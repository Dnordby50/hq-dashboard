-- 2026-05-04: split 'Quartz' off from 'Flake' as a first-class material_type.
--
-- Why: the 41 Torginol Q-Color products were seeded with material_type='Flake'
-- (with a hand-written note on the Quartz system slot saying "use Flake
-- material_type so the picker fires"). That conflated Simiron decorative flakes
-- with Torginol quartz blends in the New Job flake picker. After this
-- migration the picker can filter cleanly: Flake systems show flake products,
-- Quartz systems show quartz products.
--
-- Run order: this file FIRST, then 2026-05-04_catalog_expansion.sql.
-- Idempotent. Safe to re-run.

begin;

-- 1) Extend the CHECK constraints on the three tables that pin material_type.
alter table public.pec_prod_products
  drop constraint if exists pec_prod_products_material_type_check;
alter table public.pec_prod_products
  add constraint pec_prod_products_material_type_check
  check (material_type in ('Basecoat','Flake','Quartz','Topcoat','Stain','Sealer','Tint Pack','Extra'));

alter table public.pec_prod_recipe_slots
  drop constraint if exists pec_prod_recipe_slots_material_type_check;
alter table public.pec_prod_recipe_slots
  add constraint pec_prod_recipe_slots_material_type_check
  check (material_type in ('Basecoat','Flake','Quartz','Topcoat','Stain','Sealer','Tint Pack','Extra'));

alter table public.pec_prod_material_lines
  drop constraint if exists pec_prod_material_lines_material_type_check;
alter table public.pec_prod_material_lines
  add constraint pec_prod_material_lines_material_type_check
  check (material_type in ('Basecoat','Flake','Quartz','Topcoat','Stain','Sealer','Tint Pack','Extra'));

-- 2) Reclassify the 41 Torginol Q-Color rows from 'Flake' to 'Quartz'.
update public.pec_prod_products
   set material_type = 'Quartz'
 where material_type = 'Flake'
   and supplier = 'Torginol'
   and name like 'Torginol Q-Color%';

-- 3) Flip the Quartz system's broadcast recipe slot from 'Flake' to 'Quartz'
--    so the slot's material_type matches the product's material_type. The
--    calculator's "user-picked product" branch still resolves via
--    area.flake_product_id (kept as the column name for back-compat); see the
--    matching update in production/calculator.js + the inlined copy.
update public.pec_prod_recipe_slots rs
   set material_type = 'Quartz'
  from public.pec_prod_system_types st
 where rs.system_type_id = st.id
   and st.name = 'Quartz'
   and rs.material_type = 'Flake';

commit;

-- Verify after running:
--   select material_type, count(*)
--     from public.pec_prod_products
--    where active group by 1 order by 1;
--   -- expect: Basecoat 3, Extra ?, Flake 1 (Domino), Quartz 41, Sealer ?, ...
--   select st.name as system, rs.material_type, count(*)
--     from public.pec_prod_recipe_slots rs
--     join public.pec_prod_system_types st on st.id = rs.system_type_id
--    group by 1,2 order by 1,2;
--   -- expect: Quartz / Quartz appears (replaces Quartz / Flake).
