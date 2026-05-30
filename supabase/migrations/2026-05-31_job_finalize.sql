-- ============================================================================
-- 2026-05-31: finalize / price-lock flag for jobs
-- ============================================================================
-- The job detail now carries editable line items (scope title + detail + price)
-- pasted from the signed DripJobs proposal; their prices sum to jobs.price. Once
-- the office clicks "Finalize job", the line items and price lock -- after that
-- only a change order (on the invoice) can alter the total. This flag persists
-- that locked state.
--
-- line_items already exists (2026-05-27_invoicing_ar.sql). Read directly from
-- public.jobs by the job detail (select('*')) and dashboard, so no view change.
-- jobs_staff RLS already permits staff UPDATE.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

begin;

alter table public.jobs
  add column if not exists finalized    boolean not null default false,
  add column if not exists finalized_at timestamptz;

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='jobs'
--       and column_name in ('finalized','finalized_at');
--   -- expect 2 rows.
