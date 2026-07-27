# BusyBusy Payroll Export — discovery findings (read-only probe)

Date: 2026-07-27 MST. By: Claude Code. Source data: the 2026-07-20 00:00:00 to 2026-07-26 23:59:59 pull (66 rows, 320.50 hours, 6 employees) plus exactly 3 additional read-only API calls (repeat week pull, single-day pull, empty future range). No wage figures, no dollar amounts, no token in this file.

---

## 1. Token lifetime — THE TOKEN NEVER EXPIRES ON ITS OWN

The working credential is a 3-segment JWT, header `{"alg":"HS256"}`. The payload contains exactly three claims and nothing else:

- `aud`: `busybusy-v3-member-session`
- `iat`: `1785167680` = 2026-07-27 15:54:40 UTC (08:54 AZ — it was minted this morning when Dylan logged in)
- `sub`: `24627523` (the member id)

There is **no `exp` claim**, no `organizationId`, no scope, no type claim. Decoded locally; the token was not sent anywhere except the BusyBusy endpoint itself.

What this means for unattended operation: the token does not self-expire, so a scheduled import CAN run unattended on this credential. But it is a **member session**, not an integration key — its lifetime is governed server-side by session validity. Logging out of that session, a password change, or BusyBusy pruning old sessions would kill it silently (the API would start returning 401, as `graphql.busybusy.io` has since 2026-06-13). The import must therefore treat 401 as "credential dead, alert Dylan, do not touch stored data," and the build should assume the token will need occasional manual refresh with no advance warning.

## 2. Exact CSV shape

Header row, verbatim, 45 columns in this order:

```
"Id","CreatedBy","LastEditedBy","EmployeeId","FirstName","LastName","EmployeePosition","EmployeeGroup","Date","Start","End","Wage","Hours","BreakHours","WageType","Cost","SafetySignOffInjured","CorrectTimeSignOffTimeAccurate","BudgetedHours","BudgetedCost","Customer","ProjectCity","ProjectState","ProjectGroup","ProjectNumber","Project","SubProject1Number","SubProject1","SubProject2Number","SubProject2","SubProject3Number","SubProject3","SubProject4Number","SubProject4","SubProject5Number","SubProject5","SubProject6Number","SubProject6","CostCode","CostCodeDescription","CostCodeGroup","Equipment","EquipmentMakeModel","EquipmentMeterReading","Description"
```

- 67 physical lines: 1 header + 66 data rows. UTF-8, LF line endings (no CRLF), file ends with a newline.
- Every field on every row is double-quoted, including empty fields. All 67 lines parse to exactly 45 fields. Standard `csv` parsing works; no embedded quotes or delimiters observed this week, but quoted-field parsing must be used (Descriptions are free text).
- `Date` format: `MM/DD/YYYY` (e.g. `07/20/2026`).
- `Start`/`End` format: `YYYY-MM-DD HH:mm:ss` (e.g. `2026-07-20 06:46:00`). Seconds are always `:00` — minute resolution.
- **Timezone: local Arizona time, not UTC.** Evidence: the earliest non-midnight `Start` in the file is **06:32:00**, and the whole crew's first punches cluster 06:32–07:01 with last punches 16:18–19:37. A UTC export would put first punches around 13:30. (Four rows do start at 00:00:00, but those are midnight continuations of multi-day punches — see task 9 — not first punches.)

## 3. Projects, verbatim

| ProjectNumber | Project | Customer | ProjectCity | ProjectState | ProjectGroup | SubProject1Number | SubProject1 | Rows | Hours |
|---|---|---|---|---|---|---|---|---|---|
| *(empty)* | Shop | *(empty)* | *(empty)* | *(empty)* | *(empty)* | *(empty)* | *(empty)* | 34 | 145.95 |
| 2260678 | Bobette Weiss | Bobette Weiss | Prescott | AZ | *(empty)* | *(empty)* | *(empty)* | 4 | 29.52 |
| 2103508 | Nathan Rhodes | Nathan Rhodes | Prescott | AZ | *(empty)* | *(empty)* | *(empty)* | 7 | 29.42 |
| 2227346 | Matt Scharrer | Matt Scharrer | Prescott | AZ | *(empty)* | *(empty)* | *(empty)* | 5 | 27.25 |
| 2129551 | Scott Gordon | Scott Gordon | Sedona | AZ | *(empty)* | *(empty)* | *(empty)* | 2 | 21.33 |
| 2009843 | Will Lewis | Will Lewis | Prescott | AZ | *(empty)* | *(empty)* | *(empty)* | 3 | 20.68 |
| 2372907 | Bobby Priest | Bobby Priest | Prescott Valley | AZ | *(empty)* | *(empty)* | *(empty)* | 4 | 19.13 |
| 2246914 | Jamy Myrmel | Jamy Myrmel | DEWEY | AZ | *(empty)* | *(empty)* | *(empty)* | 4 | 18.05 |
| 2115901 | Martin Trout | Martin Trout | Prescott | AZ | *(empty)* | *(empty)* | *(empty)* | 2 | 5.17 |
| 2247058 | Al Weikart | Al Weikart | Prescott | AZ | *(empty)* | *(empty)* | *(empty)* | 1 | 4.00 |

`ProjectNumber` is a 7-digit numeric string, present on all 9 job projects, empty only on Shop, and consistent across every row of the same project. It looks like a stable identifier worth storing alongside the name (it survived byte-identically across two pulls — task 8). `Project` and `Customer` are always the identical string on job rows. City is inconsistent-case free text (`DEWEY` vs `Prescott Valley`). Sub-projects 1–6 are entirely unused.

## 4. Employees, verbatim

| FirstName | LastName | EmployeePosition | Hours | Days worked |
|---|---|---|---|---|
| Landen | Johnson | Employee | 66.5833 | 5 (07/20–07/24) |
| Aron | Bronson | Employee | 65.8000 | 5 (07/20–07/24) |
| Caden | Maier | Employee | 55.0833 | 5 (07/20–07/24) |
| Matthew | Hamby | Employee | 51.1167 | 5 (07/20–07/24) |
| Kyle | Floyd | Employee | 46.2000 | 5 (07/20–07/24) |
| Davey | Milligan | Employee | 35.7167 | 4 (07/20–07/23) |

Every row's `EmployeePosition` is the literal string `Employee`. The only dates in the file are Monday 07/20 through Friday 07/24 — no weekend rows. Spellings match `pec_prod_crew_members` exactly for the five crew names ("Matthew Hamby" not "Matt", "Davey Milligan" not "Dave").

## 5. How OT is represented — BOTH patterns occur, and REG caps at exactly 40.0

BusyBusy applies a weekly-40 model and represents it two ways depending on where the 40-hour line falls:

**(a) Split-window pairs.** When a single punch segment crosses an employee's 40th hour, the export emits TWO rows with the SAME `Start` and `End`: a REG row and an OT1 row whose `Hours` split the wall-clock span at the crossover point. The two rows' `Id`s are identical except the last two characters (`...00` vs `...01`). 5 such windows exist this week:

| Person | Date | Project | Start | End | Span | REG row Hours | OT1 row Hours |
|---|---|---|---|---|---|---|---|
| Matthew Hamby | 07/24 | Shop | 07-24 06:43 | 07-24 08:30 | 1.7833 | 0.9500 | 0.8333 |
| Kyle Floyd | 07/24 | Will Lewis | 07-24 08:30 | 07-24 18:54 | 10.4000 | 4.2000 | 6.2000 |
| Caden Maier | 07/23 | Matt Scharrer | 07-23 11:02 | 07-23 18:31 | 7.4833 | 5.1167 | 2.3667 |
| Landen Johnson | 07/23 | Matt Scharrer | 07-23 11:02 | 07-24 00:00 | 12.9667 | 5.3833 | 7.5833 |
| Aron Bronson | 07/23 | Shop | 07-23 00:00 | 07-24 00:00 | 24.0000 | 9.2000 | 14.8000 |

**(b) Whole-segment OT1.** Once an employee is past 40 hours, subsequent segments are emitted as single rows with `WageType = OT1` and no REG partner. 12 such rows this week (all dated 07/24 except Landen's 00:00–06:48 continuation).

Cross-check: for every employee with OT, REG hours sum to **exactly 40.0000** and OT1 carries the excess (Landen 40.00 + 26.58, Aron 40.00 + 25.80, Caden 40.00 + 15.08, Matthew 40.00 + 11.12, Kyle 40.00 + 6.20; Davey 35.72 with no OT1). Total OT1: 84.78 hours across 17 rows.

OT concentration: **30.55 OT1 hours on Shop, 54.23 on job projects.** (Aron's 25.80 is most of the Shop OT and is suspect — see task 7.)

Import implications:
- Hours never double-count: each hour of wall time appears in exactly one row. `hours` per window = sum of the window's rows; `ot_hours` = the OT1 rows' Hours.
- A naive dedup on (person, Start, End) or (person, Start, End, Project) would wrongly drop one side of a split pair. Dedup must include `WageType` (or just never dedup).
- **CONTRADICTS a Context assumption:** on OT1 rows the `Wage` column is exactly **1.5×** that employee's REG-row `Wage` (ratio verified for all five employees with OT). `Cost` = the row's own Wage × Hours, so **Cost DOES include the overtime premium** — the earlier conclusion that "their Cost pays overtime at straight time" was an arithmetic truth but a wrong interpretation. The per-row Cost figures are internally consistent and usable in principle; whether to trust them is a build decision, but the stated reason to ban them is wrong.

## 6. Hours reconciliation

Per ROW: 56 of 66 rows satisfy `Hours = (End − Start) − BreakHours` within 0.01 h. The 10 exceptions are exactly the 10 rows of the 5 split REG/OT1 pairs from task 5, where each row carries a share of the span.

Per WINDOW (rows grouped by person + Start + End + Project, Hours summed): **61 of 61 windows reconcile** within 0.01 h. Zero exceptions.

`BreakHours` is the literal string `0.0` on all 66 rows, so `Hours` net-of-breaks behavior is **untested** — no break was logged this week. `Hours` values are truncated (not rounded) repeating decimals at 6 places (`0.766666`, `4.116666`), so compare with tolerance, never exact equality.

## 7. Shop time-of-day profile

Dominant pattern for the five crew members: a short Shop block first thing in the morning (starts 06:32–07:01, typically 45 min to 2 h, ending 07:35–08:30) before switching to a job, occasionally a short midday Shop block between jobs (e.g. Caden and Landen 07/24, 11:55–13:27 — Caden's carries the only Shop description, `Plaza bowl`). Shop blocks do NOT bookend the day; there are no end-of-day Shop returns. The exceptions are whole days spent on Shop: Matthew and Landen and Caden all day 07/21 (06:39–17:50 range), Davey all day 07/22, Matthew until 13:10 on 07/23.

**The 45.5% Shop figure is heavily inflated by one anomaly.** Aron Bronson's entire week — 65.80 of the 145.95 Shop hours — is on Shop, and his 07/22–07/24 entries form one continuous unbroken punch from 07-22 07:52 to 07-24 07:39 (47.78 hours straight, split by the export at each midnight: 07:52→00:00, 00:00→00:00 [a full 24.0 h row], 00:00→07:39). That is almost certainly a forgotten clock-out, and it also manufactured most of his 25.80 OT1 hours. Excluding Aron entirely, Shop is 80.15 hours = 25.0% of the week's 320.50, or 31.5% of the five crew members' hours. The ops question should start with Aron's punch hygiene and the crew's 07/21 all-day Shop block, not with a blanket 45% number.

Non-empty Shop descriptions: `Plaza bowl` (Caden Maier, 07/24). That is the only one.

## 8. Idempotency test — the two pulls were BYTE-IDENTICAL

Requested the identical window (2026-07-20 00:00:00 → 2026-07-26 23:59:59) a second time, ~30 minutes after analyzing the first pull (both pulls same day, no edits in between).

- Excluding `Id`: all 66 rows identical.
- Including `Id`: **all 66 `Id` values identical, row for row.** The raw files are byte-for-byte identical (21,145 bytes each).

**This partially CONTRADICTS the working assumption.** The `Id` did not "move on its own" between identical requests — it is deterministic while the underlying data is unchanged. The doc's claim that the Id is calculated and changes when a punch is edited still stands (unverified — no edit occurred between pulls), and the split-pair structure (`...00`/`...01` suffixes on otherwise-identical Ids, with what look like time-derived components) supports "calculated." Conclusion for the build is unchanged — the Id still cannot be a durable primary key because any edit regenerates it — but delete-then-insert is validated by determinism, and the Id CAN safely be used within a single import run for change detection or logging.

## 9. Window boundary behavior — single-day pull matches the week pull exactly

Requested 2026-07-22 00:00:00 → 2026-07-22 23:59:59. Result: 11 rows, 61.5167 hours.

- The week pull contains exactly 11 rows dated 07/22 with exactly 61.5167 hours.
- Per-person hours identical in both (Aron 16.1333, Caden 7.6333, Davey 10.0167, Kyle 10.0000, Landen 7.9500, Matthew 9.7833).
- Segmentation identical: every (person, Start, End, Project, WageType, Hours) tuple matches. The API filters; it does not re-segment or re-classify per window. Notably Aron's 07:52→midnight 16.13 h row appears whole and identical in both pulls.

Midnight behavior: **no row crosses midnight with a nonzero time.** Multi-day punches are pre-split at exactly `00:00:00` (5 rows end at next-day 00:00:00; 4 rows start at 00:00:00). `Date` equals the date part of `Start` on all 66 rows, with zero disagreements. A row ending at `2026-07-23 00:00:00` is dated `07/22/2026`.

Together with task 8, this validates delete-then-insert keyed on `Date`: a request window aligned to whole days returns exactly the rows whose `Date` falls inside it, and those rows are stable across requests.

## 10. Empty range behavior — 200 with header-only CSV, NOT 404

Requested 2026-12-21 00:00:00 → 2026-12-27 23:59:59 (future, no data).

- HTTP status: **200** (not the 404 the doc claims).
- `content-type: text/csv; charset=UTF-8`, `content-length: 662`.
- Body: exactly the 45-column header row and nothing else.

The import should treat "200 with only a header row" as zero rows. The doc's 404 claim was not reproduced, but the import should still handle 404 as zero-rows defensively in case behavior differs on other inputs — while treating 401 and 5xx as failures that must NOT wipe a stored window.

## 11. Data hygiene flags

Clean on the obvious checks: 0 rows with empty `Project`, 0 rows with Hours ≤ 0, 0 rows with End before Start, 0 rows with End equal to Start, 0 rows where `Date` disagrees with `Start`'s date.

Non-empty `Description` values (2):
- Matthew Hamby, 07/20, Martin Trout: `Forgot to clock out at 330 monday`
- Caden Maier, 07/24, Shop: `Plaza bowl`

Things that would break a naive parser or import:
- **`EquipmentMakeModel` is a single space (`" "`), not empty, on every row.** Trim all fields before empties checks.
- **Duplicate (person, Start, End) windows** from REG/OT1 split pairs (task 5). Any uniqueness constraint or dedup must include `WageType`.
- **Overlapping punches exist:** Landen Johnson 07/22 has Shop 06:43→07:45 overlapping Nathan Rhodes 07:42→07:45 (a 0.05 h / 3-minute row). Summing by person-day still reconciles because the rows are as-recorded, but per-day wall-clock validation would flag it.
- **A 24.0-hour row** (Aron, 07/23, 00:00→00:00 next day) and a 16.13-hour row are legitimate rows in this file — do not clamp or reject long durations; flag them for review instead.
- `Hours` is a 6-decimal truncated repeating decimal — use tolerance comparisons.
- `SafetySignOffInjured` values seen: empty and `false`. `CorrectTimeSignOffTimeAccurate`: empty, `false`, `true`. Strings, not booleans; empty is common.
- `BudgetedHours`/`BudgetedCost`/`CostCode`/`CostCodeGroup`/`Equipment`/sub-projects: empty on all rows.
- `CreatedBy`/`LastEditedBy` are display names (including `Dylan Nordby` for admin edits) — useful audit hints, name-only like everything else.

## Summary of contradictions vs. the Context assumptions

1. **OT premium IS in Cost.** OT1 rows carry a Wage of exactly 1.5× the employee's REG wage, so Cost = Wage × Hours already includes the premium. The "Cost pays overtime at straight time" conclusion was wrong.
2. **The Id did not change between two identical requests** — byte-identical files. It is deterministic absent edits (still not a durable key, per doc, since edits regenerate it).
3. **Empty range returns 200 + header-only CSV,** not the documented 404.
4. **The 45.5% Shop share is an artifact:** Aron Bronson's continuous 47.78 h forgotten punch (07/22 07:52 → 07/24 07:39, all Shop) accounts for 65.80 of the 145.95 Shop hours. Excluding him, Shop is 25.0% of the week.
5. **The token has no expiry claim at all** — it can run unattended until BusyBusy revokes the session server-side, which can happen without warning.
