-- Commission payout tracking: one row per PAID payment.
--
-- Commission is paid on dollars actually collected (each pec_payments row is a
-- payment brought in: deposit, progress, or final, all the same). Commission for
-- a payment = payment.amount * the salesperson's commission_pct. This sidecar
-- records WHEN that commission was paid out to the rep and the exact amount paid,
-- so the Commission tab can show a pay-period ledger ("what went out on this pay
-- period") and a carry-forward queue of earned-but-unpaid commission.
--
-- A payment is PENDING when it has no row here; PAID when it has one. The amount
-- is frozen at payout time so a later commission_pct change never rewrites paid
-- history. Kept OUT of the insert-only pec_payments ledger on purpose.
--
-- RLS: any admin staff may READ (so reps with can_view_commission can see their
-- own coming commission); only an admin ROLE may WRITE (office manager marks
-- payouts). Reuses public.is_admin_staff(), public.is_admin_role(), and the
-- shared touch trigger public.pec_prod_touch_updated_at().

create table if not exists public.pec_commission_payouts (
  payment_id uuid primary key references public.pec_payments(id) on delete cascade,
  amount     numeric(12,2) not null,   -- commission actually paid for this payment (frozen at payout)
  paid_on    date not null,            -- the pay-period date it went out
  paid_by    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pec_commission_payouts enable row level security;

drop policy if exists cp_select on public.pec_commission_payouts;
create policy cp_select on public.pec_commission_payouts for select
  using (public.is_admin_staff());

drop policy if exists cp_write on public.pec_commission_payouts;
create policy cp_write on public.pec_commission_payouts for all
  using (public.is_admin_role()) with check (public.is_admin_role());

create index if not exists cp_paid_on_idx on public.pec_commission_payouts (paid_on);

drop trigger if exists trg_pec_commission_payouts_touch on public.pec_commission_payouts;
create trigger trg_pec_commission_payouts_touch before update on public.pec_commission_payouts
  for each row execute function public.pec_prod_touch_updated_at();
