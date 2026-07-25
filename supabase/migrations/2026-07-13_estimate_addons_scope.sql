-- @artifacts
--   table: public.pec_prod_addons
--   table: public.estimate_line_items
--   column: public.pec_prod_system_types.scope_template
--   column: public.pec_prod_system_types.scope_template_mvb
--   column: public.pec_prod_system_types.deposit_pct
--   column: public.estimates.scope_edited_at
--   column: public.estimates.scope_stale
--   column: public.estimates.scope_generated_at
--   column: public.estimates.scope_model
--   index: pec_prod_addons_name_key
--   index: idx_estimate_line_items_estimate
-- @end
-- ============================================================================
-- 2026-07-13: Add-on catalog, line items as real rows, scope templates and the
-- AI-assembled scope document (build prompt 15b). Author: Claude Code.
-- Idempotent: safe to re-run (create-if-not-exists, seed-only-where-missing).
--
-- Why: a real job is a garage plus a patio plus stem walls. This adds the
-- pieces prompt 15's estimate could not describe: a catalog of add-ons with
-- BOTH a price and a cost (so a rep piling on upsells cannot inflate GP), line
-- items as ROWS instead of a jsonb array (a customer ticking an optional item
-- on the public page is a write, and concurrent jsonb array writes race), and
-- Dylan's verbatim DripJobs scope-of-work templates seeded per system so the
-- AI scope writer (pec-estimate-scope.cjs) can assemble a customer document by
-- SUBSTITUTION, never authorship.
--
-- Every scope template below is VERBATIM from dripjobs-scope-templates.md
-- (extracted 2026-07-12, read-only). The awkward bits are deliberate: the
-- "is/is not included" placeholders are resolved per-job by the scope writer
-- from the estimate's actual data, and the "BLANK" placeholders in the patio
-- templates are Dylan's to clean up in DripJobs language, not ours to guess at.
--
-- Column REUSED, not added: estimates.scope_of_work (shipped 2026-06-21,
-- never written until now) is the assembled customer-facing scope document.
-- The public page already renders it and the accept path already copies it to
-- jobs.scope, so reusing it beats adding a duplicate scope_text column.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The add-on catalog. Dylan manages these rows (Catalog UI); reps pick from
--    it in the estimator. default_cost exists so GP stays honest: an add-on
--    with revenue and no cost inflates GP on every estimate that uses it, and
--    the estimator's GP warning becomes a liar. system_type_id NULL = the
--    add-on applies to any system.
-- ----------------------------------------------------------------------------
create table if not exists public.pec_prod_addons (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  description         text,
  unit                text not null default 'each' check (unit in ('each', 'sqft', 'lf', 'hour')),
  default_price       numeric not null default 0,
  default_cost        numeric not null default 0,
  is_optional_default boolean not null default false,
  -- The paragraph appended to the customer scope when this add-on is on the
  -- estimate. Verbatim DripJobs language where it exists; empty string means
  -- "Dylan still owes the language" (flagged in PROJECT-LOG).
  scope_snippet       text,
  system_type_id      uuid references public.pec_prod_system_types(id),
  active              boolean not null default true,
  sort_order          integer not null default 0,
  created_at          timestamptz not null default now()
);
create unique index if not exists pec_prod_addons_name_key on public.pec_prod_addons (name);
alter table public.pec_prod_addons enable row level security;
drop policy if exists pec_prod_addons_staff on public.pec_prod_addons;
create policy pec_prod_addons_staff on public.pec_prod_addons
  for all using (is_admin_staff()) with check (is_admin_staff());

-- Seeds. on conflict (name) do nothing: re-running never clobbers Dylan's
-- price/cost/snippet edits. Prices and costs seed at 0 because the DripJobs
-- extract carries language, not numbers; Dylan prices them in the Catalog.
insert into public.pec_prod_addons
  (name, description, unit, default_price, default_cost, is_optional_default, scope_snippet, system_type_id, active, sort_order)
values
  ('Stem Walls',
   'Vertical stem walls prepped, patched, coated, and flaked to match the floor.',
   'lf', 0, 0, true,
   $scope$Includes mechanical prep of the vertical stem walls, minor patching as needed, and application of an epoxy base coat. If the floor is a flake system, flake will be broadcasted on the stem walls to match. Finished with a protective topcoat for durability and cleanability$scope$,
   null, true, 0),
  ('Filling Control Joints',
   'Control joints cleaned and filled with two-part semi-rigid polyurea.',
   'each', 0, 0, true,
   $scope$Control joints will be cleaned and filled using a two-part semi-rigid polyurea joint filler designed for durability and movement tolerance.$scope$,
   null, true, 1),
  ('Showroom Second Polyaspartic Top Coat Upgrade',
   'Second clear polyaspartic top coat; extends the install by one day.',
   'sqft', 0, 0, true,
   $scope$Everything in the Signature system, plus a second coat of Simiron 98% solids clear gloss polyaspartic applied over the cured first top coat. This additional layer increases total film thickness, delivering maximum gloss, enhanced chemical resistance, and superior long-term durability. This is the floor people ask about when they see it.

Note: The Showroom upgrade extends the project by one additional day, making it a 3 day install$scope$,
   (select id from public.pec_prod_system_types where name = 'Standard Flake'), true, 2),
  ('High Wear Urethane',
   'Simiron High Wear Urethane wear layer with 220 grit aluminum oxide.',
   'sqft', 0, 0, true,
   $scope$Scope of work for high wear urethane application:

Sand floor to ensure proper adhesion
Apply 1 coat of Simiron High Wear Urethane by brush and roll
Urethane finish includes 220 grit aluminum oxide in the coating, acting as a wear layer against scratching and also protecting against harsh chemicals$scope$,
   (select id from public.pec_prod_system_types where name = 'Grind and Seal'), true, 3),
  -- Dylan named these two but DripJobs has no snippet for them yet: seeded with
  -- an EMPTY scope_snippet on purpose (flagged in PROJECT-LOG for him to fill).
  ('Drive Time',
   'Travel time for jobs outside the normal service area.',
   'hour', 0, 0, false, '', null, true, 4),
  ('Upgraded Flake Color',
   'Premium or custom flake blend upgrade over the standard colors.',
   'sqft', 0, 0, false, '',
   (select id from public.pec_prod_system_types where name = 'Standard Flake'), true, 5)
on conflict (name) do nothing;

-- ----------------------------------------------------------------------------
-- 2. Line items become ROWS. estimates.line_items (jsonb, prompt 15) raced:
--    the public page's optional-item tick and the dashboard's editor both
--    replaced the whole array. One row per line means a tick is one-row PATCH.
--    addon_id NULL = a system/area line or a free-typed one-off; the one-off
--    is the rep's escape hatch (job sites always produce something the catalog
--    does not have) and the UI flags them so Dylan can promote repeats.
--    estimate_area_id links a system line to its area; ON DELETE SET NULL
--    because edit-in-place rewrites areas (delete + re-enqueue) and must not
--    take the line items down with them mid-rewrite.
-- ----------------------------------------------------------------------------
create table if not exists public.estimate_line_items (
  id                   uuid primary key default gen_random_uuid(),
  estimate_id          uuid not null references public.estimates(id) on delete cascade,
  addon_id             uuid references public.pec_prod_addons(id),
  estimate_area_id     uuid references public.estimate_areas(id) on delete set null,
  label                text not null,
  description          text,
  qty                  numeric not null default 1,
  unit_price           numeric not null default 0,
  unit_cost            numeric not null default 0,
  total                numeric not null default 0,
  is_optional          boolean not null default false,
  selected_by_customer boolean not null default false,
  sort_order           integer not null default 0,
  created_at           timestamptz not null default now()
);
create index if not exists idx_estimate_line_items_estimate on public.estimate_line_items (estimate_id);
alter table public.estimate_line_items enable row level security;
drop policy if exists estimate_line_items_staff on public.estimate_line_items;
create policy estimate_line_items_staff on public.estimate_line_items
  for all using (is_admin_staff()) with check (is_admin_staff());

-- Backfill the existing jsonb arrays into rows. Row ids are DETERMINISTIC
-- (md5 of estimate id + position) so a re-run inserts nothing new, even for
-- legacy items whose jsonb id was not a uuid. unit_cost backfills to 0: the
-- jsonb shape never carried a cost (exactly the GP-honesty gap this build
-- closes). The jsonb column STAYS for now: the currently-deployed dashboard
-- still writes it until the 15b code deploys; if any estimate is saved by the
-- OLD code between this migration and that deploy, re-run this one INSERT
-- (footer). Drop estimates.line_items in a later migration once deployed.
insert into public.estimate_line_items
  (id, estimate_id, label, description, qty, unit_price, unit_cost, total,
   is_optional, selected_by_customer, sort_order, created_at)
select
  md5(e.id::text || ':li:' || (t.ord - 1)::text)::uuid,
  e.id,
  coalesce(t.li->>'label', ''),
  nullif(t.li->>'description', ''),
  coalesce((t.li->>'qty')::numeric, 1),
  coalesce((t.li->>'unit_price')::numeric, 0),
  0,
  coalesce((t.li->>'total')::numeric, 0),
  coalesce((t.li->>'optional')::boolean, false),
  coalesce((t.li->>'selected_by_customer')::boolean, false),
  (t.ord - 1)::integer,
  coalesce((t.li->>'created_at')::timestamptz, e.created_at)
from public.estimates e
cross join lateral jsonb_array_elements(coalesce(e.line_items, '[]'::jsonb)) with ordinality as t(li, ord)
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- 3. Scope templates + deposit percent per system, seeded VERBATIM from
--    dripjobs-scope-templates.md. Seeds only fill NULL columns so Dylan's
--    later edits survive a re-run.
--
--    Mapping (the full mapped/unmatched report is in PROJECT-LOG):
--      Standard Flake      <- "Full Flake Garage - Standard" (the DEFAULT), 50% deposit
--      Standard Flake MVB  <- "Moisture Barrier - 100% Flake Broadcast" (3-day
--                             system; scope_template_mvb is used by the scope
--                             writer when the estimate's mvb is not 'none',
--                             because MVB is estimate state, not a system type)
--      Concrete Polishing  <- "Ameripolish Stain with Concrete Polishing"
--      Grind and Seal      <- "Grind and Seal - Impermeable Sealer", 25% deposit
--      Quartz              <- "Patio Quartz Coating" (carries DripJobs' own
--                             "BLANK" placeholders, kept verbatim on purpose)
--    NOT mapped (no honest home; listed for Dylan in PROJECT-LOG): Penetrating
--    Sealer package, Signature Full Flake, Full Flake Patio, and the
--    project-specific "Concrete Polishing without joint filler" dental-office
--    document. Metallic and Custom System have no DripJobs template at all.
-- ----------------------------------------------------------------------------
alter table public.pec_prod_system_types add column if not exists scope_template text;
alter table public.pec_prod_system_types add column if not exists scope_template_mvb text;
alter table public.pec_prod_system_types add column if not exists deposit_pct numeric;

update public.pec_prod_system_types set scope_template = $scope$Scope of work for 100% flake broadcast with polyaspartic top coat

2 day system

**Day 1**

**Surface Preparation**

- Diamond grind concrete with 14 or 30 grit metal bond diamond tooling
- Industrial HEPA vacuums will be used to limit the amount of dust on the floor and in the air
- Perform minor cosmetic repairs to concrete, such as hairline cracks, shallow spalling areas
- Does not include cracks wider than 1/8", or spalls deeper than 1/4" or larger than 3" in diameter
- Does not include filling of control joints or expansion joints
- Thoroughly vacuum area to remove any remaining dust

**Coating Application**

- Apply 1 coat of 100% solids epoxy coating to concrete by squeegee and roller at a film thickness of 10 mils
- Broadcast decorate vinyl flakes into wet material until rejection
- Concrete past garage door is/is not  included
- Stem walls are/are not included
- We do not coat felt expansion material if it is present

**Day 2**

**Additional Prep**

- After first coat has dried, scrape and remove excess flake
- Vacuum floor prior to clear coat application

**Clear Coat Application**

- Apply 1 coat of Simiron clear gloss polyaspartic to floor by squeegee and roller

**Cleanup**

- Remove any debris, equipment, or waste materials generated during the coating process
- Perform a final cleaning of the work area, leaving it in a tidy condition

**Final Inspection**

- Conduct a thorough inspection of the completed coating to ensure quality and adherence to specifications
- Provide the client with a final walkthrough, explaining maintenance procedures and answering any questions
- Do not drive on floor for 48 hours after final coat is applied
- Do not close garage door for 24 hours after final coat is applied
- Do not walk on floor for 24 hours after final coat is applied
- Final payment is due upon completion of job

**Warranty**

Our 10 year warranty is in the attachments on this document on the left hand side

Tentative start date:

Expected project duration: 2 days$scope$
 where name = 'Standard Flake' and scope_template is null;

update public.pec_prod_system_types set scope_template_mvb = $scope$MOISTURE VAPOR BARRIER REQUIRED

3 Day System

**Day 1**

Surface Preparation - repair any cracks, spalls, or damaged areas on the concrete surface as necessary

Does not include filling of control joints or expansion joints** unless otherwise noted **

V blade out larger cracks and repair with 2-part Polyurea

Diamond grind concrete with 14 or 30 grit metal bond diamond tooling Industrial HEPA vacuums will be used to limit the amount of dust on the floor and in the air

Thoroughly vacuum area to remove any remaining dust

Coating Application - apply a moisture barrier system -100 sqft per gallon minimum via squeegee and back roll

**Day 2**

Apply 1 coat of 100% solids epoxy coating to concrete by squeegee and roller at a film thickness of 10 mils Broadcasts decorate vinyl flakes into wet material until rejection

Stem walls are not included

Concrete past garage door is not included

**Day 3**

Additional Prep after 2nd coat has dried, scrape and remove excess flake vacuum floor prior to clear coat application

Apply 1 coat of Simiron clear gloss polyaspartic to floor by squeegee and roller

Cleanup Remove any debris, equipment, or waste materials generated during the coating process

Perform a final cleaning of the work area, leaving it in a tidy condition

Final Inspection Conduct a thorough inspection of the completed coating to ensure quality and adherence to specifications

Provide the client with a final walkthrough, explaining maintenance procedures and answering any questions

Do not drive on floor for 48 hours after final coat is applied

Do not close garage door for 24 hours after final coat is applied

Do not walk on floor for 24 hours after final coat is applied

Final payment is due upon completion of job

Our 10-year warranty is in the link section of this proposal.

Tentative start date: next$scope$
 where name = 'Standard Flake' and scope_template_mvb is null;

update public.pec_prod_system_types set scope_template = $scope$Project Overview:
This scope outlines the process and materials to be used in incorporating Ameripolish® SureLock™ Stain and ColorSolve™ into the concrete polishing system. The objective is to achieve a durable, vibrant, and consistent color finish or modeling look with long-term UV stability and stain resistance as part of the polished concrete process.

Work to be Performed:

**Surface Preparation**

Mechanically grind the concrete surface using progressive metal-bond diamond tooling to remove contaminants, laitance, and surface imperfections.

Ensure surface is clean, dry, and free from curing compounds, sealers, oils, and debris prior to application.

Vacuum and auto-scrub to ensure the slab is free of dust and residue.

**Densification (if applicable)**

Apply an approved lithium or sodium silicate densifier as specified in the polishing system.

Allow sufficient time for penetration and reaction prior to stain application.

**Color Application – Ameripolish® SureLock™ Stain**

Apply Ameripolish® SureLock™ Stain evenly using a low-pressure sprayer or microfiber applicator in accordance with manufacturer specifications.

Blend colors as needed to achieve desired tone and consistency.

Allow proper dry time per product data sheet before proceeding to next step.

**Solvent Carrier – Ameripolish® ColorSolve™**

Apply Ameripolish® ColorSolve™ as the approved carrier and stain enhancer for optimal color penetration and uniformity.

Ensure adequate ventilation during application and drying period.

**Polishing Progression**

Continue polishing process using progressively finer resin-bond diamond tooling up to the desired sheen level (matte, semi-gloss, or high-gloss).

Avoid over-polishing prior to color lock-in to maintain desired color depth.

**Protection / Stain Guard**

Apply Ameripolish® SR2 or approved surface guard for added protection and stain resistance.

Burnish with high-speed diamond pad to enhance clarity and seal.

**Final Cleanup and Inspection**

Remove all masking and protection materials.

Conduct final inspection with client to verify color consistency, sheen, and finish quality.

Provide maintenance recommendations for long-term care.

**Products to Be Used:**

Ameripolish® SureLock™ Stain (specified color(s))

Ameripolish® ColorSolve™ Carrier

Ameripolish® SR2 (if part of final protection system) OR, EZ Guard

Approved densifier and polishing diamonds per system specification

**Exclusions:**

Crack repair, joint filling, patching, or resurfacing outside the defined polishing area.

Moisture mitigation or vapor barrier installation.

Any substrate correction required due to pre-existing damage or contamination.$scope$
 where name = 'Concrete Polishing' and scope_template is null;

update public.pec_prod_system_types set scope_template = $scope$Scope of work for grind, stain, and seal garage floor

Perform 1 step grind to profile surface and open up pores in concrete for product adhesion
Diamond grind concrete up to 60 grit profile
Industrial HEPA vacuums will be used to limit the amount of dust on the floor and in the air
Perform minor cosmetic repairs to concrete, such as hairline cracks, shallow spalling areas
Does not include cracks wider than 1/8", or spalls deeper than 1/4" or larger than 3" in diameter
Does not include filling of control joints or expansion joints
Thoroughly vacuum area to remove any remaining dust
Clean area prior to coating
Apply 1 coat of clear epoxy to area by squeegee and back roll
Does not include area outside of garage door$scope$
 where name = 'Grind and Seal' and scope_template is null;

update public.pec_prod_system_types set scope_template = $scope$Scope of work for quartz coating BLANK AREA

**Surface Preparation**

Repair any cracks, spalls, or damaged areas on the concrete surface as necessary
Does not include filling of control joints or expansion joints
Fill hairline cracks with filler prior to coating application
Diamond grind concrete with 14 or 30 grit metal bond diamond tooling
Industrial HEPA vacuums will be used to limit the amount of dust on the floor and in the air
Thoroughly vacuum area to remove any remaining dust

**Coating Application**

Apply 1 coat of Simiron 100% solids epoxy coating to concrete by squeegee and roller at a film thickness of 10 mils
Broadcast decorative quartz granules into wet material until rejection

**Additional Prep**

After first coat has dried, scrape and remove excess quartz
Vacuum floor prior to clear coat application

**Clear Coat Application**

Apply 1 coat of Simiron 98% solids clear gloss polyaspartic to floor by squeegee and roller

**Cleanup**

Remove any debris, equipment, or waste materials generated during the coating process
Perform a final cleaning of the work area, leaving it in a tidy condition

**Final Inspection**

Do not walk on floor for 24 hours after final coat is applied
Final payment is due upon completion of job

Tentative start date:

BLANK

Expected project duration:

BLANK$scope$
 where name = 'Quartz' and scope_template is null;

-- Deposits from the extract: 50% on the flake garage template, 25% on the
-- grind-and-seal one. The Moisture Barrier template's 25% has no per-system
-- home (MVB is estimate state); prompt 16's deposit math should read the mvb
-- column and use 25 when it is not 'none' (flagged in PROJECT-LOG).
update public.pec_prod_system_types set deposit_pct = 50
 where name = 'Standard Flake' and deposit_pct is null;
update public.pec_prod_system_types set deposit_pct = 25
 where name = 'Grind and Seal' and deposit_pct is null;

-- ----------------------------------------------------------------------------
-- 4. Scope lifecycle on the estimate. scope_of_work (reused, see header) holds
--    the assembled markdown document. scope_edited_at non-null means a HUMAN
--    touched the text: from then on the AI may never overwrite it without an
--    explicit click (the server enforces this, not just the UI). scope_stale
--    means the estimate changed after that edit, so the UI shows "the estimate
--    changed since you edited this scope" with a Regenerate button.
-- ----------------------------------------------------------------------------
alter table public.estimates add column if not exists scope_edited_at timestamptz;
alter table public.estimates add column if not exists scope_stale boolean not null default false;
alter table public.estimates add column if not exists scope_generated_at timestamptz;
alter table public.estimates add column if not exists scope_model text;

commit;

-- ============================================================================
-- Verify after running:
--   select count(*) from pec_prod_addons;                                -- 6
--   select name, unit, is_optional_default, length(coalesce(scope_snippet,'')) as snip,
--          system_type_id is not null as scoped
--     from pec_prod_addons order by sort_order;
--     -- Stem Walls lf/optional/270, Filling Control Joints each/optional/139,
--     -- Showroom sqft/optional/435/scoped, High Wear Urethane sqft/optional/299/scoped,
--     -- Drive Time hour/0, Upgraded Flake Color sqft/0/scoped
--   select column_name from information_schema.columns
--     where table_name='estimate_line_items';                            -- 14 columns
--   select count(*) from estimate_line_items;                            -- >= the jsonb items backfilled
--   select (select count(*) from estimates e cross join lateral
--           jsonb_array_elements(coalesce(e.line_items,'[]'::jsonb)) t)
--        = (select count(*) from estimate_line_items);                   -- true (backfill complete)
--   select name, length(scope_template) as tpl, length(scope_template_mvb) as mvb, deposit_pct
--     from pec_prod_system_types where active order by sort_order;
--     -- Standard Flake 2007/1840/50, Concrete Polishing 2679/null/null,
--     -- Grind and Seal 723/null/25, Quartz 1318/null/null,
--     -- Custom System + Metallic null/null/null
--   select column_name from information_schema.columns where table_name='estimates'
--     and column_name in ('scope_edited_at','scope_stale','scope_generated_at','scope_model'); -- 4 rows
--   select tablename, policyname from pg_policies
--     where tablename in ('pec_prod_addons','estimate_line_items');      -- 2 staff policies
--
-- If an estimate was saved by the OLD deployed code after this migration but
-- before the 15b deploy, re-run just the "insert into public.estimate_line_items"
-- statement above (it is idempotent) to pick up its jsonb items.
-- ============================================================================
