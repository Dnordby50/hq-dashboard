-- ============================================================================
-- 2026-07-15 (build 17): estimate controls.
-- Author: Claude Code. Idempotent. Applied to prod from the build session.
--
-- Four schema needs behind build 17:
--  1. MVB moves from the estimate to the AREA (estimate_areas.mvb, mirrored to
--     pec_prod_areas so an accepted job carries the flag). estimates.mvb is
--     RETIRED (kept for history, no longer read), the way estimates.line_items
--     jsonb was frozen in 15b. There are ZERO non-'none' estimates in prod, so
--     the backfill is a no-op today, but it is written correctly for the future.
--  2. An "MVB Only" system type: the representation for an MVB-only job (no
--     coating). Its recipe is just the standalone MVB product, so an MVB-only
--     estimate is a normal single-system estimate priced by the same weighted
--     cost-plus solve, with no special-casing left in the engine. Numbers are
--     seeded and Dylan-tunable in the catalog (flagged in the log).
--  3. Sundries + floor-GP pricing config (settings), read by the estimator.
--  4. Manual price override provenance on the estimate (calc_price keeps the
--     engine number; price stays the number that actually sells).
-- ============================================================================

begin;

-- 1. Per-area MVB -----------------------------------------------------------
alter table public.estimate_areas add column if not exists mvb boolean not null default false;
alter table public.pec_prod_areas  add column if not exists mvb boolean not null default false;

-- Backfill: every area of an estimate that had estimate-level MVB (addon or
-- standalone) turns the area flag on. (No such rows in prod today.)
update public.estimate_areas ea
   set mvb = true
  from public.estimates e
 where e.id = ea.estimate_id
   and coalesce(e.mvb, 'none') <> 'none'
   and ea.mvb = false;

-- 2. "MVB Only" system type + its one-product recipe ------------------------
-- deposit_pct 25 (moisture barrier), labor/target seeded to reasonable values
-- Dylan confirms in the catalog; scope_template left null (no MVB-only scope in
-- the DripJobs extract; the scope writer skips an untemplated line and reports
-- it, and Dylan can add one). insert-if-missing by name.
insert into public.pec_prod_system_types
  (name, description, active, sort_order, labor_budget_pct, target_gp_pct, deposit_pct, requires_flake_color, requires_basecoat_color)
select 'MVB Only', 'Moisture vapor barrier only, no decorative coating.', true,
       (select coalesce(max(sort_order), 0) + 1 from public.pec_prod_system_types),
       15, 52, 25, false, false
where not exists (select 1 from public.pec_prod_system_types where name = 'MVB Only');

-- Its recipe: one required Basecoat slot defaulting to the standalone MVB
-- product, so the area prices the MVB at its own sqft via the normal plan.
insert into public.pec_prod_recipe_slots
  (system_type_id, order_index, material_type, slot_kind, label, default_product_id, required, editor_hidden)
select st.id, 1, 'Basecoat', 'product', 'Moisture Vapor Barrier', p.id, true, false
from public.pec_prod_system_types st
cross join public.pec_prod_products p
where st.name = 'MVB Only'
  and p.name = 'Simiron MVB - Standalone'
  and not exists (
    select 1 from public.pec_prod_recipe_slots rs where rs.system_type_id = st.id
  );

-- 3. Sundries + floor GP pricing config -------------------------------------
-- estimator_sundries_pct: sundries + disposables as a % of TOTAL job cost,
--   baked into every estimate's price (default 2). Setting it to 0 reproduces
--   the pre-build-17 price exactly.
-- estimator_floor_gp_pct: the GP% floor below which a manual override fires a
--   hard confirm (warns, does not block). Default 40.
insert into public.settings (key, value)
select 'estimator_sundries_pct', '2'
where not exists (select 1 from public.settings where key = 'estimator_sundries_pct');
insert into public.settings (key, value)
select 'estimator_floor_gp_pct', '40'
where not exists (select 1 from public.settings where key = 'estimator_floor_gp_pct');

-- 4. Manual price override provenance ---------------------------------------
-- calc_price: the engine's computed price (what the math says).
-- price: unchanged meaning, the number that actually sells (override or not),
--   so every downstream reader keeps working. deleted_by: who archived it.
alter table public.estimates add column if not exists calc_price            numeric;
alter table public.estimates add column if not exists price_override_reason text;
alter table public.estimates add column if not exists price_overridden_by   uuid;
alter table public.estimates add column if not exists price_overridden_at   timestamptz;
alter table public.estimates add column if not exists deleted_by            uuid;

commit;

-- ============================================================================
-- Verify after running:
--   select column_name from information_schema.columns
--     where table_name='estimate_areas' and column_name='mvb';               -- 1
--   select column_name from information_schema.columns
--     where table_name='pec_prod_areas' and column_name='mvb';               -- 1
--   select name, labor_budget_pct, target_gp_pct, deposit_pct
--     from pec_prod_system_types where name='MVB Only';                      -- 15/52/25
--   select rs.material_type, p.name from pec_prod_recipe_slots rs
--     join pec_prod_products p on p.id=rs.default_product_id
--     join pec_prod_system_types st on st.id=rs.system_type_id
--    where st.name='MVB Only';                                               -- Basecoat / Simiron MVB - Standalone
--   select key, value from settings
--     where key in ('estimator_sundries_pct','estimator_floor_gp_pct');      -- 2, 40
--   select column_name from information_schema.columns where table_name='estimates'
--     and column_name in ('calc_price','price_override_reason','price_overridden_by',
--                         'price_overridden_at','deleted_by');               -- 5
-- ============================================================================
