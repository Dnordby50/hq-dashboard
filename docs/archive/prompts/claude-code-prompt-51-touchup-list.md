# Claude Code prompt 51: Touch-up list on the Job Schedule, callback lifecycle, cause tracking

## Context

Dylan's ask (2026-07-27): "need to add a touchup list to the job schedule so we can prioritize our current and past customers, and track callbacks."

Read before you start: CLAUDE.md, the top 3 entries of PROJECT-LOG.md, features.json entries "Job Schedule calendar", "Reschedule / pending flow", "Next Day Schedule and run sheet", "Job costing", "Crew bonus and Bonus Report", and SCHEMA.md for `pec_prod_jobs`, `pec_prod_job_schedule_days`, `pec_prod_job_costing`, `pec_prod_job_bonuses`, `settings`.

### What already exists (do NOT rebuild it)

Touch-up callbacks are already a shipped concept. This prompt is a tracking layer on top of them, not a new entity.

- `addTouchupCallback(prodJob)` at index.html ~25079 creates the callback: a new `pec_prod_jobs` row with `is_callback = true`, `original_job_id` = the parent, `revenue = null`, `status = 'unscheduled'`, then opens `openScheduleModal(newId)` so the user places it on a day/crew/slot.
- The only entry point is the `#schedAddCallback` button inside `openScheduleModal` (index.html ~25346), which means you must already be looking at the original job's scheduler to create one.
- Migration `supabase/migrations/2026-06-08_touchup_callback.sql` added `is_callback`, `original_job_id`, the `idx_pec_prod_jobs_original_job_id` index, and widened the `pec_prod_jobs_scheduled_needs_revenue` CHECK to exempt callbacks.
- `pec_prod_jobs.callback` (boolean) is a SEPARATE legacy quality flag (crew-lead callback counts, index.html ~11649). Do not conflate the two. Do not repurpose it.
- Callbacks are excluded from revenue in four places: `revSliceFor` guard at index.html 23729, the prorated-week exclusion at 24514 (reason string `'touch-up callback (no charge)'`), the filter at 29018, and the metrics filter at 11713-11716.
- `runScheduleStatusSync` (index.html ~6580) deliberately skips callbacks so they stay `status = 'unscheduled'` by design; the calendar reads day rows, not `install_date`.
- Prompt 50 Part E already uses callbacks: `callbackParents` (index.html ~15976) is built from rows with `is_callback = true` AND `original_job_id`, and flags the PARENT job's bonuses for manual review (Pay full / Reduce / Void via `review_status` / `reviewed_by` / `reviewed_at` / `review_note`, all live in prod since 2026-07-26).

### What is broken today, and is the point of this prompt

`freshPending` at index.html 24214 filters on `!j.install_date && !scheduledJobIds.has(j.id) && j.status === 'unscheduled' && ...` and does NOT exclude `is_callback`. Every unscheduled touch-up therefore renders in the **Pending Jobs** aside as an ordinary job card, showing "Proposal #MANUAL-..." and "No system yet", visually identical to a real booked job waiting to be scheduled. There is no list of open touch-ups, no age on them, no state between "unscheduled" and "on the calendar", no record of why the callback happened, and no way to create one from a customer phone call without first hunting down the original job and opening its scheduler.

Build the touch-up queue. Fix the Pending Jobs leak as part of it.

---

## Locked decisions (Dylan answered these 2026-07-27; do not re-litigate)

1. **A touch-up stays a full callback job.** Every touch-up is a `pec_prod_jobs` row with `is_callback = true` and `original_job_id` set, exactly as `addTouchupCallback` creates it today. No parallel entity for the visit itself. New tracking state (lifecycle, cause, manual order, requested-by) hangs off that row; you choose columns-on-the-row vs a sidecar table and state the reason in the log entry.
2. **Placement: a Touch-ups panel on the Job Schedule**, in the left aside alongside Pending Jobs. Not a top-level nav item.
3. **Queued until scheduled, then a real calendar block.** A new touch-up sits in the panel with no date. Assigning crew + day + slot puts it on the calendar as it works today. Nothing lands on the calendar on creation.
4. **Intake is office-only, from two places:** the panel's own Add button (the "customer just called" path, so it must let you find the original job by customer name or address without leaving the schedule), and a button on the job detail page. No crew-mobile entry, no automatic customer-request intake in this build.
5. **Revenue: $0 warranty by default, billable is an explicit override.** See Part D, this is the one answer that fights existing code.
6. **Costing rolls up to the ORIGINAL job.** A callback's real cost has to land on the parent's GP. See Part E, including a conflict you must resolve deliberately.
7. **Order is manual drag, with badges and an optional suggested sort.** Manual order is the saved default. Rows carry computed badges. A "Sort by suggested" button re-sorts on demand and manual order is restorable.
8. **Lifecycle: Open, Scheduled, Waiting on customer, Done.**
9. **Aging: the row turns red past N days open**, N in Settings, default 14. Visual only, no notification.
10. **Customer comms are manual**, via a prefilled Text button that opens the existing Messages thread.
11. **Cause is REQUIRED at close**, not at open.
12. **Touch-ups appear on the Next Day Schedule and the printed run sheet**, badged TOUCHUP.
13. **Any staff can create, schedule, and close.** No new permission flag, no RLS change on `pec_prod_jobs`.
14. **Ship as one build.**

---

## Part A: schema

New migration `supabase/migrations/2026-07-27_touchup_queue.sql` with the `@artifacts` header per standing rule 13. Written by you, applied by Cowork (standing rule 8), then SCHEMA.md refreshed for the affected tables.

State to add (column names are a suggestion, the shape is not):

```
touchup_state        text    check (touchup_state in ('open','scheduled','waiting_customer','done'))   -- NULL on non-callback rows
touchup_opened_at    timestamptz     -- when the touch-up was requested, the age clock's anchor
touchup_closed_at    timestamptz
touchup_cause        text    check (touchup_cause in ('crew_workmanship','material_failure','customer_expectation','damage_after_install','sales_spec_error','other'))
touchup_cause_note   text
touchup_closed_by    uuid
touchup_order        integer -- manual drag rank, lower first
touchup_billable     boolean not null default false
touchup_requested_by text    -- free text: who reported it (customer, crew lead, inspection)
```

Constraints and care:

- Every one of these must be nullable or defaulted so existing rows and the non-callback rows (the other 78 in the table) are untouched. Additive only, idempotent, `add column if not exists`.
- Do NOT touch `pec_prod_jobs.status`, its CHECK, or the `pec_prod_jobs_scheduled_needs_revenue` constraint. `touchup_state` is a parallel axis: a touch-up can be `status = 'unscheduled'` and `touchup_state = 'waiting_customer'` at the same time, and `runScheduleStatusSync`'s skip at 6580 must keep working unchanged.
- Index for the panel query: `(is_callback, touchup_state, touchup_order)` or equivalent. The panel loads on every schedule render, keep it cheap.
- Backfill: existing callback rows get `touchup_state = 'done'` if the parent's schedule days are all in the past AND the row has schedule days, else `'scheduled'` if it has day rows, else `'open'`; `touchup_opened_at = created_at`. Do the backfill in the migration, and report the counts in the log entry so Dylan can sanity-check them.
- RLS: nothing. Existing `pec_prod_jobs` policies already cover new columns (same posture as the 2026-07-26 bonus migration).

### Settings keys (standing rule 12, seeded in the migration)

- `touchup_aging_days` (default `14`) — days open before a row goes red.
- `touchup_default_duration_hours` (default `2`) — prefills the schedule modal for a touch-up.
- `touchup_panel_show_done_days` (default `30`) — how far back the Done section reaches.

All three exposed in Settings under the Schedule / Production group, next to the existing production knobs.

---

## Part B: the Touch-ups panel

Lives in the Job Schedule left aside (index.html ~24218, the `pec-sched-grid` aside that currently holds only Pending Jobs). Same `<details>` pattern, so it collapses on mobile like its sibling.

**B1. Fix the Pending leak first.** Add `&& !j.is_callback` to `freshPending` at index.html 24214, and confirm `needsResched` at 24213 cannot pick up a callback either (a callback with `reschedule_days_owed > 0` should show in Touch-ups, not Pending). Verify against live data that the Pending count drops by exactly the number of unscheduled callbacks and nothing else.

**B2. Sections**, in order: Open (includes Waiting on customer, visually distinct), Scheduled, Done (collapsed by default, limited to `touchup_panel_show_done_days`). Header shows the open count and a Report link (Part G).

**B3. The row.** Customer name, address, the one-line description (reuse `pec_prod_jobs.notes`, which `addTouchupCallback` already seeds), days open, and:

- **Badges**, computed at render from data already loaded by `loadScheduleData`:
  - `Active job` when that customer has another non-callback `pec_prod_jobs` row scheduled in the current or next week.
  - `Crew nearby <day>` when any job scheduled in the visible window shares the same city (parse from `address`, do not invent a geocoder).
  - `Waiting on customer` when in that state, with the days since it entered it.
  - Red styling on the whole row past `touchup_aging_days`. Use the existing amber reschedule badge at 24225 as the visual precedent; do not invent a new badge system.
- **Actions**: `+ Schedule` (hands to `openScheduleModal`, unchanged), `Text` (prefilled, Part F), `Close` (Part C), and drag to reorder.

**B4. Manual order.** Drag within a section persists `touchup_order`. Reuse whatever drag mechanism the Next Day run-sheet cards already use (`renderNextDay`) rather than adding a library. Order is per-section, global across users, no per-user ordering.

**B5. Sort by suggested.** A button that re-sorts Open by a transparent score and writes the result to `touchup_order`, so manual and suggested share one storage field. Before overwriting, snapshot the previous order (a settings row or a `touchup_order_prev` column, your call) so **Undo sort** restores it. The score is deterministic and must be shown on hover or in a tooltip as the reason, no AI call:

```
score = (has active/upcoming job ? 40 : 0)
      + (crew scheduled in same city this window ? 25 : 0)
      + min(days_open, 30)                       // age pressure, capped
      + (waiting_customer ? -15 : 0)             // parked items sink
```

State in the log entry that these weights are a starting point tunable in code, and that Dylan asked for manual order as the default deliberately.

---

## Part C: lifecycle and close

- Create → `touchup_state = 'open'`, `touchup_opened_at = now()`.
- Scheduling (saving day rows in `openScheduleModal`) → `'scheduled'`. Pulling all days back off → `'open'`, not `'waiting_customer'`.
- **Waiting on customer** is set by hand from the row, with an optional note appended to `notes`. It does not stop the age clock (Dylan wants to see the total wait), but it visually de-prioritizes and subtracts from the suggested score.
- **Close** opens a small modal requiring a cause from the six-value enum. `other` requires a note (validate before enabling the button). Closing sets `touchup_state = 'done'`, `touchup_closed_at`, `touchup_closed_by = auth uid`, and leaves the row and its schedule days intact. Nothing is deleted, ever.
- Closing must NOT change the parent's bonus review state. Prompt 50's gate is an admin decision on the Bonus Report; a closed touch-up does not auto-resolve it. If you find code that would, leave it and say so.

---

## Part D: billable touch-ups (the one that fights existing code)

Today `is_callback` means "no charge" implicitly, in four hard-coded places (23729, 24514, 29018, 11713-11716). Dylan wants $0 to stay the default with a billable override.

Change the rule from **"is_callback means excluded"** to **"a callback with no revenue is excluded; a callback with `revenue > 0` counts."** Concretely:

- Set `touchup_billable = true` and a `revenue` value together, from the schedule modal or the row. Never one without the other.
- Audit all four exclusion sites and make each one test revenue, not just the flag. Behavior for every existing row (all `revenue = null`) must be byte-identical to today. Say in the log entry that you verified this, with the four line numbers.
- The `pec_prod_jobs_scheduled_needs_revenue` CHECK already exempts callbacks, so a billable one passes trivially. No constraint change.
- **Boundary: do not wire billable touch-ups into invoicing, AR, or `public.jobs`.** A callback has no `public.jobs` row by design (index.html ~25079 comment). Revenue on the row shows in schedule revenue and costing only. If Dylan wants to invoice a paid callback, that is a separate prompt. Say this explicitly in the log entry so nobody assumes it works.

---

## Part E: costing rollup to the parent, and the bonus conflict

Callback labor and materials must land on the ORIGINAL job's GP, otherwise the parent job keeps reporting a profit that never happened.

Implementation constraints:

- The callback keeps its own costing entry (hours, materials go where they were spent). The PARENT's costing view gains a read-only **Callback costs** line inside the existing Costs section of `renderUnifiedJob`, summing every child where `original_job_id = parent.id`, and that sum flows into the parent's total variable cost and GP.
- Never double count: the parent's rollup must not also appear as a standalone costing row in reports that sum all costings. Check `renderJobCosting` / `loadCostingData` for any all-rows total and handle it.
- The line is clickable through to the callback.

**The conflict you must resolve deliberately, not accidentally:** the crew bonus pool is labor budget minus actual loaded labor (`computeCrewBonus`). If callback labor rolls into the parent automatically, the pool shrinks on its own. Prompt 50 ALSO flags that parent's bonuses for manual admin review (Pay full / Reduce / Void). Applied together, a crew gets docked twice for one callback: once silently by the math, once by the reviewer.

**Decision to implement: the rollup affects GP reporting only. It must NOT change the inputs to `computeCrewBonus`.** The prompt-50 review gate stays the single lever on bonus. Add a comment at the rollup site saying why, and record the decision in the log entry. If you find that GP and the bonus pool cannot be separated without a larger refactor, STOP and write it up rather than shipping a half-separation.

---

## Part F: intake, comms, run sheet

**F1. Add from the panel.** `+ Touch-up` button in the panel header opens a picker that searches completed and past jobs by customer name or address (the "customer just called" path), plus fields for the description and `touchup_requested_by`. On save it calls the existing `addTouchupCallback` path (refactor it to accept a description and skip the `confirm()` when called from the new flow, keep the old button working). It does NOT auto-open the scheduler from this path: the item goes to the panel as `open`.

**F2. Add from the job detail page.** A `+ Touch-up` action on the job detail header (the same header that carries the prompt-38 tap-to-call and Text actions), pre-linked to that job. Same modal, job prefilled.

**F3. Text button.** Opens the existing Messages thread for that customer with a prefilled draft (prompt 38 pattern, `routes to that job's comms tab`). Nothing sends automatically. Draft copy must have no em dashes (standing rule 6).

**F4. Next Day + run sheet.** `renderNextDay` and the printed run sheet include scheduled touch-ups in the crew's column, badged `TOUCHUP`, showing the description and the original job's address. A touch-up must never be mistaken for a new install on paper. Revenue on the run sheet stays $0 unless billable.

---

## Part G: the callback report

Cause data is worthless without a readout, and "track callbacks" is half of Dylan's ask.

A **Report** link in the panel header opens a modal: counts of closed touch-ups by cause and by crew (the crew on the ORIGINAL job, not the one who did the touch-up) over a window (last 90 days default, plus YTD), with a callback rate (callbacks / completed jobs) for the window. Read-only, computed client side from data already loaded. No new endpoint, no AI. This is deliberately the smallest useful readout; a Metrics tab section is a later prompt if Dylan wants trending.

---

## Part H: wrap-up (standing rules)

- Settings surface for the three keys (rule 12).
- What's New entry appended to `help/whats-new.json`, newest first, no em dashes (rules 6 and 11). Suggested id `touchup-list-job-schedule`.
- `features.json`: new entry "Touch-up list and callback tracking" with its anchors, tables, and settings keys, and update the "Job Schedule calendar", "Next Day Schedule and run sheet", "Job costing", and "Crew bonus and Bonus Report" entries where their behavior changed.
- Migration carries its `@artifacts` header (rule 13) so the drift checker can probe it.
- PROJECT-LOG entry at the TOP, written for a human, including: the Pending-leak fix and the before/after counts, the four revenue-exclusion sites you touched, the GP-vs-bonus decision from Part E, the backfill counts, and a `## Handoff to Cowork` section for applying the migration and refreshing SCHEMA.md.
- Commit per rule 1, one commit per part where the parts are independently revertible.

---

## Acceptance

1. An unscheduled touch-up appears in the Touch-ups panel and NOT in Pending Jobs. Pending's count drops by exactly the number of unscheduled callbacks.
2. Creating a touch-up from a customer call (panel Add, search by name) and from the job detail page both produce the same row shape as the existing `#schedAddCallback` button.
3. Scheduling a touch-up puts it on the calendar and the Next Day view, badged, at $0, and it prints on the run sheet.
4. A row past `touchup_aging_days` renders red; changing the setting changes the threshold with no code edit.
5. Dragging reorders and survives a reload. Sort by suggested re-ranks, tooltips explain the score, Undo sort restores the previous order.
6. Closing without a cause is impossible. Closing with `other` and no note is impossible.
7. A billable touch-up with revenue counts in that week's prorated schedule revenue; every existing null-revenue callback still counts as zero everywhere it did before.
8. The parent job's costing shows the callback cost line and its GP drops accordingly, while the crew bonus pool on that parent is numerically unchanged from before this build.
9. The report modal totals by cause and crew, and its numbers reconcile with a manual query.
10. `npm test` passes. Schema drift panel clean after Cowork applies the migration.

## Not in scope

Crew-facing mobile intake, automatic customer-request intake, invoicing a billable callback, Metrics-tab callback trending, and any change to prompt 50's bonus review gate.
