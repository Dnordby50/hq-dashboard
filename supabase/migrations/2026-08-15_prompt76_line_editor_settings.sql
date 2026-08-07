-- @artifacts
--   setting: estimate_line_generate_enabled
--   setting: estimator_line_sheet_breakpoint_px
-- @end
--
-- Prompt 76: the estimator's per-line editor (bottom sheet) tunables, per
-- standing rule 12. No schema changes: the editable per-line description
-- rides the EXISTING estimate_line_items.description column (prompt 74's
-- passthrough plumbing), so this migration is settings seeds only.
--
-- estimate_line_generate_enabled: the ONE "Generate with AI" button in the
--   line editor (writes templated scope / polishes typed text). Off hides
--   the button everywhere in the estimator (line sheet, add-on sheet, and
--   custom mode) while typed descriptions keep working.
-- estimator_line_sheet_breakpoint_px: below this viewport width the line
--   editor opens as a full-height bottom sheet (phone in the driveway);
--   at or above it, a centered window.
--
-- Defaults here MUST match the estimator's catalog.ts and the Settings >
-- Estimates renderer: true / 700. The code falls back the same way when a
-- row is missing, so pre-migration behavior is identical.

BEGIN;

INSERT INTO public.settings (key, value)
SELECT k, v FROM (VALUES
  ('estimate_line_generate_enabled',     'true'),
  ('estimator_line_sheet_breakpoint_px', '700')
) AS seed(k, v)
WHERE NOT EXISTS (SELECT 1 FROM public.settings s WHERE s.key = seed.k);

COMMIT;

-- Verify after running:
--   select key, value from public.settings
--    where key in ('estimate_line_generate_enabled', 'estimator_line_sheet_breakpoint_px');
