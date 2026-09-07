-- @artifacts
--   table: public.pec_appointment_blocked_days
--   column: public.pec_appointments.created_by_label
--   index: idx_pec_appt_blocked_days_range
--   index: idx_audit_log_appointments
--   setting: booking_block_crew_holidays
--   setting: appt_default_duration_minutes
-- @end
-- ============================================================================
-- 2026-09-21: Days off for the appointment calendar + an audit trail of who
-- scheduled every appointment + the default appointment length setting.
-- Author: Claude Code.
--
-- WHY (the bug): a customer booked an on-site estimate through /book on a day
-- the company was off. Two things let that happen. (1) Company holidays live
-- in pec_prod_holidays, which only the CREW schedule reads; the online booking
-- engine (production/booking-availability.cjs) reads pec_appointments alone, so
-- a holiday never blocked a slot. (2) The only way to block a sales day was an
-- all-day pec_appointments row, and nobody creates those by hand ("LABOR DAY -
-- OFF" was a 7:00-7:30 Google event, which blocked exactly 30 minutes).
--
-- WHAT:
--   1. pec_appointment_blocked_days: a date range that closes the appointment
--      calendar for everyone (sales_member_id null) or one rep. Read by the
--      booking engine, drawn on the Appointments calendar, and re-checked
--      inside book_appointment_slot so a race cannot slip through.
--   2. Audit trail: every INSERT / meaningful UPDATE / DELETE on
--      pec_appointments writes an audit_log row (entity_type
--      'pec_appointments') from a TRIGGER, so no write path (dashboard,
--      /book, Routemize, Google pull, MCP) can skip it. The actor resolves
--      from the signed-in staff user when there is one, else from a label
--      the server function passes (set_config 'topcoat.actor' or the
--      x-topcoat-actor request header), else from the row's source.
--      pec_appointments.created_by_label caches the booking actor on the
--      row so the calendar can say "Booked by ..." without a join.
--   3. Settings: booking_block_crew_holidays ('true': pec_prod_holidays also
--      close online booking) and appt_default_duration_minutes ('45': the
--      staff form's default length; end time follows the start).
--
-- Rule 14: book_appointment_slot and the trigger functions are SECURITY
-- DEFINER, so this file was rehearsed in a rolled-back prod transaction
-- (begin; <this file>; verification; raise) before the real apply. Idempotent.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1) Blocked days (days off) for the appointment calendar
-- ---------------------------------------------------------------------------
create table if not exists public.pec_appointment_blocked_days (
  id uuid primary key default gen_random_uuid(),
  start_date date not null,
  end_date date not null,
  -- null = the whole company (every rep); set = only that rep is off.
  sales_member_id uuid references public.pec_sales_team_members(id) on delete cascade,
  reason text,
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pec_appt_blocked_days_range_check check (end_date >= start_date)
);
create index if not exists idx_pec_appt_blocked_days_range
  on public.pec_appointment_blocked_days (start_date, end_date);

alter table public.pec_appointment_blocked_days enable row level security;
drop policy if exists pec_appt_blocked_days_staff on public.pec_appointment_blocked_days;
create policy pec_appt_blocked_days_staff on public.pec_appointment_blocked_days for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop trigger if exists trg_pec_appt_blocked_days_touch on public.pec_appointment_blocked_days;
create trigger trg_pec_appt_blocked_days_touch
  before update on public.pec_appointment_blocked_days
  for each row execute function public.pec_prod_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2) Actor resolution shared by the stamp trigger and the audit trigger
-- ---------------------------------------------------------------------------
alter table public.pec_appointments add column if not exists created_by_label text;

-- Who is making this write? Returns {uid, label}. Order of trust:
--   a. auth.uid() (a signed-in staff session through supabase-js / RLS)
--      -> admin_users name, else email, else the JWT email.
--   b. set_config('topcoat.actor', ...) placed by a server function inside
--      the same transaction (book_appointment_slot does this).
--   c. The x-topcoat-actor request header (server functions writing through
--      PostgREST with the service role: /book manage, Routemize, Google pull).
--   d. The row's source: booking -> the customer, routemize, google, else
--      'System'.
create or replace function public.pec_appt_actor(p_source text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_label text;
  v_claims jsonb;
  v_headers jsonb;
begin
  if v_uid is not null then
    select coalesce(nullif(name, ''), nullif(email, '')) into v_label
      from public.admin_users where auth_user_id = v_uid limit 1;
    if v_label is null then
      begin
        v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
        v_label := v_claims->>'email';
      exception when others then v_label := null; end;
    end if;
    return jsonb_build_object('uid', v_uid, 'label', coalesce(v_label, 'Staff'));
  end if;

  v_label := nullif(current_setting('topcoat.actor', true), '');
  if v_label is null then
    begin
      v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
      v_label := nullif(v_headers->>'x-topcoat-actor', '');
    exception when others then v_label := null; end;
  end if;
  if v_label is null then
    v_label := case p_source
      when 'booking'   then 'Customer (online booking)'
      when 'routemize' then 'Routemize booking'
      when 'google'    then 'Google Calendar sync'
      else 'System' end;
  end if;
  return jsonb_build_object('uid', null, 'label', left(v_label, 120));
end;
$$;

revoke all on function public.pec_appt_actor(text) from public, anon;

-- BEFORE INSERT: stamp created_by (when the client did not) and the label.
create or replace function public.pec_appointments_stamp_actor()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor jsonb := public.pec_appt_actor(new.source);
begin
  if new.created_by is null and (v_actor->>'uid') is not null then
    new.created_by := (v_actor->>'uid')::uuid;
  end if;
  if new.created_by_label is null then
    new.created_by_label := v_actor->>'label';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pec_appointments_stamp_actor on public.pec_appointments;
create trigger trg_pec_appointments_stamp_actor
  before insert on public.pec_appointments
  for each row execute function public.pec_appointments_stamp_actor();

-- AFTER INSERT / UPDATE / DELETE: one audit_log row per meaningful change.
-- Sync stamps (google_*, salesask_*, updated_at, booking_manage_token...) are
-- NOT tracked, so the reminder runner and the Google push never spam the log.
create or replace function public.pec_appointments_audit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor jsonb;
  v_action text;
  v_before jsonb := null;
  v_after jsonb := null;
  v_row public.pec_appointments;
  tracked text[] := array['start_at','end_at','all_day','status','sales_member_id','appt_type',
                          'customer_id','lead_id','title','location_address','location_city','location_zip'];
  k text;
  v_old jsonb;
  v_new jsonb;
  v_changed boolean := false;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  v_actor := public.pec_appt_actor(v_row.source);

  if tg_op = 'INSERT' then
    v_action := 'created';
    v_new := to_jsonb(new);
    v_after := '{}'::jsonb;
    foreach k in array tracked loop v_after := v_after || jsonb_build_object(k, v_new->k); end loop;
  elsif tg_op = 'DELETE' then
    v_action := 'deleted';
    v_old := to_jsonb(old);
    v_before := '{}'::jsonb;
    foreach k in array tracked loop v_before := v_before || jsonb_build_object(k, v_old->k); end loop;
  else
    v_old := to_jsonb(old); v_new := to_jsonb(new);
    v_before := '{}'::jsonb; v_after := '{}'::jsonb;
    foreach k in array tracked loop
      if (v_old->k) is distinct from (v_new->k) then
        v_changed := true;
        v_before := v_before || jsonb_build_object(k, v_old->k);
        v_after := v_after || jsonb_build_object(k, v_new->k);
      end if;
    end loop;
    if not v_changed then return null; end if;
    if old.status is distinct from new.status then
      v_action := case new.status
        when 'canceled' then 'canceled'
        when 'completed' then 'completed'
        when 'scheduled' then 'restored'
        else 'status_change' end;
    elsif old.start_at is distinct from new.start_at or old.end_at is distinct from new.end_at
          or old.all_day is distinct from new.all_day then
      v_action := 'rescheduled';
    elsif old.sales_member_id is distinct from new.sales_member_id then
      v_action := 'reassigned';
    else
      v_action := 'updated';
    end if;
  end if;

  insert into public.audit_log (auth_user_id, admin_email, action, entity_type, entity_id, before_json, after_json)
  values (
    nullif(v_actor->>'uid', '')::uuid,
    v_actor->>'label',
    v_action,
    'pec_appointments',
    v_row.id,
    v_before,
    coalesce(v_after, '{}'::jsonb) || jsonb_build_object('actor_label', v_actor->>'label', 'source', v_row.source, 'title', v_row.title)
  );
  return null;
end;
$$;

drop trigger if exists trg_pec_appointments_audit on public.pec_appointments;
create trigger trg_pec_appointments_audit
  after insert or update or delete on public.pec_appointments
  for each row execute function public.pec_appointments_audit();

create index if not exists idx_audit_log_appointments
  on public.audit_log (entity_id, created_at desc)
  where entity_type = 'pec_appointments';

-- ---------------------------------------------------------------------------
-- 3) book_appointment_slot: blocked-day fence + actor label
-- ---------------------------------------------------------------------------
-- The signature gains p_actor, so the 4-arg version must go first (CREATE OR
-- REPLACE with a different argument list would add an overload, not replace).
drop function if exists public.book_appointment_slot(jsonb, integer, integer, uuid);

create or replace function public.book_appointment_slot(
  p_row jsonb,
  p_buffer_before_minutes integer default 30,
  p_buffer_after_minutes integer default 30,
  p_reschedule_id uuid default null,
  p_actor text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_member uuid := nullif(p_row->>'sales_member_id', '')::uuid;
  v_start timestamptz := nullif(p_row->>'start_at', '')::timestamptz;
  v_end timestamptz := nullif(p_row->>'end_at', '')::timestamptz;
  v_local_date date;
  v_conflicts integer;
  v_blocked boolean := false;
  v_id uuid;
begin
  if v_start is null or v_end is null or v_end <= v_start then
    return jsonb_build_object('ok', false, 'error', 'bad_times');
  end if;

  v_local_date := (v_start at time zone 'America/Phoenix')::date;
  perform pg_advisory_xact_lock(
    hashtextextended(coalesce(v_member::text, 'unassigned') || ':' || v_local_date::text, 42));

  -- Days off: a company-wide or same-rep block on the target Phoenix date,
  -- plus crew holidays while booking_block_crew_holidays is not 'false'.
  select exists (
    select 1 from public.pec_appointment_blocked_days b
    where b.start_date <= v_local_date and b.end_date >= v_local_date
      and (b.sales_member_id is null or v_member is null or b.sales_member_id = v_member)
  ) into v_blocked;
  if not v_blocked
     and coalesce((select value from public.settings where key = 'booking_block_crew_holidays' limit 1), 'true') <> 'false' then
    select exists (select 1 from public.pec_prod_holidays h where h.holiday_date = v_local_date) into v_blocked;
  end if;
  if v_blocked then
    return jsonb_build_object('ok', false, 'taken', true, 'blocked', true);
  end if;

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

  -- Who this write is attributed to in the audit trail. Transaction-local,
  -- and cleared again below so a later statement in the same transaction
  -- (only a test harness ever has one) is not mislabeled.
  perform set_config('topcoat.actor', coalesce(nullif(p_actor, ''), 'Customer (online booking)'), true);

  if p_reschedule_id is not null then
    update public.pec_appointments
      set start_at = v_start, end_at = v_end, updated_at = now()
      where id = p_reschedule_id and status = 'scheduled'
      returning id into v_id;
    if v_id is null then
      perform set_config('topcoat.actor', '', true);
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

  perform set_config('topcoat.actor', '', true);
  return jsonb_build_object('ok', true, 'appointment_id', v_id);
end;
$$;

revoke all on function public.book_appointment_slot(jsonb, integer, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.book_appointment_slot(jsonb, integer, integer, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4) Settings (insert-only; an existing value is never overwritten)
-- ---------------------------------------------------------------------------
insert into public.settings (key, value)
select k, v from (values
  ('booking_block_crew_holidays', 'true'),
  ('appt_default_duration_minutes', '45')
) as s(k, v)
where not exists (select 1 from public.settings where settings.key = s.k);

commit;

-- Verify after running:
--   select count(*) from public.pec_appointment_blocked_days;                     -- 0 (UI seeds)
--   select tgname from pg_trigger where tgrelid = 'public.pec_appointments'::regclass
--     and not tgisinternal;   -- trg_pec_appointments_touch, _stamp_actor, _audit
--   select pg_get_function_arguments('public.book_appointment_slot'::regproc);   -- 5 args
--   select key, value from public.settings
--     where key in ('booking_block_crew_holidays','appt_default_duration_minutes');
