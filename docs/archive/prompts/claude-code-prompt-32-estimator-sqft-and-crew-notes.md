# Build Prompt 32: Estimator square footage for custom jobs + crew notes on the work order

Two related estimator upgrades Dylan asked for together. Follow the startup procedure: read CLAUDE.md and the last 3 PROJECT-LOG.md entries first, then confirm the most recent entry date and current state in one sentence before touching code.

Per CLAUDE.md rules 9 and 10: navigate with features.json anchors plus grep, and verify every column against SCHEMA.md before writing SQL or a supabase-js select. The relevant features.json entries are "Custom estimate mode", "Customer-facing estimate (send, sign, accept)", "Auto-written scope of work", and "Job costing". The index.html line numbers below are from a 2026-07-18 snapshot taken BEFORE the context/token overhaul commit (which did not touch index.html), so they should still be accurate, but confirm each by function name and grep rather than trusting the number, and say so in the log if anything drifted.

Two independent parts. Commit per part (Part A one commit, Part B one commit) plus the docs commit, so either part can be reverted alone.

## Background (verified against the code and SCHEMA.md, 2026-07-18)

- Custom estimate mode already ships (features.json "Custom estimate mode"). In `EstimatorScreen.tsx`: `isCustom` state (~`:264`), the Custom result card with the typed Price input (~`:1594-1624`), the save payload composing one `CUSTOM_LINE_LABEL` line (~`:955-968`), and the load mapping (`estimateLoad.ts` ~`:170-172`). A custom estimate persists NO area rows, so it has no square footage anywhere today.
- SCHEMA.md truth (confirm before your migration): `public.estimates` has `is_custom`, `custom_scope`, `custom_price`, `scope_of_work` but NO `custom_sqft` and NO `crew_notes`. `public.jobs` already has `sqft` (type TEXT, not numeric) and `scope` (text), but NO `crew_notes`.
- Square footage plumbing for STANDARD jobs already exists. `jobs.sqft` (text) is the manual field edited by `#jobSqft` on the job header (`index.html` ~`:12131`). `jobEffectiveSqft(jobSqft, areaSqftList)` (~`:8542`) returns the manual `jobs.sqft` when > 0, else the sum of estimate-area sqft. The job header $/sqft chip uses it (~`:12086-12087`).
- BUT the Job Costing screen's "$ / sqft" readout (the one in Dylan's screenshot, feature "Job costing", `renderJobCosting` / the unified job render, ~`index.html:23051-23063`) computes sqft from AREAS ONLY (`areas.reduce(...)` ~`:23055`) and ignores the manual `jobs.sqft`. That is why a job with no estimate areas shows "— (no sqft on file)".
- The work order (`renderWorkOrder`, ~`index.html:11608`) prints Sqft (~`:11844`) from `totalSqft` (~`:11676`), also AREAS ONLY, so a custom / area-less job prints a blank Sqft. Its "ISSUES / NOTES" box (~`:11855`) renders `sanitizeNotes(job.scope)`, the customer-facing scope, not a crew summary. There is no crew-notes field today.
- The job is created from an accepted estimate SERVER-SIDE (`netlify/functions/pec-public-estimate.cjs`; feature "Customer-facing estimate (send, sign, accept)" says accepting creates the job on both the Jobs page and the Job Schedule with areas and work-order details carried over), and also by the DripJobs proposal-accepted webhook (`pec-webhook-proposal-accepted.cjs`). The estimator does NOT create the job, so anything that must reach the job (sqft, crew notes) has to be carried by these functions from the estimate row.
- Two job tables (CLAUDE.md gotcha): `public.jobs` (+`public.customers`) drives the Jobs page, job detail, and work order; `public.pec_prod_jobs` (+`pec_prod_areas`, schedule, crews) drives the Job Schedule and costing calendar. `jobs.sqft` and the new `jobs.crew_notes` live on `public.jobs`. Before wiring any readout, confirm in SCHEMA.md which table the surface you are editing actually reads, and whether `job.sqft` / `job.crew_notes` is in scope in that render; do not assume the two tables share a row shape.

---

## PART A: Square footage + price per sqft for custom estimates

Goal: on a custom estimate, let Dylan type the square footage so the estimator shows a live price-per-sqft, and so that number carries to the job and lights up the existing "$ / sqft" readouts (Job Costing screen + work order) that are blank today.

Locked decisions (Dylan):
- Direction is PRICE + SQFT to a READOUT. Dylan types the total price (already there) and the square footage; the estimator shows a read-only "$X.XX / sqft". Do NOT multiply a rate to compute the price; the price stays the typed number.
- Custom path drives the new INPUT. Standard estimates already carry area sqft, so they get no new input; they only benefit from the Job-Costing and work-order fixes below, which start honoring the manual `jobs.sqft` as a fallback.

### A1 - Migration (WRITE, do NOT apply)
`supabase/migrations/2026-07-18_estimate_custom_sqft.sql`, additive/idempotent:
- `ALTER TABLE public.estimates ADD COLUMN IF NOT EXISTS custom_sqft numeric;`
`public.jobs.sqft` ALREADY EXISTS as text (SCHEMA.md) and needs no migration. Goes in the Cowork handoff, not applied from your session.

### A2 - Estimator custom input + readout
In `EstimatorScreen.tsx`, in the Custom result card (~`:1594-1624`, right by the Price input ~`:1603-1605`):
- Add a `customSqft` string state (same shape as `areas[].sqft`; prefill from `editing?.customSqft`). Numeric input, optional.
- Show a read-only "$X.XX / sqft" line computed as `customPrice / customSqft` when both are > 0; render nothing (or a muted dash) when either is missing. Reuse the existing money formatting helpers. Do NOT gate save on it; sqft is optional.
- Custom-only: render this input only when `isCustom`.

### A3 - Persist + load
- Save payload (the `performSave` custom branch, ~`:1120`): persist `custom_sqft` as a number or null on the estimate row.
- `estimateLoad.ts` (the `LoadedEstimate` type ~`:56-58` and the mapping ~`:170-172`): select and map `custom_sqft` to a `customSqft` string so reopening a custom estimate restores it.
- `offline/estimates.ts`: include `custom_sqft` in the row the outbox upserts so an offline-created custom estimate keeps its sqft on sync.

### A4 - Carry sqft to the job on accept
In `pec-public-estimate.cjs` (the accept-to-job creator): when the accepted estimate `is_custom` and has `custom_sqft`, write it into the created `public.jobs.sqft`. Note `jobs.sqft` is TEXT, so write the number AS A STRING. For a standard estimate leave `jobs.sqft` null (the areas sum already drives $/sqft; the manual field stays a backfill override). If the DripJobs webhook path (`pec-webhook-proposal-accepted.cjs`) also has the estimate in hand, do the same there; if not, leave it null. `node --check` any `.cjs` you touch.

### A5 - Job Costing $/sqft honors manual sqft
In the Job Costing / unified job readout (~`index.html:23055`): change `totalSqft` to use `jobEffectiveSqft(job.sqft, areas.map(a => a.sqft))` instead of the area-only sum, so a custom job (jobs.sqft set, no areas) shows a real $/sqft, as does any manually-backfilled standard job. First confirm `job.sqft` (public.jobs) is available in that render's `job` object; if that surface reads `pec_prod_jobs` (which per SCHEMA.md has no sqft), pull the public.jobs value it needs rather than inventing one. Keep the "— (no sqft on file)" fallback when effective sqft is still 0; never fabricate a number.

### A6 - Work order prints custom sqft
In `renderWorkOrder` (~`index.html:11676`): make the printed Sqft fall back to `job.sqft` (via `jobEffectiveSqft`) when the area sum is 0, so a custom job prints its sqft. Leave standard jobs unchanged (area sum still wins).

---

## PART B: Crew notes (cliff notes + watch-outs) on the estimator and the work order

Goal: give the crew a short, crew-focused summary that rides on the work order, separate from the customer scope. Dylan can type it, or have AI draft it from the proposal.

Locked decisions (Dylan):
- BOTH a manual field AND an AI "Generate from proposal" button. The button drafts; Dylan can edit or type from scratch. Manual editing always wins.
- Available on BOTH standard and custom estimates (every job has a crew).
- Crew notes are INTERNAL: they print on the crew work order only, and must NEVER appear on the customer proposal, the customer estimate page, the PDF the customer sees, or any customer-facing surface.
- AI trigger is MANUAL only (a button), never automatic, never on keystroke.

### B1 - Migration (WRITE, do NOT apply)
`supabase/migrations/2026-07-18_crew_notes.sql`, additive/idempotent:
- `ALTER TABLE public.estimates ADD COLUMN IF NOT EXISTS crew_notes text;`
- `ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS crew_notes text;`
Goes in the Cowork handoff.

### B2 - Estimator crew-notes field + AI button
In `EstimatorScreen.tsx`, add a "Crew notes (internal)" card, visible in both modes:
- A textarea bound to a `crewNotes` string state (prefill from `editing?.crewNotes`).
- A "Generate from proposal" button (disabled offline or when there is nothing to summarize). It calls the new endpoint (B3) with this estimate's assembled scope/proposal plus its facts, and replaces the textarea with the draft. Keep the pre-generate text so an Undo is possible, mirroring the custom-mode "Undo polish" pattern (~`:1350-1352`).
- Hint line: "Only the crew sees this; it prints on the work order, never on the customer proposal."
- If the textarea was hand-edited, a later Generate asks before overwriting (a simple confirm is enough).

### B3 - AI endpoint
New `netlify/functions/pec-estimate-crew-notes.cjs`, reusing the auth + `textFromMessage` pattern from `pec-estimate-ai.cjs` / `pec-estimate-scope.cjs`. Input: the estimate's assembled scope (or the custom typed scope) plus site facts already on the estimate (gate code, moisture, mohs, stem walls, coat-past-garage, additional non-slip, special notes, add-on lines, sqft, system type). Output: a SHORT crew brief in two labeled parts, "Cliff notes" (what the job is, a few lines) and "Watch out for" (access, prep, site conditions, customer-specific asks, anything unusual).
- This is a SUMMARY, so unlike the customer scope it MAY condense and rephrase. It must NOT invent facts, warranties, cure times, or numbers not in the input; if a fact is absent, leave it out. It is internal, so it does not need the customer-scope verbatim exclusion/cure-time discipline, but keep the never-fabricate rule.
- Keep it short (crew reads it on a printed sheet): tight bullet-style lines, not paragraphs.
- `node --check` the file.

### B4 - Persist + load + carry to job
- Save payload: persist `crew_notes` on the estimate (both modes).
- `estimateLoad.ts` + `offline/estimates.ts`: map `crew_notes` in and out (add `crewNotes` to `LoadedEstimate`).
- `pec-public-estimate.cjs` (accept-to-job): copy `estimates.crew_notes` into `jobs.crew_notes`, same place Part A writes sqft. Same in `pec-webhook-proposal-accepted.cjs` only if that path has an estimate to read; if the webhook job has no estimate, leave `jobs.crew_notes` null (Dylan fills it on the job page, B5).

### B5 - Editable on the job page (Job Card block)
In the "Job Card" block (~`index.html:12184-12223`, the fields that print onto the work order), add a "Crew notes" textarea bound to `job.crew_notes`, saved through the same `saveJob` path as `#jobScope` (~`:13347`). Label it "internal, prints on the work order". This lets Dylan tweak crew notes per job after accept.

### B6 - Work order section
In `renderWorkOrder` (~`index.html:11853-11856`), add a NEW section "CREW NOTES" (or "CLIFF NOTES / WATCH-OUTS") rendering `sanitizeNotes(job.crew_notes)`, near the ISSUES / NOTES box. Render it only when `job.crew_notes` is non-empty (no empty box). Do NOT replace the existing ISSUES / NOTES box (that stays `job.scope`).

---

## Guardrails (both parts)
- Do NOT touch the customer-facing scope assembly discipline in `pec-estimate-scope.cjs` (verbatim templates, never-overwrite/force). Crew notes are a separate internal field with their own endpoint.
- Do NOT change the standard pricing engine, comps, or price-recommendation AI. Part A adds a display plus a stored number only.
- Do NOT apply either migration and do NOT push to remote.
- Em dashes: none in customer-facing text (the two What's New entries especially, per CLAUDE.md rule 6). Code, comments, and the crew work order are internal, but keep the crew notes clean anyway.
- Crew notes never render on any customer surface. Double-check `pec-public-estimate.cjs`, the customer estimate page, and the customer PDF do not read `crew_notes`.

## Verification
- `npm test` green (calculator + estimate suites); `node --check` on both `.cjs` files; estimator builds (`tsc` + `vite`); all inline `index.html` script blocks parse (module-aware `node --check`); `help/whats-new.json` validates; no em dashes in customer-facing text in the diff.
- Manual A: custom estimate, type price + sqft, see the live "$/sqft"; save, reopen, sqft intact; accept it and confirm the job header chip AND the Job Costing "$ / sqft" both show the number (no longer "no sqft on file"); the work order prints the sqft.
- Manual B: on a standard and a custom estimate, type crew notes and also try "Generate from proposal" (confirm it drafts from the real proposal, invents nothing, is undoable); save, reopen, notes intact; accept and confirm the work order shows a "Crew notes" section and the customer proposal / PDF do NOT; edit crew notes on the job page and reprint the work order to confirm the change.
- Two What's New entries in `help/whats-new.json` (newest first, plain language, no em dashes): one for custom-job square footage / price per sqft, one for crew notes on the work order.

## After (Cowork handoff)
1. Apply BOTH migrations to PROD (project "HQ Dashboard", zdfpzmmrgotynrwkeakd): `2026-07-18_estimate_custom_sqft.sql` and `2026-07-18_crew_notes.sql`. Capture: `select table_name, column_name from information_schema.columns where (table_name='estimates' and column_name in ('custom_sqft','crew_notes')) or (table_name='jobs' and column_name='crew_notes');` (expect estimates.custom_sqft, estimates.crew_notes, jobs.crew_notes).
2. Regenerate SCHEMA.md from the live schema (CLAUDE.md rule 9) so the three new columns are reflected.
3. Report to Dylan: migrations applied, and confirm end to end on a test custom estimate (sqft shows on Job Costing + work order) and a test crew-notes generate (prints on the work order, absent from the customer proposal/PDF).
