# Prompt 58: change orders on the job card, Enhancify financing, Sunday-first calendars, schedule price truth, touch-up count, work order questions

Six items from Dylan, one session, one commit per part. Parts A and B are small and safe. Part C is a rendering fix with a data-model wrinkle. Part D is the one with real blast radius (two job tables disagreeing about price), and its scope was deliberately narrowed by Dylan, so read the guardrail twice. Part E touches the estimator PWA and therefore needs a rebuild of the built output. Part F is new customer-facing surface area and ends in a Cowork handoff for the vendor snippet.

Take them in order. If a later part fights you, stop and log rather than half-landing it: A through C are worth shipping on their own.

Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first. Consult features.json for anchors and SCHEMA.md before writing ANY SQL. Do not read index.html end to end.

Every line number below was verified against `main` on 2026-07-29. If a line has drifted, find the function by name and keep going; do not treat a drifted line number as a blocker.

---

## Decisions already locked (Dylan answered these; do not re-litigate)

1. Change orders show on the JOB DETAIL page and on the PRINTED WORK ORDER. Not the schedule quick look.
2. The scheduler price mismatch is fixed by DERIVING the display, not by rewriting stored data. `pec_prod_jobs.revenue` is never bulk-updated by this prompt.
3. The derived price applies to SCHEDULE surfaces only. Job Costing, bonus, metrics, and Sales/Revenue rollups are frozen: do not touch them.
4. Finalized and completed jobs keep the numbers they already report. Nothing historical is restated.
5. Every calendar GRID goes Sunday-first. Weekly metrics bucketing does not change.
6. The touch-up header counts everything not done (open + waiting + scheduled).
7. Work order questions appear in Custom estimate mode too.
8. Unanswered work order questions WARN, they never block a save, a send, or an accept.
9. Only Moisture and MOHS hardness count as required for that warning.
10. The warning surfaces on the estimator and on the job detail page. Not the Ops Queue, not the printed work order.
11. Enhancify is an embeddable widget, shown on the public estimate page, the estimate PDF, the public invoice page, and the customer portal.
12. The financing block shows an estimated monthly payment when the rate and term settings are filled in, and degrades to a plain call to action when they are not.
13. Crew notes on custom estimates was RAISED AND WITHDRAWN by Dylan. Do not build it. (For the record: `EstimatorScreen.tsx` already renders the Crew notes card in both modes and the deployed build contains it.)

---

## PART A: the touch-up header counts everything still owed

**Problem.** `renderTouchupPanel` builds `byState = { open: [], scheduled: [], done: [] }` at index.html:26264 and folds `waiting_customer` into `open` at index.html:26267. The panel summary at index.html:26331 reads `${byState.open.length} open`. A touch-up that has been scheduled but not completed moves to the `scheduled` bucket, so the header says "0 open" while a customer is still owed work. Dylan read that as a bug; it is the label being narrower than the number anyone wants.

**Do this.**
- Change the summary count to `byState.open.length + byState.scheduled.length` and label it so the word matches the math. "3 open" where open now means not done is fine; "3 outstanding" is better. Pick one and use the same word in the What's New entry.
- The section headings inside the panel (`secHead('Open', ...)` at index.html:26340 and `secHead('Scheduled', ...)` at index.html:26342) stay exactly as they are. The split is useful; only the collapsed summary changes.
- The Done section, the `showDoneDays` window, the sort order, and `touchupSuggestedScore` are untouched.

**Guardrail.** Do not change `touchup_state` values, the Ops Queue check at index.html:18698 (which deliberately counts only `state === 'open'` with no schedule date), or the aging thresholds in Settings. Those measure a different thing on purpose.

**Acceptance.** With one touch-up open and one scheduled, the collapsed panel header reads 2, not 0. Expanding it still shows Open 1 and Scheduled 1.

**Commit:** `schedule: touch-up header counts scheduled work as still outstanding`

---

## PART B: Sunday-first calendars

**Problem.** `startOfWeek` at index.html:21119 is explicitly Monday-start (`const day = (d.getDay() + 6) % 7;`) and three grid headers hardcode `['Mon','Tue','Wed','Thu','Fri','Sat','Sun']` (index.html:27199, 27799, 28500). Dylan wants the American convention.

**Do this.**
- Flip `startOfWeek` to Sunday (`const day = d.getDay();`) and update its comment.
- Flip the three day-header arrays to `['Sun','Mon','Tue','Wed','Thu','Fri','Sat']`.
- Every caller of `startOfWeek` follows automatically: the Next Day two-week window (index.html:26234), the schedule visible range (index.html:26242), the week and 3-week grids (index.html:27151, 27168), both multi-day date pickers (index.html:27757, 28482), and the task modal's range math (index.html:29092). Verify each renders correctly rather than assuming.
- The Appointments view uses FullCalendar from CDN, which is already Sunday-first by default. Confirm it and leave it alone. If the month-list offline fallback below `renderAppointments` (index.html:21817) builds its own week strip, flip that too.

**Consequence Dylan should see, and you should call out in the log.** The schedule's per-week revenue rows (`pec-cal-week-rev`, index.html:27168 onward) group by the same week boundary, so those numbers re-bucket: a Sunday install that used to land in the prior week now lands in the following one. That is inherent to the change and is acceptable. Note the shift in the PROJECT-LOG entry so nobody reports it as a regression next week.

**Guardrail.** The Metrics view's weekly charts and the rolling 4/12-week windows do NOT call `startOfWeek` (verified: the only callers are the eight schedule and picker sites listed above). Confirm this with a grep before you commit, and if a metrics caller has appeared since, leave metrics on its existing boundary and log it. The crew availability `DAYS` array at index.html:16950 is a keyed config list, not a calendar grid: leave the keys alone; reorder its display only if it visibly renders as a week strip.

**Acceptance.** Job Schedule week view, 3-week view, both date pickers, and the Next Day window all start on Sunday. Dragging a job to a Saturday still lands on Saturday. Metrics weekly bars are unchanged from before the commit.

**Commit:** `schedule: calendars start the week on Sunday`

---

## PART C: change orders show on the job detail page and the work order

**Problem, and read this before you write code.** Change orders are stored two ways, deliberately (see the comment at index.html:14730): as a `jobs.line_items` entry with `is_change_order: true`, and in scope/coat mode also as a `job_areas` row with `is_change_order = true`. Job detail EXCLUDES change-order areas from the Line Items table (index.html:13844 filters them out) because their billing representation is the line item. `saveJob` preserves change-order lines and adds them to `jobs.price` (index.html:15239 through 15246). The work order's page-2 line items table already tags them `(change order)` (index.html:13493).

So some of this may already work. Follow the Bug Diagnosis Workflow in CLAUDE.md: before building anything, open a real job that has a change order and establish exactly what renders where. Report the finding first, then fix the gap. Do not build a second Change Orders card next to one that already exists.

**Likely gaps to check, in order.**
1. Job detail: is there a visible Change Orders block, or do change orders only appear folded into the Totals card (`coSum`, index.html:14736)? If a customer-visible dollar amount appears in the total with no itemized explanation on the page, that is the bug.
2. Work order page 1: the intake and materials sections build from `areas` and the material plan. A scope-mode change order adds a `job_areas` row and pushes materials via `pushChangeOrderMaterialsToProd` (index.html:10002), but a SIMPLE-mode change order (index.html:9869) creates a line item with no area at all. Confirm whether the crew sees added scope on the page they actually read, or only on the appendix page.
3. Whether the work order's line items page renders at all when a job's `line_items` is empty except for change orders.

**Do this once you know the gap.**
- Job detail gets an itemized Change Orders block: name, description, amount, signature status from `pec_change_order_signatures` (`mountChangeOrderCard`, index.html:10062, already loads these; reuse it rather than re-querying), and a total that ties to `coSum`.
- The printed work order gets a CHANGE ORDERS section on PAGE 1, near the scope, not buried on the appendix page. Same visual language as the existing CREW NOTES section (index.html:13621). Show name, detail, and sqft where a scope-mode CO carries one. Price on the crew sheet is Dylan's call: the sheet already prints a line-items total, so include it for consistency unless you find a reason not to, and say which you chose in the log.
- If a job has no change orders, neither surface renders anything. No empty headers.

**Guardrail.** Do not change how change orders are stored, do not start writing change-order areas into the Line Items table, and do not touch `jobs.price` derivation in `saveJob`. This part is rendering only.

**Acceptance.** A job with one simple-mode CO and one scope-mode CO shows both, itemized with amounts, on the job detail page and on page 1 of the printed work order. The job's total is unchanged. A job with no COs prints exactly as it does today (diff the generated HTML if that is faster than eyeballing it).

**Commit:** `jobs: change orders itemized on the job detail page and the printed work order`

---

## PART D: the schedule shows the job's real price

**Problem.** Two tables, two numbers. `jobs.price` is derived from the estimate lines plus change orders on every save (index.html:15246). `pec_prod_jobs.revenue` is written once by the proposal-accepted webhook from the DripJobs deal and then only changed by hand in the schedule modal (`schedRevenue`, inside `openScheduleModal` at index.html:27660). Nothing syncs them. So an estimate edited after booking, or any change order, leaves the calendar quoting the original DripJobs number forever.

**Dylan's decision, exactly.** Derive the display on schedule surfaces. Leave `pec_prod_jobs.revenue` alone in the database. Costing stays frozen.

**Important and it saves you work:** Job Costing already reads `revenue: j.price` from the CRM job (index.html:12078), so costing is ALREADY on the correct number. "Costing frozen" here means do not touch it, not "make it match". Verify that line before you start; if costing turns out to read `pec_prod_jobs.revenue` somewhere you find, STOP and log it rather than changing it, because that is the path that moves GP and the bonus pool.

**Do this.**
- Add one resolver, next to `prodJobEstimateFacts` (prompt 55, the existing bridge from a prod job to its CRM job): given a `pec_prod_jobs` row, return the CRM `jobs.price` when the prod job resolves to a CRM job, else the stored `revenue`. Return the source alongside the number (`'crm'` vs `'stored'`) the same way `jobEffectiveSqft` returns `sqftSource`, and use that to drive the tooltip below.
- Use it on: the schedule modal's Revenue field, calendar bar tooltips, the per-week revenue rows, Next Day cards, and both printed run sheets. One number, one helper, no local reduces.
- In the schedule modal, when the number is CRM-derived, show it read-only with a one-line note that it comes from the estimate and changes when the estimate does, plus a link or path to the job. A freely editable copy of a derived number is exactly the drift being killed here (same reasoning as the prompt-55 salesperson lock, index.html:27678). Manual jobs (`dripjobs_deal_id IS NULL`, no CRM job) keep the editable field, because for them the stored value IS the truth.
- Where a derived number differs from the stored one, surface the delta on hover or as a small note. Nothing about this should be silent.

**Guardrails, all of them load-bearing.**
- The `pec_prod_jobs_scheduled_needs_revenue` constraint (see the handling at index.html:6608) still requires a stored revenue > 0 to mark a job scheduled. Keep writing `revenue` on the paths that already write it. Do not remove that write to "clean up", or scheduling starts failing on jobs that look fine on screen.
- No migration. No backfill. No bulk UPDATE. If you find yourself writing `update pec_prod_jobs set revenue`, you have left the scope of this prompt.
- Costing, bonus, metrics, the Sales/Revenue scorecard, and the Ops Queue missing-revenue check (index.html:18661) are untouched.
- Finalized jobs display exactly what they display today.

**Before you commit, count the blast radius and put the numbers in the log** (memory of prompt 56: a derived-beats-stored rule silently moved GP on 34 finalized jobs by $4,785). Run a read-only query that counts how many `pec_prod_jobs` rows would DISPLAY a different revenue after this change, and the total dollar delta, split by finalized and not. If that count is large or the delta is a surprise, stop and report before shipping rather than after.

**Acceptance.** Add a $500 change order to a scheduled job. The job detail total, the schedule modal, the calendar tooltip, that week's revenue row, and the run sheet all move by $500 within one reload. `select revenue from pec_prod_jobs` for that job is unchanged. Job Costing GP for the job is unchanged from before the commit. A manual "+ Add Job" row still has an editable Revenue field and still saves.

**Commit:** `schedule: job price on the schedule derives from the estimate, not the original DripJobs number`

---

## PART E: work order questions in Custom mode, and a soft warning when they are unanswered

**Problem.** `apps/estimator/src/features/estimator/EstimatorScreen.tsx:2043` wraps the whole "More detail" block in `{!isCustom && ...}`, and that block contains the Work order grid (gate code, moisture, MOHS, grinder tooling, additional non-slip, coat past garage, stem walls, special notes) at lines 2069 through 2086. A custom estimate therefore never asks any of them, and the intake values still save as null at line 993. Separately, a blank answer and a deliberate "not applicable" are indistinguishable everywhere.

**Do this.**
- Move the Work order grid out of the `!isCustom` guard so it renders in both modes. If pulling it out of the `<details>` wrapper is awkward, render the same grid in a second `<details>` for custom mode rather than duplicating the field JSX; one source of the field list.
- Add a soft warning when Moisture or MOHS hardness is empty: visible on the estimator (a hint near the block and a persistent line near the save area, in the same style as the existing `belowFloor` / `mvbMissing` warnings), and on the job detail Job Card block (index.html:14001) after the job exists. Wording is Dylan-facing and internal, so em dashes are technically allowed, but match house style and skip them anyway.
- It never blocks. Save, send, accept, and the printed work order all behave exactly as they do now. This is a nag, not a gate.
- Only Moisture and MOHS count. Gate code, tooling, non-slip, coat past garage, stem walls, and special notes are never warned about.

**Guardrail.** Do not add required-field validation to `performSave`. Do not change the intake payload shape at EstimatorScreen.tsx:993 or the columns it writes. Do not change the printed work order (Part C already touches it; keep the diffs separate).

**Rebuild the PWA.** `estimator/` at the repo root is the BUILT output of `apps/estimator` and is served statically. The current build is from 2026-07-26. Build it and commit the output in the same commit as the source change, or this ships as a no-op. Never hand-edit the build output.

**Acceptance.** Estimator in Custom mode shows the Work order questions and they persist to the estimate. A standard estimate with Moisture blank shows the warning, still saves, and still sends. The job page shows the same warning until the field is filled. `estimator/assets/*.js` has a new hash in the commit.

**Commit:** `estimator: work order questions in custom mode, plus a soft warning for missing moisture and MOHS`

---

## PART F: Enhancify financing, front and center

**Problem.** There is no financing anywhere in the codebase (grep for "enhancify" and "financing" returns nothing). Dylan wants it prominent on customer-facing money surfaces.

**What Dylan has.** An embeddable widget from Enhancify. The exact snippet is NOT in this session. Build against settings-backed placeholders and hand the snippet collection to Cowork (see below). Standing rule 7: no credential goes in code.

**Settings first (standing rule 12).** Add a Financing block under Settings > General, backed by the `settings` table, with:
- `financing_enabled` (off by default, so nothing appears until Dylan turns it on)
- `financing_provider_name` (default "Enhancify")
- `financing_embed_url` or `financing_script_src`, whichever shape the real snippet turns out to be. Support ONE of them and note which in the log; do not build a generic HTML-injection field that accepts arbitrary markup from a settings row.
- `financing_apply_url` (the plain link fallback)
- `financing_apr_pct` and `financing_term_months` (blank by default)
- `financing_min_amount` (below this total, no block renders)

**The block itself.**
- When `financing_apr_pct` and `financing_term_months` are both set, show an estimated monthly payment computed from the estimate or invoice total with the standard amortization formula, plus the apply action. When either is blank, show the plain call to action with no dollar figure. Same component, two states.
- Any payment figure is labeled as an estimate and carries "subject to credit approval". A published monthly payment is a claim PEC owns; make it unmistakably an estimate, and do not imply approval.
- No em dashes anywhere in it (standing rule 6, this is customer-facing).

**Surfaces, in this order.**
1. `netlify/functions/pec-public-estimate.cjs` — the highest-value placement. `estimatePage` builds the page at line 281; the hero total is at line 434 and the totals table at line 455. Put the block between the total and the accept panel (line 315), which is where a customer hesitating on price is looking. These functions read config from `pec_brand_identity` via `sb()` (line 610); read the financing settings the same way, from `settings`, and cache them in the same request.
2. The estimate PDF, built client-side by the print-to-PDF path near index.html:9508 (`pecPrintBrand`). Static markup only, no script: a PDF cannot run a widget, so the PDF gets the monthly estimate plus the apply URL as text.
3. `netlify/functions/pec-public-invoice.cjs` — same block, keyed on balance due rather than total.
4. The customer portal. The log notes the portal is not in use yet, so this is build-ahead. If there is no portal surface that shows a price, log that and skip it rather than inventing one.

**Guardrails.** If a widget script fails to load, the block degrades to the plain link; it never blocks the page or the accept flow. Nothing about financing touches pricing, totals, GP, or what gets written on accept. Check `netlify.toml` for a CSP or script-src that would block a third-party embed, and if you have to relax one, say exactly what you relaxed and why in the log.

**Acceptance.** With `financing_enabled` off, all four surfaces render byte-identical to today. With it on and rate/term set, a public estimate shows "from $X/mo" with the apply action above the accept panel and the accept flow still works. With rate/term blank, the same block shows the call to action and no number. Below `financing_min_amount`, nothing renders.

**Commit:** `estimates: Enhancify financing block on the public estimate, invoice, PDF, and portal`

---

## Housekeeping (every part)

- `npm test` green before every commit. Node-check any index.html script block you touch.
- Standing rule 11: What's New entries in `help/whats-new.json` for A, B, C, D, E, and F. All six are user-visible. Plain language, no em dashes, 2 to 3 how-to steps each.
- Update `features.json` for every feature whose code or tables moved: the touch-up panel, the schedule calendar, change orders, the work order, custom estimate mode, and a new entry for financing.
- One PROJECT-LOG.md entry at the TOP when you are done, written for a human. It must include: the Part D blast-radius counts, the Part B week re-bucketing note, what you actually found in the Part C diagnosis, and which settings-field shape you chose in Part F.
- No migrations are expected in this prompt. If you conclude one is needed, write it with an `@artifacts` header per standing rule 13, do NOT apply it, and hand it to Cowork.

---

## Handoff to Cowork (print this in chat as a standalone prompt when Part F lands)

Cowork needs to collect, from Dylan or the Enhancify partner dashboard:
1. The exact embed snippet (script tag or iframe URL) and whether it needs a partner or dealer ID.
2. The APR and term PEC wants quoted, or confirmation to leave them blank so no monthly figure is published.
3. The minimum job total worth showing financing on.
4. Whether financing shows for FTP jobs too or PEC only. If it is PEC only, that is a per-brand setting and needs a follow-up prompt; the settings block built here is company-wide.

Then set the values in Settings > General > Financing on the live deploy, turn `financing_enabled` on, and verify one real public estimate link end to end.

## Still open from earlier prompts (do not let these get lost)

- The prompt-56 STOP on legacy labor precedence is still awaiting Dylan's ruling.
- `supabase/migrations/2026-07-30_flake_deactivate_collapsed_blends.sql` is written and NOT applied, blocked on moving `get_portal_job_catalog` and the CRM job-card swatch grid onto `public.colors`.
- Six provisional flake hex values and the two People merge suggestions (Kyle Floyd, Landen Johnson) are waiting on Dylan.
