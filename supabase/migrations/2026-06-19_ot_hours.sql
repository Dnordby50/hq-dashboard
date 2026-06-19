-- ============================================================================
-- 2026-06-19: overtime (OT) hours for OT-aware job costing.
-- Author: Claude Code. RUN BY COWORK on the PROD Supabase project. Idempotent.
-- NOT applied to prod from the Claude Code session.
--
-- Why: overtime is paid at a premium (assume 1.5x base wage), so a job that
-- burned OT has a HIGHER loaded labor cost than the flat hours x wage math
-- showed, and the crew labor-savings bonus (75% of laborBudget - actualLabor)
-- must shrink accordingly or the company over-pays a bonus on labor that
-- actually cost more. computeCrewBonus (index.html) now splits each member's
-- hours into regular + OT and costs OT at OT_MULTIPLIER x wage.
--
-- Model: keep the existing `hours` column as TOTAL hours and add `ot_hours` as
-- the OT slice of that total. regular = hours - ot_hours. This keeps every
-- existing SUM(hours) correct and needs NO backfill (ot_hours defaults to 0, so
-- every existing row reads as "all regular hours", which is the prior behavior).
--
-- Applies to BOTH hours sources so the math is identical no matter which feeds
-- the bonus:
--   1) pec_prod_job_manual_labor       (office-entered hours, live today)
--   2) pec_prod_busybusy_time_entries  (BusyBusy sync, gated on the 401)
-- ============================================================================

-- 1) Manual labor: OT slice of the per-member total hours.
alter table public.pec_prod_job_manual_labor
  add column if not exists ot_hours numeric not null default 0;

-- 2) BusyBusy time entries: OT slice of the entry's total hours. The BusyBusy
--    TimeEntry has no OT flag (OT is a pay-period report concept), so this is
--    populated by OUR OT computation in the (still-unbuilt, 401-gated) sync, not
--    by BusyBusy. Defaults to 0 so existing/empty rows are unaffected.
alter table public.pec_prod_busybusy_time_entries
  add column if not exists ot_hours numeric(10,4) not null default 0;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_name = 'pec_prod_job_manual_labor' and column_name = 'ot_hours';      -- 1 row
--   select column_name from information_schema.columns
--     where table_name = 'pec_prod_busybusy_time_entries' and column_name = 'ot_hours'; -- 1 row
--   select count(*) from public.pec_prod_job_manual_labor where ot_hours <> 0;          -- 0 (no backfill)
