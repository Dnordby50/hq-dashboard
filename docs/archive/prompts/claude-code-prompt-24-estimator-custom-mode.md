# Build Prompt 24 (Phase 2 of 3): Estimator "Custom estimate" mode

Phase 2 of the estimator fine-tune. Do this ONLY AFTER Phase 1 (prompt 23, customer/company/address fields) has shipped and its migrations are applied, because the save/reload paths you touch here are the same ones Phase 1 restructured. Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first. If the customer-field column names below have drifted from what Phase 1 actually landed, use the landed names.

## Context

The estimator (React/TS PWA, `apps/estimator/src`, built to `/estimator/`) prices every estimate through the material/sqft engine: `pricing` comes from `computeEstimatePricing`, `hasPrice = !!pricing && pricing.price != null` (`EstimatorScreen.tsx:368`), and the sell price is either that computed number or a manual override (`priceOverride: 'sell' | 'disc'`, `sellInput`/`discInput`, `finalSell` at `:372-400`). `canSave` (`:629`) requires a price and complete areas/add-ons. This works for the standard systems (Flake, etc.) but forces every estimate through system-type areas and material recipes.

Dylan wants a distinct path for one-off jobs the shop does not do often, where forcing the material calculator is wrong. His locked decisions (from the dig):
- A SEPARATE "Custom estimate" MODE: a toggle/button at the top of the estimator that turns the WHOLE estimate custom, not a system-type option inside the normal area flow.
- Pricing: MANUAL price typed directly, with the calculator OPTIONAL (available if he wants it, but not required).
- Scope: he TYPES the scope/proposal himself in a free-text box; the AI does not author it. An OPTIONAL "Polish with AI" button cleans his typed text into proposal language (he can skip it).

## Tasks

Commit per feature per standing rules. Suggest: one commit for the schema + save/reload, one for the custom-mode UI, plus the docs commit.

### Task 1 — Migration (WRITE, do NOT apply)
`supabase/migrations/2026-07-16_estimate_custom_mode.sql`, additive/idempotent (`ADD COLUMN IF NOT EXISTS`) on `public.estimates`:
- `is_custom boolean default false`
- `custom_scope text` (Dylan's typed scope/proposal for a custom estimate)
- `custom_price numeric` (the manually typed sell price for a custom estimate)

Do NOT apply from your session. It goes in the Cowork handoff.

### Task 2 — Custom mode toggle + UI
In `EstimatorScreen.tsx`:
- Add `isCustom` state (prefill from `editing?.isCustom`). Put a clear toggle at the top of the estimator (near the customer card), e.g. "Standard estimate / Custom estimate". Default Standard, so nothing changes for the normal flow.
- When Custom is ON:
  - HIDE the areas/systems section and the "Finish the scope" questions (they are template-driven and do not apply).
  - SHOW a large free-text "Scope of work" textarea bound to `custom_scope`, and an OPTIONAL "Polish with AI" button next to it (Task 4).
  - SHOW a single manual "Price" input bound to `custom_price`. This is the sell price directly; do NOT route it through the material engine.
  - Keep the customer card, salesperson, and add-ons/one-offs available (a custom job can still have add-on lines).
- When Custom is OFF: the estimator behaves exactly as today. This toggle must be a clean branch, not a rewrite of the standard path.

### Task 3 — Price + save gating for custom mode
- Introduce a `sellPrice` that is `custom_price` when `isCustom`, else the existing `finalSell`. Do NOT make custom pricing depend on `pricing`/`hasPrice` (there is no calculated base in custom mode). Guard the existing `finalSell`/`applySellPrice`/GP math so it does not run (or divides-by-zero) when `pricing` is null in custom mode; GP/commission can be computed off the typed price and cost if available, else shown as not-applicable rather than blocking save.
- `canSave` in custom mode: require a customer (last name or company, per Phase 1) + a `custom_price > 0`. Do NOT require areas, materials, or a calculated price.
- Save payload (`EstimatorScreen.tsx:730` region + `apps/estimator/src/offline/estimates.ts`): persist `is_custom`, `custom_scope`, `custom_price`. Compose the standard downstream fields so the rest of the app keeps working: write `custom_price` into the estimate's price/total columns the standard path uses (so the estimate list, PDF, and accept-to-job flow read the right number), and write `custom_scope` into `scope_of_work` (the column the accept path already copies to `jobs.scope`) so a custom estimate produces a proposal with no special-casing downstream. A custom estimate with no priced areas should create at least one line item carrying the price + scope so `pec-public-estimate` and the PDF render a row.

### Task 4 — "Polish with AI" (optional)
Add a serverless endpoint (new `netlify/functions/pec-estimate-custom-polish.cjs`, or a `mode: 'polish'` branch in the existing `pec-estimate-scope.cjs`) that takes Dylan's typed `custom_scope` and returns a cleaned, proposal-ready version. This is POLISH, not authorship: instruct the model to preserve his meaning, exclusions, and any dollar figures verbatim, fix grammar/structure/formatting only, and never invent scope, warranties, or cure-time claims (same discipline as `pec-estimate-scope.cjs`, see its header comment). Reuse the auth + `textFromMessage` pattern from `pec-estimate-ai.cjs`/`pec-estimate-scope.cjs`. The button replaces the textarea contents with the polished text and is fully undoable (keep the original so he can revert); it never fires automatically.

### Task 5 — Reload path
Extend `apps/estimator/src/lib/estimateLoad.ts` to select and map `is_custom`, `custom_scope`, `custom_price` so reopening a custom estimate restores custom mode, the typed scope, and the price.

### Guardrails — do NOT touch
- The standard pricing engine, comps, and price-recommendation AI. Custom mode branches AROUND them, it does not modify them.
- The Phase 3 live scope writer for standard estimates (separate prompt). The "Polish with AI" here is custom-only and must not change the standard `triggerScope` behavior.
- Do not apply the migration or push to remote. No em dashes (standing rule 6).

## Verification
- `npm test` green; `node --check` on any touched `.cjs`; estimator builds.
- Manual: toggle Custom on, areas/scope-questions hide, type a scope + a price, save with NO areas, confirm it saves and reopens in custom mode with the text/price intact; confirm the estimate appears in the list with the typed price, the proposal page and PDF render the typed scope + price, and accepting it creates a job whose scope is the typed text. Toggle Custom off and confirm the standard flow is byte-for-byte unchanged. "Polish with AI" cleans text without inventing scope and is revertible.
- What's New entry appended to `help/whats-new.json` (id, date, title like "Estimator: custom estimate mode for one-off jobs", 2-3 plain steps, no em dashes).

## After (Cowork handoff)
1. Apply `supabase/migrations/2026-07-16_estimate_custom_mode.sql` to PROD (project "HQ Dashboard", zdfpzmmrgotynrwkeakd). Capture: `select column_name from information_schema.columns where table_name='estimates' and column_name in ('is_custom','custom_scope','custom_price');` (expect 3).
2. Report back to Dylan: migration applied, and confirm a test custom estimate renders end to end (proposal + PDF + accept-to-job).
