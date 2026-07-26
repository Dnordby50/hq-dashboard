# Claude Code prompt 49: Follow-up queue, human-touch tracking, AI priority ranking

## Context

Dylan's ask (2026-07-26): "In the leads pipeline we need a way to be able to track who needs to be contacted and how many times I've contacted them a little bit better, also with an AI suggestion of which leads are hottest to follow up on."

Read before you start: CLAUDE.md, the top 3 entries of PROJECT-LOG.md, features.json entries "Leads pipeline board", "Lead detail with AI game plan", "Lead drip engine", "Metrics and analytics", and SCHEMA.md for `leads`, `estimates`, `pec_call_log`, `pec_sms_log`, `pec_email_log`, `pec_drip_sends`, `pec_estimate_views`.

What already exists (do not rebuild it):
- `leadContactStats()` / `loadOutboundTouchLogs()` (index.html ~20369-20440) derive a lifetime "Contacted Nx" count per lead from outbound calls, texts, emails and the drip/blast ledger.
- `leadScoreBadge()` / `leadScoreBand()` (~20261-20302) render Hot/Warm/Cold from `leads.score` (70/40 cutoffs), written by `pec-lead-ai.cjs` at intake and on the detail page's Refresh button.
- The lead detail page shows an Outreach line and an AI game plan.
- The drip engine already sends automated follow-ups on its own schedule.

What is MISSING and is the whole point of this prompt: nothing in the system says **this lead is overdue for a HUMAN touch right now, and here is why**. `leads.score` is a snapshot of intake quality that never moves. The contact count is a lifetime total with no decay clock. And any call Dylan makes from his personal cell, or any in-person conversation, is invisible to every count, which makes a worked lead look neglected.

Build a follow-up queue, not another badge.

---

## Locked decisions (Dylan answered these; do not re-litigate)

1. **Due logic:** deterministic staleness rules decide WHO is in the queue; AI decides the ORDER within it. The queue must never depend on the AI for coverage.
2. **Placement:** a new top-level **Follow-ups** view in the existing Leads nav group. Not a rail on the kanban, not a home card.
3. **Manual touch logging:** yes. A "Log a touch" action that records off-system contact and resets the overdue clock.
4. **Drips do NOT count** toward the overdue clock. The clock answers "when did a PERSON last reach out." The existing lifetime Contacted Nx chip keeps counting drips exactly as it does today (do not change its numbers).
5. **AI ranking weighs intent + value + decay:** intake score, deal value where known, engagement signals (inbound replies, estimate views), and time decay. The question it answers is "who is most likely to close if a human calls them today," not "who looked best at intake."
6. **Nightly rank run**, open subjects only, plus a manual re-rank button.
7. **Full working rows:** why-now reason, suggested opener, one-tap Call / Text / Log touch / Open actions inline.
8. **One shared queue** for all staff. No per-owner default filter.
9. **Scope:** open leads **and** sent estimates awaiting a decision.
10. **Notification:** in-app nav badge count **and** a daily Slack digest. No bell rows, no email digest.
11. **Cold tail:** subjects untouched past a configurable number of days move to a separate collapsed "Cold" section rather than burying the live list.
12. **Ship as one build.** Prompt 34 (metrics/costing/bonus) is still unrun and is NOT a blocker for this.

---

## Part A: schema

New migration `supabase/migrations/2026-07-26_followup_queue.sql`, with the `@artifacts` header per standing rule 13. Apply to prod, then regenerate SCHEMA.md.

### A1. `public.pec_lead_touches` (manual touch log)

```
id            uuid pk default gen_random_uuid()
lead_id       uuid not null references leads(id) on delete cascade
channel       text not null check (channel in ('call','text','email','in_person','other'))
note          text
occurred_at   timestamptz not null default now()
logged_by     uuid                       -- auth.uid() of the staff member
created_at    timestamptz not null default now()
```
Index on `(lead_id, occurred_at desc)`.

RLS: staff (`is_admin_staff()`) may SELECT and INSERT. UPDATE/DELETE restricted to `is_admin_role()` (a mistyped touch needs to be fixable, but this is an audit-ish trail). Anon denied on everything. Verify anon is denied before you call it done.

### A2. `public.pec_followup_ranks` (nightly AI output)

```
id             uuid pk default gen_random_uuid()
subject_type   text not null check (subject_type in ('lead','estimate'))
subject_id     uuid not null
lead_id        uuid                       -- always populated when derivable, for joins
priority       integer                    -- 1-100
reason         text                       -- one sentence, why THIS one now
opener         text                       -- suggested first line, customer-safe
channel_hint   text check (channel_hint in ('call','text','email'))
source         text not null default 'ai' check (source in ('ai','fallback'))
model          text
computed_at    timestamptz not null default now()
```
Unique index on `(subject_type, subject_id)`; each run upserts. Index on `(computed_at desc)`.

RLS: staff SELECT. INSERT/UPDATE by the service role only (the scheduled function writes it). Anon denied.

### A3. Settings keys (standing rule 12, all seeded in the migration)

| key | default | meaning |
|---|---|---|
| `followup_enabled` | `true` | master switch for the whole feature |
| `followup_overdue_hours_new` | `1` | a `new` lead is overdue this many hours after `created_at` with no human touch |
| `followup_overdue_days_contacted` | `3` | `contacted` stage, days since last human touch |
| `followup_overdue_days_estimate_sent` | `3` | `estimate_sent` stage |
| `followup_overdue_days_presented` | `2` | `presented` stage |
| `followup_estimate_overdue_days` | `3` | a SENT estimate with no decision, days since send or last human touch |
| `followup_cold_after_days` | `30` | no human touch for this long, move to the Cold section |
| `followup_ai_rank_enabled` | `true` | off = deterministic fallback ranking only |
| `followup_ai_rank_limit` | `60` | max subjects sent to Claude per nightly run |
| `followup_slack_digest_enabled` | `true` | daily digest on/off |
| `followup_slack_digest_top_n` | `10` | how many rows in the digest |

All of these are edited from a new **Settings > Follow-ups** panel (`renderSettingsFollowups`), mirroring the shape of `renderSettingsDrips` / `renderSettingsAppointments`.

---

## Part B: the rules module (single source of truth)

Create `production/followup-rules.cjs`, a pure module with no I/O, exporting:

- `lastHumanTouchAt(subject, touchSources)` — the max of: matched outbound calls, outbound texts where `kind` is NOT `drip`/`blast`, outbound emails where `template_key` is NOT `drip`/`blast`, and `pec_lead_touches.occurred_at`. **Drip ledger rows are excluded entirely.**
- `isOverdue(subject, lastHumanAt, settings, now)` → `{ overdue: bool, dueSince: iso, thresholdLabel: string }`
- `isCold(lastHumanAt, createdAt, settings, now)` → bool
- `fallbackPriority(subject, signals)` → 1-100, deterministic. Rough shape: stage weight × days-overdue decay, plus intake score, plus a value bump when an estimate amount exists, minus an age penalty. Document the formula in a comment.
- `dedupeSubjects(leadRows, estimateRows)` — when a lead is due AND one of its sent estimates is due, keep **only the estimate row** (it is the more specific ask) and carry the lead's context onto it.

The netlify function `require()`s this module directly. index.html cannot `require`, so it carries a **mirror** of these functions, following the existing precedent of `pecInstallmentAsk` mirroring `_pec-installments.cjs` (see the "Deposits and payment schedules" feature entry). Put a comment at the top of BOTH copies naming the other as its twin, and add `production/followup.test.cjs` covering: overdue per stage, never-contacted new lead, drip send does NOT reset the clock, manual touch DOES reset it, cold cutoff, lead+estimate dedupe, fallback ranking ordering.

**Why the client recomputes instead of reading a precomputed queue:** the queue must stay correct through the day as Dylan logs touches and makes calls. The nightly function computes the same rules server-side only to pick which subjects to send to Claude and to build the Slack digest. The settings row is what keeps the two copies agreeing on numbers.

---

## Part C: the Follow-ups view

New view `followups`, registered in `switchView` under the **Leads** nav group, visible to all staff. Function `renderFollowUps()` in index.html.

### C1. Data load

Reuse `loadOutboundTouchLogs()` but **extend it** to also fetch `pec_lead_touches` and to keep drip rows separable. Refactor `leadContactStats()` so its returned per-lead stat object gains `humanTotal`, `humanLastAt`, `manual` (count of `pec_lead_touches` rows) alongside the existing `calls/texts/emails/drips/total/lastAt`. **`total` and `lastAt` must keep their current meaning** so the kanban chip and the Metrics Outbound-touches card do not silently change; add the new fields, do not repurpose the old ones.

Also load: open leads (stage not in accepted/lost, `deleted_at` null), sent-and-undecided estimates, `pec_estimate_views` counts, active drip enrollments (for an informational chip only), and the latest `pec_followup_ranks` rows.

### C2. Layout

Header: three counts (Due now / Overdue over 7 days / Cold), the timestamp of the last AI rank run, and a **Re-rank now** button (admin only) that POSTs to `pec-followup-rank` with the staff JWT.

Then two sections:
1. **Needs contact** — ranked descending by `pec_followup_ranks.priority`, falling back to `fallbackPriority` for any subject with no rank row (never hide a due subject because the AI has not seen it yet).
2. **Cold** — collapsed by default, count in the header, same row shape.

Honest empty state when nothing is due. Honest notice when the migration has not been applied yet (match how the drip cards degrade).

### C3. The row

Each row shows:
- Name, brand, stage chip, source badge (reuse `LEAD_SOURCE_COLORS` / `leadSourceLabel`).
- Priority badge, colored with the existing `leadScoreBand` bands so 70/40 keeps one meaning across the app.
- **The clock, in words:** "No human contact in 6 days" or "Never contacted, 14 hours old". This is the headline fact, make it prominent.
- Touch breakdown chip: `3 calls · 2 texts · 1 email · 1 logged` and, separately and visually quieter, `4 drip`. Human and automated touches must read as different things.
- A small `Drip active` chip when an enrollment is live, so nobody is surprised that automation is also messaging this person.
- AI reason line ("viewed the estimate twice, no reply in 4 days").
- The suggested opener in a copyable box.
- Actions inline: **Call** (`tel:` via `pecPhoneActionsHtml`), **Text** (`pecOpenTextTo`), **Log touch**, **Open lead**. Estimate rows additionally show the amount, sent date, view count, and **Open estimate**.

### C4. Nav badge

The Leads group's Follow-ups entry carries a count badge of subjects in **Needs contact** (Cold excluded). Compute it on the same load; refresh when the view is opened and after any touch is logged. Do not add a bell notification row and do not add a home-screen card.

---

## Part D: Log a touch

A modal (`openLogTouchModal(leadId, opts)`) using the shared `openModal` / `closeModal` helpers:
- Channel: Call / Text / Email / In person / Other.
- When: defaults to now, editable (he will log yesterday's call the next morning).
- Optional note.
- Saves to `pec_lead_touches` with `logged_by = auth.uid()`, writes a `lead_events` row of type `manual_touch` so it lands in the activity timeline, then refreshes the calling view.

Entry points: the Follow-ups row, and the lead detail page's Outreach section. **Leave the kanban card alone** to keep this build contained.

The lead detail Outreach line must include manual touches in its breakdown and its last-touch time, and must distinguish human from drip touches the same way the queue does.

---

## Part E: the nightly rank function

New `netlify/functions/pec-followup-rank.cjs`, scheduled in netlify.toml at `15 13 * * *` (06:15 MST, before the day starts and after overnight activity, ahead of the 07:00 drift check).

Behavior per run:
1. No-op immediately if `followup_enabled` is false.
2. Compute the due set server-side with `production/followup-rules.cjs`.
3. If `followup_ai_rank_enabled` is true, rank with Claude. **Batch the subjects, do not make one call per lead:** chunk the due set (cap `followup_ai_rank_limit`) into groups of ~25 and send each group as ONE request that returns an ordered array. This is a deliberate cost decision; a per-lead call buys depth the queue does not use.
4. Upsert `pec_followup_ranks` (`source = 'ai'`). On any AI failure, write `fallbackPriority` results with `source = 'fallback'` and log it. **The run must never leave the table empty.**
5. If `followup_slack_digest_enabled`, post the top N to `SLACK_OFFICE_WEBHOOK` (same env var `pec-security-monitor.cjs` uses): one line per subject with name, stage, days since human contact, and the AI reason. Best-effort, never throws.

Per-subject input to the model: name, stage, source, campaign, days since created, days since last human touch, human touch counts by channel, drip touch count and whether a drip is active, inbound signals (inbound text/call count and last inbound at), estimate context where present (amount, sent date, view count, last viewed), any booked or upcoming appointment, intake score and `score_reason`, city, and trimmed notes.

Model output per subject, strict JSON: `{ subject_id, priority (1-100), reason, opener, channel_hint }`.

Model guardrails, non-negotiable:
- Ground every claim in the supplied data. Never invent a fact, a price, a promise, or a link.
- `opener` is customer-facing: **no em dashes** (standing rule 6), under 200 characters, no links, no prices unless the input carried one. Run it through the same scrub the drip engine uses (reuse the helper in `_pec-drip.cjs` if it is exportable; extract it if it is not, do not fork a second copy).
- `reason` is internal and must cite a specific input fact.
- The AI never contacts anyone. This function writes rows a human reads. Keep it that way (same standing decision as `pec-lead-ai.cjs`).

Auth: the scheduled invocation is recognized by Netlify's `{ next_run }` body, as in `pec-migration-drift.cjs`. The manual path requires a staff JWT via `requireStaff()`. Do not ship an unauthenticated `?manual=1`.

---

## Part F: optional, Dylan's call (delete this section before pasting if he says no)

**Snooze.** Without it, a lead who says "call me in October" stays permanently overdue, and the only ways out are logging a fake touch or marking them lost. If Dylan wants it: a `snoozed_until timestamptz` column on `leads` plus a "Not now, remind in ___" action on the row that sets it. Snoozed subjects drop out of Needs contact until the date, shown in a small "Snoozed (n)" chip in the header.

---

## Part G: wrap-up (standing rules)

- `features.json`: one new entry for the Follow-up queue; update the "Leads pipeline board", "Lead detail with AI game plan" and "Metrics and analytics" entries where their behavior changed.
- `help/whats-new.json`: one user-facing entry, plain language, no em dashes, 2-3 how-to steps.
- Regenerate `SCHEMA.md` after applying the migration.
- `PROJECT-LOG.md`: entry at the top, and a `## Handoff to Cowork` section if anything needs verifying in a third-party UI.
- Commit per standing rule 1, named files only.
- Tests: `npm test` must pass with the new `production/followup.test.cjs`.

## Acceptance

1. A brand new lead with no touches appears in Needs contact within an hour of arriving, reading "Never contacted".
2. A drip message going out to that lead does NOT remove it from the queue and does NOT reset its clock, while the kanban Contacted Nx chip still counts that drip exactly as it does today.
3. Logging a touch on it removes it from the queue immediately and appears in the lead's activity timeline.
4. A lead whose estimate was sent 4 days ago with no decision appears ONCE (the estimate row), showing the amount and the view count.
5. Turning `followup_ai_rank_enabled` off still produces a fully ordered queue.
6. Every threshold above is changeable from Settings > Follow-ups with no code change.
7. Anon is denied on both new tables; verify, do not assume.
