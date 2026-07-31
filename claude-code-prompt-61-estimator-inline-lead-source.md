# Prompt 61: estimator inline on the estimate detail page, native job info editing, lead source unification and manual editing

Written by Cowork 2026-07-31 after 16 scoping questions. Every **LOCKED** line below is Dylan's answer, not a suggestion. Do not re-litigate them.

Two features in one build:

1. **The estimate flow.** Dylan: "estimator pre fills job info. Instead of a pop up modal, can you make it all on the estimate detail page? The flow is confusing right now." Asked three times across the scoping session, he named five complaints: two UIs for one estimate, editing one field means reopening the whole estimator, the modal traps you over the dashboard, it is unclear which record is authoritative, and it is unclear what saved and where you land. **The build answers all five: the estimator moves inline (no modal), job info becomes natively editable on the page (no estimator round trip for a phone number), the page states which record is authoritative, and saving keeps you where you are with visible confirmation.** The one thing deliberately NOT done is porting the estimator's pricing UI into index.html; that is the rewrite Dylan ruled out, and it would cost the offline path he kept.
2. **Lead source.** Dylan: "Ability to update lead source manually." It is currently write-once at lead creation and never editable.

## Read first

Standard startup (CLAUDE.md rule 4): CLAUDE.md plus the last 3 PROJECT-LOG.md entries.

State as of this prompt (verified against the repo at commit `dba990a`):

- **Prompt 60 shipped today.** The review drip, intake, bonus ledger and its migration `2026-08-04_review_drip.sql` are live and verified. Nothing in this prompt touches review code.
- Still open and NOT part of this prompt: the Routemize `AppointmentUpdated` reschedule bug (`newStartTime`/`newEndTime` unmapped in `pec-appt-intake.cjs`), Bobette Weiss's Unapprove/Approve/Finalize, and `claude-code-prompt-49-followup-queue.md`, which has never been run.
- Line numbers below are as of `dba990a` and will drift as you edit. Anchor on function names; use features.json per rule 9.

### Live facts already verified by Cowork. Do not re-derive these.

Estimator architecture:

- `apps/estimator/` is the React/Vite PWA source; `estimator/` at the repo root is its BUILT output. Rule: never hand-edit the build output. Any estimator change in this prompt means editing `apps/estimator/src/**` and rebuilding.
- The dashboard frames it: `openEstimatorFrame` (index.html:7124) renders `<iframe class="pec-estimator-frame" src="/estimator/?embed=1&...">` into `#pecModalRoot` via `openModal`, and adds `.pec-modal-estimator` (CSS at index.html:601, `height:92vh`).
- `openEstimatorModal` (index.html:7144) wraps it with the open-estimate duplicate guard (`OPEN_ESTIMATE_STATUSES`, `showDuplicateEstimateModal` at 7173). The guard deliberately lives on the launcher, not on one button.
- Three callers: `leadStartEstimate` (index.html:25512), `pecEstNew` (the Estimates list New estimate button, wired at ~25757), `estEdit` (the estimate detail Edit button, index.html:26095).
- The iframe talks back by `postMessage`, origin-checked, handled at index.html:7210-7233: `pec-estimator-close` calls `closeModal()`; `pec-estimate-saved` calls `closeModal()`, toasts, sets `state.openEstimateId` and `switchView('estimates')`.
- Estimator side: `embedFromUrl()` (`apps/estimator/src/lib/lead.ts:39`) reads `?embed=1`. `App.tsx` passes `embed` to `EstimatorScreen`, which posts `pec-estimate-saved` after a successful save (EstimatorScreen.tsx ~1566) and renders a **Close** button instead of Back when embedded (~1689). `postToParent` is at ~1155.
- Prefill today is form-state only: `loadLeadLink` (`lib/lead.ts`) reads the lead's `full_name/phone/email/address/city/state/zip` and seeds the customer form. Nothing is written to a row until the rep saves.
- `loadEstimateForEdit` (`lib/estimateLoad.ts`) is the `?estimate_id=` path and is **online by design** (it rewrites child rows, which needs a live delete). The offline outbox is the NEW-estimate path only.

Schema (SCHEMA.md, `estimates`):

- Every column an estimate needs to exist is nullable or defaulted. `status` defaults `'draft'`, `brand` defaults `'PEC'`, `public_token` defaults, `estimate_number` defaults `nextval('estimates_estimate_number_seq')`. An insert of `{lead_id, created_by}` alone is legal.
- Customer data is stored on the estimate in BOTH shapes: split (`customer_first_name`, `customer_last_name`, `customer_company`, `customer_is_commercial`, `customer_address1`, `customer_address2`, `customer_city`, `customer_state`, `customer_zip`) and legacy combined (`customer_name`, `customer_address`, plus `customer_email`, `customer_phone`).
- Salesperson is NOT a column. It lives in the `intake` jsonb (`intake.salesperson_name` and the id the estimator writes), and it is admin-locked once set (prompt 55 Part B, `viewerIsAdmin` in `App.tsx`, which FAILS CLOSED).

Lead source:

- Two columns, two vocabularies. `leads.source` holds code tokens; the New lead modal (index.html:24265, `#nlSource`) offers `['manual','meta','google_lsa','webform','angi','openphone','dripjobs']` plus whatever is already in the data plus active `pec_lead_sources` names. `customers.lead_source` holds `pec_lead_sources` names and is a required dropdown in the customer form (index.html:~8394, saved at ~8473).
- `pec_lead_sources` (19 rows) is a managed list with a Settings CRUD already built: table render at index.html:19228+, `openLeadSourceModal` at 21315.
- `LEAD_SOURCE_COLORS` / `LEAD_SOURCE_LABELS` (index.html:23360-23367) are keyed by the code tokens. `leadSourceLabel` falls back to `titleCaseValue`.
- Readers of `leads.source`: the kanban card badge (24760), the lead detail badge (25450), the board filter (`#leadFilterSource`), Metrics conversion-by-source (`convBySource = convGroup(l => leadSourceLabel(l.source))`, ~12600), and the blast wizard (raw equality filter at ~23738, options built from raw values at ~23838).
- Writers of `leads.source`: `pec-lead-intake.cjs` (`const source = cleanStr(body.source) || 'webform'`, line 91) and `pec-appt-intake.cjs` (Routemize: creates a lead with `source: rz.leadSource`, and for an existing lead fills the source **only when null**, line ~562, deliberately never overwriting attribution).
- `lead_events` (id, lead_id, event_type, from_stage, to_stage, payload jsonb, actor_user_id, created_at) has no CHECK on event_type. The lead detail timeline reads it at ~25260 and renders through `leadEventHtml` (25194).
- **Cowork could NOT read the live `pec_lead_sources` rows or the live distinct `leads.source` values: the Supabase MCP returned 502 three times while writing this.** Part D step 1 is therefore an inventory step. Do not hardcode a mapping from this document.

---

## Part A: inline the estimator on the estimate detail page

**LOCKED shape: keep the estimator exactly as it is architecturally (React PWA, own service worker, offline outbox) and render it INLINE inside the estimate detail page instead of in a floating modal.** Do not port the estimator into index.html. Do not rebuild it in vanilla JS. This is a hosting change, not a rewrite.

**LOCKED layout: a draft estimate opens with the estimator already open inline. A sent, signed, accepted, rejected or lost estimate renders the read-only summary with an Edit control that swaps the summary region for the inline estimator.** No overlay, no `#pecModalRoot`, page chrome (Back to estimates, the status header) stays visible and usable the whole time.

Changes:

1. Refactor `openEstimatorFrame` into a source builder plus two mounts. Extract `estimatorFrameSrc({ leadId, estimateId })` returning the `/estimator/?embed=1&...` URL, including the existing best-effort service-worker `update()` kick (index.html:7126-7133) which must run for the inline mount too. That kick is not optional: it is what unstuck browsers holding the cached `X-Frame-Options: DENY` shell after prompt 59.
2. New `mountInlineEstimator(container, { leadId, estimateId })`: creates the iframe in the given container, no modal, no `.pec-modal-estimator` class. New CSS class `.pec-estimator-inline` for the inline frame.
3. **Height.** The modal gave the frame `92vh`. Inline, a fixed tall frame plus the page's own scrollbar is the nested-scroll UX smell that will make this feel worse than the modal, not better. Post the height: in `EstimatorScreen`, a `ResizeObserver` on the app root posts `{ type: 'pec-estimator-height', px }` to the parent (through the existing `postToParent`, same origin check), throttled with `requestAnimationFrame`; the dashboard sets `iframe.style.height`. Fallback if no height message arrives within 1500ms, or if the frame reports 0: `min(1100px, 85vh)` with internal scrolling. Never let the frame collapse below 520px.
4. `renderEstimateDetail` (index.html:25761) gains an estimator region. Structure the page as: toolbar (unchanged), then a region that is EITHER the read-only summary or the inline estimator, then the parts that stay visible in both states (activity trail, views info, line-item table when read-only). Draft status mounts the estimator on render; every other status mounts the summary plus an Edit control.
5. `estEdit` (26095) no longer calls `openEstimatorModal`. It swaps the region to the inline estimator in place, without re-rendering the page and without navigating.
6. The estimator's embedded **Close** button (EstimatorScreen ~1689) keeps posting `pec-estimator-close`. The dashboard's handler becomes context-aware: if an inline estimator is mounted, unmount it and render the read-only summary in that region; otherwise fall back to `closeModal()` (the offline path in Part B still uses the modal).
7. The `pec-estimate-saved` handler (index.html:7219) becomes context-aware too:
   - Inline, and the saved id is the estimate already open: **do NOT re-render the page and do NOT navigate.** Toast, refresh the summary data and the status header in place, leave the iframe mounted and untouched.
   - Inline, but the saved id differs from the open one (should not happen, defend anyway): behave as today, navigate to the saved estimate.
   - Modal (offline fallback path): behave exactly as today.
8. **LOCKED: saving must be legible.** The fifth complaint is "unclear what saved and where you land". After any save, inline or offline-modal: a toast naming the estimate (EST-###), the status header and totals visibly refreshed in place, and the estimator's own save state reflecting saved. The user must never have to guess whether the row exists. If the save came from the offline outbox, say that in the toast instead of implying it reached the server.
9. **LOCKED: visual continuity, and treat it as a real deliverable, not polish.** Asked four times what is most confusing, Dylan's single answer was "two different-looking UIs for one estimate". Inlining the frame does NOT fix that by itself: the estimator still renders with its own stylesheet inside your page, and a React app in a frame that looks like a different product is exactly the complaint. So:
   - Align `apps/estimator/src/styles.css` with the dashboard's design tokens: background, surface, border, text, muted, accent, danger, radius, font family and control sizing. Where the dashboard uses CSS custom properties, mirror the same names in the estimator so both read from one vocabulary.
   - Dark mode must follow the dashboard, not the OS. The parent posts its current theme on mount and on change (`{ type: 'pec-theme', theme }`, origin-checked, same channel as the height message); the estimator applies it. A light estimator panel inside a dark dashboard is the seam at its most obvious.
   - When `embed=1`, drop the estimator's own header chrome that duplicates the page: the app title and the redundant surrounding padding. Keep the sync/offline status and the Close control, since those have no equivalent on the page.
   - Acceptance is visual: screenshot the estimate detail page with the estimator open, in both themes, and confirm the panel reads as part of the page rather than a window inside it. If it still reads as a separate app after the token alignment, say so in the log entry rather than declaring the complaint fixed. A rewrite is the only complete cure and Dylan ruled it out knowingly.
10. Keep `openEstimatorModal` and `showDuplicateEstimateModal` alive. The modal is no longer the normal path, but it is the offline fallback (Part B item 5) and the duplicate guard is reused. Update the comment block at index.html:7106-7123 so the next reader knows the modal is now the exception, not the rule.

**LOCKED: the standalone `/estimator/` page keeps working unchanged.** Reps are on-site but essentially always online (Dylan, confirmed twice), so offline is a safety net rather than a daily path; he still wants it intact. Build for the online case, keep the offline case working. `embed=0` behavior (Back button, Dashboard links, outbox) is untouched.

**The landmine that will bite you if you ignore it (landmine 1 below):** any code path that calls `renderEstimateDetail(est.id)` while the inline estimator is mounted destroys and re-creates the iframe, which reloads the PWA and silently discards whatever the rep had typed. There are roughly a dozen such calls in the file (25467, 25493, 25530, 25542, 25585, 25595, 25631, 25655, 25678, 25705, 25860 as of `dba990a`, all in the pre-`dba990a` numbering plus their current equivalents). Audit every one. Either guard the whole-page re-render while the estimator is mounted, or make those handlers refresh only their own region.

---

## Part B: "New estimate" creates a draft row immediately, prefilled

**LOCKED: clicking New estimate (or Start estimate from a lead) creates a draft estimate row right away and lands the user on that estimate's detail page, with the estimator already open inline.** This is what makes "it is all on the estimate detail page" true for creation as well as editing.

**LOCKED: abandoned empty drafts are left alone. Dylan will archive them by hand.** Do not build auto-archiving, do not hide them from the list, do not add a cleanup job. If they become a nuisance he will say so.

**LOCKED: estimate number gaps are fine.** `estimate_number` is a sequence default, so an abandoned draft burns a number and customer-facing numbering will show gaps (EST-104, EST-107). Accepted knowingly. Do not add number-on-save or number-on-send logic.

Changes:

1. New `createDraftEstimate({ leadId })`: inserts one `estimates` row with `lead_id`, `created_by` (current auth user), `status` left to its `'draft'` default, and the **prefilled job info copied from the lead**: `customer_first_name` / `customer_last_name` split from `leads.full_name` (mirror the estimator's `splitLegacyName`), `customer_email`, `customer_phone`, `customer_address1`, `customer_city`, `customer_state`, `customer_zip`, and the legacy combined `customer_name` / `customer_address` written in the same shape the estimator writes them. Walk-up (no lead) inserts the row with no customer fields.
   - Write the split AND the legacy columns. Readers are split across both; a row with only one populated shows blanks somewhere.
   - `res.error` must be checked explicitly (the supabase-js silent-empty gotcha). A failed insert shows an error toast and does nothing else. It must never leave the user on a detail page for a row that does not exist.
2. The duplicate guard runs BEFORE the insert, not after. Creating the row first and then asking "you already have an open estimate" leaves an orphan every time the answer is no.
3. On success: `state.openEstimateId = <new id>`, `switchView('estimates')`, which renders the detail page, which (status draft) mounts the inline estimator with `?estimate_id=<new id>`.
4. `leadStartEstimate` (25512) and `pecEstNew` (~25757) both route through this.
5. **Offline fallback.** The insert needs the network. If `!navigator.onLine` (or the insert fails with a network error), fall back to today's behavior exactly: `openEstimatorModal({ leadId })`, the offline outbox path, the modal, the existing save-and-navigate handler. Show a one-line note in the modal explaining that the estimate will be created when the device is back online. This is the ONLY remaining modal launch path.
6. **The estimator must survive loading a nearly empty draft.** `?estimate_id=` goes through `loadEstimateForEdit`, and `EstimatorScreen` seeds `areas` from `editing.areas` when editing, falling back to a single `Main` area only when NOT editing (EstimatorScreen.tsx ~286-292). A freshly created draft is "editing" with zero areas, so the rep would land on a form with no area row at all. Fix in the estimator: when `editing` has no areas, seed the same single `Main` area the create path uses. Same audit for any other place that assumes an edited estimate has a system type, line items, a price, or a pricing snapshot. Add a test to `production/estimate-draft.test.cjs` (or a new fixture suite) covering the empty-draft load shape.
7. Draft rows created this way must not appear anywhere they would read as real work: check the Ops Queue derived checks, the leads board value map (`leadValueMapFrom`), Metrics estimate counts, and the follow-up queue for anything that counts draft estimates or their `price`. A `null`-priced draft must not move a number or raise a queue item. If one of them does count drafts today, say so in the log entry rather than silently changing it.

---

## Part C: native job info editing on the estimate detail page

**LOCKED: the customer / job info block on the estimate detail page is natively editable, without opening the estimator.** This is the piece that actually answers "editing means reopening the estimator". Fields: first name, last name, company, residential/commercial toggle, email, phone, address1, address2, city, state, zip, and salesperson.

**LOCKED: propagation is ASK EACH TIME.** On save, if the estimate is linked to a lead and/or a customer and any shared field now differs, show a confirm listing the differing fields with a per-record choice, defaulted to CHECKED (yes, update the lead and customer). Never propagate silently, never propagate without offering.

Changes:

1. Inline edit affordance on the existing job info block in `renderEstimateDetail`. Edit swaps the block for a form; Save writes; Cancel restores. Do not re-render the whole page on save (landmine 1).
2. Writes go to the estimate's split columns AND the legacy combined columns, matching exactly what `EstimatorScreen`'s save writes. Read that save path before writing this one; if the two disagree the public estimate page and the work order will disagree with the detail page.
3. **Salesperson is admin-locked, and this is the highest-risk item in Part C.** The estimator only lets an admin change the salesperson once one is set, and it FAILS CLOSED when the role read errors (App.tsx). Mirror that exactly: the dashboard knows the viewer's role already; non-admins see the salesperson read-only with the same reasoning in the title attribute. A native editor that skips this check is a commission attribution hole, and commission flows into GP.
4. Changing the salesperson must keep `intake.salesperson_name` and the salesperson id in `intake` consistent, and must not clobber the rest of the `intake` jsonb. Read-modify-write the whole object; never PATCH a partial `intake`.
5. Propagation, when confirmed: update `leads` (full_name, email, phone, address, city, state, zip) and/or `customers` (first_name, last_name, company_name, email, phone, billing_address_*). Write a `lead_events` row `{ event_type: 'lead_updated', payload: { from, to, via: 'estimate', estimate_id } }` so the lead timeline shows why its address changed. `leadEventHtml` (25194) needs a case for it.
6. If the rep declines propagation, the estimate keeps its own values and the block shows a small "differs from lead" note with a one-click "push to lead" action. Divergence is legal; invisible divergence is not.
7. **Say which record is authoritative, on the page.** Dylan's fourth complaint (added after the first pass) is that job info lives on the lead, in the estimator, and on the estimate, and it is not clear which one wins. The rule this build establishes, and the block must state it in one plain line: **the estimate carries its own snapshot of job info; the lead and customer are only updated when someone says yes.** Show the source of each block's values ("from lead <name>" when they still match, "edited on this estimate" when they do not), so the answer is on screen instead of in someone's head.
8. Non-idempotent write discipline (CLAUDE.md architecture gotchas): these are ordinary PATCHes, so use `withDeadline`, not a blind auto-retry.

---

## Part D: unify the lead source vocabulary

**LOCKED: one managed list, `pec_lead_sources`, drives both `leads.source` and `customers.lead_source`. Migrate the stored data, and map incoming feed tokens to the managed names at intake.** Not a display-only mapping, not a "seed the tokens as rows and clean up later".

This is the part that can quietly break lead intake. Take it in this order.

**Step 1, inventory. No writes.** Query prod (`zdfpzmmrgotynrwkeakd`) via the Supabase MCP and PRINT the results in chat before writing any SQL:

```sql
select name, active from pec_lead_sources order by name;
select coalesce(source,'(null)') s, count(*) from leads where deleted_at is null group by 1 order by 2 desc;
select coalesce(lead_source,'(null)') s, count(*) from customers group by 1 order by 2 desc;
```

Then propose the token-to-name mapping from what is actually there, in chat, before applying anything. If a token has no obvious managed-name counterpart, DO NOT invent one: add it as a new `pec_lead_sources` row named the way the Settings list would name it, and say so.

**Step 2, migration** `supabase/migrations/2026-08-05_lead_source_unification.sql`, with a rule-13 `@artifacts` header:

1. `alter table public.pec_lead_sources add column if not exists aliases text[] not null default '{}'`. Aliases are what intake feeds send (`meta`, `google_lsa`, `webform`, `angi`, `openphone`, `dripjobs`, `manual`, plus whatever Routemize sends). This is what makes a future feed a data change instead of a code change, per rule 12.
2. Insert any missing managed rows for tokens that have no counterpart.
3. Populate `aliases` from the agreed mapping.
4. Rewrite the stored data: `leads.source` and `customers.lead_source` set to the canonical `pec_lead_sources.name`, matching case-insensitively on name or alias. Rows whose value matches nothing are LEFT ALONE (never null out attribution) and counted.
5. Print counts of rows changed per value in the log entry. No silent caps.
6. Apply it yourself via the Supabase MCP (you have done this since prompt 59), verify with a re-query, and regenerate SCHEMA.md.

**Step 3, intake mapping.** New shared helper (`netlify/functions/_pec-lead-source.cjs` or an export from `_pec-supabase.cjs`): `resolveLeadSourceName(db, raw)` looks up `pec_lead_sources` by exact name, then case-insensitive name, then alias; returns the canonical name; returns the raw trimmed string unchanged when nothing matches, and `console.warn`s so an unmapped feed shows up in the function log instead of vanishing.

- `pec-lead-intake.cjs`: resolve at line ~91, **before** the dedupe query at line 113-114. That query is `/leads?source=eq.<source>&source_ref=eq.<ref>` — if the stored values are canonical names and the query uses the raw token, idempotency breaks and every Zapier retry creates a duplicate lead. Map first, then dedupe.
- `pec-appt-intake.cjs`: resolve `rz.leadSource` in both places (the `createRoutemizeLead` call ~547 and the fill-only-when-null PATCH ~562). Keep the never-overwrite behavior exactly as it is.
- Grep for any other writer of `leads.source` or `customers.lead_source` before you finish. The DripJobs webhook path is the likely third one.

**Step 4, client side.** `LEAD_SOURCE_COLORS` / `LEAD_SOURCE_LABELS` are keyed by token; after the migration `lead.source` is `'Meta'`, not `'meta'`, so every badge silently goes gray and every label goes through `titleCaseValue`. Normalize the lookup key (lowercase, spaces and hyphens to underscore) and keep the maps as the color source, with the existing gray fallback. Do not add a color column to `pec_lead_sources` in this build.

- `#nlSource` (New lead modal, 24265) becomes the managed list only, plus the values already present in the data so an unmapped legacy value is still selectable.
- The board filter, the blast wizard source filter and its option list, and Metrics `convBySource` all keep working on canonical values. Verify each after the migration rather than assuming.
- The Settings lead-source editor (`openLeadSourceModal`, 21315) gains an Aliases field (comma separated). That is this feature's rule-12 settings surface: adding a new feed vocabulary must not need a code change.

---

## Part E: change the lead source manually

**LOCKED: editable on the lead detail page AND on the customer detail page.** Dylan first said customer only; when it was pointed out that most leads have no customer record until they book (and that Metrics conversion-by-source reads `leads.source`), he added the lead detail page.

**LOCKED: the two stay in sync.** Editing on the lead updates the linked customer (`leads.customer_id`); editing on the customer updates its linked lead if one exists. One concept, one value.

**LOCKED: every change is logged on the lead timeline.** A `lead_events` row: `{ event_type: 'source_changed', payload: { from, to, via: 'lead' | 'customer' } }`, `actor_user_id` set. `leadEventHtml` renders it as "Source changed from X to Y by <name>".

**LOCKED: no permission gate.** Any signed-in staff user can change a lead source. Dylan was offered the admin-only variant and did not take it. Do not add a role check.

Changes:

1. Lead detail (`renderLeadDetail`, 25252): the source badge at ~25450 becomes clickable, opening a small inline select of active `pec_lead_sources` names (plus the current value if it is not in the list, so an unmapped legacy value is never silently replaced). Save writes `leads.source`, syncs the customer when linked, writes the `lead_events` row, and re-renders the lead detail.
2. Customer detail (`renderCustomerDetail`, 8171): same editor on the customer's source. Sync back to the lead when `leads.customer_id` points at this customer, and still write the `lead_events` row on that lead. A customer with no lead simply has nowhere to log it; that is acceptable and should be a code comment, not a new table.
3. The customer form's existing required `lead_source` select (~8394) stays; make both places read the same option builder so they cannot drift.
4. Not built, on purpose: no kanban-card editor, no bulk edit from the leads list. Dylan was offered both and chose neither. Do not add them.
5. Retroactive reporting: changing a source moves Metrics conversion-by-source for past periods. That is understood and accepted; the timeline entry is the record of why. Do not add an `original_source` column (offered, not taken).

---

## Landmines

1. **Re-rendering the estimate detail page while the inline estimator is mounted destroys the iframe and drops the rep's unsaved work.** Every `renderEstimateDetail(est.id)` call in the file is a candidate. Audit all of them. This is the single most likely way to ship something worse than the modal.
2. **Do not port the estimator into index.html.** Inline hosting only. A vanilla rebuild kills the offline outbox and the service worker, both of which Dylan explicitly kept.
3. **`estimator/` is build output.** Edit `apps/estimator/src/**` and rebuild; hand-editing the built bundle is a rule violation and gets overwritten.
4. **Service worker caching.** Prompt 59's lesson: a header or shell change is not deployed until the estimator's precached shell is refetched. If you change `apps/estimator/index.html` or the app shell, bump the precache revision, and keep the `serviceWorker.getRegistration('/estimator/').update()` kick on every mount.
5. **The empty-draft load.** `editing.areas === []` currently yields a form with no area row. Fix it in the estimator, not by writing a fake area row into the database.
6. **The duplicate guard runs before the insert**, or every declined duplicate leaves an orphan draft.
7. **Salesperson stays admin-locked and fails closed** in the new native editor, exactly as the estimator does.
8. **`intake` is read-modify-write.** A partial write drops comps, discount, and pricing context.
9. **Map the source token BEFORE the dedupe query in `pec-lead-intake.cjs`.** Getting this backwards turns every Zapier retry into a duplicate lead. This is the highest-consequence bug available in Part D.
10. **`pec-appt-intake.cjs` fills `source` only when null, by design (prompt 56 decision 10).** Mapping the value does not license overwriting it.
11. **`LEAD_SOURCE_COLORS` / `LEAD_SOURCE_LABELS` are keyed by token.** After the migration, unnormalized lookups make every badge gray. Normalize the key.
12. **Rows that match no alias are left alone and counted.** Never null out a source you could not map.
13. **`res.error` must be checked explicitly on every new supabase-js read.** A nonexistent column returns an empty result, not a throw.
14. **No em dashes in anything customer-facing.** Nothing in this build is customer-facing except What's New entries, which are.
15. **Do not build what was declined:** no draft auto-archiving, no draft hiding, no estimate-number-on-save, no `original_source` column, no bulk source edit, no kanban-card source edit, no role gate on source editing.

---

## Acceptance criteria

1. Clicking Start estimate on a lead lands on a new estimate's detail page (URL state, Back to estimates visible) with the estimator open inline, no modal, and the customer name, phone, email and address already filled from the lead.
2. Saving inside the inline estimator leaves the page where it is: a toast, the header and summary data refresh, and the iframe is not reloaded. Typing in a field, saving, and continuing to type loses nothing.
3. Closing the inline estimator on a draft shows the read-only summary in the same region; Edit swaps it back, with the form state loaded from the row.
4. On a sent estimate, the page renders read-only by default and Edit opens the estimator inline in place.
5. With the network off, New estimate falls back to the modal and the offline outbox, and the rep is told the estimate will be created when the device is back online.
6. A brand-new empty draft opened in the estimator shows one `Main` area, not an empty area list.
7. Editing the phone number in the job info block on the estimate detail page saves without opening the estimator, and offers to update the lead and customer with the boxes pre-checked. Declining leaves the estimate changed, the lead unchanged, and a "differs from lead" note visible.
8. A non-admin cannot change the salesperson from the new native editor, and cannot when the role read fails either.
9. After the Part D migration, every lead and customer source value is a `pec_lead_sources` name (or an explicitly reported unmapped leftover), badges are still colored, the leads board filter still filters, and Metrics conversion-by-source still groups.
10. Posting the same test lead to `pec-lead-intake` twice with the same `source_ref` still dedupes to one lead after the mapping change.
11. Changing a lead's source from the lead detail updates the linked customer and writes one `source_changed` entry on the lead timeline naming the old and new values and the user.
12. Changing a customer's source updates its linked lead and writes the same timeline entry on that lead.
13. `npm test` is green, including a new or extended fixture suite covering the empty-draft estimator load and `resolveLeadSourceName` (exact, case-insensitive, alias, and no-match-returns-raw).

---

## Commits expected

Roughly, in dependency order. Commit after each meaningful change per rule 1.

1. `estimator: inline frame mount + height posting (no modal)` (index.html + apps/estimator, rebuild)
2. `estimates: draft-on-create, prefilled from the lead, offline modal fallback`
3. `estimator: seed a Main area when editing a draft with no areas` (+ test)
4. `estimates: native job info editing with ask-to-propagate`
5. `db: lead source unification migration (aliases, data rewrite)`
6. `intake: map feed source tokens to managed lead source names` (+ test)
7. `leads: manual source editing on lead and customer detail, timeline logged`
8. `docs: prompt 61 bookkeeping (What's New, features.json, SCHEMA.md, log entry)`

## Bookkeeping

- Rule 11: What's New entries for the two user-visible changes (the estimate flow, and manual lead source editing). Plain language, no em dashes, 2-3 how-to steps each, appended to `help/whats-new.json` newest first.
- Rule 9: update the `features.json` entries for the estimator, the estimates view, leads, and lead sources, including the new anchors.
- Rule 12: the Aliases field in the Settings lead-source editor is this build's settings surface. If the height fallback or anything else grows a tunable number, it belongs in `settings` too.
- Rule 13: `@artifacts` header on the migration. The `aliases` column is verifiable; the data rewrite is not, so declare what applies and note the hand-verified parts.
- Regenerate SCHEMA.md after applying the migration.

## Log entry

Per rule 2, append at the TOP of PROJECT-LOG.md. Include: the inventory counts from Part D step 1 and the mapping actually applied (before and after counts per value), how many `renderEstimateDetail` call sites had to be guarded in Part A, anything you found that counts draft estimates and therefore changed behavior when drafts started existing early, and whether the estimator height posting needed the fallback in practice.

## Handoff to Dylan

Expect at least these. Add any others you hit.

1. Walk the new flow once on a real lead before the team sees it: Start estimate, build, save, close, edit, and confirm nothing jumps or reloads.
2. Empty drafts now accumulate in the Estimates list by your own choice. Archive them when they annoy you, and tell Cowork if you want the auto-archive after all.
3. Estimate numbers will now show gaps. If a customer ever asks, that is why.
4. Review the token-to-name mapping Claude Code proposes in Part D step 1 BEFORE it applies the migration. That mapping is what your marketing reporting will be grouped by from then on.
