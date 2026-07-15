# Build Prompt 23 (Phase 1 of 3): Estimator customer/company/address restructure + Google address autocomplete

This is Phase 1 of a 3-phase "fine-tune the estimator" effort Dylan scoped with Cowork on 2026-07-15. Phase 1 (this prompt) reworks the customer identity and address capture. Phase 2 (custom estimate mode) and Phase 3 (live in-module AI proposal writer) are separate prompts that build on the fields you land here. Do ONLY Phase 1. Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first, per standing rules.

## Context

The estimator is a separate React/TS PWA (source: `apps/estimator/src`, built into `/estimator/`), opened as an iframe from the dashboard. Today it captures the customer as a single combined `name` and a single combined `address` string (`apps/estimator/src/features/estimator/EstimatorScreen.tsx:178-183`, JSX at `:955-958`), persists them to the `estimates` table as `customer_name` / `customer_phone` / `customer_email` / `customer_address` (`apps/estimator/src/offline/estimates.ts:77, 130-133`), and reloads them the same way (`apps/estimator/src/lib/estimateLoad.ts:32, 49, 102-106`). The `leads` table already splits address into `address,city,state,zip` and has `full_name` (`apps/estimator/src/lib/lead.ts:52, 60-70`).

Downstream readers of `customer_name` / `customer_address` that must not break: the customer-facing proposal page "Prepared for" block and the customer/accepted-job writes in `netlify/functions/pec-public-estimate.cjs` (`:418, :721-746, :760, :837-838`), the estimate PDF (`index.html:8976-8978`, `pecDownloadEstimatePdf`), and the estimate detail/list in `index.html` (`renderEstimateDetail` ~`:17546`, select ~`:17550`). Note `pec_prod_jobs` ALREADY has a `customer_company` column (`index.html:9580` reads `row.customer_company`), so pushing a company name through to the accepted job is a real, existing target, not new.

Dylan's decisions (locked, from a 12-question dig; do not re-litigate):
- Name model is a RESIDENTIAL / COMMERCIAL toggle at the top of the customer card. Residential shows First name + Last name. Commercial shows Company name (required) + an optional contact person (first/last). "Commercial" is defined as "has a company name" — so the toggle and the company field are two views of the same fact.
- Address fields: Address 1, Address 2 (suite/unit), City, State, Zip — each its own column.
- Google address autocomplete on Address 1: selecting a suggestion auto-fills street, city, state, AND zip. Every field stays hand-editable after.
- Downstream readers are reworked to use the split fields, AND `customer_name` / `customer_address` stay auto-composed from the split fields as a safety net (see Task 4). Belt and suspenders: rework the readers, keep the composed columns populated so nothing can silently render blank.
- Existing rows get a conservative, reversible backfill (Task 6): populate the new fields best-effort, never overwrite the original combined `customer_name` / `customer_address`.

## Tasks

Take these in order. Commit per feature per standing rules (suggest one commit for the migration+backfill, one for the estimator UI, one for downstream readers, plus the docs commit).

### Task 1 — Migration: add split columns to `estimates` (WRITE it, do NOT apply it)
Create `supabase/migrations/2026-07-15_estimate_customer_fields.sql`. Additive and idempotent (`ADD COLUMN IF NOT EXISTS`). Add to `public.estimates`:
- `customer_first_name text`
- `customer_last_name text`
- `customer_company text`
- `customer_is_commercial boolean` (nullable; the toggle's stored value. Deriving from company alone is fine too, but store it so an intentional commercial-under-a-person's-name is possible later without a migration.)
- `customer_address1 text`
- `customer_address2 text`
- `customer_city text`
- `customer_state text`
- `customer_zip text`

Keep the existing `customer_name` and `customer_address` columns; they become the composed safety-net (Task 4). Do NOT apply this to prod from your session (do-not-touch-prod rule). It goes in the Cowork handoff at the bottom.

### Task 2 — Estimator form: toggle + split name + company + split address
In `apps/estimator/src/features/estimator/EstimatorScreen.tsx`:
- Replace the `customer` state shape (`:178-183`) with `{ isCommercial: boolean; firstName; lastName; company; phone; email; address1; address2; city; state; zip }`. Prefill from `editing?.customer` (extend the loaded shape, Task 5) then `leadLink` (the lead link already exposes split address via `leads.address/city/state/zip`; extend `LeadLink` in `apps/estimator/src/lib/lead.ts` to carry them separately instead of pre-joining at `:66`).
- Replace the customer JSX (`:955-958`) with: a Residential/Commercial toggle; when Residential, First name + Last name inputs; when Commercial, Company name (required to save) + optional contact First/Last; then Phone, Email; then Address 1 (with autocomplete, Task 3), Address 2, City, State, Zip. `isCommercial` follows the toggle; also treat a non-empty company as commercial so the two never disagree.
- Update the save payload (`:730` region and `apps/estimator/src/offline/estimates.ts:77, 128-133`) to persist all new fields, and compose `customer_name` + `customer_address` (Task 4) so offline saves carry the safety-net values too.
- `canSave` (`EstimatorScreen.tsx:629`): require a last name (residential) OR a company (commercial). Do not over-gate the address.

### Task 3 — Google Places autocomplete on Address 1
The repo has NO Google Maps/Places key today (confirmed). Add a Places Autocomplete to the Address 1 input that, on selection, fills `address1` (street number + route), `city`, `state` (short code), `zip`. Prefer the current Places API (`PlaceAutocompleteElement` / Autocomplete Data API) over the deprecated widget. Load the Maps JS script with `loading=async`. Put the key in a build-time env var for the estimator (`VITE_GOOGLE_MAPS_KEY`) with a safe fallback: if the key is absent the Address 1 field degrades to a plain text input (autocomplete is an enhancement, never a gate — the estimator runs offline at job sites, where autocomplete cannot work anyway, so it MUST stay fully usable typed by hand). Per CLAUDE.md standing rule 7, a domain-restricted client key committed to client code is acceptable ONLY if it is HTTP-referrer restricted AND API restricted AND added to `SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES` in `netlify.toml`. Since neither the key nor its restriction exist yet, DO NOT hardcode a key: wire the code + fallback, and put "create + restrict the key, set `VITE_GOOGLE_MAPS_KEY`, add it to netlify.toml omit list" in the Cowork/Dylan handoff.

### Task 4 — Compose the safety-net columns
Add one small helper (estimator side, and mirror server-side in `pec-public-estimate.cjs` if it writes these) that composes:
- `customer_name` = company when commercial (optionally `"Company (Contact First Last)"` when a contact is present), else `"First Last"` trimmed.
- `customer_address` = `[address1, address2, city, state, zip].filter(Boolean).join(', ')`.
Write these on every save so the old columns are always current. This is what makes "rework downstream" safe: even a reader you miss keeps working.

### Task 5 — Reload path
Extend `apps/estimator/src/lib/estimateLoad.ts` (`:32, :49, :102-106`) to select and map all new columns into the editing shape so re-opening an estimate repopulates the toggle, split name, company, and split address (not the composed fallback).

### Task 6 — Conservative, reversible backfill (WRITE it, do NOT run it)
Add a second migration `supabase/migrations/2026-07-15_estimate_customer_backfill.sql` that, for rows where the new fields are null:
- Names: naive split of `customer_name` — first whitespace token → `customer_first_name`, remainder → `customer_last_name`. Do NOT guess company vs person; leave `customer_company` and `customer_is_commercial` null for backfilled rows (Dylan spot-checks). NEVER modify the original `customer_name`.
- Address: split `customer_address` on commas — first part → `customer_address1`, and if there are 3+ parts map the trailing "City, ST Zip" shape where it cleanly matches, else leave city/state/zip null. NEVER modify the original `customer_address`.
Make it idempotent (guard on `customer_first_name is null`, etc.) so re-running is safe. This is a Cowork handoff, not run from your session.

### Task 7 — Downstream readers
Rework the human/proposal-facing readers to prefer the split fields, falling back to the composed columns:
- `netlify/functions/pec-public-estimate.cjs`: the "Prepared for" block (`:418`) should show company (bold) with contact/address below when commercial, else name + address; the accepted-job write (`:837-838`) should pass `customer_company` through to `pec_prod_jobs` (column exists) and keep writing `customer_name`/`address` from the composed values.
- `index.html` estimate detail/list and `pecDownloadEstimatePdf`: read the composed `customer_name`/`customer_address` (already correct) but show company prominently where a commercial estimate is displayed. Keep changes minimal here; the composed columns mean these mostly keep working unchanged.

### Guardrails — do NOT touch
- The pricing engine, comps, and the existing price-recommendation AI (`apps/estimator/src/lib/ai.ts`, `pec-estimate-ai`). Out of scope for Phase 1.
- The scope writer (`pec-estimate-scope`, `triggerScope`) and scope questions. That's Phase 3.
- System-type / custom-system flow. That's Phase 2.
- Do not apply either migration or run the backfill from your session. Do not push to remote.
- No em dashes in any output (standing rule 6).

## Verification
- `npm test` green (no engine change expected).
- `node --check` passes on every touched `.cjs`; the estimator builds (`npm run build` in `apps/estimator`, or the repo's build script).
- Manual: new estimate as Residential (first/last) saves and reopens with the toggle + fields intact; switch to Commercial, company required, saves, `customer_name` composes to the company; Address 1 autocomplete fills city/state/zip when a key is present and degrades to plain text when absent; the proposal "Prepared for" block renders company for a commercial estimate.
- What's New entry appended to `help/whats-new.json` (user-facing change): id, date 2026-07-15, title like "Estimator: separate name, company, and address fields", 2-3 plain-language how-to steps, no em dashes.

## After (Cowork handoff)
1. Apply `supabase/migrations/2026-07-15_estimate_customer_fields.sql` to PROD (project "HQ Dashboard", zdfpzmmrgotynrwkeakd). Capture in the log: `select column_name from information_schema.columns where table_name='estimates' and column_name like 'customer_%';` (expect the 9 new columns present alongside the old two).
2. Then apply `supabase/migrations/2026-07-15_estimate_customer_backfill.sql`. Capture a before/after count of rows where `customer_first_name is not null`.
3. Google key: create a browser key in Google Cloud, enable Maps JavaScript API + Places API, restrict it by HTTP referrer to the Netlify domain(s), set `VITE_GOOGLE_MAPS_KEY` for the estimator build, and add the key value to `SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES` in `netlify.toml`. This is the only thing blocking autocomplete; everything else works without it.
4. Report back to Dylan: migrations applied, backfill row count, and whether the key is live.
