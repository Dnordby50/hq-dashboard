# Claude Code Prompt 65: appointment note cleanup, Start Estimate entry points, unified New Estimate modal, Sales Pipeline rename

Four items from Dylan, scoped by Cowork on 2026-08-03. Read CLAUDE.md and the top three PROJECT-LOG.md entries first (prompt 64 presentation view, prompt 63 estimator/preview fixes, the Cowork scoping entry). SCHEMA.md is current as of prompt 64; verify every column against it before writing SQL.

Nothing in this prompt needs a migration unless Part A's optional backfill is approved, and that is a data UPDATE, not DDL.

---

## Part A: Routemize question UUIDs are leaking into customer text messages

### What is happening

`netlify/functions/pec-appt-intake.cjs:328-336` builds the customer-facing job notes from Routemize's `customerAnswers`:

```js
const answers = (Array.isArray(data.customerAnswers) ? data.customerAnswers : [])
  .map(a => {
    if (!a || typeof a !== 'object') return null;
    const q = cleanStr(a.question);
    const ans = cleanStr(a.answer);
    return q && ans ? `${q}: ${ans}` : ans;
  })
  .filter(Boolean);
```

Routemize is sending a **question UUID** in `a.question`, not question text. So the stored `customer_notes` reads:

```
605f816a-b861-c865-3e12-3a2177755a80: Had epoxy system installed in garage and front apron 2 years ago - the front apron appears stained or possibly the clear coat is rubbing off and needs to be repaired - no gate or special directions
1077d4b4-4c1d-1f34-52a1-3a2177807ce1: Other
```

### Why this is higher severity than it looks

`customer_notes` is not internal. `netlify/functions/_pec-appt.cjs:143-145` appends it to **every customer-facing appointment message on both channels**:

```js
const jobNote = String(appt.customer_notes || '').trim();
const body = renderTemplate(rule.message_template, ctx)
  + (jobNote ? '\n\n' + scrubDashes(jobNote) : '');
```

Confirmations and reminders, SMS and email. Customers have been receiving raw UUIDs. Live counts taken 2026-08-03: **6 of 6** appointments with customer notes contain UUIDs; **1** of those has a `start_at` in the future, so it still has reminders pending.

### Task A1 (build this)

Strip ID-shaped question keys at intake. Keep real question text when Routemize actually sends it.

- Add a helper in `pec-appt-intake.cjs` near the `answers` map. Treat a question key as an ID (drop the prefix, keep the bare answer) when it matches a UUID, or is otherwise clearly not human text: a hex/opaque token of 16+ chars with no spaces. Be conservative. A short question with spaces like `What's the project?` is real text and must survive as `What's the project?: Had epoxy...`.
- When the key is dropped, the line is just the answer, trimmed. No `Q1:`, no placeholder, no empty `: ` prefix.
- An answer with no question key at all keeps today's behavior (bare answer).
- Do NOT touch the internal `notes` path (line 362, `AppointmentNotes`), the update-branch note append (line 519-527), or the `body.customer_notes` passthrough at line 619.

### Task A2 (test it, since a real Routemize payload cannot be faked honestly)

Add a test under `production/` (the npm test target) that exercises the mapping with a synthetic payload covering four cases: UUID key, human-text key, no key, and empty answer. If the answer-mapping logic is not currently exported from `pec-appt-intake.cjs`, extract it into a small pure function and export it rather than testing through the HTTP handler. Do not restructure anything else in that file.

### Task A3 (DO NOT RUN without Dylan's go-ahead)

Dylan chose intake-only, so existing rows keep their UUIDs by default. Print this in chat as a one-line approval ask, with the current live counts re-queried at run time, and stop there:

```sql
-- Cleans stored notes on appointments that already have UUID prefixes.
-- Re-query the affected count BEFORE and AFTER and report both.
UPDATE pec_appointments
SET customer_notes = regexp_replace(
      customer_notes,
      '(^|\n)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*:\s*',
      '\1', 'gi')
WHERE customer_notes ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*:';
```

Make the ask concrete: name the one future appointment (customer name and start date) whose pending reminders will otherwise send a UUID. If Dylan says yes in the same session, run it and log the before/after counts. If he does not answer, ship everything else and put it in the handoff.

---

## Part B: one New Estimate modal, in the DripJobs shape, used everywhere

Dylan's decision: **rebuild the estimate-start picker in the shape of the DripJobs "New Proposal" modal, and use it at every entry point.** The screenshot he sent is the reference.

### What exists today

`openEstimateStartPicker()` at `index.html:7448` is a three-tab modal (Existing customer / From a lead / New customer). It is reached from the Estimates list `+ New estimate` button (`#pecEstNew`, index.html:7124 region). The lead detail `Start estimate` button (`#leadStartEstimate`, index.html:26795) deliberately skips the picker.

Both paths funnel into `createDraftEstimate({leadId})` (index.html:7288, duplicate guard) or `createDraftEstimateNow({leadId, customerId})` (index.html:7305, the insert + prefill).

### The new modal

Replace the three tabs with the DripJobs layout. Keep `openEstimateStartPicker` as the function name so every existing caller keeps working.

**CONTACT INFORMATION**
- A `Contact` dropdown at the top, defaulting to `New Contact`, listing existing customers below it. Selecting an existing customer collapses the name/email/phone fields into a read-only summary of that customer (the customer row is the source of truth, do not let this modal edit an existing customer).
- Leads: keep them reachable. Put them in the same dropdown under a `Leads` optgroup, labeled with the stage the way the current lead tab does (`titleCaseValue(l.stage)`). Do not add a second dropdown.
- `New Contact` shows: Individual / Business toggle (existing behavior), Business name when Business, First Name, Last Name, E-mail, Phone, and **Lead Source (required)**, exactly the validation rules already in `#espCreateGo` (index.html ~7557): business requires business name, individual requires first AND last, lead source always required.
- `Stage` renders as a read-only `In Draft`, matching the screenshot. It is display only. Do NOT add a stage column to `estimates`.

**JOB ADDRESS** (Dylan selected this)
- Street, City, State, Postal Code.
- Prefilled from the selected customer's billing address when one is picked, editable, and empty by default on New Contact.
- These write to `estimates.customer_address1 / customer_city / customer_state / customer_zip` **and** the legacy combined `estimates.customer_address`, both shapes, exactly the way `createDraftEstimateNow` already composes them (index.html ~7345). Readers are split across both; writing one is a bug.

**ASSIGNMENT** (Dylan selected Salesperson only)
- `Salesperson` select from `pec_sales_team_members` (active only), defaulting to the current user's mapped member the same way the estimator does (the `auth_user_id` link, prompt 47).
- **Read the landmine section below before writing this field.** Setting it here has a permanent consequence for non-admins.
- Do NOT add Project Manager. There is no estimate-level PM concept in TopCoat and Dylan did not ask for one.

**Not in scope, deliberately:** the `Proposal Template` picker (TopCoat has `estimates.system_type_id` and the estimator's own system picker; Dylan did not select it), `Deal Name` (no equivalent column, would be new schema), and the `DRIPS` disable toggle (TopCoat drips are lead-driven, so what it would switch off is undecided). If any of these feel necessary while building, stop and ask rather than inventing them.

### Behavior

- Existing customer selected -> `createDraftEstimateNow({ customerId })`, plus the address/salesperson fields from this modal.
- Lead selected -> `createDraftEstimate({ leadId })`, which keeps the duplicate-estimate guard. Do not bypass it.
- New Contact -> insert the `customers` row using the exact shape already in `#espCreateGo` (`token: randomToken()`, `name`, `first_name`, `last_name`, `company_name`, `phone`, `email`, `company: 'prescott-epoxy'`, `lead_source`), then `createDraftEstimateNow({ customerId })`.
- In every case the user lands on the estimate's own page with the inline estimator, which is today's behavior. Do not add a second estimator surface.
- The `company: 'prescott-epoxy'` hardcode is existing behavior and stays. Note it in the log entry as an FTP gap, do not fix it here.

---

## Part C: Start Estimate from an appointment

Dylan's wording: "from an appointment card on the calendar, I just want the ability to click Create Proposal on that card." Naming settled as **Start Estimate** (the app says estimate everywhere; EST numbers, the Estimates rail item, the public pages).

### Where it goes

The Appointments view is FullCalendar (`renderAppointments`, index.html:23685; calendar constructed ~23730). There is no hover card: `eventClick` calls `apptOpenById` -> `openAppointmentForm` (index.html:24002). **Put the button in that modal's footer**, in the left-hand action group next to `Delete` and `Cancel appt` (index.html ~24089), edit mode only, never on a new unsaved appointment.

Do not add an inline button to the event chip. Month-view chips are ~20px and `editable: true` drag-to-reschedule is live on them; a nested button there fights the drag handler. If Dylan wants it on the chip after using this, that is a follow-up.

### What it does

- Appointment has `lead_id` -> `createDraftEstimate({ leadId })` (duplicate guard, Dylan's explicit choice).
- Appointment has `customer_id` only -> `createDraftEstimateNow({ customerId })`.
- Appointment has both -> lead path (it carries the customer through; `createDraftEstimateNow` already copies `leads.customer_id` onto the estimate, index.html ~7325).
- **Appointment has neither** -> Dylan: "you should just have to create the customer before you start creating the estimate." So: open the Part B modal on `New Contact`, prefilled from the appointment (title as the name to split, phone/email if resolvable, and the appointment's address). The customer row is created first, then the estimate. No silent auto-create, no duplicate-customer guessing.
- The appointment modal closes; the user lands on the estimate page (Dylan's choice).

### Prefill (Dylan selected both)

- **Job address from the appointment.** `pec_appointments.location_address / location_city / location_state / location_zip` win over the customer's billing address when present, because the appointment address is the actual job site. Write both column shapes as in Part B.
- **The customer's notes from the appointment.** `pec_appointments.customer_notes` (post-Part-A, so no UUIDs) carries onto the estimate. Put it where the estimator's site notes already live rather than inventing a field; if the only sane home is `estimates.crew_notes`, say so and explain the choice in the log entry instead of guessing silently.
- Dylan did NOT select the link-back, so do not add an `estimate_id` column to `pec_appointments`. No migration.

---

## Part D: Sales Pipeline rename

Today (index.html:2546-2557):

```html
<div class="pec-subnav-group">Sales Pipeline</div>
<button data-pec-view="leads" data-pec-title="Sales Pipeline">Pipeline</button>
<button data-pec-view="appointments">Appointments</button>
```

Renaming only the button makes the rail flyout read `Sales Pipeline > Sales Pipeline`. Dylan's decision: **rename the button AND the group.**

- Button text: `Pipeline` -> `Sales Pipeline`.
- Group: `Sales Pipeline` -> `Sales Activity`, still holding Sales Pipeline and Appointments.
- `data-pec-view="leads"` MUST NOT change. `switchView`, the hash router, and old `#leads` bookmarks all key off it. The existing comment at 2549-2551 says so; update the comment to match the new labels, do not delete it.
- Keep `data-pec-title="Sales Pipeline"`. `refreshTitle` uses it and the page header must not regress.
- The build-19 rail renderer parses this markup, so this IS the rail change. Verify the group flyout renders and the group-hides-when-all-items-hidden logic still behaves (both items here are all-staff, so the group should never hide; confirm rather than assume).
- Production's `Jobs pipeline` (index.html ~2578) is NOT renamed. Dylan did not pick that option.

---

## Landmines

1. **The salesperson lock is permanent for non-admins.** `renderEstJobInfoBlock` (index.html:27377-27390) computes `spSet = !!(intake.salesperson_id || intake.salesperson_name)` and `spLocked = spSet && !isAdmin()`, failing closed on an errored role read, because commission attribution flows into GP. Setting salesperson in the Part B modal means a non-admin who picks the wrong rep **cannot ever fix it themselves**. The estimator already sets it from the current-user default (prompt 47), so this is not new, but the modal makes it an explicit choice at a moment when the user may not be paying attention. Build it with the current-user default, and **report this to Dylan before shipping** with a recommendation: either accept it, or allow the creator to change it while the estimate is still `status='draft'` and unsent. Do not change the lock rule on your own.

2. **Never PATCH a partial `intake`.** It is read-modify-write on a FRESH read (prompt 61 landmine 8); a partial write drops comps, discount context, and site answers. In Part B the row is brand new so composing `intake` inside the insert is safe, but do not reuse that pattern anywhere an estimate already exists.

3. **The duplicate guard runs BEFORE the insert** (prompt 61 landmine 6). Guarding after orphans a draft every time the answer is no. `createDraftEstimate` already does this; the appointment path must call it, not `createDraftEstimateNow`, whenever a `lead_id` is present.

4. **The new modal is a data-entry modal and must refuse Escape and backdrop close.** Prompt 63 shipped opt-in `{dismissible: true}` on `openModal` and a click-time input guard, after a half-typed change order died to a stray click. Do NOT pass `dismissible` here. Add this modal to the negative regression tests: with text typed into it, Escape and a backdrop click must both do nothing.

5. **Two modal roots.** `#pecModalRoot` (openModal/closeModal, index.html:1781, ~4808) and `#prodModalRoot` (hand-rolled inline flows, index.html:1782). Part B and C use `openModal` and therefore `#pecModalRoot` only. No `#prodModalRoot` work is expected; if something pulls you there, stop and explain why.

6. **supabase-js reports a nonexistent column as an empty response without throwing.** Check `res.error` on every read before suspecting RLS. Verify every column named in this prompt against SCHEMA.md first; assumed column names have caused real bugs twice.

7. **`estimates` has no `stage`, no deal name, and no PM column.** The screenshot shows all three. They are display-only or out of scope per Part B. Do not add columns.

---

## Verification

Cowork's call, overridable by Dylan: **browser-verify the buttons and the modal on the live deploy, unit-test the intake change.**

1. `npm test` green before the first commit and after the last code change. Report the check count and the verified exit code. Do not change an existing test to make it pass.
2. Part A: the new synthetic-payload test covers all four cases. Show the before/after string for the exact two lines Dylan pasted.
3. Part B, in the live browser signed in as Dylan: create an estimate three ways (existing customer, existing lead, brand-new contact with a job address and a salesperson). For each, re-query the `estimates` row and prove BOTH address shapes were written (`customer_address1/city/state/zip` AND the combined `customer_address`), and that `intake.salesperson_id/salesperson_name` match what was picked.
4. Part B negative test: type into the new modal, then press Escape and click the backdrop. Both must be refused. Re-confirm the prompt-63 trio (change order, payment, compose) still refuse both.
5. Part C, in the live browser: Start Estimate from an appointment linked to a lead (duplicate warning must appear if one is open), from one linked only to a customer, and from an unlinked one (must route through New Contact). Prove the appointment's address beat the customer's billing address on the resulting estimate.
6. Part D: load the rail, confirm the flyout reads `Sales Activity > Sales Pipeline` with Appointments beside it, confirm the page header still reads `Sales Pipeline`, and confirm `#leads` still routes.
7. **Delete every test row created during verification** (estimates, line items, customers, appointments) and re-query to show zero residue. Report the counts, as prompt 64 did.

## What's New (standing rule 11)

User-facing, so entries are required in `help/whats-new.json`, newest first, plain language, **no em dashes**:
- Starting an estimate now uses one form everywhere, with the job address and salesperson on it.
- You can start an estimate straight from an appointment.
- Appointment notes no longer show ID codes.

The rail rename is a label change and does not need its own entry; fold it into the first one if it reads naturally, otherwise skip it.

## Out of scope

**Customer-first architecture.** Dylan wants customers to be the source of truth with leads attached to them, not the reverse. That is scoped as its own discovery prompt and must NOT be started here. Nothing in prompt 65 blocks it: the schema is already pointed that way (`leads.customer_id` is a real FK, prompt 62 added the existing-customer estimate path and no-lead estimate cards), and Part B's contact-first modal moves with the grain. Do not refactor lead/customer relationships in this prompt.

Also still outstanding and untouched here: EST-102033's manual-price landmine, the plaintext ELEVENLABS_API_KEY rotation, the dead CONFIG.SHEETS_API_KEY, prompt 62's two-card board walkthrough, and the prompt-49 follow-up queue.
