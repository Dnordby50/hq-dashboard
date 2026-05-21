-- 2026-05-20: recipe-driven system formulas.
--
-- Today a CRM job area (public.job_areas) can only express a flake color + a
-- coordinating basecoat. Real PEC systems each have their own "formula":
-- metallic = basecoat + up to 3 metallic pigments + topcoat; quartz = basecoat
-- + quartz color + single/double broadcast + topcoat; grind-and-seal varies;
-- concrete polishing is new. This migration makes formulas data-driven:
--
-- 1) pec_prod_recipe_slots gains columns describing each slot's INPUT kind
--    (single product / up-to-N products / enumerated choice / free text),
--    a human label, select bounds, and choice options. Existing rows default
--    to slot_kind='product' so current behavior is unchanged.
--
-- 2) material_type CHECK on the three tables that pin it gains 'Densifier' and
--    'Guard' for concrete-polishing products. (If PEC does not stock distinct
--    densifier / guard SKUs yet, section 2 can be commented out and those
--    recipe slots seeded as 'Extra'/text instead — it is self-contained.)
--
-- 3) New table public.job_area_materials: one row per material pick on an
--    area, so an area can hold any number of picks across any slots, plus
--    PM-added custom rows. The legacy job_areas.flake_product_id /
--    basecoat_product_id columns are kept (not dropped) for back-compat and
--    backfilled into the new table.
--
-- 4) public.jobs gains companycam_project_id (text) for the CompanyCam photo
--    integration shipping in a later phase of the same plan.
--
-- RLS note: job_areas and the pec_prod_* tables do not have RLS enabled (see
-- supabase/policies.sql — they are not in the enable list). job_area_materials
-- intentionally matches that open posture; no policy is added.
--
-- Idempotent. Safe to re-run.

begin;

-- ============================================================================
-- 1) pec_prod_recipe_slots: describe each slot's input kind
-- ============================================================================
alter table public.pec_prod_recipe_slots
  add column if not exists label text,
  add column if not exists slot_kind text not null default 'product',
  add column if not exists min_select int not null default 0,
  add column if not exists max_select int not null default 1,
  add column if not exists options jsonb,
  add column if not exists product_filter jsonb,
  -- editor_hidden: calculator-only internal slots (e.g. a fixed body coat) that
  -- the material calculator still needs but the CRM job-area editor must not
  -- surface as a pick. The calculator ignores this flag; the editor honors it.
  add column if not exists editor_hidden boolean not null default false;

alter table public.pec_prod_recipe_slots
  drop constraint if exists pec_prod_recipe_slots_slot_kind_check;
alter table public.pec_prod_recipe_slots
  add constraint pec_prod_recipe_slots_slot_kind_check
  check (slot_kind in ('product','multi_product','choice','text'));

-- A required product slot must collect at least one pick.
update public.pec_prod_recipe_slots
   set min_select = 1
 where required = true and slot_kind in ('product','multi_product') and min_select = 0;

-- ============================================================================
-- 2) material_type CHECK: allow 'Densifier' and 'Guard' (concrete polishing)
-- ============================================================================
alter table public.pec_prod_products
  drop constraint if exists pec_prod_products_material_type_check;
alter table public.pec_prod_products
  add constraint pec_prod_products_material_type_check
  check (material_type in ('Basecoat','Flake','Quartz','Metallic Pigment','Topcoat','Stain','Sealer','Tint Pack','Densifier','Guard','Extra'));

alter table public.pec_prod_recipe_slots
  drop constraint if exists pec_prod_recipe_slots_material_type_check;
alter table public.pec_prod_recipe_slots
  add constraint pec_prod_recipe_slots_material_type_check
  check (material_type in ('Basecoat','Flake','Quartz','Metallic Pigment','Topcoat','Stain','Sealer','Tint Pack','Densifier','Guard','Extra'));

alter table public.pec_prod_material_lines
  drop constraint if exists pec_prod_material_lines_material_type_check;
alter table public.pec_prod_material_lines
  add constraint pec_prod_material_lines_material_type_check
  check (material_type in ('Basecoat','Flake','Quartz','Metallic Pigment','Topcoat','Stain','Sealer','Tint Pack','Densifier','Guard','Extra'));

-- ============================================================================
-- 3) job_area_materials: flexible per-slot picks for a CRM job area
-- ============================================================================
-- One row per pick. A multi_product slot with 2 metallics = 2 rows (pick_index
-- 0 and 1). recipe_slot_id is ON DELETE SET NULL so editing a system's recipe
-- never destroys saved job history; the slot_* snapshot columns preserve
-- meaning. is_custom rows are PM ad-hoc additions (recipe_slot_id null).
create table if not exists public.job_area_materials (
  id uuid primary key default gen_random_uuid(),
  job_area_id uuid not null references public.job_areas(id) on delete cascade,
  recipe_slot_id uuid references public.pec_prod_recipe_slots(id) on delete set null,
  slot_label text,
  slot_kind text,
  material_type text,
  order_index int not null default 0,
  pick_index int not null default 0,
  product_id uuid references public.pec_prod_products(id) on delete set null,
  choice_value text,
  text_value text,
  is_custom boolean not null default false,
  created_at timestamptz default now()
);

create index if not exists idx_job_area_materials_area
  on public.job_area_materials(job_area_id, order_index, pick_index);

-- ============================================================================
-- 4) Backfill existing job_areas into job_area_materials
-- ============================================================================
-- Match each area's legacy basecoat / flake product against its system's
-- recipe slots. Guarded by NOT EXISTS so re-running the migration is a no-op.
insert into public.job_area_materials
  (job_area_id, recipe_slot_id, slot_label, slot_kind, material_type, order_index, pick_index, product_id)
select ja.id, rs.id, coalesce(rs.label, rs.material_type), 'product', rs.material_type, rs.order_index, 0, ja.basecoat_product_id
from public.job_areas ja
cross join lateral (
  select id, label, material_type, order_index
  from public.pec_prod_recipe_slots
  where system_type_id = ja.system_type_id and material_type = 'Basecoat'
  order by order_index
  limit 1
) rs
where ja.basecoat_product_id is not null
  and not exists (
    select 1 from public.job_area_materials m
    where m.job_area_id = ja.id and m.recipe_slot_id = rs.id
  );

insert into public.job_area_materials
  (job_area_id, recipe_slot_id, slot_label, slot_kind, material_type, order_index, pick_index, product_id)
select ja.id, rs.id, coalesce(rs.label, rs.material_type), 'product', rs.material_type, rs.order_index, 0, ja.flake_product_id
from public.job_areas ja
cross join lateral (
  select id, label, material_type, order_index
  from public.pec_prod_recipe_slots
  where system_type_id = ja.system_type_id
    and material_type in ('Flake','Quartz','Metallic Pigment')
  order by order_index
  limit 1
) rs
where ja.flake_product_id is not null
  and not exists (
    select 1 from public.job_area_materials m
    where m.job_area_id = ja.id and m.recipe_slot_id = rs.id
  );

-- ============================================================================
-- 5) jobs.companycam_project_id (CompanyCam photo integration, later phase)
-- ============================================================================
alter table public.jobs add column if not exists companycam_project_id text;

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='pec_prod_recipe_slots'
--       and column_name in ('label','slot_kind','min_select','max_select','options','product_filter','editor_hidden');
--   -- expect: 7 rows.
--   select to_regclass('public.job_area_materials');  -- expect: non-null.
--   select count(*) from public.job_area_materials;
--   -- expect: >= count of job_areas rows with a non-null flake/basecoat product.
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='jobs' and column_name='companycam_project_id';
--   -- expect: 1 row.
