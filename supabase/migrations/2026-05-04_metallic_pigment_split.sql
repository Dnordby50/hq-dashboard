-- 2026-05-04: split Metallic Pigment into its own material_type, retire
-- Tinted Gray + Thin Coat from the basecoat picker, add a standalone MVB
-- option on jobs.
--
-- 1) Extend the material_type CHECK constraints to allow 'Metallic Pigment'
--    and reclassify Simiron Metallic Pigment from Flake to Metallic Pigment
--    (it was conflated with flakes in the original seed). Flip the Metallic
--    system's pigment-broadcast recipe slot to match.
--
-- 2) Repoint the Flake / Quartz / Grind and Seal - Urethane recipe defaults
--    from Tinted Gray / Thin Coat to Light Gray, and the Domino color
--    pairing too. Then deactivate Tinted Gray and Thin Coat so the basecoat
--    picker no longer surfaces them. Old material_lines that already
--    reference Tinted Gray keep working (active=false doesn't break FKs).
--
-- 3) Insert "Simiron MVB - Standalone" (Basecoat, 100 sqft/gal, 3 gal kit) for
--    jobs that lay down MVB by itself before/instead of the system stack.
--    Different application thickness than the in-Metallic-system MVB.
--
-- 4) Add standalone_mvb boolean to pec_prod_jobs (defaults false). New Job
--    form gets a yes/no toggle; calculator emits one extra MVB line when
--    true.
--
-- Idempotent. Safe to re-run.

begin;

-- ============================================================================
-- 1) CHECK constraint: allow 'Metallic Pigment'
-- ============================================================================
alter table public.pec_prod_products
  drop constraint if exists pec_prod_products_material_type_check;
alter table public.pec_prod_products
  add constraint pec_prod_products_material_type_check
  check (material_type in ('Basecoat','Flake','Quartz','Metallic Pigment','Topcoat','Stain','Sealer','Tint Pack','Extra'));

alter table public.pec_prod_recipe_slots
  drop constraint if exists pec_prod_recipe_slots_material_type_check;
alter table public.pec_prod_recipe_slots
  add constraint pec_prod_recipe_slots_material_type_check
  check (material_type in ('Basecoat','Flake','Quartz','Metallic Pigment','Topcoat','Stain','Sealer','Tint Pack','Extra'));

alter table public.pec_prod_material_lines
  drop constraint if exists pec_prod_material_lines_material_type_check;
alter table public.pec_prod_material_lines
  add constraint pec_prod_material_lines_material_type_check
  check (material_type in ('Basecoat','Flake','Quartz','Metallic Pigment','Topcoat','Stain','Sealer','Tint Pack','Extra'));

-- Reclassify the Simiron Metallic Pigment row.
update public.pec_prod_products
   set material_type = 'Metallic Pigment'
 where name = 'Simiron Metallic Pigment'
   and material_type = 'Flake';

-- Flip the Metallic system's pigment slot from Flake -> Metallic Pigment.
update public.pec_prod_recipe_slots rs
   set material_type = 'Metallic Pigment'
  from public.pec_prod_system_types st
 where rs.system_type_id = st.id
   and st.name = 'Metallic'
   and rs.material_type = 'Flake';

-- ============================================================================
-- 2) Repoint recipe defaults + Domino pairing to Light Gray, then deactivate
--    Tinted Gray + Thin Coat so they're hidden from the basecoat picker.
-- ============================================================================
update public.pec_prod_recipe_slots rs
   set default_product_id = (select id from public.pec_prod_products where name = 'Simiron 1100 SL - Light Gray')
  from public.pec_prod_system_types st
 where rs.system_type_id = st.id
   and st.name in ('Flake','Quartz','Grind and Seal - Urethane')
   and rs.material_type = 'Basecoat'
   and rs.default_product_id in (
     select id from public.pec_prod_products
      where name in ('Simiron 1100 SL - Tinted Gray','Simiron 1100 SL - Thin Coat')
   );

update public.pec_prod_color_pairings
   set basecoat_product_id = (select id from public.pec_prod_products where name = 'Simiron 1100 SL - Light Gray')
 where basecoat_product_id = (select id from public.pec_prod_products where name = 'Simiron 1100 SL - Tinted Gray');

update public.pec_prod_products
   set active = false
 where name in ('Simiron 1100 SL - Tinted Gray','Simiron 1100 SL - Thin Coat');

-- ============================================================================
-- 3) Standalone MVB product (different application than the in-Metallic MVB)
-- ============================================================================
insert into public.pec_prod_products
  (name, material_type, manufacturer, supplier, color, spread_rate, kit_size, unit_cost, active, notes)
values
  ('Simiron MVB - Standalone', 'Basecoat', 'Simiron', 'Simiron', 'Clear', 100, 3, null, true, 'Standalone moisture vapor barrier application (100 sqft/gal). Distinct from the in-Metallic-system MVB which goes down at 150 sqft/gal. Toggled on per-job via the New Job form.')
on conflict (name) do nothing;

-- ============================================================================
-- 4) Job-level standalone_mvb toggle
-- ============================================================================
alter table public.pec_prod_jobs add column if not exists standalone_mvb boolean not null default false;

commit;

-- Verify after running:
--   select material_type, count(*) from public.pec_prod_products
--     where active group by 1 order by 1;
--   -- expect: 'Metallic Pigment' shows 1 row (Simiron Metallic Pigment),
--   --         'Flake' drops by 1, 'Basecoat' loses 2 (Tinted Gray + Thin Coat)
--   --         and gains 1 (MVB Standalone).
--   select st.name as system, rs.material_type, count(*)
--     from public.pec_prod_recipe_slots rs
--     join public.pec_prod_system_types st on st.id = rs.system_type_id
--    where st.name='Metallic' group by 1,2 order by 2;
--   -- expect: Metallic / Metallic Pigment slot present, no Flake slot.
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='pec_prod_jobs'
--       and column_name='standalone_mvb';
--   -- expect: 1 row.
