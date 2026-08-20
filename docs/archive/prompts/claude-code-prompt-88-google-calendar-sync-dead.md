# Prompt 88: Google Calendar sync is fully dead — zero events ever pushed. Repair, then backfill.

Written by Cowork on 2026-08-12 after running the appointments-vs-calendar reconciliation Dylan asked for. This prompt hands you a completed diagnosis with live evidence; verify the two root causes quickly, fix, and backfill. Read CLAUDE.md and the last 3 PROJECT-LOG entries first per standing rule 4.

## The reconciliation result (Cowork, live, 2026-08-12)

- `pec_appointments`: 21 rows, 19 scheduled. **0 of 21 have a `google_event_id`.** Nothing has EVER been stamped.
- Dylan's TopCoat Google calendar (c4b6b7e4...@group.calendar.google.com) contains ZERO events July–September, and its `updated` timestamp equals its creation moment (2026-07-21T16:13:41Z, the same second as `google_connected_at`). Not one event has ever landed there.
- Both roster members show `google_connected=true` (connected 2026-07-21 ~16:11-16:13 UTC). Aron's calendar lives in his own Google account (google_email aronbronson@icloud.com) and could not be read from Dylan's account, but his rows' null google_event_ids tell the same story.
- Sources: 14 of 21 appointments are `source='routemize'`, 7 are `source='topcoat'`.

## Root cause 1 (high confidence): OAuth refresh tokens died after exactly 7 days — the Google Cloud OAuth app is almost certainly still in Testing mode.

`pec_sales_member_google_tokens` live state: both rows have `token_expiry = 2026-07-28 ~16:11-16:13 UTC` and `updated_at = 2026-07-28 16:09 UTC`, and have not moved since, despite pec-google-calendar-pull running every 15 minutes (netlify.toml:97). Connected 07-21, last successful refresh 07-28: exactly 7 days. That is the documented lifetime of a refresh token issued by a Google Cloud project whose OAuth consent screen is in **Testing** publishing status. Every push and pull since 07-28 has failed auth. (Both `sync_token`s are non-null, so the pull DID work during the 7 live days; the calendars were empty then because of root cause 2 and because nearly all real appointments were created after 07-28.)

Verify cheaply: attempt one token refresh server-side (or read pec-google-calendar-pull's recent Netlify function logs for the invalid_grant error). `invalid_grant` on refresh for both members = confirmed.

The fix is NOT code: the OAuth consent screen must be published to Production in Google Cloud Console, then both members reconnect from Settings > Appointments. Both are web-UI actions. Write the `## Handoff to Cowork` section (standing rules 5 and 8) with: the Google Cloud project name/id (find it beside GOOGLE_OAUTH_CLIENT_ID in Netlify env, or in SETUP notes), the exact console path (APIs & Services > OAuth consent screen > Publish app), a note that "needs verification" warnings can be ignored for an internal-use app with only calendar scope IF Google allows publishing without review, and the reconnect steps for Dylan and Aron. What CODE should do about it:

- Surface the failure. Two weeks of silent auth failure is the real lesson. When a refresh fails with invalid_grant, flip the member's `google_connected` false (or a new needs_reconnect flag) so Settings > Appointments shows "Reconnect" instead of lying green, and drop a bell notification (once, not every 15 minutes). Respect rule 12 rationing; this is state, not a setting — no settings row.

## Root cause 2 (confirmed in code): the Routemize intake never kicks the push.

The in-app write path funnels through `apptPostWrite` (index.html:26018) → `apptKickPushSync` (:26037) → pec-appt-sync-push. But `pec-appt-intake.cjs` — the source of 14 of the 21 appointments — contains NO call to pec-appt-sync-push or any push helper. The comment at pec-appt-intake.cjs:392 even claims the title "syncs out to Google Calendar"; the sync it promises does not exist. So even with healthy tokens, Routemize bookings (the majority path) would never reach Google.

Fix: after the intake upserts an appointment (create/update/cancel/delete paths all matter — the sync-push handler already handles update-by-existing-google_event_id and delete), invoke the push server-side. Options: extract the push core from pec-appt-sync-push.cjs into _pec-google.cjs and call it directly (cleaner than HTTP self-invocation), or fetch the function URL with a service auth. Keep it fire-and-forget with a logged failure, same contract as the client kick: a push failure must never fail the intake response (Routemize retries non-2xx).

## Backfill (Dylan pre-approved the import direction)

Once tokens are healthy and the intake kick exists: re-push every appointment with `status='scheduled'` and `google_event_id IS NULL` (19 today) to its member's TopCoat calendar. The push handler is already idempotent (PATCH when stamped, insert when not). Appointments with no sales_member_id (at least one Routemize row has none) cannot push; list them in the log entry instead of guessing a member. Canceled appointments: do not create-then-cancel in Google; skip them.

Order of operations matters: the Cowork handoff (publish + reconnect) must complete before the backfill can succeed. Ship the code (failure surfacing + intake kick + a backfill trigger), verify against your own reconnected state if possible, and put the backfill execution step INTO the Cowork handoff if tokens are still dead when you finish. A one-shot backfill needs no settings row and no UI; a hidden admin action or a curl-able function with auth is fine — document the invocation in the log.

## Verification

- After reconnect: create a test appointment in-app → event appears in that member's TopCoat calendar within seconds and google_event_id is stamped. Book a Routemize test (or replay a stored intake payload) → same. Edit its time in Google → the 15-min pull brings it back (or note the wait).
- Backfill run: count of pushed rows equals the scheduled-and-unstamped count at run time; log before/after counts per member.
- The features.json "Google Calendar two-way sync" and "Routemize appointment intake" entries updated. No What's New entry unless staff-visible behavior changed (the Reconnect state IS staff-visible; one entry covering "calendar sync repaired + reconnect prompts" is right, no em dashes).
- SCHEMA.md regen only if you added a column (needs_reconnect); @artifacts header on any migration per rule 13.
