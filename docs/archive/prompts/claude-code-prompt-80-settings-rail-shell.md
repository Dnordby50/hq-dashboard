# Prompt 80: Settings shell (rail, search, responsive, redirects)

Phase 1 of 2 on the Settings cleanup. **This prompt changes the container only. It does not move a single setting.** Every existing `renderSettings*` function keeps rendering exactly what it renders today. Prompt 81 does the content split, and it will be a manifest edit plus markup moves precisely because this prompt builds the mechanism.

Depends on prompt 79 (seeds `settings_rail_breakpoint_px`). Do not start until 79 is applied and verified.

**Files: `index.html` only. No migration. No schema change. No Netlify function change.**

---

## Why

`settingsTabBar` (index.html:18832) carries this comment:

> the strip scrolls horizontally on narrow windows (no wrap, no dropdown) with a static right-edge fade as the "there's more" affordance

A horizontal nav that needs a fade gradient to hint at hidden items is out of room at ten items. Prompt 81 will not reduce that count much, so the container has to change first. Settings currently exposes roughly 78 controls; at that size search beats navigation for anything touched less than weekly.

## The seam, and why you must not widen it

There are exactly 14 call sites, all following one shape:

```
root.innerHTML = settingsTabBar('<key>') + `<content>`;
...
wireSettingsTabs(root);
```

`settingsTabBar` is called at lines 18902, 19095, 19348, 19608, 20055, 20214, 20723, 20747, 21592, 23550, 23566, 23687, 23724. `wireSettingsTabs` is called at 18972, 19199, 19376, 19742, 20098, 20264, 20726, 20830, 21936, 23551, 23598, 23754.

**Keep both function names and both signatures.** Do not rename them, do not change what `settingsTabBar` returns structurally (a single string prepended to content), and do not edit the 14 call sites. Any approach that requires each call site to append a closing `</div>` is rejected: fourteen chances to leave a tag unclosed in a 2.6 MB file, for no benefit.

The two-column layout is produced by **DOM restructuring inside `wireSettingsTabs(root)`**, which every call site already invokes after setting `innerHTML`:

1. `settingsTabBar(active)` returns the rail markup as one element with a stable hook (e.g. `data-settings-rail`).
2. `wireSettingsTabs(root)` finds that element, collects every sibling after it, wraps those siblings in a `.pec-settings-content` div, and places rail + content inside a `.pec-settings-shell` flex/grid container.
3. Then it wires clicks, search and the resize handler as it does today.

Make `wireSettingsTabs` idempotent: if `.pec-settings-shell` already exists in `root`, skip the restructure. Some paths (the two "run the migration" early-return branches at 20723 and 23550, and 23687) render and wire in quick succession.

## Part A: the page manifest

Add a module-level array. **This is the artifact prompt 81 edits.** Everything else in the shell reads from it.

```js
const SETTINGS_PAGES = [
  // group: 'config' | 'records'
  { key: 'general',      label: 'General',      group: 'config',
    keywords: ['review link', 'referral', 'birthday', 'financing', 'labor burden', 'overtime', 'bonus', 'touch-up', 'metrics', 'upload'] },
  { key: 'people',       label: 'People',       group: 'config', keywords: ['users', 'logins', 'roles', 'crew members', 'sales team', 'sign-in'] },
  { key: 'email',        label: 'Email',        group: 'config', keywords: ['sender', 'from address', 'templates', 'test send'] },
  { key: 'appointments', label: 'Appointments', group: 'config', keywords: ['booking', 'reminders', 'google calendar', 'routemize', 'salesask'] },
  { key: 'drips',        label: 'Drips',        group: 'config', keywords: ['quiet hours', 'approval', 'instant reply', 'automation'] },
  { key: 'estimates',    label: 'Estimates',    group: 'config', keywords: ['line pricing', 'optional lines', 'gp floor', 'comps', 'proposal'] },
  { key: 'invoicing',    label: 'Invoicing',    group: 'config', keywords: ['deposit', 'payment schedule', 'installment'] },
  { key: 'presentation', label: 'Presentation', group: 'config', keywords: ['present mode', 'sections', 'gallery', 'reviews'] },
  { key: 'busybusy',     label: 'BusyBusy',     group: 'config', keywords: ['hours', 'import', 'payroll', 'geofence', 'time entries'] },
  { key: 'brand',        label: 'Brand',        group: 'config', keywords: ['logo', 'terms', 'invoice text', 'status descriptions'] },
];
```

Ten entries, all `group: 'config'`, matching today exactly. The `records` group is defined in the code and renders nothing yet because no page claims it. Prompt 81 populates it. Render a group header only when that group has at least one visible entry, so today the rail shows a plain list with no stray "CONFIGURATION" heading over the whole thing.

Keywords exist so search finds a page by what you were looking for rather than by the page's name. They are the one hand-maintained thing here; a per-control search index was considered and rejected as unmaintainable against 78 controls that move in the next prompt.

## Part B: the rail

`settingsTabBar(active)` renders, top to bottom: the "Settings" heading, the search input, then the grouped item list. Fixed width around 200px, items full-width and left-aligned, active item using the existing `.pec-btn.primary` treatment so it inherits theme colors. Use existing `pec-*` classes and CSS variables; do not introduce a new color.

The content column takes the remaining width and keeps its current max width so long forms do not stretch. On the rail, `position: sticky; top: <existing header offset>` so it stays put while a long page scrolls.

Delete the horizontal scroll, the `overflow-x`, and the `mask-image` fade entirely. They are the thing being removed. Update the function's leading comment; leaving the old one describing a scrolling strip is worse than no comment.

## Part C: search

Input at the top of the rail, placeholder `Search settings`.

- Typing filters `SETTINGS_PAGES` on `label` + `keywords`, case-insensitive substring. The rail shows only matching entries. Group headers hide when their group has no matches.
- Empty input restores the full list.
- Enter with exactly one match navigates to it and clears the box.
- Escape clears and restores.
- **Do not re-render the page on keystroke.** Filtering is show/hide on rail items only. Re-rendering the content on every character would refetch settings from Supabase on every keypress.

Preserve the query in `state.settingsSearch` so it survives the re-render that happens when you click a result.

## Part D: responsive

Read `settings_rail_breakpoint_px` (seeded `900` by prompt 79). Below that width, render the rail as a single `<select>` labelled Settings, showing the current page, with `<optgroup>` per group. At or above it, the vertical rail. The search input stays visible in both.

Fetch the breakpoint once and cache it on `window.pecState`, not in a module-scope const. Per the standing gotcha recorded on 2026-07-xx, module-level consts are invisible to the classic `<script>` blocks and produce `"X is not defined"` at runtime; `settingsTabBar` is reachable from both. Fall back to `900` when the row is missing or unparseable, matching the seed.

Re-evaluate on `resize` (debounced, ~150ms). Remove the listener when leaving the Settings view; `renderSettings` already clears `state._emailLogTimer` on the same path, so follow that pattern and store the handle on `state`.

## Part E: redirect map, silent

`renderSettings` (21592-ish) already does exactly this for one key:

```js
if (state.settingsTab === 'users') { state.settingsTab = 'people'; return renderSettingsPeople(); }
```

Generalise it into a `SETTINGS_KEY_ALIASES` object consulted before dispatch, seeded with `users -> people`. It routes silently: no toast, no "this has moved" banner. (DripJobs ships a permanent "Portal Accent Color has moved" notice in their Brand tab; it is clutter that outlives its usefulness. Don't.)

No page keys change in this prompt, so the map has one entry today. It exists now so prompt 81 adds lines to it instead of inventing the mechanism mid-move, and so the birthday-bell deep link to People and the drift-banner deep link to General cannot silently 404 into a blank view.

Keep the existing `scrollIntoView` fallback behaviour in spirit: if a deep link lands on a page that search has filtered out of the rail, clear the search filter so the active item is visible.

## Verification

Manual, in the browser, as an admin:

1. All ten pages load and render identical content to before. Spot-check General (longest), BusyBusy (has its own sub-state), and both migration-missing early-return branches (People at 20723, Brand at 23550) which render a bare card and must still get the rail.
2. Click through all ten without a console error. `wireSettingsTabs` running twice on one root must not double-wrap.
3. Search `deposit` surfaces Invoicing. Search `quiet` surfaces Drips. Search `payroll` surfaces BusyBusy. Empty restores all ten.
4. Narrow the window below 900px: rail becomes a dropdown, still navigates. Widen: rail returns. No horizontal scrollbar at any width.
5. Deep links still land: trigger the birthday bell (to People) and the migration-drift banner (to General).
6. `npm test` passes. None of these suites cover Settings, so a failure means you broke something unrelated.

## Explicit non-goals

Do not move any setting between pages. Do not rename a page. Do not dissolve General. Do not add the RECORDS group members. Do not add card descriptions. Do not add Advanced disclosures. Do not touch any `renderSettings*` body beyond what Part B/E strictly require. All of that is prompt 81.

Do not refactor the five duplicated local `saveSetting` helpers (18896, 19079, 19324, 20049, 37680). They are a real problem and a real temptation while you are in this code. They are prompt 81's problem, where the pages they live in are being rewritten anyway.

## Log entry

Append to the top of PROJECT-LOG.md. `By: Claude Code`. Record: that the container changed and no setting moved; the `wireSettingsTabs` DOM-restructure approach and why the 14 call sites were left untouched; the breakpoint fallback value; which of the six verification steps you actually ran and what you saw. If you found that a call site does something other than the standard shape, log it, because prompt 81 needs to know.

## Commit

`git add index.html PROJECT-LOG.md` specifically (never `git add .`):

```
git commit -m "settings: vertical rail replaces the scrolling tab strip, page manifest, search, responsive dropdown, alias redirects (shell only, no settings moved)"
```

Do not push.
