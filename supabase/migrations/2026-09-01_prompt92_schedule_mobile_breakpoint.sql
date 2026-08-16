-- @artifacts
--   setting: schedule_mobile_breakpoint_px
-- @end
-- ============================================================================
-- 2026-09-01: mobile Job Schedule calendar breakpoint (prompt 92 Task A).
-- Author: Claude Code. Idempotent. Data-only: direct to prod per standing
-- rule 14 (no money, no auth).
--
-- WHY: prompt 92 replaces the phone 21-day card list with a one-week swipe
-- grid. The width below which that grid is used was hardcoded 720; rule 12
-- says layout thresholds are tunable without a code change (the
-- settings_rail_breakpoint_px / estimator_line_sheet_breakpoint_px pattern).
-- Missing row = 720, matching the reader's fallback. The week START day is
-- deliberately NOT a setting: the desktop calendar hardcodes Sunday
-- (startOfWeek, prompt 58) and the phone grid follows the same convention.
-- ============================================================================

insert into public.settings (key, value) values
  ('schedule_mobile_breakpoint_px', '720')
on conflict (key) do nothing;

-- Verify:
--   select value from settings where key = 'schedule_mobile_breakpoint_px';  -- '720'
