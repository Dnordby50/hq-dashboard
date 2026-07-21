# Claude Code Prompt 43: Routemize -> TopCoat appointment intake

## Context

DripJobs is being retired (today/tomorrow). Routemize (the booking/routing platform at prescottepoxycompany.routemize.com) becomes the front end where appointments get booked, and TopCoat's appointment calendar (`pec_appointments`, currently 0 rows in prod) becomes the system of record. We are wiring Routemize -> Zapier -> a new TopCoat intake endpoint so appointments booked in Routemize land on the TopCoat calendar, linked to the originating lead so the lead -> drip -> appointment pipeline stays connected. Cowork will build the Zapier side; this prompt is the TopCoat plumbing.

Chosen architecture (decided with Dylan, direct path over the Google-Calendar-bus path): a direct webhook into a clean intake endpoint, so we preserve the assigned rep, the appointment type, and the lead linkage. Google-calendar visibility for reps still comes from TopCoat's EXISTING push (`pec-appt-sync-push.cjs`), so nothing new is needed there; it stays best-effort and gated on the existing Google OAuth setup.

Read before starting (standing rules): CLAUDE.md, the last 3 PROJECT-LOG.md entries, SCHEMA.md for `pec_appointments` / `pec_sales_team_members` / `leads`, and features.json anchors for "Appointments calendar" and "Lead drip engine". Do NOT read index.html end to end; use the anchors named below.

## Grounding facts (verified by Cowork, do not re-derive blind)

- `pec_appointments` columns (SCHEMA.md): id, appt_type (CHECK: on_site_estimate / project_walkthrough / site_visit / other), title, lead_id (NO fk, survives lead soft-delete), customer_id (fk customers), sales_member_id (fk pec_sales_team_members), start_at, end_at, all_day, location_address/city/state/zip/place_id, notes (internal Company notes), customer_notes (customer-facing Job notes), status (CHECK: scheduled / completed / canceled), **source (CHECK: topcoat / google only)**, google_event_id/calendar_id/etag/updated, created_by, created_at, updated_at. There is NO column to hold an external appointment id. Unique(google_event_id) where not null.
- `pec_sales_team_members` has only 2 rows (the reps, Dylan + Aron). No plain email column; it has `name`, `google_email`, `google_calendar_id`, `google_connected`.
- Intake house pattern is `netlify/functions/pec-lead-intake.cjs`: POST, auth via `x-webhook-secret: <PEC_WEBHOOK_SECRET>` checked by `badSecret(event)` (helper in `_pec-supabase.cjs`; the secret is ALREADY set in Netlify env, reuse it, do NOT add a new one), phone normalized to last-10-digits, `logIngest({ endpoint, ... })` to `pec_webhook_ingest_log` on every attempt, `enrollLead` from `_pec-drip.cjs`. Mirror its shape and its "Zapier maps platform fields to our contract" philosophy.
- The reminder/confirmation engine `runApptReminders` (`_pec-appt.cjs`, exported) resolves the recipient lead-first then customer, enforces consent + quiet hours, and its on_book rules already fire from the 15-minute scheduled runner (`pec-appt-reminder-runner.cjs`) by looking back 24h of creations. So a linked, consented appointment gets its confirmation automatically even if intake sends no kick; you MAY also call `runApptReminders({ sb }, { appointmentId })` directly for an instant confirmation (best-effort, never fail the response).
- The in-app booking path runs lead-side effects (advance lead stage, salesperson bell, and the nurture-drip interaction) via `apptBookingSideEffects` / `apptPostWrite` in index.html and the `log_appointment_booked` RPC. Find these via the "Appointments calendar" features.json anchor. The intake must produce the SAME lead-side state as an in-app booking (see Task 3).

## Locked decisions

1. Direct intake endpoint (not the Google-calendar bus). Full mirror: Created / Updated / Cancelled / Deleted all sync.
2. On a Routemize DELETE: mark the TopCoat row `status='canceled'` (do NOT hard-delete).
3. Contact linkage: match to an existing lead (then customer) by phone (last-10) or email and link it. If no match, do NOT auto-create a lead (would collide with the DripJobs->leads and Meta-intake paths); carry the customer name/phone/address on the appointment itself.
4. Google visibility comes from the existing `pec-appt-sync-push.cjs`, kept best-effort. Do NOT build a second Google path.
5. Rep assignment: map Routemize's assigned member to a `pec_sales_team_members` row by `google_email` (case-insensitive) else by `name` (case-insensitive exact); no match -> leave `sales_member_id` null (appointment still lands, just unassigned) and note it.
6. Default `appt_type` is `on_site_estimate` (these are booked estimate visits) unless the payload maps a recognized type.

## Task 1: Migration

New file `supabase/migrations/2026-07-21_appointment_routemize_source.sql` (additive, idempotent, single transaction). It must:

- `alter table public.pec_appointments add column if not exists routemize_appt_id text;`
- Add a partial unique index: unique on `routemize_appt_id` where not null (so update/cancel/delete find exactly one row; concurrent Zap retries collide harmlessly). Name it explicitly, `create unique index if not exists`.
- Extend the `source` CHECK to allow `routemize` alongside `topcoat` / `google`. Find the existing constraint name from the live catalog (do not guess it); drop and re-add it inside the same transaction with the three-value list. This is the known CHECK-constraint gotcha in this project (material_type); handle it deliberately.
- Header comment explaining each change and a verify block at the bottom (the column exists; the index exists; the constraint now permits 'routemize'). Write it, do NOT apply it (Cowork applies migrations and regenerates SCHEMA.md, standing rule 9).

## Task 2: The endpoint

New file `netlify/functions/pec-appt-intake.cjs`. POST only, `badSecret(event)` auth reusing `PEC_WEBHOOK_SECRET`, `logIngest({ endpoint: 'appt-intake', ... })` on every attempt (create the endpoint label; the Sync Health view already reads this table).

Input contract (Zapier adapts Routemize's real fields to these keys; you define the contract, we map in Zapier):

```
{
  action: 'created' | 'updated' | 'canceled' | 'deleted'   // default 'created'
  routemize_appt_id: string            // REQUIRED (idempotency + update/cancel/delete key)
  appt_type: string                    // optional; default 'on_site_estimate'; accept the 4 valid values, else default
  title: string                        // optional; default = customer name, else the appt_type label
  start_at: string                     // ISO 8601 or a datetime Zapier passes; REQUIRED for created/updated
  end_at: string                       // optional; default start_at + 60 min
  all_day: boolean                     // optional; default false
  customer_name, phone, email: string  // for lead/customer match + carry-on-appt
  address, city, state, zip: string    // optional -> location_* columns
  assigned_member_email, assigned_member_name: string  // -> map to pec_sales_team_members (decision 5)
  notes: string                        // internal Company notes
  customer_notes: string               // optional customer-facing Job notes
}
```

Behavior by `action`:

- created: upsert by `routemize_appt_id` (insert if new; if a row already exists for that id, treat as update). Set `source='routemize'`, `status='scheduled'`. Timezone: interpret bare datetimes as America/Phoenix (fixed -07:00, the project convention; see `pec-appt-sync-push.cjs` PHX handling).
- updated: update the row matched by `routemize_appt_id` (upsert-safe: if missing, insert). Do not clobber `google_*` columns.
- canceled: set `status='canceled'` on the matched row (this is what the existing push reads to remove the Google event on its next kick). No-op if not found.
- deleted: same as canceled (decision 2). No-op if not found.

Lead / customer linkage (decision 3): normalize phone to last-10; look up a live lead by phone-ilike or email (mirror pec-lead-intake's dedupe query, `deleted_at is null`); if found set `lead_id` (and `customer_id` if the lead carries one / a matching customer exists). If no lead, try a customer match by phone/email and set `customer_id`. If neither, leave both null but keep `title` = customer_name and put phone into `notes` so the rep can act. Never auto-create a lead or customer here.

Rep mapping (decision 5): resolve `sales_member_id` from `assigned_member_email` (match `google_email`) else `assigned_member_name` (match `name`), case-insensitive; null if no match.

## Task 3: Same lead-side effects as an in-app booking (the connected-pipeline requirement)

This is the point of the whole task, so do not skip it. When the intake creates a NEW appointment that is linked to a lead, it must leave the lead in the same state an in-app booking would. Read `apptBookingSideEffects` / `apptPostWrite` and the `log_appointment_booked` RPC (Appointments-calendar anchor) and determine exactly what the in-app flow does on booking: at minimum a lead_event and a stage advance, and whether it pauses the lead's active nurture drip.

- Factor the lead-facing booking side effects into a server-callable helper (service-role `sb`), and call it from the intake so the Zapier path and the in-app path converge on one implementation. If the current side effects live only in client JS, port the lead/drip portion to the server helper and have the client keep calling its existing path (do not regress the in-app flow).
- The lead's active nurture drip MUST pause when the appointment is booked (otherwise the smoke test shows a booked lead still getting nurture texts). If the in-app flow already does this, reuse it. If it does NOT currently pause the drip on booking, add that (pause the active nurture enrollment for the linked lead), and call it out in your log entry + a one-line note to Dylan, since it is a small behavior addition beyond pure plumbing.
- Fire the confirmation for immediacy: best-effort `runApptReminders({ sb }, { appointmentId })` after a successful created/updated insert. Never let it fail or delay the 200 (Zapier retries non-200s).

Guardrails / what NOT to touch: do not change the in-app booking UX; do not touch `pec-google-calendar-pull.cjs` or the push's echo logic; do not add a new secret; do not hard-delete rows; do not read/rewrite index.html wholesale. Keep every customer-facing string em-dash-free (standing rule 6). All external effects (drip pause, confirmation, Google push) are best-effort and must never turn a good intake into a non-200.

## Testing

- Add a `production/*.test.cjs` fixture test for the intake mapping + lifecycle: created inserts with source='routemize' and the right lead link; a second created with the same routemize_appt_id updates not duplicates; canceled flips status; unmatched phone leaves lead_id null; rep mapping by email and by name; appt_type defaulting. Follow the existing test-kit pattern (`_drip-test-kit.cjs`, the appt/drip tests).
- `node --check` the new function; `npm test` stays green.
- Do NOT hit real Supabase/Quo/Resend in tests (inject deps like the other suites).

## features.json + What's New

- Add a features.json entry for the Routemize appointment intake (functions: pec-appt-intake.cjs, the new server side-effect helper; tables: pec_appointments, leads, lead_events, pec_drip_enrollments, pec_webhook_ingest_log; migration path). Update the "Appointments calendar" entry if you extract a shared helper it should reference.
- What's New: one brief staff-facing entry is warranted (appointments booked in Routemize now appear on the schedule automatically and message the customer), plain language, no em dashes. Skip it only if you judge the change purely internal.

## After

- Commit in logical pieces per standing rules (migration, endpoint+helper, tests, docs), messages `<area>: <what changed>`.
- Append a PROJECT-LOG.md entry at the top (By: Claude Code): what shipped, the exact source-CHECK constraint name you dropped/re-added, whether the in-app flow already paused the nurture drip or you added it, and what is verified vs needs-live.
- Handoff to Cowork: apply `2026-07-21_appointment_routemize_source.sql` to PROD (project "HQ Dashboard", zdfpzmmrgotynrwkeakd), run the verify block, regenerate the SCHEMA.md `pec_appointments` section. Then Cowork builds the Routemize Zaps against the deployed intake URL and runs the end-to-end smoke test.
- Handoff to Dylan: git push to deploy so the intake URL is live; confirm `PEC_WEBHOOK_SECRET` is the secret Cowork should put in the Zap header.
