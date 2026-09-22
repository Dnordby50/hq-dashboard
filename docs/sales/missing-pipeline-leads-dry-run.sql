-- READ ONLY. Set native_intake_from / selected_from / selected_until from the
-- verified native-intake rollout and report period before running. The null
-- placeholders deliberately return no rows until those review dates are set.
-- This is a review queue, not proof that every customer should be a new lead.
-- Imported contacts and ambiguous old records require separate review. No
-- customer, lead, appointment, estimate, stage or reporting row is changed.
with review_period as (
  select null::timestamptz as native_intake_from,
    null::timestamptz as selected_from,
    null::timestamptz as selected_until
), contact_candidates as (
  select c.id as customer_id, c.company,
    case c.company when 'prescott-epoxy' then 'PEC' when 'finishing-touch' then 'FTP' end as brand,
    c.name, c.email, c.phone, c.lead_source, c.created_at as customer_created_at,
    c.archived_at as customer_archived_at,
    (c.created_at >= r.selected_from and c.created_at < r.selected_until) as in_selected_period
  from public.customers c cross join review_period r
  where r.native_intake_from is not null
    and r.selected_from is not null and r.selected_until is not null
    and c.created_at >= r.native_intake_from
    and c.company in ('prescott-epoxy', 'finishing-touch')
    and not exists (select 1 from public.leads l where l.customer_id = c.id
      and l.brand = case c.company when 'prescott-epoxy' then 'PEC' else 'FTP' end
      and l.deleted_at is null)
), appointment_evidence as (
  select a.customer_id, count(*) as native_estimate_appointments,
    count(*) filter (where status = 'scheduled') as scheduled_estimate_appointments,
    min(a.created_at) as first_native_appointment_created_at,
    jsonb_agg(jsonb_build_object('id',a.id,'lead_id',a.lead_id,'created_at',a.created_at,
      'start_at',a.start_at,'status',a.status,'source',a.source) order by a.created_at,a.id) as appointments
  from public.pec_appointments a join contact_candidates c on c.customer_id = a.customer_id
  where a.appt_type = 'on_site_estimate' and a.source <> 'google'
  group by a.customer_id
), successful_messages as (
  select case brand when 'PEC' then 'PEC' when 'FTP' then 'FTP'
    when 'prescott-epoxy' then 'PEC' when 'finishing-touch' then 'FTP' end as brand,
    sent_at,body_html as body
  from public.pec_email_log
  where template_key = 'estimate'
    and status in ('sent','delivered','opened','clicked','bounced','complained')
    and nullif(btrim(resend_id),'') is not null
  union all
  select case brand when 'PEC' then 'PEC' when 'FTP' then 'FTP'
    when 'prescott-epoxy' then 'PEC' when 'finishing-touch' then 'FTP' end,
    created_at,body
  from public.pec_sms_log where direction='out' and kind='estimate'
    and status in ('sent','delivered') and nullif(btrim(quo_message_id),'') is not null
), verified_send_evidence as (
  select e.id as estimate_id,min(m.sent_at) as first_sent_at
  from successful_messages m
  cross join lateral regexp_matches(coalesce(m.body,''),
    'https?://[^[:space:]"<>]+/e/([A-Za-z0-9_-]+)', 'g') token_match
  join public.estimates e on e.public_token=token_match[1] and e.brand=m.brand
  group by e.id
), estimate_evidence as (
  select e.customer_id, count(*) as estimates,
    count(*) filter (where e.status = 'accepted') as accepted_estimates,
    count(*) filter (where s.estimate_id is not null) as verified_sent_estimates,
    count(*) filter (where e.sent_at is not null or e.status in ('sent','change_requested','signed','accepted')) as legacy_sent_indicators,
    min(e.created_at) as first_estimate_created_at,
    min(s.first_sent_at) as first_verified_send_at,
    jsonb_agg(jsonb_build_object('id',e.id,'lead_id',e.lead_id,'created_at',e.created_at,
      'status',e.status,'sent_at',e.sent_at,'earliest_recovered_receipt_at',s.first_sent_at,
      'first_send_week_reconciliation_required',s.first_sent_at is null
        or e.created_at > s.first_sent_at
        or date_trunc('week',e.created_at at time zone 'America/Phoenix')
          is distinct from date_trunc('week',s.first_sent_at at time zone 'America/Phoenix'))
      order by e.created_at,e.id) as estimate_rows
  from public.estimates e join contact_candidates c on c.customer_id = e.customer_id and c.brand = e.brand
  left join verified_send_evidence s on s.estimate_id = e.id
  where e.deleted_at is null group by e.customer_id
)
select c.*, coalesce(a.native_estimate_appointments,0) as native_estimate_appointments,
  coalesce(a.scheduled_estimate_appointments,0) as scheduled_estimate_appointments,
  a.first_native_appointment_created_at, a.appointments,
  coalesce(e.estimates,0) as estimates, coalesce(e.accepted_estimates,0) as accepted_estimates,
  coalesce(e.verified_sent_estimates,0) as verified_sent_estimates,
  coalesce(e.legacy_sent_indicators,0) as legacy_sent_indicators,
  e.first_estimate_created_at,e.first_verified_send_at,e.estimate_rows
from contact_candidates c
left join appointment_evidence a on a.customer_id = c.customer_id
left join estimate_evidence e on e.customer_id = c.customer_id
order by c.customer_created_at,c.customer_id;
