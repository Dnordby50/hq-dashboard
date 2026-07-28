# Prompt 57: schedule colors, shared job popup, sq footage, ACH pending, 12hr times, settings nav, flake condense, People+Users merge

Eight items from Dylan, one session, one commit per part. Parts A through E are display-only and carry no migration. Part F adds one column. Part G is the risky one (catalog data model). Part H touches the auth surface. Take them in order; if a later part fights you, stop and log rather than half-landing it, because A through E are worth shipping on their own.

Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first. Consult features.json for anchors and SCHEMA.md before writing ANY SQL. Do not read index.html end to end.

Every line number below was verified against `main` at the time of writing. If a line has drifted, find the function by name and keep going; do not treat a drifted line number as a blocker.

---

## Decisions already locked (Dylan answered these; do not re-litigate)

1. Crew color lives in a new `pec_prod_crews.color` column, edited with a color picker in the crew modal.
2. The system-type color becomes a thin stripe across the TOP of the bar. Crew color owns the bar fill.
3. Crew colors apply to the Job Schedule calendar, the Next Day board, AND the printed run sheet.
4. Sq footage falls back to `jobs.sqft` via the existing `jobEffectiveSqft` helper when a job has no `pec_prod_areas` rows.
5. The read-only job popup gets more fields AND becomes reachable from every schedule surface (calendar bars, Next Day cards, Pending cards).
6. Settings tabs get a horizontal scroll strip, not wrapping and not a dropdown.
7. BusyBusy punch times display as 12-hour with am/pm everywhere they appear, including the server-built anomaly detail strings.
8. Flake: the 18 identically-priced Torginol flakes collapse into ONE product. Obsidian, Autumn Brown, and Stonewash stay standalone because their cost or spread rate differs. Simiron Special Flake rows stay standalone.
9. The flake-to-basecoat pairing moves from the product record to the COLOR record.
10. Retired flake products are deactivated, never deleted, so historical costing still resolves.
11. Settings > People and Settings > Users merge into one People tab. Login, role, and permissions become a section on the person, with a Create login button for people who have none.

---

## PART A: Settings tab bar scrolls horizontally

**Problem.** `settingsTabBar` (index.html:16790) renders ten buttons in `display:flex` with no wrap and no overflow rule. On a window narrower than about 1150px the right-hand tabs (BusyBusy, Brand) are clipped and unreachable.

**Do this.**
- Add `overflow-x:auto; flex-wrap:nowrap; -webkit-overflow-scrolling:touch; scrollbar-width:thin;` to the flex container, and `flex:0 0 auto; white-space:nowrap;` to the buttons so they never squash.
- Add a small edge affordance so it is obvious there is more: a CSS mask or a gradient fade on the right edge when the strip is scrollable. Keep it cheap; a static `mask-image` is fine.
- Scroll the ACTIVE tab into view on render (`scrollIntoView({ inline: 'nearest', block: 'nearest' })` inside `wireSettingsTabs`, index.html:16806), so deep links like the birthday bell landing on People do not land on an off-screen tab.
- The `<strong>Settings</strong>` label should stay pinned and not scroll away. Either pull it out of the scrolling strip or give it `position:sticky;left:0` with a background.

**Acceptance.** At 900px window width every tab is reachable by horizontal scroll or trackpad swipe, the active tab is visible on load, and nothing is clipped at 1440px.

**Commit:** `settings: horizontal scroll for the tab bar so no tab is clipped on narrow windows`

---

## PART B: BusyBusy punch times in 12-hour format

**Problem.** `punchTime` (index.html:17445) is `(ts && ts.length >= 16) ? ts.slice(11, 16) : '?'`, a raw string slice of the ISO timestamp, so it prints `14:30`. It feeds the anomaly table at index.html:17458. Separately, `pec-busybusy-export.cjs` builds anomaly DETAIL strings that embed raw timestamps (the overlap message at line ~308 interpolates `started_at` and `ended_at` directly), so those show full ISO strings in the preview regardless of what the client formatter does.

**Do this.**
- Rewrite `punchTime` to render 12-hour with am/pm. The stored value is a timestamptz already converted to Arizona by `azTimestamp` in the export function, so do NOT re-timezone it; parse the `HH:MM` portion and format it, keeping the existing `'?'` fallback for short or missing values. A pure string transform is preferred over `new Date()` here, because `new Date()` on the stored value would shift it by the browser's offset.
- Do the same for the run of punch displays in the costing detail card and the costing queue if any render a raw time (check around index.html:29295 and index.html:30161, which build punch keys from `started_at` / `ended_at`; only change places that DISPLAY a time, never the dedupe keys).
- In `netlify/functions/pec-busybusy-export.cjs`, add a small `fmtPunch(ts)` helper and use it in every anomaly `detail` string that currently interpolates a timestamp. The stored `started_at` / `ended_at` values on the row objects stay untouched; only the human-readable `detail` text changes.

**Guardrail.** Do not touch `azTimestamp`, the stored column values, the dedupe key strings, or any comparison logic (`ended_at < started_at` stays a string comparison on the raw values).

**Acceptance.** Pull a BusyBusy window that has anomalies. Every time in the preview reads like `7:15 am` / `3:42 pm`. The overlap anomaly message reads in 12-hour too. Re-importing the same window produces byte-identical rows in `pec_prod_busybusy_time_entries`.

**Commit:** `busybusy: show punch times in 12-hour format in the import preview and anomaly messages`

---

## PART C: ACH pending shows on the job invoice

**This one is a display gap, not a data gap. The record already exists.** Verified live on 2026-07-28:

```
pec_stripe_pending:
  payment_intent pi_3TyH5685aAKLOAgM1DajHMTU
  job_id 35a79918-4eb6-488f-a4bb-2a185f630702  (Tiffany Muenks, $17,250 job)
  kind 'deposit', amount 8625, status 'pending', created_at 2026-07-28 19:56 UTC
```

The webhook wrote it correctly. `renderInvoicing` reads the table and renders an "ACH pending $X" chip on the AR list (index.html:9286-9318). `pecInvoiceSendKit` reads it to warn before dunning (index.html:10681). But **`renderJobInvoice` (index.html:10854) never queries `pec_stripe_pending` at all**, so the one screen Dylan opens to look at a customer's invoice shows a $8,625 deposit still fully unpaid with no sign a transfer is clearing.

**Do this.**
- In `renderJobInvoice`, add `pec_stripe_pending` to the existing parallel fetch block (it already batches installments and payments around index.html:10899). Select `id, payment_intent, kind, amount, status, failure_message, created_at` for this `job_id`, statuses `('pending','failed')`. Follow the existing error handling: a failed read degrades to zero pending and never blocks the page.
- Render pending in three places on that page:
  1. **Due now stat** (index.html:11030 area): when pending covers all or part of the ask, show the ask unchanged but add a sub-line under it: `$8,625 bank transfer clearing` in muted text. **Do NOT subtract pending from Due now.** An ACH can still bounce; the money is not yours until it settles, and silently zeroing the ask would hide a real receivable. Say so in a comment.
  2. **Payment schedule card**: on the installment the pending payment covers (match by `kind`, and for `kind='installment'` by amount against the current ask), show a muted "Bank transfer clearing" chip beside its status.
  3. **Payments card**: a pending row listed above recorded payments, styled muted and clearly not a payment yet, with the date it started and an expected-by note (3 to 5 business days from `created_at`).
- A `status='failed'` row renders the existing red treatment with `failure_message`, matching how the AR list already handles it.
- Reuse the AR list's copy where it exists so both screens say the same thing. The AR chip's tooltip is already written: "A bank transfer is clearing (3 to 5 business days). No need to chase this customer."

**No em dashes in any of this text. It is customer-adjacent and Dylan reads it daily.**

**Guardrail.** Do not write to `pec_stripe_pending` from the browser. Do not create a `pec_payments` row for a pending transfer; the webhook does that on settle and doing it here would double-count.

**Acceptance.** Open Tiffany Muenks' job invoice. The Due now stat still asks $8,625 with a "bank transfer clearing" sub-line, the deposit installment shows the clearing chip, and the Payments card lists the pending $8,625 started 7/28. The AR list chip is unchanged. Recording an unrelated manual payment on that job does not disturb any of it.

**Commit:** `invoicing: show pending ACH transfers on the job invoice, not just the AR list`

---

## PART D: sq footage that actually resolves

**Problem.** `openPendingJobCard` (index.html:27293) computes sqft as `areas.reduce(...)` over `state.productAreasByJob[job.id]` only. Most jobs in the system came from DripJobs and have no `pec_prod_areas` rows, so the row renders a dash. Meanwhile Job Costing already solves this with `jobEffectiveSqft(jobSqft, areaSqftList)` (index.html:8986), which prefers a manual `jobs.sqft` and falls back to summing areas, and `buildProdEstimateFacts` already loads `jobs.sqft` into `state.crmSqftByProdJob` (index.html:28987).

**Do this.**
- Add `sqft` to the return of `prodJobEstimateFacts` (index.html:29012), computed as `jobEffectiveSqft((state.crmSqftByProdJob || {})[jobId], (state.productAreasByJob[jobId] || []).map(a => a.sqft))`. Also return `sqftSource` (`'manual'` or `'areas'` or `null`) for the same reason the function already returns `systemSource`.
- Replace the local reduce in `openPendingJobCard` with `facts.sqft`.
- Show sq footage on the Next Day board cards and on the printed run sheet card, next to the system name line.
- Show it on the calendar bar tooltip (`title`) rather than in the bar text; the bars are already tight.

**Why the shared helper and not a second reduce:** the "three surfaces, one number" rule from prompt 55. Job Costing, the popup, and the board must never be able to disagree about a job's size.

**Acceptance.** A DripJobs-bridged job with `jobs.sqft` set shows that number on the popup, the Next Day card, and the run sheet, matching Job Costing exactly. A job with `pec_prod_areas` rows and no `jobs.sqft` shows the area sum. A job with neither shows a dash and does not throw.

**Commit:** `schedule: sq footage on the job popup, Next Day board, and run sheet via the shared helper`

---

## PART E: one read-only job popup, reachable from everywhere

**Problem.** Clicking a calendar bar calls `openScheduleModal` (the EDIT modal) at index.html:26901, 26930, and 26955. The read-only quick look (`openPendingJobCard`) is currently reachable only from the Pending cards and from a Next Day run-sheet card name (index.html:25476). Dylan wants a detail popup on Next Day and the same thing on the Job Schedule, meaning: one popup, richer, opened from every surface.

**Do this.**
- **Enrich `openPendingJobCard`.** Keep its existing rows (Proposal, Revenue, System, Total sqft, Est. hours, Sales team, Status, Reschedule, Scope) and add:
  - Crew, and the scheduled dates as a compact range with day count (`Aug 4 to Aug 6, 3 days`), read from `state.scheduleDays` for that job.
  - Customer phone with a `tel:` link, from the CRM bridge already resolved in state. If it is not in state, omit the row rather than firing another query.
  - Flake / basecoat / topcoat picks and flake size from `pec_prod_areas` when present, one line each, omitted when null.
  - The TOUCHUP badge for `is_callback` jobs, matching the calendar's sky blue.
- **Rename it.** It is no longer the "pending" card. `openJobQuickLook(jobId)` with a thin `openPendingJobCard` alias kept for one release so nothing breaks, or rename call sites in the same commit. Your call; say which you did in the log.
- **Wire every surface to it:**
  - Calendar bars: click opens the quick look. The Schedule button INSIDE the popup is the path to the edit modal (that button already exists at index.html:27341). This is a deliberate behavior change: a click no longer jumps straight into an editable form, which is how a stray keystroke has been one input away from changing a scheduled job.
  - Next Day cards: the whole card opens the quick look. **Preserve drag-to-move.** The card is draggable today, so bind on `click` only when no drag occurred (track `dragging` state or compare pointerdown/pointerup coordinates with a small threshold). A drag that ends on the card must not open a popup.
  - Pending cards: unchanged, they already call it.
- Keep it read-only. The only actions on it are Close and Schedule.

**Guardrail.** `openPendingJobCard` uses `openModal` / `#pecModalRoot`. Do not migrate it to `#prodModalRoot`. See the two-modal-roots gotcha in CLAUDE.md.

**Acceptance.** Clicking a bar on the week and 3-week calendar opens the read-only popup, not the edit form. Clicking a Next Day card opens it. Dragging a Next Day card between crews still works and opens nothing. The popup shows crew, dates, sqft, and material picks on a job that has them.

**Commit:** `schedule: one read-only job quick look, opened from calendar bars, Next Day cards, and Pending cards`

---

## PART F: crew colors with a system-type banner

**Problem.** Bars are colored by system type (index.html:26613: `color: isCallback ? '#0ea5e9' : ((sys && sys.color) || '#6366f1')`). Dylan reads the calendar to see who is where, so the bar fill should say CREW and the system should ride along as a banner. `pec_prod_crews` has no color column.

**Migration:** `supabase/migrations/2026-07-29_crew_colors.sql`

```sql
-- @artifacts
--   column: public.pec_prod_crews.color
-- @end
alter table public.pec_prod_crews add column if not exists color text;
```

Backfill the four existing crews with distinct, legible defaults in the same file (an `update ... where color is null` keyed by name, or by a deterministic ordering). Pick colors that are distinguishable from the callback sky blue `#0ea5e9` and from each other at small size and in dark mode.

**Do this.**
- Add a color picker to `openCrewModal` (index.html:20847): an `<input type="color">` plus a small palette of presets, saved into the `color` payload alongside name / active / notes.
- In `renderScheduleCalendar` (index.html:26527), the event `color` becomes the CREW color. Add a second value, `bannerColor`, holding the system color. Callbacks keep their sky-blue treatment and get no crew fill (a touch-up is not crew-scheduled work in the same sense); confirm that reads right and log it if you decide otherwise.
- Bar markup at index.html:26783 already sets `--ev-color`. Add `--ev-banner` and render a 4px full-width band along the top edge in CSS. Do NOT add a wrapper element; use a pseudo-element on the existing bar so the grid math is untouched.
- Next Day cards (`renderNextDay`, index.html:25170) and the run-sheet cards (index.html:26861) switch their `border-left` from system color to crew color and gain the same top banner in system color.
- A crew with no color set falls back to today's system color so nothing renders grey.
- **Legend.** Add a small crew color key to the calendar header. Without it this is a code nobody can read.

**Guardrail.** Do not change how `sys` is resolved. Do not touch `scheduleTotalDaysByJob` or any revenue proration. This is styling plus one column.

**Acceptance.** Each crew's jobs share a fill color across the week view, the 3-week view, the Next Day board, and the printed run sheet. The system color reads as a top band on every one of them. Changing a crew's color in Settings updates every surface after a reload. A job with no crew assigned still renders.

**Commit:** `schedule: color bars by crew with a system-type banner`

---

## PART G: condense the standard flake catalog

**This is the risky part. Read all of it before touching anything.**

**Current shape, verified live.** `pec_prod_products` holds 25 rows with `material_type = 'Flake'`: 21 Torginol named colors, 2 Simiron Special Flake rows, `Special Order Flake`, and `Standard Flake (color TBD)`. Of the 21 Torginol rows, 18 are identical on the numbers that matter (`unit_cost` 87.44, `spread_rate` 325, `kit_size` 1) and 3 are not:

| Product | unit_cost | spread_rate |
|---|---|---|
| Obsidian Flake | 120.00 | 300 |
| Autumn Brown Flake | 91.64 | 325 |
| Stonewash Flake | 87.44 | **300** |

**The complication.** Each of those 21 products carries its own `default_basecoat_product_id`, and the values genuinely differ (four distinct basecoats across the 21). Collapsing products to one would destroy that mapping, which is what auto-selects the right basecoat on an estimate. Dylan's answer: the pairing moves to the COLOR record.

**The second complication.** The estimator's flake dropdown (index.html:34256-34258) lists PRODUCTS and displays `p.color || p.name`, so today "pick a flake product" and "pick a color" are the same act. Collapse the products and the color names vanish from the picker unless the color becomes its own selectable thing. The `colors` table already exists and already holds 15 of these blends (`type='simiron'`, `category='flake-blend'`, with hex and a real Simiron SKU on each). It is missing six: **Garnet, Obsidian, Pumice, Schist, Stonewash, Wombat.**

**Migration:** `supabase/migrations/2026-07-29_flake_color_model.sql`

```sql
-- @artifacts
--   column: public.colors.product_id
--   column: public.colors.default_basecoat_product_id
--   column: public.colors.active
--   column: public.pec_prod_areas.flake_color_id
--   column: public.job_areas.flake_color_id
-- @end
```

The migration must:
1. Add `colors.product_id uuid references pec_prod_products(id)` (which product prices this color), `colors.default_basecoat_product_id uuid references pec_prod_products(id)`, and `colors.active boolean not null default true`.
2. Insert the six missing flake-blend colors with their hex values (derive hex from the existing rows' style; if you cannot source a real value, use a reasonable neutral and flag it in the log for Dylan to correct, do NOT invent a Simiron SKU).
3. Backfill `colors.default_basecoat_product_id` from each color's matching product's `default_basecoat_product_id`, matched on `products.color = colors.name` for Torginol flake products.
4. Backfill `colors.product_id`: Obsidian, Autumn Brown, and Stonewash point at their own surviving products; the other 18 point at the `Standard Flake (color TBD)` product (`8fb6d88d-33f3-4886-84d0-5e1eb8321509`), which is being repurposed as the single standard flake.
5. Rename that product from `Standard Flake (color TBD)` to `Standard Flake`, `color` from `TBD` to `Per-job pick`, matching how `Simiron Metallic Epoxy 3gal Kit` is already worded.
6. Add `flake_color_id uuid references colors(id)` to `pec_prod_areas` and to `job_areas`.
7. Backfill `flake_color_id` on both tables from the existing `flake_product_id` by matching the product's `color` to `colors.name`, so existing jobs keep showing the color they were sold.
8. Set `active = false` on the 18 collapsed products. **Do not delete them.** `pec_prod_areas.flake_product_id` and `job_areas.flake_product_id` still point at them on historical rows and must keep resolving.

Regenerate SCHEMA.md after the migration is applied.

**Code changes.**
- The estimator's flake picker (index.html:34256) lists COLORS (active, `category='flake-blend'`), not products. Selecting a color writes both `flake_color_id` and `flake_product_id` (set from `color.product_id`), so every existing downstream reader keeps working untouched. Quartz and Metallic Pigment pickers at 34263 and 34270 are NOT in scope; leave them exactly as they are.
- `defaultBasecoatByFlake` (index.html:34235, and the estimator's copy near 33233) resolves basecoat as: explicit `basecoat_product_id` wins, else the COLOR's `default_basecoat_product_id`, else the product's (legacy rows), else null. Keep the legacy leg so old areas still resolve.
- `computeJobEstimate` (index.html:33240 area) keeps reading `flake_product_id` for pricing. It should need no change at all. If it does, you have wired the picker wrong.
- The Catalog product list should show the collapsed flake as one row, and inactive products should stay hidden from pickers but visible in the catalog behind an "Show inactive" toggle if one does not already exist.
- The customer portal color picker reads `colors`; verify the six new rows do not break it and that `active=false` colors (none yet) would be excluded.

**Acceptance.**
1. Estimator: new estimate, flake system, the color dropdown lists all 21 blend names. Pick Domino, the basecoat auto-fills to the same basecoat it did before this change, and the material cost lands at the $87.44 standard.
2. Pick Obsidian: cost lands at $120 with a 300 spread rate, same as before.
3. Open an EXISTING estimate that used Wombat. It still shows Wombat, still prices at $87.44, and its saved basecoat is unchanged.
4. Job Costing on a historical job with a retired flake product still resolves the product name and cost (this is what proves the deactivate-don't-delete rule held).
5. Catalog: the Flake category shows 7 active products (Standard Flake, Obsidian, Autumn Brown, Stonewash, 2 Simiron Special, Special Order) instead of 25.

**If any acceptance item fails, revert this part's commit and log it. Do not ship a partial catalog migration.**

**Commit:** `catalog: collapse the standard flake products into one, colors carry the blend and its basecoat`

---

## PART H: merge Settings > People and Settings > Users

**Current shape.** `renderSettingsPeople` (index.html:17832) lists `public.people` rows with wage / commission / crew edited inline on the legacy tables. `renderSettingsUsers` (index.html:18850) is a permissions table over `admin_users` + `user_permissions` + `sign_in_log`, with `openTeamForm` (index.html:15671) for add/edit and a password reset flow. Per prompt 54, `people` is identity and `admin_users` is the auth record, mirrored by triggers.

**Do this.**
- One `people` tab. Remove the `users` tab button from `settingsTabBar` and route `state.settingsTab === 'users'` to the People renderer so existing deep links and the `data-opsTab` handler (index.html:18485) do not 404 into a blank view.
- Each person is one row. Opening a person (`openPersonModal`, index.html:18022) shows sections:
  - **Identity** (existing): name, preferred name, email, phone, birthday month/day, active.
  - **Roles** (existing): the three pointer columns, plus wage / commission / crew edited on the legacy tables exactly as they are today.
  - **Login** (new, admin only): if the person has an `admin_users` pointer, show role, the delegable permission checkboxes from `DELEGABLE_PERMS`, the Finalize costing checkbox with its admin-super-role semantics intact, linked auth status, and Reset password. If they do not, show a single **Create login** button that runs the existing `pec-create-staff` path and relies on the prompt-54 auto-adopt trigger to link the new `admin_users` row back to this person.
- Keep the sign-in log. It is a security surface and must not be lost in the merge; put it in a collapsed card at the bottom of the People tab.
- Keep the "Save permissions" bulk action working. If per-person editing makes a bulk save meaningless, replace it with a per-person save and say so in the log, but do not leave a button that silently does nothing.
- Non-admins see the People tab without the Login section and without the sign-in log. `renderSettingsUsers` is admin-gated today (index.html:18852); that gate must survive the merge at the SECTION level, not just the tab level.

**Guardrail.** Do not change the mirror triggers, `people_mirror_enabled`, `pec_people_merge`, or the merge-suggestions card. This is a UI consolidation. If you find yourself writing SQL for this part, stop and reconsider.

**Acceptance.** One People tab. A person with a login shows and can edit role and permissions there. A person without one gets a Create login button that produces a working account linked to the same person record (verify one row in `people`, not two). Permission changes still take effect. A non-admin sees the tab and cannot see or change login data.

**Commit:** `settings: merge Users into People so one person is one record end to end`

---

## Required for every part

- `npm test` green before every commit (25/25 as of prompt 55). Node-check every script block you touch.
- What's New entries in `help/whats-new.json`, newest first, per standing rule 11. Parts A through H are all user-visible except the server-side half of Part B. Plain language, 2-3 how-to steps, **no em dashes**. Suggested ids: `settings-tabs-scroll`, `busybusy-12hr-times`, `invoice-ach-pending`, `job-quick-look`, `schedule-crew-colors`, `flake-catalog-condense`, `people-users-merged`. Sq footage can fold into the `job-quick-look` entry.
- Update the affected `features.json` entries: Job Schedule calendar, Next Day Schedule and run sheet, Price & Material Catalog, Invoicing and accounts receivable, Stripe card and ACH payments, BusyBusy hours import, People directory and birthdays, Per-user permissions.
- One PROJECT-LOG.md entry at the TOP, `By: Claude Code`, covering all parts including anything you did not land and why.
- Migrations: `2026-07-29_crew_colors.sql` and `2026-07-29_flake_color_model.sql`, each with an `@artifacts` header. Both are WRITTEN, NOT APPLIED unless you can apply them safely; end the log entry with a `## Handoff to Cowork` listing exactly which migrations to run and in what order, and regenerate SCHEMA.md after.

## Open question for Dylan, do not decide it yourself

The `colors` table rows for these blends carry `type = 'simiron'` while the products carry `manufacturer = 'Torginol'`. Torginol makes the flake; Simiron is who PEC buys it through. Both may be right for different purposes, but the two tables currently disagree in a way that will confuse the next person. Flag it in the log entry as a naming question. Do not "fix" it.
