# Claude Code Prompt 82: a custom-line-only estimate can never be saved (the Save button does not exist)

Run this BEFORE prompt 83. It is a self-contained bug fix, its own commit.

## Context

Dylan built an estimate for a customer named Ron on his phone. The estimate had ONE line, a custom line, with a price typed in. There was no Save button anywhere on the screen, so the estimate could not be saved. He reported it as a mobile bug. It is not a mobile bug and it is not CSS: the Save button does not render at any viewport width for this shape of estimate.

Repo: HQ-Dashboard, `main`. Deploy: Netlify. The file is `apps/estimator/src/features/estimator/EstimatorScreen.tsx` (the estimator PWA source). `estimator/` at the repo root is the BUILT output and must never be hand-edited; rebuild it the normal way.

## Root cause, already diagnosed. Confirm it, then fix it.

The whole standard-mode money block, Save row included, is rendered inside one gate at roughly index 3095 of EstimatorScreen.tsx:

```tsx
{hasPrice && pricing && adjusted && (
  <> ... <div className="save-row"><button className="save" disabled={!canSave} ...
```

`pricing` is null whenever the calculator engine has nothing to price (line ~830):

```ts
if (isCustom) return null;
if (!salesperson || !engineAreas.length) return null;
```

`engineAreas` is derived from `pricedAreas` (line ~582), which filters to `!a.isCustom && Number(a.sqft) > 0 && a.systemTypeId`. A custom line is `isCustom: true` and carries no system type, so an estimate whose only line is custom yields `engineAreas.length === 0`.

That nulls the entire chain:

`pricing` null -> `hasPrice` false (line 857) -> `linesReady` false (line 895, it is `hasPrice && ...`) -> `basePrice` null (line ~897) -> `finalSell` null -> `finalLineAmounts` null -> `lineMoney` null -> `adjusted` null (line ~976) -> `moneyReady` false (line ~1100) -> `totalPrice` null.

Two independent failures fall out of that, and BOTH must be fixed:

1. The render gate is false, so the Save row is never in the DOM.
2. `canSave` (line 1705) is false anyway, because standard mode gates on `linesReady`, which gates on `hasPrice`. So merely rendering the button would ship a permanently disabled one.

There is also a third, cosmetic-but-misleading symptom. With `hasPrice` false, the estimator renders `Enter the square footage to price the job.` (line ~3090), which is exactly wrong advice for a custom line, and is probably what Dylan saw where the Save button should have been.

Note the asymmetry that proves the intent: whole-estimate Custom mode (`isCustom === true`, the Standard/Custom switch) has its OWN save row at line ~3079 that renders fine with no engine at all. Prompt 69 added custom LINES inside a standard estimate but never gave that case the same escape hatch.

`performSave` also hard-returns on it, line ~2046:

```ts
if (!isCustom && (!pricing || !hasPrice)) return null;
```

That returns null silently, with no `saveState` change and no message, so even a wired-up button would have failed quietly. Fix it too.

## Decisions locked with Dylan

1. **Scope: fix it, and always show why.** The Save button must ALWAYS render in both modes. When it cannot be used it renders disabled, with a plain-English line next to it naming exactly what is blocking it. Silent absence is the bug class we are killing, not just this one instance.
2. Do NOT add a sticky/pinned mobile save bar. Dylan considered it and passed. Layout is unchanged.
3. Dylan was not certain which shell he was in (inline estimator embed on the estimate page vs the standalone PWA). Both are the same React component, so one fix covers both. Do not add shell-specific code.

## What to build

### A. Let a custom-line-only estimate price and save

The correct mental model: the engine is a pricer for CALCULATOR lines. An estimate with zero calculator lines is not broken, it is simply an estimate the engine has no work to do on. Today the code conflates "the engine produced nothing" with "the estimate has no price".

Introduce an explicit count and branch on it rather than sprinkling `?.` guards:

```ts
const calcLineCount = lineRows.filter((r) => r.kind === 'calc').length;
// The engine is legitimately dormant when there is nothing for it to price.
const engineDormant = !isCustom && calcLineCount === 0;
```

Then:

- `linesReady` (line 895) becomes: every line has a `current` price, `lineRows.length > 0`, and `hasPrice` is required ONLY when `calcLineCount > 0`. A custom-line-only estimate with a typed price is ready.
- `basePrice`, `calcTotal`, `finalSell`, `finalLineAmounts`, `lineMoney`, `adjusted`, `shapedLines`, `lineTotalsSplit` should all then flow with no further change, because they key off `linesReady` / `basePrice`, not off `pricing`. VERIFY this by reading each one rather than assuming.
- `moneyReady` (line ~1100) becomes `!isCustom && linesReady && adjusted != null`. Drop the `hasPrice` term.
- The render gate becomes `{linesReady && adjusted && (` (drop `hasPrice && pricing &&`).
- `performSave`'s guard (line ~2046) becomes: require the engine snapshot only when `calcLineCount > 0`.

### B. Null-guard every `pricing.*` read inside that block

The block currently dereferences `pricing` unguarded in at least these places. With `pricing` legitimately null they will throw. Read the block and fix ALL of them, not just this list:

- `pricing.materialsCost` (Materials metric)
- `pricing.laborPct` (Labor metric label)
- `pricing.sundriesPct` (Sundries metric label)
- `pricing.standardCommissionPct` (Commission metric label)
- `pricing.price`, `pricing.priceRaw` (the derivation sentence)
- `pricing.materialsMissingCost` (the missing-cost warn)
- `pricing.calcVersion` (the `engine <ver>` line)

For a custom-line-only estimate:
- Materials should show the custom lines' typed material cost total only.
- The Labor / Sundries / Commission percentage LABELS should fall back to the config values (`config.laborRate` is a rate not a pct; use `config.sundriesPct` and `config.standardCommissionPct`), and the dollar figures come from `adjusted`, which is already summed from `customLinePricing` and is correct.
- The derivation sentence should render the custom-lines-only phrasing instead of the cost-to-target-GP sentence. Something like `1 custom line at a typed price` with no engine sentence. It must not render an empty `<p>`.
- The `engine <ver>` line should not render when there is no engine result.
- GP is computed for custom lines (they carry typed material cost and hours), so the GP metrics, the target-GP warn, and the floor/line-floor confirms all stay live. Do NOT suppress them. This differs deliberately from whole-estimate Custom mode, where GP genuinely has no basis.

Also replace the `Enter the square footage to price the job.` hint condition so it does not fire when the estimate has custom lines. It should only appear when the rep has calculator lines that are not yet priceable.

### C. Save is always rendered, and always says why it is blocked

Extract ONE helper next to `canSave`:

```ts
// The single source of truth for "why can't I save?". Empty array = saveable.
const saveBlockers: string[] = useMemo(() => { ... }, [...]);
const canSave = saveBlockers.length === 0 && saveState !== 'saving';
```

It must cover, in plain language, every condition `canSave` tests today plus the new ones:

- no salesperson selected -> `Pick a salesperson.`
- `customerIncomplete` -> the existing commercial/residential wording
- `addonsIncomplete` -> `Finish the add-on lines (each needs a label and a price).`
- `mvbMissing` -> the existing MVB wording
- `overrideNeedsReason` -> `Type a reason for the price change.`
- custom line with no typed price -> `Type a price on the custom line "<label>".` (name the line)
- calculator line missing sqft or system -> name the line
- engine error (`err`) -> the existing `ERROR_COPY[err]` text
- no lines at all -> `Add at least one area or custom line.`

Render the Save row unconditionally in BOTH mode branches (the custom-mode row at ~3079 and the standard-mode row at ~3184), OUTSIDE any `hasPrice`/`adjusted` gate, and put the first blocker (or all of them, your call, but keep it to one short line) next to the disabled button in the existing `.save-note` slot with a `bad`-style class. Do not use a tooltip or a `title` attribute: Dylan hit this on a phone, where there is no hover.

The two save rows are byte-identical today. Extract them into one small local component or a render helper so they cannot drift again.

### D. Do not change

- The offline outbox, the draft-save path (`saveDraft`), `estimateIdForSave`, or anything in `production/estimate-draft.cjs`.
- The floor-GP confirm dialogs and the reason-threshold rule.
- Whole-estimate Custom mode behavior.
- `styles.css` layout, and no new media queries.
- The estimate page, the public estimate page, or any Netlify function.

## Verification, required before you commit

1. `npm test` green across all suites.
2. Add a fixture test for the pricing chain, in `production/` alongside the existing tests, that asserts a lineRows set of exactly one custom line with a typed price produces a non-null base total and per-line money. If the per-line math is not reachable from `production/` without the React component, extract the minimum pure helper so it is testable, and say so in the log.
3. Build the estimator (`apps/estimator` -> `estimator/`) and confirm the build output actually changed.
4. Walk these four states in a browser at a phone width AND a desktop width, and report what you saw for each:
   - New estimate, customer filled, ONE custom line with a price. Save button present and ENABLED.
   - Same, price cleared. Save present, DISABLED, blocker text names the custom line.
   - One custom line plus one normal calculator area. Both price, total is the sum, Save enabled.
   - Standard estimate with no lines at all. Save present, disabled, `Add at least one area or custom line.`
5. Confirm no console errors in any of the four.

## Standing rules that apply

- Commit format `<area>: <what changed>`. Stage specific files, never `git add .`.
- Append a PROJECT-LOG.md entry at the TOP, written for a human, naming the four browser states you actually verified and their results. If something did not work, log it anyway.
- This is user-facing, so add a What's New entry to `help/whats-new.json` (newest first, no em dashes, plain language). Something like: custom-only estimates now save, and the Save button always tells you what is missing.
- Update the `features.json` entries for "Per-line pricing and custom lines" and "In-house estimator PWA" to record that a custom-line-only estimate is now a first-class priceable estimate and that Save states its blockers.
- No migration and no schema change. Do not touch SCHEMA.md.
- Do NOT push. Dylan pushes.
