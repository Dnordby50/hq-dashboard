# Prompt 72: Optional line items on any line, opt-out selection, declined-line add-back

## Context

Dylan's ask, verbatim: "Need to be able to make all line items optional. When building an estimate."

Optional lines already exist, but only for add-ons. `estimate_line_items.is_optional` and `.selected_by_customer` are real columns (2026-07-13), the public estimate page already renders tickable option cards and re-totals live, and `includedTotal` already excludes an unselected optional line. What does NOT exist is the ability to mark an AREA line or a CUSTOM line optional: the estimator hardcodes `isOptional: false` on every calculator area line, every custom line, and the whole-estimate custom line (`apps/estimator/src/features/estimator/EstimatorScreen.tsx:1759`, `:1782`, `:1821`), and only the add-on loop reads a real flag (`:1821` uses `f.optional`).

So this build is mostly unlocking plumbing that already works, plus one hard part that has to be handled deliberately: since prompt 69, the per-line solve merges ONE kit-merged material plan across all areas (two bays each needing 0.44 of a basecoat kit buy ONE kit between them). If a customer drops a line, the remaining lines keep that shared-kit discount in their price but now have to buy the full kit alone. Dylan's decision on that is recorded below and it is deliberately NOT a pricing change.

This prompt was scoped by Cowork with Dylan on 2026-08-05 across 12 questions. Every decision below is his, not an inference.

## Locked decisions

1. **Any line can be marked optional** (calculator area lines, custom lines, add-ons), with ONE structural floor: **an estimate cannot be sent with zero required lines.** At least one line must stay required. That floor is enforced at the rep's save/send gate, which is what makes the customer floor automatic: a customer can never untick their way to $0 because the required lines are not tickable.
2. **Rep decides per line, default required.** A new line ships required; the rep ticks "Optional" on the ones the customer gets to choose. Same shape as the add-on checkbox today (`EstimatorScreen.tsx:2513`).
3. **Optional AREA and CUSTOM lines start TICKED for the customer (opt-out).** They are in the headline number and the customer unticks to remove. Optional ADD-ONS keep today's behavior and start unticked (opt-in). Do not change add-on behavior.
4. **Customer floor:** at least one line always remains selected, satisfied structurally by decision 1. Also add a defensive guard on the accept endpoint (below) so a hand-crafted POST cannot produce a $0 accept.
5. **The kit-merge problem: do not change pricing. Change the MATERIAL estimate.** The customer's total is the plain sum of ticked lines. The line prices the rep set are honored exactly. What changes at accept is the material plan and the job's cost basis: the job is built from the SELECTED areas only, so the material plan, the ordering, and the costing rollup are computed on what was actually sold, not on what was offered.
6. **Rep sees per-line GP plus two totals** while building: all-in total, required-only total, and each optional line's own GP% (prompt 69 already computes per-line GP).
7. **Two stored numbers, separate meanings.** `estimates.price` = required lines only (the guaranteed floor, what pipeline and forecast count). New `estimates.price_all_options` = every line at full value (the ceiling). Pipeline reads "$8,200 (up to $12,400)".
8. **GP guard: warn, do not block.** If dropping the optional lines would put the remaining estimate below the line-pricing GP floor, show an amber notice naming the shortfall. The rep can proceed.
9. **On accept: selected lines only flow to the job. Declined lines stay on the estimate, marked declined.** You keep the record of what was offered and refused.
10. **Scope text: strip on the job, keep the estimate as signed.** `estimates.scope_of_work` is never rewritten after signature (it is the legal document the customer read). The JOB side (job_areas, pec_prod_jobs notes, work order, crew sheet) shows only the selected lines' scope.
11. **Declined lines are logged, no automation.** Record them, surface them on the job and the customer. No drip, no follow-up-queue enrollment, no lead event automation in this build.
12. **One-click add-back as a change order, at the originally quoted price.** A declined line shows on the job with an "Add to job" button that opens the existing change-order modal in AREA mode, prefilled from that estimate area, with the original quoted price prefilled and the material cost recomputed at current catalog cost.

## Part 0: read before you build

- `SCHEMA.md`: `estimate_areas`, `estimate_line_items`, `estimates`, `job_areas`, `pec_prod_areas`, `pec_prod_jobs`. Verify every column name you touch. Do not guess one.
- `features.json`: the estimator, the public estimate page, the estimate detail page, the change-order flow, the presentation view (prompt 64). Use its anchors instead of grepping `index.html` blind.
- PROJECT-LOG entries for prompts 69 and 70 (2026-08-04): the per-line pricing model and the per-line AI. This build sits directly on top of both.

Known anchors, verify before editing:

| What | Where |
|---|---|
| Add-on optional checkbox (the pattern to copy) | `EstimatorScreen.tsx:2513` |
| Area line write, `isOptional: false` hardcoded | `EstimatorScreen.tsx:1821` (area), `:1782` (custom line), `:1759` (whole-estimate custom) |
| Add-on money excluded until selected | `EstimatorScreen.tsx:920`, `:852` comment |
| "with every optional item" hint | `EstimatorScreen.tsx:2710` |
| Estimator save (areas then line items) | `apps/estimator/src/offline/estimates.ts:270-340` |
| Estimator reload for edit | `apps/estimator/src/lib/estimateLoad.ts:117-150` |
| Public page optional cards | `netlify/functions/pec-public-estimate.cjs:226` (`optionalCardsHtml`) |
| Public page included total / freeze / apply | same file `:92` (`includedTotal`), `:105` (`freezeLineItems`), `:117` (`applySelection`) |
| Accept handler | same file `:1094` (`handleAccept`) |
| Job creation from an accepted estimate | same file `:830` (`ensureJobCreated`), `job_areas` write at `:963-990`, `pec_prod_jobs` at `:995`, `pec_prod_areas` at `:1024` |
| Dashboard estimate line render | `index.html:28124` |
| Optional-aware totals in the dashboard | `index.html:27566-27575` |
| Change-order modal (AREA mode) | `index.html:10500` (`openChangeOrderModal`), `job_areas` insert at `:10795` |

## Part A: migration and settings

New migration `supabase/migrations/2026-08-11_prompt72_optional_lines.sql`, with the `@artifacts` header per standing rule 13:

```sql
-- @artifacts
--   column: public.estimate_areas.is_optional
--   column: public.estimate_areas.preselected
--   column: public.estimates.price_all_options
--   setting: optional_lines_enabled
--   setting: optional_lines_preselect_default
--   setting: optional_lines_gp_warn_pct
-- @end
```

- `estimate_areas.is_optional boolean not null default false`. This is the SOURCE OF TRUTH for whether an area or custom line is optional, because the estimator reloads areas by position and does not select area ids (`estimateLoad.ts:130`). The estimator mirrors it onto the matching `estimate_line_items` row on save; the public page and every read path keep using `estimate_line_items.is_optional` exactly as they do today, so nothing downstream needs to learn about a second flag.
- `estimate_areas.preselected boolean not null default true`. Whether an optional line starts ticked for the customer. Per decision 3, area and custom lines default true. Ignored when `is_optional` is false.
- `estimates.price_all_options numeric null`. Per decision 7.
- Three settings rows (standing rule 12), under **Settings > Estimates > Optional lines**:
  - `optional_lines_enabled` (default `'true'`): when false, the Optional checkbox does not render in the estimator and no new optional lines can be created. Already-optional lines on existing estimates still render and still work; this is a create-gate, never a data-hiding gate.
  - `optional_lines_preselect_default` (default `'true'`): whether a newly ticked-Optional area or custom line starts pre-selected for the customer. Add-ons are unaffected and always start unselected.
  - `optional_lines_gp_warn_pct` (default: seed from the existing line-pricing GP floor, currently 40): the threshold for the decision-8 warning.

Forward-only. No backfill. Every pre-72 row reads `is_optional=false`, `preselected=true` (irrelevant while `is_optional` is false), and renders exactly as it does today. Regenerate `SCHEMA.md` after applying.

## Part B: the estimator

**B1. The checkbox.** Every line row in the line list gets an "Optional (customer picks)" checkbox, same control and same wording as the add-on one at `:2513`, so the rep learns one concept. Applies to calculator area lines and custom lines. When `optional_lines_enabled` is false, the checkbox does not render.

**B2. MVB rides its area.** A moisture vapor barrier that belongs to an area is not independently optional: if the area is dropped, its MVB goes with it. Do not render a separate Optional control for an area's MVB. A STANDALONE MVB job (the "MVB Only" system type, `est.mvb === 'standalone'`) is a normal line and can be optional like any other.

**B3. The send gate (decision 1).** At least one line must be required. Implement as a save/send gate, not a silent correction: if every line is ticked Optional, block with "At least one line has to be required. A customer cannot be sent an estimate they can untick to nothing." Check this on the send path, not on draft save, so a rep mid-build is never blocked by a half-built estimate.

**B4. Pre-selected control.** Next to Optional, a second control "Starts selected for the customer", defaulting from `optional_lines_preselect_default`. Persist to `estimate_areas.preselected` and mirror to the line item's `selected_by_customer` at save time (true = the public page renders it checked and includes it in the opening total, which is exactly what `optionalCardsHtml` already does with `li.selected_by_customer`).

**B5. Totals and GP readouts (decision 6).** Below the price block, show:
- **All-in:** every line at full value.
- **Required only:** required lines only, with its own GP% computed on that set.
- Per-optional-line GP%, inline on the line row. Prompt 69 already computes per-line GP (`lineMoney`); reuse it, do not recompute.
- The existing "with every optional item" hint at `:2710` is now redundant with All-in. Fold it in, do not leave two competing numbers on screen.

**B6. The GP warning (decision 8).** If the required-only GP% falls below `optional_lines_gp_warn_pct`, show an amber notice: "If they take only the required lines, this job runs at 36% GP, below your 40% floor. Consider pricing the required lines to stand on their own." Never blocking, no typed reason required. This is the honest surfacing of decision 5's tradeoff and it is the main defense against silent margin leak.

**B7. Save.** `offline/estimates.ts` writes `is_optional` and `preselected` on the area row and mirrors `is_optional` / `selected_by_customer` onto that area's line item row (the line item write at `:320-340` already carries both fields; today they are always false/true from the hardcodes). Keep the existing write order (areas, then materials, then line items) so the foreign keys hold.

**B8. Reload.** `estimateLoad.ts:130` must add `is_optional,preselected` to the `estimate_areas` select and hydrate the two toggles. Do not try to hydrate them from line items by `estimate_area_id`: that select does not fetch area ids and the join would be by position, which is exactly the kind of fragile mapping this column exists to avoid.

**B9. Do NOT change the AI inputs key.** `is_optional` does not change a line's price basis, so it must not enter `pricing_snapshot.inputs_key`. Adding it would bust the per-line AI cache for every existing estimate for no gain. The roll-up prose may mention that a line is optional; the key may not.

## Part C: stored price semantics (decision 7)

- `estimates.price` = sum of REQUIRED lines only. This is the forecast-safe floor, and it is what the pipeline, metrics, and win-rate reporting count before acceptance.
- `estimates.price_all_options` = sum of ALL lines, required plus every optional line at full value, regardless of pre-selection. The ceiling.
- **The customer-facing opening total is neither of these.** It is required + pre-selected optional, computed live from `estimate_line_items` on the public page, which is already how that page works. Do not add a third stored column for it. The "your estimate is ready" email (`index.html:29079`) currently prints `est.price`; change it to compute the same required + pre-selected sum from the line items at send time, so the number in the email matches the number on the page the link opens. A mismatch there reads as a bait-and-switch to a customer.
- **On accept, `price` becomes the signed total.** That is already the behavior (`handleAccept` PATCHes `price: total`) and it is correct: once signed, the floor and the actual are the same number. Leave `price_all_options` untouched at accept so you keep what was offered.
- Pipeline card and estimate list: when `price_all_options > price`, render `$8,200 (up to $12,400)`. When they are equal (every pre-72 estimate, and any estimate with no optional lines), render exactly what renders today. No new visual noise on estimates that have no options.

## Part D: the public estimate page

`netlify/functions/pec-public-estimate.cjs`.

**D1. Two groups, not one.** Today optional lines are pulled out of the main table into an "options" card block (`optionalCardsHtml`), which is right for opt-in add-ons and wrong for a pre-selected area line the customer should read as part of their job. Render:
- **"Your project"**: required lines, plus pre-selected optional lines, each of the latter with a ticked checkbox and a small "Optional" tag. Unticking removes it from the total live (the existing `opt-toggle` handler already does this).
- **"Options to add"**: optional lines that start unselected (add-ons, and any area line the rep set to start unselected). Unchanged from today.
- If a group is empty, do not render its heading.

**D2. Required lines have no checkbox.** Not a disabled checkbox: no control at all. A disabled checkbox invites a support call.

**D3. The signature copy** at `:331` already says "including any optional items you ticked". With opt-out lines that is now incomplete. Change to "for the total shown above, which reflects the items you have selected". No em dashes (standing rule 6).

**D4. Accept guard (decision 4).** In `handleAccept`, after `freezeLineItems`, if the computed total is 0 or no line survives selection, return `400 { ok:false, error:'Please select at least one item before signing.' }` and do not flip status. The rep gate makes this unreachable through the UI; this is the defense against a crafted POST, and it prevents a $0 accepted estimate from creating a real job.

**D5. Declined lines are recorded, not deleted.** `applySelection` already writes `selected_by_customer` per row. After accept, a line with `is_optional = true AND selected_by_customer = false` IS the declined record (decision 9). No new column. The signature jsonb already stores `selected_optional_ids`, which is the audit trail of what was ticked at signature time.

## Part E: what flows into the job (decisions 5, 9, 10)

All in `ensureJobCreated`.

**E1. Filter the areas.** `included` (the selected line items) is already computed. Build the set of area ids that are on a DECLINED line (`is_optional && !selected_by_customer`, mapped through `estimate_area_id`) and filter `areas` before the `job_areas` write at `:963` and before the `prodAreas` filter at `:1024`. Guardrail: an area with NO line item at all must be KEPT, not dropped. A missing line item is a data bug, and silently deleting a bay from a signed job is a much worse failure than carrying an extra one.

**E2. This is the re-cost (decision 5).** `pec_prod_areas` is the recipe side that drives the material plan, the ordering, and the costing rollup. Filtering it to the selected areas is what makes the material estimate honest for what was actually sold, with no third copy of the calculator and no change to any price. Say this plainly in the log entry, because "we re-cost at accept" is easy to misread as "the price changes".

**E3. Verify, then decide, on estimate-level GP.** `estimates.gp_dollars` / `gp_pct` / `materials_cost` were computed over ALL lines. After a partial accept they are optimistic. Before writing any code for this: grep for what actually READS those columns after `status='accepted'`. If the answer is "nothing, post-accept GP reporting reads the job and the costing rollup", then leave them as signed and note that in the log. If something does read them, recompute in the browser layer (the dashboard already has the calculator inlined) and persist once, rather than requiring `production/calculator.js` from a `.cjs` function. That file is ESM (`export function ...`), no Netlify function requires it today, and adding a third copy of the calculator would violate the two-copies-only rule in its own header comment. Do not create `production/calculator.cjs`.

**E4. Scope text (decision 10).** `estimates.scope_of_work` is NEVER rewritten after signature. On the job side:
- `job_areas.description` already carries the per-line scope from that line's line item, and E1 already filtered declined areas out, so the crew-facing per-area scope is correct with no extra work.
- `pec_prod_jobs.notes` starts with the FULL `est.scope_of_work` document (`:998`), which would carry a declined bay's paragraphs onto the crew's note. Change: when nothing was declined, behavior is byte-for-byte unchanged (full document, as today). When something WAS declined, compose the note from the selected lines' descriptions instead of the full document, and append one line: `Declined by customer: Patio (Quartz), $3,400`. The crew should know what was offered and not sold so nobody coats a patio out of muscle memory.

## Part F: dashboard surfaces

**F1. Estimate detail page** (`index.html:28124`). Every line renders its state: an "Optional" tag before acceptance; after acceptance, declined lines render struck through with a "Declined" tag and are excluded from the total (`estLineOptional` / the total helper at `:27566-27575` already handle the exclusion). Show both numbers in the header while the estimate is open: `$8,200 required, up to $12,400`.

**F2. Job detail: "Declined options" card.** On a job created from an estimate with declined lines, render a card listing each declined line (label, scope, quoted price, date quoted) with an **Add to job** button.

**F3. One-click add-back (decision 12).** The button opens the existing `openChangeOrderModal` (`index.html:10500`) in AREA mode, prefilled from the declined `estimate_areas` row: name (or `custom_label`), sqft, system type, flake/basecoat/topcoat products and cure speeds, and the ORIGINAL quoted price in the price field. Show a note under the price: `Quoted 2026-08-05 at $3,400.` The rep can edit before saving. The material cost recomputes at current catalog cost through the normal change-order path, which is where "honor the price, re-cost the materials" lands for an add-back too. The saved row is a normal `job_areas` change-order row (`is_change_order = true`), so scheduling, costing, and the change-order signature flow need no changes.

**F4. Customer card.** One line under the estimate history: `Declined on EST-102061: Patio (Quartz), $3,400.` Logged, nothing fires (decision 11).

**F5. Sweep every other surface that renders estimate lines.** Use `features.json`, not grep: the estimator's own preview, the presentation view (prompt 64), any PDF or print path, the What's-New-facing help text. Each must show optional state; none may silently show a declined line as sold.

## Part G: scope writing

The scope writer already labels an optional add-on's section `## Label (optional)` (`EstimatorScreen.tsx:601`). Extend the same convention to optional area and custom lines, so the signed document says which parts were optional. Do not invent a second phrasing.

## Tests

New `production/optional-lines.test.js`, added to `npm test` (baseline 783 checks after prompt 70, expect no regressions):

1. Required-only total, all-in total, and the live selected total are three distinct numbers on a mixed estimate, and each is the exact sum of its own lines.
2. An estimate with every line optional fails the send gate; with one required line it passes.
3. Pre-selected optional line: included in the opening total, excluded after untick, `price` (required-only) unchanged by either.
4. Accept with a declined area: the signed total equals the sum of ticked lines to the cent; `price` is patched to it; `price_all_options` is untouched.
5. `ensureJobCreated` area filtering: declined area absent from `job_areas` and `pec_prod_areas`; an area with no line item is KEPT.
6. Kit-merge behavior under a declined line: the material plan built from the selected areas alone buys the full kit (this is the decision-5 proof, and it should be a named test so nobody "optimizes" it back into a shared kit).
7. Accept with zero selected lines returns 400 and does not flip status.
8. Pre-72 shaped rows (`is_optional=false` everywhere) produce byte-identical totals, job rows, and prod-job notes to the current behavior.
9. `optional_lines_enabled='false'` blocks creating a new optional line and does NOT hide an existing one.

## Live verification (do this, do not assume)

Build a real estimate on `prescottepoxy.netlify.app` with three lines: a required garage, a pre-selected optional patio, and an unselected optional add-on. Then:

1. Estimator shows all-in, required-only, per-line GP, and the amber GP notice if required-only lands under the floor.
2. Send it. The email number matches the number on the public page when the link opens.
3. Public page: garage has no checkbox, patio is ticked under "Your project", add-on is unticked under "Options to add". Untick the patio and confirm the total drops by exactly the patio's price.
4. Sign with the patio unticked. Re-query: `estimates.price` = signed total, `price_all_options` = full offer, the patio's line item has `selected_by_customer = false`, and the signature jsonb lists the ticked ids.
5. Re-query the job: `job_areas` and `pec_prod_areas` contain the garage and NOT the patio. `pec_prod_jobs.notes` has no patio scope and carries the "Declined by customer" line.
6. Job detail shows the Declined options card. Click Add to job, confirm the modal prefills the patio at $3,400 with the quoted-on note, save, and confirm a `job_areas` change-order row lands.
7. Delete every row the test created and re-query to zero, against a baseline count captured before you start (the 2026-08-04 BusyBusy entry is the template for this).

Note that accepting a real estimate fires office notifications and, if the BusyBusy gate is on, creates a BusyBusy project. Check `busybusy_autocreate_enabled` before you accept, and archive the test project afterward with the native `archive_project` action (the custom `busybusy_archive_project_by_number` code action is broken, per the 2026-08-04 entry).

## Standing rules for this build

- One What's New entry (rule 11), plain language, no em dashes: optional items on any line, customer ticks what they want, you keep a record of what they passed on.
- Settings surface per rule 12, already specified in Part A.
- `@artifacts` header on the migration per rule 13.
- Update `features.json` for the estimator, public estimate page, estimate detail, and change-order entries.
- Regenerate `SCHEMA.md` after the migration.
- Commit per rule 1, PROJECT-LOG entry per rule 2.

## Explicitly out of scope

- Any automation on a declined line (drip, follow-up queue, lead event). Decision 11. If Dylan wants the patio called on later, that is a follow-up prompt and it should reuse the existing follow-up queue rather than a new mechanism.
- Changing how prices are SOLVED. Decision 5 is explicit: prices do not move, material estimates do.
- Good/better/best packages or mutually exclusive option groups (pick one of three). Optional lines here are independent yes/no choices. Grouping is a bigger model change and Dylan did not ask for it.
- Re-pricing a declined line at today's catalog price on add-back. Decision 12 honors the original quote.
- Any change to `pricing_snapshot.inputs_key`. See B9.
