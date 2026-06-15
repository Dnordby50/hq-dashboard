-- ============================================================================
-- 2026-06-15: track when a job's invoice was first emailed (AR-timing metric).
-- Author: Claude Code. RUN BY COWORK on the PROD Supabase project. Idempotent.
-- NOT applied to prod from the Claude Code session.
--
-- Powers the Metrics "Invoiced before completion" KPI: of completed jobs, the
-- share whose invoice went out on a calendar day BEFORE completion (so the
-- customer could pay on completion day). The client stamps this on the FIRST
-- successful invoice send only (null-guarded; first send wins, never overwritten).
-- ============================================================================

begin;

alter table public.jobs
  add column if not exists invoice_first_sent_at timestamptz;

-- Recreate pec_job_ar with invoice_first_sent_at appended LAST (definition
-- copied from 2026-06-07_line_items_manual_override.sql plus the one new column;
-- CREATE OR REPLACE VIEW can only append columns, not reorder).
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
  j.invoice_first_sent_at
from public.jobs j
left join public.customers c on c.id = j.customer_id
left join (
  select job_id,
         sum(amount)        as paid_to_date,
         max(received_date) as last_payment_date
    from public.pec_payments
   group by job_id
) p on p.job_id = j.id
where j.voided_at is null;

grant select on public.pec_job_ar to authenticated;

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_name='jobs' and column_name='invoice_first_sent_at';     -- 1 row
--   select invoice_first_sent_at from public.pec_job_ar limit 1;           -- resolves
