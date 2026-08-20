# Prompt 56: Job Costing labor cost + one-click bonus approval

Written by Cowork, 2026-07-28, from Dylan's report on the Bobette Weiss job (#2989725) plus a live read of the prod DB (zdfpzmmrgotynrwkeakd). Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first, per standing rule 4.

Dylan's words, verbatim:

> "The automated bonus is the main source of truth that I want for the job costing card. There's another section further down that allows a manual bonus. I don't want that. I just want the ability to approve on my end the suggested bonus amount, the one that pulls off of this table. Also, with the hours that are pulled from BusyBusy, they are not hitting the job costing percentages at the top of the job costing card. The gross profit numbers are off for the Bobette Weiss job. And further down on the job costing summary towards the bottom, it's not pulling any labor cost."

---

## ROOT CAUSE (already diagnosed, do not re-investigate)

**All three of Dylan's symptoms are ONE bug.** BusyBusy loaded labor is computed only inside `computeCrewBonus` for the Bonus Payout box and is never handed to `computeCostingRow`. Nothing else is wrong.

Evidence, with file:line:

1. **`computeCostingRow` (index.html:29214)** builds `buckets.salary_wages_cost` from `Number(c.salary_wages_cost || 0)` at **index.html:29247**, a hand-typed field on `pec_prod_job_costing`. It has no BusyBusy input. `totalVar` at **index.html:29254** therefore omits labor entirely, and `gp = revenue - totalVar` at **:29255** is overstated by the full labor cost. That is the "gross profit numbers are off" symptom AND the "not pulling any labor cost" symptom (the `Salary & Wages` field in the Costs card is a plain `moneyInput` at **index.html:30687**, reading the same empty column).

2. **`computeCostingRow` reads hours from `job.actual_hours ?? c.actual_hours ?? 0`** at **index.html:29234**. Live: **4 of 88 `pec_prod_jobs` rows have `actual_hours` set, and none of the 10 BusyBusy-covered jobs does.** So `r.actHrs` is 0 fleet-wide, which blanks the Hrs column in the Rollups table (**index.html:29602**, `aggregateCostingRows`) and kills `gpHr` / `revHr` everywhere except the detail card, which patches around it locally with `actHrsEff` (**index.html:30288**). That is the "hours are not hitting the percentages at the top" symptom.

3. **`loadCostingData` (index.html:29034) never queries `pec_prod_busybusy_time_entries` at all.** The seven parallel reads at :29035-:29060 cover costing, crew members, material lines, bonuses, the labor rate, manual labor, and sub expenses. BusyBusy is read in exactly two other places, each scoped to one screen: the detail card at **index.html:30068** (`.eq('job_id', jobId)`) and the costing queue at **index.html:31543** (`.in('job_id', submittedReview…)`). So no shared per-job labor number exists for the list, the rollups, or Metrics to use.

4. **Live confirmation on Bobette Weiss** (`pec_prod_jobs.id = 50405d44-ce3b-40c5-b785-01554a0856ed`, revenue `5900.00`, `actual_hours` NULL, not subcontracted, submitted 2026-07-24, not finalized): **there is no `pec_prod_job_costing` row for this job at all.** `cost || {}` at :29215 makes every bucket 0, so Total Var = $0 and GP = $5,900 at 100%. Her three BusyBusy rows per member (all `wage_type = 'REG'`, no OT) total 24.2 hours: Davey Milligan 8.1667 at $22/hr, Kyle Floyd 8.1333 at $27/hr, Matthew Hamby 7.9 at $20/hr. Loaded at the 25% burden that is $697, which is exactly what the Bonus Payout box shows and exactly what GP is missing.

5. **No double-count risk on live data.** Of the 40 `pec_prod_job_costing` rows, 35 carry a hand-typed `salary_wages_cost > 0`, but **none of the 10 jobs with BusyBusy hours has one** (nine NULL, one 0.00). The old hand-typed era and the BusyBusy era do not overlap on a single job today.

---

## LOCKED DECISIONS

Dylan answered 1-4 directly. 5-9 are Cowork's calls, flagged where he can reverse them in one line.

1. **The labor number that hits GP is the LOADED cost, including the 25% burden** ($697 on Weiss, not the $558 of raw wages). One labor figure on the card, identical to what the bonus math uses. Known consequence, accepted: the 35 legacy hand-typed jobs were most likely raw wages, so BusyBusy-era jobs will carry a slightly heavier labor line than legacy ones. Do not retro-adjust legacy rows.

2. **BusyBusy wins over a hand-typed `salary_wages_cost`, and the typed value stays visible.** Same precedence pattern `computeCostingRow` already uses for materials and bonus at :29236-:29246 (`derived > 0 ? derived : stored`). The typed input is NOT deleted and NOT removed; it renders greyed with a note when a derived value is in force.

3. **The suggested-but-unapproved bonus DOES count against GP, labeled as pending.** Today `bonus_cost` only counts `pec_prod_job_bonuses` rows, which are written at finalize (**index.html:31280-:31292**), so every pending job overstates profit and GP visibly drops the moment you finalize. Pending bonus closes that gap.

4. **Scope is everywhere: detail card, Job Costing list, Rollups, and Metrics GP by crew lead.** Dylan explicitly accepted that company GP will drop for the 10 covered jobs. A fix that only touched the detail card would leave the card and the report disagreeing, which is worse than the current bug.

5. **Approve is its own button on the Labor & Bonus Payout card, separate from Finalize.** An approval dialog already exists at Finalize (**index.html:31249** onward, "Approve crew bonus & finalize", per-member editable, writes `suggested_amount` / `approved_by` / `approved_at`). Dylan is not asking for a feature that does not exist, he is asking for it in the place he reads the number. Approving the bonus and finalizing the costing are two different decisions and should be two buttons.

6. **Approval is one click on the suggested amount. No per-member editing.** This is the direct reading of "the automated bonus is the main source of truth." If a number looks wrong the fix is fixing the hours or the labor budget, not typing over the answer. Correction after the fact still exists: Pay full / Reduce / Void on the Bonus Report (**index.html:16547**). REVERSIBLE IN ONE LINE: if Dylan wants editable amounts back, re-use the existing finalize dialog's input row markup at :31305.

7. **Remove the whole `Crew Bonuses` card (`sec-bonuses`), with one exception.** The free-form `+ Add bonus row` path (**index.html:30678**, handlers at :29876, :29900, :29911) is the "manual bonus" Dylan does not want. It goes. BUT the `$50 crew lead bonus` checkbox in that same card (**index.html:30673**, handler at :29892 / :30999) is a *different policy*, not a manual override of the automated number, and deleting it silently removes the only way to record a payout PEC actually makes. It MOVES to the Labor & Bonus Payout card as a single line. REVERSIBLE IN ONE LINE: if Dylan wants the $50 gone too, delete that one checkbox and `addCrewLeadBonus`.

8. **The `Manual team member hours` editor STAYS.** Dylan objected to a manual *bonus*, not manual *hours*. That editor is the only path for a job BusyBusy never covered (shop work, a crew that forgot to clock in, a pre-import job). It already greys itself out and labels itself "not counted" when BusyBusy data exists (**index.html:30405**), which is the correct behavior.

9. **Typed `actual_hours` is a FALLBACK, not an override.** The field is currently labeled "Manual hours (override)" at **index.html:30447** but `actHrsEff` at :30288 ignores it whenever BusyBusy or manual per-member hours exist. The label is lying. Precedence stays as implemented (BusyBusy > manual per-member > typed) and the LABEL gets corrected. Do not invert the precedence.

---

## PART A: one shared per-job labor number

**The rule that makes this safe: the labor cost that hits GP is EXACTLY `computeCrewBonus(...).actualLabor` for that job.** The same number, from the same function, that the bonus formula subtracts from the labor budget. It is structurally impossible for the labor line and the bonus math to disagree. Do not compute loaded labor a second way anywhere.

A1. Add ONE query to `loadCostingData` (index.html:29035, the `Promise.all` block), following the existing graceful-empty conventions in that block:

```js
// Per-job crew labor from the BusyBusy mirror (prompt 52 shape: one row per
// export CSV row, wage_type REG|OT1, `hours` is that row's hours). Rows with a
// null crew_member_id (unmapped or ignored in Settings > BusyBusy) and overhead
// rows never reach costing. A missing table resolves with { error } rather than
// throwing, so this is safe pre-migration and degrades to no labor at all.
supabase.from('pec_prod_busybusy_time_entries').select('job_id,crew_member_id,hours,wage_type,is_overhead'),
```

A2. After `state.crewMembers` is set, build `state.bbHoursByJobMember`: `job_id -> { crew_member_id -> { total, ot } }`, skipping rows with no `job_id`, no `crew_member_id`, `is_overhead === true`, or `hours <= 0`. Accumulate `total += hours` for every row and `ot += hours` only for `wage_type === 'OT1'`. This is byte-for-byte the accumulation already at **index.html:30063-:30078**; extract it rather than writing it twice, and have the detail card call the shared helper.

A3. Add a shared helper next to `bonusTotalForJob` (index.html:29263):

```js
// The ONE crew-labor number for a job: hours, loaded cost (incl. burden), and
// the suggested bonus pool, all from computeCrewBonus so the Costs card and the
// Bonus Payout box can never disagree. Precedence: BusyBusy hours, else the
// manual per-member hours editor, else nothing. Returns zeros when neither
// exists, so a job with no hours never invents labor.
function crewLaborForJob(job, sys) { … }
```

It must resolve hours as BusyBusy-first / manual-second (mirroring `bonusSource` at :30142), build `memberLookup` from `state.crewMembers` exactly as :30111 does, use `effectiveLaborBudget(job, sys)` for the budget, pass `null` as the budget when `job.subcontracted` (matching :30157), and return `{ hours, otHours, laborCost, suggestedPool, source }` where `laborCost` is `computeCrewBonus(...).actualLabor || 0`.

Subcontracted jobs still get a real `laborCost` if crew hours exist. Only the *bonus pool* is suppressed for them, never the labor cost.

## PART B: feed it into `computeCostingRow`

B1. Extend the signature with a single trailing options object rather than a seventh positional arg:

```js
function computeCostingRow(job, cost, sysName, derivedOrderedCost, derivedUsedCost, derivedBonusCost, derived = {})
```

where `derived` may carry `{ laborCost, actHrs, pendingBonus }`. All existing call sites keep working unchanged when it is omitted.

B2. Inside, using the SAME `> 0 ? derived : stored` shape as :29236-:29246:

```js
const laborCost = derived.laborCost > 0 ? Number(derived.laborCost) : Number(c.salary_wages_cost || 0);
```

and set `buckets.salary_wages_cost = laborCost`. `totalVar` at :29254 is unchanged in form and now picks labor up for free.

B3. Hours: `const actHrs = derived.actHrs > 0 ? Number(derived.actHrs) : Number(job.actual_hours ?? c.actual_hours ?? 0);` at :29234. Every downstream consumer (`overUnder`, `hoursVarPct`, `gpHr`, `revHr`, and the Rollups Hrs column) then works with no further change.

B4. Pending bonus: `buckets.bonus_cost` becomes the ledger sum PLUS the pending pool, and never both for the same money:

```js
// derivedBonusCost is the pec_prod_job_bonuses ledger sum (approved money,
// incl. any crew-lead bonus). pendingBonus is the SUGGESTED labor-savings pool
// on a job that has not approved one yet. They are additive and mutually
// exclusive for labor savings: the caller passes pendingBonus = 0 as soon as a
// 'Labor-savings bonus' row exists, so approving cannot double-count.
```

The caller (not `computeCostingRow`) decides: `pendingBonus = (job has any ledger row with note 'Labor-savings bonus') ? 0 : crewLaborForJob(...).suggestedPool`. Put that in a tiny named helper so the detail card, the list, and Metrics all use one definition.

B5. Update every call site to pass `derived`:

- **index.html:29650** (`renderProdCostingDetail` / legacy detail)
- **index.html:30033** (callback kid rows, inside `renderUnifiedJob`)
- **index.html:30039** (`recomputeR`, the unified detail's main row)
- **index.html:31519** (the Job Costing list + rollups)
- **index.html:11978** (Metrics GP by crew lead) — see Part D, this one needs its own query

The callback-rollup comment block at **index.html:30020-:30030** states a locked prompt-51 rule: the rollup must NOT change the inputs to `computeCrewBonus`. **That rule still holds and this change does not touch it.** The parent's `bonusCalc` reads the parent's own hours and its own labor budget. Adding labor to `totalVar` does not feed back into the pool. Re-read that comment before touching `recomputeR` and leave it in place.

B6. `refreshUnifiedTotals` (index.html:30760 onward) recomputes via `recomputeR()`, so the live-edit path picks labor up automatically. Verify the `salary_wages_cost` display refreshes with it.

## PART C: the Labor & Bonus Payout card

C1. **Salary & Wages in the Costs card (index.html:30687)**: when `derived.laborCost > 0`, render it as a `derivedField` instead of a `moneyInput`, mirroring how Subcontractor already switches at :30690-:30692. Value = the loaded cost. Muted note underneath, plain language, **no em dashes** (standing rule 6):

> from N hrs of BusyBusy time, wages $X plus 25% burden

If a hand-typed `salary_wages_cost` also exists on that job, append a second muted line: `typed value $Y is not being used`. Never hide it, never delete it.

C2. **Approve button.** In `bonusPayoutBody` (index.html:30425), directly under the formula block, when the job is not subcontracted, has actuals, and has a pool greater than 0:

- Not yet approved: a primary `Approve $141 crew bonus` button plus one muted line saying approving records it to the Bonus Report as pending payout and counts it in this job's gross profit.
- Already approved: a green stamp, `Approved $141 by <name> on <date>`, plus a ghost `Unapprove` button.

Gate on `canFinalizeCosting()` (the existing helper the finalize button uses at :31253). A user without it sees the amount and the approved stamp, no buttons.

C3. **Approve writes the ledger the same way finalize does.** Reuse the exact insert shape at **index.html:31280-:31292**, including the delete-then-insert on `note = 'Labor-savings bonus'` and the pre-migration retry that strips `suggested_amount` / `approved_by` / `approved_at` when those columns 400. Do not write a second code path. Extract the ledger write from inside `doFinalize` into a named function both buttons call. On approve, `amount` equals `suggested_amount` exactly (decision 6). Unapprove deletes only rows with that note.

C4. **Finalize stops re-asking.** In the finalize handler at :31249, if approved `Labor-savings bonus` rows already exist for the job, the dialog shows them read-only with a line saying the bonus was already approved by whom and when, and finalizing leaves them untouched. It must NOT delete-and-reinsert approved rows, because that would overwrite `approved_by` / `approved_at` with the finalizer's name. If no rows exist, the current dialog behavior stands unchanged, so a job can still be approved and finalized in one action.

C5. **Delete the `Crew Bonuses` card.** Remove `bonusesBody` / `bonusesHeadExtra` (index.html:30672-:30682) and the `collapsibleSec('sec-bonuses', …)` line at **index.html:30731**. Remove `sec-bonuses` from the submitted-lock id list at **index.html:30747**. Remove the `+ Add bonus row` control, `bonusAddSelect`, `bonusOptions`, the editable `bonusesHtml` table (**index.html:30270-:30281**), and the now-dead handlers `addBonusRow` (:29876), `updateBonusField` (:29900), `deleteBonusRow` (:29911) plus their wire-ups. Grep for `bonusAddBtn`, `data-bonus-field`, `data-bonus-delete`, and `bonus-sum` and clean up every reference; `bonus-sum` is a `data-uderived` key, so check `refreshUnifiedTotals` too.

C6. **Two things that card was doing must survive the deletion.** Move both into the Labor & Bonus Payout card, below the approve control:

- The `$50 crew lead bonus` checkbox (decision 7). Keep `addCrewLeadBonus` (:29892) and the toggle handler (:30999) intact; only the markup moves.
- A **read-only** list of recorded ledger rows for the job: member, hours, amount, note, approver. `bonusRecapHtml` (index.html:30480 onward) already renders almost exactly this for finalized jobs. Widen its condition so it renders whenever ledger rows exist, approved or finalized. No inputs, no delete buttons.

C7. Relabel the hours field at **index.html:30447** from `Manual hours (override)` to `Manual hours (fallback)` with a muted note: `used only when there are no per member hours` (decision 9). Behavior unchanged.

## PART D: Metrics GP by crew lead

`renderMetrics` (index.html:11707) loads costing itself and does not call `loadCostingData`, so it needs its own read. In the `Promise.all` at :11717, add:

```js
supabase.from('pec_prod_busybusy_time_entries').select('job_id,crew_member_id,hours,wage_type,is_overhead'),
```

plus a crew-member read for wages if one is not already in that block (check before adding; do not duplicate a query). Build the same per-job labor map and pass `derived` at **index.html:11978**.

The exclusion rule at **index.html:11976** currently skips a job with no costing signal at all and counts it in `gpMissing`. **BusyBusy labor is now a costing signal**: extend that condition so a job with BusyBusy hours but no `pec_prod_job_costing` row is INCLUDED rather than dropped. Bobette Weiss is exactly that job. Update the `gpMissing` footnote text accordingly.

## PART E: settings surface (standing rule 12)

Four numbers this feature turns on are hardcoded consts at **index.html:29327-:29332**. Move them to the `settings` table, keyed, with the current constants as defaults so behavior is identical on day one. **No migration: `settings` is key/value** (see the upsert at :17551).

| key | default | label |
|---|---|---|
| `bonus_crew_fraction_pct` | 75 | Crew share of labor savings |
| `bonus_labor_burden_pct` | 25 | Labor burden on wages |
| `bonus_ot_multiplier` | 1.5 | Overtime multiplier |
| `costing_default_labor_budget_pct` | 20 | Fallback labor budget percent of revenue |
| `costing_labor_from_hours` | true | Derive labor cost from crew hours |
| `costing_count_pending_bonus` | true | Count an unapproved bonus in gross profit |

Surface them under Settings > General in a `Job Costing & Bonus` group. Read them where the consts are read today; keep the const names as the fallback values so a missing key cannot zero out the bonus math. The two booleans are the kill switches for Parts B2 and B4 respectively, so a bad number in the field can be turned off without a deploy.

---

## WHAT'S NEW (standing rule 11)

Append one entry to `help/whats-new.json`, newest first. Plain language, no em dashes:

> **Job costing now counts crew labor.** Hours imported from BusyBusy turn into a real labor cost on the job costing card, so gross profit and GP per hour finally reflect what the job actually cost. You also approve the crew bonus with one click, right under the number it is based on.
>
> 1. Open a job in Job Costing and expand Labor and Bonus Payout.
> 2. Check the crew hours and the suggested bonus, then click Approve.
> 3. Gross profit at the top of the card now includes labor and the approved bonus.

Update the relevant `features.json` entries (job costing, crew bonus, BusyBusy import) with the new anchors: `crewLaborForJob`, the new `derived` argument on `computeCostingRow`, and the new settings keys.

---

## VERIFY (run all of these before the final commit)

1. `npm test` green. Node-check every script block you touched.
2. **Bobette Weiss (#2989725), the acceptance case.** Open her Job Costing detail. Expected after the fix, arithmetic stated so a wrong number is obvious:
   - Salary & Wages: **$697** (derived, with the burden note)
   - Bonus: **$141** pending, before you approve
   - Total Var Expense: **$838** (there are 3 material lines but no `actual_used_qty`, so materials used is $0, and she has no `pec_prod_job_costing` row so every other bucket is $0)
   - Gross Profit: **$5,062**, GP% **85.8%**
   - Actual Hours **24.2**, GP/hr **$209**, Rev/hr **$244**
   - Before the fix these read Total Var $0, GP $5,900, 100%. If GP is still 100%, `derived` is not reaching `recomputeR`.
3. Click Approve. Confirm exactly one `pec_prod_job_bonuses` row per mapped member (3 rows, $48 / $47 / $46, summing to $141), each with `note = 'Labor-savings bonus'`, `suggested_amount` equal to `amount`, and `approved_by` set. Confirm **GP does not move** when you approve, because the pending bonus was already counted. That non-movement is the proof B4 is not double-counting.
4. Click Unapprove, confirm the 3 rows are deleted and the bonus reverts to pending, GP still $5,062.
5. Approve again, then Finalize. Confirm the dialog shows the approved rows read-only, and that after finalizing `approved_by` is still the approver's name, not the finalizer's.
6. Job Costing list and Rollups: the Hrs column is populated for all 10 BusyBusy jobs (Al Weikart 4.0, Bobby Priest 35.1, Bobette Weiss 24.2, Haley Construction 6.0, Jamy Myrmel 20.4, Martin Trout 5.2, Nathan Rhodes 29.4, Plaza Bowl 8.9, Scott Gordon 39.0, Will Lewis 20.7) and GP/hr is no longer a dash.
7. A job with a hand-typed `salary_wages_cost` and NO BusyBusy hours (35 of them exist) is **numerically unchanged**. This is the regression that matters most. Spot-check three.
8. Haley Construction has 6.0 BusyBusy hours and **NULL revenue**. Confirm it does not divide by zero, does not render NaN, and does not claim a bonus.
9. A subcontracted job with crew hours shows a labor cost but no bonus pool.
10. Metrics GP by crew lead: Bobette Weiss now appears instead of counting toward `gpMissing`, and total GP drops by roughly the sum of the 10 jobs' labor.
11. Confirm the `Crew Bonuses` card is gone from the DOM, no console errors from removed handlers, and the $50 crew lead checkbox works from its new home.
12. Flip `costing_labor_from_hours` off in Settings and confirm the card reverts to pre-fix behavior. That is the rollback path.

## GUARDRAILS

- **Do not** change `computeCrewBonus` (:29333), `effectiveLaborBudget` (:29370), or the bonus formula. This prompt changes where the labor number is *consumed*, not how it is *computed*.
- **Do not** touch the prompt-51 callback rollup rule at :30020-:30030.
- **Do not** touch `pec-busybusy-export.cjs` or the import path. The import stays display-and-cost only and must never write to `pec_prod_job_bonuses` or `pec_bonus_payouts` (the prompt-52 money rule at :30465).
- **Do not** delete the manual hours editor, the typed `salary_wages_cost` input, or any existing ledger row.
- **Do not** run any migration. No schema change is needed; `settings` is key/value.
- Commit per standing rule 1, one commit per part. Log per rule 2.

## OPEN QUESTION FOR DYLAN (do not block on it)

The 35 legacy jobs with a hand-typed `salary_wages_cost` were almost certainly entered as raw wages, while BusyBusy-era jobs now carry wages plus a 25% burden. Company-level GP comparisons across that boundary are apples to oranges. This prompt deliberately does not touch history. If Dylan wants them comparable, the options are backfilling the legacy rows to loaded cost or excluding pre-BusyBusy jobs from trend charts. Raise it in the log entry as a decision for later, not a task for this build.

## Handoff to Cowork

After Claude Code ships this, Cowork verifies items 2, 3, 6, 7, and 10 against the live dashboard (not just the code), records the actual before/after GP for Bobette Weiss and the Metrics grand-total GP delta in a PROJECT-LOG entry with `By: Cowork`, and reports both numbers to Dylan. No migration to apply. If item 7 shows any movement on a legacy hand-typed job, stop and flag it before anyone finalizes another job.
