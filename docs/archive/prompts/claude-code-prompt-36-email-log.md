# Claude Code Prompt 36: Email Log (global view + record embeds + full-body capture)

Repo: /Users/dylannordby/Claude-Code/HQ-Dashboard
Deploy: https://prescottepoxy.netlify.app
Supabase project: "HQ Dashboard" (zdfpzmmrgotynrwkeakd)

## Context

Every email the system sends already writes a row to `pec_email_log` (24 rows in prod today). The transactional pipeline `pec-send-email.cjs` writes one row per send (template mode and compose mode), and `pec-webhook-resend.cjs` (Svix-verified Resend webhook) PATCHes those rows by `resend_id` on `email.delivered / opened / clicked / bounced / complained`, setting `status` plus `opened_at / clicked_at / bounced_at`. Drip and blast emails mirror into `pec_email_log` too, with `template_key` `'drip'` / `'blast'`; their full rendered body already lives in `pec_drip_sends.body` (join `pec_email_log.resend_id = pec_drip_sends.provider_id`).

The gap: there is no single place to see all of this. The data is only visible scattered across the per-invoice Communication history (`renderInvoices`), the per-lead timeline, and per-customer views. Dylan wants one Email Log he can scan and filter by customer ("what did we send this customer"), plus the same log embedded at the bottom of the customer and job detail pages, and he wants to be able to read the full body of what was sent.

Dylan's locked decisions (Cowork scoping, 2026-07-20):
- Placement: a NEW top-level "Email Log" view, AND embed the record's email log at the bottom of the customer detail page and the job detail page.
- Layout: one global list, newest first, with a customer search/filter (not grouped-by-customer).
- Body: he wants to read the actual email that went out. Capture the transactional body going forward; pull drip/blast bodies from the existing `pec_drip_sends.body`. Historical rows that predate capture show a clear "body not captured" note.
- Delivery detail: show opens / clicks / bounces (the Resend webhook already feeds these).
- Visibility: all signed-in staff (same as the Messages tab). No owner gating.
- Brand: PEC only for now. Do NOT add a brand filter to the UI. (There is a separate FTP brand gap noted below; out of scope here.)

## Reference facts (verify against SCHEMA.md before writing SQL/selects)

- `pec_email_log` columns: `id, sent_at (no created_at), sent_by_user, job_id, customer_id, brand, template_key, to_email, from_email, subject, status ('queued' default), resend_id, opened_at, clicked_at, bounced_at, error_message`. Timestamp is `sent_at`, NOT `created_at`.
- `customer_id` and `job_id` on `pec_email_log` have NO FK constraint declared, but joins work. `sent_by_user` maps to `admin_users.id` (has a display name); `admin_users.auth_user_id -> auth.users.id`.
- `pec_drip_sends` columns include `channel ('sms'|'email'), status, subject, body, provider_id, blast_id, lead_id, subject_type, subject_id`. Email drip/blast bodies are here. `provider_id` is the Resend id.
- supabase-js does NOT throw on a nonexistent column; it returns `res.error` with empty data. If a read comes back empty, check `res.error` first.
- Two modal roots: `#pecModalRoot` (openModal/closeModal, ~index.html:4808) and `#prodModalRoot` (hand-rolled prod flows). If you use a modal for the row detail, use the `pecModalRoot` helpers (this is an HQ-side view).
- Token discipline: do not read index.html end to end. Navigate via features.json anchors + grep. Useful existing anchors: `renderInvoices` (already renders a per-invoice comms history off `pec_email_log` and delivery status; reuse its status-badge and row rendering), `renderMessages` (the texts/calls tab; mirror its list/detail interaction pattern and all-staff gating), `renderCustomerDetail` / the customer detail renderer, and the job detail renderer.

## Tasks (in dependency order)

### 1. Migration: store the transactional body (Claude Code writes it; Cowork applies it)
Write `supabase/migrations/2026-07-20_email_log_body.sql`, additive and idempotent:
- `ALTER TABLE pec_email_log ADD COLUMN IF NOT EXISTS body_html text;`
- Add a verify query at the bottom (column present, nullable).
Do NOT apply it yourself; it goes in the Cowork handoff. After it is applied, SCHEMA.md gets regenerated (Cowork, per rule 9). The view code must degrade cleanly before the column exists (treat a missing `body_html` as null, show the "not captured" note), so deploy order is safe either way.

### 2. Capture the body in `pec-send-email.cjs`
The final wrapped HTML is built around line ~223 (`let subject, bodyHtml;` then `wrapInChrome(...)`). On the successful-send path, write the final wrapped HTML into `pec_email_log.body_html` in the same insert (`logRow`). Keep it best-effort: storing the body must NEVER fail or delay the send (the log write is already wrapped best-effort; keep that contract). For the failed-send path, storing the attempted body is optional; null is fine. Do not store the body for drip/blast rows here (those don't flow through this compose/template insert; their body is already in `pec_drip_sends`).

### 3. New "Email Log" view (all staff)
Add a top-level nav item "Email Log" gated the same way the Messages tab is (any signed-in staff). Global table, `pec_email_log` ordered `sent_at` desc, paginated/capped sensibly (e.g. 200 with load-more; do not pull the whole table unbounded). Columns:
- Sent (relative + absolute on hover, `sent_at`)
- To (`to_email`)
- Customer (name linked to the customer detail page when `customer_id` present; else the raw `to_email`)
- Type (humanize `template_key`: invoice / estimate / document / compose / drip / blast / etc.)
- Subject
- Status (reuse the delivery-status badge from `renderInvoices`: queued/sent/delivered/opened/clicked/bounced/complained/failed, colored; failed/bounced/complained read red)
- Sender (`sent_by_user` -> `admin_users` display name; blank for system sends like drips)

Controls above the table:
- Customer search box (match `to_email` and, via join, customer name).
- Type filter, status filter, and a date range (native date inputs, no library, consistent with the Metrics custom picker).

Row click opens a detail panel/modal (use `pecModalRoot`) showing all metadata plus the full body:
- If `body_html` is set, render it (sandboxed: render into an isolated container or `srcdoc` iframe so customer HTML/CSS cannot break the app shell).
- Else if `template_key` in ('drip','blast'), fetch `pec_drip_sends` where `provider_id = resend_id` (fallback match: `subject` + `customer_id`/`lead_id` + nearest `sent_at`) and render its `body` as plain/preformatted text.
- Else show: "Body not captured (sent before email-body logging was added)."

### 4. Embed on customer detail and job detail
At the BOTTOM of the customer detail page and the job detail page, add an "Emails" section:
- Customer detail: `pec_email_log` where `customer_id = <customer>` ordered `sent_at` desc.
- Job detail: `pec_email_log` where `job_id = <job>` ordered `sent_at` desc.
- Same compact row rendering and same row-click-to-body detail as the main view. Read-only. Empty state: "No emails sent yet."
Reuse a single shared render helper for a log row + detail so the main view and both embeds stay in sync.

### 5. Standing-rules chores
- `features.json`: add an "Email log" feature entry (or extend the "Resend email pipeline" entry) with the new indexHtml anchors, `pec_email_log` / `pec_drip_sends` tables, and `pec-webhook-resend.cjs`. Update the entry's code anchors if you rename anything.
- `help/whats-new.json`: one user-facing entry (id, date 2026-07-20, title, one-line summary, 2-3 plain steps, no em dashes) telling staff where the Email Log lives and that they can open any email to read exactly what was sent.
- No em dashes in any new UI copy or the What's New entry (rule 6). Customer email subjects/bodies are passthrough content and are exempt (do not rewrite them).
- Verify: `node --check` on `pec-send-email.cjs`; confirm every inline `<script>` block in index.html still parses; `npm test` stays green (the calculator/estimate suites); `whats-new.json` and `features.json` validate. There is no dedicated test harness for this UI; do the parse/lint checks and a manual read-through of the query filters.

## Preflight (do these BEFORE building, they change the work)

1. "Every email" audit. Confirm which code paths actually send email and whether each writes `pec_email_log`. `pec-send-email.cjs` is the main one. Also check `pec-notify-costing-sendback.cjs` and any `pec-webhook-*` that emails, plus password-reset (Supabase auth emails are NOT logged and are out of scope, but note it). If a real customer/staff email path sends WITHOUT logging, either add a `pec_email_log` write or explicitly list it in the log entry as a known gap so "every email" is honest.
2. Confirm the Resend delivery/open/click plumbing is real end to end: `pec-webhook-resend.cjs` needs `RESEND_WEBHOOK_SECRET` set in Netlify AND the webhook configured in the Resend dashboard with open/click tracking enabled. This is a Cowork/Dylan config check (put it in the handoff); if opens/clicks are not actually flowing yet, the column still renders correctly, it just shows "delivered" until tracking is on. Do not block the build on it.
3. Re-grep to confirm `renderInvoices` is still the canonical `pec_email_log` reader you should mirror for the status badge, and that the Messages tab gating is the pattern to copy for all-staff access.

## Commit + log (per CLAUDE.md)

- Commit in revertable units (migration; sender body capture; the view; the two embeds; docs). Format `email-log: <what>`. Never `git add .`.
- Append a PROJECT-LOG entry at the TOP (By: Claude Code) describing what shipped, files touched, the body-source split (transactional captured going forward vs drip/blast from the ledger), and the honest state of the 24 historical rows.
- End with a `## Handoff to Cowork` section: apply `2026-07-20_email_log_body.sql` to prod + run its verify query + regenerate SCHEMA.md; and verify the Resend webhook config (secret + tracking enabled) so opens/clicks flow.

## Out of scope (do not build)
- No brand filter / no FTP support in this view (PEC only for now).
- Do NOT change the intake's hardcoded `brand: 'PEC'` here (tracked separately).
- No SMS in this view (email only; the Messages tab already covers texts/calls).
- No backfill of bodies for the 24 historical rows.
