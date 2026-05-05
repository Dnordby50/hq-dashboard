-- 2026-05-04: Job Schedule + Job Costing infrastructure.
--
-- Adds three new tables (pec_prod_crews, pec_prod_job_schedule_days,
-- pec_prod_job_costing), extends pec_prod_jobs with the fields the schedule
-- popup and costing view need, and adds a `color` column to
-- pec_prod_system_types so the calendar can render a color band per system.
--
-- Run order: this migration is independent of the 2026-05-04 catalog work
-- but assumes it has already run (so pec_prod_system_types exists with the
-- 5 active systems). Idempotent. Safe to re-run.

begin;

-- ============================================================================
-- 1) Crews (named teams for scheduling)
-- ============================================================================
create table if not exists public.pec_prod_crews (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- 2) Schedule days (one row per scheduled day per job; supports non-contiguous)
-- ============================================================================
create table if not exists public.pec_prod_job_schedule_days (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.pec_prod_jobs(id) on delete cascade,
  scheduled_date date not null,
  day_index int not null default 0,
  crew_id uuid references public.pec_prod_crews(id) on delete set null,
  crew_lead text,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists idx_pec_prod_jsd_date on public.pec_prod_job_schedule_days(scheduled_date);
create index if not exists idx_pec_prod_jsd_job on public.pec_prod_job_schedule_days(job_id, day_index);

-- ============================================================================
-- 3) System type color (calendar band color per system)
-- ============================================================================
alter table public.pec_prod_system_types add column if not exists color text;
update public.pec_prod_system_types set color='#7c3aed' where name='Flake'                      and color is null;
update public.pec_prod_system_types set color='#0ea5e9' where name='Quartz'                     and color is null;
update public.pec_prod_system_types set color='#a855f7' where name='Metallic'                   and color is null;
update public.pec_prod_system_types set color='#f59e0b' where name='Grind and Seal - Cohills'   and color is null;
update public.pec_prod_system_types set color='#fb923c' where name='Grind and Seal - Urethane'  and color is null;
update public.pec_prod_system_types set color='#10b981' where name='Grind Stain and Seal'       and color is null;

-- ============================================================================
-- 4) Extend pec_prod_jobs with schedule + costing fields
-- ============================================================================
alter table public.pec_prod_jobs add column if not exists estimated_hours numeric(8,2);
alter table public.pec_prod_jobs add column if not exists actual_hours numeric(8,2);
alter table public.pec_prod_jobs add column if not exists sales_team text;
alter table public.pec_prod_jobs add column if not exists crew_id uuid references public.pec_prod_crews(id) on delete set null;
alter table public.pec_prod_jobs add column if not exists crew_lead text;
alter table public.pec_prod_jobs add column if not exists callback boolean not null default false;
alter table public.pec_prod_jobs add column if not exists dripjobs_deal_id text;
create index if not exists idx_pec_prod_jobs_dripjobs_deal
  on public.pec_prod_jobs(dripjobs_deal_id) where dripjobs_deal_id is not null;

-- ============================================================================
-- 5) Job costing (one row per job, upserted; fields the user listed)
--    Materials are stored as TWO separate $ values per the user's note that
--    actual usage diverges from what was ordered. Derived columns
--    (Over/Under, Var %, Total, GP, %s, GP/HR, Rev/HR) are computed in the
--    UI, not stored.
-- ============================================================================
create table if not exists public.pec_prod_job_costing (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.pec_prod_jobs(id) on delete cascade,
  -- Materials (manual at job-end; ordered != used)
  materials_ordered_cost numeric(12,2) not null default 0,
  materials_used_cost    numeric(12,2) not null default 0,
  -- Other expense buckets
  equipment_rental_cost  numeric(12,2) not null default 0,
  salary_wages_cost      numeric(12,2) not null default 0,
  subcontractor_cost     numeric(12,2) not null default 0,
  misc_cost              numeric(12,2) not null default 0,
  bonus_cost             numeric(12,2) not null default 0,
  commission_cost        numeric(12,2) not null default 0,
  -- Free-form
  misc_text text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_pec_prod_job_costing_job on public.pec_prod_job_costing(job_id);

-- ============================================================================
-- 6) updated_at triggers (reuse the existing pec_prod_touch_updated_at fn
--    declared in 2026-04-28_pm_ordering.sql)
-- ============================================================================
drop trigger if exists trg_pec_prod_crews_touch on public.pec_prod_crews;
create trigger trg_pec_prod_crews_touch before update on public.pec_prod_crews
  for each row execute function public.pec_prod_touch_updated_at();

drop trigger if exists trg_pec_prod_job_costing_touch on public.pec_prod_job_costing;
create trigger trg_pec_prod_job_costing_touch before update on public.pec_prod_job_costing
  for each row execute function public.pec_prod_touch_updated_at();

-- ============================================================================
-- 7) RLS (mirror the existing pec_prod_* staff-only pattern)
-- ============================================================================
alter table public.pec_prod_crews              enable row level security;
alter table public.pec_prod_job_schedule_days  enable row level security;
alter table public.pec_prod_job_costing        enable row level security;

drop policy if exists pec_prod_crews_staff on public.pec_prod_crews;
create policy pec_prod_crews_staff on public.pec_prod_crews for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists pec_prod_job_schedule_days_staff on public.pec_prod_job_schedule_days;
create policy pec_prod_job_schedule_days_staff on public.pec_prod_job_schedule_days for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists pec_prod_job_costing_staff on public.pec_prod_job_costing;
create policy pec_prod_job_costing_staff on public.pec_prod_job_costing for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

commit;

-- Verify after running:
--   select count(*) from public.pec_prod_crews;                   -- 0 (UI seeds via Settings)
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='pec_prod_jobs'
--       and column_name in ('estimated_hours','crew_id','sales_team','dripjobs_deal_id');
--   -- expect: 4 rows
--   select name, color from public.pec_prod_system_types order by name;
--   -- expect: 6 active systems all carrying a hex color
