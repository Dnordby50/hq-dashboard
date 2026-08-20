# Claude Code prompt 66: crew-lead attribution, callback rate, comps GP%, Metrics category tabs

Scoped by Cowork 2026-08-03 after 12 multiple-choice questions with Dylan. Every number in the Evidence section was measured against the LIVE database (zdfpzmmrgotynrwkeakd) on 2026-08-03 with read-only SQL. Re-measure anything you intend to rely on; do not trust these figures blindly if the date has moved.

Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first, per standing rule 4.

This is the first of two prompts from one batch. Prompt 67 (appointment calendar restyle + BusyBusy project automation) is NOT scoped yet and is explicitly out of scope here.

---

## Evidence: what is actually broken

Three of Dylan's four items share one root cause, and it is a dead column, not a formula bug.

**1. `pec_prod_jobs.crew_lead` is NULL on all 93 rows.** Nothing writes it. `index.html:8236` and `index.html:29320` both insert `crew_lead: null` on job creation, and no save path ever fills it. Crew identity actually lives in `pec_prod_jobs.crew_id` (56 of 93 rows populated, FK to `pec_prod_crews`), and the crews are named after their leads: Davey, Dylan, Kyle, Landen.

Consequences, all three of Dylan's "returning 0" cards:
- `index.html:12971` (Revenue collected by crew lead) buckets every payment under `'Unassigned'`.
- `index.html:12997` (GP by crew lead) buckets every completed job under `'Unassigned'`.
- `index.html:13075` (Callback rate by crew lead) buckets every job under `'Unassigned'`.

Coverage after the fix, measured: 47 completed production jobs, 35 attributable via `crew_id`, 12 with no crew anywhere (not on the job row, not on any `pec_prod_job_schedule_days` row). Those 12 legitimately stay `Unassigned`.

**2. The callback quality flag has never been set on a single row, ever.** `pec_prod_jobs.callback = true` count: 0. It is a manual checkbox written only at `index.html:15390`. `is_callback` (touch-up visit rows, a DIFFERENT column, see SCHEMA.md) is also 0 today because touch-up intake shipped 2026-07-27 and nothing has been logged yet. So `callbackPct` at `index.html:13081` is structurally zero and will stay zero until touch-ups get used.

**3. Comps GP% is computed by a second, wrong formula reading columns that are always zero.** `production/comps.js` `actualGpPct()` sums `materials_ordered_cost` + `materials_used_cost` off the `pec_prod_job_costing` row. Live counts: **0 of 40 costing rows have a non-zero value in either column.** Real materials live in `pec_prod_material_lines` (154 rows; 136 with `actual_used_qty > 0 AND unit_cost_snapshot > 0`, covering 45 jobs), which is exactly where `computeCostingRow` reads them (`index.html:33073`, called from Metrics at `index.html:12996`).

So today comps GP% = `(price - wages - commission) / price`, and `costingComplete()` returns false for 100% of rows.

Measured impact on the last 365 days of completed jobs (50 jobs bridging to a production row with a price):
- Today: 29 jobs carry a GP%, averaging **79.7%**.
- With used materials and job bonuses folded in: 38 jobs carry a GP%, averaging **59.1%**.

Reps have been pricing against a number roughly 20 points too generous, on fewer rows than the data supports. That is the bug behind Dylan's "GP% on past jobs returning no data" (the column reads as dashes where costing has no wages, and lies where it does).

**4. Same dead column has silently killed review bonuses.** `index.html:24833` snapshots `prod.crew_lead` into `pec_review_requests.crew_lead` at ask time. Live: 2 asks, **0 with a crew lead**. Every future confirm would hit the `no_crew_lead` branch at `index.html:16834` and create no bonus. See Part E; this one needs Dylan's word before you touch it.

---

## Locked decisions (Dylan chose these; do not re-litigate)

1. Derive crew lead from `crew_id -> pec_prod_crews.name`. No migration, no backfill of `crew_lead`, no new lead-member column.
2. Callback rate counts **touch-ups OR the legacy flag**, attributed to the **ORIGINAL job's crew**.
3. Comps GP% uses the canonical `computeCostingRow` math, not a second formula.
4. A comp with no cost signal shows a dash, and the panel states how many comps carry a GP%.
5. The broken surface Dylan cares about is the **estimator PWA while pricing**. The estimate detail page's saved snapshot is secondary (fix follows for free; old snapshots keep their old numbers, which is correct, they are historical records).
6. Metrics gets **tabs: All / Sales / Production / Admin**, remembering the last pick like the window preset does.
7. Category mapping, confirmed by Dylan verbatim:
   - **Sales**: Sales volume, Average job size, Sales by salesperson, Jobs sold per week, Price per sq ft, Speed to lead, Conversion by source and campaign, Outbound touches, Open pipeline and AI read, Sales coaching (SalesAsk).
   - **Production**: Jobs completed, Revenue collected by crew lead, GP by crew lead, Callback rate by crew lead, Jobs completed per week, Revenue completed per week, Reviews (funnel + star breakdown + crew scoreboard), Reviews per week.
   - **Admin**: Revenue collected, AR per week, Invoiced before completion, Deposits collected per week, Drip performance, Blast performance.
   - The four `pec-grid-stats` tiles inside "More metrics" (sign-to-deposit, completion-to-paid, paid-on-day, AR aged 30+) go to **Admin**. Average review rating and Reviews (window) go to **Production**.
8. Verification bar: browser-verify on the live deploy plus database re-queries. Details at the bottom.

---

## Part A: crew lead attribution (index.html, renderMetrics)

Add `pec_prod_crews` to the `Promise.all` at `index.html:12581`-ish:

```js
supabase.from('pec_prod_crews').select('id,name'),
```

Destructure it into the result array (mind the positional array at `index.html:12631`; the catch-block fallback array at `12629` must gain a matching `{}` or every read shifts by one, which would be a silent catastrophe). Build `crewNameById`, then a single helper used everywhere:

```js
// pec_prod_jobs.crew_lead is a dead column (0 of 93 rows populated; nothing
// has written it since the prompt-54 people model). Crew identity lives on
// crew_id, and a PEC crew is named for its lead, so the crew name IS the
// crew lead for attribution purposes. One helper, so the three cards can
// never disagree about who owns a job.
const crewLeadOf = (prod) => (prod && crewNameById[prod.crew_id]) || 'Unassigned';
```

Replace every read of `prod.crew_lead` / `dealToProd[deal]?.crew_lead` inside `renderMetrics` with `crewLeadOf(...)`:
- `index.html:12757` (the callbacks drill row's crew column)
- `index.html:12971` (revenue by crew)
- `index.html:12997` (GP by crew)
- `index.html:13075` (callback rate by crew)
- `index.html:13226` (`cbRowIds` filter, must use the same helper or the drill will not match its row)

**Do NOT touch these `crew_lead` reads.** They are frozen snapshots, and re-deriving them would rewrite attribution history:
- `index.html:12947-12948` (`crewReviewRows`, reads `reviews.crew_lead`)
- `index.html:16919-16937` (review confirm path)
- `index.html:24833-24854` (review ask snapshot; see Part E, which is a separate, gated change)
- `pec_prod_job_schedule_days` / calendar task `crew_lead` usage (`index.html:29079` onward). That is a different column on a different table, it IS populated, and it means the crew name on a scheduled day. Leave it alone.

While you are here: the deal bridge (`dealToProd`, `index.html:12657`) drops any production job with a NULL `dripjobs_deal_id`. Live: 20 of 93 production rows have no deal id, and the trend is worsening (August: 1 of 1 with no deal id, because TopCoat-native accepted estimates do not mint a DripJobs deal). **Do not fix this in prompt 66.** Measure it, and report in your log entry how many completed jobs in the last 365 days are invisible to the by-crew cards because of it. It is its own prompt.

---

## Part B: callback rate (index.html ~13068-13086)

Redefine the numerator as: a production job that is `is_callback = true` (a touch-up) OR `callback = true` (the legacy flag), with the callback attributed to the **original job's crew**, resolved through `pec_prod_jobs.original_job_id`. A touch-up whose `original_job_id` is null falls back to its own crew, and the drill must say so on that row rather than silently mixing the two.

Denominator stays completed production jobs per crew, counted with `crewLeadOf`.

Both sides must exclude touch-up rows from the DENOMINATOR (a touch-up is not a completed job), which the existing `prodJobs` filter at `index.html:12664` partly does; re-read it, since it only excludes NON-billable callbacks and a billable one would now double-count as both a callback and a completed job. State in a comment which side each row lands on.

Update the card caption at `index.html:13577` so it says what it counts in plain language ("touch-ups and flagged callbacks, charged to the crew that installed the job"). No em dashes.

Honest expectation to write into the log: this card will still read 0 for everyone until touch-ups get logged. That is correct behavior, not a failure. Do not manufacture data to make it look alive.

---

## Part C: comps GP% (production/comps.js + apps/estimator + index.html)

The governing constraint: **one GP formula for the whole product.** Dylan explicitly rejected "add material lines to the comps formula" because that keeps a second formula alive.

`computeCostingRow` currently lives ONLY at `index.html:33073` and index.html cannot import from `production/` (no bundler; the file loads over `file://` in some paths and the repo's existing convention is a hand-mirrored copy, see the `production/calculator.js` mirrors at `index.html:36852` onward).

So:

1. Extract the GP math into a new canonical module `production/costing.js` (ESM, same shape as `calculator.js`): a pure function taking `{ revenue }`, the costing row, and the derived aggregates (ordered materials, used materials, bonuses, loaded labor), returning at minimum `{ buckets, totalVar, gp, gpPct }`. Pure, no Supabase, no DOM.
2. Add `production/costing.test.js` with fixtures covering: no costing row at all, wages only, materials only, materials + labor, a zero-revenue job, and a negative GP. Wire it into the `npm test` script in `package.json`.
3. Replace `index.html:33073`'s body with a mirror of that module, carrying the same "keep byte-identical with production/costing.js" comment the calculator mirrors use. Behavior must not change by one cent: the Job Costing tab and Metrics both call it.
4. `apps/estimator/src/lib/comps.ts` imports the real module (it already imports `production/comps.js` this way) and its `loadCompCandidates` gains the reads the formula needs: `pec_prod_material_lines` (154 rows), `pec_prod_job_bonuses` (44), `pec_prod_busybusy_time_entries` (144), `pec_prod_job_manual_labor` (105), `pec_prod_crew_members` (7). RLS on all five is `is_admin_staff()` with no permission gate, verified live, so every logged-in rep can read them. Payload is trivial at current volume; add a comment saying to bound these reads by date if the tables ever grow.
5. `production/comps.js` `actualGpPct()` and `costingComplete()` get rewritten in terms of the canonical formula. `gp_complete` should mean "this job has a real cost signal" (used materials or loaded labor present), not the current materials-column check that is false for every row in the database.
6. Per decision 4: a comp with no cost signal renders a dash, and the caveat line under the table becomes a count of how many comps carry a GP% ("GP% shown for 4 of 7 comps"). Keep it one sentence, no em dashes.

The estimator is an offline-first PWA. Comps must still render with NO model call and must degrade to the same panel with dashes if any of the five reads fails, exactly as `loadCompCandidates` degrades today. Do not let a costing read failure blank the comps table.

The estimate detail page (`index.html:27921`) reads a SAVED snapshot. Old snapshots keep their old numbers on purpose (they record what the rep saw). New saves carry the corrected numbers because the estimator writes the snapshot at `EstimatorScreen.tsx:1502-1519`. Update the caveat string there (`gp_caveat`) to match the new wording, and update the hardcoded caveat rebuild at `index.html:27930-27933` to match. Do not backfill old snapshots.

Expected magnitude, so you can tell a fix from a regression: average comps GP% should fall from roughly 80% to roughly 59%, and the number of comps carrying a GP% should RISE (29 to 38 across the last 365 days). If GP% goes up, or coverage goes down, something is wrong.

---

## Part D: Metrics category tabs (index.html, renderMetrics)

Add `All / Sales / Production / Admin` buttons next to the time-window presets at `index.html:13536-13539`, styled the same way, backed by `state.metricsCategory` (default `'all'`, add it beside `metricsWindow` at `index.html:6798`).

**This is a DISPLAY filter, not a data filter.** Clicking a tab must NOT call `renderMetrics()`, because that re-runs 25 Supabase queries. Tag each card and group header with `data-metcat="sales|production|admin"` and toggle visibility with a class on the root. All the math above the template is untouched.

Consequences to handle deliberately:
- The AI insights panel keeps reading the WHOLE window regardless of the visible tab. Its payload build (`index.html:13500-13519`) must not change. Say so in a comment, so a later session does not "fix" it into reading only the visible category.
- Chart.js canvases mount after the HTML is written (`index.html` chart-wrap ids). A canvas that is `display:none` at mount time measures zero. Either mount all charts before applying the filter class, or call `resize()` on reveal. Whichever you choose, the browser verification below must prove a chart in a NON-default tab renders at full width after switching to it.
- The "More metrics" `<details>` block at `index.html:13756` holds cards from two categories. Split its contents by category rather than assigning the whole block to one.
- CLAUDE.md rule 12 (every major feature ships a settings surface) was considered and judged not applicable: this is a view toggle with no timing, limit, or threshold to tune. Do not add a settings key. Record that reasoning in the log entry.

---

## Part E: review-ask crew snapshot (STOP and ask Dylan)

`index.html:24833` writes `crew_lead: prod.crew_lead` into `pec_review_requests`, which is always null now, so `createReviewBonusForConfirmed` will always take the `no_crew_lead` branch (`index.html:16834`) and no crew member will ever earn a review bonus.

The fix is the same one-line derivation as Part A, applied AT SNAPSHOT TIME going forward only. Existing snapshots must never be re-derived (SCHEMA.md is explicit: schedule edits must not rewrite attribution history).

Live state: 2 review asks exist, both with a null crew lead, and 0 reviews and 0 bonuses have ever been created, so there is no history to protect yet.

**Report this to Dylan and get a yes before you ship it.** Present two things: the going-forward fix (recommended), and separately whether to fill in the crew on those 2 existing asks with a gated one-line UPDATE. Do not run the UPDATE without an explicit yes.

---

## Guardrails

- Do not touch the appointment calendar or anything BusyBusy. That is prompt 67.
- Do not add a `crew_lead` backfill, a migration, or a new column. Decision 1 is derive-at-read-time.
- Do not change `computeCostingRow`'s numeric behavior while extracting it. The extraction is a refactor; Part C's only behavior change is on the COMPS side.
- Do not touch the estimator's pricing engine, `calc_price`, `materials_cost`, or anything that moves an estimate's price. Comps are advisory.
- Remember the prompt-56 lesson (in memory and in the log): a change that silently rewrites derived money on finalized jobs is the worst failure mode this codebase has. Before shipping Part C, COUNT how many finalized costings and how many Metrics GP figures move, and report the count.
- No em dashes in any customer-facing string. The comps caveat renders on the public estimate page's lineage, so treat it as customer-facing.

## Verification bar (Dylan chose the browser bar)

1. `npm test` green before the first commit and after the last code change. Report the check count and the exit code.
2. On the live deploy, signed in: load Metrics and screenshot the three by-crew cards showing REAL crew names and dollar amounts. Name the crews that appear and the count of jobs under `Unassigned`.
3. Cross-check one crew's GP figure against a direct SQL computation of the same jobs. They must match to the cent. Paste both numbers in the log.
4. Click through All / Sales / Production / Admin. Prove every one of the 21 cards appears under exactly one category and that no card is orphaned (count them). Prove a chart in a non-default tab renders full width after switching.
5. In the estimator (real deploy, real estimate, standard mode with a system and sqft), screenshot the comps table showing populated GP% values and the new coverage sentence. Report the before and after GP% for the same estimate.
6. Reconcile: pick one completed job and prove its GP on the Metrics card, its GP on the Job Costing tab, and its GP% as a comp all derive from the same numbers.
7. Delete any test rows you create and re-query to prove zero residue.

## After

- Append a PROJECT-LOG.md entry at the TOP, `By: Claude Code`, using the template at the bottom of that file. Include: the crew coverage counts, the before/after comps GP% averages, how many completed jobs are invisible to the by-crew cards because of the NULL `dripjobs_deal_id` bridge, the count of finalized costings whose displayed GP moved (should be zero), and Part E's answer from Dylan.
- Update `features.json` for the Metrics and comps entries.
- Add What's New entries for the category tabs and the corrected GP% (rule 11, plain language, no em dashes). The crew-lead fix is user-visible too: say the by-crew cards now show real crews.
- Regenerate SCHEMA.md only if you applied a migration. You should not need one.
- Commit per standing rule 1, staging named files only.
