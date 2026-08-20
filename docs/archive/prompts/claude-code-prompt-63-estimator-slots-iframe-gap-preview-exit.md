# Claude Code Prompt 63: hide product slots at estimate time, fix the inline-estimator gap, make the preview modal exitable, and move product picks to the job

Scoped by Cowork 2026-08-02 after 28 multiple-choice questions with Dylan. Prompt 64 (the on-site presentation view) is a **separate file** and is NOT part of this run. Do not build any part of it here.

Read `CLAUDE.md` and the top 3 entries of `PROJECT-LOG.md` first. Verify every table and column against `SCHEMA.md` before writing SQL; if SCHEMA.md and the live schema disagree, trust live and flag the drift in your log entry. Use `features.json` anchors instead of reading `index.html` end to end.

---

## Why this prompt exists

Prompt 62 Part H deleted the estimator's `More detail` accordion and made the **Products and colors** card always visible. That was the right call for the work-order questions and the wrong call for the product dropdowns: Dylan does not want to see Basecoat, Flake, or Topcoat pickers while he is selling. His words: *"This is almost never necessary at the time of estimate. We only want things that are going to drive sales on the estimate, not fine details detracting from the sales process."*

Three of the four items here are small and surgical. Ship them clean and verifiable. Prompt 61 shipped unverified into prompt 62, and 62's own handoff still lists open verification. Do not add a third unverified layer.

---

## Part A: hide product slots in the estimator's area block

**File:** `apps/estimator/src/features/estimator/EstimatorScreen.tsx`, the `Products and colors` section (currently around line 2140, inside the `{!isCustom && <section className="card">` block).

### Locked decisions

1. **Every product-kind slot hides.** Use the existing `kindOf(s)` helper (around line 91: returns `'choice' | 'text' | 'product'`). Hide every slot where `kindOf(s) === 'product'`. That covers Basecoat, Topcoat, Flake, Quartz, Metallic Pigment, primer, non-slip, and anything else in the product family. Dylan chose the broad rule explicitly ("Every product slot, keep choice/text slots") so a new product material_type added to a recipe later is hidden automatically, with no code change.
2. **Choice and text slots stay visible.** Topcoat cure speed is a `choice` slot bound to `area.topcoat_cure_speed` (see the `spec.areaField === 'topcoat_cure_speed'` branch in index.html around 15547). It stays. Anything the rep genuinely answers on site stays.
3. **The system picker stays.** Dylan was explicit: *"i want the system picker to still be there i just dont want to see those 3 dropdowns."* Do not touch the system type selector, the area name, the sqft field, or MVB.
4. **The Work order questions stay exactly where prompt 62 Part H put them: always visible, never collapsed.** They live in the same `!isCustom` card today (`{workOrderFields}` after the `Work order` heading). They must survive Part A untouched, including in the `isCustom` branch which has its own copy.
5. **Escape hatch: a small `Specify products` text link.** Rendered in the Products and colors card. Clicking it reveals the hidden product slots inline for that estimate, in the current session only. It does NOT persist, it is NOT per-area (one link reveals for all areas), and it defaults to collapsed on every open. This exists for commercial bids and for the customer who already picked a color. Style it as `.link`, matching `Generate from proposal` and `Undo generate`.
6. **Card collapse rule.** If, after hiding product slots, an area has no visible slots left, render nothing for that area. If NO area has a visible slot, the `Products and colors` heading and its hint are suppressed entirely and only the `Specify products` link plus the Work order block render. Never leave an empty titled card.
7. **Rewrite the hint.** The current hint reads "Flake color can stay unpicked; the price already includes standard flake, the customer usually chooses after the presentation, and it stays editable on the estimate page." Replace with something short and true, for example: "Colors and products are picked after the sale, on the job. The price already includes standard materials. Use Specify products if this job needs a spec now." No em dashes (customer-facing style rule; the estimator is rep-facing but keep the house style consistent).

### The thing that must not break: pricing

`defaultSlotValues` (around line 156-174) prefills every **product** slot with the system's `default_product_id`, and deliberately skips swatch types. `planForArea` resolves each slot as `pick || default_product_id`. **Therefore hiding the UI changes nothing about the material plan or the calculated price.** That is the entire reason this is safe.

You must PROVE it, not assume it:

- Pick 3 existing estimates with different system types. Record `calc_price`, `materials_cost`, and the `estimate_area_slots` rows for each BEFORE your change.
- After the change, open each in the estimator, save without touching anything, and re-query. **`calc_price`, `materials_cost`, and the slot rows must be byte-identical.** Report the three comparisons in your log entry. If any differ, stop and report; do not "fix" it by writing defaults harder.

### The one real behavior change: `flake_color`

`flakeColorFromPicks` (around line 1151) derives `estimates.flake_color` from SWATCH-type picks. Swatch slots are the ones `defaultSlotValues` deliberately leaves unprefilled, so with the UI hidden they will now always be empty and **the estimator will stop writing `flake_color` entirely** (unless the rep opens `Specify products` and picks one).

That is accepted. Dylan chose "keep the estimate Flake color field," and the manual `#estFlakeColor` input on the estimate detail page (index.html around 27290) becomes the only writer. Do not remove that field. Do not add a warning about a blank flake color; it is now the normal state at estimate time.

Confirm in your log: how many existing estimates currently have a non-null `flake_color`, so Dylan knows the baseline.

### Save path

The save block (around line 1343-1360) writes `estimate_area_slot` rows for slots that have a value, plus the legacy mirror `flake_product_id` / `basecoat_product_id` / `topcoat` via `deriveProducts`. **Do not change the save path.** The `slotValues` state still holds the prefilled defaults whether or not the UI renders them, so the same rows write. Verify this with the three-estimate comparison above.

---

## Part B: product picks move to the job page, display and ordering only

### Locked decisions

1. A **Colors and products** block on the accepted job, editable by anyone who can edit the job. It is where the flake color, basecoat, and topcoat actually get chosen before materials are ordered.
2. **It never changes money.** Dylan chose "Display and ordering only, no cost change." Changing a pick here must NOT write `materials_cost`, must NOT touch `computeCostingRow`, must NOT alter GP, and must NOT create or move a costing row. Prompt 56's lesson (a derived-beats-stored rule silently moved 34 finalized jobs' GP by $4,785) applies directly: if you find yourself writing to a cost column, you have gone out of scope.
3. **It DOES change what gets ordered and what prints.** The material plan for ordering, and the crew work order, read the picks. So the pick has to reach `computeMaterialPlan` for quantities and product names, while the cost columns stay frozen.
4. Guard the boundary with a comment at the write site explaining exactly this split, because the next person will assume a product swap should move cost.

### Before you build it

`SCHEMA.md` is the authority. Confirm where job-side picks actually live before writing anything:

- Do job areas have their own slot-pick table, or only the legacy `job_areas.flake_product_id` / `basecoat_product_id` / `topcoat_cure_speed` columns (referenced in index.html around 16122-16184)?
- If there is no job-side slot table, **say so and use the legacy columns plus a new slot table only if the recipe genuinely needs multi-slot picks.** Do not invent a table without stating why in your log.
- `material_type` is CHECK-constrained on `products`, `recipe_slots`, and `material_lines`. Do not add a new material category here.

If Part B turns out to need a migration larger than adding one table plus indexes, **stop and report** rather than expanding. Parts C and D must ship regardless.

---

## Part C: the large blank gap under the inline estimator

### Root cause, already diagnosed, verify before fixing

`apps/estimator/src/styles.css:48` sets:

```css
html, body, #root { height: 100%; margin: 0; }
```

unconditionally. In embed mode the height reporter (`EstimatorScreen.tsx` around line 1178) measures `#root`:

```js
const px = Math.ceil(Math.max(el.scrollHeight, el.offsetHeight));
```

Because `#root` is `height: 100%` of the iframe viewport, that measurement can never report **less** than the iframe's current height. The parent mounts the iframe at `min(1100px, 85vh)` (`index.html:7171`), so the frame ratchets: it can grow with content but can never shrink below its initial height. On a short estimate on a large monitor that is several hundred pixels of dead space between the estimator's `Notes for the crew` box and the `Customer view` card below it. Dylan confirmed this is exactly what he sees.

`body.embed .screen { min-height: 0 }` (styles.css:54) was the attempted fix and it misses `#root`.

### Fix

1. In `styles.css`, scope the embed case: `body.embed #root { height: auto; }`. Keep `html, body` as they are for the standalone PWA. Keep the existing `body.embed .screen { min-height: 0 }`.
2. Check line 57's `min-height: 100%` (the rule immediately after) and line 68's `.screen { min-height: 100% }`: with `#root` at `auto`, a percentage min-height resolves against an auto-height parent and should collapse, but **verify in the browser** rather than reasoning about it.
3. After the CSS change, force one re-post of the height on mount so a frame that already ratcheted in a cached session corrects itself immediately.
4. Leave the parent's floors alone: `.pec-estimator-inline { min-height: 520px }` (index.html:610) and `Math.max(520, ...)` in the message handler (index.html around 7561) are deliberate. A genuinely tiny estimator will still be 520px tall. That is fine and is not the bug.

### Verify in the browser, not by inspection

Open a **draft** estimate with ONE area on a large window. Log the posted `px` and the resulting `iframe.offsetHeight`. They must agree within a few pixels, and the visible gap between the estimator's last card and the `Customer view` card must be the normal 14px grid gap. Then add three areas and confirm it grows, then delete them and confirm **it shrinks back**. The shrink is the test that matters; growth already worked.

---

## Part D: the customer preview modal cannot be exited

### Root cause

`index.html` around 27515, the `estPreview` handler builds:

```js
const wrap = openModal('<iframe id="estPreviewFrame" ...></iframe>');
```

The modal content is an iframe and nothing else. There is no ✕, no header, no Cancel. And `openModal` (index.html:7982-7999) deliberately disables backdrop-click-to-close when the content matches `form, input, textarea, select, iframe`:

```js
if (!wrap.querySelector('form, input, textarea, select, iframe')) {
  wrap.addEventListener('click', e => { if (e.target === wrap) closeModal(); });
}
```

`iframe` is in that guard to protect the **estimator** modal's inputs. The preview inherits the protection and has nothing to protect. There is no Escape handler on `.pec-modal-bg` either (the Escape listeners at 5375, 8158, 9309, 23210, 29347 and 29942 all belong to other components). So the preview is a genuine dead end: the only exit is a page reload.

### Fix, as Dylan chose: ✕ + Escape + backdrop click

1. **Add an opt-in to `openModal`.** New option, e.g. `openModal(html, { onMount, dismissible })`. When `dismissible === true`, backdrop click closes regardless of the iframe/input guard. When it is absent, today's behavior is unchanged for every existing caller. **Do not flip the default.** The guard exists because of a real complaint ("very touchy") about stray clicks wiping half-typed data.
2. **Escape closes only dismissible modals**, top-most first, via one document-level listener attached while a dismissible modal is open and removed on close (the pattern already used at 29341-29347). A half-typed change order must still not die to a stray Escape.
3. **Preview gets a header bar**: estimate number on the left, a ✕ button on the right, above the iframe. Pass `dismissible: true`.
4. **The offline estimator fallback modal (`openEstimatorFrame`, index.html around 7198) has the same missing-✕ trap.** Give it a ✕ too, but **NOT** `dismissible` and **NOT** Escape: it contains a live half-built estimate. Its ✕ should confirm before closing if the frame has unsaved state, or at minimum warn in the tooltip.
5. Per the CLAUDE.md two-root rule, check whether a second modal root exists and whether it needs the same treatment. Report what you found.

### Verify

Open Preview on a sent estimate and on a draft estimate. Confirm all three exits work (✕, Escape, backdrop). Then open the change-order modal, the payment modal, and the compose modal, type something, press Escape, and click just outside the box: **all three must still refuse to close.** Report those three negative tests explicitly; they are the regression this fix could cause.

---

## Execution rules for this run

- Do exactly these four parts. If something looks like it needs prompt 64's presentation work, stop.
- If Part B's schema reality differs from what is described above, **do Parts A, C and D, report B, and stop on B.** Do not guess a table into existence.
- `npm test` green before you commit, with the exit code verified, and no test weakened to make it pass.
- Update `SCHEMA.md` if and only if you changed the schema. Update `features.json` anchors for anything you moved. Add a `help/whats-new.json` entry for the preview-exit fix and the cleaner estimator (customer-facing copy: **no em dashes**, use commas or two sentences).
- Commit per part with `cowork:`-style messages of your own convention, never `git add .`, never commit secrets or `.env`.
- Append a new entry to the TOP of `PROJECT-LOG.md`. Include: the three-estimate price comparison from Part A, the current non-null `flake_color` count, the browser-verified shrink test from Part C, and the three negative modal tests from Part D. If anything failed or you stopped early, log that anyway.

## Known leftovers, deliberately NOT in this prompt

- The `ELEVENLABS_API_KEY` shipped in plaintext in `index.html` (prompt 62 handoff item 7). Still needs rotating and moving server-side.
- The dead `CONFIG.SHEETS_API_KEY`.
- Prompt 62's own verification items: walking the two-card pipeline board, and confirming the `change_requested → Presented` / `signed → Accepted` column mapping reads correctly to Dylan.
- The prompt-49 follow-up queue still does not exist.
