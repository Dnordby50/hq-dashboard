-- @artifacts
--   setting: security_alerts_enabled
--   setting: security_alerts_lookback_min
-- @end
-- ============================================================================
-- 2026-07-25: settings knobs for the scheduled security monitor
-- (netlify/functions/pec-security-monitor.cjs). Standing rule 12: every feature's
-- key parameters live in the settings table, tunable with no code change.
--   security_alerts_enabled     : master on/off for new-location sign-in alerts.
--   security_alerts_lookback_min: how far back each 15-min run scans sign_in_log
--                                 (keep >= the schedule interval so none are missed).
-- Idempotent: existing values are left untouched.
-- ============================================================================
insert into public.settings (key, value) values
  ('security_alerts_enabled', 'true'),
  ('security_alerts_lookback_min', '20')
on conflict (key) do nothing;
