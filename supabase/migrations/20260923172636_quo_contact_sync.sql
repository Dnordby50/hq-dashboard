-- @artifacts
--   table: public.pec_quo_contact_sync
--   index: idx_pec_quo_contact_sync_due
--   setting: quo_contact_sync_enabled
--   setting: quo_contact_sync_max_attempts
--   setting: quo_contact_sync_create_missing
--   setting: quo_contact_sync_on_edit
--   setting: ops_check_quo_contact_sync
-- @end
-- ============================================================================
-- 2026-09-23 (prompt 107): push TopCoat lead/customer names to Quo contacts.
-- Author: Claude Code.
--
-- WHY: a phone number created in TopCoat shows up in Quo (OpenPhone) with no
-- name, so calls and texts on all three Quo lines read as bare numbers until
-- someone retypes the name. Nothing in the codebase wrote Quo contacts before
-- this (pec-openphone-sync reads calls, pec-send-sms sends texts,
-- pec-webhook-quo handles message/call events only).
--
-- WHAT:
--   1. pec_quo_contact_sync: ONE queue row per phone_norm (unique) holding
--      the desired first/last/company/email snapshot, the retry state and the
--      Quo contact id once known. A later change on a pending phone
--      OVERWRITES the snapshot (coalesce) instead of adding a row, so two
--      quick edits become one Quo push.
--   2. Enqueue TRIGGERS on public.leads and public.customers (insert, and
--      update of the watched name/phone/email columns). The database write
--      path owns this, so every create path (Angi/Zapier intake, booking,
--      manual, estimator accept, import) is covered without touching each
--      one. Rows with no phone_norm and soft-deleted / archived rows are
--      skipped. When a customer and a lead share a phone the CUSTOMER's name
--      wins (the trigger re-derives the snapshot from the live rows on every
--      fire rather than trusting the row that fired).
--   3. Settings (insert-only): quo_contact_sync_enabled ('true'; the worker
--      no-ops when 'false', the trigger keeps queueing), and behind Advanced
--      quo_contact_sync_max_attempts ('4'), quo_contact_sync_create_missing
--      ('true'), quo_contact_sync_on_edit ('true'); plus the Ops Queue
--      derived-check switch ops_check_quo_contact_sync ('true').
--
-- The worker (netlify/functions/pec-quo-contact-sync.cjs, every 5 minutes)
-- drains due rows; the pure naming rules live in
-- production/quo-contact-sync.cjs. Echo safety: nothing here ever writes a
-- Quo name back onto leads/customers; a future Quo contact webhook must not
-- either.
--
-- Rule 14: the trigger function is SECURITY DEFINER (browser sessions that
-- insert leads may not write the queue directly), so this file was rehearsed
-- in a rolled-back production transaction before the apply. Idempotent.
-- ============================================================================

begin;

create table if not exists public.pec_quo_contact_sync (
  phone_norm text primary key,
  source_table text not null check (source_table in ('leads', 'customers')),
  source_id uuid not null,
  first_name text,
  last_name text,
  company text,
  email text,
  origin text not null default 'insert' check (origin in ('insert', 'update', 'backfill')),
  status text not null default 'pending' check (status in ('pending', 'done', 'skipped', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  quo_contact_id text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_pec_quo_contact_sync_due
  on public.pec_quo_contact_sync (status, next_attempt_at);

-- RLS: staff read (the Ops Queue lists failed rows); no browser writes. The
-- trigger (SECURITY DEFINER) and the service-role worker are the only writers.
alter table public.pec_quo_contact_sync enable row level security;
drop policy if exists pec_quo_contact_sync_staff_read on public.pec_quo_contact_sync;
create policy pec_quo_contact_sync_staff_read on public.pec_quo_contact_sync
  for select using (public.is_admin_staff());
revoke all on public.pec_quo_contact_sync from public, anon, authenticated;
grant select on public.pec_quo_contact_sync to authenticated;
grant all on public.pec_quo_contact_sync to service_role;

drop trigger if exists trg_pec_quo_contact_sync_touch on public.pec_quo_contact_sync;
create trigger trg_pec_quo_contact_sync_touch
  before update on public.pec_quo_contact_sync
  for each row execute function public.pec_prod_touch_updated_at();

-- ---------------------------------------------------------------------------
-- The enqueue. Given a phone_norm, derive the desired snapshot from the live
-- rows (customer first, else newest live lead) and upsert the queue row.
-- Naming rule (locked decision 6, mirrored in production/quo-contact-sync.cjs
-- desiredName): person name in first/last, business in company; when there
-- is no person name at all the business name goes in first name. A legacy
-- combined name (customers.name / leads.full_name) splits on the first space
-- only when the split columns are blank.
-- ---------------------------------------------------------------------------
create or replace function public.pec_quo_contact_enqueue(p_phone text, p_origin text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_first text; v_last text; v_company text; v_email text; v_full text;
  v_table text; v_id uuid;
  c record; l record;
begin
  if p_phone is null or length(p_phone) < 10 then return; end if;
  select id, first_name, last_name, company_name, name, email into c
    from public.customers where phone_norm = p_phone and archived_at is null
    order by created_at desc limit 1;
  if c.id is not null then
    v_table := 'customers'; v_id := c.id;
    v_first := nullif(btrim(coalesce(c.first_name, '')), '');
    v_last := nullif(btrim(coalesce(c.last_name, '')), '');
    v_company := nullif(btrim(coalesce(c.company_name, '')), '');
    v_email := nullif(btrim(coalesce(c.email, '')), '');
    v_full := nullif(btrim(coalesce(c.name, '')), '');
  else
    select id, first_name, last_name, business_name, full_name, email into l
      from public.leads where phone_norm = p_phone and deleted_at is null and archived_at is null
      order by created_at desc limit 1;
    if l.id is null then return; end if;
    v_table := 'leads'; v_id := l.id;
    v_first := nullif(btrim(coalesce(l.first_name, '')), '');
    v_last := nullif(btrim(coalesce(l.last_name, '')), '');
    v_company := nullif(btrim(coalesce(l.business_name, '')), '');
    v_email := nullif(btrim(coalesce(l.email, '')), '');
    v_full := nullif(btrim(coalesce(l.full_name, '')), '');
  end if;
  -- Legacy combined name fills the split columns only when both are blank
  -- and the combined name is not just the business name repeated (a
  -- customers.name of 'Acme Floors' with company_name 'Acme Floors' is a
  -- business, not a person called Acme Floors).
  if v_first is null and v_last is null and v_full is not null
     and (v_company is null or lower(v_full) <> lower(v_company)) then
    v_first := split_part(v_full, ' ', 1);
    v_last := nullif(btrim(substr(v_full, length(split_part(v_full, ' ', 1)) + 1)), '');
  end if;
  -- No person name at all: the business is the name (decision 6).
  if v_first is null and v_last is null and v_company is not null then
    v_first := v_company; v_company := null;
  end if;
  if v_first is null and v_last is null then return; end if; -- nothing to name

  insert into public.pec_quo_contact_sync
    (phone_norm, source_table, source_id, first_name, last_name, company, email, origin,
     status, attempts, next_attempt_at, last_error)
  values (p_phone, v_table, v_id, v_first, v_last, v_company, v_email, coalesce(p_origin, 'insert'),
     'pending', 0, now(), null)
  on conflict (phone_norm) do update set
    source_table = excluded.source_table,
    source_id = excluded.source_id,
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    company = excluded.company,
    email = excluded.email,
    -- An edit after a completed sync is an 'update' push; a fresh insert on
    -- a phone that already synced keeps its first origin only while pending.
    origin = case when public.pec_quo_contact_sync.status = 'pending' then public.pec_quo_contact_sync.origin else excluded.origin end,
    status = 'pending',
    attempts = 0,
    next_attempt_at = now(),
    last_error = null;
end;
$$;
revoke all on function public.pec_quo_contact_enqueue(text, text) from public, anon, authenticated;

create or replace function public.pec_quo_contact_sync_trigger()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_changed boolean := (tg_op = 'INSERT');
  v_origin text := case when tg_op = 'INSERT' then 'insert' else 'update' end;
begin
  if tg_op = 'UPDATE' then
    -- UPDATE OF fires whenever a watched column is in the SET list, even
    -- unchanged; only a real change queues a push.
    if tg_table_name = 'leads' then
      v_changed := old.first_name is distinct from new.first_name
        or old.last_name is distinct from new.last_name
        or old.full_name is distinct from new.full_name
        or old.business_name is distinct from new.business_name
        or old.phone is distinct from new.phone
        or old.email is distinct from new.email;
    else
      v_changed := old.first_name is distinct from new.first_name
        or old.last_name is distinct from new.last_name
        or old.name is distinct from new.name
        or old.company_name is distinct from new.company_name
        or old.phone is distinct from new.phone
        or old.email is distinct from new.email;
    end if;
    if not v_changed then return null; end if;
    -- A phone change also re-derives the OLD number (someone else may own it now).
    if old.phone_norm is distinct from new.phone_norm and old.phone_norm is not null then
      perform public.pec_quo_contact_enqueue(old.phone_norm, 'update');
    end if;
  end if;
  if tg_table_name = 'leads' then
    if new.deleted_at is not null or new.archived_at is not null then return null; end if;
  else
    if new.archived_at is not null then return null; end if;
  end if;
  if new.phone_norm is null then return null; end if;
  perform public.pec_quo_contact_enqueue(new.phone_norm, v_origin);
  return null;
end;
$$;
revoke all on function public.pec_quo_contact_sync_trigger() from public, anon, authenticated;

drop trigger if exists trg_leads_quo_contact_sync on public.leads;
create trigger trg_leads_quo_contact_sync
  after insert or update of first_name, last_name, full_name, business_name, phone, email
  on public.leads for each row execute function public.pec_quo_contact_sync_trigger();

drop trigger if exists trg_customers_quo_contact_sync on public.customers;
create trigger trg_customers_quo_contact_sync
  after insert or update of first_name, last_name, name, company_name, phone, email
  on public.customers for each row execute function public.pec_quo_contact_sync_trigger();

-- Settings (insert-only; an existing value is never overwritten).
insert into public.settings (key, value)
select k, v from (values
  ('quo_contact_sync_enabled', 'true'),
  ('quo_contact_sync_max_attempts', '4'),
  ('quo_contact_sync_create_missing', 'true'),
  ('quo_contact_sync_on_edit', 'true'),
  ('ops_check_quo_contact_sync', 'true')
) as s(k, v)
where not exists (select 1 from public.settings where settings.key = s.k);

commit;

-- Verify after running:
--   select count(*) from public.pec_quo_contact_sync;   -- 0 until the next lead/customer write
--   select tgname from pg_trigger where tgrelid in ('public.leads'::regclass, 'public.customers'::regclass) and tgname like '%quo%';
--   select key, value from public.settings where key like 'quo_contact_sync_%' or key = 'ops_check_quo_contact_sync';
