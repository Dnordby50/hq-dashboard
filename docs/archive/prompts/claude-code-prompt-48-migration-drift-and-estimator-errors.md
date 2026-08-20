# Claude Code Prompt 48: Migration drift detection + estimator stuck-sync visibility

Owner: Dylan. ONE build, TWO independent parts, each its own commit so either can revert alone. Part A is server/dashboard (index.html + a new Netlify function + migration). Part B is the estimator PWA (apps/estimator) plus one small endpoint. Nothing in Part A depends on Part B.

Follow CLAUDE.md standing rules: 6 (no em dashes in customer/crew-facing text), 9 (features.json + SCHEMA.md before searching or writing SQL), 10 (token discipline, never read index.html end to end), 11 (What's New for user-facing changes only), 12 (every major feature ships with Settings knobs).

## Why this exists (do not re-litigate)

On 2026-07-25, Cowork ran the prompt 47 smoke test and found that FIVE migrations had never been applied to PROD:

- `2026-07-18_crew_notes.sql` (prompt 32)
- `2026-07-18_estimate_custom_sqft.sql` (prompt 32)
- `2026-07-21_drip_approval_gate.sql` (prompt 42)
- `2026-07-23_estimate_views.sql` (prompt 46)
- `2026-07-23_estimator_customer_search_setting.sql` (prompt 46)

The crew_notes one had been silently breaking EVERY estimator save for a week. The estimator is offline-first: each failed save landed in its IndexedDB outbox with `Could not find the 'crew_notes' column of 'estimates' in the schema cache` and retried forever, surfacing only as a small `3 to sync` counter in the estimator header. One of the stranded records was a real customer estimate (Chris Lopez, Polydeck System, 500 sqft, $4,950) that sat invisible from 2026-07-18 until 2026-07-25. Nothing was lost (the outbox drained itself the moment the columns existed) but nobody could have known.

Two independent failures combined:
1. A migration written by Claude Code and handed to Cowork can go unapplied indefinitely with no signal anywhere.
2. The estimator swallows repeated write failures into a counter that reads like normal progress.

This prompt fixes both. See the PROJECT-LOG entry `[2026-07-25 MST] Cowork: prompt 47 tasks 3-4 done ... FIVE unapplied prod migrations` for the full findings.

## Decisions locked (Dylan, 2026-07-25, do not re-open)

Part A:
- Surface: BOTH a daily scheduled Netlify function AND an on-demand Settings > Diagnostics panel.
- Detection method: ARTIFACT PROBE, not filename matching (rationale below, this is the important one).
- Baseline: only migrations dated 2026-07-01 or later.
- On drift: raise a bell notification to admins via `pec_notifications`. One notification per migration per detection, never a daily repeat for the same already-reported migration.
- ALSO report reverse drift (schema objects in prod with no migration file) as a separate, lower-severity section.

Part B:
- A queued item reads as BROKEN after 2 failed attempts (1 failure is a blip, 2 is real).
- Rep sees a RED banner replacing the quiet counter, an expandable list of what is failing and for how long, and a "Retry now" button.
- Retry policy: KEEP RETRYING FOREVER, but add backoff. Do NOT add a cap that parks an op permanently. This is deliberate: the real incident self-healed because the ops were still retrying when the migration landed. A cap would have left them dead.
- Skip children of a failed parent within a drain pass, so one root cause reports as one problem instead of three.
- Escalate server-side: after the threshold, the estimator reports stuck-item metadata to an endpoint, and admins get a bell notification. A rep may not understand or escalate a red banner.

## PREFLIGHT (before any edit)

1. Verify every anchor below by function/symbol name plus grep. Line numbers in this prompt are from 2026-07-25 and WILL drift.
2. Read `supabase/migrations/2026-07-25*` if any exist (Cowork may have applied more since this was written) and run the Part A check against reality before trusting it.
3. Confirm `npm test` passes before you start (`node production/calculator.test.js && node production/estimate15b.test.js && node production/estimate-draft.test.cjs`).

---

# PART A: Migration drift detection (commits 1 and 2)

## A0. Why artifact probing, not name matching

`supabase_migrations.schema_migrations` DOES exist and is readable with the service role. But its `name` column does NOT reliably match repo filenames. Real values as of 2026-07-25:

| repo file | recorded name |
|---|---|
| `2026-07-19_drip_engine.sql` | `2026-07-19_drip_engine` (matches) |
| `2026-07-20_appointments.sql` | `2026_07_20_appointments` (underscored) |
| `2026-07-22_invoice_installments.sql` | `invoice_installments` (bare stem) |
| `2026-06-19_webhook_ingest_log.sql` | `webhook_ingest_log` (bare stem) |

Naive stem matching would report applied migrations as missing, which is worse than no check: a checker that cries wolf gets ignored, and this whole feature exists because a real signal got ignored. So the check asks the LIVE SCHEMA whether each migration's artifacts exist. That also catches a PARTIALLY applied migration, which name matching structurally cannot.

## A1. The artifact header convention (commit 1)

Every migration file dated 2026-07-01 or later gets a machine-readable header block declaring what it creates. Format (a SQL comment, so files stay runnable as-is):

```sql
-- @artifacts
--   column: public.estimates.crew_notes
--   column: public.jobs.crew_notes
-- @end
```

Supported artifact kinds, exactly these four:
- `table: public.<name>`
- `column: public.<table>.<column>`
- `index: <indexname>`
- `setting: <settings.key>`

Rules:
- A migration with NO `@artifacts` block is reported as `unknown` (not `missing`), listed in its own bucket. Never guess.
- Backfill the header into every existing migration file dated 2026-07-01 or later. There are roughly 25. Derive each one's artifacts by reading its own SQL, not by querying prod, so the file is self-describing and the check is a genuine comparison rather than a tautology.
- Document the convention in CLAUDE.md as a new standing rule (next free number) so every FUTURE migration ships with the header. One sentence plus the format block.

Commit 1 is the convention plus the backfill plus the CLAUDE.md rule. No behavior yet.

## A2. The checker (commit 2)

New Netlify function `netlify/functions/pec-migration-drift.cjs`. Follow the existing scheduled-function shape in `netlify/functions/pec-auto-progress.cjs` (module comment explaining the schedule and the on-demand curl, `const { sb, json } = require('./_pec-supabase.cjs')`, `exports.handler`, idempotent).

It must:
1. Read the migration files. Netlify functions do not get the repo working tree at runtime, so DO NOT try to `fs.readdir` the migrations directory from the deployed function. Instead generate a manifest at build time: a small script (`scripts/build-migration-manifest.mjs`) that parses `supabase/migrations/*.sql` headers and writes `netlify/functions/_migration-manifest.json`. Wire it into the Netlify build command in `netlify.toml` so it regenerates on every deploy. Commit the generated file too, so a local run works without a build.
2. For each manifest entry dated >= the baseline setting, probe the live schema:
   - `table`: `to_regclass('public.<name>') is not null`
   - `column`: `information_schema.columns`
   - `index`: `pg_indexes.indexname`
   - `setting`: a row in `public.settings` with that key
   Batch these into ONE query (a `union all` of existence checks, the same shape Cowork used during the incident) rather than one round trip per artifact.
3. Classify each migration as `applied` (all artifacts present), `missing` (none present), `partial` (some present, some not, flag this LOUDLY, it means a migration half-ran), or `unknown` (no header).
4. Reverse drift, separate and lower severity: list `public` tables that appear in neither the manifest artifacts nor an allowlist of pre-baseline tables. Cap the output and label it clearly as informational. Do not notify on reverse drift alone.
5. Return JSON: `{ checkedAt, baseline, applied: n, missing: [...], partial: [...], unknown: [...], reverse: [...] }`. Each entry carries the filename and the specific artifacts that were absent, because "2026-07-18_crew_notes is missing" is far less useful than "estimates.crew_notes absent".

Notification behavior:
- Insert into `pec_notifications` following the existing pattern (`sb('POST', '/pec_notifications', {...})` as in `netlify/functions/_pec-appt.cjs` around line 214 and `pec-public-estimate.cjs` around 1084). Use `type: 'migration_drift'`, a `body` naming the file and the missing artifact, `priority: 'high'` for `partial`, `'normal'` for `missing`, and `target_view` pointing at the Diagnostics panel.
- De-dupe the same way `pec-public-estimate.cjs` de-dupes view notifications: before inserting, query for an unread `pec_notifications` row of the same type mentioning the same migration. Do not re-notify while one is outstanding. A migration pending for two weeks must not generate fourteen notifications.
- Schedule it daily in `netlify.toml` (`[functions."pec-migration-drift"]`, `schedule = "0 14 * * *"`, 07:00 MST, after the 06:00 auto-progress sweep). Keep the function callable on demand by GET, like `pec-auto-progress`.

## A3. Settings > Diagnostics panel (same commit 2)

Add a "Schema drift" card to the Settings view, in the Settings group beside the existing DripJobs Sync Health entry (`data-pec-view="dripjobs-sync-health"`, under its Diagnostics divider). It calls the function on demand and renders the four buckets, green when `missing` and `partial` are both empty. Show the artifact-level detail, not just filenames. Admin-only, using the existing staff/admin gating in that view.

---

# PART B: Estimator stuck-sync visibility (commits 3 and 4)

## B1. Verified current state

- `apps/estimator/src/offline/outbox.ts`: `OutboxOp` already carries `attempts`, `status: 'pending' | 'error'`, `lastError`. `markError` increments attempts. Nothing reads any of it for display.
- `apps/estimator/src/offline/sync.ts`: `drainOutbox()` is single-flight, FIFO by `opId`, upserts each op, `markError` on failure, `removeOp` on success. NO cap, NO backoff, and it continues past a failed parent straight into its children (which is why one bad estimate produced three stuck ops: the estimate plus its `estimate_areas` and `estimate_line_items` failing on FK).
- `apps/estimator/src/features/estimator/EstimatorScreen.tsx`: `pending` state around line 354, `refreshPending` around 814 (`setPending((await listOps()).length)`), a drain effect around 824, another drain around 905 and 1412, and the ONLY display at line 1509: `` {pending > 0 && ` · ${pending} to sync`} ``.
- `apps/estimator/src/App.tsx` line 88: best-effort `drainOutbox()` on load.
- Settings reach the estimator through `apps/estimator/src/lib/catalog.ts`: a `settings` select filtered to an explicit key list around lines 87-99, parsed into a config object around 116-137 (see `customerSearchEnabled` as the model to copy).

Remember `apps/estimator/` is SOURCE. The repo-root `estimator/` is BUILT OUTPUT and must never be hand-edited (CLAUDE.md File Layout).

## B2. Sync-loop changes (commit 3)

In `sync.ts`:
- Track a per-op next-attempt time so a repeatedly failing op backs off (suggested: 1m, 5m, 30m, then hourly, capped at 1 hour). Store it on the op (extend `OutboxOp`, e.g. `nextAttemptAt`) so it survives reloads. An op that is not yet due is SKIPPED, not failed, and does not count as `failed` in `SyncResult`.
- NEVER stop retrying. There is no maximum-attempts cap. A due op always gets tried.
- A manual retry (from the UI button in B3) clears every `nextAttemptAt` and drains immediately, so a rep who knows the problem is fixed does not wait out a backoff.
- Skip children of a failed parent within the same drain pass: when an op fails, collect its `id`, and skip any later op in that pass whose `row` references that id (the FK field, e.g. `estimate_id`). Skipped children stay `pending` with their attempt count UNCHANGED, so they do not accrue phantom failures for someone else's problem.
- Extend `SyncResult` with `blocked` (skipped due to a failed parent) and `deferred` (skipped due to backoff) so the UI can tell "waiting" apart from "broken".

Add unit tests. `production/` holds the Node test files that `npm test` runs; add `production/outbox-backoff.test.cjs` (or the closest matching existing convention) covering: backoff schedule progression, no permanent cap, children skipped when a parent fails, children NOT skipped when the parent succeeds, manual retry clearing backoff, and an op recovering after previously failing (the Chris Lopez case). Wire it into the `test` script in package.json.

## B3. The error state (commit 4)

Replace the `{pending} to sync` text at EstimatorScreen.tsx:1509 with a three-state indicator:

- Normal: `Online` (unchanged when nothing is queued).
- Syncing: `Online · N to sync` (unchanged) while every queued op is under the threshold.
- BROKEN: a RED state, visually distinct from the offline dot, when ANY op has `attempts >= threshold` (default 2). Text names the count and the age of the oldest stuck item, e.g. `2 saves not syncing · oldest 6 days`. Age matters: "6 days" is what makes a rep escalate.

Clicking the red state expands a details list: per stuck op, what it is (estimate number or customer name where derivable, else the table and id), how many attempts, how long stuck, and `lastError` verbatim. Do not prettify the error; `Could not find the 'crew_notes' column` is exactly the string that solves the problem for whoever reads it.

Include a "Retry now" button that clears backoff and drains, showing the outcome.

Wording for the red state must be plain and non-alarming, and MUST NOT imply data loss, because there is none: the work is saved locally and will sync. Something like "Saved on this device, not yet uploaded" is accurate. Standing rule 6 applies (no em dashes; a rep is crew-facing).

## B4. Server escalation (same commit 4)

New endpoint `netlify/functions/pec-sync-stuck.cjs`. The estimator POSTs once per session when it first crosses the threshold (not on every drain, not on every render):
- Payload: op `table`, op `id`, `attempts`, first-queued timestamp, `lastError`, and the estimate id if known. NO customer PII beyond ids, and no row bodies.
- Store in a new table `public.pec_sync_stuck_reports` (see migration below), upserting on op id so repeated reports update rather than pile up.
- Raise ONE `pec_notifications` row per op id, `type: 'sync_stuck'`, de-duped against unread rows for the same op the same way as Part A.
- Gate the whole behavior on the `sync_stuck_escalation_enabled` setting.

## B5. Migration (write it, DO NOT apply)

`supabase/migrations/2026-07-<dd>_sync_stuck_reports.sql`, additive and idempotent, one transaction, WITH the new `@artifacts` header from A1:

- `create table if not exists public.pec_sync_stuck_reports (id uuid primary key default gen_random_uuid(), op_id text not null unique, table_name text not null, row_id uuid, attempts int not null default 0, first_queued_at timestamptz, last_error text, estimate_id uuid, reported_at timestamptz not null default now(), resolved_at timestamptz)`
- Index on `(resolved_at, reported_at desc)` for the open-items read.
- RLS enabled, staff read via `public.is_admin_staff()` (the same pattern `pec_estimate_views` uses). Inserts are service-role through the endpoint.
- Seed the four settings keys below with `on conflict do nothing` / `where not exists`, matching the existing seeding style in `2026-07-23_estimate_views.sql`.

Verify the table and column names against SCHEMA.md conventions before writing. Cowork applies it and regenerates SCHEMA.md.

---

# Settings surface (standing rule 12)

All four go in company Settings, backed by the `settings` table, no code change to tune:

| key | default | what it does |
|---|---|---|
| `migration_drift_check_enabled` | `true` | Master switch for the scheduled drift check |
| `migration_drift_baseline` | `2026-07-01` | Only migrations dated on/after this are checked |
| `sync_stuck_threshold_attempts` | `2` | Failed attempts before the estimator shows the red state |
| `sync_stuck_escalation_enabled` | `true` | Whether a stuck save raises an admin bell notification |

Put the drift keys in the Settings > Diagnostics area next to the panel; put the sync keys wherever the estimator settings already live (see the existing `estimator_*` keys). `sync_stuck_threshold_attempts` must reach the estimator through the `catalog.ts` settings key list (B1), NOT be hardcoded in the component.

# Guardrails

- Do NOT change what the outbox stores for existing ops beyond ADDING fields. An op queued by the currently deployed build must still drain after this ships. Treat `nextAttemptAt` as optional and absent-means-due.
- Do NOT apply any migration. Cowork applies and regenerates SCHEMA.md.
- Do NOT touch the repo-root `estimator/` build output.
- Do NOT let the drift checker write to any schema. It is read-only apart from `pec_notifications` inserts.
- Do NOT make the drift check a deploy gate or a hard failure. It reports; humans decide.
- Keep the notification de-dupe strict. A checker that generates daily noise about a known-pending migration will be muted, and then it is worth nothing.

# What's New (standing rule 11)

- Part A is internal-only (admin diagnostics). NO What's New entry.
- Part B IS staff-facing (every rep sees the new red state). ONE entry: plain language, what the red banner means, that their work is saved on the device and not lost, and to tell Dylan if it stays red. No em dashes.

# Commits

1. `db: @artifacts headers on 2026-07+ migrations + CLAUDE.md convention`
2. `diagnostics: migration drift checker (scheduled fn + Settings panel + bell)`
3. `estimator: outbox backoff + skip children of a failed parent (+ tests)`
4. `estimator: stuck-sync error state, retry, and server escalation`
5. `docs: features.json + What's New + PROJECT-LOG for prompt 48`

# After

PROJECT-LOG entry (By: Claude Code) covering both parts, the new settings keys, and a `## Handoff to Cowork` section listing: apply `2026-07-<dd>_sync_stuck_reports.sql` to PROD, regenerate SCHEMA.md, then run the drift checker on demand and confirm it reports ZERO missing (Cowork applied all five known-missing migrations on 2026-07-25, so a non-empty result on first run means either the artifact headers are wrong or something else drifted). Update `features.json` with both features and their anchors.

Report to Dylan in plain English: what the red state looks like to a rep, and where to look when the bell fires.
