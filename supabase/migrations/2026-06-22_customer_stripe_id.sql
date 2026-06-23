-- ============================================================================
-- 2026-06-22: store the Stripe Customer id on public.customers.
-- Author: Claude Code. RUN BY COWORK on PROD. Idempotent.
--
-- Why: the Stripe Checkout flow (pec-stripe-checkout.cjs) now pre-creates or
-- reuses a Stripe Customer (name + email) and passes `customer` to the session,
-- so payments land in Stripe's dedicated Customer column and one Customer record
-- is reused across a customer's payments (instead of a new ad-hoc Customer per
-- charge). This column caches that Stripe Customer id per public.customers row so
-- the function looks it up once and reuses it. Written by the service-role
-- function; nullable (only set after the first card payment for that customer).
-- ============================================================================

alter table public.customers
  add column if not exists stripe_customer_id text;

-- Verify:
--   select column_name from information_schema.columns
--     where table_name='customers' and column_name='stripe_customer_id';  -- 1 row
