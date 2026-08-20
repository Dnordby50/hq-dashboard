# Claude Code Prompt 62: lead/customer name model, estimate-start rework, pipeline drafts + estimate cards, lost reasons, global search, estimator layout

Written by Cowork 2026-08-01 after 20 scoping questions with Dylan. Every decision below is LOCKED unless this document says "propose and stop".

Read CLAUDE.md, SCHEMA.md, features.json, and the top 3 entries of PROJECT-LOG.md before you touch anything. Verify every table and column against SCHEMA.md; if SCHEMA.md and the live schema disagree, trust live and flag the drift in your log entry.

---

## Context you need before you start

Prompt 61 shipped on 2026-07-31 and **Dylan has not walked through it yet**. It inlined the estimator into the estimate detail page, made "New estimate" / "Start estimate" create a draft `estimates` row immediately, added native job-info editing on the estimate detail page, and unified lead source onto `pec_lead_sources`. This prompt rebuilds part of that same estimate-start path. Dylan chose to run it as one build straight through anyway. Say so plainly in your handoff if anything you find suggests prompt 61 is not behaving as its log entry claims.

Things that are ALREADY TRUE and must not be rebuilt:

- `leads.stage` CHECK already admits `lost`. `LEAD_STAGES` (index.html:23546) already contains a Lost column and `renderLeads` already renders it. Lost is NOT missing from the board.
- `openLeadLostModal` (index.html:25193) already forces a reason pick from 6 hardcoded reasons and already blocks save without one.
- `leads.first_name` and `leads.last_name` already exist and both intake webhooks already populate them (`pec-lead-intake.cjs:148-150`, `pec-appt-intake.cjs:387-390`). Only the dashboard UI ignores them.
- Google Places autocomplete is fully built on both surfaces: `pecAttachPlacesAutocomplete` (index.html:22818) with the key hardcoded at index.html:22735, and `apps/estimator/src/lib/places.ts` + `AddressAutocomplete.tsx` gated on `VITE_GOOGLE_MAPS_KEY`.
- The estimator already collects gate code, coat-past-garage, stem walls, moisture, MOHS, non-slip, grinder tooling grit and special notes, all inside the collapsed `More detail` `<details>` (EstimatorScreen.tsx:2133 and 2165).
- `estimates.crew_notes` already exists, is written by the estimator, is copied to `jobs.crew_notes` on accept, and prints on the crew work order.

---

## Part 0: schema migration (do this first, one migration file)

Create `supabase/migrations/2026-08-06_prompt62_lead_customer_estimate.sql` and apply it via the Supabase MCP, then re-query to verify and update SCHEMA.md.

1. `ALTER TABLE leads ADD COLUMN business_name text;`
2. `ALTER TABLE leads ADD COLUMN archived_at timestamptz;`
3. `ALTER TABLE leads ADD COLUMN lost_notes text;`
4. `ALTER TABLE estimates ADD COLUMN customer_id uuid REFERENCES customers(id);`
5. Index: `CREATE INDEX IF NOT EXISTS estimates_customer_id_idx ON estimates(customer_id);`
6. Index: `CREATE INDEX IF NOT EXISTS leads_archived_at_idx ON leads(archived_at);`

No CHECK constraint changes. No new lead stage. Do NOT add an `estimate_draft` stage.

Before applying, print the current row counts for `leads` and `estimates` in chat so the backfill in Part B has a stated baseline.

---

## Part A: one global search bar

**Locked.** The main search bar at the top of the page searches customers, leads, estimates and jobs, from any page, at any time.

1. `#rdSearch` (index.html:5088) is currently the jobs-only search, wired at index.html:5585 with its dropdown built in the module at index.html:9087-9150. Turn it into the global search.
2. Placeholder becomes `Search jobs, estimates, leads, customers…`.
3. It must be present and functional on every page, not only the pages that render the CRM topbar today. Audit which views hide or replace the topbar and fix them.
4. Results are grouped with section headers in this order: Jobs, Estimates, Leads, Customers. Cap each group at 5 with a "+N more" line that runs the full list view filtered to the query.
5. Match fields per type:
   - Jobs: customer name, address, phone (whatever it matches today, unchanged)
   - Estimates: estimate number (accept both `102026` and `EST-102026`), customer name, phone, address
   - Leads: full name, business name, first/last, email, phone
   - Customers: name, company_name, first/last, email, phone
6. Clicking a result opens that record's detail page.
7. Debounce input, and cancel in-flight queries when the query changes, or the four parallel queries will race and paint stale groups.
8. **Keep the existing in-list search boxes** (`pecEstSearch`, `pecCustSearch`, `costSearch`, the leads board search, `pecEmailLogSearch`). Dylan said he does not know the difference between the two kinds; they do different jobs (in-list filtering of a visible table versus jump-to-record) and removing them would be a silent regression. Note this decision in your log entry.

---

## Part B: first + last name OR business name, everywhere

**Locked.** The lead form follows the same logic as the rest of the CRM. First name and last name, OR business name, is ALWAYS required.

The pattern to copy is the customer form, `openCustomerForm` (index.html:8543): an Individual / Business radio, `initialType` derived from whether `company_name` is set (8556), company name required when Business (8667), display name = company name or first+last (8672). The estimate job-info editor already uses the same res/com radio shape (index.html:26346-26349).

Apply the split to ALL of these:

1. **`openNewLeadModal`** (index.html:25240). Replace the single `#nlName` input with Individual/Business radio + First / Last / Business name. Validation: Business requires business_name; Individual requires first AND last. Phone-or-email requirement is unchanged.
2. **Lead detail edit** and the lead card / board display.
3. **The estimate detail page's native job info editor** (`#estJobInfo`, index.html:26340 area) from prompt 61 Part C.
4. **The customer create/edit form**: it already has the right shape; make sure first and last are both required for an Individual (today only company name is enforced).
5. **Both intake webhooks**: `pec-lead-intake.cjs` and `pec-appt-intake.cjs` already write first/last. Add business-name handling: map an incoming company / business / organization field onto `leads.business_name`. Do NOT change either function's dedupe behavior or `pec-appt-intake`'s fill-only-when-null source rule.

**`full_name` stays as the derived display column.** Every write sets it to `business_name` when Business, otherwise `first_name + ' ' + last_name`. Nothing downstream should have to change how it reads a lead's name. Do not remove `full_name`.

**Backfill (existing rows).** Baseline: 6 leads, 91 customers as of SCHEMA.md.

- Split `leads.full_name` into first/last on rows where first and last are both null: first token to `first_name`, remainder to `last_name`. Single-token names go entirely into `first_name` with `last_name` left null.
- Do the same for `customers.name` where `first_name`, `last_name` and `company_name` are all null.
- Do NOT guess business names. Never move a value into `business_name` or `company_name` from a parse.
- **Print the exact before/after for every row you change, in chat, and state the count.** This is the derived-overrides-typed lesson from prompt 56: count what a rewrite touches before you run it.
- Rows where the split is ambiguous (three or more tokens, suffixes, "and", "&") are still split first-token / rest, but list them separately in your report so Dylan can eyeball them.

---

## Part C: Google Places is dead everywhere (diagnose, then fix or hand off)

Dylan reports NO address suggestions on any surface, dashboard or estimator. The code exists on both.

1. Load the dashboard, type four or more characters into a Places-attached field (the New lead modal's `#nlAddress` is the easiest), and capture the exact console error and the network response from `maps.googleapis.com`.
2. Check the estimator separately: `placesConfigured` is `VITE_GOOGLE_MAPS_KEY !== ''`, and that env var may simply not be set in Netlify. If that is the cause for the estimator, say so and stop there for that half; setting a Netlify env var is Dylan's action, not yours.
3. If the dashboard also fails, the cause is the key itself (Places API not enabled, billing off, or the HTTP-referrer restriction not covering the Netlify domain). Report exactly which, with the error text. **Do not create, rotate, or paste a new API key.** Per CLAUDE.md rule 7 a client Maps key ships only referrer- and API-restricted, and the current key is already in netlify.toml's secret-scan omit list.
4. If, and only if, the failure is a code bug, fix it. Otherwise the deliverable for Part C is a precise diagnosis in the handoff with the exact steps Dylan takes in Google Cloud or Netlify.

---

## Part D: archive a dead lead

**Locked.** Archiving clears a dead lead off the board without deleting the contact.

1. An Archive action on the lead card and the lead detail sets `leads.archived_at = now()` and writes a `lead_events` row (`event_type: 'archived'`, actor stamped). Unarchive clears it and writes `unarchived`.
2. `leads.stage` is NOT changed by archiving. An archived lead is not lost.
3. Archived leads are **off the pipeline board** and out of the board's value totals, reachable behind an "Archived" filter that sits next to the existing board filters.
4. **Drips stop.** No further sends and no re-enrollment. Audit every drip enrollment and send path (`enrollLeadInDrip` at index.html:23866 and the nightly drip engine) for the `archived_at is null` guard.
5. **Out of the follow-up queue.** The overdue-for-a-human-touch query (the stage filter at index.html:23323 is the one to look at) excludes archived leads, and they stop counting as overdue misses.
6. **Archived leads STAY in conversion metrics.** Dylan explicitly did not choose to exclude them. State the consequence in your handoff in one sentence: an archived lead that never reached `accepted` or `lost` sits in the conversion denominator forever, so heavy archiving will drag the reported close rate down over time. Do not "fix" this on your own.
7. The customer and all comms history are untouched.

---

## Part E: starting an estimate picks a customer, a lead, or neither

**Locked.** `estimates.customer_id` is added (Part 0). Starting an estimate offers three paths.

Today `createDraftEstimate` (index.html:7249) takes only `{ leadId }`, and every estimate hangs off `lead_id`.

1. "New estimate" (Estimates list) and "Start estimate" both open a picker with three choices:
   - **Existing customer**: search `customers` by name, company, phone, email, address. Sets `customer_id`, leaves `lead_id` null.
   - **From an existing lead**: today's behavior. Sets `lead_id`; also sets `customer_id` when the lead already has `customer_id`.
   - **New customer**: creates the `customers` row (using the Part B name rules) and sets `customer_id`, `lead_id` null.
   Starting from a lead detail page skips the picker and takes the lead path directly, as it does now.
2. The instant-draft behavior from prompt 61 Part B is preserved: the draft `estimates` row is inserted first, prefilled job info written onto the row in BOTH column shapes, then the page lands on the estimate detail with the estimator open. The duplicate-estimate guard (`leadOpenEstimates`) still runs BEFORE the insert on the lead path.
3. **Audit every reader of `estimates.lead_id` before you build, and list them in chat.** Each one now has to tolerate `lead_id` being null: `leadValueMapFrom` (23698), the kanban value map, Metrics, the Ops Queue, drips, the estimate detail page, the accept/convert-to-job path, `pec-webhook-proposal-accepted`, and the estimator's load and save. A null `lead_id` must never throw and must never silently drop the estimate from a list.
4. On accept, an estimate with `customer_id` and no `lead_id` converts to a job against that customer directly. Do not invent a lead at accept time.

---

## Part F: the pipeline shows drafts, and estimate cards flow through it

**Locked, and this is the biggest change in the prompt.**

Dylan's words: "estimate created does not need a lead connected to it, just put it in the drafts section of the sales pipeline", and a draft is "an estimate that has been started but has not been sent to customer yet". Estimate cards then flow through every column.

1. **New Drafts column** on the Sales Pipeline board, positioned between Estimate Scheduled and Estimate Sent. It is **not** a `leads.stage` value and the CHECK constraint does not change. It is populated by `estimates` rows with `status = 'draft'` and `sent_at is null`, not deleted, not archived.
2. **The board renders two card shapes.** Lead cards (as today) and estimate cards. An estimate card appears for any estimate with no `lead_id`; an estimate that HAS a lead is represented by its lead card as it is today, with a Draft indicator, so nothing gets two cards.
3. **Estimate cards move by estimate status, not by drag.** Draft to Estimate Sent on send, to Presented, to Accepted or Lost following the estimate's own status. Dragging a lead card still works exactly as it does now (`commitLeadStage`, index.html:25110), including the first-touch-wins timestamp rule. Dragging an estimate card between lead stages is disabled, with a tooltip saying its column follows the estimate's status.
4. Everything the board computes has to handle both shapes: column sorting (the per-column `defaultCmp` at index.html:25379-25392), the score sort, the value rollup (`leadValueMapFrom`), the source badge, the campaign filter, the search filter, the appointment sort for Estimate Scheduled, and the empty state.
5. Note the prompt 61 behavior you are building on: `leadValueMapFrom` skips rows with a null price, so a priceless draft contributes 0 to column value. Keep that. Show the draft count in the Drafts column header instead of a dollar total when every card in it is priceless.
6. **Add Lost to the Metrics Sales Pipeline widget.** index.html:12854 currently does `LEAD_STAGES.filter(s => s.key !== 'accepted' && s.key !== 'lost')`. Include Lost so the funnel shows where deals die. Leave Accepted excluded unless including it is trivially correct; say which you did.

---

## Part G: lost reason gets notes and an AI assist

1. **Notes.** `leads.lost_notes` (Part 0). The reason stays a picked value from the existing 6 (Price, Went with competitor, Timing / not ready, No response, Not a fit, Other). **Keep those six exactly; no Settings surface for them.** Notes are optional and always available, not only for Other. Fix today's behavior where picking Other overwrites `lost_reason` with the note text: Other now stores `'Other'` in `lost_reason` and the text in `lost_notes`. Migrate existing `lost_reason` values that are not one of the six into `lost_notes` with `lost_reason = 'Other'`, and report the count.
2. **AI pre-fill at Mark-lost time.** When the modal opens, look for a recent `pec_call_log` row for this lead, pre-select the closest of the six reasons, pre-fill the notes with a one-line summary, and show the source snippet with its date. It is a suggestion: the rep can change both, and nothing saves without a human clicking Mark lost.
3. **Landmine: `pec_call_log` has `customer_id`, NOT `lead_id`** (SCHEMA.md:605, 474 rows). Matching a call to a lead has to go through `leads.phone_norm` against `from_number` / `to_number`, or through `leads.customer_id` when it is set. Normalize both sides the same way `phone_norm` does (last 10 digits). Say in your log entry how many of the 474 rows you could match to a lead at all; if the match rate is terrible, the feature is decoration and Dylan should know.
4. **Nightly backfill.** A scheduled pass fills `lost_reason` / `lost_notes` on already-lost leads that have a matching call and no reason yet. It must never overwrite a human-entered reason or note. Tag AI-written values so they are distinguishable (a `lead_events` row with the source, at minimum) and show that provenance on the lead timeline.
5. `pec_call_log.transcript` is jsonb and `summary` is already populated. Prefer `summary`; only read the transcript when the summary is empty.

---

## Part H: estimator layout and the MOHS warning

1. **Drop the "More detail" collapse.** Delete the `<details className="card more-detail">` wrapper in both the standard and custom branches (EstimatorScreen.tsx:2133 and 2165). Its contents (products, colors, and the work order questions: gate code, coat past garage, stem walls, moisture, MOHS, non-slip, grinder tooling grit) render always-visible in the page flow. Keep every one of those fields; only the accordion goes away.
2. **Retire `special_notes`.** One big, clearly labeled "Notes for the crew" textarea at the bottom of the estimate page, bound to `estimates.crew_notes` (which already saves, already copies to `jobs.crew_notes` on accept, and already prints on the work order). Make the box visibly large, at least 8 rows. Migrate any existing `intake.special_notes` values into `crew_notes` (append with a separator if `crew_notes` already has content), report the count, and stop writing `special_notes` on save. Leave the key in old `intake` jsonb rows; do not rewrite history.
3. **MOHS and moisture: loud warning, never a block.** Dylan wrote "required for every quote" but chose warning-only, and confirmed it on a second pass. So: an unmissable red banner on the estimator AND on the estimate detail page whenever either is blank, saying the crew work order will print blank. Save is not blocked. Send is not blocked. The existing quiet `woMissingFields` line (EstimatorScreen.tsx:2310) is replaced by this banner, not duplicated. Do not add a Settings toggle.
4. Do not touch the offline outbox, the standalone `/estimator/` route, or the inline-host guard in `renderEstimateDetail` from prompt 61.

---

## Landmines, all of them

1. **Prompt 61 is unverified.** You are rebuilding the estimate-start path it just changed. If you find its behavior does not match its log entry, stop and report rather than building on top of the discrepancy.
2. **A whole-page re-render kills the inline estimator.** Prompt 61 put the guard once at the top of `renderEstimateDetail`. Any new call site you add must go through that same function, not around it.
3. **`estimates.lead_id` can now be null.** Every reader is a potential crash or silent omission. Part E step 3 is a real audit, not a formality.
4. **The board rendering two card shapes touches every column behavior.** Sorting, dragging, filtering, value totals, badges, empty states. A card shape that only half-works will look fine on Dylan's 6 leads and break at 60.
5. **`pec_call_log` links to customers, not leads.** Phone-normalized matching only.
6. **`full_name` is read all over the place.** It stays derived and populated. Do not let a Business lead end up with a null `full_name`.
7. **Both intake webhooks already write first/last.** Adding business-name mapping must not disturb the source dedupe (`source=eq.<token>` in `pec-lead-intake`) or `pec-appt-intake`'s fill-only-when-null source rule from prompt 56 decision 10.
8. **supabase-js reports a nonexistent column as an empty response without throwing.** If a read comes back mysteriously empty after the migration, check `res.error` before suspecting RLS.
9. **Do not push to the remote.** Commit locally only.
10. **No em dashes in anything customer-facing.** The Drafts column header, the MOHS banner, the archive confirmations, the lost-reason copy: commas, parentheses, or two sentences.

---

## Order of work and commits

One commit per part, in this order. Do not batch them.

1. Part 0 migration (applied and verified, SCHEMA.md updated)
2. Part B names (UI, then intakes, then the backfill with its printed report)
3. Part D archive
4. Part E estimate-start + the lead_id-null audit
5. Part F pipeline drafts and estimate cards
6. Part G lost notes, AI pre-fill, nightly backfill
7. Part H estimator layout and MOHS banner
8. Part A global search
9. Part C Places diagnosis (may be a handoff item rather than a commit)
10. Bookkeeping commit: SCHEMA.md, features.json, help/whats-new.json, PROJECT-LOG.md

Commit message format: `cowork: <short description>` is for Cowork. You are Claude Code; use your normal format.

---

## Verification before you report done

1. `npm test` green, exit code verified 0. If you change a test, say which and why.
2. A Business lead and an Individual lead both create, display, edit, and appear in search correctly.
3. An estimate started from an existing customer: appears in the Drafts column, has `customer_id` set and `lead_id` null, does not crash Metrics, the Ops Queue, the kanban value rollup, or the drip engine.
4. That same estimate, once sent, moves to Estimate Sent as an estimate card and can reach Accepted.
5. An archived lead disappears from the board, stops draining into drips and the follow-up queue, and comes back with the Archived filter.
6. Mark-lost with a reason and notes saves both columns; Other stores 'Other' plus the note.
7. The global search returns all four types from at least two different pages.
8. The estimator shows every former More-detail field without expanding anything, and the crew notes box is at the bottom and large.
9. Report the three rewrite counts explicitly: name-split rows changed, `lost_reason` rows migrated, `special_notes` values migrated.

## Handoff

Write the handoff for Dylan with: what you could not verify yourself, the Places diagnosis and exactly what he has to do in Google Cloud or Netlify, the conversion-denominator consequence of archiving from Part D item 6, the call-log match rate from Part G item 3, and any place where the two-card-shape board is doing something you would call a compromise.
