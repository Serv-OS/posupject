-- 125_product_names_follow.sql (safe to run twice)
--
-- Peter, 13 Nov 2026: a renamed product kept its old name in Stock ("Adyen
-- AMS1 Dock" is now "ServOS Card Reader Dock"). Stock units, order lines and
-- shipment lines keep a copy of the product name, and the stock screens group
-- by that copy, so a rename split one product into two.
--
-- 1. Bring every copy up to the product's current name.
-- 2. From now on, renaming a product renames every copy at once.

begin;

-- Old name -> new name, worked out before anything changes. Movements and
-- thresholds carry only the name, so they follow this map.
create temp table name_map on commit drop as
  select distinct x.product_name as old_name, p.name as new_name
    from (
      select product_id, product_name from public.inv_serials
      union all select product_id, product_name from public.inv_order_lines
      union all select product_id, product_name from public.inv_shipment_lines
    ) x
    join public.products p on p.id = x.product_id
   where x.product_name is distinct from p.name and x.product_name is not null;

update public.inv_serials s set product_name = p.name
  from public.products p where p.id = s.product_id and s.product_name is distinct from p.name;
update public.inv_order_lines l set product_name = p.name
  from public.products p where p.id = l.product_id and l.product_name is distinct from p.name;
update public.inv_shipment_lines l set product_name = p.name
  from public.products p where p.id = l.product_id and l.product_name is distinct from p.name;
-- Only names that map to exactly one product, so history is never guessed.
update public.inv_movements m set product_name = nm.new_name
  from name_map nm
 where m.product_name = nm.old_name
   and (select count(distinct new_name) from name_map n2 where n2.old_name = nm.old_name) = 1;
update public.inv_thresholds t set product_name = nm.new_name
  from name_map nm
 where t.product_name = nm.old_name
   and (select count(distinct new_name) from name_map n2 where n2.old_name = nm.old_name) = 1;

-- 2. A rename follows through everywhere.
create or replace function public.products_rename_follows()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.name is distinct from old.name then
    update inv_serials        set product_name = new.name where product_id = new.id;
    update inv_order_lines    set product_name = new.name where product_id = new.id;
    update inv_shipment_lines set product_name = new.name where product_id = new.id;
    update inv_movements      set product_name = new.name where product_name = old.name;
    update inv_thresholds     set product_name = new.name where product_name = old.name;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_products_rename_follows on public.products;
create trigger trg_products_rename_follows
  after update of name on public.products
  for each row execute function public.products_rename_follows();

commit;

-- Check: should return no rows.
select s.product_name, p.name from public.inv_serials s join public.products p on p.id = s.product_id
 where s.product_name is distinct from p.name;

-- ROLLBACK
--   drop trigger trg_products_rename_follows on public.products;
--   drop function public.products_rename_follows();
--   (the renamed copies stay renamed)
