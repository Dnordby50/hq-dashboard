-- 2026-05-04: expand the PEC material catalog.
--
-- 1) Add manufacturer + image_url columns to pec_prod_products.
--    Manufacturer (Torginol) is who makes the material; supplier (Simiron,
--    Prestige Protective Coatings, Cohills) is who we order it from. They are
--    not the same thing for flake/quartz colors. image_url is the chip image
--    URL; left null until Dylan uploads.
-- 2) Backfill manufacturer for existing rows where it can be inferred.
-- 3) Insert 17 new Decorative Simiron Flake colors (Torginol-manufactured,
--    Simiron-supplied). Domino already exists from the original seed.
-- 4) Insert 6 new Simiron 1100 SL basecoat color variants (Light Gray, Haze
--    Gray, Deck Gray, Sandstone, White, Clear). Tinted Gray already exists.
--
-- Run order: 2026-05-04_quartz_material_type.sql FIRST (so 'Quartz' is allowed
-- by the CHECK constraint), THEN this file. Idempotent. Safe to re-run.

begin;

-- ============================================================================
-- 1) Schema additions
-- ============================================================================
alter table public.pec_prod_products add column if not exists manufacturer text;
alter table public.pec_prod_products add column if not exists image_url text;

-- ============================================================================
-- 2) Backfill manufacturer where it's unambiguous from name/supplier.
-- ============================================================================
update public.pec_prod_products
   set manufacturer = 'Torginol'
 where manufacturer is null
   and (name like 'Torginol Q-Color%' or name like 'Decorative Simiron Flake%');

update public.pec_prod_products
   set manufacturer = 'Simiron'
 where manufacturer is null
   and supplier = 'Simiron';

update public.pec_prod_products
   set manufacturer = 'Cohills'
 where manufacturer is null
   and supplier = 'Cohills';

-- ============================================================================
-- 3) Insert 17 new Decorative Simiron Flake colors (Torginol-made, Simiron
--    primary supplier; Prestige Protective Coatings is the backup supplier
--    selectable per-job). Mirrors the existing Domino product shape.
-- ============================================================================
insert into public.pec_prod_products
  (name, material_type, manufacturer, supplier, color, spread_rate, kit_size, unit_cost, active, notes)
values
  ('Decorative Simiron Flake - Autumn Brown', 'Flake', 'Torginol', 'Simiron', 'Autumn Brown', 325, 1, null, true, 'Torginol-manufactured, Simiron-supplied. Prestige Protective Coatings is a backup supplier.'),
  ('Decorative Simiron Flake - Cabin Fever',  'Flake', 'Torginol', 'Simiron', 'Cabin Fever',  325, 1, null, true, 'Torginol-manufactured, Simiron-supplied.'),
  ('Decorative Simiron Flake - Coyote',       'Flake', 'Torginol', 'Simiron', 'Coyote',       325, 1, null, true, 'Torginol-manufactured, Simiron-supplied.'),
  ('Decorative Simiron Flake - Creekbed',     'Flake', 'Torginol', 'Simiron', 'Creekbed',     325, 1, null, true, 'Torginol-manufactured, Simiron-supplied.'),
  ('Decorative Simiron Flake - Feather Gray', 'Flake', 'Torginol', 'Simiron', 'Feather Gray', 325, 1, null, true, 'Torginol-manufactured, Simiron-supplied.'),
  ('Decorative Simiron Flake - Garnet',       'Flake', 'Torginol', 'Simiron', 'Garnet',       325, 1, null, true, 'Torginol-manufactured, Simiron-supplied.'),
  ('Decorative Simiron Flake - Glacier',      'Flake', 'Torginol', 'Simiron', 'Glacier',      325, 1, null, true, 'Torginol-manufactured, Simiron-supplied.'),
  ('Decorative Simiron Flake - Gravel',       'Flake', 'Torginol', 'Simiron', 'Gravel',       325, 1, null, true, 'Torginol-manufactured, Simiron-supplied.'),
  ('Decorative Simiron Flake - Nightfall',    'Flake', 'Torginol', 'Simiron', 'Nightfall',    325, 1, null, true, 'Torginol-manufactured, Simiron-supplied.'),
  ('Decorative Simiron Flake - Orbit',        'Flake', 'Torginol', 'Simiron', 'Orbit',        325, 1, null, true, 'Torginol-manufactured, Simiron-supplied.'),
  ('Decorative Simiron Flake - Outback',      'Flake', 'Torginol', 'Simiron', 'Outback',      325, 1, null, true, 'Torginol-manufactured, Simiron-supplied.'),
  ('Decorative Simiron Flake - Pumice',       'Flake', 'Torginol', 'Simiron', 'Pumice',       325, 1, null, true, 'Torginol-manufactured, Simiron-supplied.'),
  ('Decorative Simiron Flake - Safari',       'Flake', 'Torginol', 'Simiron', 'Safari',       325, 1, null, true, 'Torginol-manufactured, Simiron-supplied.'),
  ('Decorative Simiron Flake - Schist',       'Flake', 'Torginol', 'Simiron', 'Schist',       325, 1, null, true, 'Torginol-manufactured, Simiron-supplied.'),
  ('Decorative Simiron Flake - Shoreline',    'Flake', 'Torginol', 'Simiron', 'Shoreline',    325, 1, null, true, 'Torginol-manufactured, Simiron-supplied.'),
  ('Decorative Simiron Flake - Stargazer',    'Flake', 'Torginol', 'Simiron', 'Stargazer',    325, 1, null, true, 'Torginol-manufactured, Simiron-supplied.'),
  ('Decorative Simiron Flake - Tidal Wave',   'Flake', 'Torginol', 'Simiron', 'Tidal Wave',   325, 1, null, true, 'Torginol-manufactured, Simiron-supplied.')
on conflict (name) do nothing;

-- ============================================================================
-- 4) Insert 6 new Simiron 1100 SL basecoat color variants. Mirrors the
--    existing 'Simiron 1100 SL - Tinted Gray' product (spread 150 sqft/gal,
--    3 gal kit). These are real stock SKUs ordered by color.
-- ============================================================================
insert into public.pec_prod_products
  (name, material_type, manufacturer, supplier, color, spread_rate, kit_size, unit_cost, active, notes)
values
  ('Simiron 1100 SL - Light Gray', 'Basecoat', 'Simiron', 'Simiron', 'Light Gray', 150, 3, null, true, 'Stock basecoat color. Verify spread + kit against invoice.'),
  ('Simiron 1100 SL - Haze Gray',  'Basecoat', 'Simiron', 'Simiron', 'Haze Gray',  150, 3, null, true, 'Stock basecoat color.'),
  ('Simiron 1100 SL - Deck Gray',  'Basecoat', 'Simiron', 'Simiron', 'Deck Gray',  150, 3, null, true, 'Stock basecoat color.'),
  ('Simiron 1100 SL - Sandstone',  'Basecoat', 'Simiron', 'Simiron', 'Sandstone',  150, 3, null, true, 'Stock basecoat color.'),
  ('Simiron 1100 SL - White',      'Basecoat', 'Simiron', 'Simiron', 'White',      150, 3, null, true, 'Stock basecoat color.'),
  ('Simiron 1100 SL - Clear',      'Basecoat', 'Simiron', 'Simiron', 'Clear',      150, 3, null, true, 'Stock basecoat. Often used as the body coat in Quartz systems.')
on conflict (name) do nothing;

commit;

-- Verify after running:
--   select material_type, count(*) from public.pec_prod_products
--     where active group by 1 order by 1;
--   -- Flake: 18 (17 new + Domino), Quartz: 41, Basecoat: ~9 (Tinted Gray + 6 new + Thin Coat + MVB + Clear).
--   select distinct manufacturer from public.pec_prod_products order by 1;
--   -- expect: Cohills, Simiron, Torginol, possibly NULL for any older row not classified.
