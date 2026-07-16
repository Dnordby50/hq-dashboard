# Claude Code Prompt 28: personal to-dos (private per-user checklist in the left nav)

## Context

Dylan wants a personal to-do list in the app. Cowork scoped this with Dylan on 2026-07-16. Decisions locked:

1. EVERY user gets their OWN private to-do list, visible only to them (not just Dylan, and not shared). An admin must NOT be able to see another user's list.
2. It lives as a nav item in the left sidebar that opens a dedicated To-dos VIEW (not an always-on pinned widget).
3. Simple checklist only: add a text item, check it to complete, delete it. Order by creation. NO due dates and NO reminders this build.
4. DB-backed and synced across devices, keyed to the signed-in user.

Repo: HQ-Dashboard, main. All UI is in index.html. Supabase project "HQ Dashboard" (zdfpzmmrgotynrwkeakd).

## What the code does today (evidence, read it first)

- The left nav is `#rdSidebarNav`, built in the redesign shell around index.html:4951+, with `.rd-crm-group` sections and `.tab-btn` items that forward to switchView. `setNav(view, show)` toggles a nav item's visibility (used at index.html:6742).
- View routing: `switchView(v)` (index.html:7076) dispatches through a map at index.html:7155-7165 (for example `leads: renderLeads`, `costing: renderJobCosting`, `settings: renderSettings`), defaulting to renderDashboard. You will add `todos: renderTodos` here plus a nav button.
- Signed-in user identity: `state.adminUser` carries id, email, role, permissions (resolveAdminUser around index.html:6640-6651; user_permissions is read by `admin_user_id`). Use `state.adminUser.id` as the owner key, and the auth uid for RLS.
- For the RLS shape, read an existing per-user policy in supabase/ (for example the policy on user_permissions, or another table scoped to the current staff identity) and MIRROR how it maps the auth uid to the admin_users row. Do not invent a looser policy.

## The build

1. New table `pec_user_todos`: `id uuid pk default gen_random_uuid()`, `admin_user_id uuid not null` (owner, FK admin_users on delete cascade), `body text not null`, `done boolean not null default false`, `created_at timestamptz not null default now()`, `done_at timestamptz`. RLS ON, owner-only for SELECT / INSERT / UPDATE / DELETE: a user can touch ONLY rows whose owner resolves to their own identity, matched the same way existing per-user policies map the auth uid to admin_users. Owner-only means even admins cannot read other users' rows (this is a private list, not a management surface). WRITE the migration under supabase/migrations; do-not-touch-prod, hand application to Cowork.

2. Nav item. Add a "To-dos" `.tab-btn` to `#rdSidebarNav` (top-level Menu group is fine since it is personal). Visible to any signed-in user with no permission gate (everyone has their own). Wire it to `switchView('todos')`.

3. `renderTodos` view. Read the current user's rows on view entry (newest first; show open items on top, completed ones struck through or below). Provide a text input plus an Add button to create an item, a checkbox to toggle done (writes `done` and stamps/clears `done_at`), and a delete control per item. Reuse the app's existing wrappers (withFreshSession for the read, withFreshWriteRetry for writes) and its toast + graceful-degrade patterns. Empty state: "No to-dos yet. Add one above." No drag reorder.

4. Sync. Because it is DB-backed and read on view entry, the list already follows the user across devices; no offline outbox is needed (unlike the estimator). Degrade gracefully if the read errors (short "Couldn't load your to-dos" note, do not break the shell).

5. Optional, only if trivial: a small open-count badge on the nav item. If it adds real complexity (extra query on every render, etc.), skip it and say so in your log entry.

## Acceptance

- Signed in as user A: add, check, and delete to-dos. Sign in as user B: see NONE of A's items, and A sees none of B's.
- Reload as A on another device: the same list appears (DB-synced).
- An admin who is not A cannot read A's to-dos. Verify the RLS is owner-only (note in your log entry the difference between a service-role query, which sees all, and an authenticated query as a different user, which must see none).

## Standing rules

Commit per meaningful change (`<area>: <what changed>`, no secrets). node --check touched blocks; npm test pass/fail. No em dashes. PROJECT-LOG.md entry at the TOP. User-facing, so one What's New entry in help/whats-new.json (id, date, title, one-line summary, 2-3 plain-language steps, no em dashes). do-not-touch-prod: write the migration, hand application to Cowork in a `## Handoff to Cowork` (migration path plus a verify query).

## Handoff to Dylan (put in your log entry)

Tell Dylan there is a new To-dos item in the left nav, private to each user, synced across his devices; that Cowork must apply the migration before it works; and to run the A/B isolation check above once it is live.
