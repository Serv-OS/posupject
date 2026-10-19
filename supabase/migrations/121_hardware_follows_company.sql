-- Hardware follows its site, and follows a company merge.
--
-- inv_serials stores the company AND the site of every unit out with a
-- customer. Two things changed one without the other:
--
--   1. Moving a site to another company (Location page, or linking an
--      existing site from a Company page) updated locations.company_id only.
--      The kit on that site kept the old company, so it showed on the wrong
--      customer's page and on no page of the new one.
--   2. merge_companies re-pointed locations, deals, tickets and more, then
--      deleted the duplicate. inv_serials.company_id is ON DELETE SET NULL, so
--      the duplicate's hardware ended up belonging to nobody.
--
-- Migration 101 (cascade_location_company) was written for the same kind of
-- drift on deals, quotes, onboardings and tickets, but it is not on the live
-- database. This migration is separate and touches hardware only.
--
-- Unlinking a site (company set to null) moves nothing: the kit stays on the
-- company it was sold to, the same rule 101 uses.

CREATE OR REPLACE FUNCTION public.inv_follow_location_company() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  who      uuid;
  who_name text;
  old_name text;
BEGIN
  IF NEW.company_id IS NULL OR NEW.company_id IS NOT DISTINCT FROM OLD.company_id THEN
    RETURN NEW;
  END IF;

  -- Who did it, only if they are a profile (actor_id is a foreign key to
  -- profiles, and a failed history line must never block the site move).
  SELECT p.id, coalesce(p.display_name, p.email) INTO who, who_name
    FROM public.profiles p WHERE p.id = auth.uid();
  SELECT c.name INTO old_name FROM public.companies c WHERE c.id = OLD.company_id;

  WITH moved AS (
    UPDATE public.inv_serials s
       SET company_id = NEW.company_id, customer_name = NULL
     WHERE s.location_id = NEW.id
       AND s.status IN ('deployed', 'staged', 'servicing')
       AND s.company_id IS DISTINCT FROM NEW.company_id
    RETURNING s.serial, s.product_name, s.category
  )
  INSERT INTO public.inv_movements
    (type, product_name, category, serials, qty, company_id, location_id, by_name, actor_id, notes)
  SELECT 'transfer', m.product_name, min(m.category), array_agg(m.serial ORDER BY m.serial), count(*)::int,
         NEW.company_id, NEW.id, coalesce(who_name, 'System'), who,
         'Site moved to another company' || coalesce(' from ' || old_name, '')
    FROM moved m
   GROUP BY m.product_name;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_inv_follow_location_company ON public.locations;
CREATE TRIGGER trg_inv_follow_location_company
  AFTER UPDATE OF company_id ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.inv_follow_location_company();

-- The merge, as it is live today, plus hardware and its history. Re-pointing
-- locations first fires the trigger above for kit on those sites; the
-- inv_serials line then catches the duplicate's kit that has no site.
CREATE OR REPLACE FUNCTION public.merge_companies(keep_id uuid, dup_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF public.current_user_role() NOT IN ('editor','owner') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF keep_id = dup_id THEN RAISE EXCEPTION 'Cannot merge a record into itself'; END IF;

  UPDATE public.locations        SET company_id = keep_id WHERE company_id = dup_id;
  UPDATE public.deals            SET company_id = keep_id WHERE company_id = dup_id;
  UPDATE public.tickets          SET company_id = keep_id WHERE company_id = dup_id;
  UPDATE public.onboardings      SET company_id = keep_id WHERE company_id = dup_id;
  UPDATE public.leads            SET company_id = keep_id WHERE company_id = dup_id;
  UPDATE public.form_submissions SET created_company_id = keep_id WHERE created_company_id = dup_id;
  UPDATE public.associations     SET from_id = keep_id WHERE from_type = 'company' AND from_id = dup_id;
  UPDATE public.associations     SET to_id   = keep_id WHERE to_type   = 'company' AND to_id   = dup_id;
  UPDATE public.crm_projects     SET subject_id = keep_id WHERE subject_type = 'company' AND subject_id = dup_id;
  UPDATE public.inv_serials      SET company_id = keep_id WHERE company_id = dup_id;
  UPDATE public.inv_movements    SET company_id = keep_id WHERE company_id = dup_id;

  DELETE FROM public.companies WHERE id = dup_id;
END;
$function$;

-- One-off: any unit already on a site of a different company takes the
-- site's company, with a history line. Expected to change nothing today.
WITH fixed AS (
  UPDATE public.inv_serials s
     SET company_id = l.company_id, customer_name = NULL
    FROM public.locations l
   WHERE l.id = s.location_id
     AND l.company_id IS NOT NULL
     AND s.company_id IS DISTINCT FROM l.company_id
     AND s.status IN ('deployed', 'staged', 'servicing')
  RETURNING s.serial, s.product_name, s.category, s.company_id, s.location_id
)
INSERT INTO public.inv_movements
  (type, product_name, category, serials, qty, company_id, location_id, by_name, notes)
SELECT 'transfer', f.product_name, min(f.category), array_agg(f.serial ORDER BY f.serial), count(*)::int,
       f.company_id, f.location_id, 'System', 'Company corrected to match its site'
  FROM fixed f
 GROUP BY f.product_name, f.company_id, f.location_id;
