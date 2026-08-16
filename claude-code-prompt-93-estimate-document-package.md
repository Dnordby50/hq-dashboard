# Claude Code Prompt 93: Estimate document package (address/ROC header, color chart, warranty)

## Context

Repo: `/Users/dylannordby/Claude-Code/HQ-Dashboard`. Base commit on `main`: **bd0f820**. Deploy: Netlify site `prescottepoxy`, https://prescottepoxy.netlify.app. Supabase project `zdfpzmmrgotynrwkeakd`.

Dylan gave nine requests on 2026-08-16, split into three prompts. **This is prompt 93 of 3.** Prompt 92 covers mobile calendar / bell / payment notifications. Prompt 94 covers scope templates and the sold-on-site metric. Do not do their work here.

One of Dylan's nine items ("presentation style estimate view for customer") was **deliberately dropped from this prompt**. He did not know Present mode already exists (prompt 64, `openPresentMode` at index.html:32018, `pec_presentation_sections`, the `pec-presentation` storage bucket). He is getting a walkthrough of what is already built and will decide afterwards whether anything is missing. **Do not build a second presentation surface.**

All anchors verified against the working tree at bd0f820 and live Supabase on 2026-08-16. Re-verify line numbers before editing; function, table, and column names are exact.

---

## Task A: Showroom address and ROC number at the top of the estimate

### What is already true (read this before you write anything)

Dylan asked to "add our showroom address to the top of the estimates along with our ROC number if it's not already there." **It is already there, in the footer.**

`netlify/functions/pec-public-estimate.cjs:748-752`:

```js
<div class="bizname">${biz}</div>
<div class="meta">${[b.address_line, b.phone, b.license_number ? 'License ' + b.license_number : ''].filter(Boolean).join(' · ')}</div>
```

Live data confirms it is populated (queried 2026-08-16):

| brand | business_name | address_line | phone | license_number |
|---|---|---|---|---|
| `prescott-epoxy` | Prescott Epoxy Company | 1030 Sandretto Dr Suite K, Prescott, AZ 86305 | (928) 800-8154 | **ROC353243** |
| `finishing-touch` | Finishing Touch Painting | 1030 Sandretto Dr Suite K, Prescott, AZ 86305 | (928) 800-8154 | **NULL** |

The header block (`pec-public-estimate.cjs:686-701`) renders logo + status pill + business name eyebrow + `Estimate <no>` + total, and nothing else.

### What to build (decision locked by Dylan, 2026-08-16)

**Add a letterhead block to the header AND keep the footer line as-is.** Both. He wants it visible without scrolling; the footer stays because that is where a printed page needs it.

1. In the header at pec-public-estimate.cjs:686-701, under the logo, render address, phone, ROC, and website when present, sourced from the **same `b.*` brand fields** already loaded by `loadBrand()` (pec-public-estimate.cjs:1140-1157). No new data source, no hardcoded strings.
2. Render `License ${b.license_number}` with the **same wording as the footer** so the two agree. If Dylan later wants "ROC #353243", one string change covers both — factor the label into a single helper used by header and footer.
3. Fields that are null or empty must **collapse silently**. FTP has no `license_number` and no `website`; the header must not print "License " with nothing after it, and must not leave a stray separator.
4. This must look right in three places, all of which already share this renderer:
   - the customer's `/e/<token>` page,
   - the **print/PDF** path (index.html:31412-31437 opens the same page with `?print=1`; there is no separate PDF renderer),
   - **Present mode**, whose estimate slide embeds the same `?preview=` render (index.html:32018+).
   Verify all three, do not assume.
5. Keep it visually subordinate to the estimate number and total. This is letterhead, not a headline. Small type, muted colour, one or two lines.

### Task A2: Settings → Brand only edits one brand

`renderSettingsBrand` (index.html:25313) is **hardcoded to `brand='prescott-epoxy'`** at index.html:25317, :25401, and :25408. There is no way to edit the `finishing-touch` row from the UI, which is why FTP has a null ROC.

Add a brand selector to that settings page (PEC / FTP), loading and saving the selected `pec_brand_identity` row. Existing field ids `biAddress` (index.html:25344), `biLicense` (index.html:25345, placeholder already reads "ROC…"), and the save patch at index.html:25384-25386 all stay; they just need to target the selected brand instead of a constant.

**Do not guess FTP's ROC number.** Leave it null and put it in the Handoff to Dylan.

### Guardrails

- `BRAND_DEFAULTS` at pec-public-estimate.cjs:91-98 stays as the fallback. Do not move brand values into code.
- Do not touch `estimate_terms_text` rendering (pec-public-estimate.cjs:516). PEC has 9,950 characters of terms; FTP has none. That is a separate content gap, not this task.

---

## Task B: Color chart tied to the system on each line

### Dylan's ask

"Attach color chart that is associated with each system. Example: if there is a flake job selected in the line item then have the flake chart there."

### Decision locked by Dylan (2026-08-16): build the chart from the products catalog

**Not** an uploaded image per system. Generate it from the color products already tied to that system through recipe slots, so it can never go stale relative to what you actually sell.

### The data path

```
estimate_areas.system_type_id
  -> pec_prod_recipe_slots (system_type_id, order_index, material_type, label,
       slot_kind, min_select, max_select, options jsonb, product_filter jsonb,
       editor_hidden, default_product_id)
     -> pec_prod_products (material_type, name, image_url, active)
```

The line's chosen colors are already on the line: `estimate_areas.flake_product_id`, `.basecoat_product_id`, `.topcoat_product_id` (SCHEMA.md:197-232).

**Live slot map for the 8 active system types** (queried 2026-08-16), so you know exactly what you are rendering:

| System | Color-bearing slots |
|---|---|
| Standard Flake | Basecoat (1), **Flake (2)**, Topcoat (3) |
| Metallic | Basecoat color (1), Metallic epoxy body coat (2, `editor_hidden`), **Metallic Pigment "Metallic colors" (3, multi_product, min 1 max 3)**, Topcoat (4) |
| Quartz | Basecoat color (1), Quartz body coat (2, `editor_hidden`), **Quartz "Quartz color" (3)**, Broadcast (4, choice), Topcoat (5) |
| Grind and Seal | Basecoat (1), Stain (2), Topcoat (3) |
| Concrete Polishing | Densifier, Stain, Polish grit (choice), Guard |
| MVB Only | Moisture Vapor Barrier (1) |
| Custom System | Custom build notes (text slot only) |
| **Polydeck System** | **ZERO recipe slots** |

**Product image coverage** (active products with a non-empty `image_url`, queried 2026-08-16):

| material_type | active | with image |
|---|---|---|
| Flake | 25 | **21** |
| Metallic Pigment | 50 | **49** |
| Quartz | 44 | **41** |
| Tint Pack | 14 | 14 |
| Polycoat | 5 | 2 |
| Basecoat | 13 | **1** |
| Stain | 9 | **0** |
| Topcoat | 4 | 0 |
| Sealer | 3 | 0 |
| Extra | 11 | 0 |

So Flake, Metallic Pigment, and Quartz have real chart coverage. Basecoat, Stain, Topcoat do not.

### What to build

1. **A chart section on the customer estimate page**, rendered inline (Dylan's locked choice: inline on the /e/ page, not an email attachment). Place it after the line items and before the terms card; keep it below the price so it never distracts from the number.
2. **One chart per distinct color-bearing slot across the estimate's lines**, deduped. If two lines are both Standard Flake, render the flake chart once. If one line is Flake and another is Quartz, render both, each labelled with the system and slot label (`pec_prod_recipe_slots.label`, falling back to `material_type`).
3. **Include only slots that clear a coverage floor.** A slot qualifies when at least `estimate_color_chart_min_products` (settings, default `6`) of its eligible active products have a non-empty `image_url`. That automatically excludes Stain (0) and Basecoat (1) today and automatically includes them later if Dylan uploads images, with no code change. **Do not hardcode a material_type allowlist.**
4. **Respect the slot's own filters.** `pec_prod_recipe_slots.product_filter` (jsonb) and `.options` (jsonb) exist and are used elsewhere in the pricer; read how `fullSlotsBySystem` (index.html:11089) resolves eligible products for a slot and reuse that resolution rather than writing a second one. Skip `editor_hidden` slots (the Metallic body coat and Quartz body coat are not customer color choices).
5. **Highlight the customer's actual selection.** The chosen product (from `estimate_areas.flake_product_id` etc, or the multi-select for Metallic) gets a visible "Your selection" marker. This is the single highest-value part of the feature: the customer sees their color in context of the range.
6. **Swatch tile**: product image, product name. Missing image = product omitted from the chart, not rendered as a broken tile.
7. **Mobile first.** This will mostly be viewed on a phone. Grid of tiles, 3 across at 390px, no horizontal scroll.
8. **Zero client-side Supabase calls from the customer page.** `pec-public-estimate.cjs` is a service-role server render; the chart data is fetched there, same as `loadCcCustomerPhotos` (pec-public-estimate.cjs:1068-1095).
9. **Print path**: charts of 50 metallic swatches will destroy a printed PDF. When `?print=1` is set, either cap the chart or omit it — pick one, state which and why in the log entry, and put the cap behind a setting.

### Flag, do not fix

**Polydeck System is active with zero recipe slots.** That means no material cost, no color chart, and a broken GP calculation on any Polydeck line. It also has no `scope_template`. Report it in the log entry and the Handoff to Dylan. Do not add slots yourself.

---

## Task C: Warranty document on the sent estimate

### Dylan's ask

"Warranty doc attached to estimates when it gets sent. Not sure if this should be a portal type thing or if we should just attach it as part of the presentation."

**Decision locked (2026-08-16): inline on the customer estimate page.** Not an email attachment (deliverability, and you lose view tracking), not a portal gate.

### The existing mechanism to extend

`pec_presentation_sections` already backs the "literature" block on the customer page: loaded at pec-public-estimate.cjs:1035 (`loadLiterature`), rendered at :1110 (`literatureBlockHtml`), placed at :743. Sections carry `brand`, `active`, `sort_order`, `images` (jsonb array of paths in the `pec-presentation` storage bucket), and markdown body. Edited at Settings → Presentation (`renderSettingsPresentation`, index.html:20549; editor modal `openPresentationSectionModal` ~20685; upload at :20752-20754; client-side resize `pecResizePresentationImage` at :20536).

`kind` is CHECK-constrained to `('why_us','process','gallery','financing')` (SCHEMA.md:1122).

### What to build

1. **Migration extending the `kind` CHECK to include `'warranty'`.** Standing rule 13 `@artifacts` header applies; a CHECK change is not one of the four expressible kinds, so declare `none: <reason>`.
2. Warranty sections render in a **dedicated, pinned position** on the customer page: after the terms card, before the footer. Do not let it float in `sort_order` among the marketing sections. It is a document, not literature.
3. The existing Settings → Presentation editor picks up the new kind automatically once it is in the kind list used by `openPresentationSectionModal`. Verify, and add the label to `PRESENT_KIND_LABELS` (index.html:32008).
4. **Freeze the warranty at send**, exactly like CompanyCam photos. `pecCcSnapshotAtSend` runs inside `markEstimateSent` (index.html:32251, `markEstimateSent` at :32148). Add the warranty to that same snapshot moment: store the rendered warranty body and its section id on the estimate. Reason: this is contractual. If Dylan edits the warranty wording next month, a customer who signed today must still see what they signed under. Live-until-sent, frozen after, is the pattern already proven in prompt 83.
   - New column: `estimates.warranty_snapshot jsonb` (nullable). Plain additive column on a non-money table, so direct to prod per standing rule 14. `@artifacts` line: `column: public.estimates.warranty_snapshot`.
   - **Careful:** `trg_estimate_status_guard` (SCHEMA.md:373) rejects any UPDATE that moves `status` backwards. Do not PATCH `warranty_snapshot` alongside a stale `status` value or the whole update fails. Write it in the same PATCH `markEstimateSent` already performs, or in its own PATCH that does not include `status`.
   - Before send (preview, Present mode), render the **live** warranty and do not write a snapshot. Same contract as the photos block.
5. **Present mode gets it for free** because its estimate slide embeds the same `?preview=` render. Confirm rather than assume.
6. **No em dashes** anywhere in warranty copy, help text, or What's New entries (standing rule 6). This is customer-facing.

### Settings (standing rule 12)

Front-of-card on Settings → Estimates (`renderSettingsEstimates`, index.html:20194), two controls:

- `estimate_warranty_enabled` (default `'true'`) — show the warranty section on customer estimates.
- `estimate_color_chart_enabled` (default `'true'`) — show color charts on customer estimates.

Behind **Advanced** on that card:

- `estimate_color_chart_min_products` (default `'6'`) — the coverage floor from Task B item 3.
- `estimate_color_chart_max_swatches` (default `'60'`) — per-chart cap so a 50-swatch metallic chart cannot balloon.
- `estimate_color_chart_print_mode` (`'omit'` | `'cap'`, default your Task B item 9 choice) — print behaviour.

Follow the existing `wire(elId, settingsKey, current)` helper pattern in that renderer (index.html:20413-20520). Do not add a `settings` row for anything the app writes to itself.

---

## Standing rules checklist for this session

- [ ] Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first (rule 4).
- [ ] `features.json` anchors + `SCHEMA.md` before grepping or writing SQL (rule 9). Never read `index.html` or `PROJECT-LOG.md` end to end (rule 10).
- [ ] Commit after each meaningful change (rule 1). Append ONE PROJECT-LOG.md entry at the TOP (rules 2, 3).
- [ ] All three tasks are user-facing and customer-visible → What's New entries in `help/whats-new.json` (rule 11), plain language, **no em dashes** (rule 6).
- [ ] Update `features.json` entries for the public estimate page, presentation sections, and Settings → Brand.
- [ ] Regenerate `SCHEMA.md` after migrations (rule 9).
- [ ] `@artifacts` headers on every migration (rule 13).
- [ ] Rule 14: none of these touch money tables, auth, or `estimates.status`, so the additive column and the CHECK extension go direct to prod. Say so explicitly in the log entry rather than leaving it unaddressed.

## Verification before the log entry

Report actual results:

1. `npm test` green; all `index.html` script blocks parse; `node --check` on `pec-public-estimate.cjs`.
2. Migration artifacts re-queried against `information_schema`.
3. New `settings` rows re-queried by value.
4. Render an FTP estimate and a PEC estimate. Confirm the FTP header collapses the missing ROC and website cleanly with no stray separators.
5. Render an estimate with a Standard Flake line and one with a Metallic line. Confirm the right charts appear, the selection is marked, and no chart appears for a Grind and Seal line (Stain has zero images today).
6. Confirm the header/letterhead appears identically on `/e/`, `?print=1`, and Present mode.
7. Confirm the warranty renders live before send and frozen after, by sending a test estimate to Dylan's own address, editing the warranty section, and reloading the public link.
8. **List explicitly what you could not verify.**

## Handoff to Dylan (put this in the log entry)

1. **FTP has no ROC number on file.** Once the brand switcher ships, open Settings → Brand, switch to Finishing Touch Painting, and enter its ROC. Until then FTP estimates print no license line.
2. **FTP has no estimate terms text** (PEC has 9,950 characters). Its terms card renders empty.
3. **Polydeck System is active with zero recipe slots and no scope template.** It will have no material cost, no color chart, and a wrong GP on any line that uses it. Either populate its slots or deactivate it.
4. **The warranty document itself needs writing.** The build ships the mechanism, not the content. Dylan writes the warranty section at Settings → Presentation once deployed.
5. Basecoat (1 of 13), Stain (0 of 9), and Topcoat (0 of 4) active products have no images, so those slots will never produce a chart until product images are uploaded in the catalog.
