-- ============================================================================
-- 2026-05-24: consolidate Polyaspartic SKUs into one canonical row
-- ============================================================================
-- Dylan: "all polyaspartic is quoted at $60 [now $66] per gallon no matter
-- the speed or kit size. condense all into one." Pricing is flat $66/gal ->
-- $132 per 2-gal kit, regardless of cure speed. Cure speed becomes a per-
-- area attribute (already supported via topcoat_cure_speed on the area).
--
-- Today the catalog has 5 polyaspartic rows:
--   * 'Polyaspartic Clear Gloss'                       (seed_pm_ordering.sql)
--   * 'Simiron Polyaspartic HS Slow Cure 10gal Kit'    (2026-05-17 pricing pass)
--   * 'Simiron Polyaspartic HS Medium Cure 10gal Kit'  (2026-05-17 pricing pass)
--   * 'Simiron Polyaspartic Medium Cure 2gal Kit'      (2026-05-17 pricing pass)
--   * 'Simiron Polyaspartic Fast Cure 2gal Kit'        (2026-05-17 pricing pass)
--
-- Target: ONE active row named 'Simiron Polyaspartic 2gal Kit' at the new
-- flat price. cureSpeedSpec() in index.html matches any product name
-- containing 'polyaspartic' so the per-area cure-speed dropdown keeps
-- working without code changes.
--
-- Steps:
--   1) Upsert the canonical row by name.
--   2) Repoint recipe slot default_product_id from 'Polyaspartic Clear Gloss'
--      to the canonical row (Flake + Quartz systems both default this slot).
--   3) Repoint historical pec_prod_material_lines rows from any of the 5
--      legacy SKUs to the canonical row, and rewrite the snapshot product_name
--      so historical job cost displays stay consistent.
--   4) Deactivate the 4 legacy variants so they disappear from the Material
--      Catalog UI. Do NOT delete: pec_prod_areas / job_areas / job_area_materials
--      FKs and material_lines stay valid, and deactivation is reversible.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

begin;

-- 0) Capture cure speed on the CRM-side job area. Was already a per-area
-- attribute on the production-side area object (search topcoat_cure_speed
-- in index.html) but never had a CRM column. The area editor will now
-- render a cure-speed selector next to the topcoat slot when the resolved
-- topcoat is polyaspartic; default 'Slow'.
alter table public.job_areas
  add column if not exists topcoat_cure_speed text;

-- 1) Canonical row, upsert by unique name
insert into public.pec_prod_products
  (name, material_type, supplier, color, spread_rate, kit_size, unit_cost, active, notes)
values
  ('Simiron Polyaspartic 2gal Kit', 'Topcoat', 'Simiron', 'Clear Gloss', 120, 2, 132.00, true,
   'Flat $66/gal pricing. Cure speed (Fast / Medium / Slow / XTRA Slow) chosen per-area at job time.')
on conflict (name) do update set
  material_type = excluded.material_type,
  supplier      = excluded.supplier,
  spread_rate   = excluded.spread_rate,
  kit_size      = excluded.kit_size,
  unit_cost     = excluded.unit_cost,
  active        = true,
  notes         = excluded.notes;

-- 2) Repoint recipe slot defaults
with canon as (
  select id from public.pec_prod_products where name = 'Simiron Polyaspartic 2gal Kit'
)
update public.pec_prod_recipe_slots
   set default_product_id = (select id from canon)
 where default_product_id in (
   select id from public.pec_prod_products
    where name in (
      'Polyaspartic Clear Gloss',
      'Simiron Polyaspartic HS Slow Cure 10gal Kit',
      'Simiron Polyaspartic HS Medium Cure 10gal Kit',
      'Simiron Polyaspartic Medium Cure 2gal Kit',
      'Simiron Polyaspartic Fast Cure 2gal Kit'
    )
 );

-- 3) Repoint historical material lines (snapshot fields too)
with canon as (
  select id, name from public.pec_prod_products where name = 'Simiron Polyaspartic 2gal Kit'
)
update public.pec_prod_material_lines ml
   set product_id   = (select id from canon),
       product_name = (select name from canon)
 where ml.product_id in (
   select id from public.pec_prod_products
    where name in (
      'Polyaspartic Clear Gloss',
      'Simiron Polyaspartic HS Slow Cure 10gal Kit',
      'Simiron Polyaspartic HS Medium Cure 10gal Kit',
      'Simiron Polyaspartic Medium Cure 2gal Kit',
      'Simiron Polyaspartic Fast Cure 2gal Kit'
    )
 );

-- 4) Deactivate the 4 legacy variants (and any 'Polyaspartic Clear Gloss'
--    seed row that pre-dated the pricing pass).
update public.pec_prod_products
   set active = false
 where name in (
   'Polyaspartic Clear Gloss',
   'Simiron Polyaspartic HS Slow Cure 10gal Kit',
   'Simiron Polyaspartic HS Medium Cure 10gal Kit',
   'Simiron Polyaspartic Medium Cure 2gal Kit',
   'Simiron Polyaspartic Fast Cure 2gal Kit'
 );

commit;

-- Verify after running:
--   select name, active, unit_cost, kit_size from public.pec_prod_products
--     where lower(name) like '%polyaspartic%' order by active desc, name;
--   -- expect 1 active row (Simiron Polyaspartic 2gal Kit, $132, 2gal) and
--   -- the 5 legacy rows all inactive.
--
--   select rs.id, rs.system_type_id, rs.label, pp.name as default_product
--     from public.pec_prod_recipe_slots rs
--     left join public.pec_prod_products pp on pp.id = rs.default_product_id
--    where rs.material_type = 'Topcoat'
--    order by rs.system_type_id;
--   -- expect every Topcoat slot that had a polyaspartic default to now point
--   -- at 'Simiron Polyaspartic 2gal Kit'.
