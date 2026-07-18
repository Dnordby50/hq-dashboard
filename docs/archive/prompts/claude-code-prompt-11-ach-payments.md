# Claude Code Prompt 11: ACH bank payments through Stripe (async settlement handling)

## Context

Dylan wants customers to pay invoices by ACH bank transfer, like they could when DripJobs ran payments through Stripe. Cards already work end to end. Scoped by Cowork on 2026-07-09 through 12 multiple-choice decisions. Repo: HQ-Dashboard, branch main. Run AFTER prompt 10 (subcontractor expenses); grep for symbols, do not trust line numbers.

Why this needs code at all: ACH settles in 3 to 5 business days. The current webhook only records `checkout.session.completed` with `payment_status = 'paid'` (pec-stripe-webhook.cjs line ~48-50). An ACH checkout completes as `unpaid`, then Stripe fires `checkout.session.async_payment_succeeded` days later, an event the webhook currently ignores, so an ACH payment would NEVER land in pec_payments. No payment row means no commission line and the job sits in completed-not-paid forever. The money side (enabling ACH on checkout) is a Stripe Dashboard toggle Dylan flips himself AFTER this deploys; the code side is making the pipeline async-aware.

Fee context (why Dylan wants this): Stripe ACH is 0.8% capped at $5, versus roughly 2.9% + 30 cents on cards. On a $10k balance that is $5 versus about $320.

## What exists today

- pec-stripe-checkout.cjs creates Checkout Sessions WITHOUT pinning `payment_method_types`, so the hosted page shows whatever methods the Stripe Dashboard enables. This is exactly right; DO NOT add payment_method_types. Enabling ACH requires zero change to this function's session params.
- pec-stripe-webhook.cjs is the ONLY place online payments are recorded: signature-verified, idempotent pec_payments insert keyed on the PaymentIntent id in `reference`, then best-effort deposit_collected auto-flip. It ignores every event except a paid checkout.session.completed.
- pec-public-invoice.cjs renders the public /pay/:token page, including the `?paid=1` green "Payment received" banner (line ~216, ~322).
- pec-invoice-intent.cjs already posts to Slack #epoxysales via the SLACK_OFFICE_WEBHOOK env var and emails via RESEND_API_KEY, each channel best-effort and independent. Reuse both patterns for failure alerts.
- The Invoicing page (index.html) has the completed-not-paid AR section with the Last-invoiced column (prompt 9).

## Dylan's decisions (all final)

1. ACH offered everywhere cards are: deposits, balances, custom amounts. One Stripe toggle covers all three because they share the checkout function.
2. Bank verification is whatever Stripe's hosted checkout does by default (Financial Connections instant login with Stripe's own microdeposit fallback). NOTHING custom, nothing built locally. All payment UX stays on Stripe's hosted surfaces.
3. After submitting an ACH payment the customer sees a distinct processing state, not the paid banner: "Payment initiated. Bank transfers take 3 to 5 business days to clear." The card flow keeps its current paid banner.
4. Pending ACH is recorded as a PENDING marker, not a pec_payments row. The payment row is inserted only when funds settle (async_payment_succeeded).
5. The job shows an "ACH pending $X" badge in Invoicing/AR while pending, and STAYS in the completed-not-paid list until settled. The badge exists so nobody chases a customer who already paid.
6. deposit_collected flips only at settlement, never at initiation.
7. pec_payments.received_date = settlement date (phoenixToday() when async_payment_succeeded arrives), matching the existing card behavior of recording when Stripe confirms.
8. ACH failure days later (insufficient funds, disputed debit) alerts THREE ways: Slack #epoxysales post, email to Dylan (dnordby50@gmail.com), and a red "ACH failed" flag on the job in Invoicing that persists until cleared/resolved.
9. Pay page gets light nudge copy toward ACH, something like "Bank transfer (ACH) available, no card fees". Stripe still shows both methods; the customer picks.
10. Dylan flips the Stripe Dashboard toggle himself after deploy (steps in his handoff below).
11. Live test: Dylan pays a small custom amount on a test invoice via ACH from his own bank, verifies the pending badge immediately and the settled payment row days later.
12. Ships after prompt 10.

## Build notes

- New table (idempotent migration, verify queries at the bottom, Cowork applies): pec_stripe_pending. Suggested shape: id uuid pk default gen_random_uuid(), payment_intent text UNIQUE not null, job_id uuid not null, kind text, amount numeric not null, status text not null default 'pending' (pending | succeeded | failed), failure_message text, created_at timestamptz default now(), resolved_at timestamptz. Trust model mirrors pec_call_log exactly: staff SELECT policy only, NO client write policy, only the service-role webhook writes.
- Webhook event routing (pec-stripe-webhook.cjs):
  a. checkout.session.completed with payment_status 'paid': UNCHANGED card path, byte for byte where possible.
  b. checkout.session.completed with payment_status 'unpaid': upsert a pec_stripe_pending row keyed on the PaymentIntent id (idempotent; a Stripe retry must not duplicate). Do NOT insert pec_payments, do NOT flip the deposit.
  c. checkout.session.async_payment_succeeded: run the EXISTING recording logic (idempotent pec_payments insert on the PI id, then the deposit auto-flip), then mark the pending row succeeded with resolved_at. The existing reference-exists check plus the partial-unique index already make double-recording impossible even if both b and c misfire; keep that property. This is a non-idempotent-looking insert made idempotent by the reference key; never add a blind retry beyond what exists.
  d. checkout.session.async_payment_failed: mark the pending row failed with the failure message, then fire the alerts (Slack via SLACK_OFFICE_WEBHOOK, email via the Resend pattern from pec-invoice-intent.cjs, both best-effort and independent, neither may fail the webhook response). The dashboard flag is just the failed pending row rendering red in Invoicing.
  e. Everything else still 200s as ignored. Preserve the 500-so-Stripe-retries contract for genuine DB failures on the recording path.
- The Quo lesson (2026-07-07 log entry) applies verbatim: verify the classifier against EVERY clause. async events carry the full session object; make sure the unpaid guard on path a cannot swallow paths c and d (route on evt.type FIRST, then payment_status).
- Success redirect: checkout redirects ACH customers to success_url even though funds are pending. Distinguish server-side in pec-public-invoice.cjs: on ?paid=1, check pec_stripe_pending for an unresolved row on this token's job; if found, render the amber processing banner (decision 3) instead of the green paid banner. Zero client JS, keep the page static HTML.
- Invoicing badges (index.html): in the completed-not-paid section, one batched query over the section's job ids against pec_stripe_pending (the Last-invoiced column pattern, never per-row). status pending shows a muted "ACH pending $X" chip; status failed shows a red "ACH failed" chip until resolved. Missing table degrades to no chips, page never breaks (deploy-order safety, same discipline as prompts 6, 8, 10).
- Failed-flag lifecycle: keep it simple. A failed row stays flagged until either a later payment settles for that job (a new checkout creates a new PI) or an admin clears it. Prefer the zero-new-UI option: clear the failed flag automatically when any subsequent pec_payments row lands for the job; add a manual clear only if trivial.
- Nudge copy (decision 9): one line on the public invoice page near the pay buttons, and consider the same line in the invoice email template if it is a one-line change. No card surcharges, no method reordering.
- Do NOT touch: the Stripe session params in pec-stripe-checkout.cjs (beyond nothing), the supabase client config, timedFetch, wedge recovery, or any non-webhook payment path. The in-app Mark Paid / Record payment modal is unaffected.
- Standing rules: commit per meaningful change, node --check every touched function and extracted script block, no em dashes anywhere, PROJECT-LOG.md entry on top, migration NOT applied from your session (Cowork handoff).

## Handoff to Cowork (put in your log entry)

1. Apply the pec_stripe_pending migration to PROD, run its verify queries, report: table exists, unique constraint on payment_intent, exactly one SELECT-only staff policy, no client write policy.
2. After Dylan's live ACH test settles (3 to 5 business days), verify in PROD: exactly one pec_payments row for the test PI, method stripe, received_date = settlement date, matching pending row status succeeded with resolved_at set, and the commission line present for the job's salesperson.

## Handoff to Dylan

1. Push to deploy FIRST. Do not enable ACH in Stripe before the deploy is green, or an early ACH payment will be dropped by the old webhook.
2. Then in the Stripe Dashboard: Settings > Payments > Payment methods, find "ACH Direct Debit" (US bank account) and click Turn on. Leave everything else default. Also confirm your webhook endpoint's event subscriptions include checkout.session.async_payment_succeeded and checkout.session.async_payment_failed (Developers > Webhooks > your endpoint > add events if missing; the deploy handles them but Stripe only sends subscribed events).
3. Live test: open any test invoice's pay link, choose a small custom amount, pay via US bank account with your own bank login. Immediately verify: the pay page shows the amber "payment initiated" banner (not green paid), and Invoicing shows the "ACH pending" chip on the job. In 3 to 5 business days verify the payment row appears, the chip clears, and commission shows the line.
4. Optional while testing: to see the failure path without waiting for a real bounce, Stripe test mode has a test account number that triggers async failure; only worth it if you want to see the Slack/email alert fire before trusting it.
