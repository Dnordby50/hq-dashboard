-- ============================================================================
-- 2026-05-28: allow 'card' as a pec_payments.method (manually-recorded credit card)
-- ============================================================================
-- The Invoicing payment modal now offers a "Credit card" option for cards run
-- manually (terminal / keyed), distinct from 'stripe' (which is reserved for the
-- Phase 2 Stripe Checkout webhook). Extend the method CHECK constraint set first
-- defined in 2026-05-27_invoicing_ar.sql.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

begin;

alter table public.pec_payments drop constraint if exists pec_payments_method_check;
alter table public.pec_payments
  add constraint pec_payments_method_check
  check (method in ('stripe','check','cash','zelle','card'));

commit;

-- Verify after running:
--   select pg_get_constraintdef(oid) from pg_constraint
--     where conrelid='public.pec_payments'::regclass and conname='pec_payments_method_check';
--   -- expect: CHECK (method = ANY (ARRAY['stripe','check','cash','zelle','card']))
