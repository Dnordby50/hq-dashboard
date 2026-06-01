-- ============================================================================
-- 2026-06-01: per-line price + detail on job_areas (areas = estimate lines)
-- ============================================================================
-- The job detail's "areas" and "line items" were merged into one Estimate
-- editor: each area is now an estimate line with its own price and a free-text
-- detail / scope of work. On save the UI derives jobs.line_items + jobs.price
-- from the areas (name + detail + price), so the invoice and work order keep
-- reading jobs.line_items unchanged.
--
-- This adds the two columns the per-line editor persists:
--   price       numeric(12,2) -- the line's price (sums to jobs.price)
--   description text          -- the line's detail / scope of work
-- (job_areas.name already exists and becomes the editable line name.)
--
-- Graceful pre-migration: the dashboard save retries the job_areas insert
-- WITHOUT these two fields if they don't exist yet (PostgREST PGRST204), so
-- saving still works before this runs -- the per-line price/detail just reload
-- empty until then (the price still lands on jobs.line_items meanwhile).
--
-- No view or RLS change: job_areas is already staff-edited (the job-save
-- delete+reinsert uses the same policy). Idempotent. Safe to re-run.
-- ============================================================================

begin;

alter table public.job_areas
  add column if not exists price numeric(12,2);

alter table public.job_areas
  add column if not exists description text;

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='job_areas'
--       and column_name in ('price','description');
--   -- expect 2 rows: price, description
