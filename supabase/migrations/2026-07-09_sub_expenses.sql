-- ============================================================================
-- 2026-07-09: itemized subcontractor expenses + subcontracted-job flag.
-- Author: Claude Code (prompt 10). RUN BY COWORK on the PROD Supabase project.
-- Idempotent. NOT applied to prod from the Claude Code session.
--
-- Why: pec_prod_job_costing.subcontractor_cost is a single per-job dollar field
-- with no record of WHO was paid WHAT. This adds per-line sub expenses (name +
-- amount only, per Dylan's decisions 2026-07-06) that SUM into the existing
-- subcontractor_cost bucket, so GP math and every rollup keep working
-- unchanged. Also adds pec_prod_jobs.subcontracted: flagged jobs are excluded
-- from crew-hours expectations and the crew bonus calc (no crew worked them).
--
-- Reuses public.is_admin_staff() and public.pec_prod_touch_updated_at().
-- ============================================================================

-- 1) Per-job subcontractor expense lines --------------------------------------
-- created_at exists for stable ordering only; the UI's entry boxes are exactly
-- name + amount (no description / date / invoice / paid tracking, by decision).
create table if not exists public.pec_prod_job_sub_expenses (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references public.pec_prod_jobs(id) on delete cascade,
  name       text not null,
  amount     numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_pec_prod_job_sub_expenses_job
  on public.pec_prod_job_sub_expenses(job_id);

-- Same RLS shape as the sibling costing tables (one FOR ALL staff policy,
-- pattern copied from pec_prod_job_manual_labor in 2026-06-15).
alter table public.pec_prod_job_sub_expenses enable row level security;
drop policy if exists pec_prod_job_sub_expenses_staff on public.pec_prod_job_sub_expenses;
create policy pec_prod_job_sub_expenses_staff on public.pec_prod_job_sub_expenses for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop trigger if exists trg_pec_prod_job_sub_expenses_touch on public.pec_prod_job_sub_expenses;
create trigger trg_pec_prod_job_sub_expenses_touch before update on public.pec_prod_job_sub_expenses
  for each row execute function public.pec_prod_touch_updated_at();

-- 2) Subcontracted-job flag ----------------------------------------------------
alter table public.pec_prod_jobs
  add column if not exists subcontracted boolean not null default false;

-- 3) Backfill: one "Prior entry" line per job with a legacy single-field amount.
-- Guarded so re-running cannot duplicate: only jobs with ZERO existing sub-
-- expense rows get the line, so the per-job sum stays identical to the old
-- subcontractor_cost before and after, and everything is itemized going
-- forward. The pec_prod_jobs join mirrors the FK so an orphaned costing row
-- (if one ever existed) cannot fail the whole migration.
insert into public.pec_prod_job_sub_expenses (job_id, name, amount)
select c.job_id, 'Prior entry', c.subcontractor_cost
from public.pec_prod_job_costing c
join public.pec_prod_jobs j on j.id = c.job_id
where c.subcontractor_cost > 0
  and not exists (
    select 1 from public.pec_prod_job_sub_expenses s where s.job_id = c.job_id
  );

-- ============================================================================
-- Verify after running (Cowork: capture the outputs in your log entry):
--
-- a) Table exists with RLS on and exactly one FOR ALL staff policy:
--   select relrowsecurity from pg_class where relname = 'pec_prod_job_sub_expenses';        -- t
--   select policyname, cmd from pg_policies where tablename = 'pec_prod_job_sub_expenses';  -- 1 row, ALL
--
-- b) Flag column present, boolean, default false:
--   select data_type, column_default from information_schema.columns
--   where table_name = 'pec_prod_jobs' and column_name = 'subcontracted';
--
-- c) Backfill count (jobs that got a "Prior entry" line):
--   select count(*) from public.pec_prod_job_sub_expenses where name = 'Prior entry';
--
-- d) CHECKSUM: per-job sum(line amounts) must equal the old subcontractor_cost
--    for every job that has lines. Expect ZERO rows:
--   select c.job_id, c.subcontractor_cost, s.line_sum
--   from public.pec_prod_job_costing c
--   join (select job_id, sum(amount) as line_sum
--         from public.pec_prod_job_sub_expenses group by job_id) s
--     on s.job_id = c.job_id
--   where coalesce(c.subcontractor_cost, 0) <> s.line_sum;
--
-- e) Touch trigger present:
--   select tgname from pg_trigger where tgname = 'trg_pec_prod_job_sub_expenses_touch';     -- 1 row
-- ============================================================================
