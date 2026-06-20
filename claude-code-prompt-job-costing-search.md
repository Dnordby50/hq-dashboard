# Claude Code prompt: search bar in Job Costing (find completed / costed-out jobs)

Paste into Claude Code. Follow CLAUDE.md (commit + PROJECT-LOG after the change). This is a pure front-end `index.html` change, no migration, no DB.

## Context

Dylan wants to search Job Costing so he can quickly find a job that has been completed and costed out. Finalized (costed-out) jobs live in the **Completed Job Costing** view, `renderCompletedCosting` at `index.html` ~line 16540. It renders a single table of every job where `costingIsFinalized(j)` is true, sorted most-recently-finalized first, with a toolbar (`.pec-toolbar` ~16568) that today only shows the title and a "<n> finalized jobs" count. There is no way to filter it; once there are many finalized jobs it is a long scroll.

The sibling active view `renderJobCosting` (~16212) already has a filter `<select id="costFilter">` wired at ~16444 (`state.costingFilter`), but it has no text search either.

## Task

Add a text search bar to **Completed Job Costing** (`renderCompletedCosting`) that filters the rows by what Dylan would type to find a job: customer name, address, proposal number, system name, and crew name. Requirements:

1. Put a search `<input type="search">` in the existing `.pec-toolbar` (between the title and the count, ~16568). Placeholder e.g. "Search completed jobs (name, address, proposal #)".
2. Filter **client-side over the already-loaded rows** — do NOT add a Supabase query. The data is already in `state.prodJobs` / the `rows` array this function builds (~16561). The search must cover, case-insensitively: `j.customer_name`, `j.address`, `j.proposal_number`, the resolved system name (`sys.name`), and the crew name (`crewById[j.crew_id].name`).
3. Filter WITHOUT a full re-render so the input keeps focus while typing. Recommended approach: give each `<tr data-completed-cost>` a `data-search` attribute holding the lowercased concatenation of those fields, then on `input` toggle each row's `hidden`/display based on whether `data-search` includes the lowercased query. Re-rendering the whole view on every keystroke (the pattern `costFilter` uses) would drop focus, so do not copy that pattern here.
4. Update the "<n> finalized jobs" count to reflect matches while searching (e.g. "<m> of <n>"), and show an inline "No matching jobs" row/message when the query matches nothing (distinct from the existing "No finalized jobs yet" empty state, which should still show when there are zero finalized jobs at all).
5. Trim and collapse whitespace in the query; an empty query shows all rows and restores the plain count.

## Guardrails / what NOT to touch

- Do not change `costingIsFinalized`, `computeCostingRow`, `loadCostingData`, or any costing math. This is display-only filtering.
- Do not add a DB column or query. No migration.
- Keep the row click-through (`[data-completed-cost]` -> open the unified job, ~16601) working for visible rows.
- Leave `renderJobCosting` and its `costFilter` select alone unless you do the optional item below.

## Optional (only if quick and consistent)

Mirror the same search input on the active `renderJobCosting` list toolbar (~16300s) using the identical in-place `data-search` filter, so both costing screens search the same way. If it adds meaningful complexity (the active list has the rollup/summary section), skip it and note that in the log rather than half-building it.

## Acceptance

- Typing part of a customer name, address, or proposal number in Completed Job Costing narrows the table live, without the input losing focus.
- Clearing the box restores the full list and the original count.
- A no-match query shows "No matching jobs", and the zero-finalized-jobs case still shows the original empty state.
- No console errors; row click still opens the job.

## After (per CLAUDE.md)

- Commit (`dashboard: add search bar to Completed Job Costing`).
- Append a PROJECT-LOG.md entry (By: Claude Code) describing the search fields covered, the in-place (no re-render) approach, and whether you also mirrored it onto the active Job Costing list.
- No Cowork or Dylan handoff needed (front-end only, no deploy-blocking dependency).
