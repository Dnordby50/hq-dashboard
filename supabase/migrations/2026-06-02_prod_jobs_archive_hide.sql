-- ============================================================================
-- pec_prod_jobs: archive + hide-from-pending columns
-- ============================================================================
-- Author: Claude Code (2026-06-02). RUN BY COWORK on the PEC Supabase project
-- (zdfpzmmrgotynrwkeakd, Primary DB, postgres role). Idempotent, additive.
--
-- Backs two new UI controls:
--   * archived_at: set when a job is archived from the CRM job-detail "Delete"
--     box. The app hides any pec_prod_jobs row with archived_at set from
--     Ordering, Job Schedule, Pending, and Job Costing (client-side filter on
--     this column). public.jobs already has its own archived_at; the detail
--     box sets both so the job leaves every list. archived_at IS NULL = active.
--   * pending_hidden_at: set when a job is removed from the Job Schedule
--     "Pending Jobs" sidebar (a mistake fix). It hides the card from the Pending
--     list ONLY; the job stays on the Ordering page with all data intact.
--
-- Both columns are nullable with no default, so existing rows are unaffected
-- (NULL = visible). RLS: the existing is_admin_staff() update policy on
-- pec_prod_jobs already covers writes to these columns; no policy change.
--
-- Reads filter client-side (e.g. !j.archived_at), so deploying the app code
-- before this migration runs cannot break Ordering/Schedule (a missing column
-- just reads as undefined and hides nothing). Run this before the new Delete /
-- Remove buttons are used, so their writes land.
-- ============================================================================

alter table public.pec_prod_jobs
  add column if not exists archived_at       timestamptz,
  add column if not exists pending_hidden_at timestamptz;

-- Partial index keeps the common "active jobs" scans cheap as archived rows pile up.
create index if not exists idx_pec_prod_jobs_active
  on public.pec_prod_jobs(archived_at) where archived_at is null;
