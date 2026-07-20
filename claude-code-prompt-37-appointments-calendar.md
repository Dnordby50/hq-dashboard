# Claude Code Prompt 37: Appointments calendar (estimates from leads + ad-hoc), two-way Google Calendar sync, address autocomplete

Repo: /Users/dylannordby/Claude-Code/HQ-Dashboard
Deploy: https://prescottepoxy.netlify.app
Supabase project: "HQ Dashboard" (zdfpzmmrgotynrwkeakd)

## Context

Dylan is rebuilding, natively in TopCoat, the DripJobs "Appointments" calendar (Month grid, event-type + user filters, per-salesperson color, a "New Appointment" button, a Google Calendar connection). TopCoat has NONE of this today: there is no appointments table, no Google Calendar / OAuth integration, and no Google Places autocomplete on the HQ dashboard (the estimator PWA already has a Places helper, but index.html does not). "Salesperson" on jobs is currently just a free-text string.

The workflow: appointments are mainly **on-site estimates scheduled off a Lead**, plus **ad-hoc appointments not tied to a lead** ("Busy", a Home Depot run, a walkthrough). Each appointment is assigned to a member of the existing `pec_sales_team_members` roster, and the calendar filters by member (an "All Users" default, like the screenshot). Dylan wants two-way sync so appointments live on each salesperson's own Google Calendar and vice-versa, address autocomplete when typing a location, and reminders/confirmations with a settings screen to control them.

This is a LARGE build (new top-level view + calendar UI + OAuth + two-way sync + autocomplete + reminders + settings). It is specified as ordered, independently-revertable commits/phases so each ships and can be reverted alone. **Recommended: hand this over as two sessions** — Phase A (native calendar + autocomplete + schedule-from-lead + notifications; tasks 1-6, 12-13) delivers a fully useful calendar with nothing fragile; Phase B (the Google two-way layer; tasks 7-11) is the OAuth/sync surface. If you build it all in one session, keep the commit boundaries below so Phase B can be reverted without touching the calendar. Flagging the big-diff/revert risk explicitly (same posture as prompt 34).

## Locked decisions (Cowork scoping with Dylan, 2026-07-20)

- Placement: a NEW top-level "Appointments" view. Keep it SEPARATE from the existing crew Job Schedule calendar (`renderSchedule`); they are different concepts (sales appointments vs crew install days).
- Assignee: `pec_sales_team_members` (2 rows today). The calendar's user filter and "All Users" default key off this roster.
- Appointment types (fixed, color-coded): `on_site_estimate`, `project_walkthrough`, `site_visit`, plus `other` (the ad-hoc / off-task type, e.g. "Busy"). NOT punch-out.
- Views: Month + Week + Day. Default Month.
- Google: TWO-WAY sync, and **each roster member connects their OWN Google account** (per-member OAuth). See the "Google sync design" section for the recommended dedicated-calendar approach and the one open call for Dylan.
- Schedule-from-lead: a "Schedule Estimate" button on the lead (detail and card) opens the appointment form prefilled from the lead, and on save ALSO advances the lead to the `estimate` stage.
- Address autocomplete (Google Places): on the appointment form AND on the lead address fields. (Not customer/job forms this pass.)
- Notifications on booking: in-app notify the assigned salesperson (`pec_notifications`), text/email the customer a confirmation, and a customer reminder before the appointment. PLUS a Settings screen to configure reminder timing and the message content per reminder.
- Default appointment length: 1 hour, editable. Customer + address prefill from the lead.
- Timezone: America/Phoenix, fixed UTC-7 (match the drip engine's convention).

## Reference facts (verify every table/column against SCHEMA.md before writing SQL/selects)

- `pec_sales_team_members`: `id, name, active, notes, commission_pct, exclude_from_commission, created_at, updated_at`. RLS on, 2 rows. These are NOT login accounts (that is `admin_users`).
- `admin_users`: `id, auth_user_id, email, name, role ('office' default), company ('both'), created_at`. 6 rows. Use `created_by` = the acting `admin_users.id` on appointments (mirror how other HQ writes stamp the actor).
- `leads`: has `id, first_name, last_name, full_name, email, phone, address, city, state, zip, gate_code, stage, customer_id, ...`. Stage move goes through `moveLeadStage(leadId, toStage)` (index.html ~18724) which calls `commitLeadStage`; the stage list is `LEAD_STAGES` (objects with `.key`/`.title`). Confirm the exact key for the estimate stage from `LEAD_STAGES` before using it (referenced as `'estimate'` in several spots).
- `settings`: key/value text table (17 rows). Fine for simple flags; the reminder RULES get their own table (below), not crammed into key/value.
- `pec_notifications`: rows are created via `.from('pec_notifications').insert(...)` in several places (index.html ~5003, ~6115-6182, ~7845). Reuse that exact shape/helper for the salesperson notify; do not invent a new notification path.
- Senders: `netlify/functions/pec-send-sms.cjs` and `pec-send-email.cjs` are the SMS/email send paths (Quo + Resend). Reuse their request shapes for confirmations/reminders. Respect consent exactly as the drip engine does (lead: positive `sms_consent` + not `opted_out` for SMS, `email_consent` for email; customer: opt-out-only `sms_opt_out`).
- Scheduled functions live in `netlify.toml` as `[functions."name"]` + `schedule = "*/15 * * * *"` (see `pec-drip-runner`, `*/15`). Register the pull runner and the reminder runner the same way.
- Google Places: `apps/estimator/src/lib/places.ts` already implements autocomplete via the CURRENT Places JS API (`importLibrary('places')`, `AutocompleteSuggestion`, `Place.fetchFields`) with graceful offline/no-key degradation. PORT that approach into a vanilla index.html helper (no Vite env). A domain-restricted browser key is ALREADY provisioned and already in `netlify.toml` `SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES` (`AIzaSyBUqdRk4eliEoc0vXK7XZz-4TiGdxnoGIY`); reuse that same key in index.html. Preflight below has Dylan confirm its referrer restriction + that the Places API is enabled.
- Two modal roots: `#pecModalRoot` (helpers `openModal`/`closeModal`, ~index.html:4808) for HQ-side views; `#prodModalRoot` for hand-rolled prod flows. The Appointments view is HQ-side: use the `pecModalRoot` helpers.
- supabase-js does NOT throw on a nonexistent column; it returns `res.error` with empty data. If a read comes back empty, check `res.error` first (this has bitten twice).
- Never use em dashes in customer-facing text (confirmations, reminders, portal-visible copy). Commas / parentheses / two sentences.

## Google sync design (read before building Phase B)

Two-way sync of a member's ENTIRE primary Google calendar is risky: TopCoat would ingest all their personal events, and a delete/reschedule of a pulled personal event from inside TopCoat would write back to their real personal calendar. Recommended design (build this unless Dylan says otherwise):

1. **Own both-ways: a dedicated "TopCoat" calendar per member.** On connect, create (or reuse) a secondary Google calendar named "TopCoat" in the member's account and store its `calendar_id`. TopCoat appointments push into THAT calendar, and the pull runner reads only THAT calendar. Full two-way, no flooding, and TopCoat can never mutate a personal event.
2. **See-only overlay of the primary calendar (optional, additive).** To reproduce the screenshot's personal blocks ("Busy", "Home Depot"), also read the member's `primary` calendar events read-only and render them as greyed, non-editable overlay blocks (for conflict visibility). TopCoat never writes to `primary`.

This gives real two-way for the appointments TopCoat owns plus the "everything in one place" view, without the danger. **One call for Dylan (surfaced in chat, not blocking): confirm dedicated-"TopCoat"-calendar (recommended) vs syncing primary directly.** Default to the dedicated calendar.

Pull mechanism: **incremental polling with `syncToken`** on a scheduled function (every 15 min, `pec-google-calendar-pull`), NOT Google push/watch channels. Watch channels need a public webhook plus channel renewal every few weeks and are fragile at this scale; incremental `events.list(syncToken)` is simpler and self-heals (on 410 GONE, drop the token and full-resync). Match the `pec-drip-runner` posture: an outside call just triggers an ordinary idempotent tick.

Echo/loop prevention + conflict: store `google_event_id`, `google_etag`, `google_updated` on each appointment. Push stamps them from the API response. Pull upserts by `google_event_id`; if the incoming Google `updated` is not newer than stored `google_updated`, skip (it is our own echo). Last-writer-wins on `google_updated` for genuine conflicts. Google `status:'cancelled'` on a pulled event marks the TopCoat row canceled. All privileged Google calls run server-side with the service role (tokens never reach the client, see secrets).

## Tasks (in dependency order; each a separate commit)

### 1. Migration: appointments + Google connection + reminder rules (Claude Code writes; Cowork applies)
Write `supabase/migrations/2026-07-20_appointments.sql`, additive + idempotent, with a verify block at the bottom. Tables:

- `pec_appointments`: `id uuid pk default gen_random_uuid()`, `appt_type text not null check (appt_type in ('on_site_estimate','project_walkthrough','site_visit','other'))`, `title text`, `lead_id uuid`, `customer_id uuid`, `sales_member_id uuid references pec_sales_team_members(id)`, `start_at timestamptz not null`, `end_at timestamptz not null`, `all_day boolean not null default false`, `location_address text`, `location_city text`, `location_state text`, `location_zip text`, `location_place_id text`, `notes text`, `status text not null default 'scheduled' check (status in ('scheduled','completed','canceled'))`, `source text not null default 'topcoat' check (source in ('topcoat','google'))`, `google_event_id text`, `google_calendar_id text`, `google_etag text`, `google_updated timestamptz`, `created_by uuid`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`. Indexes on `start_at`, `sales_member_id`, and a partial unique on `google_event_id where google_event_id is not null`. RLS on, one all-staff policy (read+write for authenticated, mirror the Messages/`pec_email_log` all-staff posture) and zero anon.
- Connection STATUS on the roster (client-readable): `alter table pec_sales_team_members add column if not exists google_connected boolean not null default false`, `google_email text`, `google_calendar_id text`, `google_connected_at timestamptz`.
- SECRETS table (server-only, never client-readable): `pec_sales_member_google_tokens`: `id uuid pk`, `sales_member_id uuid unique references pec_sales_team_members(id)`, `access_token text`, `refresh_token text`, `token_expiry timestamptz`, `sync_token text`, `updated_at timestamptz default now()`. RLS ENABLED with **NO policies** (default-deny) so only the service role touches it. The UI reads connection state from the roster flags above, never from this table.
- `pec_appointment_reminder_rules`: `id uuid pk`, `enabled boolean not null default true`, `audience text not null check (audience in ('customer','salesperson'))`, `channel text not null check (channel in ('sms','email','both'))`, `offset_minutes int not null` (minutes before `start_at`; a booking-confirmation rule uses a sentinel, e.g. a boolean `on_book boolean not null default false` with `offset_minutes` ignored), `appt_type text` (null = all types), `message_template text`, `created_at`, `updated_at`. RLS on, admin-write / staff-read. Seed sensible defaults: one on-book customer confirmation (both channels) and one 1440-minute (1 day) customer reminder, both enabled, with templates using `{customer_first}`, `{appt_date}`, `{appt_time}`, `{sales_name}` tokens; one on-book salesperson in-app notify.
- `pec_appointment_reminder_sends` (idempotency ledger, like the drip ledger): `id uuid pk`, `appointment_id uuid`, `rule_id uuid`, `channel text`, `sent_at timestamptz default now()`, `status text`. Unique on `(appointment_id, rule_id, channel)` so a reminder can never double-send.

Do NOT apply the migration yourself; it is a Cowork handoff, then Cowork regenerates SCHEMA.md. All view/runner code must degrade cleanly before the tables exist.

### 2. Appointments view (native calendar, Month/Week/Day) — NO Google yet
New top-level nav item "Appointments" -> `renderAppointments()`. Reads `pec_appointments` + `pec_sales_team_members`. Month (default) / Week / Day toggles. Filters: appointment type and salesperson (default "All Users"). Per-member color plus a per-type accent. "New Appointment" button opens a create form in `#pecModalRoot` (type, title, salesperson, date, start + end time [default +1h], all-day, location fields, link to a lead/customer optional, notes). Click an event -> edit form (same modal) with delete/cancel. Drag-to-reschedule and resize.
- Recommended: lazy-load FullCalendar 6 from cdnjs (mirror the existing Chart.js lazy-load-with-fallback pattern; there is no CSP to amend). If the CDN fails, fall back to a simple month-list render so the view still works offline/blocked. Reinventing month/week/day + drag/resize by hand is not worth it, but keep the write path (Supabase upsert) independent of the render library so a fallback still edits.
- Writes go straight to `pec_appointments` via supabase-js (client-orchestrated, like the rest of HQ). This commit has no Google side; it is fully useful on its own.

### 3. Address autocomplete helper (vanilla, ported from the estimator)
Add an index.html helper that mirrors `apps/estimator/src/lib/places.ts`: inject the Maps JS script once (`importLibrary('places')`, current `AutocompleteSuggestion`/`Place.fetchFields` API, `loading=async`), suggestions strictly an online enhancement, the input fully usable typed by hand, silent degrade with no key / offline / blocked. Reuse the already-omit-listed key. Wire it into the appointment form's location field (fills address/city/state/zip + `location_place_id`).

### 4. Wire autocomplete into the Lead address fields
Apply the same helper to the lead create/edit address input(s) so typing a street fills city/state/zip, hand-editable. Do not touch customer/job forms this pass.

### 5. "Schedule Estimate" from a lead
Add a "Schedule Estimate" action on the lead detail (`openLeadDetail`) and the lead card (`renderLeads`). It opens the appointment form prefilled: `appt_type='on_site_estimate'`, `lead_id`, `customer_id` (if any), customer name into `title`, and address/city/state/zip from the lead. On save: create the appointment AND advance the lead via `moveLeadStage(leadId, <estimate stage key>)` (confirm the key from `LEAD_STAGES`; do not fire the lost path). Guard: if the lead is already at/past the estimate stage, still create the appointment but skip the stage move.

### 6. Notifications on booking (in-app + customer confirmation)
On appointment create for a real customer/lead: (a) insert a `pec_notifications` row for the assigned salesperson (reuse the existing insert shape), and (b) if an on-book confirmation reminder rule is enabled and consent allows, send the customer a confirmation via `pec-send-sms`/`pec-send-email` and write the `pec_appointment_reminder_sends` ledger row. Ad-hoc (`other`, no customer) sends nothing. No em dashes in the copy. This is client-triggered for the notify; the customer send should go through a small server function if a token/secret is needed (mirror how the existing senders are invoked).

### 7. [Phase B] Google OAuth: connect / callback / disconnect
Add `netlify/functions/_pec-google.cjs` (shared helper: token refresh via `refresh_token`, `getFreshAccessToken(memberId)`, Calendar API fetch wrappers with an abort timeout like `timedFetch`). Add `pec-google-oauth-start.cjs` (builds the consent URL; scopes: `https://www.googleapis.com/auth/calendar.events` + `openid email`; `access_type=offline`, `prompt=consent` to guarantee a refresh token; `state` = a signed `sales_member_id`), `pec-google-oauth-callback.cjs` (exchange code, on connect create-or-reuse the dedicated "TopCoat" calendar, store tokens in `pec_sales_member_google_tokens`, set the roster status flags + `google_calendar_id`, redirect back to Settings), `pec-google-disconnect.cjs` (revoke + clear tokens + flags). All secrets server-side only.

### 8. [Phase B] Settings: connect Google per member + reminder rules editor
New "Appointments" panel in Settings (mirror `renderSettings`/`renderSettingsEmail` patterns). Per roster member: a Connect Google / Disconnect button reading the roster status flags (shows connected email). A reminder-rules editor over `pec_appointment_reminder_rules` (enable/disable, audience, channel, offset, per-type, editable message template with the token list documented inline). Admin-gated.

### 9. [Phase B] Push: TopCoat -> Google on create/update/cancel
`pec-appt-sync-push.cjs`: given an appointment id, read it (service role), and if the assigned member is connected, `events.insert/update/delete` into their "TopCoat" calendar; store `google_event_id/google_calendar_id/google_etag/google_updated` back on the row. The client calls this after each appointment write (insert/update/cancel), best-effort (a push failure must never block the local save; surface a soft "not synced yet" state). Idempotent: an update to an already-synced row patches by `google_event_id`.

### 10. [Phase B] Pull: Google -> TopCoat (scheduled, incremental)
`pec-google-calendar-pull.cjs`, registered in `netlify.toml` (`*/15 * * * *`). For each connected member: `events.list` on the "TopCoat" calendar with the stored `sync_token` (full list if none), upsert into `pec_appointments` by `google_event_id` with the echo/LWW rule above, mark cancellations, persist the new `sync_token`; on 410 GONE drop the token and full-resync. If the primary-overlay option is confirmed, also read `primary` read-only for greyed overlay blocks (never written back). Match `pec-drip-runner`'s idempotent-tick posture.

### 11. [Phase B] Reminder runner (scheduled)
`pec-appt-reminder-runner.cjs`, registered in `netlify.toml` (`*/15 * * * *`). Find `scheduled` appointments whose `start_at` minus a rule's `offset_minutes` is now-due and that have no matching `pec_appointment_reminder_sends` row, respect consent + quiet hours (8am-8pm America/Phoenix for SMS, email anytime, same as drips), send via the existing senders, write the ledger. Never resend (the unique index is the backstop).

### 12. Standing-rules chores
Add/refresh `features.json` entries (new "Appointments calendar", "Google Calendar two-way sync", "Address autocomplete (HQ)"), with anchors (`renderAppointments`, the new functions, the new tables). Append What's New entries (task 13). Update the relevant feature entries if the lead flow anchors change.

### 13. What's New
Append entries (id, date, title, one-line summary, 2-3 plain-language how-to steps, no em dashes) to `help/whats-new.json` for: the new Appointments calendar + New Appointment, Schedule Estimate from a lead, connecting your Google Calendar in Settings, and address autocomplete.

## Preflight (do these BEFORE building; they change the work)
- Confirm the estimate stage key from `LEAD_STAGES` (task 5 depends on it).
- Confirm the `pec_notifications` insert shape from an existing call site (task 6) rather than guessing columns.
- Confirm the Maps/Places key `AIzaSy...noGIY` is referrer-restricted to the Netlify domain (+ any custom domain) and that BOTH Maps JavaScript API and Places API are enabled on it (Dylan/Cowork handoff). If Places is not enabled, autocomplete silently no-ops (safe) but will not suggest.
- Do not run tasks 5-6 and any other in-flight prompt that edits `renderLeads`/`openLeadDetail` simultaneously; re-anchor whichever ships second.
- Read the dataviz skill only if you add any chart here (you likely do not).

## Secrets + external setup (Dylan/Cowork handoffs; Claude Code uses placeholders, never commits secrets)
- Google Cloud project: enable Google Calendar API, Maps JavaScript API, Places API. OAuth consent screen (External; scopes `calendar.events`, `openid`, `email`; add the salespeople as test users or publish). Create a Web OAuth client with redirect URI `https://prescottepoxy.netlify.app/.netlify/functions/pec-google-oauth-callback`. Set Netlify env `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (server-only; NOT in client, NOT committed).
- Maps/Places browser key: reuse the existing omit-listed key; confirm restriction + Places API enabled (above). If a new key is ever minted, update index.html AND `netlify.toml` omit values in the same commit (CLAUDE.md rule 7/33).
- Migration `2026-07-20_appointments.sql`: Cowork applies to prod, runs the verify block, regenerates SCHEMA.md.

## Commit + log (per CLAUDE.md)
Commit each task as its own unit (`appointments: <what>`, `google-sync: <what>`, etc.) so Phase B reverts cleanly. Never commit secrets. Append ONE PROJECT-LOG entry at the top when done (`By: Claude Code`) describing what shipped, the migration handed to Cowork, and a `## Handoff to Cowork` (apply the migration + regenerate SCHEMA.md + the OAuth/Google-Cloud verification once Dylan provides the client id/secret) and `## Handoff to Dylan` (Google Cloud project + OAuth client + env vars + connect each salesperson + confirm the dedicated-calendar-vs-primary call).

## Out of scope (do not build)
- Merging into or changing the crew Job Schedule calendar (`renderSchedule`).
- Autocomplete on customer/job/prod forms (leads + appointment only this pass).
- Punch-out appointment type.
- Turning `admin_users` logins into the assignee source (roster is the source).
- Any auto-send that is not a booking confirmation or a configured reminder.
