-- 2026-05-17: Unified job page infrastructure.
--
-- Three changes that together let the Job Costing detail page move from a
-- modal to a full-page view and capture per-line material usage plus
-- per-crew-member bonuses (instead of the current single job-level numbers):
--
--   1) pec_prod_material_lines.actual_used_qty  (per-line consumption)
--   2) pec_prod_crew_members                    (granular crew roster; the
--      existing pec_prod_crews is teams, not people)
--   3) pec_prod_job_bonuses                     (per-job, per-crew-member
--      bonus + hours row; the BusyBusy integration in a later commit will
--      populate hours_actual)
--
-- Reuses public.pec_prod_touch_updated_at() and public.is_admin_staff()
-- from 2026-04-28_pm_ordering.sql. Idempotent. Safe to re-run.

begin;

-- ============================================================================
-- 1) Per-line "actual used" quantity (cost is derived in UI from
--    actual_used_qty * unit_cost_snapshot, so no extra column needed)
-- ============================================================================
alter table public.pec_prod_material_lines
  add column if not exists actual_used_qty numeric(12,4);

-- ============================================================================
-- 2) Crew members (people). pec_prod_crews is teams. A member can belong to
--    one team via crew_id (optional). busybusy_member_id is a placeholder for
--    the BusyBusy time-tracking integration we'll wire up in a later commit.
-- ============================================================================
create table if not exists public.pec_prod_crew_members (
  id uuid primary key default gen_random_uuid(),
  crew_id uuid references public.pec_prod_crews(id) on delete set null,
  name text not null,
  busybusy_member_id text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_pec_prod_crew_members_crew
  on public.pec_prod_crew_members(crew_id);

-- ============================================================================
-- 3) Per-job, per-crew-member bonus rows. crew_member_name is snapshotted so
--    the row stays readable even if the crew_member is later deleted.
--    hours_actual is manual today and BusyBusy-fed in a later commit.
-- ============================================================================
create table if not exists public.pec_prod_job_bonuses (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.pec_prod_jobs(id) on delete cascade,
  crew_member_id uuid references public.pec_prod_crew_members(id) on delete set null,
  crew_member_name text not null,
  hours_actual numeric(8,2),
  amount numeric(12,2) not null default 0,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_pec_prod_job_bonuses_job
  on public.pec_prod_job_bonuses(job_id);

-- ============================================================================
-- 4) updated_at triggers (reuse pec_prod_touch_updated_at fn)
-- ============================================================================
drop trigger if exists trg_pec_prod_crew_members_touch on public.pec_prod_crew_members;
create trigger trg_pec_prod_crew_members_touch before update on public.pec_prod_crew_members
  for each row execute function public.pec_prod_touch_updated_at();

drop trigger if exists trg_pec_prod_job_bonuses_touch on public.pec_prod_job_bonuses;
create trigger trg_pec_prod_job_bonuses_touch before update on public.pec_prod_job_bonuses
  for each row execute function public.pec_prod_touch_updated_at();

-- ============================================================================
-- 5) RLS (mirror the existing pec_prod_* staff-only pattern)
-- ============================================================================
alter table public.pec_prod_crew_members enable row level security;
alter table public.pec_prod_job_bonuses  enable row level security;

drop policy if exists pec_prod_crew_members_staff on public.pec_prod_crew_members;
create policy pec_prod_crew_members_staff on public.pec_prod_crew_members for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists pec_prod_job_bonuses_staff on public.pec_prod_job_bonuses;
create policy pec_prod_job_bonuses_staff on public.pec_prod_job_bonuses for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='pec_prod_material_lines'
--       and column_name='actual_used_qty';
--   -- expect: 1 row
--   select count(*) from public.pec_prod_crew_members; -- 0 (seed via UI / SQL)
--   select count(*) from public.pec_prod_job_bonuses;  -- 0
