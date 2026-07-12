# Claude Code build prompt 16: the customer-facing estimate (send, sign, accept, job)

RUN THIS ONLY AFTER PROMPT 15 IS SHIPPED AND VERIFIED. Prompt 15 built the thin estimator modal, the pricing/comps panel, and the estimate as a numbered object with its own page. This prompt turns that internal object into a document a customer signs, and makes an accepted estimate become a job. Read prompt 15's PROJECT-LOG entry first: it names what was left stubbed for you (at minimum a disabled "Send to customer" button on the estimate page).

## Context

Repo: hq-dashboard (github.com/Dnordby50/hq-dashboard, main). Deploy: prescottepoxy.netlify.app. Supabase: zdfpzmmrgotynrwkeakd. This is the last piece of the DripJobs exit for the sales side: today a proposal goes out of DripJobs, the customer signs there, and the deal comes back to us over a webhook. After this build, the estimate is ours end to end.

Prompt 15's migration already created every column you need (status set including sent / signed / accepted / change_requested / rejected, change_request_note, rejected_reason, rejected_at, line_items jsonb with optional items, customer_*), and estimates has carried public_token, signature, signed_name, signed_at, signed_ip, sent_at, accepted_at, job_id, and pec_prod_job_id since it was created. Verify that against the live schema before you write a migration; you probably do not need one.

## Decisions locked with Dylan (do not relitigate these)

1. The estimate page is PRIVATE UNTIL SENT. The public link must not resolve before sent_at is set; it 404s exactly like an unknown token. Sending is what makes it live.
2. The customer can do exactly THREE things: accept and sign, request changes with a message, or reject with a reason. Nothing else.
3. NO payment on this page. No Stripe, no deposit. Dylan named sign / request changes / reject and nothing more, and the deposit already has a working home in the invoice path. Do not build a second money path. If you believe this is a mistake, write the argument in the log; do not build it anyway.
4. Optional line items are tickable by the customer, and ticking one changes the total they are signing for. What is selected at signature time is what freezes onto the accepted estimate.
5. Accepting creates the JOB.

## The build

### 1. Send

- A send action on the estimate page that emails the customer their link. Reuse pec-send-email.cjs rather than duplicating a mail path; extend it if you must, but do not stand up a second Resend integration.
- Sending sets estimates.sent_at, flips status to sent, and writes an activity row. It is the ONLY thing that makes the public link resolve.
- The link is /e/<public_token>. Add the rewrite to netlify.toml next to the existing /pay/* one. The token is minted when the estimate is created but is inert until sent_at.
- The estimate page's "Copy link" button stays disabled until sent, so nobody hands out a URL that 404s.
- STOP AND ASK DYLAN before the first real send. Emailing a customer is an external communication; do not fire one at a live address as a smoke test. Test against Dylan's own address only, and say so in the log.

### 2. Public estimate page: netlify/functions/pec-public-estimate.cjs

Model it on pec-public-invoice.cjs, which already solved every hard part of this exact problem: server-rendered HTML with no client framework, an unguessable UUID token acting as a bearer in the URL, a generic 404 on any miss that never leaks the token or DB detail, noindex/nofollow so shared links are not crawled, and the voltcoatings-inspired PEC look (white cards with soft shadows on off-white, a dark ink hero band with the number and the amount in big tight type, uppercase letterspaced eyebrow labels in accent orange, chunky rounded buttons, dark footer with the accent rule). The estimate and the invoice must read as the same company.

Page contents: the estimate number, the customer block, the scope (system, sqft, MVB, flake color if chosen), the line items with an OPTIONAL ITEMS section the customer can tick, the total, and the three actions.

The three actions:
1. ACCEPT: the customer types their name as the signature. Writes signature, signed_name, signed_at, signed_ip, sets accepted_at, freezes the selected optional items and the final total, and flips status to accepted. Then creates the job (section 3).
2. REQUEST CHANGES: a message box. Writes change_request_note, flips status to change_requested, and notifies Dylan (Slack #epoxysales C09AZE8CU0Z or email, whichever is already wired; do not build a new notification channel).
3. REJECT: a reason. Writes rejected_reason and rejected_at, flips status to rejected. Also move the LEAD to lost with that reason, since lost_reason is what conversion-by-source in Metrics reads.

An estimate that is already accepted, rejected, or superseded shows a read-only state instead of live buttons. A signed document must not be re-signable.

### 3. Accept creates the job

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

- Do not touch the invoicing, payment, commission, or change-order code paths.
- The public page is the only unauthenticated surface here. It reads and writes through the service role INSIDE the function. Never grant public RLS on estimates, never accept an estimate id from the client (the token is the only key), and never echo the token back into the page in a way that could leak through a referrer.
- Rate-limit or at minimum guard the three public actions against replay; a stranger with a leaked link should not be able to spam change requests.
- Both modal roots, if you touch modal lifecycle.
- No em dashes anywhere.
- One What's New entry: the customer can now sign an estimate online.
- Harness tests, driving the real extracted functions: the public route 404s before sent_at and resolves after; accept writes exactly one job across both tables and is safe when run twice; a double POST creates one customer, not two; optional items selected by the customer land on the accepted total; reject moves the lead to lost with the reason; an already-accepted estimate renders read-only; a bad token 404s without leaking.

## After

Append a PROJECT-LOG.md entry (By: Claude Code) at the TOP: commit SHAs, what you tested, the idempotency argument for the accept path stated plainly, and any judgment call that differs from this prompt.

## Handoff to Dylan (put this in the log)

The first send to a real customer is a decision, not a test. Tell him what to do: send one estimate to himself, sign it, and confirm the job appears on the Jobs page AND the Job Schedule calendar before he sends one to a paying customer.
