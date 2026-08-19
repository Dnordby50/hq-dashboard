# Claude Code prompt 101: TopCoat online booking (replace Routemize)

## Context

Dylan, 2026-08-19: "Routemize has been nothing but issues for us. What we need: ability to create and edit an online form we can put on our website where customers can book onto our calendar similar to Routemize. Use the address so appointments don't overlap, nothing outside our service area. I am dropping the Routemize subscription."

He is cancelling Routemize immediately and taking bookings by phone until this ships, so the online booking channel is DARK from the day he pulls the link until this deploys. Routemize was carrying 5 to 7 bookings a week (`pec_appointments` by week: 7 on 08-03, 6 on 08-10, 2 so far on 08-17). Treat that as the clock on this build: every day this is not live is roughly one self-booked estimate that has to be caught by phone.

What exists and is being replaced: `pec-appt-intake.cjs` receives Routemize's webhook and writes `pec_appointments` rows with `source='routemize'`, creating or matching a lead and customer, advancing the pipeline stage, pausing nurture, kicking the Google push and the customer confirmation. **That write path is not the problem and is not being rewritten.** What Routemize owned and TopCoat has never had is the FRONT of it: a public form, a slot list, a service-area gate, and a self-serve reschedule link. This prompt builds that front end and lands it on the same write path.

What already exists that this build leans on, so do not rebuild any of it:

- `pec_appointments` (see SCHEMA.md), including `source` (check: topcoat / google / routemize), `location_*`, `customer_notes` (customer-facing, rides the confirmation and reminder messages) and `notes` (internal, pushed to the Google event).
- `_pec-appt.cjs`: `apptBookingLeadEffects` (stage advance, drip pause, lead event), `apptCancelLeadEffects` (the cancel walk-back), `runApptReminders`.
- `_pec-appt-push.cjs`: `pushApptById` (Google Calendar create/update/delete, and the prompt-96 imported-event branch).
- `_pec-lead-match.cjs`: `resolveOrCreateCustomer`, `findRecentLiveLead`, `sameHumanOr` (the same-human rule shared by both intakes; use it, do not write a third matcher).
- `_pec-supabase.cjs`: `sb`, `json`, `randomToken`, `tokenFromEvent`, `logIngest`, `writeHeartbeat`.
- The public-page pattern in `pec-public-estimate.cjs` (`htmlResponse`, `loadBrand`, the token-in-path redirect in netlify.toml at `/e/*` and `/pay/*`).
- **Prompt 96's Google import.** Every event on Dylan's ticked Google calendars now lands in `pec_appointments` as `source='google'`. That is the reason the availability engine can be honest: his real busy time is already in one table. 695 rows landed the week of 08-17, so the engine must be efficient about how it reads them.

### Read before you start

CLAUDE.md, the top 3 entries of PROJECT-LOG.md, features.json entries "Appointments calendar", "Routemize appointment intake", "Google Calendar two-way sync", "Instant lead touch and new-lead alerts", "Address autocomplete (HQ)". SCHEMA.md for `pec_appointments`, `pec_sales_team_members`, `leads`, `customers`, `settings`, `pec_notifications`, `pec_webhook_ingest_log`. Files: `netlify/functions/pec-appt-intake.cjs` (the write path you are mirroring, especially `processApptIntake` at :716 and `createRoutemizeLead` at :609), `_pec-appt.cjs`, `_pec-appt-push.cjs`, `_pec-lead-match.cjs`, `pec-lead-intake.cjs`, `pec-public-estimate.cjs`.

---

## Locked decisions (Dylan answered these 2026-08-19)

1. **Availability comes from the real calendar**, not a fixed grid: working hours minus everything already in `pec_appointments` for that rep, including `source='google'` imported events.
2. **Service area is a zip / city allowlist** Dylan maintains. No radius math, no geofence.
3. **Assignment is round robin across active reps.** The roster has exactly one active member today (Dylan; Aron is `active=false` since 2026-08-12), so build the rule so it degrades to "the only active rep" without a special case and starts distributing the day a second rep is added.
4. **60 minute appointments, with a buffer that varies by drive time**, measured live with the Google Routes API (Part C sets hard cost and failure guardrails; the buffer must degrade to a flat default when the API is unavailable, over budget, or slow).
5. **Same-day booking is allowed, 30 day horizon.** Cowork's addition, stated so it is not silently dropped: minimum notice ships as a setting defaulting to **120 minutes**, which still permits same-day. Zero-notice booking means a customer can put an appointment on Dylan's calendar for 40 minutes from now while he is on a roof. He can set it to 0 in Settings once he trusts the bell.
6. **Out of area captures a lead, it does not show slots.** Name, phone, address, project description, an honest "we will call you about scheduling" message, and a lead in TopCoat tagged out-of-area. Never a booked appointment outside the area.
7. **PEC only** for now. Build with a `brand` column and a per-form service area so FTP is a row, not a refactor, but ship one PEC form.
8. **The form is editable without a deploy**: questions can be added, reordered, removed, marked required, and each answer routed to the customer-facing notes or the internal rep notes, exactly like `routemize_answer_routing` does today. This prompt ships the storage, the seeded question set, and a JSON editor behind Advanced. Prompt 102 ships the visual builder.
9. **A hosted page plus an iframe embed.** One booking page TopCoat serves, linkable directly (texts, Google Business Profile, ads) and embeddable in one line on the website.
10. **Customers can reschedule and cancel themselves** from a private link in the confirmation, honoring the same slot rules.

---

## Part A: schema

One migration, `@artifacts` header per rule 13. None of this touches money, auth, or `estimates.status`, so direct to prod under rule 14, EXCEPT the `pec_appointments.source` check change in A1: that constraint is on a live table with real rows, so verify the existing constraint definition against the live schema first and write the drop/recreate explicitly rather than assuming its name.

1. `pec_appointments`: extend the `source` check to allow `'booking'`. Add `booking_manage_token text` (unique where not null, minted by `randomToken()`) and `booking_request_id uuid`.
2. `pec_booking_forms`: `id`, `slug` (unique, seed `pec`), `brand` (default `PEC`), `name`, `active`, `headline`, `intro_text`, `success_message`, `appt_types jsonb` (which appointment types the form offers and each one's duration, seeded to one entry: `on_site_estimate`, 60 minutes), `questions jsonb` (the editable question set, see A5), timestamps.
3. `pec_booking_service_areas`: `id`, `form_id`, `zip`, `city`, `active`, `note`, timestamps. Unique on `(form_id, zip)`. Seed from the real service area (Cowork handoff below supplies the zip list; do NOT invent zips, and do not ship the form active with an empty allowlist, which would put every visitor on the out-of-area path).
4. `pec_booking_requests`: every submission attempt, including the ones that never became an appointment. `id`, `form_id`, `status` (`booked` / `out_of_area` / `rejected` / `error`), name, phone, email, `address_*` fields, `place_id`, `in_area bool`, `requested_start timestamptz`, `appointment_id`, `lead_id`, `customer_id`, `answers jsonb`, `sms_consent bool`, `sms_consent_disclosure text`, `ip_hash`, `user_agent`, `error_text`, `created_at`. This table is the audit trail that answers "are we losing bookings?", which is the exact question nobody could answer about Routemize. It is also the rate-limit source in Part F.
5. `pec_drive_time_cache`: `id`, `origin_key`, `dest_key` (normalized address or place_id, hashed or lowercased consistently), `minutes numeric`, `meters numeric`, `fetched_at`. Unique on `(origin_key, dest_key)`. TTL from settings.
6. RLS: the public endpoint runs service-role, so these tables get RLS ON. Staff read of `pec_booking_requests` and the Settings editors need policies matching how other staff-read tables are handled in this repo; copy the posture of an existing staff-readable table rather than inventing one, and never expose `pec_booking_requests.ip_hash` to the browser.
7. Regenerate SCHEMA.md.

Seeded question set (`questions`), each entry `{id, label, type, required, routing}` where `type` is one of `short_text | long_text | choice | yes_no` and `routing` is `customer | internal | drop`, mirroring `routemize_answer_routing`'s three values:

- What are we quoting? (choice: garage floor, patio, driveway, shop or commercial, other) → internal
- Roughly how many square feet? (short_text, required) → internal
- Tell us about the project (long_text) → customer
- How did you hear about us? (choice, feeding `lead_source`) → drop from notes, mapped to the lead's source
- SMS consent checkbox, see Part E4. Not a `questions` entry; it is a structural field.

## Part B: the availability engine

Build it as a **pure module**, `production/booking-availability.cjs`, with no network and no database inside it, so it is testable: inputs in, slots out. The endpoint does the loading.

`computeSlots({ now, reps, busy, workingHours, config, driveTimes })` returns `[{ start, end, sales_member_id }]`.

Rules:

1. **Window**: from `now + min_notice_minutes`, through `now + horizon_days`, clamped to working hours per weekday per rep (settings, default Mon-Fri 08:00-17:00 Phoenix, Sat/Sun closed). Arizona does not observe DST, but store and compare in UTC anyway and render Phoenix.
2. **Grid**: slot starts every `slot_granularity_minutes` (default 30). Duration comes from the form's `appt_types` entry (default 60).
3. **Busy**: any `pec_appointments` row for that rep with `status='scheduled'` and `start_at`/`end_at` overlapping the window, **whatever the source**, blocks. `all_day=true` rows block the whole working day for that rep. Exclude `status='canceled'` and the row being rescheduled (Part E5 reuses this engine).
4. **Buffer**: a candidate slot must clear the preceding busy block by `bufferBefore` and the following one by `bufferAfter`, where each buffer is `clamp(driveMinutes, buffer_min_minutes (default 20), buffer_max_minutes (default 90))`. `driveMinutes` comes from `driveTimes` keyed by the neighbor's address; when the key is missing (no address on a Google-imported block, API unavailable, budget spent), fall back to `buffer_default_minutes` (default 30). The first and last appointment of a rep's day measure against `booking_home_base_address` (setting).
5. **Round robin**: for each start time, offer it if ANY booking-enabled rep is free. Assignment picks the free rep with the fewest `source='booking'` appointments in the horizon, tie-broken by the earliest `start_at` of their next appointment (keeps a day from clumping). One active rep: it returns that rep, no branch.
6. **Never emit a slot the write path would reject.** The engine and the Part D re-check must call the same function, or this build ships double-bookings.

Tests, `production/booking-availability.test.cjs`: buffer math with a long drive on one side and a short one on the other; all-day event blocks the day; min-notice boundary (a slot exactly at the boundary is offered, one minute inside is not); horizon boundary; a canceled appointment does not block; a `source='google'` focus block DOES block; round robin over two reps distributes; round robin over one rep returns that rep; empty calendar returns a full day of slots; a rep with no working hours for that weekday returns none.

## Part C: drive time, with a leash

The Routes API is the one part of this build with a per-request dollar cost and an external failure mode, and it sits on a public page. It gets a leash.

1. **One batch call per booking session, not one per slot.** The customer's address is fixed once they enter it. Collect the DISTINCT addresses of the neighbor appointments across the whole 30-day window (typically under 20), plus the home base, and issue a single `computeRouteMatrix` call (origins = those addresses, destination = the customer address) . Cache each pair in `pec_drive_time_cache` and read the cache first (TTL setting, default 30 days).
2. **Budget**: `booking_routes_max_origins_per_request` (default 25) and a hard timeout (`booking_routes_timeout_ms`, default 4000). Over budget, over time, missing key, or any non-200: log it, use `buffer_default_minutes` for every unresolved pair, and still return slots. **The slot list must never fail because Google did.**
3. Key: `GOOGLE_ROUTES_API_KEY` in Netlify env, server-side only. This is NOT the referrer-restricted `PEC_MAPS_KEY` in index.html; a referrer-restricted browser key does not authenticate a server call. Placeholder plus a handoff per standing rule 7. Everything no-ops to the flat buffer while unset, so the build ships and works before the key exists.
4. Isolate the whole thing behind one function (`driveMinutesFor(origins, dest)`) so swapping providers later is one file.

## Part D: the public booking page and the write path

New function `netlify/functions/pec-booking.cjs`. netlify.toml redirects: `/book` and `/book/*` to it, plus `/api/booking/*` for the JSON actions, following the existing `/e/*` and `/pay/*` shapes.

1. **GET `/book`** renders the form server-side, same `htmlResponse` + `loadBrand` pattern as `pec-public-estimate.cjs`: brand logo, colors, phone. `?embed=1` renders chrome-free for the iframe and posts its height to the parent (`postMessage`), and Settings shows the exact one-line snippet to paste. Mobile first: most of these bookings arrive on a phone.
2. **Step 1 is the address**, before any slot is shown. Google Places autocomplete (the same `PEC_MAPS_KEY` and the current `AutocompleteSuggestion` / `Place.fetchFields` surface already ported in index.html; typing a raw address without picking a suggestion must still work). On selection, resolve zip and city and check `pec_booking_service_areas`: zip match first, then case-insensitive city, else out of area.
3. **Out of area** (locked decision 6): no slots. Show the honest message, collect name, phone, email and the project description, write a `pec_booking_requests` row with `status='out_of_area'`, create the lead through the same `resolveOrCreateCustomer` + `findRecentLiveLead` path the other intakes use, with `lead_source` from the form's how-did-you-hear answer (else `topcoat_booking`), a `lead_events` note naming the address and why it was out of area, and a bell. Dylan gets the contact and the demand data.
4. **In area**: `POST /api/booking/slots` returns the next N days of open slots (grouped by day, Phoenix-rendered) via Part B. Show a compact day-then-time picker, not a wall of 400 buttons.
5. **POST /api/booking/book** is the only write. In order: validate the payload; re-check service area server-side (never trust the client's verdict); load busy fresh; **re-run `computeSlots` and confirm the requested start is still offered**; then write.
6. **Concurrency.** Two visitors can hold the same slot list. The insert must happen inside a Postgres function (`book_appointment_slot`, SECURITY DEFINER) that takes `pg_advisory_xact_lock` on a hash of (rep, local date), re-checks for an overlapping `status='scheduled'` row for that rep including buffer, and inserts only if clear, returning a distinct result the endpoint can turn into "that time was just taken, here are the next open ones" instead of a 500. Do not rely on an application-level check alone, and do not add a table-wide exclusion constraint: `source='google'` imports legitimately overlap each other and would fail it.
7. **After the insert**, reuse the existing path rather than reimplementing it. Read `processApptIntake` in `pec-appt-intake.cjs` and mirror it exactly: customer resolve-or-create, lead resolve-or-create (never nurture-enroll a booker whose effects would immediately pause it), title derived as `{Type label} for {Name}` by the same rule so the calendar, Google event and modal agree, `answers` routed into `customer_notes` / `notes` by the question routing, `apptBookingLeadEffects`, the booking bell, `pushApptById`, and the on-book customer confirmation kicked **the same way the intake kicks it** (verify that mechanism in code before writing it; do not invent a second confirmation path). Log every attempt to `pec_webhook_ingest_log` with endpoint `booking` so it appears in Sync Health next to the Routemize rows.
8. The confirmation message carries the manage link (Part E5). `pec-appt-reminder-runner` then handles the offset reminders with no change, because the row is an ordinary appointment.

## Part E: the pieces around it

1. **Settings > Appointments gains an "Online booking" card** (rule 12, at most two front-of-card): front, the **Booking enabled** toggle and the **booking link + copy-embed** control. Behind Advanced: working hours per weekday, `slot_granularity_minutes`, min notice (default 120), horizon days (30), the three buffer numbers, drive-time on/off and its budget and TTL, `booking_home_base_address`, the service-area zip/city editor, the question-set JSON editor, the rate limit, and the confirmation copy. State and caches are not settings: `pec_drive_time_cache` and `pec_booking_requests` get no controls.
2. **`routemize_booking_url` is now the TopCoat booking URL.** That setting feeds the `{booking_link}` token in the day-0 instant touch and the drip steps (`pec_drip_steps` step 0, `_pec-drip.cjs`). Repoint it in the migration, and rename the key to `booking_url` with a one-line back-compat read if any code reads the old name. Missing this means every drip message keeps sending customers to a cancelled Routemize.
3. **Out-of-area and stalled-booking visibility**: one new Ops Queue derived check, `booking_out_of_area` (out-of-area requests in the last `ops_booking_days`, default 7, with no lead contact since), following the check-11 conventions from prompt 95 including self-clear and Dismiss. Plus `writeHeartbeat` on the endpoint so the system-heartbeat surface knows booking is alive.
4. **SMS consent, finally.** features.json currently carries this note on the instant-touch feature: "sms_consent is false on nearly every lead because the WEB FORM does not capture consent; until the form ships a TCPA checkbox mapped into sms_consent, the instant touch and all drips are email-only in practice." This form is that web form. Ship the checkbox with real disclosure text (settings-editable, defaulting to standard TCPA wording naming PEC, message frequency, rates, STOP to opt out), store the exact disclosure shown on the lead event and on `pec_booking_requests`, and map it to `leads.sms_consent` through `parseSmsConsent`. Unchecked is a valid booking, it just stays email-only. Update that features.json note when it ships.
5. **Manage link.** `/book/manage/<booking_manage_token>` renders the appointment (date, time, address, rep) with Reschedule and Cancel. Reschedule re-runs Part B excluding the row's own block, writes through the same locked function, keeps the same appointment id, writes a `lead_events` note and an `appointment_rescheduled` bell in the shape prompt 95 established, and kicks `pushApptById`. Cancel sets `status='canceled'` (never a hard delete), runs `apptCancelLeadEffects`, and pushes so the Google event disappears. The token stops working after the appointment ends. Both actions send the customer a confirmation on the channel their consent allows.

## Part F: abuse control

Honeypot field plus a minimum fill time (a bot submits in under 2 seconds), a per-`ip_hash` limit read from `pec_booking_requests` (default 5 bookings per hour, setting), and a duplicate guard: the same phone booking the same appointment type within 24 hours returns the existing appointment and its manage link rather than creating a second one. No CAPTCHA. Rejected attempts still write a `pec_booking_requests` row with `status='rejected'` so a real customer being blocked is visible instead of invisible.

## Part G: cutover and docs

1. features.json: a new "Online booking" entry, and amend the Routemize entry to say the intake is retained for historical rows and inbound stragglers while the subscription winds down.
2. One What's New entry, plain language, no em dashes: "Customers can book online through TopCoat", with the steps to find the link and the embed snippet in Settings.
3. Tests: the Part B suite, plus fixture tests for the service-area matcher, the question routing (an internal-routed answer never reaches `customer_notes`), consent parsing, the duplicate guard, and a simulated concurrent double-book proving the second caller gets the taken-slot response and not a second row.
4. **Leave `pec-appt-intake.cjs` running.** Routemize may keep firing until the subscription lapses, and a stray booking landing in TopCoat is better than one landing nowhere. Add a `routemize_intake_enabled` setting (default true) so Dylan can switch it off without a deploy once the account is closed.
5. Commit and log per standing rules.

## Acceptance criteria

- A real address inside the allowlist shows real open slots that match Dylan's actual Google calendar for that week, and an address outside it shows no slots and creates a tagged lead.
- Booking creates ONE `pec_appointments` row with `source='booking'`, a linked customer and lead, the stage advanced, nurture paused, the Google event present on the TopCoat calendar, the customer confirmation sent, and a `pec_booking_requests` row with `status='booked'`.
- Two simultaneous bookings of the same slot produce one appointment and one honest "just taken" message. Prove it with a test, not by reasoning.
- With `GOOGLE_ROUTES_API_KEY` unset, the whole flow still works on the flat buffer. With it set, a slot next to a 40-minute-away appointment is spaced further than one next to a job across town.
- The manage link reschedules and cancels, and both changes reach Google.
- A booking with the consent box ticked produces a lead with `sms_consent = true` and a stored disclosure. **Report the count of consent-true leads in the log entry after the first week.**
- Report in the log entry: the number of slots the engine offers for a typical week, and how many Routes API calls one booking session actually made.

## Do not touch

`processApptIntake`'s existing Routemize behavior (mirror it, do not refactor it out from under a path that is working), `_pec-appt-push.cjs`'s imported-event branch from prompt 96, the reminder runner's rules, `estimates.status`, or anything in the money tables. If the booking write path needs a change inside `_pec-appt.cjs`, add a parameter with a default rather than changing existing callers' behavior.
