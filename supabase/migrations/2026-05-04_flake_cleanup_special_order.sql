-- 2026-05-04: flake naming cleanup + flake size + special-order placeholder.
--
-- Three changes:
--
-- 1) Rename existing Decorative Simiron Flake rows. The "Decorative Simiron
--    Flake - " prefix was fluff. New convention: "<Color> Flake" (e.g.
--    "Autumn Brown Flake"). Color column is unchanged so calendar dots and
--    color pairings keep working. Only material_type='Flake' rows are
--    touched; Quartz blends keep their Torginol Q-Color naming.
--
-- 2) Add flake_size + special_order_color text columns to pec_prod_areas.
--    flake_size defaults to '1/4"' (the standard cut). When a customer
--    requests 1/8" or another spec, set per-area. Doesn't affect spread rate
--    or pricing; it's an order-printout note. special_order_color is a
--    free-text custom color name for one-off requests that we don't stock.
--
-- 3) Insert two placeholder products ("Special Order Flake" and "Special
--    Order Quartz"). When a New Job area is marked special_order, the form
--    auto-picks the matching placeholder so the material calculator still
--    has a product to compute against; the actual color name lives in
--    pec_prod_areas.special_order_color and renders on the order pull.
--    The catalog stays clean of one-off colors.
--
-- Idempotent. Safe to re-run.

begin;

-- ============================================================================
-- 1) Rename Decorative Simiron Flake products
-- ============================================================================
update public.pec_prod_products
   set name = color || ' Flake'
 where material_type = 'Flake'
   and name like 'Decorative Simiron Flake - %'
   and color is not null;

-- ============================================================================
-- 2) New columns on pec_prod_areas
-- ============================================================================
alter table public.pec_prod_areas add column if not exists flake_size           text;
alter table public.pec_prod_areas add column if not exists special_order_color  text;

-- ============================================================================
-- 3) Special-order placeholder products
-- ============================================================================
insert into public.pec_prod_products
  (name, material_type, manufacturer, supplier, color, spread_rate, kit_size, unit_cost, active, notes)
values
  ('Special Order Flake',  'Flake',  null, null, 'Per-job custom', 325, 1, null, true, 'Placeholder product for one-off custom flake colors. The job-specific color name lives on pec_prod_areas.special_order_color and renders on the order pull. Spread rate matches the Simiron decorative flake standard so the calculator math works.'),
  ('Special Order Quartz', 'Quartz', null, null, 'Per-job custom', 50,  1, null, true, 'Placeholder product for one-off custom quartz blends. Color name lives on pec_prod_areas.special_order_color. Spread rate matches Torginol Q-Color #40 standard.')
on conflict (name) do nothing;

commit;

-- Verify after running:
--   select count(*) from public.pec_prod_products
--     where material_type = 'Flake'
--       and name like 'Decorative Simiron Flake - %';
--   -- expect: 0 (all renamed)
--   select name from public.pec_prod_products
--     where material_type = 'Flake' order by name limit 5;
--   -- expect: "Autumn Brown Flake", "Cabin Fever Flake", ...
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='pec_prod_areas'
--       and column_name in ('flake_size','special_order_color');
--   -- expect: 2 rows
--   select name, material_type from public.pec_prod_products
--     where name like 'Special Order%';
--   -- expect: 2 rows (Flake + Quartz placeholders)
