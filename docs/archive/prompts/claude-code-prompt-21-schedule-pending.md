# Build Prompt 21: three Job Schedule fixes (rail flyout z-index, pending job card modal, pending panel height)

## Context

Repo: /Users/dylannordby/Claude-Code/HQ-Dashboard. Single-file dashboard, index.html. Builds 18, 19, 20 are on main. Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first.

Three fixes, all on the Job Schedule page (`renderSchedule`, index.html ~18600 onward). Item 1 is a real defect users hit right now (the rail flyout is the primary navigation and it renders behind content); ship it FIRST as its own commit. Items 2 and 3 are enhancements to the Pending Jobs aside.

Line numbers below are from recon at the time of writing and drift as the file is edited. Every anchor comes with a search string. Re-anchor before you edit; do not trust a bare line number.

## Task 1 (ship first, own commit): rail flyout renders behind page content

Symptom: the build-19 icon-rail flyout submenu (`.rd-crm-flyout`) opens BEHIND the Job Schedule pending cards instead of on top.

Root cause, confirmed, not a guess: `#rdSidebar` (search `#rdSidebar {`, ~index.html:776) is `position:sticky` (~:793) with NO `z-index` (so `z-index:auto`). `position:sticky` ALWAYS creates a stacking context. The flyout is built inside the sidebar (`fly.className = 'rd-crm-flyout'`, search that string, ~:5174) and its `z-index:3000` (search `.rd-crm-flyout {`, ~:897) is therefore TRAPPED inside the sidebar's stacking context. It only outranks the sidebar's own children. The sidebar precedes `#rdMain` in the DOM (`build()`, sidebar appended before main), so any positioned element in main paints over the whole sidebar subtree, flyout included. Each pending card is emitted with an inline `position:relative` (search `pec-sched-pcard" style="position:relative`, ~:18654), which is exactly such an element. Calendar event bars (`.pec-cal-event-bar { ... z-index:2 }`), tasks, and holidays (z-index:3) are the same latent hazard.

So the flyout's z-index NUMBER is correct (3000 sits above the +Add popover at 40 and dropdowns at 30, below modals at 10000). The number is not the problem. The trapped stacking context is.

Fix: PORTAL the flyout to `document.body`. It is already `position:fixed`, so appending it to `document.body` instead of inside the sidebar makes its `z-index:3000` compete at the ROOT, above everything in main and below modals. Chosen over "give `#rdSidebar` a z-index" deliberately: hoisting the entire sidebar subtree is a bigger blast radius than the flyout needs, and portaling fixes the whole CLASS of bug (any future positioned element in main) rather than this one instance.

Requirements:
- The flyout still positions correctly relative to its rail icon (it is `position:fixed` with computed top/left; make sure the coordinates are viewport-relative now that the parent is body, not the sidebar).
- It still opens, closes on outside click and Escape, closes on selecting an item, and closes/repositions on scroll and resize (a body-portaled fixed element does not move with the rail if the rail scrolls; verify the rail does not scroll independently, and if it can, reposition or close on that scroll).
- Clean up on unmount: a flyout appended to body must be removed when it closes, not orphaned. No leaked nodes accumulating on repeated opens.
- Keyboard nav and aria from build 19 survive the move.

Acceptance: open any rail flyout while on the Job Schedule page with pending cards visible. The flyout paints ON TOP of the cards and the calendar. Repeat in 3-week mode. No visual regression to the flyout's position or the rail.

Commit this alone (`nav: portal rail flyout to body so it escapes the sidebar stacking context`), then move on.

## Task 2: click a pending card to open a read-only job card modal

Today the Pending Jobs cards (search `pec-sched-pcard`, render ~:18654-18664) show the customer name as plain non-clickable text. Only the `+ Schedule` button (`data-schedule-job`) and the `×` remove button (`data-hide-pending`) do anything.

Build a NEW, READ-ONLY job card modal, opened by clicking a pending card. A new modal, not a reuse of `openScheduleModal` (that IS the scheduler; a quick look should not be one input away from rescheduling) and not `openCostingDetail` (cost-focused, has editable margin fields, admin-shaped). A quick-look card should not be able to accidentally edit or schedule anything.

The card shows, read-only:
- Identity: customer name, service address, proposal / quote number, revenue.
- Job: system (with its color dot, dominant system per the rule build 20 standardized if the job has multiple areas), total sqft, estimated hours.
- Scope / notes: the job's scope or notes text. This is NOT on the pending card today; pull it from the job (`notes`) and/or the linked estimate's scope. If both exist, show the estimate scope; if neither, omit the section cleanly (no empty header).
- Context: sales team, current status, and the reschedule history (the amber "N days owed" and `rescheduled_from` line) WHEN it applies.

Data: the pending card already has the `pec_prod_jobs.id` (`data-schedule-job="${j.id}"`). Everything above is reachable from `state.prodJobs`, `state.systemTypes`, `state.productAreasByJob`, `state.scheduleDays`, `state.crews`, and the estimate link, all already loaded by `loadScheduleData` / `loadProdCore`. Do not add a new fetch if the data is already in state; if scope requires the estimate and it is not in state, fetch just that one row.

Modal plumbing: reuse `openModal(html, { onMount })` (search `function openModal`, ~:7217) and `window.pecCloseModal` (~:7236). Per the Architecture Gotchas in CLAUDE.md, `openModal`/`closeModal` use `#pecModalRoot`; this is the right root for a helper-driven modal, so use it and do NOT hand-roll into `#prodModalRoot`. The card carries a `+ Schedule` action that closes it and calls `openScheduleModal(id)`, so the path from look to schedule still exists, just not by accident.

Click behavior: the WHOLE card is clickable (bigger target). The `+ Schedule` button and the `×` remove button keep their own handlers and must `stopPropagation` so they do not also open the card. Give the card `cursor:pointer` (it is `cursor:default` today, search `.pec-sched-pcard {`) and a hover state. Keyboard: the card is focusable and opens on Enter/Space (it is an interactive element now).

Acceptance: clicking a pending card opens the read-only modal with every applicable field; clicking + Schedule opens the scheduler instead; clicking × removes the card; none of the three trip each other. Nothing on the modal can edit or persist anything.

## Task 3: pending panel stretches to the calendar height, then scrolls internally

Desired behavior, Dylan's words reconciled into one rule: when there are FEW pending jobs the panel hugs its content (it can be shorter than the calendar); when there are MANY, the panel height is CAPPED at the calendar's actual height and the pending list scrolls INSIDE that, without adding a second page scrollbar. One rule delivers both: `max-height = calendar height`, natural `height = content`.

What fights this today:
- `.pec-sched-grid { display:grid; grid-template-columns:280px 1fr; align-items:start }` (search `.pec-sched-grid {`, ~:23817). `align-items:start` sizes each grid item to its content, so the aside can never relate to the calendar's height. The calendar (the `1fr` main column) defines the grid ROW height; the aside just needs to be allowed to see it.
- `.pec-sched-pending { ... max-height:75vh; overflow-y:auto }` (search `.pec-sched-pending {`, ~:23831). The hard `75vh` is viewport-relative and unrelated to the calendar: it truncates a short 1-week calendar and overshoots a tall 3-week one. This is the number to replace.
- The `<details class="pec-sched-aside-details">` wrapper (search that class) is the actual grid item and has no height/flex rules, so even with stretch the inner panel inherits nothing.

Approach (CSS-only preferred, no JS height measurement if the grid can do it):
- On `.pec-sched-grid`, allow the aside to relate to the row height. `align-items:stretch` (the default) makes both columns share the row height the calendar sets. If removing `align-items:start` regresses anything else in that grid, scope the change.
- Make the `<details>` wrapper a full-height flex column: `min-height:0; display:flex; flex-direction:column` (and let it fill the stretched row).
- On `.pec-sched-pending`: replace `max-height:75vh` with the flex pattern that caps at the parent (the stretched wrapper) and scrolls past it: `flex:1 1 auto; min-height:0; overflow-y:auto`, and NO fixed max-height. Because the wrapper's height is now the calendar's height (via the stretched grid row) and `min-height:0` lets a flex child shrink below content, the list scrolls internally exactly when it exceeds the calendar, and hugs its content when shorter.
- If a pure-CSS grid-stretch cannot achieve "cap at calendar height, hug when short" cleanly (grid row stretch can force the short case to fill rather than hug), then measure the calendar column's height and set the aside's `max-height` to it via a ResizeObserver, recomputed on mode toggle (Week vs 3 weeks) and on window resize. State in the log which path you took and why. Prefer CSS.

Do NOT change the responsive collapses: the `@media (max-width:720px)` rule that turns the aside into a `<details>` drawer (search `pec-sched-aside-details` in the media query) and the `@media (max-width:900px)` single-column fallback (~:23818) must be unaffected. This stretch behavior is DESKTOP two-column only.

Acceptance: with 3 pending jobs and a 3-week calendar, the panel is short (hugs the cards) and there is no scrollbar. With 20 pending jobs and a 1-week calendar, the panel height matches the calendar and the list scrolls inside it, with no second page scrollbar. Toggle Week vs 3 weeks and confirm the cap tracks the new calendar height. Both mobile breakpoints still collapse as before.

## Guardrails

- Do not touch the pricing engine, estimator, comps, or the nav structure beyond the flyout portal in task 1.
- No em dashes anywhere (standing rule 6).
- What's New entries (standing rule 9) for the pending card modal (users can click a pending job to see its details) and arguably the panel height (nicer schedule layout). The z-index fix is a bug fix; a one-line entry is optional, use judgment.
- Commit per standing rule 1: task 1 alone first, then task 2, then task 3 (three commits, bisectable). Update PROJECT-LOG.md per standing rule 2. Run `npm test`; all index.html script blocks must parse; em-dash scan on added lines.

## After

Append a PROJECT-LOG.md entry (By: Claude Code) covering: the flyout portal (and confirmation that the trapped-stacking-context class of bug is now closed, not just this instance), the new job card modal and why it is a fresh read-only modal rather than a reuse, and whether the panel height is pure CSS or ResizeObserver-driven and why. Then a plain-English note to Dylan on the z-index root cause: the flyout's z-index was never too low, it was locked inside the sticky sidebar's own stacking context, so no number would have lifted it above the page until it was moved out to the document body.
