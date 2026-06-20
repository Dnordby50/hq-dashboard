# Claude Code prompt: DripJobs Sync Health (catch missing / partial / silent-fail zaps)

Paste into Claude Code. Follow CLAUDE.md (Bug Diagnosis Workflow, commit + PROJECT-LOG, Cowork handoff for the migration). Read the Architecture Gotchas in CLAUDE.md before touching ingestion: the two-parallel-job-tables shape is central here.

## Context

DripJobs jobs reach the CRM only by Zapier push: DripJobs -> a Zap -> `netlify/functions/pec-webhook-proposal-accepted.cjs`, which writes `public.jobs` (+ timeline_stages) and then bridges a `public.pec_prod_jobs` row so the job shows on the Job Schedule. There is no DripJobs API and no pull. Some jobs are not arriving and the office re-enters them by hand. Three failure classes are currently INVISIBLE:

1. Partial ingestion: a `public.jobs` row is created but the `pec_prod_jobs` bridge throws. The bridge is wrapped in a non-fatal catch that only `console.error`s (pec-webhook-proposal-accepted.cjs ~line 159-161), so the job appears on the Jobs page but never on the schedule.
2. Rejected payloads: missing `customer_name` returns 400 (line ~44) and the job is dropped with no record anywhere.
3. Caught 500s: the outer catch (line ~174-177) logs to console only.

None of these are queryable after the fact because nothing is persisted. This task makes them visible. NOTE THE CEILING (state it in your PROJECT-LOG entry): this cannot detect a deal that never reached the webhook at all (Zap errored/filtered/never-fired in Zapier), because the CRM has no source-of-truth list to reconcile against. That gap is a separate Zapier-side audit / future DripJobs API pull, not this task.

## Tasks

### 1. Ingestion log table (new migration; do NOT apply, hand off to Cowork)

Add `supabase/migrations/2026-06-19_webhook_ingest_log.sql` creating `public.pec_webhook_ingest_log`:

- `id uuid pk default gen_random_uuid()`
- `endpoint text` (e.g. 'proposal-accepted', 'appointment-set')
- `deal_id text` (nullable)
- `customer_name text` (nullable)
- `company text` (nullable)
- `outcome text not null` (one of: 'ok', 'rejected', 'error', 'bridge_failed')
- `status_code int`
- `message text` (error text or short note)
- `payload jsonb` (the parsed inbound body, for replay/debugging; redact nothing structural but do not store secrets - the body has none)
- `public_job_id uuid`, `prod_job_id uuid` (nullable, when known)
- `created_at timestamptz not null default now()`
- index on `created_at desc` and on `deal_id`.
- RLS: enable, admin-only read using the same `is_admin_staff()` gate the costing tables use. Writes come from the service role (webhook), which bypasses RLS.

### 2. Webhook: record every inbound attempt (best-effort, never blocking)

In `pec-webhook-proposal-accepted.cjs`, write one `pec_webhook_ingest_log` row per request via a small helper `logIngest(fields)` that POSTs to the table with the service-role `sb(...)` client and is wrapped so a logging failure can NEVER change the handler's response or throw. Record:

- `rejected` + 400 when `customer_name` is missing (before returning the 400).
- `bridge_failed` inside the existing bridge catch (~159), capturing the error message, with `public_job_id` set (the public.jobs row that DID succeed).
- `error` + 500 in the outer catch (~174), with the message.
- `ok` on success (~164), with `public_job_id` and `prod_job_id`.

Do the same minimal logging in `pec-webhook-appointment-set.cjs` (at least `rejected` / `error` / `ok`). Keep payload logging to the parsed body only. Do not change any existing status code, response shape, or the idempotency/dedup logic - this is additive instrumentation.

### 3. Dashboard "DripJobs Sync Health" view (admin-gated)

Add a read-only view (register in the `switchView` router and add a nav entry under Admin, gated with the existing `pec-role-admin` class like Job Costing). It loads on demand and shows three sections:

- A. **On Jobs page but not on the Schedule (partial ingestion).** Jobs in `public.jobs` with `source = 'dripjobs'` and `dripjobs_deal_id` not null, for PEC (prescott-epoxy) customers, that have NO `pec_prod_jobs` row with the same `dripjobs_deal_id`. These are the silent partial failures. Show customer, address, deal_id, signed_date, and a link to the job. (Respect the two-table model: match on `dripjobs_deal_id`, the reliable bridge key per CLAUDE.md.)
- B. **Recent ingestion errors.** From `pec_webhook_ingest_log` where outcome in ('rejected','error','bridge_failed'), newest first, last ~50. Show created_at, endpoint, outcome, customer_name/deal_id, and message. Include a small "received in last 24h / 7d" success count + the most recent `ok` timestamp at the top, so a drop-off in inbound volume is visible at a glance.
- C. **Manual entries that may duplicate a real deal.** `pec_prod_jobs` rows with `dripjobs_deal_id is null` (the manual-entry marker per CLAUDE.md, `proposal_number` like 'MANUAL-%') whose normalized customer name + address closely matches a DripJobs-sourced job. Flag as possible duplicates to reconcile. Display-only (no auto-merge).

Each row links through to the relevant job. No writes from this view.

## Guardrails

- Additive only. Do not alter existing webhook responses, dedup, or the timeline/bridge logic beyond adding the log calls.
- The log write must be fully swallowed on failure; a logging error must never drop or duplicate a job.
- No change to the resource Google Sheets or any costing math.
- Section A is the high-value piece (it catches today's silent partial failures from data already in the DB, even before the log table has any rows), so make sure it works independent of tasks 1-2.

## Acceptance

- `node --check` passes on both edited functions.
- A simulated missing-`customer_name` POST and a forced bridge failure each leave a `pec_webhook_ingest_log` row with the right `outcome`, and the handler's HTTP response is unchanged.
- The Sync Health view lists any real partial-ingestion jobs (section A) from current prod data, renders B and C without error, and is admin-gated.

## After (per CLAUDE.md)

- Commit per standing rules.
- `## Handoff to Cowork`: apply `2026-06-19_webhook_ingest_log.sql` to PROD Supabase and report the table + RLS live. Also: a Zapier-side task-history audit is still needed to catch never-arrived zaps (this task cannot).
- PROJECT-LOG entry (By: Claude Code) noting the three failure classes now logged, that section A works off existing data, and the explicit ceiling: never-arrived zaps are out of scope and need the Zapier audit / a DripJobs API pull.
