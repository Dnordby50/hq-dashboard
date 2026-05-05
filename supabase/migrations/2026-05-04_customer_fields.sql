-- 2026-05-04: customer fields rebuild.
--
-- Splits the existing single `name` column on public.customers into structured
-- first_name + last_name + company_name (a customer can be either an individual
-- or a business). Adds a structured billing address (5 fields), a lead_source
-- column backed by a managed list (pec_lead_sources), and a tags array for
-- contact flags ("Dylan's customer", "do not call", etc.). Adds a job_class
-- ('residential'|'commercial') flag to both job tables so we can mark each job.
--
-- The legacy `name` column stays as a denormalized display name so the
-- customer portal that reads it (renderCustomerPortal in index.html, and the
-- get_portal_data RPC) keeps working without changes. The customer form
-- recomputes it on save: company_name if present, else first + last.
--
-- Note on naming: customers.company already exists and stores the BRAND
-- ('prescott-epoxy' | 'finishing-touch'). We are adding a NEW column
-- `company_name` for the customer's business. Two different concepts, two
-- different columns.
--
-- Idempotent. Safe to re-run.

begin;

-- ============================================================================
-- 1) Customer name parts + business name
-- ============================================================================
alter table public.customers add column if not exists first_name   text;
alter table public.customers add column if not exists last_name    text;
alter table public.customers add column if not exists company_name text;  -- the customer's business; NOT the brand

-- Best-effort backfill from the existing single `name` field.
update public.customers
   set first_name = split_part(name, ' ', 1),
       last_name  = case when position(' ' in name) > 0
                          then substring(name from position(' ' in name) + 1)
                          else null end
 where first_name is null
   and last_name is null
   and name is not null;

-- ============================================================================
-- 2) Structured billing address
-- ============================================================================
alter table public.customers add column if not exists billing_address_line1 text;
alter table public.customers add column if not exists billing_address_line2 text;
alter table public.customers add column if not exists billing_city          text;
alter table public.customers add column if not exists billing_state         text;
alter table public.customers add column if not exists billing_zip           text;

-- ============================================================================
-- 3) Lead source (managed list) + tags
-- ============================================================================
alter table public.customers add column if not exists lead_source text;
alter table public.customers add column if not exists tags        text[] not null default '{}';
create index if not exists idx_customers_tags on public.customers using gin(tags);

create table if not exists public.pec_lead_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Seed common lead sources. Dylan can edit/disable in Settings.
insert into public.pec_lead_sources (name) values
  ('Google'),
  ('Facebook'),
  ('Referral'),
  ('Repeat Customer'),
  ('Yard Sign'),
  ('Door Hanger'),
  ('Truck Lettering'),
  ('Home Show'),
  ('Other')
on conflict (name) do nothing;

-- ============================================================================
-- 4) Job class (residential vs commercial) on both job tables
-- ============================================================================
alter table public.jobs add column if not exists job_class text
  check (job_class is null or job_class in ('residential','commercial'));
alter table public.pec_prod_jobs add column if not exists job_class text
  check (job_class is null or job_class in ('residential','commercial'));

-- ============================================================================
-- 5) RLS + updated_at trigger for the new lead_sources table
-- ============================================================================
alter table public.pec_lead_sources enable row level security;
drop policy if exists pec_lead_sources_staff on public.pec_lead_sources;
create policy pec_lead_sources_staff on public.pec_lead_sources for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop trigger if exists trg_pec_lead_sources_touch on public.pec_lead_sources;
create trigger trg_pec_lead_sources_touch before update on public.pec_lead_sources
  for each row execute function public.pec_prod_touch_updated_at();

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='customers'
--       and column_name in ('first_name','last_name','company_name','billing_address_line1','billing_zip','lead_source','tags');
--   -- expect 7 rows
--   select count(*) from public.pec_lead_sources;   -- expect 9 (seeded)
--   select column_name from information_schema.columns
--     where table_schema='public' and column_name='job_class';
--   -- expect 2 rows (one for jobs, one for pec_prod_jobs)
