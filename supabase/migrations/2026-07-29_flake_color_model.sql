-- @artifacts
--   column: public.colors.product_id
--   column: public.colors.default_basecoat_product_id
--   column: public.colors.active
--   column: public.pec_prod_areas.flake_color_id
--   column: public.job_areas.flake_color_id
-- @end
--
-- Prompt 57 Part G: condense the standard flake catalog. 18 of the 21 Torginol
-- named-color flake products are numerically identical ($87.44 / 325 spread /
-- kit 1); they collapse into ONE product (the repurposed "Standard Flake
-- (color TBD)" row, 8fb6d88d) and the BLEND moves to the colors table, which
-- also takes over the flake -> default basecoat pairing. Obsidian ($120/300),
-- Autumn Brown ($91.64) and Stonewash (300 rate) stay standalone products
-- because their numbers differ. The 18 collapsed products are DEACTIVATED,
-- never deleted: pec_prod_areas.flake_product_id and job_areas.flake_product_id
-- still point at them on historical rows and must keep resolving for costing.
--
-- READ BEFORE APPLYING (flagged in PROJECT-LOG 2026-07-28): the customer
-- portal color picker (get_portal_job_catalog RPC) and the CRM job-card swatch
-- grid list only ACTIVE products, so once step 8 runs, those two surfaces
-- offer the condensed product list (Standard Flake + the 3 outliers + Simiron
-- Special) instead of the 21 blend names. The estimator's New Job flake picker
-- is colors-driven after this migration and keeps all 21 blends. Dylan decides
-- whether that trade is acceptable before this file is applied.
--
-- RESOLVED 2026-07-29 (Cowork): steps 1-7 APPLIED to prod; step 8 HELD and
-- split into 2026-07-30_flake_deactivate_collapsed_blends.sql. Dylan cleared
-- the customer side (the portal is not in use yet), but the CRM job-card
-- swatch grid is the STAFF colour-pick surface on booked jobs and with the
-- portal unused it is currently the only one, so it would lose 18 of 21
-- options. Re-running THIS file is safe and idempotent.

-- 1. Colors learn which product prices them, their default basecoat pairing,
--    and an active flag (mirroring products, for future retirements).
alter table public.colors add column if not exists product_id uuid references public.pec_prod_products(id);
alter table public.colors add column if not exists default_basecoat_product_id uuid references public.pec_prod_products(id);
alter table public.colors add column if not exists active boolean not null default true;

-- 2. Insert the six flake blends missing from colors (Garnet, Obsidian,
--    Pumice, Schist, Stonewash, Wombat). Hex values are reasonable neutrals
--    derived from the blend appearance, NOT sourced from Simiron; sku stays
--    NULL on purpose (never invent a SKU). Flagged in the log for Dylan to
--    correct the hexes if he has the real chips.
insert into public.colors (name, type, category, hex)
select v.name, 'simiron', 'flake-blend', v.hex
from (values
  ('Garnet',    '#6E3B3B'),
  ('Obsidian',  '#1C1C1E'),
  ('Pumice',    '#A8A296'),
  ('Schist',    '#6E675E'),
  ('Stonewash', '#7E8C99'),
  ('Wombat',    '#757065')
) as v(name, hex)
where not exists (
  select 1 from public.colors c where c.name = v.name and c.category = 'flake-blend'
);

-- 3. Backfill each color's default basecoat from its matching Torginol flake
--    product (products.color = colors.name), so the pairing the estimator
--    auto-selected yesterday is the pairing the color carries today.
update public.colors c
set default_basecoat_product_id = p.default_basecoat_product_id
from public.pec_prod_products p
where c.category = 'flake-blend'
  and c.default_basecoat_product_id is null
  and p.material_type = 'Flake'
  and p.manufacturer = 'Torginol'
  and p.color = c.name;

-- 4. Backfill colors.product_id: the three outliers point at their own
--    surviving products; the other 18 point at the single standard flake.
update public.colors set product_id = '826ad502-64d3-46f9-b5f6-f075abf1dbdd' where category = 'flake-blend' and name = 'Obsidian'     and product_id is null;
update public.colors set product_id = 'b42e5b92-4f07-4c6d-8dbc-2fca9a276447' where category = 'flake-blend' and name = 'Autumn Brown' and product_id is null;
update public.colors set product_id = 'abdd9e31-b41f-40cb-9e59-e51d29b36d6f' where category = 'flake-blend' and name = 'Stonewash'    and product_id is null;
update public.colors set product_id = '8fb6d88d-33f3-4886-84d0-5e1eb8321509' where category = 'flake-blend' and product_id is null;

-- 5. Repurpose the TBD placeholder as THE standard flake product, worded like
--    "Simiron Special Flake 40lb (Standard)" already is.
update public.pec_prod_products
set name = 'Standard Flake', color = 'Per-job pick'
where id = '8fb6d88d-33f3-4886-84d0-5e1eb8321509';

-- 6. Areas learn which blend they carry (the product keeps pricing them).
alter table public.pec_prod_areas add column if not exists flake_color_id uuid references public.colors(id);
alter table public.job_areas add column if not exists flake_color_id uuid references public.colors(id);

-- 7. Backfill flake_color_id from the existing flake product's color name, so
--    every existing job keeps showing the blend it was sold with.
update public.pec_prod_areas a
set flake_color_id = c.id
from public.pec_prod_products p
join public.colors c on c.category = 'flake-blend' and c.name = p.color
where a.flake_color_id is null
  and a.flake_product_id = p.id
  and p.material_type = 'Flake'
  and p.manufacturer = 'Torginol';

update public.job_areas a
set flake_color_id = c.id
from public.pec_prod_products p
join public.colors c on c.category = 'flake-blend' and c.name = p.color
where a.flake_color_id is null
  and a.flake_product_id = p.id
  and p.material_type = 'Flake'
  and p.manufacturer = 'Torginol';

-- 8. (MOVED) Deactivating the 18 collapsed products now lives in
--    2026-07-30_flake_deactivate_collapsed_blends.sql and is NOT applied.
--    See that file's header for why. Steps 1-7 above were applied 2026-07-29
--    and do not depend on it.

-- Verify:
--   select count(*) from colors where category = 'flake-blend';                          -- 21
--   select count(*) from colors where category = 'flake-blend' and product_id is null;   -- 0
--   select count(*) from colors where category = 'flake-blend'
--     and default_basecoat_product_id is null;                                           -- 0
--   select name, color, active from pec_prod_products
--     where id = '8fb6d88d-33f3-4886-84d0-5e1eb8321509';                                 -- Standard Flake / Per-job pick / true
--   select count(*) from pec_prod_products where material_type = 'Flake' and active;     -- 25 while step 8 is held (7 once it runs)
--   select count(*) from pec_prod_areas where flake_product_id is not null
--     and flake_color_id is null;   -- only rows whose product is not a Torginol blend
--                                   -- (Simiron Special, Special Order, Standard Flake pre-pick)
