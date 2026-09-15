-- @artifacts
--   table: public.pec_security_rate_limits
--   index: pec_security_rate_limits_expiry_idx
--   setting: booking_slots_rate_limit_per_hour
--   setting: booking_routes_rate_limit_per_day
-- @end
-- Staff session boundaries, immutable payment audit events and server quotas.
-- Rehearsed as a rollback-only transaction before production application.
-- No MFA enrollment/assurance requirement is introduced by this migration.

create schema if not exists topcoat_security_private;
revoke all on schema topcoat_security_private from public, anon, authenticated;
grant usage on schema topcoat_security_private to authenticated, service_role;

create or replace function topcoat_security_private.staff_session_valid()
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.admin_users a
    join auth.users u on u.id = a.auth_user_id
    join auth.sessions s on s.user_id = u.id
    where a.auth_user_id = (select auth.uid())
      and a.login_revoked_at is null
      and u.email_confirmed_at is not null
      and (u.banned_until is null or u.banned_until <= now())
      and s.id::text = (select auth.jwt()->>'session_id')
      and (s.not_after is null or s.not_after > now())
  );
$$;
revoke all on function topcoat_security_private.staff_session_valid() from public, anon, authenticated, service_role;
grant execute on function topcoat_security_private.staff_session_valid() to authenticated, service_role;

-- Preserve helper signatures and their anon EXECUTE: anonymous table reads
-- evaluate these predicates and must receive false rather than a grant error.
create or replace function public.is_admin_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select topcoat_security_private.staff_session_valid();
$$;
create or replace function public.is_admin_role()
returns boolean language sql stable security definer set search_path = '' as $$
  select topcoat_security_private.staff_session_valid() and exists (
    select 1 from public.admin_users where auth_user_id = (select auth.uid()) and role = 'admin'
  );
$$;
create or replace function public.has_permission(p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select topcoat_security_private.staff_session_valid() and (
    public.is_admin_role() or coalesce((
      select case p_perm
        when 'can_move_pipeline' then up.can_move_pipeline
        when 'can_view_job_costing' then up.can_view_job_costing
        when 'can_override_status' then up.can_override_status
        when 'can_view_commission' then up.can_view_commission
        when 'can_edit_catalog' then up.can_edit_catalog
        when 'can_manage_team' then up.can_manage_team
        when 'can_manage_settings' then up.can_manage_settings
        when 'can_finalize_costing' then up.can_finalize_costing
        else false end
      from public.user_permissions up
      join public.admin_users a on a.id = up.admin_user_id
      where a.auth_user_id = (select auth.uid()) limit 1
    ), false)
  );
$$;

-- Netlify invokes this with the user's validated Bearer JWT. Never accept a
-- caller-supplied user or session id as an argument on an exposed RPC.
create or replace function public.pec_staff_session()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',a.id,'auth_user_id',a.auth_user_id,
    'email',a.email,'name',a.name,'role',a.role,'company',a.company)
  from public.admin_users a
  where a.auth_user_id=(select auth.uid()) and topcoat_security_private.staff_session_valid()
  limit 1;
$$;
revoke all on function public.pec_staff_session() from public, anon, authenticated, service_role;
grant execute on function public.pec_staff_session() to authenticated;

-- WITH CHECK does not apply to DELETE. Separate command policies make the
-- existing admin-only mutation intent explicit for every write.
drop policy if exists settings_staff on public.settings;
create policy settings_staff_select on public.settings
  for select to authenticated using (public.is_admin_staff());
create policy settings_admin_insert on public.settings
  for insert to authenticated with check (public.is_admin_role());
create policy settings_admin_update on public.settings
  for update to authenticated using (public.is_admin_role()) with check (public.is_admin_role());
create policy settings_admin_delete on public.settings
  for delete to authenticated using (public.is_admin_role());
-- The existing restrictive owner_settings_boundary remains in force.

-- The worker table stays default-deny. This safe, private function is the only
-- deliberate RLS bypass; its view is SECURITY INVOKER and reveals no tokens.
create or replace function topcoat_security_private.google_calendar_metadata()
returns table (
  id uuid, member_id uuid, calendar_id text, summary text, access_role text,
  sync_enabled boolean, last_synced_at timestamptz, last_error text,
  updated_at timestamptz, last_attempt_at timestamptz,
  last_full_synced_at timestamptz, pull_version integer, sync_in_progress boolean
) language sql stable security definer set search_path = '' as $$
  select c.id,c.member_id,c.calendar_id,c.summary,c.access_role,c.sync_enabled,
    c.last_synced_at,c.last_error,c.updated_at,c.last_attempt_at,
    c.last_full_synced_at,c.pull_version,c.pull_state is not null
  from public.pec_sales_member_google_calendars c
  where public.is_admin_staff();
$$;
revoke all on function topcoat_security_private.google_calendar_metadata() from public, anon, authenticated, service_role;
grant execute on function topcoat_security_private.google_calendar_metadata() to authenticated, service_role;
create or replace view public.pec_member_google_calendars_v
with (security_invoker=true) as
  select * from topcoat_security_private.google_calendar_metadata();
revoke all on public.pec_member_google_calendars_v from public, anon;
grant select on public.pec_member_google_calendars_v to authenticated, service_role;

-- Existing payment corrections remain possible for the same authorized roles.
-- Every real change now commits its audit event atomically, including raw
-- PostgREST mutations and service-side Stripe events. Audit failure rolls back
-- the payment. A no-op retry does not create another event.
create or replace function topcoat_security_private.audit_payment_mutation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  before_row jsonb;
  after_row jsonb;
  actor_email text;
  payment_id uuid;
begin
  if TG_OP='UPDATE' and to_jsonb(OLD)=to_jsonb(NEW) then return NEW; end if;
  if TG_OP <> 'INSERT' then before_row:=to_jsonb(OLD); payment_id:=OLD.id; end if;
  if TG_OP <> 'DELETE' then after_row:=to_jsonb(NEW); payment_id:=NEW.id; end if;
  select a.email into actor_email from public.admin_users a where a.auth_user_id=auth.uid() limit 1;
  insert into public.audit_log(auth_user_id,admin_email,action,entity_type,entity_id,before_json,after_json)
  values(auth.uid(),actor_email,'payment_'||lower(TG_OP),'pec_payments',payment_id,before_row,after_row);
  if TG_OP='DELETE' then return OLD; end if;
  return NEW;
end;
$$;
revoke all on function topcoat_security_private.audit_payment_mutation() from public, anon, authenticated, service_role;
drop trigger if exists pec_payment_audit on public.pec_payments;
create trigger pec_payment_audit after insert or update or delete on public.pec_payments
for each row execute function topcoat_security_private.audit_payment_mutation();

-- This table stores only caller-generated hashes and counters, never raw IPs,
-- customer tokens or request bodies. Atomic row conflict locking covers
-- concurrent server instances; denial does not prolong the window.
create table public.pec_security_rate_limits (
  scope text not null check (length(scope) between 1 and 80),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  hits integer not null check (hits>0),
  window_started_at timestamptz not null,
  expires_at timestamptz not null,
  primary key(scope,key_hash)
);
create index pec_security_rate_limits_expiry_idx on public.pec_security_rate_limits(expires_at);
alter table public.pec_security_rate_limits enable row level security;
revoke all on public.pec_security_rate_limits from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.pec_security_rate_limits to service_role;

create or replace function public.pec_take_rate_limit(
  p_scope text,p_key text,p_limit integer,p_window_seconds integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  now_at timestamptz:=clock_timestamp();
  used integer;
  ends_at timestamptz;
begin
  if p_scope is null or length(p_scope) not between 1 and 80
    or p_key is null or p_key !~ '^[0-9a-f]{64}$'
    or p_limit is null or p_limit not between 1 and 1000000
    or p_window_seconds is null or p_window_seconds not between 1 and 86400 then
    raise exception 'Invalid rate limit arguments' using errcode='22023';
  end if;
  -- Bounded opportunistic cleanup avoids retaining old IP hashes indefinitely.
  delete from public.pec_security_rate_limits where ctid in (
    select ctid from public.pec_security_rate_limits
    where expires_at < now_at - interval '1 day' order by expires_at limit 100
  );
  insert into public.pec_security_rate_limits as limits
    (scope,key_hash,hits,window_started_at,expires_at)
  values(p_scope,p_key,1,now_at,now_at+make_interval(secs=>p_window_seconds))
  on conflict(scope,key_hash) do update
    set hits=case when limits.expires_at<=now_at then 1 else limits.hits+1 end,
        window_started_at=case when limits.expires_at<=now_at then now_at else limits.window_started_at end,
        expires_at=case when limits.expires_at<=now_at then now_at+make_interval(secs=>p_window_seconds) else limits.expires_at end
    where limits.expires_at<=now_at or limits.hits<p_limit
  returning hits,expires_at into used,ends_at;
  if found then
    return jsonb_build_object('allowed',true,'remaining',greatest(0,p_limit-used),'retry_after',0);
  end if;
  select expires_at into ends_at from public.pec_security_rate_limits
    where scope=p_scope and key_hash=p_key;
  return jsonb_build_object('allowed',false,'remaining',0,
    'retry_after',greatest(1,ceil(extract(epoch from (ends_at-now_at)))::integer));
end;
$$;
revoke all on function public.pec_take_rate_limit(text,text,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.pec_take_rate_limit(text,text,integer,integer) to service_role;

insert into public.settings(key,value) values
  ('booking_slots_rate_limit_per_hour','60'),('booking_routes_rate_limit_per_day','200')
on conflict(key) do nothing;

-- Photo URLs and bucket visibility stay compatible; future uploads are bounded.
update storage.buckets set file_size_limit=20971520,
  allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif']
where id='pec-photos';

-- These privileges are not used by PostgREST CRUD. Explicitly remove the
-- ability to install triggers or truncate through any future SQL bridge.
revoke truncate,references,trigger on all tables in schema public from anon,authenticated;
-- Future migrations must opt public clients into each table/function. Existing
-- grants remain intact; service_role defaults and normal staff CRUD remain.
alter default privileges for role postgres in schema public revoke all on tables from anon,authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon,authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from anon,authenticated;
alter default privileges for role postgres revoke execute on functions from public;
