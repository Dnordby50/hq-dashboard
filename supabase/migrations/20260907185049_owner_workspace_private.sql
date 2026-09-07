-- @artifacts
--   table: public.pec_owner_access
--   table: public.pec_owner_documents
--   table: public.pec_owner_revisions
--   index: pec_owner_revisions_request_idx
--   setting: owner_studio_enabled
--   setting: owner_morning_time
--   setting: owner_morning_days
--   setting: owner_morning_target_minutes
--   setting: owner_weekly_time
--   setting: owner_weekly_day
--   setting: owner_weekly_target_minutes
--   setting: owner_timezone
-- @end
-- Owner Studio: private storage only. No source workbook data in this migration.
-- Rehearse all statements and denial tests in a rolled-back transaction first.
-- Enabling the visible feature is a separate, explicit release step.

create schema if not exists topcoat_owner_private;
revoke all on schema topcoat_owner_private from public, anon;
grant usage on schema topcoat_owner_private to authenticated, service_role;

create table public.pec_owner_access (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.pec_owner_documents (
  auth_user_id uuid not null references public.pec_owner_access(auth_user_id) on delete cascade,
  doc_key text not null check (doc_key ~ '^[a-z][a-z0-9:_-]{0,99}$'),
  revision integer not null check (revision > 0),
  body jsonb not null check (jsonb_typeof(body) = 'object' and octet_length(body::text) <= 2000000),
  updated_at timestamptz not null default now(),
  primary key (auth_user_id, doc_key)
);
create table public.pec_owner_revisions (
  auth_user_id uuid not null,
  doc_key text not null,
  revision integer not null,
  request_id uuid not null,
  body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (auth_user_id, doc_key, revision),
  foreign key (auth_user_id, doc_key) references public.pec_owner_documents(auth_user_id, doc_key) on delete cascade
);
create unique index pec_owner_revisions_request_idx on public.pec_owner_revisions(auth_user_id, request_id);

alter table public.pec_owner_access enable row level security;
alter table public.pec_owner_documents enable row level security;
alter table public.pec_owner_revisions enable row level security;
revoke all on public.pec_owner_access, public.pec_owner_documents, public.pec_owner_revisions from public, anon, authenticated;
grant select on public.pec_owner_access, public.pec_owner_documents, public.pec_owner_revisions to authenticated;
grant select, insert, update on public.pec_owner_access, public.pec_owner_documents to service_role;
grant select, insert on public.pec_owner_revisions to service_role;

-- A trusted entitlement, current staff status, and live session must ALL hold.
-- The private helper bypasses RLS only for this bounded membership lookup.
-- No user-editable metadata, email-only gate, or staff/admin-wide read policy.
create function topcoat_owner_private.allowed() returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.pec_owner_access o
    join public.admin_users a on a.auth_user_id = o.auth_user_id
    join auth.users u on u.id = o.auth_user_id
    join auth.sessions s on s.user_id = o.auth_user_id
    where o.auth_user_id = (select auth.uid()) and o.enabled
      and a.login_revoked_at is null
      and u.email_confirmed_at is not null
      and (u.banned_until is null or u.banned_until < now())
      and s.id::text = (select auth.jwt()->>'session_id')
      and (s.not_after is null or s.not_after > now())
  );
$$;
revoke all on function topcoat_owner_private.allowed() from public, anon, authenticated, service_role;
grant execute on function topcoat_owner_private.allowed() to authenticated, service_role;

create function public.pec_owner_authorized() returns boolean
language sql stable security invoker set search_path = '' as $$
  select topcoat_owner_private.allowed();
$$;
revoke all on function public.pec_owner_authorized() from public, anon;
grant execute on function public.pec_owner_authorized() to authenticated;

create policy owner_access_read on public.pec_owner_access for select to authenticated
  using (auth_user_id = (select auth.uid()) and (select topcoat_owner_private.allowed()));
create policy owner_document_read on public.pec_owner_documents for select to authenticated
  using (auth_user_id = (select auth.uid()) and (select topcoat_owner_private.allowed()));
create policy owner_revision_read on public.pec_owner_revisions for select to authenticated
  using (auth_user_id = (select auth.uid()) and (select topcoat_owner_private.allowed()));

-- Write RPC is service-role-only. Netlify validates the real user's JWT and
-- pec_owner_authorized() before calling it with the derived (not supplied) UID.
-- One lock, compare-and-swap revision, and immutable history in one transaction.
create function public.pec_owner_save_document(
  p_auth_user_id uuid, p_doc_key text, p_expected_revision integer,
  p_request_id uuid, p_body jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare old_doc public.pec_owner_documents;
declare prior public.pec_owner_revisions;
declare next_revision integer;
begin
  if p_auth_user_id is null or p_request_id is null or p_expected_revision is null or p_expected_revision < 0
    or p_doc_key is null or p_doc_key !~ '^[a-z][a-z0-9:_-]{0,99}$'
    or p_body is null or jsonb_typeof(p_body) <> 'object' or octet_length(p_body::text) > 2000000 then
    raise exception 'Invalid owner document' using errcode = '22023';
  end if;
  if not exists (select 1 from public.pec_owner_access o join public.admin_users a on a.auth_user_id = o.auth_user_id
    where o.auth_user_id = p_auth_user_id and o.enabled and a.login_revoked_at is null) then
    raise exception 'Owner access denied' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_auth_user_id::text, 0));
  select * into prior from public.pec_owner_revisions where auth_user_id = p_auth_user_id and request_id = p_request_id;
  if found then
    if prior.doc_key <> p_doc_key or prior.body <> p_body then
      raise exception 'Request ID already used for another write' using errcode = '22023';
    end if;
    return jsonb_build_object('ok', true, 'revision', prior.revision, 'replayed', true);
  end if;
  select * into old_doc from public.pec_owner_documents where auth_user_id = p_auth_user_id and doc_key = p_doc_key for update;
  if coalesce(old_doc.revision, 0) <> p_expected_revision then
    return jsonb_build_object('ok', false, 'conflict', true, 'revision', coalesce(old_doc.revision, 0));
  end if;
  if old_doc.revision is not null and p_doc_key like 'source:%' then
    raise exception 'Imported source snapshots are immutable' using errcode = '22023';
  end if;
  next_revision := p_expected_revision + 1;
  insert into public.pec_owner_documents(auth_user_id, doc_key, revision, body)
    values (p_auth_user_id, p_doc_key, next_revision, p_body)
    on conflict (auth_user_id, doc_key) do update set revision = excluded.revision, body = excluded.body, updated_at = now();
  insert into public.pec_owner_revisions(auth_user_id, doc_key, revision, request_id, body)
    values (p_auth_user_id, p_doc_key, next_revision, p_request_id, p_body);
  return jsonb_build_object('ok', true, 'revision', next_revision, 'replayed', false);
end;
$$;
revoke all on function public.pec_owner_save_document(uuid, text, integer, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.pec_owner_save_document(uuid, text, integer, uuid, jsonb) to service_role;

-- This is a one-time grant to the verified existing owner, never an ongoing
-- name/email authorization rule. Resolve IDs from live records, not literals.
do $$
begin
  if (select count(*) from public.admin_users a join auth.users u on u.id = a.auth_user_id
    where lower(a.email) = 'dylan@prescottepoxy.com' and lower(u.email) = lower(a.email)
      and a.name = 'Dylan Nordby' and a.role = 'admin' and a.login_revoked_at is null and u.email_confirmed_at is not null) <> 1 then
    raise exception 'Expected exactly one verified owner account; no entitlement created';
  end if;
  insert into public.pec_owner_access(auth_user_id)
    select a.auth_user_id from public.admin_users a join auth.users u on u.id = a.auth_user_id
    where lower(a.email) = 'dylan@prescottepoxy.com' and lower(u.email) = lower(a.email)
      and a.name = 'Dylan Nordby' and a.role = 'admin' and a.login_revoked_at is null and u.email_confirmed_at is not null;
end;
$$;

insert into public.settings(key, value) values
  ('owner_studio_enabled', 'false'), ('owner_morning_time', '06:20'),
  ('owner_morning_days', '[1,2,3,4,5]'), ('owner_morning_target_minutes', '10'),
  ('owner_weekly_time', '08:00'), ('owner_weekly_day', '1'),
  ('owner_weekly_target_minutes', '30'), ('owner_timezone', 'America/Phoenix')
on conflict (key) do nothing;

-- Other staff retain their existing settings permissions, but cannot read or
-- alter Owner Studio configuration. State and private content are never settings.
create policy owner_settings_boundary on public.settings as restrictive for all to authenticated
  using (key not like 'owner\_%' escape '\' or (select topcoat_owner_private.allowed()))
  with check (key not like 'owner\_%' escape '\' or (select topcoat_owner_private.allowed()));
