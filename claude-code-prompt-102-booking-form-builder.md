# Claude Code prompt 102: the booking form builder, booking funnel, and the second brand

## Context

Prompt 101 shipped TopCoat's online booking: a public page at `/book`, a real availability engine, a zip/city service area, drive-time buffers, round robin assignment, a self-serve manage link, and a question set stored as JSON on `pec_booking_forms.questions` and edited as raw JSON behind Advanced in Settings > Appointments.

Dylan's ask was "the ability to create and edit an online form." A JSON textarea is storage, not that ability. This prompt is the editing half. Run it only after prompt 101 is live and has taken at least a few real bookings, so the builder is edited against a form that is known to work.

### Read before you start

CLAUDE.md, the top 3 entries of PROJECT-LOG.md, the prompt 101 log entry, features.json entry "Online booking", SCHEMA.md for `pec_booking_forms`, `pec_booking_service_areas`, `pec_booking_requests`, `pec_appointments`. Files: `netlify/functions/pec-booking.cjs`, `production/booking-availability.cjs`, the Settings > Appointments render in index.html.

---

## Part A: the builder

A Settings screen that edits `pec_booking_forms` rows without touching JSON by hand.

1. **Question list** with drag-to-reorder, add, duplicate, delete. Each question: label, type (`short_text`, `long_text`, `choice`, `yes_no`), required toggle, help text, and for `choice` an option list that is itself reorderable.
2. **Routing per question**, the control that matters most: customer-facing notes, internal rep notes, or drop. Explain it inline in one sentence, because a wrong routing sends an internal answer into a customer's confirmation text. Same three values as prompt 101 and `routemize_answer_routing`, so the two intakes stay aligned.
3. **Form-level fields**: name, headline, intro text, success message, active toggle, which appointment types the form offers and each one's duration.
4. **Service area editor** on the same screen: the zip and city list from `pec_booking_service_areas`, add/remove/deactivate, with a paste-a-list bulk add. An active form with zero active rows is a configuration error, not a valid state: block save and say why.
5. **Live preview** of the public form beside the editor, rendered from the same code path the public page uses so preview and reality cannot drift. If that means extracting the form renderer into a shared module, extract it.
6. **Validation on save**: unique question ids, no empty labels, `choice` questions have at least two options, required questions are answerable (a required question routed to `drop` is legal but pointless, warn), and the seeded structural fields (name, phone, address, consent) cannot be deleted.
7. Every save writes the whole `questions` array with an optimistic-concurrency guard on `updated_at`, so two tabs cannot silently overwrite each other. The prompt-79 `updated_at` convention already exists in Settings; follow it.

## Part B: the booking funnel

`pec_booking_requests` has been recording every attempt since prompt 101, including the ones that never became appointments. Surface it, because the whole point of owning this is being able to answer questions Routemize could not.

One card in Metrics (Sales section), windowed by the existing metrics window control: attempts, booked, out of area, rejected (rate limit, honeypot, duplicate), and errors, each drillable to the underlying rows. Out-of-area rows list by city so Dylan can see where demand is showing up outside the allowlist, which is the input to expanding it. No new tables; this is a read.

## Part C: the second brand

FTP gets its own form: a second `pec_booking_forms` row, its own slug (`/book/ftp`), its own service area rows, its own questions and appointment types, its own brand chrome from `pec_brand_identity`. If prompt 101 was built as instructed, this is configuration plus routing the slug, not new engine code. If anything in the engine turns out to be hardcoded to PEC, fix that rather than branching on brand.

Confirm with Dylan before shipping this part that FTP actually wants online booking, since he scoped prompt 101 to PEC only and may not want painting estimates self-booking onto the same calendar.

## Acceptance criteria

- Dylan can add a question, reorder it, route it to internal notes, save, and see it on the live form without a deploy, and the answer lands in `notes` and never in `customer_notes`.
- Deleting a structural field is impossible; saving an active form with an empty service area is blocked with a clear reason.
- The preview matches the live page exactly (same renderer).
- The funnel card's booked count reconciles with `pec_appointments where source='booking'` for the same window. If it does not, that is a real bug in prompt 101's write path, not a display issue; chase it.
- Two tabs editing the same form do not silently clobber each other.

## Do not touch

The availability engine's math, the locked booking function, or the write path. This prompt is editing and reporting only. Any engine change discovered as necessary gets its own log entry explaining why.
