-- @artifacts
--   setting: salesask_score_green_pct
--   setting: salesask_score_amber_pct
-- @end
-- ============================================================================
-- 2026-08-11: SalesAsk process-score color thresholds (prompt 71 Part F).
-- Author: Claude Code, prompt 77 session (which builds prompt 71). Applied to
-- PROD (zdfpzmmrgotynrwkeakd) via MCP in that same session on 2026-08-08.
--
-- The score badge on the customer card / estimate card and the pipeline chip
-- color by these two thresholds (percent = process_followed / process_total):
-- at or above green = green, at or above amber = amber, below = red. The
-- Settings UI refuses to save green <= amber rather than silently rendering
-- everything red.
--
-- NOTE, recorded for the next reader: prompt 71 also asked for a migration
-- widening pec_salesask_recordings' read policy from is_admin_staff() to "any
-- signed-in staff". That migration deliberately does NOT exist. Verified live
-- 2026-08-08: is_admin_staff() IS this app's any-signed-in-staff predicate
-- (it checks bare admin_users membership; estimates and leads use the exact
-- same qual, and both sales reps with logins have admin_users rows), so the
-- policy the 2026-07-31 migration created already grants reps read and a
-- replacement would recreate it verbatim.
--
-- Idempotent: insert-only seeding, live edits never clobbered.
-- ============================================================================

begin;

insert into public.settings (key, value) values
  ('salesask_score_green_pct', '90'),
  ('salesask_score_amber_pct', '70')
on conflict (key) do nothing;

commit;

-- Verify:
--   select key, value from settings where key like 'salesask_score%';  -- 2 rows
