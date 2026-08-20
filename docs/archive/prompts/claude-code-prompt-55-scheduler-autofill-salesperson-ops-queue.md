# Claude Code Prompt 55: scheduler autofill, locked salesperson, and the Admin Ops Queue

## Before you start
Read CLAUDE.md and the last 3 PROJECT-LOG.md entries (standing rule 4). Consult features.json and SCHEMA.md before grepping or writing SQL (standing rules 9, 10). Do not read index.html end to end; use the anchors in this prompt.

**Deploy-order warning.** Prompt 54's migration (`supabase/migrations/2026-07-28_people_model.sql`) is WRITTEN BUT NOT APPLIED to prod. `public.people` does not exist in the live database yet. Nothing in this prompt may read or write `people`. Part C's assignee picker reads `admin_users`, deliberately, so this build ships independent of prompt 54's migration state. If you find yourself wanting `people`, you have taken a wrong turn.

## Goal
Four items from Dylan, in one build:

- **A.** System type and estimated hours auto-populate on the job scheduler from the estimate.
- **B.** Salesperson is locked at estimate creation, and shows on job detail and on the printed work order.
- **C.** An Admin Ops Queue: one screen listing everything that needs a human, so Anne can run the admin side of TopCoat without Dylan telling her what to look at.
- **D.** The standing-rule paperwork for all three.

A and B are mechanical. C is a new surface with one small table. Build them in that order and commit each part separately, so a problem in C does not hold A and B.

---

## Decisions locked (from Dylan, do not re-litigate)

**Part A**
1. System type resolves through the SAME chain Job Costing already uses (CRM job card by deal id, else name+address, then `pec_prod_areas`, then the schedule stub). Extract it, do not fork it. No new column, no migration, no backfill.
2. Estimated hours come from `window.computeJobEstimate(...).budgetedHours`, the same number the front-end Budget card and Job Costing use. The manual `pec_prod_jobs.estimated_hours` becomes the FALLBACK, not the source.
3. **Both stay EDITABLE. The autofill is a prefill, not a lock.** The system dropdown and the hours input both remain, prefilled from the estimate, and a change saves as it does today.
   *Decision history, so this is not re-opened:* Dylan was asked this four times across the session and answered editable, editable, read-only, editable. The majority and the final answer agree, and editable is also the lower-risk rollout, since it removes no control PMs use today. If a schedule-side system override later turns out to be causing drift against the estimate, the fix is check 6 in the Ops Queue surfacing the disagreement, NOT quietly locking the field.
3a. **System: live, but an explicit pick wins.** The derived value re-resolves on every render, so a change order or a corrected rep pick follows through automatically. An explicit pick in the schedule modal is an override and sticks. Implement it through the mechanism that already exists (the pick writes the system onto the job's `pec_prod_areas` row, inserting the default "Main" area when there is none, and the helper's precedence already puts a real `pec_prod_areas` system ahead of the CRM-derived one). Verify that ordering holds; if it does not, fix the precedence, do not add a column.
3b. **Hours are scheduling-only.** The editable hours field writes `pec_prod_jobs.estimated_hours` and affects the schedule surfaces ONLY. Costing and crew bonus keep using the computed number, per prompt 50. The field must say so on screen. This prompt does NOT reverse prompt 50.
3c. **Hours drift is visible, never silent.** The computed estimate re-derives every time the modal opens. A typed override wins on the schedule surfaces, and whenever an override exists AND differs from the current computed estimate, the modal shows a note reading "Estimate now says N hrs" so a change order that moved the estimate cannot quietly leave a stale schedule number unchallenged.
4. Every schedule surface that shows these two values uses ONE shared helper: the schedule modal, the Pending Jobs cards, the read-only job popup, the calendar bars, and the Next Day board. No surface keeps its own resolution.
5. Derived at read time. Nothing is written to the database to make this work, and no existing job is backfilled.

**Part B**
6. `jobs.salesperson` (the CRM job card, frozen from the estimate on accept) is the single source of truth for display. `pec_prod_jobs.sales_team` follows it and is never the thing we read.
7. Salesperson is LOCKED at estimate creation. Only an ADMIN can change it afterward, and the change is recorded. This intentionally narrows prompt 47's "freely editable" decision; prompt 47's on-behalf-of case is now an admin action.
8. On the printed work order, salesperson goes in the Job Identity intake grid, NOT in the header hero boxes. Prompt 53 just verified that header's height math; do not disturb it.
9. A job with no salesperson displays "Unassigned" and is surfaced as an Ops Queue item (Part C, check 5).

**Part C**
10. Shape: an Admin Ops Queue. One screen that scans live data for everything stalled or incomplete, each row linking straight to where it gets fixed.
11. Populated automatically by data checks AND by manual items Dylan (or any admin) adds and assigns.
12. Notification routing: a count badge on the nav button, plus a `pec_notifications` row for NEW MANUAL items only. Derived items never write to the bell (they would re-fire every day).
13. NO permission changes. Anne is already role admin and passes every gate except `can_finalize_costing`, and that stays as it is. This prompt does not touch `user_permissions`, `DELEGABLE_PERMS`, or any RLS policy on existing tables.

---

## PART A: system type and estimated hours on the schedule

### The bug, precisely
`openScheduleModal` (index.html ~26857) builds its draft like this:

```js
const domSysId = dominantSystemId(areas);            // areas = state.productAreasByJob[job.id]
...
estimated_hours: job.estimated_hours || (job.is_callback ? (state.touchupSettings?.defaultHours ?? 2) : ''),
system_type_id: sys ? sys.id : '',
```

Both read production-side rows that are EMPTY for DripJobs-bridged and manually added jobs: `pec_prod_areas` is a stub with no `system_type_id`, and `pec_prod_jobs.estimated_hours` is null. The same two blanks show up on the Pending Jobs card (index.html ~25876, "No system yet") and the read-only job popup (index.html ~26830, "Est. hours").

Job Costing already solved this. `loadCostingData` (index.html ~28390 to ~28505) resolves each prod job to its CRM job card with `window.resolveCrmForProdJob` (deal id first, then `window.jobNameAddrKey` on name+address), builds plan areas with `window.crmPlanAreas`, and runs `window.computeJobEstimate` to get `budgetedHours`. It stores the results in `state.estimateByJob` and `state.systemIdByJob`. The schedule never calls any of it.

### A1: extract the resolution into one helper
Create a single function, used by every surface in decision 4. Suggested shape:

```js
// Resolves the estimate-derived facts for a production job the SAME way
// loadCostingData does. Returns { systemTypeId, budgetedHours, source } or nulls.
window.prodJobEstimateFacts(jobId)   // reads a cache built once per load
```

Requirements:

- The resolution logic must exist ONCE. Either extract the body of the `loadCostingData` estimate phase into a shared builder that both callers use, or have the schedule call that same builder. Do not copy the chain. If the two ever disagree, the whole point of this part is lost.
- The schedule does not currently load products, recipe slots, or the CRM identity list. Add a `loadScheduleEstimates()` that fetches exactly what the builder needs, batched into the schedule's EXISTING `Promise.all`, and caches the result on state for the render. Reuse `cachedRef` for products and recipe slots (they are already cached elsewhere; do not add a second uncached read of a 182-row and a full slot table on every calendar page turn).
- Degrade silently. Wrap the whole estimate phase in try/catch exactly as `loadCostingData` does (`console.warn('[pec] ... skipped:', e)`). If it throws, every surface falls back to today's behavior. The schedule must never fail to render because estimate math failed.
- Precedence for hours, in order: a typed OVERRIDE in `pec_prod_jobs.estimated_hours` > computed `budgetedHours` > touch-up default (`state.touchupSettings.defaultHours`) for callbacks > blank. The helper returns both the effective value and the computed value, so callers can flag drift (decision 3c). State this precedence in a comment at the helper.
- **What makes a stored value an override.** Because the override wins, a derived value must never be able to masquerade as one. The modal writes `estimated_hours` ONLY when the field's value differs from the derived prefill it opened with. Saving without touching the field writes nothing and leaves the column as it was.
- Precedence for system: CRM job card system (its own `system_type_id`, else dominant `job_areas` by sqft) > dominant `pec_prod_areas` > schedule stub > null.
- Round displayed hours to one decimal. Do not round the stored or costing value.

### A2: the schedule modal
In `openScheduleModal`, prefill `draft.system_type_id` and `draft.estimated_hours` from the helper, falling back to the current expressions.

**System stays a dropdown (decision 3).** It opens on the derived value and Save behaves exactly as today (an explicit pick inserts the default "Main" area when the job has none). Add a short note under it when the value came from the estimate: "From the estimate." No em dashes.

**The one guard that matters (decision 3a).** Saving the modal WITHOUT touching the system dropdown must not write a system. Otherwise every Save silently converts the derived value into a sticky override, and within a week no job follows its estimate any more. Same rule as the hours field: write only what the user actually changed.

**Hours are scheduling-only (decision 3b).** Under the Estimated hours input, two short lines: "From the estimate. Type to override." and "Scheduling only. Job Costing and crew bonus use the estimate." No em dashes. No new badge, no new setting. Do not touch `computeCostingRow`, which correctly ignores `estimated_hours` per prompt 50.

**Drift note (decision 3c).** When the job carries an override AND the current computed estimate differs from it, replace the first line with "Estimate now says N hrs" plus a one-click "Use it" that drops the computed value into the field. The schedule surfaces keep showing the override until someone acts; the note is what makes acting possible.

### A3: the other surfaces
- Pending Jobs card (~25876): system chip and the `· N hrs est` suffix read the helper. "No system yet" now only appears when the job genuinely has no system anywhere.
- Read-only job popup (~26830): the `System` and `Est. hours` rows read the helper.
- Calendar bars (~24772, ~24834): the `· N hrs` suffix reads the helper.
- Next Day board and its printed run sheet: same.

### A4: out of scope for Part A
No migration. No backfill. No change to `computeCostingRow`, to `loadCostingData`'s outputs, or to what the Budget card shows. If you find yourself editing costing behavior, stop.

---

## PART B: salesperson locked, shown on job detail and the work order

### B1: lock it in the estimator
`apps/estimator/src/features/estimator/EstimatorScreen.tsx`:

- Line ~185: the current-user default from prompt 47 stays exactly as it is (match `pec_sales_team_members.auth_user_id` to the session user, else blank; never `salespeople[0]`).
- Line ~1806: the `<select>` becomes read-only text showing the salesperson's name for non-admins. Admins keep the select.
- **The blank exception.** If `salespersonId` is empty (an unmapped login, per prompt 47's fallback), the select stays ENABLED for everyone. Otherwise an unmapped rep can never save an estimate, and prompt 47's block-with-a-clear-message path becomes a dead end. Keep that message unchanged.
- **Fail closed.** Determining "is this user an admin" needs the session user's `admin_users.role`. Thread it in the same way `currentUserId` is threaded from `App.tsx`. If the lookup fails or returns nothing, treat the user as NOT an admin (locked). A rep briefly unable to reassign is a much smaller problem than a silently editable commission attribution.
- This applies to BOTH surfaces, the standalone PWA and the dashboard-embedded estimator, since they share the component.

### B2: after the estimate exists
- `pec-public-estimate.cjs` already writes `jobs.salesperson` (~:810) and `pec_prod_jobs.sales_team` (~:888) from `intake.salesperson_name` on accept. VERIFY this still happens. Do not rebuild it.
- Add an admin-only inline edit of `jobs.salesperson` on the CRM job detail. It writes `jobs.salesperson`, mirrors the new value to the linked `pec_prod_jobs.sales_team`, and writes a job activity log row (the per-job audit card already exists, see features.json "Job activity log"). Non-admins see plain text.
- The schedule modal's existing `sales_team` field becomes READ-ONLY when the job resolves to a CRM job that carries a salesperson. It stays editable only for prod jobs with no CRM card, so a manual "+ Add Job" row can still record who sold it. A second freely editable copy of this name is exactly the drift decision 6 exists to kill.
- Do NOT mass-update `pec_prod_jobs.sales_team` rows that currently disagree with `jobs.salesperson`. Display reads the CRM job; the disagreements surface in the Ops Queue instead.

### B3: job detail
In `renderJobDetailInner` (index.html ~13563; it already selects `jobs.*`, so `salesperson` is in hand), add a Salesperson row to the job's detail rows. Read-only for non-admins, inline-editable for admins per B2. Blank renders "Unassigned".

### B4: the printed work order
`renderWorkOrder` (index.html ~13270). The Job Identity grid at ~13485 currently ends with an empty label/value pair:

```html
<div class="lbl">Phone:</div>          <div class="val num">...</div>
<div class="lbl"></div>                <div class="val"></div>
```

Replace that empty pair with:

```html
<div class="lbl">Salesperson:</div>    <div class="val">${e(job.salesperson || 'Unassigned')}</div>
```

The grid is 2 pairs per row, so this fills the existing hole and the row count does not change. Height math is untouched.

Note the deliberate inconsistency and comment it: the CREW and DATE hero boxes print EMPTY when blank because the crew writes them in by hand. Salesperson is not something the crew fills in, so a blank one prints "Unassigned" and gets fixed in the office (Part C, check 5).

### B5: out of scope for Part B
No change to commission attribution, to `renderCommission`, or to the alias machinery from prompt 54. Renames are already commission-safe by that build; this prompt only changes WHO can edit the name and WHERE it is displayed.

---

## PART C: the Admin Ops Queue

### What this is not
This is not the follow-up queue from prompt 49 (that is sales-side, lives in Leads, and tracks leads overdue for a human touch). This is admin-side data hygiene and workflow: things that are stuck, missing, or waiting on a person. Do not merge the two, and do not duplicate prompt 49's checks here.

### C1: the view
New view key `ops`, label "Ops Queue", in the Overview nav group next to To-dos, class `pec-role-admin` (index.html ~2481 for the group markup, ~7485 for the `switchView` render map). Admin-gated the same way Job Costing and Settings are.

### C2: derived checks (no storage)
Every check is computed at render time from data that already exists. Ship these, each as its own card or grouped section with a count, and each row linking to the exact screen that fixes it:

1. **Unmapped BusyBusy names.** Rows in the employee map with a null `crew_member_id` and `ignored = false`, plus any imported name with no row at all. Links to Settings > BusyBusy. (Their hours never reach costing, per SCHEMA.md.)
2. **Costings waiting to be finalized.** `pec_prod_job_costing` rows with `costing_submitted_at` set and `costing_finalized_at` null. Links to Job Costing. (Note in the row that only an admin with `can_finalize_costing` can clear these.)
3. **Scheduled or completed jobs with no revenue.** `pec_prod_jobs` where status is scheduled/in progress/completed and `revenue` is null or 0, excluding callbacks (the existing `pec_prod_jobs_scheduled_needs_revenue` constraint already exempts them). Links to the job.
4. **Completed jobs never invoiced.** `completed_date` set and `invoice_first_sent_at` null. Links to Invoicing.
5. **Signed jobs with no salesperson.** `jobs.salesperson` null or blank on a signed job. Links to the job detail, where B2's admin edit fixes it. This is the Part B feeder.
6. **Jobs with no system.** The Part A helper returns null for the job. Links to the job card.
7. **Drips held for approval.** Count from the existing Drip Approvals data. Links there.
8. **Touch-ups open too long.** `touchup_state = 'open'` older than a threshold. Links to the Touch-ups panel.
9. **Deposits not collected.** Signed jobs past a threshold with `deposit_collected` false and `deposit_waived` false. Links to Invoicing.
10. **System health.** One line each for unapplied migrations (reuse the Schema Drift signal) and stuck estimator syncs (reuse the sync-health signal). These already have their own screens; the queue just surfaces that they are non-zero.

Every check gets an on/off toggle, and every threshold gets a number, in Settings > General under an "Ops Queue" heading (standing rule 12). Defaults: all checks on; thresholds 7 days for touch-ups, 7 days for deposits.

Reuse the queries and helpers each source screen already uses. Do not write a new bespoke query where one exists, and verify every table and column against SCHEMA.md before you write any SQL (standing rule 9).

### C3: manual items and dismissals (one small table)
Migration `supabase/migrations/2026-07-28_ops_queue.sql`, WRITTEN, NOT APPLIED (Cowork applies it; handoff below). Include the `@artifacts` header per rule 13 and a Verify block at the bottom.

`public.pec_ops_items`:

- `id uuid pk default gen_random_uuid()`
- `source text not null` CHECK in ('manual','auto')
- `title text` (required for manual, null for auto dismissals)
- `body text`
- `assigned_to uuid` references `admin_users(id)` (NOT `people`, see the deploy-order warning)
- `created_by uuid` references `admin_users(id)`
- `due_date date`
- `status text not null default 'open'` CHECK in ('open','done','dismissed')
- `link_view text`, `link_id uuid` (so a manual item can deep-link like a notification does)
- `check_key text` (auto rows only: a stable identifier such as `job_missing_revenue:<job uuid>`)
- `created_at`, `done_at`, `done_by uuid`

Indexes: partial unique on `check_key WHERE source = 'auto'` (one dismissal per derived item, ever); one on `(status, assigned_to)` for the badge count.

RLS: staff read, admin write, using the EXISTING `is_admin_staff()` / `has_permission` helpers. Do not invent a new permission concept and do not widen any existing policy.

Behavior:

- **Manual item:** "+ Add item" on the queue with title, optional note, assignee (admin_users list), optional due date. Also add an "Add to Ops Queue" action on the CRM job detail that prefills `link_view`/`link_id`. Nothing else gets the action in v1.
- **Dismiss a derived item:** writes an `auto` row with that item's `check_key` and `status = 'dismissed'`. The queue hides derived items whose key has a dismissal. Because the key contains the record id, dismissing one job's missing revenue never hides another's.
- **Done:** manual items flip to `done` with `done_at`/`done_by`. Derived items have no Done, only Dismiss; they disappear when the underlying data is actually fixed, which is the point.

### C4: ordering and layout
Overdue manual items first (past `due_date`), then remaining manual items, then derived sections in the order listed in C2. Show a total count at the top. The table sits in a `.pec-table-wrap` (prompt 53 shipped the global scroll rule; do not add another unwrapped wide table).

### C5: badge and bell
- **Nav badge:** count of OPEN MANUAL items. One cheap count query at boot. Do NOT run the derived checks at boot; they are page-load work only. Say so in a comment, because the obvious "make the badge show everything" change would put ten queries on every sign-in.
- **Bell:** inserting a manual item writes one `pec_notifications` row (`type` 'ops_item', `target_view` 'ops', `target_id` the item id) so it routes through the existing `notifTarget` machinery. Derived items write nothing to the bell, ever.

### C6: out of scope for Part C
No permission changes (decision 13). No email or SMS. No daily digest function. No AI. No reading or writing `people`. If a check needs data that does not exist yet, drop the check and note it in the log entry rather than adding columns.

---

## PART D: standing-rule paperwork

- **What's New** (help/whats-new.json): one entry for the scheduler autofill, one for salesperson on the job and work order, one for the Ops Queue. Plain language, customer-facing tone, NO em dashes (standing rule 6). Part A is arguably a fix, but the visible behavior changes for every PM, so it gets an entry.
- **features.json:** amend "Job Schedule calendar" (autofill), "Customers and jobs records" and "Crew notes on the work order" or whichever entry anchors `renderWorkOrder` (salesperson), and add a new "Admin Ops Queue" entry with its `indexHtml` anchors, `tables`, `settings`, and `spec` pointing at this file.
- **PROJECT-LOG.md:** one new entry at the TOP, By: Claude Code, describing what you actually did, which files changed, the commits, and the handoff. If you stopped early or hit an error, log that anyway.
- **Commits:** one per part, `npm test` green (root suite is 25/25) before each. Stage specific files, never `git add .`.

---

## Verify before you call it done

**Part A**
- A DripJobs-bridged job that previously showed "No system yet" on its Pending card now shows its system, and the same system appears in the schedule modal, the popup, and the calendar bar.
- The hours shown in the schedule modal for a job equal the Budget card's hours for that job and Job Costing's estimated hours for that job. All three, same number. This is the acceptance test for the whole part.
- Typing over the hours still saves and still shows on the card after a reload, and Job Costing's estimated hours for that job DO NOT change (decision 3b).
- Save the modal WITHOUT touching the hours field on a job that has no stored hours: `pec_prod_jobs.estimated_hours` is still null afterward (the prefill did not become a fake override). Query the row to confirm, do not infer it from the UI.
- With an override saved, change that job's estimate (add an area or change sqft), reopen the modal: the override is still in the field, the "Estimate now says N hrs" note appears with the new number, and "Use it" replaces the field value (decision 3c).
- Open the schedule modal on a job whose estimate carries a system, Save WITHOUT touching the dropdown, then change that job's system on the job card: the schedule follows the new one. If it does not, the Save silently froze the derived value and the guard in A2 is not working. Confirm by querying `pec_prod_areas`, not by reading the UI.
- Explicitly pick a different system, Save, then change the job card's system: the schedule keeps the picked one (decision 3a).
- Open the modal on a manual "+ Add Job" row with no CRM card and no areas: picking a system still inserts the default "Main" area on Save.
- A manual "+ Add Job" prod row with no CRM card still opens the modal cleanly with blanks, no console error.
- Break the estimate phase deliberately (temporarily throw inside the builder) and confirm the schedule still renders with today's behavior and one console warning.

**Part B**
- As a non-admin rep in the estimator: salesperson shows as text, cannot be changed.
- As a rep whose login is unmapped: the field is enabled and the existing block message appears on save.
- As an admin: the select works in both the PWA and the embedded estimator.
- Job detail shows the salesperson; an admin edit writes `jobs.salesperson`, mirrors `pec_prod_jobs.sales_team`, and appears in the job activity log.
- Print the work order for a job WITH a salesperson and one WITHOUT. Confirm the Job Identity grid is still even (2 pairs per row), the page count did not grow, and the blank one reads "Unassigned".

**Part C**
- Pre-migration: the Ops Queue renders its derived checks and shows a clear run-the-migration notice on the manual-items card. Every other screen behaves exactly as before. Confirm this on the live deploy, since pushing auto-deploys the UI before Cowork applies the migration (this is the same trap prompt 53 hit; commit 0b11859 is the pattern).
- Each derived row's link lands on the right screen with the right record open.
- Dismiss a derived item, reload, confirm it stays hidden and that a SECOND record of the same check type is still listed.
- Add a manual item, confirm the nav badge increments and one bell notification appears that routes to the queue.
- Confirm no bell notification is written by any derived check.
- Confirm `user_permissions` and every existing RLS policy are untouched (`git diff` the migration and grep the diff for `policy`).

---

## Handoff to Cowork
1. Apply `supabase/migrations/2026-07-28_ops_queue.sql` to PROD (`zdfpzmmrgotynrwkeakd`). Additive only: one new table, its indexes, its RLS policies, and the Ops Queue settings keys.
2. Run the Verify block at the bottom of the migration file.
3. Regenerate SCHEMA.md (standing rule 9): add the `pec_ops_items` section and the new settings keys, and update the settings row count and the documented-of-live header.
4. Exercise the queue in the live app: add a manual item assigned to Anne, confirm it appears with the badge and the bell, mark it done, dismiss one derived item, and confirm the dismissal persists across a reload.
5. Still open from prior entries and NOT part of this prompt: prompt 54's People migration is unapplied, and Aron Bronson's 47.78-hour BusyBusy punch plus the Matt Scharrer job (#2227346) still gate the first real hours import.
