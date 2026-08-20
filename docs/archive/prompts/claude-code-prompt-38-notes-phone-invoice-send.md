# Claude Code Prompt 38: appointment notes split (customer vs internal), customer phone on job/lead/appointment details, and a combined Email+Text send control for invoices AND estimates

Repo: /Users/dylannordby/Claude-Code/HQ-Dashboard
Deploy: https://prescottepoxy.netlify.app
Supabase project: "HQ Dashboard" (zdfpzmmrgotynrwkeakd)

## Context

Three independent Dylan requests, bundled here as three separately-committable features. Feature 1 builds on the Appointments calendar that shipped today (prompt 37, commits 3b09aa9..33d868a); features 2 and 3 touch existing job/lead/invoice/estimate views. Read the last few PROJECT-LOG entries and CLAUDE.md before starting. Verify every table/column against SCHEMA.md before writing SQL or a supabase-js select (supabase-js returns `res.error` with empty data on a bad column, it does not throw; this has bitten twice).

Take the features in order. Each is its own commit (or small set of commits). None depends on another, so any one can be reverted alone.

## Confirmed anchors (grounded in the current code; re-anchor if line numbers drifted)

- Appointment form: `openAppointmentForm(existing, prefill)` at index.html ~18611. Single notes field `#afNotes` ("Notes") at ~18674; the save `row` object is built at ~18722 and writes `notes: val('afNotes')`.
- Appointment types: `APPT_TYPES` / `APPT_TYPE_LABELS`.
- Google push: `netlify/functions/pec-appt-sync-push.cjs`. The event body is built ~lines 46-52: `summary = appt.title || label`, `description: appt.notes || ''`, `location = [address, city, state, zip]`.
- Google pull mapping: `netlify/functions/pec-google-calendar-pull.cjs` (maps a pulled event's description back onto the row; see the echo/LWW rule).
- Reminder engine: `netlify/functions/_pec-appt.cjs`. `renderTemplate(tpl, ctx)` ~57 (tokens `{customer_first}`, `{appt_date}`, `{appt_time}`, `{sales_name}`); the customer SMS/email sends build `body = renderTemplate(rule.message_template, ctx)` ~138 (SMS) and ~174 (email); `scrubDashes` strips em dashes on stored templates.
- Invoice send buttons: `renderJobInvoice`. `#pecInvEmail` ("Email invoice") and `#pecInvText` ("Text invoice") at index.html ~9817-9818. Email compose modal ~9958; text send logic ~9885-9917 (Quo, `kind='invoice'`, appends a "Reply STOP to opt out" line, has a confirm dialog).
- Estimate send: `renderEstimateDetail` -> the send modal at index.html ~21213 (`#estCmpSend`). Estimates send by EMAIL ONLY today via `pecSendEmail({ ..., log_template_key: 'estimate' })` ~21260, then flip the estimate to sent (`sent_at`, `status='sent'`) ~21262 and call `estimateSentLeadEffects(est, nowIso)` ~21267. There is NO text-estimate path today. Public estimate link is `${location.origin}/e/${est.public_token}` ~21201. There is a BLANK-scope send-gate warn ~21252.
- Phone helpers/anchors: tel-href helper at index.html ~15917; lead detail already shows Phone as a `tel:` row (`openLeadDetail`, ~20285); estimate detail shows a `tel:` phone (~20713). Jobs page `renderJobs` ~5613. Crew job card `renderJobCard` (notes-box render ~12239, card body). Lead list `renderLeads` ~18868. The one customer-texting entry point is the `renderMessages` comms feed (features.json ~432; "Staff text the customer right from the job") — tap-to-text must route here, do NOT open a new SMS path.

---

## Feature 1: split appointment notes into customer "Job notes" and internal "Company notes"

Dylan wants two note fields when scheduling (applies to ALL appointment types, not just estimates):
- **Company notes (internal):** private detail so the salesperson is informed. These are what shows in the Google Calendar event description when the salesperson opens the event on their phone.
- **Job notes (customer-facing):** what the customer sees, auto-added to their automated confirmation and reminder messages.

Today there is one `notes` field, and it already feeds the Google description. So keep `notes` AS the internal company notes (no data migration needed; any existing notes stay internal), and ADD a new customer-facing field.

### 1a. Migration (Claude Code writes; Cowork applies — do NOT apply it yourself)
Write `supabase/migrations/2026-07-21_appointment_customer_notes.sql`, additive + idempotent, with a verify block at the bottom:
```sql
alter table pec_appointments add column if not exists customer_notes text;
```
No RLS change (the existing all-staff policy covers the new column). Verify block: confirm the column exists (information_schema), text, nullable. Hand this to Cowork to apply + regenerate SCHEMA.md (standing rule 9). All code below must degrade cleanly if the column does not exist yet (a select of a missing column returns `res.error`; guard the reads).

### 1b. Appointment form (`openAppointmentForm`, ~18674 and ~18722)
- Relabel the existing field from "Notes" to **"Company notes (internal)"** with helper text like `Private. Shows on the Google Calendar event, not sent to the customer.` (still `#afNotes` -> `notes`).
- Add a new field above or below it, **"Job notes (customer sees)"** (`#afCustomerNotes` -> `customer_notes`), helper text like `Added to the customer's appointment confirmation and reminder texts and emails.`
- Add `customer_notes: val('afCustomerNotes') || null` to the save `row`. Prefill `a.customer_notes` on edit.

### 1c. Google event description (`pec-appt-sync-push.cjs`, ~51)
Change the pushed `description` from bare `appt.notes` to a composed block so the salesperson has everything on their phone calendar:
1. The internal company notes (`appt.notes`), if any.
2. A separator line, then an auto-added contact/link block: customer name and phone (fetch from the linked `lead_id`/`customer_id`; the appointment row does not store a phone), and a TopCoat deep-link to the appointment (reuse the same deep-link the `pec_notifications` 'appointments' target uses — see prompt 37's `notifTarget` routing).
Do NOT push `customer_notes` to Google (it is customer-facing, not for the calendar). No em dashes anywhere in the composed text. Use a stable separator (e.g. a line of dashes or a `— TopCoat —`-free marker like `----`) so the pull side (1e) can distinguish the human-typed part from the auto-added block.

### 1d. Reminders carry the job note (`_pec-appt.cjs`, customer sends ~138 and ~174)
When the audience is the **customer**, after building `body = renderTemplate(...)`, if `appt.customer_notes` is non-empty, append it to the message body on BOTH channels (SMS and email), e.g. `body + '\n\n' + scrubDashes(appt.customer_notes)`. Run it through `scrubDashes` (standing rule 6). Salesperson messages are unaffected. Make sure the runner's appointment read selects `customer_notes` (guarded for the pre-migration window).

### 1e. Pull round-trip safety (`pec-google-calendar-pull.cjs`)
The description now carries a composed block (internal notes + auto-added contact/link). Update the pull mapping so it does NOT clobber `notes` with the auto-added contact/link block: on a genuine Google-side description edit, ingest only the free-text portion above the separator into `notes`, and never write the contact/link block back into stored `notes`. Never touch `customer_notes` from Google. (Our own pushes are already echo-skipped by the `google_updated`/etag rule; this guard is for real edits made in Google.)

---

## Feature 2: customer phone number visible on job, lead, and appointment details (tap-to-call + tap-to-text)

Show the customer's phone number, as a tap-to-call link plus a small tap-to-text action, on all four surfaces:
- **Jobs page** (`renderJobs` ~5613) — job/customer detail.
- **Crew job card / job detail** (`renderJobCard`).
- **Lead card and lead detail** (`renderLeads` ~18868 and `openLeadDetail` ~20285). Lead detail already has a `tel:` phone row — add the tap-to-text icon there; make sure the lead CARD also surfaces the number.
- **Appointment detail popup** (`openAppointmentForm`) — the appointment row has no phone; fetch it from the linked `lead_id`/`customer_id` and show it read-only near the customer/title.

Behavior:
- Tap-to-call: `tel:` link (reuse the helper at ~15917 so formatting is consistent).
- Tap-to-text: a small icon/button next to the number that opens the EXISTING customer comms feed / texting entry point (`renderMessages`, features.json ~432). Do NOT build a new SMS compose or a raw `sms:` link — routing through the existing feed keeps consent/opt-out and logging correct.
- If there is no phone on file, show nothing (or a muted "No phone on file"); do not render a dead link.

---

## Feature 3: one "Send" control (Email + Text) for invoices AND estimates

Replace the separate Email/Text buttons with a single split button: a primary action plus a caret dropdown offering **Email + Text**, **Email only**, **Text only**. The primary click defaults to **both**. This applies to BOTH invoices and estimates (Dylan explicitly asked for the same treatment on estimates).

Combined-send flow (when "both" or a channel is chosen):
- **Both:** show the existing email compose modal AND the text confirm dialog before anything sends (compose email + confirm text). Do not fire silently.
- **Missing channel:** if "both" is chosen but the customer has only an email or only a phone, send on whatever is available and surface a small note that the other was skipped (e.g. "No phone on file, texted skipped"). Do not hard-block.

### 3a. Invoice (`renderJobInvoice`, ~9817-9818)
Replace `#pecInvEmail` + `#pecInvText` with the split button. Reuse the existing invoice email compose modal (~9958) and the existing invoice text send (~9885-9917, `kind='invoice'`, STOP line). "Both" = open the email compose, and also run the text confirm+send. Keep the existing per-channel logging (Communication history) intact.

### 3b. Estimate (`renderEstimateDetail` send, ~21213) — NOTE: the text path is NEW
Estimates only email today. Building "Text estimate" is real new work, not just a UI merge:
1. Add a text-estimate SMS send that texts the public estimate link (`/e/<public_token>`) via Quo, mirroring the invoice text path: consent check, "Reply STOP to opt out" line, log to `pec_sms_log` with an estimate kind/template key (mirror `log_template_key: 'estimate'` so it stays out of the invoicing "last invoiced" counter).
2. CRITICAL: a text-only send must run the SAME post-send side effects the email send does — flip the estimate to `sent_at`/`status='sent'` (~21262) and call `estimateSentLeadEffects(est, nowIso)` (~21267). Otherwise a texted estimate would never go "live"/sent and the lead conversion metrics + drip kill-switch would be wrong. Guard against double-flipping when both channels send (set sent state once).
3. The BLANK-scope send-gate warn (~21252) must fire on ANY channel (text-only too), not just email.
4. Wrap the send trigger in the same split button (Email + Text / Email only / Text only, default both). "Both" = email compose modal + text confirm.

---

## Mentor push-backs (surface to Dylan; not blocking)
- The estimate text path is the largest hidden cost here: it is a NEW send channel with its own consent, logging, and "mark sent" side effects, not a cosmetic button merge. It is committed separately so it can be reverted without touching the invoice/estimate email flows.
- Defaulting the primary click to "both" means a stray click can double-message a customer. Keep the compose+confirm steps for "both" (as specified) so nothing sends on a single accidental click, and make the sent-state flip idempotent.
- Phone tap-to-text intentionally routes through the one existing comms feed rather than a native `sms:` link, so opt-out/STOP enforcement and logging stay in one place across all four surfaces.

## Standing-rules chores
- `features.json`: update the Appointments entry (two note fields, Google-description composition, reminder job-note), the Invoicing/estimate entries (combined send control, new estimate text channel), and the comms/phone entries (phone on job/lead/appointment details). Keep anchors current.
- What's New (`help/whats-new.json`, newest first, no em dashes): one entry each for (a) customer vs internal appointment notes, (b) customer phone with tap-to-call/text on job and lead details, (c) the combined Send (email + text) control on invoices and estimates.
- Commit per feature/sub-part (`appointments: split customer vs internal notes`, `push: compose google description`, `reminders: append customer job note`, `ui: phone tap-to-call/text on details`, `invoice: combined send control`, `estimate: text send + combined control`). Never commit secrets or `.env`.
- No em dashes in any customer-facing text (confirmations, reminders, invoice/estimate messages, What's New).

## Verify before you finish
- `npm test` green (touching `_pec-appt.cjs` and the runner is covered by `production/appt-reminders.test.cjs`; add/extend a case that the customer job note is appended on both channels and only for the customer audience, and that the Google description composition + pull-round-trip guard behave).
- `node --check` on every touched `.cjs`; all inline index.html JS blocks parse.
- `features.json` + `help/whats-new.json` validate as JSON.
- Manually confirm: appointment form shows both note fields and saves both; a booked estimate's reminder text/email includes the job note but the Google event shows the company notes + phone + link (not the job note); phone tap-to-call and tap-to-text work on all four surfaces; the invoice and estimate split buttons send both by default, email-only and text-only work, and a text-only estimate flips to "sent".

## Commit + log (per CLAUDE.md)
Append ONE PROJECT-LOG entry at the top when done (`By: Claude Code`) describing what shipped, the migration handed to Cowork, and a `## Handoff to Cowork` (apply `2026-07-21_appointment_customer_notes.sql` to prod, run the verify block, regenerate SCHEMA.md) and a `## Handoff to Dylan` (git commit if the session cannot; note the estimate text channel is new and worth a live test). If this session cannot `git commit` from its sandbox, say so and leave the commit to Dylan.

## Out of scope (do not build)
- Any new customer-facing surface for the job note beyond the automated reminders (no portal/estimate-page display this pass).
- Autocomplete or other unrelated appointment-form changes.
- Changing the crew Job Schedule calendar.
- A native `sms:`/`mailto:` compose that bypasses the existing comms feed and senders.
