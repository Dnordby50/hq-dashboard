# Claude Code Prompt 14: What's New system (sign-in popup + Help history + auto-written entries)

## Context

Dylan wants CRM updates communicated automatically: a popup at sign-in summarizing what changed, and a browsable history in the Help section, so the crew trains itself and nobody has to announce features by hand. Scoped by Cowork on 2026-07-09 through 11 decisions. Repo: HQ-Dashboard, main.

RUN ORDER: Dylan wants this BEFORE prompt 13. Fine, BUT prompt 13's live test fixture (the $1 pending ACH on job 63c361be) settles around Jul 14-16 and vanishes. Run 14 and 13 back to back in the same sitting so 13 still has the fixture.

## Dylan's decisions (all final)

1. Entries are AUTO-WRITTEN by Claude Code: every user-facing change ships with a plain-language changelog entry in the same session. This becomes a STANDING RULE; add it to CLAUDE.md (see below).
2. Entry format: one-line summary plus 2 to 3 how-to steps (where it lives, how to use it). Plain language for the crew, no jargon, no em dashes.
3. One entry per shipped feature, dated. The popup stacks all unseen entries, newest first.
4. Backfill roughly the last 30 days of user-facing changes from PROJECT-LOG.md (see backfill list below).
5. No audience filtering; everyone sees everything.
6. Seen tracking is PER USER in the database with acknowledgment: a "Got it" button records who acked which entries, works across devices. Track silently; NO admin report UI (data is queryable when Dylan wants it).
7. Popup: modal at sign-in when unseen entries exist, "Got it" marks all shown entries acked, plus a "See all updates in Help" link. No snooze. Never block sign-in: any fetch/ack failure degrades to no popup, silently.
8. Full history lives in a "What's New" card at the top of the existing Help view, AND the Help assistant can answer questions about new features (single source; prefer feeding the same content to the assistant at runtime over duplicating text into help/crm-help.md).
9. No Slack or email announcements. In-app only.
10. Content lives in a JSON file in the repo (ships with each deploy, typo fixes are commits). Only the ack tracking needs a DB table.
11. Ships before prompt 13 (with the timing caveat above).

## Build notes

- Content file: help/whats-new.json (or sibling; match the crm-help.md fetch pattern, cache no-cache). Array of entries: stable id (slug), date (YYYY-MM-DD), title, summary (one line), howto (array of 2-3 short strings). Newest first.
- Migration (idempotent, verify queries at bottom, Cowork applies): ack table keyed on (user, entry_id text) with unique constraint and acked_at. Mirror the app's existing per-user identity pattern (look at how user_permissions rows map to logged-in staff) and give it the narrowest RLS that lets a signed-in staff user insert/select their OWN acks; no update/delete policy needed. Deploy-order safety: missing table = no popup, never an error.
- Sign-in hook: after auth + staff resolution, fetch the JSON and the user's acks (one batched query), diff, and open the modal via openModal/#pecModalRoot (NOT the prod modal root) when unseen entries exist. "Got it" upserts ack rows idempotently (on conflict do nothing); double-click safe; failure degrades silently.
- Help view: "What's New" card at the top listing all entries with dates, always accessible regardless of ack state.
- Help assistant grounding: include the entries in what the assistant reads (its backend is netlify/functions/sop-chat.js / the crm-help fetch at ~23036; choose the cleanest single-source path and justify in your log entry).
- STANDING RULE for CLAUDE.md (add verbatim under Standing Rules): "Every user-facing change ships with a What's New entry: append one entry (id, date, title, one-line summary, 2-3 how-to steps, plain language, no em dashes) to the changelog JSON in the same session. Internal-only changes (refactors, webhooks, migrations with no visible behavior change) do not get entries."
- BACKFILL (~last 30 days, from PROJECT-LOG.md; write for the crew, not for engineers). Candidates, pick the user-facing ones: change orders from the job page with scope + customer signature links (prompt 12); ACH bank payment option on invoices (prompt 11); itemized subcontractor expenses + subcontracted-job flag on Job Costing (prompt 10); call summaries and transcripts on customer profiles (Quo); two-way texting + text invoice; Team Members management in Settings + submit-for-review costing flow (prompt 8); Last-invoiced column + cancelled/archived jobs section (prompt 9); estimator beta if user-visible. Skip pure infra (wedge fixes, webhook plumbing, RLS).
- Standing rules apply: commit per meaningful change, node --check extracted blocks, no em dashes, PROJECT-LOG entry on top, migration NOT applied from your session.

## Handoff to Cowork (put in your log entry)

1. Apply the ack-table migration to PROD, run verify queries, report results.
2. Post-deploy verify with Dylan: sign in as Dylan (unseen backfill entries exist) and confirm the popup stacks them newest first; click Got it; refresh and confirm no popup; open Help and confirm the What's New card lists everything; ask the Help assistant a question about a new feature (e.g. how do I add a change order) and confirm it answers from the new content; have one non-admin (Aron or a PM) sign in and confirm they get the popup once.

## Handoff to Dylan

Run prompt 13 immediately after this one deploys, before the $1 test ACH settles.
