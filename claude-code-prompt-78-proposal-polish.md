# Claude Code prompt 78: proposal polish

Four changes to the customer-facing proposal and the send path: tickable options in Preview, saved customer selections, the combined square footage removed, real customer names in the bell, and a hard block on blanks before send.

---

## Read before you touch anything

1. `CLAUDE.md` (all standing rules apply, especially 1, 2, 10, 11, 12).
2. The top 3 entries of `PROJECT-LOG.md`.
3. Nothing else. This prompt carries every fact you need, with line numbers, verified against the working tree at `HEAD` on 2026-08-08.

Do NOT read `index.html` or `PROJECT-LOG.md` end to end. Every anchor you need is named below.

**This prompt ships ZERO migrations by design.** No new columns, no new settings keys. Every column it writes already exists (`estimate_line_items.unit_cost`, `estimates.gp_dollars`, `estimates.gp_pct`, `estimates.price`). Given that three migrations were stranded in the last two weeks, adding a fourth for a UI change would be a bad trade. See the rule 12 note at the end of Part D.

---

## What was already verified (Cowork, 2026-08-08, read against the working tree)

Trust these. They were read, not inferred from `features.json`.

**The optional-tick complaint is a Preview problem, not a live-page bug.** `pec-public-estimate.cjs:381` reads `const interactive = state.live && !preview;`. That one flag does three jobs at once: it disables the checkboxes (`readOnly` passed into `lineItemRowsHtml` and `optionalCardsHtml`, lines 634 and 637), it suppresses the entire client `<script>` (line ~663, `${!interactive ? '' : ...}`), and it gates the accept/change/decline wiring. On the real `/e/<token>` page everything already works: `refresh()` at line ~700 updates `heroTotal`, `grandTotal`, `subTotal`, `acceptTotal`, and every payment-schedule cell. Dylan saw the dead boxes in the **Preview modal**, which is behaving exactly as designed.

**Present mode can already sign on the iPad. Do not rebuild it.** `openForSigning` (`index.html:29763`) runs the send gates, flips `markEstimateSent`, drops the `srcdoc` preview, and points the iframe at the REAL live URL (`?token=...&present=1`), where ticks and the signature both work; a 5-second poll (`startPoll`, ~29746) picks up the signature. `present=1`'s only effect server-side is to skip `logEstimateView` (line 1736) so the rep's own presentation does not fire the bell. Part A2 is two small changes to that flow, not a build.

**The Present sign path skips the blank check.** `openForSigning` at 29768-29769 calls `estimateOptionalGateOk` and `estimateSendGateOk` but NOT `estimateBlankScopeOk`. The email path (29873) and the text path (29954) both call it. So today, opening an estimate for signature on the iPad is the one send channel where a scope full of BLANK sails through unchallenged.

**The blank check is a warn, and it looks in the wrong place.** `estimateBlankScopeOk` (`index.html:29422`) is a `confirm()` that scans `est.scope_of_work` only. Since prompt 74 the customer reads `estimate_line_items.description`, one per line; `scope_of_work` is the internal record that feeds the job and the crew scope. A BLANK sitting in a line description trips nothing at all.

**`mdToSafeHtml` treats `---` as a horizontal rule, never `___`** (`pec-public-estimate.cjs:169`). So an underscore run in a scope is always a fill-in, never a divider. Part D can match `_{3,}` without a false-positive heuristic.

**`estimate_line_items.unit_cost` exists** (numeric, not null, default 0). Per-line gross profit is computable server-side, which is what makes Part A3's GP recompute possible without the estimator.

---

## Dylan's locked decisions

Eighteen scoping questions. These are answers, not suggestions. Do not re-litigate them.

1. The dead checkboxes were in the **Preview modal**.
2. Preview interactivity is Claude's call (see A1); Present must be signable on the iPad (it already is, see A2).
3. Rep ticks in Present persist through the normal live-page path, because Present goes live rather than simulating.
4. Customer ticks save **immediately** on the live page.
5. `estimates.price` is written live **only once the customer opens the accept panel**, not on every tick.
6. Remove the **whole** top summary table from the customer estimate page.
7. Remove it from the two customer-facing change order pages **and** the staff estimate detail card, because a combined footage lies when the lines carry different systems.
8. Lines with no area (add-ons, custom lines) show no footage at all. Acceptable.
9. Flake color keeps a **one-line note above "Your project"**; it must not vanish from the signed document.
10. Staff removal is the estimate **detail card only**. The estimates LIST keeps its sqft column and `$/sqft` sort.
11. Bell wording: `Susan Nasser viewed estimate #102064 (2nd view)`.
12. Existing bell rows are **left alone**. New rows only. No backfill.
13. Blanks that block: the literal `BLANK`, unresolved `is/is not` choices, underscore runs, and an empty line description (already blocking).
14. The blank scan runs on **per-line descriptions plus `scope_of_work`**.
15. **Hard block, no override.** No admin escape hatch, no settings switch.
16. One prompt, four parts, one What's New entry.

---

## Part A: optional line items the customer can actually tick

### A1. Split `interactive` so Preview can tick

File: `netlify/functions/pec-public-estimate.cjs`.

Today one flag does three jobs. Split it into two:

```js
// TICKING: the checkboxes are live and the recalc script runs. True on any
// open estimate, including a staff preview, because a rep demoing the page
// needs to see the price move. False on accepted / rejected / lost, where
// the document is a frozen record.
const ticking = state.live;
// INTERACTIVE (unchanged meaning): the customer can actually act. Gates the
// public token, the accept / change / decline panels, and every POST.
const interactive = state.live && !preview;
```

`state.live` is already false for `accepted`, `rejected` and `lost` (`stateForStatus`, line 306), so previewing a signed estimate stays correctly read-only with no extra guard.

Then:

- `lineItemRowsHtml(items, !ticking, areaById)` and `optionalCardsHtml(items, !ticking, areaById)` (lines 634, 637). The `readOnly` copy inside `optionalCardsHtml` ("These items were offered and not selected.") is keyed off the same flag and stays correct.
- Restructure the client script at line ~663 into **one IIFE with two sections**:
  - Emitted when `ticking`: `money`, `toggles`, `baseTotal`, `currentTotal`, `selectedIds`, `schedCells`, `schedRecalc`, `refresh`, the `change` listeners, and the initial `refresh()` call.
  - Emitted when `interactive` only, interpolated as `${interactive ? actionScript : ''}` inside the same closure: `TOKEN`, `panels`, `show`, the `sigName` preview, `post()`, and the three action handlers.
  - **`TOKEN` must not appear anywhere in a preview render.** After the change, grep the preview HTML for the estimate's `public_token` and confirm zero hits. A preview leaking a live token would turn a screenshot into a signable link.
- The preview banner (line ~600) currently says "the buttons are disabled", which will be half true. Replace with, exactly:

  `PREVIEW &middot; this is exactly what the customer will see. It has not been sent. You can tick options to watch the price move, and the accept, change and decline buttons stay disabled.`

  (No em dashes, rule 6.)

Leave `const total = (interactive || preview) ? includedTotal(items) : Number(est.price || includedTotal(items));` (line 383) as it is. It already resolves correctly for both flags.

### A2. Present mode: do not rebuild the signing flow

File: `index.html`.

`openForSigning` (~29763) already does the right thing. Two changes only:

1. **Add the missing blank gate.** At 29768-29769, after `estimateOptionalGateOk` and before `estimateSendGateOk`, the blank check must run like it does on the other two channels. After Part D this becomes automatic (the blank blockers move INTO `estimateSendGateOk`), so the concrete task is: verify by reading the final code that opening for signing cannot get past a blank. Do not leave a separate `estimateBlankScopeOk` call behind; Part D deletes that function.
2. **Discoverability.** `renderSignArea` (~29731) renders a bare "Open for signing" button. Add a hint line under it: `The customer can tick options and sign on this iPad once you open it.` Keep the existing live-state message as it is.

After A1, the walkthrough's pre-live estimate slide (the cached `?preview=` `srcdoc`) becomes tickable, so the rep can show the price moving before committing to going live. That is the intended win here; no other Present change is in scope.

### A3. Save the customer's selection as they tick

**New POST action on `netlify/functions/pec-public-estimate.cjs`.** The handler already branches on `body.action` for `accept` / `change` / `reject` (~line 1400). Add `select`.

Contract:

```
POST /api/estimate/action
{ token, action: 'select', selected_optional_ids: [...], signing: false }
```

Server behavior, in order:

1. `UUID_RE.test(token)` or 404, exactly like the other actions.
2. `loadEstimate(token)`; 404 on miss.
3. Refuse unless the status is open (`draft`, `sent`, `signed`, `change_requested`). On `accepted`, `rejected` or `lost` return **409** and write nothing. A signed document is never re-selected.
4. Cap `selected_optional_ids` at 50 and `String()` each, mirroring the accept path at line 1407.
5. Call the EXISTING `applySelection(est.id, items, selectedIds)` (line ~139). It is already idempotent, already touches only optional rows, and is already scoped to the estimate. **Do not write a second selection writer.**
6. If `signing !== true`, return `{ok:true}` here. Do not touch `estimates`.
7. If `signing === true`, additionally:
   - `const frozen = freezeLineItems(items, selectedIds)` (existing helper, line ~127).
   - `const total = Math.round(includedTotal(frozen) * 100) / 100`.
   - Recompute GP over the SAME included set: `gpDollars = Σ(total) − Σ(unit_cost × qty)`, `gpPct = total > 0 ? (gpDollars / total) * 100 : null`.
   - **The honesty rule, and it is not optional.** If ANY included line has `unit_cost === 0` while `total > 0`, do NOT write `gp_dollars` or `gp_pct` at all. Leave the stored values untouched and `console.warn` with the estimate id and the offending line ids. A zero cost on a priced line means the cost data is missing, not that the margin is 100 percent. A fabricated margin is worse than a stale one, because it looks authoritative in the pipeline.
   - PATCH with a status guard so a signature landing mid-flight can never be clobbered:
     `PATCH /estimates?id=eq.<id>&status=in.(sent,signed,change_requested,draft)` with `{price: total}` plus the two GP fields when the honesty rule allows them. A zero-row result is a no-op, not an error.

**Client wiring** (inside the `interactive` section from A1, never in preview):

- Debounce the tick POST at 250ms so a customer clicking through five options sends one request. Fire and forget: a failed `select` must never surface an error or block anything. The signature freeze at accept remains the authority, so a lost tick costs nothing.
- On the FIRST time `show('accept')` runs in a page load, POST once with `signing: true`. Track it with a local `let signingAnnounced = false;`.
- The accept POST keeps sending `selected_optional_ids` exactly as today. **Nothing about the accept path changes.** The CAS, `freezeLineItems`, `applySelection`, the schedule freeze and `ensureJobCreated` are untouched.

**Why price is not written on every tick, and the consequence Dylan accepted.** Prompt 72 defines `estimates.price` as the required-only floor while the estimate is open, and the pipeline and estimates list render `$X (up to $Y)` off exactly that. Writing on every tick would move pipeline and forecast dollars every time a customer clicked a box with nothing signed. The accept-panel trigger narrows that to the moment they are actually signing.

The residue: a customer who opens the accept panel and then abandons leaves `price` sitting between the floor and the ceiling with the status still `sent`. This degrades gracefully rather than breaking, because the `(up to $Y)` render keys on `price !== price_all_options`, which is still true. **Record this consequence explicitly in the PROJECT-LOG entry** so the next person reading a pipeline number knows a mid-range price on an open estimate means "they opened the signature panel", not "the rep repriced it".

---

## Part B: remove the combined square footage

The rule Dylan is applying: footage belongs on the line it describes. A single number at the top is a sum across lines that may carry different systems, so it is wrong the moment an estimate has more than one line.

### B1. Customer estimate page

File: `netlify/functions/pec-public-estimate.cjs`.

- Delete the `scopeRowsHtml` function (line 213) entirely.
- Delete its render block (lines ~628-629): the `<div class="eyebrow">Scope of work</div>` and the `<table class="scope">` that follows it.
- Remove the `table.scope` CSS rules only after grepping the file and confirming the class has no other consumer.
- `totalSqft` is still computed and still used at lines 1091, 1172, 1697 and 1720 for job creation and `jobs.sqft`. **Leave every one of those alone.** Only the render usage goes.
- `sysName` may become unused at the call site; remove the argument, not the variable, if it is still needed elsewhere.

**Flake color gets a one-line note** (decision 9). Immediately above the `<div class="eyebrow" style="margin-top:26px">Your project</div>` line, render, only when `est.flake_color` is non-empty:

```html
<div style="color:#4b5563;font-size:14px;margin-top:4px">Flake color: <strong>${esc(est.flake_color)}</strong></div>
```

Nothing else from the old table comes back. The MVB note already lives per line via `liSubtitleHtml` (line 233), and the system name is already in each line's label.

`liSubtitleHtml` is untouched. Per-line footage keeps reading `970 sq ft` exactly as it does today.

### B2. Customer change order pages

Same treatment, whole summary table:

- `netlify/functions/pec-public-change-order.cjs`, the summary rows around line 83.
- `netlify/functions/pec-public-change-order-batch.cjs`, the same around line 91.

Read each file's table before cutting. If a change order's summary carries a row that has no per-line equivalent (the way flake color did on the estimate), keep that row as a one-line note using the same pattern as B1 rather than losing the fact. Name in the log entry exactly which rows you removed from each file.

### B3. Staff estimate detail card

File: `index.html`, `renderEstimateDetail`.

- Remove `${detailRow('Sqft', ...)}` at line 28873.
- Remove the `$/sqft` readout fed by `ppsfTxt` (defined line 28721, `detailSqft` at 28720). A blended dollar-per-foot across two systems is the same lie in a different unit.
- Remove `detailSqft` / `ppsfTxt` if nothing else consumes them. `const sqft = estimateSqft(est)` at 28698 may still be used; check before deleting.
- **`estimateSqft` itself stays** (line 28210). The estimates LIST at 28241 keeps its sqft column and its `$/sqft` sort, by decision 10.

---

## Part C: the customer's name in the notification bell

File: `netlify/functions/pec-public-estimate.cjs`, `logEstimateView` (~1550-1645).

The bell renderer prints `n.body` verbatim (`renderBellPanel`, `index.html:6456`), so this is a write-time string change and nothing else. No renderer change, no migration.

**Shared bell** (line 1610). Replace:

```js
body: est.estimate_number != null ? `Customer viewed estimate #${est.estimate_number}` : 'Customer viewed an estimate',
```

with a name-first body matching decision 11: `<name> viewed estimate #<number> (<ordinal> view)`.

- The name is `est.customer_name`, falling back to `'A customer'` when it is null or blank. Never render an empty leading space or a stray `#`.
- Use the EXISTING `viewOrdinal(viewCount)` helper the Slack post already uses (line ~1586), and omit the parenthetical entirely when `viewCount` is null, exactly as the Slack path does.
- Keep the no-number fallback: `<name> viewed an estimate`.

**Rep bell** (line 1636). Same shape, dropping the possessive: `<name> viewed estimate #<number> (<ordinal> view)`. The current text reads `Your customer viewed...`; the name makes "your customer" redundant.

**Commercial estimates.** `customerDisplay(est)` (~line 345) already resolves the split-column identity and prefers the company name for a commercial record. Use it rather than reaching for `customer_name` directly, so a commercial bell reads the company name the rest of the system uses. Confirm by reading the helper that its return shape gives you a `name` string; if it does not, use `est.customer_company || est.customer_name`.

**No backfill** (decision 12). Existing rows keep their wording and age out. Do not write an UPDATE against `pec_notifications`.

**Slack is already correct.** Line 1589 already posts `${est.customer_name || 'Customer'} opened estimate ...`. Do not touch it.

---

## Part D: blanks hard-block the send

The failure this prevents: a customer reading the literal word BLANK, or `are/are not included`, in a document they are being asked to sign.

### D1. One shared detector

File: `production/scope.cjs`.

`containsBlank` (line 25) stays exported and unchanged; `pec-estimate-scope.cjs` and the estimator both import it and their behavior must not shift.

Add a new export alongside it:

```js
// Every customer-visible unfilled placeholder in `text`, as structured
// findings so the send gate can quote the offending text back to the rep.
// kind: 'blank' | 'choice' | 'underscore'
function scopeBlanks(text) { ... }
```

Three detectors, and no others:

| kind | pattern | why |
|---|---|---|
| `blank` | `/\bBLANK\b/g`, case sensitive | the existing `BLANK_RE`. Case sensitivity is deliberate and load-bearing: a customer named Blank Smith must never trip it. |
| `choice` | `/\b(is\|are)\s*\/\s*(is\|are)\s+not\b/gi` | Dylan's templates carry `Stem walls are/are not included` and `Concrete past garage door is/is not included`. The scope writer leaves them verbatim when the intake cannot resolve them (`pec-estimate-scope.cjs` rule 2). Note the live Metallic template has a DOUBLE space in `is/is not  included`, so `\s+` on the tail is required, not cosmetic. |
| `underscore` | `/_{3,}/g` | `mdToSafeHtml` renders `---` as a horizontal rule and never `___` (`pec-public-estimate.cjs:169`), so an underscore run in a scope is always a fill-in. No divider heuristic needed. |

Each finding returns `{kind, snippet}` where `snippet` is the trimmed surrounding line, capped at 60 characters, so the blocker message can show the rep what to look for.

Add fixture tests in `production/` covering: the three positives; `Blank Smith` not matching; `is not included` (already resolved) not matching; `---` not matching; `is/is not  included` with the double space matching. Follow the existing test file conventions in that directory. `npm test` must stay green.

### D2. Fold it into the one send gate

File: `production/optional-lines.cjs`, `scopeSendBlockers` (line 135).

Extend the signature to `scopeSendBlockers({ scopeStale, items, customAreaIds, scopeOfWork })`.

New rules, added to the existing ones:

- **Every line's `description` is scanned**, including add-on / one-off lines (no `estimate_area_id`) and custom lines. Blocker text: `"<label>" still has a blank in its scope of work: "<snippet>". Fill it in, then send.`
- **Custom lines change behavior on this axis only.** They stay exempt from the empty-description rule (a typed scope is the rep's call, unchanged), but a custom line whose typed scope contains `BLANK` or `____` or an unresolved choice DOES block. Pasting a template into a custom line and forgetting to fill it is exactly the failure mode this catches.
- **`scopeOfWork` is scanned** as an estimate-level blocker: `The scope of work still has a blank: "<snippet>". Fill in the scope questions, then send.`

### D3. Mirror it on the client and delete the dead warn

File: `index.html`.

- `estimateSendGateOk` (29456) is the CLIENT MIRROR of `scopeSendBlockers` and the comment at 29443 says to keep them in lockstep. Add the same three scans there, producing the same structured `{msg, sortOrder}` blockers so prompt 76's tappable links still open the offending line's editor sheet. A `scope_of_work` blocker has no `sortOrder` and renders as a plain row, like the stale-scope one.
- The fresh read at 29465 already selects `description`. Add `scope_of_work` to the `estimates` select at 29468 so the gate judges fresh text, not the page's snapshot.
- **Delete `estimateBlankScopeOk` entirely** (29422) and both call sites (29873, 29954). It is a `confirm()` that Dylan has now overruled (decision 15: hard block, no override), it scans the wrong field, and leaving it would mean two competing blank gates with different answers. Deleting it also fixes the Present hole from A2 automatically, since all three channels route through `estimateSendGateOk`.
- Re-grep for `estimateBlankScopeOk` after the change and confirm zero hits.

### D4. The estimator's warning gets honest

File: `apps/estimator/src/features/estimator/EstimatorScreen.tsx`.

The Line items card warning at line 2827 currently reads as advice. It is now a block. Change it to say so, in the rep's terms and with no em dashes, for example: `The word BLANK is still in the scope. You will not be able to send this estimate until it is filled in.`

The hint at 2927 keeps its meaning but should match: anything left blank now stops the send rather than showing up in the signed document. **Do not add a save block.** A rep mid-build must never be blocked; the gate fires at SEND only, exactly like every other rule in `scopeSendBlockers`.

`tsc` and the Vite build must stay clean.

### Rule 12 note

Rule 12 says every major feature ships with a settings surface. Dylan explicitly chose **hard block, no override, no switch** (decision 15), so this gate deliberately ships without one. Record that waiver and his decision in the PROJECT-LOG entry rather than silently omitting it, and do NOT invent a settings key, because a key means a migration and this prompt's zero-migration property is worth more than the knob.

---

## Verification, before you commit anything

1. `npm test` green, including the new `scopeBlanks` fixtures.
2. Estimator `tsc` clean and the Vite build clean.
3. Every `<script>` block in `index.html` parses. The A1 restructure is inside a template literal that emits JavaScript; a stray backtick there breaks the customer page silently.
4. **Preview leak check.** Render a preview and grep the HTML for the estimate's `public_token`. Zero hits required.
5. **Preview tick check.** In a preview, ticking an option moves `heroTotal`, `subTotal`, `grandTotal` and any schedule rows, and the accept / change / decline buttons stay disabled.
6. **Accepted preview check.** Preview an accepted estimate: every checkbox is disabled and the frozen totals render, unchanged from today.
7. **Live tick check.** On a real `/e/<token>` page, tick an option and confirm `estimate_line_items.selected_by_customer` flipped, and that `estimates.price` did NOT move. Then open the accept panel and confirm `price` moved once and `gp_pct` either moved consistently or was correctly left alone by the honesty rule.
8. **Accept still works.** Sign a test estimate end to end and confirm the frozen selection, the job creation, and the schedule freeze are byte-identical to today's behavior.
9. **Gate check, all three channels.** Put a `BLANK` in one line description on a test estimate and confirm email send, text send, and Present's Open for signing all refuse, and that the blocker is tappable and opens that line's editor sheet.
10. **Bell check.** Open a sent test estimate as a customer and read the bell row: it must carry the customer's name and the view ordinal.
11. Clean up every test artifact. Prompt 76's entry sets the bar: zero residue.

---

## After

Per standing rules 1, 2 and 11:

- Commit per meaningful change, `<area>: <what changed>` format.
- One PROJECT-LOG entry at the TOP, `By: Claude Code`, written for a human. It must record: the three consequences named above (the mid-range `price` on an abandoned accept panel, the rule 12 waiver, and which change order rows were removed from which file), plus the fact that Present signing already existed and was not rebuilt.
- One What's New entry in `help/whats-new.json` (newest first), plain language, no em dashes, 2 to 3 how-to steps. It covers the customer-visible half: options can be ticked in Preview, the estimate header is cleaner, and blanks now stop a send.
- Update the affected `features.json` entries: "Customer-facing estimate (send, sign, accept)", "Optional line items on any line", "Estimate view tracking", "Notifications", "On-site presentation view (Present mode)".
- No migration, so nothing to add to the drift manifest and no `SCHEMA.md` regeneration.
