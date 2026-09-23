-- @artifacts
--   column: public.leads.inquiry_date
--   column: public.leads.inquiry_origin
--   column: public.leads.inquiry_evidence
--   column: public.leads.intake_request_key
--   column: public.leads.duplicate_of
--   column: public.leads.reporting_excluded_at
--   column: public.leads.reporting_exclusion_reason
--   column: public.customers.reporting_excluded_at
--   column: public.customers.reporting_exclusion_reason
--   table: topcoat_sales_private.inquiry_requests
--   index: leads_intake_request_key_unique
--   none: Inquiry identity RPC and audited classification guards; no historical reclassification
-- @end
alter table public.leads
  add column inquiry_date date,
  add column inquiry_origin text,
  add column inquiry_evidence text,
  add column intake_request_key text,
  add column duplicate_of uuid references public.leads(id),
  add column reporting_excluded_at timestamptz,
  add column reporting_exclusion_reason text;
alter table public.customers
  add column reporting_excluded_at timestamptz,
  add column reporting_exclusion_reason text;
create unique index leads_intake_request_key_unique on public.leads(brand,intake_request_key) where intake_request_key is not null;

create or replace function topcoat_sales_private.contact_lead(
  p_customer_id uuid, p_lead_id uuid, p_brand text, p_stage text,
  p_occurred_at timestamptz)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_customer public.customers%rowtype;
  v_lead public.leads%rowtype;
  v_brand text := upper(btrim(coalesce(p_brand, 'PEC')));
  v_stage text := coalesce(p_stage, 'new');
  v_at timestamptz := coalesce(p_occurred_at, now());
  v_company text;
  v_customer_phone text;
  v_lead_phone text;
  v_candidates integer;
begin
  if not (current_user = 'service_role'
    or current_setting('role', true) = 'service_role'
    or public.is_admin_staff()) then
    raise exception 'Staff session required' using errcode = '42501';
  end if;
  if p_customer_id is null then
    raise exception 'Customer is required' using errcode = '22023';
  end if;
  if v_brand not in ('PEC', 'FTP') or v_stage not in ('new', 'estimate_scheduled') then
    raise exception 'Invalid sales lead brand or stage' using errcode = '22023';
  end if;
  if not isfinite(v_at) or v_at > now() + interval '5 minutes' then
    raise exception 'Lead occurrence cannot be in the future' using errcode = '22023';
  end if;
  v_company := case v_brand when 'PEC' then 'prescott-epoxy' else 'finishing-touch' end;
  perform pg_advisory_xact_lock(hashtextextended('sales-lead:' || v_brand || ':' || p_customer_id::text, 0));
  select * into v_customer from public.customers where id = p_customer_id;
  if not found or v_customer.company is distinct from v_company or v_customer.archived_at is not null or v_customer.reporting_excluded_at is not null then
    raise exception 'A live customer in this sales brand is required' using errcode = '22023';
  end if;

  if p_lead_id is not null then
    select * into v_lead from public.leads where id = p_lead_id and deleted_at is null for update;
    if not found or v_lead.brand is distinct from v_brand or v_lead.archived_at is not null or v_lead.duplicate_of is not null or v_lead.reporting_excluded_at is not null then
      raise exception 'Linked lead does not belong to this sales brand' using errcode = '22023';
    end if;
    if v_lead.customer_id is null then
      -- Older unlinked leads may be joined only with exact contact evidence.
      v_customer_phone := regexp_replace(coalesce(v_customer.phone, ''), '[^0-9]', '', 'g');
      v_lead_phone := regexp_replace(coalesce(v_lead.phone, ''), '[^0-9]', '', 'g');
      if length(v_customer_phone) = 11 and left(v_customer_phone, 1) = '1' then
        v_customer_phone := substr(v_customer_phone, 2);
      end if;
      if length(v_lead_phone) = 11 and left(v_lead_phone, 1) = '1' then
        v_lead_phone := substr(v_lead_phone, 2);
      end if;
      if not (
        coalesce(nullif(lower(btrim(v_customer.email)), '') = nullif(lower(btrim(v_lead.email)), ''), false)
        or (length(v_customer_phone) = 10 and v_customer_phone = v_lead_phone)
      ) then
        raise exception 'Unlinked lead needs matching customer email or phone' using errcode = '22023';
      end if;
      update public.leads set customer_id = p_customer_id where id = v_lead.id;
      v_lead.customer_id := p_customer_id;
    elsif v_lead.customer_id is distinct from p_customer_id then
      raise exception 'Linked lead belongs to a different customer' using errcode = '22023';
    end if;
  else
    select count(*) into v_candidates from public.leads
      where customer_id=p_customer_id and brand=v_brand and deleted_at is null
        and archived_at is null and stage not in ('accepted','lost')
        and duplicate_of is null and reporting_excluded_at is null;
    if v_candidates > 1 then
      raise exception 'Choose the inquiry this follows; this customer has several open requests' using errcode='22023';
    end if;
    select * into v_lead from public.leads
      where customer_id=p_customer_id and brand=v_brand and deleted_at is null
        and archived_at is null and stage not in ('accepted','lost')
        and duplicate_of is null and reporting_excluded_at is null
      for update;
  end if;

  if v_lead.id is null then
    if (v_at at time zone 'America/Phoenix')::date <> (now() at time zone 'America/Phoenix')::date then raise exception 'Use record_sales_inquiry with evidence for an earlier inquiry date' using errcode='22023'; end if;
    insert into public.leads (
      customer_id, brand, source, first_name, last_name, full_name,
      business_name, email, phone, address, city, state, zip, stage,
      contacted_at, estimate_scheduled_at, created_by, created_at, inquiry_date, inquiry_origin
    ) values (
      v_customer.id, v_brand, v_customer.lead_source,
      v_customer.first_name, v_customer.last_name, v_customer.name,
      v_customer.company_name, v_customer.email, v_customer.phone,
      v_customer.billing_address_line1, v_customer.billing_city,
      v_customer.billing_state, v_customer.billing_zip, v_stage,
      case when v_stage = 'estimate_scheduled' then v_at end,
      case when v_stage = 'estimate_scheduled' then v_at end, auth.uid(), v_at, (v_at at time zone 'America/Phoenix')::date, 'record_link'
    ) returning * into v_lead;
    insert into public.lead_events (lead_id, event_type, to_stage, payload, actor_user_id, created_at)
    values (v_lead.id, 'created', v_stage,
      jsonb_build_object('source', coalesce(v_customer.lead_source, 'manual'), 'via', 'sales_contact_link', 'customer_id', p_customer_id), auth.uid(), v_at);
  elsif v_stage = 'estimate_scheduled' and v_lead.archived_at is null
    and v_lead.stage in ('new', 'contacted') then
    update public.leads set stage = 'estimate_scheduled',
      contacted_at = coalesce(contacted_at, v_at),
      estimate_scheduled_at = coalesce(estimate_scheduled_at, v_at)
    where id = v_lead.id;
    insert into public.lead_events (lead_id, event_type, from_stage, to_stage, payload, actor_user_id)
    values (v_lead.id, 'stage_change', v_lead.stage, 'estimate_scheduled',
      jsonb_build_object('source', 'sales_contact_link', 'customer_id', p_customer_id), auth.uid());
  end if;
  return v_lead.id;
end;
$$;
revoke all on function topcoat_sales_private.contact_lead(uuid,uuid,text,text,timestamptz) from public, anon, authenticated, service_role;
grant execute on function topcoat_sales_private.contact_lead(uuid,uuid,text,text,timestamptz) to authenticated, service_role;

-- Historical records remain editable with their existing retired links.
-- New records and actual relinks always pass the live identity guards above.
create or replace function topcoat_sales_private.link_sales_record()
returns trigger language plpgsql security invoker set search_path='' as $$
declare v_brand text; v_stage text:='new'; v_same_identity boolean:=false;
begin
  if tg_op='UPDATE' then
    v_same_identity:=new.customer_id is not distinct from old.customer_id and new.lead_id is not distinct from old.lead_id;
    if tg_table_name='estimates' then
      v_same_identity:=v_same_identity and new.brand is not distinct from old.brand;
    else
      v_same_identity:=v_same_identity and new.source is not distinct from old.source and new.appt_type is not distinct from old.appt_type;
    end if;
    if v_same_identity and (
      exists(select 1 from public.customers where id=new.customer_id and (archived_at is not null or reporting_excluded_at is not null))
      or exists(select 1 from public.leads where id=new.lead_id and (archived_at is not null or reporting_excluded_at is not null or duplicate_of is not null))
    ) then return new; end if;
  end if;
  if tg_table_name='estimates' and new.lead_id is not null then
    if not exists(select 1 from public.leads where id=new.lead_id and brand=new.brand and deleted_at is null) then
      raise exception 'Linked lead does not belong to this sales brand' using errcode='22023';
    end if;
  end if;
  if tg_table_name='pec_appointments' then
    if new.source='google' or new.appt_type<>'on_site_estimate' then return new; end if;
    if new.status='scheduled' then v_stage:='estimate_scheduled'; end if;
  end if;
  if new.customer_id is null and new.lead_id is not null then
    select customer_id into new.customer_id from public.leads where id=new.lead_id and deleted_at is null;
  end if;
  if new.customer_id is null then return new; end if;
  if tg_table_name='estimates' then v_brand:=new.brand;
  else
    select case company when 'prescott-epoxy' then 'PEC' when 'finishing-touch' then 'FTP' end into v_brand from public.customers where id=new.customer_id;
    if v_brand is null then raise exception 'Unknown appointment customer brand' using errcode='22023'; end if;
  end if;
  new.lead_id:=topcoat_sales_private.contact_lead(new.customer_id,new.lead_id,v_brand,v_stage,new.created_at);
  return new;
end; $$;
revoke all on function topcoat_sales_private.link_sales_record() from public,anon,authenticated,service_role;


create table topcoat_sales_private.inquiry_requests (
  brand text not null, request_key text not null, customer_id uuid not null references public.customers(id),
  lead_id uuid not null references public.leads(id), created_at timestamptz not null default now(),
  primary key(brand,request_key)
);
alter table topcoat_sales_private.inquiry_requests enable row level security;
revoke all on topcoat_sales_private.inquiry_requests from public,anon,authenticated,service_role;
grant select,insert on topcoat_sales_private.inquiry_requests to authenticated,service_role;
create policy staff_requests on topcoat_sales_private.inquiry_requests for all to authenticated using(public.is_admin_staff()) with check(public.is_admin_staff());

-- Explicit new requests never reuse a different request from the same person.
create or replace function public.record_sales_inquiry(
  p_customer_id uuid, p_request_key text, p_brand text default 'PEC',
  p_mode text default 'new', p_lead_id uuid default null,
  p_inquiry_date date default null, p_origin text default 'staff_live',
  p_evidence text default null, p_stage text default 'new', p_details jsonb default '{}'::jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare v_id uuid; v_lead public.leads%rowtype; v_customer public.customers%rowtype;
  v_brand text:=upper(btrim(p_brand)); v_date date; v_now timestamptz:=now(); v_details jsonb; v_consent boolean;
begin
  if not (current_user='service_role' or current_setting('role',true)='service_role' or public.is_admin_staff()) then
    raise exception 'Staff session required' using errcode='42501';
  end if;
  if p_mode not in ('new','followup','auto') or p_stage not in ('new','estimate_scheduled') or v_brand not in ('PEC','FTP') then
    raise exception 'Invalid inquiry intent, stage or brand' using errcode='22023';
  end if;
  if nullif(btrim(p_request_key),'') is null or length(p_request_key)>300 then
    raise exception 'Stable request identifier required' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sales-inquiry:'||v_brand||':'||p_request_key,0));
  perform pg_advisory_xact_lock(hashtextextended('sales-lead:'||v_brand||':'||p_customer_id::text,0));
  select * into v_customer from public.customers where id=p_customer_id;
  if not found or v_customer.archived_at is not null or v_customer.reporting_excluded_at is not null or v_customer.company is distinct from
    (case v_brand when 'PEC' then 'prescott-epoxy' else 'finishing-touch' end) then
    raise exception 'A live customer in this company is required' using errcode='22023';
  end if;
  select l.* into v_lead from public.leads l join topcoat_sales_private.inquiry_requests r on r.lead_id=l.id where r.brand=v_brand and r.request_key=p_request_key;
  if found then
    if v_lead.customer_id is distinct from p_customer_id or v_lead.deleted_at is not null or v_lead.duplicate_of is not null or v_lead.reporting_excluded_at is not null
       or (p_lead_id is not null and p_lead_id<>v_lead.id)
       or (p_inquiry_date is not null and p_inquiry_date is distinct from v_lead.inquiry_date) then
      raise exception 'Request identifier conflicts with the saved inquiry' using errcode='22023';
    end if;
    return v_lead.id;
  end if;
  if p_mode='followup' and p_lead_id is null then
    if not exists(select 1 from public.leads where customer_id=p_customer_id and brand=v_brand and deleted_at is null and archived_at is null and stage not in ('accepted','lost') and duplicate_of is null and reporting_excluded_at is null) then
      raise exception 'Choose an existing inquiry or create a new request' using errcode='22023';
    end if;
  end if;
  if p_mode='followup' or (p_mode='auto' and (p_lead_id is not null or exists(select 1 from public.leads where customer_id=p_customer_id and brand=v_brand and deleted_at is null and archived_at is null and stage not in ('accepted','lost') and duplicate_of is null and reporting_excluded_at is null))) then
    v_id:=topcoat_sales_private.contact_lead(p_customer_id,p_lead_id,v_brand,p_stage,v_now);
    insert into topcoat_sales_private.inquiry_requests(brand,request_key,customer_id,lead_id) values(v_brand,p_request_key,p_customer_id,v_id);
    return v_id;
  end if;
  if p_lead_id is not null then raise exception 'A new request cannot reuse an existing inquiry' using errcode='22023'; end if;
  if p_origin not in ('staff_live','public_booking','source_event','historical_review') then
    raise exception 'Valid inquiry origin required' using errcode='22023';
  end if;
  v_date:=coalesce(p_inquiry_date,case when p_origin in ('staff_live','public_booking') then (v_now at time zone 'America/Phoenix')::date end);
  if v_date is null or not isfinite(v_date) or v_date>(v_now at time zone 'America/Phoenix')::date then raise exception 'Original inquiry date required' using errcode='22023'; end if;
  if (p_origin in ('source_event','historical_review') or v_date<(v_now at time zone 'America/Phoenix')::date) and nullif(btrim(p_evidence),'') is null then
    raise exception 'Original date evidence required' using errcode='22023';
  end if;
  if p_details is null or jsonb_typeof(p_details)<>'object' then raise exception 'Inquiry details must be an object' using errcode='22023'; end if;
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into v_details from jsonb_each(p_details)
    where key=any(array['source','source_ref','first_name','last_name','business_name','full_name','email','phone','address','city','state','zip','campaign','ad_meta','notes','sms_consent','sms_consent_source','sms_consent_at']);
  v_consent:=coalesce((v_details->>'sms_consent')::boolean,false) and not coalesce(v_customer.sms_opt_out,false);
  insert into public.leads(customer_id,brand,source,first_name,last_name,full_name,business_name,email,phone,address,city,state,zip,stage,contacted_at,estimate_scheduled_at,created_by,intake_request_key,inquiry_date,inquiry_origin,inquiry_evidence)
  values(v_customer.id,v_brand,v_customer.lead_source,v_customer.first_name,v_customer.last_name,v_customer.name,v_customer.company_name,v_customer.email,v_customer.phone,v_customer.billing_address_line1,v_customer.billing_city,v_customer.billing_state,v_customer.billing_zip,p_stage,
    case when p_stage='estimate_scheduled' then v_now end,case when p_stage='estimate_scheduled' then v_now end,auth.uid(),p_request_key,v_date,p_origin,p_evidence) returning id into v_id;
  -- Only this new row is enriched. Retries return above without rewriting
  -- staff changes, consent evidence, timestamps or the request identity.
  update public.leads set
    source=coalesce(v_details->>'source',source),source_ref=v_details->>'source_ref',
    first_name=coalesce(v_details->>'first_name',first_name),last_name=coalesce(v_details->>'last_name',last_name),
    business_name=coalesce(v_details->>'business_name',business_name),full_name=coalesce(v_details->>'full_name',full_name),
    email=coalesce(v_details->>'email',email),phone=coalesce(v_details->>'phone',phone),
    address=coalesce(v_details->>'address',address),city=coalesce(v_details->>'city',city),
    state=coalesce(v_details->>'state',state),zip=coalesce(v_details->>'zip',zip),
    campaign=v_details->>'campaign',ad_meta=nullif(v_details->'ad_meta','null'::jsonb),notes=v_details->>'notes',
    sms_consent=v_consent,opted_out=coalesce(v_customer.sms_opt_out,false),
    sms_consent_source=case when v_consent then v_details->>'sms_consent_source' end,
    sms_consent_at=case when v_consent then coalesce((v_details->>'sms_consent_at')::timestamptz,v_now) end
    where id=v_id;
  insert into public.lead_events(lead_id,event_type,to_stage,payload,actor_user_id)
    values(v_id,'created',p_stage,jsonb_build_object('via','sales_inquiry','inquiry_date',v_date,'origin',p_origin,'evidence',p_evidence,'details',v_details),auth.uid());
  insert into topcoat_sales_private.inquiry_requests(brand,request_key,customer_id,lead_id) values(v_brand,p_request_key,p_customer_id,v_id);
  return v_id;
end; $$;
revoke all on function public.record_sales_inquiry(uuid,text,text,text,uuid,date,text,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.record_sales_inquiry(uuid,text,text,text,uuid,date,text,text,text,jsonb) to authenticated,service_role;

-- Changes to historical classifications must be explicit and attributable.
create or replace function topcoat_sales_private.audit_inquiry_classification()
returns trigger language plpgsql security invoker set search_path='' as $$
declare v_target public.leads%rowtype;
begin
  if new.reporting_excluded_at is not null and nullif(btrim(new.reporting_exclusion_reason),'') is null then
    raise exception 'Reporting exclusion requires a reason' using errcode='22023';
  end if;
  if tg_table_name='leads' then
    if tg_op='INSERT' and (new.customer_id is null or new.inquiry_date is null or nullif(btrim(new.inquiry_origin),'') is null) then raise exception 'New inquiries require customer, original date and origin' using errcode='22023'; end if;
    if tg_op='UPDATE' and (new.intake_request_key is distinct from old.intake_request_key or (old.intake_request_key is not null and (new.customer_id is distinct from old.customer_id or new.brand is distinct from old.brand))) then raise exception 'Saved inquiry request identity cannot be rewritten' using errcode='22023'; end if;
    if new.duplicate_of is not null then
      select * into v_target from public.leads where id=new.duplicate_of;
      if not found or new.id=new.duplicate_of or v_target.customer_id is distinct from new.customer_id or v_target.brand<>new.brand or v_target.duplicate_of is not null or v_target.deleted_at is not null then
        raise exception 'Duplicate inquiry must reference a canonical inquiry for the same customer/company' using errcode='22023';
      end if;
      if nullif(btrim(new.inquiry_evidence),'') is null then raise exception 'Duplicate classification requires evidence' using errcode='22023'; end if;
    end if;
    if new.inquiry_date is not null and (not isfinite(new.inquiry_date) or new.inquiry_date>(now() at time zone 'America/Phoenix')::date) then raise exception 'Invalid inquiry date' using errcode='22023'; end if;
    if tg_op='UPDATE' and (new.inquiry_date is distinct from old.inquiry_date or new.duplicate_of is distinct from old.duplicate_of) and nullif(btrim(new.inquiry_evidence),'') is null then
      raise exception 'Historical inquiry changes require evidence' using errcode='22023';
    end if;
  end if;
  if tg_op='UPDATE' then
    insert into public.audit_log(action,entity_type,entity_id,before_json,after_json,auth_user_id)
    values('sales_reporting_classification',tg_table_name,new.id,to_jsonb(old),to_jsonb(new),auth.uid());
  end if;
  return new;
end; $$;
revoke all on function topcoat_sales_private.audit_inquiry_classification() from public,anon,authenticated,service_role;
create trigger trg_leads_reporting_classification before insert or update of intake_request_key,customer_id,brand,inquiry_date,inquiry_evidence,duplicate_of,reporting_excluded_at,reporting_exclusion_reason on public.leads for each row execute function topcoat_sales_private.audit_inquiry_classification();
create trigger trg_prod_jobs_reporting_classification before update of reporting_excluded_at,reporting_exclusion_reason on public.pec_prod_jobs for each row execute function topcoat_sales_private.audit_inquiry_classification();
create trigger trg_customers_reporting_classification before update of reporting_excluded_at,reporting_exclusion_reason on public.customers for each row execute function topcoat_sales_private.audit_inquiry_classification();

create or replace function public.resolve_sales_customer(p_profile jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare v_id uuid; v_count integer; v_phone text:=right(regexp_replace(coalesce(p_profile->>'phone',''),'[^0-9]','','g'),10);
 v_email text:=lower(btrim(coalesce(p_profile->>'email',''))); v_company text:=coalesce(p_profile->>'company','prescott-epoxy');
begin
 if not (current_user='service_role' or current_setting('role',true)='service_role' or public.is_admin_staff()) then raise exception 'Staff session required' using errcode='42501'; end if;
 if v_company not in ('prescott-epoxy','finishing-touch') or nullif(btrim(p_profile->>'name'),'') is null then raise exception 'Customer name and company required'; end if;
 if length(v_phone)<>10 and v_email='' then raise exception 'Customer phone or email required'; end if;
 -- Stable lock order prevents duplicate identities across simultaneous intake requests.
 if length(v_phone)=10 then perform pg_advisory_xact_lock(hashtextextended('customer-phone:'||v_company||':'||v_phone,0)); end if;
 if v_email<>'' then perform pg_advisory_xact_lock(hashtextextended('customer-email:'||v_company||':'||v_email,0)); end if;
 select count(*),(array_agg(id))[1] into v_count,v_id from public.customers
 where company=v_company and archived_at is null and
 ((length(v_phone)=10 and right(regexp_replace(coalesce(phone,''),'[^0-9]','','g'),10)=v_phone) or (v_email<>'' and lower(btrim(email))=v_email));
 if v_count>1 then raise exception 'Several customers match; review the identity before linking this inquiry' using errcode='22023'; end if;
 if v_count=1 then return v_id; end if;
 insert into public.customers(id,token,name,first_name,last_name,company_name,company,email,phone,billing_address_line1,billing_city,billing_state,billing_zip,lead_source)
 values(coalesce(nullif(p_profile->>'_new_customer_id','')::uuid,gen_random_uuid()),gen_random_uuid()::text||gen_random_uuid()::text,p_profile->>'name',p_profile->>'first_name',p_profile->>'last_name',p_profile->>'company_name',v_company,nullif(v_email,''),nullif(v_phone,''),p_profile->>'billing_address_line1',p_profile->>'billing_city',p_profile->>'billing_state',p_profile->>'billing_zip',p_profile->>'lead_source') returning id into v_id;
 return v_id;
end; $$;
revoke all on function public.resolve_sales_customer(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.resolve_sales_customer(jsonb) to authenticated,service_role;
