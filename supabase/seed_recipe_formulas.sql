-- 2026-05-20: recipe formulas for the recipe-driven job-area editor.
--
-- Run AFTER migration 2026-05-20_recipe_formula.sql. Idempotent: system types
-- use on-conflict-do-nothing, slot UPDATEs are naturally idempotent, and new
-- slot INSERTs are guarded with NOT EXISTS.
--
-- This seed labels each system's recipe slots and sets each slot's input kind
-- so the CRM job-area editor renders the right control:
--   Metallic = basecoat color + up to 3 metallic colors + topcoat
--   Quartz   = basecoat color + quartz color + Single/Double broadcast + topcoat
--   Concrete Polishing (new) = densifier + optional dye/stain + grit + guard
--   Custom System (new)      = free-text build notes; everything else added
--                              per-area via the editor's Custom options button
-- Body-coat slots the material calculator needs but the CRM editor should not
-- surface are flagged editor_hidden = true.

begin;

-- ============================================================================
-- 1) New system types
-- ============================================================================
insert into public.pec_prod_system_types
  (name, description, requires_flake_color, requires_basecoat_color, active, color, notes)
values
  ('Concrete Polishing', 'Mechanically polished concrete: densify, optional dye/stain, polish to a grit, guard.', false, false, true, '#64748b',
   'Formula seeded 2026-05-20. Densifier / Guard product slots ship NOT required so CRM jobs can be saved before those SKUs are stocked — flip them to Required in Material Catalog once products exist.'),
  ('Custom System', 'Fully bespoke build. Add every material per job via the area editor''s Custom options.', false, false, true, '#a855f7',
   'Catch-all for one-off systems that do not fit a standard formula.')
on conflict (name) do nothing;

-- ============================================================================
-- 2) Metallic — basecoat color + up to 3 metallic colors + topcoat
--    (existing slots: Basecoat, Extra body coat, Metallic Pigment, Topcoat)
-- ============================================================================
update public.pec_prod_recipe_slots rs
   set label = 'Basecoat color', slot_kind = 'product'
  from public.pec_prod_system_types st
 where rs.system_type_id = st.id and st.name = 'Metallic' and rs.material_type = 'Basecoat';

update public.pec_prod_recipe_slots rs
   set label = 'Metallic epoxy body coat', slot_kind = 'product', editor_hidden = true
  from public.pec_prod_system_types st
 where rs.system_type_id = st.id and st.name = 'Metallic' and rs.material_type = 'Extra';

update public.pec_prod_recipe_slots rs
   set label = 'Metallic colors', slot_kind = 'multi_product', min_select = 1, max_select = 3
  from public.pec_prod_system_types st
 where rs.system_type_id = st.id and st.name = 'Metallic' and rs.material_type = 'Metallic Pigment';

update public.pec_prod_recipe_slots rs
   set label = 'Topcoat', slot_kind = 'product'
  from public.pec_prod_system_types st
 where rs.system_type_id = st.id and st.name = 'Metallic' and rs.material_type = 'Topcoat';

-- ============================================================================
-- 3) Quartz — basecoat + quartz color + Single/Double broadcast + topcoat
--    (existing slots: Basecoat, Extra body coat, Quartz, Topcoat). Renumber so
--    the new Broadcast choice slot sits between quartz color and topcoat.
-- ============================================================================
update public.pec_prod_recipe_slots rs
   set label = 'Basecoat color', slot_kind = 'product', order_index = 1
  from public.pec_prod_system_types st
 where rs.system_type_id = st.id and st.name = 'Quartz' and rs.material_type = 'Basecoat';

update public.pec_prod_recipe_slots rs
   set label = 'Quartz body coat', slot_kind = 'product', editor_hidden = true, order_index = 2
  from public.pec_prod_system_types st
 where rs.system_type_id = st.id and st.name = 'Quartz' and rs.material_type = 'Extra';

update public.pec_prod_recipe_slots rs
   set label = 'Quartz color', slot_kind = 'product', order_index = 3
  from public.pec_prod_system_types st
 where rs.system_type_id = st.id and st.name = 'Quartz' and rs.material_type = 'Quartz';

update public.pec_prod_recipe_slots rs
   set label = 'Topcoat', slot_kind = 'product', order_index = 5
  from public.pec_prod_system_types st
 where rs.system_type_id = st.id and st.name = 'Quartz' and rs.material_type = 'Topcoat';

-- New Quartz Broadcast choice slot (order 4). Carries no product.
insert into public.pec_prod_recipe_slots
  (system_type_id, order_index, material_type, slot_kind, label, required, min_select, max_select, options, editor_hidden, notes)
select st.id, 4, 'Extra', 'choice', 'Broadcast', true, 1, 1, '["Single","Double"]'::jsonb, false,
       'Single vs double quartz broadcast. Recorded for the work order; carries no material line.'
from public.pec_prod_system_types st
where st.name = 'Quartz'
  and not exists (
    select 1 from public.pec_prod_recipe_slots rs
    where rs.system_type_id = st.id and rs.slot_kind = 'choice' and rs.label = 'Broadcast'
  );

-- ============================================================================
-- 4) Grind and Seal — keep the existing material slots; add one free-text
--    scope slot so PMs can capture the job-to-job variability. Anything else
--    is added per-area via the editor's Custom options.
-- ============================================================================
insert into public.pec_prod_recipe_slots
  (system_type_id, order_index, material_type, slot_kind, label, required, min_select, max_select, editor_hidden, notes)
select st.id, 90, 'Extra', 'text', 'Job scope / notes', false, 0, 1, false,
       'Free-text scope for grind-and-seal jobs (grit sequence, repairs, joint fill, etc.).'
from public.pec_prod_system_types st
where st.name in ('Grind and Seal', 'Grind Stain and Seal')
  and not exists (
    select 1 from public.pec_prod_recipe_slots rs
    where rs.system_type_id = st.id and rs.slot_kind = 'text' and rs.label = 'Job scope / notes'
  );

-- ============================================================================
-- 5) Concrete Polishing recipe (new system). Densifier / Guard ship NOT
--    required (see system-type note) so CRM jobs save before SKUs are stocked.
-- ============================================================================
insert into public.pec_prod_recipe_slots
  (system_type_id, order_index, material_type, slot_kind, label, required, min_select, max_select, options, editor_hidden, notes)
select st.id, v.order_index, v.material_type, v.slot_kind, v.label, v.required, v.min_select, v.max_select, v.options, false, v.notes
from public.pec_prod_system_types st
cross join (values
  (1, 'Densifier', 'product', 'Densifier / hardener',   false, 0, 1, null::jsonb,                       'Lithium/silicate densifier. Set Required once a densifier SKU is in the catalog.'),
  (2, 'Stain',     'product', 'Dye / stain (optional)', false, 0, 1, null::jsonb,                       'Optional decorative dye or stain.'),
  (3, 'Extra',     'choice',  'Polish grit',            true,  1, 1, '["400","800","1500","3000"]'::jsonb, 'Final polish grit level.'),
  (4, 'Guard',     'product', 'Guard sealer',           false, 0, 1, null::jsonb,                       'Stain-guard / sealer. Set Required once a guard SKU is in the catalog.')
) as v(order_index, material_type, slot_kind, label, required, min_select, max_select, options, notes)
where st.name = 'Concrete Polishing'
  and not exists (
    select 1 from public.pec_prod_recipe_slots rs
    where rs.system_type_id = st.id and rs.order_index = v.order_index
  );

-- ============================================================================
-- 6) Custom System recipe (new system) — a single free-text slot.
-- ============================================================================
insert into public.pec_prod_recipe_slots
  (system_type_id, order_index, material_type, slot_kind, label, required, min_select, max_select, editor_hidden, notes)
select st.id, 1, 'Extra', 'text', 'Custom build notes', false, 0, 1, false,
       'Describe the bespoke build. Add each material per area via the editor''s Custom options.'
from public.pec_prod_system_types st
where st.name = 'Custom System'
  and not exists (
    select 1 from public.pec_prod_recipe_slots rs
    where rs.system_type_id = st.id and rs.order_index = 1
  );

commit;

-- Verify after running:
--   select st.name, rs.order_index, rs.label, rs.slot_kind, rs.editor_hidden
--     from public.pec_prod_recipe_slots rs
--     join public.pec_prod_system_types st on st.id = rs.system_type_id
--    where st.name in ('Metallic','Quartz','Concrete Polishing','Custom System')
--    order by st.name, rs.order_index;
--   -- expect: Metallic has a multi_product 'Metallic colors' slot; Quartz has a
--   --         choice 'Broadcast' slot; Concrete Polishing + Custom System exist.
