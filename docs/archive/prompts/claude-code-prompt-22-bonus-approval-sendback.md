# Claude Code Prompt 22: bonus approval dialog + send-back notes

## Context

Repo: `/Users/dylannordby/claude-code/hq-dashboard` (single-file `index.html`, live on Netlify).
This prompt is self-contained. Do the bug-diagnosis workflow: read the relevant code first, confirm the anchors below by line, then build. Two independent features, both touching the Job Costing detail (`openCostingDetail`, index.html ~21550) and its finalize card (`finalizeCardHtml`, ~22314) and button handlers (~22861-22946).

Read these first so you build on what exists rather than duplicating it:
- `computeCrewBonus(laborBudget, hoursByKey, memberLookup, defaultRate)` at ~21294. It already auto-calculates the labor-savings bonus. Returns `{ members, totalHours, totalOtHours, actualLabor, laborBudget, savings, pool, hasActuals }`. Each member: `{ key, name, hours, otHours, regHours, wage, usedDefault, otPremium, wageTotal, wageTotalBurden, bonus }`. `key` is `crew_member_id`, or `bb:<id>` for an unmapped BusyBusy member (cannot be paid, no crew link).
- The finalize handler `#costingFinalizeBtn` (~22897-22937) currently does `confirm(...)`, stamps `costing_finalized_by/at`, then delete-then-inserts the `'Labor-savings bonus'` rows into `pec_prod_job_bonuses` using `bonusCalc.members` filtered by `m.bonus > 0 && m.key && !m.key.startsWith('bb:')`, mapped to `{ job_id, crew_member_id: m.key, crew_member_name: m.name, hours_actual: m.hours, amount, note }`. Subcontracted jobs (`job.subcontracted`) record zero bonus.
- The send-back handler `#costingSendBackBtn` (~22881-22888) currently just clears `costing_submitted_at/by` with a `confirm()`, no note.
- The bell notification pattern: `log_costing_submitted(p_customer)` is a SECURITY DEFINER RPC (see `supabase/migrations/2026-06-27_costing_submit_review.sql`). Client JS cannot insert into `pec_notifications` directly (RLS is SELECT/UPDATE only for staff), so notifications go through a SECURITY DEFINER function.
- Slack: `SLACK_OFFICE_WEBHOOK` is a SERVER-side env var (Netlify), used by `netlify/functions/pec-invoice-intent.cjs`, `pec-stripe-webhook.cjs`, `pec-public-estimate.cjs` to post to #epoxysales (id `C09AZE8CU0Z`) via a best-effort `fetch`. There is NO Slack bot token and NO per-user DM path wired. So the send-back Slack notification is a CHANNEL post to #epoxysales, not a DM to the submitter. Do not build a new Slack channel; reuse `SLACK_OFFICE_WEBHOOK`.
- Bonus Report already has the "pending payout + Mark selected paid" bulk flow (renderBonusReport, ~13909; pending list + `#bonMarkPaid` ~14066-14103). Bonuses land there on finalize. DO NOT build a new pending area; the approved bonus continues to flow into that existing one.
- Two-modal-root gotcha: use `openModal` (#pecModalRoot), same as `openAddMaterialModal` (~22952), for both new dialogs.

Dylan's decisions (from a 12-question dig, locked):

FEATURE A, SEND BACK WITH A NOTE.
- Note is REQUIRED (cannot send back without a reason).
- Entered in a proper modal textarea (not `prompt()`).
- Keep a FULL HISTORY of send-back reasons (timestamp + who), shown as a thread on the job.
- Submitter sees the reason THREE ways: a banner on the costing job, a bell notification, and a Slack post to #epoxysales.

FEATURE B, BONUS APPROVAL DIALOG.
- The suggested bonus already calculates; what is missing is an explicit approve-with-edit step and prominence during review.
- Finalize IS the approval (keep one button, no separate "approve" action).
- On Finalize, open a dialog listing each crew member with their suggested bonus, EDITABLE per member.
- Pool FLOATS: the pool total is simply the sum of the amounts Dylan sets. No re-split math.
- Keep a FULL AUDIT TRAIL: store the originally-suggested amount, the approved amount, and who approved it.
- Also show the suggested bonus pool in the "Submitted for review" queue list, before the job is opened.

## Tasks

Ship FEATURE A first (smaller, independent), then FEATURE B. Separate commits per feature so each is bisectable. Migrations are NOT applied to prod from your session (standing do-not-touch-prod rule): write the SQL files, commit them, and hand off application to Cowork in the PROJECT-LOG entry.

### FEATURE A, send-back with notes

A1. Migration `supabase/migrations/2026-07-14_costing_sendback_notes.sql` (new, idempotent, Cowork-applied):
- `create table if not exists public.pec_prod_costing_sendbacks ( id uuid primary key default gen_random_uuid(), job_id uuid not null references public.pec_prod_jobs(id) on delete cascade, note text not null, sent_back_by text, created_at timestamptz not null default now() );` plus `create index if not exists ... on (job_id)`.
- Enable RLS and add a staff-only policy mirroring `pec_prod_crews` (drop-if-exists then create, `for all using public.is_admin_staff() with check public.is_admin_staff()`).
- `create or replace function public.log_costing_sent_back(p_customer text, p_note text) returns void language plpgsql security definer set search_path = public` that inserts a `pec_notifications` row: `type = 'costing_sent_back'`, body `= coalesce(actor,'Someone') || ' sent ' || coalesce(nullif(p_customer,''),'a job') || ' job costing back: ' || p_note` (actor resolved the same way `log_costing_submitted` does). `grant execute ... to authenticated;`. Add the same verify comments at the bottom that the 2026-06-27 migration has.

A2. `netlify/functions/pec-notify-costing-sendback.cjs` (new): mirror the best-effort Slack post in `pec-invoice-intent.cjs`. Read `SLACK_OFFICE_WEBHOOK`; if set, POST `{ text }` where text names the customer, who sent it back, and the note; always return 200 (best-effort, a Slack failure must never surface as a send-back failure). If the webhook is unset, no-op. This posts to the #epoxysales CHANNEL (there is no DM path).

A3. `index.html`, send-back flow (replace the `#costingSendBackBtn` handler at ~22881):
- On click, open an `openModal` dialog with a required `<textarea>` and two buttons ("Send back" disabled until the textarea is non-empty, and Cancel). Keep the `canFinalizeCosting()` guard.
- On submit, in order: (1) insert a `pec_prod_costing_sendbacks` row `{ job_id: jobId, note, sent_back_by: state.adminUser?.name || state.adminUser?.email || 'Admin' }` (use `withFreshWrite`); (2) clear `costing_submitted_at` and `costing_submitted_by` (existing behavior); (3) best-effort `supabase.rpc('log_costing_sent_back', { p_customer: job.customer_name || '', p_note: note })` in a try/catch (RPC may not be live pre-migration); (4) best-effort `fetch('/.netlify/functions/pec-notify-costing-sendback', ...)` in a try/catch; (5) `renderUnifiedJob(jobId)`.
- Load the send-back history with the costing detail data: `select note, sent_back_by, created_at from pec_prod_costing_sendbacks where job_id = ... order by created_at desc`. Degrade to empty if the table is missing (same graceful pattern as `pec_prod_tasks`), so the page never errors pre-migration.
- Render, on the costing detail: when the job is NOT finalized and has send-back history, show the LATEST note prominently as a banner near the top of the finalize card (so the submitter sees why it came back), plus a collapsible "Send-back history" list of every note with who + when. Show it to the submitter (non-admin) and admin alike.

### FEATURE B, bonus approval dialog + audit + queue preview

B1. Migration `supabase/migrations/2026-07-14_bonus_approval_audit.sql` (new, idempotent, Cowork-applied): `alter table public.pec_prod_job_bonuses add column if not exists suggested_amount numeric, add column if not exists approved_by text, add column if not exists approved_at timestamptz;`. Additive only, no RLS change. Add verify comments.

B2. `index.html`, finalize approval dialog (replace the `confirm()` in `#costingFinalizeBtn` at ~22897 with an `openModal` dialog; keep the `canFinalizeCosting()` guard and everything that happens AFTER approval):
- The dialog lists each MAPPED crew member (`bonusCalc.members` where `m.key && !m.key.startsWith('bb:')`) with: name, hours, the suggested amount shown read-only for reference, and an editable number input pre-filled to `round2(m.bonus)`. Show a live "Crew pool" total = sum of the inputs (pool floats; no re-split). Buttons: "Approve & Finalize" and Cancel.
- Unmapped `bb:` members: show as a disabled row noting "not linked to a crew member, cannot be paid" and exclude them from the commit.
- Subcontracted job (`job.subcontracted`): the dialog shows "Subcontracted job, no crew bonus recorded" with no inputs; approving still finalizes and records zero bonus rows (preserve the existing subcontracted-zero behavior and the delete that clears stale auto rows).
- Awaiting hours (`!bonusCalc.hasActuals`): show "No crew hours yet, no bonus" and finalize with zero rows.
- On "Approve & Finalize": do exactly the existing finalize sequence (stamp `costing_finalized_by/at`, delete-then-insert the `'Labor-savings bonus'` rows, clear submitted stamps, `renderUnifiedJob`), but the inserted rows now use the EDITED amount for `amount`, plus `suggested_amount: round2(m.bonus)` (the original), `approved_by: <current admin>`, `approved_at: new Date().toISOString()`. Only insert rows where the approved amount > 0 and the member is mapped. Keep the delete-then-insert idempotency and the existing error toast if the ledger write fails.

B3. `index.html`, queue preview: in `renderJobCosting`'s "Submitted for review" list (~23102-23114), show the suggested crew bonus pool next to each submitted job (read-only). Reuse the same aggregation the costing detail / `loadCostingData` already builds (do not add a fourth bonus computation). If a job is awaiting hours, show a dash.

B4. `index.html`, finalized recap: `bonusRecapHtml` (the finalized "Bonus (recorded)" block, ~22321) should surface the approved amount, and note the original suggested amount when it differs (the audit columns now exist). Read-only.

## Guardrails
- Never use em dashes anywhere (standing rule 6). Use commas, parentheses, or two sentences.
- Do NOT apply either migration to prod from your session. Write the files, commit, hand off to Cowork.
- Do NOT build a new pending-payout area or a new Slack channel. Reuse the Bonus Report pending list and `SLACK_OFFICE_WEBHOOK`.
- Use `openModal` (#pecModalRoot) for both dialogs (two-modal-root rule).
- Both features are user-facing: append a `help/whats-new.json` entry for each (send-back reasons; per-member bonus approval), newest first, plain language, no em dashes.
- Do not touch the bonus math (`computeCrewBonus`, `CREW_BONUS_FRACTION`, burden, OT). Dylan is only editing the OUTPUT amounts, not the formula.

## Verification
- `npm test` green (unchanged calculator/estimate suites; this is UI + schema).
- `node --check` passes on every `index.html` script block and both new `.cjs`/`.sql`-adjacent JS.
- `help/whats-new.json` parses.
- Em-dash scan of every added line: zero (the null-value display glyph is the only allowed exception, per prior builds).
- Manual smoke listed in the Handoff below.

## After
Append a PROJECT-LOG.md entry at the TOP, `By: Claude Code`, describing what shipped, the commits (one per feature), files touched, and a `## Handoff to Cowork` section:
- Apply BOTH migrations to PROD (project zdfpzmmrgotynrwkeakd "HQ Dashboard") via the Supabase SQL editor: `2026-07-14_costing_sendback_notes.sql` (new table + RPC) and `2026-07-14_bonus_approval_audit.sql` (three columns on `pec_prod_job_bonuses`). Both idempotent. Capture the verify-query results in the log entry.
- Confirm `SLACK_OFFICE_WEBHOOK` is set in Netlify (it should already be, from the invoice/stripe paths).
And a `## Handoff to Dylan` section: push to deploy, then smoke: (1) as the reviewer, Send back a submitted job, confirm the note is required, and confirm the submitter sees the banner + bell + a #epoxysales post; resubmit and send back again, confirm both notes show in the history. (2) Finalize a job with crew hours, confirm the dialog lists each member with editable amounts and a live pool, edit one amount, approve, and confirm the Bonus Report pending payout shows the edited number and the finalized recap shows suggested vs approved. (3) Confirm the "Submitted for review" queue shows a suggested pool per job.
