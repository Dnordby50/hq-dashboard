# Claude Code Prompt 30: Clarify product cost basis (per-unit vs per-kit) in Settings

## Context

Owner (Dylan) reports that the product cost input in Settings is confusing because a product's cost can be read as either "price per kit" or "price per gallon," and there is no clear label saying which. That ambiguity risks inaccurate job costing (entering a per-gallon number into a field the system treats as per-kit under-costs a job by the kit size). This prompt makes the cost basis explicit and clearly labeled everywhere cost appears, without changing how job costing math actually works.

This was scoped by Cowork with Dylan through a full decision pass. The decisions below are locked. Do not re-litigate them; implement exactly what is written. Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first per standing rules, then do this task.

### What is true today (verified, for grounding)

- A product (`pec_prod_products`) stores `spread_rate` (sqft per single unit: gal/box/pack), `kit_size` (single units per kit), and `unit_cost` (cost per kit). The editor labels the cost field "Unit cost / kit" and the table header reads "Cost / Kit," and the toolbar note says "Cost is per kit." So `unit_cost` is ALREADY per-kit and is the value job costing consumes.
- Job costing multiplies a whole-kit quantity by the per-kit cost. In `production/calculator.js` a material group's `qty = ceil(sqft_total / spread_rate / kit_size)` (kits, rounded up) and `line_cost = qty * unit_cost_snapshot`. On the costing screen, used cost = `actual_used_qty * unit_cost_snapshot`. Both `qty_needed`/`order_qty` and `actual_used_qty` are in KITS, and `unit_cost_snapshot` is per-kit.
- `unitFor(material_type)` (index.html around line 26730) already returns the correct base-unit label per type: Flake/Quartz return `box`, Metallic Pigment and Tint Pack return `pack`, everything else returns `gal`.

## Locked decisions

1. Cost basis: keep BOTH a per-single-unit cost and a per-kit cost in the product editor, but make the basis unmistakable with clear labels. The per-kit value is the single source of truth for costing.
2. Editor UI: two cost fields, "Cost per {gal/box/pack}" and "Cost per kit." The user enters whichever number they have; the OTHER field auto-fills live using kit size (per-kit = per-unit x kit size; per-unit = per-kit / kit size). On save, only the per-kit value is persisted to `unit_cost`. The per-unit value is derived, not stored (no new column, no migration).
3. Costing philosophy stays exactly as today: cost by whole kits bought (rounded up) x per-kit cost. Do NOT change any costing or calculator math.
4. Actual Used field on the costing screen stays in KITS (fractional allowed). Just relabel it clearly as kits. Do not convert it to gallons.
5. Labels: show the unit clearly everywhere cost appears (product editor, product table, costing material-line table, and any other place a unit cost or per-kit cost is displayed).
6. Spread rate: relabel for consistent wording only. This is cosmetic. Do NOT change spread math.
7. All material types get the two-field treatment. For dry goods where kit size is 1, per-unit equals per-kit and the fields simply mirror each other. Use `unitFor` so the labels read gal/box/pack correctly per type.
8. History: leave past job cost snapshots frozen. Touch nothing in `pec_prod_material_lines` historical data and nothing in costing snapshots.
9. Keep the kit size field.
10. No database migration and no Cowork handoff. Because `unit_cost` is already per-kit and stays canonical, no stored cost value changes. This is an index.html-only change.

## Tasks

Take these in order. All edits are in `index.html` unless noted.

### 1. Product editor: two clearly-labeled cost fields with live auto-fill

Location: `openProductModal` (around index.html 26797 to 26975). Today the cost field is a single input "Unit cost / kit" (`pmCost`) sitting in the `pec-row-3` with Kit size (`pmKit`) and Active (around line 26851 to 26857).

- Replace the single cost input with two inputs:
  - Per-unit cost, id `pmCostUnit`, label "Cost per {unit}" where {unit} comes from `unitFor(current material_type).per` (gal/box/pack). Mark it as the convenience field in the sublabel, e.g. "the number you sometimes have off an invoice."
  - Per-kit cost, id `pmCost` (keep this id so the save path and validation keep working), label "Cost per kit" with a sublabel "what job costing uses."
- Live auto-fill behavior:
  - On input in `pmCostUnit`: set `pmCost` = perUnit x kitSize (read the CURRENT `pmKit` value). Round to 2 decimals for display.
  - On input in `pmCost`: set `pmCostUnit` = perKit / kitSize. Round to 2 decimals for display.
  - On input in `pmKit` (kit size): recompute so the two stay consistent. Anchor on whichever cost field the user last edited; if neither has been touched yet, recompute per-unit from the existing per-kit. Guard against kit size being blank or 0 (do not divide by 0; leave the other field as-is and let existing "Kit size must be > 0" validation catch it on save).
  - When material type changes (`pmType` change handler already exists around line 26882 for the basecoat field): update the per-unit label text to the new `unitFor(...).per`.
- Save path (around 26901 to 26914): `unit_cost` must be taken from `pmCost` (the per-kit field) exactly as today. Do not persist the per-unit value. If `pmCost` is blank, `unit_cost` stays null (cost is optional, keep that behavior). Keep the existing "Kit size must be > 0" and other validations.
- Keep everything else in the modal (basecoat field, image, notes, delete, duplicate handling) untouched.

### 2. Product table: label the unit and show per-unit as a muted reference

Location: `renderProducts` / `renderRow` (around 26736 to 26784) and the toolbar note (around 26760).

- The "Cost / Kit" column stays as the primary, canonical value. Beneath it (or beside it) show a muted derived per-unit value in the same visual style the Spread Rate and Kit Size cells already use for their muted unit suffix, e.g. `$165 / kit` on top and a muted `$55 / gal` under it. Derive per-unit as `unit_cost / kit_size` (guard divide-by-zero and null cost, render the existing em-dash-free "—" placeholder when cost is null).
- Update the toolbar note (currently "Cost is per kit...") so it states the basis plainly, for example: "Cost per kit is what job costing uses. Enter cost per gal/box/pack or per kit in the editor; the other fills in automatically."

### 3. Costing material-line table: label the kit-based columns

Location: the material-line table inside the costing render (headers around 22351 to 22356, cells around 22364 to 22371, `lineUsedCost` around 22335).

- Relabel headers so the kit basis is explicit without changing any values:
  - "Qty" to "Qty (kits)"
  - "Order Qty" to "Order Qty (kits)"
  - "Unit $" to "Unit $ / kit"
  - "Actual Used" to "Actual Used (kits)"
- Leave the `data-line-used` input (around 22370) in kits as-is; only its header label changes. Leave all computed values and the used-cost math unchanged.
- If there is a compact/secondary rendering of the same lines elsewhere (for example the read-only cost displays around 21918, 12451, 22912) apply the same "/ kit" wording to any unit-cost label you find there, but change no values.

### 4. Spread rate wording (cosmetic only)

- Wherever the spread rate is labeled (editor label around 26842 "Spread rate (sqft per gal/box)", table header/cell around 26748, 26776), keep it reading clearly as "per {unit}" using `unitFor`. If it already reads clearly, leave it. Do not touch spread math anywhere.

### 5. What's New entry (required, user-facing change)

Append one entry to `help/whats-new.json` (newest first) per standing rule 9: id, date, title, one-line summary, 2 to 3 plain-language how-to steps, no em dashes. Suggested title: "Clearer product cost: per gallon or per kit." Steps should tell the user they can now enter cost either way in Settings > Products and the other value fills in automatically, and that job costing uses the per-kit number.

## Acceptance criteria

- In the product editor, typing a per-gallon cost fills the per-kit field as (per-gal x kit size) and vice versa, live, and changing kit size keeps them consistent. Saving stores the per-kit number in `unit_cost` (verify a save round-trips the same per-kit value as before this change for an unchanged product).
- Every place a product cost shows now states its basis (per kit, and per gal/box/pack where shown). No cost VALUE changes anywhere for any existing product.
- The costing screen's Qty, Order Qty, Unit $, and Actual Used columns are labeled as kits / per-kit. Used cost and line cost numbers are byte-for-byte the same as before.
- Both test suites pass (187 calculator, 142 estimate). All inline `<script>` blocks parse clean. `help/whats-new.json` validates. No em dashes in any new text.

## What NOT to touch (guardrails)

- Do NOT change any calculator or costing math (`production/calculator.js`, the `qty`/`line_cost`/`actual_used_qty * unit_cost_snapshot` paths). This is labeling plus a two-field input that computes the SAME per-kit `unit_cost` that is stored today.
- Do NOT add a database column or write a migration. Per-unit cost is derived, not stored. There is no Cowork handoff and no prod change.
- Do NOT modify historical `pec_prod_material_lines` rows or any cost snapshot.
- Do NOT change the flake default-basecoat behavior, the duplicate-name handling, or any other modal logic.

## After

- Commit per standing rules (index.html + help/whats-new.json in one commit; area prefix e.g. `settings: label product cost basis per-unit vs per-kit`).
- Append a PROJECT-LOG.md entry at the top per the template, describing the two-field editor, the label changes, the fact that no cost values or math changed, and that no migration was needed.
- Handoff to Dylan (put this in the log entry): the redesign prevents FUTURE mis-entries, but it cannot retroactively detect products whose existing cost was already entered on the wrong basis. Recommend Dylan spot-check existing product costs after deploy, or ask Cowork to produce a review list of products whose per-kit cost looks low relative to kit size and peers.
