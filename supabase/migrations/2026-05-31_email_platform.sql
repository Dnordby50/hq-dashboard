-- ============================================================================
-- 2026-05-31: transactional email platform (Resend)
-- ============================================================================
-- Stands up the email pipeline tables:
--   pec_email_senders   - from-name / from-email / reply-to per brand (PEC, FTP)
--   pec_email_templates - editable subject + html per (key, brand)
--   pec_email_log       - audit + UI history of every send and its delivery
--                         events (opened / clicked / bounced)
--
-- The API key never touches the browser; the pec-send-email Netlify Function
-- (service role) does the sending and writes pec_email_log. RLS therefore lets
-- staff READ the log but never insert/update it directly; senders + templates
-- are staff-editable from Settings. Reuses public.is_admin_staff() (policies.sql).
--
-- PEC only: brand is always 'prescott-epoxy' (matches customers.company).
-- Seeded from-emails are placeholders Dylan replaces in Settings once the Resend
-- domains are verified.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

begin;

-- 1. Sender identities --------------------------------------------------------
create table if not exists public.pec_email_senders (
  brand      text primary key,
  from_name  text not null,
  from_email text not null,
  reply_to   text,
  updated_at timestamptz not null default now()
);

-- 2. Editable templates -------------------------------------------------------
create table if not exists public.pec_email_templates (
  id         uuid primary key default gen_random_uuid(),
  key        text not null,
  brand      text not null,
  name       text not null,
  subject    text not null,
  html       text not null,
  text_body  text,
  vars       jsonb,
  updated_at timestamptz not null default now(),
  unique (key, brand)
);

-- 3. Send log (audit + UI history) -------------------------------------------
create table if not exists public.pec_email_log (
  id            uuid primary key default gen_random_uuid(),
  sent_at       timestamptz not null default now(),
  sent_by_user  uuid,
  job_id        uuid,
  customer_id   uuid,
  brand         text,
  template_key  text,
  to_email      text,
  from_email    text,
  subject       text,
  status        text not null default 'queued',
  resend_id     text,
  opened_at     timestamptz,
  clicked_at    timestamptz,
  bounced_at    timestamptz,
  error_message text
);
create index if not exists pec_email_log_resend_id_idx on public.pec_email_log (resend_id);
create index if not exists pec_email_log_sent_at_idx    on public.pec_email_log (sent_at desc);

-- 4. RLS ----------------------------------------------------------------------
alter table public.pec_email_senders   enable row level security;
alter table public.pec_email_templates enable row level security;
alter table public.pec_email_log        enable row level security;

-- Senders + templates: staff read + edit.
drop policy if exists pec_email_senders_staff on public.pec_email_senders;
create policy pec_email_senders_staff on public.pec_email_senders for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists pec_email_templates_staff on public.pec_email_templates;
create policy pec_email_templates_staff on public.pec_email_templates for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

-- Log: staff can READ. No insert/update policy -> only the service-role function
-- writes it (service role bypasses RLS).
drop policy if exists pec_email_log_read on public.pec_email_log;
create policy pec_email_log_read on public.pec_email_log for select
  using (public.is_admin_staff());

grant select on public.pec_email_senders, public.pec_email_templates, public.pec_email_log to authenticated;
grant insert, update on public.pec_email_senders, public.pec_email_templates to authenticated;

-- 5. Seeds --------------------------------------------------------------------
-- PEC ONLY. This CRM is Prescott Epoxy only; no Finishing Touch email identity.
-- Clean up any finishing-touch rows in case an earlier version of this migration
-- (which seeded FTP) was already applied.
delete from public.pec_email_templates where brand = 'finishing-touch';
delete from public.pec_email_senders   where brand = 'finishing-touch';

-- Sender identity (placeholder from-email; Dylan sets the real one in Settings).
insert into public.pec_email_senders (brand, from_name, from_email, reply_to) values
  ('prescott-epoxy', 'Prescott Epoxy Company', 'invoices@prescottepoxy.com', null)
on conflict (brand) do nothing;

-- Templates. Tokens are filled by pec-send-email.cjs: {{customer_name}},
-- {{invoice_number}}, {{line_items_table}}, {{total}}, {{balance}},
-- {{portal_link}}, {{brand_name}}, {{from_name}}, {{year}}.
insert into public.pec_email_templates (key, brand, name, subject, html, vars) values
  ('invoice', 'prescott-epoxy', 'Invoice', 'Your invoice from Prescott Epoxy Company',
   '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#0f172a">'
   || '<h2 style="color:#ea580c;margin:0 0 4px">{{brand_name}}</h2>'
   || '<p>Hi {{customer_name}},</p>'
   || '<p>Thank you for your business. Here is your invoice <strong>{{invoice_number}}</strong>.</p>'
   || '{{line_items_table}}'
   || '<p style="font-size:15px;margin-top:16px"><strong>Total: {{total}}</strong><br>Balance due: <strong>{{balance}}</strong></p>'
   || '<p>Questions about this invoice? Just reply to this email.</p>'
   || '<p style="color:#64748b;font-size:12px;border-top:1px solid #e2e8f0;padding-top:10px;margin-top:18px">{{from_name}} &middot; This is a transactional message about your job, not a marketing email.</p>'
   || '</div>',
   '["customer_name","invoice_number","line_items_table","total","balance","portal_link","brand_name","from_name","year"]'::jsonb),

  ('test', 'prescott-epoxy', 'Test', 'TopCoat test email (Prescott Epoxy)',
   '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#0f172a">'
   || '<h2 style="color:#ea580c">{{brand_name}} &middot; test email</h2>'
   || '<p>This is a test send from TopCoat. If you received it, transactional email is working.</p>'
   || '<p style="color:#64748b;font-size:12px">{{from_name}}</p></div>',
   '["brand_name","from_name","year"]'::jsonb)
on conflict (key, brand) do nothing;

commit;

-- Verify after running (PEC only):
--   select count(*) from public.pec_email_senders;    -- expect 1 (prescott-epoxy)
--   select count(*) from public.pec_email_templates;  -- expect 2 (invoice + test, prescott-epoxy)
--   select count(*) from public.pec_email_senders where brand='finishing-touch';  -- expect 0
--   select to_regclass('public.pec_email_log');        -- not null
