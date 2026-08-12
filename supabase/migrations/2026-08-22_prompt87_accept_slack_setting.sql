-- @artifacts
--   setting: estimate_accept_slack_enabled
-- @end
-- ============================================================================
-- 2026-08-22: on/off for the Slack accept celebration (prompt 87 Task A).
-- Author: Claude Code. Idempotent. Data-only.
--
-- WHY: the accept notification in pec-public-estimate.cjs (notifyOffice) had
-- no settings switch of its own; the view notification got one in prompt 75
-- (estimate_view_slack_enabled) and rule 12 says every notification channel
-- is tunable without a code change. The accept post is now a celebration
-- message, and this key silences it independently of the view alerts.
-- Missing row = ON, matching the reader's default.
-- ============================================================================

insert into public.settings (key, value) values
  ('estimate_accept_slack_enabled', 'true')
on conflict (key) do nothing;
