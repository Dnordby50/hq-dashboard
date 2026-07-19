# Claude Code Prompt 34 — Leads pipeline robustness, PHASE 2 of 3: the lead drip engine

## Context

Phase 1 (prompt 33) shipped and is verified live on https://prescottepoxy.netlify.app: times-contacted chips on the Leads board and lead detail (derived read-only from pec_call_log / pec_sms_log / pec_email_log via a `countContactsForLead`-style helper), Hot/Warm/Cold score badges with a hot-first board sort, and the Metrics chart redesign (Chart.js 4.4.1) with a new "Outbound touches" Sales card that currently reads "Not enough data yet" because prod has one lead.

This is Phase 2: the automatic, AI-tailored **lead** drip engine. Estimate drips, invoice drips, and the manual blast tool are Phase 3 and are NOT built here, but you WILL build the engine generically (a `kind` column, channel-agnostic send path) so Phase 3 is mostly new campaign rows and two new triggers, not a rewrite. Where Phase 2 touches Phase 1's contact count, this prompt says exactly how.

Locked decisions from Dylan (scoped by Cowork 2026-07-19; see the PROJECT-LOG "Cowork: scoped leads-pipeline robustness build" entry and the memory note project_leads_robustness_build):
- Sending is FULLY AUTOMATIC and the AI tailors each message per lead. This is an intentional, scoped exception to the old "AI drafts, never sends" rule, and it applies ONLY to drip copy. AI scoring/analysis stay read-only.
- Channel: both SMS and email (a step can be sms, email, or both).
- Cadence: a tapering sequence over 30 days, ~8-10 touches. Default: days 1, 2, 4, 7, 11, 16, 22, 30 after enrollment (8 steps).
- Kill-switches, ALL of them: lead replies (any inbound), stage advances or lead marked lost, STOP / opt-out, and a max-touches ceiling.
- Times-contacted counts outbound Quo calls/texts PLUS drip sends (Phase 1 left the extension point; wire it here).

Follow every CLAUDE.md standing rule: consult SCHEMA.md before writing ANY SQL or supabase-js select, consult features.json before hunting in index.html, token discipline (grep + anchors, never a full read of index.html or the logs), commit per meaningful change, PROJECT-LOG entry, What's New entry for the user-visible parts, no em dashes in customer-facing text (the drip messages ARE customer-facing, so this matters), keep secrets out of code.

## Mentor-level guardrails I want you to build in (not optional)

Automatic + AI-authored + SMS is the highest-liability path. These protect Dylan's business number and brand and are part of the spec, not nice-to-haves:

1. **Quiet hours.** Never send SMS outside 8:00am-8:00pm America/Phoenix. A step whose scheduled time lands outside the window is deferred to the next window open, not skipped. Email can send any time.
2. **Global master switch.** A single setting that pauses ALL drip sending instantly (the runner checks it first and no-ops if off). Ship it defaulting to OFF so nothing sends until Dylan turns it on.
3. **Dry-run / live per campaign.** Each campaign has a mode: `dry_run` writes the fully-rendered message it WOULD send into pec_drip_sends with status `dry_run` (and does NOT hit Quo/Resend), so Dylan can watch the AI's actual output for a few days on the lead detail timeline before flipping the campaign to `live`. Default new campaigns to `dry_run`.
4. **Consent + opt-out enforced on every SMS send**, re-checked at send time, not just at enrollment: skip/stop if `leads.opted_out` or `sms_consent` is false. Wire the Quo STOP path (pec-webhook-quo.cjs already flips customer opt-out on inbound STOP) to ALSO set `leads.opted_out = true` for a matching lead, so a STOP kills the drip.
5. **Rate limits + max touches.** A hard per-lead ceiling (default 8, matching the taper) and a per-run global cap, both logged when hit. No enrollment can ever loop-send.
6. **First SMS carries opt-out language** ("Reply STOP to opt out") appended once, and the AI is forbidden from inventing prices, dates, warranties, or facts not present in the lead record.

## Schema (new migration; Cowork applies, do NOT apply yourself)

Before writing the migration, VERIFY against SCHEMA.md: the exact `leads` columns (phone_norm, email, stage, opted_out, sms_consent, customer_id, contacted_at, stage timestamps), the `is_admin_staff()` helper and the `pec_prod_touch_updated_at()` trigger used by sibling tables, and the shapes of pec_sms_log / pec_email_log you will insert or read. Mirror the RLS pattern of a recent staff-only table (e.g. pec_change_order_batches from the 2026-07-17 migration): staff FOR ALL via is_admin_staff(), NO anon policy.

Create (names indicative; match existing `pec_` conventions):

- `pec_drip_campaigns`: id, name, kind text check in ('lead','estimate','invoice') default 'lead', status text check in ('active','paused') default 'active', mode text check in ('dry_run','live') default 'dry_run', max_touches int default 8, created_at, updated_at. Seed ONE lead campaign in the migration.
- `pec_drip_steps`: id, campaign_id fk, step_index int, day_offset int (days from enrollment), channel text check in ('sms','email','both'), ai_guidance text (the per-step instruction the model tailors from, e.g. "friendly first touch, introduce PEC, ask for a good time"), email_subject text null, active bool default true. Seed the 8 taper steps for the lead campaign (day_offset 1,2,4,7,11,16,22,30). Pick sensible per-step channel + guidance; early steps SMS+email, later ones vary.
- `pec_drip_enrollments`: id, lead_id fk, campaign_id fk, status text check in ('active','stopped','completed') default 'active', next_step_index int default 0, next_send_at timestamptz, stop_reason text null, enrolled_at default now(), stopped_at null, updated_at. PARTIAL UNIQUE index on (lead_id) WHERE status='active' (one live enrollment per lead). Index on (status, next_send_at) for the runner.
- `pec_drip_sends`: id, enrollment_id fk, lead_id fk, campaign_id fk, step_index int, channel text, status text check in ('queued','sent','failed','skipped','dry_run'), scheduled_for timestamptz, sent_at timestamptz null, subject text null, body text, provider_id text null (quo_message_id or resend_id), error_message text null, created_at default now(). Index on (lead_id, status). This table is the send ledger AND the new contact-count source.
- A settings row for the global master switch: reuse whatever app-settings table already exists (check SCHEMA.md / features.json for a settings/config table) rather than inventing one; if none fits, a tiny `pec_drip_settings` single-row table with `sending_enabled bool default false`.

Include the verify queries at the bottom of the migration file (table exists, columns, the partial unique index definition, RLS + one staff policy + zero anon, seeded campaign + 8 steps).

## Enrollment

- Auto-enroll a lead into the active `kind='lead'` campaign when it is created / enters stage 'new'. Do this server-side where leads are created from intake (pec-lead-intake.cjs) AND cover leads created manually in the dashboard (openNewLeadModal path) — verify both against features.json/code. Set next_step_index=0 and next_send_at = enrolled_at + step0.day_offset (respecting quiet hours for SMS-first steps).
- Never create a second active enrollment (the partial unique index backs this; handle the conflict gracefully).
- A lead that is already past 'new' when the engine ships should NOT be retro-enrolled unless Dylan asks; only new arrivals enroll. State this in the log.

## The runner (new scheduled Netlify function, e.g. pec-drip-runner.cjs)

Register it as a Netlify scheduled function (netlify.toml `[functions]` schedule, or the `schedule` export) at a sensible cadence (every 15 min is fine; the taper is day-grained so timing is forgiving). The function:

1. If the global master switch is OFF → log and return immediately (no sends).
2. Select active enrollments with next_send_at <= now, up to the per-run cap.
3. For EACH, re-check kill-switches at send time and stop the enrollment (status stopped + stop_reason) if any fire:
   - opted_out or (channel needs SMS and sms_consent false) → stop reason 'opted_out'.
   - lead.stage is beyond the pre-sale window (advanced past 'contacted' to estimate_sent/presented/accepted, or 'lost') → stop reason 'stage_advanced' / 'lost'.
   - an inbound touch since enrolled_at (a pec_sms_log direction='in' OR pec_call_log direction='in' matching the lead's phone_norm/customer_id with timestamp > enrolled_at) → stop reason 'replied'.
   - step_index >= campaign.max_touches → status completed, reason 'max_touches'.
4. Otherwise render the message: call an AI helper (new endpoint or inline, reuse the auth + Anthropic call shape from pec-lead-ai.cjs / pec-estimate-crew-notes.cjs) with the lead record + the step's ai_guidance. System prompt: tailor a short, friendly outreach as PEC; NEVER invent prices, dates, warranties, or facts not in the lead; SMS must be concise; email returns subject + body. No em dashes.
5. Send:
   - If campaign.mode = 'dry_run' → write a pec_drip_sends row status 'dry_run' with the rendered body/subject, do NOT call Quo/Resend, advance the schedule.
   - If 'live' → send via the SAME server paths pec-send-sms / the email/Resend sender already use (find them via features.json: "Quo / OpenPhone integration" and the email sender). VERIFY-THEN-RECORD, no blind retry (non-idempotent write discipline from CLAUDE.md): on a network wobble, do not resend blindly; record failed and let the next run reconsider only if no provider id came back. Append the STOP line to the first SMS only.
   - Record pec_drip_sends (status sent/failed, provider_id, sent_at). Update leads.contacted_at.
6. Advance: next_step_index++, compute next_send_at from the next active step's day_offset (relative to enrolled_at), applying quiet hours for SMS. If no more steps → status completed.

Concurrency: a run must not double-send a step. Use the enrollment row's next_step_index as the guard (only send the step matching next_step_index; the advance is the commit). Keep per-run work bounded.

## Fold drip sends into the Phase 1 contact count

In the Phase 1 `countContactsForLead` helper (features.json "Leads pipeline board" / lead detail anchors), add pec_drip_sends rows with status IN ('sent') for the lead as a fourth outbound source, at the extension point Phase 1 left. Dry-run and failed sends do NOT count. Re-verify the de-dupe so a drip SMS that also lands in pec_sms_log is not double-counted (decide the rule: prefer counting the drip_send and excluding the mirrored sms_log row, or vice versa; document it). Update the lead-detail breakdown copy if you add a "drip" line.

## UI (minimal but sufficient for Dylan to trust it)

- A Drips admin view (under Sales or Admin, match the nav pattern; features.json shows the menu structure): list campaigns with kind, status, mode (dry_run/live), max_touches; the global master switch (big, obvious, defaults OFF); a per-campaign pause and a dry_run/live toggle; and the step list (read-only is fine for P2, editable is a bonus). Show a count of active enrollments.
- Lead detail: a "Drip" block showing enrollment status (Active: step 3 of 8, next touch <date>; or Stopped: replied / Completed), the sent (and dry-run) messages inline in the activity timeline, and a manual "Stop drip" button and "Enroll" button. Stopping is a plain status update.
- Board (optional, keep light): a small dot/label when a lead has an active drip.

## Env / credentials (Handoff to Dylan, do not hardcode)

The runner needs ANTHROPIC_API_KEY (confirm it is set in Netlify per the leads build) and whatever Quo + Resend credentials pec-send-sms and the email sender already use (reuse, do not add new). If anything is missing, put a placeholder and add a Handoff line; do not commit secrets.

## Verification (before commit)

- `node --check` every new/changed .cjs (runner, any AI endpoint, the webhook edit).
- Confirm all inline index.html script blocks still parse (module-aware) and whats-new.json validates.
- Production suites still green (this phase should not touch calculator/estimate logic).
- Fixture-test the runner against a stubbed Supabase + stubbed Quo/Resend: cover each kill-switch (replied stops before send, opted_out stops, stage-advanced stops, max_touches completes), dry_run writes a row but never calls the providers, a live send records provider_id and advances exactly one step, quiet-hours defers an SMS step, the master-switch-off path sends nothing, and a second concurrent run cannot double-send the same step_index. Aim for the same rigor as the prompt-31 batch handler fixture (28 checks).
- Confirm by grep that drip copy is the ONLY new auto-send; scoring/analysis still never send.

## Ship

- Commit in logical units (migration; runner + AI endpoint; enrollment wiring + webhook STOP edit; contact-count fold; UI; docs).
- What's New entry for the user-visible drip controls (plain language, no em dashes).
- Update features.json (new "Lead drip engine" feature with anchors: runner function, AI endpoint, enrollment points, tables; and amend the "Leads pipeline board" contact-count note).
- PROJECT-LOG entry (By: Claude Code): how the engine works, the kill-switch re-check-at-send design, the dry-run/master-switch defaults (OFF), the contact-count de-dupe rule you chose, and that estimate/invoice/blast are Phase 3.
- Regenerate SCHEMA.md AFTER Cowork applies the migration (Handoff to Cowork).

## Handoff to Cowork (put this in the PROJECT-LOG entry)

1. Apply the drip-engine migration to PROD (project "HQ Dashboard", zdfpzmmrgotynrwkeakd); run the verify queries; confirm tables, the partial-unique-on-active-enrollment index, RLS staff-only + zero anon, and the seeded lead campaign + 8 taper steps. Regenerate SCHEMA.md.
2. After Dylan deploys with the master switch OFF and the campaign in dry_run: create a couple of test leads, let the runner tick, and confirm pec_drip_sends fills with dry_run rows carrying sensible AI copy, that a test inbound reply / a STOP / a stage advance each stop the enrollment with the right reason, and that quiet hours defer SMS. Only after Dylan is happy with the dry-run copy does he flip a campaign to live.

## Explicitly OUT of scope for Phase 2 (Phase 3)

- Estimate follow-up drips and invoice payment-reminder drips (the engine's `kind` column is built for them; the triggers and campaigns are Phase 3).
- The manual blast tool.
- Drip/blast performance metric cards (the Phase 1 Sales-section placeholder stays until Phase 3).
