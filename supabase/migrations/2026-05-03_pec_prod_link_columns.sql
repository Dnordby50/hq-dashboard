-- ============================================================================
-- PEC PM Module: forward-compat link columns on pec_prod_jobs
-- ============================================================================
-- Adds nullable customer_id and proposal_id columns so production jobs can
-- later roll up under a CRM customer + an accepted proposal without rewriting
-- existing rows.
--
-- Standalone use is unchanged: every existing pec_prod_jobs row stays null on
-- both new columns, the New Job form does not write them, and no FK constraint
-- prevents jobs from being created without a customer.
--
-- proposal_id has no FK constraint yet because public.proposals does not exist.
-- A follow-up migration in Phase 3 will create that table and add the FK
-- constraint without touching column data.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

alter table public.pec_prod_jobs
  add column if not exists customer_id uuid references public.customers(id) on delete set null,
  add column if not exists proposal_id uuid;

create index if not exists idx_pec_prod_jobs_customer
  on public.pec_prod_jobs(customer_id) where customer_id is not null;

-- Note: index renamed to idx_pec_prod_jobs_proposal_link because the original
-- 2026-04-28_pm_ordering.sql migration already created idx_pec_prod_jobs_proposal
-- on the proposal_number column. See PROJECT-LOG.md entries dated 2026-05-03
-- 14:25 (collision discovered) and the follow-up correction entry.
create index if not exists idx_pec_prod_jobs_proposal_link
  on public.pec_prod_jobs(proposal_id) where proposal_id is not null;
