# PM Module 1 — Ordering Runbook

How to operate, test, and roll back the Production tab.

## What this module is

The Production tab in the dashboard is the in-house ordering / material-calculator front-end for PEC. It owns its own Supabase tables (`pec_prod_*`) and writes to the existing PEC Order Sheet via the Apps Script proxy plus a new Netlify Function (`pec-prod-sync-sheet`).

DripJobs is still the source of truth for jobs and customers. This module does not pull from DripJobs. Dylan enters the proposal #, customer, sqft, and install date by hand for v1.

## One-time setup checklist

1. **Apply the migration.**
   - In Supabase SQL editor, run `supabase/migrations/2026-04-28_pm_ordering.sql`.
   - Then run `supabase/seed_pm_ordering.sql` (idempotent).
   - In Supabase Studio, confirm the 9 `pec_prod_*` tables exist with RLS enabled.

2. **Deploy the Apps Script POST handler.**
   - Open the existing Apps Script project that hosts `CONFIG.SHEETS_PROXY` (the one whose `/exec` URL is referenced in `index.html` near line 1575).
   - Append the contents of `production/sheets-proxy-snippet.js`. Keep the existing `doGet`.
   - Project Settings → Script Properties → add `SCRIPT_SECRET` with a long random value (generate one with `openssl rand -hex 32`).
   - Deploy → Manage Deployments → Edit → New Version. The `/exec` URL stays the same.

3. **Set Netlify environment variables.**
   ```
   PEC_SHEETS_PROXY_URL          existing /exec URL of the Apps Script web app
   PEC_SHEETS_PROXY_SECRET       must equal SCRIPT_SECRET in Apps Script
   PEC_PROD_SHEET_ID             16vfUHggITTuz53RRWFepQWNtInJmN1JsZ7qt3MeRGcI (production)
   PEC_PROD_SHEET_ID_TEST        a copy of production made for the first end-to-end test
   ```

4. **Make the test sheet.**
   - In Drive, right-click the production PEC Order Sheet → Make a copy. Name it "PEC Order Sheet — TEST".
   - Open it, confirm both tabs (`NEW ORDER SHEET` and `COMPLETED JOBS`) and the 15-column header row exist.
   - Copy the new sheet id (the long hash in its URL) into `PEC_PROD_SHEET_ID_TEST` in Netlify.

5. **First end-to-end test.**
   - Sign in as an admin or pm at the dashboard.
   - Open the Production tab. The Jobs view should be empty and the System Catalog tab should show the 3 seeded products, the Standard Flake System type, and the Domino → Tinted Gray default pairing.
   - Click `+ New Job`. Enter a real upcoming proposal #, customer, address, an install date, and one Area: name "Garage", sqft 600, system Standard Flake, flake Domino. Verify the calculator preview shows 3 lines: 2 basecoat kits, 2 flake boxes, 3 topcoat kits.
   - Save. The job appears in the Jobs list as `dirty`.
   - Open the job. Click `Sync to Order Sheet`.
     - The browser calls `/.netlify/functions/pec-prod-sync-sheet` with the user's Supabase JWT.
     - The function loads the job + areas + lines, builds the 15-column payload, and POSTs to the Apps Script.
     - Because Netlify Dev / preview defaults to the test sheet (or because you can pass `use_test=true` from the function payload manually), the rows land in the TEST copy. Verify visually.
   - Edit a quantity, click `Sync` again. The block updates **in place**. Sync 3 times in a row; verify there are still 3 rows and no duplicates.
   - Click `Mark complete`. Verify the rows leave `NEW ORDER SHEET` and appear at the bottom of `COMPLETED JOBS` with today's date in column M. Verify in Supabase that `pec_prod_jobs.status='completed'` and that all `pec_prod_material_lines` rows for that job still exist.
   - Once the test sheet behavior is verified, switch to a real production job and let the function target `PEC_PROD_SHEET_ID` (the production sheet) by leaving `use_test` unset and the `CONTEXT` env var at `production` (Netlify default for prod deploys).

6. **Audit log spot-check.**
   - In Supabase, `select * from public.audit_log where action like 'pec_prod_%' order by created_at desc limit 20;`
   - Each sync and mark-complete should have a row with `auth_user_id`, `admin_email`, `entity_type='pec_prod_job'`, and a before/after JSON snapshot.

## Day-to-day operation

- **New job:** Production tab → `+ New Job` → fill in → Save → click the row → `Sync to Order Sheet`.
- **Quantity changed:** open job → edit qty in the line → `Save line edits` (job goes `dirty`) → `Sync to Order Sheet`.
- **Recalculate from catalog:** if a System Type or Product changes, `Recalculate` on the job rebuilds all material lines from the current catalog. This **overwrites** any manual line edits — the modal warns before doing it.
- **Mark complete:** `Mark complete` button on a job after install. Rows move to COMPLETED JOBS; DB record is preserved so Module 2 can attach labor entries against the same `Job.id`.
- **Adding a flake color or system type:** System Catalog → Products / System Types / Color Pairings.

## Switching between test and production sheets

Two ways:

1. Per-call: future code can pass `use_test: true` in the body of the POST to `pec-prod-sync-sheet`. There is no UI toggle for this in v1 — it's intended for one-off tests.
2. Per-environment: Netlify sets `CONTEXT='dev'` for Netlify Dev / preview deploys. The function automatically picks `PEC_PROD_SHEET_ID_TEST` in that case if it's set.

## Calculator unit tests

```
npm test
```

Runs `node production/calculator.test.js`. Should print 24 passing assertions and exit zero. Re-run any time the calculator file changes.

## Roll back

The migration is additive only. To undo it, drop the `pec_prod_*` tables in Supabase. The existing customer portal (public.jobs, public.customers, etc.) is untouched.

```sql
drop table if exists public.pec_prod_overhead_allocations cascade;
drop table if exists public.pec_prod_labor_entries cascade;
drop table if exists public.pec_prod_material_lines cascade;
drop table if exists public.pec_prod_areas cascade;
drop table if exists public.pec_prod_jobs cascade;
drop table if exists public.pec_prod_color_pairings cascade;
drop table if exists public.pec_prod_recipe_slots cascade;
drop table if exists public.pec_prod_system_types cascade;
drop table if exists public.pec_prod_products cascade;
drop function if exists public.pec_prod_touch_updated_at();
```

The Production tab in `index.html` and the Netlify Function will still load but show an empty state and a 5xx on sync, respectively. To remove them, revert the relevant commits.

## Things that are NOT in v1 (do not assume)

- Customer-facing color picker (still ARM 2 territory).
- DripJobs API integration. Manual entry of proposal # is the v1 pattern.
- QuickBooks integration.
- Job costing math. Schema is in place (`pec_prod_labor_entries`, `pec_prod_overhead_allocations`, `unit_cost_snapshot`, `line_cost`), but no UI surfaces it. Module 2.
- Scheduling / calendar / cure-time validation. Module 3.
- SMS or email notifications.

## Known constraints

- Sync uses the Apps Script proxy. If Dylan rotates the Apps Script `/exec` URL or revokes the deployment, sync will start failing with a 5xx until `PEC_SHEETS_PROXY_URL` is updated.
- Sync writes to the sheet are protected by an Apps Script LockService with a 30s timeout. If two sync calls overlap by more than 30 seconds, the second will return 503 and the user can retry.
- `pec_prod_jobs.proposal_number` is uniquely indexed. Dylan cannot enter the same proposal # twice (the New Job form surfaces this as "A job with that Proposal # already exists.").
