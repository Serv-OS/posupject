-- 119: an association dies with the record it points at.
--
-- associations is polymorphic (from_type/from_id, to_type/to_id), so it has no
-- foreign keys and nothing removes a row when a deal, site, contact, company,
-- lead, onboarding or ticket is deleted. The deleted record's links stay behind
-- and keep answering questions about it. On 16 Sep a deal that had been deleted
-- still "owned" the Mozz Milk Block site through one of these rows, so
-- deal_for_location (118) found a deal that did not exist, the Milk Block
-- quote could never attach, and the one off fix refused to create a new deal
-- because the site "already had one". 13 such rows existed across deals,
-- sites, leads and tickets.
--
-- Two things:
--   * Delete every association whose from or to side no longer exists, and say
--     how many, so the stale answers stop today.
--   * A trigger on each of the seven tables removes that record's associations
--     when it is deleted, so this cannot build up again. One function, each
--     trigger passes its type name.
--
-- Safe to run twice. Bare statements, no begin/commit.
--
-- ROLLBACK:
--   drop trigger if exists assoc_follow_delete on public.deals;   (and the same
--   on locations, contacts, companies, leads, onboardings, tickets)
--   drop function if exists public.trg_assoc_follow_delete();
--   The rows deleted by the sweep pointed at records that were already gone
--   and need no undoing.

-- ---------- 1. Sweep the rows that point at nothing ----------
DO $$
DECLARE n integer;
BEGIN
  WITH gone AS (
    SELECT a.id
      FROM public.associations a
     WHERE (a.from_type = 'deal'       AND NOT EXISTS (SELECT 1 FROM public.deals       x WHERE x.id = a.from_id))
        OR (a.to_type   = 'deal'       AND NOT EXISTS (SELECT 1 FROM public.deals       x WHERE x.id = a.to_id))
        OR (a.from_type = 'location'   AND NOT EXISTS (SELECT 1 FROM public.locations   x WHERE x.id = a.from_id))
        OR (a.to_type   = 'location'   AND NOT EXISTS (SELECT 1 FROM public.locations   x WHERE x.id = a.to_id))
        OR (a.from_type = 'contact'    AND NOT EXISTS (SELECT 1 FROM public.contacts    x WHERE x.id = a.from_id))
        OR (a.to_type   = 'contact'    AND NOT EXISTS (SELECT 1 FROM public.contacts    x WHERE x.id = a.to_id))
        OR (a.from_type = 'company'    AND NOT EXISTS (SELECT 1 FROM public.companies   x WHERE x.id = a.from_id))
        OR (a.to_type   = 'company'    AND NOT EXISTS (SELECT 1 FROM public.companies   x WHERE x.id = a.to_id))
        OR (a.from_type = 'lead'       AND NOT EXISTS (SELECT 1 FROM public.leads       x WHERE x.id = a.from_id))
        OR (a.to_type   = 'lead'       AND NOT EXISTS (SELECT 1 FROM public.leads       x WHERE x.id = a.to_id))
        OR (a.from_type = 'onboarding' AND NOT EXISTS (SELECT 1 FROM public.onboardings x WHERE x.id = a.from_id))
        OR (a.to_type   = 'onboarding' AND NOT EXISTS (SELECT 1 FROM public.onboardings x WHERE x.id = a.to_id))
        OR (a.from_type = 'ticket'     AND NOT EXISTS (SELECT 1 FROM public.tickets     x WHERE x.id = a.from_id))
        OR (a.to_type   = 'ticket'     AND NOT EXISTS (SELECT 1 FROM public.tickets     x WHERE x.id = a.to_id))
  ), removed AS (
    DELETE FROM public.associations a USING gone g WHERE a.id = g.id RETURNING a.id
  )
  SELECT count(*) INTO n FROM removed;
  RAISE NOTICE '119: removed % association(s) that pointed at a deleted record', n;
END $$;

-- ---------- 2. From now on the links go with the record ----------
-- The trigger argument is the type name the association rows use for that
-- table. Security definer, so a user allowed to delete the record does not
-- also need delete rights on associations.
CREATE OR REPLACE FUNCTION public.trg_assoc_follow_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t text := TG_ARGV[0];
BEGIN
  DELETE FROM public.associations
   WHERE (from_type = t AND from_id = OLD.id) OR (to_type = t AND to_id = OLD.id);
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_assoc_follow_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS assoc_follow_delete ON public.deals;
CREATE TRIGGER assoc_follow_delete AFTER DELETE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.trg_assoc_follow_delete('deal');

DROP TRIGGER IF EXISTS assoc_follow_delete ON public.locations;
CREATE TRIGGER assoc_follow_delete AFTER DELETE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.trg_assoc_follow_delete('location');

DROP TRIGGER IF EXISTS assoc_follow_delete ON public.contacts;
CREATE TRIGGER assoc_follow_delete AFTER DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.trg_assoc_follow_delete('contact');

DROP TRIGGER IF EXISTS assoc_follow_delete ON public.companies;
CREATE TRIGGER assoc_follow_delete AFTER DELETE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.trg_assoc_follow_delete('company');

DROP TRIGGER IF EXISTS assoc_follow_delete ON public.leads;
CREATE TRIGGER assoc_follow_delete AFTER DELETE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.trg_assoc_follow_delete('lead');

DROP TRIGGER IF EXISTS assoc_follow_delete ON public.onboardings;
CREATE TRIGGER assoc_follow_delete AFTER DELETE ON public.onboardings
  FOR EACH ROW EXECUTE FUNCTION public.trg_assoc_follow_delete('onboarding');

DROP TRIGGER IF EXISTS assoc_follow_delete ON public.tickets;
CREATE TRIGGER assoc_follow_delete AFTER DELETE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.trg_assoc_follow_delete('ticket');

-- What is left pointing at nothing (should be no rows).
SELECT a.from_type, a.to_type, count(*) AS still_dangling
  FROM public.associations a
 WHERE (a.from_type = 'deal'     AND NOT EXISTS (SELECT 1 FROM public.deals     x WHERE x.id = a.from_id))
    OR (a.to_type   = 'location' AND NOT EXISTS (SELECT 1 FROM public.locations x WHERE x.id = a.to_id))
    OR (a.from_type = 'lead'     AND NOT EXISTS (SELECT 1 FROM public.leads     x WHERE x.id = a.from_id))
    OR (a.from_type = 'ticket'   AND NOT EXISTS (SELECT 1 FROM public.tickets   x WHERE x.id = a.from_id))
 GROUP BY 1, 2;
