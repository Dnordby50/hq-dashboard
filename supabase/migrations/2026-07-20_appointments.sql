-- @artifacts
--   table: public.pec_appointments
--   table: public.pec_sales_member_google_tokens
--   table: public.pec_appointment_reminder_rules
--   table: public.pec_appointment_reminder_sends
--   column: public.pec_sales_team_members.google_connected
--   column: public.pec_sales_team_members.google_email
--   column: public.pec_sales_team_members.google_calendar_id
--   column: public.pec_sales_team_members.google_connected_at
--   index: idx_pec_appointments_start_at
--   index: idx_pec_appointments_sales_member
--   index: uq_pec_appointments_google_event
--   index: uq_pec_appt_reminder_send
-- @end
-- ============================================================================
-- 2026-07-20: Appointments calendar (prompt 37): pec_appointments, per-member
-- Google connection state + token vault, reminder rules + sends ledger, and
-- the bell RPC for booking notifications.
-- ============================================================================
-- Additive and idempotent; safe to re-run. All view/runner code ships with
-- degrade-cleanly guards, so this can land before or after the code deploy.
--
-- WHAT AND WHY:
--   1. pec_appointments: sales appointments (on-site estimates scheduled off a
--      lead, walkthroughs, site visits, ad-hoc "other" blocks). Assignee is a
--      pec_sales_team_members row (the roster, NOT admin_users logins). The
--      google_* columns are the two-way sync bookkeeping: google_event_id ties
--      a row to its Google Calendar event; google_updated is the echo/LWW
--      timestamp (a pulled event whose updated <= stored google_updated is our
--      own push echoing back and is skipped).
--   2. Roster flags (google_connected, google_email, google_calendar_id,
--      google_connected_at) are the CLIENT-READABLE connection status. The
--      tokens themselves live in pec_sales_member_google_tokens, which has RLS
--      enabled and ZERO policies (default-deny): only the service role (the
--      Netlify functions) can touch it. The UI never reads tokens.
--   3. pec_appointment_reminder_rules: configurable booking-confirmation and
--      pre-appointment reminders (Settings > Appointments editor). on_book
--      true = fires right after booking (offset_minutes ignored); otherwise
--      offset_minutes before start_at. Seeded with a customer confirmation
--      (on book, both channels) and a 1-day-before customer reminder. The
--      on-book salesperson bell deliberately has NO seeded rule: it goes
--      through the log_appointment_booked RPC at booking time (instant, and
--      it names the acting user), and a runner-processed duplicate would
--      double-notify. Salesperson rules created later in the editor (e.g. an
--      in-app nudge 60 minutes before) are handled by the runner.
--   4. pec_appointment_reminder_sends: idempotency ledger, one row per
--      (appointment, rule, channel) send attempt. The unique index is the
--      never-double-send backstop, same design as the drip ledger.
--   5. log_appointment_booked RPC: client JS cannot insert pec_notifications
--      (RLS is staff select/update only); the established path is a SECURITY
--      DEFINER RPC (see log_customer_deleted). This one drops the bell row
--      when an appointment is booked, naming the assigned salesperson.
--
-- *** COWORK HANDOFF: run this file in the PROD Supabase project ("HQ
-- Dashboard", zdfpzmmrgotynrwkeakd), run the verify block at the bottom, then
-- regenerate SCHEMA.md. ***
-- ============================================================================

begin;

-- 1. Appointments ------------------------------------------------------------
create table if not exists public.pec_appointments (
  id                 uuid primary key default gen_random_uuid(),
  appt_type          text not null
                       check (appt_type in ('on_site_estimate','project_walkthrough','site_visit','other')),
  title              text,
  lead_id            uuid,                -- no FK on purpose: leads soft-delete (deleted_at) and an appointment must survive its lead
  customer_id        uuid references public.customers(id),
  sales_member_id    uuid references public.pec_sales_team_members(id),
  start_at           timestamptz not null,
  end_at             timestamptz not null,
  all_day            boolean not null default false,
  location_address   text,
  location_city      text,
  location_state     text,
  location_zip       text,
  location_place_id  text,
  notes              text,
  status             text not null default 'scheduled'
                       check (status in ('scheduled','completed','canceled')),
  source             text not null default 'topcoat'
                       check (source in ('topcoat','google')),
  google_event_id    text,
  google_calendar_id text,
  google_etag        text,
  google_updated     timestamptz,
  created_by         uuid,                -- acting admin_users.auth user id (auth.uid()), same stamp the lead writes use
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_pec_appointments_start_at
  on public.pec_appointments (start_at);
create index if not exists idx_pec_appointments_sales_member
  on public.pec_appointments (sales_member_id);
-- Partial unique: one row per Google event. The pull upserts by
-- google_event_id; this makes a concurrent double-pull a clean conflict
-- instead of a duplicate appointment.
create unique index if not exists uq_pec_appointments_google_event
  on public.pec_appointments (google_event_id) where google_event_id is not null;

alter table public.pec_appointments enable row level security;
-- All-staff read+write (mirror the Messages / pec_email_log posture: any
-- signed-in staff member works the calendar; RLS is the boundary, no anon).
drop policy if exists pec_appointments_staff on public.pec_appointments;
create policy pec_appointments_staff on public.pec_appointments for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());
drop trigger if exists trg_pec_appointments_touch on public.pec_appointments;
create trigger trg_pec_appointments_touch before update on public.pec_appointments
  for each row execute function public.pec_prod_touch_updated_at();

-- 2. Roster connection status (client-readable flags, never tokens) ----------
alter table public.pec_sales_team_members add column if not exists google_connected boolean not null default false;
alter table public.pec_sales_team_members add column if not exists google_email text;
alter table public.pec_sales_team_members add column if not exists google_calendar_id text;
alter table public.pec_sales_team_members add column if not exists google_connected_at timestamptz;

-- 3. Token vault (server-only) -----------------------------------------------
create table if not exists public.pec_sales_member_google_tokens (
  id              uuid primary key default gen_random_uuid(),
  sales_member_id uuid unique references public.pec_sales_team_members(id),
  access_token    text,
  refresh_token   text,
  token_expiry    timestamptz,
  sync_token      text,       -- Google Calendar incremental-sync token for the pull runner
  updated_at      timestamptz default now()
);
-- RLS ON with NO policies = default-deny for anon AND authenticated. Only the
-- service role (Netlify functions) bypasses RLS. Do NOT add policies here.
alter table public.pec_sales_member_google_tokens enable row level security;
drop trigger if exists trg_pec_google_tokens_touch on public.pec_sales_member_google_tokens;
create trigger trg_pec_google_tokens_touch before update on public.pec_sales_member_google_tokens
  for each row execute function public.pec_prod_touch_updated_at();

-- 4. Reminder rules ----------------------------------------------------------
create table if not exists public.pec_appointment_reminder_rules (
  id               uuid primary key default gen_random_uuid(),
  enabled          boolean not null default true,
  audience         text not null check (audience in ('customer','salesperson')),
  channel          text not null check (channel in ('sms','email','both','in_app')),
  on_book          boolean not null default false,  -- true: fires on booking; offset_minutes ignored
  offset_minutes   int not null default 0,          -- minutes BEFORE start_at (ignored when on_book)
  appt_type        text,                            -- null = all types; else one of the pec_appointments appt_type values
  message_template text,                            -- tokens: {customer_first} {appt_date} {appt_time} {sales_name}
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table public.pec_appointment_reminder_rules enable row level security;
-- Staff read (the runner state is visible), admin-only write (it's a Settings
-- surface, like campaigns).
drop policy if exists pec_appt_rules_read on public.pec_appointment_reminder_rules;
create policy pec_appt_rules_read on public.pec_appointment_reminder_rules for select
  using (public.is_admin_staff());
drop policy if exists pec_appt_rules_write on public.pec_appointment_reminder_rules;
create policy pec_appt_rules_write on public.pec_appointment_reminder_rules for all
  using (public.is_admin_role()) with check (public.is_admin_role());
drop trigger if exists trg_pec_appt_rules_touch on public.pec_appointment_reminder_rules;
create trigger trg_pec_appt_rules_touch before update on public.pec_appointment_reminder_rules
  for each row execute function public.pec_prod_touch_updated_at();

-- Seed defaults (idempotent: only when the table is empty, so Dylan's later
-- edits are never overwritten by a re-run). No em dashes: these are
-- customer-facing message bodies.
insert into public.pec_appointment_reminder_rules
  (enabled, audience, channel, on_book, offset_minutes, appt_type, message_template)
select * from (values
  (true, 'customer', 'both'::text, true,  0,    null::text,
   'Hi {customer_first}, you are booked with Prescott Epoxy Company. {sales_name} will see you on {appt_date} at {appt_time}. Reply to this message if you need to reschedule.'),
  (true, 'customer', 'both'::text, false, 1440, null::text,
   'Hi {customer_first}, a reminder from Prescott Epoxy Company: {sales_name} will see you tomorrow, {appt_date} at {appt_time}. Reply here if anything changes.')
) as seed(enabled, audience, channel, on_book, offset_minutes, appt_type, message_template)
where not exists (select 1 from public.pec_appointment_reminder_rules);

-- 5. Reminder sends ledger ---------------------------------------------------
create table if not exists public.pec_appointment_reminder_sends (
  id             uuid primary key default gen_random_uuid(),
  appointment_id uuid references public.pec_appointments(id) on delete cascade,
  rule_id        uuid references public.pec_appointment_reminder_rules(id) on delete set null,
  channel        text,             -- 'sms' | 'email' | 'in_app'
  sent_at        timestamptz default now(),
  status         text              -- 'sent' | 'failed' | 'skipped_consent' | 'skipped_no_contact'
);
-- The never-double-send backstop: one attempt per (appointment, rule, channel).
create unique index if not exists uq_pec_appt_reminder_send
  on public.pec_appointment_reminder_sends (appointment_id, rule_id, channel);
alter table public.pec_appointment_reminder_sends enable row level security;
-- Staff read-only (the runner writes with the service role; the UI only shows
-- send history).
drop policy if exists pec_appt_sends_read on public.pec_appointment_reminder_sends;
create policy pec_appt_sends_read on public.pec_appointment_reminder_sends for select
  using (public.is_admin_staff());

-- 6. Bell RPC ----------------------------------------------------------------
-- Client JS cannot insert pec_notifications (RLS allows staff select/update
-- only); mirror log_customer_deleted: SECURITY DEFINER, names the actor,
-- target_view/target_id route the bell tap to the appointment.
create or replace function public.log_appointment_booked(
  p_appointment_id uuid, p_title text, p_sales_name text, p_when text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text;
begin
  select coalesce(name, email) into v_actor from public.admin_users where auth_user_id = auth.uid();
  insert into public.pec_notifications (type, body, target_view, target_id)
    values ('appointment_booked',
            coalesce(v_actor, 'Someone') || ' booked ' || coalesce(nullif(p_title, ''), 'an appointment')
              || case when nullif(p_sales_name, '') is not null then ' for ' || p_sales_name else '' end
              || case when nullif(p_when, '') is not null then ' (' || p_when || ')' else '' end,
            'appointments', p_appointment_id);
end
$$;
grant execute on function public.log_appointment_booked(uuid, text, text, text) to authenticated;

commit;

-- ============================================================================
-- VERIFY (run after applying; expected results in comments)
-- ============================================================================
-- 1) Tables exist:
--    select table_name from information_schema.tables where table_schema='public'
--      and table_name in ('pec_appointments','pec_sales_member_google_tokens',
--                         'pec_appointment_reminder_rules','pec_appointment_reminder_sends')
--      order by table_name;
--    -- 4 rows
-- 2) Roster flags:
--    select column_name from information_schema.columns
--      where table_name='pec_sales_team_members' and column_name like 'google%'
--      order by column_name;
--    -- google_calendar_id / google_connected / google_connected_at / google_email (4 rows)
-- 3) Token vault is default-deny (RLS on, zero policies):
--    select relrowsecurity from pg_class where relname='pec_sales_member_google_tokens';  -- true
--    select count(*) from pg_policies where tablename='pec_sales_member_google_tokens';   -- 0
-- 4) Seeds:
--    select audience, channel, on_book, offset_minutes from public.pec_appointment_reminder_rules order by on_book desc;
--    -- 2 rows: customer/both/on_book, customer/both/1440-min
-- 5) RPC:
--    select proname from pg_proc where proname='log_appointment_booked';  -- 1 row
-- 6) Ledger unique index:
--    select indexname from pg_indexes where tablename='pec_appointment_reminder_sends';  -- includes uq_pec_appt_reminder_send
