-- Crew notes (prompt 32, Part B): a short INTERNAL crew brief (cliff notes +
-- watch-outs), separate from the customer-facing scope. Typed or AI-drafted on
-- the estimator, carried to the job on accept, editable on the job page, and
-- printed ONLY on the crew work order. It must never render on any customer
-- surface (proposal page, customer PDF, portal).
-- Additive and idempotent: safe to re-run.

ALTER TABLE public.estimates ADD COLUMN IF NOT EXISTS crew_notes text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS crew_notes text;

COMMENT ON COLUMN public.estimates.crew_notes IS
  'Internal crew brief (cliff notes / watch-outs) typed or AI-drafted on the estimator. Copied to jobs.crew_notes on accept. Never customer-facing.';
COMMENT ON COLUMN public.jobs.crew_notes IS
  'Internal crew brief printed on the crew work order only. Editable on the job page (Job Card block). Never customer-facing.';

-- Verify:
--   select table_name, column_name from information_schema.columns
--   where table_schema = 'public' and column_name = 'crew_notes'
--     and table_name in ('estimates', 'jobs');
