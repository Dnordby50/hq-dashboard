# Claude Code Prompt 45: Partial invoicing, required deposits, and payment schedules

## Context

Owner: Dylan. Repo: HQ-Dashboard (TopCoat CRM, ARM 1 dashboard `index.html` + `netlify/functions/*.cjs`, prod Supabase "HQ Dashboard" zdfpzmmrgotynrwkeakd). Read CLAUDE.md and the last 3 PROJECT-LOG entries first, per standing rules.

Today the invoicing model is **one invoice per job**, and the only amount a customer is ever shown is the **full remaining balance** (`balance_remaining = job total - payments`) or, if a deposit is still due, a **deposit** that is clamped to be smaller than the balance. There is no way for staff to bill an arbitrary amount, no default-deposit setting, and no payment schedule. Dylan needs to be able to require a deposit on accepted estimates, optionally lay out a payment schedule, and invoice for 100% or a custom amount.

Dylan scoped this over a 12-question dig with Cowork. The decisions below are **locked**. Do not re-open them; build to them. If the live code contradicts a stated fact here, trust the code, flag the drift in your log entry, and keep the locked decision.

### Locked decisions

1. **Structure: one invoice per job, adjustable amount.** Do NOT create multiple invoice records per job. Keep one `hq_invoice_number`, one `public_token`, one pay page per job. The "invoice" gains a **schedule of installments**; at any moment exactly one installment is the **current amount due**.
2. **Amount entry: dollar OR percent.** Every deposit and every installment can be entered as a flat dollar amount or a percent of the job total; staff picks per line. Store both the kind and the value, and snapshot the computed dollar amount.
3. **Required deposit on accepted estimates.** There is a company default deposit %, manually editable per job. On estimate acceptance the system **prepares** a deposit invoice at the default %, but **staff sends it manually** (no auto-send, no scheduling gate). See "Deposit default %" below for the precedence rule.
4. **Deposit vs schedule: staff decides per job.** The deposit can either be **installment #1 of the schedule** or a **separate** line handled on its own. Support both; a per-job choice.
5. **Payment schedule sending: auto-queue with an approval gate.** When an installment's trigger fires it is queued automatically but **held for staff approval** before anything sends. Mirror the existing drip approval-gate pattern (see anchors). The deposit is the exception: it follows decision 3 (staff sends manually, not queued).
6. **Schedule timing: job milestones.** Installments are due on **on acceptance / on job start / on completion**, not calendar dates. (Leave room for a future "manual/date" trigger in the schema, but the UI ships with the three milestones.)
7. **Pay page: current amount due + full schedule.** The customer sees the current amount as the big "Amount due", plus the entire schedule (each installment, what's paid, what's upcoming), plus project total / paid / remaining context.
8. **One outstanding ask at a time.** Only one installment is ever "current". When it settles, the next eligible installment (lowest sequence whose trigger has fired) becomes current. Milestones that fire while a prior installment is unpaid just queue.
9. **Online payment charges exactly the requested amount.** Extend the existing Stripe path so card and ACH both charge precisely the current installment amount. Compute the amount **server-side** from the token + installment; never trust a client-supplied amount (the intent function already warns this).
10. **Reminders reference the current outstanding ask.** The invoice reminder drip should nudge on whatever amount is currently due (the deposit or the current installment) and its milestone/due context, not the full remaining balance.

### Backward compatibility (critical)

A job with **no schedule and no installments must behave exactly as it does today**: amount due = full remaining balance, the existing "Pay deposit" button still works off `deposit_amount` / `deposit_collected` / `deposit_waived`, and the current Stripe `kind=balance` / `kind=deposit` flows are untouched. The new current-ask logic only engages when a job actually has installments. Do not regress the plain path.

## Grounding: where things live (verify before editing)

- **Invoicing UI (`index.html`)** anchors from features.json: `renderInvoicing`, `renderJobInvoice`, `renderInvoicingDocs`, `pecDownloadInvoicePdf`, `pecOpenPrintDoc`, `pecSplitSendHtml`, `pecWireSplitSend`, `markJobComplete`. Send code is the prompt-38 split Send control (kind='invoice' SMS + compose modal + `invoice_first_sent_at` first-send stamp).
- **Public pay page:** `netlify/functions/pec-public-invoice.cjs` (computes `balance_remaining`, the deposit clamp, ACH pending netting, the status pill, `kind=balance` / `kind=deposit` Stripe buttons). Offline "pay another way": `netlify/functions/pec-invoice-intent.cjs` (note its "Never trust client-supplied customer/amount" rule). Find the Stripe checkout function behind `/api/stripe/checkout?token=...&kind=...` and its success/webhook handler that records the payment.
- **`jobs` table:** `deposit_amount`, `deposit_collected`, `deposit_waived`, `line_items` (jsonb), `hq_invoice_number`, `invoice_first_sent_at`, `public_token`, `status_manual_at` (stamped by `markJobComplete`; this is the **on completion** signal). Job total is derived from `line_items` / `price`.
- **`estimates` table:** `deposit_amount`, `deposit_payment_id`, `system_type_id`, `accepted_at`, `signed_at`, `job_id`, `pec_prod_job_id`. Acceptance flows through the proposal-accepted path (`pec-webhook-proposal-accepted.cjs`, which per CLAUDE.md writes to BOTH `jobs` and `pec_prod_jobs`) and/or the estimator public accept. Find where "estimate accepted" is actually detected and hook the **deposit prepare** there. This is the **on acceptance** signal.
- **`pec_prod_system_types.deposit_pct`** already exists (a per-system-type default deposit %). Use it in the precedence rule below rather than adding a parallel concept.
- **`settings` table:** simple key/value (`key`, `value`). New settings live here per standing rule 12 (every major feature ships a Settings surface).
- **Drip approval-gate pattern to mirror (decision 5):** `netlify/functions/_pec-drip.cjs` (`pending` status, `resolvePendingStep`, quiet-hours config), `netlify/functions/pec-drip-approve.cjs`, the **Drip Approvals** view `renderDripApprovals` in index.html, table `pec_drip_sends`. The invoice reminder campaign is `pec_drip_campaigns` row with `kind='invoice'` (steps at days 0,3,7,14). Wire decision 10 into the invoice runner's amount resolution.
- **Money-path gotchas (CLAUDE.md "Architecture Gotchas"):** never blind-retry a non-idempotent write (payment insert) - the payment path uses recover-verify-retry; keep `timedFetch`; two modal roots (`#pecModalRoot` and `#prodModalRoot`) - any modal-lifecycle change goes to both; supabase-js returns an empty result (not an error) for a bad column, so check `res.error`.
- **`SCHEMA.md`** is the column reference; verify every table/column before writing SQL. Migrations are **written, not applied** - Cowork applies them per standing rule 9.

### Deposit default % precedence

When preparing a deposit, resolve the default in this order, first hit wins: (a) a manual per-job override if set; (b) the job's system type `pec_prod_system_types.deposit_pct`; (c) a new company-wide `settings` key `default_deposit_pct`. Surface all three so Dylan can tune the company default in Settings and override per job, and so the system-type default keeps working. Confirm this precedence in your log entry with the code paths.

## What to build

Build the full system, but **build and commit it in internal phases** (schema + model, then staff UI + send/approval, then pay page + Stripe, then reminders), with fixture tests at each phase. This is the money path; ship it test-first.

### 1. Data model (migration, written not applied)

Design a `pec_invoice_installments` table (name your call, justify it) keyed to `jobs.id`, capturing at least: sequence/sort, label, `amount_kind` ('fixed'|'percent'), `amount_value`, snapshotted `computed_amount`, `trigger` ('on_acceptance'|'on_start'|'on_completion'|'manual'|'date' - ship the three milestones in UI, allow the others in schema), optional `due_date`, `status` ('planned'|'queued'|'pending_approval'|'sent'|'paid'|'skipped'|'canceled'), `is_deposit` bool, `sent_at`, `paid_at`, `payment_id` FK -> `pec_payments.id` nullable, plus created_at/by. Add RLS matching the invoicing module. Add the `settings` seed(s): `default_deposit_pct`, plus any on/off + approval-gate config the Settings surface needs (rule 12). Follow the material_type CHECK gotcha style (drop/re-add in one transaction) if you touch any existing CHECK. Write a verify block. **Do not apply it** - hand to Cowork.

### 2. "Current amount due" resolver (fixture-testable)

One function that, given a job + its installments + its payments, returns the current outstanding ask (amount, label, installment id, trigger/milestone context) or falls back to the full remaining balance when there is no schedule. Enforce decision 8 (one at a time; next becomes current only when the prior is settled and its trigger has fired). Define "settled": an installment is paid when cumulative applied payments >= its computed amount. Put this in `production/` (or a shared `.cjs` the functions and index.html both reach) so both the pay page and the reminder runner use the SAME definition. Cover it with a fixture test.

### 3. Staff UI (index.html, invoicing + job invoice views)

- A **schedule editor** on the job invoice: add/edit/remove installments (label, dollar-or-percent amount, milestone trigger), reorder, mark the deposit line, and choose deposit-as-first-line vs separate (decision 4). Editing is allowed on planned/queued lines; sent/paid lines are locked.
- **Deposit prepare on acceptance** (decision 3): on estimate acceptance, create the deposit installment at the resolved default %, left for staff to send via the existing Send control. Not auto-sent.
- Show the current ask, the schedule, and per-installment status in the staff view.
- Settings surface (rule 12): company `default_deposit_pct`, the approval-gate toggle, and any timing/limits, all editable with no code change.
- Apply any modal changes to both modal roots.

### 4. Send + approval gate (decision 5)

Milestone-triggered installments queue into an **approval gate** and are held until staff approve, then send through the existing invoice send path (kind='invoice' SMS + email compose, `invoice_first_sent_at` stamp on first send). Reuse / mirror the drip approval-gate mechanics (`resolvePendingStep`, the Drip Approvals view shape, quiet hours) rather than inventing a parallel one. Approve-time re-check: void the send if the job was paid/voided/canceled between queue and approve. The deposit does NOT go through the gate (staff sends it manually).

### 5. Public pay page + Stripe (decisions 7, 9)

- `pec-public-invoice.cjs`: show the current amount due as the hero "Amount due", plus the full schedule (each installment: label, amount, status paid/upcoming) and the project total / paid / remaining context. Preserve the ACH-pending netting and status-pill behavior.
- Stripe: add a checkout path that charges **exactly the current installment amount**, computed server-side from the token + current installment (never client-supplied). Card + ACH both. On payment success, record the `pec_payments` row through the existing recover-verify-retry path (do NOT blind-retry), mark the installment paid, and advance the current ask. Keep `kind=balance` / `kind=deposit` working for no-schedule jobs.

### 6. Reminders (decision 10)

Change the invoice reminder drip's amount resolution to use the "current amount due" resolver (section 2): reminders reference the current installment/deposit and its context, not the full balance, when a schedule exists; unchanged for no-schedule jobs.

## Guardrails - do not

- Do not regress the no-schedule path (see Backward compatibility).
- Do not blind-retry any payment/non-idempotent write; reuse the existing recover-verify-retry.
- Do not trust a client-supplied amount for Stripe; compute server-side.
- Do not hard-code the deposit %; use the precedence rule + Settings.
- Do not create multiple invoice records per job, and do not change `hq_invoice_number` to be per-installment.
- Do not apply the migration (Cowork applies).
- No em dashes in any customer-facing copy (pay page, invoice text, SMS/email). Commas, parentheses, or two sentences.

## Tests, docs, logging

- Fixture tests in `production/` for: the current-amount-due resolver (one-at-a-time, milestone gating, deposit-first vs separate, dollar vs percent, settled threshold), the approval-gate void-on-change, and the Stripe server-side amount computation. Keep existing suites green (`npm test`, drip-runner, drip-phase3, drip-approval, appt-intake, etc.). `node --check` every touched function; confirm inline index.html scripts parse.
- What's New entry (rule 11): the new deposit/partial-invoicing/schedule behavior, plain language, no em dashes.
- features.json: update the Invoicing entry (+ hosted-invoice + drip entries as touched) with new anchors/tables.
- PROJECT-LOG: append a top entry (By: Claude Code) describing what shipped, the deposit-% precedence you confirmed with code paths, and the milestone signals you wired (which code fires on_acceptance / on_start / on_completance). Flag any SCHEMA drift.
- Handoff to Cowork: apply the migration to prod + regenerate SCHEMA.md + the settings-seed verify. Handoff to Dylan: git push (commits are local), and tune `default_deposit_pct` in Settings.

## Acceptance criteria

1. A no-schedule job's pay page, deposit button, and Stripe flows are byte-for-byte the behavior they are today.
2. Accepting an estimate prepares a deposit installment at the resolved default %, shown in the staff view, unsent until staff sends it.
3. Staff can build a schedule of dollar-or-percent installments on milestones, choose deposit-as-first-line vs separate, and only one installment is ever the current ask.
4. When a milestone fires, its installment queues into the approval gate; approving sends it; a void condition between queue and approve cancels the send.
5. The pay page shows the current amount due + the full schedule + balance context; paying online charges exactly that amount (server-computed), records the payment once, and advances to the next ask.
6. Invoice reminders reference the current outstanding ask.
7. All fixture suites + npm test green; What's New, features.json, and the migration verify block present; migration NOT applied.
