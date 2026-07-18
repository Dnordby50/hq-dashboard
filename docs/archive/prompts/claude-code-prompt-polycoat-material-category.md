# Claude Code prompt: add "Polycoat" as a material_type category

## Context
Dylan is standing up a new waterproof deck system called Polycoat. He is adding the Polycoat SYSTEM TYPE himself through Catalog, System Types, + Add system type (no code needed there). What he cannot do without code is add a new material_type CATEGORY so Polycoat's materials group and behave as their own kind of product. The category list is hardcoded in index.html in four places, and material_type is free text in the DB (the recipe-slot list already carries values like Densifier and Guard that are not in the product list), so there is NO enum or CHECK constraint and NO migration is needed. This is a single-file, front-end-only change to index.html plus one What's New entry. Repo: hq-dashboard. Deploy: https://prescottepoxy.netlify.app.

The goal is that Polycoat behaves exactly like the existing categories: it can be picked when creating a product, Polycoat products group under a "Polycoat" section in the Price and Material Catalog, and a system's recipe slot can pull Polycoat-typed products (so the Polycoat system can actually consume its own materials).

## Tasks
Make all four edits in index.html. They are small and independent, but all four are required or Polycoat is only half-wired.

1. Product modal category dropdown.
   - File: index.html, line ~26531 (the `id="pmType"` select inside `openProductModal`).
   - Current array: `['Basecoat','Flake','Quartz','Metallic Pigment','Topcoat','Stain','Sealer','Tint Pack','Extra']`.
   - Add `'Polycoat'` to the array. Place it after `'Sealer'` (so it reads `...'Sealer','Polycoat','Tint Pack','Extra'`). Do not touch the `t === 'Basecoat' ? 'Epoxy Products' : t` label special-case; Polycoat should display as its own name "Polycoat".
   - Acceptance: opening + Add product shows "Polycoat" as a selectable Material type.

2. Recipe-slot category dropdown.
   - File: index.html, line ~26914 (the `id="rsType"` select inside the recipe-slot modal).
   - Current array: `['Basecoat','Flake','Quartz','Metallic Pigment','Topcoat','Stain','Sealer','Densifier','Guard','Tint Pack','Extra']`.
   - Add `'Polycoat'` in the same relative spot (after `'Sealer'`).
   - Why this one matters: the Polycoat system's recipe slots need to reference material_type "Polycoat" to pull Polycoat products. Without this, Dylan can create Polycoat products but cannot wire them into the Polycoat system's recipe.
   - Acceptance: adding or editing a recipe slot on a system shows "Polycoat" in the material type dropdown.

3. Catalog section order.
   - File: index.html, line ~26414 (`const sectionOrder` inside `renderProducts`).
   - Current: `['Flake', 'Quartz', 'Metallic Pigment', 'Basecoat', 'Topcoat', 'Stain', 'Sealer', 'Tint Pack', 'Extra']`.
   - Add `'Polycoat'` after `'Sealer'`.
   - Why: any material_type not in `sectionOrder` falls into the catch-all "Other" bucket (line ~26435). Adding Polycoat here gives it its own labeled, sorted, collapsible section like every other category.

4. Catalog section label.
   - File: index.html, line ~26415 (`const sectionLabel` map, right below `sectionOrder`).
   - Add an entry: `Polycoat: 'Polycoat',`. (A plain label is fine; the other entries pluralize or rename, but "Polycoat" reads correctly as-is.)
   - Note on units: `unitFor` (line ~26440) defaults to gallons for anything not Flake/Quartz/Metallic Pigment/Tint Pack. A liquid deck coating is billed per gallon, so the default is correct and needs NO change. Do not add Polycoat to `unitFor` unless Dylan later says it is sold by the box/kit.

5. What's New entry (standing rule 9, this is user-facing).
   - File: help/whats-new.json (newest first).
   - Append one entry: id (next in sequence), today's date, title like "New material category: Polycoat", a one-line summary, and 2 to 3 plain-language how-to steps (for example: open the Price and Material Catalog, click + Add product, pick Polycoat as the Material type). No em dashes.

## Guardrails
- index.html only for tasks 1 to 4; help/whats-new.json for task 5. Do NOT touch any Supabase migration, the estimator app (apps/estimator), or any recipe/costing math. material_type is free text, so there is nothing to migrate.
- Do not reorder or rename any existing category. Only insert Polycoat.
- Do not add Polycoat to the SWATCH sets (Flake/Quartz/Metallic Pigment color swatches at lines ~11249, ~11618, ~24624) or to any Basecoat special-casing. Polycoat is neither a color swatch nor a basecoat.
- Keep the placement consistent (after Sealer) in all three lists so the ordering reads the same everywhere.

## After
- Commit per standing rules: `catalog: add Polycoat material category`.
- Append a PROJECT-LOG.md entry at the top (By: Claude Code) naming the four index.html spots changed, the What's New id added, and that no migration was needed because material_type is free text. Note the sibling fact that Dylan is adding the Polycoat SYSTEM TYPE himself via the Catalog UI, so no system-type row is created in code.
- No Cowork or Dylan handoff is required for this change (front-end only, no prod data touched). If node --check or the existing production tests are part of your normal flow, run them; nothing here should affect them.
