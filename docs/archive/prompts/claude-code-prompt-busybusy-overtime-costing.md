# Claude Code prompt: overtime (OT) hours in Job Costing

Paste this whole file into Claude Code. Follow CLAUDE.md and the Bug Diagnosis Workflow. Read the last 3 PROJECT-LOG entries first.

---

## 0. READ THIS FIRST: the symptom is NOT a code bug

Dylan reports "there are still no overtime hours showing." Do not go hunting a rendering or calc bug in `index.html`. The reason no hours of ANY kind show is upstream: the BusyBusy integration is dead at the auth gate.

State as of the last time anyone touched it (PROJECT-LOG 2026-06-13, commit df4113f):

- The read-only proxy `netlify/functions/pec-busybusy.cjs` was reworked to GraphQL (endpoint `https://graphql.busybusy.io/`, header `key-authorization`, bare token).
- A live probe from a logged-in admin session returned **401 FROM BusyBusy** (`{ status: 401, ok: false }`). Our session gate and proxy work; BusyBusy rejects the Integration Key. The "TopCoat" key showed "Never Used."
- Because of the 401, introspection is blocked, so the real GraphQL root query names/args are still UNKNOWN, the typed queries are best-guess, and **no sync function exists** — nothing writes into `pec_prod_busybusy_time_entries`. That table is empty, so every job reads "awaiting BusyBusy hours" and the Bonus Payout box pays nothing.

Resolving the 401 is a Dylan / BusyBusy-support action (regenerate key, then try alternate auth schemes, then ask AlignOps support for the integration endpoint, which may be a legacy REST API). It is NOT something you can fix in this repo. Do not build the BusyBusy OT sync blind against an endpoint that 401s.

So this prompt is deliberately split: what you CAN ship now (OT-aware costing math + a manual OT path), and what is gated on the 401 (the real BusyBusy OT sync).

## 1. What Dylan actually wants

OT hours change how a job is costed. Overtime is paid at a premium (assume 1.5x base wage unless Dylan says otherwise), so:

- A job where the crew burned overtime has a HIGHER loaded labor cost than the current math shows.
- The crew "labor-savings" bonus (75% of `laborBudget - actualLabor`) must shrink accordingly, or the company over-pays a bonus on labor that actually cost more.

Today the math treats every hour identically. In `computeCrewBonus` (`index.html` ~line 14931) loaded labor is `sum(memberHours x wage x (1 + CREW_BONUS_BURDEN))` with `CREW_BONUS_BURDEN = 0.25` and no OT premium. Neither `pec_prod_busybusy_time_entries` (single `hours` numeric, `2026-06-13_busybusy_time.sql`) nor `pec_prod_job_manual_labor` stores OT separately.

## 2. The design problem you must solve (do not assume OT is handed to you)

The captured BusyBusy `TimeEntry` has NO `hours` field and NO OT flag. Its fields are `id, memberId, projectId, costCodeId, startTime, endTime, breaks[], actionType, createdOn, updatedOn, deletedOn`. Overtime in BusyBusy is a pay-period-derived report concept, not a per-entry property. So OT will NOT fall out of raw time entries for free.

Decide and write up which approach we take (this is the first thing to confirm, ideally before coding):

- (a) Pull OT from a BusyBusy OT/aggregate query, IF one exists. Unknown until introspection works, which is blocked by the 401.
- (b) Compute OT ourselves from raw punches against an OT rule. Arizona follows FEDERAL OT only: time over 40 hours in a workweek, no daily OT. Recommended, because it is independent of BusyBusy's reporting layer and works the moment we have raw punches.

Recommend (b) in your write-up unless you find a reason against it. But see the hard modeling question in section 5 before you assume per-job OT is even well-defined.

## 3. Scope you CAN ship now (independent of the 401)

This lets Dylan OT-job-cost TODAY through the existing manual-entry path, and makes the math correct for BusyBusy later.

1. Schema (new migration, do NOT apply it; hand off to Cowork): add an `ot_hours numeric not null default 0` column to `pec_prod_job_manual_labor` and to `pec_prod_busybusy_time_entries`. Keep the existing `hours` column as TOTAL hours; derive `regular = hours - ot_hours`. This keeps every existing SUM working and avoids a backfill.
2. Make `computeCrewBonus` OT-aware as the single shared math path (the Crew Bonus tab and the costing Bonus Payout box both call it, so do not fork the math). Add an `OT_MULTIPLIER` constant (default 1.5) next to `CREW_BONUS_BURDEN`. New loaded-labor per member:
   `((regHours x wage) + (otHours x wage x OT_MULTIPLIER)) x (1 + CREW_BONUS_BURDEN)`.
   Change the `hoursByKey` input so it can carry OT (for example `{ key -> { total, ot } }`, or a parallel `otByKey` map). Keep the per-member bonus split on TOTAL hours unless Dylan says otherwise.
3. Manual entry UI: add an "OT hours" input next to the existing hours input in the "Crew labor (manual)" table (Bonus Payout box, `renderUnifiedJob` ~line 15700) so Dylan can enter OT per member now. Validate `ot_hours <= hours`.
4. Display: show OT hours and the OT premium in the Bonus Payout breakdown and the costing labor line, so the higher cost is visible, not hidden inside one number.

Build, commit per standing rules, and TEST the math with a worked example (regular-only job unchanged vs a job with OT showing higher actualLabor and a smaller pool). Cory Poole is the standing test job.

## 4. Gated on the 401 (do NOT build blind)

The actual BusyBusy OT sync (upsert entries into `pec_prod_busybusy_time_entries`, compute OT, resolve `crew_member_id` and `job_id`). Do not write this until a probe returns 200 and introspection reveals the real root queries and whether OT is queryable. Until then, the manual OT path from section 3 covers Dylan's need. You may write the sync skeleton + the OT-from-punches helper as pure, unit-tested functions that do not depend on the live endpoint, but do not wire a live sync against a 401 endpoint.

## 5. Open questions for Dylan (flag these; do not guess them into production)

The first one is the real modeling problem and changes every job's cost, so surface it prominently:

1. **OT attribution across jobs.** Overtime is computed per PERSON per WEEK, but job costing is per JOB. If Preston works 45 hours across two jobs in one week, the 5 OT hours have to be assigned to a job. Which rule: the job he was on when he crossed 40 (chronological), pro-rata across that week's jobs, or last-job-of-week? There is no neutral default; the choice materially moves each job's labor cost. Get Dylan's rule before any payout goes live.
2. OT multiplier: 1.5x base wage? Confirm.
3. Does the 25% burden stack ON TOP of the OT premium (i.e., `hours x wage x 1.5 x 1.25`), or is burden computed on base wage only? The recommended formula in section 3 stacks them; confirm.
4. OT threshold: federal weekly >40 only (Arizona), or any daily/other rule Dylan uses internally?
5. Per-member bonus split: on total hours (recommended) or on loaded-labor dollars (which would shift more of the pool toward the OT earners)?

## 6. Honest take for Dylan (include in your reply to him)

Building OT-aware costing is worth doing, but note bluntly: the upstream data pipe (BusyBusy) has been dead at a 401 for six days and no hours flow at all, so none of this is testable against real data until the key authenticates. The highest-leverage next step is resolving the 401 (Dylan/support), not more code. The manual OT path is the one piece that delivers value immediately and is fully testable now, which is why it is the recommended first build.

## After (per CLAUDE.md)

- Append a PROJECT-LOG.md entry (By: Claude Code) describing the schema migration added (not applied), the OT-aware math change, the manual OT UI, and the worked-example test result.
- `## Handoff to Cowork`: apply the new migration to prod Supabase (the `ot_hours` columns) and report the columns live.
- `## Handoff to Dylan`: the five open questions in section 5, especially OT attribution (#1), and the standing 401 blocker for real BusyBusy OT.
