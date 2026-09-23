-- @artifacts
--   none: extend portal_confirm_job to recognize staff-recorded external contract acceptance
-- @end
-- Keep the existing token, ownership, payload and replay protections. An
-- accepted estimate is already the customer's signed project agreement;
-- jobs.confirmed remains the legacy portal-confirmation flag. Color selection
-- has its own RPC and is deliberately unchanged. CREATE OR REPLACE preserves
-- the wrapper's existing grants and private implementation boundary.
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
  if exists (
    select 1 from public.estimates e
    where e.job_id=job_row.id and e.status='accepted'
      and (e.signed_at is not null or e.signature->>'via'='staff_external_contract')
      and e.deleted_at is null
  ) then
    raise exception 'Estimate already signed';
  end if;
  perform topcoat_security_private.portal_write_limit(p_token,'portal_confirm',30);
  return topcoat_security_private.portal_confirm_job(p_token,p_job_id,p_signature,p_colors);
end;
$$;
