-- ============================================================================
-- 2026-05-27: Invoicing & AR module, Phase 1 schema
-- ============================================================================
-- Stands up the data layer for the new Invoicing + Metrics tabs. The module
-- reuses the existing public.jobs row as the single source of truth (it is
-- already populated by pec-webhook-proposal-accepted.cjs with customer, price,
-- scope, status, and the DripJobs deal id), and adds a payments ledger on the
-- side. AR buckets and balances are derived in queries, not stored.
--
-- Column mapping (existing -> invoicing concept):
--   jobs.price            = total invoice amount
--   jobs.scope            = scope-of-work narrative
--   jobs.dripjobs_deal_id = DripJobs invoice number (used during transition)
--   jobs.status           = production lifecycle (signed/scheduled/in_progress/
--                           completed). We deliberately do NOT add 'paid_in_full'
--                           or 'voided' to jobs_status_check -- payment state is
--                           derived from the payments ledger, and voided invoices
--                           are flagged via jobs.voided_at.
--
-- What this migration does:
--   1. Adds invoicing columns to public.jobs.
--   2. Backfills signed_date, completed_date, and a default 50% deposit_amount
--      on existing rows (idempotent: only fills NULLs).
--   3. Creates public.pec_payments (the payment ledger).
--   4. Adds supporting indexes.
--   5. Enables staff-wide RLS on pec_payments (matches existing posture).
--   6. Adds 'crew' to admin_users.role for forward-compat (crew login lands in
--      Phase 3; column-level crew RLS is deferred).
--   7. Creates the public.pec_job_ar view (security_invoker) that the Invoicing
--      tab reads: every non-voided job with paid_to_date, balance_remaining,
--      days_outstanding, and days_since_signed.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

begin;

-- 1. Invoicing columns on public.jobs ---------------------------------------
alter table public.jobs
  add column if not exists deposit_amount    numeric(12,2),
  add column if not exists deposit_collected boolean not null default false,
  add column if not exists signed_date       date,
  add column if not exists completed_date    date,
  add column if not exists salesperson       text,
  add column if not exists bill_to_address   text,
  add column if not exists line_items        jsonb,
  add column if not exists hq_invoice_number text,
  add column if not exists voided_at         timestamptz;

-- 2. Backfill existing rows (only fills NULLs) ------------------------------
-- signed_date: webhook rows are created when the proposal is accepted, so
-- created_at is the best available proxy for the signed date.
update public.jobs
   set signed_date = created_at::date
 where signed_date is null;

-- completed_date: bridge from the production row's completed_at where the CRM
-- job is already marked completed but has no completed_date yet.
update public.jobs j
   set completed_date = pp.completed_at::date
  from public.pec_prod_jobs pp
 where j.dripjobs_deal_id = pp.dripjobs_deal_id
   and j.status = 'completed'
   and j.completed_date is null
   and pp.completed_at is not null;

-- deposit_amount: default to 50% of price (editable per job later).
update public.jobs
   set deposit_amount = round(price * 0.50, 2)
 where deposit_amount is null
   and price is not null;

-- 3. Payment ledger ---------------------------------------------------------
create table if not exists public.pec_payments (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.jobs(id) on delete cascade,
  amount        numeric(12,2) not null,
  method        text not null check (method in ('stripe','check','cash','zelle')),
  reference     text,
  received_date date not null default (now() at time zone 'America/Phoenix')::date,
  recorded_by   text,
  recorded_at   timestamptz not null default now(),
  notes         text
);

-- 4. Indexes ----------------------------------------------------------------
create index if not exists idx_jobs_status         on public.jobs(status);
create index if not exists idx_jobs_salesperson    on public.jobs(salesperson) where salesperson is not null;
create index if not exists idx_jobs_completed_date  on public.jobs(completed_date) where completed_date is not null;
create index if not exists idx_jobs_signed_date     on public.jobs(signed_date);
create index if not exists idx_pec_payments_job     on public.pec_payments(job_id);
create index if not exists idx_pec_payments_recvd   on public.pec_payments(received_date);

-- 5. RLS: staff-wide, mirrors every other PEC table -------------------------
alter table public.pec_payments enable row level security;
drop policy if exists pec_payments_staff on public.pec_payments;
create policy pec_payments_staff on public.pec_payments for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

-- 6. Forward-compat: allow a 'crew' role (login + crew RLS land in Phase 3) --
alter table public.admin_users drop constraint if exists admin_users_role_check;
alter table public.admin_users
  add constraint admin_users_role_check check (role in ('admin','office','pm','crew'));

-- 7. AR view ----------------------------------------------------------------
-- security_invoker = on so the underlying RLS on jobs / customers / pec_payments
-- applies to the calling user (staff only). Exposes every non-voided job with
-- its rolled-up payment totals and aging counters.
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
  (current_date - j.signed_date)                       as days_since_signed
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
--   select column_name, data_type from information_schema.columns
--     where table_schema='public' and table_name='jobs'
--       and column_name in ('deposit_amount','deposit_collected','signed_date',
--         'completed_date','salesperson','bill_to_address','line_items',
--         'hq_invoice_number','voided_at')
--     order by column_name;
--   -- expect: all 9 columns present.
--
--   select count(*) filter (where signed_date is null) as null_signed,
--          count(*) filter (where deposit_amount is null and price is not null) as null_deposit
--     from public.jobs;
--   -- expect: both 0.
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--     where conrelid='public.admin_users'::regclass and conname='admin_users_role_check';
--   -- expect: check ... role in ('admin','office','pm','crew').
--
--   select * from public.pec_job_ar limit 5;
--   -- expect: rows with balance_remaining, days_outstanding, days_since_signed.
