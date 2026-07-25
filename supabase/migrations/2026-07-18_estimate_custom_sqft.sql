-- @artifacts
--   column: public.estimates.custom_sqft
-- @end
-- Custom estimate square footage (prompt 32, Part A).
-- A custom estimate persists no area rows, so it has no sqft anywhere today
-- and every $/sqft readout shows "no sqft on file". This column holds the
-- typed square footage; on accept it is carried to public.jobs.sqft (which
-- already exists as TEXT and needs no migration).
-- Additive and idempotent: safe to re-run.

ALTER TABLE public.estimates ADD COLUMN IF NOT EXISTS custom_sqft numeric;

COMMENT ON COLUMN public.estimates.custom_sqft IS
  'Typed square footage for a CUSTOM estimate (is_custom = true). Standard estimates keep sqft on their estimate_areas rows and leave this null. Carried to jobs.sqft (as text) when the estimate is accepted.';

-- Verify:
--   select column_name, data_type from information_schema.columns
--   where table_schema = 'public' and table_name = 'estimates' and column_name = 'custom_sqft';
