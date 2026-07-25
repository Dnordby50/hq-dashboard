-- @artifacts
--   table: public.pec_user_todos
--   index: idx_pec_user_todos_user
-- @end
-- ============================================================================
-- 2026-07-16: Personal to-dos (prompt 28).
-- Author: Claude Code. RUN BY COWORK on the PROD Supabase project. Idempotent.
-- NOT applied to prod from the Claude Code session.
--
-- Why: every signed-in user gets a PRIVATE checklist (a To-dos item in the left
-- nav). One row = one to-do. DB-backed so the same list follows the user across
-- devices; no due dates, no reminders, no sharing this build.
--
-- Identity mirrors user_permissions (2026-06-08) and pec_whats_new_acks
-- (2026-07-09): rows key on admin_users.id, and RLS maps the signed-in
-- auth.uid() to that id. OWNER-ONLY on purpose: there is deliberately no
-- admin-wide policy, so even an admin's authenticated queries see only their
-- own rows (this is a private list, not a management surface). Only the
-- service role (which bypasses RLS entirely) can see everything, and the
-- client never holds that key. All four verbs are owner-scoped: SELECT,
-- INSERT, UPDATE (check the toggle cannot re-home a row to another user),
-- DELETE.
-- Deploy-order safety: the client treats a failed read as "couldn't load"
-- (short note, shell keeps working), so deploying before this migration
-- cannot break anything.
-- ============================================================================

begin;

create table if not exists public.pec_user_todos (
  id            uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references public.admin_users(id) on delete cascade,
  body          text not null,
  done          boolean not null default false,
  created_at    timestamptz not null default now(),
  done_at       timestamptz
);
create index if not exists idx_pec_user_todos_user on public.pec_user_todos (admin_user_id);

alter table public.pec_user_todos enable row level security;

drop policy if exists put_select_own on public.pec_user_todos;
create policy put_select_own on public.pec_user_todos for select
  using (admin_user_id in (select id from public.admin_users where auth_user_id = auth.uid()));

drop policy if exists put_insert_own on public.pec_user_todos;
create policy put_insert_own on public.pec_user_todos for insert
  with check (admin_user_id in (select id from public.admin_users where auth_user_id = auth.uid()));

-- UPDATE carries BOTH clauses: `using` scopes which rows the user may touch,
-- `with check` blocks an update that would hand the row to someone else.
drop policy if exists put_update_own on public.pec_user_todos;
create policy put_update_own on public.pec_user_todos for update
  using (admin_user_id in (select id from public.admin_users where auth_user_id = auth.uid()))
  with check (admin_user_id in (select id from public.admin_users where auth_user_id = auth.uid()));

drop policy if exists put_delete_own on public.pec_user_todos;
create policy put_delete_own on public.pec_user_todos for delete
  using (admin_user_id in (select id from public.admin_users where auth_user_id = auth.uid()));

commit;

-- ============================================================================
-- Verify after running (Cowork: capture the outputs in your log entry):
--
-- a) Table exists with RLS on:
--   select relrowsecurity from pg_class where relname = 'pec_user_todos';   -- t
--
-- b) Exactly four owner-only policies, one per verb:
--   select policyname, cmd from pg_policies where tablename = 'pec_user_todos'
--     order by cmd;                       -- DELETE, INSERT, SELECT, UPDATE
--
-- c) Owner column FKs admin_users with cascade:
--   select pg_get_constraintdef(oid) from pg_constraint
--     where conrelid = 'public.pec_user_todos'::regclass and contype = 'f';
--
-- d) Starts empty:
--   select count(*) from public.pec_user_todos;                             -- 0
--
-- Isolation note for the log: a service-role query (Studio's SQL editor, the
-- MCP tools) BYPASSES RLS and sees every row, so "I can see all rows in
-- Studio" proves nothing. The real check is two authenticated sessions: sign
-- in as user A, add a to-do; sign in as user B, open To-dos; B must see none
-- of A's items and vice versa.
-- ============================================================================
