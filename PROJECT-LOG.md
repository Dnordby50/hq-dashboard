# CRM / Dashboard Project Log

Newest entries on top. Append only. Never edit or delete past entries. If a previous entry was wrong, write a new correction entry that references it.

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
