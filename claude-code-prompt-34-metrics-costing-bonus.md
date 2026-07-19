# Claude Code Prompt 34 — Metrics filters + AI insights, Job Costing office notes + declutter, Bonus 2-week lock + reversal

Owner: Dylan. One combined build, but **five independent parts, each its own commit** so any single part can revert alone. Parts A/B touch the Metrics tab; Parts C/D/E touch the Job Costing detail. Follow CLAUDE.md rules (9 features.json/SCHEMA.md first, 10 token discipline, 6 em dashes banned only in customer/crew-facing text). Do not read index.html end to end; use the anchors below plus targeted greps.

## PREFLIGHT (do this first, before any edit)
1. **Coordinate with prompt 33 (leads P1).** Per PROJECT-LOG 2026-07-19, prompt 33 also edits the Metrics tab (`renderMetrics`: Chart.js graph redesign + sparklines + a contact-count stat card). This prompt (Parts A/B) also edits `renderMetrics`. **These two must not be in flight at the same time.** If prompt 33 has already shipped, re-confirm every Metrics anchor by function name + grep before editing (line refs will have moved). If prompt 33 has NOT shipped, tell Dylan which order he wants; do not edit `renderMetrics` until that is settled. Everything in Parts C/D/E is independent of prompt 33 and can proceed regardless.
2. **Verify anchors by function name + grep** (never trust line numbers). Confirm these exist:
   - Metrics: `renderMetrics`, `openMetricsDrill`, netlify `pec-metrics-ai.cjs`.
   - Job Costing: `renderJobCosting`, `renderUnifiedJob`, `loadCostingData`, `computeCostingRow`, `openCostingDetail`, `saveCostingField`, `jobEffectiveSqft`, `canFinalizeCosting`.
   - Bonus: `renderCrewBonus`, `computeCrewBonus`, `saveBonusField`, `renderBonusReport`, `buildBonusHandoutMemberPage`, `openBonusHandouts`.
3. **Verify every table/column against SCHEMA.md** before writing SQL. Relevant tables: `pec_prod_jobs` (has `completed_at` timestamptz, `costing_finalized_at`, `callback` bool, `is_callback` bool, `original_job_id` uuid, `revenue`, `status`), `pec_prod_job_costing` (has `notes`, `updated_at`), `pec_prod_job_bonuses` (`id`, `job_id`, `crew_member_id`, `crew_member_name`, `amount`, `approved_by`, `approved_at`, `note`), `pec_bonus_payouts` (PK `bonus_id`, `amount`, `paid_on`, `payroll_date`, `paid_by`). **Confirm which of `callback` vs `is_callback` marks the callback job and how `original_job_id` links it to the parent** (grep how they are written/read today). Do not guess.
4. All migrations: additive, idempotent, one transaction each, in `supabase/migrations/`. **Do NOT apply them** — Cowork applies to PROD and regenerates SCHEMA.md (see the After section). Nothing you deploy may write a new column before its migration is live.

---

## PART A — Metrics time-window presets (commit 1)

Replace the current Metrics time-window control with four presets plus a custom range. **Default on load: MTD.**

- Buttons: **MTD**, **YTD**, **Last 4 weeks**, **Custom**. Selecting one re-renders the whole tab for that window.
- **Last 4 weeks = rolling last 28 days** (today minus 28 days through today, inclusive). Not calendar weeks.
- **MTD** = first of the current month through today. **YTD** = Jan 1 of the current year through today.
- **Custom** reveals two native `<input type="date">` fields (From / To) and an Apply action. No date-picker library (codebase is vanilla JS). Guard: From ≤ To; empty range does nothing.
- First find how `renderMetrics` currently derives its window and what state var holds it (grep inside `renderMetrics` and `openMetricsDrill`). Route ALL existing consumers (KPI cards, the Sales section: price/sqft by month+system, speed-to-lead, conversion by source/campaign, open pipeline) through the one selected window. **The window drives the whole tab, not just the KPI cards.** The drill-through (`openMetricsDrill`) must inherit the same window.
- The salesperson filter that exists today stays and composes with the time window (both apply).
- Keep the selected preset visually active. No persistence across reloads is required (MTD default is fine on refresh).

## PART B — Metrics AI insights panel (commit 2)

Add a **new dedicated AI insights panel** at the top of the Metrics tab (distinct from the existing weekly pipeline read, which stays as-is).

- The panel reads the KPI cards + Sales section **for the currently selected window (Part A)** and writes a short plain-language read: what moved, notable anomalies, and what to act on. It must state the window it analyzed (e.g. "Month to date").
- **Trigger: a manual "Generate insights" button** (matches the existing AI-generate pattern in this app; avoids an AI call on every tab load). Disabled while offline or mid-request; show a spinner/last-generated state. **[FLAGGED DEFAULT — confirm with Dylan: manual button vs auto-on-load. Manual chosen for cost/latency.]**
- Reuse `pec-metrics-ai.cjs` if its shape allows (extend it with a mode/param for the whole-tab read); otherwise add a sibling endpoint following the same auth + `textFromMessage` pattern. Send it the computed metric values for the window, not raw tables. The model may summarize but must not invent numbers not in the payload.
- No customer-facing surface. Internal only.

## PART C — Job Costing "Office notes" field (commit 3)

A distinct, clearly labeled **Office notes** box on the costing detail (`openCostingDetail` / `renderUnifiedJob`), separate from the existing `pec_prod_job_costing.notes` (leave that column and any current use untouched).

- Migration adds to `pec_prod_job_costing`: `office_notes text`, `office_notes_by text`, `office_notes_at timestamptz`. Additive/idempotent.
- Editable by anyone who can open the costing detail (Job Costing is admin-only today, and Anne's account has it — confirm her access is on; do not change permissions). On save, stamp `office_notes_by` (current user display name) and `office_notes_at` (now), and render "Last edited by {name}, {date}" under the box.
- Save through the existing costing save path (`saveCostingField` or the same patch mechanism the detail uses). **Gate the read + the patch key on the column existing in the select row** so a pre-migration deploy cannot 400 the costing save (same defensive pattern prompt 32 used for `crew_notes`).
- Internal only — never appears on any customer surface.

## PART D — Declutter Job Costing detail (collapsible sections) (commit 4)

Condense the costing detail by grouping its blocks into **collapsible sections** (accordion cards). Nothing is removed; sections just tuck away.

- Group into: **Materials**, **Labor**, **Subcontractors**, **Bonus**, **Revenue** (map to whatever the detail renders today — grep `renderUnifiedJob`/`openCostingDetail` for the current block order first). Keep a compact **profit summary** (GP, GP/hr, REV/hr, $/sqft) always visible at the top, outside the collapsibles.
- Default state: summary open; detail sections **collapsed** except the one most-used for data entry (Labor) — confirm with Dylan if unsure, but ship with Labor open, rest collapsed.
- Collapse state is view-only (no persistence needed). Pure layout/CSS + toggle; **do not change any costing math, save logic, or field wiring.** This part must be a diff of markup/CSS and a small toggle handler only.

## PART E — Bonus 2-week lock + callback flag + reversal with audit trail (commit 5)

Three linked pieces on the bonus/payout flow.

### E1 — Hard 2-week lock (no override)
- A bonus becomes payable only when `now() >= pec_prod_jobs.completed_at + interval '14 days'` for its job. Before that it is **locked**: the "mark paid" / payout action is disabled everywhere it appears (`renderCrewBonus`, `renderBonusReport`, bonus handout/payout path). **Hard block — no admin override.**
- If `completed_at` is null for a job, treat the bonus as locked and show "awaiting completion date" (do not let a null silently unlock it).
- Show the unlock date on each locked bonus ("Unlocks {date}"). This is a gate on **payout**, not on computing/approving the bonus (approval in costing is unchanged).

### E2 — Callback flag for manual review
- Detect a callback tied to the bonus's job (a callback job whose `original_job_id` = the bonus's `job_id`, and/or the parent job's callback flag — use whichever the schema check in Preflight proves authoritative). If a callback exists, the bonus is **flagged for manual review** regardless of the 14-day timer: surface it prominently in the Bonus Report with a "Callback — review before paying" state.
- Flagged bonuses are held (payout disabled) until someone records a review decision. Add a minimal review step: **Pay in full / Reduce (enter amount) / Void**, capturing `reviewed_by`, `reviewed_at`, and a `review_note`. No automatic math — the person decides.
- Migration: add to `pec_prod_job_bonuses`: `review_status text` (null | 'flagged' | 'released' | 'void'), `reviewed_by text`, `reviewed_at timestamptz`, `review_note text`. Additive/idempotent. (Derive the "locked" state at read time from `completed_at`; only the callback-review decision needs persistence.)

### E3 — Reverse a paid bonus, with audit trail (the wood-job clawback tool)
- Add a **"Reverse payout"** action on any bonus that has a `pec_bonus_payouts` row, in the Bonus Report (and costing bonus card if that is where payouts are marked). Reversing **does not delete** the payout: it records the clawback and marks the bonus unpaid-with-history.
- Migration: add to `pec_bonus_payouts`: `reversed_at timestamptz`, `reversed_by text`, `reversal_reason text`. Reversal sets these three; the row stays. The Bonus Report shows the bonus as "Paid {date} · Clawed back {date} — {reason}" so history is visible. A reversed payout no longer counts as paid in totals, and the bonus returns to payable/locked/flagged per E1/E2.
- Require a non-empty `reversal_reason`. Admin-only.
- This is the tool Dylan uses to claw back the wood-job bonus after deploy (see handoff). Build it generic; do not hard-code any job.

---

## Tests / verification (required)
- `node --check` clean on any changed/added Netlify function.
- All inline index.html script blocks parse clean (module-aware extraction; validate the importmap as JSON).
- `help/whats-new.json` validates. **Add What's New entries** (newest first) for: Metrics time filters + AI insights; Job Costing office notes; the bonus 2-week hold + callback review + payout reversal. Customer-facing copy — **zero em dashes**.
- Add a small fixture/unit check for the lock predicate (completed_at + 14d vs now, and null completed_at → locked) and for the reversal (reversed payout excluded from paid totals; row preserved).
- Grep-confirm office notes and bonus internals appear on **no** customer surface (proposal, portal, invoice, PDF).
- Zero em dashes in any customer/crew-facing string in the diff (What's New, any printed handout text).

## Commits
Five commits, in this order, each independently revertable:
1. `cowork: metrics time-window presets (MTD/YTD/4wk/custom)`
2. `cowork: metrics AI insights panel`
3. `cowork: job costing office notes field`
4. `cowork: declutter job costing detail (collapsible sections)`
5. `cowork: bonus 2-week lock + callback review + payout reversal`
Plus a docs commit (What's New, features.json updates for the changed features, PROJECT-LOG entry, this prompt moved to docs/archive/prompts/).

## After you finish — Handoff to Cowork
1. Apply these migrations to PROD (project "HQ Dashboard", zdfpzmmrgotynrwkeakd), each additive/idempotent:
   - `pec_prod_job_costing`: `office_notes`, `office_notes_by`, `office_notes_at`.
   - `pec_prod_job_bonuses`: `review_status`, `reviewed_by`, `reviewed_at`, `review_note`.
   - `pec_bonus_payouts`: `reversed_at`, `reversed_by`, `reversal_reason`.
   Then verify each column exists via information_schema and regenerate SCHEMA.md (CLAUDE.md rule 9).
2. Dylan deploys AFTER the migrations are live (the office-notes save and the bonus review/reversal writes reference new columns; deploying first would 400 those saves).

## After deploy — Handoff to Dylan
1. Confirm which of the paid bonuses is "the wood job" (candidates below), then use the new **Reverse payout** action on that bonus with a reason ("callback on wood job"). Verify it reads as clawed back and drops out of paid totals.
2. Spot-check: a job completed < 14 days ago shows its bonus **locked** with an unlock date; a job with a callback shows **flagged for review**; MTD loads by default on Metrics and the AI panel reads the selected window.
3. Run the git commit for the PROJECT-LOG entry + this prompt (the Cowork cloud sandbox cannot commit).

### Paid-bonus candidates for the wood-job clawback (as of 2026-07-19, all paid 2026-07-15, payroll 2026-07-17)
Brandon Campos, Brian Wirick, Cory Poole, Jeff Walker, Jon Loyd, Michelle Herod, Mike Long. None of the customer names read as "wood," so Dylan must identify which job it is before reversing. (Largest single bonus: Mike Long, $413.58, install 2026-07-02.)
