-- Prescott Epoxy + Finishing Touch portal schema (Postgres / Supabase)
-- Run this once in the Supabase SQL editor before policies.sql and seed_colors.sql.

create extension if not exists "pgcrypto";

-- ============================================================================
-- admin_users  (linked to Supabase Auth)
-- ============================================================================
create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete cascade,
  email text unique not null,
  name text not null,
  role text not null default 'office' check (role in ('admin','office','pm')),
  created_at timestamptz not null default now()
);

-- ============================================================================
-- customers
-- ============================================================================
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  token text unique not null,
  name text not null,
  email text,
  phone text,
  company text not null default 'prescott-epoxy' check (company in ('prescott-epoxy','finishing-touch')),
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_customers_email on public.customers(email);
create index if not exists idx_customers_token on public.customers(token);

-- ============================================================================
-- colors
-- ============================================================================
create table if not exists public.colors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'simiron',   -- 'simiron' today; will open up when other libraries are added
  hex text,
  sku text,                               -- product SKU (Simiron = 1/4″ chip; other libraries will use their own codes)
  swatch_image text,
  category text,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- jobs
-- ============================================================================
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  type text not null check (type in ('epoxy','paint')),
  address text,
  package text,
  status text not null default 'confirmed' check (status in ('confirmed','scheduled','in_progress','completed')),
  scope text,
  sqft text,
  price numeric(12,2),
  monthly_payment numeric(12,2),
  warranty text,
  dripjobs_url text,
  dripjobs_deal_id text,
  confirmed boolean not null default false,
  signature_data text,
  confirmed_at timestamptz,
  source text not null default 'native',
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_jobs_customer on public.jobs(customer_id);
create index if not exists idx_jobs_deal_id on public.jobs(dripjobs_deal_id);

-- ============================================================================
-- job_colors
-- ============================================================================
create table if not exists public.job_colors (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  color_id uuid not null references public.colors(id) on delete restrict,
  label text not null
);
create index if not exists idx_job_colors_job on public.job_colors(job_id);

-- ============================================================================
-- timeline_stages
-- ============================================================================
create table if not exists public.timeline_stages (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  stage_name text not null,
  status text not null default 'pending' check (status in ('pending','in_progress','completed')),
  completed_at timestamptz,
  sort_order int not null default 0
);
create index if not exists idx_timeline_job on public.timeline_stages(job_id);

-- ============================================================================
-- photos
-- ============================================================================
create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  url text not null,
  storage_path text,
  caption text,
  created_at timestamptz not null default now()
);
create index if not exists idx_photos_job on public.photos(job_id);

-- ============================================================================
-- referrals
-- ============================================================================
create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  friend_name text not null,
  friend_phone text,
  friend_email text,
  service_interest text,
  status text not null default 'submitted' check (status in ('submitted','contacted','booked','paid')),
  payment_amount numeric(12,2),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_referrals_customer on public.referrals(customer_id);

-- ============================================================================
-- reviews
-- ============================================================================
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  feedback text,
  created_at timestamptz not null default now()
);
create index if not exists idx_reviews_job on public.reviews(job_id);

-- ============================================================================
-- settings
-- ============================================================================
create table if not exists public.settings (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  value text
);

insert into public.settings (key, value) values
  ('google_review_link_epoxy', 'https://g.page/r/prescottepoxy/review'),
  ('google_review_link_paint', 'https://g.page/r/finishingtouchpainting/review'),
  ('referral_reward_amount', '50')
on conflict (key) do nothing;

-- ============================================================================
-- audit_log
-- ============================================================================
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid,
  admin_email text,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_entity on public.audit_log(entity_type, entity_id);
create index if not exists idx_audit_admin on public.audit_log(auth_user_id);
create index if not exists idx_audit_created on public.audit_log(created_at);

-- ============================================================================
-- sign_in_log  (audit trail of staff sign-ins — IP + timestamp)
-- ============================================================================
create table if not exists public.sign_in_log (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid references auth.users(id) on delete set null,
  email text,
  ip_address text,
  user_agent text,
  signed_in_at timestamptz not null default now()
);
create index if not exists idx_sign_in_log_user on public.sign_in_log(auth_user_id);
create index if not exists idx_sign_in_log_time on public.sign_in_log(signed_in_at desc);
