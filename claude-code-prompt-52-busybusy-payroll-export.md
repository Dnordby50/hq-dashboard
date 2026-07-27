# Prompt 52: BusyBusy Payroll Export as the hours source for job costing

Paste into Claude Code, or say "read claude-code-prompt-52-busybusy-payroll-export.md and build it."

---

## Provenance

Scoped by Cowork 2026-07-27 across sixteen questions plus a live discovery pull. Supporting files in this repo: `busybusy-discovery-findings.md` (Claude Code's own probe results, read it first) and the PROJECT-LOG entries dated 2026-07-27 titled "scoped the BusyBusy Payroll Export API", "first live BusyBusy Payroll Export pull analyzed", "verified the BusyBusy name-to-job join against PROD", and "discovery findings received, THREE Cowork conclusions corrected". This prompt supersedes `docs/archive/prompts/claude-code-prompt-busybusy-overtime-costing.md`, whose GraphQL premise is dead.

## What this is

Real crew hours have never reached job costing. `pec_prod_busybusy_time_entries` has zero rows, the GraphQL proxy `netlify/functions/pec-busybusy.cjs` has returned 401 since 2026-06-13, and every job reads "awaiting BusyBusy hours" while the office types hours by hand into `pec_prod_job_manual_labor`.

AlignOps has since supplied a different, working endpoint: `GET https://export.busybusy.io/?start=<YYYY-MM-DD HH:mm:ss>&end=<YYYY-MM-DD HH:mm:ss>` with header `Key-Authorization: <token>`, returning CSV. Build a weekly, admin-triggered, preview-then-commit import from that endpoint into job costing, and retire the GraphQL path.

**The one constraint that shapes everything: this is a snapshot API, not a sync API.** The returned `Id` is a calculated record. It is deterministic while data is unchanged (verified: two identical pulls were byte-identical), but any edit to a punch regenerates it, one row can split into three, and there is no `updatedSince`, no deletion feed, and no guarantee a row reappears. Storage is therefore **delete-then-insert by date range, atomically**. Never upsert on the export `Id`. Never write dedup logic against it.

## Facts already established. Do not re-derive these.

From the live pull of 2026-07-20 to 2026-07-26 (66 rows, 320.50 hours, 6 employees) and the discovery probe:

**CSV shape.** 45 columns, every field double-quoted including empties, UTF-8, LF endings. Header verbatim:

```
"Id","CreatedBy","LastEditedBy","EmployeeId","FirstName","LastName","EmployeePosition","EmployeeGroup","Date","Start","End","Wage","Hours","BreakHours","WageType","Cost","SafetySignOffInjured","CorrectTimeSignOffTimeAccurate","BudgetedHours","BudgetedCost","Customer","ProjectCity","ProjectState","ProjectGroup","ProjectNumber","Project","SubProject1Number","SubProject1","SubProject2Number","SubProject2","SubProject3Number","SubProject3","SubProject4Number","SubProject4","SubProject5Number","SubProject5","SubProject6Number","SubProject6","CostCode","CostCodeDescription","CostCodeGroup","Equipment","EquipmentMakeModel","EquipmentMeterReading","Description"
```

- `Date` is `MM/DD/YYYY`. `Start`/`End` are `YYYY-MM-DD HH:mm:ss`, minute resolution.
- Times are **local Arizona**, not UTC. Arizona does not observe DST, so a fixed `-07:00` offset is always correct. Build `timestamptz` values with an explicit `-07:00`; never let the runtime guess.
- `Date` equals the date part of `Start` on every row, with zero disagreements. **Use the `Date` column as `work_date`.** Do not re-derive it from timestamps.
- Multi-day punches are pre-split by BusyBusy at exactly `00:00:00`, so no stored row spans midnight.
- `EmployeeId`, `EmployeeGroup`, `CostCode`, `CostCodeGroup`, `BudgetedHours`, `BudgetedCost`, and all six sub-project pairs are empty on every row.
- `EquipmentMakeModel` is a single space `" "` on every row. Trim every field before testing for empty.
- `Hours` is a truncated repeating decimal at six places (`0.766666`, `4.116666`). Always compare with tolerance, never equality.

**Overtime.** `WageType` is `REG` or `OT1`. BusyBusy caps REG at exactly 40.0000 per employee per week across all projects, then represents the overflow two ways: (a) a **split pair**, two rows sharing the same `Start` and `End` and project, one REG and one OT1, whose `Hours` divide the span at the crossover, with `Id`s differing only in the last two characters; and (b) whole-segment `OT1` rows for everything after. Each hour of wall time appears in exactly one row, so summing never double counts. **Any uniqueness constraint or dedup MUST include `WageType`**, or a split pair silently loses half its hours.

**Their `Wage` and `Cost`.** On OT1 rows `Wage` is exactly 1.5x that employee's REG wage, so `Cost` does include the overtime premium. It does **not** include our 25 percent burden, so it is not loaded labor. Do not import `Wage` or `Cost` at all, and do not store them. Costing uses `pec_prod_crew_members.hourly_wage` and our existing burden, exactly as today.

**Projects are customer names.** `ProjectNumber` is a stable 7-digit string present on all nine job projects, empty only on "Shop", identical on every row of a project and across both pulls. Cowork verified against prod that eight of the nine project names match exactly one `pec_prod_jobs.customer_name` after lowercasing and collapsing whitespace. "Matt Scharrer" (2227346, 27.25 hours) matches nothing in `pec_prod_jobs` or `public.customers`. A surname-only match is proven dangerous on this data: "Gordon" also hits "Gordon  Clarry" (note the double space in the stored name) and "Rhodes" also hits "Wayne Rhodes".

**Employees are name-only.** `FirstName` + `LastName` is the sole identity. `pec_prod_crew_members` has 7 rows: Allen Adamo, Caden Maier, Davey Milligan, Kyle Floyd, Landen Johnson, Matthew Hamby, Preston. Four carry a `busybusy_member_id` GUID which is now dead weight. Five of the six exported names match a crew member exactly. Aron Bronson does not and must not; he is a salesperson. Note "Preston" is stored with no surname, which is precisely the case that breaks exact-name matching.

**Empty range returns HTTP 200 with a header-only CSV**, not the documented 404.

**Token.** A 3-segment JWT, `aud: busybusy-v3-member-session`, **no `exp` claim**. It does not self-expire, so unattended running is technically possible, but it is a member session: a logout, password change, or server-side prune kills it with no warning, exactly as happened to the GraphQL key. Goes in Netlify env as `BUSYBUSY_EXPORT_TOKEN`. Never in code, never in a log entry, never returned to the browser.

## Locked decisions

Every one of these came from Dylan directly. Do not relitigate them; if one turns out to be unbuildable, stop and write it up rather than substituting your own.

1. **Scope is job-costing hours only.** No payroll processing surface, no pay-period export screen.
2. **Manual trigger, in Settings, admin only.** No scheduled function. Weekly cadence in practice.
3. **Two-week window per pull** (the week being costed plus the one before), because delete-replace is idempotent and late punch edits are the common failure.
4. **Preview then commit.** The pull shows its numbers and the admin presses Import. Dylan's words: "flag anomalies, we will make sure they are accurate before we import them, manually."
5. **Shop hours are overhead.** Stored and reported, never charged to a job, never in a bonus pool.
6. **Project link: name once, then number.** On first sight of a project, auto-link by exact normalized customer name; persist its `ProjectNumber`. Thereafter the number is the key, so renames never break an established link.
7. **Employee link: a mapping screen in Settings**, listing every distinct BusyBusy name ever seen against a crew member dropdown, with an explicit Ignore (Aron and any other non-production person). Only mapped, non-ignored people feed costing.
8. **Overtime: accept BusyBusy's attribution.** OT hours land on whatever job the person was on when they crossed hour 40. **Documented tradeoff, recorded deliberately:** a job running Thursday and Friday absorbs premium labor unrelated to that job, and its crew's bonus pool shrinks accordingly. Dylan chose this because it matches payroll exactly and every figure traces to a punch. Do not "improve" it.
9. **Anomalies import and are flagged**, never silently dropped, altered, clamped, or auto-corrected. The 47.78-hour punch and the 24.00-hour row in the sample week are legitimate rows.
10. **BusyBusy is the source of truth going forward.** A job with BusyBusy hours uses them; its manual entries stay visible but greyed and labeled. Manual entry remains available where there is no BusyBusy coverage.
11. **Never recalculate a paid bonus.** Details in Part F.
12. **Retire the GraphQL proxy** in this build.
13. Settings-backed parameters per standing rule 12; What's New entry per standing rule 11; `@artifacts` header per standing rule 13.

## Part A. Schema

New migration `supabase/migrations/2026-07-27_busybusy_export.sql`. Write it, do not apply it; Cowork applies migrations.

**Replace `pec_prod_busybusy_time_entries`.** It has zero rows and its entire design (unique `busybusy_entry_id`, upsert, soft delete) is the pattern this API forbids. Drop and recreate. New shape, one row per CSV row, verbatim fidelity:

`id` uuid pk; `import_id` uuid not null references the imports table on delete cascade; `work_date` date not null (from the `Date` column); `employee_name` text not null (`FirstName` + space + `LastName`, verbatim); `crew_member_id` uuid null references `pec_prod_crew_members(id)` on delete set null; `busybusy_project_number` text null; `busybusy_project_name` text null; `job_id` uuid null references `pec_prod_jobs(id)` on delete set null; `is_overhead` boolean not null default false; `started_at` timestamptz; `ended_at` timestamptz; `hours` numeric(10,4) not null default 0; `wage_type` text not null; `break_hours` numeric(10,4) not null default 0; `description` text; `source_export_id` text (the export `Id`, for logging and change detection **within a single run only**); `created_at` timestamptz not null default now().

Deliberately absent: any wage or cost column. Note this in the migration comments so a future session does not "helpfully" add one.

Indexes on `(work_date)`, `(job_id)`, `(crew_member_id)`, `(import_id)`.

**`pec_prod_busybusy_imports`** (the audit trail and the unit of replacement): `id` uuid pk; `window_start` date not null; `window_end` date not null; `imported_by` uuid; `imported_at` timestamptz not null default now(); `row_count` int; `total_hours` numeric; `ot_hours` numeric; `overhead_hours` numeric; `employees_seen` int; `unmapped_employees` text[]; `unlinked_projects` text[]; `anomaly_count` int; `notes` text.

**`pec_prod_busybusy_projects`** (the remembered link): `id` uuid pk; `project_number` text; `project_name` text not null; `job_id` uuid null references `pec_prod_jobs(id)` on delete set null; `is_overhead` boolean not null default false; `linked_by` uuid; `linked_at` timestamptz; `created_at`. Unique index on `project_number` where it is not null and not empty; unique index on `lower(project_name)` where `project_number` is null or empty (this is how "Shop" is keyed). Seed one row: project_name 'Shop', is_overhead true.

**`pec_prod_busybusy_employees`** (the mapping screen's table): `id` uuid pk; `busybusy_name` text not null unique; `crew_member_id` uuid null references `pec_prod_crew_members(id)` on delete set null; `ignored` boolean not null default false; `first_seen_at`; `updated_at`.

**RLS:** match the existing costing posture. Read for `is_admin_staff()`; writes go through the server (service role) or are admin-gated. Do not widen anything. `pec_prod_jobs.busybusy_project_id` (added 2026-06-13 for GraphQL GUIDs) is now dead; leave the column, do not read it, and say so in the migration comment.

**The atomic replace.** Delete-then-insert across two supabase-js calls is not acceptable for this data: a failure between them empties a window. Create a `security definer` function `public.pec_busybusy_import(p_window_start date, p_window_end date, p_rows jsonb, p_user uuid) returns uuid` that, in one transaction: inserts the `pec_prod_busybusy_imports` row, deletes every `pec_prod_busybusy_time_entries` row whose `work_date` is between the window bounds inclusive, inserts the new rows from the jsonb payload, and returns the new import id. Grant execute to `authenticated` and gate the body on `is_admin_staff()`. Because a function is not expressible in the four `@artifacts` kinds, declare `none:` with that reason per standing rule 13, and declare the tables, columns, indexes, and settings keys that ARE expressible.

**Settings keys** (seed in the migration): `busybusy_import_window_weeks` (2), `busybusy_anomaly_hours_threshold` (16), `busybusy_overhead_project_names` ('Shop'), `busybusy_export_base_url` ('https://export.busybusy.io/'). Editable in Settings under the existing Integrations or Schedule/Production heading.

## Part B. The fetch and parse function

New `netlify/functions/pec-busybusy-export.cjs` (`.cjs` deliberately). Session-gated exactly like the existing functions, and additionally admin-gated. Two modes on the same endpoint, `mode=preview` and `mode=commit`.

Both modes fetch server-side from `BUSYBUSY_EXPORT_TOKEN` and never return the token or any wage figure to the browser.

**Response handling, all four cases explicitly:**
- 200 with data rows: parse.
- 200 with only a header row: zero rows. A legitimate, successful, empty result.
- 404: also treat as zero rows (defensive, since the doc claims it even though we observed 200).
- 401, or any 5xx, or a network failure: **hard failure**. Return an error that names the likely cause (401 means the member session is dead and Dylan must supply a fresh token). **Never proceed to the delete step on a failure.** This is the rule that stops a bad credential from wiping a stored window.

**Parsing rules:** use a real quoted-CSV parser, not a split on commas (`Description` is free text). Trim every field. Reject the response if the header row does not match the expected 45 columns, naming the difference, rather than silently mis-mapping.

**Per-row classification:**
1. `employee_name` = trimmed `FirstName` + " " + `LastName`. Resolve against `pec_prod_busybusy_employees`. Unknown name: create a row with `crew_member_id` null and report it as unmapped. Ignored or unmapped: the row is still stored, but `crew_member_id` stays null and it never reaches costing.
2. Project: look up `pec_prod_busybusy_projects` by `ProjectNumber` first; if the number is empty, by lowercased whitespace-collapsed `project_name`. On a miss, create the row and attempt the one-time auto-link: exact match of the normalized project name against normalized `pec_prod_jobs.customer_name`. Exactly one match links it and stores the number. Zero or more than one match leaves `job_id` null and reports it as unlinked. When more than one job matches, disambiguate by whether the row's `work_date` falls inside that job's `pec_prod_job_schedule_days.scheduled_date` range; if exactly one job survives, link it, otherwise leave it for a human.
3. `is_overhead` true when the project matches `busybusy_overhead_project_names` or its linked project row is flagged overhead. Overhead rows never carry a `job_id`.
4. `hours` from `Hours`, `wage_type` from `WageType`, stored verbatim per row. **Do not collapse split pairs into one row.** Aggregation happens at read time (Part F).

**Anomaly detection** (reported, never acted on): any single row with `hours` greater than `busybusy_anomaly_hours_threshold`; any two rows for the same employee whose `started_at`/`ended_at` overlap; `hours` at or below zero; `ended_at` before `started_at`; a non-empty `Description` (these are usually punch corrections, and one in the sample says "Forgot to clock out at 330 monday").

**Preview** returns: row count, distinct employees, total hours, REG versus OT1 hours, overhead versus job-attributed hours, per-job hours, the unmapped employee list, the unlinked project list with hours, and the anomaly list with enough detail to find each in BusyBusy (person, date, times, project). No writes.

**Commit** re-fetches (do not trust a client-supplied payload), then calls the `pec_busybusy_import` RPC with the parsed rows. Return the same summary plus the new import id, and note any difference from the preview's counts.

## Part C. The Settings panel

Admin only, under Settings. A window picker defaulting to the last `busybusy_import_window_weeks` full weeks (Monday through Sunday), a "Fetch preview" button, the summary described above rendered plainly, and an "Import" button that is disabled until a preview has been fetched. Unmapped employees, unlinked projects, and anomalies each render as a short list with a direct link to the relevant management section. Anomalies never block the button, per decision 9, but they are displayed above it, not below.

An import history table beneath it: the last ten `pec_prod_busybusy_imports` rows with window, who, when, and counts. Re-importing a window is safe and expected; make that visible so nobody fears the button.

## Part D. Employee mapping

A section in the same panel listing every `pec_prod_busybusy_employees` row: the BusyBusy name, a crew member dropdown, an Ignore toggle, and total hours seen. New unmapped names sort to the top. Changing a mapping applies to future imports and re-resolves existing rows in place (a plain UPDATE of `crew_member_id` on stored rows matching that name, which is safe because it changes attribution, not hours).

Make it visible that "Preston" has no surname in `pec_prod_crew_members` and will not auto-match a full BusyBusy name. The mapping screen is the fix; do not add fuzzy name matching anywhere.

## Part E. Unlinked projects

A section listing `pec_prod_busybusy_projects` rows with no `job_id` and not flagged overhead: project number, name, total hours, first seen. Each row gets a job search picker (reuse the existing customer/job search) and a "Mark as overhead" action. Linking re-resolves stored rows for that project in place, same as Part D.

Matt Scharrer (2227346, 27.25 hours) will be sitting here on the first import. That is correct behavior, not a bug: there is genuinely no such job in the system.

## Part F. Job costing integration

**Read model.** For a job, per crew member: `hours` = sum of all stored rows for that `job_id` and `crew_member_id`; `ot_hours` = sum of those rows where `wage_type` is `OT1`. This preserves the existing convention from `2026-06-19_ot_hours.sql` that `hours` is TOTAL and regular equals `hours` minus `ot_hours`, so `computeCrewBonus` needs no change to its math. Rows with a null `crew_member_id`, or `is_overhead` true, are excluded from every job total.

**Precedence.** A job with any BusyBusy rows uses them. Its `pec_prod_job_manual_labor` entries stay visible, greyed, and labeled so the before and after is legible; they are not deleted and not counted. A job with no BusyBusy coverage keeps manual entry exactly as today. Label the source on screen so nobody has to guess which produced a number.

**Finalized jobs, the money rule.** Do not write to `pec_prod_job_bonuses` or `pec_bonus_payouts` from the import, ever. A finalized job's ledger rows already hold their amounts, so a changed hour count cannot move a paid bonus, and that safety is structural rather than conditional. What you must add is **visibility**: where BusyBusy hours for a crew member differ from the `hours_actual` snapshot on that job's `pec_prod_job_bonuses` row, show a plain "Hours changed since finalize: was X, now Y" note in the costing detail. Dylan then decides, using prompt 50's existing Pay full / Reduce / Void review gate, whether anything should change. Do not automate that decision and do not set `review_status` from the import.

Note for the record: an earlier Cowork log entry said the import would flag such bonuses through `review_status`. This is the corrected, safer instruction. Display only, no writes to bonus tables.

## Part G. Retirement and housekeeping

Delete `netlify/functions/pec-busybusy.cjs` and any client code that calls it. Remove its env vars from documentation (`BUSYBUSY_API_URL`, `BUSYBUSY_AUTH_HEADER`, `BUSYBUSY_AUTH_PREFIX`); leave `BUSYBUSY_API_TOKEN` alone in Netlify for Dylan to delete by hand. Update `features.json` for the BusyBusy entry and every costing entry whose hours source changed. Append the What's New entry (plain language, no em dashes). Move `docs/archive/prompts/claude-code-prompt-busybusy-overtime-costing.md` references into the past tense in any doc that cites it as pending.

## Guardrails

- `computeCrewBonus`, `computeCostingRow`, `effectiveLaborBudget`, and `aggregateCostingRows` keep their current math. This build changes where hours come from, nothing about how they are turned into money.
- No RLS widening. No change to `pec_prod_jobs_status_check` or any existing constraint.
- Never import, store, or display BusyBusy's `Wage` or `Cost`.
- Never delete a stored window except inside the RPC, and never on a failed fetch.
- No em dashes in any user-facing string.
- `npm test` (25 tests) green before and after every commit.
- Commit per part, each revertible alone.

## Preflight

Before writing code: read `busybusy-discovery-findings.md`, read `SCHEMA.md` for `pec_prod_job_manual_labor`, `pec_prod_job_bonuses`, `pec_bonus_payouts`, `pec_prod_crew_members`, and `pec_prod_job_schedule_days`, and check `features.json` for the costing and BusyBusy anchors rather than grepping `index.html` blind. Confirm the actual `review_status` values before writing anything near the bonus review gate, and confirm whether any live code still calls `pec-busybusy.cjs` before deleting it.

If any part of this cannot be built as specified, stop and write it up rather than shipping a half version. In particular: if the RPC approach conflicts with something in the existing Supabase setup, say so before falling back to a non-atomic delete-then-insert.

## Handoffs

Expect to end with a `## Handoff to Cowork` (apply the migration, verify the new tables and settings keys, refresh `SCHEMA.md`) and a `## Handoff to Dylan` (set `BUSYBUSY_EXPORT_TOKEN` in Netlify, fix Aron Bronson's 47.78-hour punch in BusyBusy before the first real import, and decide what the Matt Scharrer hours belong to).
