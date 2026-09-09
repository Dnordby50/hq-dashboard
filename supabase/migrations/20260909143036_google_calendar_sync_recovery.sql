-- @artifacts
--   column: public.pec_sales_member_google_calendars.pull_state
--   column: public.pec_sales_member_google_calendars.pull_version
--   column: public.pec_sales_member_google_calendars.last_attempt_at
--   column: public.pec_sales_member_google_calendars.last_full_synced_at
--   column: public.pec_sales_member_google_calendars.lease_id
--   column: public.pec_sales_member_google_calendars.lease_until
--   setting: google_booking_max_sync_age_minutes
-- @end
-- Resumable Google calendar imports and a booking check on completed syncs.
-- The existing private ledger retains its RLS/default-deny boundary. Only
-- safe status fields are appended to the existing dashboard view; continuation
-- tokens, the original query, seen IDs and leases never reach that view.
-- The booking RPC keeps its service-role-only grant and existing day lock.
-- Rehearse the complete migration and behavioral checks with BEGIN/ROLLBACK
-- before applying, because the RPC is SECURITY DEFINER.

alter table public.pec_sales_member_google_calendars
  add column if not exists pull_state jsonb,
  add column if not exists pull_version integer not null default 0,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_full_synced_at timestamptz,
  add column if not exists lease_id uuid,
  add column if not exists lease_until timestamptz;

create or replace view public.pec_member_google_calendars_v as
  select id, member_id, calendar_id, summary, access_role,
         sync_enabled, last_synced_at, last_error, updated_at,
         last_attempt_at, last_full_synced_at, pull_version,
         (pull_state is not null) as sync_in_progress
  from public.pec_sales_member_google_calendars;

-- Preserve the existing view's read-only audience. No table policies/grants
-- are changed, and new worker state is intentionally absent from the view.
revoke all on public.pec_member_google_calendars_v from anon;
grant select on public.pec_member_google_calendars_v to authenticated, service_role;

insert into public.settings (key, value)
select 'google_booking_max_sync_age_minutes', '45'
where not exists (
  select 1 from public.settings where key = 'google_booking_max_sync_age_minutes'
);

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
begin
  if v_start is null or v_end is null or v_end <= v_start then
    return jsonb_build_object('ok', false, 'error', 'bad_times');
  end if;

  v_local_date := (v_start at time zone 'America/Phoenix')::date;
  perform pg_advisory_xact_lock(
    hashtextextended(coalesce(v_member::text, 'unassigned') || ':' || v_local_date::text, 42));

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
