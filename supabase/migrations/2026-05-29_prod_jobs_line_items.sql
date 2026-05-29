-- ============================================================================
-- 2026-05-29: add line_items JSONB to pec_prod_jobs
-- ============================================================================
-- The manual "Add Job" modal now lets the user paste a job's line items
-- (description + price each) copied from a DripJobs proposal; their prices sum
-- to the job total written to pec_prod_jobs.revenue. This column persists the
-- breakdown alongside the summed revenue.
--
-- Shape mirrors public.jobs.line_items (a JSONB array): each element is
--   { "name": "<description>", "price": <number> }
-- (simpler than the invoice line_items shape, which also carries qty/tax/total).
-- Nullable; existing rows and webhook-sourced jobs simply leave it null.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

begin;

alter table public.pec_prod_jobs add column if not exists line_items jsonb;

commit;

-- Verify after running:
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'pec_prod_jobs'
--      and column_name = 'line_items';
--   -- expect one row: line_items | jsonb
