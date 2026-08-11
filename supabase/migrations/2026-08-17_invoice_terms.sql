-- @artifacts
--   column: public.jobs.invoice_terms
--   column: public.jobs.invoice_due_date
--   setting: invoice_terms_residential_default
--   setting: invoice_terms_commercial_default
-- @end
-- ============================================================================
-- 2026-08-17: invoice-level payment terms + due date (DripJobs-parity batch,
-- phase 1). Author: Claude Code. Idempotent.
--
-- WHY: TopCoat had NO invoice-level terms concept. The only "due" language was
-- the brand fine print at the bottom of the pay page and the per-installment
-- due dates. Dylan's rule (2026-08-10): every invoice states its terms at the
-- TOP; residential defaults to due-upon-completion, commercial defaults to
-- Net 30, editable per invoice. DripJobs models this as an invoice-level
-- "Due On" date; we store the TERM (the rule) and the DATE (its resolution)
-- separately so the rule survives a resend and the date can be stamped when
-- its trigger fires (first send for net terms, completion for
-- due-on-completion).
--
-- PRECEDENCE (locked): when a payment schedule (pec_invoice_installments)
-- exists, the schedule owns every amount and the due box on the pay page; the
-- terms line is informational only. These columns never move money.
--
-- Commercial rule, deterministic, first hit wins (mirrored in
-- _pec-invoice-terms.cjs and the client):
--   1. jobs.job_class = 'commercial' / 'residential'
--   2. source estimate's customer_is_commercial (estimates.job_id -> jobs.id)
--   3. customers.company_name non-empty (NOT customers.company: that column
--      is the BRAND slug, prescott-epoxy | ftp)
--   4. else residential
-- ============================================================================

begin;

alter table public.jobs add column if not exists invoice_terms text;
alter table public.jobs add column if not exists invoice_due_date date;

-- CHECK added separately so reruns are clean (add column if not exists cannot
-- carry a named constraint idempotently).
do $$ begin
  alter table public.jobs add constraint jobs_invoice_terms_check
    check (invoice_terms is null or invoice_terms in
      ('due_on_completion','due_on_receipt','net_15','net_30','custom_date'));
exception when duplicate_object then null; end $$;

insert into public.settings (key, value) values
  ('invoice_terms_residential_default', 'due_on_completion'),
  ('invoice_terms_commercial_default', 'net_30')
on conflict (key) do nothing;

-- Backfill OPEN jobs only (voided/archived stay null: nothing renders them).
-- Runs the commercial rule in SQL. Null-terms only, so a rerun or a manual
-- edit is never overwritten.
with cls as (
  select j.id,
         case
           when j.job_class = 'commercial' then true
           when j.job_class = 'residential' then false
           when e.customer_is_commercial is not null then e.customer_is_commercial
           when coalesce(nullif(trim(c.company_name), ''), null) is not null then true
           else false
         end as is_commercial
    from public.jobs j
    left join public.customers c on c.id = j.customer_id
    left join lateral (
      select customer_is_commercial
        from public.estimates e
       where e.job_id = j.id and e.deleted_at is null
       order by e.created_at desc
       limit 1
    ) e on true
   where j.voided_at is null and j.archived_at is null
)
update public.jobs j
   set invoice_terms = case when cls.is_commercial then 'net_30' else 'due_on_completion' end
  from cls
 where cls.id = j.id
   and j.invoice_terms is null;

-- Derive due dates where the trigger already fired. Phoenix has no DST;
-- 'America/Phoenix' converts the first-send timestamp to the local send DAY.
update public.jobs
   set invoice_due_date = (invoice_first_sent_at at time zone 'America/Phoenix')::date + 30
 where invoice_terms = 'net_30' and invoice_due_date is null and invoice_first_sent_at is not null;
update public.jobs
   set invoice_due_date = (invoice_first_sent_at at time zone 'America/Phoenix')::date + 15
 where invoice_terms = 'net_15' and invoice_due_date is null and invoice_first_sent_at is not null;
update public.jobs
   set invoice_due_date = completed_date
 where invoice_terms = 'due_on_completion' and invoice_due_date is null and completed_date is not null;

-- Recreate pec_job_ar with the two columns APPENDED (create or replace view
-- cannot reorder or drop columns). Definition copied verbatim from
-- 2026-07-10_ar_exclude_archived.sql with ONLY the two new columns added at
-- the end.
create or replace view public.pec_job_ar with (security_invoker = on) as
select
  j.id,
  j.customer_id,
  j.status,
  j.address,
  j.price,
  j.scope,
  j.dripjobs_deal_id,
  j.hq_invoice_number,
  j.salesperson,
  j.bill_to_address,
  j.deposit_amount,
  j.deposit_collected,
  j.signed_date,
  j.completed_date,
  j.line_items,
  j.created_at,
  c.name  as customer_name,
  c.email as customer_email,
  c.phone as customer_phone,
  c.company as customer_company,
  coalesce(p.paid_to_date, 0)                          as paid_to_date,
  coalesce(j.price, 0) - coalesce(p.paid_to_date, 0)   as balance_remaining,
  p.last_payment_date,
  (current_date - j.completed_date)                    as days_outstanding,
  (current_date - j.signed_date)                       as days_since_signed,
  j.deposit_waived,
  j.public_token,
  j.line_items_manual_override,
  j.invoice_first_sent_at,
  j.invoice_terms,
  j.invoice_due_date
from public.jobs j
left join public.customers c on c.id = j.customer_id
left join (
  select job_id,
         sum(amount)        as paid_to_date,
         max(received_date) as last_payment_date
    from public.pec_payments
   group by job_id
) p on p.job_id = j.id
where j.voided_at is null
  and j.archived_at is null;

grant select on public.pec_job_ar to authenticated;

commit;

-- Verify after running:
--   select invoice_terms, count(*) from public.jobs
--     where voided_at is null and archived_at is null group by 1;   -- no nulls
--   select count(*) from public.jobs
--     where invoice_terms = 'net_30' and invoice_first_sent_at is not null
--       and invoice_due_date is null;                               -- 0
--   select invoice_terms, invoice_due_date from public.pec_job_ar limit 1;  -- columns exist
