-- PEC PM Module 1: Full system catalog + recipe slot wiring.
--
-- Run AFTER:
--   supabase/migrations/2026-04-28_pm_ordering.sql   (creates the pec_prod_* tables)
--   supabase/seed_pm_ordering.sql                    (3 starter products + Standard Flake)
--   supabase/seed_pec_systems.sql                    (5 system rows: Flake, Quartz, Metallic, Grind and Seal, Grind Stain and Seal)
--
-- This file is idempotent for the catalog inserts (ON CONFLICT (name) DO NOTHING)
-- and the recipe-slot inserts (it deletes then re-inserts slots for the 5 systems
-- so re-running converges on the same final state). Updates use guarded WHERE
-- clauses so re-runs do not flap values Dylan has tweaked.
--
-- Open items / assumptions (flagged in product notes too):
--   - Torginol Q-Color #40 box weight defaulted to 50 lb at 1 lb/sqft total
--     coverage = 50 sqft per box. Confirm against an actual invoice and update
--     spread_rate via the Material Catalog UI if wrong.
--   - Simiron MVB kit_size defaulted to 3 gal. Update if wrong.
--   - Simiron High Wear Urethane kit_size defaulted to 1 gal. Update if wrong.
--   - Simiron Metallic Epoxy kit_size defaulted to 3 gal (so 1 metallic pigment =
--     2 kits = 6 gal coverage = 240 sqft).
--   - Cohills Water-Based Sealer is a 2-coat system: spread_rate is set to 100
--     (effective per-coverage-foot) so qty math comes out right with one slot.
--
-- Seeded by Cowork on 2026-05-01 against decisions Dylan made in chat.

-- ============================================================================
-- 0) Ensure pec_prod_products.name is uniquely indexed so the ON CONFLICT (name)
--    clauses below can match. The original migration didn't add this; safe to
--    add here because the only existing rows are the 3 starter products from
--    seed_pm_ordering.sql, which have distinct names.
-- ============================================================================
create unique index if not exists pec_prod_products_name_uq
  on public.pec_prod_products(name);

-- ============================================================================
-- 1) Update existing Domino flake spread_rate from 350 to 325 (per Dylan).
-- ============================================================================
update public.pec_prod_products
   set spread_rate = 325,
       notes = '1/4" chip blend. Coverage 325 sqft per box per Dylan.'
 where name = 'Decorative Simiron Flake - Domino'
   and spread_rate = 350;

-- ============================================================================
-- 2) Deactivate the original "Standard Flake" system so the dropdown only
--    shows the 5 systems Dylan defined. Recipe slots tied to it remain in the
--    DB so we don't lose seed data; just the picker hides the row.
-- ============================================================================
update public.pec_prod_system_types
   set active = false,
       notes = 'Superseded by "Flake" (2026-05-01). Recipe slots kept for reference.'
 where name = 'Standard Flake';

-- ============================================================================
-- 3) Flip Quartz + Metallic to require per-job color pick (the New Job form
--    uses this flag to surface the per-area flake_product_id picker, which the
--    calculator special-cases for the Flake-typed slot in those recipes).
-- ============================================================================
update public.pec_prod_system_types
   set requires_flake_color = true,
       notes = 'User picks Torginol Q-Color #40 blend per job. Broadcast slot uses Flake material_type so the picker fires.'
 where name = 'Quartz';

update public.pec_prod_system_types
   set requires_flake_color = true,
       notes = 'User picks Simiron metallic pigment color per job. Pigment slot uses Flake material_type so the picker fires.'
 where name = 'Metallic';

-- ============================================================================
-- 4) New non-color products.
-- ============================================================================
insert into public.pec_prod_products
  (name, material_type, supplier, color, spread_rate, kit_size, unit_cost, notes)
values
  ('Simiron 1100 SL - Clear',          'Extra',    'Simiron', 'Clear',           150, 3, null, 'Untinted 1100 SL clear epoxy. Used as the body coat between quartz broadcasts.'),
  ('Simiron 1100 SL - Thin Coat',      'Basecoat', 'Simiron', 'Tinted (varies)', 200, 3, null, 'Same 1100 SL chemistry, applied thinner over ground concrete for the urethane G&S system. Tint to job color.'),
  ('Simiron MVB',                      'Basecoat', 'Simiron', 'Clear',           150, 3, null, 'Moisture vapor barrier. Used as basecoat for the Metallic system. Kit size assumed 3 gal, confirm against invoice.'),
  ('Simiron Metallic Epoxy',           'Extra',    'Simiron', 'Clear',            40, 3, null, 'Pigmented body coat for the Metallic system. 1 Simiron metallic pigment tints 2 kits / 6 gal of metallic epoxy. Kit size assumed 3 gal.'),
  ('Simiron Metallic Pigment',         'Flake',    'Simiron', 'Per-job pick',    240, 1, null, 'Tinting pack for Simiron Metallic Epoxy. Modeled with material_type=Flake so the New Job form picker fires for color choice. 1 pack covers 240 sqft (= 2 metallic-epoxy kits at 40 sqft/gal x 6 gal). Add specific color SKUs as you stock them.'),
  ('Simiron High Wear Urethane',       'Topcoat',  'Simiron', 'Clear',           600, 1, null, 'Topcoat for Grind and Seal - Urethane and for Metallic. Kit size assumed 1 gal, confirm against invoice.'),
  ('Cohills Eco Water-Based Stain',    'Stain',    'Cohills', 'Per-job pick',    200, 1, null, 'Concrete stain. Optional first coat in Grind and Seal - Urethane; required in Grind Stain and Seal. User picks color per job.'),
  ('Cohills Water-Based Sealer',       'Sealer',   'Cohills', 'Clear',           100, 1, null, '2-coat system: each coat is 200 sqft/gal. spread_rate set to 100 so a one-slot recipe produces the right qty for both coats together.')
on conflict (name) do nothing;

-- ============================================================================
-- 5) Torginol Q-Color #40 quartz blends (41 SKUs, all 50 sqft per 50-lb box at
--    1 lb/sqft total double-broadcast coverage). Source:
--    https://torginol.com/quartz-collections (Signature, Warm, Cool collections).
-- ============================================================================
insert into public.pec_prod_products
  (name, material_type, supplier, color, spread_rate, kit_size, unit_cost, notes)
values
  ('Torginol Q-Color #40 - Crystal (QB-1001)',       'Flake', 'Torginol', 'Crystal',       50, 1, null, 'Cool collection. 50-lb box assumed; 1 lb/sqft total over double broadcast.'),
  ('Torginol Q-Color #40 - Tundra (QB-1002)',        'Flake', 'Torginol', 'Tundra',        50, 1, null, 'Cool collection.'),
  ('Torginol Q-Color #40 - Solstice (QB-1003)',      'Flake', 'Torginol', 'Solstice',      50, 1, null, 'Cool collection.'),
  ('Torginol Q-Color #40 - Oyster (QB-1004)',        'Flake', 'Torginol', 'Oyster',        50, 1, null, 'Warm collection.'),
  ('Torginol Q-Color #40 - Oxford (QB-1005)',        'Flake', 'Torginol', 'Oxford',        50, 1, null, 'Warm collection.'),
  ('Torginol Q-Color #40 - Quicksand (QB-1006)',     'Flake', 'Torginol', 'Quicksand',     50, 1, null, 'Signature + Warm collection.'),
  ('Torginol Q-Color #40 - Dalmatian (QB-1007)',     'Flake', 'Torginol', 'Dalmatian',     50, 1, null, 'Cool collection.'),
  ('Torginol Q-Color #40 - Eclipse (QB-1008)',       'Flake', 'Torginol', 'Eclipse',       50, 1, null, 'Signature + Cool collection.'),
  ('Torginol Q-Color #40 - Matrix (QB-1009)',        'Flake', 'Torginol', 'Matrix',        50, 1, null, 'Cool collection.'),
  ('Torginol Q-Color #40 - Twilight (QB-1010)',      'Flake', 'Torginol', 'Twilight',      50, 1, null, 'Signature + Cool collection.'),
  ('Torginol Q-Color #40 - Breaking Dawn (QB-1011)', 'Flake', 'Torginol', 'Breaking Dawn', 50, 1, null, 'Warm collection.'),
  ('Torginol Q-Color #40 - Coconut (QB-1012)',       'Flake', 'Torginol', 'Coconut',       50, 1, null, 'Warm collection.'),
  ('Torginol Q-Color #40 - Biscuit (QB-1013)',       'Flake', 'Torginol', 'Biscuit',       50, 1, null, 'Warm collection.'),
  ('Torginol Q-Color #40 - Davenport (QB-1014)',     'Flake', 'Torginol', 'Davenport',     50, 1, null, 'Warm collection.'),
  ('Torginol Q-Color #40 - Driftwood (QB-1015)',     'Flake', 'Torginol', 'Driftwood',     50, 1, null, 'Warm collection.'),
  ('Torginol Q-Color #40 - Tradewinds (QB-1016)',    'Flake', 'Torginol', 'Tradewinds',    50, 1, null, 'Warm collection.'),
  ('Torginol Q-Color #40 - Aquarium (QB-1017)',      'Flake', 'Torginol', 'Aquarium',      50, 1, null, 'Cool collection.'),
  ('Torginol Q-Color #40 - New Moon (QB-1018)',      'Flake', 'Torginol', 'New Moon',      50, 1, null, 'Cool collection.'),
  ('Torginol Q-Color #40 - Marina (QB-1019)',        'Flake', 'Torginol', 'Marina',        50, 1, null, 'Cool collection.'),
  ('Torginol Q-Color #40 - Clearwater (QB-1020)',    'Flake', 'Torginol', 'Clearwater',    50, 1, null, 'Signature + Cool collection.'),
  ('Torginol Q-Color #40 - Avocado (QB-1022)',       'Flake', 'Torginol', 'Avocado',       50, 1, null, 'Cool collection.'),
  ('Torginol Q-Color #40 - Cinnamon (QB-1023)',      'Flake', 'Torginol', 'Cinnamon',      50, 1, null, 'Warm collection.'),
  ('Torginol Q-Color #40 - Firehouse (QB-1024)',     'Flake', 'Torginol', 'Firehouse',     50, 1, null, 'Warm collection.'),
  ('Torginol Q-Color #40 - Ruby (QB-1025)',          'Flake', 'Torginol', 'Ruby',          50, 1, null, 'Warm collection.'),
  ('Torginol Q-Color #40 - Lilac (QB-1026)',         'Flake', 'Torginol', 'Lilac',         50, 1, null, 'Cool collection.'),
  ('Torginol Q-Color #40 - Equinox (QB-2005)',       'Flake', 'Torginol', 'Equinox',       50, 1, null, 'Cool collection.'),
  ('Torginol Q-Color #40 - Icicle (QB-2006)',        'Flake', 'Torginol', 'Icicle',        50, 1, null, 'Signature + Cool collection.'),
  ('Torginol Q-Color #40 - Riverbank (QB-2007)',     'Flake', 'Torginol', 'Riverbank',     50, 1, null, 'Signature + Cool collection.'),
  ('Torginol Q-Color #40 - Ivy (QB-2008)',           'Flake', 'Torginol', 'Ivy',           50, 1, null, 'Cool collection.'),
  ('Torginol Q-Color #40 - Seaside (QB-2009)',       'Flake', 'Torginol', 'Seaside',       50, 1, null, 'Cool collection.'),
  ('Torginol Q-Color #40 - Sidewinder (QB-2010)',    'Flake', 'Torginol', 'Sidewinder',    50, 1, null, 'Warm collection.'),
  ('Torginol Q-Color #40 - Lighthouse (QB-2011)',    'Flake', 'Torginol', 'Lighthouse',    50, 1, null, 'Signature + Cool collection.'),
  ('Torginol Q-Color #40 - Cardinal (QB-2012)',      'Flake', 'Torginol', 'Cardinal',      50, 1, null, 'Signature + Warm collection.'),
  ('Torginol Q-Color #40 - Nebula (QB-2013)',        'Flake', 'Torginol', 'Nebula',        50, 1, null, 'Cool collection.'),
  ('Torginol Q-Color #40 - Sandhill (QB-2014)',      'Flake', 'Torginol', 'Sandhill',      50, 1, null, 'Signature + Warm collection.'),
  ('Torginol Q-Color #40 - Badlands (QB-2015)',      'Flake', 'Torginol', 'Badlands',      50, 1, null, 'Warm collection.'),
  ('Torginol Q-Color #40 - Canyon (QB-2016)',        'Flake', 'Torginol', 'Canyon',        50, 1, null, 'Warm collection.'),
  ('Torginol Q-Color #40 - Steelhead (QB-2017)',     'Flake', 'Torginol', 'Steelhead',     50, 1, null, 'Warm collection.'),
  ('Torginol Q-Color #40 - Harbor (QB-2018)',        'Flake', 'Torginol', 'Harbor',        50, 1, null, 'Cool collection.'),
  ('Torginol Q-Color #40 - Fjord (QB-2019)',         'Flake', 'Torginol', 'Fjord',         50, 1, null, 'Cool collection.'),
  ('Torginol Q-Color #40 - Sandpiper (QB-2020)',     'Flake', 'Torginol', 'Sandpiper',     50, 1, null, 'Warm collection.')
on conflict (name) do nothing;

-- ============================================================================
-- 6) Recipe slots for the 5 active systems.
--    Strategy: delete any existing slots for these 5 system rows first, then
--    insert fresh. This keeps re-runs of this file convergent. Standard Flake
--    is left alone (not in this list) so its original slots survive.
-- ============================================================================
delete from public.pec_prod_recipe_slots
 where system_type_id in (
   select id from public.pec_prod_system_types
    where name in ('Flake','Quartz','Metallic','Grind and Seal - Cohills','Grind and Seal - Urethane','Grind Stain and Seal','Grind and Seal')
 );

-- We split the seeded "Grind and Seal" row into two by renaming it to the
-- Cohills variant (the simpler 2-coat sealer) and inserting a new Urethane row.
update public.pec_prod_system_types
   set name = 'Grind and Seal - Cohills',
       description = 'Mechanical grind followed by 2 coats of Cohills water-based sealer.',
       requires_flake_color = false,
       requires_basecoat_color = false,
       active = true,
       notes = 'Renamed from "Grind and Seal" on 2026-05-01. The 2-coat Cohills variant.'
 where name = 'Grind and Seal';

insert into public.pec_prod_system_types
  (name, description, requires_flake_color, requires_basecoat_color, active, notes)
values
  ('Grind and Seal - Urethane',
   'Mechanical grind, optional Cohills stain, 1100 SL thin-coat basecoat, Simiron high wear urethane topcoat.',
   false, true, true,
   'Stain is applied first (over bare ground concrete) when used. Stain is optional; basecoat and urethane are required.')
on conflict (name) do nothing;

-- ----------------------------------------------------------------------------
-- Flake recipe (replaces Standard Flake going forward)
-- ----------------------------------------------------------------------------
with sys as (select id from public.pec_prod_system_types where name = 'Flake'),
     basecoat as (select id from public.pec_prod_products where name = 'Simiron 1100 SL - Tinted Gray'),
     topcoat as (select id from public.pec_prod_products where name = 'Polyaspartic Clear Gloss')
insert into public.pec_prod_recipe_slots
  (system_type_id, order_index, material_type, default_product_id, required, notes)
select sys.id, 1, 'Basecoat', basecoat.id, true,  'Override at job time if customer picks a non-default color.' from sys, basecoat
union all
select sys.id, 2, 'Flake',    null,         true, 'User picks flake color per job.' from sys
union all
select sys.id, 3, 'Topcoat',  topcoat.id,   true, 'Polyaspartic Clear Gloss.' from sys, topcoat;

-- ----------------------------------------------------------------------------
-- Quartz recipe: basecoat, body-coat clear, broadcast quartz (per-job pick),
-- polyaspartic topcoat.
-- ----------------------------------------------------------------------------
with sys as (select id from public.pec_prod_system_types where name = 'Quartz'),
     basecoat as (select id from public.pec_prod_products where name = 'Simiron 1100 SL - Tinted Gray'),
     bodycoat as (select id from public.pec_prod_products where name = 'Simiron 1100 SL - Clear'),
     topcoat  as (select id from public.pec_prod_products where name = 'Polyaspartic Clear Gloss')
insert into public.pec_prod_recipe_slots
  (system_type_id, order_index, material_type, default_product_id, required, notes)
select sys.id, 1, 'Basecoat', basecoat.id, true, 'Tinted basecoat. Override at job time if customer picks a non-default color.' from sys, basecoat
union all
select sys.id, 2, 'Extra',    bodycoat.id, true, 'Clear epoxy body coat between quartz broadcasts.' from sys, bodycoat
union all
select sys.id, 3, 'Flake',    null,        true, 'Quartz broadcast. User picks Torginol Q-Color #40 blend per job. Spread rate accounts for the full 1 lb/sqft total double broadcast.' from sys
union all
select sys.id, 4, 'Topcoat',  topcoat.id,  true, 'Polyaspartic Clear Gloss.' from sys, topcoat;

-- ----------------------------------------------------------------------------
-- Metallic recipe: MVB, metallic epoxy, metallic pigment (per-job pick),
-- urethane topcoat.
-- ----------------------------------------------------------------------------
with sys as (select id from public.pec_prod_system_types where name = 'Metallic'),
     mvb as (select id from public.pec_prod_products where name = 'Simiron MVB'),
     mep as (select id from public.pec_prod_products where name = 'Simiron Metallic Epoxy'),
     topcoat as (select id from public.pec_prod_products where name = 'Simiron High Wear Urethane')
insert into public.pec_prod_recipe_slots
  (system_type_id, order_index, material_type, default_product_id, required, notes)
select sys.id, 1, 'Basecoat', mvb.id,     true, 'Simiron MVB moisture vapor barrier basecoat.' from sys, mvb
union all
select sys.id, 2, 'Extra',    mep.id,     true, 'Simiron Metallic Epoxy body coat. Tinted with 1 metallic pigment per 2 kits.' from sys, mep
union all
select sys.id, 3, 'Flake',    null,       true, 'Simiron metallic pigment color. User picks per job. 1 pigment per 240 sqft.' from sys
union all
select sys.id, 4, 'Topcoat',  topcoat.id, true, 'Simiron High Wear Urethane.' from sys, topcoat;

-- ----------------------------------------------------------------------------
-- Grind and Seal - Cohills recipe: 2 coats Cohills water-based sealer.
-- ----------------------------------------------------------------------------
with sys as (select id from public.pec_prod_system_types where name = 'Grind and Seal - Cohills'),
     sealer as (select id from public.pec_prod_products where name = 'Cohills Water-Based Sealer')
insert into public.pec_prod_recipe_slots
  (system_type_id, order_index, material_type, default_product_id, required, notes)
select sys.id, 1, 'Sealer', sealer.id, true, '2 coats of Cohills water-based sealer. spread_rate baked in; one slot covers both coats.' from sys, sealer;

-- ----------------------------------------------------------------------------
-- Grind and Seal - Urethane recipe: optional stain, 1100 SL thin coat basecoat,
-- Simiron high wear urethane topcoat.
-- ----------------------------------------------------------------------------
with sys as (select id from public.pec_prod_system_types where name = 'Grind and Seal - Urethane'),
     stain as (select id from public.pec_prod_products where name = 'Cohills Eco Water-Based Stain'),
     basecoat as (select id from public.pec_prod_products where name = 'Simiron 1100 SL - Thin Coat'),
     topcoat as (select id from public.pec_prod_products where name = 'Simiron High Wear Urethane')
insert into public.pec_prod_recipe_slots
  (system_type_id, order_index, material_type, default_product_id, required, notes)
select sys.id, 1, 'Stain',    stain.id,    false, 'Optional Cohills stain. Applied first over bare ground concrete.' from sys, stain
union all
select sys.id, 2, 'Basecoat', basecoat.id, true,  'Simiron 1100 SL applied thin (200 sqft/gal) over the stain or bare concrete.' from sys, basecoat
union all
select sys.id, 3, 'Topcoat',  topcoat.id,  true,  'Simiron High Wear Urethane.' from sys, topcoat;

-- ----------------------------------------------------------------------------
-- Grind Stain and Seal recipe: stain, then 2-coat Cohills sealer.
-- ----------------------------------------------------------------------------
with sys as (select id from public.pec_prod_system_types where name = 'Grind Stain and Seal'),
     stain as (select id from public.pec_prod_products where name = 'Cohills Eco Water-Based Stain'),
     sealer as (select id from public.pec_prod_products where name = 'Cohills Water-Based Sealer')
insert into public.pec_prod_recipe_slots
  (system_type_id, order_index, material_type, default_product_id, required, notes)
select sys.id, 1, 'Stain',  stain.id,  true, 'Cohills water-based stain. User picks color per job.' from sys, stain
union all
select sys.id, 2, 'Sealer', sealer.id, true, '2 coats of Cohills water-based sealer over the stain.' from sys, sealer;
