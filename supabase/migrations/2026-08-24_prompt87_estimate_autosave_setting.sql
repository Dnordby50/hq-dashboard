-- @artifacts
--   setting: estimate_autosave_enabled
-- @end
-- ============================================================================
-- 2026-08-24: on/off for the estimator's autosave (prompt 87 Task D).
-- Author: Claude Code. Idempotent. Data-only.
--
-- WHY: the estimator now autosaves (debounced 2.5s + flush on tab-hide/close),
-- and rule 12 wants the feature killable without a code change. Deliberately
-- the feature's ONLY knob, behind the Advanced disclosure in Settings >
-- Estimates: autosave should just work, and the debounce interval is not
-- worth a control. Missing row = ON, matching catalog.ts's default.
-- ============================================================================

insert into public.settings (key, value) values
  ('estimate_autosave_enabled', 'true')
on conflict (key) do nothing;
