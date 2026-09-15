-- Run only inside BEGIN/ROLLBACK, after the staff-boundaries migration.
-- Never commits or touches customer/job/payment rows.
create temporary table security_rehearsal_results(check_name text,passed boolean) on commit drop;

do $test$
declare
  s record;
  sample_uid uuid;
  sample_sid uuid;
  fixture_setting text:='security_rehearsal_'||replace(gen_random_uuid()::text,'-','');
  n integer;
begin
  for s in
    select a.auth_user_id,u.id,ses.id as session_id from public.admin_users a
    join auth.users u on u.id=a.auth_user_id join auth.sessions ses on ses.user_id=u.id
    where a.login_revoked_at is null and u.email_confirmed_at is not null
      and (u.banned_until is null or u.banned_until<=now())
      and (ses.not_after is null or ses.not_after>now())
  loop
    perform set_config('request.jwt.claims',jsonb_build_object('sub',s.auth_user_id,'session_id',s.session_id,'role','authenticated')::text,true);
    if not public.is_admin_staff() then raise exception 'Existing active session rejected'; end if;
    sample_uid:=s.auth_user_id; sample_sid:=s.session_id;
  end loop;
  if sample_uid is null then raise exception 'No active staff session available for rehearsal'; end if;
  insert into security_rehearsal_results values('existing active staff sessions accepted',true);

  perform set_config('request.jwt.claims',jsonb_build_object('sub',sample_uid,'role','authenticated')::text,true);
  if public.is_admin_staff() then raise exception 'Missing session accepted'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sample_uid,'session_id',gen_random_uuid(),'role','authenticated')::text,true);
  if public.is_admin_staff() then raise exception 'Stale session accepted'; end if;
  insert into security_rehearsal_results values('missing and nonexistent sessions denied',true);

  perform set_config('request.jwt.claims',jsonb_build_object('sub',sample_uid,'session_id',sample_sid,'role','authenticated')::text,true);
  -- Auth mutations are transaction-local; the whole rehearsal rolls back.
  update public.admin_users set login_revoked_at=now() where auth_user_id=sample_uid;
  if public.is_admin_staff() or public.is_admin_role() or public.has_permission('can_edit_catalog') then raise exception 'Revoked staff accepted'; end if;
  update public.admin_users set login_revoked_at=null where auth_user_id=sample_uid;
  insert into security_rehearsal_results values('revocation denied by staff role and permission helpers',true);

  -- Retain existing role value via a subtransaction that always rolls back.
  begin
    update public.admin_users set role='pm' where auth_user_id=sample_uid;
    insert into public.settings(key,value) values(fixture_setting,'fixture');
    execute 'set local role authenticated';
    delete from public.settings where key=fixture_setting;
    get diagnostics n=row_count;
    if n<>0 then raise exception 'Nonadmin deleted settings'; end if;
    execute 'reset role';
    if not exists(select 1 from public.settings where key=fixture_setting) then raise exception 'Setting was deleted'; end if;
    raise exception 'rollback role fixture' using errcode='P0002';
  exception when no_data_found then null;
  end;
  insert into security_rehearsal_results values('nonadmin settings deletion denied',true);

  perform set_config('request.jwt.claims','{}',true);
  execute 'set local role authenticated';
  select count(*) into n from public.pec_member_google_calendars_v;
  execute 'reset role';
  if n<>0 then raise exception 'Nonstaff read calendar metadata'; end if;
  insert into security_rehearsal_results values('nonstaff calendar metadata denied',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sample_uid,'session_id',sample_sid,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  if public.pec_staff_session()->>'auth_user_id' is distinct from sample_uid::text then raise exception 'Staff RPC identity mismatch'; end if;
  execute 'reset role';
  insert into security_rehearsal_results values('caller JWT staff RPC accepted',true);
end;
$test$;

create temporary table security_payment_fixture(id uuid primary key,amount numeric,job_id uuid) on commit drop;
create trigger fixture_payment_audit after insert or update or delete on security_payment_fixture
for each row execute function topcoat_security_private.audit_payment_mutation();
do $test$
declare fixture_id uuid:=gen_random_uuid(); n integer;
begin
  insert into security_payment_fixture values(fixture_id,1.25,gen_random_uuid());
  update security_payment_fixture set amount=2.5 where id=fixture_id;
  update security_payment_fixture set amount=2.5 where id=fixture_id;
  delete from security_payment_fixture where id=fixture_id;
  select count(*) into n from public.audit_log where entity_id=fixture_id and entity_type='pec_payments';
  if n<>3 then raise exception 'Expected 3 audit events, got %',n; end if;
  if not exists(select 1 from public.audit_log where entity_id=fixture_id and action='payment_update' and before_json->>'amount'='1.25' and after_json->>'amount'='2.5') then raise exception 'Payment snapshots missing'; end if;
  insert into security_rehearsal_results values('payment insert/update/delete audited and no-op deduplicated',true);
end;
$test$;

do $test$
declare k text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'); a jsonb;b jsonb;c jsonb;
begin
  execute 'set local role service_role';
  a:=public.pec_take_rate_limit('rehearsal',k,2,60);
  b:=public.pec_take_rate_limit('rehearsal',k,2,60);
  c:=public.pec_take_rate_limit('rehearsal',k,2,60);
  execute 'reset role';
  if a->>'allowed'<>'true' or b->>'allowed'<>'true' or c->>'allowed'<>'false' or (c->>'retry_after')::int<1 then raise exception 'Rate limiter failed'; end if;
  update public.pec_security_rate_limits set expires_at=now()-interval '1 second' where scope='rehearsal' and key_hash=k;
  a:=public.pec_take_rate_limit('rehearsal',k,2,60);
  if a->>'allowed'<>'true' or a->>'remaining'<>'1' then raise exception 'Rate limiter reset failed'; end if;
  begin
    execute 'set local role authenticated';
    perform public.pec_take_rate_limit('rehearsal',k,2,60);
    raise exception 'Authenticated role called server limiter';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  insert into security_rehearsal_results values('atomic rate quota deny reset and grants verified',true);
end;
$test$;

select check_name,passed from security_rehearsal_results order by check_name;
