-- @artifacts
--   table: public.pec_customer_notes
--   table: public.pec_followup_ranks
--   column: public.estimates.followup_snoozed_until
--   column: public.estimates.followup_snooze_reason
--   index: pec_customer_notes_customer_idx
--   index: pec_customer_notes_estimate_idx
--   index: pec_followup_ranks_subject_idx
--   setting: followup_enabled
--   setting: followup_overdue_days_estimate_sent
--   setting: followup_cold_days
--   setting: followup_snooze_max_days
--   setting: followup_ai_rank_enabled
--   setting: followup_ai_rank_limit
--   setting: followup_slack_digest_enabled
--   setting: followup_digest_top_n
--   setting: followup_digest_time
-- @end
-- ============================================================================
-- 2026-09-10: prompt 98, the sent-estimate follow-up queue. Author: Claude
-- Code. Applied to PROD via MCP. Idempotent.
--
-- RULE 14 REASONING: estimates is a rehearse-on-a-branch table because of
-- estimates.status; this migration adds two nullable followup_snooze_*
-- columns and never touches status, its trigger, or any money column, so
-- direct-to-prod is the defensible path (the rule's own carve-out for plain
-- additive columns).
--
-- pec_customer_notes: THE customer note store (customers has no notes column
-- today; this is new, not a migration of something existing). One "Log a
-- touch" write renders on the customer page, the estimate detail, and the
-- lead's pipeline card. counts_as_touch exists so "customer walked in and
-- paid" and "left voicemail" can both be recorded while only actual outreach
-- resets the follow-up clock. lead_id carries NO FK on purpose (the
-- pec_appointments convention: survives lead soft-delete). The touch moment
-- is created_at (prompt 98's field list; no separate occurred_at).
--
-- pec_followup_ranks: the nightly AI output, one row per open subject,
-- upserted on (subject_type, subject_id). `inputs` snapshots the
-- deterministic signals the model was given, so a bad ranking is debuggable
-- instead of mysterious. Two columns beyond the prompt's list, both needed
-- by locked decisions: `suggested_text` (Part D5 requires BOTH a one-line
-- phone opener and a short text draft; the prompt's column list carried only
-- the opener) and `source` 'ai'|'fallback' + `model` (prompt 49's locked
-- fallbackPriority requires the view to say honestly whether a row was AI-
-- ranked or fallback-ranked). Staff read; writes are service-role only (the
-- runner), so no insert/update policy exists.
--
-- Settings (rule 12): followup_enabled + followup_overdue_days_estimate_sent
-- front-of-card on Settings > Follow-ups; the rest behind Advanced.
-- followup_digest_time is Phoenix local HH:MM (the digest ticker compares
-- against America/Phoenix; the project is single-timezone, no DST).
-- ============================================================================

begin;

create table if not exists public.pec_customer_notes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  lead_id uuid,
  estimate_id uuid references public.estimates(id),
  body text not null,
  channel text not null,
  outcome text,
  counts_as_touch boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint pec_customer_notes_channel_check
    check (channel in ('call','text','email','in_person','walk_in','other')),
  constraint pec_customer_notes_outcome_check
    check (outcome is null or outcome in ('reached','voicemail','no_answer','n_a'))
);

create index if not exists pec_customer_notes_customer_idx
  on public.pec_customer_notes (customer_id, created_at desc);
create index if not exists pec_customer_notes_estimate_idx
  on public.pec_customer_notes (estimate_id, created_at desc);

alter table public.pec_customer_notes enable row level security;

-- Staff read + insert (any signed-in staff member logs touches); edits and
-- deletes are admin-only because this is an audit-ish trail (a mistyped
-- touch must be fixable, but not silently rewritable by anyone). Anon sees
-- nothing: no policy grants it anything.
drop policy if exists pec_customer_notes_staff_read on public.pec_customer_notes;
create policy pec_customer_notes_staff_read on public.pec_customer_notes
  for select using (public.is_admin_staff());
drop policy if exists pec_customer_notes_staff_insert on public.pec_customer_notes;
create policy pec_customer_notes_staff_insert on public.pec_customer_notes
  for insert with check (public.is_admin_staff());
drop policy if exists pec_customer_notes_admin_update on public.pec_customer_notes;
create policy pec_customer_notes_admin_update on public.pec_customer_notes
  for update using (public.is_admin_role()) with check (public.is_admin_role());
drop policy if exists pec_customer_notes_admin_delete on public.pec_customer_notes;
create policy pec_customer_notes_admin_delete on public.pec_customer_notes
  for delete using (public.is_admin_role());

create table if not exists public.pec_followup_ranks (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null,
  subject_id uuid not null,
  rank integer,
  score integer,
  why_now text,
  suggested_opener text,
  suggested_text text,
  suggested_channel text,
  source text not null default 'ai',
  model text,
  inputs jsonb,
  ranked_at timestamptz not null default now(),
  constraint pec_followup_ranks_subject_type_check
    check (subject_type in ('estimate','lead')),
  constraint pec_followup_ranks_channel_check
    check (suggested_channel is null or suggested_channel in ('call','text','email')),
  constraint pec_followup_ranks_source_check
    check (source in ('ai','fallback'))
);

create unique index if not exists pec_followup_ranks_subject_idx
  on public.pec_followup_ranks (subject_type, subject_id);

alter table public.pec_followup_ranks enable row level security;

-- Staff read only; the nightly runner writes with the service role (which
-- bypasses RLS), so no insert/update policy exists on purpose. Anon: nothing.
drop policy if exists pec_followup_ranks_staff_read on public.pec_followup_ranks;
create policy pec_followup_ranks_staff_read on public.pec_followup_ranks
  for select using (public.is_admin_staff());

alter table public.estimates add column if not exists followup_snoozed_until timestamptz;
alter table public.estimates add column if not exists followup_snooze_reason text;

insert into public.settings (key, value) values
  ('followup_enabled', 'true'),
  ('followup_overdue_days_estimate_sent', '3'),
  ('followup_cold_days', '21'),
  ('followup_snooze_max_days', '60'),
  ('followup_ai_rank_enabled', 'true'),
  ('followup_ai_rank_limit', '60'),
  ('followup_slack_digest_enabled', 'true'),
  ('followup_digest_top_n', '10'),
  ('followup_digest_time', '07:30')
on conflict (key) do nothing;

commit;
