-- @artifacts
--   column: public.pec_prod_jobs.crm_job_id
--   column: public.pec_prod_jobs.crm_link_declined
--   index: idx_pec_prod_jobs_crm_job_id
-- @end
-- ============================================================================
-- 2026-08-29: explicit prod-to-CRM job link (prompt 91 Task 1).
-- Author: Claude Code. Additive, non-money, non-auth: direct to prod per
-- standing rule 14.
--
-- WHY: the two parallel job tables (public.jobs / pec_prod_jobs) bridge
-- through resolveCrmForProdJob's ladder, whose last rung is a fuzzy
-- normalized name+address match. A repeat customer with two real open jobs
-- at the same name+address (the Haley Construction case) cannot be told
-- apart by that rung: first row wins, so one prod job silently reads the
-- other job's areas, price, and materials. crm_job_id makes the pairing
-- EXPLICIT at the root; the fuzzy rung becomes a legacy fallback for old
-- rows only.
--
-- crm_link_declined is the opt-out marker (prompt 91 Task 5): when Dylan
-- answers the creation-time chooser with "Separate new job" and no CRM
-- partner row exists to point crm_job_id at, this flag records the
-- declaration so the resolver's name+address rung skips the row FOREVER
-- (a sentinel value in crm_job_id would break the FK, hence the companion
-- boolean).
--
-- ON DELETE SET NULL: CRM jobs are soft-archived in practice, but a hard
-- delete must degrade the prod row to unlinked, never block the delete.
-- ============================================================================

alter table public.pec_prod_jobs
  add column if not exists crm_job_id uuid null references public.jobs(id) on delete set null,
  add column if not exists crm_link_declined boolean not null default false;

-- Partial: only linked rows are indexed (the lookup is always by a real id).
create index if not exists idx_pec_prod_jobs_crm_job_id
  on public.pec_prod_jobs (crm_job_id) where crm_job_id is not null;
