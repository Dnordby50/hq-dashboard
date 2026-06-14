-- ============================================================================
-- Job Costing lifecycle columns (Phases 3-4 of the costing overhaul) plus the
-- per-crew-member hourly wage. Author: Claude Code (2026-06-14).
-- RUN BY COWORK on the PEC Supabase project. Idempotent. This was NOT applied to
-- prod from the Claude Code session, per the standing do-not-touch-prod rule.
--
-- Home choice: the reconciled/finalized stamps live on pec_prod_jobs (not
-- pec_prod_job_costing) because renderUnifiedJob already reads job fields and
-- writes them through saveJobField -> pec_prod_jobs.update. A costing row may not
-- exist yet for a job, whereas the job row always does, so the stamps can never
-- be orphaned and we avoid an upsert-into-costing dance just to set them.
-- ============================================================================

-- 1) Reconciliation + finalize stamps on the job.
alter table public.pec_prod_jobs
  add column if not exists hours_reconciled_at  timestamptz,
  add column if not exists hours_reconciled_by  text,
  add column if not exists costing_finalized_at timestamptz,
  add column if not exists costing_finalized_by text;

-- 2) Per-crew-member hourly wage. Drives the Crew Bonus math
--    (actual labor = hours x wage x 1.25 burden). A null wage falls back to
--    settings.default_labor_hourly_rate in the app.
alter table public.pec_prod_crew_members
  add column if not exists hourly_wage numeric;

-- 3) Partial index so the new Completed Job Costing view (jobs WITH a finalize
--    stamp) and the active / Pending Job Costing lists (jobs WITHOUT one) filter
--    cheaply as the table grows.
create index if not exists idx_pec_prod_jobs_costing_finalized
  on public.pec_prod_jobs (costing_finalized_at)
  where costing_finalized_at is not null;

-- No new RLS: pec_prod_jobs and pec_prod_crew_members already carry their
-- policies, and these are just added columns on those existing tables.
