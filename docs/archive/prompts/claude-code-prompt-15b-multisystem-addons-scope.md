# Claude Code build prompt 15b: multi-system estimates, the add-on catalog, and AI scope writing

RUN THIS AFTER PROMPT 15 IS SHIPPED AND VERIFIED. Prompt 15 built the thin estimator modal, the comps and AI pricing panel, and the estimate as a numbered object with its own page and list. This prompt makes an estimate able to describe a real job (several systems, several add-ons) and to WRITE ITSELF: the customer-facing scope text, generated from Dylan's real templates and editable by hand. Prompt 16 then puts that document in front of the customer.

Read prompt 15's PROJECT-LOG entry before you start. If prompt 15 made a judgment call that contradicts anything below, the log wins and you flag the conflict to Dylan rather than quietly reconciling it.

## Context

Repo: hq-dashboard (github.com/Dnordby50/hq-dashboard, main). Deploy: prescottepoxy.netlify.app. Supabase: zdfpzmmrgotynrwkeakd.

Dylan reviewed prompt 15's shape against his DripJobs proposals and found three gaps. First, an estimate can hold only ONE system, but a real job is a garage plus a patio plus stem walls. Second, there is no way to add a line item on top of the floor (stem walls, drive time, upgraded flake color), and those are the upsell. Third, and biggest: a DripJobs proposal carries a long, specific SCOPE OF WORK per line item ("2 day system, Day 1, diamond grind with 14 or 30 grit metal bond tooling, does not include cracks wider than 1/8 inch..."), and that writing is most of what the customer actually reads. Right now our estimate produces a number and no document.

His real templates have been extracted from DripJobs (read-only) into dripjobs-scope-templates.md at the repo root: 8 templates, 12 line items, verbatim. THAT FILE IS THE SEED DATA FOR THIS BUILD. Read it first. It is the actual language he sells with, including the exclusions and the cure-time warnings, and it is legal and operational text. Do not rewrite it, tidy it, or "improve" it. Its awkward bits (the "is/is not included" placeholders a rep edits per job, the "BLANK" placeholders in the patio templates, the fact that Concrete Polishing without joint filler is a project-specific document with [Client Name] baked into it) are all documented in the extraction notes and are Dylan's problem to clean up, not yours to guess at.

## Decisions locked with Dylan

1. MULTI-SYSTEM: an estimate has AREAS, and each area picks its OWN system type and sqft. Pricing and line items roll up from the areas. This is the smallest change to the estimate_areas table, which already carries system_type_id per area.
2. ADD-ONS come from a CATALOG TABLE that Dylan manages, not free text.
3. Add-ons carry a COST and a PRICE, so GP% stays honest when a rep piles on upsells. An add-on with revenue and no cost inflates GP on every estimate that uses it, and then the GP warning you shipped in prompt 15 becomes a liar.
4. SCOPE TEXT: template per system type (Dylan's real language, seeded from dripjobs-scope-templates.md), and the AI merges in THIS job's specifics. Not fully AI-written. The exclusions in that text are what protect him in a dispute, and a model that rewrites them freehand will eventually soften the one clause that mattered.
5. The AI NEVER silently overwrites a human edit. If Dylan has touched the scope text and the estimate then changes, the text is marked stale and a Regenerate button appears. His words are never lost without a click.
6. The AI PRICE READ (built in prompt 15) additionally reads the customer's Quo (OpenPhone) history: calls, transcripts, and texts, to gauge intent.
7. The estimator is BOTH a modal (over the lead or the estimate page) and a full page at /estimator/ with a working Back button. Same code, two surfaces.

## The build

### 1. Migration: supabase/migrations/2026-07-13_estimate_addons_scope.sql

- pec_prod_addons (the catalog): id, name, description, unit ('each' / 'sqft' / 'lf' / 'hour'), default_price numeric, default_cost numeric, is_optional_default boolean, scope_snippet text (the paragraph that gets appended to the customer scope when this add-on is on the estimate), system_type_id uuid NULL (null = applies to any system), active boolean, sort_order int. Seed it from the add-ons that already exist in Dylan's templates: Stem Walls (optional, 270-char scope snippet in the extract), Filling Control Joints (optional), Showroom Second Polyaspartic Top Coat Upgrade, High Wear Urethane, plus Drive Time and Upgraded Flake Color which Dylan named but which have no DripJobs snippet yet (seed those with an empty scope_snippet and flag it in your log so he can fill them in).
- estimate_line_items: id, estimate_id, addon_id NULL (null = it is a system/area line, or a one-off), estimate_area_id NULL, label, description (the customer-facing scope text for THIS line), qty, unit_price, unit_cost, total, is_optional, selected_by_customer, sort_order. If prompt 15 already put line_items on estimates as jsonb, MIGRATE it to this table and say so; a customer ticking an optional item on a public page is a write, and jsonb array writes race.
- pec_prod_system_types.scope_template text: the verbatim template per system, seeded from dripjobs-scope-templates.md. Map each template in that file to the matching system type row. If a template has no matching system type (Ameripolish stain, concrete polishing, grind and seal packages), CREATE the system type or leave scope_template null and list the unmatched ones in your log. Do not force a bad mapping.
- pec_prod_system_types.deposit_pct: the extract shows 50% on the flake garage templates and 25% on the moisture barrier and grind-and-seal ones. Prompt 16 needs this. Seed from the extract.
- estimates.scope_text (the assembled customer-facing document), estimates.scope_edited_at (non-null means a human touched it), estimates.scope_stale boolean, estimates.scope_generated_at, estimates.scope_model text.
- Footer check queries proving each table, column, and seed row exists, per repo convention.

### 2. Multi-system areas (apps/estimator)

- The area row gains its own System select. The estimate's system_type_id becomes the DOMINANT area's system (the one with the most sqft) for reporting, and every area prices with its own system's recipe, defaults, and target GP.
- The pricing engine (lib/calculator) currently takes one systemTypeId for the whole estimate. Read it before you touch it and keep the per-area math it already does; this is a change to how the system is CHOSEN per area, not a rewrite of the pricing.
- GP warning: with mixed systems the target GP is the sqft-weighted average of the areas' target_gp_pct. State that in a comment; a naive mean would let a small high-target area drag the warning.
- The comps panel from prompt 15 keys off the dominant system. When an estimate spans systems, say so in the panel rather than pretending the comps cover the whole job.

### 3. Add-ons in the estimator

- An "Add-ons" section under the areas: pick from the catalog (filtered to the areas' systems plus the any-system ones), set qty, and the price and cost prefill from the catalog and stay editable.
- Optional add-ons render in their own group. An optional item is EXCLUDED from the estimate total and from GP until the customer selects it on the public page (prompt 16). Show both numbers to the rep: the base price and the price if every optional item is taken.
- A free-typed one-off line stays possible (label, description, price, cost), because the job site always produces something the catalog does not have. Flag one-offs in the UI so Dylan can see what keeps getting typed and promote it to the catalog.

### 4. AI scope writing: netlify/functions/pec-estimate-scope.cjs

- Input: the estimate with its areas (each with its system, sqft, flake color, and the system's scope_template), its add-ons (each with its scope_snippet), and the production detail (coat past garage, stem walls, moisture, gate code).
- The model's job is ASSEMBLY AND SUBSTITUTION, not authorship. Say this in the system prompt in exactly these terms: the templates are the source of truth; keep every exclusion, cure-time warning, and payment term VERBATIM; resolve the "is/is not included" placeholders from the estimate's actual data (stem walls on the estimate means "Stem walls ARE included"); fill the sqft, the flake color, the area names, and the expected duration; and when the data does not say, leave the placeholder rather than guessing. It may not invent scope, may not soften an exclusion, and may not add a warranty term.
- Output: one scope document per line item (each area's system, each add-on with a snippet), assembled into estimates.scope_text, plus per-line description on estimate_line_items so the customer page can show the scope under each line exactly like the DripJobs proposal.
- Auth, timeout, and text extraction: clone pec-lead-ai.cjs. CRITICAL: use the textFromMessage() helper pattern from commit 613245a (filter content blocks for type === 'text' and JOIN them). Do NOT index content[0].text. That exact assumption silently broke the lead AI in prod, and this function will hit the same trap.
- Runs on demand from the estimate page (Generate scope), and automatically once on first save when scope_text is null.
- STALENESS, and this is the part to get right: if scope_edited_at is null, a change to systems/areas/add-ons regenerates freely. If scope_edited_at is NOT null, a change sets scope_stale = true and the UI shows "The estimate changed since you edited this scope" with a Regenerate button. Regenerating after a human edit must require that explicit click and must warn that it will replace the edited text. Never auto-overwrite.
- The scope is a rich-text-ish document. Store markdown or sanitized HTML, pick one, and sanitize on the way OUT to the public page in prompt 16 (never render raw model output into a customer page without escaping).

### 5. Quo history in the AI price read (extend pec-estimate-ai.cjs from prompt 15)

- Pull the lead's Quo history: 'call' lead_events (the OpenPhone sync writes calls with transcripts there) and the SMS thread (pec-webhook-quo.cjs already logs messages; find where they land and read that, do not build a second integration).
- Feed it to the price-read prompt as INTENT SIGNAL: urgency, budget language, competing quotes, timeline, who the decision maker is. Ask for specific quotes from the transcript to justify any claim, so the read is auditable instead of vibes.
- HONESTY REQUIREMENT: pec-openphone-sync has never successfully returned data from the live API (its GET /v1/calls listing shape is unverified, see the 2026-07-11 Cowork log entry). Assume the transcript source may be EMPTY. When there is no Quo history, the panel must say "no call history on file" and the AI must not infer intent from silence. Do not let this feature's absence break the price read.

### 6. Estimator surfaces

- Modal (iframe, embed=1) over the lead detail AND over the estimate page's Edit button.
- Full page at /estimator/ with a Back button that returns to wherever the rep came from (document.referrer when it is same-origin, else the dashboard root). A full-screen estimator that dead-ends is what Dylan is complaining about.
- Both surfaces are the same React app. No duplicated form.

## Guardrails

- Offline still works. The estimator's IndexedDB outbox is the reason a rep can quote in a driveway with no signal. Areas, add-ons, and line items all have to ride the outbox in FK order (estimates -> estimate_areas -> estimate_line_items). The scope generation is the one thing allowed to require a connection: offline, save without it and generate later, with the UI saying so.
- Do not touch invoicing, payments, commission, or change orders.
- Never render model output into HTML without escaping.
- Both modal roots, if you touch modal lifecycle.
- No em dashes.
- What's New: multi-system estimates, add-ons, and the auto-written scope are each user-visible. Internal plumbing is not.
- Harness tests, driving the real extracted functions: two areas with two different systems price with their own recipes; the sqft-weighted target GP; an optional add-on excluded from the total until selected; add-on cost flowing into GP (an add-on with price and no cost must NOT inflate GP once cost is set); scope generation resolving "stem walls are/are not included" both ways from the estimate data; an edited scope going stale instead of being overwritten; regeneration requiring the explicit click; the Quo-empty case producing "no call history on file" rather than invented intent; and an offline save with areas + add-ons landing complete when the outbox drains.

## After

Append a PROJECT-LOG.md entry (By: Claude Code) at the TOP: commit SHAs, the migration's footer-check results, which DripJobs templates mapped cleanly to system types and which did NOT, which add-ons you seeded with an empty scope_snippet (Drive Time, Upgraded Flake Color), and what you tested. Flag anything in dripjobs-scope-templates.md that looks like it needs Dylan's editorial attention (the [Client Name] and "BLANK" placeholders, the 3,000 SF dental office baked into the polishing template) rather than silently cleaning it up.
