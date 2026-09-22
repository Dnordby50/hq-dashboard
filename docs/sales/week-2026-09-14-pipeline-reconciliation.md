# Reviewed September 14–20 pipeline reconciliation

Prepared September 22, 2026 for the seven PEC customer records reviewed in the private sales audit. The SQL emitter is deliberately limited to those exact customer IDs, original creation timestamps, sources, appointment IDs and proposal IDs. No general customer/import backfill is included.

## Preview verified against live records

| Customer ID | Original contact record (UTC) | Source | Proposed pipeline stage | Proposal links | Appointment links |
| --- | --- | --- | --- | ---: | ---: |
| dae1ad0b-cb9c-48e0-820d-613efc035a64 | 2026-09-14 16:08:29.880388 | Google | estimate_sent | 1 | 1 |
| 9e690bba-066c-4daa-a14b-cc8c9af97b2d | 2026-09-14 18:03:13.034290 | Google | accepted | 1 | 1 |
| 09d1b7bb-fb09-4f7b-923a-493147e3b4ea | 2026-09-14 18:30:57.344773 | Magazine AD | new | 0 | 1 site_visit |
| efbf1825-b187-4e0d-bba5-b926b8c262af | 2026-09-14 19:00:31.590634 | Google | new | 0 | 0 |
| f221f7aa-35e0-4b40-9166-3691a190f06e | 2026-09-14 21:37:22.832037 | Repeat Customer | estimate_sent | 1 | 0 |
| 1837eeb8-ea1d-49f4-9dfa-af58b4b6c14b | 2026-09-14 21:51:49.582535 | Repeat Customer | estimate_sent | 2 | 0 |
| 88646d80-7317-4097-b416-f20d37521b0b | 2026-09-15 17:06:10.553178 | Referral | accepted | 1 | 0 |

Expected: seven missing leads, six proposal links, three appointment links. All seven were active PEC contacts without another canonical lead, another matching customer, or another matching unlinked lead at the read-only review. The existing eighth contact's lead and the separately investigated older scheduled leads are outside the allowlist.

Two records explicitly say Repeat Customer. Their timestamps establish the reviewed new TopCoat contact records and proposal inquiries, not the first-ever business relationship. The contact-only record has no appointment/proposal evidence to corroborate an earlier inquiry time. The reconciliation preserves these caveats in each lead's audit note and does not invent another date. The site visit is linked but remains a new lead; it does not establish an estimate booking.

Accepted stages require accepted proposal status and an actual accepted_at/signed_at timestamp. Sent stages use the earliest matching successful provider receipt or immutable first-send ledger entry, matched to the proposal's full public token. A proposal's mutable latest sent_at alone is not evidence. This repair does not modify the send ledger; historical first-send evidence is reconciled separately.

## Generate and review

```sh
node scripts/reconcile-sales-week-2026-09-14.cjs > reviewed-sales-preview.sql
node scripts/reconcile-sales-week-2026-09-14.cjs --apply > reviewed-sales-apply.sql
```

Both modes only print SQL. The default emits a SELECT. Execute that preview through the existing private database connection and compare it with the reviewed list. The explicitly selected apply output is one transaction that sets local role service_role. It requires the already-installed sales truth migration and should be executed only by the operator handling this authorized release. Never place credentials in the script or generated files.

The transaction locks the seven contacts and related records, serializes against intake's per-customer lock, rechecks the allowlist and evidence, calls the canonical lead function with the original contact timestamp, restores evidence-supported stages, records an audit note, and fills only missing child links. An unreviewed existing lead, changed contact identity/date/source, duplicate contact evidence, changed proposal/appointment membership, or conflicting child link aborts the whole transaction. Ordinary concurrent appointment/proposal writes take locks in a different order; contention can cause a bounded timeout/deadlock and full rollback. Verify transaction outcome and rerun the read-only preview before any quiet-window retry.

No endpoint, email/SMS sender, appointment reminder, webhook, or drip enrollment is called. Live database trigger inventory contained lead touch, proposal link/status/touch, and appointment link/audit/assignment/touch triggers; no lead enrollment or customer messaging trigger was present. Existing created_at/status/source fields remain unchanged. Normal updated_at touch and appointment audit entries are expected on newly linked records.

A second apply recognizes this repair's audit marker and leaves its lead stage/dates untouched, including later loss/archive changes. Existing child links produce no update. If source evidence or relationships later change, the script requires a fresh review instead of expanding scope automatically.

## Isolated rehearsal

```sh
PGLITE_MODULE=/path/to/@electric-sql/pglite node scripts/rehearse-sales-week-reconciliation.cjs
```

The rehearsal loads the existing migration fixture schema, the exact sales truth migration, and the real estimate status guard. It seeds the allowlisted identities/dates with synthetic contact details and provider receipts before installing the triggers. It checks dry-run immutability, exact microsecond occurrence dates, accepted proposal preservation, site-visit classification, six proposal/three appointment links, unchanged communications/nurture/evidence, second-apply zero changes, later archived-stage preservation, and complete rollback for changed or conflicting evidence. It never connects to production.

Applied by Codex on 2026-09-22 at 17:47:11 UTC after Dylan explicitly authorized completion. Readback verified seven new leads, six proposal links, three appointment links, and seven reconciliation audit notes. The September 14–20 PEC lead count is eight and no customer from that week lacks a pipeline lead. Customer records and proposal/appointment content excluding intended lead links and automatic updated_at fields have matching before/after digests. No reconciled lead has a drip enrollment. All 13 isolated rehearsal checks passed; the private release audit contains the detailed transaction result.
