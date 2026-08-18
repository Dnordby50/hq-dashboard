-- @artifacts
--   table: public.pec_sales_member_google_calendars
--   column: public.pec_appointments.google_recurring_event_id
--   column: public.pec_appointments.google_readonly_reason
--   setting: google_pull_window_days_past
--   setting: google_pull_window_days_future
--   setting: google_pull_max_pages_per_calendar
--   setting: google_imported_default_appt_type
--   setting: google_pull_include_all_day
--   setting: google_pull_include_declined
-- @end
-- (The pec_member_google_calendars_v view below is not expressible in the
-- four @artifacts kinds; it rides unverified by the drift checker.)
-- ============================================================================
-- 2026-09-08: prompt 96, Google multi-calendar sync. Author: Claude Code.
-- Applied to PROD via MCP. Idempotent. Additive tables/columns/settings only
-- (rule 14: no money/auth/estimates.status touched, direct to prod).
--
-- WHY: the pull has only ever polled the dedicated "TopCoat" calendar per
-- member. Dylan wants his OTHER Google calendars (primary, Sales, Meetings,
-- ...) visible in TopCoat, per-calendar toggleable, two-way where his access
-- allows. This table is the per-(member, calendar) sync ledger; each calendar
-- carries its OWN Google sync token (Google sync tokens are per-calendar),
-- its accessRole as of the last calendarList refresh, and last-sync
-- diagnostics for the Settings surface.
-- ============================================================================

create table if not exists public.pec_sales_member_google_calendars (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.pec_sales_team_members(id) on delete cascade,
  calendar_id text not null,
  summary text,
  access_role text,
  sync_enabled boolean not null default false,
  sync_token text,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (member_id, calendar_id)
);

-- Same posture as pec_sales_member_google_tokens: RLS on, ZERO policies =
-- default-deny, service-role only. sync_token is sync-protocol state and
-- must never reach a browser; reads go through the view below, writes go
-- through the pec-google-calendars endpoint (service role).
alter table public.pec_sales_member_google_calendars enable row level security;

-- Read-only surface for the dashboard (the Settings toggle list, imported-
-- event provenance in the appointment modal). The view owner (postgres) owns
-- the table and RLS is not FORCEd, so authenticated staff read THROUGH the
-- view while the table itself stays default-deny. sync_token deliberately
-- excluded.
create or replace view public.pec_member_google_calendars_v as
  select id, member_id, calendar_id, summary, access_role,
         sync_enabled, last_synced_at, last_error, updated_at
  from public.pec_sales_member_google_calendars;
revoke all on public.pec_member_google_calendars_v from anon;
grant select on public.pec_member_google_calendars_v to authenticated, service_role;

-- Pull bookkeeping for imported events. google_recurring_event_id: Google's
-- recurringEventId when the row is an expanded recurring instance (the push
-- patches the INSTANCE id only, never the series). google_readonly_reason:
-- non-null = TopCoat must not write this event back to Google
-- (calendar_read_only | not_organizer | recurring_patch_failed |
-- google_rejected_edit); the UI renders the row read-only straight off this
-- column instead of re-deriving the guardrails.
alter table public.pec_appointments add column if not exists google_recurring_event_id text;
alter table public.pec_appointments add column if not exists google_readonly_reason text;

-- Seed: the dedicated TopCoat calendar every already-connected member has,
-- sync_enabled = true, so current behavior survives the migration untouched.
-- The multi-calendar pull loop SKIPS this calendar (it is the push target;
-- pulling it would round-trip TopCoat's own writes through the legacy
-- member-level path that still owns it), and Settings shows it as the push
-- target, not toggleable.
insert into public.pec_sales_member_google_calendars (member_id, calendar_id, summary, access_role, sync_enabled)
select id, google_calendar_id, 'TopCoat', 'owner', true
from public.pec_sales_team_members
where google_calendar_id is not null
on conflict (member_id, calendar_id) do nothing;

-- Settings (rule 12): window days front-of-card on Settings > Appointments;
-- the rest behind that card's Advanced disclosure. The window bounds the
-- FIRST full sync of a personal calendar (singleEvents:true over years of
-- daily recurring blocks would otherwise expand thousands of instances);
-- incremental sync-token pulls cannot carry the window (Google rejects
-- syncToken combined with timeMin/timeMax) and inherit it from the full sync
-- that minted the token.
insert into public.settings (key, value) values
  ('google_pull_window_days_past', '30'),
  ('google_pull_window_days_future', '180'),
  ('google_pull_max_pages_per_calendar', '6'),
  ('google_imported_default_appt_type', 'other'),
  ('google_pull_include_all_day', 'true'),
  ('google_pull_include_declined', 'false')
on conflict (key) do nothing;
