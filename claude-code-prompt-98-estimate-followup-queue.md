# Claude Code prompt 98: the sent-estimate follow-up queue (who to call first, why, and what to actually say)

## Context

Dylan, 2026-08-18: "Sales follow up list in TopCoat by Hot leads, who to call first based on indicators." Asked to pick the ranking inputs he added: "this is for salespeople, on estimates sent only for now." Asked what removes a row: "also add suggested follow ups for each. What Chuck Thokey with a top rep would say, or Tommy Mello. Not just 'checking in on your proposal', to help us be better." Asked where a logged touch should land: "customer file, also the estimate detail or sales pipeline card."

**This prompt supersedes the scope of claude-code-prompt-49-followup-queue.md, which was written 2026-07-26, updated 2026-07-29, and never run.** Read prompt 49 first: its twelve locked decisions still stand except where this file overrides them. Nothing from it shipped, so there is no partial build to reconcile with: no Follow-ups view exists in index.html and no touch tables exist in the database (verified 2026-08-18).

**Prompt 97 is a hard prerequisite.** It makes `leads.score` real. Do not start this until it has shipped and the backfill has run.

Live shape of the problem, 2026-08-18: 8 estimates in `sent` status awaiting a decision, 26 estimates total, 101 estimate-view records, 1,931 calls and 436 texts in the comms logs, 6 SalesAsk visit recordings with transcripts already linked to estimates. The signal exists; nothing assembles it into a call list.

### Read before you start

CLAUDE.md, the top 3 entries of PROJECT-LOG.md, claude-code-prompt-49-followup-queue.md, features.json entries "Sales Pipeline board", "Lead detail with AI game plan", "Numbered estimate records", "Estimate follow-up drip", and the SalesAsk entry, SCHEMA.md for `estimates`, `customers`, `leads`, `pec_estimate_views`, `pec_call_log`, `pec_sms_log`, `pec_email_log`, `pec_drip_sends`, `pec_salesask_recordings`, `settings`.

---

## Locked decisions

Carried from prompt 49, unchanged:

1. Deterministic staleness rules decide WHO is in the queue; AI decides only the ORDER and the wording. Coverage never depends on the model.
2. A new top-level **Follow-ups** view in the Sales nav group. Not a rail on the kanban, not a home card.
3. Manual touch logging exists, and drips do **not** reset the clock. The clock answers "when did a PERSON last reach out."
4. Nightly rank run plus a manual re-rank button.
5. Full working rows: why-now, suggested opener, one-tap Call / Text / Log touch / Open inline.
6. **One shared queue for all staff**, no per-owner default filter (Dylan re-confirmed this 2026-08-18).
7. Nav badge count plus a daily Slack digest. No bell rows, no email digest.
8. Cold tail: subjects untouched past a configurable threshold collapse into a separate Cold section rather than burying the live list.

New or changed 2026-08-18:

9. **Subjects are sent estimates awaiting a decision. Leads without an estimate are OUT of scope for now.** This narrows prompt 49's decision 9. Build the subject resolver so a second subject type can be added later without a rewrite, but ship only estimates.
10. **Ranking inputs**: days since a human last touched them, inbound engagement (estimate views, inbound calls, inbound texts, portal activity), and dollar value at stake. Speed-to-lead is explicitly out, since new leads are not in scope.
11. **Exits**: accepted / signed / paid, marked lost or declined, and snoozed until a date.
12. **The suggested follow-up must be coaching-grade.** See Part D. "Checking in on your proposal" is a build failure, not a wording nit.
13. **A logged touch writes a note on the CUSTOMER file**, and that note renders on the customer page, the estimate detail, and the lead's sales pipeline card. One write, three surfaces.

---

## Part A: schema

1. `pec_customer_notes`: `id`, `customer_id` (FK, cascade), `lead_id` (nullable, no FK, matching the `pec_appointments` convention), `estimate_id` (nullable FK), `body` (text), `channel` (check: `call`, `text`, `email`, `in_person`, `walk_in`, `other`), `outcome` (nullable check: `reached`, `voicemail`, `no_answer`, `n_a`), `counts_as_touch` (bool, default true), `created_by` (auth uid), `created_at`. Index on `(customer_id, created_at desc)` and `(estimate_id, created_at desc)`. RLS: staff read and write, same posture as the other staff-facing tables.
   - `customers` has no notes column today, so this is the customer note store, not a migration of something existing.
   - `counts_as_touch` exists so a "customer walked in and paid" note and a "left voicemail" note can both be recorded while only the ones that are outreach reset the clock. Default true, editable on the form.
2. `estimates` gains `followup_snoozed_until` (nullable timestamptz) and `followup_snooze_reason` (nullable text).
3. `pec_followup_ranks`: the nightly output, one row per open subject: `subject_type`, `subject_id`, `rank`, `score`, `why_now` (text), `suggested_opener` (text), `suggested_channel`, `ranked_at`, `inputs` (jsonb snapshot of the deterministic signals the model was given). Unique on `(subject_type, subject_id)`. Keeping the inputs makes a bad ranking debuggable instead of mysterious.
4. Migration with the `@artifacts` header (rule 13). New tables plus two nullable columns on `estimates`. Note rule 14: `estimates.status` is a rehearse-on-a-branch table, but these columns are additive and do not touch `status`, so direct to prod is defensible. State that reasoning in the migration comment.

## Part B: membership, deterministically

An estimate is in the queue when all of these hold:

- `status = 'sent'` (not draft, not accepted, not rejected), `deleted_at` is null, its lead is not archived or lost.
- `followup_snoozed_until` is null or in the past.
- Days since the last **human** touch is at or past the threshold for its situation.

Last human touch = the most recent of: an outbound call in `pec_call_log`, an outbound text in `pec_sms_log` that is not a drip mirror row, an outbound email in `pec_email_log` that is not a drip or blast row, or a `pec_customer_notes` row with `counts_as_touch`. Match on `customer_id` first, then normalized phone, exactly the way `leadContactStats()` already does (index.html ~:20369-20440). **Reuse that helper rather than writing a second matcher**; if it needs generalizing from leads to customers, generalize it and keep its existing numbers identical (the Contacted Nx chip must not move).

Thresholds live in settings (rule 12): `followup_overdue_days_estimate_sent` (default 3), `followup_cold_days` (default 21, the cold-tail cutoff), `followup_snooze_max_days` (default 60).

Membership is computed at render time from live data, the same posture as the Ops Queue's derived checks. The nightly rank only orders what the rules already selected.

## Part C: the rank run

New scheduled function `pec-followup-rank.cjs`, nightly, gated by a settings toggle, heartbeat-wrapped.

For each open subject, assemble the deterministic inputs first, in code, not in the model:

- Days since last human touch, and the count of human touches so far.
- Inbound engagement: estimate view count and the timestamp of the most recent view (`pec_estimate_views`), inbound calls and texts since the estimate was sent, portal change requests.
- Dollar value: `estimates.price`.
- The lead's current AI score from prompt 97, and its band.
- Days since the estimate was sent.
- Whether a SalesAsk recording exists for the visit, and its summary.

Then **batch roughly 25 subjects per Claude call, not one call per subject** (prompt 49's cost decision, still binding even though today's set is 8). The call returns `score`, `why_now`, `suggested_opener`, `suggested_channel` per subject. Store the inputs blob alongside the output. The model orders and words; it does not decide membership, and its score is never allowed to remove a row.

A **deterministic `fallbackPriority`** must exist so the queue is never empty or unordered when the model call fails: rank by days-since-touch, then engagement recency, then value. Prompt 49 locked this; keep it.

Put the shared rules in a pure module `production/followup-rules.cjs` required by the Netlify function, with a mirrored copy in index.html for the client render (the precedent is `pecInstallmentAsk` mirroring `_pec-installments.cjs`). Keep them in lockstep and test the module directly.

A manual "Re-rank now" button on the view runs the same path for the current set.

## Part D: the suggested follow-up (the part Dylan actually asked for)

Dylan's words: "what Chuck Thokey with a top rep would say, or Tommy Mello. Not just 'checking in on your proposal', to help us be better."

Requirements, and treat these as acceptance criteria, not style notes:

1. **Ground it in this business's own playbook.** The PEC Sales Process v3 lives in Drive as `PEC-SALES-003` and its win thesis is "we solve problems". If a copy is not in the repo, ask Cowork to place one at `docs/sales/pec-sales-process-v3.md` and feed it to the model as context; do not paraphrase it from memory.
2. **Ground it in what actually happened on the visit.** When a SalesAsk recording is linked, the opener must reference something real from that conversation (the wife's concern about the garage in summer, the RV pad they mentioned, the timeline they gave). A follow-up that could have been sent to any of the eight estimates is a failure.
3. **Every suggestion advances a decision.** It asks for a yes, a no, or a specific next step with a date. No open-ended "let me know if you have questions", no "just following up", no "wanted to touch base". Put those phrases in a deterministic reject list and regenerate when the model produces them, the same way the drip scrubber already enforces no-em-dashes and no-invented-links.
4. **It states a reason for the call that serves the customer**, not the rep's pipeline: a scheduling constraint, a material lead time, a price validity window, a question left open at the visit.
5. Two lengths per row: a one-line phone opener and a short text draft. Copy-to-clipboard on both. The AI never sends; it drafts for a human, per the standing rule in `pec-lead-ai.cjs`.
6. No em dashes anywhere in this output. It is customer-facing copy the moment a rep pastes it.

## Part E: the view

Top-level **Follow-ups** in the Sales nav group. One shared list, ranked, each row carrying: customer name and company, estimate number and price, days since the last human touch, the engagement chips (viewed 3x, last viewed 2 days ago, called in Tuesday), the lead's Hot/Warm/Cold badge, the why-now line, the suggested opener with a copy button, and inline actions: Call (tel: link), Text, **Log a touch**, Snooze, Open estimate, Mark lost.

Below it, a collapsed **Cold** section for anything past `followup_cold_days`.

Nav badge = the count of live rows (one head-count query at boot, the Ops Queue pattern, not a full render).

**Log a touch** opens a small form: channel, outcome, note body, and a "this counts as outreach" toggle. It writes one `pec_customer_notes` row linked to the customer, the estimate, and the lead. That note then renders on the customer detail page, on the estimate detail page, and on the lead's card and detail in the Sales Pipeline. Dylan explicitly wants to be able to log "they walked into the shop" or "they emailed me directly" from wherever he is, so put the same Log a touch action on the customer page and the estimate page too, not only in the queue.

## Part F: the Slack digest

Once a day, to `SLACK_OFFICE_WEBHOOK` (prompt 49's locked channel; fall back to `SLACK_LEADS_WEBHOOK`, logged no-op when neither is set, matching `pec-lead-intake`): the top N rows with name, price, days quiet, the why-now line, and a TopCoat link. Time and N are settings. Skip the post entirely when the queue is empty rather than sending "nothing to do today" every morning.

## Part G: docs and ship

New features.json entry, SCHEMA.md regenerated, one What's New entry in plain language, tests for: membership rules including every exit condition, the touch matcher agreeing with `leadContactStats` on existing data, the snooze round trip, the reject-list scrubber on suggested copy, and the digest's empty case. Commit and log per standing rules.

## Acceptance criteria

- With 8 sent estimates live, the queue shows the ones past the threshold, in an order Dylan agrees with when he reads the why-now lines. If he disagrees with the order, that is a tuning conversation, not a rebuild: the inputs blob shows exactly why each row ranked where it did.
- Accepting, rejecting, marking lost, or snoozing an estimate removes it from the list immediately, no nightly run required.
- Logging a touch from the queue resets the clock, and the note is visible on the customer page, the estimate page, and the pipeline card without a reload of any other screen.
- No suggested opener contains "checking in", "following up", "touching base", or "let me know if you have any questions", enforced in code, not in the prompt wording alone.
- Every suggestion for an estimate with a SalesAsk recording references something specific from that visit. Spot-check all of them by hand and paste two verbatim into the log entry.
- `npm test` green, `node --check` clean, index.html script blocks parse.

## Do not touch

The Contacted Nx chip's numbers (it keeps counting drips exactly as it does today). The drip engine's schedule, kill switches or wording. `estimates.status` transitions and the status guard trigger. The estimator.
