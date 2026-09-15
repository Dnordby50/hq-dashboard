-- Run inside BEGIN/ROLLBACK after the portal migration. All tokens are fabricated;
-- no customer/job/payment records are written by these negative requests.
do $test$
declare error_seen boolean;
begin
  execute 'set local role anon';
  error_seen:=false;
  begin
    perform public.portal_confirm_job(repeat('x',64),gen_random_uuid(),repeat('x',2097153),null);
  exception when others then
    if SQLERRM not like '%valid PNG%' then raise; end if; error_seen:=true;
  end;
  if not error_seen then raise exception 'Oversized signature accepted'; end if;

  error_seen:=false;
  begin
    perform public.portal_set_area_colors(repeat('x',64),gen_random_uuid(),jsonb_build_array(jsonb_build_object('invalid',repeat('x',70000))));
  exception when others then
    if SQLERRM not like '%Invalid color selections%' then raise; end if; error_seen:=true;
  end;
  if not error_seen then raise exception 'Oversized picks accepted'; end if;

  error_seen:=false;
  begin
    perform public.portal_submit_review(repeat('x',64),gen_random_uuid(),5,repeat('x',10001));
  exception when others then
    if SQLERRM not like '%Invalid review%' then raise; end if; error_seen:=true;
  end;
  if not error_seen then raise exception 'Oversized review accepted'; end if;

  error_seen:=false;
  begin
    perform public.portal_submit_referral(repeat('x',64),repeat('x',301),null,null,null);
  exception when others then
    if SQLERRM not like '%Invalid referral%' then raise; end if; error_seen:=true;
  end;
  if not error_seen then raise exception 'Oversized referral accepted'; end if;

  error_seen:=false;
  begin
    perform public.portal_submit_review(repeat('x',64),gen_random_uuid(),5,'fixture');
  exception when others then
    if SQLERRM not like '%Job not found%' then raise; end if; error_seen:=true;
  end;
  if not error_seen then raise exception 'Invalid token accepted'; end if;

  error_seen:=false;
  begin
    perform topcoat_security_private.portal_submit_review(repeat('x',64),gen_random_uuid(),5,'fixture');
  exception when insufficient_privilege then error_seen:=true;
  end;
  if not error_seen then raise exception 'Original implementation still directly callable'; end if;
  execute 'reset role';
end;
$test$;
select
  position('row_to_json(v_customer)' in pg_get_functiondef('public.get_portal_data(text)'::regprocedure))=0 as customer_projection_explicit,
  not has_function_privilege('authenticated','topcoat_security_private.portal_confirm_job(text,uuid,text,jsonb)','EXECUTE') as private_original_not_callable,
  has_function_privilege('anon','public.portal_confirm_job(text,uuid,text,jsonb)','EXECUTE') as public_signature_preserved,
  true as oversized_payloads_invalid_tokens_and_private_access_denied;
