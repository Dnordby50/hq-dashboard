-- @artifacts
--   none: portal function isolation, explicit customer projection and validation
-- @end
-- Preserve legacy portal field names and RPC signatures. Customer-facing UI is
-- unchanged. Original color validation stays in private implementations.
-- A customer token remains the portal credential; this migration does not
-- change link expiry or require account enrollment.
CREATE OR REPLACE FUNCTION public.get_portal_data(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_customer public.customers%rowtype;
  v_jobs jsonb;
  v_referral_reward text;
begin
  select * into v_customer from public.customers where token = p_token and archived_at is null;
  if v_customer.id is null then
    return null;
  end if;

  select value into v_referral_reward from public.settings where key = 'referral_reward_amount';

  select coalesce(jsonb_agg(sub.job_obj order by sub.created_at desc), '[]'::jsonb) into v_jobs
  from (
    select
      j.created_at as created_at,
      jsonb_build_object(
        'id', j.id,
        'type', j.type,
        'status', j.status,
        'address', j.address,
        'package', j.package,
        'price', j.price,
        'warranty', j.warranty,
        'confirmed', j.confirmed,
        'confirmed_at', j.confirmed_at,
        'signature_data', j.signature_data,
        'created_at', j.created_at,
        'colors_confirmed', j.colors_confirmed,
        'install_date', (select pj.install_date from public.pec_prod_jobs pj
                           where pj.dripjobs_deal_id = j.dripjobs_deal_id
                             and pj.install_date is not null
                           order by pj.install_date limit 1),
        'timeline', (select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.sort_order), '[]'::jsonb)
                       from public.timeline_stages t where t.job_id = j.id),
        'colors', (select coalesce(jsonb_agg(jsonb_build_object(
                            'id', jc.id, 'label', jc.label, 'name', c.name, 'type', c.type,
                            'hex', c.hex, 'sku', c.sku, 'swatch_image', c.swatch_image)), '[]'::jsonb)
                     from public.job_colors jc join public.colors c on jc.color_id = c.id
                     where jc.job_id = j.id),
        'photos', (select coalesce(jsonb_agg(row_to_json(p)::jsonb order by p.created_at desc), '[]'::jsonb)
                     from public.photos p where p.job_id = j.id),
        'review', (select row_to_json(r)::jsonb from public.reviews r where r.job_id = j.id limit 1),
        'estimate_signature', (select jsonb_build_object(
                            'estimate_number', e.estimate_number,
                            'signed_name', e.signed_name,
                            'signed_at', e.signed_at,
                            'public_token', e.public_token)
                     from public.estimates e
                     where e.job_id = j.id and e.status = 'accepted'
                       and e.signed_at is not null and e.deleted_at is null
                     order by e.signed_at desc limit 1)
      ) as job_obj
    from public.jobs j
    where j.customer_id = v_customer.id and j.archived_at is null
  ) sub;

  return jsonb_build_object(
    'customer', jsonb_build_object(
      'id',v_customer.id,'name',v_customer.name,'first_name',v_customer.first_name,
      'last_name',v_customer.last_name,'email',v_customer.email,'phone',v_customer.phone,
      'company',v_customer.company,'company_name',v_customer.company_name,
      'billing_address_line1',v_customer.billing_address_line1,
      'billing_address_line2',v_customer.billing_address_line2,
      'billing_city',v_customer.billing_city,'billing_state',v_customer.billing_state,
      'billing_zip',v_customer.billing_zip),
    'jobs', v_jobs,
    'referral_reward_amount', coalesce(v_referral_reward, '50')
  );
end
$function$;

-- Move existing implementations out of the API schema before wrapping them.
do $$
declare signature text;
begin
  foreach signature in array array[
    'portal_confirm_job(text,uuid,text,jsonb)',
    'portal_set_area_colors(text,uuid,jsonb)',
    'portal_submit_review(text,uuid,integer,text)',
    'portal_submit_referral(text,text,text,text,text)',
    'portal_log_view(text,text)'
  ] loop
    if to_regprocedure('topcoat_security_private.'||signature) is null then
      execute 'alter function public.'||signature||' set schema topcoat_security_private';
    end if;
    execute 'revoke all on function topcoat_security_private.'||signature||' from public,anon,authenticated,service_role';
  end loop;
end;
$$;

create or replace function topcoat_security_private.portal_write_limit(p_token text,p_scope text,p_limit integer)
returns void language plpgsql security definer set search_path='' as $$
declare quota jsonb;
begin
  quota:=public.pec_take_rate_limit(p_scope,encode(sha256(convert_to(p_token,'UTF8')),'hex'),p_limit,3600);
  if quota->>'allowed' is distinct from 'true' then
    raise exception 'Too many requests. Please try again later.' using errcode='P0001';
  end if;
end;
$$;
revoke all on function topcoat_security_private.portal_write_limit(text,text,integer) from public,anon,authenticated,service_role;

create or replace function public.portal_confirm_job(p_token text,p_job_id uuid,p_signature text,p_colors jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job_row public.jobs%rowtype;
begin
  if p_token is null or length(p_token) not between 16 and 128 then raise exception 'Invalid token'; end if;
  if p_signature is null or octet_length(p_signature)>2097152
     or p_signature !~ '^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$' then
    raise exception 'A valid PNG signature is required';
  end if;
  if p_colors is not null and (jsonb_typeof(p_colors)<>'array' or octet_length(p_colors::text)>65536) then
    raise exception 'Invalid color selections';
  end if;
  if p_colors is not null and jsonb_array_length(p_colors)>100 then raise exception 'Too many color selections'; end if;
  select j.* into job_row from public.jobs j join public.customers c on c.id=j.customer_id
    where j.id=p_job_id and c.token=p_token and c.archived_at is null
      and j.archived_at is null and j.voided_at is null for update of j;
  if job_row.id is null then raise exception 'Job not found'; end if;
  if job_row.confirmed then
    if job_row.signature_data=p_signature then return jsonb_build_object('ok',true,'job_id',p_job_id); end if;
    raise exception 'Job already confirmed';
  end if;
  perform topcoat_security_private.portal_write_limit(p_token,'portal_confirm',30);
  return topcoat_security_private.portal_confirm_job(p_token,p_job_id,p_signature,p_colors);
end;
$$;

create or replace function public.portal_set_area_colors(p_token text,p_job_id uuid,p_picks jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job_row public.jobs%rowtype;
begin
  if p_token is null or length(p_token) not between 16 and 128 then raise exception 'Invalid token'; end if;
  if p_picks is null or jsonb_typeof(p_picks)<>'array' or octet_length(p_picks::text)>65536 then
    raise exception 'Invalid color selections';
  end if;
  if jsonb_array_length(p_picks) not between 1 and 100 then raise exception 'Invalid color selection count'; end if;
  select j.* into job_row from public.jobs j join public.customers c on c.id=j.customer_id
    where j.id=p_job_id and c.token=p_token and c.archived_at is null
      and j.archived_at is null and j.voided_at is null for update of j;
  if job_row.id is null then raise exception 'Job not found'; end if;
  -- The UI only offers colors before confirmation; keep signed choices stable.
  if job_row.confirmed then raise exception 'Job already confirmed'; end if;
  perform topcoat_security_private.portal_write_limit(p_token,'portal_colors',30);
  return topcoat_security_private.portal_set_area_colors(p_token,p_job_id,p_picks);
end;
$$;

create or replace function public.portal_submit_review(p_token text,p_job_id uuid,p_rating integer,p_feedback text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_customer_id uuid; existing_id uuid; existing_rating integer; existing_feedback text;
begin
  if p_token is null or length(p_token) not between 16 and 128 then raise exception 'Invalid token'; end if;
  if p_rating is null or p_rating not between 1 and 5 or octet_length(coalesce(p_feedback,''))>10000 then
    raise exception 'Invalid review';
  end if;
  select c.id into v_customer_id from public.customers c join public.jobs j on j.customer_id=c.id
    where c.token=p_token and c.archived_at is null and j.id=p_job_id
      and j.archived_at is null and j.voided_at is null for update of j;
  if v_customer_id is null then raise exception 'Job not found'; end if;
  select r.id,r.rating,r.feedback into existing_id,existing_rating,existing_feedback
    from public.reviews r where r.job_id=p_job_id and r.customer_id=v_customer_id
    order by r.created_at limit 1;
  if existing_id is not null then
    if existing_rating=p_rating and coalesce(existing_feedback,'')=coalesce(p_feedback,'') then
      return jsonb_build_object('ok',true,'review_id',existing_id);
    end if;
    raise exception 'A review has already been submitted for this job';
  end if;
  perform topcoat_security_private.portal_write_limit(p_token,'portal_review',10);
  return topcoat_security_private.portal_submit_review(p_token,p_job_id,p_rating,p_feedback);
end;
$$;

create or replace function public.portal_submit_referral(
  p_token text,p_friend_name text,p_friend_phone text,p_friend_email text,p_service_interest text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_customer_id uuid;existing_id uuid;
begin
  if p_token is null or length(p_token) not between 16 and 128 then raise exception 'Invalid token'; end if;
  if p_friend_name is null or length(trim(p_friend_name))=0 or octet_length(p_friend_name)>300
    or octet_length(coalesce(p_friend_phone,''))>80 or octet_length(coalesce(p_friend_email,''))>320
    or octet_length(coalesce(p_service_interest,''))>1000 then raise exception 'Invalid referral'; end if;
  select c.id into v_customer_id from public.customers c where c.token=p_token and c.archived_at is null;
  if v_customer_id is null then raise exception 'Invalid token'; end if;
  perform pg_advisory_xact_lock(hashtextextended('portal_referral:'||v_customer_id::text,0));
  select r.id into existing_id from public.referrals r where r.customer_id=v_customer_id
    and r.friend_name=p_friend_name and coalesce(r.friend_phone,'')=coalesce(p_friend_phone,'')
    and coalesce(r.friend_email,'')=coalesce(p_friend_email,'')
    and coalesce(r.service_interest,'')=coalesce(p_service_interest,'')
    and r.created_at>now()-interval '24 hours' order by r.created_at desc limit 1;
  if existing_id is not null then return jsonb_build_object('ok',true,'referral_id',existing_id); end if;
  perform topcoat_security_private.portal_write_limit(p_token,'portal_referral',20);
  return topcoat_security_private.portal_submit_referral(p_token,p_friend_name,p_friend_phone,p_friend_email,p_service_interest);
end;
$$;

create or replace function public.portal_log_view(p_token text,p_user_agent text default null)
returns void language plpgsql security definer set search_path='' as $$
declare v_customer_id uuid;
begin
  if p_token is null or length(p_token) not between 16 and 128 then return; end if;
  if octet_length(coalesce(p_user_agent,''))>2048 then raise exception 'Invalid user agent'; end if;
  select c.id into v_customer_id from public.customers c where c.token=p_token and c.archived_at is null;
  if v_customer_id is null then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('portal_view:'||v_customer_id::text,0));
  if exists(select 1 from public.pec_portal_views v where v.customer_id=v_customer_id and v.viewed_at>now()-interval '1 minute') then return; end if;
  perform topcoat_security_private.portal_write_limit(p_token,'portal_view',120);
  perform topcoat_security_private.portal_log_view(p_token,p_user_agent);
end;
$$;

-- Future defaults are closed; intentional bearer-token RPCs opt in explicitly.
do $$
declare signature text;
begin
  foreach signature in array array[
    'get_portal_data(text)',
    'portal_confirm_job(text,uuid,text,jsonb)',
    'portal_set_area_colors(text,uuid,jsonb)',
    'portal_submit_review(text,uuid,integer,text)',
    'portal_submit_referral(text,text,text,text,text)',
    'portal_log_view(text,text)'
  ] loop
    execute 'revoke all on function public.'||signature||' from public,anon,authenticated,service_role';
    execute 'grant execute on function public.'||signature||' to anon,authenticated,service_role';
  end loop;
end;
$$;
