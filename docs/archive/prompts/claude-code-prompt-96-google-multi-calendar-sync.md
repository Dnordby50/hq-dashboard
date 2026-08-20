# Claude Code prompt 96: sync Dylan's other Google calendars into TopCoat (per-calendar toggles, two-way with guardrails)

## Context

Dylan, 2026-08-18: "All events from my Google Calendar push to TopCoat."

What exists today is narrower than he thinks. At connect time, `_pec-google.cjs` (~:198-211) creates a dedicated **"TopCoat"** secondary calendar on the rep's Google account and stores its id on `pec_sales_team_members.google_calendar_id`. `pec-google-calendar-pull.cjs` polls **only that one calendar** per member, with one sync token per member (`pec_sales_member_google_tokens.sync_token`). Dylan's connected row points at `c4b6b7e401daf841e2323059add8b3d0f19e67b82172893b53a5c36091b50454@group.calendar.google.com`. Nothing on his own calendars is visible to TopCoat.

His account carries eleven calendars (verified live 2026-08-18): `dnordby50@gmail.com` (primary), Planning and Admin, Sales, Meetings, Personal, Family, Todoist, `dylan@finishingtouchpaintingaz.com`, Green Bay Packers, Holidays in United States, and TopCoat. His primary is mostly recurring focus blocks and internal meetings (a "Doug GSR" weekly, a "Focus: Top-Client Relationships and Follow-Up" daily block), not customer appointments. Routemize does **not** write to his primary, so there is no duplicate-booking risk from that direction.

Two of those calendars (Packers, Holidays) are subscriptions he cannot write to, and Family is a shared calendar. That is why Part C exists.

### Read before you start

CLAUDE.md, the top 3 entries of PROJECT-LOG.md, features.json entries "Appointments calendar" and whatever entry covers the Google two-way sync, SCHEMA.md for `pec_appointments`, `pec_sales_team_members`, `pec_sales_member_google_tokens`, `settings`. The files: `netlify/functions/pec-google-calendar-pull.cjs`, `_pec-appt-push.cjs`, `_pec-google.cjs`, `pec-google-oauth-callback.cjs`, and the Settings > Appointments render in index.html.

---

## Locked decisions (Dylan answered these 2026-08-18)

1. **Per-calendar toggles in Settings.** TopCoat lists every calendar on the connected account and the rep ticks which ones sync. Not a hardcoded list.
2. **Imported events carry full detail and are visible to all staff**, same as any other appointment. No privacy masking.
3. **Two-way**, same as the existing TopCoat calendar, subject to the Part C guardrails.
4. **The dedicated TopCoat calendar stays exactly as it is** as the push target for TopCoat-created appointments. Nothing currently working changes.
5. Cowork's addition, stated as a decision so it is not silently skipped: **imported events never trigger customer-facing automation.** No confirmation text, no reminder, no drip effect, no lead stage advance, no sold-on-site matching. An imported event is a time block, not a booking.

---

## Part A: schema and settings

1. New table `pec_sales_member_google_calendars`: `id`, `member_id` (FK to `pec_sales_team_members`), `calendar_id`, `summary`, `access_role` (Google's `accessRole` at last list), `sync_enabled` (bool, default false), `sync_token`, `last_synced_at`, `last_error`, timestamps. Unique on `(member_id, calendar_id)`. RLS: same posture as the rest of the sales-member tables; the sync token is service-role territory, so if in doubt copy the `pec_sales_member_google_tokens` posture (RLS on, no policies) and expose the toggle through a view or an RPC rather than widening it.
2. Seed one row per member for the existing `google_calendar_id` with `sync_enabled = true`, so the current behavior survives the migration untouched.
3. Settings keys (rule 12), on the Appointments card, **at most two front-of-card**: `google_pull_window_days_past` (default 30) and `google_pull_window_days_future` (default 180) front; behind Advanced: `google_pull_max_pages_per_calendar` (default 6), `google_imported_default_appt_type` (default `other`), `google_pull_include_all_day` (default true), `google_pull_include_declined` (default false).
4. Migration carries the `@artifacts` header (rule 13). Additive tables and settings rows, no money, auth or estimates.status, so direct to prod under rule 14.

## Part B: the pull, over N calendars

1. `pullMember` becomes a loop over that member's `sync_enabled` calendars, each with **its own sync token**. One calendar's 410 or error must not poison the others. Per-calendar page cap from settings, per-calendar `last_error` written so Settings can show it.
2. **Bound the window.** The current call passes `singleEvents: 'true'` with no `timeMin` / `timeMax`, which is fine for a calendar TopCoat created weeks ago and is not fine for a personal calendar with years of history and daily recurring blocks: a first full sync would expand thousands of instances. Pass `timeMin` = now minus `google_pull_window_days_past` and `timeMax` = now plus `google_pull_window_days_future`. Note in a comment that a bounded window and a sync token do not compose the way an unbounded one does; re-assert the window on every full resync.
3. Skip the member's own TopCoat calendar in this loop, whether or not somebody ticks it. That calendar is the push target and pulling it would round-trip TopCoat's own writes.
4. Mapping: reuse `mapEventToRow`. `source` stays `'google'`. `appt_type` from the private extended property when it is one of ours, else `google_imported_default_appt_type`. Persist `google_calendar_id` on the row (the column already exists) so the push knows where the event lives.
5. Skip events the settings say to skip: all-day when disabled, events the rep has declined when disabled, and `eventType` values that are not real time commitments (`birthday`, `workingLocation`) always. `outOfOffice` and `focusTime` DO import; they are real blocks on his day.
6. Recurring events: keep `singleEvents: true`, so instances arrive expanded and each gets its own row keyed by the instance id. Store `recurringEventId` when present (new nullable column) because Part C needs it.
7. The existing echo rule (`shouldSkipEcho` on `google_updated`) is unchanged and now matters more, since two-way writes on more calendars mean more echoes.

## Part C: two-way, with the three guardrails

TopCoat may write back to Google for an imported event ONLY when all three hold:

1. **Access:** the calendar's `accessRole` is `owner` or `writer`. Packers and Holidays are `reader` and a write would throw.
2. **Ownership:** the rep is the event's organizer (`organizer.self === true`). TopCoat must never edit an event someone else owns and Dylan was merely invited to.
3. **Instance, not series:** a dragged or resized recurring instance patches that instance id only, never the series. If Google rejects the instance patch, fall back to read-only rather than escalating to the series.

When any guardrail fails, the appointment renders read-only in the Appointments view with a short note ("This event lives in Google and TopCoat cannot edit it"), and drag, resize, edit and cancel are disabled for it. Write the reason on the row so the UI does not have to re-derive it.

## Part D: the UI

1. **Settings > Appointments** gains a per-rep calendar list: pull `calendarList` at render (or on a Refresh button, cached on the table), show each calendar's name, its access role, a sync toggle, last sync time, and any last error. The TopCoat calendar row shows as the push target and is not toggleable.
2. **Appointments view**: imported events are visually distinguishable (a chip or the calendar's Google color), the existing type and salesperson filters keep working, and a new filter lets you hide imported events in one click. Do not let a wall of focus blocks bury the actual estimates.
3. The appointment modal for an imported event shows which Google calendar it came from and, when read-only, why.

## Part E: the automation guard

Audit every place an appointment triggers something and confirm `source = 'google'` rows are excluded: `pec-appt-notify`, `pec-appt-reminder-runner`, `apptBookingLeadEffects` / `apptCancelLeadEffects`, the lead stage advance to `estimate_scheduled`, `production/sold-on-site.cjs` matching, and the bell. Some of these are already keyed on lead linkage and will exclude naturally; prove it with a test rather than reasoning about it. This is the single highest-consequence part of this prompt: a "Focus: Top-Client Relationships" block that texts a customer is a bug Dylan will hear about from a customer, not from a log.

## Part F: docs and ship

features.json (the appointments and Google sync entries), SCHEMA.md regenerated, one What's New entry in plain language ("See your whole Google calendar in TopCoat", how to turn calendars on in Settings), tests for the mapper, the guardrail predicate, the window math, and the automation exclusions. Commit and log per standing rules.

## Acceptance criteria

- Ticking `dnordby50@gmail.com` in Settings imports his events within one 15-minute tick, with the recurring focus blocks expanded as instances inside the window and nothing outside it.
- Dragging an imported event he owns moves it in Google; an imported Holidays or Packers event cannot be dragged and says why.
- A first sync of the primary calendar creates a bounded, countable number of rows. **Report that count in the log entry.** If it is over a few hundred, stop and tell Dylan before enabling more calendars.
- No confirmation text, reminder, bell, drip effect, stage change or sold-on-site match fires for any `source = 'google'` row, proven by test.
- The existing TopCoat calendar sync is byte-for-byte unaffected: the 27 live appointments keep their mappings.

## Do not touch

The OAuth flow, the token table's RLS posture, `_pec-appt-push.cjs`'s target for TopCoat-created appointments, or the Routemize intake (prompt 95 is editing that file; if both land in the same session, sequence 95 first).
