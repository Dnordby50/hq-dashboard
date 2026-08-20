# Prompt 73: reminder-note routing, lead drip coverage, and the day-0 instant touch

Scoped by Cowork 2026-08-06 with Dylan, after 15 scoping questions and live read-only queries against prod (zdfpzmmrgotynrwkeakd). Everything in the "Verified facts" section was re-queried during scoping; re-verify anything you are about to depend on, and flag drift.

---

## 0. Read this first: what is NOT in scope

Dylan's opening ask was "email is showing these codes as of 8/3, remove the codes." **That bug is already fixed and there is nothing to do about it.** Prompt 65 Part A shipped `mapCustomerAnswers` / `isIdLikeQuestionKey` on 2026-08-03, and Dylan approved the Part A3 backfill the same day (its own PROJECT-LOG entry). All 8 appointments carrying customer notes were re-queried on 2026-08-06: **zero UUIDs remain**. Dylan's pasted message went out 2026-08-02, before the fix.

Do not re-fix it. Do not re-run the backfill.

**Dylan is checking whether he has received a code-bearing message dated after 8/3.** If he says yes during your run, stop and investigate the OTHER paths before continuing: the Routemize `AppointmentUpdated` branch (which can PATCH `customer_notes`), `pec-appt-notify`, and the estimate / invoice / review / blast senders. Until he says yes, assume it is closed and spend the run on Parts A through F.

Also out of scope: prompt 71 (SalesAsk surfaces, Part 0 migration still unapplied) and its queue position. Do not touch it.

---

## 1. Verified facts (re-queried 2026-08-06, prod)

**Appointment notes.** `_pec-appt.cjs:143` appends `appt.customer_notes` to every customer-facing appointment message on BOTH channels. The raw Routemize envelopes in `pec_webhook_ingest_log` (endpoint `appt-intake`) show `customerAnswers[]` carries a stable `questionId` that is identical to the (UUID-valued) `question` field, and there are exactly two questions in play:

| questionId | What it is | Sample answers |
|---|---|---|
| `605f816a-b861-c865-3e12-3a2177755a80` | Free-text project description | "New house slab. Want to grind and seal floor. This will be the finished house floor.", "Porch", "Interested in Quartz coating for front apron..." |
| `1077d4b4-4c1d-1f34-52a1-3a2177807ce1` | Service picker (fixed list) | "Grind and Seal", "Other", "Epoxy Patio / Pool Deck", "Epoxy Garage Floor" |

**The order is not stable.** Rob Rudman's envelope has the picker first; Brent Boyer's has the description first. Do not use position.

Current live `customer_notes` values, all clean of UUIDs but all still carrying the picker line:

- Jason Magimel: `Porch`
- Rob Rudman: `Other\nInterested in Quartz coating for front apron...`
- Tom Bechtel: `Pebble stone/epoxy on the front porch and the rear patio\nOther`
- Brent Boyer: `New house slab. Want to grind and seal floor. This will be the finished house floor.\nGrind and Seal`
- Lynette Williams: `Had epoxy system installed in garage and front apron 2 years ago...\nOther`
- Daniel Northrup, Jay McCoy, Larry Bowles: description + `Epoxy Garage Floor`

So Brent's reminder ended with a dangling "Grind and Seal" and Lynette's ended with the single word "Other". That is what Part A fixes.

**Drip state.**

- `pec_drip_campaigns` lead campaign: `e646981a-7bc4-4b58-8da1-280d685d7c8a`, "Lead follow-up (30-day taper)", status `active`, mode **`live`**, `max_touches` **8**.
- `pec_drip_steps` for it: 8 rows, step_index 0..7, day_offset **1, 2, 4, 7, 11, 16, 22, 30**, channels both/sms/email/both/sms/email/sms/both. Columns are `id, campaign_id, step_index, day_offset, channel, ai_guidance, email_subject, active`. **There is no fixed-template column.**
- Settings: `drip_sending_enabled` = `true`, `drip_approval_required` = **`true`**, `drip_autosend_sms` = `false`, `drip_autosend_email` = `false`, `drip_kill_switch` = `false`, quiet hours `08:00`-`20:00` on `mon,tue,wed,thu,fri,sat`.
- **No `routemize_booking_url` setting exists.** No booking URL is stored anywhere in the repo or the database. Routemize front end is `prescottepoxycompany.routemize.com`.
- `pec-drip-runner` runs `*/15 * * * *`.
- **Zero active enrollments on the lead campaign right now.** All 6 existing lead enrollments are `stopped` (reasons: replied, estimate_sent, archived x3, manual). Re-verify this before the migration; the step renumbering in Part B depends on it.

**Enrollment coverage.** `enrollLead` is called from exactly three places: `pec-lead-intake.cjs:191` (the Zapier web-form webhook), and `index.html` lines 26986 and 27657 (`enrollLeadInDrip`). `pec-appt-intake.cjs` never enrolls, and features.json documents that as deliberate ("the created lead is deliberately NOT nurture-enrolled").

Leads and their enrollment status (15 total, 6 never enrolled):

| Lead | Source | Stage | From Routemize | Enrollment |
|---|---|---|---|---|
| Rob Rudman | Google | estimate_scheduled | yes | none |
| Jason Magimel | Google | estimate_scheduled | yes | none |
| Brent Boyer | Word of Mouth | estimate_scheduled | yes | none |
| Tom Bechtel | Google | estimate_scheduled | yes | none |
| Lynette Williams | Word of Mouth | accepted | yes | none |
| Daniel Northrup | Google | estimate_scheduled | yes | none |
| **Jay McCoy** | Google | estimate_scheduled | **no** | none |
| **Larry Bowles** | Other | estimate_scheduled | **no** | none |
| **Cowork Smoke Test** | Website | estimate_scheduled | **no** | none |
| Eric Moorcroft | Facebook | contacted | no | stopped (replied) |
| Dylan Nordb | Other | presented | no | stopped (estimate_sent) |
| Marty Sarner | Facebook | contacted | no | stopped (manual) |
| Laura Donaldson | Facebook | contacted | no | stopped (archived) |
| ZZ Test Draft | Manual entry | new | no | stopped (archived) |
| \<test lead\> | Facebook | new | no | stopped (archived) |

**`sms_consent` is `false` on 14 of 15 leads** (only "Dylan Nordb" is true). Step 0 today is channel `both`. An SMS leg for essentially every real lead is currently unsendable.

**Slack.** Only `SLACK_OFFICE_WEBHOOK` exists (used by `pec-invoice-intent`, `pec-notify-costing-sendback`, `pec-public-estimate`, `pec-security-monitor`). There is no leads webhook.

---

## 2. Dylan's locked decisions

1. Reminder copy: **keep the free-text project description, drop the service-picker answer** from the customer-facing note. The picker value still reaches the rep, on internal notes.
2. Leads that arrive with an appointment already booked do **NOT** go into nurture. Booked appointment is its own track. Enroll only if the appointment is canceled or no-showed.
3. "Online lead" = **any lead created by a webhook**, not a per-source flag. In practice that is `pec-lead-intake.cjs`. Routemize-intake leads are excluded by decision 2 anyway.
4. **The day-0 instant touch auto-sends. Steps 1 through 8 keep the approval gate exactly as today.** This is the whole point of the build; Dylan reversed an earlier "keep the gate on everywhere" answer once the contradiction was named.
5. The day-0 message is a **fixed template, no AI**. Instant by construction, and Dylan reads the exact words once before they ever go out.
6. **Also fix consent capture at intake** so `sms_consent` starts landing true.
7. The instant touch **ignores quiet hours**. It is an immediate reply to a message the person just sent; steps 1 through 8 keep respecting quiet hours.
8. Shape: **new day-0 step, the existing 8 shift down.** One campaign, 9 steps at days 0, 1, 2, 4, 7, 11, 16, 22, 30.
9. Rep alert: yes, **plus a Slack message** to a new leads channel.
10. Booking link: **one settings key** (`routemize_booking_url`) plus a `{booking_link}` token, editable in Settings > Drips. Rule 12.
11. Link scope: **the day-0 touch plus every one of the lead-nurture steps.** Not the estimate, invoice, or review campaigns.
12. Slack destination: **new channel, new webhook** (`SLACK_LEADS_WEBHOOK`), falling back to `SLACK_OFFICE_WEBHOOK` when unset.
13. Backlog: **auto-enroll any still-open non-appointment lead.** See the guardrail in Part F; Cowork flagged that a naive read of this catches test rows and Dylan accepted a filtered version.

---

## 3. Part A: route the Routemize answers by questionId

**File:** `netlify/functions/pec-appt-intake.cjs` (`mapCustomerAnswers`, exported and unit-tested in `production/appt-notes.test.cjs`).

Today every answer goes to `customer_notes`. Change it to return two streams.

- New settings key `routemize_answer_routing`, a JSON object mapping `questionId` to one of `customer` / `internal` / `drop`. Seed it with:
  ```json
  {"605f816a-b861-c865-3e12-3a2177755a80":"customer","1077d4b4-4c1d-1f34-52a1-3a2177807ce1":"internal"}
  ```
  Editable in Settings > Appointments > Routemize booking intake, next to the existing `routemize_service_type_map` card. Rule 12: a new Routemize question is a settings edit, never a code change.
- **Default for an unmapped questionId is `customer`**, preserving today's behavior for anything new rather than silently dropping content a customer wrote.
- Match on `questionId` first, falling back to `question` when `questionId` is absent (the two are identical on every envelope observed, but do not assume that holds).
- Keep `isIdLikeQuestionKey` exactly as it is. It still strips the UUID prefix from any line that reaches the customer note. Do not weaken it.
- `internal` answers append to `body.notes` (the internal notes field, which already carries `AppointmentNotes`) as `Service requested: <answer>`, not to `customer_notes`.
- `drop` discards.
- `customer_notes` becomes `null` when no answer routes to `customer` (do not write an empty string; `_pec-appt.cjs` trims and skips falsy, but a null is cleaner and the column is nullable).

Extend `production/appt-notes.test.cjs` with fixtures built from the four REAL envelopes quoted in section 1, including both orderings, and prove that Brent's note becomes exactly `New house slab.  Want to grind and seal floor.  This will be the finished house floor.` with no trailing "Grind and Seal", and that Lynette's becomes her description alone rather than the bare word "Other".

**Existing rows.** Ask Dylan before running any UPDATE. Prepare a gated statement that strips a trailing or leading picker-value line from the 8 stored `customer_notes` values, print the before/after for all 8, and get a yes. Only one of these appointments can still have a future `start_at`; name it in the ask, the way prompt 65 did.

---

## 4. Part B: the migration

One migration file, applied via MCP, verified by re-query, SCHEMA.md regenerated.

**B1. Step renumbering on the lead campaign.** Insert a new step at `step_index` 0 / `day_offset` 0, shift the existing 8 to indices 1..8, and set `max_touches` to 9.

The order of operations matters because `(campaign_id, step_index)` is expected to be unique. Shift the existing rows upward in descending index order (or to a temporary offset and back), then insert the new row. Verify by re-query that the final state is exactly 9 rows at day offsets 0, 1, 2, 4, 7, 11, 16, 22, 30.

**Guardrail, and do not skip it:** `pec_drip_enrollments.next_step_index` points at the OLD numbering. Scoping found zero active enrollments on this campaign, which makes the renumber free, but re-query `select count(*) from pec_drip_enrollments where campaign_id = 'e646981a-...' and status = 'active'` inside the same migration transaction. If it is greater than zero, `update ... set next_step_index = next_step_index + 1` for those rows in the same transaction. Log the count either way. A renumber that silently reindexes a live enrollment sends someone the wrong message.

**B2. New `pec_drip_steps` columns.**
- `fixed_template text` (nullable) — when set, the step sends this text verbatim and makes zero model calls.
- `fixed_subject text` (nullable) — email subject for a fixed-template step.
- `auto_send boolean not null default false` — when true, this step bypasses the approval gate and quiet hours.

Forward-only. Every existing step gets `fixed_template` null and `auto_send` false, so their behavior is byte-identical to today.

**B3. The new step 0 row.** `day_offset` 0, `channel` `both`, `auto_send` **true**, `ai_guidance` null, and `fixed_template` set to the copy in Part C. `email_subject` / `fixed_subject`: "Thanks for reaching out to Prescott Epoxy Company".

**B4. New settings keys** (insert-only, so a live edit is never clobbered by a re-run):
- `routemize_booking_url` — seed with the empty string. **The build must not invent a URL.** Ask Dylan for the exact booking URL during the run; if he has not given it, seed empty and let the token render as nothing (see Part C's degradation rule).
- `drip_instant_touch_enabled` — `'true'`. Master switch for the whole day-0 behavior, Settings > Drips.
- `routemize_answer_routing` — the JSON from Part A.

**B5.** Regenerate SCHEMA.md and confirm the new columns and keys appear. Per CLAUDE.md, if SCHEMA.md and the live schema disagree anywhere else, trust live and flag the drift in the log entry.

---

## 5. Part C: the day-0 fixed template and the booking link

**Copy rules.** Customer-facing, so **no em dashes anywhere**. Use commas, parentheses, or two sentences.

Write the template with these tokens, which the renderer must support: `{first_name}`, `{booking_link}`. Draft it in the migration, and print it in your final summary so Dylan reads the exact words. Something in this shape, which you may tighten:

> Hi {first_name}, thanks for reaching out to Prescott Epoxy Company. We got your request and someone from our team will call you shortly. If it is easier, you can pick a time for your free on site estimate right here: {booking_link}
>
> Prescott Epoxy Company, Prescott, AZ.

The SMS version must stay under the existing `MAX_SMS_LEN` cap after `capSms`, and the STOP line still appends the way every other SMS leg does.

**`{booking_link}` degradation, and this is a hard requirement:** when `routemize_booking_url` is empty, the token renders as nothing AND the surrounding sentence is dropped, so the message never reads "...right here:" with a dangling colon. Implement this as a template-level conditional (a `{{#booking_link}}...{{/booking_link}}` style block, or two template variants), not a string replace. Unit-test both the set and unset cases.

**AI steps 1 through 8.** Inject the resolved booking URL into `buildRenderPrompt` context for the lead campaign only, with a system-prompt rule in the same register as the existing verbatim-template rules elsewhere in the codebase:

> A booking link is provided. Include it exactly as given, once, near the end. Never modify it, never shorten it, never invent a URL, and never mention booking online if no link was provided.

Add a validation in `renderCopyReal` (or the nearest existing validation seam) that rejects a rendered lead-campaign message containing a `routemize.com` URL that is not character-identical to the configured one. A model hallucinating a booking URL sends a customer to a 404 with your name on it.

---

## 6. Part D: the instant touch

**Where it fires:** inline in `netlify/functions/pec-lead-intake.cjs`, immediately after the existing `enrollLead` call at line 191, in the same request. **Not** on the 15-minute runner tick. That is what makes it instant.

**New function**, in `_pec-drip.cjs` next to `enrollSubject` so the drip logic stays in one file. Suggested `sendInstantTouch(sb, leadId, { now, senders })`. Contract, matching `enrollLead`'s: **never throws**, returns a result object, and a failure can never fail the intake response or the 200 back to Zapier.

**Preconditions, checked in this order, each with its own logged reason:**
1. `drip_instant_touch_enabled` is `'true'`.
2. `drip_sending_enabled` is `'true'` and `drip_kill_switch` is not `'true'`. The global master switches still outrank everything.
3. The lead is enrolled (the `enrollLead` call above returned `enrolled: true`) and its campaign's step 0 has `auto_send = true` and a non-null `fixed_template`.
4. The lead is not archived, not opted out.
5. No `pec_drip_sends` row already exists for this enrollment at `step_index` 0. Idempotency: a Zapier retry must not double-send.

**Channels.** Email always, when an email address exists. SMS **only** when `leads.sms_consent` is true. With 14 of 15 leads at false today, expect this to be email-only in practice and make the ledger say so rather than failing silently: write a `skipped` row with reason `no_sms_consent` for the SMS leg, exactly the way `runDrips` records wanted-but-unsendable legs.

**Gates it bypasses, and only these two:** the approval gate (`drip_approval_required`) and quiet hours. Everything else (kill switch, master switch, consent, opt-out, archived) applies in full. Write this as an explicit `auto_send` branch, not as a new global flag, so the bypass can never leak to steps 1 through 8.

**Ledger and advance.** Write `pec_drip_sends` rows with `enrollment_id`, `campaign_id`, `lead_id`, `subject_type` `lead`, `subject_id`, `step_index` 0, `status` `sent` (or `failed`), reusing the existing `ledgerBase` / `writeLedger` shape including its pre-Phase-3 fallback. Then advance the enrollment to `next_step_index` 1 with `next_send_at` = `enrolled_at` + 1 day, so the taper continues correctly and the next runner tick does not re-send step 0.

**Do not double-count.** The contact-count feature reads `pec_drip_sends` with `status='sent'`; these rows are real sends and should count. Confirm you have not created a path where both this function and `runDrips` write a step-0 row.

---

## 7. Part E: Slack alert and consent capture

**E1. Slack.** New env var `SLACK_LEADS_WEBHOOK`, falling back to `SLACK_OFFICE_WEBHOOK` when unset, and a clean no-op with a logged reason when neither is set (the pattern `pec-notify-costing-sendback.cjs:48` already uses). Fires inline at intake, same best-effort contract as the instant touch.

Message content: lead name, source, phone (as a `tel:` link), email, the free-text project description, whether the instant touch went out and on which channels, and a direct link to the lead in TopCoat. This is an internal message, so em dashes are fine, but keep it scannable.

**E2. In-app notification** to the assigned rep, or to the office when no rep is assigned yet, using the existing notifications mechanism.

**E3. Consent capture.** The intake already maps `body.sms_consent === true` onto `leads.sms_consent` / `sms_consent_source` / `sms_consent_at`. The reason it is false everywhere is upstream: the web form is not capturing or passing it.

Code side, small:
- Accept the common truthy spellings Zapier will actually send (`true`, `"true"`, `"yes"`, `"on"`, `"1"`, checkbox-style values) rather than strict `=== true`. Be explicit about the list and test it; do not treat an arbitrary non-empty string as consent.
- Store the disclosure text the customer actually agreed to, if the payload carries it, so the consent record is defensible.
- Add a Settings > Drips readout: how many leads created in the last 30 days arrived with `sms_consent` true, so the gap is visible instead of invisible.

**Dylan handoff, put this in your final summary rather than trying to build it:** the web form needs a real consent checkbox with TCPA-style disclosure language, and the Zapier Zap needs to map it into `sms_consent`. Write out the exact field name the intake expects and suggested disclosure wording so he can hand it to whoever owns the site. **This is the actual root cause and it is not fixable from this repo.**

---

## 8. Part F: enrollment coverage and the backlog

**F1. Confirm the appointment path stays out.** `pec-appt-intake.cjs` does not enroll, and per decision 2 it should not start. Verify no change is needed and say so in the log entry rather than leaving a reader to wonder.

**F2. Re-engagement on cancel or no-show.** When a Routemize `AppointmentCancelled` / `AppointmentDeleted` event marks an appointment canceled, enroll that appointment's lead into the lead campaign, best-effort, subject to the usual archived / opted-out guards. This is the one case where a previously-booked lead belongs in nurture. It is a normal enrollment (starts at step 0 or step 1 per your read of what makes sense for someone who has already talked to you; recommend step 1 and say why), NOT an instant touch. A cancellation is not a fresh inquiry.

**F3. Investigate three leads.** Jay McCoy, Larry Bowles, and Cowork Smoke Test were created outside Routemize and never enrolled, despite `index.html:26986` calling `enrollLeadInDrip` on manual add. Find out why: created before that wiring, a different creation path, or a silent failure. If it is a live bug, fix it. Report the finding either way, since it determines whether "all leads enroll" is actually true going forward.

**F4. Backlog enrollment.** Dylan chose auto-enroll for still-open non-appointment leads. Build it as a gated, re-runnable, idempotent script under `scripts/` with a `--dry-run` that prints the exact list, following the `scripts/backfill-review-asks.cjs` pattern. **Run the dry-run and show Dylan the list before running it for real.**

Exclusion filters, all required:
- `archived_at` is not null
- `opted_out` is true
- stage in `accepted`, `lost`
- the lead has any non-canceled appointment
- already has an enrollment on the lead campaign in any status (a `stopped` enrollment means a human or a rule already ended it; do not resurrect it)
- name matches an obvious test pattern (`ZZ %`, `%Smoke Test%`, `%test lead%`)

Anchor `next_send_at` to enrollment time, not lead creation date. `enrollSubject` already does this, and the prompt-60 log entry explains why it matters: anchor a 30-day-old lead to its creation date and it becomes instantly overdue for six steps on one tick.

**Backlog leads do NOT get the instant touch.** A "thanks for reaching out" auto-reply to someone who inquired three weeks ago reads as broken. They start at step 1.

---

## 9. Acceptance criteria

Every one of these needs a live verification against `prescottepoxy.netlify.app` with database re-queries, in the house style: capture baseline counts first, delete every test row afterward, and re-query to prove zero residue.

1. `mapCustomerAnswers` on the real Brent Boyer envelope yields a `customer_notes` of the description alone and an internal note carrying `Service requested: Grind and Seal`. Same for Rob Rudman, whose picker answer comes first.
2. An unmapped questionId still routes to `customer`, and `isIdLikeQuestionKey` still strips a UUID prefix from it.
3. The lead campaign has exactly 9 steps at day offsets 0, 1, 2, 4, 7, 11, 16, 22, 30, `max_touches` 9, and any active enrollment had its `next_step_index` bumped.
4. A POST to the lead-intake webhook creates a lead AND sends the day-0 email **within the same request**, with `drip_approval_required` still `'true'`. Prove the timing from the function log, not by inference.
5. That same test with `sms_consent` true also sends the SMS; with it false, a `skipped` ledger row with reason `no_sms_consent` exists and no SMS was attempted.
6. A second POST of the identical payload (Zapier retry) creates no second lead and no second step-0 send.
7. With the system clock inside quiet hours (or by whatever seam the existing tests use), the day-0 touch still sends, and a step-1 SMS still defers.
8. Steps 1 through 8 still land in the approval queue as pending. Nothing about the gate changed for them. Test this explicitly; it is the regression that would matter most.
9. With `routemize_booking_url` set, the day-0 message contains it verbatim and an AI-rendered step 3 contains it verbatim. With it empty, neither message contains a dangling colon or a hallucinated URL.
10. An AI step that returns a fabricated `routemize.com` URL is rejected by the validation in Part C.
11. `drip_instant_touch_enabled` = `'false'` produces zero sends and a logged reason. `drip_kill_switch` = `'true'` also produces zero sends.
12. The Slack alert fires to `SLACK_LEADS_WEBHOOK`, and falls back to `SLACK_OFFICE_WEBHOOK` when that var is unset, and no-ops cleanly when neither is set.
13. Canceling a Routemize appointment enrolls its lead; the same lead does not receive an instant touch.
14. `scripts/` backlog script `--dry-run` output excludes every archived, test, accepted, lost, and appointment-holding lead.
15. `npm test` green, with new checks covering: the questionId routing map (both orderings, unmapped default, drop), the booking-link conditional (set and unset), the auto_send bypass (and that it does NOT leak to steps 1-8), instant-touch idempotency, and the consent-value parsing list.

---

## 10. Landmines

1. **The step renumber is the highest-risk change in this build.** It is safe only because there are currently zero active enrollments. Re-verify inside the transaction and handle nonzero.
2. **`auto_send` must be per-step, never global.** The moment it becomes a settings key that `runDrips` reads globally, someone flips it and 8 AI-written messages auto-send to a customer.
3. The approval gate has a **hold** branch (`pending_held`) that fires regardless of the gate setting, by design, so flipping the gate can never auto-send something a human was mid-review on. Your `auto_send` branch must not defeat that. Read `_pec-drip.cjs` section 4.5 before writing anything.
4. **Do not put the instant touch on the runner.** If you find yourself writing it into `runDrips`, you have built a 15-minute-latency feature and lost the point.
5. `supabase-js` reports a nonexistent column as an empty response without throwing. If a read comes back mysteriously empty, check `res.error` before suspecting RLS. (CLAUDE.md.)
6. `material_type`-style CHECK constraints: `pec_drip_campaigns.kind` has one. You are not adding a kind, so you should not need to touch it. If you find yourself wanting to, stop and ask.
7. Verify every table and column against SCHEMA.md before writing SQL, and trust the live schema over SCHEMA.md where they disagree. (CLAUDE.md.)
8. Customer-facing copy: no em dashes. Applies to the day-0 template, the AI guidance strings, and the What's New entry.
9. **Do not send a real message to a real person during verification.** Use a throwaway lead with an address you control, and delete it afterward.

---

## 11. Housekeeping

- `features.json`: new entry for the instant touch, amend the Routemize intake entry (Part A changes documented behavior), amend the drip entries.
- `help/whats-new.json`: one entry, no em dashes.
- SCHEMA.md regenerated and verified.
- PROJECT-LOG.md: new entry at the TOP, `By: Claude Code`. Record the actual step-renumber counts, whether any active enrollment was bumped, the finding on the three unenrolled leads (F3), the exact day-0 template text as shipped, and whether Dylan approved the Part A note backfill and the F4 backlog run.
- Commit named files only, never `git add .`, message `cowork: <short description>` style per CLAUDE.md's commit rules (adjust the prefix for Claude Code's own convention).
- **Stop and confirm with Dylan before:** running the Part A UPDATE on stored notes, running the F4 backlog enrollment for real, and sending any test message to a real phone number or inbox.

## 12. Open items needing Dylan during the run

1. The exact Routemize booking URL for `routemize_booking_url`.
2. The final wording of the day-0 template (show him your draft).
3. Approval for the Part A stored-notes cleanup, with the before/after printed.
4. Approval for the F4 backlog list, after the dry run.
5. Confirmation on whether any post-8/3 message actually carried UUID codes (section 0).

## 13. Cowork handoff after this ships

- Create the `#new-leads` Slack channel and its Incoming Webhook, set `SLACK_LEADS_WEBHOOK` in Netlify, and **redeploy**. The 2026-08-04 BusyBusy entry proved env vars do not reach running functions without a redeploy; do not skip it.
- Verify the first real online lead end to end: instant email received, Slack alert landed, `pec_drip_sends` step-0 row written, enrollment advanced to step 1, and step 1 appearing in the approval queue the next day.
- Report back what percentage of new leads arrive with `sms_consent` true once the web form change lands, so the SMS leg's real reach is known rather than assumed.
