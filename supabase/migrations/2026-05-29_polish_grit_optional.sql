-- ============================================================================
-- 2026-05-29: make Concrete Polishing's "Polish grit" slot optional
-- ============================================================================
-- Concrete Polishing jobs could not be saved from the Job list: its recipe has
-- a required "Polish grit" choice slot (seed_recipe_formulas.sql step 5,
-- required=true, min_select=1), and the Job-list editor blocks save until every
-- required slot is filled. The Job Schedule skips that validation, which is why
-- the same job saved from the schedule but not the Job list.
--
-- Densifier and Guard on this same system were deliberately shipped NOT required
-- "so CRM jobs save before SKUs are stocked." Bring Polish grit in line: make it
-- optional so the job saves, and the grit can still be picked later.
--
-- The Job-list validation keys off min_select > 0 (index.html ~7988), so
-- min_select = 0 is what actually unblocks save; required = false keeps the slot
-- consistent with Densifier/Guard.
--
-- The seed labels the slot "Polish grit"; the live row may read "Finish grit"
-- (the wording in the reported error), so match both.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

begin;

update public.pec_prod_recipe_slots rs
   set required = false, min_select = 0
  from public.pec_prod_system_types st
 where rs.system_type_id = st.id
   and st.name = 'Concrete Polishing'
   and rs.slot_kind = 'choice'
   and rs.label in ('Polish grit', 'Finish grit');

commit;

-- Verify after running:
--   select st.name, rs.label, rs.slot_kind, rs.required, rs.min_select
--     from public.pec_prod_recipe_slots rs
--     join public.pec_prod_system_types st on st.id = rs.system_type_id
--    where st.name = 'Concrete Polishing'
--    order by rs.order_index;
--   -- expect the grit choice row to show required=false, min_select=0.
