# Claude Code prompt 105: online booking rep eligibility + primary rep

Prompt number: 105 (highest existing was 104 in PROJECT-LOG.md; root files stop at 103). Built 2026-09-21 by Claude Code.

Follow the normal startup procedure (CLAUDE.md, last 3 PROJECT-LOG entries). Use features.json to locate the booking engine, the slots endpoint, the booking write path, Settings > People, and Settings > Booking. Verify every table and column against SCHEMA.md before writing SQL.

## Why this exists (verified against live prod 2026-09-21)

- Dusty Wilson was added to `pec_sales_team_members` on 2026-09-15 (id `cb99d703-2a96-469e-bbbd-e552161bc686`) with `active = true`, `google_connected = false`.
- The booking engine treats every `active` roster row as bookable. Dusty has zero appointments and no Google calendar, so she reads as free all day.
- Result: on 2026-09-17 a customer self-booked 10:00 AM (appointment `fe972743-d22a-474f-bfd7-a544784ab54d`) even though Dylan already had a site visit at 10:15 (`48d2807d-24a1-4ee2-aeac-0d84b087b976`, created the day before). The slot only existed because of Dusty. Dylan reassigned it by hand.
- Right now every working-hours slot in the 30 day horizon is bookable regardless of Dylan's calendar. This is the bug. Treat it as urgent.
- Business rule: Dusty only handles offsite quotes that call in. Dylan does 100% of on-site estimates.
- Root cause in the model: roster `active` is doing three jobs (selectable as salesperson, commission, online booking eligibility). This build splits booking eligibility out. Do NOT fix this by setting Dusty `active = false`; she must stay selectable as a salesperson.

## Locked decisions (Cowork defaults, Dylan did not override)

1. Booking eligibility is a per-person flag, edited in Settings > People, summarized read-only in Settings > Booking.
2. There is a primary rep setting. Default is Dylan (`2add1f35-c46f-4931-8220-e5ba14939e3f`).
3. Assignment mode is a setting with three values: `primary_first` (default), `primary_only`, `round_robin`. With one eligible rep all three behave the same, which is today's reality.
4. A rep with no connected Google Calendar cannot be bookable unless a setting explicitly allows it. Default is block.
5. If zero reps are eligible, the public page shows NO slots and captures the lead (same path as out-of-area). Fail closed, never fall back to "all active reps".
6. One on/off flag per rep. No per-appointment-type eligibility in this build.
7. Internally created on-site estimates default their rep to the primary rep, editable.
8. Every change of `pec_appointments.sales_member_id` is logged.

Out of scope, do not build: per-rep working hours, daily booking caps, blackout dates, a phone-quote booking type, cleanup of far-future Google recurring rows.

## Build

### 1. Migration
- `pec_sales_team_members`: add `bookable_online boolean not null default false`.
- Data step in the same migration: set `bookable_online = true` for Dylan only, matched by id `2add1f35-c46f-4931-8220-e5ba14939e3f`. Everyone else stays false. New roster rows default to false forever; being bookable is always an explicit choice.
- `settings` rows (match the existing `booking_*` key/value pattern):
  - `booking_primary_member_id` = Dylan's id
  - `booking_assignment_mode` = `primary_first`
  - `booking_require_google_connected` = `true`
- New table `pec_appointment_assignment_log`: `id uuid pk`, `appointment_id uuid` (FK to pec_appointments, on delete cascade), `from_member_id uuid null`, `to_member_id uuid null`, `changed_by uuid null`, `changed_by_label text null`, `reason text null`, `created_at timestamptz default now()`. RLS consistent with `pec_appointments`.
- Populate the log with an AFTER INSERT OR UPDATE OF `sales_member_id` trigger on `pec_appointments` so every write path is covered (booking, intake, UI, Google sync). `changed_by` from `auth.uid()` when present. The booking write path should set reason `online_booking:<mode>`.
- Update SCHEMA.md and features.json.

### 2. Engine
- One shared helper returns the eligible rep list: `active = true AND bookable_online = true AND (google_connected = true OR booking_require_google_connected is false)`. The slots endpoint and the booking insert must BOTH use it. No second copy of the rule.
- Slot generation by mode:
  - `primary_only`: slots come from the primary rep's calendar only.
  - `primary_first`: a slot is offered if any eligible rep is free; on insert assign the primary if free at that time, else the next eligible rep.
  - `round_robin`: existing behavior, restricted to the eligible list.
- If the primary id is missing, inactive, or not eligible, fall back to the eligible list in `round_robin` order and surface a warning in Settings > Booking. If the eligible list is empty, fail closed per decision 5.
- The advisory-lock insert must re-check the ASSIGNED rep's availability inside the lock, not just "some rep is free".
- Customer self-serve reschedule must use the same eligible list.

### 3. Settings UI (no code edit needed to tune any of this)
- Settings > People: "Takes online bookings" toggle per person. If Google is not connected and the require setting is on, the toggle is disabled with the reason shown.
- Settings > Booking: primary rep dropdown (eligible reps only), assignment mode selector with one-line plain-English descriptions, "Require connected Google Calendar" toggle, and a read-only line: "Currently bookable online: <names>". Show a red warning when that list is empty.
- No em dashes in any of this copy.

### 4. Internal default
- When an on-site estimate appointment is created inside TopCoat and no rep is chosen, prefill the rep with `booking_primary_member_id`. Editable. Example of the gap: appointment `e2e4124c-0e02-4400-b6fb-c903fee474fb` was saved with `sales_member_id` null. Do not backfill old rows.

## Acceptance (prove by side effects, not by the endpoint answering)

1. With Dusty `active = true, bookable_online = false`: call the slots endpoint for a day where Dylan has a scheduled block. No slot overlapping that block (plus buffer) is returned. Before this build the same call returns one; capture before and after.
2. Temporarily set Dylan `bookable_online = false` on a branch or in a transaction: slots endpoint returns zero slots and a test submission lands as a lead with no appointment. Restore.
3. A test booking produces a `pec_appointment_assignment_log` row with reason `online_booking:primary_first`. Reassigning it in the UI produces a second row.
4. Toggling the People switch changes slot output with no deploy.
5. Query: `select name, active, bookable_online, google_connected from pec_sales_team_members;` shows only Dylan bookable.
6. Delete any test appointments, leads, and booking requests you created, and say so in the log.

## Wrap up
- PROJECT-LOG.md entry at the top, By: Claude Code. Include the before/after slot evidence from acceptance 1.
- Stage specific files by name, commit. Dylan has authorized auto-commit for this task. Do not push without asking.
- If anything in the live code contradicts the "Why this exists" section (for example the engine already filters reps some other way), stop and report before building.
