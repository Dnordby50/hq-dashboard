# Claude Code Prompt 69: per-line pricing, custom lines inside a normal estimate, per-line GP, per-line notes and scope

Read CLAUDE.md and the last 3 entries of PROJECT-LOG.md before you touch anything. Standing rules 1, 2, 9, 10, 11, 12 and 13 all apply to this build.

This prompt is **Part 1 of 2**. Prompt 70 rebuilds the comps engine and the AI price recommendation on top of what you build here. Do NOT build the AI half in this session (see "Explicitly out of scope" at the bottom), but do leave the seams it needs.

---

## Why this exists

Dylan is quoting jobs that do not fit the current shape of an estimate. Two things break:

1. **A real estimate is often mixed.** A quartz system in the garage, plus a one-off custom scope (a stair install, a shop-built curb, a repair) on the same proposal. Today `is_custom` is a WHOLE-ESTIMATE mode (`estimates.is_custom` / `custom_price` / `custom_scope`, EstimatorScreen.tsx:366-372 and 1412-1425): custom mode replaces the calculator entirely and emits ONE line labeled "Custom scope of work". There is no way to mix. Dylan has to either build the quartz estimate and hand-write the custom part into the scope with no price attached to it, or throw the calculator away for the whole job.

2. **Nothing is priced per line.** The calculator solves ONE price for the whole area set using a **sqft-weighted average** labor% and target GP% across the areas' systems (`computeEstimatePricing`, production/calculator.js:277-420, the 2026-07-13 multi-system change). The estimator then back-allocates that single number onto the area lines proportionally (`allocateProportionally`, EstimatorScreen.tsx:1440-1450). The rep sees one price and one GP number. He cannot price the garage separately from the patio, cannot see that one line is underwater, and cannot discount one line without moving all of them.

The weighted-divisor approach is also mathematically weaker than it looks: on a mixed estimate, no individual system hits its own target GP. Only the blended average does. A high-margin system subsidizes a low-margin one silently.

---

## Locked decisions (Dylan, 2026-08-04). Do not relitigate these.

1. **A custom line is a custom AREA row**, not a bare line item and not a new system type. New `estimate_areas` columns carry it. It reuses the existing area to line-item pipeline, the scope writer, and the public page.
2. **Each line solves its own price. The job total is the sum.** Proportional back-allocation of a single job price goes away for the calc price.
3. **The discount / sell override stays job-level** and allocates across the lines proportionally. `estimates.price_override_reason` stays the audit trail.
4. **GP is shown per line AND combined.** Per-line pricing without per-line GP lets a rep discount a line into the negative and never see it.
5. **A custom line takes a typed material cost and typed labor hours**, so its GP is computed the same way every other line is and its hours are real for scheduling. Not a single blended cost number, not price-only.
6. **A custom line pulls no products from the catalog** in this build. Typed cost only. It contributes nothing to the material plan.
7. **On accept, a custom line becomes a real `job_areas` row** carrying its scope text and price, so the crew sees it on the work order.
8. **Per-line notes are a new field on each area and custom line**, internal only, and they feed that line's scope generation.
9. **Scope generation stays ONE action** (the existing Generate, with its never-overwrite rule) that writes every line's description. No per-line generate buttons, no auto-regeneration on keystroke.
10. **Forward-only migration.** New columns are nullable. Existing estimates keep their stored line amounts and must render exactly as they do today. **No backfill.** (Prompt 56's lesson: a derived-beats-stored rule silently moved GP on 34 finalized jobs by $4,785. Do not repeat it.)

---

## Current state, with anchors, so you do not have to hunt

- `production/calculator.js`
  - `computeJobEstimate` (~line 160): builds the material plan. **Materials merge ACROSS areas** (`mergeAcrossAreas`, ~line 849): the same product used in two areas becomes ONE summed, kit-rounded line. This is the ordering truth and it is why naive per-area solves do not sum correctly (see Part B).
  - `computeEstimatePricing` (~line 277): the sqft-weighted single-divisor solve described above.
  - `applySellPrice` (~line 445): recomputes buckets at an overridden sell price.
  - `allocateProportionally` (~line 522): parts always sum exactly to the total. Keep using it.
  - `roundEstimatePrice`: increment rounding, rounds UP so rounding never drops realized GP below target.
- `apps/estimator/src/features/estimator/EstimatorScreen.tsx` (2484 lines)
  - areas state and `engineAreas` / `pricedAreas` (~1359).
  - sell price / discount block (~637-780): `basePrice`, `sellInput`, `discInput`, `priceOverride`, `finalSell`, `overrideReason`, `belowFloor` (~757).
  - custom mode state (~366-372) and its save branch (~1412-1425).
  - line item build (~1405-1470), including the `soloByArea` per-area solve that today is used ONLY as allocation weights, never as money.
  - `crewNotes` generation (~1277-1317), `generateScope` and the scope panel.
- `netlify/functions/pec-estimate-scope.cjs`: already writes `estimate_line_items.description` per line and assembles `estimates.scope_of_work`. Never-overwrite rule enforced server-side (`scope_edited_at`).
- `netlify/functions/pec-estimate-custom-polish.cjs`: polish for typed custom scope. Reuse it for custom lines.
- `netlify/functions/pec-public-estimate.cjs`: renders per-line price and description already (`liDescHtml` ~205, line load ~592-615); `job_areas` insert at ~958-970 (note: it does NOT currently set `price` or `description`).
- `apps/estimator/src/lib/estimateLoad.ts`: the edit round-trip. Line 147 filters the `CUSTOM_LINE_LABEL` line back out when reopening a whole-estimate custom job. That filter must keep working for legacy custom estimates and must NOT eat the new custom lines.
- `index.html` estimate detail view: `estimate_line_items` read at ~27972, per-row edit/add/delete at ~28518-28570.
- SCHEMA.md is the column reference. Verify every column you use against it. Regenerate it after the migration.

---

## Part A: migration

One migration file, `supabase/migrations/2026-08-XX_prompt69_per_line_pricing.sql`, with the `@artifacts` header (standing rule 13) declaring every column it creates.

Add to `public.estimate_areas`:

| column | type | purpose |
|---|---|---|
| `is_custom` | boolean not null default false | this area is a typed custom line, no recipe |
| `custom_label` | text | the line label the customer sees (e.g. "Stair install") |
| `custom_scope` | text | the typed scope for this line |
| `custom_material_cost` | numeric | typed estimated material cost |
| `custom_labor_hours` | numeric | typed estimated crew hours |
| `notes` | text | INTERNAL per-line notes, fed to scope generation, never customer facing |
| `calc_price` | numeric | this line's solved cost-plus price (null on custom lines) |
| `price_override` | numeric | rep-typed price for this line (null = use `calc_price`; on a custom line this is where the typed price lives) |

Also: `estimate_line_items.unit_cost` exists and is currently written as 0 for area lines. Start writing the **real** per-line cost into it (materials + labor + commission + sundries attributed to that line). Nothing downstream should break, but grep for readers of `unit_cost` before you assume that.

No changes to `estimates`. The job-level discount keeps using `price`, `calc_price`, `price_override_reason`, `price_overridden_by`, `price_overridden_at`.

Apply via the Supabase MCP, verify by re-query, regenerate SCHEMA.md.

---

## Part B: the calculator, per-line solve

This is the part where you can quietly break every price in the system. Read it twice.

### The trap

The obvious implementation, "call `computeEstimatePricing` once per area and sum", is **wrong**, and the existing `soloByArea` code proves the authors knew it: it is used only for allocation weights, never for money. The reason is `mergeAcrossAreas`. Materials are kit-rounded ACROSS the whole estimate: two areas each needing 0.6 of a kit of the same basecoat consume ONE kit total, not two. Solve each area alone and you buy two kits, and the estimate total inflates.

### The specified approach

1. **Keep ONE estimate-wide material plan.** `computeJobEstimate` at revenue 0 for the full area set, exactly as today. The merged, kit-rounded plan stays the ordering truth and its total is `M`.
2. **Attribute `M` to areas.** Compute each area's PRE-merge raw material cost (its own recipe at its own sqft, unrounded), then `allocateProportionally(M, rawCostByArea)` so the parts sum to `M` **exactly**. Kit-rounding overhead lands on the areas in proportion to what they actually consume.
3. **Solve each area at its own system's rates.** For area `a`:
   - `laborFrac_a` = that area's system `labor_budget_pct` / 100
   - `gpFrac_a` = that area's system `target_gp_pct` (falling back to the global target) / 100
   - `commFrac` = the standard house commission, unchanged and estimate-wide
   - `s` = sundries pct, unchanged
   - `divisor_a = 1 - (laborFrac_a + commFrac)(1 + s) - gpFrac_a`; if `divisor_a <= 0` return the existing `TARGET_UNREACHABLE` error **naming the area**, never divide.
   - `priceRaw_a = (M_a + F_a)(1 + s) / divisor_a`, then `roundEstimatePrice` per line with the existing increment and rounding-up rule.
4. **Fixed add-ons (`F`).** Check how the estimator feeds `fixedAddons` today before you move it. If it is non-zero, allocate it across areas the same proportional way; do not silently drop it. If add-ons are already their own line items, keep them their own line items and leave `F` at 0 per area. State which is true in the log entry.
5. **Job calc total = sum of the area line prices + the add-on line prices.** No second job-level solve, no back-allocation of the calc price.
6. **Custom lines are outside the solve.** Their price is typed. Their cost is `custom_material_cost + custom_labor_hours * laborRate`, plus commission and sundries at the typed price, so the GP formula is the same shape as every other line.

### The invariant you must prove in tests

For a **single-area** estimate, the new per-area solve must produce a price **identical** to today's `computeEstimatePricing`. Same inputs, same number, to the cent. If it does not, your material attribution or your divisor is wrong. Add this as an explicit test over several real single-area fixtures.

For a **multi-area** estimate the total WILL change, because each system now hits its own target GP instead of a blended one. That is the intended correction, not a bug. **Before you commit any behavior change**, run the new math over every existing estimate and report, in the log entry, the old total, the new total, and the delta for each. If any estimate is already `sent` or `accepted`, its stored numbers stay untouched (decision 10); you are only reporting what would have changed.

Keep `CALC_VERSION` honest: bump it, since the pricing math changed.

---

## Part C: the estimator, per-line pricing UI

- Each area row gains: its solved price, an editable price field (writes `price_override`), its own GP$ and GP%, and a red state when that line is under `config.floorGpPct`.
- **"+ Add custom line"** next to the existing add-area control. A custom line row has: label, scope textarea (with the existing Polish button, wired to `pec-estimate-custom-polish.cjs`, keeping its in-memory undo), typed price, typed material cost, typed labor hours, optional sqft, and the notes field from Part F.
- The job-level sell/discount block stays where it is, but it now operates on the **sum**. When the rep sets a job sell price or a discount percent, allocate the delta across the lines with `allocateProportionally` weighted by each line's current price, and show the resulting per-line numbers. Do not let allocation drift: the parts must sum to the typed total exactly.
- **The reason rule tightens, with a threshold.** Today a reason is required when the job price is discounted below the calculated price. Now require it whenever the FINAL total is below the CALCULATED total, no matter how the rep got there (a per-line edit, the job discount, or both). A rep must not be able to route around the audit trail by editing lines instead of using the discount box.

  To keep that from nagging on a rounding nudge, the reason is only demanded when the shortfall exceeds `max(line_pricing_reason_threshold_pct% of the calculated total, line_pricing_reason_threshold_dollars)`. Both are settings keys (Part D), defaulting to **2%** and **$100**, so a $40 trim on a $2,000 job passes silently and a $600 trim on a $20,000 job does not. The threshold applies to the shortfall on the WHOLE estimate, not per line, so three small line trims that add up past it still ask for a reason.
- The below-floor save confirmation must **name which lines** are below floor, not just report the combined percentage.
- The whole-estimate `is_custom` mode keeps working exactly as it does today. Do not fold it into the new custom line in this build; a legacy custom estimate must reopen and re-save byte-identically.
- Offline / draft round-trip: the new fields must survive the outbox and the draft autosave (`apps/estimator/src/offline/*`), and `estimateLoad.ts` must rehydrate them on edit. The `CUSTOM_LINE_LABEL` filter at estimateLoad.ts:147 must keep filtering the legacy whole-estimate custom line and must NOT filter the new custom-line rows.

---

## Part D: settings surface (standing rule 12)

Settings gains a **Line pricing** card backed by the `settings` table, server and client reading the same keys with IDENTICAL defaults:

- `line_pricing_gp_floor_pct` (default: the existing floor value, so behavior is unchanged on day one) — the per-line floor that turns a line red.
- `line_pricing_block_below_floor` (default false) — whether a below-floor LINE forces the confirmation dialog, or only warns.
- `line_pricing_custom_label_default` (default "Custom work") — the prefilled label on a new custom line.
- `line_pricing_reason_threshold_pct` (default 2) — how far under the calculated total the final total may land before a written reason is required.
- `line_pricing_reason_threshold_dollars` (default 100) — the dollar floor on that same threshold, so small jobs are not held to a percentage that amounts to pocket change. The effective threshold is the GREATER of the two.

A rep must not be able to raise these from the estimator. They live in Settings with the rest of the pricing knobs.

---

## Part E: per-line notes and scope

- The `notes` field is INTERNAL. It must never render on the public estimate page, the PDF, or the presentation view. Verify that, do not assume it.
- `pec-estimate-scope.cjs`: include each area's `notes` in that line's generation context, alongside the system's `scope_template` and the existing BLANK answers. The model's job stays **assembly and substitution, not authorship** (the exclusions and cure-time clauses are what protect Dylan in a dispute).
- **A custom line's typed scope is used VERBATIM** as that line's description. The scope writer must not rewrite it. Only the explicit Polish button touches custom text, and only when the rep presses it.
- The single Generate action, the never-overwrite rule (`scope_edited_at`), the `force` regenerate path, and the assembled `estimates.scope_of_work` document all stay as they are.

---

## Part F: accept path and downstream surfaces

- `pec-public-estimate.cjs` `job_areas` insert (~958): also write `price` (the line's final price) and `description` (the line's scope). For a custom line: `name` = `custom_label`, `system_type_id` null, `sqft` null or the typed sqft, `price` and `description` set. It must remain guarded by its own existence check so the heal path stays idempotent.
- Public estimate page: verify a MIXED estimate renders correctly (calculator lines and a custom line together, each with its price and its scope), including the optional-item selection math.
- `index.html` estimate detail (~27972, ~28518): verify the per-row display and the existing add/delete line editing do not regress on a mixed estimate.
- Presentation view (prompt 64) and the estimate PDF: verify both.
- Work order: the custom area should appear with its scope.

---

## Verification bar

Match the standard this repo has been holding. Nothing counts as verified because the code looks right.

1. `npm test` green, with the new checks added. Report the exact count and note the baseline it grew from (646 as of prompt 68).
2. The single-area identity invariant (Part B) proven over several real fixtures.
3. The full old-vs-new total report over every existing estimate (Part B), in the log entry, with the deltas.
4. Allocation exactness: a job-level discount on a 3-line mixed estimate, where the line prices sum to the typed total to the cent. Prove it with numbers, not assertion.
5. Browser verification against the live deploy, signed in, with **database re-queries** for every write: build a mixed estimate (two calculator areas on different systems plus one custom line), save it, reopen it and confirm every field rehydrates, generate scope and confirm each line got its own description with the notes reflected, send it, open the public page, accept it, and confirm the `job_areas` rows including the custom one.
6. Below-floor behavior: drive one line under the floor and confirm the line goes red, the confirmation names that line, and the reason is required.
7. Legacy regression: reopen an existing whole-estimate custom estimate and an existing multi-area estimate, save with no edits, and confirm their stored numbers do not move.
8. **Zero residue.** Delete every test row and re-query to prove it. Report the before/after table counts.

---

## Housekeeping (standing rules)

- Commit after each meaningful change, `<area>: <what changed>`.
- Append ONE PROJECT-LOG.md entry at the TOP, written for a human, including the old-vs-new price delta table and anything you had to deviate on and why.
- Update `features.json` for every feature whose code or tables changed.
- Regenerate SCHEMA.md after the migration.
- One `help/whats-new.json` entry: this is user-facing. Plain language, 2-3 how-to steps, **no em dashes**.
- No em dashes in any customer-facing text (line labels, scope, the public page, What's New).
- If something needs a third-party UI, a prod migration by hand, or a value only Dylan has, write a Cowork handoff in the log entry AND print the standalone prompt in chat. Code edits in this repo are not a Cowork handoff.

---

## Explicitly out of scope (this is prompt 70)

Do NOT change `netlify/functions/pec-estimate-ai.cjs` or `production/comps.js` beyond keeping them working. Prompt 70 will:

- Make the system type a **hard filter** in `buildComps`. Today the widen ladder drops the system filter when fewer than 3 same-system jobs exist (production/comps.js:126-160), which is the actual reason a suggestion reads as square-foot-only. A quartz price built from polyaspartic comps is worse than no comp at all.
- Move the AI from one job-level recommendation to **one call returning a recommendation per line**, plus a short job-level roll-up.
- Give each line a range, a why, and a **server-computed** confidence flag (comps-backed / thin sample / no comps), never model-claimed.
- Have custom lines reason from the typed scope with an explicit no-comparables statement.

Two seams to leave for it, at no cost now:

- `estimates.pricing_snapshot` is jsonb and estimate-level. Prompt 70 will key it by line id. Do not restructure it, but do not add anything that would make keying it by line awkward.
- The `inputs_key` cache discipline in pec-estimate-ai.cjs is what keeps reopening an estimate from re-billing. Whatever you change about how a line's inputs are represented, keep them cheaply hashable per line.
