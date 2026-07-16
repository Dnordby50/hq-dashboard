# Claude Code Prompt 26: fix the Invoicing "last sent / never sent" read + build a Communication history panel on the invoice page

## Context

Dylan sent Dan Patterson an invoice on 2026-07-16 via the "Email invoice" button on the invoice detail page. He got the green "Invoice sent ✓" toast, but the Invoicing list still shows nothing for that job in the last-sent column. Digging with him: the completed-section last-sent column NEVER shows a real date for ANY completed job. It only ever renders "never sent" (red badge) or a dash. So this is not a Dan-specific miss, the whole last-sent signal is dark.

Cowork scoped this with Dylan through a round of questions on 2026-07-16. Two deliverables, one prompt, in this order: (A) diagnose and fix why the last-sent read is empty, then (B) build a Communication history panel on the invoice detail page so Dylan can see, at a glance, every invoice email and text that went out for a job and when. Customer view-tracking ("when did the customer open it") is explicitly a PHASE 2 follow-up, not this build, because the public invoice page does not record views yet.

Repo: HQ-Dashboard, main. All UI is in index.html. The Supabase project is "HQ Dashboard" (zdfpzmmrgotynrwkeakd).

## What the code does today (evidence, read it first)

- The last-sent value is built in renderInvoicing at index.html:8627-8646. It reads pec_email_log (select job_id,sent_at,created_at, `.in('job_id', completedIds).neq('status','failed').in('template_key', ['compose','invoice'])`) and pec_sms_log (`kind='invoice'`, `direction='out'`, status not failed), then keeps the newest timestamp per job in `lastInvoiceSentByJob`. The read is wrapped in withFreshSession and a try/catch that degrades to `{ data: [] }` and a console.warn "last-invoice-sent lookup skipped" on throw.
- lastSentCell at index.html:8656-8674 renders: an actual date when `lastInvoiceSentByJob[r.id]` exists, otherwise the red "never sent" badge (when the job is stale: past completed_date + 2 and completed on/after INVOICE_LOG_LIVE_DATE 2026-06-15) or a plain dash.
- The "Email invoice" button (compose mode) is at index.html:9609-9684. It calls `pecSendEmail({ brand, subject, body_html, to_email, cc, job_id: row.id, customer_id: row.customer_id })` at 9661 with NO log_template_key.
- Server side, pec-send-email.cjs computes `logTemplateKey = composeMode ? 'compose' : template_key` (line 148-149; compose mode = body_html present), and on a successful Resend send writes pec_email_log with `status: 'sent'`, `job_id`, `template_key: 'compose'` (lines 255-257). The write uses the service-role key, so it bypasses RLS. Failure paths write `status: 'failed'` (251, 262).
- So the WRITE for Dan's invoice is correct and complete: a pec_email_log row with his job_id, template_key 'compose', status 'sent'. That row satisfies the read filter. Yet the read returns nothing for any job.
- Contrast: the estimate send passes `log_template_key: 'estimate'` on purpose to stay OUT of this column (index.html:18226-18228). Do not break that: 'estimate' rows must remain excluded from invoice history.
- The invoice detail page is renderJobInvoice (dispatched at index.html:8556; the Email/Text/Change-order buttons live inside it around 9540-9684). This is the "invoice page" where the new panel goes.
- jobs.invoice_first_sent_at is stamped on the first send (index.html:9668-9673) and is read client-side today (index.html:10172), which proves the client CAN read the jobs table. That column is a reliable first-send fallback if you want belt-and-suspenders on the column, but it is not a substitute for fixing the log read (we need full history, and last != first).
- pec-public-invoice.cjs has NO view tracking (grep confirmed): no viewed_at, no view insert. Customer-viewed is net-new plumbing and is out of scope here.

## Part A: diagnose and fix the empty last-sent read

Follow the CLAUDE.md bug workflow: confirm the cause from the code and the live data BEFORE changing anything.

Leading hypothesis (rank it first, but prove it): pec_email_log and pec_sms_log have no SELECT policy for the authenticated staff role, so the client read returns an empty set under RLS default-deny while the service-role write succeeds. That single fact would make EVERY job show never-sent/dash regardless of real sends, which matches the symptom exactly.

Confirm which cause it is, cheaply, before editing:
1. Service-role query (Supabase MCP): `select id, job_id, template_key, status, sent_at from pec_email_log where job_id = '<Dan Patterson job id>' order by sent_at desc;`. Expect a real 'compose' / 'sent' row. If it exists, the write is fine and the bug is on the read side. (Find Dan's job id via pec_job_ar / jobs by customer name.)
2. Check policies: `select schemaname, tablename, policyname, cmd, roles, qual from pg_policies where tablename in ('pec_email_log','pec_sms_log');`. If there is no permissive SELECT policy for the authenticated role, that is the bug.
3. Have Dylan (or you, if you can reach the live site) open the Invoicing tab with DevTools: Console for the "last-invoice-sent lookup skipped" warning, and Network for the PostgREST pec_email_log request. A 200 with an empty `[]` body and no console warning = RLS deny (hypothesis 1). A non-200 or a console warning = a query error instead (look at hypothesis 3).
4. Secondary hypotheses to rule out: the `.in('job_id', completedIds)` list is long enough to blow the URL length and error the request (would trip the catch and warn), or the rows carry an unexpected job_id/template_key. The service-role query in step 1 settles the data question.

Fix, by cause:
- If RLS (expected): add a SELECT policy on pec_email_log AND pec_sms_log for the staff role, scoped the same way other staff-readable PEC tables are (read an existing staff SELECT policy, for example on pec_payments or pec_job_ar's underlying tables, and mirror its company/role scoping. Do not invent a looser policy). This is a schema change, so it goes in a NEW dated migration under supabase/migrations. Per the do-not-touch-prod rule, WRITE the migration but do not apply it to prod. End your log entry with a `## Handoff to Cowork` giving the exact migration path and a verify query. No index.html change is required for the column to start working once the policy lands, but re-read the degrade path (8630-8637) and make sure a genuine read error still degrades gracefully rather than throwing.
- If a query error (long `.in()` list, etc.): fix it in code (chunk the `.in()` over completedIds, or select the log rows without the id filter and join in memory). No migration.
- If a data problem (job_id or template_key wrong on write): fix the write in pec-send-email.cjs or the caller, and note whether existing rows need a backfill (Cowork handoff if so).

Whatever the cause, the acceptance test is: a completed job that has a real invoice email or text shows its actual last-sent date in the Invoicing list column, and "never sent" only appears for jobs that truly have no qualifying send.

## Part B: Communication history panel on the invoice detail page

Add a "Communication history" section to renderJobInvoice (the invoice detail page). Decisions, all locked by Dylan:

1. Location: a panel on the invoice detail page (not the list, not a tooltip). Newest entry at the top. That newest entry IS the at-a-glance "last sent", so do NOT add a separate "Last invoice sent: <date>" summary line elsewhere. Dylan chose "the panel is enough."
2. Scope: invoice emails + invoice texts for THIS job. Email rows: pec_email_log for the job_id with template_key in ('compose','invoice'). Text rows: pec_sms_log for the job_id with kind='invoice'. Same filter contract as the list column, so the two never disagree. Do NOT include 'estimate' or unrelated template keys.
3. Read shape: one batched pec_email_log read and one batched pec_sms_log read for this single job_id (mirror the list's batched pattern at 8630-8636, never per-row). renderJobInvoice already fetches the AR row; add these two reads alongside. Merge into one list, sort descending by sent_at (fallback created_at). This read depends on the Part A fix being live to return anything, which is why A ships first.
4. Each entry shows FULL detail: date + time in Phoenix time (reuse the existing phxDay / invoice date helpers, do not hand-roll a new tz path), channel (Email or Text), recipient (to_email for email, the phone/customer for text), subject (email subject; texts show a short "Invoice text" label or the body preview if one is stored), a delivery status label, and who on staff sent it (resolve sent_by_user to a name or email the same way the rest of the app resolves staff identities, and fall back to blank if unknown).
5. Status: show ALL attempts including failures, each with a clear status label (sent / delivered / bounced / failed, whatever the row carries). Before you promise delivered/bounced, check what values pec_email_log.status actually holds: the sender writes 'sent' or 'failed' (pec-send-email.cjs), and pec-webhook-resend.cjs may or may not upgrade rows to delivered/bounced. Render whatever statuses exist truthfully. If only sent/failed exist today, show those and note in your log entry that richer delivery states depend on the Resend webhook, which can be a later pass.
6. Empty state: "No invoice emails or texts have been sent for this job yet." Never break the page if the read errors, degrade to a short "Couldn't load communication history" note, matching the app's existing degrade style.
7. Leave a clean seam for phase 2 customer-view tracking (a comment marking where a "Viewed by customer" row would slot in), but build no view-tracking now.

Reuse existing helpers (esc, the invoice date formatters, the pec-badge styles). Match the visual language of the surrounding invoice detail sections.

## Standing rules

Commit per meaningful change (`<area>: <what changed>`, no secrets). node --check every extracted script block and touched function; run npm test and report pass/fail. No em dashes anywhere. Append a PROJECT-LOG.md entry at the TOP. This is a user-facing change, so add one What's New entry to help/whats-new.json (id, date, title, one-line summary, 2-3 plain-language how-to steps, no em dashes). If Part A needs a migration, do-not-touch-prod: write it and hand the application to Cowork in your log entry.

## Handoff to Dylan (put in your log entry)

Tell Dylan the confirmed root cause in plain English (why the sends were written but never read back), what you changed, and the one thing he needs to do: if it was RLS, that Cowork must apply the new migration before the column and panel light up. After that lands, he should reload Invoicing, confirm real dates appear in the last-sent column, open Dan Patterson's invoice, and confirm the Communication history panel lists his 2026-07-16 send with the right time, recipient, subject, and a "sent" status.
