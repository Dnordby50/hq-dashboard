-- ============================================================================
-- 2026-07-16 (build 18): normalized phone matching for calls + texts.
-- Author: Claude Code. Idempotent. Applied to prod from the build session.
--
-- Why: pec_sms_log.customer_id / pec_call_log.customer_id are the ONLY link
-- between an inbound number and a customer, and they were stamped only by the
-- Quo webhook's format-dependent match (a `phone LIKE %tail%`, which misses a
-- customer whose phone is stored formatted like "(928) 555-1234"). Anything the
-- webhook missed was permanently orphaned as an unclickable "Unknown number".
--
-- The rule, used everywhere with no variants: strip non-digits, take the LAST
-- 10 digits (which drops a leading country-code 1). phone_norm is a STORED
-- generated column so the match is an INDEXED lookup, not a scan. NULL when the
-- phone has fewer than 10 digits (so a partial number never false-matches a
-- full 10-digit inbound tail). customers and leads each get one column + index.
-- ============================================================================

begin;

-- The one normalization, inline (generated columns require immutable exprs;
-- regexp_replace / right / length / case all qualify).
alter table public.customers add column if not exists phone_norm text
  generated always as (
    case when length(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')) >= 10
         then right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)
         else null end
  ) stored;
create index if not exists idx_customers_phone_norm on public.customers (phone_norm);

alter table public.leads add column if not exists phone_norm text
  generated always as (
    case when length(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')) >= 10
         then right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)
         else null end
  ) stored;
create index if not exists idx_leads_phone_norm on public.leads (phone_norm);

-- ---- Backfill customer_id on unmatched call + text rows --------------------
-- Only where the row's OTHER number (the customer's side: from_number when
-- inbound, to_number when outbound) normalizes to EXACTLY ONE customer. A number
-- owned by two customers is left unmatched (a lead/attach decision, not a guess).
create temporary table _quo_uniq_cust on commit drop as
  select phone_norm, (array_agg(id))[1] as customer_id
  from public.customers
  where phone_norm is not null
  group by phone_norm
  having count(*) = 1;  -- exactly one customer owns this number

update public.pec_sms_log s
   set customer_id = u.customer_id
  from _quo_uniq_cust u
 where s.customer_id is null
   and length(regexp_replace(case when s.direction = 'in' then s.from_number else s.to_number end, '[^0-9]', '', 'g')) >= 10
   and u.phone_norm = right(regexp_replace(case when s.direction = 'in' then s.from_number else s.to_number end, '[^0-9]', '', 'g'), 10);

update public.pec_call_log c
   set customer_id = u.customer_id
  from _quo_uniq_cust u
 where c.customer_id is null
   and length(regexp_replace(case when c.direction = 'in' then c.from_number else c.to_number end, '[^0-9]', '', 'g')) >= 10
   and u.phone_norm = right(regexp_replace(case when c.direction = 'in' then c.from_number else c.to_number end, '[^0-9]', '', 'g'), 10);

commit;

-- ============================================================================
-- Verify after running:
--   select count(*) from information_schema.columns
--     where column_name='phone_norm' and table_name in ('customers','leads'); -- 2
--   select indexname from pg_indexes
--     where indexname in ('idx_customers_phone_norm','idx_leads_phone_norm');  -- 2
--   -- unmatched counts AFTER backfill (were 35 sms / 189 call before):
--   select count(*) filter (where customer_id is null) sms_unmatched from pec_sms_log;
--   select count(*) filter (where customer_id is null) call_unmatched from pec_call_log;
--   -- expected: 35 sms still unmatched (those senders are not customers),
--   --           180 call unmatched (9 were backfilled), 0 ambiguous.
-- ============================================================================
