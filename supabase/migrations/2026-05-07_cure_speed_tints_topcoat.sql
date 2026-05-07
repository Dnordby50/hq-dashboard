-- 2026-05-06: cure speed + per-area U-Tint attachments + per-area topcoat override.
--
-- Three concerns in one migration since they all touch the area editor and the
-- material planner together:
--
--   1) pec_prod_areas gets a topcoat_product_id override (defaulted from the
--      recipe slot, overridable per area). Mirrors the existing
--      basecoat_product_id pattern. Required so per-area U-Tints can target a
--      specific topcoat instead of whatever happens to be in the recipe.
--
--   2) Cure speed authoring lives on pec_prod_areas as two text columns
--      (basecoat_cure_speed, topcoat_cure_speed). Two columns, not one, because
--      the cure-speed enums differ per product family (1100 SL: Fast/Standard/
--      Slow; Polyaspartic HS: Fast/Medium/Slow/XTRA Slow). The planner stamps
--      the value onto the matching computed material_line as cure_speed
--      (mirrors the unit_cost_snapshot pattern).
--
--   3) New table pec_prod_area_tints: per-area attachments of U-Tint Packs
--      onto either the basecoat or the topcoat for that area. The planner
--      reads this table and emits separate Tint Pack lines into
--      pec_prod_material_lines so each tint shows up as its own invoice line
--      and so backstock/ordered/delivered tracking works the same way as for
--      every other line.
--
-- Then 14 U-Tint Pack catalog rows are inserted at the bottom so the new
-- pickers in the area editor have something to pick from. Catalog values
-- (color, image, price) come from Simiron's public Shopify catalog
-- (shop.simiron.com). unit_cost is set to Simiron retail since dealer cost
-- was not in hand at migration time. Cowork should verify dealer cost.
--
-- No CHECK constraint changes needed: 'Tint Pack' is already an allowed
-- material_type on pec_prod_products / pec_prod_recipe_slots /
-- pec_prod_material_lines (added in 2026-05-04_metallic_pigment_split.sql).

-- ============================================================================
-- 1) pec_prod_areas: topcoat override + cure speed
-- ============================================================================
alter table public.pec_prod_areas
  add column if not exists topcoat_product_id uuid references public.pec_prod_products(id) on delete set null;
alter table public.pec_prod_areas
  add column if not exists basecoat_cure_speed text;
alter table public.pec_prod_areas
  add column if not exists topcoat_cure_speed  text;

-- ============================================================================
-- 2) pec_prod_material_lines: cure speed snapshot
-- ============================================================================
alter table public.pec_prod_material_lines
  add column if not exists cure_speed text;

-- ============================================================================
-- 3) pec_prod_area_tints: per-area U-Tint attachments
-- ============================================================================
create table if not exists public.pec_prod_area_tints (
  id uuid primary key default gen_random_uuid(),
  area_id uuid not null references public.pec_prod_areas(id) on delete cascade,
  product_id uuid not null references public.pec_prod_products(id) on delete restrict,
  attach_to text not null check (attach_to in ('Basecoat','Topcoat')),
  packs int not null default 1 check (packs > 0),
  order_index int not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_pec_prod_area_tints_area    on public.pec_prod_area_tints(area_id, order_index);
create index if not exists idx_pec_prod_area_tints_product on public.pec_prod_area_tints(product_id);

drop trigger if exists trg_pec_prod_area_tints_touch on public.pec_prod_area_tints;
create trigger trg_pec_prod_area_tints_touch before update on public.pec_prod_area_tints
  for each row execute function public.pec_prod_touch_updated_at();

-- RLS, matching every other pec_prod_* table (staff full access, anonymous denied).
alter table public.pec_prod_area_tints enable row level security;
drop policy if exists pec_prod_area_tints_staff on public.pec_prod_area_tints;
create policy pec_prod_area_tints_staff on public.pec_prod_area_tints for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

-- ============================================================================
-- 4) Seed the 14 U-Tint Pack catalog rows.
--
-- Pricing: Simiron retail from shop.simiron.com. Three retail tiers exist
-- (the standard colors at $22, Sky Blue at $29.50, the safety colors at $59).
-- spread_rate is set to 240 sqft/pack as a rough match for one 3-gal 1100 SL
-- kit; in practice the planner pulls quantity from pec_prod_area_tints (not
-- sqft math) so this number is mostly cosmetic for the catalog display.
-- ============================================================================
insert into public.pec_prod_products
  (name, material_type, manufacturer, supplier, color, spread_rate, kit_size, unit_cost, active, notes, image_url)
values
  ('Simiron U-Tint Pack 16oz - Black',          'Tint Pack', 'Simiron', 'Simiron', 'Black',          240, 1, 22.00, true, 'Quantity is set per-area in pec_prod_area_tints, not by sqft. SKU 40009335.', 'https://shop.simiron.com/cdn/shop/files/BC_Upload_4142a330-ac82-4b2f-8856-deef79d384e1.png'),
  ('Simiron U-Tint Pack 16oz - Deck Gray',      'Tint Pack', 'Simiron', 'Simiron', 'Deck Gray',      240, 1, 22.00, true, 'Quantity is set per-area in pec_prod_area_tints, not by sqft. SKU 40009229.', 'https://shop.simiron.com/cdn/shop/files/BC_Upload_8a92e26f-2cb5-427d-844a-dcd8d5c4a084.png'),
  ('Simiron U-Tint Pack 16oz - Haze Gray',      'Tint Pack', 'Simiron', 'Simiron', 'Haze Gray',      240, 1, 22.00, true, 'Quantity is set per-area in pec_prod_area_tints, not by sqft. SKU 40009212.', 'https://shop.simiron.com/cdn/shop/files/BC_Upload_f884e697-a59e-4c4e-bdfd-0d13218fb736.png'),
  ('Simiron U-Tint Pack 16oz - Light Gray',     'Tint Pack', 'Simiron', 'Simiron', 'Light Gray',     240, 1, 22.00, true, 'Quantity is set per-area in pec_prod_area_tints, not by sqft. SKU 40009205.', 'https://shop.simiron.com/cdn/shop/files/BC_Upload_e91dde41-d12a-4a8c-a0ec-e8dc6f867d5b.png'),
  ('Simiron U-Tint Pack 16oz - Safety Blue',    'Tint Pack', 'Simiron', 'Simiron', 'Safety Blue',    240, 1, 59.00, true, 'Quantity is set per-area in pec_prod_area_tints, not by sqft. SKU 40009748.', 'https://shop.simiron.com/cdn/shop/files/BC_Upload_ddd077c7-7861-4606-be38-cfb160eed762.png'),
  ('Simiron U-Tint Pack 16oz - Safety Green',   'Tint Pack', 'Simiron', 'Simiron', 'Safety Green',   240, 1, 59.00, true, 'Quantity is set per-area in pec_prod_area_tints, not by sqft. SKU 40009762.', 'https://shop.simiron.com/cdn/shop/files/BC_Upload_ec03e2a1-79c3-4042-afdd-340846a09ace.png'),
  ('Simiron U-Tint Pack 16oz - Safety Orange',  'Tint Pack', 'Simiron', 'Simiron', 'Safety Orange',  240, 1, 59.00, true, 'Quantity is set per-area in pec_prod_area_tints, not by sqft. SKU 40009755.', 'https://shop.simiron.com/cdn/shop/files/BC_Upload_1cda7886-c792-42ac-8887-6701b2270e9f.png'),
  ('Simiron U-Tint Pack 16oz - Safety Red',     'Tint Pack', 'Simiron', 'Simiron', 'Safety Red',     240, 1, 59.00, true, 'Quantity is set per-area in pec_prod_area_tints, not by sqft. SKU 40009786.', 'https://shop.simiron.com/cdn/shop/files/BC_Upload_66a0bf3b-e4b3-4bdf-b92f-684e7e334559.png'),
  ('Simiron U-Tint Pack 16oz - Safety Yellow',  'Tint Pack', 'Simiron', 'Simiron', 'Safety Yellow',  240, 1, 59.00, true, 'Quantity is set per-area in pec_prod_area_tints, not by sqft. SKU 40009779.', 'https://shop.simiron.com/cdn/shop/files/BC_Upload_d07a3ce1-6e0c-4924-a51d-54dc2ef28baf.png'),
  ('Simiron U-Tint Pack 16oz - Sandstone',      'Tint Pack', 'Simiron', 'Simiron', 'Sandstone',      240, 1, 22.00, true, 'Quantity is set per-area in pec_prod_area_tints, not by sqft. SKU 40009236.', 'https://shop.simiron.com/cdn/shop/files/BC_Upload_c398b112-f552-4ad3-8513-38c8095a5105.png'),
  ('Simiron U-Tint Pack 16oz - Sky Blue',       'Tint Pack', 'Simiron', 'Simiron', 'Sky Blue',       240, 1, 29.50, true, 'Quantity is set per-area in pec_prod_area_tints, not by sqft. SKU 40009144.', 'https://shop.simiron.com/cdn/shop/files/BC_Upload_4cfc8713-8081-4a1c-9b87-df400b86db17.png'),
  ('Simiron U-Tint Pack 16oz - Taupe',          'Tint Pack', 'Simiron', 'Simiron', 'Taupe',          240, 1, 22.00, true, 'Quantity is set per-area in pec_prod_area_tints, not by sqft. SKU 40009793.', 'https://shop.simiron.com/cdn/shop/files/BC_Upload_f9ac73d2-1c3f-4e61-ba4b-0ec71c9538e4.png'),
  ('Simiron U-Tint Pack 16oz - Tile Red',       'Tint Pack', 'Simiron', 'Simiron', 'Tile Red',       240, 1, 22.00, true, 'Quantity is set per-area in pec_prod_area_tints, not by sqft. SKU 40009342.', 'https://shop.simiron.com/cdn/shop/files/BC_Upload_d9e6c4dd-f7ef-44c0-bb8a-1990ddc6050c.png'),
  ('Simiron U-Tint Pack 16oz - White',          'Tint Pack', 'Simiron', 'Simiron', 'White',          240, 1, 22.00, true, 'Quantity is set per-area in pec_prod_area_tints, not by sqft. SKU 40009328.', 'https://shop.simiron.com/cdn/shop/files/BC_Upload_f4460f87-236b-45ed-993d-65071ca3480a.png');

-- ============================================================================
-- Verification queries (run after the migration):
--   select count(*) from public.pec_prod_products where material_type = 'Tint Pack';
--     -> should be 14 (assuming this migration runs once on a database that
--        had no Tint Pack rows beforehand; per a 2026-05-06 search of every
--        prior migration there are none).
--
--   select column_name from information_schema.columns
--    where table_name = 'pec_prod_areas'
--      and column_name in ('topcoat_product_id','basecoat_cure_speed','topcoat_cure_speed');
--     -> should return all three.
--
--   select column_name from information_schema.columns
--    where table_name = 'pec_prod_material_lines' and column_name = 'cure_speed';
--     -> should return one row.
--
--   select to_regclass('public.pec_prod_area_tints');
--     -> should return public.pec_prod_area_tints (not null).
-- ============================================================================
