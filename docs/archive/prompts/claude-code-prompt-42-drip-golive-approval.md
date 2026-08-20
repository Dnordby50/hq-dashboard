# Prompt 42 — Drip go-live with a human approval gate, Settings pause + quiet hours, and a lead-card drip section

## Context

The lead drip engine (Phases 1-3, prompts 33-35) is built and deployed. `pec-drip-runner.cjs` is on Netlify's every-15-min schedule; the master switch (settings key `drip_sending_enabled`) is seeded `false`, and all three campaigns (lead, estimate, invoice) are still `dry_run`, so nothing has ever sent.

Dylan wants to go **live on all three campaigns**, but with a **supervised launch**: for roughly the first week, every drip message is held for a human (Anne) to review, edit, and approve before it sends. After that week Dylan will manually flip the approval gate off and let it run fully automatic. This prompt builds the approval gate, the review surface, the Settings controls, and the lead-card view. It does NOT flip anything live in code — that is a Cowork config step after this ships.

Repo: `/Users/dylannordby/Claude-Code/HQ-Dashboard` (single-file dashboard `index.html` + Netlify functions). Deploy: the live Netlify site.

Key anchors (read these, do not full-read index.html):
- `netlify/functions/_pec-drip.cjs`: `runDrips` (~618), `quietHours(now)` (~94), per-campaign `mode` `dry_run`/`live` logic, `resolveRecipient` (~457), kill-switch checks (`checkReplied` ~552, `checkKillSwitches` ~570), `endEnrollment` (~596), `masterSwitchOn` (~604). The runner already defers late SMS at ~686.
- `netlify/functions/pec-drip-runner.cjs`: the thin scheduled entry (runDrips + drainBlasts).
- `index.html`: `renderDrips` (~19358, master-switch upsert ~19611), `renderSettings` (~15708, settings upsert ~15870, `data-settings-tab` tabs), `renderLeadDetail` (~20441) with the existing `dripCard` and the `drip_send` timeline case in `leadEventHtml` (~20402), the view route map (~7274) and the admin nav buttons (~2498-2517).
- `SCHEMA.md`: `pec_drip_sends` (~711; status CHECK `pec_drip_sends_status_check` in `queued','sending','sent','failed','skipped','dry_run` ~736), `pec_drip_enrollments` (~689), `pec_drip_campaigns` (~672). Settings live in `public.settings` (key/value text rows).

## Locked decisions (Dylan, 2026-07-21)

1. **Approval gate = one global setting** `drip_approval_required` (bool text row, treat as `true` at launch). When ON: a due step renders the AI copy exactly as it does today, but instead of calling a provider it **persists a pending-approval send row and does NOT advance the enrollment** — nothing reaches the customer until a human approves. When OFF: current Phase-3 behavior (live campaigns auto-send). The gate is GLOBAL and intercepts even `live` campaigns. This is what makes "all three live" safe on day one.

2. **Dedicated approvals queue** — a new admin view "Drip Approvals" listing every pending draft across all leads/jobs (newest first). Each row shows recipient (name + masked channel target), campaign + step, channel, and the **editable** body (plus subject for email). Per-item actions:
   - **Approve & Send** — sends the (possibly edited) message via the same providers the runner uses, logs status `sent`, then advances the enrollment exactly as an auto-send would.
   - **Edit** — inline edit of body/subject, persisted to the pending row before sending.
   - **Skip this step** — advances the enrollment to the next step without sending (marks the pending row `skipped`).
   - **Stop drip** — ends the enrollment (reuses the existing stop path).

3. **Settings controls** — a new "Drips" section/tab in company **Settings** (`renderSettings`), every knob a `settings` row so Dylan/Anne adjust without code edits:
   - Master on/off, mirroring `drip_sending_enabled` (keep it in sync with the existing admin Drips view toggle).
   - Approval gate on/off (`drip_approval_required`). This is the switch Dylan flips after the supervised week.
   - Quiet-hours window: start/end time (default 08:00-20:00 America/Phoenix) and days (default Mon-Sat). **Make the existing `quietHours()` read these settings** instead of the hardcoded 8-20. Master + quiet hours only; **NO per-campaign pause**.

4. **Lead-card drip section** — expand the existing `dripCard` in `renderLeadDetail` into a dedicated section showing: (a) current enrollment status, (b) messages already sent / pending for this lead with full body (keep the expandable `<details>` pattern), and (c) the **upcoming** scheduled steps — the next touch and the remaining steps with their planned dates. Dylan explicitly asked for a section that shows what is coming, not just what already went out.

5. **New CLAUDE.md standing rule** (add under Standing Rules): "Every major feature ships with a settings surface. Its key parameters (on/off, timing, limits, thresholds, quiet hours) must be adjustable from company Settings, backed by the `settings` table, with no code change required." Dylan hardwired this on 2026-07-21.

## Implementation notes / gotchas

- **Pending status:** prefer extending the `pec_drip_sends` status CHECK with a `pending` (or `pending_approval`) value via a migration under `supabase/migrations/` rather than overloading `queued`. If you add a value, that migration is a Cowork handoff (standing rule 9): Cowork applies it to prod and regenerates SCHEMA.md. If you can cleanly reuse `queued` instead, do that and skip the migration — document whichever you choose.
- **Idempotency:** with the gate on, a tick must create at most ONE pending row per (enrollment_id, step_index). Reuse the claim-first pattern the engine already uses for sends; if a pending row exists for that enrollment+step, the tick does nothing and the enrollment stays put (leave `next_send_at` as-is or null it — pick one and be consistent) until approve or skip.
- **Re-check at approve time, not just render time:** consent (`resolveRecipient`), opt-out/STOP, reply, stage-advance/lost, and paid (invoice) can all change between render and approval. The approve path must re-run the per-channel consent + kill-switch checks immediately before sending; if a kill-switch now fires (customer replied, opted out, paid, lost), do NOT send — void the pending row and surface why in the queue.
- **Quiet hours at approve time:** if a human approves during quiet hours, defer the actual send to the next allowed window (keep it queued for the runner to flush) rather than sending late. Quiet hours apply to SMS as today; email is far less sensitive — either leave email 24/7 or make the "apply to email" choice a setting, and note what you did.
- **Blasts unchanged:** the approval gate applies to drip enrollments only. Manual blasts (`drainBlasts`) are already a deliberate human action; leave that path alone.
- **Auth posture:** the approve/skip backend is a staff-only action; follow the same auth pattern as the other staff writes (caller's Supabase token, staff RLS), same as `renderDrips`'s writes.

## Tasks (dependency order)

1. (If needed) migration adding the pending status value to `pec_drip_sends` — write it under `supabase/migrations/`, hand the apply to Cowork.
2. `_pec-drip.cjs`: add the approval-gate branch in `runDrips` (render + persist pending, no send, no advance, idempotent); make `quietHours()` settings-driven (start/end/days, default 08:00-20:00 Phoenix Mon-Sat).
3. Approve/skip backend: a function (extend the runner or add `pec-drip-approve.cjs`) that takes a pending send id + optional edited body/subject, re-checks consent + kill-switches + quiet hours, sends, logs `sent`, advances the enrollment; plus a skip that advances without sending.
4. `index.html`: new "Drip Approvals" admin view — add the nav button (near the other `pec-role-admin` buttons ~2498-2517), the route (view map ~7274), and the render function (list, inline edit, Approve & Send / Skip / Stop).
5. `index.html` `renderSettings`: add the Drips section (master on/off, approval gate on/off, quiet-hours start/end/days). Keep the master in sync with the admin Drips view.
6. `index.html` `renderLeadDetail`: expand `dripCard` into the dedicated section (status + sent/pending messages with body + upcoming steps with dates).
7. `CLAUDE.md`: add the settings standing rule.
8. `help/whats-new.json`: 2 staff-facing entries (Drip Approvals queue; Drip controls in Settings). Plain language, no em dashes.
9. `features.json`: update the drip entry anchors; add the approvals view + drip settings.

## Acceptance criteria

- Gate ON + a due enrollment: one tick creates exactly ONE pending row, sends nothing, enrollment does not advance; a second tick does not duplicate.
- Drip Approvals view lists the pending item; Approve & Send delivers the (optionally edited) message, logs `sent`, advances the enrollment; Skip advances without sending; Stop ends the enrollment.
- A lead who replied / opted out / paid / was marked lost between render and approve does NOT get sent — the pending item is voided with a visible reason.
- Quiet hours come from the Settings values, not the hardcoded window; changing them needs no code edit.
- Settings shows master on/off, approval gate on/off, and the quiet-hours window; master mirrors the admin Drips view.
- Lead card shows the sent/pending messages (full body) and the upcoming steps with dates.
- Gate OFF: behavior reverts exactly to Phase-3 automatic live sending.

## Guardrails / do NOT touch

- Do NOT set `drip_sending_enabled` or any campaign `mode` to live in code. Go-live config is a Cowork step after this ships; the final gate-off is Dylan's manual flip later.
- Do NOT change blast (`drainBlasts`) send logic beyond what is strictly required.
- Do NOT weaken consent or kill-switch checks. No em dashes in any customer-facing copy (standing rule 6).
- Do NOT full-read `index.html` / `PROJECT-LOG.md`; navigate by anchors.

## After

- Append a PROJECT-LOG entry (By: Claude Code) describing what shipped, the migration (if any) flagged as a `## Handoff to Cowork`, and the What's New entries. Commit per standing rule 1 (stage only the files you changed, message format `<area>: <what changed>`).
- Handoff to Cowork: (1) apply the pending-status migration and regenerate SCHEMA.md (if a migration was written); (2) once Dylan says go, flip go-live config — `drip_sending_enabled` = true, all three campaigns `mode` = `live`, `drip_approval_required` = true — so week-one runs live-but-held-for-approval. Dylan flips `drip_approval_required` off after the supervised week.
