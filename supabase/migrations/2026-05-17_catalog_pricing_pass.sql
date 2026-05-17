-- 2026-05-17: Bulk pricing pass on pec_prod_products from the Simiron / multi-supplier
-- epoxy price list (Google Sheet 1S0EeQKa_mPZ0IFujGrRBdS3T2UYQFVAV7Kk9eL3i92I, gid 0).
--
-- Decisions captured in chat with Dylan during the Cowork session:
--   * Column H (Price per kit) is source of truth when populated. Where blank, kit
--     cost derived per row (per-gallon x kit gallons, or E IS the kit price when
--     notes confirm). 11 ambiguous rows confirmed individually with Dylan.
--   * Base+activator 5-gal pairs combined into one 10-gal kit at jug-cost x 2.
--   * Use newest dated price when multiple rows exist for the same product.
--   * 1100SL color variants: $144.27 flat across all Simiron 1100 SL color rows.
--     1100SL Clear: $139.03 (notes confirm $139.03 for the kit incl activator).
--   * Decorative Simiron Flake colors: $87.44 flat across 16 colors,
--     Autumn Brown special-cased at $91.64.
--   * Torginol Q-Color quartz: $38.25 (under-400-lb tier as default).
--   * Metallic Pigments (49 rows): $63.70 flat across the group.
--   * Polyaspartic Clear Gloss (existing): $153.02 (Slow Cure 2-gal, 1/15/2026).
--   * Resin Tek rows skipped entirely (Dylan does not order from them).
--
-- Idempotent. Updates are explicit; inserts use ON CONFLICT (name) DO UPDATE so
-- re-running will refresh prices but not duplicate rows.
--
-- After running, sanity-check totals at the bottom of this file.

begin;

-- ============================================================================
-- 1) Update unit_cost on existing rows the pricing rules cover.
-- ============================================================================

-- Simiron 1100 SL color variants (Basecoat) at $144.27 flat. Clear gets a
-- separate $139.03 because the price list explicitly broke it out.
update public.pec_prod_products
   set unit_cost = 144.27,
       effective_date = '2026-05-17',
       updated_at = now()
 where name in (
   'Simiron 1100 SL - Light Gray',
   'Simiron 1100 SL - Haze Gray',
   'Simiron 1100 SL - Deck Gray',
   'Simiron 1100 SL - Sandstone',
   'Simiron 1100 SL - White',
   'Simiron 1100 SL - Tinted Gray',
   'Simiron 1100 SL - Thin Coat'
 );

update public.pec_prod_products
   set unit_cost = 139.03,
       effective_date = '2026-05-17',
       updated_at = now()
 where name = 'Simiron 1100 SL - Clear';

-- Simiron MVB Standalone: 3-gal kit, $214.04 (notes: "$214.04 for kit
-- activator and tax included").
update public.pec_prod_products
   set unit_cost = 214.04,
       effective_date = '2026-05-17',
       updated_at = now()
 where name = 'Simiron MVB - Standalone';

-- Simiron High Wear Urethane (Topcoat, 1 gal kit).
update public.pec_prod_products
   set unit_cost = 199.36,
       effective_date = '2026-05-17',
       updated_at = now()
 where name = 'Simiron High Wear Urethane';

-- Polyaspartic Clear Gloss (Topcoat, 2 gal kit). Mapped to Polyaspartic Slow
-- Cure 2-gal 1/15/2026 row at $153.02.
update public.pec_prod_products
   set unit_cost = 153.02,
       effective_date = '2026-05-17',
       updated_at = now()
 where name = 'Polyaspartic Clear Gloss';

-- Simiron Metallic Pigment Pack (already classified as Metallic Pigment).
-- Price-list row: $63.70 per canister (makes 2 x 3-gal kits).
update public.pec_prod_products
   set unit_cost = 63.70,
       effective_date = '2026-05-17',
       updated_at = now()
 where name = 'Simiron Metallic Pigment';

-- All Metallic Pigment color rows flat at $63.70 per canister (per Dylan).
update public.pec_prod_products
   set unit_cost = 63.70,
       effective_date = '2026-05-17',
       updated_at = now()
 where material_type = 'Metallic Pigment'
   and unit_cost is null;

-- 17 Simiron-supplied flake colors flat at $87.44, except Autumn Brown
-- which is $91.64 per the price list (special-case). NOTE: actual row names
-- in prod are "<Color> Flake" (e.g. "Autumn Brown Flake"), not the longer
-- "Decorative Simiron Flake - <Color>" form that the 2026-05-04 catalog
-- expansion migration inserted. Some later rename collapsed the names. Match
-- on the short form here.
update public.pec_prod_products
   set unit_cost = 87.44,
       effective_date = '2026-05-17',
       updated_at = now()
 where material_type = 'Flake'
   and name like '% Flake'
   and name not in ('Autumn Brown Flake','Domino Flake');

update public.pec_prod_products
   set unit_cost = 91.64,
       effective_date = '2026-05-17',
       updated_at = now()
 where name = 'Autumn Brown Flake';

-- Domino Flake (legacy). Not on the price list, leave null.

-- All 41 Torginol Q-Color quartz rows at $38.25 (under-400-lb tier).
update public.pec_prod_products
   set unit_cost = 38.25,
       effective_date = '2026-05-17',
       updated_at = now()
 where name like 'Torginol Q-Color%'
   and material_type = 'Quartz';

-- ============================================================================
-- 2) Insert / upsert new products from the price list.
--    ON CONFLICT (name) DO UPDATE so a second run refreshes prices.
-- ============================================================================

insert into public.pec_prod_products
  (name, material_type, manufacturer, supplier, color, spread_rate, kit_size, unit_cost, effective_date, active, notes)
values
  -- ---- Topcoats: new entries ----
  ('Simiron Polyaspartic HS Slow Cure 10gal Kit',
   'Topcoat','Simiron','Simiron','Clear',125,10,765.10,'2026-01-15',true,
   '5 gal base + 5 gal activator at $382.55 each. Pair forms one 10-gal kit. Replaces older $437.20 pair (2025-10-16) and $819.74 single SKU (2025-11-07).'),
  ('Simiron Polyaspartic HS Medium Cure 10gal Kit',
   'Topcoat','Simiron','Simiron','Clear',125,10,856.16,'2025-10-30',true,
   '5 gal base + 5 gal activator at $428.08 each. Pair forms one 10-gal kit.'),
  ('Simiron Polyaspartic Medium Cure 2gal Kit',
   'Topcoat','Simiron','Simiron','Clear',120,2,122.41,'2026-02-13',true,
   '$61.21 per gallon x 2. Newest of three Medium Cure 2gal rows.'),
  ('Simiron Polyaspartic Fast Cure 2gal Kit',
   'Topcoat','Simiron','Simiron','Clear',120,2,153.02,'2026-01-15',true,
   '$76.51 per gallon x 2.'),
  ('Sherwin Williams PolyGuard 85 2gal Kit',
   'Topcoat','Sherwin Williams','Sherwin Williams','Clear',120,2,238.27,'2026-01-06',true,
   '$119.14 per gallon w/tax x 2.'),
  ('One Stop Epoxy Premera T2 Topcoat Gloss',
   'Topcoat','One Stop Epoxy','One Stop Epoxy','Gloss',120,1,165.00,'2025-07-07',true,
   'Single 1-gal kit.'),

  -- ---- Basecoats: standalone activators + alt bases ----
  ('Simiron 1100SL Standard Activator (standalone 1gal)',
   'Basecoat','Simiron','Simiron','N/A',150,1,48.09,'2025-10-01',true,
   'Standalone 1-gal activator for when a 1100SL base is purchased separately.'),
  ('Simiron 1100SL Fast Activator (standalone 1gal)',
   'Basecoat','Simiron','Simiron','N/A',150,1,48.09,'2026-01-08',true,
   'Standalone 1-gal fast activator.'),
  ('Simiron MVB Clear Activator (standalone 1gal)',
   'Basecoat','Simiron','Simiron','N/A',150,1,71.35,'2025-10-16',true,
   'Standalone activator for MVB Clear base; makes a 3-gal kit when paired with base.'),
  ('Simiron E-Flex 100% Flexible Solids Epoxy',
   'Basecoat','Simiron','Simiron','Clear',150,2,136.98,'2025-10-30',true,
   '2-gal kit. Specialty flexible solids epoxy.'),
  ('Simiron Metallic Epoxy 3gal Kit',
   'Basecoat','Simiron','Simiron','Per-job pick',50,3,157.10,'2026-03-04',true,
   '3-gal kit, 50 sqft/gal so 150 sqft/kit.'),

  -- ---- Sealers: new ----
  ('Acrylux Colorback Paver Sealer 5gal',
   'Sealer','Acrylux','Amazon','Clear',150,5,218.60,'2025-08-01',true,
   'Sold in 5 gallons; price is for 1 gallon ($43.72 x 5).'),
  ('DCP EZ Densifier 5gal',
   'Sealer','EZ','DCP Supply','Clear',150,5,135.12,'2025-11-24',true,
   '$27.02 per gallon x 5.'),
  ('DCP EZ Green Cut 5gal',
   'Sealer','EZ','DCP Supply','Clear',150,5,135.12,'2025-11-24',true,
   '$27.02 per gallon x 5.'),
  ('DCP EZ Superguard 5gal',
   'Sealer','EZ','DCP Supply','Clear',150,5,189.17,'2025-11-24',true,
   '$37.83 per gallon x 5.'),
  ('SureCrete Matte Agent (1 lb canister)',
   'Sealer','SureCrete','SureCrete','N/A',150,1,22.95,'2025-08-01',true,
   '10 scoops per canister; additive for sealer.'),
  ('Simiron Cure & Seal 5gal',
   'Sealer','Simiron','Simiron','Clear',150,5,166.90,'2025-11-07',true,
   '$33.38 per gallon x 5.'),

  -- ---- Stains: new ----
  ('Brickform Acid Stain 1gal',
   'Stain','Brickform','Best Material','Per-job pick',200,1,65.85,'2025-07-21',true,
   'Acid stain, 1 gallon.'),
  ('Ameripolish Classic Stain 1gal',
   'Stain','Ameripolish','Reliable Diamond','Per-job pick',200,1,75.27,'2025-07-07',true,
   'Single 1-gal kit.'),
  ('Ameripolish Classic Stain 5gal',
   'Stain','Ameripolish','Reliable Diamond','Per-job pick',200,5,326.20,'2025-07-10',true,
   '$65.24 per gallon x 5 (bulk discount vs 1-gal $75.27).'),
  ('Ameripolish Densifier 1gal',
   'Stain','Ameripolish','Reliable Diamond','Clear',200,1,71.86,'2025-10-17',true,
   'Single 1-gal kit. Densifier (classified as Stain to match its workflow).'),
  ('Reliable Diamond ColorSolve 1gal',
   'Stain','Reliable Diamond','Reliable Diamond','Per-job pick',200,1,81.82,'2025-07-10',true,
   'Single 1-gal kit.'),
  ('Reliable Diamond ColorSolve 5gal',
   'Stain','Reliable Diamond','Reliable Diamond','Per-job pick',200,5,376.07,'2025-07-10',true,
   '$75.21 per gallon x 5.'),
  ('Reliable Diamond SR2 Polishing Sealer 1gal',
   'Stain','Reliable Diamond','Reliable Diamond','Clear',200,1,193.70,'2025-07-10',true,
   'Single 1-gal kit.'),
  ('Reliable Diamond SR2 Polishing Sealer 5gal',
   'Stain','Reliable Diamond','Reliable Diamond','Clear',200,5,937.25,'2025-07-10',true,
   '$187.45 per gallon x 5.'),

  -- ---- Flake: new (Simiron's Special Flake line) ----
  ('Simiron Special Flake 40lb (Standard)',
   'Flake','Simiron','Simiron','Per-job pick',320,1,136.62,'2025-10-30',true,
   '40 lb box, premium Simiron special flake line.'),
  ('Simiron Special Flake 40lb - Carbon',
   'Flake','Simiron','Simiron','Carbon',320,1,125.69,'2025-10-30',true,
   '40 lb box.'),

  -- ---- Quartz: new (Sherwin Williams quartz granules) ----
  ('SW Quartz Granules 50lb (over-400lb tier)',
   'Quartz','Sherwin Williams','Sherwin Williams','Per-job pick',50,1,30.05,'2025-07-07',true,
   '50 lb bag. Tier price for orders over 400 lb. Spread 1 lb / sqft means a 50 lb bag covers 50 sqft.'),
  ('SW Quartz Granules 50lb (under-400lb tier)',
   'Quartz','Sherwin Williams','Sherwin Williams','Per-job pick',50,1,38.25,'2025-07-07',true,
   '50 lb bag. Tier price for orders under 400 lb. Default for cost estimates.'),

  -- ---- Metallic Pigments: new (Torginol 12 oz line) ----
  ('Torginol 12 oz Metallic Pigment',
   'Metallic Pigment','Torginol','Torginol','Per-job pick',120,1,36.48,'2025-11-25',true,
   '12 oz container, mixed at 1 per gallon.'),

  -- ---- Extras: new ----
  ('Simiron Instant Patch Polyurea Crack Filler 1gal',
   'Extra','Simiron','Simiron','N/A',1,1,82.16,'2025-10-30',true,
   '1 gallon kit.'),
  ('Simiron 800CF Epoxy Crack Filler 2gal Kit',
   'Extra','Simiron','Simiron','N/A',1,2,164.93,'2025-10-30',true,
   '2 gallon kit.'),
  ('Simiron 50 Tex Slip Resistant Additive (3.2 oz)',
   'Extra','Simiron','Simiron','N/A',1,1,11.05,'2025-11-07',true,
   '3.2 oz canister; makes 1 gallon.'),
  ('Simiron Thickening Fibers (3.5 lb bag)',
   'Extra','Simiron','Simiron','N/A',1,1,81.07,'2026-01-07',true,
   '3.5 lb bag.'),
  ('Self Leveling Concrete 50lb (orange bag)',
   'Extra','Home Depot','Home Depot','N/A',1,1,32.72,'2026-01-13',true,
   '50 lb bag.'),
  ('Metzger/McQuire Joint Filler 10gal Kit (with color pack)',
   'Extra','Metzger/McQuire','Polished Concrete Solutions','Per-job pick',1,10,628.47,'2026-01-13',true,
   '$62.85 per gallon x 10.'),
  ('Reliable Diamond 7-inch 2-mil Honeycomb Pad',
   'Extra','Reliable Diamond','Reliable Diamond','N/A',1,1,42.77,'2025-07-10',true,
   'Each.'),
  ('Reliable Diamond Backer Pad 3-inch Aluminum',
   'Extra','Reliable Diamond','Reliable Diamond','N/A',1,1,30.55,'2025-07-10',true,
   'Each.'),
  ('Reliable Diamond CRT Pad 3-inch 12mm',
   'Extra','Reliable Diamond','Reliable Diamond','N/A',1,1,34.91,'2025-07-10',true,
   'Each.'),
  ('Reliable Diamond CRT Pad 3-inch 3mm',
   'Extra','Reliable Diamond','Reliable Diamond','N/A',1,1,8.73,'2025-07-10',true,
   'Each.'),
  ('Reliable Diamond CRT Pad 7-inch',
   'Extra','Reliable Diamond','Reliable Diamond','N/A',1,1,41.46,'2025-07-10',true,
   'Each.')
on conflict (name) do update set
  unit_cost = excluded.unit_cost,
  effective_date = excluded.effective_date,
  active = excluded.active,
  notes = excluded.notes,
  updated_at = now();

commit;

-- ============================================================================
-- Verification queries (run after apply):
-- ============================================================================
-- A) Spot-check the 1100SL pricing:
--    select name, unit_cost from pec_prod_products where name like 'Simiron 1100 SL%' order by name;
-- B) Confirm all 17 Decorative Simiron Flake colors got priced:
--    select name, unit_cost from pec_prod_products where name like 'Decorative Simiron Flake -%' order by name;
--    -- expect: Autumn Brown $91.64, other 16 at $87.44.
-- C) Quartz coverage:
--    select count(*) from pec_prod_products where material_type='Quartz' and unit_cost is not null;
--    -- expect: at least 41 (the Torginol Q-Color rows) plus 2 new SW Quartz Granules.
-- D) Metallic Pigment coverage:
--    select count(*) from pec_prod_products where material_type='Metallic Pigment' and unit_cost is not null;
--    -- expect: 49 existing + 1 Torginol 12oz = 50.
-- E) New topcoats present:
--    select name, unit_cost from pec_prod_products where material_type='Topcoat' order by name;
-- F) Catalog-wide priced row count:
--    select material_type, count(*) filter (where unit_cost is not null) as priced,
--           count(*) as total
--      from pec_prod_products where active
--     group by material_type order by material_type;
