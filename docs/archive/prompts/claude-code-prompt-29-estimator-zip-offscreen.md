# Claude Code Prompt 29: fix the estimator Zip field rendering off-screen on desktop

## Context

On the estimator (apps/estimator, the React/TS mobile-first app), the Zip field in the customer City / State / Zip row renders partly off-screen on DESKTOP. Dylan confirmed it is desktop, not phone. This is a CSS layout overflow, not a data bug.

Repo: HQ-Dashboard, main. The estimator is its own app under apps/estimator (separate from index.html).

## Diagnosis (read first, confirm in the browser before editing)

- The row is `.cust-csz` (apps/estimator/src/styles.css:182-183): `grid-column: 1 / -1; display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 0.6rem;`, holding three `.field` labels City / State / Zip at apps/estimator/src/features/estimator/EstimatorScreen.tsx:1316-1320.
- `.cust-csz` sits inside `.cust-grid` (`grid-template-columns: 1fr 1fr`, styles.css:177), and the whole customer card is inside `.cols`, which becomes two columns at min-width 760px (styles.css:95-96). So on desktop each card is about half the viewport, which is why this three-input row is cramped on desktop but fits on a phone (full-width card). That matches Dylan's "desktop only" report.
- Root cause: the base `select, input` rule (styles.css:108-115) sets NO width, so inputs keep their intrinsic default width (roughly 20 characters). CSS grid items default to `min-width: auto`, so an input's intrinsic width can exceed its track and overflow the row to the right, pushing Zip past the card edge. `* { box-sizing: border-box }` is already set (styles.css:13), so box-sizing is not the problem; the missing pieces are input `width: 100%` and `min-width: 0` on the tracks.

## The fix (confirm, then apply the minimal version)

- Make form inputs fill their field: add `width: 100%` to the base `select, input` rule (styles.css:108). This matches what `.custom-scope` (201) and `.addr-ac input` (209) already do. The checkbox-style overrides `.area-mvb input` (131) and `.check input` (158) have higher specificity, so they are unaffected.
- Let the grid tracks shrink: add `min-width: 0` to `.cust-csz .field` (applying it to `.field` generally is also acceptable) so the 2fr / 1fr / 1fr tracks can size below the inputs' intrinsic width.
- Verify no regression on the other input rows that share this pattern: `.cust-grid`, `.slots`, `.wo-grid`, `.sell-row`, `.area-top`, `.addon-nums`. `width: 100%` on inputs is the expected behavior for all of them, but eyeball them (or screenshot at a desktop width around 1200px) to confirm nothing else shifts.

Keep the change to styles.css only if possible; no TSX change should be needed. This is CSS, so there is NO migration and NO Cowork handoff.

## Acceptance

At a desktop-width browser (the two-column `.cols` layout, >= 760px), the customer card's City / State / Zip row shows all three inputs fully inside the card with Zip not clipped. The phone layout still looks right.

## Standing rules

Commit (`estimator: fix zip field overflow on desktop`, no secrets). Build the estimator (tsc plus vite) to confirm it compiles. No em dashes. Append a PROJECT-LOG.md entry at the TOP. This is a bug fix on the separate estimator app; it does not need a dashboard What's New entry (that changelog is for index.html), but note the fix in the log. No migration.
