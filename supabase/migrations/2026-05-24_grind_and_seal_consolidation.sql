-- ============================================================================
-- 2026-05-24: consolidate three Grind variants into one "Grind and Seal" system
-- ============================================================================
-- Dylan: "Set the systems to be just one system for grind and seal. It will be
-- a custom one every time. For all grind and seals let's have one Basecoat
-- option a stain option, and then a topcoat option pulling from the materials
-- catalog."
--
-- Today the catalog has three Grind variants (seeded by 2026-05-01_pec_systems
-- _recipes.sql lines 219-245 and Cowork's 2026-05-24 system_budgets seed):
--   * "Grind and Seal - Cohills"   (1 slot:  Sealer)
--   * "Grind and Seal - Urethane"  (3 slots: Stain optional, Basecoat, Topcoat)
--   * "Grind Stain and Seal"       (2 slots: Stain required, Sealer)
--
-- Target end state: ONE active row named "Grind and Seal" with a clean 3-slot
-- recipe of Basecoat (required), Stain (optional), Topcoat (required), each a
-- plain `product` slot kind sourced from the Material Catalog at job time (no
-- default_product_id, no swatch picker since Stain is not in SWATCH_TYPES).
--
-- Approach: rename "Grind and Seal - Cohills" in place so its existing FKs
-- (CRM job_areas + production pec_prod_areas) stay valid. Deactivate the other
-- two variants instead of deleting; pec_prod_areas.system_type_id is
-- `on delete restrict` (2026-04-28_pm_ordering.sql) so deletion would fail if
-- any historical prod jobs reference them. The editor's dropdown filters
-- `s.active !== false || s.id === sel` (index.html ~6304), so deactivated rows
-- disappear from new-job pickers while historical jobs still display them.
--
-- Idempotent. Safe to re-run; conflict-on-name handled by upserts and guarded
-- inserts.
-- ============================================================================

begin;

-- 1) Rename the canonical row in place
update public.pec_prod_system_types
   set name = 'Grind and Seal'
 where name = 'Grind and Seal - Cohills';

-- 2) Deactivate the other two variants. They keep their FK identity so
--    historical jobs still resolve their old system label.
update public.pec_prod_system_types
   set active = false
 where name in ('Grind and Seal - Urethane', 'Grind Stain and Seal');

-- 3) Clean out the consolidated row's old slot(s) so the rewrite below is the
--    sole source of truth for its recipe.
delete from public.pec_prod_recipe_slots
 where system_type_id = (select id from public.pec_prod_system_types where name = 'Grind and Seal');

-- 4) Drop slots attached to the deactivated variants. They are invisible to
--    the editor anyway but the Material Catalog's per-system slot view will
--    show them otherwise.
delete from public.pec_prod_recipe_slots
 where system_type_id in (
   select id from public.pec_prod_system_types
    where name in ('Grind and Seal - Urethane', 'Grind Stain and Seal')
 );

-- 5) Rewrite "Grind and Seal" recipe with the three target slots. No
--    default_product_id and no min/max constraints on Stain so the operator
--    can leave it blank when the job is a plain grind-and-topcoat.
insert into public.pec_prod_recipe_slots
  (system_type_id, order_index, material_type, slot_kind, label, required, min_select, max_select, default_product_id, editor_hidden, notes)
select st.id, v.order_index, v.material_type, 'product', v.label, v.required, v.min_select, v.max_select, null, false, v.notes
  from public.pec_prod_system_types st
  cross join (values
    (1, 'Basecoat', 'Basecoat', true,  1, 1, 'PM picks the basecoat per job from the Material Catalog.'),
    (2, 'Stain',    'Stain',    false, 0, 1, 'Optional decorative stain. Leave blank for plain grind-and-seal.'),
    (3, 'Topcoat',  'Topcoat',  true,  1, 1, 'PM picks the topcoat per job from the Material Catalog.')
  ) as v(order_index, material_type, label, required, min_select, max_select, notes)
 where st.name = 'Grind and Seal';

commit;

-- Verify after running:
--   select name, active from public.pec_prod_system_types
--     where name ilike '%grind%' order by name;
--   -- expect:
--   --   Grind and Seal              | t
--   --   Grind and Seal - Urethane   | f
--   --   Grind Stain and Seal        | f
--
--   select rs.order_index, rs.material_type, rs.label, rs.required, rs.min_select, rs.max_select
--     from public.pec_prod_recipe_slots rs
--     join public.pec_prod_system_types st on st.id = rs.system_type_id
--    where st.name = 'Grind and Seal'
--    order by rs.order_index;
--   -- expect 3 rows: Basecoat (req), Stain (opt), Topcoat (req).
--
--   select count(*) from public.pec_prod_recipe_slots rs
--     join public.pec_prod_system_types st on st.id = rs.system_type_id
--    where st.name in ('Grind and Seal - Urethane', 'Grind Stain and Seal');
--   -- expect 0.
