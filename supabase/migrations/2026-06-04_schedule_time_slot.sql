-- ============================================================================
-- 2026-06-04: AM/PM time slot on schedule days
-- ============================================================================
-- PEC crews run ~2 site visits per day (an AM job and a PM job). time_slot tags
-- each scheduled day as 'AM' or 'PM' so the calendar and the Next-Day
-- finalization board can show first/second visit per crew. Nullable: null means
-- "slot not set yet" (the Next-Day board surfaces those for assignment).
--
-- day_index already exists for multi-day sequencing within ONE job; time_slot is
-- the within-day marker, independent of day_index.
--
-- Additive + idempotent. Deploy-order safe: the client reads time_slot via
-- select('*') (undefined before this runs) and writes it with a fallback.
-- ============================================================================

begin;

alter table public.pec_prod_job_schedule_days
  add column if not exists time_slot text check (time_slot in ('AM','PM'));

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='pec_prod_job_schedule_days'
--       and column_name='time_slot';
--   -- expect: 1 row.
