-- @artifacts
--   none: data-only (deactivates 18 existing pec_prod_products rows, creates nothing)
-- @end
--
-- Prompt 57 Part G, step 8, SPLIT OUT OF 2026-07-29_flake_color_model.sql AND
-- NOT YET APPLIED (Cowork, 2026-07-29).
--
-- WHY IT IS HELD: both the customer portal color picker
-- (get_portal_job_catalog, which filters `and p.active`) and the CRM job-card
-- swatch grid list flake options straight from pec_prod_products. Deactivating
-- the 18 collapsed blends removes them from BOTH. Dylan cleared the customer
-- side (the portal is not in use yet), but the CRM job-card grid is the STAFF
-- surface where colors get picked on booked jobs, and with the portal unused
-- it is currently the ONLY such surface. Losing 18 of 21 options there is a
-- live internal regression.
--
-- APPLY THIS ONLY AFTER get_portal_job_catalog and the CRM job-card swatch
-- grid read public.colors (category = 'flake-blend', joined to
-- colors.product_id for pricing) instead of pec_prod_products. At that point
-- this file is safe and the Catalog Flake section drops from 25 active
-- products to 7.
--
-- Steps 1-7 of the parent migration ARE applied (2026-07-29). Nothing here is
-- required for them: the colors model, the pairings, and flake_color_id all
-- work with these 18 products still active.

-- 8. Deactivate the 18 collapsed products (explicit ids, never a name match).
--    DO NOT DELETE: historical areas FK to them and costing must keep
--    resolving their names and costs.
update public.pec_prod_products set active = false where id in (
  '7c608eff-9394-446f-b496-653615071ee8',  -- Cabin Fever Flake
  'd556afa1-583c-4fa6-a188-b5de4ac86af7',  -- Coyote Flake
  '83dca574-4e4e-472f-8f05-e9bc54a1c6b5',  -- Creekbed Flake
  '94f2da6b-b9b5-4923-96e1-2d3352d50de5',  -- Domino Flake
  '4a1b7552-9aca-40a5-bf70-aa42f9ebd12b',  -- Feather Gray Flake
  'd7e17787-78a5-4c99-a173-b856b94037b0',  -- Garnet Flake
  'b81ce7a2-12a9-4af1-9ad6-89d5f18271ae',  -- Glacier Flake
  'ea3d1f53-9603-4a2c-a95c-10dede24fbf0',  -- Gravel Flake
  'bcc436dd-f378-4a89-9117-0dda0a9d483d',  -- Nightfall Flake
  '3b202382-f96b-4ac1-84da-f2aeee899472',  -- Orbit Flake
  '901d0b46-0971-462c-a92c-ff58695dd170',  -- Outback Flake
  '82661eab-f823-42eb-9cbb-0a452350edfb',  -- Pumice Flake
  '20d9d38a-dab6-4a3d-913e-ffe2be364824',  -- Safari Flake
  '79b57923-96f0-4ece-ab4a-965fa720d6b5',  -- Schist Flake
  'e05512ff-63e4-49d2-8ef1-ee067b16a163',  -- Shoreline Flake
  'a75e6258-cca0-4669-940c-9ca22d989e83',  -- Stargazer Flake
  'b2be6b28-7352-43a1-83c9-7e004f85de09',  -- Tidal Wave Flake
  'af13a551-1dae-419a-8540-e1ac8a592c0f'   -- Wombat Flake
);

-- Verify:
--   select count(*) from pec_prod_products where material_type = 'Flake' and active;  -- 7
