-- PEC PM Module 1: Ordering / Material Calculator
-- All new tables prefixed pec_prod_*. Nothing in schema.sql or policies.sql changes.
-- Run once in the Supabase SQL editor. Then run supabase/seed_pm_ordering.sql.

create extension if not exists "pgcrypto";

-- ============================================================================
-- pec_prod_products  (catalog of every orderable SKU)
-- ============================================================================
create table if not exists public.pec_prod_products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  material_type text not null check (material_type in ('Basecoat','Flake','Topcoat','Stain','Sealer','Tint Pack','Extra')),
  supplier text,
  color text,
  spread_rate numeric(10,3) not null check (spread_rate > 0),
  kit_size numeric(10,3) not null default 1 check (kit_size > 0),
  unit_cost numeric(12,2),
  effective_date date not null default current_date,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_pec_prod_products_type on public.pec_prod_products(material_type);
create index if not exists idx_pec_prod_products_active on public.pec_prod_products(active);

-- ============================================================================
-- pec_prod_system_types  (Standard Flake, Grind & Seal, Metallic, etc.)
-- ============================================================================
create table if not exists public.pec_prod_system_types (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  description text,
  requires_flake_color boolean not null default false,
  requires_basecoat_color boolean not null default false,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- pec_prod_recipe_slots  (ordered material list per system type)
-- ============================================================================
create table if not exists public.pec_prod_recipe_slots (
  id uuid primary key default gen_random_uuid(),
  system_type_id uuid not null references public.pec_prod_system_types(id) on delete cascade,
  order_index int not null default 0,
  material_type text not null check (material_type in ('Basecoat','Flake','Topcoat','Stain','Sealer','Tint Pack','Extra')),
  default_product_id uuid references public.pec_prod_products(id) on delete set null,
  required boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists idx_pec_prod_recipe_slots_system on public.pec_prod_recipe_slots(system_type_id, order_index);

-- ============================================================================
-- pec_prod_color_pairings  (flake -> basecoat default pairings)
-- ============================================================================
create table if not exists public.pec_prod_color_pairings (
  id uuid primary key default gen_random_uuid(),
  flake_product_id uuid not null references public.pec_prod_products(id) on delete cascade,
  basecoat_product_id uuid not null references public.pec_prod_products(id) on delete cascade,
  is_default boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  unique (flake_product_id, basecoat_product_id)
);
create index if not exists idx_pec_prod_color_pairings_flake on public.pec_prod_color_pairings(flake_product_id);

-- Only one default basecoat pairing per flake.
create unique index if not exists uq_pec_prod_color_pairings_default
  on public.pec_prod_color_pairings(flake_product_id) where is_default = true;

-- ============================================================================
-- pec_prod_jobs  (production job; sibling of public.jobs, not a replacement)
-- ============================================================================
create table if not exists public.pec_prod_jobs (
  id uuid primary key default gen_random_uuid(),
  proposal_number text unique not null,
  customer_name text not null,
  address text,
  install_date date,
  crew text,
  status text not null default 'unscheduled' check (status in ('unscheduled','scheduled','ordered','delivered','completed')),
  revenue numeric(12,2),
  notes text,
  last_synced_at timestamptz,
  sync_status text not null default 'dirty' check (sync_status in ('clean','dirty','error')),
  sync_error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_pec_prod_jobs_install_date on public.pec_prod_jobs(install_date);
create index if not exists idx_pec_prod_jobs_status on public.pec_prod_jobs(status);
create index if not exists idx_pec_prod_jobs_proposal on public.pec_prod_jobs(proposal_number);

-- ============================================================================
-- pec_prod_areas  (one or more areas per job; each its own sqft + system)
-- ============================================================================
create table if not exists public.pec_prod_areas (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.pec_prod_jobs(id) on delete cascade,
  name text not null default 'Main',
  sqft numeric(10,2) not null check (sqft >= 0),
  system_type_id uuid not null references public.pec_prod_system_types(id) on delete restrict,
  flake_product_id uuid references public.pec_prod_products(id) on delete set null,
  basecoat_product_id uuid references public.pec_prod_products(id) on delete set null,
  notes text,
  order_index int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_pec_prod_areas_job on public.pec_prod_areas(job_id, order_index);

-- ============================================================================
-- pec_prod_material_lines  (computed lines, snapshotted unit_cost for Module 2)
-- ============================================================================
create table if not exists public.pec_prod_material_lines (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.pec_prod_jobs(id) on delete cascade,
  area_id uuid references public.pec_prod_areas(id) on delete set null,
  material_type text not null check (material_type in ('Basecoat','Flake','Topcoat','Stain','Sealer','Tint Pack','Extra')),
  product_id uuid references public.pec_prod_products(id) on delete set null,
  product_name text not null,
  supplier text,
  color text,
  spread_rate numeric(10,3) not null,
  kit_size numeric(10,3) not null default 1,
  qty_needed numeric(10,2) not null default 0,
  backstock_qty numeric(10,2) not null default 0,
  order_qty numeric(10,2) not null default 0,
  use_backstock boolean not null default false,
  ordered boolean not null default false,
  delivered boolean not null default false,
  unit_cost_snapshot numeric(12,2),
  line_cost numeric(12,2),
  order_index int not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_pec_prod_material_lines_job on public.pec_prod_material_lines(job_id, order_index);
create index if not exists idx_pec_prod_material_lines_area on public.pec_prod_material_lines(area_id);

-- ============================================================================
-- pec_prod_labor_entries  (schema only in v1, surfaced by Module 2)
-- ============================================================================
create table if not exists public.pec_prod_labor_entries (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.pec_prod_jobs(id) on delete cascade,
  crew_member text not null,
  role text not null check (role in ('Lead','Installer','Helper')),
  hours numeric(8,2) not null check (hours >= 0),
  hourly_rate numeric(10,2) not null check (hourly_rate >= 0),
  date date not null,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists idx_pec_prod_labor_entries_job on public.pec_prod_labor_entries(job_id);

-- ============================================================================
-- pec_prod_overhead_allocations  (schema only in v1)
-- ============================================================================
create table if not exists public.pec_prod_overhead_allocations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  allocation_type text not null check (allocation_type in ('flat_per_job','per_sqft','percent_of_revenue')),
  amount numeric(12,4) not null,
  effective_date date not null default current_date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- updated_at triggers (lightweight)
-- ============================================================================
create or replace function public.pec_prod_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end$$;

drop trigger if exists trg_pec_prod_products_touch on public.pec_prod_products;
create trigger trg_pec_prod_products_touch before update on public.pec_prod_products
  for each row execute function public.pec_prod_touch_updated_at();

drop trigger if exists trg_pec_prod_system_types_touch on public.pec_prod_system_types;
create trigger trg_pec_prod_system_types_touch before update on public.pec_prod_system_types
  for each row execute function public.pec_prod_touch_updated_at();

drop trigger if exists trg_pec_prod_jobs_touch on public.pec_prod_jobs;
create trigger trg_pec_prod_jobs_touch before update on public.pec_prod_jobs
  for each row execute function public.pec_prod_touch_updated_at();

drop trigger if exists trg_pec_prod_areas_touch on public.pec_prod_areas;
create trigger trg_pec_prod_areas_touch before update on public.pec_prod_areas
  for each row execute function public.pec_prod_touch_updated_at();

drop trigger if exists trg_pec_prod_material_lines_touch on public.pec_prod_material_lines;
create trigger trg_pec_prod_material_lines_touch before update on public.pec_prod_material_lines
  for each row execute function public.pec_prod_touch_updated_at();

-- ============================================================================
-- RLS  (matches the convention in supabase/policies.sql:65-67)
-- Staff full access. No anonymous access. Service-role bypasses all of this.
-- ============================================================================
alter table public.pec_prod_products              enable row level security;
alter table public.pec_prod_system_types          enable row level security;
alter table public.pec_prod_recipe_slots          enable row level security;
alter table public.pec_prod_color_pairings        enable row level security;
alter table public.pec_prod_jobs                  enable row level security;
alter table public.pec_prod_areas                 enable row level security;
alter table public.pec_prod_material_lines        enable row level security;
alter table public.pec_prod_labor_entries         enable row level security;
alter table public.pec_prod_overhead_allocations  enable row level security;

drop policy if exists pec_prod_products_staff on public.pec_prod_products;
create policy pec_prod_products_staff on public.pec_prod_products for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists pec_prod_system_types_staff on public.pec_prod_system_types;
create policy pec_prod_system_types_staff on public.pec_prod_system_types for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists pec_prod_recipe_slots_staff on public.pec_prod_recipe_slots;
create policy pec_prod_recipe_slots_staff on public.pec_prod_recipe_slots for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists pec_prod_color_pairings_staff on public.pec_prod_color_pairings;
create policy pec_prod_color_pairings_staff on public.pec_prod_color_pairings for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists pec_prod_jobs_staff on public.pec_prod_jobs;
create policy pec_prod_jobs_staff on public.pec_prod_jobs for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists pec_prod_areas_staff on public.pec_prod_areas;
create policy pec_prod_areas_staff on public.pec_prod_areas for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists pec_prod_material_lines_staff on public.pec_prod_material_lines;
create policy pec_prod_material_lines_staff on public.pec_prod_material_lines for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists pec_prod_labor_entries_staff on public.pec_prod_labor_entries;
create policy pec_prod_labor_entries_staff on public.pec_prod_labor_entries for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists pec_prod_overhead_allocations_staff on public.pec_prod_overhead_allocations;
create policy pec_prod_overhead_allocations_staff on public.pec_prod_overhead_allocations for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());
