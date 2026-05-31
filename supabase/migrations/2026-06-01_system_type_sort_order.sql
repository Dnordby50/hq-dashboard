-- ============================================================================
-- 2026-06-01: sort_order for system types (drag-to-reorder in Settings)
-- ============================================================================
-- Lets the office drag system types in Settings > System Types to put the most
-- popular ones at the top of the picker dropdowns. Adds a nullable sort_order
-- and backfills sequential values by current name order so existing rows have a
-- defined order. The UI sorts by sort_order (nulls last) then name, so it works
-- the same before this runs (name order) and reflects custom order after.
--
-- The catalog editor already reads pec_prod_system_types with select('*'), and
-- the pickers were switched to select('*') too, so sort_order flows through with
-- no other schema change. Staff RLS on pec_prod_system_types already allows the
-- update the reorder UI performs.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

begin;

alter table public.pec_prod_system_types
  add column if not exists sort_order int;

with ordered as (
  select id, (row_number() over (order by name)) - 1 as rn
    from public.pec_prod_system_types
)
update public.pec_prod_system_types s
   set sort_order = o.rn
  from ordered o
 where o.id = s.id and s.sort_order is null;

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='pec_prod_system_types' and column_name='sort_order';
--   select name, sort_order from public.pec_prod_system_types order by sort_order;
