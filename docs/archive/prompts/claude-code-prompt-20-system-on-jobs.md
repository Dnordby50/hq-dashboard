# Build Prompt 20: system flows onto the job (estimate areas copied at acceptance), schedule picker defaults to the current month, weekly revenue shows its math

## Context

Repo: /Users/dylannordby/Claude-Code/HQ-Dashboard. Single-file dashboard, index.html. Builds 18 (UI fixes, phone matching, unified Messages) and 19 (icon rail) are shipped and on main (c5f9603). Read CLAUDE.md and the last 3 PROJECT-LOG.md entries before starting.

Three items from a Cowork session on 2026-07-13. Item 1 is the substantive one and it is a DATA MODEL fix, not a UI fix. Read the framing before you touch anything.

Dylan's ask was "make the job type on the schedule dropdown auto populate from the system on the estimate." Recon says the premise is off, and the real bug is bigger and better:

- `pec_prod_jobs` has NO system column and NO job_type column. Verified against every migration that touches the table (2026-04-28_pm_ordering.sql:79 creates it; the later adds are estimated_hours, actual_hours, sales_team, crew_id, crew_lead, callback, dripjobs_deal_id, job_class, standalone_mvb, line_items, original_job_id, is_callback). A job's system lives ONLY in `pec_prod_areas.system_type_id`.
- The `#schedSystem` dropdown in `openScheduleModal` (index.html:19486, seeded at 19355) ALREADY prefills from `areas[0].system_type_id`. It looks broken because there are no areas to read.
- There are no areas because `pec-webhook-proposal-accepted.cjs` (:147-158) creates the `pec_prod_jobs` row with customer, address, revenue, status, sync_status, dripjobs_deal_id, sales_team, notes, and NOTHING ELSE. No areas, no system. This is already a known gap: docs/job-schedule-future-todos.md:69 ("DripJobs does NOT send system_type").
- The manual "+ Add Job" modal (`openAddJobModal`, index.html:19891) has the same hole from the other direction: it writes a job with no areas and no system either (insert payload at 20358-20369).

So a job's system is missing at the source, and every downstream consumer degrades quietly: the calendar color band falls back to indigo (index.html:18827), materials/recipes cannot be built (recipe_slots are keyed by system_type_id, index.html:11197-11213), and per-system $/sqft metrics (10633-10641) and the costing panel's dominant-system chip (22018-22030) have nothing to attribute the job to. Prefilling a dropdown would hide all of that. Fix the source.

Line numbers are from the state of index.html at the time of writing. Verify before editing.

## Task 1: the system flows onto the job

### 1a. Copy estimate areas onto the job at acceptance

When an estimate is accepted and a job is created, copy the estimate's areas into `pec_prod_areas` for that job: system_type_id, sqft, and mvb at minimum (per-area mvb shipped in build 17; see the 2026-07-15 log entry). Carry order_index so `areas[0]` remains meaningful.

Find the acceptance path first. `pec-webhook-proposal-accepted.cjs` is the DripJobs door; there may be a separate estimator-acceptance path (an accepted estimate in your own estimator). Grep both, and handle EVERY door that creates a `pec_prod_jobs` row from an estimate. If a door exists that you cannot fix from this session (a webhook configured in the DripJobs UI, for example), STOP and write it as a Cowork handoff rather than guessing.

Rules:
- NEVER OVERWRITE. The copy fills areas only when the job has NONE. If a job already has areas, an existing area is the newer truth (someone deliberately changed the system on site) and it wins. Dylan's explicit decision. Do not silently revert a human's choice.
- The estimate may have MULTIPLE areas with different systems (a Flake garage plus a Quartz patio). Copy ALL of them, one `pec_prod_areas` row each. The job is genuinely multi-system and the data model already supports that.
- Idempotent. Accepting twice, or a webhook retry, must not double-insert areas.

### 1b. The dropdown shows the DOMINANT system

`#schedSystem` holds one value but a job can have several areas. Show the DOMINANT system: the area holding the most sqft.

This rule ALREADY EXISTS IN THREE PLACES. Reuse it, do not write a fourth:
- `dominantSystemId` in apps/estimator/src/features/estimator/EstimatorScreen.tsx:295-300
- metrics per-system $/sqft attribution, index.html:10633-10641
- the job costing panel's dominant-system chip, index.html:22024-22026

If they have drifted from each other, extract ONE shared helper and point all callers at it, and say so in the log. Note this deliberately disagrees with the calendar band and job badge, which use `areas[0]` (index.html:18600, 6444-6447). Decide whether those should also move to dominant, and JUSTIFY whichever way you go: it is defensible to say the calendar shows the first area's color, but it is not defensible to have two rules nobody can explain. State the answer in the log.

### 1c. System becomes REQUIRED to schedule

A DripJobs job that never went through the estimator has no estimate and no areas, so there is nothing to copy. For those, the dropdown stays blank and SAVE IS BLOCKED until a system is picked. `openScheduleModal` cannot save without a system. This is deliberate: it forces the data in at the one moment a human is already looking at the job, which is what keeps materials and metrics honest.

Do NOT guess a system by scanning the proposal text for "Flake" or "Quartz". Dylan rejected that: a wrong guess is worse than a blank.

### 1d. Same fix on the manual + Add Job modal

`openAddJobModal` (index.html:19891) gets a REQUIRED system dropdown, options from `pec_prod_system_types` (the same source `#schedSystem` uses: `sortSystemTypes(state.systemTypes).filter(s => s.active !== false)`, loaded at index.html:6056). On save, it writes a default area to `pec_prod_areas` with that system, exactly as `openScheduleModal` already does at index.html:19681-19688. Reuse that insert; do not fork it.

### 1e. NO BACKFILL

Dylan's explicit decision: existing area-less jobs in prod are left alone. They get a system the moment someone schedules them, via 1c. Do not write a backfill migration. Do not "helpfully" add one.

## Task 2: the schedule day picker defaults to the current month

`openScheduleModal`'s `draft.pickerMonth` is seeded from the job's FIRST scheduled day (index.html:19369, `pickerMonth: new Date(seedDate.getFullYear(), seedDate.getMonth(), 1)`). Dylan wants it to open on the CURRENT month.

His exact clarification, which is the whole point of the change: "this is for a job that is already scheduled and spans across multiple months. if this happens, show the current month days as default." A job running late June into July currently opens the picker on JUNE, which is the past and is not where he is working.

Build: `pickerMonth` seeds to the current month (the same way `openAddJobModal` already does at index.html:19915, `new Date(today.getFullYear(), today.getMonth(), 1)`).

Guard against the obvious regression: a job scheduled entirely in a DIFFERENT month (a September job opened in July) would now open on a month with none of its selected days visible, which looks like the days vanished. So when the job has scheduled days OUTSIDE the current month, show a small, unmissable line at the top of the picker naming them and offering to jump ("2 days in September" with a jump control). The selected days themselves are unchanged, they are just not on screen; the line is what makes that legible. Existing prev/next month controls (index.html:19446-19453) still work.

## Task 3: the weekly revenue number shows its math

The week revenue figure in the calendar's revenue column is PRORATED and the proration is invisible, which is why Dylan cannot reconcile it. `weekRevenue` (index.html:18841) computes, per job, `contract_revenue * (days scheduled in THIS week / total scheduled days for the job)`, using the shared `scheduleTotalDaysByJob()` denominator, and it SKIPS touch-up callbacks (no-charge, never in revenue). So a $40k job spanning 4 days shows $20k in a week that holds 2 of them. The per-bar labels use the same denominator (index.html:18919), so the bars in a week sum to the header figure by construction. That is correct math, but nothing on screen says so.

Build: the week revenue cell becomes CLICKABLE and expands an inline breakdown panel showing, per job in that week:
- customer name
- contract price
- days this week / total scheduled days
- the resulting slice

with a footer that sums to the header figure, and an EXCLUSIONS line naming what was deliberately left out (touch-up callbacks, and anything else `weekRevenue` skips). The point is that the number reconciles VISIBLY. If the footer does not equal the header, that is a bug the panel should make obvious rather than hide.

Rules:
- Label it plainly: "scheduled contract revenue, prorated by day." It is not cash collected and it is not GP.
- Do NOT add GP to this panel. Dylan's explicit decision, and the reason is in your own log: `pec_prod_job_costing` has materials on ZERO of 34 jobs (the 15c and build-17 entries), so any GP shown here would read roughly 30 points high. Do not print a number you know is wrong.
- Reuse `weekRevenue` and `scheduleTotalDaysByJob`. The panel must be a VIEW of the existing computation, not a second implementation of it. If you find yourself recomputing the proration, stop and refactor so both read one function. A breakdown that can disagree with the number it explains is worse than no breakdown.
- It must work on the mobile day-list layout shipped in build 18 (index.html:19080-19086), where the week revenue appears in `.pec-cal-daylist-weekhead`. Not a hover tooltip: hover is dead on a phone.
- Closes on outside click and Escape. Per the Architecture Gotchas in CLAUDE.md, if you touch modal lifecycle at all, remember there are TWO modal roots (`#pecModalRoot` and `#prodModalRoot`) and the production views use the hand-rolled inline flows. This is a popover, so it should not bite, but do not assume.

## Guardrails

- Do not touch the pricing engine, the estimator's calculator, comps, or the nav.
- Item 1 changes what a job IS (it now carries areas from acceptance). Trace every reader of `pec_prod_areas` before you ship it: the calendar band (18827), the job badge (6444-6452), materials/recipes (11197-11213, 12043-12116), the work order (8926, 11229), metrics (10633-10649), the costing panel (22018-22030), the Ordering editor (25059). Several of these will start showing data where they previously showed nothing. That is the POINT, but check that none of them break on a job that now has three areas where they assumed one.
- No em dashes anywhere (standing rule 6).
- What's New entries (standing rule 9) for: the required system on scheduling and Add Job, the picker defaulting to the current month, and the weekly revenue breakdown. The area-copy at acceptance is internal plumbing, but its visible effect (jobs now show their system and color on the calendar automatically) is worth one line.
- Commit per standing rule 1, one commit per item. Update PROJECT-LOG.md per standing rule 2. Run `npm test`; all index.html script blocks must parse; run the em-dash scan on added lines.

## After

Append a PROJECT-LOG.md entry (By: Claude Code) covering: every acceptance door you found and whether you fixed all of them (or a Cowork handoff for one you could not), whether the three dominant-system implementations had drifted and whether you unified them, your decision on areas[0]-vs-dominant for the calendar band and job badge WITH the justification, and confirmation that no backfill was run (Dylan's call).

Then explain to Dylan, in plain English, why the dropdown was blank: it was never a prefill bug. The job never had a system to begin with, because nothing on the acceptance path ever wrote one, and every downstream feature that needed it (calendar color, materials, per-system metrics) had been quietly degrading for exactly the same reason.
