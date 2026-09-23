# Prompt 107: Push TopCoat lead/customer names to Quo contacts

Prompt number: 107 (highest existing was 106, checked against git log and the working tree 2026-09-23 before saving). Recheck numbering before committing.

Written 2026-09-23 by Cowork from a scoping session with Dylan. 10 locked decisions below. Do exactly this scope. If anything here conflicts with AGENTS.md, SCHEMA.md, or the last 3 PROJECT-LOG entries, stop and ask Dylan.

## Startup

1. Read AGENTS.md, docs/product-charter.md, and run `node scripts/context-packet.mjs --feature "quo"`.
2. Use features.json to locate the Quo pieces (pec-webhook-quo, pec-openphone-sync, pec-send-sms), the lead create paths, the customer create paths, and the Admin Ops Queue. Do not read index.html end to end.
3. Verify every table and column below against SCHEMA.md and the live schema before writing SQL.
4. Verify the Quo (OpenPhone) Contacts API shape against the official docs before coding: create, update (PATCH), list with pagination, the `externalId` / `source` fields, and `createdAt`. Do not guess field names.

## Problem

When a lead or customer is created in TopCoat, the phone number shows up in Quo with no name (or a stale partial name someone typed from a call). Dylan wants Quo to show the TopCoat name on calls and texts across all three Quo lines, without anyone retyping it.

## Findings that shaped this (verified 2026-09-23)

1. Nothing in the codebase writes Quo contacts today. `pec-openphone-sync` reads calls, `pec-send-sms` sends texts, `pec-webhook-quo` receives message/call events and does NOT handle contact events (so there is no echo loop to guard against today; keep it that way).
2. `QUO_API_KEY` is already set in Netlify. Auth is the raw key in the Authorization header, same as `pec-openphone-sync.cjs` (`process.env.QUO_API_KEY || process.env.OPENPHONE_API_KEY`). No new credential.
3. **Quo's contact list API cannot filter by phone number.** Only `externalIds` and `sources` filters exist. Finding "the Quo contact on this number" requires paging the whole workspace contact list (50 per page). The workspace already has more than 50 contacts.
4. **Quo already has duplicate contacts on one number.** Examples on the first page: Kyle and Kyle Kirby (+19285779556), Chris and Chris Clevenger (+16027020711), "Marianne T" and "Marianne Thorstad Husband Cell" (+19289109562), two Mattie Magonigal, two Kathryn Huntley.
5. TopCoat has no single contacts table. A person is a `leads` row, a `customers` row, or both (`leads.customer_id`). Both tables carry `phone_norm` (last 10 digits), first/last name, and a business name column (`leads.business_name`, `customers.company_name`). `customers.name` is the legacy combined name.
6. Quo inboxes: PEC +19288008154, Finishing Touch +19283561243, Aron +19284931922. Contacts are workspace-wide, shared by all three.

## Locked decisions

1. **Trigger:** fire when a `leads` row OR a `customers` row is created. Match by `phone_norm`, so a lead and its customer on the same number map to ONE Quo contact.
2. **Edits sync too:** later changes to first name, last name, business/company name, phone, or email on either table also push. Other column changes do not.
3. **Existing Quo contact on the number:** overwrite the NAME only (first name, last name, company). Never touch email, role, notes, custom fields, or anything else a person typed in Quo. Exception: on a contact TopCoat itself created (carries our externalId), email may also be kept in sync.
4. **Duplicate Quo contacts on the number:** update only the NEWEST one by Quo `createdAt`. Leave the older ones untouched.
5. **No Quo contact on the number:** create one with first/last name, company, phone, and email, and set `externalId` to a stable TopCoat key so later syncs find it without paging (suggest `topcoat:<phone_norm>`; confirm the field is filterable). `source` per Quo docs.
6. **Business naming:** person name in First/Last, business in Company. If there is no person name, the business name goes in First name.
7. **No brand tag.** Do not write Role or any custom field.
8. **Keep the fuller name:** skip the rename when the TopCoat name is blank or is only a first name that Quo's current name already contains with more (TopCoat "Kyle" vs Quo "Kyle Kirby" = skip). Any real difference still overwrites. Compare case-insensitively, trimmed. Put this rule in a pure helper with fixture tests.
9. **Failures:** queue the push, retry automatically (default 4 attempts over about an hour, backoff), then surface ONE Admin Ops Queue item per failing phone. Creating or editing a lead/customer is never blocked or slowed by Quo.
10. **Backfill:** one-time idempotent script over existing `leads` and `customers` with `--dry-run`. The dry run lists every Quo contact it would create, rename (old name -> new name), or skip and why. Dylan reviews the list and explicitly authorizes the live run. Do NOT run it live yourself.

## Design (adjust names if SCHEMA.md disagrees)

- **Queue table** `pec_quo_contact_sync`: one row per `phone_norm` (unique), with source table + id, desired first/last/company/email snapshot, status (`pending` / `done` / `skipped` / `failed`), attempts, next_attempt_at, last_error, quo_contact_id, updated_at. Coalesce: a new change on a pending phone overwrites the snapshot instead of adding a row. RLS: staff read, no browser writes.
- **Enqueue** with a Postgres trigger on insert and on update-of the watched columns on `leads` and `customers` (skip rows with no `phone_norm`, skip soft-deleted/archived rows). The database write path owns this, so every create path (Angi/Zapier intake, booking, manual, estimator accept, import) is covered without touching each one. Prefer the customer's name over a linked lead's when both exist on one phone.
- **Worker:** a scheduled Netlify function (every 5 minutes, matching the existing `*/5` pattern and the non-schedule-declared invocation workaround already used in netlify.toml) drains due rows. Page the Quo contact list at most once per run and index it by normalized phone in memory. Honor Quo rate limits; on 429 back off and leave rows pending.
- **Ops Queue:** add a DERIVED check (the existing pattern: derived at render time, self-clears when fixed) for `pec_quo_contact_sync` rows with status `failed`, `check_key` `quo_contact_sync_failed:<phone_norm>`, showing the phone, the TopCoat name, and last_error, linking to the lead/customer.
- **Echo safety:** if a future build adds Quo contact webhooks, those must not write back to TopCoat names. Note this in the code comment.

## Settings (no code edit to tune)

Company Settings, one card "Quo contact sync":
- Front of card: `quo_contact_sync_enabled` (default ON after deploy is verified; the worker no-ops when off, the trigger still queues).
- Advanced: `quo_contact_sync_max_attempts` (default 4), `quo_contact_sync_create_missing` (default true), `quo_contact_sync_on_edit` (default true).

## Out of scope

- Merging or deleting duplicate Quo contacts.
- Syncing Quo -> TopCoat in any direction.
- Brand/role/custom fields in Quo.
- Staff/people records, vendors, or anything not in `leads` / `customers`.

## Verify (report each result in the log)

1. `npm test` with fixture tests for: the fuller-name rule, business naming, newest-duplicate selection, coalescing two edits into one push.
2. `node --check` every touched .cjs; `git diff --check`.
3. Migration applied and verified live (trigger enqueues on a synthetic lead insert inside a rolled-back transaction).
4. One real end-to-end check on a single test record Dylan names: create it, confirm the Quo contact name within one worker cycle, edit the last name, confirm the update. Do not test on a real customer without Dylan naming one.
5. Backfill `--dry-run` output saved to a file (not in public assets) and summarized in the log with counts: create / rename / skip-fuller / skip-duplicate-older / no-phone.

## Log and commit

Commit as `quo: <what changed>`, stage specific files, prepend a PROJECT-LOG entry with `By: Claude Code`, update features.json and SCHEMA.md, add a plain-language help/whats-new.json entry ("New leads and customers now show up by name in Quo"). Hand the dry-run file to Dylan for the live-run go-ahead.
