-- Touch-up / warranty callback visits as real schedule entries.
-- A callback is a no-charge return trip linked to an original job. It is a NEW
-- pec_prod_jobs row (so it gets its own schedule days / crew / time slot) marked
-- is_callback = true and linked via original_job_id. It must NOT need revenue
-- (touch-ups are free), so the scheduled-needs-revenue constraint is widened to
-- exempt callbacks.
--
-- NOTE: this is a SEPARATE concept from the existing pec_prod_jobs.callback
-- boolean, which is an after-the-fact QUALITY flag (crew-lead callback counts).
-- That column is left untouched.

alter table public.pec_prod_jobs
  add column if not exists is_callback boolean not null default false;

alter table public.pec_prod_jobs
  add column if not exists original_job_id uuid references public.pec_prod_jobs(id) on delete set null;

-- Widen the revenue gate: a scheduled row still needs revenue > 0 UNLESS it is a
-- callback. Re-added NOT VALID (matching 2026-06-02_price_integrity.sql's style);
-- VALIDATE after confirming no existing scheduled row violates it.
alter table public.pec_prod_jobs drop constraint if exists pec_prod_jobs_scheduled_needs_revenue;
alter table public.pec_prod_jobs
  add constraint pec_prod_jobs_scheduled_needs_revenue
  check (status <> 'scheduled' OR is_callback = true OR (revenue is not null and revenue > 0))
  not valid;

-- Helpful for "show this job's callbacks" lookups.
create index if not exists idx_pec_prod_jobs_original_job_id on public.pec_prod_jobs(original_job_id);

-- After confirming existing rows are clean, run:
--   alter table public.pec_prod_jobs validate constraint pec_prod_jobs_scheduled_needs_revenue;
