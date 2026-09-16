-- 118: a quote with a site belongs to that site's deal.
--
-- Deals have no location column. A deal is tied to its site by a row in
-- associations (deal -> location, label affected_location, written by the deal
-- board and the lead screens, or location -> deal from the association
-- picker). A quote carries both location_id and deal_id, and until now nothing
-- joined the two: a quote made from the Quotes tab (company only) or given a
-- site in the builder kept deal_id NULL for good. The site's deal then sat at
-- value 0 and the pipeline never saw the quote. On 16 Sep Q-1016, Q-1017 and
-- Q-1018 (Mozz Pizza's three sites) all had a site and no deal, and the Day
-- Break deal read GBP for a US site because its only quote was an empty GBP
-- draft. The quote_recalc trigger also only ever recalculated the deal a quote
-- JOINED, so a quote moved off a deal, or deleted, left the old deal showing
-- the value of a quote it no longer had.
--
-- What changes, in plain words:
--   * currency_for_country(country): 'US' or 'USA' is USD, anything else GBP.
--     The same rule as currencyForCountry in src/lib/region.js.
--   * deal_for_location(site): the site's deal through associations in either
--     direction. Never a lost deal; an open deal before a won one; then the
--     newest.
--   * attach_orphan_quotes(deal): pulls in the deal's site's quotes that have
--     no deal yet (same company, not void) and recalculates the deal when any
--     moved. Nothing moved means nothing to re-derive, so a deal with no quote
--     keeps its typed value. From a screen only an editor or owner may call it.
--   * Linking a site to a deal (an associations insert) runs
--     attach_orphan_quotes and, when the deal still has no live quote, gives
--     it the currency of the site's country.
--   * Saving a quote (insert, or an update that names location_id, deal_id or
--     company_id): a site with no company fills the company; a site with no
--     deal takes the site's deal when the companies agree; a deal with no site
--     takes the deal's site when it has exactly one. On insert only, a quote
--     left at the GBP default for a US site (or else a US company) becomes
--     USD. A saved quote's currency is deliberate and is never changed here.
--   * quote_recalc also fires on delete, and recalculates the deal a quote
--     LEFT as well as the one it joined. recalc_deal_rollup zeroes a deal's
--     derived values when it has no live quote left, rounds them to pennies,
--     keeps the currency, and no longer rewrites a deal whose figures have not
--     changed (so updated_at is not bumped for nothing).
--   * Deleting a quote: a signed, paid or won quote is a contract the customer
--     accepted and invoices point at it, so the database refuses with
--     "Accepted quotes cannot be deleted. Set the quote to void instead."
--     Any other quote may go. Its lines go with it (019), invoices and
--     recurring invoices keep their rows with quote_id cleared (039, 112),
--     and quote_recalc puts the deal right.
--   * Backfill: attach orphans for every deal with a site; set currency from
--     the site for quote-less deals; recalculate the deals that have a live
--     quote and are not won. A deal with no quote keeps its hand-typed value
--     (recalc would zero it) and a won deal keeps the payments_arr written
--     when it was won, which Sales Performance reads. Nearly every deal has a
--     site link, so attach_orphan_quotes must not recalc a deal it moved
--     nothing onto, or step (a) would zero both before (c) could spare them.
--
-- Safe to run twice. Bare statements, no begin/commit, so a failure stops it
-- part way and the whole file can simply be run again.
--
-- ROLLBACK (code first, then data):
--   drop trigger if exists quote_no_delete_accepted on public.quotes;
--   drop trigger if exists quote_links on public.quotes;
--   drop trigger if exists assoc_deal_location on public.associations;
--   drop function if exists public.trg_quote_no_delete_accepted();
--   drop function if exists public.trg_quote_links();
--   drop function if exists public.trg_assoc_deal_location();
--   drop function if exists public.attach_orphan_quotes(uuid);
--   drop function if exists public.deal_for_location(uuid);
--   drop function if exists public.currency_for_country(text);
--   Then put trg_quote_recalc back as in 019 (AFTER INSERT OR UPDATE only,
--   recalculating NEW.deal_id) and recalc_deal_rollup back as in 091.
--   The quotes this migration attached are named in the notice it prints
--   ("118: attached ..."); to detach them again:
--     update public.quotes set deal_id = null where quote_number in (...);
--   Deal currencies it changed are named the same way ("118: set currency ...").
--   Deal values it recalculated were derived from their quotes and need no
--   undoing.

-- ---------- 1. Country to currency, the same rule as the app ----------
CREATE OR REPLACE FUNCTION public.currency_for_country(p_country text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN upper(coalesce(p_country, '')) IN ('US', 'USA') THEN 'USD' ELSE 'GBP' END;
$$;

-- ---------- 2. Which deal a site belongs to ----------
-- Either direction of the association counts. A lost deal is never the answer.
-- An open deal beats a won one (an upsell quote goes on the new deal, not the
-- history), and of two open deals the newest wins.
CREATE OR REPLACE FUNCTION public.deal_for_location(p_location_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id
    FROM public.associations a
    JOIN public.deals d ON d.id = CASE WHEN a.from_type = 'deal' THEN a.from_id ELSE a.to_id END
   WHERE ((a.from_type = 'deal' AND a.to_type = 'location' AND a.to_id = p_location_id)
       OR (a.from_type = 'location' AND a.to_type = 'deal' AND a.from_id = p_location_id))
     AND d.stage <> 'closed_lost'
   ORDER BY (d.stage = 'closed_won'), d.created_at DESC, d.id
   LIMIT 1;
$$;

-- ---------- 3. Rollup: a deal is worth what its live quote says ----------
-- Same as 091 with three changes. The figures are rounded to pennies (the
-- columns are numeric(12,2) and the app rounds with round2). A deal with no
-- live quote left goes to 0: its figures came from the quote that left, so
-- they leave with it; the currency stays. And a deal whose figures have not
-- changed is not rewritten, so its updated_at is not bumped for nothing.
CREATE OR REPLACE FUNCTION public.recalc_deal_rollup(p_deal_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  q_id uuid;
  q_currency text;
  hw numeric := 0; sv numeric := 0; saas numeric := 0; pay numeric := 0;
BEGIN
  IF p_deal_id IS NULL THEN RETURN; END IF;
  -- Primary quote drives the deal: the won one if present, else the most recent live quote
  SELECT id, currency INTO q_id, q_currency FROM public.quotes
   WHERE deal_id = p_deal_id AND status NOT IN ('declined','void','expired')
   ORDER BY (status = 'won') DESC, updated_at DESC
   LIMIT 1;

  IF q_id IS NOT NULL THEN
    SELECT
      COALESCE(sum(line_total) FILTER (WHERE category = 'hardware'), 0),
      COALESCE(sum(line_total) FILTER (WHERE category = 'services'), 0),
      COALESCE(sum(CASE WHEN category = 'saas' THEN (CASE WHEN billing_type = 'monthly' THEN line_total * 12 ELSE line_total END) END), 0),
      COALESCE(sum(line_total) FILTER (WHERE category = 'payments'), 0)
    INTO hw, sv, saas, pay
    FROM public.quote_line_items WHERE quote_id = q_id;
  END IF;
  hw := round(hw, 2); sv := round(sv, 2); saas := round(saas, 2); pay := round(pay, 2);

  UPDATE public.deals SET
    hardware_value = hw, services_value = sv, saas_arr = saas, payments_arr = pay,
    value = hw + sv + saas + pay,
    currency = COALESCE(q_currency, currency, 'GBP')
  WHERE id = p_deal_id
    AND (hardware_value IS DISTINCT FROM hw OR services_value IS DISTINCT FROM sv
      OR saas_arr IS DISTINCT FROM saas OR payments_arr IS DISTINCT FROM pay
      OR value IS DISTINCT FROM hw + sv + saas + pay
      OR currency IS DISTINCT FROM COALESCE(q_currency, currency, 'GBP'));
END;
$$;

-- ---------- 4. Pull a site's quotes onto its deal ----------
-- Only for sites where THIS deal is the site's deal (deal_for_location): a
-- lost deal never collects quotes, and when a site has two open deals the
-- newest collects them, whatever order the deals are handled in. A quote with
-- no company takes the deal's. Returns how many quotes moved.
--
-- The deal is recalculated only when a quote actually moved. When none did,
-- nothing about the deal's quotes changed, and a recalc would zero a deal
-- that has no quote at all: the value typed on the board when the deal was
-- made, or the payments_arr written when it was won (Sales Performance reads
-- that). Linking a site runs this for every deal, quote or not, and the
-- backfill below runs it for every linked deal, so this guard is what keeps
-- those figures.
--
-- Callable from a screen by the same people the quotes and deals policies
-- let write (editor, owner). It runs as its owner, so without the check a
-- viewer could call it from the browser console, move quotes about and
-- rewrite deals past the RLS. Server side callers (this migration's backfill,
-- service_role) carry no auth.uid() and pass, and so does the association
-- trigger when it fires for them.
CREATE OR REPLACE FUNCTION public.attach_orphan_quotes(p_deal_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d public.deals%ROWTYPE;
  n integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND COALESCE(public.current_user_role(), '') NOT IN ('editor', 'owner') THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_deal_id IS NULL THEN RETURN 0; END IF;
  SELECT * INTO d FROM public.deals WHERE id = p_deal_id;
  IF d.id IS NULL THEN RETURN 0; END IF;

  WITH sites AS (
    SELECT DISTINCT CASE WHEN a.from_type = 'location' THEN a.from_id ELSE a.to_id END AS location_id
      FROM public.associations a
     WHERE (a.from_type = 'deal' AND a.from_id = p_deal_id AND a.to_type = 'location')
        OR (a.from_type = 'location' AND a.to_type = 'deal' AND a.to_id = p_deal_id)
  ), moved AS (
    UPDATE public.quotes q
       SET deal_id = p_deal_id,
           company_id = COALESCE(q.company_id, d.company_id)
      FROM sites s
     WHERE q.location_id = s.location_id
       AND q.deal_id IS NULL
       AND q.status <> 'void'
       AND (q.company_id IS NULL OR q.company_id = d.company_id)
       AND public.deal_for_location(s.location_id) = p_deal_id
    RETURNING q.id
  )
  SELECT count(*) INTO n FROM moved;

  IF n > 0 THEN PERFORM public.recalc_deal_rollup(p_deal_id); END IF;
  RETURN n;
END;
$$;

-- ---------- 5. Linking a site to a deal ----------
-- The deal collects the site's quotes that had none. A deal still without a
-- live quote takes the currency of the site's country; a deal with one keeps
-- what recalc_deal_rollup read from the quote.
CREATE OR REPLACE FUNCTION public.trg_assoc_deal_location() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_deal uuid;
  v_loc uuid;
  v_country text;
  v_ccy text;
BEGIN
  IF NEW.from_type = 'deal' AND NEW.to_type = 'location' THEN
    v_deal := NEW.from_id; v_loc := NEW.to_id;
  ELSIF NEW.from_type = 'location' AND NEW.to_type = 'deal' THEN
    v_deal := NEW.to_id; v_loc := NEW.from_id;
  ELSE
    RETURN NULL;
  END IF;

  PERFORM public.attach_orphan_quotes(v_deal);

  IF NOT EXISTS (SELECT 1 FROM public.quotes WHERE deal_id = v_deal AND status <> 'void') THEN
    SELECT NULLIF(btrim(country), '') INTO v_country FROM public.locations WHERE id = v_loc;
    IF v_country IS NOT NULL THEN
      v_ccy := public.currency_for_country(v_country);
      UPDATE public.deals SET currency = v_ccy WHERE id = v_deal AND currency IS DISTINCT FROM v_ccy;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS assoc_deal_location ON public.associations;
CREATE TRIGGER assoc_deal_location AFTER INSERT ON public.associations
  FOR EACH ROW EXECUTE FUNCTION public.trg_assoc_deal_location();

-- ---------- 6. Saving a quote fills in what follows from its site or deal ----------
-- Fires on insert, and on any update that names location_id, deal_id or
-- company_id (QuoteBuilder's save always names location_id, so a quote given a
-- site in the builder is linked on the next save).
CREATE OR REPLACE FUNCTION public.trg_quote_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_deal uuid;
  v_deal_company uuid;
  v_sites uuid[];
  v_country text;
BEGIN
  -- A site names its company.
  IF NEW.location_id IS NOT NULL AND NEW.company_id IS NULL THEN
    SELECT company_id INTO NEW.company_id FROM public.locations WHERE id = NEW.location_id;
  END IF;

  -- A site with no deal on the quote: the site's deal, when the companies agree.
  IF NEW.deal_id IS NULL AND NEW.location_id IS NOT NULL THEN
    v_deal := public.deal_for_location(NEW.location_id);
    IF v_deal IS NOT NULL THEN
      SELECT company_id INTO v_deal_company FROM public.deals WHERE id = v_deal;
      IF NEW.company_id IS NULL OR NEW.company_id = v_deal_company THEN
        NEW.deal_id := v_deal;
        NEW.company_id := COALESCE(NEW.company_id, v_deal_company);
      END IF;
    END IF;
  END IF;

  -- A deal with no site on the quote: the deal's site, when it has exactly one.
  IF NEW.deal_id IS NOT NULL AND NEW.location_id IS NULL THEN
    SELECT array_agg(DISTINCT CASE WHEN a.from_type = 'location' THEN a.from_id ELSE a.to_id END)
      INTO v_sites
      FROM public.associations a
     WHERE (a.from_type = 'deal' AND a.from_id = NEW.deal_id AND a.to_type = 'location')
        OR (a.from_type = 'location' AND a.to_type = 'deal' AND a.to_id = NEW.deal_id);
    IF array_length(v_sites, 1) = 1 THEN NEW.location_id := v_sites[1]; END IF;
  END IF;

  -- A deal names its company too, when the quote still has none.
  IF NEW.company_id IS NULL AND NEW.deal_id IS NOT NULL THEN
    SELECT company_id INTO NEW.company_id FROM public.deals WHERE id = NEW.deal_id;
  END IF;

  -- Insert only: a quote left at the GBP default for a US site (or else a US
  -- company) is a USD quote. Never on update: a saved currency is deliberate.
  IF TG_OP = 'INSERT' AND COALESCE(NEW.currency, 'GBP') = 'GBP' THEN
    IF NEW.location_id IS NOT NULL THEN
      SELECT NULLIF(btrim(country), '') INTO v_country FROM public.locations WHERE id = NEW.location_id;
    END IF;
    IF v_country IS NULL AND NEW.company_id IS NOT NULL THEN
      SELECT NULLIF(btrim(country), '') INTO v_country FROM public.companies WHERE id = NEW.company_id;
    END IF;
    NEW.currency := public.currency_for_country(v_country);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quote_links ON public.quotes;
CREATE TRIGGER quote_links BEFORE INSERT OR UPDATE OF location_id, deal_id, company_id ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.trg_quote_links();

-- ---------- 7. Recalculate the deal a quote leaves, not only the one it joins ----------
CREATE OR REPLACE FUNCTION public.trg_quote_recalc() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM public.recalc_deal_rollup(NEW.deal_id);
  END IF;
  -- The deal the quote left: moved to another deal, taken off a deal, or deleted.
  IF TG_OP = 'DELETE' THEN
    PERFORM public.recalc_deal_rollup(OLD.deal_id);
  ELSIF TG_OP = 'UPDATE' AND OLD.deal_id IS DISTINCT FROM NEW.deal_id THEN
    PERFORM public.recalc_deal_rollup(OLD.deal_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS quote_recalc ON public.quotes;
CREATE TRIGGER quote_recalc AFTER INSERT OR UPDATE OR DELETE ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.trg_quote_recalc();

-- ---------- 8. An accepted quote cannot be deleted ----------
-- Signed, paid and won quotes are contracts the customer accepted, and the
-- invoices raised from them point at them. Voiding keeps the number and the
-- history; deleting would lose both, so the database says no whoever asks
-- (the screens hide the button, but a direct call or a cascade from a deal
-- delete reaches here too). Everything else may be deleted.
CREATE OR REPLACE FUNCTION public.trg_quote_no_delete_accepted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.status IN ('signed', 'paid', 'won') THEN
    RAISE EXCEPTION 'Accepted quotes cannot be deleted. Set the quote to void instead.'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS quote_no_delete_accepted ON public.quotes;
CREATE TRIGGER quote_no_delete_accepted BEFORE DELETE ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.trg_quote_no_delete_accepted();

-- ---------- 9. Who may call what ----------
-- Staff screens may ask for a site's deal or pull a deal's orphans in
-- (attach_orphan_quotes itself turns a signed-in viewer away, the same rule
-- as the quotes and deals policies, because the grant alone would let one
-- write past RLS). The public quote page runs as anon and needs none of
-- this. Nobody calls a trigger function directly, so those are executable by
-- no one but their owner (Postgres does not check execute rights when a
-- trigger fires).
REVOKE ALL ON FUNCTION public.currency_for_country(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.currency_for_country(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.deal_for_location(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deal_for_location(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.attach_orphan_quotes(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_orphan_quotes(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.trg_assoc_deal_location() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_quote_links() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_quote_recalc() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_quote_no_delete_accepted() FROM PUBLIC, anon, authenticated;

-- ---------- 10. Backfill ----------
DO $$
DECLARE
  r record;
  n integer := 0;
  attached integer := 0;
  orphans integer[];
  list text;
BEGIN
  -- Remember which quotes were orphans, so the notice can name the ones attached.
  SELECT array_agg(quote_number ORDER BY quote_number) INTO orphans
    FROM public.quotes WHERE deal_id IS NULL AND location_id IS NOT NULL AND status <> 'void';

  -- (a) every deal with a site collects that site's orphans
  FOR r IN
    SELECT DISTINCT CASE WHEN a.from_type = 'deal' THEN a.from_id ELSE a.to_id END AS deal_id
      FROM public.associations a
     WHERE (a.from_type = 'deal' AND a.to_type = 'location')
        OR (a.from_type = 'location' AND a.to_type = 'deal')
  LOOP
    attached := attached + public.attach_orphan_quotes(r.deal_id);
  END LOOP;
  SELECT string_agg('Q-' || quote_number, ', ' ORDER BY quote_number) INTO list
    FROM public.quotes WHERE quote_number = ANY (COALESCE(orphans, '{}')) AND deal_id IS NOT NULL;
  RAISE NOTICE '118: attached % orphan quote(s) to their site''s deal: %', attached, COALESCE(list, 'none');

  -- (b) a deal with a site and no live quote takes the site's currency
  WITH linked AS (
    SELECT DISTINCT ON (d.id) d.id AS deal_id, l.country
      FROM public.deals d
      JOIN public.associations a ON (a.from_type = 'deal' AND a.from_id = d.id AND a.to_type = 'location')
                                 OR (a.from_type = 'location' AND a.to_type = 'deal' AND a.to_id = d.id)
      JOIN public.locations l ON l.id = CASE WHEN a.from_type = 'location' THEN a.from_id ELSE a.to_id END
     WHERE NULLIF(btrim(l.country), '') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.quotes q WHERE q.deal_id = d.id AND q.status <> 'void')
     ORDER BY d.id, a.created_at DESC
  ), changed AS (
    UPDATE public.deals d SET currency = public.currency_for_country(linked.country)
      FROM linked
     WHERE linked.deal_id = d.id AND d.currency IS DISTINCT FROM public.currency_for_country(linked.country)
    RETURNING d.name, d.currency
  )
  SELECT count(*), string_agg(name || ' -> ' || currency, ', ' ORDER BY name) INTO n, list FROM changed;
  RAISE NOTICE '118: set currency from the site on % deal(s) with no live quote: %', n, COALESCE(list, 'none');

  -- (c) deals that have a live quote and are not won are re-derived from it
  n := 0;
  FOR r IN
    SELECT d.id FROM public.deals d
     WHERE d.stage <> 'closed_won'
       AND EXISTS (SELECT 1 FROM public.quotes q WHERE q.deal_id = d.id AND q.status NOT IN ('declined','void','expired'))
  LOOP
    PERFORM public.recalc_deal_rollup(r.id);
    n := n + 1;
  END LOOP;
  RAISE NOTICE '118: recalculated % deal(s) that have a live quote', n;
END $$;

-- What is left to look at: quotes that still have a site but no deal. Either
-- the site has no deal yet, or the quote's company is not the deal's.
SELECT 'Q-' || q.quote_number AS quote, q.status, q.currency, l.name AS site, c.name AS company
  FROM public.quotes q
  JOIN public.locations l ON l.id = q.location_id
  LEFT JOIN public.companies c ON c.id = q.company_id
 WHERE q.deal_id IS NULL AND q.status <> 'void'
 ORDER BY q.quote_number;
