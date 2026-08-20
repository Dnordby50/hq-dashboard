# Prompt 89: Customers become the source of truth; appointments link customers with real search; auto-titles.

Written by Cowork on 2026-08-12 from Dylan's request, after clarifying questions. Dylan's words: "I want the customer to be in the main source of truth, and then every lead or appointment connects to that customer." He explicitly chose the FULL restructure over a modal-only patch. Run AFTER prompts 87 and 88. Read CLAUDE.md and the last 3 PROJECT-LOG entries first per standing rule 4.

## What Dylan asked for, concretely

1. The create-appointment modal currently asks to link a LEAD. It should link a CUSTOMER.
2. The picker must be searchable (type-ahead), not a scroll-through dropdown.
3. The modal/appointment title becomes "On-site Estimate for {Customer Name}" — hard-derived from the linked customer, and per Dylan's follow-up, auto-titled for ALL appointment types ("{Type label} for {Name}"), not editable.
4. Structurally: every lead and appointment hangs off a customer record. A person exists ONCE, as a customer row; leads and appointments are things that happen to that person.

## The good news: the schema is already shaped for this

Verified against the live DB on 2026-08-12 (SCHEMA.md agrees):
- `leads.customer_id` exists, FK → customers.id. Live: 14 active leads, only 3 linked.
- `pec_appointments.customer_id` exists, FK → customers.id. Live: 21 appointments; 4 have customer_id, 12 have lead_id (no FK, survives lead soft-delete), 5 have neither (ad-hoc "other" blocks like "SNP Meeting", "Golf w/ Dylan").
- `customers`: 101 active rows, with phone_norm, routemize_contact_id, and the same-human matching helper already shared in `_pec-lead-match.cjs` (used by pec-lead-intake and pec-appt-intake).

So this is a behavior + backfill build, not a schema rebuild. Design the work in these parts:

## Part A: every lead gets a customer

- Forward path: every lead-creating intake (pec-lead-intake, pec-appt-intake's createRoutemizeLead, any manual new-lead UI, the DripJobs-side flows if they create leads) resolves a customer FIRST — match by the existing same-human rule (phone_norm, then email; reuse `_pec-lead-match.cjs`, do not write a second matcher) — creating the customer row when no match, then creates the lead WITH customer_id set. Customer fields from lead fields (name parts, phone, email, address → billing_*, lead_source from the lead's source, company from brand: PEC → 'prescott-epoxy'; check what FTP maps to in existing code before assuming).
- Backfill migration: link the 11 unlinked active leads the same way (match else create). Per the project's derived-overrides-typed lesson: COUNT AND LOG what the backfill will touch before running it — how many matched an existing customer vs created a new row — and put those numbers in the PROJECT-LOG entry. Soft-deleted/archived leads: link only on match, never create customers for dead leads.
- A prospect is not yet a paying customer, and the Customers page currently means "real customers" (91-101 rows, most with jobs). Do NOT let 14 leads-as-customers silently blur that list. Make the distinction DERIVED, not stored state: a customer with no non-archived estimate, invoice, or job is a prospect; give the Customers list a filter chip (All / Customers / Prospects) computed from that. No settings row, no stored flag that can drift.

## Part B: the appointment modal links customers

- `openAppointmentForm` (index.html; anchor via features.json): replace the lead dropdown with a customer type-ahead: a search input filtering on name, phone, and (if cheap) address, results as a tap list, plus "New customer" inline (name + phone minimum) that creates the row and links it without leaving the modal. Debounce the query; ilike on name/phone_norm server-side rather than loading all customers, so it scales past 101 rows.
- `openScheduleEstimateFromLead` (the Schedule Estimate button on a lead) keeps working: it now resolves the lead's customer_id (guaranteed by Part A) and prefills the customer picker.
- Lead side effects survive via the customer: booking an on-site estimate for a customer whose active lead exists (leads.customer_id = customer, not archived/deleted) must still fire the pipeline effects (apptBookingLeadEffects and its server twin: stage advance, drip pause, cancel-walk-back). Resolve customer → lead where the effects need a lead. Keep writing `lead_id` onto the appointment row when one resolves, so existing queries and the cancel-walk-back keep their anchor.
- Backfill: stamp customer_id on the 12 lead-linked appointments from their lead's customer (post-Part-A every lead has one). The 5 no-link ad-hoc rows stay as they are.

## Part C: auto-titles

- Title derives as "{Type label} for {Customer Name}": "On-site Estimate for Tom Bechtel", "Project Walkthrough for …", "Site Visit for …". Applies on create AND on edit (relink → retitle). Not editable when a customer is linked — the title field becomes a read-only preview (or disappears in favor of showing the derived title).
- Ad-hoc "other" blocks with NO linked customer (BNI, golf) keep the free-text title; auto-titling requires a name to derive from. "Other" WITH a customer linked derives like the rest ("Appointment for {Name}" or the type label you find in TYPE_LABELS).
- Where titles surface, keep them consistent: the calendar chips (apptChipContent/apptTitleNameHalf may already derive display names — reconcile rather than double-derive), the Google-pushed event title, reminder/confirmation texts (customer-facing: NO em dashes in the derived format — "for" phrasing has none), and the Routemize intake's own title composition at pec-appt-intake.cjs:392 (it already builds "<name>, <service>"; unify on ONE format everywhere, the new one).

## Guardrails

- Do not touch pec_prod_jobs / the crew Job Schedule; this is the sales side only.
- Do not break Routemize intake idempotency (routemize_appt_id upsert key) or its contact matching; extend, don't fork.
- customers RLS: the modal's search and inline-create run as staff; verify policies already allow what the UI needs before assuming.
- estimates/jobs linkage is untouched; they already hang off customers.
- Migration files carry @artifacts headers (rule 13); regenerate SCHEMA.md after; update features.json (Appointments calendar, Customers and jobs records, Routemize appointment intake, Lead intake entries).

## Verification

- New lead via a test intake payload → customer row exists (or matched) and lead.customer_id set.
- Backfill counts logged: leads matched vs created; appointments stamped.
- Modal: search "bech" → Tom Bechtel appears; pick → title reads "On-site Estimate for Tom Bechtel"; save; calendar chip, Google event (post-prompt-88), and confirmation text all show the same title. New-customer inline path works. Booking for a customer with an active lead advances the lead stage exactly as before (and cancel walks it back).
- Customers page: filter chips show sane counts (Customers ≈ the old list; Prospects ≈ lead-originated rows with no estimate/invoice/job).
- npm test green; What's New entry for the modal + search + auto-title (plain language, no em dashes); PROJECT-LOG entry per standing rules.
