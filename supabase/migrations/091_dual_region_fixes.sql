-- Review fixes for the dual-region build.

-- 1. Deals never learned their currency: the rollup copied a USD quote's line
--    totals onto the deal while deals.currency stayed at its 'GBP' default, so
--    every dollar of US pipeline landed in the £ bucket of the new per-currency
--    dashboards. The driving quote is already the authority on the deal's
--    value — make it the authority on the currency too.
CREATE OR REPLACE FUNCTION public.recalc_deal_rollup(p_deal_id uuid) RETURNS void AS $$
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

  UPDATE public.deals SET
    hardware_value = hw, services_value = sv, saas_arr = saas, payments_arr = pay,
    value = hw + sv + saas + pay,
    currency = COALESCE(q_currency, currency, 'GBP')
  WHERE id = p_deal_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Backfill: any deal whose driving quote already has a currency.
UPDATE public.deals d
   SET currency = q.currency
  FROM (
    SELECT DISTINCT ON (deal_id) deal_id, currency
      FROM public.quotes
     WHERE deal_id IS NOT NULL AND status NOT IN ('declined','void','expired')
     ORDER BY deal_id, (status = 'won') DESC, updated_at DESC
  ) q
 WHERE q.deal_id = d.id AND d.currency IS DISTINCT FROM q.currency;

-- 2. Deleting a ticket dropped its live chat session back to the BOT: the
--    session stayed 'escalated' with ticket_id nulled, the escalated guard
--    stopped matching, and the bot silently rejoined a conversation the
--    customer was told is with the team. Close the session with the ticket.
CREATE OR REPLACE FUNCTION public.close_chat_on_ticket_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.chat_sessions
     SET status = 'closed', last_at = now()
   WHERE ticket_id = OLD.id AND status <> 'closed';
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_close_chat_on_ticket_delete ON public.tickets;
CREATE TRIGGER trg_close_chat_on_ticket_delete
  BEFORE DELETE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.close_chat_on_ticket_delete();
