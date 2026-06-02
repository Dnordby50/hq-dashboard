-- ============================================================================
-- B-012 / B-013 / B-008: price reconciliation + divergence audit
-- ============================================================================
-- Author: Claude Code (2026-06-02). RUN BY COWORK (no DB access in this session).
--
-- SCHEMA NOTE / divergence from the Phase 1 prompt: the prompt asked to audit
-- "jobs.price vs (SELECT SUM(line_price) FROM job_lines WHERE job_id = jobs.id)".
-- There is NO job_lines table and NO line_price column anywhere in this schema
-- (verified against supabase/schema.sql + all migrations on 2026-06-02). The
-- value the Schedule and Job Costing views actually show for these rows is
-- public.pec_prod_jobs.revenue, NOT a line-item sum. So the real divergence is
-- public.jobs.price  vs  public.pec_prod_jobs.revenue for the SAME job. This
-- script audits that. (Per-line costing lives in pec_prod_material_lines /
-- job_area_materials, but those drive material cost, not the headline price the
-- eval flagged.)
--
-- The two tables are linked by:
--   * DripJobs jobs: public.jobs.dripjobs_deal_id = pec_prod_jobs.dripjobs_deal_id
--   * Manual jobs:   pec_prod_jobs.customer_id = public.jobs.customer_id
--     (the "+ New Job" bridge sets pec_prod_jobs.customer_id). This is a
--     HEURISTIC: a customer with multiple jobs can match multiple prod rows, so
--     treat manual-row matches as candidates to eyeball, not gospel.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- SECTION A (B-012): Stephen Prescott ZIP-leak ($86,301 == ZIP 86301)
--   Costing reads pec_prod_jobs.revenue; the bad value is on the MANUAL- prod
--   row, proposal MANUAL-20260528-041812-SX9U. Jobs view shows the real $3,555.
-- ----------------------------------------------------------------------------

-- A1. Inspect the offending prod row + the matching public.jobs price.
SELECT p.id::text, p.customer_name, p.proposal_number, p.address,
       p.revenue AS prod_revenue,
       j.id::text AS public_job_id, j.price AS jobs_price
FROM public.pec_prod_jobs p
LEFT JOIN public.jobs j ON j.customer_id = p.customer_id
WHERE p.proposal_number = 'MANUAL-20260528-041812-SX9U';
-- Confirm: prod_revenue = 86301 (the ZIP), jobs_price = 3555 (the real price),
-- and p.address contains "86301". That confirms a manual-entry fat-finger
-- (cause "c" in the prompt): the ZIP was typed into the revenue field. There is
-- no automatic zip->price fallback in the code (causes "a"/"b" ruled out), so
-- this is a one-row DATA fix, not a read-path fix.

-- A2. FIX: set the prod revenue to the real price. Verify A1 first; if the real
--     price is not exactly 3555, use the value from jobs_price in A1.
-- UPDATE public.pec_prod_jobs
--   SET revenue = 3555
--   WHERE proposal_number = 'MANUAL-20260528-041812-SX9U' AND revenue = 86301;


-- ----------------------------------------------------------------------------
-- SECTION B (B-013): full divergence audit, jobs.price vs prod revenue
--   Read-only. Lists every active job where the two numbers disagree, worst
--   first. Cindy Schubert and Robert Waxler should appear here (Jobs $0 vs
--   ~$2,633 / ~$4,703). Report the full list back to Dylan.
-- ----------------------------------------------------------------------------
SELECT
  j.id::text             AS public_job_id,
  c.name                 AS customer,
  j.status               AS jobs_status,
  j.price                AS jobs_price,
  p.revenue              AS prod_revenue,
  (COALESCE(p.revenue,0) - COALESCE(j.price,0)) AS delta,
  p.proposal_number,
  CASE WHEN j.dripjobs_deal_id IS NOT NULL THEN 'deal_id' ELSE 'customer_id(heuristic)' END AS matched_on
FROM public.jobs j
JOIN public.customers c ON c.id = j.customer_id
LEFT JOIN public.pec_prod_jobs p
  ON (j.dripjobs_deal_id IS NOT NULL AND p.dripjobs_deal_id = j.dripjobs_deal_id)
  OR (j.dripjobs_deal_id IS NULL     AND p.customer_id      = j.customer_id)
WHERE j.archived_at IS NULL
  AND p.id IS NOT NULL
  AND COALESCE(j.price,0) <> COALESCE(p.revenue,0)
ORDER BY ABS(COALESCE(p.revenue,0) - COALESCE(j.price,0)) DESC;


-- ----------------------------------------------------------------------------
-- SECTION C (B-008 + B-013): reconcile the obvious $0 jobs.price rows
--   For Cindy Schubert / Robert Waxler (and any row in SECTION B where
--   jobs_price = 0 and prod_revenue is a real number), the prod revenue is the
--   truth and jobs.price is stale. Push the real price onto public.jobs.
--   Run SECTION B first; only auto-fix the clear "jobs_price = 0, prod_revenue
--   > 0" rows. Anything where BOTH are non-zero-but-different is a judgment call
--   for Dylan, not an auto-update.
-- ----------------------------------------------------------------------------

-- C1. Preview exactly what C2 would change (the safe subset):
SELECT j.id::text AS public_job_id, c.name, j.price AS old_price, p.revenue AS new_price
FROM public.jobs j
JOIN public.customers c ON c.id = j.customer_id
JOIN public.pec_prod_jobs p
  ON (j.dripjobs_deal_id IS NOT NULL AND p.dripjobs_deal_id = j.dripjobs_deal_id)
  OR (j.dripjobs_deal_id IS NULL     AND p.customer_id      = j.customer_id)
WHERE j.archived_at IS NULL
  AND COALESCE(j.price,0) = 0
  AND p.revenue IS NOT NULL AND p.revenue > 0;

-- C2. APPLY (only after C1 looks correct and after the B-016 dedupe has removed
--     the ghost rows, so a customer_id heuristic match is unambiguous):
-- UPDATE public.jobs j
--   SET price = p.revenue
--   FROM public.pec_prod_jobs p
--   WHERE j.archived_at IS NULL
--     AND COALESCE(j.price,0) = 0
--     AND p.revenue IS NOT NULL AND p.revenue > 0
--     AND ( (j.dripjobs_deal_id IS NOT NULL AND p.dripjobs_deal_id = j.dripjobs_deal_id)
--        OR (j.dripjobs_deal_id IS NULL     AND p.customer_id      = j.customer_id) );

-- C3. After A2 + C2 + the B-016 dedupe, run the VALIDATE block in
--     supabase/migrations/2026-06-02_price_integrity.sql to lock the guards in.
