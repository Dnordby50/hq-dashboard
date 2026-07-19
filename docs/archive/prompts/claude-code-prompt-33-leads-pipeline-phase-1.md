# Claude Code Prompt 33 — Leads pipeline robustness, PHASE 1 of 3

## Context

This is Phase 1 of a three-phase build to make the Leads pipeline more robust and tie its activity into the Metrics dashboard. Dylan's overall ask: track speed-to-lead AND how many times a lead has been contacted on the lead card (auto, from Quo), add automated drip campaigns (leads, estimates, invoices) with a manual blast tool, tie all of it into Metrics, and make the Metrics graphs more visually compelling than today's flat bars.

Cowork scoped the whole thing with Dylan on 2026-07-19 and split it into three phases so nothing ships as one giant risky change. This prompt is **Phase 1 only**: the low-risk, high-visibility foundation. The drip engine (Phase 2) and estimate/invoice drips + manual blast (Phase 3) are NOT in this prompt. Do not build them here. Where a Phase 1 piece will later be extended by Phase 2/3, this prompt says so explicitly.

Repo: the HQ-Dashboard single-file dashboard (`index.html`) plus `netlify/functions/*.cjs`. Deploy is the live Netlify site. Follow all CLAUDE.md standing rules (commit per change, PROJECT-LOG entry, What's New entry for user-facing changes, no em dashes in customer-facing text, consult features.json + SCHEMA.md before searching or writing SQL, token discipline: navigate index.html via features.json anchors + grep, never a full read).

## What Phase 1 delivers

Part A — "Times contacted" count on the lead card and lead detail, derived automatically from the comms logs (NOT from a manual counter).
Part B — AI lead score surfaced and reinforced on the board and lead detail (the field already exists; this makes it prominent and useful).
Part C — Metrics dashboard graph redesign using Chart.js + sparklines, applied to the EXISTING metrics plus one new contact-count stat card.

---

## IMPORTANT data-source correction (read before Part A)

The 2026-07 leads build notes assumed Quo call/text activity lands in `lead_events`. It does NOT. Verified against the live schema and `pec-webhook-quo.cjs`:

- `pec-webhook-quo.cjs` writes CALL events to `public.pec_call_log` (has `direction` in/out, `customer_id`, `quo_call_id`, timestamps) and INBOUND texts to `public.pec_sms_log` (`direction` 'in'). OUTBOUND texts are logged by `pec-send-sms.cjs` into `pec_sms_log` (`direction` 'out'). Emails are in `public.pec_email_log` (one row per send, `sent_at`, `to_email`, `template_key`).
- `lead_events` currently has ~1 row and is effectively unused. Do NOT base the contact count on it.
- These comms logs are keyed by `customer_id` and by phone number/email, NOT by `lead_id`. A lead may not have a `customer_id` yet (it is nullable until conversion). `leads` has `phone_norm` (a normalized phone) and `email`.

So the contact count must be derived by matching the comms logs to the lead. Before writing the query, confirm the exact columns and the normalized-phone shape in SCHEMA.md and in `pec_call_log` / `pec_sms_log` (check whether they store a normalized phone column or raw `from_number`/`to_number` E164). Verify `pec-send-sms.cjs` for how outbound SMS rows are shaped, and `pec-lead-ai.cjs` / `renderLeadDetail` for how a lead is already tied to its customer/phone.

---

## Part A — Times-contacted count (auto, from comms logs)

Goal: on each lead card (board) and on the lead detail page, show how many times WE have reached out to that lead, next to the existing speed-to-lead timer and last-contacted time.

Definition (locked by Dylan): count OUTBOUND touches only. For Phase 1 that means:
- Outbound calls: `pec_call_log` rows for this lead where `direction` = out.
- Outbound texts: `pec_sms_log` rows for this lead where `direction` = out.
- Outbound emails: `pec_email_log` rows for this lead (every row is a send).

Phase 2 will ADD "drip steps sent" to this same tally once the drip engine exists. Structure the count so Phase 2 can add one more source without a rewrite (e.g. a single `countContactsForLead(lead)` helper that sums the sources, with a clearly marked spot to add drip sends later). Do not build any drip send counting now.

Lead-to-log matching:
- If the lead has a `customer_id`, match logs by `customer_id`.
- Also match by normalized phone (`leads.phone_norm` against the log's phone), because a pre-conversion lead has no `customer_id`. Use the SAME normalization the webhook/send paths use so numbers line up (see the `toE164`/`phone_norm` logic; mirror it, do not invent a new one).
- De-dupe so a touch is not counted twice if both `customer_id` and phone match the same row.
- Decide and document whether the count is computed client-side from already-loaded rows or via a small aggregate query in `loadLeadsData`. Prefer the cheaper option; if you add a query, add an index if the planner needs it (flag any new index as a Cowork migration handoff, do not apply it yourself).

UI:
- Board card (`renderLeads`): a small "Contacted Nx" chip beside the speed-to-lead timer. 0 reads "Not contacted" (and should visually echo the same urgency treatment the speed-to-lead timer already uses when a new lead is sitting untouched, so an uncontacted aging lead is obvious at a glance). Keep it compact; the card is dense.
- Lead detail (`renderLeadDetail`): a clearer breakdown, e.g. "Contacted 6 times: 3 calls, 2 texts, 1 email, last on <relative time>". Use `leads.contacted_at` for last-contacted if it is reliably maintained; otherwise derive last-touch from the max timestamp across the matched log rows and note which you used.
- No em dashes anywhere a customer could see. These surfaces are internal (staff-only board), so em dashes are technically allowed per rule 6, but keep the copy plain.

Guardrail: read-only derivation. Do not write to the comms logs, do not add a manual increment button, do not change how the Quo webhook or send paths log.

## Part B — AI lead score, surfaced and reinforced

`leads.score` (integer 1-100) and `leads.ai_analysis` (jsonb) already exist and are populated by `pec-lead-ai.cjs` on new-lead intake and on-demand from the lead detail AI panel (features.json: "Leads pipeline board", "Lead detail with AI game plan"). Dylan explicitly asked for "AI lead scoring as well," so Phase 1 makes the score prominent and actionable rather than rebuilding it.

Do:
- Surface the score as a color-coded badge on every board card (`renderLeads`): a hot/warm/cold band (pick sensible 1-100 cutoffs, document them) with an accessible color treatment that also works in dark mode. If a score badge already exists, upgrade its prominence/legibility rather than duplicating it.
- Add a board sort and/or filter by score (highest-first) so Dylan can work the hottest leads. Reuse the existing board filter/sort mechanism (source/campaign/owner filters already exist); do not fork a new one.
- On lead detail, show the score prominently near the top with the AI's one-line reason from `ai_analysis` if present.

Do NOT:
- Change the AI to auto-send anything. Scoring and analysis stay draft/read-only in Phase 1 (auto-SEND is Phase 2, and even then only for drip copy, never for the score).
- Re-run the model on every render. If you add any re-score trigger, keep it to meaningful events (new lead, manual refresh) exactly as today. If `pec-lead-ai.cjs` already covers this, leave the endpoint alone and only touch the UI.

Confirm current behavior in `pec-lead-ai.cjs` and `renderLeadDetail` before editing so you do not double-wire the refresh.

## Part C — Metrics graph redesign (Chart.js + sparklines)

Goal (Dylan's words): the Metrics graphs are "very blank and just a bar graph"; make them enticing. Locked approach: Chart.js (via CDN) for the big charts, plus small sparklines/gradient meters on the KPI cards. Anchors: `renderMetrics`, `openMetricsDrill`, `pec-metrics-ai.cjs` (features.json: "Metrics and analytics").

Before writing chart code, READ the `dataviz` skill (SKILL.md + references/palette.md) and follow its color/mark/legend guidance and accessibility rules. Do not hand-pick chart colors ad hoc.

Steps:
1. Add Chart.js via CDN. FIRST check whether a Content-Security-Policy is enforced (netlify.toml `[[headers]]` and any `<meta http-equiv="Content-Security-Policy">` in index.html). The grep during scoping found no script-src CSP in netlify.toml, but confirm in index.html too. If a CSP exists, add the CDN origin (e.g. cdn.jsdelivr.net) to `script-src` and `connect-src` in the SAME commit; if none exists, just add the script tag. Pin a specific Chart.js version, do not float `@latest`.
2. Redesign the EXISTING Metrics KPI cards and charts:
   - Keep every existing metric and its drill-through (`openMetricsDrill`) working. This is a visual upgrade, not a data change.
   - Replace flat bars with: a trend line/gradient area chart for Speed-to-lead over time (Dylan wants the trend, not just the current number), price-per-sqft by month, and conversion by source/campaign; give the KPI cards small sparklines or gradient meters showing recent movement.
   - Preserve light AND dark mode (the dashboard supports both). Verify chart text/gridlines are legible in both.
   - Keep the existing time-window + salesperson filters driving the charts.
3. Add ONE new stat card in the Sales section: contact-count stats, e.g. average outbound touches to convert (lead reached `accepted`) and to book. Derive from the same matching logic as Part A over won leads in the window. If the data is too thin to be meaningful, show a graceful "not enough data yet" state rather than a broken chart.

Do NOT add drip-performance or blast-performance metric cards in Phase 1 — that data does not exist until Phases 2 and 3. Leave a clearly commented placeholder in the Sales section where those cards will slot in, so Phase 3 is a drop-in.

Guardrails: do not change what any metric MEANS or how it is computed; do not touch `pec-metrics-ai.cjs`'s AI read logic beyond styling its container; do not break the drill modals (remember the two-modal-root gotcha in CLAUDE.md if any chart opens in a modal).

---

## Verification (before commit)

- Run the production suites (`npm test` targets: 187 calculator + 142 estimate) and confirm still green; Phase 1 should not touch calculation logic, so any change there is a red flag.
- `node --check` every `.cjs` you touch; confirm all inline index.html script blocks still parse (module-aware extraction, importmap validated as JSON) exactly as prior prompts did.
- Manually reason through the contact-count matching on paper for: a lead with a customer_id and matching phone (must not double-count), a pre-conversion lead with only a phone, and a lead with zero touches (must read "Not contacted", not error).
- Confirm Chart.js loads with no CSP console errors in both light and dark mode, and every existing drill-through still opens.
- `help/whats-new.json` validates; add entries per below.
- Zero em dashes in any customer-facing string (these surfaces are internal, but keep the discipline).

## Ship

- Commit in logical units (Part A, Part B, Part C can be separate commits so any one can revert alone), `<area>: <what>` format.
- What's New: add entries for the user-visible changes (contact count on leads, score badge/sort, redesigned Metrics graphs). Plain language, 2-3 how-to steps each, no em dashes, newest first.
- Update features.json for the "Leads pipeline board", "Lead detail with AI game plan", and "Metrics and analytics" entries if their code anchors or behavior changed.
- PROJECT-LOG entry per the template, `By: Claude Code`, describing what shipped, the contact-count matching decision you landed on, and explicitly noting Phase 2/3 are not yet built.
- If you added any DB index, that is the ONLY Cowork handoff (migration apply + SCHEMA.md regen). Everything else in Phase 1 is code you can ship directly. No prod data changes.

## Explicitly OUT of scope for Phase 1 (do not build)

- Any drip engine, scheduled function, drip tables, or auto-send logic.
- Estimate or invoice follow-up automation.
- The manual blast tool.
- Drip/blast performance metric cards (leave the commented placeholder only).
- Any change to the Quo webhook or the SMS/email send paths.
