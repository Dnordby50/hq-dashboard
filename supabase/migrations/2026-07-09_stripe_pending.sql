-- ============================================================================
-- 2026-07-09: pec_stripe_pending, the ACH async-settlement marker (prompt 11).
-- Author: Claude Code. RUN BY COWORK on the PROD Supabase project. Idempotent.
-- NOT applied to prod from the Claude Code session.
--
-- Why: ACH settles in 3 to 5 business days. Stripe completes the checkout
-- session as 'unpaid', then fires checkout.session.async_payment_succeeded (or
-- _failed) days later. A pending ACH is recorded HERE as a marker, never as a
-- pec_payments row; the payment row is inserted only at settlement, so paid_to_
-- date, deposit flips, and commission all move on real money only. Invoicing
-- reads this table for the "ACH pending $X" and red "ACH failed" chips, and
-- the public pay page reads it to show the amber processing banner instead of
-- the green paid banner after an ACH checkout redirect.
--
-- Trust model mirrors pec_call_log (2026-07-06_quo_call_log.sql) exactly:
-- staff can READ, there is NO client write policy, and only the service-role
-- webhook (pec-stripe-webhook.cjs) writes rows.
-- ============================================================================

begin;

create table if not exists public.pec_stripe_pending (
  id              uuid primary key default gen_random_uuid(),
  payment_intent  text not null unique,     -- Stripe PaymentIntent id; the idempotency key
  job_id          uuid not null,            -- public.jobs id (pec_job_ar.id), same key pec_payments uses
  kind            text,                     -- 'deposit' | 'balance' | 'custom' (from checkout metadata)
  amount          numeric not null,
  status          text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  failure_message text,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz               -- set when the pending state ends (settled OR failed)
);

create index if not exists idx_pec_stripe_pending_job on public.pec_stripe_pending (job_id, status);

alter table public.pec_stripe_pending enable row level security;

-- Staff READ only; no client write policy (service-role webhook writes).
drop policy if exists pec_stripe_pending_read on public.pec_stripe_pending;
create policy pec_stripe_pending_read on public.pec_stripe_pending for select
  using (public.is_admin_staff());

commit;

-- ============================================================================
-- Verify after running (Cowork: capture the outputs in your log entry):
--
-- a) Table exists:
--   select count(*) from information_schema.tables
--     where table_schema='public' and table_name='pec_stripe_pending';        -- 1
--
-- b) Unique constraint on payment_intent:
--   select pg_get_constraintdef(oid) from pg_constraint
--     where conrelid='public.pec_stripe_pending'::regclass and contype='u';   -- UNIQUE (payment_intent)
--
-- c) RLS on, exactly one policy, SELECT only, no client write policy:
--   select relrowsecurity from pg_class where relname='pec_stripe_pending';   -- t
--   select policyname, cmd from pg_policies
--     where tablename='pec_stripe_pending';                                   -- 1 row, SELECT
--
-- d) Status check constraint present:
--   select pg_get_constraintdef(oid) from pg_constraint
--     where conrelid='public.pec_stripe_pending'::regclass and contype='c';   -- status in (...)
-- ============================================================================
