# Claude Code task: BusyBusy Payroll Export discovery (read-only, no build)

Paste this into Claude Code, or just say: "read busybusy-discovery-prompt.md at the repo root and do it."

---

## Context

Repo: `/Users/dylannordby/Claude-Code/HQ-Dashboard` (TopCoat, PEC production dashboard). Deploy: Netlify. This is a DISCOVERY task only. Do not write app code, do not touch the schema, do not modify `netlify/functions/pec-busybusy.cjs`, do not build anything. The output is one findings file that Cowork will use to write the real build prompt (prompt 52).

AlignOps sent the BusyBusy Payroll Export API doc v2.1 (2026-07-10). The endpoint is `GET https://export.busybusy.io/?start=<YYYY-MM-DD HH:mm:ss>&end=<YYYY-MM-DD HH:mm:ss>` with header `Key-Authorization: <token>`, returning CSV. This is a DIFFERENT endpoint from `graphql.busybusy.io`, which `pec-busybusy.cjs` proxies and which has returned 401 since 2026-06-13. Dylan already pulled the week of 2026-07-20 to 2026-07-26 successfully; the file is at `~/bb_week.csv` (66 rows, 320.50 hours, 6 employees). The token that worked was a full BusyBusy member-session JWT, not the short integration key.

The API is a SNAPSHOT, not a sync. Per doc sections 6, 11 and 14: the returned `Id` is a calculated record regenerated per request, it changes when anyone edits a punch or adds a break, there is no `updatedSince`, no deletion feed, and no guarantee a row reappears. The planned storage model is therefore delete-then-insert by date range. Several questions below exist specifically to validate that model before it is built.

**Already established by Cowork. Do not spend time re-deriving these:**

- `WageType` values include `REG` and `OT1`. 84.78 hours across 17 rows are OT1, so BusyBusy does classify overtime.
- Every row's `Cost` equals `Wage` x `Hours` exactly, including OT1 rows, so their Cost pays overtime at straight time and must never be used for costing.
- 145.95 of 320.50 hours (45.5%) are on a project named "Shop" with no customer.
- `EmployeeId`, `EmployeeGroup`, and `CostCode` are empty on all 66 rows. Identity is name-only.
- Project names are customer names. The 9 job projects that week: Bobette Weiss 29.5, Nathan Rhodes 29.4, Matt Scharrer 27.3, Scott Gordon 21.3, Will Lewis 20.7, Bobby Priest 19.1, Jamy Myrmel 18.1, Martin Trout 5.2, Al Weikart 4.0.
- Cowork already checked those names against prod. Eight of the nine match EXACTLY ONE `pec_prod_jobs.customer_name` after lowercasing and collapsing whitespace. "Matt Scharrer" matches nothing, so those 27.3 hours have no job in the system. Do not re-run that check.
- `pec_prod_crew_members` has 7 rows: Allen Adamo, Caden Maier, Davey Milligan, Kyle Floyd, Landen Johnson, Matthew Hamby, Preston. Four carry a `busybusy_member_id` GUID, which is useless now that `EmployeeId` comes back empty. Five of the six names in the export match a crew member exactly. Aron Bronson does not and should not, he is a salesperson.

## Hard rules for this task

- NEVER print the token, echo it into a file, or commit it anywhere. Read it from an env var or prompt for it with `input()`.
- The findings file must contain NO wage figures and NO dollar amounts. Hours, counts, names, times, and project strings only.
- Read-only against BusyBusy. Never POST, PATCH, or DELETE against their API.
- Do not run more than about 6 API calls total.

## Tasks

### 1. Token lifetime

Determine whether the working token expires. Decode the JWT payload locally (do not send it anywhere) and report the `exp`, `iat`, `sub`/`memberId`, `organizationId`, and any scope or type claim, plus the expiry as a human date. If it is not a JWT, or has no `exp`, say so plainly. **This single answer decides whether the integration can run unattended, so lead the findings file with it.**

### 2. Exact CSV shape

From `~/bb_week.csv`: the header row verbatim in order, total row count, quoting style, and whether every row has the same field count. Then the exact formats of `Date`, `Start`, and `End`, and whether `Start`/`End` are local Arizona time or UTC. Evidence for the timezone: report the earliest `Start` time of day in the file. A 06:00 first punch is local; a 13:00 first punch means UTC and every date boundary in the build has to shift.

### 3. Projects, verbatim

A table of every distinct project: `ProjectNumber`, `Project`, `Customer`, `ProjectCity`, `ProjectState`, `ProjectGroup`, `SubProject1Number`, `SubProject1`, with row count and total hours each. Include "Shop". I need the literal `ProjectNumber` values to decide whether it is a stable identifier worth storing or noise.

### 4. Employees, verbatim

Every distinct `FirstName` + `LastName` exactly as spelled, with `EmployeePosition`, total hours, and days worked. Exact spelling matters because name is now the only join key.

### 5. How OT is represented, per row

This determines how the import populates `hours` and `ot_hours`, so be precise. For a person-day that contains OT, does the export emit a separate `OT1` row alongside the `REG` row for the same project and day, or does it reclassify the whole segment? Show two or three complete real examples (person, date, project, start, end, hours, wage type) side by side. Also report whether OT1 rows are concentrated in Shop or in job projects, and the OT hours split between the two.

### 6. Hours reconciliation

For every row, does `Hours` equal `(End - Start) - BreakHours`? Report how many rows reconcile and show any that do not. This tells us whether `Hours` is already net of breaks or whether the import has to subtract them.

### 7. Shop time-of-day profile

For rows on the "Shop" project: start and end times, blocks per person per day, and whether Shop blocks bookend the day (morning and evening) or run continuously through it. Also print any non-empty `Description` values on Shop rows. This feeds a separate operations question about why shop time is 45% of the week.

### 8. Idempotency test (validates the whole storage design)

Request the exact same window (`2026-07-20 00:00:00` to `2026-07-26 23:59:59`) a second time into a new file. Compare it to the first pull **twice**: once including the `Id` column, once excluding it. Report whether the non-Id data is identical and, separately, whether the `Id` values changed between two identical requests. If the Ids move on their own, that is direct proof the Id cannot be a key and belongs in the findings.

### 9. Window boundary behavior

Request a single day, `2026-07-22 00:00:00` to `2026-07-22 23:59:59`. Compare those rows to the rows dated 07/22 in the week-long pull: same row count, same hours per person, same segmentation? If they differ, the API is not simply filtering, and the delete-then-insert window logic has to account for it. Also report whether any entry in either file spans midnight, and whether the `Date` column ever disagrees with the date part of `Start`.

### 10. Empty range behavior

Request a future week with no data (for example `2026-12-21 00:00:00` to `2026-12-27 23:59:59`). Report the HTTP status and the exact response body. The doc claims 404 for no data; the import needs to treat that as "zero rows," not as an error, and it also must not wipe a stored window on a transient failure.

### 11. Data hygiene flags

Count rows where `Project` is empty (as opposed to "Shop"), where `Hours` is 0 or negative, where `End` is before `Start`, and where `Description` is non-empty (list those descriptions; one is known to say "Forgot to clock out at 3:30 Monday"). Note anything else that would break a naive parser.

## After

1. Write the results to `busybusy-discovery-findings.md` at the repo root. Structure it in the order of the tasks above, lead with the token-lifetime answer, and keep it factual. No wages, no dollar figures, no token.
2. Append a PROJECT-LOG.md entry at the TOP per the standing rules, `By: Claude Code`, describing what was probed and what was found, especially anything that contradicts the assumptions listed in Context.
3. Commit only `busybusy-discovery-findings.md` and `PROJECT-LOG.md`, message `busybusy: discovery pull findings (read-only)`. Do NOT push.
4. Print the full contents of the findings file in chat so Dylan can hand it straight to Cowork.

If any task is impossible (the token has expired, the API rate-limits, a file is missing), write that down rather than working around it. A recorded failure is more useful here than a substitute result.
