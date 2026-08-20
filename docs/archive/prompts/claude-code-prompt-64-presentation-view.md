# Claude Code Prompt 64: on-site presentation view (SumoQuote-style), with the literature riding the customer estimate page too

Scoped by Cowork 2026-08-02 alongside prompt 63. **Do not run this until prompt 63 has shipped and Dylan has confirmed Parts A, C and D behave.** This prompt assumes prompt 63's preview-modal changes exist.

Read `CLAUDE.md` and the top 3 entries of `PROJECT-LOG.md` first. Verify every table and column against `SCHEMA.md` before writing SQL. Use `features.json` anchors instead of reading `index.html` end to end.

---

## The ask, in Dylan's words

> "presentation view for presenting an estimate on site. Think roofing CRMs and sales processes like sumo quote where they put the literature in the same presentation with the estimate"

The job is to stop handing a homeowner a bare price and start walking them through who PEC is, how the work happens, what the warranty covers, what the work looks like, and how to pay for it, ending on the estimate itself.

---

## The single most important constraint

Dylan said this three separate times, so treat it as the governing rule of the whole build:

> "the presentation just presents the customer view plus literature, never a separate estimate"
> "present = customer view of the estimate plus literature. never a new estimate itself"
> "your suggestion but the presentation is just a customer view only plus literature not a new one EVER"

**There is exactly one renderer for an estimate: `netlify/functions/pec-public-estimate.cjs`.** The presentation must not reimplement price, scope, line items, optional-item ticking, or totals. The estimate slide inside present mode **embeds the existing `?preview=<estimate_id>` HTML**, using the same staff-JWT fetch into `srcdoc` that the Preview button already uses (`index.html` around 27502-27525). If you find yourself writing a second line-item table, you have broken the one rule that matters here.

---

## Locked decisions

### Where it runs

- **A dashboard view**, rep-facing, launched from the estimate detail page. Full-screen, iPad-friendly.
- **Online only for v1.** No offline caching, no queued signatures. Dylan accepted the driveway-signal risk explicitly. Do not build a service-worker story.
- Present mode is chrome + literature + the embedded customer page. Nothing else.

### The literature also ships to the customer

- The same section content renders on the **public estimate page** (`pec-public-estimate.cjs`), read-only, so the customer re-reads the story at the kitchen table with the spouse who was not home. Dylan chose this over presentation-only.
- **One content store, two consumers.** The dashboard present view and the public page must read the same rows. Do not fork the copy.

### Sections

Four section types, all four in scope:

1. **Why us / company story + warranty** (the trust block)
2. **Our process, step by step**
3. **Photo gallery and reviews**
4. **Financing and payment options**

- **All active sections show, in the Settings-defined sort order.** No per-estimate toggles, no per-estimate storage column. The rep can skip or jump between sections live while presenting, but nothing is saved per estimate.
- Order and active state are set in Settings. Standing rule 12: every major feature exposes its knobs in company Settings so nothing needs a code edit to tune.

### Content storage

- A new Settings-managed table (name it per the existing naming convention you find in SCHEMA.md, e.g. `pec_presentation_sections`) with at minimum: title, body, section kind, image reference(s), sort order, active flag, and **brand** (PEC vs FTP, matching whatever `loadBrand(brandKey)` in `pec-public-estimate.cjs:617` already keys on).
- Body content should support light formatting. `mdToSafeHtml` already exists in `pec-public-estimate.cjs:132`; reuse it rather than introducing a second markdown path or raw HTML.
- A Settings editor to create, reorder, activate and deactivate sections.

### Photos and reviews

- **Photos: manual curated uploads in Settings**, stored in Supabase Storage. Dylan wants control over which before/afters a customer sees. No CompanyCam integration in this prompt.
- **Reviews: pull live from the reviews table prompt 60 built.** Verify against SCHEMA.md what that table is actually called and what it holds before wiring it. Show a small number of recent high-rated reviews; make the count and the minimum rating Settings values, not constants.

### Closing on site

- **The customer can accept and sign at the end of the presentation**, on the rep's device.
- **Reuse the existing accept-and-sign path.** The embedded `?preview=` render currently ships those buttons **disabled** on purpose (`pec-public-estimate.cjs:305-314`, `preview ? ' disabled' : ''`, plus the "In this preview they are disabled" note at 314). Present mode needs a live variant.
- **This is the riskiest part of the prompt.** The accept path creates the job, resolves the customer, moves the lead, fires `notifyOffice` and `pec-webhook-proposal-accepted`, and stamps `signed_at` / `accepted_at`. Do NOT duplicate any of it. Options, in order of preference:
  1. Present mode's final step opens the **real public estimate URL** (`/e/<public_token>`) on the same device, so the untouched live path runs. Requires the estimate to be sent (the link 404s until `sent_at`), so present mode must offer a Send step first.
  2. A new authenticated "present" render mode in `pec-public-estimate.cjs` that is byte-identical to the live render except that it is staff-authenticated instead of token-authenticated, sharing the exact same `handleAccept` code path.
  - **Report which you chose and why before building it.** If option 2 means touching `handleAccept`, stop and check with Dylan first.
- Whatever you choose, an on-site signature must produce the same rows, the same job, and the same webhooks as a signature from the emailed link. Prove it with a side-by-side comparison of two test estimates in your log entry.

### Explicitly OUT of scope

- **Tiered good/better/best packages.** Dylan's answers conflicted on this across rounds; his most recent and most considered answers were "Not now, one price plus optional items" (twice). **Cowork flagged the conflict to Dylan rather than silently choosing.** Present mode shows the one price plus the existing optional line items, given a proper visual treatment (upgrade cards with a running total instead of a bare checkbox row) using the machinery that already exists. Real tiers would mean multiple priced packages per estimate, touching the calculator, the accept path, costing, and metrics. That is its own prompt.
- Offline support.
- CompanyCam.
- Per-estimate section selection.
- A PDF export of the presentation.

---

## Landmines

- **The `?preview=` render is deliberately inert.** Buttons disabled, no public token exposed, no `sent_at` flip, no view logged (`logEstimateView` is bypassed on the preview branch, and `BOT_UA_RE` at line 1088 exists because link-preview bots were lighting the bell). Any "live" present variant must be deliberate about each of those four behaviors, not accidental. Decide explicitly whether presenting on site should count as a customer view; Cowork's read is that it should NOT, since the rep is driving.
- **`estimates.lead_id` can be null since prompt 62.** Every new query you write against estimates must tolerate it. `estimates.customer_id` may be the only link.
- **Brand.** PEC and FTP are separate brands with separate content. A section without a brand, or a brand lookup that silently falls back, will show a homeowner the wrong company's warranty. Make the brand key required.
- **Image weight.** A gallery of full-resolution job photos will make an iPad on cell data unusable, and this build is online-only. Resize on upload and state the ceiling you chose.
- **Prompt 62 shipped with open verification items** and prompt 61 shipped unverified before it. Confirm 63 is verified before starting this.
- **Netlify build credits: Dylan was over 75% of the monthly allowance on 2026-08-01.** Do not burn builds iterating; test locally and deploy deliberately.

---

## Style

Everything in the presentation is customer-facing. **No em dashes anywhere** in section copy, headings, button labels, financing text, or the What's New entry. Use commas, parentheses, or two sentences.

---

## Verification required in the log entry

1. The chosen approach for on-site signing, and why.
2. A side-by-side proof that an on-site acceptance and an emailed acceptance produce identical rows, jobs, and webhook fires.
3. Confirmation that the estimate slide renders from `pec-public-estimate.cjs` and that no line-item or price markup was written anywhere else.
4. The image size ceiling chosen, and the resulting weight of a full presentation with a populated gallery.
5. Whether presenting logs a customer view, and the reasoning.
6. Screenshots or a description of the presentation at iPad width and at phone width (the public-page copy of the sections has to survive a phone).
