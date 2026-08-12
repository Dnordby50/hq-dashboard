-- @artifacts
--   setting: accept_celebration_enabled
-- @end
-- ============================================================================
-- 2026-08-23: on/off for the staff-dashboard accept celebration (prompt 87
-- Task B). Author: Claude Code. Idempotent. Data-only.
--
-- WHY: when an estimate is accepted, every open staff dashboard fires a
-- confetti burst + toast (and the next open catches up on acceptances nobody
-- saw). Rule 12: the feature's one front-of-card control is this switch, in
-- Settings > Estimates. Missing row = ON, matching the reader's default in
-- pecStartRevokedLoginWatch / pecAcceptCelebrationCheck. The per-browser
-- celebrated high-water mark lives in localStorage and is state, not a
-- setting, per rule 12's state clause.
-- ============================================================================

insert into public.settings (key, value) values
  ('accept_celebration_enabled', 'true')
on conflict (key) do nothing;
