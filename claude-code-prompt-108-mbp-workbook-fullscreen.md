# Prompt 108: Growth and Development MBP as a full-screen workbook clone

Prompt number: 108 (highest existing was 107, checked against git log and the working tree 2026-09-25 before saving). Recheck numbering before committing.

Written 2026-09-25 by Cowork from a scoping session with Dylan (15 questions). Locked decisions below. Do exactly this scope. If anything here conflicts with AGENTS.md, docs/product-charter.md, SCHEMA.md, or the last 3 PROJECT-LOG entries, stop and ask Dylan.

## Startup

1. Read AGENTS.md, docs/product-charter.md, and run the scoped context command for the owner workspace (`node scripts/context-packet.mjs --feature "Growth and Development"` or whatever AGENTS.md names).
2. Read `production/owner-mbp.md` in full. It is the contract for the calculation engine, the source-cell column map, the finance documents, editability rules and the PEC live refresh. Nothing in this prompt changes calculations, storage, or the live refresh.
3. Use features.json (feature 0, "Growth and Development owner workspace") to locate code. Main files: `production/owner-studio.js` (UI shell and MBP grids), `production/owner-mbp-ui.js`, `production/owner-mbp-inputs.js`, `production/owner-finance-ui.js`, `production/owner-finance.js`, `netlify/functions/pec-owner-studio.cjs`. Do not read index.html end to end.
4. Reference workbook (PRIVATE, never copy into the repo, never commit, never bundle into public assets):
   - `~/Desktop/HQ/07 - Coaching & MBP/MBP Workbook Reference/MBP 2026 - Finishing Touch Painting (2).xlsx`
   - `~/Desktop/HQ/07 - Coaching & MBP/MBP Workbook Reference/MBP-2026-visual-reference-SP-RP-Budget2-IS2.pdf` (LibreOffice render of the 8 sheets. Approximate only. The xlsx cell styles are the truth.)
   Read styles from the xlsx with openpyxl: fills, font colors/weight, borders, number formats, column widths, row heights, merged ranges, hidden columns/rows, outline (group) levels, and conditional formatting. Tests and fixtures must stay synthetic.

## What Dylan asked

"Under Growth and Development, I want the Revenue Produced and Sales tabs to look exactly like this Excel sheet without any variations. Be able to open it up full screen so I can see everything, and I want the top boxes and the bottom boxes as well. For the budget and income statement tabs as well. They need to work together like this workbook does. Pretty much make this sheet an exact clone inside of there."

## Findings that shaped this (verified 2026-09-25, live app + workbook + DB)

1. All 8 sheets already exist with source-faithful math: Sales Plan TOTAL / SP Painting / SP Epoxy, Revenue Produced TOTAL / RP Painting / RP Epoxy (`mbp:2026`, revision 4), Budget - 2 and Income Statement - 2 (`finance:2026`, revision 10). This is a presentation rebuild, not a data or calculation build.
2. "Work together like the workbook": the workbook's only cross-sheet links are TOTAL = sum of brand tabs (SP and RP), and Budget - 2 <-> Income Statement - 2 (Budget owns account names; IS monthly actuals feed Budget actual columns). Sales/Revenue do NOT feed Budget/IS in the workbook. TopCoat already implements both links. Do not add new cross-sheet links.
3. Current gaps vs the workbook: the grid is boxed in an 1100px scroll area (Sales table is 2,332px wide); SP/RP grids use grey TopCoat styling instead of the workbook's navy/blue; quarter label repeats per row instead of merged Q1-Q4 blocks; the red/grey flag columns (G, M, Y, AF, AS on SP; H, N, U on RP) are missing; top boxes are rebuilt as two TopCoat cards; ~8 lines of data notes sit between the top box and the grid; Budget/IS use pill-shaped inputs and uneven row heights.
4. The uploaded file's plan inputs are identical to TopCoat's today (checked: newSales, carryOver, leadConversion, salesRatio, averageJobSize, annualProduced, chargeRate and all 52 sales and revenue seasonal weights for both lines; Budget plan revenue streams and variable expense plan values spot-checked). No AL/AO overrides in the file.
5. Workbook flag rule (exact, from the row-12 array formulas): `Grey` if the row's source week-ending date > today; else `Grey` if ROUND(cumulative actual,0) >= ROUND(cumulative plan,0); else `Red`. Red cells fill #CC4125. Grey cells are #F3F3F3 with font the same color (text invisible). There is NO green state. Pairs: SP G = F vs E, M = L vs K, Y = X vs W, AF = AD vs AC, AS = AR vs AP. RP H = F vs E, N = M vs L, U = T vs R.
6. Source palette samples (SP Painting): quarter/section header fill #073763 white bold; Plan/Actual header bar #3D85C6 white bold; actual input cells #CFE2F3; week date `d mmm` bold #454545; counts `#,##0_);[Red](#,##0)`; dollars `_($* #,##0_);[red]_($* (#,##0);_($* "-"??_)`. Pull the rest from the xlsx, do not eyeball.
7. SP hidden columns O, S, T, AL, AO (claims + weekly conversion overrides). RP has no hidden columns. Budget - 2 has 45 hidden columns and ~786 hidden rows in outline groups; IS - 2 hides S:T and ~727 rows in outline groups. The engine already omits the claims scenario; keep O:T and AL/AO hidden, exactly like the workbook.
8. AGENTS.md: a substantial redesign needs a concrete preview and Dylan's approval before production. This is one.

## Locked decisions

1. **Numbers:** keep TopCoat's live PEC actuals, FTP manual actuals, and every saved manual edit. Change the screens only. Do not re-import data.
2. **Plan check from the file:** write a one-off local script (not committed with any data, output to the terminal only) that diffs every plan input in the reference xlsx (SP/RP annual inputs, seasonal weights, AL/AO overrides; Budget - 2 planning input ranges) against live `mbp:2026` and `finance:2026`. Report the diff in the log entry. Write NOTHING. If differences exist, list them for Dylan.
3. **Week labels:** keep TopCoat's Saturday closing date, but format it like the sheet: `d mmm` ("3 Jan"), bold. Flag and "today" comparisons still use the saved Sunday source key so they match the workbook exactly.
4. **Full screen = the workbook.** One "Open workbook" button enters true browser full screen (Fullscreen API on a dedicated container; fall back to a fixed full-viewport overlay if the API is refused). The TopCoat sidebar, header, and Growth and Development tab bar are hidden. Esc or an "Exit" button leaves. Deep link: `?v=owner-studio&mbp=workbook&sheet=<id>` reopens it (full-screen API needs a click, so the deep link opens the overlay and shows a one-click "Go full screen").
5. **Excel-style sheet tabs along the bottom**, in workbook order and with workbook names: `Sales Plan - (Wk) TOTAL`, `SP - (Wk) Painting`, `SP - (Wk) Epoxy`, `Revenue Produced - (Wk) TOTAL`, `RP - (Wk) Painting`, `RP - (Wk) Epoxy`, `Budget - 2`, `Income Statement - 2`. Remember the last sheet and scroll position per sheet for the session.
6. **Each sheet renders as the workbook renders it:** top boxes (SP A3:E7 PLAN/TREND and I3:L6 PLAN/YTD; RP A3:D6 PLAN/TREND and PLAN/YTD charge rate), header rows (SP 9-11, RP 8-10), all 52 week rows, and the bottom totals row (SP row 65, RP row 64, including the RP H64 variance %). Same column order, column widths, merges, fills, fonts, borders, number formats, blank spacer columns, and hidden columns. Freeze panes exactly like the workbook: SP at C12, RP at C11, Budget - 2 none (keep the existing pinned header behavior only if the workbook freezes it), IS - 2 at C5. Hidden control rows (SP 66-77, RP 65-75) stay hidden.
7. **Include:** the red/grey flag cells (exact rule in finding 5) and merged Q1-Q4 quarter blocks (#073763). **Exclude:** the MBP Support link, the USER INSTRUCTIONS box, and the row-1 read-only banner. Leave those cells empty with their normal background so the layout does not shift. No Excel A/B/C column letters or row numbers on SP/RP. On Budget - 2 and IS - 2, also remove the letter/number gutter the current finance grid shows, so all 8 sheets match.
8. **Editing is Excel-like with autosave.** Only the cells that are editable today (owner-mbp.md "Editable MBP inputs" allowlist; finance input ranges) accept input, shown with the workbook's input fills (#CFE2F3 actuals, green plan inputs per the xlsx). Click or arrow-key to a cell, type, Enter moves down, Tab moves right, Esc cancels, Delete clears to blank (blank and 0 stay distinct). Each change saves automatically after ~800 ms idle (setting below) through the EXISTING `mbp-inputs` changed-field save and the existing finance save, keeping request-ID replay and revision-conflict handling. A small status in the toolbar corner shows Saving / Saved / Conflict. On a revision conflict, keep the typed values, show the conflict, never overwrite silently. Formula cells are read-only. Yellow manual-override fill and the missing-input `*` stay on the cells. Account names on Budget - 2 remain editable name cells (that is how accounts are added/renamed now, exactly like the workbook).
9. **Use TopCoat stays:** right-click (or long-press) a yellow manual-override cell -> "Use TopCoat value". Same behavior and eligibility as today's button.
10. **Period filter stays** in the full-screen toolbar for SP/RP (Full year / Quarter / Month, existing behavior: filters rows only, never recalculates cumulative, top boxes, or bottom totals).
11. **Dropped from the full-screen workbook:** "Jump to" links, the separate Weekly entry and Plan assumptions forms (the AL/AO override inputs stay hidden with their columns, like Excel), the Income Statement Combined/PEC/FTP company filter, "Show empty slots", and add-account controls on the Income Statement (prompt 104). Remove them from the UI; keep their data, helpers, and settings untouched so nothing saved is lost. Do not delete stored settings rows.
12. **Outline groups:** Budget - 2 and IS - 2 render the workbook's row/column outline groups collapsed exactly as saved in the xlsx, with Excel-style +/- controls in the margins to expand/collapse each group. Remember open/closed state per sheet (per-viewer convenience, localStorage wrapped in try/catch). Replace the current single "Show all rows and columns" toggle. Note: prompt 104's auto-show of named/valued rows was a variation; with it dropped, a row inside a collapsed group is shown only by expanding its group, as in Excel. Confirm with the live data that every account with a nonzero actual is inside a group whose default state keeps it visible OR list the ones that would start hidden in the log for Dylan.
13. **Data notes:** move all current notes (PEC auto-update status, unverified booking/completion dates, pipeline-lead gaps, source workbook notes, formula cells needing attention, yellow = manual) to the summary page. In full screen, a single warning icon with a count in the toolbar opens them in a side panel. The sheet surface has no notes.
14. **Summary page replaces the 4 tabs.** In the Growth and Development top nav, replace Sales Plan, Revenue Produced, Budget Plans and Income Statement with ONE tab named `MBP`. It shows, on one page: the SP top boxes for TOTAL, Painting, Epoxy; the RP top boxes for TOTAL, Painting, Epoxy (styled exactly like the workbook boxes); one P&L box built from Budget - 2's plan and actual columns: Revenue (FTP, PEC, Total), Total Variable Expenses, Gross Profit and GP%, Total Fixed Expenses, Net Profit and NP%, each as Plan / YTD Actual / Gap; the data notes; the Budget year picker and Add year (existing behavior); and a prominent "Open workbook" button. Clicking any box opens full screen on that sheet. Old deep links to the four removed tabs redirect to `MBP`.
15. **Phone:** the MBP tab shows the summary. "Open workbook" still works and opens the same grid with touch panning; no separate phone layout.
16. **Morning focus, weekly review, rocks, problem solving, AI insights, routine settings:** untouched.

## Settings (no code edit to tune)

Routine settings, in the existing MBP section, owner-scoped like `owner_mbp_refresh_minutes`:
- `owner_mbp_autosave_ms` (default 800, range 300-5000).
- `owner_mbp_workbook_default_sheet` (default `sales_total`; any of the 8 sheet ids).
Insert-only seed, same pattern as `20260909024453_owner_mbp_live_refresh_settings.sql`. No other schema change is expected; if one seems needed, stop and ask.

## Build order (preview first, per AGENTS.md)

1. Build the full-screen workbook renderer behind a preview gate (for example `?mbp=workbook-preview`) without removing the current tabs. Render all 8 sheets from the existing engine outputs.
2. Fidelity check: for each of the 8 sheets, screenshot the preview at 1920x1080 and compare against the xlsx styles and the reference PDF. Produce a short checklist per sheet (columns, widths, merges, fills, number formats, hidden cols/rows, freeze, flags, top boxes, bottom row) with pass/fail. Fix fails.
3. STOP. Post the preview link and screenshots in the PROJECT-LOG entry and ask Dylan to approve before step 4.
4. After approval: switch the top nav to the MBP summary tab, remove the dropped controls, redirect old deep links, publish.

## Tests (synthetic data only)

- Flag rule: future week -> Grey; rounded actual >= rounded plan -> Grey; below -> Red; rounding at .5 boundary; applies to all 8 flag columns.
- Keyboard grid: Enter/Tab/arrows skip formula cells correctly; Esc restores; Delete stores blank not 0.
- Autosave: debounce coalesces rapid edits into one changed-field save; request-ID replay on a dropped response does not create a second revision; conflict keeps typed values.
- Use TopCoat context action only on eligible yellow PEC cells; never on FTP.
- Period filter does not change top boxes, cumulative cells, or bottom totals.
- Outline groups: collapsed defaults match the source outline; toggling does not change saved data.
- Summary P&L box equals the Budget - 2 plan/actual cells it reads.
- No owner financial values, workbook bytes, or private names in committed fixtures or public assets (extend the existing guard test).

## Acceptance (Dylan, on his desktop)

1. MBP tab shows every summary box on one page; numbers equal the corresponding top boxes inside the workbook.
2. Open workbook -> full screen, no TopCoat chrome, bottom sheet tabs in workbook order. Each sheet side by side with the Excel file looks the same (layout, colors, formats, frozen panes, hidden columns, merged quarters, red/grey flags, bottom totals), with TopCoat's live numbers.
3. Type an Epoxy weekly actual in full screen, press Enter, see Saved; reload; value persists, yellow; right-click -> Use TopCoat restores the live value.
4. Rename a Budget - 2 account; Income Statement - 2 shows the new name; enter an IS actual; Budget - 2 actual column updates.
5. Expand and collapse a Budget - 2 group with +/-.
6. On the phone, MBP shows the summary boxes.

## Out of scope

- Any calculation, storage format, live-refresh, or source-rule change.
- Other workbook sheets (Strategic Plan, GSR, KPI Dashboard, Cash Flow, Marketing Plan, Implementation Plan, monthly SP/RP tabs, Budget - 1 / IS - 1).
- Re-importing workbook data or writing any plan value from the file.
- A phone-specific workbook layout.

## Logging

PROJECT-LOG entry at the top with By: Claude Code, the plan-diff result (decision 2), the fidelity checklist, the collapsed-row audit (decision 12), the preview link, and the approval status. Update `production/owner-mbp.md` and features.json feature 0 to describe the MBP summary tab and the full-screen workbook, and remove the dropped controls from the description.
