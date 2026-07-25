-- @artifacts
--   table: public.pec_whats_new_acks
--   index: idx_pec_whats_new_acks_user
-- @end
-- ============================================================================
-- 2026-07-09: What's New acknowledgments (prompt 14).
-- Author: Claude Code. RUN BY COWORK on the PROD Supabase project. Idempotent.
-- NOT applied to prod from the Claude Code session.
--
-- Why: the What's New popup shows each signed-in user the changelog entries
-- they have not acknowledged yet, across devices. Content lives in the repo
-- (help/whats-new.json, ships with each deploy); ONLY the per-user ack state
-- needs the database. One row = this user acked this entry.
--
-- Identity mirrors user_permissions (2026-06-08): rows key on admin_users.id,
-- and RLS maps the signed-in auth.uid() to that id. Narrowest possible
-- policies: a signed-in staff user can INSERT and SELECT their OWN rows only;
-- no update or delete policy exists at all (acks are append-only facts).
-- Deploy-order safety: the client treats a missing table as "no popup".
-- ============================================================================

begin;

create table if not exists public.pec_whats_new_acks (
  id            uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references public.admin_users(id) on delete cascade,
  entry_id      text not null,
  acked_at      timestamptz not null default now(),
  unique (admin_user_id, entry_id)
);
create index if not exists idx_pec_whats_new_acks_user on public.pec_whats_new_acks (admin_user_id);

alter table public.pec_whats_new_acks enable row level security;

drop policy if exists wna_select_own on public.pec_whats_new_acks;
create policy wna_select_own on public.pec_whats_new_acks for select
  using (admin_user_id in (select id from public.admin_users where auth_user_id = auth.uid()));

drop policy if exists wna_insert_own on public.pec_whats_new_acks;
create policy wna_insert_own on public.pec_whats_new_acks for insert
  with check (admin_user_id in (select id from public.admin_users where auth_user_id = auth.uid()));

commit;

-- ============================================================================
-- Verify after running (Cowork: capture the outputs in your log entry):
--
-- a) Table exists with RLS on:
--   select relrowsecurity from pg_class where relname = 'pec_whats_new_acks';  -- t
--
-- b) Exactly two policies, SELECT and INSERT, none for update/delete:
--   select policyname, cmd from pg_policies where tablename = 'pec_whats_new_acks';
--
-- c) Unique constraint on (admin_user_id, entry_id):
--   select pg_get_constraintdef(oid) from pg_constraint
--     where conrelid = 'public.pec_whats_new_acks'::regclass and contype = 'u';
--
-- d) Starts empty:
--   select count(*) from public.pec_whats_new_acks;                            -- 0
-- ============================================================================
