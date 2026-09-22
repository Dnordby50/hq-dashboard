-- READ ONLY: prospective ledger rollout review, not a migration or a backfill.
-- Run across ALL available history, not just the selected report period. A
-- later resend must never become the first send because of a date filter.
-- This proposes one earliest provider-accepted send per exact public token.
-- Review these rows before authorizing a separate idempotent insert script.
-- Queued/failed rows, missing provider IDs, inbound SMS, unmatched/prefix
-- tokens and other-brand messages cannot establish a sent proposal.
-- A later bounce still proves the provider accepted the original send; it
-- does not establish that the recipient read or received the proposal.
-- The earliest recovered receipt is NOT a certified historical first send.
-- When creation and receipt span Phoenix weeks, an earlier missing receipt
-- could change weekly totals; reconcile that history before certifying it.
-- Same-week bounds support that week's count, not the exact first-send time.
with successful_messages as (
  select 'email'::text as channel, id::text as log_id,
    case brand when 'PEC' then 'PEC' when 'FTP' then 'FTP'
      when 'prescott-epoxy' then 'PEC' when 'finishing-touch' then 'FTP' end as brand,
    sent_at as sent_at, resend_id as provider_id, body_html as body
  from public.pec_email_log
  where template_key = 'estimate'
    and status in ('sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained')
    and nullif(btrim(resend_id), '') is not null
  union all
  select 'sms', id::text,
    case brand when 'PEC' then 'PEC' when 'FTP' then 'FTP'
      when 'prescott-epoxy' then 'PEC' when 'finishing-touch' then 'FTP' end,
    created_at, quo_message_id, body
  from public.pec_sms_log
  where direction = 'out' and kind = 'estimate' and status in ('sent', 'delivered')
    and nullif(btrim(quo_message_id), '') is not null
), exact_tokens as (
  select distinct m.channel, m.log_id, m.brand, m.sent_at, m.provider_id,
    token_match[1] as public_token
  from successful_messages m
  cross join lateral regexp_matches(coalesce(m.body, ''),
    'https?://[^[:space:]"<>]+/e/([A-Za-z0-9_-]+)', 'g') token_match
), candidates as (
  select e.id as estimate_id, e.brand, e.customer_id, e.lead_id,
    e.public_token, e.status as current_estimate_status,
    e.created_at as estimate_created_at,
    e.deleted_at as estimate_deleted_at, m.sent_at as first_sent_at,
    m.channel, m.provider_id, m.channel || '_log:' || m.log_id as evidence_ref,
    row_number() over (partition by e.id order by m.sent_at, m.channel, m.log_id) as send_rank,
    count(*) over (partition by e.id) as matching_success_messages
  from exact_tokens m
  join public.estimates e on e.public_token = m.public_token and e.brand = m.brand
)
select estimate_id, brand, customer_id, lead_id, public_token,
  current_estimate_status, estimate_created_at, estimate_deleted_at, first_sent_at, channel,
  provider_id, evidence_ref, matching_success_messages,
  date_trunc('week', estimate_created_at at time zone 'America/Phoenix')
    = date_trunc('week', first_sent_at at time zone 'America/Phoenix')
    as creation_receipt_same_phoenix_week,
  (estimate_created_at > first_sent_at
    or date_trunc('week', estimate_created_at at time zone 'America/Phoenix')
      is distinct from date_trunc('week', first_sent_at at time zone 'America/Phoenix'))
    as first_send_week_reconciliation_required
from candidates where send_rank = 1
order by first_sent_at, estimate_id;
