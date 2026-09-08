# Owner MBP calculation foundation

Status: calculation engine connected to the 🚀 Growth and Development beta through `owner-studio.js` and `pec-owner-studio.cjs`. The engine itself remains pure and contains no owner data. Private persistence and on-request AI live in the endpoint, not this module or the existing staff-accessible Cockpit. Calendar accountability and full automatic PEC import remain pending; the initial CRM adapter is a read-only, caveated weekly preview.

`owner-mbp.js` is a pure ESM calculation engine shared by future UI and server adapters. Run `npm run test:owner-mbp`; the suite also runs through `npm test`'s posttest hook. Tests use synthetic data only. The site's publish directory is the repository root, so never commit the source workbook, actuals, private plans, journal records, or import snapshots here.

## Owner UI and weekly rock workflow

The owner navigation is a horizontal top bar; narrow screens scroll it sideways and keep the active destination visible. Sales and revenue grids offer full-year, quarter, and calendar-month row filters. Quarter grouping remains the source fiscal grouping; monthly membership uses the week-ending date. Filtering does not recalculate source cumulative cells, annual summaries, or full-year footers. Frozen headers and the week-ending column remain intact.

Q4 plan items accept `milestones: [{ id, title, done, focusWeek?, completedWeek? }]`. The two week fields are ISO Monday dates or empty strings. Selecting This week assigns the current Phoenix Monday; unfinished selections from earlier weeks remain visible in morning focus. Completed selections remain visible through their completion week, then leave that weekly view without being removed from the rock. A legacy `checkpoint` is shown as one unchecked milestone only when `milestones` is absent; an explicit empty array never resurrects a removed checkpoint. Existing checkpoint and note fields are retained on save. The endpoint validates unique per-rock IDs, boolean completion, nonempty titles, Monday dates, and at most 100 milestones per rock. Existing private JSON document/revision storage is reused; there is no migration or bulk rewrite.

The first morning answer (`alignment`, same stable key) now records weekly quarterly-rock progress. Saving a check-in first saves any changed milestone completion in its Q4 plan using the existing revision/request-ID boundary, then saves the daily answers. These are two explicit, sequential document saves, not an atomic cross-document transaction. A plan conflict stops completion and keeps typed answers. If the plan saves but the check-in fails, the draft stays visible; retrying unchanged milestone selections does not write the plan again. No background milestone write or AI request is triggered by checkbox changes.

## Input contract

`calculateMbp(input)` requires:

- `schemaVersion: 1`, numeric `year`, explicit `weekEndings` (52 or 53 consecutive Sunday dates), and `asOfWeekEnding` selected from that calendar. Dates are ISO `YYYY-MM-DD`; calculations never consult the wall clock.
- `lines`: separate business lines with stable unique `id` and display `label`. `total` is reserved. Labels are not authorization. Dylan confirmed Painting = FTP manual and Epoxy = PEC CRM on September 7, 2026.
- Each line's `sales`: `newSales`, optional `carryOver` and `recurring`, `leadConversion`, `salesRatio`, `averageJobSize`, and `weekly`.
- Each line's `revenue`: `annualProduced`, `chargeRate`, and `weekly`.
- Every `weekly` array contains exactly one keyed row per source week, with `weekEnding`, `weight` and optional `actual`. Order can vary; duplicate/unknown/missing dates fail validation. Weights must add to 1 within floating-point tolerance and are never normalized silently.
- Sales weekly actuals: `leads`, `estimates`, `jobsBooked`, `bookedDollars`. Optional row-level `leadConversionOverride` and `salesRatioOverride` preserve the source's AL/AO inputs. A zero override is not blank and never falls back to the base rate.
- Revenue weekly actuals: `producedDollars`, `laborHours`, and optional `custom`; optional row-level `customPlan`.
- Optional `totalRevenueCustom`: one keyed row per week with independent `plan` and `actual`. The workbook's TOTAL Custom Option is its own input, not an aggregation of potentially unlike brand measures. When omitted, those weekly cells stay blank.

Values must be numbers or optional null/undefined, never formatted currency or numeric strings. Counts are nonnegative integers. Hours are nonnegative and may be fractional. Signed dollar corrections and custom values remain signed. Annual dollar plans are nonnegative; average job size and charge rate must be positive. Planning conversion ratios may be 0 through 1. Division by a zero ratio yields unavailable plan cells and a specific issue, not a substituted base rate or an apparently valid partial total.

The current source has 52 Sundays, Jan 4 through Dec 27, 2026. Preserve that calendar. Do not create a 53rd row for Dec 28-31 or map those days into an unrelated week. A future fiscal year can supply its own explicit 53-week calendar. Quarter labels follow the workbook's 13-week groups (a supplied week 53 belongs to Q4).

## Output and source-cell correspondence

The result has `schemaVersion`, `calculatorVersion`, `year`, `calendar`, and `sheets`. Each sheet identifies `kind`, `businessLineId`, `label`, and `sourceTabName`, and has `top`, `rows`, `footer`, `summary`, and `issues`. Sheet order is Sales TOTAL, sales business lines, Revenue Produced TOTAL, revenue business lines.

Each row retains its week-ending key, fiscal quarter, original worksheet row number, and values keyed by the original column letters in `v`. Sales source rows begin at 12 and production source rows at 11. No Excel formula strings are evaluated.

| Sales field group | Original columns |
| --- | --- |
| Leads: weekly plan/actual, cumulative plan/actual | C, D, E, F |
| Estimates: weekly plan/actual, cumulative plan/actual | I, J, K, L |
| Jobs booked: weekly plan/actual, cumulative plan/actual | U, V, W, X |
| Booked dollars: weekly plan/actual, cumulative plan/actual, gap | AA, AB, AC, AD, AE |
| Seasonal allocation: weekly and cumulative | AH, AI |
| Lead conversion: base plan, weekly actual, optional override | AJ, AK, AL |
| Sales ratio: base plan, weekly actual, optional override | AM, AN, AO |
| Average job size: plan, weekly actual, cumulative actual | AP, AQ, AR |

Sales top C4 is new + carry-over + recurring. The source weekly plan allocates C5 (new sales) only. Booked jobs = C5 / K6 * weekly weight; estimates = jobs / effective sales ratio; leads = estimates / effective lead conversion. Carry-over and recurring do not silently get added to weekly new-business targets.

| Revenue Produced field group | Original columns |
| --- | --- |
| Produced dollars: weekly plan/actual, cumulative plan/actual, gap | C, D, E, F, G |
| Labor hours: weekly plan/actual, cumulative plan/actual | J, K, L, M |
| Seasonal allocation: weekly and cumulative | P, Q |
| Charge rate: plan, weekly actual, cumulative actual | R, S, T |
| Custom Option: weekly plan/actual, cumulative plan/actual | W, X, Y, Z |

Produced plan = C4 * weekly weight; hours plan = produced plan / C6. Produced dollars, booked sales, and cash collections are different measures. There is no collections or accounting recognition rule in this calculator.

TOTAL adds business-line plans and actuals, then divides the matching aggregate components for ratios. Sales K4/K5/K6 use annual plan totals. TOTAL AP deliberately repeats annual K6, as the original workbook does, even when a weekly weighted average would differ. Revenue R uses weekly dollars/hours; C6 uses annual dollars/hours. Keep fractional planning precision; round only for display.

## Missing numbers, ratios and trend interpretation

`row.coverage[column]` and `row.cumulativeCoverage[column]` report `entered`, `expected`, and `state` (`missing`, `partial`, `complete`) for each actual column. These describe input presence, not source freshness, reviewed status, or accounting correctness. Optional Custom Option coverage must not block review of the required revenue/hour fields.

Brand blank actuals stay null. TOTAL's ordinary actual columns retain the workbook's SUM behavior, so a completely blank week has a numerical zero AND `missing` coverage. A partly entered TOTAL stays `partial`. The UI, exports, and AI must consume coverage together with values and never present those zeros as confirmed actuals. Cumulative sums include entered values even across gaps, retaining cumulative coverage. A zero denominator gives a null ratio. For source fidelity, a missing weekly numerator over an entered denominator numerically evaluates to zero; the contributing column coverage must remain visible.

Sales top YTD ratios are ratios of the annual recorded totals. Footer AK/AN/AQ are arithmetic means of available weekly ratios. These are intentionally different. They are same-period activity ratios, not customer-cohort conversion rates.

The explicit as-of row drives `summary.recordedThroughWeek`, `planThroughWeek`, and `gapThroughWeek`. Trend is recorded cumulative dollars divided by cumulative seasonal allocation. It is labeled `seasonal_annualization` and carries dollar-input coverage. Missing weeks make it incomplete. It is not an AI prediction, a current CRM forecast, or evidence of current underperformance.

To match the workbook, the top YTD actual ratios and annual footer include all entered source weeks, including entries after the as-of row. Only the as-of summary and trend exclude later entries. Present those periods accurately. Import adapters must separately carry source timestamps and review/cutover metadata. A saved spreadsheet reporting date is not proof its actuals are current.

## Deliberate boundaries and source quirks

- Only the active Typical sales scenario is implemented. `claimsEnabled: true` fails explicitly; hidden claims columns are not fabricated.
- Brand AL/AO overrides are preserved. The TOTAL's hidden override-marker formulas still reference retired Name tabs; those markers are left null rather than reproducing invalid references.
- The source Custom Option actual footer contains a literal zero. This engine computes the sum of entered custom actuals, so future custom entries will not leave a false zero footer. This intentional correction needs to be disclosed when Custom Option entry is exposed in the UI. TOTAL custom inputs remain independent as above.
- The source workbook's cached values are rounded by its export. Local reconciliation uses absolute 0.00001 or relative 1e-8 tolerance, without rounding calculations. The source snapshot remains outside the repository and immutable.
- The engine does not preserve arbitrary Excel formatting, hidden template sheets, spreadsheet formulas/macros, or source metadata. It is not an Excel importer or full spreadsheet runtime.

## Integration work before release

1. Confirm the owner entitlement and enforce record ownership in database policies and every endpoint, including another admin account. the former Cockpit's `OWNER_ROLES` includes admin, office, and pm; its label is not a privacy boundary. `pec_user_todos` demonstrates a useful per-user ownership pattern, not a table to overload.
2. Persist versioned private plans, weekly inputs, immutable import/review snapshots, check-in responses, and correction history. Keep all private content out of shared `settings`, generic AI caches, staff logs, notifications, and public assets. Use settings only for appropriate configuration, not records or caches.
3. Reconcile PEC booking and production recognition dates, job/estimate identity, callback/cancellation/change-order handling, hour attribution, fiscal boundaries and historical cutover. Existing Metrics has distinct signed-date sales, completed-date revenue, and payment-date collections; legacy Cockpit sales/revenue share a source and cannot be reused as distinct MBP actuals.
4. Connect the approved orange/blue workspace and exact six grids. Test data edits, validation, freshness indicators, source drills, keyboard navigation, narrow screens and private-account isolation.
5. Add weekday 6:20 AM Phoenix morning completion gating and a distinct, reasoned emergency bypass. Monday's 8 AM weekly review does not replace its morning check-in. Gate both navigation systems and deep links; an ordinary modal is insufficient because navigation clears modal roots. Confirm whether ten minutes is a minimum elapsed time or a guided target.
6. Build recurring calendar blocks with the owner. Review destination/calendar conflicts before creation. Events are commitments, not proof of attendance. Add private AI insights only after live metric definitions and authorization are verified; the existing staff-wide metrics AI cache is unsuitable for private goals or difficulties.
7. Review Claude's final changes, integrate on top of them, rerun tests, rehearse required auth/money migrations, and only merge/push after Dylan's go-ahead. No live migration, calendar write, merge, or push is part of this foundation commit.

Follow-on source-faithful modules remain Strategic Plan, KPI Dashboard 2026, Marketing Plan, GSR Dashboard, Implementation Plan, Cash Flow Plan (Mo). They are not implemented by this module.


## Yearly budgets and income statements

`owner-finance.js` and `owner-finance-ui.js` implement the active source Budget - 2 / Income Statement - 2 pair. Private records `finance:YYYY` contain the linked working sheets together, including their needed Date Definitions cells. `source:finance:YYYY` is the immutable source snapshot. Existing `source:2026` and `mbp:2026` records are independent and were not modified by this import. No source data belongs in public files, tests, generic logs, or settings.

Budget accounts/categories drive income statement labels. Monthly actuals entered on Income Statement flow back to budget actual/variance comparisons. This source income statement is a monthly actual statement, not a second editable plan. Formulas stay calculated; designated source planning, historical, sandbox, selector, and actual input ranges remain editable. Sparse blank inputs are represented by input ranges, so missing values and explicit zero remain distinct. The source had an omitted expense category in its aggregate budget summary, broken references in business-value/sandbox formulas, and future-month division by zero percentages. These are retained and explained inside private source metadata. No other workbook modules or accounting recognition rules are inferred.

The limited parser supports source references, ranges, arithmetic, comparisons, concatenation, IF, IFERROR, SUM, SUMIF, SUMIFS, OR, AND, NOT, EDATE, UPPER, LOWER, ROUND, ABS, DATE, YEAR, MONTH and DAY. It never evaluates JavaScript. Imported array spills are expanded into scalar references; original formula text, cached values, source notes and links remain in the immutable source. Unsupported/cyclic/broken formulas remain explicit errors. Formula results are calculated in memory and never written back as stale source caches. Full source reconciliation matched 25,440 populated cached reference cells; all tests committed to the repository use synthetic values.

Creating the next consecutive year reads an immutable source revision supplied by the user interface and creates the target with expected revision zero. Replaying a request cannot use a changed source revision or overwrite an existing year. It retains planning inputs, clears monthly actuals, moves fiscal date anchors, and uses explicit mappings to carry recorded previous-year actuals into historical columns. Historical text labels are materialized from the correct prior planning row even where the old template linked a different stream label. Blank-only history stays blank, incomplete history retains a coverage note, formula errors never become zero, and previous year documents are never changed.

The existing owner entitlement, live-session validation, private/no-store responses, per-owner record filters, append-only revisions and request-ID conflict boundary apply to both new endpoints and existing save/document/history actions. No schema, permission or setting change is needed. Dates and supported years are bounded. Current document limits remain 1.8 MB per request and 2 MB for PostgreSQL's JSON text; compact source styles/ranges and sparse actuals keep the imported year and tested subsequent years inside both limits. Oversized documents fail rather than truncate data.

Source import used a fresh read-only Google Sheets export. Private temporary pieces were necessary for the SQL connector's request-size limit. Assembly checked exact content digests, rehearsed both final saves plus cleanup in a rolled-back transaction, then committed the same verified operation. The 11 temporary records and their revisions were removed in that final transaction. Both finance documents have revision 1; the existing weekly MBP and original source revisions remained unchanged. No Google Sheet was modified.
