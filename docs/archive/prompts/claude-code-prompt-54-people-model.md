# Claude Code prompt 54: the People model (one person record across logins, sales, and crew) plus birthdays

## Provenance

Dylan's ask (2026-07-28): "map team members, crew, and users together on one table."

This is not a new idea. It is the People model build framed and locked on 2026-07-16. That framing stands and is not up for re-litigation in this session:

- **ONE person = one record** carrying role labels and permissions (Login/User, Sales rep, Crew member). Not four tables.
- **Crews stay a separate grouping** that people are assigned to. A crew is not a person.
- **Migration is phased and reversible.** Old tables stay live; nothing gets dropped in this build.
- **Birthdays fold in here**, not as a separate build: one birthday field per person, month/day only (no year, no age shown anywhere), mandatory on new adds, a backfill nag for existing people, reminder as an admin dashboard banner AND everyone's bell at 7 days out.

Answered 2026-07-28, on top of that framing:

- Build the unified table **now**. Dylan explicitly declined the read-only-join-first option.
- **The new table is the source of truth; the old tables are mirrored** from it so existing readers keep working. Dylan's words: "your suggestion, new table can be a view if needed" — meaning if you get into the build and the mirror-trigger direction proves worse than starting with a view over the old tables, take the view and say so in the log entry. That is a permitted retreat, not a default.
- Birthdays are **in this build**.

Read before you start: CLAUDE.md, the top 3 entries of PROJECT-LOG.md, SCHEMA.md for every table named below, and features.json entries for Users/permissions, Sales Team, Crews, Crew bonus, Commission, and BusyBusy.

---

## Facts already established. Do not re-derive these.

Today a person can exist in up to four places at once. Live row counts as of 2026-07-28:

| table | rows | what it holds | who reads it |
|---|---|---|---|
| `admin_users` | 6 | logins: `auth_user_id`, email, name, role (`admin`/`office`), company | 22 places in index.html, 16 netlify functions, and RLS helpers throughout `supabase/` |
| `user_permissions` | 6 | 8 capability booleans, FK `admin_user_id` → `admin_users.id` | `renderSettingsUsers` index.html:17856, `pec-create-staff.cjs` |
| `pec_sales_team_members` | 2 | `commission_pct`, `exclude_from_commission`, Google calendar tokens, `auth_user_id` (partial-unique) | `pec-appt-*.cjs`, `pec-google-*.cjs`, `_pec-appt.cjs`, commission view, estimator salesperson default |
| `pec_prod_crews` | 4 | crew grouping (name, active, notes) | schedule, run sheet, bonus, BusyBusy |
| `pec_prod_crew_members` | 7 | `crew_id`, name, `hourly_wage`, `active`, dead `busybusy_member_id` | bonus math, costing, days off, BusyBusy mapping |
| `pec_prod_crew_member_days_off` | 0 | FK → `pec_prod_crew_members.id` | schedule capacity |

Settings surfaces these in three separate cards today: Sales Team (index.html:17642), Crews (index.html:17687), Team Members (index.html:17710), plus the Users tab (index.html:17856). index.html:17855 carries the comment that made this split deliberate at the time: "Crews / Crew Members stay separate (they are field workers, not logins)." That assumption is what this build retires.

### Five landmines. Each one has broken something before or is one rename away from it.

1. **Commission attribution is matched by free-text lowercased NAME, not by id.** `pctByName` is built from `pec_sales_team_members.name` at index.html:15603-15605 and matched against the salesperson text on `pec_job_ar`. Renaming a person in a unified table therefore silently changes historical commission math. Any name change path in this build must either preserve the old string as an alias or be blocked. Say which you chose.
2. **Crew bonus labor cost is `hours x hourly_wage x 1.25`**, wage read from `pec_prod_crew_members.hourly_wage` (index.html ~28163). If the mirror drops or nulls a wage, bonuses silently go wrong and nobody notices until payout.
3. **BusyBusy maps to people by `pec_prod_busybusy_employees.crew_member_id` → `pec_prod_crew_members.id`** (prompt 52, live since 2026-07-27). `pec_prod_crew_members.busybusy_member_id` is DEAD; do not treat it as the link. Breaking `pec_prod_crew_members.id` stability breaks every imported hour's attribution.
4. **`admin_users` is load-bearing for RLS.** There are ~206 references to the admin/staff helpers across `supabase/`. Do not change `admin_users`' shape, PK, or the meaning of `role` in this build.
5. **`pec_sales_team_members.auth_user_id` has a partial unique index** (`uq_pec_sales_team_members_auth_user`, one login maps to at most one member) and the estimator's current-user salesperson default (prompt 47) depends on it.

Also true and easy to forget: users and permissions were **already** merged into Settings > Users in an earlier build. What is still scattered is Sales Team + Team Members + Users.

---

## Locked decisions

1. One `people` table is the source of truth. `admin_users`, `pec_sales_team_members`, and `pec_prod_crew_members` remain and are kept in sync FROM it.
2. Roles are multi-valued on one person: a person can be a login AND a sales rep AND a crew member. Model this as either a `person_roles` child table or boolean role columns; pick one, justify it in the log entry.
3. Crews stay `pec_prod_crews`. A person gets assigned to a crew; a crew is not a person and does not move into `people`.
4. **Nothing is dropped in this build.** No `drop table`, no `drop column`, on any of the four legacy tables. Reversibility means Dylan can turn the mirror off and the app still runs.
5. Birthdays: month/day only. No year stored anywhere, no age displayed anywhere. Required on new adds, nagged for existing.
6. Dedupe is **human-confirmed, never automatic.** See Part B.
7. Settings gets a **People** surface. The three existing cards (Sales Team, Crews, Team Members) and the Users tab stay functional during this build; how they eventually fold in is a later phase.

---

## Part A. Schema

New migration `supabase/migrations/2026-07-28_people_model.sql`, `@artifacts` header per standing rule 13, written by you and applied by Cowork (standing rule 8).

`people` needs at minimum: id, full name, preferred/display name, email (nullable, a crew member may have none), phone, `birth_month` + `birth_day` (both nullable smallint with CHECK ranges, and a CHECK that they are both-null-or-both-set), active, created/updated.

Role linkage: whatever shape you choose in decision 2, a person row must be able to point at its counterpart row in each legacy table (`admin_user_id`, `sales_team_member_id`, `crew_member_id`, all nullable). Those pointers ARE the identity map and are what the mirror writes through.

Do not put `hourly_wage` or `commission_pct` on `people` in this build unless you also move their readers. If you leave them on the legacy tables, the People screen edits them there. Either is defensible; pick one and be consistent, because the half-and-half version is how wages get lost.

RLS: `people` is staff-visible, admin-writable, using the existing helpers. Do not invent a new permission concept; `can_manage_team` already exists on `user_permissions`.

Settings keys per standing rule 12, at least: birthday reminder on/off, and lead days (default 7).

---

## Part B. Backfill and dedupe (the part that actually decides whether this build is safe)

Write the backfill as part of the migration for the unambiguous cases, and a **review screen** for the rest. Do not name-match blindly across tables. The data will not cooperate: prompt 52 already established that at least one crew member ("Preston") is stored with no surname in `pec_prod_crew_members`, which is exactly the shape that both fails to auto-match and falsely auto-matches.

- Auto-merge only on a hard key: same `auth_user_id` across `admin_users` and `pec_sales_team_members`.
- Everything else (name similarity, email similarity) is a **suggestion** presented to Dylan on a one-time reconciliation screen with a Merge / Keep separate control per pair, defaulting to Keep separate.
- With 6 + 2 + 7 = 15 legacy rows, the worst case is a short list. Do not over-engineer the matcher; make the screen good and let a human resolve 15 rows once.
- Log the resulting counts in the PROJECT-LOG entry: people created, pairs merged, pairs left separate.

---

## Part C. The mirror

Triggers on `people` (and on the role linkage) that write through to `admin_users`, `pec_sales_team_members`, and `pec_prod_crew_members` so every existing reader keeps reading what it reads today.

Non-negotiables:

- `pec_prod_crew_members.id` values must not change. BusyBusy hour attribution and days-off rows hang off them.
- `admin_users.id` values must not change. `user_permissions.admin_user_id` FKs it.
- `hourly_wage` and `commission_pct` must survive the backfill byte-for-byte. Add a verification query at the bottom of the migration that asserts the pre- and post- sums are identical, in the same style as the prompt-52 migration's Verify block.
- Name changes: implement whatever you decided for landmine 1, and make it impossible to rename a person through the People screen in a way that silently re-attributes commission.
- The mirror must be switch-off-able. A `settings` flag or a disable-trigger path, documented in the log entry, so "turn it off" is a real rollback and not a code deploy.

If, while building this, the trigger direction is clearly worse than making `people` a view over the legacy tables plus the identity map: take the view, ship it, and write the reason in the log entry. Dylan pre-authorized that retreat.

---

## Part D. The People screen

New Settings surface listing every person once, with columns for the roles they hold, crew assignment, wage (crew), commission % (sales), login/auth state, active, and birthday. Editing a person edits one row.

- Duplicates across the old tables should be visibly gone. That dedup is the entire point of the ask.
- Crew assignment is editable from here (assign a person to a `pec_prod_crews` row).
- Keep Settings > Users, Sales Team, Crews, and Team Members working. They are the fallback if the mirror misbehaves.
- The table will be wide. Prompt 53 adds the global `.pec-table-wrap { overflow-x:auto }` rule; if 53 has not shipped when you build this, add that rule here rather than shipping another table that runs off the page.

---

## Part E. Birthdays

- Month/day only, on `people`. No year. No age anywhere in the UI.
- Required on new adds.
- Backfill nag: a dismissible prompt (admin-visible) listing people with no birthday set, until the list is empty.
- Reminder at N days out (setting, default 7): an admin dashboard banner AND a bell notification for every user. Use the existing `pec_notifications` path, including `target_view` / `target_id` so the notification deep-links (prompt 27 established that pattern).
- Do not email or text anyone. In-app only in this build.

---

## Guardrails

- No `drop table` or `drop column` on `admin_users`, `user_permissions`, `pec_sales_team_members`, `pec_prod_crews`, `pec_prod_crew_members`, or `pec_prod_crew_member_days_off`.
- Do not change `admin_users`' shape, PK, or the meaning of `role`. RLS across the whole database depends on it.
- Do not touch `pec_prod_busybusy_employees` or anything else prompt 52 shipped.
- Do not store a birth year, and do not display an age, even as a tooltip.
- Never commit a credential.
- Standing rule 11: user-facing, so a What's New entry. Standing rule 9: update features.json for Users, Sales Team, Crews, Crew bonus, and Commission, since their tables now have a writer above them.

## Preflight

- `npm test` green before you start and before every commit.
- Before/after assertion on wages and commission percentages (Part C) must be in the migration, not just in your head.
- After the mirror is live, re-render the Bonus Report and the Commission view and confirm the numbers are byte-identical to before.
- Confirm a BusyBusy-imported hour still resolves to the same crew member.

## Handoffs

`## Handoff to Cowork`: apply the migration to prod (zdfpzmmrgotynrwkeakd), run the Verify block including the wage/commission sum assertions, regenerate SCHEMA.md, and report the backfill counts.

`## Handoff to Dylan`: work the one-time dedupe review screen (roughly 15 rows), and fill in birthdays for existing people.
