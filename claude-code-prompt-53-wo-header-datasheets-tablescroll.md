# Claude Code prompt 53: work order header boxes, product data sheets, global table scroll fix

## Provenance

Dylan's asks (2026-07-28), verbatim:

- "job name and crew name- LARGE boxes replace 'crew work order' text area on work order"
- "data sheets able to be attached to products in catalog"
- "users table is not all the way visible, falls off page, make scrollable"

A fourth ask from the same message ("map team members, crew, and users together on one table") is NOT in this prompt. It is the People model build and has its own prompt (54). Do not touch `admin_users`, `pec_sales_team_members`, `pec_prod_crews`, or `pec_prod_crew_members` in this session.

Read before you start: CLAUDE.md, the top 3 entries of PROJECT-LOG.md, SCHEMA.md for `pec_prod_products` and `settings`, and features.json entries "Work Order print", "Catalog / Products", "Job detail".

Three independent parts. Commit each separately per standing rule 1. `npm test` green before and after each commit.

---

## Locked decisions (Dylan answered these 2026-07-28; do not re-litigate)

1. The work order header gets **three** large boxes: Job, Crew, Date. Not two.
2. The small `Crew:`, `Job Name:`, and `Date:` rows in the Job Identity grid are **removed**. The three facts print once, large, at the top.
3. Data sheets are **uploaded PDFs**, not pasted URLs. This is the app's first Supabase Storage code.
4. **Two sheets per product**: a data sheet (TDS) and an MSDS/SDS. Not a child table, not one field.
5. The storage bucket is **public**. Dylan considered private + signed URLs and reversed: these are manufacturer documents that are already public, and a public URL survives being printed, texted, or opened by someone without a TopCoat login.
6. Sheets are reachable from **the catalog product row/modal** and **a button on job detail**. The job-detail button is **not always visible**: it appears only when the job's materials actually have sheets attached.
7. The table-scroll fix is **global**, not scoped to Settings > Users.

---

## Part A. Work order header: three large boxes

### What exists

`renderWorkOrder(ctx)` starts at index.html:13173. It resolves `installDate` and `crewName` from `pec_prod_jobs` / `pec_prod_job_schedule_days` / `pec_prod_crews` (index.html:13176-13197); both are silently null when the job is not on the calendar, and the sheet still prints. The printed HTML is a template literal starting at index.html:13322 with its own inline `<style>` block (this is a separate popup window and cannot read the app's `--rd-*` tokens).

The header today, index.html:13396-13401:

```html
<div class="wo-header">
  <div class="wo-title">Crew Work Order</div>
  <div class="wo-brandwrap">
    <img class="wo-logo" src="${location.origin}/assets/pec-logo.png" alt="Prescott Epoxy Company">
  </div>
</div>
```

`.wo-header` and `.wo-title` are defined at index.html:13345-13346.

The Job Identity block immediately below, index.html:13417-13425, is a 4-column grid (`.intake`, `grid-template-columns: 116px 1fr 116px 1fr`) of label/value pairs:

```
Crew: | Date: | Job Name: | DJ #: | Address: | Location: | Gate Code#: | Phone:
```

### What to build

Replace `.wo-title` with a row of three large boxes: **JOB** (`job.customers?.name`), **CREW** (`crewName`), **DATE** (`dateFmt(installDate)`). Keep the PEC logo where it is, on the right. Keep the orange `.wo-banner` above it untouched.

Requirements:

- Each box has a small uppercase caption (JOB / CREW / DATE) and the value in large bold type. The value should be the biggest text on the page: target ~20px for Job, ~18px for Crew and Date, against the sheet's 11px body. Job gets the widest box (it is the longest string); Crew and Date can be narrower and fixed-width.
- **A blank value prints an empty box, not the word "Unassigned".** This sheet is a fillable paper form (see the `.wo-banner` copy and the empty `Location:` / `Moisture vapor barrier:` cells that already exist by design). An unscheduled job's crew and date get written in by hand. Give an empty box enough height to write in.
- The header must stay ONE page-line tall. The work order is length-sensitive; if the three boxes plus logo push the materials table onto page 2, shrink the boxes, do not accept the overflow.
- Then delete the `Crew:`, `Date:`, and `Job Name:` label/value pairs from the `.intake` Job Identity group. **The grid pairs two label/value sets per row, so removing three pairs leaves five, which is 2.5 rows.** Rebalance so the remaining pairs (DJ #, Address, Location, Gate Code#, Phone) land in the right columns; add one empty `<div class="lbl"></div><div class="val"></div>` pair if that is what keeps the grid even. Do not leave a half row.
- `Address` and `Phone` stay in the small grid. Do not promote them.

Nothing else on the sheet changes. Print it and confirm the page count did not grow.

Commit: `workorder: job / crew / date as large header boxes, drop the duplicated small rows`

---

## Part B. Product data sheets (first Supabase Storage code in the app)

### What exists, and what does not

- `pec_prod_products` (181 rows) is documented in SCHEMA.md:1383. Its only file-ish column is `image_url text`, a **pasted URL**, whose label in the product modal literally reads "(paste a URL; uploads coming later)" (index.html:33862).
- There is **zero** Supabase Storage code in index.html. `grep -n "storage\.from(" index.html` returns nothing.
- One bucket exists in prod: `pec-photos`, public, created 2026-04-26, no size limit, no MIME restriction. It is not referenced from this repo (CompanyCam photos come through `pec-companycam.cjs`). **Do not reuse it.**
- The products list renders at `renderProducts(host)` index.html:33697, with the image chip cell at index.html:33738. The edit modal is `openProductModal(productId)` index.html:33792, its field block runs to ~33870, and its save payload is index.html:33930-33942.
- The product modal is a hand-rolled `#prodModalRoot` flow, NOT the `openModal()` helper. See the Architecture Gotchas section of CLAUDE.md before you touch its lifecycle.

### Schema

New migration `supabase/migrations/2026-07-28_product_datasheets.sql`, with the `@artifacts` header per standing rule 13. **You write it, Cowork applies it** (standing rule 8), then Cowork refreshes SCHEMA.md.

It must:

1. Add two columns to `pec_prod_products`. Store the **storage object path**, not the URL, so a file can be replaced or deleted later and so the public base URL is never baked into rows:

   ```sql
   alter table public.pec_prod_products
     add column if not exists datasheet_path text,   -- TDS, the product data sheet
     add column if not exists msds_path      text;   -- MSDS / SDS
   ```

   Build the browser-facing URL with `supabase.storage.from('pec-datasheets').getPublicUrl(path)`. Never store a full URL in these columns.

2. Create the bucket and its policies **in SQL** (`storage.buckets` insert plus `storage.objects` policies), so the migration is the record of it and a fresh database replay reproduces it. Do not ask Cowork to click it into being in Supabase Studio.

   - Bucket id `pec-datasheets`, `public = true`.
   - `file_size_limit` set from the settings key below (hardcode the same number in the bucket; the setting is what the UI enforces and what Dylan tunes).
   - `allowed_mime_types = ARRAY['application/pdf']`.
   - Policies on `storage.objects` for `bucket_id = 'pec-datasheets'`: SELECT to `public` (that is the point of a public bucket), and INSERT / UPDATE / DELETE gated on the same staff check the rest of the app uses. Match the existing helper (`is_admin_staff()` or whatever the current catalog policies use, check `supabase/` first, there are ~206 references to these helpers). Catalog editing is already gated by `user_permissions.can_edit_catalog` in the UI, so the storage policy should not be looser than that.

3. Add one settings key per standing rule 12: `datasheet_max_upload_mb`, default `10`.

### UI

**Product modal** (index.html ~33860, next to the image URL field): a "Data sheets" field group with two rows, "Data sheet (TDS)" and "MSDS / SDS". Each row shows either:

- attached: the filename, a View link (opens the public URL in a new tab), and a Replace and a Remove control; or
- empty: a `<input type="file" accept="application/pdf">`.

Rules:

- **Upload on file pick, not on Save.** A new product has no id yet, so name the object with `crypto.randomUUID() + '.pdf'` rather than the product id. That makes the upload independent of whether the product row exists, and makes Replace a plain new upload plus a delete of the old path.
- Enforce `datasheet_max_upload_mb` and `application/pdf` client-side before the upload call, with a clear inline error in the existing `#pmError` element. The bucket enforces it again server-side; do not rely on only one of the two.
- Show a disabled/uploading state on the row while it is in flight. Do not let Save fire mid-upload.
- Remove deletes the storage object AND nulls the column. If the storage delete fails but the column update succeeded, log it and move on: an orphaned object is a cleanup problem, a dangling path is a broken link.
- Add `datasheet_path` and `msds_path` to the save payload at index.html:33930.
- While you are in this field block, fix the now-wrong hint on the image field: it says "uploads coming later" (index.html:33862). The image field stays a URL in this build; reword it so it does not promise something this prompt did not deliver.

**Product list row** (index.html ~33738): a compact cell with a `TDS` and an `SDS` chip. Attached chips are links that open the PDF; missing ones are dimmed and non-clickable. No new column header text longer than "Sheets".

**Job detail button** (next to `#pecJobPrintWO`, index.html:13717): a `Data sheets` button that opens a modal listing every product in this job's material plan, each with its TDS and SDS links.

- Reuse the material plan `renderWorkOrder` already computes (`productById`, `recipeSlots`, the calculator call in the same function) rather than inventing a second resolution path. If that means extracting a small helper out of `renderWorkOrder`, do it, and say so in the log entry.
- **The button renders only when at least one product on the job has a sheet attached.** Dylan asked for it to be "not always visible". A job whose materials have no sheets shows no button at all, not a disabled one and not an empty modal.
- This modal goes through `openModal()` / `#pecModalRoot` (job detail is the `pec-modal-bg` side of the two-root split), not `#prodModalRoot`.

### Standing rules that apply

- Standing rule 11: this is user-facing, so append a What's New entry to `help/whats-new.json`. Plain language, no em dashes.
- Standing rule 9: update the features.json entry for the catalog (and add one for data sheets if the shape warrants it).
- Standing rule 12: `datasheet_max_upload_mb` must be editable from company Settings, not just present in the table. Put it wherever the catalog-adjacent knobs already live.

Commit each of: migration, catalog UI, job-detail surface.

---

## Part C. The table scroll fix (this one is a real, named bug)

`.pec-table-wrap` **has no global CSS rule.** The only definition in the file is scoped to a modal:

```
index.html:31394:  .prod-modal-wide .pec-table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch }
```

`.pec-table-wrap` is used 15 times. Outside `.prod-modal-wide` it is an ordinary `<div>` with no overflow behavior at all, so a table wider than its card does not scroll, it runs off the page. Settings > Users is the worst case because it renders 12 columns: Name, Email, Role, Linked Auth, five delegable permission checkboxes, Finalize costing, Actions (`colCount` is computed at index.html:17884 and the table starts at index.html:17898).

Fix: add a real global rule next to the other `.pec-table` rules at index.html:479-485.

```css
.pec-table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
```

Then:

- Delete the now-redundant `.prod-modal-wide .pec-table-wrap` rule at index.html:31394, or leave it and say why in the log entry. Do not leave both silently.
- Verify at a ~1300px viewport that Settings > Users scrolls horizontally inside its card instead of pushing the page. The page itself should stop overflowing.
- Check that no table inside a `.pec-table-wrap` relies on visible overflow (a dropdown, a tooltip, a sticky header that now clips). If one does, name it in the log entry rather than silently leaving it broken.
- Optional, only if trivial: the "Recent sign-ins" table on the same page (index.html ~17932) has no `.pec-table-wrap` at all. Wrapping it is a one-line change. Dylan chose the global-rule option, not the full straggler audit, so do this one or skip it, but do not go hunting for the other thirteen.

This is CSS only. No migration, no What's New entry (standing rule 11 excludes changes with no visible new behavior; a table that stops clipping is arguably visible, use your judgement and default to no entry).

Commit: `css: global .pec-table-wrap overflow so wide tables scroll instead of clipping`

---

## Guardrails

- Do not touch `admin_users`, `user_permissions`, `pec_sales_team_members`, `pec_prod_crews`, or `pec_prod_crew_members`. Those belong to prompt 54.
- Do not change `image_url` behavior. It stays a pasted URL in this build.
- Do not reuse or modify the `pec-photos` bucket.
- Do not put the storage bucket's creation in a Cowork handoff. It goes in the migration.
- The work order and the job-detail modal live on opposite sides of the two-modal-root split. Read the Architecture Gotchas section before touching either lifecycle.
- Never commit a credential. The storage calls use the existing anon client and the user's JWT; there is no new secret in this prompt.

## Preflight

- `npm test` green before you start and before every commit.
- `grep -n "storage.from(" index.html` should return only your new calls when you are done.
- Print a work order for a scheduled job AND an unscheduled one. The second is the one that proves the empty-box behavior.
- Open a product with no sheets, attach one, replace it, remove it. Then confirm the product list chip state matches.

## Handoffs

Write a `## Handoff to Cowork` section in the PROJECT-LOG entry covering: apply `2026-07-28_product_datasheets.sql` to prod (zdfpzmmrgotynrwkeakd), confirm the `pec-datasheets` bucket exists and is public with the PDF MIME restriction, confirm the storage policies, and regenerate SCHEMA.md (which is currently 79 documented of 80 live; `pec_invoice_installments` is the known undocumented one, and adding its section while in there would close that gap).
