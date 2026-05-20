-- ============================================================================
-- CRM Jobs: per-area breakdown table
-- ============================================================================
-- A CRM job (public.jobs) can cover multiple areas, each with its own square
-- footage and system type, and (for flake systems) a flake color + coordinating
-- basecoat. public.jobs only has a single sqft / system_type_id, so this table
-- holds the per-area rows. It is the CRM-side parallel of pec_prod_areas (which
-- is keyed to pec_prod_jobs, the production table).
--
-- Every job has at least one area ("Main"). flake_product_id / basecoat_product_id
-- stay null for non-flake systems. on delete set null on the product / system
-- FKs so catalog edits never delete an area; on delete cascade on job_id so
-- removing a job clears its areas.
--
-- Idempotent, non-destructive. Safe to re-run.
-- ============================================================================

create table if not exists public.job_areas (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  name text default 'Main',
  sqft numeric,
  system_type_id uuid references public.pec_prod_system_types(id) on delete set null,
  flake_product_id uuid references public.pec_prod_products(id) on delete set null,
  basecoat_product_id uuid references public.pec_prod_products(id) on delete set null,
  order_index int default 0,
  created_at timestamptz default now()
);

create index if not exists idx_job_areas_job on public.job_areas(job_id);
