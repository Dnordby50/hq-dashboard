# Claude Code build prompt 16: the customer-facing estimate (send, sign, accept, job)

RUN THIS ONLY AFTER PROMPTS 15 AND 15b ARE SHIPPED AND VERIFIED. 15 built the thin estimator modal, the comps and AI pricing, and the estimate as a numbered object with its own page. 15b added multi-system areas, the add-on catalog, and the AI-written scope text. This prompt turns that into a document the customer signs and pays a deposit on, and makes an accepted estimate become a job. Read both PROJECT-LOG entries first; they name what was left stubbed for you (at minimum a disabled "Send to customer" button).

## Context

Repo: hq-dashboard (github.com/Dnordby50/hq-dashboard, main). Deploy: prescottepoxy.netlify.app. Supabase: zdfpzmmrgotynrwkeakd. This is the last piece of the DripJobs exit for the sales side: today a proposal goes out of DripJobs, the customer signs there, and the deal comes back to us over a webhook. After this build, the estimate is ours end to end.

Prompt 15's migration already created every column you need (status set including sent / signed / accepted / change_requested / rejected, change_request_note, rejected_reason, rejected_at, line_items jsonb with optional items, customer_*), and estimates has carried public_token, signature, signed_name, signed_at, signed_ip, sent_at, accepted_at, job_id, and pec_prod_job_id since it was created. Verify that against the live schema before you write a migration; you probably do not need one.

## Decisions locked with Dylan (do not relitigate these)

1. The estimate page is PRIVATE UNTIL SENT. The public link must not resolve before sent_at is set; it 404s exactly like an unknown token. Sending is what makes it live.
2. The customer can APPROVE AND PAY THE DEPOSIT, request changes with a message, or reject with a reason.
3. THE DEPOSIT IS COLLECTED ON THIS PAGE (Dylan reversed the earlier no-payment call on 2026-07-12, after showing the DripJobs customer view he wants to match). Approve and Pay takes the deposit by card through Stripe Checkout. Reuse pec-stripe-checkout.cjs and the signature-verified pec-stripe-webhook.cjs. The webhook, never this page, records the payment. Deposit percentage comes from pec_prod_system_types.deposit_pct (50% on the flake garage systems, 25% on the moisture barrier ones, seeded in 15b) and is overridable per estimate.
4. Optional line items are tickable by the customer, and ticking one changes the total AND the deposit they are paying. What is selected at signature time is what freezes onto the accepted estimate.
5. Accepting creates the JOB.
6. THE PAGE MUST LOOK LIKE THE DRIPJOBS CUSTOMER VIEW Dylan sent. Specifics below, and they are not decoration: this is the page his customers judge him by.

## The build

### 1. Send

- A send action on the estimate page that emails the customer their link. Reuse pec-send-email.cjs rather than duplicating a mail path; extend it if you must, but do not stand up a second Resend integration.
- Sending sets estimates.sent_at, flips status to sent, and writes an activity row. It is the ONLY thing that makes the public link resolve.
- The link is /e/<public_token>. Add the rewrite to netlify.toml next to the existing /pay/* one. The token is minted when the estimate is created but is inert until sent_at.
- The estimate page's "Copy link" button stays disabled until sent, so nobody hands out a URL that 404s.
- STOP AND ASK DYLAN before the first real send. Emailing a customer is an external communication; do not fire one at a live address as a smoke test. Test against Dylan's own address only, and say so in the log.

### 2. Public estimate page: netlify/functions/pec-public-estimate.cjs

Take the SECURITY AND PLUMBING from pec-public-invoice.cjs, which already solved every hard part: server-rendered HTML with no client framework, an unguessable UUID token acting as a bearer in the URL, a generic 404 on any miss that never leaks the token or DB detail, noindex/nofollow so shared links are not crawled, and the Stripe Checkout handoff.

Take the LAYOUT from the DripJobs customer view Dylan sent, in PEC brand colors (the invoice page's palette, not DripJobs' purple):

- A sticky top bar: company name, phone, an "Only $X deposit" chip on the left, and "Approve & Pay" plus "Download PDF" buttons on the right.
- A HERO BAND in PEC orange with the PEC logo, "License# ROC353243", the word Proposal, a status pill (Pending / Approved / Rejected), and a row of PROPOSAL #, DATE, STATUS.
- Under it, a white card with three blocks: PREPARED FOR (name, email, phone), PROJECT LOCATION (address), COMPANY (Prescott Epoxy Company, 1030 Sandretto Dr Suite K, Prescott AZ 86305, (928) 800-8154). Verify those details against what is already in the repo (the invoice page and pec-send-email have them) rather than trusting this prompt.
- THREE TRUST CARDS with icons: Prescott Showroom, Top Rated Prescott Company, Quick Turnaround. Put the copy in a config or a settings row, not hardcoded in the function, so Dylan can reword them without a deploy.
- LINE ITEMS as collapsible cards: the label and price on the header row, and the FULL SCOPE TEXT (generated in 15b) expanded underneath, exactly like "Scope of work for 100% flake broadcast with polyaspartic top coat / 2 day system / Day 1 / Surface Preparation / Diamond grind concrete with 14 or 30 grit..." in his screenshot. This text is the product. Render it properly (headings, bullets), sanitized, never as raw model output.
- An OPTIONAL ITEMS group the customer can tick, which updates the total and the deposit live.
- COMPANY DOCUMENTS links: insurance, warranty, workers comp, license, W-9. Dylan asked for the document links, not the full portal. Store them as URLs in settings; if a document is missing, the link simply does not render.
- A STICKY BOTTOM BAR: "Start today for only $X deposit" with the Approve & Pay button. This is the conversion element in his screenshot and it is why it is sticky.
- A DOWNLOAD PDF button. Model the generation on the existing invoice PDF path.

The three actions:
1. APPROVE AND PAY: the customer types their name as the signature, then goes to Stripe Checkout for the deposit. Order matters: write signature, signed_name, signed_at, signed_ip, freeze the selected optional items and the final total, and set status to signed BEFORE handing off to Stripe. The webhook flips it to accepted and creates the job when the payment lands. A customer who signs and then abandons the card form leaves a SIGNED estimate with no deposit, which is a real state Dylan needs to see on the estimate page, not a broken one.
2. REQUEST CHANGES: a message box. Writes change_request_note, flips status to change_requested, notifies Dylan (Slack #epoxysales C09AZE8CU0Z or email, whichever is already wired; do not build a new notification channel).
3. REJECT: a reason. Writes rejected_reason and rejected_at, flips status to rejected. Also move the LEAD to lost with that reason, since lost_reason is what conversion-by-source in Metrics reads.

An estimate that is already accepted, rejected, or superseded shows a read-only state instead of live buttons. A signed document must not be re-signable and a paid deposit must not be re-collectable.

### 3. Accept creates the job

TRIGGER: the job is created when the DEPOSIT PAYMENT LANDS, in the Stripe webhook (pec-stripe-webhook.cjs), not in the page handler. The page can be closed, refreshed, or double-submitted; the webhook is the one signed, verified, retried-by-Stripe event you can trust. If Dylan later allows an approve-without-paying path, that path creates the job at signature instead, and both routes must call the SAME job-creation function.

CLAUDE.md's architecture gotcha is load-bearing here: there are TWO parallel job tables. public.jobs (with public.customers) is read by the Jobs page; pec_prod_jobs (with pec_prod_job_schedule_days, pec_prod_crews, pec_prod_areas) is read by the Job Schedule calendar. They are siblings, not duplicates, and the DripJobs proposal-accepted webhook writes to BOTH so a deal appears everywhere.

READ netlify/functions/pec-webhook-proposal-accepted.cjs AND FOLLOW IT. Do not invent a second job-creation path. On acceptance:
- Create/reuse the customer, create the job in both tables the same way that webhook does.
- Set estimates.job_id and estimates.pec_prod_job_id.
- Copy the estimate's areas into the job's areas, and its production detail (gate code, moisture, Mohs, grit, non-slip, stem walls) onto the job, so the crew's work order is populated without re-keying.
- Move the lead to accepted with accepted_at and write the lead_event.

IDEMPOTENCY IS NOT OPTIONAL HERE. A customer double-clicking Accept, a mobile browser retrying a timed-out POST, or a refresh of the confirmation page must not create two jobs, two customers, or two lead events. Existence-check before every write and make the whole path safe to run twice. Per CLAUDE.md: never blind-retry a non-idempotent write; verify the row did not land before writing it again. This is the same discipline the payment insert uses.

### 4. Dashboard side

- The estimate page shows the customer-facing state: sent at, viewed (if you track it), signed by and when, or the change request / rejection with its text.
- A change_requested estimate is editable and re-sendable (a new send is a new sent_at, same number, same link).
- The Leads board and the Estimates list surface the new statuses.
- Notify Dylan on accept, the same channel as the change request.

## Guardrails

- EXTEND the invoicing/payment code, do not rewrite it. You are reusing pec-stripe-checkout.cjs and pec-stripe-webhook.cjs, which are load-bearing and were recently stabilized. Add an estimate-deposit path alongside the invoice path; do not refactor the invoice path to accommodate it.
- The deposit payment is recorded ONLY by the signature-verified Stripe webhook. The public page never writes a payment row. This is the existing rule for invoices and it does not get an exception here.
- The public page is the only unauthenticated surface here. It reads and writes through the service role INSIDE the function. Never grant public RLS on estimates, never accept an estimate id from the client (the token is the only key), and never echo the token back into the page in a way that could leak through a referrer.
- Rate-limit or at minimum guard the three public actions against replay; a stranger with a leaked link should not be able to spam change requests.
- The scope text on the page came out of a language model in 15b. Sanitize it on the way out. Never innerHTML raw model output into a customer page.
- Both modal roots, if you touch modal lifecycle.
- No em dashes anywhere.
- One What's New entry: the customer can now approve and pay a deposit on an estimate online.
- Harness tests, driving the real extracted functions: the public route 404s before sent_at and resolves after; a bad token 404s without leaking; signing then abandoning the card leaves a SIGNED estimate with no job and no payment; the deposit-paid webhook creates exactly one job across BOTH job tables and one customer, and is safe when replayed (Stripe retries); optional items ticked by the customer change both the total and the deposit and are frozen at signature; reject moves the lead to lost with the reason; an accepted estimate renders read-only and cannot be re-signed or re-paid; the deposit percentage comes from the system type and honors a per-estimate override.

## After

Append a PROJECT-LOG.md entry (By: Claude Code) at the TOP: commit SHAs, what you tested, the idempotency argument for the deposit-to-job path stated plainly, and any judgment call that differs from this prompt.

## Handoff to Dylan (put this in the log)

The first send to a real customer is a decision, not a test, and this one now moves money. Tell him what to do, in this order: send one estimate to himself, approve it, pay the deposit with a REAL card in Stripe test conditions or a small live amount he refunds, and confirm (a) the payment shows on the estimate, (b) the job appears on the Jobs page AND the Job Schedule calendar, and (c) it appears exactly once. Only then does a paying customer see this page.
