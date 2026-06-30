-- ============================================================================
-- 2026-06-28: Quo (OpenPhone) SMS platform, phase 1
-- ============================================================================
-- Stands up the SMS pipeline, mirroring the email platform tables
-- (2026-05-31_email_platform.sql) one-for-one so the two stacks stay parallel:
--   pec_sms_senders - brand -> Quo workspace number map (the SMS equivalent of
--                     pec_email_senders). Seeded with the two verified live
--                     numbers: PEC and FTP.
--   pec_sms_log     - audit + UI history of every inbound and outbound text
--                     (the SMS equivalent of pec_email_log).
--   customers.sms_opt_out / sms_opt_out_at - per-customer consent. A STOP reply
--                     (handled by pec-webhook-quo.cjs) flips this true and the
--                     send guard in pec-send-sms.cjs refuses to text an
--                     opted-out customer. Quo also enforces STOP at the carrier
--                     level; this keeps the CRM's own state in sync.
--
-- The Quo API key never touches the browser; the pec-send-sms Netlify Function
-- (service role) does the sending and the pec-webhook-quo Function (service
-- role) writes inbound rows + flips opt-out. RLS therefore lets staff READ the
-- log + senders but never insert/update them directly. Reuses
-- public.is_admin_staff() (policies.sql), same as the email tables.
--
-- Brands match public.customers.company: 'prescott-epoxy' and 'finishing-touch'
-- (the same keys the email + brand-identity tables use).
--
-- Idempotent. Safe to re-run.
-- ============================================================================

begin;

-- 1. Sender identities (brand -> Quo number map) ------------------------------
-- from_number is the Quo workspace number in E.164. quo_inbox_id is Quo's
-- internal phone-number/inbox id (PNxxxxxxxx), kept so the send function can
-- pass userId/inbox context to Quo later without a hardcode in code.
create table if not exists public.pec_sms_senders (
  brand        text primary key,
  from_number  text not null,
  quo_inbox_id text,
  active       boolean not null default true,
  updated_at   timestamptz not null default now()
);

-- 2. Send + receive log (audit + UI history) ----------------------------------
-- direction: 'in' (customer -> us) or 'out' (us -> customer).
-- kind:      'invoice' | 'manual' | 'estimate' | 'system'.
-- status:    'sent' | 'failed' (outbound) or 'received' (inbound).
create table if not exists public.pec_sms_log (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  direction       text not null,
  brand           text,
  from_number     text,
  to_number       text,
  customer_id     uuid,
  job_id          uuid,
  body            text,
  kind            text,
  status          text not null default 'sent',
  quo_message_id  text,
  error_message   text,
  sent_by_user    uuid
);
create index if not exists pec_sms_log_customer_idx   on public.pec_sms_log (customer_id, created_at desc);
create index if not exists pec_sms_log_created_at_idx  on public.pec_sms_log (created_at desc);
create index if not exists pec_sms_log_quo_msg_idx     on public.pec_sms_log (quo_message_id);

-- 3. Customer consent ---------------------------------------------------------
-- All 78 customers already have a phone. Default false = opted in (transactional
-- texting about their own job, with a STOP line on every send).
alter table public.customers
  add column if not exists sms_opt_out    boolean not null default false,
  add column if not exists sms_opt_out_at timestamptz;

-- 4. RLS ----------------------------------------------------------------------
alter table public.pec_sms_senders enable row level security;
alter table public.pec_sms_log     enable row level security;

-- Senders: staff read. Edits go through the service-role function / Supabase
-- Studio, not the client, so there is no client write policy (matches how the
-- email log is policed; senders are rarely edited and never from the browser).
drop policy if exists pec_sms_senders_read on public.pec_sms_senders;
create policy pec_sms_senders_read on public.pec_sms_senders for select
  using (public.is_admin_staff());

-- Log: staff can READ. No insert/update policy -> only the service-role
-- functions (pec-send-sms, pec-webhook-quo) write it (service role bypasses RLS).
drop policy if exists pec_sms_log_read on public.pec_sms_log;
create policy pec_sms_log_read on public.pec_sms_log for select
  using (public.is_admin_staff());

grant select on public.pec_sms_senders, public.pec_sms_log to authenticated;

-- 5. Seeds (the two verified live Quo numbers) --------------------------------
-- DO NOT hardcode these in code; the functions read them from this table.
insert into public.pec_sms_senders (brand, from_number, quo_inbox_id, active) values
  ('prescott-epoxy',  '+19288008154', 'PNY8vPVPEZ', true),
  ('finishing-touch', '+19283561243', 'PNbl4NYbrM', true)
on conflict (brand) do update
  set from_number  = excluded.from_number,
      quo_inbox_id = excluded.quo_inbox_id,
      active       = excluded.active,
      updated_at   = now();

commit;

-- Verify after running:
--   select count(*) from public.pec_sms_senders;                 -- expect 2
--   select brand, from_number from public.pec_sms_senders order by brand;
--     -- finishing-touch +19283561243 / prescott-epoxy +19288008154
--   select to_regclass('public.pec_sms_log');                    -- not null
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='customers'
--       and column_name in ('sms_opt_out','sms_opt_out_at');     -- 2 rows
