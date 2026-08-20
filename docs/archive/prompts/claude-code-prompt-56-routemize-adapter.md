# Claude Code Prompt 56: Routemize native-webhook adapter for pec-appt-intake

## Context

Routemize is now the live booking front end for PEC. As of 2026-07-29 a **native Routemize Custom Webhook** ("TopCoat appointment intake", Active) posts all five appointment events directly to:

```
https://prescottepoxy.netlify.app/.netlify/functions/pec-appt-intake
```

with a custom header `x-webhook-secret` carrying PEC_WEBHOOK_SECRET. **Auth already works.** The test delivery returned `400 / rejected / "routemize_appt_id is required"`, not 401, which proves the secret is correct and the request reaches us.

This REPLACES the Zapier design in `claude-code-prompt-43-routemize-appt-intake.md`. Zapier existed in that design to do two jobs: set the auth header and rename fields. Routemize's native webhook does the first. This prompt does the second. There is no Zapier in this chain, and none should be added.

**Current state: every real appointment 400s.** The endpoint is fine, it logs every attempt to `pec_webhook_ingest_log`, and nothing is corrupted. But nothing lands either. Routemize is booking daily (2 appointments on 2026-07-28 alone) and `pec_appointments` holds 1 row, a stale smoke test.

Routemize → DripJobs is STILL live and healthy (146 deliveries). Do not touch it. It gets retired only after this ships and is verified against a real booking.

---

## The real payload (production serializer, read from Routemize's own DripJobs delivery log, not a guess)

Envelope:

```json
{
  "eventId": "58289007-04c2-459e-bfa8-1bd566c06699",
  "eventType": "AppointmentCreated",
  "timestamp": "2026-07-28T20:32:25.866442Z",
  "tenantId": "f99ef972-3ac5-cc90-51f5-3a217775511f",
  "apiVersion": "v1",
  "data": { ... },
  "metadata": { "actorName": "...", "sourceIp": "...", "userAgent": "...", "additionalData": null }
}
```

Inside `data` (fields confirmed on a real AppointmentCreated):

| Field | Example | Maps to |
|---|---|---|
| `relatedEntityId` (+ `relatedEntityType: "Appointment"`) | `5ce70ae6-da0e-96da-1729-3a22bc9a90e6` | **`routemize_appt_id`** (also mirrored as `AppointmentId` in a nested PascalCase block) |
| `startTime` | `2026-07-29T15:00:00Z` | `start_at` |
| `endTime` | `2026-07-29T16:00:00Z` | `end_at` |
| `contactName` | `John Courtis` | `customer_name` |
| `contact.firstName` / `.lastName` / `.email` / `.phoneNumber` | | name / email / phone |
| `contact.contactId` | `6e43abf5-...` | new Routemize contact id column |
| `contact.leadSource` / `.leadSourceText` | `Other`, `Google` | lead source (see decision 10) |
| `contact.businessName` | `null` | optional |
| `address.addressLine1` / `.addressLine2` / `.city` / `.state` / `.zipCode` | `DEWEY`, `AZ`, `86327-5311` | `location_*` columns |
| `address.latitude` / `.longitude` | | ignore for now |
| `serviceName` | `Estimate` | drives `appt_type` via the settings map |
| `eventTypeId` | uuid | secondary key for the settings map |
| `appointmentTitle` | `Meeting with - John` | **not used**, see decision 6 |
| `assignedUsers[]` | `{ userId, firstName, lastName, email, userName }` | rep mapping |
| `customerAnswers[]` | `{ questionId, question, answer, attachments[] }` | `customer_notes` |
| `customQuestions[]` | form definition | ignore |
| nested `AppointmentNotes` | `""` | internal `notes` |

`startTime` carries an explicit `Z`. `parseApptDate` already trusts an explicit offset, so **do not add timezone handling** — the Phoenix bare-datetime branch must not run on these.

---

## Locked decisions (Dylan, 2026-07-29). Do not re-litigate.

1. **Auto-detect, one endpoint.** If the body has `eventType` AND `data`, treat it as Routemize native and map it. Otherwise fall back to the existing hand-rolled contract. The prompt-43 contract keeps working (a manual curl must still succeed).
2. **Rep mapping order:** `assignedUsers[0].userName` → then `.email` → then first+last name. All against `pec_sales_team_members.google_email` (name against `.name`), case-insensitive. `userName` first because on the real sample it held the work address `aron@prescottepoxy.com`.
3. **AppointmentStatusChanged maps by status value.** A cancelled-type status sets `status='canceled'`; anything else patches as an update.
4. **customerAnswers → `customer_notes`** (formatted Q&A pairs, the customer wrote them). Routemize's `AppointmentNotes` plus any unmapped-rep warning → internal `notes`.
5. **appt_type via a settings-backed map.** New settings key mapping `serviceName` (and/or `eventTypeId`) to our four appt types, defaulting to `on_site_estimate` when unmapped. Standing rule 12: tunable from Settings, no deploy to add a Routemize service.
6. **Build our own title**, e.g. `"John Courtis, Estimate"`. Ignore `appointmentTitle`. This title shows on the TopCoat calendar and syncs out to Google Calendar.
7. **PEC only.** Hardcode the brand. FTP does not use Routemize.
8. **No backfill.** Only new events flow. Appointments already on the Routemize books (John Courtis 7/29, Susan Nasser 8/3) will NOT appear in TopCoat.
9. **Create a lead when nothing matches.** See landmine 1 — this REVERSES prompt 43.
10. **Lead source is attributed to the person, not the appointment.** Do not put lead source on `pec_appointments`. On an EXISTING lead: fill only if blank, never overwrite. On a NEW lead: use Routemize's own `leadSource` value, falling back to `'routemize'` when Routemize sends nothing.
11. **Ship live, no kill switch.** The endpoint currently rejects everything, so there is no working behavior to protect.
12. **Store `contact.contactId`** on the matched/created lead or customer. One small nullable column plus a migration.

---

## Landmines

**1. Decision 9 REVERSES prompt 43's locked decision 3** ("match a LIVE lead ... else a customer ... else leave both null. Never auto-create a lead or customer here (would collide with the other intake paths)"). That reasoning was correct when DripJobs was the front door. Routemize is now the front door, and a direct booker who never becomes a lead would show on the calendar but never enter the pipeline, so the follow-up queue and drips would never see them. Do NOT "fix" this back to the prompt-43 behavior. The collision risk it warned about is real and is what landmine 2 addresses.

**2. Duplicate leads are the actual risk of decision 9.** The same human can arrive via a Meta/webform Zap into `pec-lead-intake` and via a Routemize booking minutes apart. Before creating, apply the SAME dedupe `pec-lead-intake.cjs` uses: a live lead with matching normalized last-10 phone OR matching email, created within the 90-day window. On a hit, link to that lead instead of creating, and append a `lead_event` recording the Routemize booking. Prefer extracting the existing dedupe into a shared helper over copy-pasting the rule, so the two intakes cannot drift apart.

**3. Do not double-enroll a drip on a lead created from a booking.** `pec-lead-intake` calls `enrollLead` on arrival. A lead created here already has an appointment booked, and `apptBookingLeadEffects` immediately PAUSES the nurture drip. Enrolling and then instantly pausing is churn and pollutes the drip ledger. Create the lead at the correct stage and skip nurture enrollment for this path; let `apptBookingLeadEffects` do the stage work it already does.

**4. `eventType` casing is NOT consistent.** The real appointment event was PascalCase `AppointmentCreated`. The synthetic test event was dotted lowercase `test.webhook`. Normalize aggressively (strip non-alphanumerics, lowercase) before matching, and handle `appointment.created` style as well as `AppointmentCreated`. An unrecognized `eventType` must return **200** with a no-op, never a 4xx.

**5. `AppointmentStatusChanged`'s payload shape is UNVERIFIED.** The captured sample is a Created event; no status field was observed. Do not guess a field name and silently depend on it. Read the status defensively from the likely candidates, and when no status can be determined, treat the event as an update (never as a cancellation) and note it in the internal notes. Deleting a real appointment because of a mis-read field is the worst failure available here.

**6. Never return a non-2xx for anything recoverable.** Routemize retries on failure and tracks webhook health. Unknown event, unmatched rep, unparseable optional field: log it, return 200. Reserve 4xx for a genuinely unusable body.

**7. Idempotency.** `eventId` is stable per delivery and `relatedEntityId` is stable per appointment. Retries of the events that have been 400ing may still be queued on Routemize's side, so the created/updated path must remain upsert-safe on `routemize_appt_id` exactly as it is today.

**8. Deploy-order guard.** The migration for the contact-id column will be WRITTEN, NOT APPLIED (Cowork applies it). Until then the endpoint must tolerate the column being absent without failing the intake, same pattern as prompt 54's `name_aliases` guard.

**9. Do not touch `google_*` columns** on `pec_appointments`. `pec-appt-sync-push.cjs` owns them and gives us Google Calendar visibility for free.

---

## Also required by standing rules

- **Rule 11 (What's New):** this IS user-facing (appointments start appearing on the TopCoat calendar). Add an entry to `help/whats-new.json`.
- **Rule 12 (Settings):** the serviceName → appt_type map is adjustable in company Settings.
- **Rule 13 (@artifacts header):** on the migration file.
- **Rule 9:** update the relevant `features.json` entry.
- `npm test` green before every commit.

---

## Verify

1. A manual curl in the OLD prompt-43 contract still returns 200 and creates an appointment (decision 1 did not break it).
2. A replay of the captured Routemize `AppointmentCreated` envelope returns 200, creates one `pec_appointments` row with `source='routemize'`, correct UTC `start_at` (15:00Z stays 15:00Z, not shifted to 22:00Z), rep resolved to Aron Bronson, and `customer_notes` holding the Q&A text.
3. The same envelope replayed a second time updates rather than duplicates.
4. An envelope with an unknown `eventType` returns 200 and writes nothing.
5. An envelope whose contact matches no existing lead creates exactly ONE lead, with Routemize's leadSource, and does NOT create a second lead when replayed.
6. An envelope whose contact matches an existing lead with a source already set leaves that source unchanged.

## Handoff to Cowork

1. Apply the contact-id migration to PROD (zdfpzmmrgotynrwkeakd) and regenerate SCHEMA.md.
2. Verify against a REAL booking, not the synthetic test event: watch `pec_webhook_ingest_log` for the next `appt-intake` row and confirm outcome `ok`, then confirm the appointment renders on the TopCoat calendar with the right rep and time.
3. Only after 2 passes: retire the Routemize → DripJobs push (Routemize > Settings > Integrations > DripJobs > Disconnect).
4. Append a `By: Cowork` PROJECT-LOG entry with the first real appointment's id and the ingest-log outcome.
