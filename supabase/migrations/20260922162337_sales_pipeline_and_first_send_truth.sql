-- @artifacts
--   table: public.pec_estimate_send_attempts
--   table: public.pec_estimate_first_sends
--   index: pec_estimate_send_attempts_estimate_idx
--   index: pec_estimate_send_attempts_pending_idx
--   index: pec_estimate_send_attempts_one_pending_idx
--   index: pec_estimate_first_sends_period_idx
--   index: leads_customer_brand_truth_idx
--   none: Authorized intake RPC, contact-link triggers and immutable send evidence
-- @end
-- Prospective behavior only. This migration does not backfill or redate any
-- existing customer, lead, appointment, estimate or historical send.

create schema if not exists topcoat_sales_private;
revoke all on schema topcoat_sales_private from public, anon, authenticated;
grant usage on schema topcoat_sales_private to authenticated, service_role;

create index if not exists leads_customer_brand_truth_idx
  on public.leads (customer_id, brand, created_at, id) where deleted_at is null;

-- One serialized intake primitive serves the explicit staff RPC and record
-- triggers. SECURITY INVOKER retains the existing staff table/RLS boundaries.
-- The role setting also supports the existing SECURITY DEFINER booking RPC:
-- it retains the caller's PostgREST role even while current_user is its owner.
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
  if not found or v_customer.company is distinct from v_company then
    raise exception 'Customer does not belong to this sales brand' using errcode = '22023';
  end if;

  if p_lead_id is not null then
    select * into v_lead from public.leads where id = p_lead_id and deleted_at is null for update;
    if not found or v_lead.brand is distinct from v_brand then
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
    -- Archived and terminal leads still establish that this is an existing
    -- contact. Reuse them without reopening, unarchiving or redating history.
    select * into v_lead from public.leads
    where customer_id = p_customer_id and brand = v_brand and deleted_at is null
    order by created_at, id limit 1 for update;
  end if;

  if v_lead.id is null then
    insert into public.leads (
      customer_id, brand, source, first_name, last_name, full_name,
      business_name, email, phone, address, city, state, zip, stage,
      contacted_at, estimate_scheduled_at, created_by, created_at
    ) values (
      v_customer.id, v_brand, v_customer.lead_source,
      v_customer.first_name, v_customer.last_name, v_customer.name,
      v_customer.company_name, v_customer.email, v_customer.phone,
      v_customer.billing_address_line1, v_customer.billing_city,
      v_customer.billing_state, v_customer.billing_zip, v_stage,
      case when v_stage = 'estimate_scheduled' then v_at end,
      case when v_stage = 'estimate_scheduled' then v_at end, auth.uid(), v_at
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

create or replace function public.ensure_sales_lead(
  p_customer_id uuid, p_brand text default 'PEC', p_stage text default 'new',
  p_occurred_at timestamptz default null)
returns uuid language sql security invoker set search_path = '' as $$
  select topcoat_sales_private.contact_lead(p_customer_id, null, p_brand, p_stage, p_occurred_at);
$$;
revoke all on function public.ensure_sales_lead(uuid,text,text,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.ensure_sales_lead(uuid,text,text,timestamptz) to authenticated, service_role;

create or replace function topcoat_sales_private.link_sales_record()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_brand text;
  v_stage text := 'new';
begin
  if tg_table_name = 'estimates' and new.lead_id is not null then
    if not exists(select 1 from public.leads where id = new.lead_id
      and brand = new.brand and deleted_at is null) then
      raise exception 'Linked lead does not belong to this sales brand' using errcode = '22023';
    end if;
  end if;
  if tg_table_name = 'pec_appointments' then
    -- Imported Google calendar blocks never create or advance sales leads.
    if new.source = 'google' or new.appt_type <> 'on_site_estimate' then return new; end if;
    if new.status = 'scheduled' then v_stage := 'estimate_scheduled'; end if;
  end if;
  if new.customer_id is null and new.lead_id is not null then
    select customer_id into new.customer_id from public.leads
      where id = new.lead_id and deleted_at is null;
  end if;
  if new.customer_id is null then return new; end if;
  if tg_table_name = 'estimates' then
    v_brand := new.brand;
  else
    select case company when 'prescott-epoxy' then 'PEC' when 'finishing-touch' then 'FTP' end
      into v_brand from public.customers where id = new.customer_id;
    if v_brand is null then raise exception 'Unknown appointment customer brand' using errcode = '22023'; end if;
  end if;
  new.lead_id := topcoat_sales_private.contact_lead(
    new.customer_id, new.lead_id, v_brand, v_stage, new.created_at);
  return new;
end;
$$;
revoke all on function topcoat_sales_private.link_sales_record() from public, anon, authenticated, service_role;

drop trigger if exists trg_appointments_sales_contact_link on public.pec_appointments;
create trigger trg_appointments_sales_contact_link
  before insert or update of customer_id, lead_id, appt_type, status, source on public.pec_appointments
  for each row execute function topcoat_sales_private.link_sales_record();
drop trigger if exists trg_estimates_sales_contact_link on public.estimates;
create trigger trg_estimates_sales_contact_link
  before insert or update of customer_id, lead_id, brand on public.estimates
  for each row execute function topcoat_sales_private.link_sales_record();

create table if not exists public.pec_estimate_send_attempts (
  id uuid primary key default gen_random_uuid(),
  estimate_id uuid not null references public.estimates(id),
  brand text not null check (brand in ('PEC', 'FTP')),
  channel text not null check (channel in ('email', 'sms')),
  recipient text not null check (nullif(btrim(recipient), '') is not null),
  started_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  provider_id text,
  completed_at timestamptz,
  error text,
  constraint pec_estimate_send_attempts_completion_check check (
    (status = 'pending' and completed_at is null and provider_id is null)
    or (status = 'sent' and completed_at is not null and completed_at >= started_at and nullif(btrim(provider_id), '') is not null)
    or (status = 'failed' and completed_at is not null and completed_at >= started_at and provider_id is null)
  )
);
create index if not exists pec_estimate_send_attempts_estimate_idx
  on public.pec_estimate_send_attempts(estimate_id, started_at, id);
create index if not exists pec_estimate_send_attempts_pending_idx
  on public.pec_estimate_send_attempts(brand, started_at, id) where status = 'pending';
create unique index if not exists pec_estimate_send_attempts_one_pending_idx
  on public.pec_estimate_send_attempts(estimate_id, channel) where status = 'pending';

create table if not exists public.pec_estimate_first_sends (
  estimate_id uuid primary key references public.estimates(id),
  brand text not null check (brand in ('PEC', 'FTP')),
  first_sent_at timestamptz not null,
  channel text not null check (channel in ('email', 'sms')),
  evidence_ref text not null check (nullif(btrim(evidence_ref), '') is not null)
);
create index if not exists pec_estimate_first_sends_period_idx
  on public.pec_estimate_first_sends(brand, first_sent_at, estimate_id);

alter table public.pec_estimate_send_attempts enable row level security;
alter table public.pec_estimate_first_sends enable row level security;
revoke all on public.pec_estimate_send_attempts, public.pec_estimate_first_sends from public, anon, authenticated, service_role;
grant select on public.pec_estimate_send_attempts, public.pec_estimate_first_sends to authenticated;
grant select, insert, update on public.pec_estimate_send_attempts to service_role;
grant select, insert, update on public.pec_estimate_first_sends to service_role;
drop policy if exists pec_estimate_send_attempts_staff_read on public.pec_estimate_send_attempts;
create policy pec_estimate_send_attempts_staff_read on public.pec_estimate_send_attempts
  for select to authenticated using (public.is_admin_staff());
drop policy if exists pec_estimate_first_sends_staff_read on public.pec_estimate_first_sends;
create policy pec_estimate_first_sends_staff_read on public.pec_estimate_first_sends
  for select to authenticated using (public.is_admin_staff());

create or replace function topcoat_sales_private.guard_send_evidence()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_brand text;
begin
  select brand into v_brand from public.estimates where id = new.estimate_id;
  if not found or new.brand is distinct from v_brand then
    raise exception 'Send evidence brand must match its estimate' using errcode = '22023';
  end if;
  if tg_table_name = 'pec_estimate_send_attempts' then
    if tg_op = 'INSERT' and new.status <> 'pending' then
      raise exception 'A send attempt must start pending' using errcode = '22023';
    elsif tg_op = 'UPDATE' then
      if new.id is distinct from old.id or new.estimate_id is distinct from old.estimate_id
        or new.brand is distinct from old.brand or new.channel is distinct from old.channel
        or new.recipient is distinct from old.recipient
        or new.started_at is distinct from old.started_at then
        raise exception 'Send attempt identity is immutable' using errcode = '22023';
      end if;
      if old.status <> 'pending' and new is distinct from old then
        raise exception 'Completed send evidence is immutable' using errcode = '22023';
      end if;
    end if;
  elsif tg_op = 'UPDATE' and new is distinct from old then
    -- Only recovery of an earlier provider-accepted attempt may correct the
    -- projection. Resends and direct metadata/date edits cannot restate it.
    if new.estimate_id is distinct from old.estimate_id or new.brand is distinct from old.brand
      or new.first_sent_at >= old.first_sent_at or not exists (
        select 1 from public.pec_estimate_send_attempts a
        where 'attempt:' || a.id::text = new.evidence_ref
          and a.estimate_id = new.estimate_id and a.brand = new.brand
          and a.status = 'sent' and a.channel = new.channel
          and a.completed_at = new.first_sent_at
      ) then
      raise exception 'First-send correction requires earlier verified send evidence' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function topcoat_sales_private.guard_send_evidence() from public, anon, authenticated, service_role;
drop trigger if exists trg_estimate_send_attempt_guard on public.pec_estimate_send_attempts;
create trigger trg_estimate_send_attempt_guard before insert or update on public.pec_estimate_send_attempts
  for each row execute function topcoat_sales_private.guard_send_evidence();
drop trigger if exists trg_estimate_first_send_guard on public.pec_estimate_first_sends;
create trigger trg_estimate_first_send_guard before insert or update on public.pec_estimate_first_sends
  for each row execute function topcoat_sales_private.guard_send_evidence();

create or replace function topcoat_sales_private.record_first_estimate_send()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_estimate public.estimates%rowtype;
  v_lead public.leads%rowtype;
  v_had_first boolean;
begin
  if new.status = 'sent' then
    -- Serialize channels for the same proposal before projecting evidence or
    -- advancing lifecycle; a delayed recovery may supply an earlier receipt.
    select * into v_estimate from public.estimates where id = new.estimate_id for update;
    select exists(select 1 from public.pec_estimate_first_sends where estimate_id = new.estimate_id) into v_had_first;
    insert into public.pec_estimate_first_sends(estimate_id, brand, first_sent_at, channel, evidence_ref)
    values (new.estimate_id, new.brand, new.completed_at, new.channel, 'attempt:' || new.id::text)
    on conflict (estimate_id) do update set
      first_sent_at = excluded.first_sent_at, channel = excluded.channel,
      evidence_ref = excluded.evidence_ref
    where excluded.first_sent_at < public.pec_estimate_first_sends.first_sent_at;

    update public.estimates set status = 'sent',
      sent_at = greatest(sent_at, new.completed_at)
    where id = new.estimate_id and status in ('draft', 'sent', 'change_requested');

    if v_estimate.lead_id is not null then
      select * into v_lead from public.leads
        where id = v_estimate.lead_id and brand = new.brand and deleted_at is null for update;
      if found then
        update public.leads set
          estimate_sent_at = least(estimate_sent_at, new.completed_at),
          stage = case when archived_at is null and stage in ('new', 'contacted', 'estimate_scheduled')
            then 'estimate_sent' else stage end
        where id = v_lead.id;
        if not v_had_first then
          insert into public.lead_events(lead_id, event_type, from_stage, to_stage, payload, created_at)
          values (v_lead.id, 'estimate_sent', v_lead.stage,
            case when v_lead.archived_at is null and v_lead.stage in ('new','contacted','estimate_scheduled')
              then 'estimate_sent' else v_lead.stage end,
            jsonb_build_object('estimate_id', new.estimate_id, 'send_attempt_id', new.id,
              'channel', new.channel, 'provider_id', new.provider_id), new.completed_at);
        end if;
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function topcoat_sales_private.record_first_estimate_send() from public, anon, authenticated, service_role;
drop trigger if exists trg_estimate_send_attempt_completed on public.pec_estimate_send_attempts;
create trigger trg_estimate_send_attempt_completed after update of status on public.pec_estimate_send_attempts
  for each row execute function topcoat_sales_private.record_first_estimate_send();
