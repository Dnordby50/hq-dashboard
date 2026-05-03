# CRM / Dashboard Project Log

Newest entries on top. Append only. Never edit or delete past entries. If a previous entry was wrong, write a new correction entry that references it.

---

## [2026-05-03 14:35] crm: resolved index collision (Option A), partial index now lives on idx_pec_prod_jobs_proposal_link
By: Cowork
Changed: Two things, in this order. (1) Edited supabase/migrations/2026-05-03_pec_prod_link_columns.sql to rename the new partial index from idx_pec_prod_jobs_proposal to idx_pec_prod_jobs_proposal_link, and added a 4-line comment above it pointing readers at the PROJECT-LOG entries that explain the rename. The rest of the file is unchanged. (2) Ran the renamed create index in the Supabase SQL editor (project zdfpzmmrgotynrwkeakd): create index if not exists idx_pec_prod_jobs_proposal_link on public.pec_prod_jobs(proposal_id) where proposal_id is not null. Result: "Success. No rows returned."
Why: Dylan picked Option A from the prior entry. Renames the new partial index instead of dropping the pre-existing non-partial one on proposal_number. Lowest-risk path: pre-existing index on proposal_number (and the UNIQUE index pec_prod_jobs_proposal_number_key) are untouched, and the migration file in repo now matches what is actually in the database.
Files touched: supabase/migrations/2026-05-03_pec_prod_link_columns.sql, PROJECT-LOG.md
Verification output:
  select indexname, indexdef from pg_indexes
  where schemaname = 'public' and tablename = 'pec_prod_jobs' and indexname like '%proposal%' order by indexname;
    idx_pec_prod_jobs_proposal      | CREATE INDEX idx_pec_prod_jobs_proposal ON public.pec_prod_jobs USING btree (proposal_number)             (pre-existing, untouched)
    idx_pec_prod_jobs_proposal_link | CREATE INDEX idx_pec_prod_jobs_proposal_link ON public.pec_prod_jobs USING btree (proposal_id) WHERE (proposal_id IS NOT NULL)   (new, partial, intended)
    pec_prod_jobs_proposal_number_key | CREATE UNIQUE INDEX pec_prod_jobs_proposal_number_key ON public.pec_prod_jobs USING btree (proposal_number)   (pre-existing UNIQUE, untouched)
Next steps: When Phase 3 of docs/pm-module-unification-plan.md lands and proposal_id starts being populated, the partial index on idx_pec_prod_jobs_proposal_link will start carrying weight automatically. No further DB work needed for this thread.
Handoff to Cowork: None
Handoff to Dylan: None. Pushing this commit + the prior 14:25 entry's commit to origin/main now.

---

## [2026-05-03 14:25] crm: ran 2026-05-03 link columns migration in Supabase, hit index name collision on idx_pec_prod_jobs_proposal
By: Cowork
Changed: Executed supabase/migrations/2026-05-03_pec_prod_link_columns.sql in the production Supabase SQL editor (project zdfpzmmrgotynrwkeakd) exactly as committed. Statement returned "Success. No rows returned." Both new columns landed: customer_id uuid (FK to public.customers, on delete set null) and proposal_id uuid, both nullable. The partial index on customer_id (idx_pec_prod_jobs_customer) was created. The partial index on proposal_id was NOT created because an index named idx_pec_prod_jobs_proposal already existed from the 2026-04-28_pm_ordering.sql migration, where it indexes proposal_number (not proposal_id). Postgres treated `create index if not exists idx_pec_prod_jobs_proposal ...` as a no-op against the same name. No data was modified or dropped. No further SQL was run after the verification revealed the collision.
Why: Forward-compat schema change so production jobs can later link to a CRM customer + accepted proposal. Stopped at the verification step rather than fixing the index name collision unilaterally because the task instructions said: if anything errors out, do not delete data or drop columns, stop and write a Handoff to Dylan entry. The pre-existing idx_pec_prod_jobs_proposal looks redundant (there's also a UNIQUE INDEX pec_prod_jobs_proposal_number_key on proposal_number that already serves lookup), but that is Dylan's call, not mine.
Files touched: PROJECT-LOG.md
Verification output:
  Q1 columns:
    customer_id | uuid | YES
    proposal_id | uuid | YES
  Q2 indexes filtered to the two expected names:
    idx_pec_prod_jobs_customer | CREATE INDEX idx_pec_prod_jobs_customer ON public.pec_prod_jobs USING btree (customer_id) WHERE (customer_id IS NOT NULL)
    idx_pec_prod_jobs_proposal | CREATE INDEX idx_pec_prod_jobs_proposal ON public.pec_prod_jobs USING btree (proposal_number)        <-- pre-existing, NOT the new partial index
  Q2b all indexes on pec_prod_jobs:
    idx_pec_prod_jobs_customer (new, partial, on customer_id)
    idx_pec_prod_jobs_install_date
    idx_pec_prod_jobs_proposal (pre-existing, non-partial, on proposal_number)
    idx_pec_prod_jobs_status
    pec_prod_jobs_pkey (pk on id)
    pec_prod_jobs_proposal_number_key (unique on proposal_number)
  Q3 row sanity check:
    total = 0, with_customer = 0, with_proposal = 0   (table is empty, nothing was disturbed)
Next steps: Dylan picks one of two fixes and runs the one-liner. The columns themselves are good as-is; only the proposal_id partial index is missing. After the fix is applied, push the merged commit (this entry plus whatever Claude Code does to the migration file) to origin.
Handoff to Cowork: None
Handoff to Dylan: 1) Decide between two fixes for the missing partial index on proposal_id. Option A (lowest risk, recommended): rename the partial index in the migration file and re-run. Edit supabase/migrations/2026-05-03_pec_prod_link_columns.sql to change idx_pec_prod_jobs_proposal to idx_pec_prod_jobs_proposal_link (or similar), then in the Supabase SQL editor run: create index if not exists idx_pec_prod_jobs_proposal_link on public.pec_prod_jobs(proposal_id) where proposal_id is not null; Option B: drop the pre-existing redundant index (the unique index pec_prod_jobs_proposal_number_key already covers proposal_number lookups), then re-run the original migration. SQL: drop index if exists public.idx_pec_prod_jobs_proposal; create index if not exists idx_pec_prod_jobs_proposal on public.pec_prod_jobs(proposal_id) where proposal_id is not null; This frees the name but you lose nothing performance-wise. 2) After applying the chosen fix, verify with: select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'pec_prod_jobs' and indexname like '%proposal%'; You should see one entry referencing proposal_id with the partial WHERE clause. 3) Push to origin/main when ready (this commit is local-only).

---

## [2026-05-03 14:10] crm: forward-compat link columns on pec_prod_jobs + unification plan doc + push to origin
By: Claude Code
Changed: Two small additions plus a push. (1) supabase/migrations/2026-05-03_pec_prod_link_columns.sql adds two nullable columns to pec_prod_jobs: customer_id uuid (FK to customers, on delete set null) and proposal_id uuid (no FK yet, placeholder until proposals table exists). Both get partial indexes (where ... is not null) so they stay cheap until rows actually carry links. Migration is idempotent (if not exists). (2) docs/pm-module-unification-plan.md captures the target architecture for the next session: proposals table sits between customers and the two job tables (public.jobs and pec_prod_jobs), proposal-accepted webhook stages a pec_prod_job pre-linked to customer + proposal, and a new customer-detail view in the CRM tab lists everything for a customer. Standalone Ordering use is preserved (both new FKs nullable). (3) git push origin main published the 4 unpushed commits: aa7fbb8 (left-rail subnav, light theme, hardened New Job buttons), cb05c03 (seed_pec_systems.sql), 5ddae58 (Cowork's full catalog migration, already executed in Supabase), and the new 2026-05-03 migration commit.
Why: Dylan asked to push the recent edits live, and to make sure material ordering keeps working standalone today while the data model is ready for a future where lead -> customer -> proposals -> production-job is one connected flow. Adding the columns now is cheap forward-compat: zero impact on existing rows or code, and saves a separate column-add migration later. The doc keeps the architectural intent in version control rather than scattered across chat history.
Files touched: supabase/migrations/2026-05-03_pec_prod_link_columns.sql (new), docs/pm-module-unification-plan.md (new), PROJECT-LOG.md
Next steps: When Dylan starts wiring the customer-portal CRM lifecycle (lead capture, proposals, accept-flow), open docs/pm-module-unification-plan.md and follow Phase 3. Until then, both columns stay null and nothing in the UI changes.
Handoff to Cowork: None
Handoff to Dylan: 1) Run supabase/migrations/2026-05-03_pec_prod_link_columns.sql in the Supabase SQL editor. (Idempotent; safe to re-run.) 2) Verify columns exist: select column_name from information_schema.columns where table_name = 'pec_prod_jobs' and column_name in ('customer_id','proposal_id'). Should return both. 3) No UI test needed; the columns are not consumed yet. 4) Hard-refresh the live Netlify site once it deploys to confirm CRM left rail + light theme are showing in production.

---

## [2026-05-01 19:35] crm: full PM Module 1 catalog seeded end-to-end in Supabase
By: Cowork
Changed: Ran 4 SQL stages in the production Supabase (project zdfpzmmrgotynrwkeakd) in a single transaction. Stage 1 created the 9 pec_prod_* tables, indexes, RLS policies, triggers (the migration that had never been applied). Stage 2 seeded the 3 starter products (Tinted Gray basecoat, Domino flake, Polyaspartic Clear Gloss), the Standard Flake system, the Standard Flake recipe, and the Domino->Tinted Gray default pairing. Stage 3 added the 5 system rows from seed_pec_systems.sql (Flake, Quartz, Metallic, Grind and Seal, Grind Stain and Seal). Stage 4 was a new file Cowork wrote, supabase/migrations/2026-05-01_pec_systems_recipes.sql, which: added a unique index on pec_prod_products(name) so ON CONFLICT (name) works, fixed Domino flake spread_rate from 350 to 325 (Dylan's correct number), deactivated "Standard Flake" so the dropdown only shows the 5 systems Dylan defined, flipped Quartz and Metallic to requires_flake_color=true so the per-job color picker fires, renamed seeded "Grind and Seal" to "Grind and Seal - Cohills" and inserted "Grind and Seal - Urethane" as a new sibling row (Dylan splits this into two systems), inserted 8 non-color SKUs (Simiron 1100 SL Clear, 1100 SL Thin Coat, MVB, Metallic Epoxy, Metallic Pigment, High Wear Urethane, Cohills Eco Stain, Cohills Water-Based Sealer), inserted all 41 Torginol Q-Color #40 quartz blends (pulled from torginol.com/quartz-collections), then deleted-and-reinserted recipe slots for the 5 active systems wired to the right products. First execution failed with a 42P10 ON CONFLICT error because the original migration didn't have a unique index on pec_prod_products(name); second execution after adding that index succeeded.
Why: Dylan asked Cowork to handle steps 2 through 4 of the prior handoff (run the seed, configure recipe slots, optionally deactivate Standard Flake). Cowork's pre-flight check found the prereq migration had never been applied, so all four SQL stages were combined and run together. Recipe slots were configured via SQL rather than the dashboard UI because Dylan opted for "Full setup" and the schema lets us do it in one transactional pass with the right product references.
Files touched: supabase/migrations/2026-05-01_pec_systems_recipes.sql (new), PROJECT-LOG.md
Verification: select 'systems' counts returned 7 total / 6 active (Standard Flake inactive); 'products' 52 total / 52 active; 'recipe_slots' 20; 'color_pairings' 1. Per-system slot counts: Flake 3, Quartz 4, Metallic 4, G&S Cohills 1, G&S Urethane 3, Grind Stain and Seal 2, Standard Flake 3 (legacy). Quartz and Metallic both show requires_flake_color=true.
Open items / assumptions flagged in product notes (need Dylan to confirm against an invoice and edit via Material Catalog UI if wrong): Torginol Q-Color #40 spread_rate=50 (assumed 50-lb box at 1 lb/sqft total); Simiron MVB kit_size=3 gal; Simiron High Wear Urethane kit_size=1 gal; Simiron Metallic Epoxy kit_size=3 gal; Cohills Water-Based Sealer spread_rate=100 (effective for 2-coat system).
Next steps: Dylan opens the dashboard CRM tab -> Material Catalog -> System Types and verifies the 6 active systems and their slot configs render the way he expects. The Metallic Pigment and Cohills Stain "Per-job pick" SKUs are placeholders; specific color SKUs can be added via the Material Catalog as Dylan stocks them. Once a real PEC job is created, exercise the New Job preview to confirm the calculator math comes out right (the box-weight assumption above is the most likely thing to be off).
Handoff to Cowork: None
Handoff to Dylan: 1) Hard-refresh the dashboard, sign in to CRM, click Material Catalog -> System Types. Confirm Flake, Quartz, Metallic, Grind and Seal - Cohills, Grind and Seal - Urethane, and Grind Stain and Seal all appear with the listed slot counts and the right material types in order. Standard Flake should be hidden from the picker but still visible in the catalog with an inactive marker. 2) Spot-check the Torginol box weight against a real invoice; if your boxes aren't 50 lb, edit the spread_rate field on the Q-Color products. 3) Confirm Simiron MVB, Metallic Epoxy, and High Wear Urethane kit sizes against an invoice. 4) Push main to origin when ready (this commit is local-only).

---

## [2026-04-30 12:25] crm: seed 5 PEC system types (Flake, Quartz, Metallic, Grind and Seal, Grind Stain and Seal)
By: Claude Code
Changed: Added supabase/seed_pec_systems.sql, an idempotent insert into public.pec_prod_system_types for the 5 systems Dylan offers. Each row has a description, sensible defaults for the requires_flake_color / requires_basecoat_color flags (Flake true/true, Quartz false/true, the rest false/false), and active=true. Uses ON CONFLICT (name) DO NOTHING so re-running the seed is safe and never overwrites edits Dylan makes via the Material Catalog admin UI. Recipe slots are intentionally not seeded; Dylan configures each system's recipe in the System Catalog after running the seed.
Why: Dylan asked for these 5 systems to appear in the New Job form's "Pick a system" dropdown. The picker reads from pec_prod_system_types filtered by active=true (index.html line 6237), so seeding the rows is the minimum needed change. Recipe slots are per-system and per-product; doing those in SQL would lock them to product names that may not exist yet, so leaving that for the admin UI keeps the seed safe.
Files touched: supabase/seed_pec_systems.sql, PROJECT-LOG.md
Next steps: Dylan runs the seed in Supabase, then opens Material Catalog -> System Types and adds recipe slots for each system. The original "Standard Flake" seed system stays as-is; Dylan can deactivate it in the admin UI if he wants only these 5 in the picker.
Handoff to Cowork: None
Handoff to Dylan: 1) In Supabase SQL editor, run supabase/seed_pec_systems.sql. (If you have not run supabase/migrations/2026-04-28_pm_ordering.sql yet, run it first, otherwise the seed will fail because pec_prod_system_types does not exist.) 2) Open the dashboard, sign in to CRM, click Material Catalog -> System Types. You should see Flake, Quartz, Metallic, Grind and Seal, Grind Stain and Seal listed. 3) For each system, configure its recipe slots (basecoat, flake/quartz, topcoat, stain, sealer, etc.) and product defaults using the existing per-row "Edit recipe" button. 4) (Optional) Mark "Standard Flake" inactive if you don't want it to appear in the New Job picker.

---

## [2026-04-30 12:00] crm: left-rail subnav, light theme to match dashboard, hardened New Job buttons
By: Claude Code
Changed: Three things in index.html. (1) Restructured the CRM shell into a 2-column grid (220px sidebar + main content). The existing `#pecSubnav` keeps all 10 buttons and their `data-pec-view` semantics, but is now wrapped in `<aside class="pec-side">` and renders as a vertical column. The view roots (`#pecViewRoot`, `#prodViewRoot`) live in `<main class="pec-main">`. Below 900px it collapses back to a horizontal scrolling strip. (2) Added a new `<style id="crm-light-theme">` block right after the redesign block. It scopes every `.pec-*` and `.prod-*` surface inside `#tab-prescott-crm` to the redesign light palette (`--rd-bg`, `--rd-card`, `--rd-ink`, `--rd-line`, `--rd-accent`, etc.) and retunes all `.pec-badge` color pairs for legibility on white. The override is gated by `body:not(.pec-portal-mode)` so the customer portal mode (which has its own light tokens) is untouched. The legacy dark `:root` vars are unchanged so non-CRM dark widgets still render. (3) Hardened both New Job flows. `openNewJobForm()` now wraps the Supabase customer load in try/catch and still opens the modal on failure with a visible error banner; the form-submit handler shows a `#pecJobFormError` line instead of a plain `alert(...)` so the user sees what failed. The production-side `saveNewJob()` is wrapped in a top-level try/catch and falls back to alert if `#njError` is missing. Added breadcrumb logs (`[crm] pecJobNew click`, `[prod] prodNewJobBtn click`, `[prod] saveNewJob click`) to make a dead click distinguishable from a failing save in DevTools.
Why: Dylan reported the CRM was still rendering against the dark legacy palette while the rest of the frontend uses the light redesign palette, and that "+ New Job" looked like it did nothing. Cause was twofold: the redesign block has no `.pec-*` overrides, and `openNewJobForm` had a silent-await on `customers` that, if it rejected, killed the modal open with no UI feedback. The left-rail layout matches Dylan's stated preference (tabs on the left, not on top) and aligns the CRM visual language with the existing global sidebar (`#rdSidebarNav`).
Files touched: index.html, PROJECT-LOG.md
Next steps: None blocking. The breadcrumb logs are kept in for now; remove them after Dylan confirms which button he was clicking and that both flows work.
Handoff to Cowork: None
Handoff to Dylan: Hard-refresh the dashboard. Open DevTools console. Click CRM. The subnav should now be a vertical column on the left, on a white card surface. Background should be light gray (`#eef0f3`), cards white. Click each subnav item and confirm no panels are black. Then: click Jobs and "+ New Job". You should see either the modal open OR an alert/banner explaining why it could not load. Submit the form: success closes the modal and opens the new job; any DB error shows up inline now. Click Ordering and "+ New Job"; it should switch to the new-job form view. If a click does nothing AND no breadcrumb log fires in console, the click never reached the handler (bind issue). If the breadcrumb fires but no UI change, the handler's path is failing somewhere we now log; copy that error.

---

## [2026-04-28 18:30] crm: inline material calculator so file:// works
By: Claude Code
Changed: Inlined the material calculator into index.html's production module so the dashboard works when opened directly via file:// (Chrome blocks ESM imports for file:// origins with a CORS error, which was killing the entire production script and leaving Ordering + Material Catalog blank). The canonical source is still production/calculator.js — it's used by npm test, kept identical, and the in-file comment in both files now says "if you change one, change both and re-run npm test." Verified npm test still passes 24/24.
Why: Dylan opens the dashboard locally as a file (file://) for testing. The previous static `import { computeMaterialPlan } from './production/calculator.js'` worked on Netlify but not on file://. Two ways to fix: tell Dylan to use a local server every time, or make the page work on file:// directly. Inlining is the lower-friction fix and removes a class of bug where browser security policy randomly differs between dev and prod.
Files touched: index.html, production/calculator.js, PROJECT-LOG.md
Next steps: None blocking. Test runs unchanged.
Handoff to Cowork: None
Handoff to Dylan: Hard-refresh the dashboard. Open DevTools console. Click CRM → Ordering. You should now see the empty-state table with the + New Job button, plus the breadcrumb log "[prod] module booted, prodSwitchView ready" and no CORS error.

---

## [2026-04-28 17:45] CRM polish: match dashboard UI in Ordering + Material Catalog, fix blank-view bug, blank Colors view
By: Claude Code
Changed: Two real fixes plus a stylistic alignment. (1) Ordering and Material Catalog were rendering blank because ensureBooted in the production module returned the boot promise (which resolves to undefined) and the caller bailed on `if (!ok) return`. Rewrote ensureBooted to await the in-flight boot and explicitly return the booted boolean; also added a "Loading…" empty state that paints immediately so the user never sees a blank panel during the first load. (2) Replaced every .prod-* class in the production module with the existing .pec-* design-system classes (.pec-toolbar, .pec-card, .pec-table, .pec-btn primary/ghost/danger/sm, .pec-badge with status modifier, .pec-field, .pec-row-2/3, .pec-modal-bg, .pec-modal, .pec-modal-actions, .pec-empty, .pec-subnav for the Catalog tab strip). The custom .prod-host stylesheet is gone except for a tiny block (the dashed area-card border, message colors, a slightly wider modal modifier for the job-detail). Sync status uses .pec-badge {completed,admin,submitted} mapped from {clean,error,dirty} so it picks up the existing color tokens. (3) Wiped the Colors subnav view to a single empty-state line per Dylan's request.
Why: Dylan reported both views came up completely blank, and the visual style didn't match the rest of the CRM. The blank was a real bug, not a styling issue. The class swap unifies the two halves of the CRM under one design system so the eye flows from Customers/Jobs into Ordering/Catalog without a jarring shift.
Files touched: index.html, PROJECT-LOG.md
Next steps: Same as before. Dylan still needs to run the migration, deploy the Apps Script POST handler, and set the Netlify env vars before sync goes live (Ordering tab will load and let you create jobs even before that, but the Sync to Order Sheet button will return a clear "not configured" error).
Handoff to Cowork: None
Handoff to Dylan: Hard-refresh. Click CRM, then Ordering. You should see "No production jobs yet. Click + New Job." and the toolbar with status filter + button. Click Material Catalog (admin/pm only). You should see the Products / System Types / Color Pairings sub-strip and tables matching the rest of the CRM. Colors tab is intentionally empty for now.

---

## [2026-04-28 17:05] dashboard: relabel monthly revenue cards as Booked Sales
By: Claude Code
Changed: Top three Command-tab cards now read "PEC Booked Sales - Monthly", "FTP Booked Sales - Monthly", and "Combined Booked Sales - Monthly". Underlying data source (Booked Jobs Sheet) and IDs (#pecRev, #ftpRev, #combRev) are unchanged, so all the existing JS that populates them still works.
Why: The numbers are sales booked, not collected revenue. Dylan asked for the labels to match what they actually represent.
Files touched: index.html, PROJECT-LOG.md
Next steps: None.
Handoff to Cowork: None
Handoff to Dylan: Hard-refresh the dashboard to see the new labels.

---

## [2026-04-28 16:55] CRM consolidation: fold Ordering + Material Catalog into the CRM tab
By: Claude Code
Changed: Renamed the "Prescott CRM" left-sidebar tab to just "CRM" (LABELS, TITLES, button text). Removed the standalone "Production" top-level tab. Moved its two main views into the existing CRM subnav as "Ordering" (the production jobs list + new-job form + job detail modal) and "Material Catalog" (admin/pm gated; products, system types with recipe-slot editor, color pairings). The CRM module's switchView now hands off to window.prodSwitchView when the user clicks Ordering or Material Catalog: hides #pecViewRoot, shows #prodViewRoot, and the production module renders into it. Auth and tab-activation gates that the production module owned are gone (the parent CRM tab handles both). CSS that was scoped to #tab-production was rescoped to .prod-host, applied to #prodViewRoot and #prodModalRoot (both now siblings inside the CRM shell). Internal navigation between the production sub-views (Jobs list ↔ New Job form ↔ Job Detail) is unchanged; only the entry point changed.
Why: Dylan reported he couldn't find material ordering or settings in the CRM and asked for the tab to just be named "CRM." Two top-level tabs for what is conceptually one customer/job system was the wrong shape. One tab, one subnav, one auth flow.
Files touched: index.html, PROJECT-LOG.md
Next steps: None blocking. Watch for any leftover references to "Production" in copy or screenshots if Dylan shares them.
Handoff to Cowork: None
Handoff to Dylan: Hard-refresh the dashboard (Cmd+Shift+R). The left tab now reads "CRM"; the subnav inside it has Ordering and Material Catalog (the latter only if your role is admin or pm). Everything else works as before. The 2-week kill-criterion check-in routine (trig_01Hb73C7jSPnHWGEYTP8E5fd, fires 2026-05-12) is unaffected.

---

## [2026-04-28 16:10] PM Module 1: runbook + module v1 ready for end-to-end test
By: Claude Code
Changed: Added docs/pm-module-ordering-runbook.md covering one-time setup checklist (migration, Apps Script deploy, Netlify env vars, test sheet), day-to-day operation (new job, quantity edits, recalculate, mark complete, catalog admin), how to switch between test and production sheets, how to run the calculator tests, the rollback plan, what's intentionally not in v1, and known constraints (proxy URL rotation, 30s LockService timeout, unique proposal_number index). Module 1 v1 is now code-complete and waiting on the deploy handoff to Dylan.
Why: The kill criterion is two weeks to replace Dylan's manual ordering workflow. Code is done; the remaining gap is operational (Apps Script paste, Netlify env vars, test-sheet copy). The runbook gives Dylan a single page to follow without needing to ask Claude Code questions.
Files touched: docs/pm-module-ordering-runbook.md
Next steps: Dylan executes the deploy handoff. After the first real PEC job is synced and visible in production, schedule a 2-week check-in to evaluate the kill criterion before any work begins on Module 2 (Job Costing).
Handoff to Cowork: None
Handoff to Dylan: Follow docs/pm-module-ordering-runbook.md "One-time setup checklist." Stop after step 5 (first end-to-end test) and report back with whether the test-sheet sync looked right. Do not point the function at the real production sheet until that passes. Once it does, set CONTEXT-style env to production and run the same flow against one upcoming real job.

---

## [2026-04-28 15:55] PM Module 1: Production tab UI wired into index.html
By: Claude Code
Changed: Added a new Production tab to the dashboard (button at line 1130, section at line 1499, sidebar nav auto-populates via the existing build() in the rd-shell script). The sub-app reuses window.pecSupabase and window.pecState from the Prescott CRM module so a single sign-in works for both. Three views: Jobs (sortable table by install date with a status filter and click-to-detail), New Job form (proposal #, customer, address, install date, crew, plus a multi-area repeater where each area picks System Type then Flake then optional basecoat override and sqft, with a live calculator preview that re-runs on every input change), and System Catalog admin tab gated to admin/pm roles via the existing .pec-role-admin class (Products, System Types with recipe-slot drill-down editor, and Color Pairings with set-as-default toggle). Job Detail modal shows status pills, areas, fully editable material lines, and four buttons: Recalculate from catalog (with overwrite warning), Save line edits (marks the job dirty), Sync to Order Sheet (calls the Netlify Function with the user's Supabase JWT and surfaces success/failure), and Mark Complete (with confirmation; the modal then refreshes from the DB and shows the final status). Calculator imported as a real ESM module from /production/calculator.js (no inlining), so the same code paths are unit-tested and used at runtime. Self-contained styles scoped under #tab-production using existing CSS variables (--accent, --border, --s1/2/3, --text, --muted), no new tokens.
Why: This is the operational interface that has to replace Dylan's manual ordering workflow within the kill-criterion window. Single sign-in across CRM + Production reduces friction; live calculator preview catches bad inputs before a save; role gating keeps the catalog out of office-staff hands; Save vs Sync separation means in-flight edits never accidentally hit the production sheet; Mark Complete moves the rows but keeps the DB record so Module 2 can attach labor + compute profit later.
Files touched: index.html
Next steps: Runbook doc (docs/pm-module-ordering-runbook.md), then hand off the deploy steps so Dylan can complete the Apps Script + Netlify env-var setup and run the first end-to-end test against a copy sheet.
Handoff to Cowork: None
Handoff to Dylan: None new beyond the previous log entry's handoff (run the migration + seed; deploy the Apps Script doPost; set Netlify env vars; create a test copy of the production Sheet).

---

## [2026-04-28 15:10] PM Module 1: Apps Script proxy snippet + sync Netlify Function
By: Claude Code
Changed: Added production/sheets-proxy-snippet.js, the doPost code Dylan pastes into the existing CONFIG.SHEETS_PROXY Apps Script project. It implements two actions: syncJob (find rows on NEW ORDER SHEET by Proposal #, delete them, insert the new block in chronological position by Install Date with an UNSCHEDULED divider for jobs without a date) and moveJobToCompleted (capture the block, append to COMPLETED JOBS with today's date in column M, delete from NEW ORDER SHEET). Includes a script-level lock so concurrent calls don't corrupt the sheet, a SCRIPT_SECRET check, and idempotent move-to-completed. Added netlify/functions/pec-prod-sync-sheet.js implementing the staff-only proxy: validates the caller's Supabase JWT, verifies their admin_users.role is admin/pm/office, loads the job + areas + material lines via service-role REST, builds the 15-column payload, POSTs to the Apps Script proxy, updates pec_prod_jobs.last_synced_at + sync_status, and writes a row to audit_log for every operation (success and failure). use_test=true in the body or CONTEXT=dev makes the function target PEC_PROD_SHEET_ID_TEST instead of PEC_PROD_SHEET_ID so the first integration test never touches the real sheet.
Why: The Sheet sync is the single highest-risk operation in this module (corrupting the live ordering sheet would block crew leads and suppliers immediately). Locking, idempotent move-to-completed, before/after audit log, and the test-sheet override exist because that risk is real.
Files touched: production/sheets-proxy-snippet.js, netlify/functions/pec-prod-sync-sheet.js
Next steps: Wire the new Production tab into index.html (System Catalog admin first, Jobs list, New Job form, Job Detail modal with Sync + Mark Complete). Then runbook + final handoff entry.
Handoff to Cowork: None
Handoff to Dylan: 1) Open the existing CONFIG.SHEETS_PROXY Apps Script project; append production/sheets-proxy-snippet.js; in Project Settings -> Script Properties add SCRIPT_SECRET with a long random value; Deploy -> Manage Deployments -> Edit -> New Version (the /exec URL stays the same). 2) In Netlify env vars set: PEC_SHEETS_PROXY_URL (the existing /exec URL), PEC_SHEETS_PROXY_SECRET (matches SCRIPT_SECRET), PEC_PROD_SHEET_ID (the real id 16vfUHggITTuz53RRWFepQWNtInJmN1JsZ7qt3MeRGcI), PEC_PROD_SHEET_ID_TEST (a copy you make of the production sheet for the first end-to-end test).

---

## [2026-04-28 14:30] PM Module 1 foundation: schema, seed, calculator, proposal doc
By: Claude Code
Changed: Approved Module 1 of the PEC PM build (Ordering / Material Calculator) and laid the foundation. New Supabase migration creates 9 production tables prefixed pec_prod_* (products, system_types, recipe_slots, color_pairings, jobs, areas, material_lines, labor_entries, overhead_allocations) with RLS policies matching the existing is_admin_staff pattern. Seed populates the Standard Flake System (3 products, 1 system type, 3 recipe slots, 1 default color pairing). Pure-function material calculator extracted to production/calculator.js with a 24-assertion Node test runner; npm test green for every spec edge case (sqft=0, sqft=1, exact kit and box boundaries, spread_rate=0 rejection, negative sqft rejection, missing-flake rejection, multi-area merge by product, distinct basecoat colors as separate lines, recipe order preserved). Proposal doc at docs/pm-module-ordering-plan.md captures the spec's required Step 0 record. Two-arm decision matrix made with Dylan: extend the existing Apps Script proxy for Sheet writes (no new service account), and keep production tables separate from public.jobs (which is the customer portal). Multi-area jobs supported in v1.
Why: The kill criterion is two weeks to replace Dylan's manual ordering workflow. Foundation first (schema, calculator) lets the UI and Sheet sync land on solid ground. Calculator is the highest-risk piece (math errors over-order or under-order materials), so unit tests come before any UI.
Files touched: docs/pm-module-ordering-plan.md, supabase/migrations/2026-04-28_pm_ordering.sql, supabase/seed_pm_ordering.sql, production/calculator.js, production/calculator.test.js, package.json
Next steps: Apps Script POST snippet (production/sheets-proxy-snippet.js), then Netlify Function pec-prod-sync-sheet.js, then UI inline in index.html (System Catalog admin first, then Jobs list, New Job form, Job Detail with sync button, Mark Complete).
Handoff to Cowork: None
Handoff to Dylan: 1) Run supabase/migrations/2026-04-28_pm_ordering.sql in Supabase SQL editor. 2) Run supabase/seed_pm_ordering.sql after the migration. 3) Verify the 9 tables exist in Supabase Studio with RLS enabled. No code wired to these tables yet, so this is safe to do whenever.

---

## [2026-04-25 23:03] ARM 2 v1: customer color picker + signature wired
By: Claude Code
Changed: Customer portal (?portal=token mode in index.html) now lets epoxy customers pick one or more labeled flake colors from the 15 seeded Simiron swatches before signing. Signature submit now sends the picks to portal_confirm_job (was previously sending p_colors: null). Paint jobs skip the picker and just collect a signature with copy explaining the project manager handles paint colors directly. Portal mode now overrides the dark dashboard CSS variables to render on the light/professional palette (--rd-bg, --rd-card, etc) and applies an FTP brand class for orange accent on Finishing Touch customers.
Why: ARM 2 backend (Supabase schema, RPCs, DripJobs webhooks) was already live and the index.html portal scaffold was already drawn, but customers had no way to actually choose their colors through the portal. Locking colors via customer self-service before the crew shows up is the operationally critical gap.
Files touched: index.html
Next steps: Test end-to-end with a real DripJobs-generated token. After v1 validates, follow up with reviews + referrals (already drawn but dormant), per-brand visual polish, paint color seed for Sherwin-Williams, and DripJobs auto-send of the portal link.
Handoff to Cowork: None
Handoff to Dylan: 1) Pull a portal link from a recent customer in the Prescott CRM tab and open it in a private window to verify the picker shows 15 Simiron swatches, the signature canvas works, and the confirm button enables only after both a pick AND signature exist. 2) Test on a phone (iOS Safari + Android Chrome) since signature canvas is the highest failure-risk piece. 3) Push to origin when ready (this commit is unpushed).

---

## [2026-04-25 22:39] Removed TEST-HANDOFF.md after loop verified
By: Claude Code
Changed: Deleted TEST-HANDOFF.md from the repo.
Why: The handoff loop test (entries on 2026-04-25 22:36 and 23:00) succeeded and Cowork's commit 7d6af8f confirmed the trace. The file has no purpose beyond that test.
Files touched: TEST-HANDOFF.md
Next steps: None. Loop is closed.
Handoff to Cowork: None
Handoff to Dylan: Push main to origin when ready (local is currently ahead by 3 commits, plus this one makes 4).

---

## [2026-04-25 23:00] Cowork handoff confirmation
By: Cowork
Changed: Appended the line "Cowork was here" to the bottom of TEST-HANDOFF.md as requested in the handoff.
Why: Closes the end-to-end test of the Claude Code, Cowork, Dylan handoff loop. Leaves a verifiable trace that Cowork picked up the written handoff and acted on it.
Files touched: TEST-HANDOFF.md
Next steps: Commit with message "test: cowork handoff confirmation". Dylan can verify the loop and then schedule a future cleanup entry to delete TEST-HANDOFF.md.
Handoff to Cowork: None
Handoff to Dylan: Verify the commit landed, then decide when to remove TEST-HANDOFF.md.

---

## [2026-04-25 22:36] Test handoff file created for Cowork
By: Claude Code
Changed: Created TEST-HANDOFF.md containing a single handoff request asking Cowork to append the line "Cowork was here" to that file.
Why: End-to-end test of the Claude Code, Cowork, Dylan handoff loop. Confirms Cowork reads handoffs from this repo, acts on them, and leaves a verifiable trace.
Files touched: TEST-HANDOFF.md
Next steps: Wait for Cowork to append the line and commit. Once verified, the file can be deleted in a future cleanup entry.
Handoff to Cowork: Open TEST-HANDOFF.md, append the line "Cowork was here" to the bottom, then commit with message "test: cowork handoff confirmation".
Handoff to Dylan: None

---

## [2026-04-25 22:34] Project log initialized
By: Claude Code
Changed: Created CLAUDE.md and PROJECT-LOG.md. Initialized git repo and .gitignore.
Why: Establish change history so Dylan, Cowork, and Claude Code stay in sync and Dylan can debug or roll back when something breaks.
Files touched: CLAUDE.md, PROJECT-LOG.md, .gitignore
Next steps: Begin tracking all future changes via commits and log entries.
Handoff to Cowork: None
Handoff to Dylan: Going forward, before each Claude Code session, cd into this directory so CLAUDE.md is loaded automatically.

---

## Entry template (copy this for each new entry, paste it ABOVE the most recent entry)

## [YYYY-MM-DD HH:MM] Short title of what changed
By: Claude Code | Cowork | Dylan
Changed: One or two sentences on what was actually modified.
Why: The reason. Tie to a goal or fix.
Files touched: comma-separated list
Next steps: What should happen next, if anything.
Handoff to Cowork: Specific actions needed, or "None"
Handoff to Dylan: Specific actions needed, or "None"

---
END TEMPLATE
