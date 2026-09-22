# Sales reporting and pipeline contract

Database migration applied and verified on 2026-09-22 as `20260922173603 sales_pipeline_and_first_send_truth`. The application release uses this schema. The schema migration itself changes no historical business records; any targeted reconciliation is separately recorded.

## Definitions

- **Lead:** one distinct new contact requesting a quote, represented by a pipeline lead. Use the earliest nondeleted lead `created_at` for a linked customer, separately by business. A website inquiry, phone inquiry entered by staff, estimate appointment, or direct estimate contact must have a lead. Booking, rescheduling, sending, winning, losing and archiving do not create another new contact.
- **Estimates sent:** one proposal, once, in the Arizona week of its first successful email or text send. Dual-channel delivery and resends add no extra proposal. The current proposal stage does not determine whether it was sent. Presenting an unsigned quote on a device is not an email/text send.
- A provider-accepted send is a send. It does not claim the recipient opened/read it. A later bounce does not erase the send.
- Weeks run Sunday 00:00 through the next Sunday 00:00 in `America/Phoenix`, using a half-open timestamp range. Current-week values are partial. FTP MBP actuals remain manual under the existing coverage policy.

## Owning records

`customers` owns contact identity; `leads` owns the sales inquiry and pipeline stage. `ensure_sales_lead` serializes canonical lead creation per customer/business. Explicit new-contact forms call it; native on-site estimate appointments and customer-linked estimates enforce linkage in database triggers. Customer CSV imports do not call it. A direct estimate does not imply an appointment was scheduled. An appointment must be an actual native on-site estimate to advance early pipeline stages.

Existing explicit lead links are preserved. Missing links choose the earliest nondeleted lead for that customer/business. Archived or terminal leads are reused without reopening or moving them backward. Historical duplicates are not silently merged.

`pec_estimate_send_attempts` records the proposal, channel, exact recipient and start before contacting the provider. A failed preflight sends nothing. Provider acceptance with a message ID completes the attempt; its transaction updates `pec_estimate_first_sends`, the eligible estimate's sent state, and the linked lead's forward progression. Failed completion cannot leave a partial reporting/stage update. A pending attempt prevents another send on the same channel until verified. HTTP 5xx, 408, network loss, and accepted responses without a provider ID remain uncertain.

`pec_estimate_first_sends` is a server-owned projection of first provider acceptance. It cannot move later because of a resend. A verified recovery with an earlier provider acceptance time can correct it earlier. Browser writes are denied. Existing `estimates.sent_at` remains the most recent sent/presented state for existing workflows; it is not the reporting first-send source.

## Historical coverage

`sales-metrics.cjs` reads all prior evidence before bucketing by report week. It combines the first-send projection with exact `/e/{public_token}` matches from successful estimate email/text receipts, including the actual communication brand names. Tokens and bodies never leave the private server adapter.

Old logs were best-effort. Their earliest available receipt cannot prove there was no earlier missing receipt. For an older proposal, the possible first-send range runs from proposal creation through earliest available receipt. A weekly count is exact when both fall in the same Arizona week; otherwise those historical weeks remain unverified. A ledger event for a legacy resend does not certify the earlier history. New proposals created after the first recorded durable tracking activity can use their first-send record across weeks. Pending earlier sends still make affected weeks unavailable.

New contact records without a pipeline lead also make their affected lead week unavailable, because a contact may be an import or a missed inquiry. Source failures, missing migration objects, and pagination caps never turn into confirmed zeros. Existing manual/imported values are preserved and labeled; use the existing **Use TopCoat** control to return an override to a verified automatic source.

## Release and historical reconciliation

1. Integrate this branch with current main while preserving other sessions' commits. Apply `supabase/migrations/20260922162337_sales_pipeline_and_first_send_truth.sql` before deploying dependent code. Verify RPC grants, triggers, both tables, recipient/identity protections, and the unique pending-attempt index. Run the isolated rehearsal using `PGLITE_MODULE` when the package is outside normal module resolution.
2. Run the full application test suite, source parse checks, and synthetic desktop/mobile checks. Deploy and verify the served source and owner endpoint under an actual owner session. Do not send real customer messages as test fixtures.
3. Run `missing-pipeline-leads-dry-run.sql` with explicitly reviewed dates. The list includes supporting appointment/proposal/send evidence and is not permission to insert all customers. Review import-only/ambiguous contacts and preserve the actual first-contact date. A separately authorized backfill must be idempotent, support dry-run, and link the existing appointments/estimates to the new canonical lead without inventing a visit, send or sale. Reconcile the derived current stage from actual evidence. Do not enroll historical contacts into a fresh nurture campaign.
4. Run `first-send-evidence-dry-run.sql` for historical review. Do not certify an across-week earliest receipt as first without evidence. No historical send rewrite is required for same-week reconstructed counts; the reporting adapter reads the receipts directly.

The reviewed September 14–20 repair was applied on September 22: seven leads restored with original contact dates, six proposals and three appointments linked. See `week-2026-09-14-pipeline-reconciliation.md` and the default-read-only SQL emitter `scripts/reconcile-sales-week-2026-09-14.cjs`. Other incomplete historical records remain unverified.

## Pending send recovery

This is a private service operation, not a customer resend or a browser write. Read the pending attempt's proposal, channel, recipient and start time. Prefer an existing successful communication log's provider ID. If unavailable, use provider history to match the exact recorded recipient, exact proposal URL and attempt time. Absence from an incomplete search is not proof of failure.

With affirmative provider evidence, conditionally update that same `pending` attempt to `sent`, recording the real provider ID and original acceptance time in `completed_at`. The database updates the projection and eligible stages atomically. A definitive rejection can be recorded as `failed`, with its known time and reason. Never move an attempt to failed merely to unlock the send button. Do not edit completed attempts or create a new customer send to repair a metric. Re-read the attempt, first-send row, estimate and lead to verify the outcome before retrying an uncertain database response.

## Historical audit and calendar correction, 2026-09-22

The working Sales Plan and Revenue Produced views show Saturday closing dates and use Sunday-through-Saturday Arizona ranges. Saved Sunday workbook keys remain stable for field addresses and revisions; the immutable original source view retains its source labels. Imported/manual values are preserved with their original source meaning. This changes report grouping, not activity timestamps.

The retrospective audit compared 161 TopCoat customers and 119 jobs with private DripJobs exports (516 YTD lead rows, 328 proposal rows and 148 closed deals). DripJobs proposal totals include 23 records marked Not Sent, so that headline is not a first-delivery count. The export does not alone certify first versus latest delivery. Original inquiry dates differ from many TopCoat import dates. Do not bulk-create historical leads from customer import timestamps or copy external aggregate totals.

Thirty uniquely matched native/imported CRM jobs had their signed_date corrected to the original DripJobs Date Accepted: eight missing dates and 22 import dates. Matching required customer name plus email or phone, exact price, and a single external match. A reviewed private allowlist pinned the current customer, prior date, deal ID and price. The transaction rejected drift, recorded before/after audit_log rows under historical-booking-dates-2026-09-22, and changed no other job fields. No customer communication, owner document, transaction amount, or protected sheet was changed.

Remaining undated jobs prevent certification of historical bookings/completions. The live adapter separately checks date completeness, returns unavailable for affected metric families and retains saved inputs with source-unavailable labels. Absence of a date is not zero activity. Older source coverage, duplicate contacts and first-send gaps remain unresolved; this audit does not certify all historical totals.

Private evidence lives outside the public repository at Documents/Codex/TopCoat-Historical-Audit-2026-09-22. The generic reconciliation emitter defaults to read-only and its isolated PostgreSQL rehearsal verifies replay, rollback on drift, field preservation and duplicate rejection.
