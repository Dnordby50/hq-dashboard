# Claude Code Prompt 31: Batch change-order approval (send multiple pending COs for signature at once)

## Context

Today each change order is an independent signature record with its own token and its own hosted `/co/<token>` approval page. The Change Orders card (mountChangeOrderCard, index.html ~9360) renders one accent box per CO, each with its own Copy / Email / Text / View buttons. A customer with three pending change orders gets three separate links and signs three separate pages.

Dylan wants pending change orders bundled: when a job has 2 or more pending (unsigned) COs, they go out as ONE approval request, on ONE page, approved with ONE signature. Scoped by Cowork on 2026-07-16 through 12 multiple-choice decisions (all final, below). Repo HQ-Dashboard, branch main.

This is delivery / approval UX only. Nothing about how or when a change order bills changes.

## What exists today (verify in code before building; do not guess)

- pec_change_order_signatures: one row per CO. openChangeOrderModal (~9078) mints a row per CO (token to /co/<token>) storing a snapshot (title, amount, system_name, sqft, description), status pending|signed, and on sign: signed_name, signed_at, a drawn-signature data URL, ip, user_agent. Confirm the exact live columns before writing the migration.
- mountChangeOrderCard (~9360): renders one .pec-co-box per row, created_at ordered, "Change Order #N", a status pill (Pending signature / Signed <date>), a 6-column line table, and actions: Copy link (data-co-copy), Email link (data-co-email), Text link (data-co-text), View (data-co-view). Email uses pecSendEmail (Resend, log_template_key 'change_order'); Text uses pecSendSms (Quo, kind 'change_order', co_token). Both surfaces mount the same card: Invoicing detail (invCoCard ~9657) and the job-detail Estimate section.
- The public approval page is server-rendered static HTML, token-gated, X-Robots-Tag noindex, mirroring the pec-public-invoice pattern. Find the exact Netlify function that serves /co/:token (netlify/functions, likely pec-public-co.cjs) and its sign POST endpoint before designing. The sign write is verify-then-insert, no blind retry (payment-path discipline).
- Billing: a change order hits jobs.price and the invoice IMMEDIATELY at save, and unsigned COs never block billing (signature is documentation). Do not change this.

## Dylan's decisions (all final)

1. Batch triggers AUTOMATICALLY at 2 or more pending COs on a job. With exactly one pending CO, behavior is UNCHANGED: today's per-CO link, page, badge, and Email / Text / Copy / View buttons stay exactly as they are.
2. When 2+ are pending, batch is the ONLY send path. Remove the per-CO Email and Text buttons in that state and replace them with a single batch send. Copy link and View also become batch-level (one link, one page).
3. Only pending (unsigned) COs are part of the signature.
4. The batch approval link is ONE STABLE link per job. It always renders whatever COs are currently pending, so a CO added after the link was sent auto-appears on the same link with no re-mint. Re-sending reuses the same link.
5. Combined page layout: each pending CO as its own stacked section (title, scope description, system + sqft, price), then a grand total across all pending COs, then ONE signature block (typed name + drawn canvas) that approves all of them.
6. Each pending CO still shows its own price / total in its section, AND the page shows a summed grand total that the customer is approving.
7. Already-signed COs on the job appear on the page as read-only "already approved" context (greyed), NOT part of the new signature.
8. One signature approves all. A single typed name + drawing marks every currently-pending CO signed in one action.
9. Storage: ONE batch signature record holds the signature (typed name, drawing data URL, signed_at, ip, user_agent) plus a snapshot of exactly which CO ids it signed. Each of those COs links to the batch and flips to status signed. New table + migration; do NOT fold the signature onto each CO row. The existing single-CO sign path (decision 1) keeps writing to the per-CO row as today.
10. Scope guardrail: approval delivery and signature only. Billing still hits jobs.price and the invoice at save, unsigned COs never block billing, the signature stays native in-stack, no new vendor, no new monthly cost.

## Build notes

- Data model: add a batch signatures table (for example pec_change_order_batch_signatures) keyed to job_id with a stable token (one active batch link per job; reuse/upsert the job's token rather than minting per send, per decision 4), status pending|signed, signed_name, signed_signature (data URL), signed_at, ip, user_agent, and the signed CO set (a uuid[] column or a join row set) capturing exactly what was signed. Give pec_change_order_signatures a nullable batch_id (or signed_batch_id) FK so a CO signed via batch points at the batch, and its per-CO badge can read the batch's signed_at. Migration idempotent, verify queries at the bottom, Cowork applies. UI degrades gracefully pre-migration: if the batch table / columns are missing, fall back to today's per-CO behavior with a note, never break the card (prompts 6/8/10 discipline).
- Capture the signed set AT SIGN TIME, not at send time, because the link is live (decision 4). The sign POST reads the job's currently-pending COs, records their ids on the batch row, and flips exactly those to signed. A CO added between the last page render and the click is included; a CO signed some other way is not re-signed.
- Card (mountChangeOrderCard): when the job has 2+ pending COs, render the pending ones under a single batch header with ONE set of actions (Copy batch link, Email batch, Text batch, View batch), and render the signed COs as their existing signed boxes (or a compact signed list). With 0 or 1 pending, render exactly as today. Keep the data-attribute wiring-contract style; add batch-level data attributes rather than overloading the per-CO ones.
- Public page: extend the /co function family (or add a sibling, for example /co/batch/:token) that renders all currently-pending COs for the job stacked, the already-signed COs read-only, the grand total, and one signature canvas. Static server-rendered HTML, X-Robots-Tag noindex, no client frameworks, brand-styled and printable like the invoice / CO page. After signing it renders the signed document (all signed COs + one signature block + grand total, printable).
- Sign endpoint: verify-then-insert, no blind retry (a retry must not double-sign). Store typed name, drawing data URL, signed_at, ip, user_agent on the batch row and flip the captured COs to signed in the same serialized operation. Do not wrap this non-idempotent write in a blind auto-retry.
- Send buttons: reuse pecSendEmail (Resend) and pecSendSms (Quo). Keep log keys OUTSIDE the Last-invoiced predicate: the prompt-9 predicate counts template_key 'compose'/'invoice' and sms kind 'invoice', so the batch send must not pollute it (keep the 'change_order' template key / kind). Email subject and body and the SMS say that N change orders need approval and carry the one batch link plus the grand total. No auto-send at save.
- Single-CO path untouched (decision 1). Do not regress the existing single-CO link, page, badges, or send buttons.
- What's New: this is user-facing, so append one entry (id, date, title, one-line summary, 2 to 3 plain-language steps, no em dashes) to help/whats-new.json, newest first, and validate the JSON.
- Do NOT touch: supabase client config, timedFetch, wedge recovery, payment paths, the two-modal-roots rule (the CO modal keeps openModal / #pecModalRoot). No em dashes anywhere. Run node --check on every touched or extracted script block. PROJECT-LOG entry on top. Do NOT apply the migration from the Claude Code session (Cowork applies it).

## Handoff to Cowork (put this in your log entry)

1. Apply the migration(s) to PROD (project HQ Dashboard, zdfpzmmrgotynrwkeakd), run the verify queries, and report results: the batch table and columns exist, RLS follows the sibling pec_change_order_signatures pattern (if the signing function writes via service role, confirm anon cannot write the signature), and the batch_id FK on pec_change_order_signatures is present.
2. Post-deploy verification with Dylan: on a test job, add 2 pending COs and confirm the card collapses to a single batch send; send the batch link by text to Dylan's cell; open it and confirm both COs render stacked with a grand total; add a 3rd CO and confirm it auto-appears on the same already-open link; sign once and confirm all three flip to Signed, one batch record holds the signature, and the printable signed document shows all three plus one signature block.
3. Confirm the single-pending-CO case still behaves exactly as before.

## Handoff to Dylan

1. Push to deploy after Cowork applies the migration.
2. Live end-to-end test per Cowork item 2 on a real or test job.
