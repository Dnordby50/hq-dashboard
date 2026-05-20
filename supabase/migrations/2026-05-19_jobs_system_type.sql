-- ============================================================================
-- CRM Jobs: system_type_id link column
-- ============================================================================
-- Adds a nullable system_type_id column to public.jobs so a CRM job can carry
-- the same system-type selection used by the production / ordering flow
-- (public.pec_prod_system_types). Mirrors the dropdown on the schedule side.
--
-- Nullable with no default: every existing jobs row stays null, and the Jobs
-- form treats "No system type" as a valid empty selection. on delete set null
-- so removing a system type never deletes a job.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

alter table public.jobs
  add column if not exists system_type_id uuid
  references public.pec_prod_system_types(id) on delete set null;

create index if not exists idx_jobs_system_type
  on public.jobs(system_type_id) where system_type_id is not null;
