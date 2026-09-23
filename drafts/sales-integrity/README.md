# Draft: reliable sales reporting from the first contact onward

Prepared September 23, 2026. **Design and executable policy draft, not a production change.** The companion policy has no database connection and is not imported by the application. Historical corrections already verified in production remain separate from this draft.

## The operating result

A new quote request creates one sales opportunity, whether the customer is new or returning. Scheduling and proposals attach to that opportunity. A successful first proposal send, an accepted job, and completed work each record their own business date and source. Weekly reports use those records in Sunday-through-Saturday Arizona weeks. Missing or contradictory evidence produces a specific task to resolve, never a confidently displayed zero.

The office should not need a separate spreadsheet or a weekly reconciliation ritual. Exceptions should be discovered when the work is entered. No software can recover an unrecorded historical fact automatically; the goal is to prevent avoidable gaps and make the remaining exceptions explicit.

## Confirmed causes in the current application

| Current behavior | Consequence | Draft correction |
|---|---|---|
| `canonicalLeads()` in `production/sales-metrics.cjs` groups by customer and keeps the earliest lead. | A separate request from a returning customer disappears from lead totals. | Count distinct qualifying inquiries, with explicit duplicate links where records represent the same request. |
| `contact_lead()` in the September 22 migration reuses the customer's earliest lead, including terminal/archived records. The manual New lead form calls it. | New work can attach to an old accepted/lost opportunity. | Separate “create new inquiry” from “attach follow-up”; preserve a request identifier across retries. |
| `pec-lead-intake.cjs` additionally folds same-person submissions within a 90-day window into an existing lead. | A different platform submission or request can be mistaken for a retry. | Deduplicate delivery retries by source event ID. Contact matching determines customer identity, not whether work is new. |
| `completeActiveJob()` changes production status, then best-effort stamps the CRM completion date using a DripJobs ID. | A missing external ID or failed second write leaves completed work undated. | One authorized transaction updates the explicitly linked CRM and production jobs and writes the completion evidence. |
| DripJobs acceptance and completion handlers use receipt-day “today.” | A delayed or replayed event can put work into the wrong week. | Use the original source occurrence date; missing event dates become exceptions. |
| Imported customer creation time can be treated as first contact, and native/imported rows share a broad missing-lead warning. | Import batches distort lead history; administrative or test records can obscure genuine gaps. | Record intake origin and inquiry date separately; classify imports and explicit reporting exclusions with evidence. |
| Booked/produced dollars read the job's current mutable price. | Later amendments can restate previous weeks. | Preserve event amount snapshots and report explicit adjustments; settle the treatment of change orders before changing live dollar calculations. |

## Staff workflow

1. **New request:** choose or create the customer and enter the work requested. A matched returning customer still receives a new inquiry. Keep source and request description visible. First-contact date defaults to the server-recorded current date; older dates require a reason and supporting reference under Advanced.
2. **Follow-up or reschedule:** retain the existing inquiry ID. If there is one active inquiry, it can be selected automatically. If there are several, show their request descriptions and dates so staff select the correct one. Never choose the oldest silently.
3. **Estimate scheduled:** save the appointment and inquiry association together. Cancellation/rescheduling retains identity. Only early pipeline stages advance automatically; accepted/lost work is not reopened as a side effect.
4. **Proposal sent:** retain the existing successful-send ledger. Re-sending or sending by two channels adds delivery history, not another proposal. Ambiguous provider outcomes stay pending until checked. Drafts and on-screen presentations do not count as sent proposals.
5. **Booked:** a native acceptance records the actual acceptance instant and resulting job in one transaction. An imported/external acceptance needs the original accepted date. A manually added booked job asks for “Date accepted”; creating/importing the row does not supply that fact.
6. **Completed:** “Mark complete” displays the completion date, defaulting to today for a staff action. It saves CRM status/date, linked production status/date, and evidence together. Repeating the action preserves the original date. A later correction requires an audited amendment.
7. **Exceptions:** a compact reporting-health indicator opens the specific records with missing dates, conflicting amounts, failed links, or uncertain delivery. It says which metric/week is affected and what action resolves it.

## Sources of truth and proposed data contracts

| Metric | Authoritative record | Deduplication and date rule |
|---|---|---|
| Leads | One qualifying inquiry/opportunity, linked to a customer | One count per canonical inquiry ID on its original inquiry date. Repeat work is a new inquiry. Duplicate transport events and follow-ups are not. |
| Estimates sent | Existing `pec_estimate_first_sends`, verified original receipts, and explicit historical owner confirmations | One count per proposal on its first successful send. Preserve date-only testimony as date-only. |
| Jobs booked | Audited acceptance event linked to the exact job/proposal | One booking per job, on original acceptance date; retries reuse the event ID. |
| Completed work | Explicit staff/source completion event linked to the exact CRM/production job | Completion business date, not import day, cleanup timestamp, or planned installation start. |
| Dollar totals | Proposed acceptance/completion amount snapshots and explicit adjustment events | No silent movement of historical dollars when a current price is edited. This is an additional change from current reporting. |

Reuse `leads.id` as the inquiry identity rather than inventing a second pipeline. Add an original calendar date, optional exact occurrence timestamp, origin, evidence reference, and stable intake request key. Imported date-only evidence must not be converted into an invented precise timestamp. Keep customer `created_at` as record creation time.

Use an explicit canonical/duplicate relationship for reviewed duplicate inquiries. Do not retroactively collapse every customer to one inquiry. Preserve original rows and audit the classification. Administrative/test exclusions require an explicit flag, reason, and authorized review; a suspicious name is not enough to delete or exclude a record.

For future business events, store entity/inquiry IDs, event type, occurrence date, optional exact timestamp, recorded-at timestamp, actor/source, unique source event key and evidence reference. Preserve evidence by adding amendments rather than editing the original event. Foreign keys, unique request/event keys and brand/customer validation belong in the database. Staff/customer permissions must be checked there as well as in the interface.

## Implementation sequence and exact integration points

### 1. New inquiry versus existing request

Add separate database operations to create an inquiry idempotently and attach a record to an existing inquiry. Use a stable request key per open intake form or platform event, enforced by a unique database constraint; a read-then-insert check is insufficient under concurrent deliveries. Require the same company/customer on linked records. Keep existing RLS boundaries, and explicitly revoke unauthenticated function access.

Update the manual `openNewLeadModal`, new-customer entry points, appointment entry and estimate entry in `index.html`; `pec-lead-intake.cjs`; `pec-appt-intake.cjs`; `pec-booking.cjs`; and any other caller of `_pec-lead-match.cjs` found during implementation. Update the database estimate/appointment link triggers and the reporting adapter. Public booking creates a new inquiry only when it represents a new request; a manage/reschedule operation preserves the existing one. Google calendar blocks do not create inquiries.

An integration without a stable submission identifier cannot safely distinguish a retry from separate work. Configure the upstream event ID where available; otherwise retain the intake in an exception queue. Do not replace that missing contract with a broad same-phone/90-day rule. Source matching and consent behavior remain independently enforced.

### 2. Atomic booking and completion

Introduce an authorized completion operation with a stable action/request ID, CRM job ID, optional explicitly paired production job ID, completion date and evidence. Lock and validate the pair; write statuses/date/audit together; return the saved state. The UI reports success only from that response. Support CRM-only work explicitly; production-only rows need a reviewed CRM link or a clearly classified non-CRM workflow, not silent partial success.

Route every completion path through this operation: CRM invoice completion, job-list completion, production detail completion and external completion handlers. Prefer `pec_prod_jobs.crm_job_id`; validate any legacy external-ID fallback is unique before using it. Do not merge jobs or create a CRM job solely because an external ID is absent. Review existing status-mirroring triggers before adding new ones to avoid recursion or competing writers.

At database level, protect prospective booked/completed transitions from missing evidence. Keep an explicit historical-import staging path so old unresolved records can be loaded without being falsely certified. Unrelated edits to existing legacy exceptions must remain possible. Validate old records before tightening constraints; do not run a blanket backfill to satisfy a new NOT NULL rule.

Update `pec-webhook-proposal-accepted.cjs` and `pec-webhook-project-completed.cjs` to consume source occurrence dates and stable event IDs. A delayed webhook must not use its delivery day as the business date. Stage undated events and expose the exception; retrying them must neither duplicate jobs nor create communications. The native acceptance path in `pec-public-estimate.cjs` retains signature/acceptance safety and captures the same transaction's actual date.

### 3. Reporting health and traceability

Show the source record list behind each automatic weekly total, with first-contact/send/acceptance/completion date, source and any correction. Show manual overrides distinctly and preserve the immutable imported workbook. Add exception states for unresolved, resolved and explicitly excluded, with actor/reason/evidence and affected metric/time range. Unknown historical dates may affect a broad range; do not claim precise completeness where that range is unknown.

Run integrity checks after relevant writes and through an application maintenance check. No Codex reminder or external notification automation is installed by this draft. Keep alert routing and repetition interval under existing operator settings; proposed defaults should alert once on a new actionable failure and clear on resolution rather than repeat unchanged warnings.

### 4. Historical reconciliation and release

Keep the original source exports immutable. Prepare reviewed mappings between source inquiry/job identifiers and TopCoat records. Separate singular matches, repeated requests, duplicate identities, missing source history and explicit test/admin records. Apply only evidence-backed date/link repairs, with dry-run output, exact row preconditions, locks, idempotency and before/after audit. Preserve prices until conflicting amounts are resolved.

Rehearse migrations and role boundaries in an isolated database. Test all writers against the new contracts before enforcing them in production. Deploy migration prerequisites before dependent code. Verify live intake, booking, first-send and completion using safe synthetic fixtures outside production, then verify the real read-only reporting output after deployment. Release from a dedicated branch after this draft is accepted; this draft itself changes no live workflow.

## Acceptance checks

- Same customer requests separate work: two inquiry counts, one customer identity, correct original dates.
- Exact form/webhook retry: one inquiry and one business event, including concurrent requests.
- Same request rescheduled or followed up after acceptance: no new inquiry; no stage regression.
- Two active inquiries: an appointment cannot silently pick the wrong one.
- Wrong-company/customer links: rejected in the server/database write path.
- Proposal resend, email+text send, later status change or deletion: first-send count and week unchanged.
- Saturday 11:59:59 PM versus Sunday midnight Arizona: separate reporting weeks.
- A webhook arrives days late: original event date wins; missing/contradictory dates create an exception.
- Staff completes a native job with no DripJobs ID: CRM and production dates/statuses commit together.
- Injected failure between completion writes: all writes roll back; no false success, review ask or customer message.
- Duplicate completion retry: original date and amount preserved; conflicting correction requires an amendment.
- Historical date-only import: no invented timestamp, new-lead communication or current-week count.
- Manual/saved workbook values: retained, visibly distinguished from automatic sources.
- Accepted/completed amount edit: no silent restatement after the amount-snapshot policy is implemented.
- Mobile at 360px: new-request/follow-up choice and completion date remain usable.

`policy.test.cjs` currently covers nine focused decision-contract scenarios. The completion prototype covers paired CRM/production jobs only; the CRM-only operation described above remains to be implemented. These are not integration, security, concurrency or database-transaction tests. All of those remain required before shipping the implementation.

## Outstanding decisions and historical facts

Already decided by Dylan: new requests from returning customers count; proposals count once on first send; weeks are Sunday through Saturday in America/Phoenix; reviewed DripJobs schedule end dates may establish historical completion.

Still requiring evidence: conflicting job amounts/dates and ambiguous duplicate versus separate historical requests. Private customer lists and source exports remain in the audit folder, not this repository or public assets.

Pending classification decision: whether material-only sales contribute revenue without increasing the jobs-booked count. Preserve these records and current reporting until that decision is confirmed; use an explicit sale type instead of inferring it from price or description at report time.

Recommended dollar policy for approval before implementation: freeze original booked value on acceptance, report signed change-order adjustments on their own acceptance dates, and record final completed value on completion. Cancellations/credits need explicit adjustment events as well. Until approved and implemented, current contract-price-based dollar reporting remains unchanged and labeled accordingly.
