# PEC PM Module 1: Ordering / Material Calculator — Plan

Status: approved 2026-04-28 by Dylan via Claude Code plan mode. This document is the in-repo durable record of the spec's Step 0 proposal.

Source spec: `~/Desktop/HQ/06 - Automations & Tech/Active Automations/PEC-Spec-CRM-PM-Module-Ordering-ClaudeCode-Prompt-2026-04-28.md`

## Stack alignment (no deviations)

The existing repo uses:

- Frontend: a single 5651-line `index.html` served from the Netlify publish root. Vanilla JS, no build step. Direct `@supabase/supabase-js` ESM client in the browser, exposed as `window.pecSupabase`. Existing tab system at `index.html:1124-1129` with `data-tab` attribute switching, switcher logic at `3493-3504`. Existing Prescott CRM sub-app pattern at `1455-1495` is the template for any new sub-app.
- Backend: Netlify Functions, CommonJS, esbuild. Two auth conventions: webhooks use `x-webhook-secret` (`netlify/functions/_pec-supabase.js:27-31`), staff-only writes use Supabase JWT validation against `/auth/v1/user` plus an `admin_users.role` check (`netlify/functions/pec-create-staff.js:31-39`). Service-role REST helper `sb()` for all DB writes.
- Database: Supabase Postgres. UUID PKs (`gen_random_uuid()`), snake_case, RLS enabled on every table, `is_admin_staff()` / `is_admin_role()` SECURITY DEFINER helpers in `supabase/policies.sql:5-30`. Audit log already exists in `supabase/schema.sql:160-173`.
- Sheet integration: a Google Apps Script web app at `CONFIG.SHEETS_PROXY` already handles GET reads from three sheets. We will extend the same Apps Script with a `doPost` handler rather than introduce a Google Service Account.

This module matches every existing convention. No framework changes, no build step changes.

## File / folder structure

New, additive. Nothing in `supabase/schema.sql`, `supabase/policies.sql`, or `public.jobs` changes.

```
docs/
  pm-module-ordering-plan.md       this file
  pm-module-ordering-runbook.md    how to operate, test, roll back
production/
  calculator.js                    pure function, ESM
  calculator.test.js               Node-runnable assertions, no framework
  sheets-proxy-snippet.js          Apps Script code for Dylan to paste
supabase/
  migrations/
    2026-04-28_pm_ordering.sql     all new tables + RLS policies
  seed_pm_ordering.sql             Standard Flake System seed
netlify/functions/
  pec-prod-sync-sheet.js           sync + mark-complete, JWT-authed
package.json                       minimal, just `npm test`
index.html                         new Production tab + sub-app inline
```

## Data model

All new tables prefixed `pec_prod_*`. Reasoning: `public.jobs` is the customer-portal job (signature, DripJobs deal id, archive). The spec's "production job" has different fields and lifecycle. Conflating them is the exact bug the spec is built to avoid. They can be linked later via proposal number if the need arises.

Tables (UUID PKs, `created_at`, `updated_at` where applicable, RLS with `is_admin_staff()` policies):

- `pec_prod_products` (catalog SKUs)
- `pec_prod_system_types` (Standard Flake, Grind & Seal, Metallic, etc.)
- `pec_prod_recipe_slots` (the ordered material list per system type)
- `pec_prod_color_pairings` (flake → basecoat default pairings)
- `pec_prod_jobs` (proposal #, customer, install date, crew, status, sync metadata)
- `pec_prod_areas` (one-or-more area per job, each with sqft + system type + colors)
- `pec_prod_material_lines` (computed lines, snapshotted unit_cost for Module 2)
- `pec_prod_labor_entries` (schema only, no UI in v1, populated by Module 2)
- `pec_prod_overhead_allocations` (schema only, no UI in v1)

See `supabase/migrations/2026-04-28_pm_ordering.sql` for the full DDL.

## Sync architecture

```
Browser (admin UI)
   |
   | 1. Save job: supabase-js insert into pec_prod_jobs / _areas / _material_lines
   | 2. Click "Sync to Order Sheet": fetch /netlify/functions/pec-prod-sync-sheet
   |    with Authorization: Bearer <supabase access token>
   v
Netlify Function pec-prod-sync-sheet
   |
   | 3. Verify JWT against Supabase /auth/v1/user
   | 4. Verify admin_users.role IN ('admin','pm','office')
   | 5. Load job + areas + material lines via service-role REST
   | 6. Build 15-column row payload
   | 7. POST to CONFIG.SHEETS_PROXY with shared SCRIPT_SECRET
   v
Apps Script doPost
   |
   | 8. Find existing rows by Proposal # (column B), delete them
   | 9. Insert new block in chronological position by Install Date
   | 10. Or moveJobToCompleted: remove from NEW ORDER SHEET, append to COMPLETED JOBS with Date Completed
   v
Netlify Function
   |
   | 11. Update pec_prod_jobs.last_synced_at, sync_status, sync_error
   | 12. Insert audit_log row (action: pec_prod_sync or pec_prod_complete)
   v
Browser
   |
   | 13. Refresh job row, show last-synced timestamp
```

The browser never talks to Sheets directly. The function is the only thing that holds the proxy secret, and the proxy is the only thing that holds Sheets write credentials.

## Decisions made

1. Sheet write mechanism: extend the existing Apps Script proxy. (Apps Script's deployment URL plus a shared `SCRIPT_SECRET` is the auth surface.)
2. Schema: separate `pec_prod_*` namespace.
3. Multi-area jobs: supported in v1 via `pec_prod_areas`.
4. Sync trigger: manual button per job (not auto-on-save).
5. UI in `index.html` (matches convention); calculator extracted to `production/calculator.js` so it can be unit-tested.
6. Single test runner: a Node-runnable script with `assertEq` calls. No framework. `npm test` runs it.
7. No DripJobs API integration in v1. Manual entry of proposal # + customer info is fine.
8. No QuickBooks, no scheduling, no AI optimization, no customer-facing pages, no SMS / email.

## Open items requiring Dylan handoff (before sync goes live)

1. Create a copy of the production Sheet for testing. Provide the new Sheet id.
2. Paste `production/sheets-proxy-snippet.js` into the existing Apps Script project; add a new deployment version; set `SCRIPT_SECRET` in Apps Script Project Properties.
3. Set Netlify env vars: `PEC_SHEETS_PROXY_SECRET` (matches Apps Script `SCRIPT_SECRET`), `PEC_SHEETS_PROXY_URL` (the existing `/exec` URL), `PEC_PROD_SHEET_ID` (production), `PEC_PROD_SHEET_ID_TEST` (the copy).
4. Pick one real upcoming PEC job from the current pipeline for the end-to-end test.

Until those are done, the UI works against Supabase only and the Sync button surfaces a clear "sync not configured yet" error.

## Build order

1. Migration + seed (this commit).
2. Proposal doc + runbook.
3. Calculator + tests (`npm test`).
4. Apps Script POST snippet (handoff).
5. Netlify Function (deploys to Netlify but inert until env vars set).
6. UI: System Catalog admin → Jobs list → New Job form → Job Detail → Mark Complete.
7. End-to-end test against the copy Sheet, then against production.

## Out of scope (hard line)

Customer-facing color picker, customer portal pages, DripJobs API integration, QuickBooks, job costing math, scheduling calendar, cure-time validation, AI optimization, SMS / email customer comms, multi-tenancy, mobile app, public deployment.

## Kill criterion (carried from the spec)

If Module 1 has not replaced Dylan's manual ordering workflow within two weeks of v1 going live, pause and re-evaluate before building Module 2.
