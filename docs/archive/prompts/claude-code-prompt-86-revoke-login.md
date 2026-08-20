# Claude Code Prompt 86: revoke a user's login, kill their live sessions, keep every record they touched

Run this AFTER prompt 85. Separate commit.

## Context

Repo: HQ-Dashboard, branch `main`. Deploy: Netlify, https://prescottepoxy.netlify.app. Supabase project is the PEC one; use the Supabase MCP tools for schema reads and the migration.

**The gap.** TopCoat can create a staff login (`netlify/functions/pec-create-staff.cjs` makes an auth user plus an `admin_users` row, admin-only) but it has no way to take one away. `admin_users` has no active or revoked flag. The only thing standing between a former employee and the dashboard is the not-approved gate at `index.html:2652`, which is "authed but not in `admin_users`", and it is only evaluated on page load. A person with an open tab keeps working until they refresh. Dylan needs a real offboard: remove the login, end every live session, and leave the historical record completely intact.

**What Dylan means by "delete a user".** Not a delete. He wants the login gone and the human's name still attached to every estimate, job, lead, audit row and metric they ever touched. Deleting rows would silently rewrite history and break attribution.

## Decisions locked with Dylan (asked and answered 2026-08-11, do not re-litigate)

1. **Scope: revoke login only.** The auth login dies. Their `people` record, and their sales-rep and crew-member roles if they hold any, are left completely alone. A revoked login is not a retired salesperson.
2. **Auth handling: ban the auth user, keep the row.** Do not hard-delete from `auth.users`. `audit_log.auth_user_id` and `admin_users.auth_user_id` must stay resolvable so "who did this" still answers correctly years later.
3. **Session kill: server-side global signout AND a client-side kill switch.** Revoke every refresh token server-side, and have the app notice within about a minute that its own login was revoked and drop the user to the sign-in screen without needing a manual reload.
4. **Where: Settings > People**, on the person's card, gated on `can_manage_team` (the same permission the existing `pec_people_grant_role` and `pec_people_merge` RPCs require). Not restricted to `role = 'admin'`.
5. **Reversible: a Restore login button.** Same email, same password, `user_permissions` preserved.
6. **One guardrail only: you cannot revoke your own login.** Dylan considered and declined a last-admin guard, a type-the-name confirmation, and an ownership preview screen. Do not add them. (The self-revoke block already makes a total admin lockout impossible, since locking out every admin would require revoking yourself.)
7. **Open work is reassigned during the revoke**, to a person picked in the confirm dialog.
8. **Audited** in the existing `audit_log` table.

## The gotcha that will bite you if you miss it

`people` has three mirror triggers that write THROUGH to the legacy role tables. `people_mirror_forward` fires AFTER UPDATE on `people` and pushes `full_name` and `active` to whichever of `admin_users`, `pec_sales_team_members` and `pec_prod_crew_members` that person points at (see the `people` section of SCHEMA.md).

So **do not implement revoke by setting `people.active = false`.** That would deactivate the person's sales-rep and crew rows too, pulling them out of salesperson pickers, crew assignment and schedule capacity, which directly violates locked decision 1. Revoke must write to `admin_users` and to the auth user, and must not touch `people` at all.

## What to build

### A. Migration

One migration file, with the `@artifacts` header per standing rule 13.

Add to `public.admin_users`:

- `login_revoked_at timestamptz null`
- `login_revoked_by uuid null` (references `admin_users.id`, on delete set null)

Null `login_revoked_at` means an active login, which is every existing row. No backfill, no default. Verify the column names against SCHEMA.md's `admin_users` section before you write the SQL, and regenerate SCHEMA.md after applying (rule 9).

Nothing about the RLS policies changes. `is_admin_staff()` and the not-approved gate keep working exactly as they do; the revoked row is still an `admin_users` row, and the thing that actually stops the person signing in is the auth ban.

### B. Netlify function: `netlify/functions/pec-revoke-login.cjs`

Model it on `pec-create-staff.cjs` (same bearer-token pattern, same `_pec-supabase.cjs` helper, same CORS shape). One function handling both directions, `POST` with `{ action: 'revoke' | 'restore', adminUserId, reassignToAdminUserId? }`.

Caller authorization, in this order:

1. Bearer JWT present, else 401.
2. `GET ${SUPABASE_URL}/auth/v1/user` with the JWT resolves a caller, else 401.
3. Caller has an `admin_users` row, else 403.
4. Caller's `user_permissions.can_manage_team` is true, else 403. Note this differs deliberately from `pec-create-staff.cjs`, which gates on `role = 'admin'`.
5. `adminUserId !== caller's admin_users.id`, else 400 with "You cannot revoke your own login." Enforce this on the server, not only in the UI.

Revoke does, in order, and stops on the first failure with a useful message:

1. Reassign open work, if `reassignToAdminUserId` was supplied. See section C for the exact tables. Do this FIRST, while the row is still coherent.
2. Ban the auth user. `PUT ${SUPABASE_URL}/auth/v1/admin/users/{auth_user_id}` with a permanent `ban_duration`. Confirm the exact field name and the "permanent" value against the current GoTrue admin API before you write it (use `mcp__Supabase__search_docs`); do not guess, and do not assume a duration string that this project's GoTrue version rejects. If the row has a null `auth_user_id`, skip this step rather than failing; the staff row is already orphaned from auth.
3. Revoke every session for that user via the admin API so existing refresh tokens die immediately. Again, verify the endpoint against the docs rather than guessing.
4. Set `admin_users.login_revoked_at = now()` and `login_revoked_by = <caller's admin_users.id>`.
5. Insert one `audit_log` row: `action = 'revoke_login'`, `entity_type = 'admin_users'`, `entity_id = <the revoked admin_users.id>`, `auth_user_id` and `admin_email` = the caller's, `before_json` / `after_json` carrying the revoked state plus a `reassigned_to` field and the per-table reassignment counts. The function holds the service role key, so it can insert here directly; a staff session cannot, same constraint as `pec_notifications`.

Restore reverses it: unban the auth user, clear `login_revoked_at` and `login_revoked_by`, write an `audit_log` row with `action = 'restore_login'`. It does NOT touch `user_permissions` (locked decision 5) and does NOT un-reassign the work that was moved. Say so in the UI copy.

Never log or return the service role key, and never return the target's tokens.

### C. Reassigning their open work

Verify each of these against SCHEMA.md before writing any SQL. Do not guess a column name; assumed column names have caused real bugs in this repo twice.

Known `admin_users` foreign keys, from SCHEMA.md:

- `pec_ops_items.assigned_to` (and `created_by`, `done_by`, both historical, leave those alone)
- `pec_notifications.target_user_id`
- `pec_user_todos.admin_user_id`
- `user_permissions.admin_user_id` (the person's own permissions row, not work, leave it)
- `people.admin_user_id` (the identity pointer, leave it)

Also check `leads.owner_user_id`: it exists on the `leads` table but did not show up in SCHEMA.md's list of declared `admin_users` foreign keys. Confirm what it actually references live before including or excluding it.

Rules for the reassignment:

- Move only **open** work. `pec_ops_items` where `status = 'open'`. `pec_user_todos` that are not done (check the actual column). Unread `pec_notifications` (`read_at is null`). Leads only if they are live, not archived and not lost.
- Never rewrite historical attribution: `created_by`, `done_by`, `estimates.created_by`, anything in `audit_log`, and the salesperson on any estimate or job all stay exactly as they are. The person did that work and the record should keep saying so.
- Return per-table counts so the UI can report what moved and the audit row can record it.
- If no `reassignToAdminUserId` is supplied, skip reassignment entirely and revoke anyway. Reassignment is a convenience, not a precondition.

### D. Settings > People UI

The People surface is in `index.html` around `:21331` (the prompt 54 People screen); staff/`admin_users` management notes are at `:18041` and the create-login call is at `:18120`. Use `features.json` to find the exact render function rather than reading `index.html` end to end (standing rule 10).

On each person card that holds a Login role (`admin_user_id` is set):

- If `login_revoked_at` is null: a **Revoke login** action, visible only when the viewer has `can_manage_team`, and never on the viewer's own card.
- If `login_revoked_at` is set: a **Login revoked** state on the card showing who did it and when, plus a **Restore login** action.

The revoke confirm dialog contains:

- Plain-English copy: this ends their access and signs them out everywhere, their name stays on everything they worked on, and their sales or crew roles are not affected.
- A **"Reassign their open items to"** picker listing other active logins, plus a "Do not reassign" option. Show the counts of what will move so the choice is informed.
- Confirm and Cancel. No type-the-name step (locked decision 6).

Use the existing `openModal()` / `#pecModalRoot` helpers around `index.html:4808`, not a hand-rolled modal. Note the two-modal-root gotcha in CLAUDE.md: `#prodModalRoot` is a separate system used by the production and catalog views; you want `#pecModalRoot` here.

After a successful revoke, refresh the People list and show a toast naming what moved.

### E. The client-side kill switch

The app already probes `admin_users` on idle (`index.html:6577`, the `withDeadline` idle probe) and already has a not-approved gate at `:2652`. Extend rather than invent:

- Poll the signed-in user's own `admin_users` row for `login_revoked_at` on an interval and on `visibilitychange`, reusing the existing wedge-safe read wrappers (`withFreshSession` for reads, per the supabase-js notes in CLAUDE.md). Do not add a bare `.from()` call that can wedge.
- When `login_revoked_at` comes back non-null: sign out locally, clear session state, and land the user on the sign-in screen with a plain message that their access was removed. No data loss theatrics, no alert dialog.
- Make the poll cheap: one row, two columns, and skip it entirely when the tab is hidden.
- Per standing rule 12, the poll interval is the one tunable parameter here. Add a `settings` key for it and put the control behind the **Advanced** disclosure on whichever Settings card is the right home (this is not a front-of-card control; nobody tunes it in normal operation). Do not add settings rows for anything else in this feature; the rest is behavior, not a parameter.

## Guardrails

- Do not delete any row from `auth.users`, `admin_users`, `people`, or any legacy role table.
- Do not touch `people`, `pec_sales_team_members`, or `pec_prod_crew_members` at all.
- Do not change `is_admin_staff()`, `has_permission()`, or any existing RLS policy.
- Do not change `pec-create-staff.cjs`.
- Never commit the service role key; it is already an env var.
- No em dashes in any user-facing copy (standing rule 6). That includes the confirm dialog, the toast, the card state, the sign-out message, and the What's New entry.

## Verification

1. `npm test` from the repo root, green.
2. Apply the migration live via Supabase MCP, then regenerate SCHEMA.md (rule 9) and confirm the two new columns appear.
3. Create a throwaway staff login through the existing Add flow. Sign into it in a second browser profile and leave that tab open on the dashboard.
4. From Dylan's account, revoke it with a reassignment target picked. Confirm, in order: the open `pec_ops_items` moved and the closed ones did not; `login_revoked_at` and `login_revoked_by` are set; one `audit_log` row exists with the counts; the second browser's open tab drops to the sign-in screen within the poll interval **without a manual reload**; signing in again with that email and password fails.
5. Confirm the throwaway user's name still renders on anything it was attached to.
6. Confirm the Revoke action does not appear on your own card, and that calling the function against your own `adminUserId` with curl returns 400.
7. Restore the login. Confirm sign-in works again, `user_permissions` is unchanged, and a `restore_login` audit row exists.
8. Delete the throwaway login only after all of the above, and note in the log entry that a test row was created and revoked.

## Standing rules for this session

Commit per rule 1 (`auth: <what changed>`), separate from prompt 85. Append a PROJECT-LOG.md entry at the TOP per rule 2 with `By: Claude Code`, and make it say plainly why revoke does not touch `people` (the mirror trigger), what the two new columns mean, and what a Restore does and does not undo. Add a What's New entry per rule 11. Add or update the `features.json` entry for staff offboarding with its code anchors (rule 9). If anything needs a browser action Dylan or Cowork must take, end with the appropriate Handoff section.
