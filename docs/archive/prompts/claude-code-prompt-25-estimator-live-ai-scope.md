# Build Prompt 25 (Phase 3 of 3): Live in-module AI proposal writer for standard estimates

Phase 3 of the estimator fine-tune. Do this AFTER Phases 1 (customer fields) and 2 (custom mode) have shipped. Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first.

## Context (read this carefully — the AI writer already exists)

Dylan asked to have the AI "populate the proposal automatically once you select the system type and answer the questions, and build the proposal right in the module as we go." An AI proposal writer ALREADY EXISTS: `netlify/functions/pec-estimate-scope.cjs` assembles the customer-facing scope from Dylan's VERBATIM system-type templates (`pec_prod_system_types.scope_template` / `scope_template_mvb`) plus add-on `scope_snippet`s, substituting this estimate's facts (sqft, area names, stem walls, coat-past-garage, flake color). It is ASSEMBLY + SUBSTITUTION, deliberately NOT freehand authorship (its header explains why: the exclusions and cure-time clauses protect Dylan in a dispute, so the model must not rewrite them). It writes to `estimates.scope_of_work` and per-line `estimate_line_items.description`, and enforces a never-overwrite rule: once a human edits the scope (`estimates.scope_edited_at` set), it refuses to regenerate without `force=true`.

Today it runs AFTER save, in the background: `triggerScope(estimateId)` in `EstimatorScreen.tsx:670-690` fires post-save when no human has edited the scope; the estimate DETAIL page (`index.html`, scope edit UI ~`:17960-18125`, `pec-estimate-scope` fetch ~`:17978`) is where Dylan currently sees, edits, and Regenerates it. So Phase 3 is NOT building an AI writer. It is MOVING the existing one into the estimator so the assembled proposal appears live and editable while Dylan builds the estimate, instead of only showing up on the estimate page after save.

Dylan's locked decisions (from the dig):
- LIVE draft IN the estimator module, EDITABLE inline before save/send.
- Trigger: AUTO the FIRST time (once system type + the scope questions are answered), then a manual "Regenerate" button for subsequent changes. NOT re-running on every keystroke (cost + it would clobber his edits).
- This is the STANDARD-system flow only. Custom mode (Phase 2) has its own typed scope + optional polish and is out of scope here.

## Tasks

Commit per feature per standing rules.

### Task 1 — Live scope panel in the estimator
In `EstimatorScreen.tsx`, add a "Proposal / Scope of work" panel (a card, near the existing "Finish the scope" section ~`:1070-1085`) that shows the assembled scope text for the current estimate, editable in a textarea. Requirements:
- It renders the SAME assembled output `pec-estimate-scope` produces. The estimator already has the pieces to preview locally: the scope templates (`systemTypes[].scope_template`/`scope_template_mvb`), add-on snippets, and the shared `production/scope.cjs` (`applyAnswers`, `openQuestions`, `containsBlank`) it already imports (`EstimatorScreen.tsx:32`). Prefer generating the AI-assembled text via the server function (Task 2) so the model does the assembly identically to today; use the local template substitution only as an instant placeholder/preview before the first server call returns.
- Unfilled BLANKs surface exactly as today (the "Finish the scope" questions already drive this); leaving one blank shows the word BLANK in the proposal, matching current behavior.

### Task 2 — Auto-first, then manual regenerate (cost + edit safety)
- The estimator needs an estimate id to call the server function (it keys off `estimate_id`). Reuse the existing save path: on the FIRST save where system type + required scope answers are present, call the existing `triggerScope(id)` (already wired at `:670-690`) and load the returned `scope_of_work` into the live panel. This preserves the auto-first behavior with zero new server logic.
- After that first generation, changes do NOT auto-regenerate. Show a "Regenerate proposal" button that calls `pec-estimate-scope` with `force=true` (the same call the estimate page's Regenerate uses), behind the same "this replaces your edited text" confirm when the scope was hand-edited. Respect the never-overwrite rule that already lives in the function: a hand-edited scope (`scope_edited_at` set) is only overwritten on an explicit forced Regenerate.
- If Dylan edits the text in the panel, mark it edited (the save already does `markScopeStale`/sets `scope_edited_at`) so a later background trigger will not silently overwrite his words.
- Offline: the estimator runs offline at job sites and the AI needs the network. When offline, show the local template-substituted preview and a note that the polished proposal writes itself once online (the current post-save behavior already does this; match its copy at `EstimatorScreen.tsx:1205`).

### Task 3 — Keep the estimate-page editor in sync
The estimate DETAIL page scope editor (`index.html` ~`:17960-18125`) stays the source of truth for a saved estimate. Ensure the estimator's live panel and the estimate page do not fight: both read/write the same `estimates.scope_of_work` + `scope_edited_at`, both use the same `force` semantics. No duplicate generation logic; both call `pec-estimate-scope`.

### Guardrails — do NOT touch
- The assembly-not-authorship contract in `pec-estimate-scope.cjs`. Do NOT loosen the prompt to let the model rewrite exclusions or cure-time clauses. If you change the function at all, keep the verbatim-template discipline and the never-overwrite/force rule intact.
- The pricing engine, comps, and price-recommendation AI (`ai.ts`/`pec-estimate-ai`).
- Custom mode (Phase 2). No auto-regenerate on keystroke (explicitly rejected: cost + clobbering edits).
- No migration is expected (reuses `scope_of_work`, `scope_edited_at`, `scope_answers`). If you find you need one, STOP and flag it rather than applying it. No push to remote. No em dashes.

## Verification
- `npm test` green; `node --check` on any touched `.cjs`; estimator builds.
- Manual: build a standard estimate, answer the scope questions, save — confirm the assembled proposal appears in the live panel automatically. Edit a word in the panel, save, reopen — confirm the edit survived and was NOT auto-overwritten. Change the sqft and click Regenerate — confirm it re-assembles (with the confirm if the text was edited). Confirm the estimate page shows the same scope. Confirm offline shows the local preview + the "writes itself once online" note.
- What's New entry appended to `help/whats-new.json` (id, date, title like "Estimator: the proposal now builds live as you estimate", 2-3 plain steps, no em dashes).

## After
No Cowork DB handoff expected (no migration). Report to Dylan that the live proposal panel is in the estimator and behaves auto-first-then-regenerate, and confirm the estimate page still edits the same text.
