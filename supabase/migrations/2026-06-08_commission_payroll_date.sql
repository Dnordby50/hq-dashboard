-- Friday payroll/check date for commission payouts.
--
-- Commission is paid out weekly on a Friday check. This records, per payout, the
-- Friday payroll date it correlates to, so the Commission tab's Payroll report can
-- group "which jobs paid out on this check". The app defaults it to the Friday on
-- or after the pay-out date and lets an admin override it.
--
-- Non-destructive: adds one nullable column + an index. Existing payout rows keep a
-- null payroll_date and the report buckets them under "No check date assigned" (it
-- never hides them). Reuses the existing RLS on pec_commission_payouts (admin staff
-- read, admin role write), so no policy change is needed.

alter table public.pec_commission_payouts
  add column if not exists payroll_date date;

create index if not exists cp_payroll_date_idx
  on public.pec_commission_payouts (payroll_date);
