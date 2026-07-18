# Claude Code Prompt 12: Change orders as scope (new-area change orders, materials flow, customer signature)

## Context

Dylan wants change orders to carry actual SCOPE, not just a dollar amount. Today "Add change order" lives only on the Invoicing panel (pecInvChangeOrder, index.html ~8173) and appends a title + manual price line to jobs.line_items, bumping jobs.price. Nothing flows to production: no materials, no labor budget, no ordering, no crew paperwork. Scoped by Cowork on 2026-07-09 through 17 multiple-choice decisions. Repo: HQ-Dashboard, branch main.

RUN ORDER: Dylan wants this NEXT, BEFORE prompts 10 (subcontractor expenses) and 11 (ACH). You are first in the queue; prompts 10 and 11 will run after and their line references will drift, which is fine since all three say grep for symbols.

## What exists today (verified in code)

- Invoicing change-order modal (~8349): title, optional description, manual amount. Appends { name, description, price, is_change_order: true } to jobs.line_items and bumps jobs.price via one withFreshWrite update. This is the sanctioned way to adjust a finalized total.
- Job detail Estimate section (~10884): renders is_change_order lines READ-ONLY and, when finalized, tells the user to add change orders from the invoice (~10904). saveJob regenerates line_items from areas but explicitly preserves change-order lines (~11239-11283) unless line_items_manual_override is set.
- Estimate areas: job_areas rows (system_type_id, sqft, price, description) sum to the job price; recipes/formulas compute materials from system + sqft on the production side.
- TWO PARALLEL JOB TABLES (Architecture Gotcha, respect it): public.jobs/job_areas feed the Jobs page and invoicing; pec_prod_jobs and friends feed the schedule and Job Costing. Job Costing's derived material lines and crew-hours expectations live on the production side. A change order added on the CRM side MUST reach the production side or costing/materials will not see it. Diagnose the existing bridge (dripjobs_deal_id, jobNameAddrKey fallback, how estimate lines currently reach costing derivation) before designing; do not guess.
- Public token page pattern: pec-public-invoice.cjs renders /pay/:token server-side, static HTML, token-gated by UUID. Mirror this pattern for the signature page.
- Send paths that exist and work: pec-send-email.cjs (Resend) and pec-send-sms.cjs (Quo), both already used for invoices with per-job logging (pec_email_log, pec_sms_log).

## Dylan's decisions (all final)

1. Button placement: Add change order on the Jobs page job detail (the Estimate section, where change-order lines already display read-only) AND keep the existing Invoicing button. Both open the same flow. They must stay in sync automatically; since both write the same jobs.line_items/job_areas data there is one source of truth, so this is free, just verify both surfaces re-render.
2. A change order is a NEW AREA LINE: system selector + square footage, exactly like current estimate line items work. That is the primary mode.
3. Keep a simple mode too: the current title + manual amount path must survive for non-scope change orders (e.g. "haul away debris, $200"). One modal, two modes; simple mode behaves byte-for-byte like today's.
4. Price pre-fills from the same sqft pricing the estimator uses for that system, EDITABLE before saving.
5. Materials auto-derive from the recipe formulas into the job's estimated material lines in Job Costing, same as original estimate areas. No re-entry.
6. Labor: the change-order area contributes budgeted labor hours to crew-hours expectations like a normal area, so crew bonus math stays fair on changed jobs.
7. Ordering + crew paperwork: change-order materials must be visible to the PEC Order Sheet workflow and the crew work order / job cards. Those two are Cowork-side skills reading from the DB, so your job is to make sure the derived material lines and the change-order area are queryable/flagged (is_change_order on the area row); the skill updates are a Cowork handoff, not your code.
8. Customer invoice shows ONE line: title + price with the existing (change order) marker. Materials stay internal.
9. Permissions: same as today's Invoicing button. No new gate.
10. Billing timing: the change order hits jobs.price and the invoice IMMEDIATELY at save. Signature is documentation, not a billing gate.
11. Signature: NATIVE, in our stack, no vendor. Dylan's words: "whatever is easiest, no customer sign-in preferred, something we can integrate directly onto our page." Build a token-gated hosted approval page (pec-public-invoice pattern): renders the change-order details (job, customer, scope description, system + sqft when present, price) with an Approve & sign action, typed name plus drawn-signature canvas, recorded with timestamp and IP/user agent. No login, no third party. If certified audit trails ever matter, an e-sign API can replace the page later; note that in a comment.
12. The customer signs a generated change-order document: the approval page IS that document (printable, brand-styled like the invoice page); after signing it renders/downloads with the signature block filled. A separate PDF pipeline is not required if the signed page prints clean.
13. Send for signature: buttons for BOTH email (Resend path) and text (Quo path) on the change order, mirroring the invoice send buttons, logged to the same log tables with a distinct kind/template key so Last-invoiced logic is not polluted (check the prompt-9 predicate: it counts template_key 'compose'/'invoice' and sms kind 'invoice'; pick keys outside those).
14. No auto-send of anything at save.
15. Status: change order shows pending-signature / signed state as a badge on the job detail and Invoicing line. Unsigned COs never block billing (decision 10).
16. Verification/UX stays on our page; nothing run locally on Dylan's machine, no new vendors, no new monthly costs.
17. Ships first, before prompts 10 and 11.

## Build notes

- Data model: prefer is_change_order boolean (+ created_at, and signature fields or a small pec_change_order_signatures table keyed to the area/line) on job_areas for area-mode COs, so price summing, materials derivation, and labor budgets inherit for free. Keep jobs.line_items generation marking those lines is_change_order so the invoice renders them with the existing badge. Legacy line-item-only COs (existing data) must keep rendering everywhere they do today. Migration idempotent, verify queries at the bottom, Cowork applies; UI degrades gracefully pre-migration (missing column/table shows a note, never breaks the page; prompts 6/8/10 discipline).
- Finalized estimates: adding a change-order area must work on a FINALIZED job without unlocking the original lines (that is the whole point). Reconcile with the finalize invariants: line prices sum to job price; saveJob regeneration preserves CO lines; line_items_manual_override interplay (~11276). Trace every path that recomputes price before writing.
- Production bridge: change-order area must reach the production job so Job Costing derives its materials and labor. Find how original areas get there today and reuse that path. If the job has no production twin (manual entries, edge cases), degrade with a visible note, never a silent drop.
- Derived material lines: the Eric Harris lesson (prompt 8, 2026-07-06 08:07 entry) applies. Whatever re-derivation the CO triggers must go through the per-job serialized persist chain; never a second concurrent delete-then-insert path.
- Signature endpoint: new Netlify function (or extension of the public-invoice function family) with its own UUID token per change order. Signature write is non-idempotent: verify-then-insert, no blind retry (payment-path discipline). Store typed name, drawn signature (data URL), signed_at, IP, user agent. The page is static server-rendered HTML like /pay, X-Robots-Tag noindex, no client frameworks.
- Send buttons: reuse the invoice email/text composer patterns including the office alert conventions. Message contains the approval link. Distinct template/kind keys per decision 13.
- Do NOT touch: supabase client config, timedFetch, wedge recovery, payment paths, both modal roots rule (the CO modal should use openModal/#pecModalRoot like its Invoicing sibling; if any production-view surface is touched, remember #prodModalRoot flows are separate).
- Standing rules: commit per meaningful change, node --check every extracted script block and touched function, no em dashes anywhere, PROJECT-LOG.md entry on top, migration NOT applied from your session.

## Handoff to Cowork (put in your log entry)

1. Apply the migration(s) to PROD, run verify queries, report results (columns/table exist, RLS on any new table follows the sibling pattern, no client write policy on signature storage if the webhook/function writes it; if the signing function writes via service role, confirm anon cannot).
2. Update the pec-order-sheet and pec-work-order skill workflows to include change-order materials/scope (they read the DB; confirm the CO area and derived lines surface in what they query, and adjust the skill docs if the queries need a filter change). Report what changed.
3. Post-deploy verification with Dylan: add an area-mode CO on a finalized job from the job detail; confirm price pre-fill, invoice line, costing materials + labor budget, order-sheet visibility; send the signature link by text to Dylan's cell; sign it; confirm the signed badge and the printable signed document.

## Handoff to Dylan

1. Push to deploy after Cowork applies the migration.
2. Live test end to end on a real (or test) job per Cowork item 3.
3. Sequencing reminder: prompts 10 (subcontractor expenses) and 11 (ACH) run AFTER this one. Do not enable ACH in Stripe until prompt 11 deploys.
