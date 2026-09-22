#!/usr/bin/env node
'use strict';

// Emit SQL only; never connects to a database or sends a customer message.
// Default/--dry-run: read-only review. --apply: one transaction for an already
// authorized operator to execute through the existing private SQL connection.
const KEY = 'sales-pipeline-2026-09-14-reviewed-2026-09-22';
const REVIEWED = [
  ['dae1ad0b-cb9c-48e0-820d-613efc035a64', '2026-09-14T16:08:29.880388Z', 'Google', 'estimate_sent', ['f9d1d623-0c32-44d2-8a55-ee876e69f87f'], ['15daffb0-3410-4c65-af88-990148dcecfd']],
  ['9e690bba-066c-4daa-a14b-cc8c9af97b2d', '2026-09-14T18:03:13.034290Z', 'Google', 'accepted', ['5c894243-2e4c-4a6b-8820-5458dfb8b76e'], ['4726779a-4e30-492c-b56c-2040f578f8f9']],
  ['09d1b7bb-fb09-4f7b-923a-493147e3b4ea', '2026-09-14T18:30:57.344773Z', 'Magazine AD', 'new', ['b7ab1ca4-c5cc-4d00-87b2-4958bd946f02'], []],
  ['efbf1825-b187-4e0d-bba5-b926b8c262af', '2026-09-14T19:00:31.590634Z', 'Google', 'new', [], []],
  ['f221f7aa-35e0-4b40-9166-3691a190f06e', '2026-09-14T21:37:22.832037Z', 'Repeat Customer', 'estimate_sent', [], ['096e0116-937b-487c-a8e2-72142122f7a1']],
  ['1837eeb8-ea1d-49f4-9dfa-af58b4b6c14b', '2026-09-14T21:51:49.582535Z', 'Repeat Customer', 'estimate_sent', [], ['a4eeb0fa-59de-455d-95c2-c2356fdceb45', 'de6657ef-5c9c-40dd-b3e3-4da841f2eff5']],
  ['88646d80-7317-4097-b416-f20d37521b0b', '2026-09-15T17:06:10.553178Z', 'Referral', 'accepted', [], ['e72134fa-98e0-4536-9426-fe8bbcd74fa1']],
];
const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
const uuidArray = values => 'array[' + values.slice().sort().map(value => quote(value) + '::uuid').join(',') + ']::uuid[]';
const ids = uuidArray(REVIEWED.map(row => row[0]));
const values = REVIEWED.map(([id, at, source, stage, appointments, estimates]) =>
  `(${quote(id)}::uuid,${quote(at)}::timestamptz,${quote(source)},${quote(stage)},${uuidArray(appointments)},${uuidArray(estimates)})`).join(',\n');
const PLAN = `with reviewed(customer_id,first_contact_at,expected_source,expected_stage,expected_appointments,expected_estimates) as (values
${values}
), proposals as (
  select e.* from public.estimates e join reviewed r on r.customer_id=e.customer_id
  where e.brand='PEC' and e.deleted_at is null
), receipts as (
  select e.customer_id,e.id as estimate_id,m.sent_at as occurred_at
  from proposals e join public.pec_email_log m on m.template_key='estimate'
    and m.brand in ('PEC','prescott-epoxy')
    and m.status in ('sent','delivered','opened','clicked','bounced','complained')
    and nullif(btrim(m.resend_id),'') is not null
  where exists(select 1 from regexp_matches(coalesce(m.body_html,''),
    'https?://[^[:space:]"<>]+/e/([A-Za-z0-9_-]+)','g') t where t[1]=e.public_token)
  union all
  select e.customer_id,e.id,m.created_at
  from proposals e join public.pec_sms_log m on m.kind='estimate' and m.direction='out'
    and m.brand in ('PEC','prescott-epoxy') and m.status in ('sent','delivered')
    and nullif(btrim(m.quo_message_id),'') is not null
  where exists(select 1 from regexp_matches(coalesce(m.body,''),
    'https?://[^[:space:]"<>]+/e/([A-Za-z0-9_-]+)','g') t where t[1]=e.public_token)
  union all
  select e.customer_id,e.id,s.first_sent_at from proposals e
    join public.pec_estimate_first_sends s on s.estimate_id=e.id and s.brand='PEC'
), facts as (
  select r.*,c.name,c.company,c.created_at,c.archived_at,c.lead_source,
    coalesce((select array_agg(a.id order by a.id) from public.pec_appointments a where a.customer_id=c.id and a.source<>'google'),'{}'::uuid[]) appointment_ids,
    coalesce((select array_agg(e.id order by e.id) from proposals e where e.customer_id=c.id),'{}'::uuid[]) estimate_ids,
    (select min(a.created_at) from public.pec_appointments a where a.customer_id=c.id and a.source<>'google' and a.appt_type='on_site_estimate') estimate_scheduled_at,
    (select count(*) from public.pec_appointments a where a.customer_id=c.id and a.source<>'google' and a.appt_type='on_site_estimate' and a.status='scheduled') scheduled_estimates,
    (select min(coalesce(e.accepted_at,e.signed_at)) from proposals e where e.customer_id=c.id and e.status='accepted') accepted_at,
    (select count(*) from proposals e where e.customer_id=c.id and e.status='accepted') accepted_count,
    (select min(m.occurred_at) from receipts m where m.customer_id=c.id) first_verified_send_at,
    (select count(*) from public.leads l where l.customer_id=c.id and l.brand='PEC' and l.deleted_at is null) existing_leads,
    (select count(*) from public.customers o where o.id<>c.id and (
      nullif(lower(btrim(o.email)),'')=nullif(lower(btrim(c.email)),'')
      or (length(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'))>=10
        and right(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'),10)=right(regexp_replace(coalesce(o.phone,''),'[^0-9]','','g'),10))
      or lower(btrim(o.name))=lower(btrim(c.name)))) other_customer_matches,
    (select count(*) from public.leads l where l.customer_id is distinct from c.id and l.deleted_at is null and l.brand='PEC' and (
      nullif(lower(btrim(l.email)),'')=nullif(lower(btrim(c.email)),'')
      or (length(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'))>=10
        and right(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'),10)=right(regexp_replace(coalesce(l.phone,''),'[^0-9]','','g'),10)))) other_lead_matches
  from reviewed r left join public.customers c on c.id=r.customer_id
), plan as (
  select *,case when accepted_count>0 then 'accepted' when first_verified_send_at is not null then 'estimate_sent'
    when scheduled_estimates>0 then 'estimate_scheduled' else 'new' end proposed_stage,
    case when expected_source='Repeat Customer' then 'Existing business relationship; date is the reviewed new TopCoat contact record, not first-ever contact.'
      when cardinality(appointment_ids)=0 and cardinality(estimate_ids)=0 then 'Reviewed contact-only inquiry; no appointment/proposal date to corroborate first contact.'
      else 'Native appointment/proposal supports the reviewed contact record.' end coverage_note
  from facts
) select * from plan order by first_contact_at,customer_id`;

function buildSql(apply = false) {
  if (!apply) return '-- READ ONLY: seven explicitly reviewed contacts; no writes.\n' + PLAN + ';\n';
  return `-- Authorized targeted reconciliation. All mutations commit together; errors roll back.
begin;
set local role service_role;
set local lock_timeout='8s';
set local statement_timeout='60s';
select set_config('topcoat.actor','Historical sales reconciliation 2026-09-22',true);
do $reconcile$
declare v_record record; v_customer_id uuid; v_lead_id uuid; v_existing public.leads%rowtype; v_done boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(${quote(KEY)},0));
  -- Use the intake RPC's lock before reading its existing-lead evidence.
  -- All repair IDs lock in UUID order; concurrent intake cannot slip between
  -- the missing-lead check and the call that creates the historical lead.
  for v_customer_id in select unnest(${ids}) order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended('sales-lead:PEC:'||v_customer_id::text,0));
  end loop;
  perform id from public.customers where id=any(${ids}) order by id for update;
  perform id from public.estimates where customer_id=any(${ids}) order by id for update;
  perform id from public.pec_appointments where customer_id=any(${ids}) order by id for update;
  for v_record in ${PLAN} loop
    if v_record.name is null or v_record.company is distinct from 'prescott-epoxy' or v_record.archived_at is not null
      or v_record.created_at is distinct from v_record.first_contact_at or v_record.lead_source is distinct from v_record.expected_source
      or v_record.appointment_ids is distinct from v_record.expected_appointments or v_record.estimate_ids is distinct from v_record.expected_estimates
      or v_record.proposed_stage is distinct from v_record.expected_stage or v_record.other_customer_matches<>0 or v_record.other_lead_matches<>0
      or v_record.existing_leads>1 or (v_record.proposed_stage='accepted' and v_record.accepted_at is null)
      or (v_record.accepted_at is not null and v_record.accepted_at<v_record.first_contact_at)
      or (v_record.first_verified_send_at is not null and v_record.first_verified_send_at<v_record.first_contact_at)
      or (v_record.estimate_scheduled_at is not null and v_record.estimate_scheduled_at<v_record.first_contact_at) then
      raise exception 'Reviewed evidence changed or is ambiguous for customer %; rerun dry-run',v_record.customer_id;
    end if;
    select * into v_existing from public.leads where customer_id=v_record.customer_id and brand='PEC' and deleted_at is null order by created_at,id limit 1 for update;
    v_done := v_existing.id is not null and exists(select 1 from public.lead_events ev
      where ev.lead_id=v_existing.id and ev.payload->>'reconciliation_key'=${quote(KEY)});
    if v_existing.id is not null and not v_done then
      raise exception 'Customer % acquired an unreviewed lead; preserve it and review again',v_record.customer_id;
    end if;
    v_lead_id := public.ensure_sales_lead(v_record.customer_id,'PEC','new',v_record.first_contact_at);
    if not v_done then
      -- Only the lead created by this transaction receives historical state.
      -- Existing lead stage/date changes are never overwritten on replay.
      update public.leads set stage=v_record.proposed_stage,
        contacted_at=least(v_record.estimate_scheduled_at,v_record.first_verified_send_at,v_record.accepted_at),
        estimate_scheduled_at=v_record.estimate_scheduled_at,
        estimate_sent_at=v_record.first_verified_send_at,accepted_at=v_record.accepted_at
      where id=v_lead_id and customer_id=v_record.customer_id and created_at=v_record.first_contact_at
        and stage='new' and archived_at is null and deleted_at is null;
      if not found then raise exception 'New reconciliation lead changed for customer %',v_record.customer_id; end if;
      insert into public.lead_events(lead_id,event_type,from_stage,to_stage,payload)
      values(v_lead_id,'note','new',v_record.proposed_stage,jsonb_build_object(
        'reconciliation_key',${quote(KEY)},'customer_id',v_record.customer_id,
        'original_contact_at',v_record.first_contact_at,'appointment_ids',v_record.appointment_ids,
        'estimate_ids',v_record.estimate_ids,'first_verified_send_at',v_record.first_verified_send_at,
        'accepted_at',v_record.accepted_at,'coverage_note',v_record.coverage_note,
        'text','Historical pipeline link restored from reviewed original records. No customer messages or nurture enrollment.'));
    end if;
    if exists(select 1 from public.estimates where id=any(v_record.estimate_ids) and lead_id is not null and lead_id<>v_lead_id)
      or exists(select 1 from public.pec_appointments where id=any(v_record.appointment_ids) and lead_id is not null and lead_id<>v_lead_id) then
      raise exception 'Existing record lead link must be preserved for customer %',v_record.customer_id;
    end if;
    update public.estimates set lead_id=v_lead_id where id=any(v_record.estimate_ids) and customer_id=v_record.customer_id and lead_id is null;
    -- Includes Becky site_visit linkage only; no on-site-estimate is invented.
    update public.pec_appointments set lead_id=v_lead_id where id=any(v_record.appointment_ids) and customer_id=v_record.customer_id and lead_id is null;
    if exists(select 1 from public.estimates where id=any(v_record.estimate_ids) and lead_id is distinct from v_lead_id)
      or exists(select 1 from public.pec_appointments where id=any(v_record.appointment_ids) and lead_id is distinct from v_lead_id) then
      raise exception 'Historical links did not persist for customer %',v_record.customer_id;
    end if;
  end loop;
end;
$reconcile$;
select c.id as customer_id,c.name,l.id as lead_id,l.stage,l.created_at,l.estimate_scheduled_at,l.estimate_sent_at,l.accepted_at
from public.customers c join public.leads l on l.customer_id=c.id and l.brand='PEC' and l.deleted_at is null
where c.id=any(${ids}) order by c.created_at;
commit;
`;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--dry-run','--apply'].includes(arg)) || args.length>1) {
    console.error('Usage: node scripts/reconcile-sales-week-2026-09-14.cjs [--dry-run|--apply] > reviewed.sql');
    process.exitCode=2;
  } else process.stdout.write(buildSql(args[0]==='--apply'));
}
module.exports = { REVIEWED, KEY, buildSql };
