# Prompt 75: deep links and new-tab navigation, ordering line fixes, estimate view visibility

Scoped by Cowork 2026-08-07 with Dylan, after 14 scoping questions and live read-only queries against prod (zdfpzmmrgotynrwkeakd). Everything in "Verified facts" was queried during scoping. Re-verify anything you are about to depend on, and flag drift.

Prompt 74 shipped hours before this was written (commits ad6f381 through a6ca169). Start from current `main`. The estimate detail page and the estimate send paths were both touched by 74, and Part E of this prompt edits the same region.

---

## 0. Read this first: what is NOT in scope

**Estimate view tracking already exists and works.** Prompt 44 shipped `logEstimateView` (`pec-public-estimate.cjs`, around line 1537), the `pec_estimate_views` table, the user-agent bot filter, the shared bell row, and the "Viewed N times" line on the estimate detail (`renderEstimateDetail`, index.html around 28464 and 28641). It is live: 10 view rows across 3 estimates, most recent 2026-08-07 02:25 UTC. **Do not rebuild any of it.** This prompt adds Slack, a per-rep bell, a bigger detail block, and a pipeline badge on top of it.

**Do not add view counts to the job detail page.** Dylan's original ask said "job detail," but when asked he chose estimate detail only. The job detail page gets no view UI in this build.

**Do not touch the drip engine, prompt 73's instant touch, or the prompt 74 send gate.**

---

## 1. Verified facts (queried 2026-08-07, prod)

### 1.1 The dashboard has no per-record URLs

- `pecSyncHistory` (index.html ~7987) pushes and replaces history entries with **`location.href` unchanged**. The state tuple is `{view, openJobId, openInvoiceJobId, openCustomerId, openUnifiedJobId}` (`pecNavTuple`, ~7969). Back and Forward work; the address bar never changes.
- `popstate` (~7999) restores that tuple and re-routes with the `pecIsPopstate` guard.
- `switchView(v)` is at ~8022. It clears both modal roots, sets `state.view`, calls `pecSyncHistory()`, and hands `ordering` / `catalog` to the sibling production root.
- Rows and cards are `<div onclick>` / `<button>` elements, not anchors. Ctrl-click, middle-click, and "copy link address" do nothing anywhere in the CRM.
- **There is exactly one deep-link precedent:** `/?appt=<id>` at index.html ~7223, consumed once via `window._pecApptDeepLinkDone`, sets `state.view = 'appointments'` and `state.openAppointmentId`. **This link lives in Google Calendar event descriptions, so it is an external contract. It must keep working byte-for-byte.**
- **Query params already in use on this page:** `?portal=<token>` (customer portal mode, index.html 2192 and 37385), `?staff=1` (suppresses portal view logging, 37394), `?view=prescott` (legacy: clicks the outer prescott-crm tab once the shell is up, 37445), `?appt=<id>`.
- **The CRM lives inside an outer tab.** `?view=prescott` exists because the shell has tabs and the CRM is one of them (`#rdSidebarNav .tab-btn[data-tab="prescott-crm"]`). Any deep link must open that outer tab before it sets a CRM view.
- The customer portal keeps its own `location.hash` routing and is explicitly skipped by `pecSyncHistory` and the popstate handler (`body.pec-portal-mode`).

### 1.2 The Bryan Smith ordering bug, root-caused

Job: `pec_prod_jobs.id = 58ec3097-6579-4e00-857c-a64d24eda220`, customer "Bryan Smith", proposal/deal `3027370`, install 2026-08-10, status scheduled. CRM job: `jobs.id = 3783eaf8-fd49-4ad9-b134-115fcb668236`.

Its five saved `pec_prod_material_lines` rows (all created 2026-08-06 14:12, none manual_added, none ordered):

| idx | type | product | color | cure | qty |
|---|---|---|---|---|---|
| 0 | Basecoat | Simiron 1100 SL - Light Gray | Light Gray | (null) | 5 |
| 1 | Flake | Wombat Flake | Wombat | (null) | 7 |
| 2 | Flake | **Standard Flake** | **Per-job pick** | (null) | **1** |
| 3 | Topcoat | Simiron Polyaspartic 2gal Kit | Clear Gloss | **Slow** | 9 |
| 4 | Topcoat | Simiron Polyaspartic 2gal Kit | Clear Gloss | **(null)** | **1** |

**There is only ONE 1100 SL line.** Dylan remembered the duplicate as 1100 SL; the actual duplicate is the topcoat (rows 3 and 4), plus a phantom flake line (row 2).

The CRM job card has three `job_areas` rows:

| area | sqft | flake_product_id | basecoat_product_id | topcoat_cure_speed | is_change_order |
|---|---|---|---|---|---|
| Full Flake Garage Floor - 3 Bays | 1823 | Wombat | 1100 SL | Slow | false |
| Full Flake Floor - Workshop | 236 | Wombat | 1100 SL | Slow | false |
| **Add Striping** | **100** | **null** | **null** | **null** | **true** |

"Add Striping" is a change order for painted stripes. It needs no epoxy. But it carries the flake `system_type_id`, so the plan builder treats it as a 100 sqft flake floor and emits a full slot-default material set: a flake line with no color picked (which resolves to the catalog's `Standard Flake` product whose `color` value is literally `Per-job pick`) and a topcoat line with no cure speed.

Those lines never fold into the real ones because the aggregation SKU key is <code>`${product_id}|${cure_speed}`</code>, and blank cure is not Slow. The key appears in `aggregateMaterialPull` (index.html ~38903) and `mergeRecalcLines` (~39024). The basecoat DID merge, because every area's basecoat cure is null.

Relevant code path: `calcAreasInputFor` (~38764) chooses CRM job card areas (`state.crmAreasByProdJob`) over `pec_prod_areas`; `crmPlanAreas` (~37998) shapes them; `computeMaterialPlan` (~37755) builds the plan; `makePullCalcLines` (~38799) memoizes; `resolveJobLines` (~38841) picks saved over calculated and applies the colors-confirmed gate; `mergeRecalcLines` (~39023) merges on Recalculate.

`Per-job pick` is a **real catalog color value**, not a bug in itself. It is read at index.html 16023, 16065, 31906, 33558, 37981 (`if (payload.color === 'Per-job pick') return null;`) and 39903-39905 (ordering stamps the picked blend name over it). Do not rename the catalog product.

### 1.3 Estimate views, live numbers

| estimate | status | sent | views | first | last |
|---|---|---|---|---|---|
| 102066 | sent | 08-05 19:38 | 4 | 08-05 19:40 | 08-07 02:25 |
| 102035 | accepted | 07-31 20:09 | 3 | 07-31 20:09 | 07-31 22:41 |
| 102046 | accepted | 08-05 16:13 | 3 | 08-05 16:34 | 08-05 17:22 |

Five estimates have ever been sent; 14 exist. **At this volume a bare "3+ views = hot" rule flags every estimate anyone opens.** That is why the hot rule below is count AND recency, both tunable in Settings.

### 1.4 The bell has no per-user targeting

`pec_notifications` columns today: `id, type, job_id, body, priority, created_at, read_at, target_view, target_id`. **There is no user column.** Every row is shared: `refreshBell` (index.html 6361) loads all rows, `notifTarget` (6383) routes clicks, `renderBellPanel` (6413) draws them, and `read_at` is a single shared column. Sending a notification to one salesperson requires a schema change (Part D2).

### 1.5 Salesperson identity chain

`estimates` has **no** `salesperson` column. The rep lives in the intake jsonb:

`estimates.intake->>'salesperson_id'` -> `pec_sales_team_members.id` -> `.auth_user_id` -> `admin_users.auth_user_id` -> `admin_users.id`

Both live reps resolve cleanly today: Aron Bronson (`c893da3f-…`, admin `bca092d9-…`) and Dylan Nordby (`2add1f35-…`, admin `92c5061b-…`). Every sent estimate carries a `salesperson_id`. `intake->>'salesperson_name'` carries the display name and is what `renderEstimateDetail` already shows.

### 1.6 Slack

`SLACK_OFFICE_WEBHOOK` (#epoxysales, channel `C09AZE8CU0Z`) is already imported in `pec-public-estimate.cjs:61` and used by `notifyOffice` (line 959, Slack block at 995) for accepted / change / declined. `SLACK_LEADS_WEBHOOK` exists from prompt 73 and is NOT used here.

---

## 2. Dylan's locked decisions

1. **Deep links cover records AND nav.** Job rows, estimate rows, lead cards, estimate cards on the pipeline, customer rows, global search results, and the left rail items all become real links.
2. **The address bar shows a shareable URL** for whatever you are looking at, so a link can be pasted into Slack and land a teammate on the same record. Follows the `/?appt=<id>` precedent.
3. **Change-order areas never auto-generate material lines.** If a change order truly needs material, someone adds the line by hand on the order sheet.
4. **A blank cure speed inherits the job's cure speed** so the lines merge. Genuinely different explicit cure speeds stay separate.
5. **An area with no flake color picked renders a row that reads "Flake color not chosen"** with no product and no quantity, and it cannot be checked off as ordered.
6. **Slack proposal-view alerts go to #epoxysales** on the existing office webhook.
7. **Every single open fires Slack.** Not first-per-day. Dylan was shown that one customer opened an estimate twice in a day and chose every open anyway.
8. **The salesperson who sold it also gets an in-app bell**, personal to them. No Slack DM, no SMS, no @-mention.
9. **View counts stay on the estimate detail only**, made louder. No job-detail view UI.
10. **Hot = repeat views, recently.** Both thresholds live in Settings (defaults: 3 or more views AND last view within 48 hours). Going quiet cools it off automatically.
11. **The pipeline corner is an eye icon plus count, turning into a flame when hot.** Deliberately distinct from the existing AI Hot/Warm/Cold lead-score badge, which is untouched.
12. **The schedule quick look's customer name links to the job detail when a CRM job exists, and renders as plain text when it does not** (manual "+ Add Job" entries). Never create a record from a read-only popup.
13. On what he actually saw when material lines "did not populate": **he does not remember**. Fix the duplicates and harden the path so it cannot silently come up empty (Part C4).

---

## 3. Part A: deep links and new-tab navigation

### A1. URL scheme

Pick ONE param for the view and one id param per record kind. Proposed, adjust only with a logged reason:

```
/?v=jobs&job=<uuid>
/?v=estimates&estimate=<uuid>
/?v=leads&lead=<uuid>
/?v=customers&customer=<uuid>
/?v=invoicing&invoice=<uuid>
/?v=schedule
/?v=ordering
/?appt=<uuid>            <- UNCHANGED, existing external contract
```

**Use `v`, not `view`.** `?view=prescott` is a live legacy link that clicks the outer CRM tab (index.html 37445) and must keep working. Do not overload it.

`v` values are the existing `state.view` keys. An unknown or unpermitted `v` falls back to the default view rather than erroring.

### A2. Boot

Extend the existing deep-link block at index.html ~7223 (keep `?appt=` handling exactly as is, including the `_pecApptDeepLinkDone` once-only guard):

1. Read `v` and the id params.
2. If `v` is present, ensure the outer prescott-crm tab is open. Reuse the retry-click pattern at 37445 rather than inventing a second one, or better, factor that pattern into one helper both call.
3. Set `state.view` and the matching open-id (`openJobId`, `openCustomerId`, `openInvoiceJobId`, `openUnifiedJobId`, or whatever the estimate and lead detail panes actually key on; read the code, do not assume).
4. Respect permissions: a deep link to `costing` for a user without `can_view_job_costing` lands on the default view with a toast, never a blank panel. Mirror `notifTarget`'s gating.
5. Consume once, so a later re-render does not re-open a record the user navigated away from.

### A3. Make the address bar follow navigation

`pecSyncHistory` currently passes `location.href`. Build the URL from the tuple instead, and pass it to `replaceState` / `pushState`. Rules:

- Portal mode still bails first (`body.pec-portal-mode`).
- Preserve unrelated existing params on the URL you build (do not strip `?staff=1` or anything a future link adds).
- The dedup key stays the same, so a filter change or a re-render still does not stack entries.
- `popstate` currently trusts `e.state`. A pasted URL or an entry with no state must be handled: fall back to parsing the URL with the same reader Part A2 uses.

### A4. Anchors

Every clickable record row or card gets a real `<a href="…">` wrapping (or becoming) the clickable element, with the existing click handler kept and this guard:

```js
if (e.defaultPrevented) return;
if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // let the browser open a tab
e.preventDefault();
// existing in-app navigation
```

Surfaces, all of them:

- Jobs list rows (`renderJobs`)
- Estimates list rows
- Customers list rows
- Sales Pipeline: **both card shapes** (lead cards and the prompt-62 estimate cards, `renderLeads` / `estimateCardHtml`)
- Global search results (`#rdSearch` result rows, all four groups)
- The left nav rail items (`#pecSubnav` buttons and the flyout group items) get an href to `?v=<view>`, keeping their button behavior for a plain click
- The schedule quick look customer name (Part B)

### A5. Sanity rules

- Do not put an `<a>` around something already inside another `<a>`.
- Anchors must not change the visual design. Set `color:inherit;text-decoration:none;display:block` (or `contents` where layout depends on it) and verify no card shifts.
- Keyboard: an anchor is focusable, so tab order changes. Make sure the pipeline board and the jobs list are still sane to tab through, and that Enter activates the same navigation.

---

## 4. Part B: the schedule quick look customer name

`openJobQuickLook(jobId)` (index.html ~31860) is the read-only popup opened from Pending cards, Next Day cards, run-sheet cards, the Touch-ups panel, and the calendar bars. It operates on `pec_prod_jobs`.

Dylan wants the customer's name in that popup to open the job detail.

- Build a `state.crmJobIdByProdJob` map in the SAME fetch that already builds `state.crmPhoneByProdJob` and `state.crmAreasByProdJob` / `state.crmColorsConfirmedByProdJob` (see index.html ~33653, ~33866, ~38326). Do not add a second round trip and do not query inside the popup.
- When a CRM job id exists: render the name as an anchor to the job detail URL from Part A. Clicking closes the modal (via `closeModal`, `#pecModalRoot`, per the two-modal-roots rule) and routes in-app. Ctrl-click opens a new tab and leaves the modal alone.
- When it does not exist (manual `+ Add Job` entries, `dripjobs_deal_id IS NULL`): plain text, exactly as today. **Do not create a CRM job from a read-only popup.**
- Use whichever detail surface the Jobs page's own row click uses today. Read the code and match it; do not guess between `openJobId` and `openUnifiedJobId`.

---

## 5. Part C: ordering line fixes

### C1. Change-order areas contribute nothing

An area with `is_change_order = true` produces **zero** material lines.

- Filter at the plan-input layer (`crmPlanAreas` / `calcAreasInputFor`), not inside `computeMaterialPlan`, so the pure calculator stays a pure calculator and the estimator side is untouched.
- Check whether the `pec_prod_areas` path has an equivalent flag. If it does not, say so in the log entry rather than inventing one.
- A job whose ONLY areas are change orders resolves to "no lines" with a clear skip reason, not a silent empty.

### C2. Blank cure speed inherits the job's cure speed

At plan-build time, before lines are generated: for each cure-bearing slot, an area with a null cure speed adopts the job's dominant non-null cure speed for that slot (most common; ties break by lowest `order_index`). If no area on the job has a cure speed, everything stays null, exactly as today.

- Do this in the plan input, **not** by changing the SKU key. The key <code>`${product_id}|${cure_speed}`</code> is used in `aggregateMaterialPull` AND `mergeRecalcLines` AND the pull; changing it would silently re-pair existing saved lines.
- Two areas with two DIFFERENT explicit cure speeds still produce two lines. That is correct.

### C3. "Flake color not chosen"

For a non-change-order area with no flake color picked (no `flake_color_id`, and either no `flake_product_id` or one that resolves to the catalog color `Per-job pick`):

- The order sheet renders a row reading **"Flake color not chosen"** with no product name, no quantity, and no cost.
- That row cannot be checked off as ordered or delivered (disable the controls, with a title explaining why).
- The job shows a "flake color not chosen" warning chip in the Jobs-to-order list, alongside the existing colors-confirmed chip.
- **Do not rename the catalog product or its `Per-job pick` color value.** This is a rendering and orderability rule on the ordering side only. Leave 31906, 33558, 37981 and 39903-39905 alone unless a change is provably required, and justify it if so.

### C4. Prove the populate path, and make failure legible

Dylan cannot recall whether the job never appeared, appeared with no lines, or only filled in after Recalculate. So:

- `resolveJobLines` already returns a `{kind:'skipped', reason}` for every hold-out (colors not confirmed, no areas, calculator error, no lines produced). Make sure **the Ordering page surfaces that reason on the job row**, not only the Pull modal's summary. A job that produces nothing must say why, on screen, in one short sentence.
- Re-run the Bryan Smith job (`58ec3097-6579-4e00-857c-a64d24eda220`) after the fix. Expected: **four** lines (1100 SL basecoat, Wombat flake, one merged Slow polyaspartic topcoat, and no striping-derived rows). Report the before and after quantities in the log entry. The two junk rows are unordered and undelivered, so `mergeRecalcLines` deletes them as stale.
- Do not mass-fix other jobs' saved lines. Fix the generator; let Recalculate handle each job when someone touches it.

---

## 6. Part D: Slack on every proposal view, plus a bell for the rep

### D1. Slack

In `logEstimateView` (`pec-public-estimate.cjs`), after the `pec_estimate_views` insert and the existing bell logic:

- Post to `SLACK_OFFICE_WEBHOOK` on **every** logged open (the bot-UA filter above already runs; keep it).
- Gate it on a new setting `estimate_view_slack_enabled` (default `'true'`), read in the same `settings` fetch that already pulls the two `estimate_view_*` keys. Rule 12.
- Message content: customer name, estimate number, price, the salesperson's name, which open this is ("3rd view"), how long since it was sent, and a link. Compute the ordinal from a count query on `pec_estimate_views` for that estimate (the row you just inserted is included).
- Best-effort, exactly like `notifyOffice`: wrapped, logged on failure, never breaks the customer page and never blocks the render.
- The staff `?preview=` branch never reaches `logEstimateView`. Confirm that is still true after prompt 74's changes and note it.
- Keep the existing `estimate_view_notify_first_per_day` throttle applying to **the bell only**, as it does today. Slack is every open. Say so in the settings help text so the two switches are not confused.

### D2. Per-rep bell (needs a migration)

Migration `supabase/migrations/2026-08-14_prompt75_notification_targeting.sql` with an `@artifacts` header per rule 13:

- `pec_notifications.target_user_id uuid NULL REFERENCES admin_users(id) ON DELETE SET NULL`
- an index on `(target_user_id, created_at desc)`

Behavior:

- `NULL` means shared, exactly as every existing row. **Existing rows must keep showing for everyone**, so the filter is "target_user_id IS NULL OR target_user_id = me".
- The bell loader applies that filter client-side in its query. `read_at` stays a single shared column; a personally-targeted row read by its owner is fine.
- **This is a filter, not a security boundary.** RLS still lets any staff row read the table. Do not describe it as private, and do not put anything sensitive in a targeted body.
- On a view, resolve the rep through the chain in 1.5 (`intake->>'salesperson_id'` -> `pec_sales_team_members` -> `auth_user_id` -> `admin_users.id`). If any hop fails, **skip the personal row silently**; the shared bell row and Slack still fire.
- Type `estimate_viewed_rep`, `target_view: 'estimates'`, `target_id: est.id`, so `notifTarget`'s existing estimates branch routes it with no change.
- Per-rep rows are NOT subject to the first-per-day throttle unless the shared bell is; keep the two consistent and state which you chose.

---

## 7. Part E: estimate detail, louder

In `renderEstimateDetail` (index.html ~28464 for the query, ~28641 for the render), replace the one-line footer with a proper block:

- A stat reading "Viewed 4 times", the first open, and the last open, with relative times ("last opened 3 hours ago").
- The individual opens listed (cap at 10, newest first, date and time).
- A Hot chip when the shared hot rule (Part F1) is met, with a tooltip stating the rule in plain language.
- "Not opened yet" as an explicit, muted state for a sent estimate with zero views. A draft that was never sent says nothing at all.
- Keep the existing best-effort guard: a query error hides the block rather than breaking the page.
- No em dashes anywhere a customer could see. This block is internal, but the estimate page is one file away, so keep the habit.

---

## 8. Part F: pipeline corner badge

### F1. The shared hot rule

One helper, used by Part E and Part F both:

```
hot = viewCount >= estimate_hot_min_views AND lastViewedAt >= now - estimate_hot_window_hours
```

Two new settings keys, both surfaced in Settings > Estimates next to the existing view-notification switches (rule 12):

- `estimate_hot_min_views`, default `'3'`
- `estimate_hot_window_hours`, default `'48'`

Insert-only seeding, like every other settings migration in this repo.

### F2. The badge

- A small corner chip on the pipeline card: an eye icon and the view count. When the hot rule is met, the eye becomes a flame and the chip takes the hot color.
- **Leave the existing AI Hot/Warm/Cold lead score badge (`leadScoreBadge`) completely alone.** Two badges coexist on purpose: one says how good the lead looks, the other says the customer is reading the proposal right now. Make them visually distinct enough that nobody reads them as the same signal.
- Applies to the prompt-62 **estimate cards** and to **lead cards that carry a sent estimate** (the Draft chip logic already links a lead to its estimates; reuse that join, do not invent a second one).
- Zero views, or an estimate never sent: no chip at all. An empty eye icon is noise.
- Hovering shows "Viewed 4 times, last 3 hours ago".

### F3. Data loading

- One aggregate over `pec_estimate_views` for the estimate ids already on the board, folded into `loadLeadsData`. **No per-card query.** If the board later grows past a few hundred estimates this must still be one round trip.
- Best-effort: if the query fails, the board renders with no chips, never an error.

---

## 9. Acceptance criteria

**Part A**

1. Ctrl-click (Windows) and Cmd-click (Mac) on a job row, an estimate row, a customer row, a pipeline lead card, a pipeline estimate card, a global search result, and a nav rail item each open a new tab that lands on that exact record or view.
2. Middle-click does the same.
3. A plain left click behaves exactly as it does today: no page reload, no flash.
4. The address bar updates as you navigate, and pasting the URL into a second browser (signed in as staff) lands on the same record.
5. `/?appt=<id>` still opens the Appointments calendar with that appointment's modal.
6. `/?view=prescott` still opens the CRM tab.
7. `/?portal=<token>` still renders the customer portal and is untouched by any of this.
8. Back and Forward still walk CRM views, including after arriving from a pasted URL.
9. A deep link to a permission-gated view, opened by a user without that permission, lands on the default view with a toast.
10. Pipeline cards can still be dragged between columns. Verify this specifically; wrapping a draggable card in an anchor can hijack the drag with the browser's native link drag.

**Part B**

11. The schedule quick look on a DripJobs-sourced job shows the customer name as a link; clicking it closes the popup and opens the job detail; ctrl-clicking opens it in a new tab with the popup still open.
12. The quick look on a manual `MANUAL-` job shows the name as plain text with no dead click.

**Part C**

13. Bryan Smith (`58ec3097-…`) recalculates to four lines, with one polyaspartic topcoat line and no "Standard Flake / Per-job pick" row.
14. A job whose only area is a change order shows a clear reason on the Ordering page instead of an empty order sheet.
15. An area with a real flake color picked is unaffected.
16. A job with two areas at two different explicit cure speeds still produces two topcoat lines.
17. A "Flake color not chosen" row cannot be checked off as ordered.

**Part D**

18. Opening a sent estimate's public link posts one message to #epoxysales naming the customer, the estimate number, the price, the rep, and which open it is.
19. Opening it twice posts twice.
20. An SMS or email link preview does NOT post (bot UA filter).
21. The salesperson on the estimate sees a personal bell notification; another staff member does not see that row, but both still see the shared one.
22. Every pre-existing notification row still appears for every user.
23. Turning `estimate_view_slack_enabled` off stops Slack and leaves the bell alone.

**Part E / F**

24. The estimate detail shows the count, first open, last open, and the list of opens.
25. An estimate meeting the hot rule shows the Hot chip on the detail and a flame chip on its pipeline card; one that has gone quiet past the window shows the count with an eye, not a flame.
26. Changing `estimate_hot_min_views` in Settings changes both surfaces with no deploy.

**Everything**

27. `npm test` green, with new fixtures for the cure-speed inheritance, the change-order exclusion, and the hot rule.
28. `SCHEMA.md` regenerated after the migration. `features.json` updated. What's New entries appended.

---

## 10. Landmines

1. **`?view=prescott` and the outer tab.** The CRM is inside a tab; a deep link that only sets `state.view` will render behind a hidden panel and look like a blank page. Open the tab first. And do not reuse the `view` param name.
2. **Two modal roots.** The quick look uses `openModal` / `#pecModalRoot`. Do not migrate it, and do not add a competing close path (CLAUDE.md).
3. **Drag versus anchors on the pipeline.** Native link dragging will fight the kanban drag-to-advance. Test it before calling Part A done.
4. **The SKU key is load-bearing in three places.** Fix cure speed in the plan input. Changing <code>`${product_id}|${cure_speed}`</code> would silently re-pair every saved line during the next Recalculate, which is exactly the class of bug prompt 56 already cost a day to.
5. **`Per-job pick` is real catalog data**, not a placeholder string to delete. Six code sites read it.
6. **`pec_notifications` is a shared table with a shared `read_at`.** `target_user_id` is a display filter. Never describe it as private and never rely on it for access control.
7. **Every-open Slack includes staff who open the raw public link** in a signed-out browser (the preview route is separate, but the raw `/e/<token>` is not). Dylan chose every open knowing the volume; if that turns noisy the setting is the escape hatch, not a code change.
8. **The migration needs an `@artifacts` header** (rule 13) declaring the column and the index.
9. **Prompt 74 shipped hours ago** and rewrote parts of the estimate detail render and all three send paths. Rebase on latest `main` and re-read the region before editing Part E.
10. **`state._calcCache`** memoizes calculated lines per job and is cleared only by `loadJobs` / `loadCatalog`. Any change to the plan inputs must invalidate it, or the ordering page will keep serving the old lines within a session.

---

## 11. Housekeeping

- **features.json**: update "Estimate view tracking" (Slack, per-rep bell, louder detail block), "Sales Pipeline board" (view chip), "Material ordering" (change-order exclusion, cure inheritance, not-chosen rows, on-row skip reasons), "Notifications" (targeting), "Slack notifications" (estimate viewed). Add ONE new feature entry for deep links and shareable URLs, since it is a platform capability nothing else documents.
- **SCHEMA.md**: regenerate after the migration; note the new column and index on `pec_notifications`.
- **What's New** (`help/whats-new.json`), user-facing, no em dashes. Candidates: opening records in a new tab and sharing links, Slack alerts when a customer opens a proposal, seeing how many times a proposal was opened, and the ordering fix for change orders. Internal-only items (the notification column) get nothing.
- **Settings surfaces** (rule 12): `estimate_view_slack_enabled`, `estimate_hot_min_views`, `estimate_hot_window_hours`, all in Settings > Estimates.
- **Commits** per standing rule 1, one per part where it makes sense. **PROJECT-LOG entry** at the top per rule 2, written for a human.

---

## 12. Open items needing Dylan during the run

Nothing blocks the build. Two things worth a one-line confirmation if you have him:

- The URL param names in A1 (`v`, `job`, `estimate`, `lead`, `customer`, `invoice`). Once these are pasted into Slack threads they are effectively permanent, so name them once and correctly.
- Whether the per-rep bell should also fire for Dylan on estimates he did not sell. Current spec: no, only the rep on the estimate, plus the shared row everyone already sees.
