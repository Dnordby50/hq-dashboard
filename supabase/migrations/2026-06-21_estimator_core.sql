-- ============================================================================
-- 2026-06-21: Estimator / lead+sales CRM beta -- Migration set #1 (core tables).
-- Author: Claude Code. RUN BY COWORK on the PROD Supabase project. Idempotent.
-- NOT applied to prod from the Claude Code session.
--
-- Why: the estimator beta needs a place to store leads, the on-site estimate
-- (its area set, intake answers, and the priced result), and the per-area
-- material picks. These mirror the existing job_areas / job_area_materials
-- shapes so the SAME calculator (computeJobEstimate / computeEstimatePricing)
-- consumes an estimate's areas with no translation layer.
--
-- Offline-first (v1 = estimate-capture only): leads + estimates + their child
-- rows are written offline and synced on reconnect. So each of those rows
-- carries a client-mintable uuid PK (the client supplies `id` when offline; the
-- server default covers online creation), plus updated_at (the last-write-wins
-- key), client_updated_at (the device clock, for intent-time LWW), rev (a cheap
-- optimistic-concurrency counter), and deleted_at (soft-delete tombstone so a
-- delete propagates through the outbox). Reconcile is an idempotent
-- `insert ... on conflict (id) do update`, so replaying the outbox after an
-- ambiguous failure can never duplicate a row.
--
-- Config lives in the EXISTING public.settings key/value store (same place as
-- default_labor_hourly_rate), which is staff-gated by RLS, so the confidential
-- target-GP and commission values are not exposed. Per-system overrides are
-- added as columns on pec_prod_system_types (same convention as
-- labor_budget_pct). No new settings tables are created (reuse, do not fork).
--
-- Reuses public.is_admin_staff() (the same gate every staff table uses) and the
-- existing public.pec_prod_touch_updated_at() BEFORE-UPDATE trigger.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Per-system pricing overrides (null = use the global default in settings)
-- ----------------------------------------------------------------------------
alter table public.pec_prod_system_types
  add column if not exists target_gp_pct  numeric(5,2),
  add column if not exists commission_pct numeric(5,2);

alter table public.pec_prod_system_types
  drop constraint if exists pec_prod_system_types_target_gp_range;
alter table public.pec_prod_system_types
  add constraint pec_prod_system_types_target_gp_range
  check (target_gp_pct is null or (target_gp_pct >= 0 and target_gp_pct <= 100));

alter table public.pec_prod_system_types
  drop constraint if exists pec_prod_system_types_commission_range;
alter table public.pec_prod_system_types
  add constraint pec_prod_system_types_commission_range
  check (commission_pct is null or (commission_pct >= 0 and commission_pct <= 100));

-- ----------------------------------------------------------------------------
-- 2. leads
-- ----------------------------------------------------------------------------
create table if not exists public.leads (
  id                uuid primary key default gen_random_uuid(),
  brand             text not null default 'PEC',
  source            text,                       -- manual|dripjobs|openphone|webform|google_lsa|meta|angi
  source_ref        text,                       -- external id / message id, when known
  first_name        text,
  last_name         text,
  full_name         text,
  email             text,
  phone             text,
  address           text,
  city              text,
  state             text,
  zip               text,
  gate_code         text,
  stage             text not null default 'new',  -- new|contacted|estimate_sent|presented|accepted|lost
  lost_reason       text,
  owner_user_id     uuid,                       -- admin_users.auth_user_id (soft ref)
  score             int,
  sms_consent       boolean not null default false,
  sms_consent_source text,
  sms_consent_at    timestamptz,
  email_consent     boolean not null default true,
  opted_out         boolean not null default false,
  opted_out_at      timestamptz,
  dripjobs_deal_id  text,
  customer_id       uuid references public.customers(id) on delete set null,
  notes             text,
  contacted_at      timestamptz,
  estimate_sent_at  timestamptz,
  presented_at      timestamptz,
  accepted_at       timestamptz,
  lost_at           timestamptz,
  created_by        uuid,                       -- auth.uid() of the rep (soft ref)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  client_updated_at timestamptz,                -- device clock at the offline edit
  rev               int not null default 0,
  deleted_at        timestamptz                 -- soft-delete tombstone
);

alter table public.leads
  drop constraint if exists leads_stage_check;
alter table public.leads
  add constraint leads_stage_check
  check (stage in ('new','contacted','estimate_sent','presented','accepted','lost'));

create index if not exists idx_leads_stage      on public.leads (stage);
create index if not exists idx_leads_created_by on public.leads (created_by);
create index if not exists idx_leads_updated_at on public.leads (updated_at desc);
create index if not exists idx_leads_live        on public.leads (created_at desc) where deleted_at is null;

-- ----------------------------------------------------------------------------
-- 3. lead_events  (pipeline + activity timeline; powers speed-to-lead, conversion)
-- ----------------------------------------------------------------------------
create table if not exists public.lead_events (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.leads(id) on delete cascade,
  event_type    text not null,                  -- stage_change|note|call|sms_in|sms_out|email|estimate_sent|...
  from_stage    text,
  to_stage      text,
  payload       jsonb,
  actor_user_id uuid,
  created_at    timestamptz not null default now()
);
create index if not exists idx_lead_events_lead on public.lead_events (lead_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 4. estimates  (one priced estimate; areas live in the child table below)
-- ----------------------------------------------------------------------------
create table if not exists public.estimates (
  id                  uuid primary key default gen_random_uuid(),
  lead_id             uuid references public.leads(id) on delete set null,
  brand               text not null default 'PEC',
  system_type_id      uuid references public.pec_prod_system_types(id) on delete set null,
  status              text not null default 'draft',  -- draft|sent|presented|accepted|lost|expired
  intake              jsonb,                      -- work-order fields: gate_code, coat_past_garage, stem_walls, moisture, mohs_hardness, additional_non_slip, grinder_tooling_grit, special_notes
  -- priced result (snapshots from computeEstimatePricing; all PERCENTS where _pct)
  materials_cost      numeric(12,2),              -- M
  fixed_addons        numeric(12,2) not null default 0,  -- F
  labor_pct           numeric(5,2),
  commission_pct      numeric(5,2),
  target_gp_pct       numeric(5,2),
  price               numeric(12,2),              -- R (rounded)
  price_increment     numeric(10,2),
  gp_dollars          numeric(12,2),
  gp_pct              numeric(6,4),
  gp_per_hour         numeric(12,2),
  labor_budget        numeric(12,2),
  commission_dollars  numeric(12,2),
  budgeted_hours      numeric(10,2),
  material_plan       jsonb,                      -- snapshot of materialLines (audit / reproducibility; hidden from rep by flag)
  scope_of_work       text,
  calc_version        text,                       -- CALC_VERSION the price was produced with
  -- presentation + acceptance
  public_token        text unique,
  signature           jsonb,
  signed_name         text,
  signed_at           timestamptz,
  signed_ip           text,
  deposit_payment_id  uuid,                       -- pec_payments.id (soft ref; deposits are online-only)
  deposit_amount      numeric(12,2),
  -- bridge into the existing production pipeline (set on accept)
  job_id              uuid references public.jobs(id) on delete set null,
  pec_prod_job_id     uuid references public.pec_prod_jobs(id) on delete set null,
  -- bookkeeping + offline sync
  created_by          uuid,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  accepted_at         timestamptz,
  updated_at          timestamptz not null default now(),
  client_updated_at   timestamptz,
  rev                 int not null default 0,
  deleted_at          timestamptz
);

alter table public.estimates
  drop constraint if exists estimates_status_check;
alter table public.estimates
  add constraint estimates_status_check
  check (status in ('draft','sent','presented','accepted','lost','expired'));

create index if not exists idx_estimates_lead       on public.estimates (lead_id);
create index if not exists idx_estimates_status     on public.estimates (status);
create index if not exists idx_estimates_created_by on public.estimates (created_by);
create index if not exists idx_estimates_updated_at on public.estimates (updated_at desc);
create index if not exists idx_estimates_live        on public.estimates (created_at desc) where deleted_at is null;

-- ----------------------------------------------------------------------------
-- 5. estimate_areas  (mirrors the calculator's area shape; parent-owned set)
-- ----------------------------------------------------------------------------
create table if not exists public.estimate_areas (
  id                  uuid primary key default gen_random_uuid(),
  estimate_id         uuid not null references public.estimates(id) on delete cascade,
  name                text not null default 'Main',
  sqft                numeric(12,2),
  system_type_id      uuid references public.pec_prod_system_types(id) on delete set null,
  flake_product_id    uuid references public.pec_prod_products(id) on delete set null,
  basecoat_product_id uuid references public.pec_prod_products(id) on delete set null,
  topcoat_product_id  uuid references public.pec_prod_products(id) on delete set null,
  basecoat_cure_speed text,
  topcoat_cure_speed  text,
  answers             jsonb,                      -- per-area choice/text slot values + per-area work-order answers
  sort_order          int not null default 0,
  created_at          timestamptz not null default now()
);
create index if not exists idx_estimate_areas_estimate on public.estimate_areas (estimate_id);

-- ----------------------------------------------------------------------------
-- 6. estimate_area_materials  (mirrors job_area_materials: product/choice/text picks)
-- ----------------------------------------------------------------------------
create table if not exists public.estimate_area_materials (
  id               uuid primary key default gen_random_uuid(),
  estimate_area_id uuid not null references public.estimate_areas(id) on delete cascade,
  recipe_slot_id   uuid references public.pec_prod_recipe_slots(id) on delete set null,
  slot_label       text,
  slot_kind        text,                          -- product|multi_product|choice|text
  material_type    text,
  product_id       uuid references public.pec_prod_products(id) on delete set null,
  choice_value     text,
  text_value       text,
  pick_index       int not null default 0,        -- multi_product slots emit pick_index 0,1,...
  is_custom        boolean not null default false,
  order_index      int,
  created_at       timestamptz not null default now()
);
create index if not exists idx_estimate_area_materials_area on public.estimate_area_materials (estimate_area_id);

-- ----------------------------------------------------------------------------
-- 7. updated_at triggers (leads + estimates only; child rows sync as a set)
-- ----------------------------------------------------------------------------
drop trigger if exists trg_leads_touch on public.leads;
create trigger trg_leads_touch before update on public.leads
  for each row execute function public.pec_prod_touch_updated_at();

drop trigger if exists trg_estimates_touch on public.estimates;
create trigger trg_estimates_touch before update on public.estimates
  for each row execute function public.pec_prod_touch_updated_at();

-- ----------------------------------------------------------------------------
-- 8. RLS: staff full access (service role bypasses). Matches every staff table.
-- ----------------------------------------------------------------------------
alter table public.leads                   enable row level security;
alter table public.lead_events             enable row level security;
alter table public.estimates               enable row level security;
alter table public.estimate_areas          enable row level security;
alter table public.estimate_area_materials enable row level security;

drop policy if exists leads_staff on public.leads;
create policy leads_staff on public.leads for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists lead_events_staff on public.lead_events;
create policy lead_events_staff on public.lead_events for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists estimates_staff on public.estimates;
create policy estimates_staff on public.estimates for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists estimate_areas_staff on public.estimate_areas;
create policy estimate_areas_staff on public.estimate_areas for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists estimate_area_materials_staff on public.estimate_area_materials;
create policy estimate_area_materials_staff on public.estimate_area_materials for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

grant select, insert, update, delete on
  public.leads,
  public.lead_events,
  public.estimates,
  public.estimate_areas,
  public.estimate_area_materials
  to authenticated;

-- ----------------------------------------------------------------------------
-- 9. Config seeds in public.settings (staff-gated). on conflict do nothing so a
--    re-run never clobbers a value Dylan has set. default_commission_pct is left
--    blank on purpose: Dylan must provide the real rate before pricing is live.
-- ----------------------------------------------------------------------------
insert into public.settings (key, value) values
  ('estimator_enabled',               'false'),   -- master gate for the admin nav button
  ('estimator_hide_material_qty',     'true'),    -- hide rep-facing material quantities during beta
  ('estimator_target_gp_pct',         '50'),      -- global target gross-profit percent
  ('estimator_default_commission_pct',''),        -- commission percent of revenue (Dylan to set)
  ('estimator_price_increment',       '25'),      -- round price up to this dollar increment
  ('drip_autosend_email',             'false'),   -- automated email drip master switch
  ('drip_autosend_sms',               'false'),   -- automated SMS drip master switch (off until guardrail soak)
  ('drip_kill_switch',                'false')     -- emergency: halt ALL drip sends
on conflict (key) do nothing;

commit;

-- ============================================================================
-- Verify after running:
--   select count(*) from public.leads;                                 -- 0
--   select count(*) from public.estimates;                             -- 0
--   select column_name from information_schema.columns
--     where table_name='pec_prod_system_types'
--       and column_name in ('target_gp_pct','commission_pct');         -- 2 rows
--   select key, value from public.settings where key like 'estimator_%' or key like 'drip_%';  -- 8 rows
--   select tablename, count(*) from pg_policies
--     where tablename in ('leads','lead_events','estimates','estimate_areas','estimate_area_materials')
--     group by tablename;                                              -- 1 policy each
--
-- Data API exposure: this is an EXISTING Supabase project, so new public tables
-- are still auto-exposed to PostgREST today. Supabase enforces opt-in exposure
-- for existing projects on 2026-10-30. Before then, confirm the new tables are
-- visible to the Data API (a quick authenticated GET /rest/v1/estimates?limit=1
-- should return 200, not 404). If 404, expose them via the project's Data API
-- settings (Exposed schemas / table privileges) so offline sync can write.
-- ============================================================================
