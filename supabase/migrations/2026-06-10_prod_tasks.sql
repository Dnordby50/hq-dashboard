-- ============================================================================
-- 2026-06-10: single-day crew tasks on the Job Schedule calendar
-- ============================================================================
-- Standalone reminders shown as chips on both calendar modes (1-week run
-- sheet and 3-week grid). Deliberately NO foreign key to pec_prod_jobs:
-- a task is never a job, and it must not interact with any job status
-- sync path (deriveJobStatus, the unified status trigger, etc.).
--
-- crew_lead stores the crew NAME as plain text, matching how
-- pec_prod_jobs.crew_lead is stored and rendered on the run sheet. That
-- means a task survives a crew row being renamed or deleted.
--
-- *** COWORK HANDOFF: run this in the PROD Supabase project. ***
-- Idempotent / safe to re-run.
-- ============================================================================

begin;

create table if not exists public.pec_prod_tasks (
  id          uuid primary key default gen_random_uuid(),
  task_date   date not null,
  crew_lead   text,
  description text not null,
  completed   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists pec_prod_tasks_date_idx on public.pec_prod_tasks (task_date);

alter table public.pec_prod_tasks enable row level security;

drop policy if exists pec_prod_tasks_staff on public.pec_prod_tasks;
create policy pec_prod_tasks_staff on public.pec_prod_tasks for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

-- Shared touch trigger function already exists (2026-04-28_pm_ordering.sql);
-- only the trigger is attached here.
drop trigger if exists trg_pec_prod_tasks_touch on public.pec_prod_tasks;
create trigger trg_pec_prod_tasks_touch before update on public.pec_prod_tasks
  for each row execute function public.pec_prod_touch_updated_at();

commit;

-- Verify after running:
--   select count(*) from information_schema.tables
--     where table_schema='public' and table_name='pec_prod_tasks';            -- 1
--   select count(*) from pg_policies where tablename='pec_prod_tasks';        -- 1
--   select count(*) from pg_trigger where tgname='trg_pec_prod_tasks_touch';  -- 1
