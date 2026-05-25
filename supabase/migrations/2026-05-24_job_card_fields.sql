-- ============================================================================
-- 2026-05-24: work-order intake fields on public.jobs
-- ============================================================================
-- Dylan: the existing paper work order ("MAKE SURE TO ACCURATELY FILL OUT ALL
-- SECTIONS") asks for several fields the CRM does not capture today. We add
-- them to public.jobs (CRM-side) since they're entered during job creation /
-- pre-install, then the new "Print Work Order" view reads them out alongside
-- the customer + areas + materials plan.
--
-- All nullable. Two CHECK constraints clamp the dropdowns to the sheet's
-- ranges (moisture 1-5, MOHS 1-10). Idempotent.
-- ============================================================================

begin;

alter table public.jobs
  add column if not exists gate_code text,
  add column if not exists coat_past_garage boolean,
  add column if not exists stem_walls boolean,
  add column if not exists moisture int,
  add column if not exists mohs_hardness int,
  add column if not exists additional_non_slip text,
  add column if not exists grinder_tooling_grit text;

alter table public.jobs drop constraint if exists jobs_moisture_range;
alter table public.jobs
  add constraint jobs_moisture_range
  check (moisture is null or (moisture between 1 and 5));

alter table public.jobs drop constraint if exists jobs_mohs_range;
alter table public.jobs
  add constraint jobs_mohs_range
  check (mohs_hardness is null or (mohs_hardness between 1 and 10));

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='jobs'
--       and column_name in ('gate_code','coat_past_garage','stem_walls','moisture',
--                           'mohs_hardness','additional_non_slip','grinder_tooling_grit');
--   -- expect 7 rows.
--   select conname from pg_constraint where conrelid='public.jobs'::regclass
--     and conname in ('jobs_moisture_range','jobs_mohs_range');
--   -- expect 2 rows.
