-- @artifacts
--   table: public.pec_pricing_project_types
--   table: public.pec_pricing_requests
--   index: pec_pricing_project_types_brand_name_idx
--   index: pec_pricing_requests_created_idx
--   index: pec_pricing_requests_ip_idx
--   index: pec_pricing_requests_status_idx
--   setting: pricing_enabled
--   setting: pricing_url
--   setting: pricing_headline
--   setting: pricing_intro_text
--   setting: pricing_reveal_copy
--   setting: pricing_round_to
--   setting: pricing_min_sqft
--   setting: pricing_max_sqft
--   setting: pricing_rate_limit_per_hour
--   setting: pricing_min_fill_seconds
--   setting: pricing_duplicate_window_hours
--   setting: pricing_out_of_area_copy
--   setting: pricing_call_us_copy
-- @end
-- ============================================================================
-- 2026-09-15: Instant Pricing (replace the Price Guide AI subscription).
-- Author: Claude Code. Direct to prod per rule 14: no money/auth tables, no
-- SECURITY DEFINER, no estimates.status; everything here is additive on
-- brand-new objects (same posture as the presentation migration).
-- Idempotent.
--
-- WHY each piece exists:
--
-- pec_pricing_project_types: the public price book. One row per project type
-- the website visitor can pick: name, description, a photo (storage PATH in
-- the pec-pricing bucket, never a URL, so bucket moves stay cheap), and a
-- manual $/sqft low/high range. Dylan chose manual ranges over the live
-- estimator engine on purpose: full control, no leak of internal margin
-- math, and it works for types the engine cannot price (Concrete Polishing
-- and Custom System have no priceable recipe). priceable=false marks a
-- "call us" type: it shows no range and routes straight to booking.
-- system_type_id is an optional soft link to pec_prod_system_types for
-- future reporting; on delete set null because the price book must survive
-- catalog changes. Brand-ready (brand column) like pec_booking_forms, PEC
-- only for now per the booking precedent.
--
-- Seeded rates bracket the live completed-job medians (~+/-15 percent,
-- rounded to quarters): Standard Flake median 6.15/sqft over 45 jobs,
-- Grind and Seal Clear 6.54 over 5, Metallic 7.48 over 3, Quartz 10.08
-- over 2. Only these four comps-backed types get rates; the Custom median
-- (3.77, n=4) is not a publishable rate, hence the call-us type. min_price
-- ships null: a job floor is Dylan's call, suggested in the Settings UI.
--
-- pec_pricing_requests: EVERY quote attempt, the same audit-everything
-- posture as pec_booking_requests. Deliberately a SEPARATE table: the
-- booking table's status CHECK and the Metrics booking-funnel card count
-- every row as a booking attempt and reconcile against appointments;
-- pricing rows would corrupt both. Rates AND computed prices are
-- snapshotted so the row records exactly what the visitor saw even after
-- Dylan edits rates. "Booked" is booked_appointment_id not null on a
-- 'priced' row (the funnel stage never mutates). error_text doubles as the
-- reject reason (honeypot / too_fast / rate_limit) on rejected rows.
-- ip_hash is a salted hash, never granted to the browser: the column-list
-- grant below omits it, so staff clients must name columns (select=* is a
-- Postgres permission error for authenticated, the fence working as
-- designed, same as booking).
--
-- Bucket pec-pricing: NEW bucket rather than a prefix in pec-presentation,
-- because that bucket's contract is "everything here may render on
-- estimates" and its policies are bucket-scoped anyway; separate features
-- keep separate lifecycles. Public read (the pricing page shows the photos
-- without auth), staff-only writes, images only, 5 MB backstop (Settings
-- resizes to ~1600 px JPEG before upload).
--
-- Settings (rule 12): pricing_enabled + the page link are front-of-card on
-- the new Settings > Instant Pricing page; everything else behind Advanced.
-- pricing_enabled ships 'false' (dark until Dylan adds photos, reviews the
-- seeded rates, and flips it). pricing_url auto-fills to <origin>/pricing on
-- first enable, the booking_url pattern. No em dashes in seeded copy; it is
-- customer-facing.
-- ============================================================================

begin;

-- ---- pec_pricing_project_types ---------------------------------------------

create table if not exists public.pec_pricing_project_types (
  id uuid primary key default gen_random_uuid(),
  brand text not null default 'PEC',
  name text not null,
  description text,
  image_path text,
  rate_low numeric(8,2),
  rate_high numeric(8,2),
  min_price numeric(10,2),
  priceable boolean not null default true,
  sort_order integer,
  active boolean not null default true,
  system_type_id uuid references public.pec_prod_system_types(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pec_pricing_types_rates_check
    check (priceable = false or (rate_low is not null and rate_high is not null and rate_low <= rate_high))
);

create unique index if not exists pec_pricing_project_types_brand_name_idx
  on public.pec_pricing_project_types (brand, name);

-- updated_at maintained by trigger (reuse the generic pec_prod touch fn);
-- the Settings editor's optimistic-concurrency save guards on it.
drop trigger if exists pec_pricing_project_types_touch on public.pec_pricing_project_types;
create trigger pec_pricing_project_types_touch
  before update on public.pec_pricing_project_types
  for each row execute function public.pec_prod_touch_updated_at();

alter table public.pec_pricing_project_types enable row level security;

-- Staff manage the price book from Settings; the public endpoint reads it
-- with the service role.
drop policy if exists pec_pricing_project_types_staff_all on public.pec_pricing_project_types;
create policy pec_pricing_project_types_staff_all on public.pec_pricing_project_types
  using (public.is_admin_staff()) with check (public.is_admin_staff());

-- ---- pec_pricing_requests --------------------------------------------------

create table if not exists public.pec_pricing_requests (
  id uuid primary key default gen_random_uuid(),
  brand text not null default 'PEC',
  status text not null,
  project_type_id uuid references public.pec_pricing_project_types(id),
  project_type_name text,
  sqft numeric,
  rate_low numeric(8,2),
  rate_high numeric(8,2),
  price_low numeric(10,2),
  price_high numeric(10,2),
  name text,
  phone text,
  email text,
  address_line1 text,
  address_city text,
  address_state text,
  address_zip text,
  place_id text,
  in_area boolean,
  lead_id uuid,
  customer_id uuid,
  booked_appointment_id uuid references public.pec_appointments(id) on delete set null,
  sms_consent boolean not null default false,
  sms_consent_disclosure text,
  ip_hash text,
  user_agent text,
  error_text text,
  created_at timestamptz not null default now(),
  constraint pec_pricing_requests_status_check
    check (status in ('priced', 'out_of_area', 'call_us', 'rejected', 'error'))
);

create index if not exists pec_pricing_requests_created_idx
  on public.pec_pricing_requests (created_at desc);
create index if not exists pec_pricing_requests_ip_idx
  on public.pec_pricing_requests (ip_hash, created_at desc);
create index if not exists pec_pricing_requests_status_idx
  on public.pec_pricing_requests (status, created_at desc);

alter table public.pec_pricing_requests enable row level security;

drop policy if exists pec_pricing_requests_staff_read on public.pec_pricing_requests;
create policy pec_pricing_requests_staff_read on public.pec_pricing_requests
  for select using (public.is_admin_staff());

-- ip_hash never reaches the browser: replace the blanket table grant with a
-- column list that omits it (the booking-requests fence, same reasoning).
revoke select on public.pec_pricing_requests from anon, authenticated;
revoke insert, update, delete on public.pec_pricing_requests from anon, authenticated;
grant select (id, brand, status, project_type_id, project_type_name, sqft,
  rate_low, rate_high, price_low, price_high, name, phone, email,
  address_line1, address_city, address_state, address_zip, place_id, in_area,
  lead_id, customer_id, booked_appointment_id, sms_consent,
  sms_consent_disclosure, user_agent, error_text, created_at)
  on public.pec_pricing_requests to authenticated;

-- ---- Storage: pec-pricing bucket -------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pec-pricing', 'pec-pricing', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists pec_pricing_public_read on storage.objects;
create policy pec_pricing_public_read on storage.objects
  for select using (bucket_id = 'pec-pricing');

drop policy if exists pec_pricing_staff_insert on storage.objects;
create policy pec_pricing_staff_insert on storage.objects
  for insert with check (bucket_id = 'pec-pricing' and public.is_admin_staff());

drop policy if exists pec_pricing_staff_update on storage.objects;
create policy pec_pricing_staff_update on storage.objects
  for update using (bucket_id = 'pec-pricing' and public.is_admin_staff())
  with check (bucket_id = 'pec-pricing' and public.is_admin_staff());

drop policy if exists pec_pricing_staff_delete on storage.objects;
create policy pec_pricing_staff_delete on storage.objects
  for delete using (bucket_id = 'pec-pricing' and public.is_admin_staff());

-- ---- Seed: project types ----------------------------------------------------

insert into public.pec_pricing_project_types
  (brand, name, description, rate_low, rate_high, priceable, sort_order, active, system_type_id)
values
  ('PEC', 'Standard Flake',
   'Our most popular garage floor: decorative flake broadcast into epoxy with a tough polyaspartic topcoat.',
   5.25, 7.00, true, 1, true,
   (select id from public.pec_prod_system_types where name = 'Standard Flake' limit 1)),
  ('PEC', 'Grind and Seal Clear',
   'Concrete ground smooth and sealed with clear, high-wear epoxy. Clean industrial look.',
   5.50, 7.50, true, 2, true,
   (select id from public.pec_prod_system_types where name = 'Grind and Seal - Clear epoxy/high wear' limit 1)),
  ('PEC', 'Metallic',
   'One-of-a-kind flowing metallic epoxy. A showpiece floor for garages, shops, and interiors.',
   6.50, 8.50, true, 3, true,
   (select id from public.pec_prod_system_types where name = 'Metallic' limit 1)),
  ('PEC', 'Quartz',
   'Broadcast quartz granules for maximum durability and slip resistance. Great for patios and pool decks.',
   8.75, 11.50, true, 4, true,
   (select id from public.pec_prod_system_types where name = 'Quartz' limit 1)),
  ('PEC', 'Something else / Not sure',
   'Polishing, staining, repairs, or a project that does not fit a box. We will price it in person.',
   null, null, false, 5, true, null)
on conflict (brand, name) do nothing;

-- ---- Seed: lead source vocabulary -------------------------------------------

insert into public.pec_lead_sources (name, aliases)
select 'Instant Pricing', array['instant_pricing']
where not exists (
  select 1 from public.pec_lead_sources where lower(name) = 'instant pricing'
);

-- ---- Settings ---------------------------------------------------------------

insert into public.settings (key, value) values
  ('pricing_enabled', 'false'),
  ('pricing_url', ''),
  ('pricing_headline', 'Get your instant price'),
  ('pricing_intro_text', 'Pick your project, tell us the size, and see your ballpark price in about a minute.'),
  ('pricing_reveal_copy', 'Most projects like yours land between {low} and {high}. Your exact price depends on the condition of the concrete, which we confirm with a free on-site visit.'),
  ('pricing_round_to', '50'),
  ('pricing_min_sqft', '50'),
  ('pricing_max_sqft', '20000'),
  ('pricing_rate_limit_per_hour', '10'),
  ('pricing_min_fill_seconds', '2'),
  ('pricing_duplicate_window_hours', '24'),
  ('pricing_out_of_area_copy', 'You are a little outside our normal service area. We saved your info and we will reach out to see what we can do.'),
  ('pricing_call_us_copy', 'This one deserves a custom price. Book your free on-site visit and we will price it in person.')
on conflict (key) do nothing;

commit;
