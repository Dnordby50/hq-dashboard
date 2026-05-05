# Job Schedule + Customer Journey: Future TODOs

Companion to `docs/pm-module-unification-plan.md`. Captures the next phases beyond what shipped on 2026-05-04 (Job Schedule + Job Costing + DripJobs auto-bridge). Items are roughly priority-ordered, but each can stand alone.

## 1. Lead Pipeline / Kanban

**Goal:** Replace the current "leads live in DripJobs only" pattern with a top-of-funnel pipeline inside the dashboard, where a job entity is created the moment a lead is captured and flows through Kanban columns until the proposal accepts.

**Columns (proposed):** New Lead → Contacted → Estimate Scheduled → Estimate Sent → Accepted → Lost.

**Build notes:**
- New `public.leads` table OR reuse `public.customers` with a new `pipeline_stage` column.
- Drag-and-drop card reordering between columns. Native HTML5 DnD is fine; no library needed.
- Lead capture form (manual entry) + a "Convert to estimate" action that hands off to DripJobs (or to native estimate writing once that lands).
- Same `id` flows through to the production job once accepted, so this `lead_id` becomes the `customer_id` everywhere downstream.

## 2. Estimate Calendar

Separate calendar from the Job Schedule. Books estimate appointments (1–2 hr blocks) with the salesperson assigned. Probably a daily/weekly view with time slots, not the multi-day bar layout the install schedule uses. Consider Google Calendar two-way sync for the salesperson's calendar.

## 3. Native estimate writing using the Material Catalog

Replace the DripJobs estimate authoring step with a native flow that uses the catalog (Phase 1 of the 2026-05-04 work) to compute pricing.

**Why:** owns the data end-to-end; lets the calculator drive the proposal, the install material plan, and the costing baseline from one source.

**Build notes:**
- New `public.proposals` table (already specced in `pm-module-unification-plan.md`).
- New "Write Estimate" UI that picks a customer, system, sqft per area, color choices, hours estimate. Calculator computes material cost. Margin slider sets price.
- "Send to customer" produces a portal link (the customer-portal infra already exists).
- Backfill: keep DripJobs webhook live during the transition.

## 4. Automated personalized follow-ups using Claude

Per-stage SMS/email follow-ups generated from job notes + history. Examples:
- Lead in "Contacted" for 3 days → polite check-in.
- Estimate sent, no response after 5 days → follow-up with FAQ pointers.
- Job complete → review request + warranty reminder.

**Build notes:**
- A scheduled Netlify Function or Supabase cron job that scans for overdue stages.
- Claude API call with: customer name, last interaction notes, stage, brand voice. Returns the message body.
- Sends via Twilio (SMS) or existing email path. Opt-in toggle per customer.
- Log every send so we don't double-tap the same customer.

## 5. Full job-table unification

Today: `public.jobs` (DripJobs/CRM side) and `public.pec_prod_jobs` (production side) coexist, linked by `customer_id` + `dripjobs_deal_id`. The 2026-05-04 webhook auto-bridges them on proposal-accept.

Once the bridge is stable:
- Decide canonical: probably `pec_prod_jobs` (with a richer schema) absorbs the lifecycle columns from `public.jobs`.
- Migrate the customer portal that reads `public.jobs` to read the unified table.
- Refactor `pec-webhook-stage-changed.js` and `pec-webhook-project-completed.js` to update the canonical row.
- Drop `public.jobs` (or keep as a view for backward compat).

## 6. Customer detail rollup page

A "click a customer" page that shows: contact info, all proposals, all production jobs (with schedules), all material lines, all costing rows, all reviews, all referrals — one screen per customer. Useful for both internal lookups and the future customer portal.

## 7. `pec_prod_labor_entries` UI

Table is already in the schema (since 2026-04-28) but not surfaced. Surface it so:
- Each crew member's hours per day per job get logged individually.
- Salary & Wages column in Job Costing auto-sums from these entries instead of being a manual single number.
- Unlocks per-person profitability reports later.

## 8. DripJobs payload extension

DripJobs currently sends: customer fields + `deal_id, address, job_type, package, scope, sqft, price, monthly_payment, dripjobs_url, warranty`. It does NOT send `system_type` or `estimated_hours`. Both would let the auto-bridged job land in Pending Jobs already pre-filled.

**Action:** ask the DripJobs side (Cowork session or whoever maintains the integration) to add those two fields to the `proposal-accepted` webhook payload. Then extend `pec-webhook-proposal-accepted.js` to map them onto `pec_prod_jobs.estimated_hours` and the first `pec_prod_areas.system_type_id`.

## 9. Drag-and-drop scheduling on the calendar

Current Job Schedule lets you reschedule via the popup only. Future enhancement: drag a job's bar to a new day, drag its right edge to extend duration. Calendar event manipulation. Nice-to-have, not blocking.

## 10. Sheets export of Pull Material + Job Costing

The 2026-05-04 Pull Material modal renders on screen and prints. If users want the result in a Google Sheet (for sharing or further manipulation), wire it through the existing `pec-prod-sync-sheet` Netlify Function infrastructure. Same for Job Costing exports at quarter-end.

## 11. FTP equivalent of the PEC production stack

The 2026-05-04 webhook auto-bridge currently fires only when `customer.company === 'prescott-epoxy'`. FTP-accepted estimates land in `public.customers` + `public.jobs` as before, but get NO `pec_prod_jobs` row (and so don't appear in the Job Schedule sidebar).

When FTP needs the same Schedule + Costing + Ordering treatment, decide between:
- **Option A — separate FTP tables**: `ftp_prod_jobs`, `ftp_prod_crews`, etc. Cleanest separation, but doubles the schema and the UI render functions need to dispatch by brand.
- **Option B — add `company` column to `pec_prod_*` tables (recommended)**: rename them to `prod_*` (or leave the prefix, treat it as historical), add a `company text not null default 'prescott-epoxy'` column to `pec_prod_jobs`, `pec_prod_crews`, `pec_prod_job_costing`, `pec_prod_job_schedule_days`. Brand switcher on the dashboard sets the active filter; every query gets `.eq('company', activeBrand)`. The webhook bridge passes through the company. One schema, two brands.

Then update the brand switcher (top of dashboard) to flip `state.activeBrand` and refresh all the pec_prod_* loaders accordingly.

## 12. Material auto-sum into Materials Ordered/Pulled

The user opted for fully manual costing entry, but if the catalog `unit_cost` data ever gets fully populated, we could pre-fill `materials_ordered_cost = sum(qty_needed * unit_cost_snapshot)` from `pec_prod_material_lines` on first open of a job's costing row. Manual override would still win.
