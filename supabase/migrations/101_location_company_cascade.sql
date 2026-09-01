-- A location's company is the ONE place that fact should live.
--
-- Moving a location to another company updated locations.company_id and
-- nothing else, so every record that also stores a company_id kept pointing at
-- the old one. Fourteen deals (£12,434), fourteen signed quotes (£13,838) and
-- fourteen onboardings ended up saying "Lightspeed Netherlands B.V." while
-- their locations sat under "Lightspeed POS UK Ltd", plus 181 tasks and 10
-- projects hanging off those onboardings.
--
-- Nothing was ever deleted: the deal<->location links in `associations` and
-- onboardings.location_id all survived. The company stamp simply went stale.
--
-- This runs in the DATABASE rather than in the two UI screens that move a
-- location, because an import, a script, or a screen written next year would
-- silently reintroduce the drift. Same reasoning as auto_assign_ticket.

CREATE OR REPLACE FUNCTION public.cascade_location_company() RETURNS trigger AS $$
BEGIN
  -- Only a real move. UNLINKING (company_id -> NULL) deliberately does nothing:
  -- blanking the company on a deal or an invoice would destroy information, and
  -- unlink is documented as "keeps the location and its history".
  IF NEW.company_id IS NULL OR NEW.company_id IS NOT DISTINCT FROM OLD.company_id THEN
    RETURN NEW;
  END IF;

  UPDATE public.onboardings SET company_id = NEW.company_id
    WHERE location_id = NEW.id AND company_id IS DISTINCT FROM NEW.company_id;

  UPDATE public.quotes SET company_id = NEW.company_id
    WHERE location_id = NEW.id AND company_id IS DISTINCT FROM NEW.company_id;

  UPDATE public.tickets SET company_id = NEW.company_id
    WHERE location_id = NEW.id AND company_id IS DISTINCT FROM NEW.company_id;

  -- An ISSUED invoice names its customer on a document that has already gone
  -- out and, for 29 of them, been paid. Re-pointing that is an accounting
  -- event, not a tidy-up, so only unissued drafts follow the location. Anything
  -- already sent stays put and shows up in the drift view below.
  UPDATE public.invoices SET company_id = NEW.company_id
    WHERE location_id = NEW.id AND status = 'draft' AND company_id IS DISTINCT FROM NEW.company_id;

  -- Deals have no location_id; the link lives in `associations`, written from
  -- either end depending on which screen made it.
  UPDATE public.deals d SET company_id = NEW.company_id
    WHERE d.company_id IS DISTINCT FROM NEW.company_id
      AND EXISTS (
        SELECT 1 FROM public.associations a
        WHERE (a.from_type = 'deal' AND a.from_id = d.id AND a.to_type   = 'location' AND a.to_id   = NEW.id)
           OR (a.to_type   = 'deal' AND a.to_id   = d.id AND a.from_type = 'location' AND a.from_id = NEW.id));

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_location_company_cascade ON public.locations;
CREATE TRIGGER trg_location_company_cascade AFTER UPDATE OF company_id ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.cascade_location_company();

-- Anything the cascade deliberately will not touch stays visible instead of
-- rotting silently. Expected to be empty except for issued invoices.
CREATE OR REPLACE VIEW public.v_company_location_drift AS
  SELECT 'onboarding' AS record, o.id, l.name AS location, o.company_id AS says, l.company_id AS should_be
    FROM public.onboardings o JOIN public.locations l ON l.id = o.location_id
    WHERE l.company_id IS NOT NULL AND o.company_id IS DISTINCT FROM l.company_id
  UNION ALL
  SELECT 'quote', q.id, l.name, q.company_id, l.company_id
    FROM public.quotes q JOIN public.locations l ON l.id = q.location_id
    WHERE l.company_id IS NOT NULL AND q.company_id IS DISTINCT FROM l.company_id
  UNION ALL
  SELECT 'invoice', i.id, l.name, i.company_id, l.company_id
    FROM public.invoices i JOIN public.locations l ON l.id = i.location_id
    WHERE l.company_id IS NOT NULL AND i.company_id IS DISTINCT FROM l.company_id
  UNION ALL
  SELECT 'ticket', t.id, l.name, t.company_id, l.company_id
    FROM public.tickets t JOIN public.locations l ON l.id = t.location_id
    WHERE l.company_id IS NOT NULL AND t.company_id IS DISTINCT FROM l.company_id
  UNION ALL
  SELECT 'deal', d.id, l.name, d.company_id, l.company_id
    FROM public.deals d
    JOIN public.associations a ON (a.from_type = 'deal' AND a.from_id = d.id AND a.to_type = 'location')
    JOIN public.locations l ON l.id = a.to_id
    WHERE l.company_id IS NOT NULL AND d.company_id IS DISTINCT FROM l.company_id;

-- Backfill everything that drifted before the trigger existed. Idempotent: it
-- only touches rows that disagree, so running it twice is a no-op. Mirrors the
-- trigger's rules exactly, issued invoices included.
UPDATE public.onboardings o SET company_id = l.company_id
  FROM public.locations l WHERE l.id = o.location_id
   AND l.company_id IS NOT NULL AND o.company_id IS DISTINCT FROM l.company_id;

UPDATE public.quotes q SET company_id = l.company_id
  FROM public.locations l WHERE l.id = q.location_id
   AND l.company_id IS NOT NULL AND q.company_id IS DISTINCT FROM l.company_id;

UPDATE public.tickets t SET company_id = l.company_id
  FROM public.locations l WHERE l.id = t.location_id
   AND l.company_id IS NOT NULL AND t.company_id IS DISTINCT FROM l.company_id;

UPDATE public.invoices i SET company_id = l.company_id
  FROM public.locations l WHERE l.id = i.location_id
   AND i.status = 'draft'
   AND l.company_id IS NOT NULL AND i.company_id IS DISTINCT FROM l.company_id;

UPDATE public.deals d SET company_id = l.company_id
  FROM public.associations a, public.locations l
  WHERE a.from_type = 'deal' AND a.from_id = d.id AND a.to_type = 'location' AND a.to_id = l.id
    AND l.company_id IS NOT NULL AND d.company_id IS DISTINCT FROM l.company_id;
