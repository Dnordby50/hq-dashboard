# Claude Code prompt: Price & Material Catalog reorg (pairings on flake, required basecoat, collapsible system types, drop requires flags)

## Context
Repo: hq-dashboard (ARM 1 single-file dashboard, all UI in index.html). Deploy: https://prescottepoxy.netlify.app. Dylan finds the Price & Material Catalog messy and asked Cowork to plan a reorg. Cowork did the recon and locked every decision with Dylan (multiple-choice dig, 2026-07-16) and ran a read-only prod audit. This prompt is self-contained; you do not need the chat history. Do the whole thing in ONE session, all four changes together (Dylan chose one build, not phased).

The Catalog is `renderCatalog` (index.html ~26288) with sub-tabs Products / System Types / Add-ons / Color Pairings. Read these before editing: renderCatalog (~26288), renderProducts (~26409), openProductModal (~26508), renderSystemTypes (~26698), openSystemTypeModal (~26799), renderColorPairings (~27000), openPairingModal (~27056), and the estimator basecoat-default block (~11612-11614) plus the color-picker gating (~25656-25661).

Architecture note (do not trip on it): the catalog modals use `#prodModalRoot` (the production/catalog inline modal root), NOT `#pecModalRoot`. Stay on `#prodModalRoot` for every modal you touch here. This change does not touch modal lifecycle helpers, so the two-modal-root gotcha does not require a both-roots edit here; just keep using the same root the surrounding code already uses.

## Locked decisions (do not re-litigate)
1. Color pairings move ONTO the flake product as a single "Default basecoat" field. One basecoat per flake. The standalone Color Pairings tab is retired.
2. A basecoat is REQUIRED to save a flake product: block the save if a Flake has no default basecoat. EXEMPTION: "Special Order Flake" (by name) is exempt. Existing flakes are grandfathered (enforcement only fires when a flake is added or edited-and-saved, which is automatic since validation runs on save).
3. System Types renders COLLAPSED by default: a compact row per system showing name + active status + the pricing percentages (Target GP / Labor / Materials), read-only. Click a system to expand its recipe-slots table and controls. Pricing % stays editable ONLY in the existing Edit modal.
4. Remove the "Requires flake" / "Requires basecoat" Yes/No toggles entirely. Required colors are DERIVED FROM RECIPE SLOTS: a Flake slot means the system needs a flake, a Quartz slot means it needs quartz, a Metallic Pigment slot means it needs a pigment, a Basecoat slot means it needs a basecoat. Slots are the single source of truth.
5. Estimator behavior is IDENTICAL for reps. When a rep picks a flake, the paired basecoat still auto-fills; it just reads the new location (the flake product's default basecoat) instead of the pairings table. Quartz is UNCHANGED: quartz systems keep their manual per-job basecoat pick (too many quartz colors to pair). No pairing field on quartz.

## Prod audit (already run by Cowork, read-only, so you can build against reality)
- 23 real flake products (excluding "Special Order Flake"). 20 have exactly one DEFAULT pairing that backfills cleanly 1:1. 3 have no pairing and are all placeholders where a per-job pick is correct, so grandfather them: "Simiron Special Flake 40lb - Carbon", "Simiron Special Flake 40lb (Standard)", "Standard Flake (color TBD)".
- The estimator's color pickers ALREADY derive from slots today (`sysHasSlot`), with the `requires_*` flags only as an OR fallback (see ~25660-25661 and the comment there calling the flag "legacy"). So removing the flags is a fallback removal, not a rewrite.
- Active systems and their slot material types (derived requirement in brackets):
  - Standard Flake: Basecoat, Flake, Topcoat [flake + basecoat]
  - Quartz: Basecoat, Quartz, Extra, Topcoat [quartz + basecoat] (its stale requires_flake_color=Y is already ignored by slot logic)
  - Metallic: Basecoat, Metallic Pigment, Topcoat [pigment + basecoat] (its stale requires_flake_color=Y is already ignored)
  - Grind and Seal: Basecoat, Stain, Topcoat [basecoat] (picker already shows basecoat via slot today, no change)
  - MVB Only: Basecoat [basecoat] (no change)
  - Concrete Polishing / Custom System / Polydeck System: no color slots [no color] (no change)
- The ONLY behavior divergence from dropping the flags is the INACTIVE "Grind and Seal - Urethane" (requires_basecoat=Y but zero slots): its basecoat picker would disappear. It is inactive so it never appears in the estimator picker; acceptable. If it is ever reactivated, add a Basecoat slot to it.

## Tasks (dependency order)

### 1. Migration file (write it, do NOT apply; Cowork applies to prod)
Create `supabase/migrations/2026-07-16_flake_default_basecoat.sql` with exactly this (additive, idempotent, reversible):
```sql
-- Move flake->basecoat pairing onto the flake product itself.
-- Single default basecoat per flake. Additive + idempotent. Backfills from
-- the existing default color pairings. Does NOT drop pec_prod_color_pairings.
alter table public.pec_prod_products
  add column if not exists default_basecoat_product_id uuid
  references public.pec_prod_products(id) on delete set null;

update public.pec_prod_products f
set default_basecoat_product_id = cp.basecoat_product_id
from public.pec_prod_color_pairings cp
where cp.flake_product_id = f.id
  and cp.is_default = true
  and f.default_basecoat_product_id is null;
```
Acceptance: file exists, `psql`-valid, backfill fills 20 rows when applied. Do NOT apply it here and do NOT drop the pairings table.

### 2. Product modal: add required Default basecoat for flakes (openProductModal ~26508)
- Add a "Default basecoat" `<select>` populated with active Basecoat products (use the existing `productsByMaterialType('Basecoat')` helper, exclude any Special Order placeholder). Include a blank "Pick a basecoat..." first option.
- Prefill from `p.default_basecoat_product_id`.
- Show the field ONLY when material type is Flake. Add a change listener on `pmType` to show/hide it live, and set initial visibility from `p.material_type`.
- On save: add `default_basecoat_product_id` to the payload = the select value when material type is Flake, else `null`.
- Validation (block save): if `material_type === 'Flake'` AND `name !== 'Special Order Flake'` AND no basecoat chosen, set the error text to "Pick a default basecoat for this flake color." and return without saving. Reenable buttons on that path like the other validation returns do.
- Acceptance: creating/editing a normal flake with no basecoat is blocked; picking one saves and reopens with it selected; "Special Order Flake" saves with no basecoat; non-flake products never show the field.

### 3. Retire the Color Pairings tab
- Remove the `color_pairings` tab button (~26294), its dispatch line (~26302), and the functions `renderColorPairings` (~27000) and `openPairingModal` (~27056).
- Catalog nav is now three tabs: Products, System Types, Add-ons. If `state.catalogTab === 'color_pairings'` on entry, fall back to `'products'` so a stale value cannot render a dead tab.
- Grep `state.colorPairings` and `pec_prod_color_pairings`. Remove now-dead UI reads/fetches of the pairings table (e.g. the cachedRef/load fetches at ~9024, ~11527, ~21050, ~24874) ONLY after confirming the estimator no longer needs `state.colorPairings` (task 4 repoints it). Do NOT drop the DB table. If any fetch is entangled with other loads, leave the fetch but stop consuming the result rather than risk a load break; note what you left.
- Acceptance: Catalog shows three tabs, no console errors, no reference to a missing pairings function.

### 4. Estimator: repoint the basecoat auto-fill to the flake product (do NOT change rep UX)
- At ~11612-11614 replace the pairings-based `defaultBasecoatByFlake` build with one sourced from products:
```js
const defaultBasecoatByFlake = {};
for (const p of products) if (p.material_type === 'Flake' && p.default_basecoat_product_id) defaultBasecoatByFlake[p.id] = p.default_basecoat_product_id;
```
- Everything downstream that reads `defaultBasecoatByFlake` (the auto-fill at ~12087) stays as-is.
- Acceptance: on a Standard Flake job, picking a flake still auto-sets its basecoat; a quartz job still requires a manual basecoat pick (unchanged).

### 5. Remove the requires-flake/basecoat toggles; derive from slots
- openSystemTypeModal (~26799): remove the `smReqFlake` and `smReqBase` fields (~26808-26818), remove `requires_flake_color`/`requires_basecoat_color` from the payload (~26862-26863), and drop them from the default object (~26805).
- renderSystemTypes: remove the "Requires flake: ... requires basecoat: ..." line (~26714/26718).
- Estimator gating (~25660-25661): drop the `|| (sys && sys.requires_flake_color)` and `|| sys.requires_basecoat_color` fallbacks so `showFlake`/`showBase` derive purely from `sysHasSlot(...)`. Confirm `showQuartz`/`showPigment` are already slot-only.
- Grep the whole file for `requires_flake_color` and `requires_basecoat_color` and remove every remaining read/write. Leave the DB columns in place (dead, reversible) — do NOT write a migration to drop them.
- Acceptance: system modal no longer shows the toggles; grep returns zero code references; the estimator pickers for every ACTIVE system match the audit table above (verify Standard Flake shows flake+basecoat, Quartz shows quartz+basecoat, Metallic shows pigment+basecoat, Grind and Seal shows basecoat, MVB Only shows basecoat, the no-color systems show none).

### 6. System Types: collapse-to-expand (renderSystemTypes ~26698)
- Default every system COLLAPSED. Collapsed row shows: the drag handle, name, active/inactive status, and a compact read-only pricing summary (Target GP / Labor / Materials %, showing a dash when null), plus an expand affordance (chevron or click target) and the Edit button.
- Clicking the row (not the drag handle, not Edit) toggles expansion. Expanded shows the existing recipe-slots table, the slot Edit/Delete buttons, and "+ Add slot".
- Track expanded ids in memory (e.g. `state.expandedSystemTypes` as a Set) so re-render preserves what is open; default empty (all collapsed).
- Keep drag-to-reorder working from the collapsed row (the handle already carries the id).
- Pricing % remains editable only in the Edit modal; the summary is display-only.
- Acceptance: the list is scannable at a glance, clicking expands/collapses one system, drag reorder still persists, Edit still opens the modal, adding/deleting slots still works.

### 7. What's New entry (standing rule 9)
Append to `help/whats-new.json` (newest first) one entry: id `catalog-flake-basecoat-and-system-cleanup`, today's date, title like "Simpler Price & Material Catalog", a one-line summary, and 2-3 plain-language how-to steps (set a flake's basecoat right on the flake, click a system to expand it). No em dashes.

### 8. Tests + build
- Update any production test that referenced color pairings, the requires flags, or system-type rendering. Add at least one assertion that a flake's default basecoat drives the estimator auto-fill, and one that a Flake without a basecoat cannot be saved (or test the validation helper if you factor one out).
- `npm test` green, `node --check` clean on any touched .cjs, and the estimator app build (if this touches it) clean.

## Guardrails (do NOT do these)
- Do NOT drop `pec_prod_color_pairings` or the `requires_*` columns. Reversibility matters; they become dead, not deleted.
- Do NOT add pairing to quartz or change quartz/metallic basecoat behavior.
- Do NOT change per-area material planning math; only the basecoat DEFAULT source moves.
- Do NOT remove the Special Order Flake exemption.
- Do NOT apply the migration to prod (Cowork does that before Dylan deploys).

## After (standing rules 1, 2, 5)
- Commit per format (e.g. `catalog: pairings on flake, collapse system types, drop requires flags`).
- Append a PROJECT-LOG.md entry at the TOP (By: Claude Code) describing exactly what changed, the files touched, and a `## Handoff to Cowork` telling Cowork to apply `supabase/migrations/2026-07-16_flake_default_basecoat.sql` to PROD (project "HQ Dashboard", zdfpzmmrgotynrwkeakd) BEFORE Dylan deploys (the save writes `default_basecoat_product_id`, so the column must exist first), capturing the backfill row count (expect 20), and a `## Handoff to Dylan` to deploy after Cowork confirms, then reassign basecoats on the 3 grandfathered placeholder flakes if he wants them auto-filling.
