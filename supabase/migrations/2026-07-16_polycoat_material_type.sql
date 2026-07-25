-- @artifacts
--   none: check-constraint changes only
-- @end
-- 2026-07-16: add 'Polycoat' as an allowed material_type.
--
-- Why: the Polycoat category was shipped front-end-only (dropdowns in
-- index.html) on the premise that material_type is free text with no CHECK
-- constraint. That premise was wrong. Three tables pin material_type with an
-- identical CHECK, and none listed 'Polycoat', so every write failed with
-- pec_prod_products_material_type_check (and would fail the same way on
-- recipe slots and material lines). Adding a Polycoat product raised:
--   new row for relation "pec_prod_products" violates check constraint
--   "pec_prod_products_material_type_check"
--
-- This migration adds 'Polycoat' to all three CHECKs so Polycoat works end to
-- end: create the product, wire it into the Polycoat system's recipe slot, and
-- write material lines in costing. The CHECK is kept (per Dylan) as a typo
-- guardrail, so new categories still need a migration like this one.
--
-- Idempotent. Safe to re-run.

begin;

-- Same allow-list on all three tables: the current 11 values plus 'Polycoat',
-- placed after 'Sealer' to match the front-end dropdown order.
alter table public.pec_prod_products
  drop constraint if exists pec_prod_products_material_type_check;
alter table public.pec_prod_products
  add constraint pec_prod_products_material_type_check
  check (material_type in ('Basecoat','Flake','Quartz','Metallic Pigment','Topcoat','Stain','Sealer','Polycoat','Tint Pack','Densifier','Guard','Extra'));

alter table public.pec_prod_recipe_slots
  drop constraint if exists pec_prod_recipe_slots_material_type_check;
alter table public.pec_prod_recipe_slots
  add constraint pec_prod_recipe_slots_material_type_check
  check (material_type in ('Basecoat','Flake','Quartz','Metallic Pigment','Topcoat','Stain','Sealer','Polycoat','Tint Pack','Densifier','Guard','Extra'));

alter table public.pec_prod_material_lines
  drop constraint if exists pec_prod_material_lines_material_type_check;
alter table public.pec_prod_material_lines
  add constraint pec_prod_material_lines_material_type_check
  check (material_type in ('Basecoat','Flake','Quartz','Metallic Pigment','Topcoat','Stain','Sealer','Polycoat','Tint Pack','Densifier','Guard','Extra'));

commit;

-- Verify after running:
--   select conrelid::regclass as tbl, pg_get_constraintdef(oid) as def
--     from pg_constraint
--    where conname in (
--      'pec_prod_products_material_type_check',
--      'pec_prod_recipe_slots_material_type_check',
--      'pec_prod_material_lines_material_type_check')
--    order by 1;
--   -- expect all three defs to include 'Polycoat'.
