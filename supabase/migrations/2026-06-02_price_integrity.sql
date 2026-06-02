-- ============================================================================
-- B-012 + B-008: write-time price integrity constraints
-- ============================================================================
-- Author: Claude Code (2026-06-02). RUN BY COWORK on the PEC Supabase project
-- (zdfpzmmrgotynrwkeakd, Primary DB, postgres role). Idempotent.
--
-- Two guards, added to BOTH job tables (public.jobs.price for the Jobs page;
-- public.pec_prod_jobs.revenue for Schedule/Costing):
--   1. price/revenue must be within a sane range (0 .. 100000). Catches gross
--      errors like a phone number or a digit-fat-finger landing in the money
--      column.
--   2. a job in status 'scheduled' must have a non-zero price/revenue (B-008:
--      Cindy Schubert / Robert Waxler were SCHEDULED at $0).
--
-- IMPORTANT (honest limitation): the range ceiling does NOT by itself fix the
-- B-012 ZIP leak. ZIP 86301 (= the bad value) is < 100000, so a row carrying
-- the ZIP in the money column still passes the range check. The actual B-012
-- row is corrected as DATA in scripts/migrations/2026-06-02_b012_b013_price_reconcile_audit.sql.
-- This constraint is the cheap structural backstop the eval asked for; the real
-- decoupling of price from address is Phase 2 (the jobs_full canonical view).
--
-- Added as NOT VALID so pre-existing out-of-range / scheduled-at-zero rows do
-- NOT block the migration. NOT VALID still enforces the check on every INSERT
-- and UPDATE from now on; it just skips the one-time scan of existing rows.
-- After the data reconciliation + dedupe scripts have run, VALIDATE the
-- constraints (uncomment SECTION C) to confirm no bad rows remain.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- SECTION A: public.jobs
-- ----------------------------------------------------------------------------
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_price_in_range;
ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_price_in_range
  CHECK (price IS NULL OR (price >= 0 AND price <= 100000))
  NOT VALID;

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_scheduled_needs_price;
ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_scheduled_needs_price
  CHECK (status <> 'scheduled' OR (price IS NOT NULL AND price > 0))
  NOT VALID;


-- ----------------------------------------------------------------------------
-- SECTION B: public.pec_prod_jobs  (Schedule/Costing revenue)
--   Note: pec_prod_jobs.status uses 'scheduled' as well (check constraint:
--   unscheduled/scheduled/ordered/delivered/completed).
-- ----------------------------------------------------------------------------
ALTER TABLE public.pec_prod_jobs DROP CONSTRAINT IF EXISTS pec_prod_jobs_revenue_in_range;
ALTER TABLE public.pec_prod_jobs
  ADD CONSTRAINT pec_prod_jobs_revenue_in_range
  CHECK (revenue IS NULL OR (revenue >= 0 AND revenue <= 100000))
  NOT VALID;

ALTER TABLE public.pec_prod_jobs DROP CONSTRAINT IF EXISTS pec_prod_jobs_scheduled_needs_revenue;
ALTER TABLE public.pec_prod_jobs
  ADD CONSTRAINT pec_prod_jobs_scheduled_needs_revenue
  CHECK (status <> 'scheduled' OR (revenue IS NOT NULL AND revenue > 0))
  NOT VALID;


-- ----------------------------------------------------------------------------
-- SECTION C: VALIDATE (run only AFTER the B-012/B-013 reconcile + B-016 dedupe
--   scripts have cleaned the existing rows; each VALIDATE errors and names the
--   first offending row if any bad data remains, which is a useful audit).
-- ----------------------------------------------------------------------------
-- ALTER TABLE public.jobs          VALIDATE CONSTRAINT jobs_price_in_range;
-- ALTER TABLE public.jobs          VALIDATE CONSTRAINT jobs_scheduled_needs_price;
-- ALTER TABLE public.pec_prod_jobs VALIDATE CONSTRAINT pec_prod_jobs_revenue_in_range;
-- ALTER TABLE public.pec_prod_jobs VALIDATE CONSTRAINT pec_prod_jobs_scheduled_needs_revenue;
