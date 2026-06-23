-- ============================================================================
-- 2026-06-22: Stripe payment idempotency hardening.
-- Author: Claude Code. RUN BY COWORK on PROD. Idempotent (if not exists).
--
-- Why: the Stripe webhook (pec-stripe-webhook.cjs) records an online card payment
-- as a pec_payments row whose `reference` holds the Stripe PaymentIntent id, and
-- dedupes by selecting on that reference before inserting. A partial UNIQUE index
-- closes the remaining race window (two concurrent webhook deliveries both
-- passing the select-before-insert): the second insert then fails with a unique
-- violation, which the webhook treats as "already recorded" (returns 200). This
-- is the hard guard for a money ledger.
--
-- Scoped to method='stripe' with a non-null reference so it never constrains
-- manual payments (check/cash/zelle), whose `reference` is free-text and may repeat.
--
-- No other schema change is needed: pec_payments.method already allows 'stripe'
-- (2026-05-28_payment_method_card.sql) and the pec_job_ar balance is derived from
-- sum(pec_payments.amount), so a recorded Stripe payment updates the balance with
-- no extra write.
-- ============================================================================

create unique index if not exists pec_payments_stripe_ref_uniq
  on public.pec_payments (reference)
  where method = 'stripe' and reference is not null;

-- Verify:
--   select indexname from pg_indexes where indexname = 'pec_payments_stripe_ref_uniq';  -- 1 row
