-- ============================================================================
-- 2026-05-24: pec_sales_team_members managed list
-- ============================================================================
-- The Job Schedule popup and Job Costing surfaces currently capture
-- "sales_team" as a free-text input on pec_prod_jobs.sales_team. Free text
-- means naming drifts (Dylan vs Dylan N. vs DN) and analytics is impossible.
-- This adds a managed list of sales-team members, editable from Settings,
-- mirroring the existing pec_lead_sources pattern from
-- supabase/migrations/2026-05-04_customer_fields.sql:57-97.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

begin;

create table if not exists public.pec_sales_team_members (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pec_sales_team_members enable row level security;
drop policy if exists pec_sales_team_members_staff on public.pec_sales_team_members;
create policy pec_sales_team_members_staff on public.pec_sales_team_members for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop trigger if exists trg_pec_sales_team_members_touch on public.pec_sales_team_members;
create trigger trg_pec_sales_team_members_touch before update on public.pec_sales_team_members
  for each row execute function public.pec_prod_touch_updated_at();

commit;

-- Verify after running:
--   select to_regclass('public.pec_sales_team_members');   -- expect non-null
--   select count(*) from public.pec_sales_team_members;    -- expect 0 until Cowork seeds
--
-- Seed step (Cowork handoff): ask Dylan for the current PEC sales-team roster
-- and run:
--   insert into public.pec_sales_team_members (name) values
--     ('Dylan Nordby'),
--     ('<other rep>'),
--     ...
--   on conflict (name) do nothing;
