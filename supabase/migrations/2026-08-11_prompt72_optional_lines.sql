-- @artifacts
--   column: public.estimate_areas.is_optional
--   column: public.estimate_areas.preselected
--   column: public.estimates.price_all_options
--   setting: optional_lines_enabled
--   setting: optional_lines_preselect_default
--   setting: optional_lines_gp_warn_pct
-- @end
--
-- Prompt 72: optional line items on ANY line (calculator areas and custom
-- lines, not just add-ons).
-- WHY estimate_areas carries the flag: the estimator reloads areas by
-- POSITION and never selects area ids (estimateLoad.ts), so the rep's
-- optional/preselected choices must live on the area row and be MIRRORED onto
-- the matching estimate_line_items row at save time. The public page and
-- every downstream read keep using estimate_line_items.is_optional /
-- selected_by_customer exactly as today.
-- preselected: whether an optional line starts TICKED for the customer
-- (opt-out; Dylan's decision 3). Ignored while is_optional is false. Add-ons
-- are unaffected and keep their opt-in (unticked) behavior.
-- estimates.price_all_options: the ceiling (every line at full value);
-- estimates.price becomes the required-only floor while the estimate is open
-- and the signed total after acceptance (decision 7).
--
-- Forward-only, NO backfill: every pre-72 row reads is_optional=false /
-- preselected=true (irrelevant while not optional) and renders exactly as
-- it does today.

BEGIN;

ALTER TABLE estimate_areas ADD COLUMN IF NOT EXISTS is_optional boolean NOT NULL DEFAULT false;
ALTER TABLE estimate_areas ADD COLUMN IF NOT EXISTS preselected boolean NOT NULL DEFAULT true;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS price_all_options numeric;

-- Settings (rule 12), Settings > Estimates > Optional lines.
-- optional_lines_gp_warn_pct seeds from the LIVE line-pricing GP floor so the
-- decision-8 warning threshold starts where the floor already is; the code
-- default when the row is missing is the same fallback chain.
INSERT INTO public.settings (key, value)
SELECT 'optional_lines_gp_warn_pct',
       COALESCE((SELECT s.value FROM public.settings s WHERE s.key = 'line_pricing_gp_floor_pct'), '40')
WHERE NOT EXISTS (SELECT 1 FROM public.settings s WHERE s.key = 'optional_lines_gp_warn_pct');

INSERT INTO public.settings (key, value)
SELECT k, v FROM (VALUES
  ('optional_lines_enabled',           'true'),
  ('optional_lines_preselect_default', 'true')
) AS seed(k, v)
WHERE NOT EXISTS (SELECT 1 FROM public.settings s WHERE s.key = seed.k);

COMMIT;

-- Verify after running:
--   select column_name, is_nullable, column_default from information_schema.columns
--    where (table_name='estimate_areas' and column_name in ('is_optional','preselected'))
--       or (table_name='estimates' and column_name='price_all_options');
--   select key, value from public.settings where key like 'optional_lines%' order by key;
