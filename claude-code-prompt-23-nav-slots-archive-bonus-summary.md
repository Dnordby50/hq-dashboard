# Build prompt 23: standalone Settings + Metrics rail slots, archive employees, per-employee bonus summary

You are Claude Code working in the HQ-Dashboard repo (single-file app, `index.html`). Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first, per standing rules. This prompt is self-contained; the recon below was done by Cowork on 2026-07-15 against `main` at commit 4899cd3. Verify each anchor before you touch it (line numbers drift).

Ship THREE features, each its own commit, in the order below (bisectable: nav first because it is smallest and has no migration; archive second; the bonus summary last because it is the largest). No em dashes anywhere. Standing rule 9 applies: every one of the three is user-facing, so each ships a What's New entry in `help/whats-new.json`.

---

## Recon (what already exists, so you build on it instead of duplicating)

- **The left rail is generated from a hidden `<nav id="pecSubnav">`**, not hand-built. Nav markup is at `index.html:2435-2464` (groups Overview / Sales / Production / Finance / Admin / Help; each `<button data-pec-view="...">`).
- **Rail builder** at `index.html:5060-5320`. It parses `#pecSubnav` into `railGroups`, renders one `.rd-crm-gbtn` per group with a hover `.rd-crm-flyout` submenu, and cloned rail buttons forward clicks to the source `#pecSubnav` button (`src.click()`, ~5235). Relevant config constants just above the loop: `RAIL_ICONS` (~5075, per-group SVG keyed by group label), `RAIL_RELABEL` (~5084), `RAIL_SECTION` (~5086), and **`RAIL_PIN` (~5089) = `{ docs:'Help' }`** which pins an item to a bottom rail row instead of a group. Active-state sync at ~5290-5317.
- **Both target views already exist.** `metrics` (nav `2438`, route → `renderMetrics` at `10162`, currently inside the Overview group) and `settings` (nav `2462`, route → `renderSettings` at `14384`, currently inside the Admin group, hard admin gate at `14386`). View routing is `switchView(v)` at `7076-7212`; the route table is the object literal at `7143-7165`.
- **Settings is a tabbed view**: General / Users / Email / Brand (`renderSettings` 14384, tabs dispatched ~14390). The **Team Members card** (the employee list) is `renderSettings` General at `index.html:14500-14528`, backed by table **`pec_prod_crew_members`** (loaded ~14400, cached `state.crewMembers`). It already renders an **Active** checkbox per member (`m.active`, ~14517), wage (`hourly_wage`, ~14516), crew, BusyBusy link flag. Active write path ~14606; wage ~14590; insert ~14572. `pec_prod_crews` (the Crews card, ~14481) also has `active`.
- **`active` is already used as a dropdown filter** at `19431`, `21940`, `22258` (`.filter(m => m.active !== false)`), so leave `active` doing that job. There is currently **no `archived` field** on `pec_prod_crew_members`. The `archived_at timestamptz` convention is already used elsewhere in the app for jobs/customers (e.g. `8219-8221`).
- **Bonus ledger = `pec_prod_job_bonuses`.** Fields: `id, job_id, crew_member_id, crew_member_name, hours_actual, amount, note, created_at`, plus the build-22 audit columns `suggested_amount, approved_by, approved_at`. Paid status via **`pec_bonus_payouts`** (`bonus_id, amount, paid_on, payroll_date`).
- **Bonus Report view = `renderBonusReport()` at `13909-14185`** (route `crew-bonus`, gated `can_view_job_costing` at `13911`). It has two tabs (`state.bonusReportTab`): Payouts (`14044-14105`) and Payroll report (`13993-14024`). It already groups by pay period (Friday `payroll_date`) then by crew member with subtotals (`13966-13980`, `14009-14020`). Pay-period helper is **`commissionPeriod(date)` (~13545)**; a per-crew "Paid this period" breakdown block is at `13961-14061`.
- **Labor budget helper** extracted in build 22: **`effectiveLaborBudget(job, sys)`** (labor-budget-with-fallback), used by `renderUnifiedJob` and the costing detail. **`computeCrewBonus`** (~21291) is the shared bonus math (wage x 1.25 burden, OT). Do NOT add a fourth bonus computation; reuse these.
- **Known identity gap (read before Feature 3 line items):** production metrics attribute by the free-text `pec_prod_jobs.crew_lead`; bonuses attribute by `pec_prod_job_bonuses.crew_member_id`. These are two different identities. Callback data (`renderMetrics`, callback rate) is keyed to `crew_lead` text, NOT to `crew_member_id`. This matters for the "learned / callbacks" line in Feature 2 (see that feature's guardrail).

---

## Feature 1 (commit 1): promote Settings and Metrics to their own standalone rail slots

**Decision (locked with Dylan):** both become their own top-level rail icons pinned at the BOTTOM of the rail near Help, and are REMOVED from their group flyouts so there is no duplication. Access is unchanged: Settings stays admin-only, Metrics keeps its current visibility. This is a nav-placement change only; do not touch `renderMetrics` / `renderSettings` content.

**Tasks:**
1. Give `metrics` and `settings` their own pinned bottom-rail slots. The cleanest lever is the existing `RAIL_PIN` map (`~5089`), which already pins `docs` to a bottom row. Extend it so `metrics` and `settings` are pinned too, each with its own icon and label, sitting at the bottom with Help. Order at the bottom: Metrics, then Settings, then Help (Help stays last). Confirm `RAIL_PIN` actually removes the item from its group flyout; if a pinned item still also renders inside its group flyout, make the flyout builder skip any `data-pec-view` present in `RAIL_PIN` so it appears once, at the bottom only.
2. Add rail icons for the two new pinned slots. Reuse a gear/settings glyph for Settings and a chart/bars glyph for Metrics (match the existing SVG style in `RAIL_ICONS`, ~5075). Keep labels "Metrics" and "Settings".
3. Preserve the admin gate. Settings is admin-only today via `.pec-role-admin` toggling (~6730-6753) and the hard gate in `renderSettings` (14386). The pinned rail slot for Settings must hide for non-admins exactly as the current Admin-group Settings button does. Verify a non-admin session shows neither a Settings rail icon nor a reachable route.
4. Active-state highlight must work for the pinned slots (the rail-to-`#pecSubnav` active sync at ~5290-5317). Clicking the pinned Metrics/Settings icon highlights it and no stale group icon stays lit.

**Acceptance:** On desktop, Metrics and Settings each appear as their own icon at the bottom of the rail (not inside Overview/Admin flyouts). Clicking each routes to the same view as before. Non-admin sees Metrics but not Settings. Mobile accordion still works (pinned items must still be reachable on mobile; if `RAIL_PIN` handling differs on mobile, verify the mobile path still lists them). No duplicate entries anywhere.

**Do NOT touch:** the contents of `renderMetrics` or `renderSettings`; any other group's icons; the `switchView` route table (the routes already exist).

**Note for Dylan (not a task):** Dylan asked to also expand what Metrics SHOWS ("metrics are the whole point of our own CRM"). That is a separate, larger build, captured as a wish-list in the PROJECT-LOG entry: per-employee performance, company-wide bonus/savings trend over time, and sales/conversion. Do not build it in this prompt. Feature 2 below already delivers the per-employee bonus trend in the summary handout.

---

## Feature 2 (commit 2): archive former employees

**Decision (locked):** a dedicated **Archive** action separate from the existing Active checkbox. Archived people move into a **collapsed "Archived" section** at the bottom of the Team Members card with a **Restore** button. The `active` checkbox keeps doing its current dropdown-filtering job (do not repurpose it). Archiving hides a person from ONLY two places: the Settings Team Members active list and the Feature 3 bonus-summary employee picker. It does NOT change bonus/costing dropdowns (those stay `active`-filtered), does NOT change Metrics, and does NOT alter any historical report. All past bonus/commission rows and totals stay intact.

**Schema:** add a nullable `archived_at timestamptz` to `pec_prod_crew_members` (matches the app's existing `archived_at` convention). Write the migration file under `supabase/migrations/2026-07-15_crew_member_archived_at.sql`; make it idempotent (`add column if not exists`). Per the do-not-touch-prod rule, WRITE and COMMIT the migration but do NOT apply it; it is a Cowork handoff (below). Client must be forward-compatible: `pec_prod_crew_members` is already loaded with a broad select, so treat a missing `archived_at` as "not archived" and gate the archive UI so it degrades cleanly pre-migration (if the update errors on an unknown column, surface a friendly "archive not available yet" rather than a crash).

**Tasks:**
1. Team Members card (`~14500-14528`): a member with `archived_at` set renders in a new collapsed "Archived (N)" section at the bottom, not in the main list. Main list = members where `archived_at` is null.
2. Add an **Archive** control on each active member row (an "Archive" button or a small icon; keep it visually distinct from the Active checkbox so they are not confused). On click, confirm, then `update({ archived_at: new Date().toISOString() }).eq('id', id)` and re-render. Follow the write-safety patterns already used for the wage/active updates in this card.
3. Add a **Restore** button on each archived row: `update({ archived_at: null }).eq('id', id)` and re-render back into the main list.
4. The "Archived" section is collapsed by default (a disclosure/expander); persist its open/closed state the same way other collapsibles in Settings do, or default-closed if there is no existing pattern.

**Acceptance:** Archiving a member removes them from the main Team Members list and the Feature 3 employee picker, drops them into the collapsed Archived section, and Restore brings them back. A past bonus report for a period the archived person worked still shows their rows and correct totals (history untouched). The bonus/costing crew-member dropdowns are unchanged by archiving (still governed by `active`). Pre-migration (archived_at column absent) the card still renders and does not crash.

**Do NOT touch:** the `active` checkbox behavior or the `.filter(m => m.active !== false)` dropdown filters; any historical report query; `pec_prod_crews`.

---

## Feature 3 (commit 3): per-employee bonus summary (in-app view + printable handout)

**Purpose (Dylan's words):** show each employee, per pay period, "where we won and where we learned" so they see the breakdown. Labor-savings bonus only (no commission in this view).

**Where it lives:** add a third tab to `renderBonusReport()` (`13909-14185`) alongside Payouts and Payroll report, e.g. `state.bonusReportTab === 'employee'`, labeled "Employee summary". Reuse the already-loaded bonus + payout + job-name data and `commissionPeriod` rather than re-fetching where possible. Same `can_view_job_costing` gate as the rest of the view. Do not add a new top-level nav slot for this.

**Controls:** an **employee picker** (crew members, EXCLUDING archived per Feature 2, i.e. `archived_at` null) and a **pay-period picker** (reuse the pay-period model already in Payouts/Payroll: Sun to Sat period keyed off the Friday `payroll_date`). Selecting an employee + period renders their summary.

**Summary contents (locked with Dylan):**
1. **Header trend strip** ("how are we tracking"): for the selected employee, show bonus earned this period vs recent prior periods (a small sparkline or a short row of the last ~6 periods) so it is obvious whether they are earning MORE bonus over time (getting better) or LESS (backtracking). Include a simple production-over-time read (e.g. hours or job count per period). Keep it compact; reuse `commissionPeriod` to bucket.
2. **"Where we won"**: the jobs in the period where this member earned a bonus. Per job line show: **job/customer name**, the member's **hours** (`hours_actual` on the bonus row), the job's **labor budget vs actual** (job-level, via `effectiveLaborBudget` and the actual-hours source the costing detail uses; label it clearly as whole-job so it is not mistaken for the member's own budget), and the member's **bonus dollars** earned on that job. Period bonus total at the bottom.
3. **Per-job wage comparison** (Dylan specifically wants this): for each won job, show the member's **standard wage** (base `hourly_wage` x their hours on the job) next to their **effective earnings with bonus** (wage x hours + bonus), and the **effective hourly rate** with bonus (`hourly_wage + bonus / hours`). This is the "see the difference" view. Use `computeCrewBonus` / existing wage fields; do not invent new math.
4. **"Where we learned"**: jobs in the period tied to this member that went **over budget** (actual labor exceeded `effectiveLaborBudget`, so little or no bonus) and any **callbacks / rework**. See the guardrail below on callback attribution.

**Callback attribution guardrail:** callbacks are keyed to `pec_prod_jobs.crew_lead` (free text), not to `crew_member_id`. Do NOT silently mis-attribute. Attribute a callback to the selected employee only where you can defensibly tie it to them (e.g. `crew_lead` matches this member's name, or they appear on that job's bonus/hours rows). If you cannot make a clean tie for a given callback, leave it out rather than guess, and if the attribution is weak across the board, render the callbacks sub-section with a one-line caveat ("callbacks shown are those where this member was crew lead"). Flag in your PROJECT-LOG entry exactly how you attributed them so Dylan knows the basis.

**Printable handout:** a "Print / Save PDF" button on the summary that produces a clean one-page-per-employee layout. Prefer a print-CSS approach (`window.print()` with a print stylesheet that shows only the summary card) over any new server/PDF infrastructure unless the repo already has a PDF generator wired for this kind of thing (check before adding a dependency). The printed sheet should carry the employee name, period, the won/learned breakdown, the wage comparison, and the period total.

**Acceptance:** picking an employee + period shows their won jobs (name, hours, budget vs actual, bonus $), the standard-wage-vs-wage+bonus comparison per job, a trend strip showing bonus direction over recent periods, and a "learned" section (over-budget jobs + defensibly-attributed callbacks). Print produces a clean one-page handout. Archived employees do not appear in the picker. Numbers reconcile with the existing Payouts/Payroll tab for the same person and period (do not double count paid vs earned; be explicit about whether the view is earned-in-period or paid-in-period and keep it consistent with how you label it).

**Do NOT:** add a fourth bonus computation; pull commission into this view; re-split or recompute the pool (reuse recorded ledger amounts and the shared helpers).

---

## Migrations (Cowork applies, do not apply from your session)

Only Feature 2 needs one: `supabase/migrations/2026-07-15_crew_member_archived_at.sql` adding `archived_at timestamptz` (nullable, `if not exists`) to `pec_prod_crew_members`. Additive, no RLS change. End your PROJECT-LOG entry with a `## Handoff to Cowork` section instructing Cowork to apply it to PROD (project "HQ Dashboard", zdfpzmmrgotynrwkeakd) and to capture the verifying select:
`select column_name from information_schema.columns where table_name = 'pec_prod_crew_members' and column_name = 'archived_at';` (expect 1 row).

Client must degrade gracefully if deployed before the migration lands (treat absent column as not-archived; do not crash the Team Members card).

## What's New (standing rule 9)

Append three entries to `help/whats-new.json` (newest first), plain language, no em dashes, 2-3 how-to steps each:
- Settings and Metrics now have their own buttons at the bottom of the left menu.
- You can now archive employees who have left, so old names drop off your team list (with Restore).
- New per-employee bonus summary you can pull up per pay period and print for each person.

## Verification (do before you call it done)

- `npm test` green (no engine math changed; this is UI + one additive column).
- `node --check` on every `<script>` block you touched and any changed function; `help/whats-new.json` parses.
- Em-dash scan of every added line (zero, except any pre-existing empty-value glyph the codebase already uses).
- Manually reason through: non-admin sees no Settings rail icon; archived member gone from list + picker but present in a historical report; a won job's wage-vs-bonus math ties to the ledger amount.

## PROJECT-LOG + commits

One commit per feature (`nav:`, `settings:`/`crew:`, `costing:`/`bonus:` prefixes), plus a docs commit for the log. Append ONE PROJECT-LOG.md entry at the top summarizing all three, with the Cowork migration handoff and the callback-attribution note. Record the Metrics-expansion wish-list (per-employee performance, bonus/savings trend, sales/conversion) as a "next build" pointer so it is not lost.
