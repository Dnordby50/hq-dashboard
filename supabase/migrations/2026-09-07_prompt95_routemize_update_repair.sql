-- @artifacts
--   setting: routemize_status_map
--   setting: ops_check_appt_intake
--   setting: ops_appt_intake_days
-- @end
-- ============================================================================
-- 2026-09-07: prompt 95, Routemize update repair settings. Author: Claude
-- Code. Applied to PROD via MCP. Idempotent. Data-only, additive (rule 14:
-- no money/auth/estimates.status touched, direct to prod).
--
-- WHY: pec-appt-intake now reads AppointmentUpdated's newStartTime/newEndTime
-- and its NUMERIC newStatus codes ("1" scheduled, "3" cancelled; the old
-- /cancel/i regex could never match a number). Rule 12: a new Routemize
-- status code must be a Settings edit, not a deploy, so the code map lives
-- here (surface: Settings > Appointments > Routemize booking intake >
-- Advanced). The two ops_* keys drive the new Ops Queue derived check
-- appt_intake_not_applied (Settings > General > Ops Queue), the alarm that
-- keeps a landed-but-not-applied webhook from ever being silent again.
--
-- The server falls back to exactly the routemize_status_map default seeded
-- below when the row is missing or unparseable, so this seed changes no
-- behavior; it makes the knob visible and editable.
-- ============================================================================

insert into public.settings (key, value) values
  ('routemize_status_map', '{"1":"scheduled","2":"scheduled","3":"canceled"}'),
  ('ops_check_appt_intake', 'true'),
  ('ops_appt_intake_days', '7')
on conflict (key) do nothing;
