# Claude Code Prompt 39: Schedule UX polish + CompanyCam in the scheduler

Three small, related Dylan requests on the production Job Schedule. All decisions below are LOCKED (Cowork scoped them with Dylan on 2026-07-20). Do exactly this scope, nothing more. Follow CLAUDE.md standing rules (commit boundaries, PROJECT-LOG entry, What's New entries, no em dashes in customer-facing text, token discipline). All work is in `index.html`.

Ship as ONE session but keep THREE clean commits (features are independent; the lightbox change is shared/global, so it is its own commit):
1. `schedule: highlight today in the +Schedule and Add Job day pickers`
2. `schedule: click a job name in Pending + Next Day to open the quick-look`
3. `photos: CompanyCam gallery in the +Schedule modal + zoom-into-photo in the lightbox`

---

## FEATURE 1 — Highlight today (current day) in the schedule day pickers

**Why:** When Dylan opens a job to schedule it, the month day-picker gives no visual anchor for "today," so he can't quickly orient. The main Week/3-week calendar grid already highlights today (`renderScheduleCalendar` ~ index.html:22071, `.day-c.today`); this brings the same idea to the two modal day-pickers. Do NOT touch `renderScheduleCalendar` — it is already correct.

**Style (locked):** an OUTLINE RING on today's cell (colored border, no fill), so it still reads clearly even when that cell is also `.selected` (selected cells have an accent FILL today). Not a fill, not a chip, not just bold.

**Where — both month pickers share the exact same cell markup:**
- `openScheduleModal` picker cell: index.html ~22971
  `return \`<div class="day-cell ${inMonth?'':'dim'} ${idx>0?'selected':''}" data-pick="${iso}" ...>`
- `openAddJobModal` picker cell: index.html ~23510 (identical line)

**Do:**
1. In BOTH cell-render lines, add an `is-today` class when `iso === isoDate(new Date())` (use the existing `isoDate` helper so it matches the app's date logic; the picker already builds `iso` per cell).
2. Add CSS next to the existing day-cell rules (index.html ~27629-27632):
   ```
   .pec-day-grid .day-cell.is-today { border-color: var(--rd-accent, var(--accent)); box-shadow: inset 0 0 0 1px var(--rd-accent, var(--accent)); }
   ```
   The double border (border + inset shadow) keeps the ring visible on a `.selected` cell whose background is the accent fill; verify the ring is legible in BOTH light and dark mode and on a selected+today cell. Adjust the ring color/contrast if it disappears on the accent fill (e.g. use a white inset ring when the cell is also selected: `.day-cell.selected.is-today { box-shadow: inset 0 0 0 2px #fff; }`).

**Acceptance:** Open +Schedule on any pending job and open Add Job. Today's cell shows a ring. Navigating months with the picker's prev/next keeps the ring only on the real today. A day that is both selected and today shows both the fill and a legible ring.

---

## FEATURE 2 — Click a job NAME to open the brief quick-look (two surfaces) + fix the live "nothing happens" bug

**What Dylan wants:** clicking a job's NAME on (a) the Pending Jobs panel and (b) the Next Day run sheet opens the existing read-only quick-look card `openPendingJobCard(jobId)` (index.html:22795). "Job detail" here means that BRIEF quick-look (proposal, revenue, system, sqft, hours, status, scope) — NOT the costing detail.

**IMPORTANT — diagnose first (Bug Diagnosis Workflow).** Dylan reports that on the LIVE site (prescottepoxy.netlify.app), clicking a Pending Jobs card does "nothing at all." But the whole-card handler was shipped in commit 06cd3a6 (2026-07-14) and `index.html` has no uncommitted changes, so the code IS on `main`. Before writing new code:
1. Confirm whether live is actually serving 06cd3a6 (Netlify deploy could be behind un-pushed commits — the log shows several Cowork handoffs waiting on Dylan to push). If live is stale, that alone explains it; say so and tell Dylan to push/redeploy.
2. If live IS current, find the real reason the `[data-open-pcard]` click does nothing: e.g. an exception thrown earlier in `renderSchedule` (between the `innerHTML` at ~21895 and the handler binding at ~21994) that aborts before the listeners attach; the pending `<details>` panel; a CSS overlay swallowing clicks; or `openPendingJobCard` early-returning because `state.prodJobs` lacks the row. Name the root cause with a file:line and give Dylan a one-line DevTools/console way to confirm, then fix it.

**Then implement the name click on both surfaces:**

Pending Jobs panel (`renderSchedule`, card markup ~21905, name is `<h4>${esc(j.customer_name)}</h4>` at ~21907):
- Keep the current whole-card → quick-look behavior (locked: "name opens detail, card keeps quick-look").
- Make the NAME read as clickable: `cursor:pointer` + hover underline on the `<h4>`. It opens the same `openPendingJobCard(j.id)`. (The whole card already does; the point is the name must visibly afford a click.)

Next Day run sheet (`renderNextDay`, job `cardHtml` ~21432, name is `<strong ...>${esc(j.customer_name || '(no name)')}</strong>`):
- Today the name is plain text with no handler, so clicking does nothing (matches Dylan's report). Wrap the name in a clickable element (`cursor:pointer`, hover underline, `role="button"`, `tabindex="0"`), carrying `data-open-pcard="${esc(j.job_id)}"` (the underlying `pec_prod_jobs` id; `openPendingJobCard` looks up `state.prodJobs.find(j => j.id === jobId)`, so pass the job id, NOT the schedule-day id).
- Wire a click handler that calls `openPendingJobCard(dayRow.job_id)` and **`e.stopPropagation()`** so it does not interfere with the card's drag. The cards are `draggable="true"` and have `dragstart`/drop handlers (~21701+); a plain click on the name must open the quick-look while a drag on the card body still moves it. Do NOT make the name a drag handle. Also handle Enter/Space for keyboard (mirror the pending panel's pattern at ~21997).
- Task cards (`taskCardHtml` ~21445) are NOT jobs — leave them unclickable.

**Acceptance:** On live-equivalent build: clicking a name in the Pending panel opens the quick-look; clicking a name on a Next Day job card opens the same quick-look; dragging a Next Day card between crews/slots still works and does not open the quick-look; the +Schedule and x buttons on pending cards still work (they already `stopPropagation`). Root cause of the original "nothing happens" is fixed or (if a deploy gap) clearly reported to Dylan.

---

## FEATURE 3 — CompanyCam photos in the +Schedule modal + zoom-into-photo in the lightbox

Two parts. Part B (lightbox zoom) is a shared/global change and its commit also improves the existing job-detail gallery.

### 3A — Read-only CompanyCam gallery in `openScheduleModal`

**Data-model gotcha (important):** `companycam_project_id` lives ONLY on `public.jobs` (SCHEMA.md:344, the `jobs` table). The scheduler modal runs off a `pec_prod_jobs` row (`state.prodJobs`), which has NO `companycam_project_id`. The reliable bridge between the two tables is `dripjobs_deal_id` (present on both; see the established pattern in `renderDashboard` ~ index.html:7547-7551 where install dates are joined `installByDeal[dripjobs_deal_id]`). Use that same bridge: for the modal's job, look up the matching `public.jobs` row by `dripjobs_deal_id` to get `companycam_project_id`. Manual jobs have `dripjobs_deal_id = null` and will not resolve — that is the no-project case below.

**Reuse, do not reinvent.** The job-detail gallery already does exactly the fetch + render + zoom you need:
- Section markup: `#ccSection` / `#ccPhotos` at index.html ~12629-12643 (`.pec-gallery` grid of `.pec-gallery-item > img`).
- Fetch logic: `ccApi` + `showPhotos` at ~13920-13944, hitting `/.netlify/functions/pec-companycam?action=photos&project_id=...` with the signed-in Supabase access token in the `Authorization: Bearer` header.
- Click-to-zoom: `gal.querySelectorAll('img').forEach((img, idx) => img.addEventListener('click', () => openLightbox(fulls, idx)))` at ~13940.

**Do:**
1. In `openScheduleModal`, resolve `companycam_project_id` via the `dripjobs_deal_id` bridge (one `supabase.from('jobs').select('companycam_project_id').eq('dripjobs_deal_id', job.dripjobs_deal_id).maybeSingle()` when `job.dripjobs_deal_id` is set; guard `res.error` per the supabase-js empty-vs-error gotcha in CLAUDE.md).
2. Add a collapsed-by-default "Site photos (CompanyCam)" section to the modal body (view-only; do NOT add the project picker here — linking stays on job detail). Render photos with the SAME `.pec-gallery` / `.pec-gallery-item` markup and the SAME `openLightbox(fulls, idx)` click wiring as job detail. Keep it out of the way of the scheduling controls (place it below the day-picker/segment-notes area).
3. **No linked project (locked: "show a link prompt"):** when the job has no resolvable `companycam_project_id`, show a short line "No CompanyCam project linked" plus a "Link a project" action. Simplest honoring of Dylan's choice without cluttering the scheduler: the action opens that job's full job detail focused on the CompanyCam section (where the existing type-to-search picker already writes `companycam_project_id`). If wiring a cross-navigation is heavy, an acceptable fallback is a one-line note "Link a CompanyCam project from the job's detail page" — but prefer the actionable button. Edge case: if there is NO matching `public.jobs` row at all (a manual `pec_prod_jobs` entry with null `dripjobs_deal_id`), there is nowhere to store the link; show the note only and mention in your log that manual jobs can't link CompanyCam until they have a `public.jobs` sibling.
4. Silent degrade on proxy error / logged-out / no photos, exactly like job detail (show the muted empty/unavailable states, never throw).

**Acceptance:** Open +Schedule on a DripJobs-sourced job that has a linked CompanyCam project → its photos show; clicking one opens the lightbox. Open +Schedule on a job with no linked project → the "No CompanyCam project linked" + link prompt shows, no errors. No project picker appears in the scheduler modal.

### 3B — Zoom INTO a photo (magnify + pan) in `openLightbox`

**Why:** Dylan: the fullscreen viewer works, "but i need to be able to click zoom further onto the pictures." Today `openLightbox` (index.html:7473) only fits the image to screen and uses wheel/swipe to PAGE between photos (~7501-7517). There is no way to magnify a single photo to inspect detail.

**Do — add single-photo zoom to `openLightbox` (benefits both the job-detail gallery and the new scheduler gallery, since both call it):**
- Add a zoom level (e.g. 1x default up to ~4x) applied to the `<img>` via CSS transform scale.
- Desktop: wheel zooms the CURRENT photo when engaged; double-click toggles zoom in/out at the cursor point; when zoomed >1x, drag to pan. Reconcile with the existing wheel-pages-between-photos behavior: when at 1x, wheel keeps paging (current behavior); when zoomed in, wheel adjusts zoom and does not page. Alternatively add explicit +/− (and a reset) controls and reserve wheel for zoom — your call, but preserve the ability to page between photos at 1x via arrows/keys/swipe.
- Touch: pinch-to-zoom and drag-to-pan when zoomed; single-finger swipe still pages at 1x.
- Reset zoom to 1x whenever the photo changes (`show(n)`), on open, and offer a quick way back to 1x (double-click or a reset button).
- Keep Escape-to-close, backdrop-click-to-close (only when NOT mid-pan), arrow/key nav, and the count indicator working.
- CSS lives at index.html ~636-643 (`.pec-lightbox`, `.pec-lightbox img`). The image currently uses `max-width/height:100%`; you'll need it to allow transform scaling and overflow panning without breaking the fit-to-screen default. Add `cursor: zoom-in` at 1x / `grab`(→`grabbing`) when zoomed for affordance.

**Acceptance:** In BOTH the job detail gallery and the +Schedule gallery, open a photo, zoom in (wheel/double-click on desktop, pinch on touch), pan around the magnified image, reset to 1x, and still page to the next/prev photo at 1x. Nothing regresses in the existing viewer (close, backdrop, arrows, keys, swipe, count).

---

## After (per CLAUDE.md)

- **What's New (help/whats-new.json):** these are staff-facing UI changes, so add entries (newest first, plain language, no em dashes, 2-3 how-to steps). Reasonable to combine into 2 entries: one "See today at a glance when scheduling + tap a job name for a quick look," one "Job site photos while you schedule, with zoom." Keep them short and non-em-dashed.
- **PROJECT-LOG.md:** append ONE entry at the TOP, `By: Claude Code`, describing what shipped per feature with the 3 commit SHAs, the root cause you found for the Feature-2 "nothing happens" report (deploy gap vs live bug), and any handoff (e.g. if live was stale and needs Dylan to push/redeploy). Note the manual-job CompanyCam-link edge case if relevant.
- **features.json:** update the "Job Schedule calendar" and "Reschedule / pending flow" entries if their anchors/behavior changed; the CompanyCam-in-scheduler is worth a one-line note on the "Job Schedule calendar" entry (new tables touched: reads `jobs.companycam_project_id` via the `dripjobs_deal_id` bridge; proxy `pec-companycam`).
- No migrations, no schema changes, no new Netlify functions (reuse `pec-companycam`). No secrets.
