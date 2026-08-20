-- @artifacts
--   column: public.pec_appointments.booking_manage_token
--   column: public.pec_appointments.booking_request_id
--   table: public.pec_booking_forms
--   table: public.pec_booking_service_areas
--   table: public.pec_booking_requests
--   table: public.pec_drive_time_cache
--   index: pec_appointments_booking_manage_token_idx
--   index: pec_booking_service_areas_form_zip_idx
--   index: pec_booking_requests_created_idx
--   index: pec_booking_requests_ip_idx
--   index: pec_booking_requests_status_idx
--   index: pec_drive_time_cache_pair_idx
--   setting: booking_enabled
--   setting: booking_url
--   setting: booking_working_hours
--   setting: booking_slot_granularity_minutes
--   setting: booking_min_notice_minutes
--   setting: booking_horizon_days
--   setting: booking_buffer_min_minutes
--   setting: booking_buffer_max_minutes
--   setting: booking_buffer_default_minutes
--   setting: booking_drive_time_enabled
--   setting: booking_routes_max_origins_per_request
--   setting: booking_routes_timeout_ms
--   setting: booking_drive_cache_ttl_days
--   setting: booking_home_base_address
--   setting: booking_rate_limit_per_hour
--   setting: booking_min_fill_seconds
--   setting: booking_duplicate_window_hours
--   setting: booking_sms_disclosure
--   setting: booking_manage_link_text
--   setting: routemize_intake_enabled
--   setting: ops_check_booking_out_of_area
--   setting: ops_booking_days
-- @end
-- ============================================================================
-- 2026-09-11: prompt 101, TopCoat online booking (replace Routemize).
-- Author: Claude Code. REHEARSED ON A BRANCH DATABASE FIRST per rule 14: this
-- migration creates a SECURITY DEFINER function (book_appointment_slot), which
-- is an explicit rule-14 trigger even though no money/auth table is touched.
-- Idempotent.
--
-- WHY each piece exists:
--
-- pec_appointments.source gains 'booking' (the TopCoat public form). The
-- existing check constraint was verified against the live schema 2026-08-19:
-- name pec_appointments_source_check, def CHECK (source = ANY (ARRAY
-- ['topcoat','google','routemize'])). Recreating it with a superset can never
-- fail validation on the 741 existing rows.
--
-- booking_manage_token: the customer's private reschedule/cancel key, minted
-- by randomToken() at booking time, unique where not null (same posture as
-- routemize_appt_id). booking_request_id ties the appointment back to its
-- pec_booking_requests audit row.
--
-- pec_booking_forms: one row per public form (PEC ships seeded; FTP is a row,
-- not a refactor, per locked decision 7). questions is the editable set
-- (prompt 102 ships the visual builder; until then a JSON editor behind
-- Advanced edits it). appt_types carries which types the form offers and each
-- one's duration, so duration is form data, not code.
--
-- pec_booking_service_areas: the zip/city allowlist (locked decision 2). NOT
-- seeded here: Cowork supplies the real zip list (inventing zips would
-- silently put real customers on the out-of-area path). The public endpoint
-- treats an empty allowlist as "booking not open yet", never as
-- "everyone is out of area", and booking_enabled ships 'false' until the
-- allowlist lands.
--
-- pec_booking_requests: EVERY submission attempt, including the ones that
-- never became an appointment. This is the audit trail that answers "are we
-- losing bookings?", the exact question nobody could answer about Routemize,
-- and the rate-limit source for abuse control. error_text doubles as the
-- reject reason (rate_limit / honeypot / too_fast / duplicate) on
-- status='rejected' rows. ip_hash is a salted hash, never the raw IP, and is
-- NEVER granted to the browser: the table grant below enumerates every
-- column except it, so a staff client must name columns (select=* would be
-- rejected by Postgres for the authenticated role, which is the fence
-- working as designed).
--
-- pec_drive_time_cache: memoized Routes API results keyed on normalized
-- (origin, destination) so one booking session costs at most one matrix call
-- and repeat sessions cost zero. State, not settings: no UI control exists on
-- purpose (rule 12). Service-role only, zero policies (default deny).
--
-- book_appointment_slot: the concurrency gate (Part D6). Two visitors can
-- hold the same slot list; the insert happens inside this SECURITY DEFINER
-- function, which takes pg_advisory_xact_lock on a hash of (rep, Phoenix
-- date), re-checks for an overlapping scheduled row for that rep INCLUDING
-- the drive-time buffers, and inserts only if clear. It returns
-- {ok:false, taken:true} for a lost race so the endpoint can answer "that
-- time was just taken" instead of a 500. Deliberately NOT a table-wide
-- exclusion constraint: source='google' imports legitimately overlap each
-- other and would fail one. p_reschedule_id switches the same lock+check to
-- an UPDATE, so the manage link's reschedule honors identical rules and the
-- appointment keeps its id. EXECUTE is revoked from anon/authenticated: only
-- the service role (the booking endpoint) may book through it.
--
-- Settings (rule 12): booking_enabled + the booking link are front-of-card
-- on Settings > Appointments' new "Online booking" card; everything else
-- behind Advanced. booking_enabled ships 'false' (dark until the service
-- area is seeded and Dylan flips it). booking_url is the renamed
-- routemize_booking_url (the {booking_link} drip token source); the live
-- value was verified EMPTY on 2026-08-19, so there is no value to migrate,
-- only the key to introduce (getBookingUrl reads booking_url first, then
-- falls back to the old key). routemize_intake_enabled (Part G4) lets Dylan
-- switch the old intake off without a deploy once the Routemize account
-- closes.
-- ============================================================================

begin;

-- ---- pec_appointments: 'booking' source + manage token ---------------------

alter table public.pec_appointments
  drop constraint if exists pec_appointments_source_check;
alter table public.pec_appointments
  add constraint pec_appointments_source_check
  check (source = any (array['topcoat'::text, 'google'::text, 'routemize'::text, 'booking'::text]));

alter table public.pec_appointments add column if not exists booking_manage_token text;
alter table public.pec_appointments add column if not exists booking_request_id uuid;

create unique index if not exists pec_appointments_booking_manage_token_idx
  on public.pec_appointments (booking_manage_token)
  where booking_manage_token is not null;

-- ---- pec_booking_forms -----------------------------------------------------

create table if not exists public.pec_booking_forms (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  brand text not null default 'PEC',
  name text not null,
  active boolean not null default true,
  headline text,
  intro_text text,
  success_message text,
  appt_types jsonb not null default '[]'::jsonb,
  questions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pec_booking_forms enable row level security;

-- Staff manage the form from Settings (the JSON editor now, the prompt-102
-- builder later); the public endpoint reads it with the service role.
drop policy if exists pec_booking_forms_staff_all on public.pec_booking_forms;
create policy pec_booking_forms_staff_all on public.pec_booking_forms
  using (public.is_admin_staff()) with check (public.is_admin_staff());

-- ---- pec_booking_service_areas ---------------------------------------------

create table if not exists public.pec_booking_service_areas (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.pec_booking_forms(id) on delete cascade,
  zip text,
  city text,
  active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pec_booking_service_areas_has_key check (zip is not null or city is not null)
);

-- Unique per (form, zip); NULL zips (city-only rows) stay distinct, which is
-- Postgres default NULLS DISTINCT semantics and exactly what we want.
create unique index if not exists pec_booking_service_areas_form_zip_idx
  on public.pec_booking_service_areas (form_id, zip);

alter table public.pec_booking_service_areas enable row level security;

drop policy if exists pec_booking_service_areas_staff_all on public.pec_booking_service_areas;
create policy pec_booking_service_areas_staff_all on public.pec_booking_service_areas
  using (public.is_admin_staff()) with check (public.is_admin_staff());

-- ---- pec_booking_requests --------------------------------------------------

create table if not exists public.pec_booking_requests (
  id uuid primary key default gen_random_uuid(),
  form_id uuid references public.pec_booking_forms(id),
  status text not null,
  name text,
  phone text,
  email text,
  address_line1 text,
  address_city text,
  address_state text,
  address_zip text,
  place_id text,
  in_area boolean,
  requested_start timestamptz,
  appointment_id uuid references public.pec_appointments(id) on delete set null,
  lead_id uuid,
  customer_id uuid,
  answers jsonb,
  sms_consent boolean not null default false,
  sms_consent_disclosure text,
  ip_hash text,
  user_agent text,
  error_text text,
  created_at timestamptz not null default now(),
  constraint pec_booking_requests_status_check
    check (status in ('booked', 'out_of_area', 'rejected', 'error'))
);

create index if not exists pec_booking_requests_created_idx
  on public.pec_booking_requests (created_at desc);
create index if not exists pec_booking_requests_ip_idx
  on public.pec_booking_requests (ip_hash, created_at desc);
create index if not exists pec_booking_requests_status_idx
  on public.pec_booking_requests (status, created_at desc);

alter table public.pec_booking_requests enable row level security;

drop policy if exists pec_booking_requests_staff_read on public.pec_booking_requests;
create policy pec_booking_requests_staff_read on public.pec_booking_requests
  for select using (public.is_admin_staff());

-- ip_hash never reaches the browser: replace the blanket table grant with a
-- column list that omits it. The service role is unaffected (BYPASSRLS +
-- its own grants). Staff clients must name columns in select= (star would be
-- a Postgres permission error for authenticated, by design).
revoke select on public.pec_booking_requests from anon, authenticated;
revoke insert, update, delete on public.pec_booking_requests from anon, authenticated;
grant select (id, form_id, status, name, phone, email, address_line1,
  address_city, address_state, address_zip, place_id, in_area,
  requested_start, appointment_id, lead_id, customer_id, answers,
  sms_consent, sms_consent_disclosure, user_agent, error_text, created_at)
  on public.pec_booking_requests to authenticated;

-- ---- pec_drive_time_cache --------------------------------------------------

create table if not exists public.pec_drive_time_cache (
  id uuid primary key default gen_random_uuid(),
  origin_key text not null,
  dest_key text not null,
  minutes numeric,
  meters numeric,
  fetched_at timestamptz not null default now()
);

create unique index if not exists pec_drive_time_cache_pair_idx
  on public.pec_drive_time_cache (origin_key, dest_key);

alter table public.pec_drive_time_cache enable row level security;
-- Zero policies on purpose: service-role only, default deny (the
-- pec_sales_member_google_tokens posture). It is a cache, not data anyone
-- browses.
revoke all on public.pec_drive_time_cache from anon, authenticated;

-- ---- book_appointment_slot: the locked write --------------------------------

create or replace function public.book_appointment_slot(
  p_row jsonb,
  p_buffer_before_minutes integer default 30,
  p_buffer_after_minutes integer default 30,
  p_reschedule_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member uuid := nullif(p_row->>'sales_member_id', '')::uuid;
  v_start timestamptz := nullif(p_row->>'start_at', '')::timestamptz;
  v_end timestamptz := nullif(p_row->>'end_at', '')::timestamptz;
  v_local_date date;
  v_conflicts integer;
  v_id uuid;
begin
  if v_start is null or v_end is null or v_end <= v_start then
    return jsonb_build_object('ok', false, 'error', 'bad_times');
  end if;

  -- Serialize per (rep, Phoenix calendar date): two bookings for the same rep
  -- on the same day take the same lock and run one at a time; different reps
  -- or different days never contend. xact lock: released automatically at
  -- commit/rollback, so no leak path exists.
  v_local_date := (v_start at time zone 'America/Phoenix')::date;
  perform pg_advisory_xact_lock(
    hashtextextended(coalesce(v_member::text, 'unassigned') || ':' || v_local_date::text, 42));

  -- Re-check UNDER the lock, buffers included: a scheduled row for this rep
  -- (whatever its source, google blocks too) that starts before the
  -- candidate's end-plus-after-buffer and ends after the candidate's
  -- start-minus-before-buffer is a conflict. The buffers passed in are the
  -- engine's for this slot's actual neighbors; for any third row the check
  -- is at worst conservative, and a conservative "taken" beats a
  -- double-booked driveway.
  select count(*) into v_conflicts
  from public.pec_appointments a
  where a.status = 'scheduled'
    and (v_member is null or a.sales_member_id = v_member)
    and (p_reschedule_id is null or a.id <> p_reschedule_id)
    and a.start_at < v_end + make_interval(mins => greatest(p_buffer_after_minutes, 0))
    and a.end_at > v_start - make_interval(mins => greatest(p_buffer_before_minutes, 0));

  if v_conflicts > 0 then
    return jsonb_build_object('ok', false, 'taken', true);
  end if;

  if p_reschedule_id is not null then
    update public.pec_appointments
      set start_at = v_start, end_at = v_end, updated_at = now()
      where id = p_reschedule_id and status = 'scheduled'
      returning id into v_id;
    if v_id is null then
      return jsonb_build_object('ok', false, 'error', 'not_found');
    end if;
  else
    insert into public.pec_appointments
      (appt_type, title, lead_id, customer_id, sales_member_id,
       start_at, end_at, all_day,
       location_address, location_city, location_state, location_zip,
       location_place_id, notes, customer_notes,
       status, source, booking_manage_token, booking_request_id)
    values
      (coalesce(nullif(p_row->>'appt_type', ''), 'on_site_estimate'),
       nullif(p_row->>'title', ''),
       nullif(p_row->>'lead_id', '')::uuid,
       nullif(p_row->>'customer_id', '')::uuid,
       v_member,
       v_start, v_end, false,
       nullif(p_row->>'location_address', ''),
       nullif(p_row->>'location_city', ''),
       nullif(p_row->>'location_state', ''),
       nullif(p_row->>'location_zip', ''),
       nullif(p_row->>'location_place_id', ''),
       nullif(p_row->>'notes', ''),
       nullif(p_row->>'customer_notes', ''),
       'scheduled', 'booking',
       nullif(p_row->>'booking_manage_token', ''),
       nullif(p_row->>'booking_request_id', '')::uuid)
    returning id into v_id;
  end if;

  return jsonb_build_object('ok', true, 'appointment_id', v_id);
end;
$$;

-- Only the booking endpoint (service role) books through the lock. A browser
-- session must never reach a SECURITY DEFINER writer directly.
revoke execute on function public.book_appointment_slot(jsonb, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.book_appointment_slot(jsonb, integer, integer, uuid) to service_role;

-- ---- Seed: the PEC form ----------------------------------------------------

insert into public.pec_booking_forms (slug, brand, name, active, headline, intro_text, success_message, appt_types, questions)
values (
  'pec', 'PEC', 'PEC online booking', true,
  'Book your free on-site estimate',
  'Tell us where the project is and pick a time that works for you. We come to you, take measurements, and give you a firm price on the spot.',
  'You are booked! A confirmation is on its way by text or email with everything you need, including a link to reschedule if plans change.',
  '[{"key":"on_site_estimate","label":"On-site estimate","duration_minutes":60}]'::jsonb,
  '[
    {"id":"quote_type","label":"What are we quoting?","type":"choice","required":false,"routing":"internal","options":["Garage floor","Patio","Driveway","Shop or commercial","Other"]},
    {"id":"sqft","label":"Roughly how many square feet?","type":"short_text","required":true,"routing":"internal","help":"A rough guess is fine. A standard 2-car garage is about 400 to 500 square feet."},
    {"id":"project","label":"Tell us about the project","type":"long_text","required":false,"routing":"customer"},
    {"id":"how_heard","label":"How did you hear about us?","type":"choice","required":false,"routing":"drop","maps_to":"lead_source","options":["Google","Facebook or Instagram","Referral","Saw a job in my neighborhood","Other"]}
  ]'::jsonb
)
on conflict (slug) do nothing;

-- ---- Settings ---------------------------------------------------------------

insert into public.settings (key, value) values
  ('booking_enabled', 'false'),
  ('booking_url', ''),
  ('booking_working_hours', '{"mon":["08:00","17:00"],"tue":["08:00","17:00"],"wed":["08:00","17:00"],"thu":["08:00","17:00"],"fri":["08:00","17:00"],"sat":null,"sun":null}'),
  ('booking_slot_granularity_minutes', '30'),
  ('booking_min_notice_minutes', '120'),
  ('booking_horizon_days', '30'),
  ('booking_buffer_min_minutes', '20'),
  ('booking_buffer_max_minutes', '90'),
  ('booking_buffer_default_minutes', '30'),
  ('booking_drive_time_enabled', 'true'),
  ('booking_routes_max_origins_per_request', '25'),
  ('booking_routes_timeout_ms', '4000'),
  ('booking_drive_cache_ttl_days', '30'),
  ('booking_home_base_address', ''),
  ('booking_rate_limit_per_hour', '5'),
  ('booking_min_fill_seconds', '2'),
  ('booking_duplicate_window_hours', '24'),
  ('booking_sms_disclosure', 'By checking this box you agree to receive text messages from Prescott Epoxy Company about your appointment and project. Message frequency varies. Message and data rates may apply. Reply STOP to opt out.'),
  ('booking_manage_link_text', 'Need to change it? Reschedule or cancel here: {link}'),
  ('routemize_intake_enabled', 'true'),
  ('ops_check_booking_out_of_area', 'true'),
  ('ops_booking_days', '7')
on conflict (key) do nothing;

commit;
