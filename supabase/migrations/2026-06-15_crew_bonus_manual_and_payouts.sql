-- ============================================================================
-- 2026-06-15: manual crew-labor entry + bonus payout ledger.
-- Author: Claude Code. RUN BY COWORK on the PROD Supabase project. Idempotent.
-- NOT applied to prod from the Claude Code session.
--
-- Why: actual hours only come from BusyBusy (pec_prod_busybusy_time_entries),
-- which is 401-blocked and empty, so the Bonus Payout box can never compute a
-- payout. These tables let the office enter hours by hand NOW, drive the EXISTING
-- computeCrewBonus math from them, record the result into the bonus ledger on
-- finalize, and track paid/pending like commissions. BusyBusy takes over the
-- hours source automatically once its 401 is resolved (it wins when it has data).
--
-- Reuses public.is_admin_staff(), public.is_admin_role(),
-- public.pec_prod_touch_updated_at().
-- ============================================================================

-- 1) Manual labor hours: per job, per crew member ----------------------------
create table if not exists public.pec_prod_job_manual_labor (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.pec_prod_jobs(id) on delete cascade,
  crew_member_id uuid references public.pec_prod_crew_members(id) on delete set null,
  hours          numeric not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (job_id, crew_member_id)
);
create index if not exists idx_pec_prod_job_manual_labor_job
  on public.pec_prod_job_manual_labor(job_id);

alter table public.pec_prod_job_manual_labor enable row level security;
drop policy if exists pec_prod_job_manual_labor_staff on public.pec_prod_job_manual_labor;
create policy pec_prod_job_manual_labor_staff on public.pec_prod_job_manual_labor for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop trigger if exists trg_pec_prod_job_manual_labor_touch on public.pec_prod_job_manual_labor;
create trigger trg_pec_prod_job_manual_labor_touch before update on public.pec_prod_job_manual_labor
  for each row execute function public.pec_prod_touch_updated_at();

-- 2) Idempotency guard for the labor-savings bonus rows finalize writes -------
-- Partial: only the rows finalize creates (note = 'Labor-savings bonus'), so it
-- never collides with existing crew-lead / ad-hoc bonus rows. crew_member_id is
-- always set on these rows, so partial-index nulls are not a concern. The client
-- also delete-then-inserts on finalize; this is the database backstop.
create unique index if not exists uq_pec_prod_job_bonuses_labor_savings
  on public.pec_prod_job_bonuses (job_id, crew_member_id)
  where note = 'Labor-savings bonus';

-- 3) Bonus payout ledger (mirrors pec_commission_payouts) --------------------
-- A bonus is PENDING when it has no row here, PAID when it has one. amount is
-- frozen at payout time. payroll_date is the Friday check date it correlates to.
create table if not exists public.pec_bonus_payouts (
  bonus_id     uuid primary key references public.pec_prod_job_bonuses(id) on delete cascade,
  amount       numeric(12,2),
  paid_on      date,
  payroll_date date,
  paid_by      text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists bp_paid_on_idx     on public.pec_bonus_payouts (paid_on);
create index if not exists bp_payroll_date_idx on public.pec_bonus_payouts (payroll_date);

alter table public.pec_bonus_payouts enable row level security;
drop policy if exists bp_select on public.pec_bonus_payouts;
create policy bp_select on public.pec_bonus_payouts for select using (public.is_admin_staff());
drop policy if exists bp_write on public.pec_bonus_payouts;
create policy bp_write on public.pec_bonus_payouts for all using (public.is_admin_role()) with check (public.is_admin_role());

drop trigger if exists trg_pec_bonus_payouts_touch on public.pec_bonus_payouts;
create trigger trg_pec_bonus_payouts_touch before update on public.pec_bonus_payouts
  for each row execute function public.pec_prod_touch_updated_at();

-- Verify after running:
--   select count(*) from public.pec_prod_job_manual_labor;  -- 0
--   select count(*) from public.pec_bonus_payouts;          -- 0
--   select indexname from pg_indexes where indexname = 'uq_pec_prod_job_bonuses_labor_savings';  -- 1 row
