-- 2026-06-23: Company holidays + individual crew-member days off.
--
-- Adds two scheduling-overlay tables:
--   pec_prod_holidays              - company-wide block-out days (hard stop on
--                                    scheduling; a job can never be written onto
--                                    a holiday date).
--   pec_prod_crew_member_days_off  - a specific crew member is off for a day
--                                    (informational/visual only; jobs schedule to
--                                    CREWS not members, so this does NOT block).
--
-- Both mirror the existing pec_prod_* staff-only RLS pattern (admin staff full
-- access via public.is_admin_staff(), same as pec_prod_crews). Idempotent and
-- safe to re-run.

begin;

-- ============================================================================
-- 1) Company holidays (block-out days)
-- ============================================================================
create table if not exists public.pec_prod_holidays (
  id uuid primary key default gen_random_uuid(),
  holiday_date date not null unique,
  name text,
  created_at timestamptz not null default now()
);
create index if not exists idx_pec_prod_holidays_date on public.pec_prod_holidays(holiday_date);

-- ============================================================================
-- 2) Individual crew-member days off
-- ============================================================================
create table if not exists public.pec_prod_crew_member_days_off (
  id uuid primary key default gen_random_uuid(),
  crew_member_id uuid references public.pec_prod_crew_members(id) on delete cascade,
  off_date date not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (crew_member_id, off_date)
);
create index if not exists idx_pec_prod_crew_days_off_date on public.pec_prod_crew_member_days_off(off_date);
create index if not exists idx_pec_prod_crew_days_off_member on public.pec_prod_crew_member_days_off(crew_member_id);

-- ============================================================================
-- 3) RLS (mirror the existing pec_prod_* staff-only pattern)
-- ============================================================================
alter table public.pec_prod_holidays              enable row level security;
alter table public.pec_prod_crew_member_days_off  enable row level security;

drop policy if exists pec_prod_holidays_staff on public.pec_prod_holidays;
create policy pec_prod_holidays_staff on public.pec_prod_holidays for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists pec_prod_crew_member_days_off_staff on public.pec_prod_crew_member_days_off;
create policy pec_prod_crew_member_days_off_staff on public.pec_prod_crew_member_days_off for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

commit;

-- Verify after running:
--   select count(*) from public.pec_prod_holidays;                  -- 0 (UI seeds)
--   select count(*) from public.pec_prod_crew_member_days_off;      -- 0 (UI seeds)
--   select tablename, policyname from pg_policies
--     where tablename in ('pec_prod_holidays','pec_prod_crew_member_days_off');  -- 2 rows
