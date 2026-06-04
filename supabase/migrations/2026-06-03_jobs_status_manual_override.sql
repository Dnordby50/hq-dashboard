-- ============================================================================
-- 2026-06-03: jobs.status_manual_at (manual status override marker)
-- ============================================================================
-- The job-detail status dropdown used to "do nothing": a manual pick was saved,
-- then renderJobDetail re-ran, the schedule auto-sync recomputed the status from
-- the linked pec_prod_jobs.install_date, and overwrote the manual choice back.
-- To the user the dropdown snapped back to the schedule-derived value.
--
-- status_manual_at records WHEN an admin last set the status by hand. Once set,
-- the automation that derives status from the schedule stops touching the row:
--   1. renderJobDetail's schedule auto-sync (index.html ~7698)
--   2. runAutoProgressSweep, the client boot sweep (index.html ~5147)
--   3. pec-auto-progress.cjs, the daily 6am MST scheduled function
-- so an admin's pick sticks. The DripJobs proposal/stage webhooks are NOT
-- gated by this column (they reflect real external events); whether a manual
-- override should also survive a later DripJobs stage change is a follow-up
-- decision for Dylan.
--
-- Additive + idempotent. Deploy-order safe: the client reads the flag from
-- select('*') (undefined before this runs, so nothing is suppressed) and the
-- override write falls back to a status-only update if the column is missing,
-- so deploying the code before this migration runs cannot break the dropdown.
-- ============================================================================

begin;

alter table public.jobs
  add column if not exists status_manual_at timestamptz;

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='jobs'
--       and column_name='status_manual_at';
--   -- expect: 1 row.
