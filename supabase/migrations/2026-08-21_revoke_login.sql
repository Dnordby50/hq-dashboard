-- Prompt 86: revoke a user's login without deleting their records.
--
-- WHY columns on admin_users and NOT people.active: people_mirror_forward
-- (AFTER UPDATE on people) writes `active` through to pec_sales_team_members
-- and pec_prod_crew_members, so flipping people.active would retire the
-- person's sales and crew roles too. Locked decision 1 says revoke touches
-- the LOGIN only, so the state lives on admin_users and nothing here touches
-- people or the legacy role tables.
--
-- login_revoked_at null  = active login (every pre-existing row; no backfill).
-- login_revoked_at set   = login revoked; the auth user is banned and their
--                          sessions were deleted. The admin_users row, the
--                          auth.users row, and every historical attribution
--                          stay exactly where they were.
-- login_revoked_by       = the admin_users.id of who revoked it.
--
-- pec_admin_kill_sessions: the GoTrue admin REST API has no sign-out-by-
-- user-id endpoint (auth.admin.signOut wants the target's JWT, which we never
-- have), so the server-side session kill is a SECURITY DEFINER delete of the
-- user's auth.sessions rows; auth.refresh_tokens cascades via session_id, so
-- every refresh token dies with them. Executable by service_role ONLY (the
-- Netlify function): a staff session must go through pec-revoke-login.cjs,
-- which enforces can_manage_team and the self-revoke block.
--
-- @artifacts
--   column: public.admin_users.login_revoked_at
--   column: public.admin_users.login_revoked_by
--   setting: login_revoked_poll_seconds
-- @end

alter table public.admin_users
  add column if not exists login_revoked_at timestamptz null,
  add column if not exists login_revoked_by uuid null references public.admin_users(id) on delete set null;

create or replace function public.pec_admin_kill_sessions(target_auth_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  n integer;
begin
  delete from auth.sessions where user_id = target_auth_user_id;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.pec_admin_kill_sessions(uuid) from public;
revoke all on function public.pec_admin_kill_sessions(uuid) from anon;
revoke all on function public.pec_admin_kill_sessions(uuid) from authenticated;
grant execute on function public.pec_admin_kill_sessions(uuid) to service_role;

-- Kill-switch poll interval (standing rule 12: the one tunable parameter of
-- this feature). Seconds between the app's checks of its own login_revoked_at.
insert into public.settings (key, value)
  values ('login_revoked_poll_seconds', '60')
on conflict (key) do nothing;
