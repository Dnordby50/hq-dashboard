# Claude Code Prompt 50: Metrics window presets + AI insights, Job Costing office notes + declutter, Bonus 2-week lock + reversal

Owner: Dylan. ONE build, FIVE independent parts, each its own commit so any single part can revert alone. Parts A/B touch the Metrics tab; Parts C/D/E touch Job Costing and Bonus.

Follow CLAUDE.md standing rules: 6 (no em dashes in customer/crew-facing text), 9 (features.json + SCHEMA.md before searching or writing SQL), 10 (token discipline, never read index.html end to end), 11 (What's New for user-facing changes), 12 (Settings knobs for every major feature), plus the @artifacts header rule on every migration.

## Provenance: this REPLACES claude-code-prompt-34-metrics-costing-bonus.md

That file was scoped 2026-07-19 and never run. Prompts 35 through 48 shipped on top of it, so its anchors and two of its factual claims are now wrong. This is the corrected version, renumbered to 50 because "prompt 34" already means the shipped lead-drip-engine Phase 2 in git history and PROJECT-LOG, and 49 was claimed the same evening by the follow-up-queue build (claude-code-prompt-49-followup-queue.md). Refer to this build as prompt 50 in every commit message and log entry. DELETE or archive `claude-code-prompt-34-metrics-costing-bonus.md` as part of commit 5; do not leave both in the repo root.

Verified against commit HEAD on main and live prod schema by Cowork on 2026-07-26. Every anchor below was re-confirmed by grep, and every table/column against the live schema, not SCHEMA.md alone.

## Dylan's answers to the open questions (2026-07-26, locked)

1. Part B trigger: MANUAL "Generate insights" button. Not auto-on-load. (Was flagged unconfirmed in prompt 34.)
2. Part A default window: MTD, as originally scoped. No persistence across reloads required.
3. Scope: ALL FIVE parts, one prompt, five commits.
4. Part E clawback target: Dylan has NOT identified the wood job. Build the generic Reverse payout tool with its audit trail and STOP there. Do NOT reverse any payout. He will do the actual reversal in the UI once he spots the job. See the payout inventory at the end of Part E.

## THREE CORRECTIONS to prompt 34 (read these before Part C/D/E, they change the design)

### Correction 1: `pec_prod_jobs.completed_at` is NOT a usable lock anchor. It is NULL on all 87 rows.

Prompt 34 said "pec_prod_jobs already has completed_at (the real lock anchor)". The column exists but NOTHING populates it. Live counts, 2026-07-26:

- `pec_prod_jobs`: 87 rows, `completed_at` NOT NULL on **0**.
- `public.jobs`: 93 rows, `status='completed'` on **53**, `completed_date` NOT NULL on **49**, `status_manual_at` NOT NULL on 22.

Completion is stamped on `public.jobs` by `markJobComplete`, not on the production row. That is the 2026-07-21 manual-completion-as-source-of-truth model from prompt 40 (see PROJECT-LOG 2026-07-21, commits 174bf19 and 9d051c3).

So the 2-week bonus lock anchors on **`public.jobs.completed_date`**, reached from the bonus row via `pec_prod_job_bonuses.job_id -> pec_prod_jobs.id`, bridged to `public.jobs` the way the rest of the app bridges: `dripjobs_deal_id` first, then the normalized name+address fallback (`_nameAddrKey` / `_normKey`, near `mstTodayIso` in index.html). Reuse the existing bridge helper; do not write a third one.

Handle the 8 rows that are `status='completed'` with `completed_date` NULL explicitly. Do NOT treat a NULL completion date as "unlocked forever" (that silently disables the lock this part exists to create) and do NOT treat it as "locked forever" (that blocks legitimate payouts). Required behavior: NULL completion date means the lock cannot be evaluated, so the bonus shows as **"Completion date missing"** and is treated as LOCKED with a one-click "Set completion date" affordance for an admin. Surface the count of such rows on the Bonus Report so it gets cleaned up rather than hidden.

### Correction 2: `is_callback` is the authoritative flag. `callback` is vestigial.

Prompt 34 told you to grep for which one is authoritative. Answered: across 87 `pec_prod_jobs` rows, `callback` is true on **0**, `is_callback` is true on **2**, and `original_job_id` is set on exactly those same 2 rows. Use `is_callback` + `original_job_id`. Do NOT write to `callback`, and do not delete it in this build (out of scope, note it in the log as dead).

### Correction 3: these three tables are now under DB-enforced RBAC RLS. This can silently break Part C and Part E.

Yesterday's security batch (commit 122b426, "enforce RBAC in RLS on commissions/costing/catalog") added policies that did not exist when prompt 34 was written. Live policy expressions:

| table | policy | expression |
|---|---|---|
| `pec_prod_job_costing` | read / ins / upd / del | `is_admin_staff() AND has_permission('can_view_job_costing')` |
| `pec_prod_job_bonuses` | staff (ALL) | `is_admin_staff()` |
| `pec_bonus_payouts` | `bp_select` | `is_admin_staff() AND has_permission('can_view_commission')` |
| `pec_bonus_payouts` | `bp_write` (ALL) | `is_admin_role()` |

Consequences you MUST design around:

- **Part C (office notes)** writes to `pec_prod_job_costing`, so the author needs `can_view_job_costing`. The whole point of Part C is "so Anne can see and change them". Anne (anne@finishingtouchpaintingaz.com) is role `admin`, and `has_permission()` short-circuits on `is_admin_role()`, so she passes. VERIFY this rather than assume: adding a column does not change RLS, but confirm an office-role (non-admin) user with `can_view_job_costing` can actually UPDATE the new column, and that a user without it gets a clean error, not a silent no-op. Remember the supabase-js gotcha in the project instructions: a failed write can come back without throwing, so check `res.error`.
- **Part E (reversal)** writes to `pec_bonus_payouts`, whose write policy is `is_admin_role()` with NO permission-flag escape hatch. The Reverse payout tool is therefore **admin-only, enforced in the database**. Match the UI to that: hide or disable the reverse control for non-admins instead of letting them click it and get an RLS failure. Do not add or widen any policy on `pec_bonus_payouts`; admin-only is the correct security posture for clawing back money.

---

## PREFLIGHT

1. Re-verify every anchor by function name plus grep. Line numbers below are from 2026-07-26 and will drift as you edit.
2. Prompt 33 (leads Phase 1) HAS shipped, so the sequencing question in prompt 34's preflight is RESOLVED: proceed. But prompt 33 redesigned `renderMetrics` with Chart.js, sparklines and a contact-count card, so EVERY Metrics line reference from prompt 34 is stale. Re-anchor A/B by name before editing.
3. `npm test` must pass before you start and after each commit.

## Verified anchors (2026-07-26)

Metrics (Parts A/B):
- `renderMetrics` — index.html:11599 (`async function`)
- `openMetricsDrill` — index.html:12565
- current window control — index.html:12334, `const winOpts = [['4w','Last 4 weeks'],['12w','Last 12 weeks'],['ytd','Year to date']]`; the `<select id="pecMetWin">` at 12337; its change listener at 12499
- window state — `state.metricsWindow` initialized `'4w'` at index.html:6718 (alongside `metricsSalesperson`, which stays and must compose with the new window)
- `invBuildWeeks(key)` — index.html:8946, consumed by Metrics at index.html:11743. This is the existing window-to-weeks helper; extend it or route around it deliberately, and say which in the log.
- AI endpoint — `netlify/functions/pec-metrics-ai.cjs`. It ALREADY has: `requireStaff` gating, a cache-first path with `CACHE_TTL_DAYS` and a `force` flag in the POST body, and returns `{ text, generated_at, model }`. Extend it with a mode/param for the whole-tab read; do NOT build a sibling endpoint, and do NOT remove the cache (it is what keeps the manual button cheap on repeat clicks).

Job Costing (Parts C/D):
- `renderJobCosting` — index.html:28499 · `loadCostingData` — 26210 · `computeCostingRow` — 26465 · `openCostingDetail` — 26859 · `saveCostingField` — 26773 · `renderUnifiedJob` — 27182 · `jobEffectiveSqft` — 8913 · `canFinalizeCosting` — 5878

Bonus (Part E):
- `renderBonusReport` — index.html:15729 · `openBonusHandouts` — 16086 · `buildBonusHandoutMemberPage` — 16031 · `saveBonusField` — 27115 · `computeCrewBonus` — 26584 · `renderCrewBonus` — 26636 (legacy, keep working)

Schema facts confirmed live: `pec_prod_job_costing.notes` EXISTS (leave it alone, office notes is a NEW separate field). `pec_prod_jobs` has `costing_finalized_at`, `completed_at` (unused, see Correction 1), `is_callback`, `callback`, `original_job_id`, `revenue`, `status`. `pec_prod_job_bonuses` has `id, job_id, crew_member_id, crew_member_name, amount, approved_by, approved_at, note`. `pec_bonus_payouts` PK is `bonus_id`, plus `amount, paid_on, payroll_date, paid_by`.

---

## PART A — Metrics time-window presets (commit 1)

Replace the `winOpts` control with four presets plus a custom range. **Default MTD.**

- Buttons: **MTD**, **YTD**, **Last 4 weeks**, **Custom**. Selecting one re-renders the whole tab.
- **Last 4 weeks = rolling last 28 days** (today minus 28 through today, inclusive). Not calendar weeks.
- **MTD** = first of the current month through today. **YTD** = Jan 1 through today. All dates in MST (UTC-7, no DST), consistent with `mstTodayIso`.
- **Custom** reveals two native `<input type="date">` fields plus Apply. No date-picker library. Guard From <= To; an empty range is a no-op.
- Route ALL existing consumers through the one selected window: KPI cards, the Sales section (price/sqft by month+system, speed-to-lead, conversion by source/campaign, open pipeline), the prompt-33 Chart.js graphs and sparklines, and the contact-count card. **The window drives the whole tab, not just the KPI cards.** `openMetricsDrill` inherits the same window.
- The existing salesperson filter (`state.metricsSalesperson`) stays and COMPOSES with the window.
- Keep the selected preset visually active. No cross-reload persistence.
- `invBuildWeeks` currently keys off `'4w' | '12w' | 'ytd'`. Decide explicitly whether MTD/custom extend it or bypass it, and keep `12w` reachable somewhere or state in the log that it was intentionally dropped. Do not silently delete a window Dylan uses.

## PART B — Metrics AI insights panel (commit 2)

A NEW dedicated AI insights panel at the top of Metrics, distinct from the existing weekly pipeline read, which stays as-is.

- Reads the KPI cards plus Sales section **for the currently selected window** and writes a short plain-language read: what moved, notable anomalies, what to act on. It must state the window it analyzed ("Month to date").
- **Trigger: a manual "Generate insights" button** (Dylan confirmed). Disabled while offline or mid-request; show a spinner and a last-generated timestamp.
- Extend `pec-metrics-ai.cjs` with a mode/param. Keep `requireStaff`. Keep the existing cache and make the cache key include the window and the salesperson filter, so MTD and YTD do not serve each other's text. The button should honor the cache and expose the existing `force` flag as a "Regenerate" affordance.
- Send the model the COMPUTED metric values for the window, not raw tables. It may summarize but must not invent numbers absent from the payload.
- Internal only, no customer surface.

## PART C — Job Costing "Office notes" field (commit 3)

A distinct, clearly labeled **Office notes** box on the costing detail (`openCostingDetail` / `renderUnifiedJob`), separate from the existing `pec_prod_job_costing.notes`, which stays untouched.

- New columns: `office_notes text`, `office_notes_by uuid`, `office_notes_at timestamptz`.
- Show author and timestamp ("Anne, Jul 26 2:14 PM") when present. Save follows the `saveCostingField` pattern; check `res.error` on the write (project instructions gotcha: a bad column comes back as an empty response, not a throw).
- Editable by anyone who passes the costing RLS (see Correction 3). Verify the non-admin office path explicitly.
- Not crew-facing and not customer-facing, so em dashes are allowed here, but keep it plain.

## PART D — Declutter the Job Costing detail (commit 4)

Collapsible accordion sections (Materials / Labor / Subs / Bonus / Revenue) with a compact profit summary ALWAYS visible above them. Layout only.

- **Zero math changes.** No edits to `computeCostingRow`, `jobEffectiveSqft`, or any total. If a number moves, that is a bug in this part.
- Default state: profit summary open, all five sections collapsed. Remember open/closed per section within the session only.
- Do not break `canFinalizeCosting` gating or the finalize affordance.

## PART E — Bonus 2-week lock + callback flag + reversal with audit trail (commit 5)

Three linked mechanisms.

**E1. Hard 2-week lock.** A bonus becomes payable only once **14 days have passed since the job's completion date** (`public.jobs.completed_date`, bridged per Correction 1). HARD block, no admin override, per Dylan. Show the unlock date on the row ("payable Aug 9"). Missing completion date behaves per Correction 1 (locked, labeled, with a set-date affordance, and a count surfaced on the report).

**E2. Callback flags the bonus for manual review.** When a job has a callback (another `pec_prod_jobs` row with `is_callback = true` and `original_job_id` pointing at it), the parent job's bonuses get flagged for MANUAL review with three actions: **Pay full / Reduce / Void**. No automatic math, per Dylan. New columns on `pec_prod_job_bonuses`: `review_status text`, `reviewed_by uuid`, `reviewed_at timestamptz`, `review_note text`. A flagged, unreviewed bonus is not payable.

**E3. Generic "Reverse payout" tool with an audit trail.** Reverses an already-paid payout WITHOUT deleting anything: mark `pec_bonus_payouts` reversed with a reason and who did it. New columns: `reversed_at timestamptz`, `reversed_by uuid`, `reversal_reason text`. A reversed payout stops counting as paid everywhere it is summed (Bonus Report, handouts, commission views) and reads visibly as reversed with its reason. **Admin-only, matching the DB policy (Correction 3): hide or disable the control for non-admins rather than letting the click fail.**

**DO NOT REVERSE ANYTHING.** Dylan has not identified the wood job. Ship the tool; he uses it. For his reference, the full paid set is 16 payouts, all `paid_on` 2026-07-15 / `payroll_date` 2026-07-17, across 7 jobs: Mike Long ($413.58, Kyle), Michelle Herod ($398.80 across Davey/Kyle/Caden/Landen), Cory Poole ($334.46, Kyle+Davey), Jon Loyd ($402.12, Davey/Kyle/Caden, MANUAL entry), Jeff Walker ($202.75, Kyle+Davey), Brandon Campos ($192.08, Kyle+Davey, MANUAL), Brian Wirick ($149.34, Kyle+Davey, MANUAL).

## Migrations (write them, DO NOT apply)

Three files in `supabase/migrations/`, additive and idempotent, one transaction each, each with an `@artifacts` header per the CLAUDE.md convention:

1. `2026-07-<dd>_costing_office_notes.sql` — `pec_prod_job_costing` += `office_notes`, `office_notes_by`, `office_notes_at`
2. `2026-07-<dd>_bonus_review_status.sql` — `pec_prod_job_bonuses` += `review_status`, `reviewed_by`, `reviewed_at`, `review_note`
3. `2026-07-<dd>_bonus_payout_reversal.sql` — `pec_bonus_payouts` += `reversed_at`, `reversed_by`, `reversal_reason`

No new RLS policies on any of the three (existing policies already cover the new columns; widening them would weaken the security posture shipped yesterday). Cowork applies and regenerates SCHEMA.md.

## Settings (standing rule 12)

- `bonus_lock_days` (default `14`) — the lock window, so Dylan can tune it without a code change.
- `metrics_default_window` (default `mtd`) — the landing preset.
- `metrics_ai_cache_days` — reuse or expose whatever `CACHE_TTL_DAYS` currently hardcodes in `pec-metrics-ai.cjs`.

## Guardrails

- Parts C/D/E must not change any costing or bonus MATH. The lock and review gate change WHETHER a bonus is payable, never the amount.
- Never delete a payout row. Reversal is a marking operation with an audit trail.
- Do not widen RLS on `pec_prod_job_costing`, `pec_prod_job_bonuses`, or `pec_bonus_payouts`.
- Do not apply migrations. Do not touch the repo-root `estimator/` build output.
- Preserve `renderCrewBonus` (legacy) behavior.

## What's New (rule 11)

Staff-facing, so entries are required. Suggest three: the Metrics window presets plus the insights button (one entry), Office notes on job costing (one), and the bonus 2-week lock plus callback review (one, and state plainly that bonuses now wait 14 days after completion so nobody thinks payroll broke). No em dashes.

## Commits

1. `metrics: MTD/YTD/4-week/custom window presets driving the whole tab`
2. `metrics: AI insights panel (manual generate, window-keyed cache)`
3. `costing: Office notes field with author and timestamp`
4. `costing: collapsible detail sections with always-visible profit summary`
5. `bonus: 2-week lock, callback review gate, payout reversal with audit trail` (+ delete claude-code-prompt-34-metrics-costing-bonus.md, features.json, What's New, PROJECT-LOG)

## After

PROJECT-LOG entry (By: Claude Code), titled with prompt 50, covering all five parts, the three new settings keys, which completion-date bridge you used and how many jobs currently lack a completion date, plus a `## Handoff to Cowork` section listing: apply the three migrations to PROD, regenerate SCHEMA.md, and verify a non-admin office user can write office notes but cannot see the reverse control. Update `features.json` for all five.

Tell Dylan in plain English: how many bonuses are currently locked, how many are flagged for callback review, and how many are blocked on a missing completion date.
