-- ============================================================================
-- 2026-06-01: brand identity + public hosted invoice
-- ============================================================================
-- Three things:
--   1. pec_brand_identity (one row per brand) - logo, colors, address, phone,
--      license, payment instructions. The email "chrome" (header/signature/
--      footer) and the public invoice page both read this, so editing brand
--      identity restyles every email + the hosted page with no template edits.
--   2. public.jobs.public_token (unguessable v4 UUID) -> the customer-facing
--      hosted invoice URL /pay/<token>. public_token_revoked_at is reserved for
--      a future "invalidate link" action (no UI yet). pec_job_ar is recreated to
--      expose public_token (the view uses an explicit column list, and Postgres
--      CREATE OR REPLACE VIEW only allows APPENDING columns, so public_token goes
--      LAST -- same 42P16 rule as the deposit_waived migration).
--   3. Convert the two PEC email templates to BODY-ONLY content (the chrome is
--      added by the render layer now). Done with explicit UPDATE -- NOT
--      insert-on-conflict, which would skip the existing rows.
--
-- PEC only. Idempotent. Safe to re-run.
-- ============================================================================

begin;

-- 1. Brand identity -----------------------------------------------------------
create table if not exists public.pec_brand_identity (
  brand                    text primary key,
  logo_url                 text,
  primary_color            text not null default '#1e3a5f',
  accent_color             text not null default '#ea580c',
  business_name            text not null,
  address_line             text not null,
  phone                    text,
  license_number           text,
  website                  text,
  footer_disclaimer        text,
  payment_instructions_html text,
  updated_at               timestamptz not null default now()
);

alter table public.pec_brand_identity enable row level security;
drop policy if exists pec_brand_identity_staff on public.pec_brand_identity;
create policy pec_brand_identity_staff on public.pec_brand_identity for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());
grant select, insert, update on public.pec_brand_identity to authenticated;

insert into public.pec_brand_identity
  (brand, logo_url, primary_color, accent_color, business_name, address_line, phone, license_number, website, footer_disclaimer, payment_instructions_html)
values
  ('prescott-epoxy', null, '#1e3a5f', '#ea580c', 'Prescott Epoxy Company',
   '1030 Sandretto Dr Suite K, Prescott, AZ 86305', '(928) 800-8154', 'ROC353243', 'prescottepoxy.com',
   'This is a transactional message about your job, not a marketing email.',
   '<p>To pay by check, mail to Prescott Epoxy Company, 1030 Sandretto Dr Suite K, Prescott, AZ 86305.</p><p>To pay by phone, call (928) 800-8154.</p><p>To pay by reply, hit Reply on the email we sent you with your preferred method and we will follow up.</p>')
on conflict (brand) do nothing;

-- 2. Public token on jobs -----------------------------------------------------
alter table public.jobs
  add column if not exists public_token uuid not null default gen_random_uuid(),
  add column if not exists public_token_revoked_at timestamptz;
create unique index if not exists pec_jobs_public_token_idx on public.jobs(public_token);

-- Recreate pec_job_ar with public_token appended LAST (definition copied from
-- 2026-05-30_deposit_waived.sql plus the one new column).
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
  j.public_token
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

-- 3. Convert PEC templates to body-only (explicit UPDATE; rows already exist) --
update public.pec_email_templates set
  subject = 'Invoice {{invoice_number}} from {{business_name}}',
  html =
       '<p>Hi {{customer_name}},</p>'
    || '<p>Thank you for your business. Here is your invoice <strong>{{invoice_number}}</strong>.</p>'
    || '{{line_items_table}}'
    || '<p style="font-size:15px;margin-top:16px"><strong>Total: {{total}}</strong><br>Balance due: <strong>{{balance}}</strong></p>'
    || '<p>{{cta}}</p>'
    || '<p>Questions about this invoice? Just reply to this email.</p>',
  vars = '["customer_name","invoice_number","line_items_table","total","balance","cta","business_name","year"]'::jsonb,
  updated_at = now()
where key = 'invoice' and brand = 'prescott-epoxy';

update public.pec_email_templates set
  subject = 'TopCoat test email',
  html = '<p>This is a test send from TopCoat. If you received it, transactional email is working.</p>',
  vars = '["business_name","year"]'::jsonb,
  updated_at = now()
where key = 'test' and brand = 'prescott-epoxy';

commit;

-- Verify after running:
--   select count(*) from public.pec_brand_identity;                                    -- expect 1
--   select brand from public.pec_brand_identity;                                       -- prescott-epoxy
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='jobs' and column_name='public_token';-- 1 row
--   select public_token from public.pec_job_ar limit 1;                                -- resolves (in the view)
--   select subject from public.pec_email_templates where key='invoice' and brand='prescott-epoxy';
--     -- expect: Invoice {{invoice_number}} from {{business_name}}
