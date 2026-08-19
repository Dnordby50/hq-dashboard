# Claude Code prompt 99: Ordering usability (truthful rows, hand-added lines, order-on-first-touch)

## Context

Dylan reported on 2026-08-19 that "for Robert Brass, the budgeted materials are not showing up on the ordering side" and that Ordering "is not really usable right now, I still have to do it manually."

Cowork audited this before scoping. **The calculator is not broken.** Robert Brass (`pec_prod_jobs.id = 8942ab57-5edf-4847-9d08-29a6b727ca26`, `MANUAL-20260810-145214-U48H`, CRM job `ba85c379-f036-4588-8064-e5c3ae28c6d3`) resolves correctly through `resolveCrmForProdJob` (explicit `crm_job_id`), his CRM card has one 655 sqft Standard Flake area with all three `job_area_materials` picks intact, and ticking his checkbox on the LIVE Ordering page produces `Simiron · 3 lines · $947` (Deck Gray x2, Nightfall Flake x3, Polyaspartic Slow x3), byte-for-byte the Budget card on his job page. The same three lines were reproduced offline by running `production/calculator.js` (`crmPlanAreas` -> `inheritCureSpeeds` -> `computeMaterialPlan`) against his real rows. The live bundle at `prescottepoxy.netlify.app` is current (2,848,962 bytes, identical to `main` at 1515f4a), so this is not a stale-deploy issue.

What is actually wrong is everything around the math. Live census of all 56 open jobs on the Ordering page, taken 2026-08-19:

| Material chip | Count |
|---|---|
| saved lines | 29 |
| calculated, not saved | 14 |
| "calculator produced no lines (check area sqft...)" | 12 |
| "no areas" | 12 |
| "colors not confirmed yet on the CRM job card" | 1 |

Four concrete defects behind those numbers:

1. **The row lies about itself.** `sysSummary` and `sumSqft` (index.html ~42473-42484) read `job.areas`, which is `pec_prod_areas` (the schedule-modal stub, empty for every manual and CRM-bridged job), while the MATERIAL chip beside them reads the CRM job card through `calcAreasInputFor`. 24 of 56 rows therefore show SYSTEM `—` and SQFT `0` next to a working material chip. Robert Brass is one of them. That is what Dylan read as "no materials".
2. **The selection step is invisible.** The order sheet is selection-driven and starts empty. Dylan confirmed he did not know he had to tick the checkbox. The empty state currently reads "Nothing selected yet." in small muted type below a long table.
3. **12 jobs can never produce a line, and the message blames the wrong thing.** 9 of the 12 are `Custom System`, whose recipe is a single `slot_kind='text'` slot with no product. 2 are `Concrete Polishing` (4 slots, all `required=false`, all `default_product_id` NULL). `Polydeck System` has 0 slots and is active. Chris Hill (870 sqft) and Michael Scigliano (1,057 sqft) are both told "check area sqft on the CRM job card" when their sqft is fine and the recipe is the problem. There is no escape hatch: `+ Add line` only renders when `(j.lines || []).length` is truthy (index.html:42588) and "Save lines to job" only renders for `kind === 'calculated'` (index.html:42628), so a Custom System job is a permanent dead end. **This is the direct cause of "I still have to do it manually."**
4. **11 of the 12 "no areas" rows are touch-up callbacks** (`is_callback = true`, proposal numbers 9000002-9000012). `resolveCrmForProdJob` refuses to bridge callbacks by design, so "no areas" is correct but useless: they can never be ordered for and they clutter the list.

Dylan answered 12 scoping questions. Every task below is a locked decision from those answers. Do not re-litigate them.

Repo: `/Users/dylannordby/Claude-Code/HQ-Dashboard`, branch `main`, base commit `1515f4a`. Deploy: `https://prescottepoxy.netlify.app`. Supabase project `zdfpzmmrgotynrwkeakd`.

---

## Tasks

Take them in order. Task E depends on D's shared insert path existing.

### A. The list columns read the same source as the material chip

**What.** SYSTEM and SQFT in the Jobs-to-order table must be derived from whichever area source `calcAreasInputFor(job, slotsBySystem)` actually chose for that job, not unconditionally from `job.areas`.

**Where.** `renderJobs` in index.html, `sysSummary` (~42473) and `sumSqft` (~42484), consumed in `jobRowsHtml` (~42506).

**How.** `makePullCalcLines()` already memoizes per job and already runs `calcAreasInputFor`. Extend the memoized result to carry the resolved `areas` array and a `fromCrm` flag (it already returns `fromCrm`), then have `sysSummary` / `sumSqft` read `computeLinesFor(job).areas` when present and fall back to `job.areas` otherwise. Do not add a second fetch and do not add a second resolution ladder; there is exactly one, and prompt 91 made it `resolveCrmForProdJob`.

**Acceptance.** Robert Brass's row shows `Standard Flake` and `655`, not `—` and `0`. Chris Hill shows `Custom System` and `870`. The count of rows showing both `—` and `0` drops from 24 to only those jobs that genuinely have no areas anywhere. The jobs TABLE lower on the page (`tableJobs`, the unrelated status-filtered list) is out of scope; leave it alone.

**Do not touch.** `computeMaterialPlan`, `crmPlanAreas`, `inheritCureSpeeds`, or anything in `production/calculator.js` numeric behavior.

### B. Touch-up callbacks leave the Jobs-to-order list

**What.** Rows with `is_callback = true` never appear in the Jobs-to-order list or its Select-all.

**Where.** `renderJobs`, the `openJobs` filter (~42460) and `shownJobs`.

**How.** Add `&& !j.is_callback` to the open-jobs filter. Prune any already-selected callback id in the same stale-selection sweep at ~42455 so a leftover selection cannot smuggle one into the order sheet.

**Acceptance.** The 11 rows with proposal numbers 9000002 through 9000012 disappear from Jobs-to-order. The header count changes from "56 of 56 open jobs shown" to 45. The Job Schedule calendar, the Touch-ups panel, and the by-customer putaway cards are unaffected.

**Guardrail.** Do NOT filter callbacks anywhere else. `pec_prod_jobs` callbacks are load-bearing for the touch-up queue and for Job Costing's callback rollup (prompt 51).

### C. Honest skip reasons, classified as a pure function

**What.** Replace the single catch-all "calculator produced no lines (check area sqft...)" with a classifier that names the real cause.

**Where.** New exported function in `production/calculator.js` with the usual byte-identical mirror in index.html (same convention as `crmPlanAreas`), called from `resolveJobLines` (index.html ~42977) and from `recalcActiveJob`'s result message (~44288).

**Signature.**

```js
export function classifyNoLines({ areas, fromCrm, recipeSlotsBySystemType, systemTypesById })
// -> { code, message }
```

Codes and messages, in priority order:

- `no_areas` — no areas on either source. "no areas on the job card yet"
- `all_change_orders` — keep the existing prompt 75 C1 message verbatim.
- `no_recipe` — every area's `system_type_id` resolves to a system whose recipe slots contain zero `slot_kind='product'` entries. Message: `"<System name> has no material recipe, add lines by hand"`. When areas span several such systems, name them comma-separated.
- `zero_sqft` — recipe exists but every area's sqft is 0 or null. "every area has 0 sqft, enter the real sqft on the job card"
- `unknown` — fall back to today's text.

`no_recipe` must be checked BEFORE `zero_sqft`, because Brian Hixson and Rob Rudman are both (Custom System AND 0 sqft) and the recipe is the blocking cause: filling in their sqft would change nothing.

**Acceptance.** Chris Hill and Michael Scigliano read "Custom System has no material recipe, add lines by hand" instead of a sqft complaint. Scott Gordon (Concrete Polishing + Custom System, 2850 and 0 sqft) names both systems. Add unit tests to `production/calculator.test.js` covering all five codes plus the multi-system case and the no_recipe-beats-zero_sqft precedence.

**Data note, verified live, do not re-query:** slot counts by system are Polydeck System 0, Custom System 1 (text, no product), MVB Only 1, Grind and Seal Clear 3, Standard Flake 3, Concrete Polishing 4 (all optional, all `default_product_id` NULL), Metallic 4, Quartz 5. Concrete Polishing has 4 product-kind slots but no defaults, so it hits `no_recipe` only if you define the check as "zero product slots". Define it instead as **"zero product slots that can yield a product"**: a slot yields nothing when `slot_kind !== 'product'`, or when it has no `default_product_id` AND no pick for it on any area. That correctly catches Concrete Polishing.

### D. Hand-added material lines, always available

**What.** Any job in the Jobs-to-order list can have material lines added by hand, including a job with zero saved AND zero calculated lines. Available from two places, one shared modal.

**Where.**
- Ordering page: the `addChipsHtml` selection chips (index.html:42588) and a new inline "Add lines by hand" button on the skipped row itself.
- Production job detail: `renderDetailLines` (index.html ~44164), whose empty state currently reads "No lines. Click Recalculate to generate from the catalog." Add an "+ Add line" button beside Recalculate.

**How.** `openProdAddLineModal(jobId)` (index.html:43345) already exists and already inserts a `manual_added: true` row. The only real work is removing the `(j.lines || []).length ?` gate at 42588 so the button always renders, wiring the two new entry points to the same function, and making sure a job whose only lines are hand-added flows through `resolveJobLines` as `kind: 'saved'` (it will, since `job.lines` becomes non-empty).

**Acceptance.** Select Michael Scigliano (Custom System, currently a dead end). The row shows the `no_recipe` reason and an "Add lines by hand" button. Clicking it opens the existing add-line modal. After adding one line, his chip flips to "saved · 0/1 ordered", he appears in the order sheet grouped under his supplier, and the qty and ordered controls work. Same flow reachable from his production job detail.

**Guardrail.** Hand-added lines carry `manual_added = true` and must keep surviving Recalculate, per `mergeRecalcLines`. Do not change that merge.

### E. Ordering a calculated line persists it on first touch

**What.** Today a calculated job's rows in the order sheet render as read-only text ("calculated; save lines to edit"). Make the first order action on such a row persist that job's calculated lines, then apply the action.

**Where.** `breakdownHtml` inside `renderJobs` (~42548), `handleOrderQtyEdit` (~43286), `handleOrderLineToggle` (~43255), and `saveCalculatedLines` (~43226).

**How.** Render the qty input and the "ordered" checkbox for calculated rows too, keyed by `data-oq-job` / `data-ord-job` plus the SKU key (`${product_id}|${cure_speed}`) instead of `data-oq-line` / `data-line-id`. On the first such event: call `saveCalculatedLines(jobId)`, await it, then locate the freshly inserted row by that same SKU key and apply the edit through the existing saved-line path. Guard against double-fire with the existing `state._savingLines` set. If the save fails, revert the control and toast, exactly as the current handlers do.

**Acceptance.** With Robert Brass selected, typing `4` into his Deck Gray qty writes three rows to `pec_prod_material_lines` for job `8942ab57-...` and sets `order_qty = 4`, `order_qty_manual = true` on the Deck Gray row. His chip flips from "CALCULATED, NOT SAVED" to "saved · 0/3 ordered". Ticking "ordered" on a calculated row does the same and then sets `ordered = true`.

**Guardrail, non-negotiable.** The `flake_not_chosen` sentinel is display-only and must NEVER be persisted (prompt 75 C3). `saveCalculatedLines` already filters it; do not route around that filter. A sentinel row must not render an editable qty input at all.

### F. One colors-confirmed rule for every source

**What.** `isGated` (index.html:42503) currently requires `j.dripjobs_deal_id`, so a manual or estimate-sourced job with unconfirmed colors shows the warning chip but stays selectable. Brad Dalling (`EST-102163`) is in that state right now. Drop the deal-id condition in both `isGated` and the matching guard in `resolveJobLines` (~42990).

**Acceptance.** Brad Dalling's checkbox is disabled with the existing "Colors not confirmed on the CRM job card" title. Any job with `state.crmColorsConfirmedByProdJob[j.id] === false` and no saved lines is gated regardless of source. Saved lines still win over the gate (unchanged rule). A MISSING entry still never gates, so the fail-open behavior when the CRM fetch degrades is preserved. Verify that last point explicitly, it is the one that silently breaks the whole page if you get it wrong.

### G. The selection step becomes obvious

**What.** Dylan did not know the order sheet needed a selection. Make it unmissable.

**Where.** The order sheet header and `sheetBodyHtml` empty state (~42565).

**How.** When `state.orderSelected.size === 0`, replace the small muted "Nothing selected yet." with a real empty state inside the order sheet card: a one-line instruction ("Tick the jobs above to build an order.") plus the existing Select-all-shown button repeated there. Keep the selection manual; Dylan explicitly declined auto-select and declined persisting the selection across reloads.

**Acceptance.** Loading the Ordering page with nothing selected shows the instruction and a working Select all inside the order sheet card. Selecting one job replaces it with the supplier groups.

---

## Out of scope, do not do these

- Do not fill in recipes for Concrete Polishing or Polydeck System. Dylan chose hand-add now, catalog later. Log the two gaps as a follow-up in the PROJECT-LOG entry instead.
- Do not change any pricing, GP, or quantity math. No edits to `computeMaterialPlan`, `computeJobEstimate`, `computeCostingRow`, or `production/costing.js`.
- Do not touch the estimator PWA (`apps/estimator/` or the built `estimator/`).
- Do not touch the by-customer putaway cards' date filter or the Pull Material modal's date semantics.
- No migration. Every task here is client-side plus the existing tables. If you think you need a schema change, stop and say why before writing it.

## Standing rules that apply

- Rule 9: update the `Material ordering` entry in `features.json` (new anchors: the classifier, the new entry points).
- Rule 11: append a What's New entry to `help/whats-new.json`. User-facing, plain language, no em dashes. Cover: rows now show the real system and sqft, touch-ups no longer clutter the list, jobs with no recipe say so and can take hand-added lines, and editing a qty now saves the lines for you.
- Rule 1 and 2: commit per task or per coherent group, append the PROJECT-LOG entry at the TOP.
- Token discipline: navigate index.html via the anchors named above plus grep. Do not read it end to end.
- `npm test` must be green, `node --check` clean on any touched `.cjs`, and every inline `<script>` block in index.html must still parse.

## Report back

In the PROJECT-LOG entry, state the before and after counts for: rows showing `—`/`0`, rows in the Jobs-to-order list, and rows in each material-chip bucket. Dylan's measure of success is that the 12 dead jobs become orderable, so name which of them you verified end to end.
