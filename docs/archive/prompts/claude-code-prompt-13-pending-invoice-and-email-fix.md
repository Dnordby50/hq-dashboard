# Claude Code Prompt 13: pending ACH on the customer invoice + emailBrandLabel bug fix

## Context

Dylan ran the prompt-11 ACH live test on 2026-07-09 and it worked (pending row pi_3TrV6085aAKLOAgM1o5y0PuH, $1.00, job 63c361be-498c-4055-98c9-1cef1f7480cc, invoice ACH-TEST-1, token 57ba3edc-9f0b-47f6-92a9-6280d5d4da0f). His feedback, scoped by Cowork through 10 decisions: the customer invoice page must reflect a pending ACH IMMEDIATELY and persistently, not just on the post-checkout redirect. Today a customer who revisits their /pay link while their ACH processes sees the FULL amount still due with live pay buttons: that causes "did my payment go through" calls to the office and invites an accidental double payment by card. Also bundled here (Dylan's choice): the Settings > Email tab is dead, diagnosed by Cowork in the 2026-07-09 19:29 PROJECT-LOG entry.

Repo: HQ-Dashboard, main. The live $1 pending ACH above is your test fixture; it settles around Jul 14-16, so ship before then to see the pending state live.

## Part A: pending ACH on the public invoice (Dylan's decisions, all final)

1. Pending ACH renders as a real line in the Payments section: "Bank transfer $X" with a PENDING badge, on EVERY visit while pending (not only the ?paid=1 redirect). The amber processing banner (bank transfers take 3 to 5 business days) also shows on every visit while pending.
2. "Amount due" shows NET of pending, with a qualifier line ("includes a pending bank transfer of $X"). Reverts automatically if the ACH fails.
3. When pending covers the FULL balance: pay buttons hidden entirely, replaced by a processing note. They return automatically on failure.
4. Partial pending (pending < balance): pending line shows with the badge, Amount due shows the remainder, pay buttons stay and target the REMAINDER only.
5. Stamp wording: PENDING badge; the 3-to-5-day language lives in the banner.
6. Failure: red notice on the invoice ("Your bank transfer could not be completed. Please pay again or contact us."), amount due reverts to full, buttons return. The notice clears itself as soon as ANY later successful payment lands on the job (no staff dismissal step).
7. Identical treatment for all three kinds: balance, deposit, custom.
8. Staff-side send warning: before an invoice email or text goes out for a job with a pending ACH, show a confirm dialog ("This job has a $X bank transfer pending. Send anyway?") so the office never duns a customer who already paid.

## Part A build notes

- pec-public-invoice.cjs already queries the job; add a pec_stripe_pending lookup by job id (status 'pending', plus the newest 'failed' row). The table shipped in prompt 11; staff-SELECT RLS does not apply to the service-role key the function uses.
- DOUBLE-PAY GUARD, server side too: pec-stripe-checkout.cjs clamps custom amounts and computes balance from pec_job_ar, which does NOT know about pending ACH. Clamp the chargeable amount to (balance minus pending sum); if that leaves nothing chargeable, redirect back to /pay. Otherwise a stale link or back button can still double-charge even with the buttons hidden.
- Failure-clears-itself rule (decision 6): the failure notice shows only when the newest failed pending row has NO successful pec_payments row dated after its created_at. That is one indexed query, no new state.
- Send warning (decision 8): the Email invoice and Text invoice flows in index.html; check pending rows for the job before send and confirm. Both flows already fetch job context; keep it one batched lookup, no per-keystroke queries.
- The Invoicing chips from prompt 11 already cover the staff list view; do not duplicate.
- No migration needed. Nothing in this part touches pec_payments writes, the webhook, or the payment recording path.

## Part B: emailBrandLabel fix (diagnosis already done, in the 2026-07-09 19:29 log entry)

- Symptom: Settings > Email tab does not activate; console shows ReferenceError: emailBrandLabel is not defined, from renderSettingsEmail (~14072-14074), four throws per click.
- Root cause: emailBrandLabel is CALLED five times (13682, 13817, 14074, 14087, 14102) and DEFINED nowhere; git log -S shows it vanished in 269b6db ("email: PEC-only (drop Finishing Touch)"), which removed the helper but left call sites, and the Quo work later added two more call sites (13682, 13817). smsBrandLabel at 13533 is the surviving sibling.
- KNOWN FALLOUT beyond the tab: 13682 is the customer-profile Calls card meta line (r.brand ? emailBrandLabel(r.brand) : ''), so a call row WITH brand set throws mid-render; 13817 is the email log row. Check whether the Calls card has been silently broken since the Quo push and note the finding in your log entry.
- Fix: restore a one-line helper (mirror smsBrandLabel semantics; email is PEC-only per 269b6db, so decide whether the label should just say Prescott Epoxy or handle both brands like smsBrandLabel does, and justify in the log). Audit all five call sites. Verify: Email tab renders and saves, Calls card renders for a call with brand set, email log rows render.

## Standing rules

Commit per meaningful change, node --check every extracted script block and touched function, no em dashes anywhere, PROJECT-LOG.md entry on top. No migration this time, so no Cowork DB handoff.

## Handoff to Dylan (put in your log entry)

After deploy, with the $1 test ACH still pending: (1) open the test invoice link (/pay/57ba3edc-9f0b-47f6-92a9-6280d5d4da0f) fresh, no ?paid=1: expect the amber banner, a "Bank transfer $1.00 PENDING" line, Amount due $0.00 with the qualifier, and NO pay buttons; (2) from Invoicing, try to email or text that invoice: expect the pending-ACH confirm dialog; (3) Settings > Email: tab opens and templates render; (4) open a customer profile with a logged call and confirm the Calls card renders. Cowork's scheduled settlement check runs Jul 15 9:00 AM and will verify the payment row lands when the ACH clears.
