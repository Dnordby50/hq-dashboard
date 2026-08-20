# Claude Code prompt 95: Routemize reschedules must actually move the appointment (plus numeric status, a replay of the four missed events, and an alarm so this can never be silent again)

## Context

Dylan, 2026-08-18: "Routemize, appointment got updated in their system but did not update in TopCoat. Diagnose and repair so this does not happen again."

Cowork already diagnosed it against the live database. Do not re-diagnose; verify the claims below and build.

**Root cause, one sentence:** `mapRoutemizeEnvelope` reads the start/end times from `data.startTime` / `data.endTime` (netlify/functions/pec-appt-intake.cjs:417-420), and an `AppointmentUpdated` envelope does not carry those fields at all, it carries `newStartTime` / `newEndTime`, so `parseApptDate(body.start_at)` returns null (pec-appt-intake.cjs:657), the handler takes the defensive "no readable start time" branch (:659-676), appends an internal note, answers 200, and leaves `start_at` exactly as it was.

**It has happened four times in production.** From `pec_webhook_ingest_log` (endpoint `appt-intake`, message `updated: no readable start time%`):

| when (UTC) | routemize_appt_id | who | appointment id |
|---|---|---|---|
| 2026-08-13 18:48:42 | d783f1d5-efb8-db1b-4122-3a230e95691f | Karen Adams | 01f84b13-99f7-4618-8da8-1ef10f4ba6ec |
| 2026-08-13 18:42:50 | d783f1d5-efb8-db1b-4122-3a230e95691f | Karen Adams | 01f84b13-99f7-4618-8da8-1ef10f4ba6ec |
| 2026-08-10 17:22:38 | 704bae82-a6d7-f6fc-7a26-3a22f4d78221 | Rob Rudman | 33676b2c-6ebb-4065-bd40-175cbf1ec988 |
| 2026-07-29 21:08:26 | 5a213677-f851-b022-aa9a-3a22c1e08a08 | Jay McCoy | 0e1809bc-7717-4e38-9c51-b1a0ef46f080 |

Karen Adams is the one Dylan noticed: Routemize moved her 8/14 visit from 3:00 PM to 9:15 AM, and `pec_appointments.start_at` still reads `2026-08-14 22:00:00+00` (3:00 PM Phoenix). Her row has a `google_event_id`, so the stale time also propagated to the Google calendar.

### THE LANDMINE: the obvious fix shifts every non-reschedule update by seven hours

`AppointmentUpdated` sends `newStartTime` in TWO formats, and the difference is not semantic:

| event | newStartTime | oldStartTime | reason | notificationVariables.AppointmentTime |
|---|---|---|---|---|
| Karen 18:48 | `2026-08-14T16:15:00Z` | `2026-08-14T22:00:00Z` | TimeChanged | **9:15 AM** |
| Karen 18:42 | `2026-08-14T22:00:00` | `2026-08-14T22:00:00Z` | Updated | 3:00 PM |
| Rob 17:22 | `2026-08-11T15:05:00` | `2026-08-11T15:05:00Z` | Cancelled | 8:05 AM |
| Jay 21:08 | `2026-07-31T16:15:00` | `2026-07-31T16:15:00Z` | Updated | 9:15 AM |

Read row 4: `16:15:00` with no `Z`, and Routemize's own human-readable variable says the appointment is at **9:15 AM Phoenix**, which is `16:15Z`. So a BARE Routemize datetime is **UTC with the Z dropped**, not Phoenix wall clock. `parseApptDate` (pec-appt-intake.cjs:133-149) treats a bare datetime as Phoenix `-07:00` by project convention, which is correct for the hand-rolled curl contract and **wrong for every Routemize field**. Feeding `newStartTime` straight into it moves those appointments seven hours later.

Also note rows 2, 3 and 4: Routemize echoes the CURRENT time on ordinary edits (an address correction, a cancellation). The update path must therefore be safe when nothing about the time changed, not just on a genuine reschedule.

### Second defect found in the same read

`readRoutemizeStatus` (:241-247) collects a status string and tests it with `/cancel/i` (:360). Live `newStatus` values are **numeric strings**: `"1"` = scheduled, `"3"` = cancelled. The regex can never match, so a Routemize cancellation only reaches TopCoat because a separate `AppointmentCancelled` event happens to follow (Rob Rudman: the Updated arrived 17:22:38, the Cancelled 17:22:41, three seconds apart).

That matters more once Task A lands. Today the update path never runs, so nobody notices that it sets `status: 'scheduled'` unconditionally (:757). After Task A, an out-of-order `AppointmentUpdated` arriving AFTER an `AppointmentCancelled` would silently **resurrect a cancelled appointment** onto the calendar and the Google event. Task B closes that.

### Read before you start

CLAUDE.md, the top 3 entries of PROJECT-LOG.md, features.json entry "Routemize appointment intake", SCHEMA.md for `pec_appointments`, `pec_webhook_ingest_log`, `pec_ops_items`, `settings`, and claude-code-prompt-56-routemize-adapter.md for the fourteen decisions already locked on this endpoint (they all still stand).

---

## Locked decisions (Dylan answered these 2026-08-18; do not re-litigate)

1. **The update path accepts everything Routemize sends**: times, address, assigned rep, notes, projectDetail, title. Routemize is the booking system of record for an appointment's facts.
2. **One guard on that, because of the prompt-65 incident**: `customer_notes` rides every customer-facing appointment text and email. Accept `notes` and `projectDetail` into the internal notes freely; write `customer_notes` only when the incoming `customerAnswers` actually differ from what is stored. A Routemize edit must never be able to push raw question text at a customer.
3. **Cancels: map the numeric codes AND keep honoring the separate `AppointmentCancelled` event.** Belt and braces.
4. **Backfill by replaying the stored payloads** from `pec_webhook_ingest_log` through the fixed mapper. Count first, apply second.
5. **The alarm is an Ops Queue derived check plus a bell row**, not Slack.
6. **A Routemize reschedule does NOT re-fire the customer confirmation text or email.** Routemize notifies the customer itself (the payloads carry `recipients` and `notificationVariables`), so a second message from TopCoat would double-contact. The reminder runner picks up the new time on its own schedule. Say so in the log entry; if Dylan wants a confirmation on reschedule, that is a later prompt.

---

## Part A: read the times correctly

In `mapRoutemizeEnvelope` (pec-appt-intake.cjs ~:344-455):

1. Add a candidate-list reader in the same shape the status reader already uses:
   - start: `newStartTime` → `startTime`. **Never `oldStartTime`.** Those are pre-change values and would rewrite the appointment backwards.
   - end: `newEndTime` → `endTime`. Never `oldEndTime`.
2. Normalize a Routemize datetime to UTC before it reaches `parseApptDate`: if the string has no trailing `Z` and no `+HH:MM` / `-HH:MM` offset, append `Z`. Do this ONLY on the native path (`rz`), in the adapter. **Do not change `parseApptDate` itself** and do not change the bare-datetime convention for the hand-rolled contract, which manual curls and the sync push still rely on.
3. Cross-check, do not trust blindly. Every envelope carries `notificationVariables.AppointmentDate` ("Aug 14, 2026") and `.AppointmentTime` ("9:15 AM"), which are Routemize's own Phoenix wall-clock rendering. After parsing, compare the parsed instant to that pair rendered in `America/Phoenix`. On a mismatch greater than one minute: keep the parsed value, append an internal note naming both readings, and raise the Task D alert. Never silently pick one.
4. Keep the existing defensive branch for a genuinely time-less event. It stops being the normal path; it stays as the floor.

## Part B: status, and never resurrect a cancelled appointment

1. Extend `readRoutemizeStatus` to return the raw value including numerics, and add a mapper backed by a new settings key `routemize_status_map`, default `{"1":"scheduled","2":"scheduled","3":"canceled"}`. Standing rule 12: a new Routemize status code is a Settings edit, not a deploy. Front-of-card: nothing. This belongs behind Advanced on the Appointments settings card.
2. Cancel detection is the union of three signals: the mapped numeric status is `canceled`, OR the status text matches `/cancel/i`, OR `data.reason` matches `/cancel/i`. Any one is enough.
3. In the created/updated write block (~:750-780), `status: 'scheduled'` becomes conditional. If the existing row is already `canceled` and the incoming event maps to scheduled, **do not resurrect it**: leave the status alone, apply the other fields, append an internal note ("Routemize sent a live update for an appointment TopCoat has cancelled"), and raise the Task D alert. An un-cancel is rare enough to want a human; a silent resurrection on the crew calendar is not acceptable.
4. Unknown or unmapped status stays an update, exactly as decision 3 of prompt 56 says, and never a cancellation.

## Part C: the rest of the update payload

Once Part A parses, the existing field block (~:764-771) already applies address, city, state, zip and the resolved rep, because those come from the same envelope. Verify that in the tests rather than assuming it. Then add:

1. `projectDetail` and `notes` (the update-path names) into the internal-notes composition alongside the existing `AppointmentNotes` lookup.
2. `customer_notes` per locked decision 2: compute the incoming customer-routed answers, compare to the stored value, write only on a real difference.
3. A reschedule leaves a trail. When the parsed start differs from the stored `start_at`, write a `lead_events` row of type `note` on the linked lead ("Rescheduled via Routemize: Aug 14, 3:00 PM to Aug 14, 9:15 AM") and one `pec_notifications` row so it reaches the bell. Both best-effort, both non-fatal, matching every other side effect in this handler.
4. `kickPush` already runs on the update branch, so the Google event follows. Confirm it in the test.

## Part D: the alarm (Ops Queue check + bell)

Add a derived Ops Queue check `appt_intake_not_applied` (features.json entry "Admin Ops Queue", index.html ~:22972 onward, storage `pec_ops_items` only, per-check toggle and day threshold in Settings > General under Ops Queue, exactly like the ten existing checks).

Row definition: an `appt-intake` row in `pec_webhook_ingest_log` from the last N days (default 7) whose outcome is not `ok`, or whose message indicates the event landed without being applied (the "no readable start time" family, the Part A cross-check mismatch, and the Part B resurrection block). Each row deep-links to the appointment when one is known and shows the Routemize appointment id when it is not. Derived rows disappear when the data is fixed; dismissals follow the existing `auto` row convention.

Also write ONE `pec_notifications` row (type `appt_intake_stalled`, target_view `ops`) the first time a given ingest-log row qualifies, so it is not only visible to whoever opens the Ops Queue.

## Part E: replay the four missed events

Write a one-shot replay path (a Netlify function guarded by `x-webhook-secret`, or a node script under `production/`, your call, but it must be re-runnable and idempotent).

1. Select `appt-intake` ingest rows whose stored `payload` maps to a Routemize update, ordered oldest first.
2. Re-map each through the fixed mapper.
3. **Dry run first, and print the count and the exact before/after for every row it would touch.** This is the prompt-56 lesson (a derived-beats-stored rule silently rewrote 34 finalized jobs' GP): a count comes before an apply, always. Include in the report whether any touched appointment is linked to an ACCEPTED estimate, because the sold-on-site audit line on an estimate page renders from the appointment's start time and its wording will change (the stamped `sold_on_site` value itself will not: prompt 94 stamps it at accept, it is not re-derived).
4. Apply only rows where the replayed value differs from what is stored. Do not touch `status` during a replay: the cancels in that set already landed correctly through their own events.
5. Expected result on today's data: `01f84b13-99f7-4618-8da8-1ef10f4ba6ec` (Karen Adams) moves from `2026-08-14 22:00:00+00` to `2026-08-14 16:15:00+00`. The other three replay to the value they already hold and change nothing. If your dry run says otherwise, stop and report before applying.

## Part F: tests, docs, ship

1. Fixture tests in `production/` covering, at minimum: bare `newStartTime` parses as UTC (Jay McCoy's real payload, asserting 9:15 AM Phoenix); `Z`-suffixed `newStartTime` parses unchanged (Karen's real payload); `oldStartTime` is never read (a payload with only old fields must take the defensive branch, not move the appointment backwards); numeric `newStatus` 3 cancels; an update against a cancelled row does not resurrect it; an update with an unchanged time is a no-op on `start_at`; `customer_notes` is not rewritten when the answers are identical. Use the four real payloads out of `pec_webhook_ingest_log`, trimmed of nothing.
2. Migration for the new settings keys with the `@artifacts` header (standing rule 13). Additive settings rows only, so direct to prod is fine under rule 14. Regenerate SCHEMA.md if anything else changes.
3. features.json: update "Routemize appointment intake" and "Admin Ops Queue".
4. help/whats-new.json: one user-facing entry. Plain language, no em dashes, something close to "Rescheduling in Routemize now moves the appointment in TopCoat" with two or three how-to lines.
5. Commit per standing rule 1, log per rule 2.

## Acceptance criteria

- A replayed Karen Adams payload moves appointment `01f84b13` to `2026-08-14 16:15:00+00`, and the Google event follows.
- A bare-datetime update payload lands on the same instant as its `notificationVariables` wall-clock, proven by a test that asserts the Phoenix rendering.
- An `AppointmentUpdated` carrying `newStatus: "3"` cancels the appointment with no second event required.
- An `AppointmentUpdated` arriving after a cancellation leaves the row cancelled and raises an Ops Queue row.
- The Ops Queue shows zero `appt_intake_not_applied` rows after the replay (the four historical rows are older than the default 7-day window; confirm rather than assume, and say which it is in the log entry).
- `npm test` green, `node --check` clean on every edited `.cjs`, all inline `index.html` script blocks parse.

## Do not touch

The created path's lead creation, lead-source mapping, dedupe, or stage-advance behavior (prompt 56 decisions 9, 10 and 12). `parseApptDate`'s Phoenix convention. The push direction (`_pec-appt-push.cjs`). The DripJobs push out of Routemize, which stays until Dylan confirms reschedules move.
