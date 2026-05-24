-- ============================================================================
-- 2026-05-24: per-system budget percentages + default labor hourly rate
-- ============================================================================
-- Phase 3 of the CRM evolution plan. Adds two budget knobs per system
-- (labor and materials, both expressed as a percentage of job revenue) and a
-- single project-wide default labor hourly rate setting. The plan call:
-- "have a set labor budget under system type. ex) flake is 20%" --> a $10,000
-- flake job has a $2,000 labor budget = ~57 hours at $35/hr.
--
-- The dashboard's job detail Budget card multiplies revenue by labor_budget_pct
-- to get the dollar budget, then divides by default_labor_hourly_rate to get
-- budgeted hours. The Job Costing view uses the same fields for its Labor
-- Budget variance column.
--
-- Per-system values + the hourly rate are SEEDED EMPTY HERE. Cowork handoff
-- (in PROJECT-LOG.md) collects Dylan's per-system percentages and the
-- canonical hourly rate, then runs the seed updates. Until then, the Budget
-- card on the job detail page shows "Not set in catalog" and the costing
-- variance column shows "--".
--
-- Idempotent. Safe to re-run.
-- ============================================================================

begin;

alter table public.pec_prod_system_types
  add column if not exists labor_budget_pct numeric(5,2),
  add column if not exists materials_budget_pct numeric(5,2);

-- Soft validation: any non-null percentage stays between 0 and 100. NULL means
-- "not set yet"; the dashboard falls back to a neutral message.
alter table public.pec_prod_system_types
  drop constraint if exists pec_prod_system_types_labor_pct_range;
alter table public.pec_prod_system_types
  add constraint pec_prod_system_types_labor_pct_range
  check (labor_budget_pct is null or (labor_budget_pct >= 0 and labor_budget_pct <= 100));

alter table public.pec_prod_system_types
  drop constraint if exists pec_prod_system_types_materials_pct_range;
alter table public.pec_prod_system_types
  add constraint pec_prod_system_types_materials_pct_range
  check (materials_budget_pct is null or (materials_budget_pct >= 0 and materials_budget_pct <= 100));

-- Seed a placeholder for the project-wide default labor hourly rate. The
-- existing public.settings table is a generic key/value store; the dashboard
-- already reads it at boot for things like the referral reward amount. The
-- on conflict clause leaves an existing rate untouched if one already exists.
insert into public.settings (key, value)
  values ('default_labor_hourly_rate', '35')
  on conflict (key) do nothing;

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='pec_prod_system_types'
--       and column_name in ('labor_budget_pct','materials_budget_pct');
--   -- expect: 2 rows.
--   select key, value from public.settings where key = 'default_labor_hourly_rate';
--   -- expect: 1 row with value '35' (or whatever Dylan set later).
--
-- Cowork seed step (after Dylan provides the per-system %s):
--   update public.pec_prod_system_types set labor_budget_pct = 20.00 where name = 'Flake';
--   update public.pec_prod_system_types set labor_budget_pct = <X>     where name = 'Quartz';
--   update public.pec_prod_system_types set labor_budget_pct = <X>     where name = 'Metallic';
--   update public.pec_prod_system_types set labor_budget_pct = <X>     where name = 'Grind and Seal - Cohills';
--   update public.pec_prod_system_types set labor_budget_pct = <X>     where name = 'Grind and Seal - Urethane';
--   update public.pec_prod_system_types set labor_budget_pct = <X>     where name = 'Concrete Polishing';
--   update public.pec_prod_system_types set labor_budget_pct = <X>     where name = 'Custom System';
-- And the hourly rate update:
--   update public.settings set value = '<rate>' where key = 'default_labor_hourly_rate';
