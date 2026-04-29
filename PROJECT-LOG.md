# CRM / Dashboard Project Log

Newest entries on top. Append only. Never edit or delete past entries. If a previous entry was wrong, write a new correction entry that references it.

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
