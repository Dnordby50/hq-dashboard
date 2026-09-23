-- @artifacts
--   table: public.pec_job_business_events
--   table: public.pec_sales_integrity_exceptions
--   column: public.jobs.reporting_state
--   column: public.jobs.booked_occurred_at
--   column: public.jobs.booking_evidence_ref
--   column: public.pec_prod_jobs.reporting_excluded_at
--   column: public.pec_prod_jobs.reporting_exclusion_reason
--   column: public.pec_prod_jobs.completed_date
--   index: pec_job_business_events_one_original_idx
--   index: pec_job_business_events_job_idx
-- @end
-- Prospective evidence only. Existing unresolved rows are not backfilled or certified.
alter table public.jobs add column reporting_state text not null default 'historical_pending'
  check (reporting_state in ('verified','historical_pending'));
alter table public.jobs alter column reporting_state set default 'verified';
alter table public.jobs add column booked_occurred_at timestamptz, add column booking_evidence_ref text;
alter table public.pec_prod_jobs add column completed_date date, add column reporting_excluded_at timestamptz, add column reporting_exclusion_reason text;
create table public.pec_job_business_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id),
  prod_job_id uuid references public.pec_prod_jobs(id),
  brand text not null check (brand in ('PEC','FTP')),
  event_type text not null check (event_type in ('booked','completed','completion_amended','booked_adjusted','completed_adjusted')),
  business_date date not null,
  occurred_at timestamptz,
  amount_snapshot numeric,
  source text not null,
  request_key text not null unique,
  evidence_ref text not null,
  actor_id uuid,
  recorded_at timestamptz not null default clock_timestamp(),
  event_sequence bigint generated always as identity unique,
  supersedes_event_id uuid references public.pec_job_business_events(id)
);
create unique index pec_job_business_events_one_original_idx on public.pec_job_business_events(job_id,event_type)
  where event_type in ('booked','completed');
create index pec_job_business_events_job_idx on public.pec_job_business_events(job_id,recorded_at);
alter table public.pec_job_business_events enable row level security;
revoke all on public.pec_job_business_events from public,anon,authenticated,service_role;
grant select on public.pec_job_business_events to authenticated,service_role;
create policy job_events_staff_read on public.pec_job_business_events for select to authenticated using (public.is_admin_staff());

create table public.pec_sales_integrity_exceptions (
  id uuid primary key default gen_random_uuid(),
  brand text not null check (brand in ('PEC','FTP')),
  source text not null,
  source_event_key text not null,
  event_type text not null,
  entity_ref text,
  reason text not null,
  payload jsonb not null default '{}',
  state text not null default 'open' check (state in ('open','resolved','excluded')),
  recorded_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_note text,
  unique(source,source_event_key,event_type)
);
alter table public.pec_sales_integrity_exceptions enable row level security;
revoke all on public.pec_sales_integrity_exceptions from public,anon,authenticated,service_role;
grant select,insert,update on public.pec_sales_integrity_exceptions to service_role;

create or replace function topcoat_security_private.job_event_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_brand text; v_event public.pec_job_business_events; v_now date := (now() at time zone 'America/Phoenix')::date;
begin
  if ((tg_op='INSERT' or new.signed_date is distinct from old.signed_date) and new.signed_date is not null and (not isfinite(new.signed_date) or new.signed_date>v_now)) or ((tg_op='INSERT' or new.completed_date is distinct from old.completed_date) and new.completed_date is not null and (not isfinite(new.completed_date) or new.completed_date>v_now)) then raise exception 'Job business dates must be finite and cannot be in the future'; end if;
  if new.booked_occurred_at is not null and (not isfinite(new.booked_occurred_at) or new.booked_occurred_at>clock_timestamp() or (new.booked_occurred_at at time zone 'America/Phoenix')::date is distinct from new.signed_date) then raise exception 'Booking timestamp and business date must agree'; end if;
  if (tg_op='INSERT' or new.price is distinct from old.price) and new.price is not null and new.price::text in ('NaN','Infinity','-Infinity') then raise exception 'Recorded contract price must be finite'; end if;
  select case company when 'prescott-epoxy' then 'PEC' when 'finishing-touch' then 'FTP' else 'FTP' end into v_brand from public.customers where id = new.customer_id;
  if tg_op = 'INSERT' then
    if new.reporting_state = 'historical_pending' then
      if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'Only a reviewed service import may stage historical jobs'; end if;
      return new;
    end if;
    if new.signed_date is null or new.signed_date > v_now then raise exception 'Date accepted is required and cannot be in the future'; end if;
    if new.price is null then raise exception 'Recorded contract price is required for a verified booking'; end if;
    if new.status = 'completed' then raise exception 'Create the job, then record completion through pec_complete_job'; end if;
    return new;
  end if;
  -- Unrelated edits to existing historical gaps remain allowed.
  if new.reporting_state is distinct from old.reporting_state and coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'Historical classification requires reviewed service action'; end if;
  if (new.signed_date is distinct from old.signed_date or new.booked_occurred_at is distinct from old.booked_occurred_at or new.booking_evidence_ref is distinct from old.booking_evidence_ref) and exists(select 1 from public.pec_job_business_events where job_id = new.id and event_type = 'booked') then
    raise exception 'The original booking date is locked; use a reviewed historical amendment';
  end if;
  if new.completed_date is distinct from old.completed_date or (new.status = 'completed' and old.status is distinct from 'completed') then
    select * into v_event from public.pec_job_business_events where job_id = new.id and event_type in ('completed','completion_amended') order by event_sequence desc limit 1;
    if v_event.id is null or v_event.business_date is distinct from new.completed_date then raise exception 'Use pec_complete_job or pec_amend_job_completion to record completion'; end if;
  end if;
  return new;
end $$;
revoke all on function topcoat_security_private.job_event_guard() from public,anon,authenticated,service_role;
create trigger job_business_event_guard before insert or update on public.jobs for each row execute function topcoat_security_private.job_event_guard();

-- Invoice price includes pending change-order lines before approval. Reporting
-- excludes those lines and adds only signed change-order records. The invoice
-- and material workflow stays unchanged; customer approval owns booked dollars.
create or replace function topcoat_security_private.approved_job_value(p_job public.jobs)
returns numeric language plpgsql stable security definer set search_path = '' as $$
declare v_amount numeric;
begin
  select p_job.price
    - coalesce((select sum(coalesce(nullif(li->>'price',''),nullif(li->>'total',''),nullif(li->>'unit_price',''),'0')::numeric)
        from jsonb_array_elements(case when jsonb_typeof(p_job.line_items)='array' then p_job.line_items else '[]'::jsonb end) li
        where li->>'is_change_order'='true'),0)
    + coalesce((select sum(amount) from public.pec_change_order_signatures where job_id=p_job.id and status='signed'),0) into v_amount;
  if v_amount::text in ('NaN','Infinity','-Infinity') then raise exception 'Approved contract value and change-order lines must be finite'; end if;
  return v_amount;
end $$;
revoke all on function topcoat_security_private.approved_job_value(public.jobs) from public,anon,authenticated,service_role;

create or replace function topcoat_security_private.capture_job_business_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_brand text; v_type text; v_delta numeric;
begin
  select case company when 'prescott-epoxy' then 'PEC' else 'FTP' end into v_brand from public.customers where id = new.customer_id;
  if tg_op = 'INSERT' and new.reporting_state = 'verified' then
    insert into public.pec_job_business_events(job_id,brand,event_type,business_date,occurred_at,amount_snapshot,source,request_key,evidence_ref,actor_id)
      values(new.id,v_brand,'booked',new.signed_date,new.booked_occurred_at,topcoat_security_private.approved_job_value(new),new.source,'booked:'||new.id,coalesce(nullif(new.booking_evidence_ref,''),'jobs/'||new.id),auth.uid());
  elsif tg_op = 'UPDATE' and (new.price is distinct from old.price or new.line_items is distinct from old.line_items or new.voided_at is distinct from old.voided_at) then
    -- A correction changes the correction week's dollars, never the original snapshot.
    -- A previously unknown price is its first measured amount, rather than a zero-priced sale.
    v_delta := (case when new.voided_at is null then coalesce(topcoat_security_private.approved_job_value(new),0) else 0 end) - (case when old.voided_at is null then coalesce(topcoat_security_private.approved_job_value(old),0) else 0 end);
    if v_delta=0 then return new; end if;
    foreach v_type in array array['booked','completed'] loop
      if exists(select 1 from public.pec_job_business_events where job_id=new.id and (event_type=v_type or (v_type='completed' and event_type='completion_amended'))) then
        if new.price is null then raise exception 'Recorded job value cannot be cleared; enter an explicit correction'; end if;
        insert into public.pec_job_business_events(job_id,brand,event_type,business_date,occurred_at,amount_snapshot,source,request_key,evidence_ref,actor_id)
          values(new.id,v_brand,v_type||'_adjusted',(now() at time zone 'America/Phoenix')::date,now(),v_delta,case when new.voided_at is distinct from old.voided_at then 'job_void_amendment' else 'job_price_amendment' end,gen_random_uuid()::text,'jobs/'||new.id||'/price',auth.uid());
      end if;
    end loop;
  end if;
  return new;
end $$;
revoke all on function topcoat_security_private.capture_job_business_event() from public,anon,authenticated,service_role;
create trigger capture_job_business_event after insert or update of price,line_items,voided_at on public.jobs for each row execute function topcoat_security_private.capture_job_business_event();

create or replace function public.pec_complete_job(p_job_id uuid, p_prod_job_id uuid default null, p_completed_date date default null, p_request_key text default null, p_occurred_at timestamptz default null, p_evidence_ref text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.jobs; p public.pec_prod_jobs; e public.pec_job_business_events; v_date date; v_brand text; v_ids uuid[]; v_service boolean := coalesce(auth.jwt()->>'role','')='service_role';
begin
  if not v_service and not public.is_admin_staff() then raise exception 'Active staff access required' using errcode='42501'; end if;
  if p_request_key is null or length(trim(p_request_key)) < 8 or length(p_request_key)>240 then raise exception 'Stable completion request key required'; end if;
  if p_evidence_ref is null or length(trim(p_evidence_ref))=0 then raise exception 'Completion evidence required'; end if;
  select * into j from public.jobs where id=p_job_id for update;
  if j.id is null or j.archived_at is not null or j.voided_at is not null then raise exception 'Active CRM job required'; end if;
  select case company when 'prescott-epoxy' then 'PEC' else 'FTP' end into v_brand from public.customers where id=j.customer_id;
  if p_prod_job_id is null then
    select array_agg(id order by id) into v_ids from public.pec_prod_jobs where crm_job_id=j.id and archived_at is null and not is_callback;
    if cardinality(v_ids)>1 then raise exception 'Multiple production jobs require a reviewed completion link'; end if;
    p_prod_job_id := v_ids[1];
    if p_prod_job_id is null and j.dripjobs_deal_id is not null and exists(select 1 from public.pec_prod_jobs where dripjobs_deal_id=j.dripjobs_deal_id and archived_at is null and not is_callback) then raise exception 'External production match needs an explicit reviewed CRM link'; end if;
  end if;
  if p_prod_job_id is not null then
    select * into p from public.pec_prod_jobs where id=p_prod_job_id for update;
    if p.id is null or p.archived_at is not null or p.crm_job_id is distinct from j.id or v_brand<>'PEC' or (p.customer_id is not null and p.customer_id<>j.customer_id) then raise exception 'Production job must be explicitly linked to this CRM customer and company'; end if;
  end if;
  select * into e from public.pec_job_business_events where request_key=p_request_key;
  if e.id is not null then
    if e.job_id<>j.id or e.event_type not in ('completed','completion_amended') or e.prod_job_id is distinct from p_prod_job_id or (p_completed_date is not null and e.business_date<>p_completed_date) then raise exception 'Completion request key conflicts with its original action'; end if;
    return jsonb_build_object('job_id',j.id,'prod_job_id',p_prod_job_id,'completed_date',j.completed_date,'event_id',e.id,'already',true);
  end if;
  if v_service and p_completed_date is null then raise exception 'External completion must supply original business date'; end if;
  v_date := coalesce(p_completed_date,(now() at time zone 'America/Phoenix')::date);
  if not isfinite(v_date) or v_date > (now() at time zone 'America/Phoenix')::date then raise exception 'Completion cannot be in the future'; end if;
  if p_occurred_at is not null and (not isfinite(p_occurred_at) or p_occurred_at>clock_timestamp() or (p_occurred_at at time zone 'America/Phoenix')::date<>v_date) then raise exception 'Completion timestamp and business date disagree'; end if;
  if j.completed_date is not null and j.completed_date<>v_date then raise exception 'Completion date already recorded; use an audited amendment'; end if;
  select * into e from public.pec_job_business_events where job_id=j.id and event_type in ('completed','completion_amended') order by event_sequence desc limit 1;
  if e.id is not null then
    -- A fresh form key is still the same completed business event. Never
    -- repeat downstream review asks or change the recorded production pair.
    if e.prod_job_id is distinct from p_prod_job_id then raise exception 'Completion production link conflicts with recorded evidence; use an audited amendment'; end if;
    if e.business_date is distinct from v_date or j.status<>'completed' or j.completed_date is distinct from v_date or (p.id is not null and (p.status<>'completed' or p.completed_date is distinct from v_date)) then raise exception 'Recorded completion state needs an audited amendment'; end if;
    return jsonb_build_object('job_id',j.id,'prod_job_id',p_prod_job_id,'completed_date',j.completed_date,'event_id',e.id,'already',true);
  end if;
  insert into public.pec_job_business_events(job_id,prod_job_id,brand,event_type,business_date,occurred_at,amount_snapshot,source,request_key,evidence_ref,actor_id)
    values(j.id,p_prod_job_id,v_brand,'completed',v_date,p_occurred_at,topcoat_security_private.approved_job_value(j),case when v_service then 'external_completion' else 'staff_completion' end,p_request_key,p_evidence_ref,auth.uid()) returning * into e;
  update public.jobs set status='completed',completed_date=v_date,status_manual_at=now(),invoice_due_date=case when invoice_terms='due_on_completion' and invoice_due_date is null then v_date else invoice_due_date end where id=j.id;
  if p_prod_job_id is not null then
    update public.pec_prod_jobs set status='completed',completed_date=v_date,completed_at=coalesce(completed_at,p_occurred_at) where id=p_prod_job_id;
  end if;
  update public.timeline_stages set status='completed',completed_at=coalesce(completed_at,p_occurred_at) where job_id=j.id and status<>'completed';
  return jsonb_build_object('job_id',j.id,'prod_job_id',p_prod_job_id,'completed_date',v_date,'event_id',e.id,'already',false);
end $$;
revoke all on function public.pec_complete_job(uuid,uuid,date,text,timestamptz,text) from public,anon,authenticated,service_role;
grant execute on function public.pec_complete_job(uuid,uuid,date,text,timestamptz,text) to authenticated,service_role;

create or replace function public.pec_amend_job_completion(p_job_id uuid,p_completed_date date,p_request_key text,p_evidence_ref text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.jobs; e public.pec_job_business_events; p public.pec_prod_jobs; v_brand text; v_ids uuid[];
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' and not public.is_admin_role() then raise exception 'Administrator access required' using errcode='42501'; end if;
  if p_completed_date is null or not isfinite(p_completed_date) or p_completed_date>(now() at time zone 'America/Phoenix')::date or length(trim(coalesce(p_evidence_ref,'')))<8 or length(trim(coalesce(p_request_key,'')))<8 then raise exception 'A past completion date, stable key and supporting evidence are required'; end if;
  select * into j from public.jobs where id=p_job_id for update;
  if j.id is null or j.archived_at is not null or j.voided_at is not null then raise exception 'Active CRM job required'; end if;
  select * into e from public.pec_job_business_events where request_key=p_request_key;
  if e.id is not null then
    if e.job_id<>j.id or e.business_date<>p_completed_date or e.event_type<>'completion_amended' then raise exception 'Amendment request conflicts'; end if;
    return jsonb_build_object('job_id',j.id,'completed_date',j.completed_date,'already',true);
  end if;
  select case company when 'prescott-epoxy' then 'PEC' else 'FTP' end into v_brand from public.customers where id=j.customer_id;
  select array_agg(id order by id) into v_ids from public.pec_prod_jobs where crm_job_id=j.id and archived_at is null and not is_callback;
  if cardinality(v_ids)>1 then raise exception 'Multiple production jobs require a reviewed completion link'; end if;
  if v_ids[1] is not null then
    select * into p from public.pec_prod_jobs where id=v_ids[1] for update;
    if v_brand<>'PEC' or (p.customer_id is not null and p.customer_id<>j.customer_id) then raise exception 'Production job must belong to the same CRM customer and company'; end if;
  elsif j.dripjobs_deal_id is not null and exists(select 1 from public.pec_prod_jobs where dripjobs_deal_id=j.dripjobs_deal_id and archived_at is null and not is_callback) then raise exception 'External production match needs an explicit reviewed CRM link';
  end if;
  select * into e from public.pec_job_business_events where job_id=j.id and event_type in ('completed','completion_amended') order by event_sequence desc limit 1;
  insert into public.pec_job_business_events(job_id,prod_job_id,brand,event_type,business_date,amount_snapshot,source,request_key,evidence_ref,actor_id,supersedes_event_id)
    values(j.id,p.id,v_brand,'completion_amended',p_completed_date,case when e.id is null then topcoat_security_private.approved_job_value(j) else e.amount_snapshot end,'admin_completion_amendment',p_request_key,p_evidence_ref,auth.uid(),e.id);
  update public.jobs set status='completed',completed_date=p_completed_date,status_manual_at=now() where id=j.id;
  update public.pec_prod_jobs set status='completed',completed_date=p_completed_date where id=p.id;
  return jsonb_build_object('job_id',j.id,'completed_date',p_completed_date,'already',false);
end $$;
revoke all on function public.pec_amend_job_completion(uuid,date,text,text) from public,anon,authenticated,service_role;
grant execute on function public.pec_amend_job_completion(uuid,date,text,text) to authenticated,service_role;

-- Completion never mirrors by an external ID; RPC validates explicit pairing.
-- Preserve non-completion schedule progress and never regress completed CRM jobs.
create or replace function public.pec_prod_jobs_sync_public_status()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_start date; v_target text; v_job uuid; v_matches uuid[];
begin
  if new.status='completed' or new.is_callback then return new; end if;
  v_job := new.crm_job_id;
  if v_job is null and new.dripjobs_deal_id is not null then
    select array_agg(j.id order by j.id) into v_matches from public.jobs j join public.customers c on c.id=j.customer_id where j.dripjobs_deal_id=new.dripjobs_deal_id and j.archived_at is null and j.voided_at is null and c.company='prescott-epoxy' and (new.customer_id is null or j.customer_id=new.customer_id);
    if cardinality(v_matches)=1 then v_job:=v_matches[1]; end if;
  end if;
  if v_job is null then return new; end if;
  select least(new.install_date,min(scheduled_date)) into v_start from public.pec_prod_job_schedule_days where job_id=new.id;
  v_target := case when v_start is null and new.status in ('scheduled','ordered','delivered') then 'scheduled' when v_start is null then 'signed' when v_start>(now() at time zone 'America/Phoenix')::date then 'scheduled' else 'in_progress' end;
  update public.jobs set status=v_target,status_manual_at=null where id=v_job and (new.customer_id is null or customer_id=new.customer_id) and status is distinct from v_target and status<>'completed';
  return new;
end $$;

create or replace function topcoat_security_private.guard_production_completion()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status='completed' and (tg_op='INSERT' or old.status is distinct from 'completed' or new.completed_date is distinct from old.completed_date or new.crm_job_id is distinct from old.crm_job_id or new.customer_id is distinct from old.customer_id) then
    if new.crm_job_id is null or not exists(select 1 from public.jobs j where j.id=new.crm_job_id and j.status='completed' and j.completed_date is not null and j.completed_date=new.completed_date and (new.customer_id is null or j.customer_id=new.customer_id) and exists(select 1 from public.customers c where c.id=j.customer_id and c.company='prescott-epoxy')) then raise exception 'Complete the explicitly linked CRM job through pec_complete_job'; end if;
  end if;
  return new;
end $$;
revoke all on function topcoat_security_private.guard_production_completion() from public,anon,authenticated,service_role;
create trigger guard_production_completion before insert or update on public.pec_prod_jobs for each row execute function topcoat_security_private.guard_production_completion();

-- Service-only webhook transaction: a semantic deal acceptance key serializes
-- deliveries even when the provider does not include a separate transport ID.
create or replace function public.pec_accept_external_job(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.customers; j public.jobs; p public.pec_prod_jobs; v_company text := coalesce(nullif(p_payload->>'company',''),'prescott-epoxy'); v_deal text := nullif(p_payload->>'deal_id',''); v_count integer; v_created boolean:=false; v_stage text; v_index integer:=0; v_date date; v_at timestamptz;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  if v_deal is null or nullif(p_payload->>'customer_name','') is null or nullif(p_payload->>'signed_date','') is null then raise exception 'Deal identity, customer and original accepted date required'; end if;
  if v_company not in ('prescott-epoxy','finishing-touch') then raise exception 'Unknown company'; end if;
  v_date := (p_payload->>'signed_date')::date;
  v_at := nullif(p_payload->>'occurred_at','')::timestamptz;
  if not isfinite(v_date) or v_date>(now() at time zone 'America/Phoenix')::date or (v_at is not null and (not isfinite(v_at) or v_at>clock_timestamp() or (v_at at time zone 'America/Phoenix')::date<>v_date)) then raise exception 'Invalid original acceptance date'; end if;
  perform pg_advisory_xact_lock(hashtextextended('external-accept:'||v_company||':'||v_deal,0));
  select count(*) into v_count from public.jobs x join public.customers y on y.id=x.customer_id where x.dripjobs_deal_id=v_deal and y.company=v_company;
  if v_count>1 then raise exception 'Multiple CRM jobs match the external proposal'; end if;
  select x.* into j from public.jobs x join public.customers y on y.id=x.customer_id where x.dripjobs_deal_id=v_deal and y.company=v_company for update of x;
  if j.id is not null then
    if j.signed_date is distinct from v_date then raise exception 'External acceptance conflicts with recorded booking date'; end if;
    if nullif(p_payload->>'price','')::numeric is distinct from coalesce((select amount_snapshot from public.pec_job_business_events where job_id=j.id and event_type='booked'),j.price) then raise exception 'External acceptance conflicts with original booked price'; end if;
    select * into c from public.customers where id=j.customer_id;
  else
    if nullif(p_payload->>'customer_email','') is not null then
      -- Serialize contact creation as well, independently of inquiry identity.
      perform pg_advisory_xact_lock(hashtextextended('external-customer:'||v_company||':'||lower(p_payload->>'customer_email'),0));
      select count(*) into v_count from public.customers where lower(email)=lower(p_payload->>'customer_email') and company=v_company and archived_at is null;
      if v_count>1 then raise exception 'Customer email matches multiple active records'; end if;
      select * into c from public.customers where lower(email)=lower(p_payload->>'customer_email') and company=v_company and archived_at is null;
    end if;
    if c.id is null then
      insert into public.customers(token,name,email,phone,company) values(gen_random_uuid()::text,p_payload->>'customer_name',nullif(p_payload->>'customer_email',''),nullif(p_payload->>'customer_phone',''),v_company) returning * into c;
    end if;
    insert into public.jobs(customer_id,type,address,package,scope,sqft,price,monthly_payment,warranty,dripjobs_url,dripjobs_deal_id,salesperson,signed_date,source,invoice_terms,booked_occurred_at,booking_evidence_ref)
    values(c.id,case when p_payload->>'job_type'='paint' then 'paint' else 'epoxy' end,nullif(p_payload->>'address',''),nullif(p_payload->>'package',''),nullif(p_payload->>'scope',''),nullif(p_payload->>'sqft',''),nullif(p_payload->>'price','')::numeric,nullif(p_payload->>'monthly_payment','')::numeric,nullif(p_payload->>'warranty',''),nullif(p_payload->>'dripjobs_url',''),v_deal,nullif(p_payload->>'salesperson',''),v_date,'dripjobs',nullif(p_payload->>'invoice_terms',''),v_at,'DripJobs proposal '||v_deal) returning * into j;
    v_created:=true;
  end if;
  if not exists(select 1 from public.timeline_stages where job_id=j.id) then
    foreach v_stage in array case when j.type='epoxy' then array['Proposal Accepted','Scheduled','Prep Day','Coating Day','Cure Period','Final Walkthrough','Complete'] else array['Proposal Accepted','Scheduled','Prep','Prime','Paint','Final Walkthrough','Complete'] end loop
      insert into public.timeline_stages(job_id,stage_name,status,completed_at,sort_order) values(j.id,v_stage,case when v_index=0 then 'completed' else 'pending' end,case when v_index=0 then v_at else null end,v_index);
      v_index:=v_index+1;
    end loop;
  end if;
  if v_company='prescott-epoxy' then
    select count(*) into v_count from public.pec_prod_jobs where crm_job_id=j.id or dripjobs_deal_id=v_deal;
    if v_count>1 then raise exception 'Multiple production jobs match the external proposal'; end if;
    select * into p from public.pec_prod_jobs where crm_job_id=j.id or dripjobs_deal_id=v_deal for update;
    if p.id is null then
      insert into public.pec_prod_jobs(proposal_number,customer_id,customer_name,address,revenue,status,sync_status,dripjobs_deal_id,sales_team,notes,crm_job_id)
        values(v_deal,c.id,c.name,j.address,j.price,'unscheduled','dirty',v_deal,j.salesperson,j.scope,j.id) returning * into p;
    elsif p.crm_job_id is null and (p.customer_id is null or p.customer_id=c.id) then
      update public.pec_prod_jobs set crm_job_id=j.id where id=p.id;
    elsif p.crm_job_id is distinct from j.id or (p.customer_id is not null and p.customer_id<>c.id) then raise exception 'Production proposal is linked to another CRM job or customer'; end if;
  end if;
  return jsonb_build_object('job_id',j.id,'prod_job_id',p.id,'customer_id',c.id,'customer_token',c.token,'created',v_created);
end $$;
revoke all on function public.pec_accept_external_job(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.pec_accept_external_job(jsonb) to service_role;


create or replace function topcoat_security_private.capture_signed_change_order()
returns trigger language plpgsql security definer set search_path = '' as $$
declare j public.jobs; v_type text; v_brand text;
begin
  if tg_op in ('UPDATE','DELETE') and old.status='signed' then
    if tg_op='DELETE' then raise exception 'Signed change orders are immutable; record a separate correction'; end if;
    if new.id is distinct from old.id or new.status is distinct from old.status or new.amount is distinct from old.amount or new.job_id is distinct from old.job_id or new.signed_at is distinct from old.signed_at then raise exception 'Signed change-order amounts and dates are immutable; record a separate correction'; end if;
    return new;
  end if;
  if tg_op='DELETE' then return old; end if;
  if new.status<>'signed' then return new; end if;
  if new.signed_at is null or not isfinite(new.signed_at) or new.signed_at>clock_timestamp() or new.amount::text in ('NaN','Infinity','-Infinity') then raise exception 'Signed change order requires its original approval time and finite amount'; end if;
  select * into j from public.jobs where id=new.job_id for update;
  if j.id is null or j.archived_at is not null or j.voided_at is not null then raise exception 'Active CRM job required for change-order acceptance'; end if;
  select case company when 'prescott-epoxy' then 'PEC' else 'FTP' end into v_brand from public.customers where id=j.customer_id;
  foreach v_type in array array['booked','completed'] loop
    if exists(select 1 from public.pec_job_business_events where job_id=j.id and (event_type=v_type or (v_type='completed' and event_type='completion_amended'))) then
      insert into public.pec_job_business_events(job_id,brand,event_type,business_date,occurred_at,amount_snapshot,source,request_key,evidence_ref,actor_id)
        values(j.id,v_brand,v_type||'_adjusted',(new.signed_at at time zone 'America/Phoenix')::date,new.signed_at,new.amount,'signed_change_order','signed-co:'||new.id||':'||v_type,'pec_change_order_signatures/'||new.id,auth.uid());
    end if;
  end loop;
  return new;
end $$;
revoke all on function topcoat_security_private.capture_signed_change_order() from public,anon,authenticated,service_role;
create trigger capture_signed_change_order before insert or update or delete on public.pec_change_order_signatures for each row execute function topcoat_security_private.capture_signed_change_order();
