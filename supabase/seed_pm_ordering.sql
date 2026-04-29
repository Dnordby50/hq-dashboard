-- PEC PM Module 1: Standard Flake System seed.
-- Idempotent. Safe to re-run. Uses ON CONFLICT on natural keys.
-- Run after supabase/migrations/2026-04-28_pm_ordering.sql.

-- ----------------------------------------------------------------------------
-- Products
-- ----------------------------------------------------------------------------
insert into public.pec_prod_products
  (name, material_type, supplier, color, spread_rate, kit_size, unit_cost, notes)
values
  ('Simiron 1100 SL - Tinted Gray', 'Basecoat', 'Simiron', 'Tinted Gray',     150,   3, null, 'Two-component epoxy basecoat. 150 sq ft per gallon, 3 gal kit.'),
  ('Decorative Simiron Flake - Domino', 'Flake',  'Simiron', 'Domino',         350,   1, null, '1/4" chip blend. Coverage assumed at 350 sq ft per box.'),
  ('Polyaspartic Clear Gloss',         'Topcoat','Simiron', 'Clear Gloss',    120,   2, null, 'Polyaspartic topcoat. 120 sq ft per gallon, 2 gal kit.')
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- System Type
-- ----------------------------------------------------------------------------
insert into public.pec_prod_system_types
  (name, description, requires_flake_color, requires_basecoat_color, notes)
values
  ('Standard Flake',
   'PEC standard residential garage flake system: tinted basecoat, broadcast flake, polyaspartic topcoat.',
   true, true,
   'Default seed system. Edit recipe slots in System Catalog as needed.')
on conflict (name) do nothing;

-- ----------------------------------------------------------------------------
-- Recipe Slots for Standard Flake
-- ----------------------------------------------------------------------------
with sys as (select id from public.pec_prod_system_types where name = 'Standard Flake'),
     basecoat as (select id from public.pec_prod_products where name = 'Simiron 1100 SL - Tinted Gray'),
     topcoat as (select id from public.pec_prod_products where name = 'Polyaspartic Clear Gloss')
insert into public.pec_prod_recipe_slots
  (system_type_id, order_index, material_type, default_product_id, required, notes)
select sys.id, 1, 'Basecoat', basecoat.id, true,  'Override at job time if customer picks a non-default basecoat color' from sys, basecoat
union all
select sys.id, 2, 'Flake',    null,         true, 'User selects flake color per job' from sys
union all
select sys.id, 3, 'Topcoat',  topcoat.id,   true, 'Standard polyaspartic clear' from sys, topcoat
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- Color Pairing: Domino flake -> Tinted Gray basecoat (default)
-- ----------------------------------------------------------------------------
with flake as (select id from public.pec_prod_products where name = 'Decorative Simiron Flake - Domino'),
     basecoat as (select id from public.pec_prod_products where name = 'Simiron 1100 SL - Tinted Gray')
insert into public.pec_prod_color_pairings (flake_product_id, basecoat_product_id, is_default, notes)
select flake.id, basecoat.id, true, 'Seed pairing: Domino reads richer on Tinted Gray base'
from flake, basecoat
on conflict (flake_product_id, basecoat_product_id) do nothing;
