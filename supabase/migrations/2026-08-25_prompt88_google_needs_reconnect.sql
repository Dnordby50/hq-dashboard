-- @artifacts
--   column: public.pec_sales_team_members.google_needs_reconnect
-- @end
-- ============================================================================
-- 2026-08-25: honest connection state for Google Calendar sync (prompt 88).
-- Author: Claude Code. Idempotent. DDL only.
--
-- WHY: both members' OAuth refresh tokens died on 2026-07-28 (the Google
-- Cloud OAuth app sat in Testing mode, whose refresh tokens live exactly 7
-- days) and the roster kept showing google_connected=true for two weeks while
-- every push and pull failed auth. When a token refresh fails with Google's
-- invalid_grant (the token is dead, not a transient blip), the server now
-- flips google_connected=false AND sets this flag, so Settings > Appointments
-- can show "Reconnect" (the account that WAS linked, needs re-consent)
-- instead of either a lying green state or an amnesiac "Not connected".
-- This is STATE written by the app, never a setting (rule 12): no settings
-- row, no UI control. Cleared by a successful reconnect or a disconnect.
-- ============================================================================

alter table public.pec_sales_team_members
  add column if not exists google_needs_reconnect boolean not null default false;
