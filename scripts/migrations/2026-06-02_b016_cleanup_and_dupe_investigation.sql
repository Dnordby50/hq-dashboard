-- ============================================================================
-- B-016: remove test/placeholder data from production + investigate duplicates
-- ============================================================================
-- Author: Claude Code (2026-06-02). RUN BY COWORK on the PEC Supabase project
-- (zdfpzmmrgotynrwkeakd, Primary DB, postgres role). This Claude Code session
-- has NO direct DB access, so the destructive steps are written as explicit,
-- guarded SQL with verification SELECTs around them. Read every section before
-- running it; sections C and D are INVESTIGATIONS that need a human decision.
--
-- Schema facts this script relies on (verified against supabase/schema.sql +
-- supabase/migrations on 2026-06-02):
--   * public.jobs.customer_id  -> references public.customers ON DELETE CASCADE
--     (deleting a customer deletes that customer's public.jobs rows).
--   * public.pec_prod_jobs.customer_id -> references public.customers
--     ON DELETE SET NULL (deleting a customer does NOT delete the prod row; it
--     nulls the link). So prod rows must be deleted EXPLICITLY, before/around
--     the customer delete, by id / customer_name / proposal_number.
--   * public.pec_prod_areas.job_id -> pec_prod_jobs ON DELETE CASCADE
--     (deleting a prod job deletes its areas automatically).
--   * pec_prod_jobs.proposal_number is text UNIQUE NOT NULL.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- SECTION A: hard-delete the "ZZZ TEST DELETE ME" customer + all of its jobs
--   Customer id (from the eval): e3562d70-c06b-4303-8a6f-e0ccc86eecd6
-- ----------------------------------------------------------------------------

-- A1. PRE-CHECK: confirm the customer and see what hangs off it before deleting.
SELECT 'customer' AS kind, id::text, name, company, archived_at
FROM public.customers
WHERE id = 'e3562d70-c06b-4303-8a6f-e0ccc86eecd6'
UNION ALL
SELECT 'public.jobs', id::text, status, type, price::text
FROM public.jobs
WHERE customer_id = 'e3562d70-c06b-4303-8a6f-e0ccc86eecd6'
UNION ALL
SELECT 'pec_prod_jobs', id::text, customer_name, proposal_number, revenue::text
FROM public.pec_prod_jobs
WHERE customer_id = 'e3562d70-c06b-4303-8a6f-e0ccc86eecd6'
   OR customer_name = 'ZZZ TEST DELETE ME';

-- A2. DELETE (run only after A1 looks right). One transaction.
BEGIN;
  -- prod rows first (ON DELETE SET NULL would otherwise orphan them). Match by
  -- the link AND by the literal test name so a bridged row with a nulled link
  -- is still caught. pec_prod_areas cascade-delete with the job.
  DELETE FROM public.pec_prod_jobs
  WHERE customer_id = 'e3562d70-c06b-4303-8a6f-e0ccc86eecd6'
     OR customer_name = 'ZZZ TEST DELETE ME';

  -- the customer; public.jobs rows cascade-delete with it.
  DELETE FROM public.customers
  WHERE id = 'e3562d70-c06b-4303-8a6f-e0ccc86eecd6';
COMMIT;

-- A3. POST-CHECK: all three of these must return 0 rows.
SELECT count(*) AS leftover_customer  FROM public.customers     WHERE id = 'e3562d70-c06b-4303-8a6f-e0ccc86eecd6';
SELECT count(*) AS leftover_jobs      FROM public.jobs          WHERE customer_id = 'e3562d70-c06b-4303-8a6f-e0ccc86eecd6';
SELECT count(*) AS leftover_prod_jobs FROM public.pec_prod_jobs WHERE customer_name = 'ZZZ TEST DELETE ME';


-- ----------------------------------------------------------------------------
-- SECTION B: delete the "Jones / #1234 / Flake / 400 sqft" placeholder job
--   Appears in Ordering AND Costing, so it is a public.pec_prod_jobs row.
-- ----------------------------------------------------------------------------

-- B1. PRE-CHECK: identify the placeholder. Confirm this returns ONLY the dummy
--     row (no real customer named Jones) before running B2.
SELECT id::text, customer_name, proposal_number, address, revenue, status, created_at
FROM public.pec_prod_jobs
WHERE customer_name ILIKE 'Jones%'
   OR proposal_number = '1234'
   OR proposal_number ILIKE '%1234%';
-- Also check public.jobs in case a sibling row exists there:
SELECT j.id::text, c.name, j.address, j.price, j.status
FROM public.jobs j JOIN public.customers c ON c.id = j.customer_id
WHERE c.name ILIKE 'Jones%';

-- B2. DELETE (run only after B1 confirms the single placeholder row). Tighten
--     the WHERE to the exact id from B1 if there is any doubt. pec_prod_areas
--     cascade with the job.
-- DELETE FROM public.pec_prod_jobs
-- WHERE id = '<paste the placeholder id from B1>';


-- ----------------------------------------------------------------------------
-- SECTION C: INVESTIGATE the duplicate Greg Gutierrez rows
--   Address: 13995 N Thunderbird Rd, Prescott 86305
--   Eval: Jobs shows one SCHEDULED $4,345 and one SIGNED $0 (same created date);
--   Ordering shows two rows (MANUAL-...-A02T and MANUAL-...-E933).
--   DO NOT auto-delete. Decide root cause first, then delete only a clear dupe.
-- ----------------------------------------------------------------------------

-- C1. public.jobs side (the SCHEDULED $4,345 vs SIGNED $0 pair):
SELECT j.id::text, c.name, j.status, j.price, j.dripjobs_deal_id,
       j.source, j.created_at
FROM public.jobs j JOIN public.customers c ON c.id = j.customer_id
WHERE c.name ILIKE 'Greg%Gutierrez%'
   OR j.address ILIKE '%13995%Thunderbird%'
ORDER BY j.created_at;

-- C2. pec_prod_jobs side (the two Ordering rows -A02T / -E933):
SELECT id::text, customer_name, proposal_number, status, revenue,
       dripjobs_deal_id, customer_id::text, install_date, created_at
FROM public.pec_prod_jobs
WHERE customer_name ILIKE 'Greg%Gutierrez%'
   OR address ILIKE '%13995%Thunderbird%'
ORDER BY created_at;

-- C3. Root-cause read: if both pec_prod_jobs rows share the SAME
--     dripjobs_deal_id, the webhook double-fired before the dedupe guard
--     shipped (see PROJECT-LOG 2026-06-01 #7). If both deal_ids are NULL and
--     both are MANUAL-, it was a double manual entry. Report which.
--     Decision rule: keep the row with the real revenue / a real status
--     (SCHEDULED $4,345), delete the $0 SIGNED ghost. Templated, fill the id:
-- DELETE FROM public.jobs          WHERE id = '<the $0 SIGNED public.jobs id>';
-- DELETE FROM public.pec_prod_jobs WHERE id = '<the $0 / ghost prod-jobs id>';
--   If BOTH rows are real (two separate jobs at one address), delete nothing
--   and add a one-line note to PROJECT-LOG per the Phase 1 instructions.


-- ----------------------------------------------------------------------------
-- SECTION D: INVESTIGATE + merge the duplicate Robert Waxler CUSTOMER rows
--   Same name, two different UUIDs in the New Job dropdown. Pick the canonical
--   row, move its jobs onto it, delete the other. DO NOT delete before merging.
-- ----------------------------------------------------------------------------

-- D1. Find the two (or more) customer rows + how many jobs hang off each:
SELECT c.id::text, c.name, c.company, c.email, c.phone, c.archived_at, c.created_at,
       (SELECT count(*) FROM public.jobs          j WHERE j.customer_id = c.id) AS public_jobs,
       (SELECT count(*) FROM public.pec_prod_jobs p WHERE p.customer_id = c.id) AS prod_jobs
FROM public.customers c
WHERE c.name ILIKE 'Robert%Waxler%'
ORDER BY c.created_at;

-- D2. CANONICAL = the row with real contact info / the most jobs (usually the
--     older one). Define both ids, then merge in one transaction:
-- BEGIN;
--   UPDATE public.jobs
--     SET customer_id = '<CANONICAL customer id>'
--     WHERE customer_id = '<OTHER customer id>';
--   UPDATE public.pec_prod_jobs
--     SET customer_id = '<CANONICAL customer id>'
--     WHERE customer_id = '<OTHER customer id>';
--   DELETE FROM public.customers
--     WHERE id = '<OTHER customer id>';
-- COMMIT;

-- D3. POST-CHECK: one Robert Waxler customer row remains, all jobs attached.
-- SELECT count(*) FROM public.customers WHERE name ILIKE 'Robert%Waxler%';
