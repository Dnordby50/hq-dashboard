# Build Prompt 18: four contained UI fixes (estimator entry, schedule toolbar, mobile schedules, phone-to-customer matching)

## Context

Repo: /Users/dylannordby/Claude-Code/HQ-Dashboard. Deploy: Netlify, single-file dashboard at index.html. Build 17 (estimate archive, per-area MVB, 2% sundries, pricing logic + override, price per sqft) is pushed to main and live, so start from a clean origin/main. Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first per standing rule 4.

Dylan brought six issues in a Cowork session on 2026-07-13. Five of them are contained; the sixth (a full left-rail nav rework to an icon rail with flyouts) is deliberately split into prompt 19 and must NOT be touched here, because it rewrites the nav clone logic at index.html:4995 that every view depends on and a nav regression would be indistinguishable from the four fixes below. Ship this prompt, deploy, verify, then do 19.

This prompt is four items. Item 4 (phone matching) is the only one with a data component and is the one that matters most: right now an inbound text or call from a number that the Quo/OpenPhone webhook did not stamp with a customer_id renders as a dead, unclickable "Unknown number" row. Real customers are landing in that bucket.

Line numbers below are from the state of index.html at the time of writing. Verify before you edit; do not trust them blindly.

## Tasks

### 1. Remove the standalone Estimator side-tab button

What: delete the Estimator (Beta) nav entry. The estimator should be reached from lead detail > Start estimate, and from the Estimates list "New estimate" button. It should NOT be a rail item.

Where:
- index.html:2372-2378, the `<button id="pecEstimatorNav" style="display:none">Estimator (Beta)</button>` inside the Sales group of `#pecSubnav`.
- index.html:4998-5002, the sidebar clone `querySelectorAll` that explicitly includes `#pecEstimatorNav`.
- index.html:6486-6518, `wireEstimatorNav()` (the `settings.estimator_allowed_emails` allowlist gate), called from index.html:6468.

Do NOT touch: index.html:16805 / 16874 (lead detail Start estimate), index.html:17088 (Estimates list New estimate), index.html:17188 / 17402 (estimate detail Edit). All four stay exactly as they are. Dylan explicitly wants the Estimates-list walk-up button kept.

Judgment call for you to make and log: `wireEstimatorNav()` is the only reader of `settings.estimator_allowed_emails`. Decide whether that setting is now dead (and say so in the log) or whether the remaining entry points should honor it. Recommendation: if the allowlist was gating who can create estimates at all, port the gate onto the Start estimate and New estimate buttons rather than silently dropping it. If it was only ever gating a beta rail item, drop it and note the setting is now unused. Read the setting's usage before deciding.

Acceptance: no Estimator item in the rail for any user. Start estimate from a lead still opens the estimator with the lead attached and still hits the 15c duplicate-estimate guard inside `openEstimatorModal`. New estimate on the Estimates list still opens a walk-up estimate.

### 2. Reorganize the Job Schedule toolbar

What: the header currently reads as a random row of six controls. Regroup it.

Where: `renderSchedule()` at index.html:18182, toolbar markup at index.html:18244-18258, handlers at index.html:18264-18279.

Target layout, left to right:
- Nav cluster: `‹` `Today` `›` then the period label (`#pecSchedPeriod`).
- Immediately after it (not pushed to the far side by the `margin-left:auto` spacer at 18249): the Week / 3 weeks segmented control. Dylan's words: "today should be close to week and 3 week button."
- Far right: a SINGLE `+ Add` button that opens a small dropdown menu containing Add Job, Add Task, Holiday, Day Off. Four buttons collapse into one.

Rules:
- The four existing handlers (`pecSchedHoliday`, `pecSchedDayOff`, `pecSchedAddTask`, `pecSchedAddJob`, wired around 18264-18279) must be REUSED, not rewritten. The menu items call the same functions. Do not fork the modal flows.
- Add Job is the common action; make it the first item in the menu.
- The mode toggle must keep persisting to `localStorage pec_sched_mode` (index.html:18277).
- The dropdown must close on outside click and on Escape.
- Read the Architecture Gotchas section of CLAUDE.md before touching any modal: the production views use `#prodModalRoot` with hand-rolled inline modal flows, NOT the `openModal()` / `closeModal()` helpers. The Add menu is a popover, not a modal, so this should not bite you, but if you find yourself adding modal lifecycle code, apply it to both roots or justify skipping one.

Acceptance: toolbar is two clusters, nav+mode on the left, one + Add on the right. All four add flows still work and still write the same rows they did before. `.pec-sched-toolbar` still wraps gracefully at narrow widths (it is `flex-wrap:wrap` at index.html:23143; the `min-width:200px` on `.pec-sched-period` at 23144 is what forces early wrapping, consider trimming it).

### 3. Mobile layouts for Next Day Schedule and Job Schedule

What: both schedule views are unusable on a phone. Build purpose-built mobile layouts, not a horizontal-scroll escape hatch. Dylan's decision: below the mobile breakpoint these become stacked, scrollable CARD lists, one card per job, not a squeezed grid.

Where the breakage is:
- `renderNextDay()` at index.html:17854. Header at 18004-18012. The crew x slot board at 18013-18017 with hardcoded `grid-template-columns:140px 1fr 1fr 1fr` (index.html:17928, 17932) inside an outer `1fr 240px` (18013) that carries the "No slot yet" panel (18018-18022). No media query touches any of it. This is the worst one: it is the view the crew opens on a phone in the morning, and the "No slot yet" / jobs-to-schedule panel is exactly what Dylan reports getting cut off.
- `renderSchedule()` calendar at index.html:18302. `.pec-cal-month-head` is `repeat(7, minmax(0,1fr)) 150px` (index.html:23146), `.pec-cal-week-row` is `1fr 150px` (23149), `.pec-cal-week-grid` is 7 columns with `min-height:140px` (23154). At phone width each day cell is roughly 40px and `.pec-cal-event-bar` (23169, `white-space:nowrap; overflow:hidden`) truncates the customer name to nothing. The only schedule media query that exists is index.html:23138 (`max-width:900px` stacks `.pec-sched-grid` to one column). The Pending Jobs aside (`#pecSchedPending`, index.html:18220-18242, `max-height:75vh; overflow-y:auto` at 23139) stacks but is not otherwise adapted.

Build:
- A `max-width:720px` breakpoint (match the existing shell breakpoints at index.html:1281-1287 and 1604-1620; do not invent a new one if an existing one fits).
- Next Day Schedule on mobile: crew columns stack vertically. One section per crew, crew name as a sticky section header, each job as a full-width card showing customer, address, slot, note. The "No slot yet" panel becomes a section at the TOP of the list (it is the thing that needs action), not a 240px column that falls off the right edge. The date nav (Prev / date / Next) and Print run sheet stay reachable, wrapping rather than overflowing.
- Job Schedule on mobile: the 7-column calendar becomes a vertical day list (one row per day, date header, the day's job bars stacked full-width, revenue shown inline rather than as a 150px column). The Pending Jobs aside becomes a collapsible section above the list.
- Reuse the existing render data. Do not fork `loadScheduleData` or duplicate the job objects. Ideally the mobile layout is a different rendering of the same in-memory arrays, gated on a `matchMedia` check or pure CSS where possible. CSS-only is preferable to a JS branch: fewer code paths to keep in sync. If you must branch in JS, say why in the log.
- Container queries already exist at index.html:23187-23188 (hiding note/crew below 150px/96px). Do not fight them; make sure the mobile layout does not trip them.

Acceptance: at 390px wide, Next Day Schedule shows every crew, every job, and every unscheduled job with nothing clipped and no horizontal scrollbar. Job Schedule shows every day and every job bar with the customer name readable. Both still work identically at desktop width (the desktop grid is unchanged).

### 4. Phone-number to customer matching on calls and messages

This is the substantive item. Read all of it before starting.

Current state:
- `renderMessages()` at index.html:15083-15148 reads Supabase table `pec_sms_log` (15089-15090), collapses to one row per conversation keyed by `r.customer_id || 'num:' + otherNumber` (index.html:15104), and batch-resolves names from `customers` (15112-15117). A row with no `customer_id` renders as an unclickable "Unknown number" (15121, 15127).
- Calls live in a SEPARATE table, `pec_call_log`, and never appear on the Messages tab at all. They only show on the customer profile Calls card (index.html:14816-14894) and in the job-detail merged feed (index.html:14899-14990), both of which filter by `customer_id`.
- `customer_id` on both tables is stamped by the Quo/OpenPhone webhook (service role; see comments at index.html:14575-14577 and 14816-14821). There is NO phone-to-customer lookup anywhere in the client. `qoFmtPhone()` (index.html:14632-14635) and `qoTelHref()` (14636-14639) are display-only.

Build, in this order:

4a. Normalized phone matching in the database.
- Add a normalized phone representation and match on the LAST 10 DIGITS: strip every non-digit, drop a leading country-code 1, compare the trailing 10. This is the rule; use it everywhere, no exceptions, no fuzzy variants.
- Make it an INDEXED lookup, not a table scan. Preferred shape: a generated column (for example `phone_norm`) on `customers`, plus the same on `leads`, with a btree index on each. A customer with multiple phone numbers, if that exists in the schema, must match on any of them; inspect the schema before you design this.
- Write it as a migration in supabase/migrations/ following the existing naming convention. Apply it to prod from this session (the last several migrations were applied this way; the footer checks confirm) and report the verification queries and their results in the log.

4b. Match on arrival, and match retroactively.
- Fix the webhook path so a new inbound text or call resolves `customer_id` via the normalized rule at write time. Find the function that writes these rows (start from netlify/functions/ and the comments at index.html:14575 and 14816; it may be a Quo/OpenPhone webhook that does not live in this repo, in which case STOP and report that in the log as a handoff rather than guessing).
- Backfill: a one-time statement in the same migration that stamps `customer_id` on every existing unmatched row in `pec_sms_log` and `pec_call_log` where the normalized number matches exactly one customer. Report the counts (rows before, rows matched, rows still unmatched) in the log entry. If a number matches MORE than one customer, leave it unmatched rather than guessing, and report that count separately.
- Match against `customers` FIRST. Then, only if there is no customer match, resolve a display name from `leads` by the same rule. Store the customer link only where a real customer matched; a lead match is a display-name resolution, not a `customer_id` write. Do not invent a `lead_id` column unless the schema already supports it, and if you do add one, say so.

4c. Merge calls into the Messages tab.
- `renderMessages()` becomes a unified activity inbox: `pec_sms_log` and `pec_call_log` merged into one conversation list, newest first, exactly as the job-detail feed at index.html:14899-14990 already does. Reuse that merge logic; do not write a second one. If it needs to be extracted into a shared helper, extract it.
- Each conversation row shows the resolved name (customer, or lead name with a small "Lead" marker, or the formatted number), the last activity (text preview, or "Missed call" / "Call, 4m12s"), and a timestamp.
- Add All / Texts / Calls filter chips at the top. Keep it simple.

4d. No dead ends.
- Every conversation row is CLICKABLE, including a number that matches nothing. Clicking an unmatched number opens a conversation view keyed by the number, showing the full merged text and call history for that number plus the existing reply box (`pecSendSms()` at index.html:14583-14596).
- That conversation header carries an "Attach to customer" action (search and pick an existing customer, which stamps `customer_id` on every row for that number, not just the one clicked) and a "Create lead" action (prefills the phone number into the existing new-lead flow; see the phone strip at index.html:16538).
- Do NOT auto-create leads from unknown inbound numbers. Dylan rejected that: spam and wrong numbers would pollute the pipeline.
- Attaching is a WRITE. Per the Architecture Gotchas in CLAUDE.md, wrap non-idempotent writes in `withDeadline` (no blind retry), not `withFreshWriteRetry`. Attaching by number is arguably idempotent (it sets a column to a fixed value), so if you use the retry path, say why in the log.

Acceptance: a real customer who texts from a number the webhook did not previously match now shows their name in the Messages list. An unknown number is clickable, opens a thread, and can be attached to a customer in two clicks, after which their prior history shows on the customer profile Calls/Messages cards too (because the backfill/attach stamps `customer_id`, which is what those cards filter on). Calls and texts appear in one list.

## Guardrails (all four items)

- Do NOT touch the left rail structure, the nav clone logic at index.html:4995-5059, `switchView` (6841), or the view map (6908-6930), beyond deleting the single Estimator button in item 1. The nav rework is prompt 19.
- Do NOT touch the pricing engine, the estimator app, comps, or anything build 17 shipped.
- No em dashes in any output, code comment, log entry, or What's New text (CLAUDE.md standing rule 6).
- Every user-facing change here gets a What's New entry in help/whats-new.json (standing rule 9): the schedule toolbar, the mobile schedules, and the messages inbox all qualify. The estimator button removal qualifies only if users could see it (it was allowlist-gated, so use judgment). The phone-matching backfill is internal.
- Commit per standing rule 1, one commit per item where they are separable, so a regression can be bisected. Update PROJECT-LOG.md per standing rule 2.
- Run `npm test` before you finish. All 9 index.html script blocks must parse. Run the em-dash scan on added lines.

## After

Append a PROJECT-LOG.md entry (By: Claude Code) at the TOP, covering: the migration and its verification output, the BACKFILL COUNTS (how many sms and call rows were unmatched before, how many the normalized rule matched, how many are still unmatched and why, how many were ambiguous), whether the inbound webhook lives in this repo or needs a Cowork handoff, the judgment call on `estimator_allowed_emails`, and whether the mobile layouts are CSS-only or JS-branched and why.

Then give Dylan a plain-English explanation of why the phone matching was broken (the webhook was the only thing that could ever link a number to a customer, and it only linked the ones it happened to recognize, so anything it missed was permanently orphaned with no way for the UI to recover it), and a smoke-test list.
