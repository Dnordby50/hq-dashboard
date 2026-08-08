-- @artifacts
--   column: public.pec_notifications.target_user_id
--   index: idx_pec_notifications_target_user
--   setting: estimate_view_slack_enabled
--   setting: estimate_hot_min_views
--   setting: estimate_hot_window_hours
-- @end
-- ============================================================================
-- 2026-08-14: per-user notification targeting + estimate-view visibility
-- settings (prompt 75: Slack on every proposal view, a personal bell for the
-- selling rep, and the shared "hot estimate" rule).
-- Author: Claude Code, in the prompt 75 session (which could NOT apply it:
-- permission mode blocked the DDL write; see the prompt 75 PROJECT-LOG entry).
-- Applied to PROD (zdfpzmmrgotynrwkeakd) via MCP in the prompt 77 session on
-- 2026-08-08. Idempotent.
--
-- WHY target_user_id: pec_notifications is a shared table with a single
-- shared read_at; every existing row shows for everyone and MUST keep doing
-- so, so NULL means "shared, exactly as today" and the bell loader filters
-- client-side on (target_user_id IS NULL OR target_user_id = me). This is a
-- DISPLAY FILTER, not a security boundary: staff RLS still lets any staff row
-- read the whole table. Never describe a targeted row as private and never
-- put anything sensitive in a targeted body.
--
-- ON DELETE SET NULL on purpose: removing a staff member turns their personal
-- rows back into shared rows instead of deleting notification history.
--
-- Settings (rule 12, Settings > Estimates):
--   estimate_view_slack_enabled  'true'  -> #epoxysales post on EVERY logged
--                                           open (the bell keeps its own
--                                           first-per-day throttle; the two
--                                           switches are independent)
--   estimate_hot_min_views       '3'     -> hot = views >= this AND
--   estimate_hot_window_hours    '48'       last view within this window
-- ============================================================================

begin;

alter table public.pec_notifications
  add column if not exists target_user_id uuid references public.admin_users(id) on delete set null;

create index if not exists idx_pec_notifications_target_user
  on public.pec_notifications (target_user_id, created_at desc);

-- Insert-only seeding, like every other settings migration in this repo: a
-- re-run (or a later value change in Settings) is never clobbered.
insert into public.settings (key, value) values
  ('estimate_view_slack_enabled', 'true'),
  ('estimate_hot_min_views', '3'),
  ('estimate_hot_window_hours', '48')
on conflict (key) do nothing;

commit;

-- Verify:
--   select column_name from information_schema.columns
--     where table_name='pec_notifications' and column_name='target_user_id';
--   select indexname from pg_indexes where indexname='idx_pec_notifications_target_user';
--   select key, value from settings where key like 'estimate_view_slack%' or key like 'estimate_hot%';
