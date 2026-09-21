-- @artifacts
--   column: public.pec_sales_team_members.bookable_online
--   table: public.pec_appointment_assignment_log
--   index: idx_pec_appt_assignment_log_appt
--   setting: booking_primary_member_id
--   setting: booking_assignment_mode
--   setting: booking_require_google_connected
-- @end
-- ============================================================================
-- 2026-09-21 (prompt 105): online booking rep eligibility + primary rep.
-- Author: Claude Code.
--
-- WHY (the bug, verified on live prod 2026-09-21): the booking engine treated
-- EVERY active pec_sales_team_members row as bookable. Dusty Wilson was added
-- to the roster on 2026-09-15 (active, no Google calendar, zero appointments)
-- so she read as free all day, and on 2026-09-17 a customer self-booked
-- 10:00 AM over Dylan's 10:15 site visit. The slot only existed because of
-- Dusty. Roster `active` was doing three jobs (selectable as salesperson,
-- commission, online booking eligibility); this migration splits online
-- booking eligibility out so Dusty stays selectable as a salesperson (she
-- handles phone quotes) without ever being offered to the public.
--
-- WHAT:
--   1. pec_sales_team_members.bookable_online (default FALSE, forever): being
--      bookable is an explicit choice made in Settings > People. The data
--      step sets it true for Dylan only (id 2add1f35-...), matched by id.
--   2. Settings (insert-only): booking_primary_member_id (Dylan),
--      booking_assignment_mode ('primary_first' | 'primary_only' |
--      'round_robin') and booking_require_google_connected ('true': a rep
--      with no connected Google Calendar cannot be bookable).
--   3. pec_appointment_assignment_log + an AFTER INSERT OR UPDATE OF
--      sales_member_id trigger on pec_appointments, so every change of the
--      assigned rep is logged whatever wrote it (booking, intake, UI,
--      Google sync). The booking write passes its reason through p_row
--      ('assignment_reason' -> the transaction GUC topcoat.assignment_reason).
--   4. book_appointment_slot re-checks, INSIDE the advisory lock, that the
--      assigned rep is still eligible (active + bookable_online + Google
--      rule), so a toggle flipped between the slot read and the write can
--      never land a booking on a rep who is no longer bookable.
--
-- Rule 14: SECURITY DEFINER function + trigger, rehearsed in a rolled-back
-- prod transaction before the real apply. Idempotent.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1) The eligibility flag. Default false: new roster rows are never bookable
--    until someone switches them on.
-- ---------------------------------------------------------------------------
alter table public.pec_sales_team_members
  add column if not exists bookable_online boolean not null default false;

-- Data step: Dylan is the only rep who does on-site estimates today.
update public.pec_sales_team_members
   set bookable_online = true
 where id = '2add1f35-c46f-4931-8220-e5ba14939e3f'
   and bookable_online = false;

-- ---------------------------------------------------------------------------
-- 2) Settings (insert-only; an existing value is never overwritten)
-- ---------------------------------------------------------------------------
insert into public.settings (key, value)
select k, v from (values
  ('booking_primary_member_id', '2add1f35-c46f-4931-8220-e5ba14939e3f'),
  ('booking_assignment_mode', 'primary_first'),
  ('booking_require_google_connected', 'true')
) as s(k, v)
where not exists (select 1 from public.settings where settings.key = s.k);

-- ---------------------------------------------------------------------------
-- 3) Assignment log
-- ---------------------------------------------------------------------------
create table if not exists public.pec_appointment_assignment_log (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.pec_appointments(id) on delete cascade,
  from_member_id uuid,
  to_member_id uuid,
  changed_by uuid,
  changed_by_label text,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists idx_pec_appt_assignment_log_appt
  on public.pec_appointment_assignment_log (appointment_id, created_at desc);

-- RLS in the pec_appointments shape (is_admin_staff), read-only for the
-- browser: the trigger is the only writer, so staff never need INSERT /
-- UPDATE / DELETE on a log (same stance as audit_log).
alter table public.pec_appointment_assignment_log enable row level security;
drop policy if exists pec_appt_assignment_log_staff_read on public.pec_appointment_assignment_log;
create policy pec_appt_assignment_log_staff_read on public.pec_appointment_assignment_log
  for select using (public.is_admin_staff());
revoke all on public.pec_appointment_assignment_log from public, anon, authenticated;
grant select on public.pec_appointment_assignment_log to authenticated;
grant all on public.pec_appointment_assignment_log to service_role;

-- The trigger. INSERT logs when the row arrives with a rep; UPDATE logs only
-- when sales_member_id actually changed (UPDATE OF fires whenever the column
-- is in the SET list, even unchanged, so the body re-checks). Actor resolves
-- through pec_appt_actor exactly like the audit trail; the reason comes from
-- the transaction GUC (book_appointment_slot), else the x-topcoat-assignment-
-- reason request header (server writers), else a generic op:source tag.
create or replace function public.pec_appointments_assignment_log()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor jsonb;
  v_reason text;
  v_headers jsonb;
begin
  if tg_op = 'INSERT' then
    if new.sales_member_id is null then return null; end if;
  elsif old.sales_member_id is not distinct from new.sales_member_id then
    return null;
  end if;

  v_actor := public.pec_appt_actor(new.source);
  v_reason := nullif(current_setting('topcoat.assignment_reason', true), '');
  if v_reason is null then
    begin
      v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
      v_reason := nullif(v_headers->>'x-topcoat-assignment-reason', '');
    exception when others then v_reason := null; end;
  end if;
  if v_reason is null then
    v_reason := (case when tg_op = 'INSERT' then 'created:' else 'reassigned:' end) || coalesce(new.source, 'topcoat');
  end if;

  insert into public.pec_appointment_assignment_log
    (appointment_id, from_member_id, to_member_id, changed_by, changed_by_label, reason)
  values
    (new.id,
     case when tg_op = 'INSERT' then null else old.sales_member_id end,
     new.sales_member_id,
     nullif(v_actor->>'uid', '')::uuid,
     v_actor->>'label',
     left(v_reason, 200));
  return null;
end;
$$;

revoke all on function public.pec_appointments_assignment_log() from public, anon, authenticated;

drop trigger if exists trg_pec_appointments_assignment_log on public.pec_appointments;
create trigger trg_pec_appointments_assignment_log
  after insert or update of sales_member_id on public.pec_appointments
  for each row execute function public.pec_appointments_assignment_log();

-- ---------------------------------------------------------------------------
-- 4) book_appointment_slot: eligibility fence inside the lock + the
--    assignment reason. Same 5-argument signature (the reason rides p_row),
--    so no PostgREST overload churn. Body = the live 2026-09-09/09-21
--    definition (Google health, days off, actor label) plus the new block.
-- ---------------------------------------------------------------------------
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
  v_google_max_age numeric := 45;
  v_google_setting text;
  v_google_now timestamptz;
  v_require_google boolean := true;
begin
  if v_start is null or v_end is null or v_end <= v_start then
    return jsonb_build_object('ok', false, 'error', 'bad_times');
  end if;

  v_local_date := (v_start at time zone 'America/Phoenix')::date;
  perform pg_advisory_xact_lock(
    hashtextextended(coalesce(v_member::text, 'unassigned') || ':' || v_local_date::text, 42));

  -- Eligibility (prompt 105), re-checked under the lock: the ASSIGNED rep
  -- must still be active, bookable online, and (unless the setting says
  -- otherwise) Google-connected. A new booking with no rep fails closed; a
  -- reschedule of a legacy unassigned row keeps working (times only).
  v_require_google := coalesce((select value from public.settings where key = 'booking_require_google_connected' limit 1), 'true') <> 'false';
  if v_member is null then
    if p_reschedule_id is null then
      return jsonb_build_object('ok', false, 'taken', true, 'not_bookable', true);
    end if;
  elsif not exists (
    select 1 from public.pec_sales_team_members m
    where m.id = v_member and m.active = true and m.bookable_online = true
      and (m.google_connected = true or not v_require_google)
  ) then
    return jsonb_build_object('ok', false, 'taken', true, 'not_bookable', true);
  end if;

  -- Fail closed when any required Google source is not verified. Read
  -- the clock after acquiring the same per-rep/day lock used for bookings.
  v_google_now := clock_timestamp();
  select value into v_google_setting from public.settings
    where key = 'google_booking_max_sync_age_minutes' limit 1;
  begin
    if nullif(btrim(v_google_setting), '') is not null then
      v_google_max_age := v_google_setting::numeric;
      if v_google_max_age::text in ('NaN', 'Infinity', '-Infinity') then
        v_google_max_age := 45;
      end if;
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    v_google_max_age := 45;
  end;
  v_google_max_age := greatest(15, least(1440, v_google_max_age));

  if exists (
    select 1 from public.pec_sales_team_members m
    where m.id = v_member
      -- Only a member with a Google dependency needs a completed import.
      and (m.google_connected or m.google_needs_reconnect
        or m.google_calendar_id is not null
        or exists (select 1 from public.pec_sales_member_google_calendars c
                   where c.member_id = m.id and c.sync_enabled))
      and (
        not coalesce(m.google_connected, false) or coalesce(m.google_needs_reconnect, false)
        -- A connected member whose source ledger vanished is not verified.
        or not exists (select 1 from public.pec_sales_member_google_calendars c
                       where c.member_id = m.id
                         and (c.sync_enabled or c.calendar_id = m.google_calendar_id))
        -- The dedicated push target is also a required pull source.
        or (m.google_calendar_id is not null and not exists (
          select 1 from public.pec_sales_member_google_calendars c
          where c.member_id = m.id and c.calendar_id = m.google_calendar_id))
        or exists (
          select 1 from public.pec_sales_member_google_calendars c
          where c.member_id = m.id
            and (c.sync_enabled or c.calendar_id = m.google_calendar_id)
            and (c.pull_version < 2
              or nullif(btrim(c.last_error), '') is not null
              or c.last_synced_at is null
              or c.last_synced_at < v_google_now - (v_google_max_age * interval '1 minute')
              or c.last_synced_at > v_google_now + interval '1 minute'
              or (m.google_connected_at is not null and c.last_synced_at < m.google_connected_at))
        )
      )
  ) then
    return jsonb_build_object('ok', false, 'taken', true, 'calendar_unavailable', true);
  end if;

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

  -- Who this write is attributed to in the audit trail, and why this rep
  -- was assigned (the assignment log). Transaction-local, cleared below.
  perform set_config('topcoat.actor', coalesce(nullif(p_actor, ''), 'Customer (online booking)'), true);
  perform set_config('topcoat.assignment_reason', coalesce(nullif(p_row->>'assignment_reason', ''), 'online_booking'), true);

  if p_reschedule_id is not null then
    update public.pec_appointments
      set start_at = v_start, end_at = v_end, updated_at = now()
      where id = p_reschedule_id and status = 'scheduled'
      returning id into v_id;
    if v_id is null then
      perform set_config('topcoat.actor', '', true);
      perform set_config('topcoat.assignment_reason', '', true);
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
  perform set_config('topcoat.assignment_reason', '', true);
  return jsonb_build_object('ok', true, 'appointment_id', v_id);
end;
$$;

revoke all on function public.book_appointment_slot(jsonb, integer, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.book_appointment_slot(jsonb, integer, integer, uuid, text) to service_role;

commit;

-- Verify after running:
--   select name, active, bookable_online, google_connected from public.pec_sales_team_members;
--     -- only Dylan Nordby bookable_online = true
--   select key, value from public.settings
--     where key in ('booking_primary_member_id','booking_assignment_mode','booking_require_google_connected');
--   select tgname from pg_trigger where tgrelid = 'public.pec_appointments'::regclass and not tgisinternal;
--     -- includes trg_pec_appointments_assignment_log
--   select count(*) from public.pec_appointment_assignment_log;   -- 0 until the next assignment
