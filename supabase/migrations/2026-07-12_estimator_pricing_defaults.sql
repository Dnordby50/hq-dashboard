-- @artifacts
--   none: data-only catalog/pricing updates
-- @end
-- Estimator pricing fixes (Dylan, 2026-07-12): price on system alone, count
-- flake cost when no color is picked, and target 52% GP on Standard Flake.
--
-- WHY, in one paragraph: the pricing engine only hard-blocks when a REQUIRED
-- non-swatch recipe slot has neither a pick nor a default_product_id, and
-- three live systems had exactly that hole (Standard Flake basecoat, Grind and
-- Seal basecoat + topcoat, Metallic's visible basecoat color), which is what
-- made basecoat feel "mandatory". Separately, an unpicked flake priced as $0
-- (swatch placeholder), so a 1000 sqft flake garage quoted ~$3,770 against the
-- $5,000-5,500 price sheet. With costs counted, the sheet works out to ~52%
-- GP by the engine's own definition, (price - materials - labor - commission)
-- / price, which Dylan confirmed; 60% (his first ask) would have priced 1000
-- sqft at ~$7,590 and was explicitly not chosen. Reference check after this
-- migration: 1000 sqft Standard Flake, zero picks = $1,442.57 materials
-- (3 basecoat kits x 144.27 + 4 flake boxes x 87.44 + 5 topcoat kits x 132),
-- price = 1442.57 / (1 - .15 labor - .06 commission - .52 gp) = ~$5,345.
--
-- All data, no schema. Ids resolved by name so this replays anywhere. Every
-- UPDATE touches only rows whose default is still NULL, so a value Dylan has
-- since set by hand in the Catalog is never clobbered on a re-run.

-- 1. A visibly-placeholder flake product that carries the STANDARD flake cost.
--    The engine prices an unpicked swatch slot from the slot's default product
--    (pick || default_product_id), so this makes "color TBD" cost $87.44/box
--    instead of $0. The name makes it impossible to mistake for a color choice
--    on a materials list.
insert into pec_prod_products (name, material_type, supplier, color, spread_rate, kit_size, unit_cost, active, notes)
select 'Standard Flake (color TBD)', 'Flake', 'Simiron', 'TBD', 325, 1, 87.44,
       true, 'Pricing placeholder: standard 1/4in flake cost for estimates where the customer has not picked a color yet. Swap for the real color when it is chosen.'
where not exists (select 1 from pec_prod_products where name = 'Standard Flake (color TBD)');

-- 2. Slot defaults (only where still NULL).
-- Standard Flake / Basecoat -> Simiron 1100 SL - Light Gray (Quartz's default)
update pec_prod_recipe_slots rs
set default_product_id = (select id from pec_prod_products where name = 'Simiron 1100 SL - Light Gray' limit 1)
where rs.system_type_id = (select id from pec_prod_system_types where name = 'Standard Flake' limit 1)
  and rs.material_type = 'Basecoat'
  and rs.default_product_id is null;

-- Standard Flake / Flake -> the new TBD placeholder
update pec_prod_recipe_slots rs
set default_product_id = (select id from pec_prod_products where name = 'Standard Flake (color TBD)' limit 1)
where rs.system_type_id = (select id from pec_prod_system_types where name = 'Standard Flake' limit 1)
  and rs.material_type = 'Flake'
  and rs.default_product_id is null;

-- Grind and Seal / Basecoat -> 1100 SL Clear, / Topcoat -> Polyaspartic 2gal
update pec_prod_recipe_slots rs
set default_product_id = (select id from pec_prod_products where name = 'Simiron 1100 SL - Clear' limit 1)
where rs.system_type_id = (select id from pec_prod_system_types where name = 'Grind and Seal' limit 1)
  and rs.material_type = 'Basecoat'
  and rs.default_product_id is null;

update pec_prod_recipe_slots rs
set default_product_id = (select id from pec_prod_products where name = 'Simiron Polyaspartic 2gal Kit' limit 1)
where rs.system_type_id = (select id from pec_prod_system_types where name = 'Grind and Seal' limit 1)
  and rs.material_type = 'Topcoat'
  and rs.default_product_id is null;

-- Metallic / visible "Basecoat color" (the hidden body-coat slot already has
-- its default; match on the label to leave it alone)
update pec_prod_recipe_slots rs
set default_product_id = (select id from pec_prod_products where name = 'Simiron 1100 SL - Light Gray' limit 1)
where rs.system_type_id = (select id from pec_prod_system_types where name = 'Metallic' limit 1)
  and rs.material_type = 'Basecoat'
  and rs.label = 'Basecoat color'
  and rs.default_product_id is null;

-- 3. Target GP 52 on Standard Flake ONLY (whole-number percent; the engine
--    divides by 100). Other systems stay NULL and keep the global 50 default
--    (settings estimator_target_gp_pct). Editable per system in the Catalog's
--    System Type modal as of this build.
update pec_prod_system_types
set target_gp_pct = 52
where name = 'Standard Flake'
  and target_gp_pct is null;

-- Footer checks (run after applying):
--   select name, target_gp_pct from pec_prod_system_types where name='Standard Flake';  -- 52
--   select st.name, rs.material_type, rs.label, p.name as default_product
--     from pec_prod_recipe_slots rs
--     join pec_prod_system_types st on st.id = rs.system_type_id
--     left join pec_prod_products p on p.id = rs.default_product_id
--     where rs.required and rs.slot_kind = 'product' and rs.default_product_id is null;
--   -- expect ZERO rows for non-swatch material types
