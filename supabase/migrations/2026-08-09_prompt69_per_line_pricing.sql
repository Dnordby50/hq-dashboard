-- @artifacts
--   column: public.estimate_areas.is_custom
--   column: public.estimate_areas.custom_label
--   column: public.estimate_areas.custom_scope
--   column: public.estimate_areas.custom_material_cost
--   column: public.estimate_areas.custom_labor_hours
--   column: public.estimate_areas.notes
--   column: public.estimate_areas.calc_price
--   column: public.estimate_areas.price_override
--   setting: line_pricing_gp_floor_pct
--   setting: line_pricing_block_below_floor
--   setting: line_pricing_custom_label_default
--   setting: line_pricing_reason_threshold_pct
--   setting: line_pricing_reason_threshold_dollars
-- @end

-- Prompt 69: per-line pricing and custom lines inside a normal estimate.
-- WHY: an estimate_areas row becomes the ONE line unit. A calculator area now
-- carries its own solved cost-plus price (calc_price) and an optional rep-typed
-- price (price_override); a CUSTOM line is an area row with is_custom=true, a
-- typed label/scope, a typed material cost and typed labor hours (so its GP is
-- computed the same way every other line is and its hours are real for
-- scheduling), and its typed price stored in price_override (calc_price stays
-- null: nothing was calculated). notes is INTERNAL per-line context fed to
-- scope generation, never customer-facing.
--
-- Forward-only, NO backfill (locked decision 10, the prompt-56 lesson):
-- every column is nullable (or defaulted false), so existing estimates keep
-- their stored line amounts and render exactly as they do today.

BEGIN;

ALTER TABLE estimate_areas ADD COLUMN IF NOT EXISTS is_custom boolean NOT NULL DEFAULT false;
ALTER TABLE estimate_areas ADD COLUMN IF NOT EXISTS custom_label text;
ALTER TABLE estimate_areas ADD COLUMN IF NOT EXISTS custom_scope text;
ALTER TABLE estimate_areas ADD COLUMN IF NOT EXISTS custom_material_cost numeric;
ALTER TABLE estimate_areas ADD COLUMN IF NOT EXISTS custom_labor_hours numeric;
ALTER TABLE estimate_areas ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE estimate_areas ADD COLUMN IF NOT EXISTS calc_price numeric;
ALTER TABLE estimate_areas ADD COLUMN IF NOT EXISTS price_override numeric;

-- Settings (rule 12): the Line pricing card's knobs. line_pricing_gp_floor_pct
-- seeds from the EXISTING estimator floor so behavior is unchanged on day one;
-- the code default when the row is missing is the same fallback chain
-- (line_pricing_gp_floor_pct -> estimator_floor_gp_pct -> 40).
INSERT INTO public.settings (key, value)
SELECT 'line_pricing_gp_floor_pct',
       COALESCE((SELECT s.value FROM public.settings s WHERE s.key = 'estimator_floor_gp_pct'), '40')
WHERE NOT EXISTS (SELECT 1 FROM public.settings s WHERE s.key = 'line_pricing_gp_floor_pct');

INSERT INTO public.settings (key, value)
SELECT k, v FROM (VALUES
  ('line_pricing_block_below_floor',        'false'),
  ('line_pricing_custom_label_default',     'Custom work'),
  ('line_pricing_reason_threshold_pct',     '2'),
  ('line_pricing_reason_threshold_dollars', '100')
) AS seed(k, v)
WHERE NOT EXISTS (SELECT 1 FROM public.settings s WHERE s.key = seed.k);

COMMIT;

-- Verify after running:
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_name = 'estimate_areas' and column_name in
--          ('is_custom','custom_label','custom_scope','custom_material_cost',
--           'custom_labor_hours','notes','calc_price','price_override');
--   select key, value from public.settings where key like 'line_pricing%' order by key;
