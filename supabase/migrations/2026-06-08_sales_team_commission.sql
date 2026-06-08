-- Per-salesperson commission percentage.
-- Set in Settings (admin only) and used by the Commission tab to compute
-- commission = commission_pct% * revenue COLLECTED (sum of pec_payments.amount
-- attributed to the job's salesperson) over a date range. Commission is only
-- ever on money actually received, never on the contract/sold price.
--
-- RLS: pec_sales_team_members already has the is_admin_staff() for-all policy
-- (2026-05-24_sales_team_members.sql), so this column inherits it. No new policy.

alter table public.pec_sales_team_members
  add column if not exists commission_pct numeric(5,2) not null default 0;

-- Seed Aron at 6% (Dylan's number). Safe no-op if the row isn't present yet.
update public.pec_sales_team_members
   set commission_pct = 6
 where lower(name) = 'aron';
