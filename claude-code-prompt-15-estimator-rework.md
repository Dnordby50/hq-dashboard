# Claude Code build prompt 15: thin estimator modal, real numbered estimates

SCOPE: this prompt is the INTERNAL half. The customer-facing proposal (send, public page, sign, accept-creates-job) is prompt 16 and runs as its own session. Do not build it here. The migration below deliberately lays the columns 16 needs, so 16 is additive and does not reshape anything you ship.

## Context

Repo: hq-dashboard (github.com/Dnordby50/hq-dashboard, main). Deploy: prescottepoxy.netlify.app (Netlify auto-deploys main). Supabase: zdfpzmmrgotynrwkeakd. This builds directly on commit 613245a (Cowork, 2026-07-11), which fixed the Anthropic content-block parsing bug in pec-lead-ai / pec-metrics-ai and taught the estimator to read ?lead_id=. Confirm 613245a is on main before you start; if it is not, stop and tell Dylan.

The weekend leads build (phases 1 to 4, 2026-07-11) shipped: a Zapier lead-intake webhook, a six-stage Leads kanban, $/sqft plus a Metrics Sales section, and a lead detail page with an AI panel. The estimator is a separate React PWA at apps/estimator (Vite, base /estimator/, IndexedDB offline outbox, built by the Netlify build command into repo-root /estimator). Its lead detail page has a "Start estimate" button (index.html:16630) that opens /estimator/?lead_id=<uuid> in a NEW TAB.

Dylan's verdict after using it: the estimator asks for far too much detail up front, it opens in a tab instead of over the dashboard, and a saved estimate is a dead end. It has no number, no page, no customer-facing document, and no way to reopen it. He is replacing DripJobs, whose model is a deal card that becomes a real numbered proposal with a customer view, a link, and a signature. He does not want DripJobs' deal card, but he does want the second half: once an estimate is started it becomes a first-class object with its own page and its own number.

This prompt is the internal half of that build: the thin modal, the pricing intelligence, and the estimate as a real numbered object with its own page. Prompt 16 turns it into a document the customer signs.

## Facts already verified against prod (do not re-derive, but do not blindly trust either, re-check anything you are about to depend on)

- estimates columns TODAY: id, lead_id, brand, system_type_id, status, intake, materials_cost, fixed_addons, labor_pct, commission_pct, target_gp_pct, price, price_increment, gp_dollars, gp_pct, gp_per_hour, labor_budget, commission_dollars, budgeted_hours, material_plan, scope_of_work, calc_version, public_token, signature, signed_name, signed_at, signed_ip, deposit_payment_id, deposit_amount, job_id, pec_prod_job_id, created_by, created_at, sent_at, accepted_at, updated_at, client_updated_at, rev, deleted_at. Most of the proposal plumbing (public_token, signature, sent_at, job_id) EXISTS and has never been used.
- estimates currently holds exactly ONE row. There is no legacy data. Reshape aggressively.
- There is NO public estimate page and NO estimate-accepted-creates-job path anywhere in the repo. pec-public-invoice.cjs (/pay/<token>) and pec-public-change-order.cjs are the templates for both.
- pec_prod_recipe_slots ALREADY has default_product_id. Defaulting products per system needs NO migration.
- jobs.sqft is a TEXT column. Any $/sqft math must cast it (nullif(regexp_replace(coalesce(sqft,''),'[^0-9.]','','g'),'')::numeric) and treat 0 or unparseable as unknown, exactly as jobEffectiveSqft does client-side.
- Comps data is THIN: 35 completed jobs total (completed_date not null, not archived, not voided), 32 with usable sqft and price, all 35 with system_type_id. Actual GP comes from pec_prod_job_costing (34 rows: materials_ordered_cost, materials_used_cost, equipment_rental_cost, salary_wages_cost, subcontractor_cost, misc_cost, bonus_cost, commission_cost).
- pec_prod_system_types has target_gp_pct per system. Use it for the GP warning threshold, not a hardcoded number.

## Decisions locked with Dylan (do not relitigate these, build them)

1. The estimator opens in an IFRAME MODAL over the dashboard, not a tab. The PWA stays exactly as it is architecturally (offline is essential, reps quote in driveways with no signal). The modal is a shell around /estimator/?lead_id=.
2. The modal asks for almost nothing: SYSTEM TYPE, SQFT, and a STANDALONE MVB toggle. Everything else is optional and collapsed.
3. MVB is BOTH an add-on to a system AND sellable standalone. Handle both.
4. Products come from pec_prod_recipe_slots.default_product_id per system, always applied by default, editable inside a collapsed "More detail" section.
5. The production detail (gate code, moisture, Mohs, grinder grit, non-slip, stem walls) STAYS in the estimator modal, but inside that collapsed "More detail" section, never blocking a price.
6. Flake color is optional at estimate time and editable later on the estimate page (the customer often picks the color after the presentation).
7. Comps: same system type, sqft within plus or minus 25%, completed in the last 12 months. When fewer than 3 match, WIDEN (same system any size, then similar size any system) and SAY SO with the sample count and what rule produced it. Never silently mislead.
8. AI price analysis runs AUTOMATICALLY once system type and sqft are both present.
9. Discount: the rep can free-type a sell price OR apply a discount percentage. Either way the GP% updates live and turns red below the system's target_gp_pct. Nothing is blocked.
10. Saving from the modal closes it, returns to the lead, and shows the estimate.
11. Launchable from the lead detail page AND the existing sidebar Estimator button (walk-up estimates with no lead).
12. Customer info (name, address, phone, email) is captured on the estimate, prefilled from the lead when there is one, always editable.
13. An estimate gets its OWN PAGE and its OWN NUMBER. Format: EST-<n>, sequential, STARTING AT 102026 (so the first estimate is EST-102026, then EST-102027). Dylan said "start at a 102026"; build exactly that and note it in the log so he can correct it in one line if he meant something else.
14. Estimates support LINE ITEMS including OPTIONAL items the customer can add (the upsell: stem walls, MVB, extra bay). Optional items are excluded from the total until the customer ticks them.
15. An ESTIMATES LIST view: chronological, with a search bar.
16. The estimate page is PRIVATE UNTIL SENT. The public link does not work before sent_at is set. Once sent, the customer can (a) sign and accept, (b) request changes with a message, or (c) reject with a reason.
17. NO Stripe deposit on the public estimate page. Dylan's answer named sign / request changes / reject and nothing else, and the deposit already has a working home in the invoice path. Do not build a second money path. If you think this is wrong, say so in the log; do not just build it.
18. Reopening an estimate edits it IN PLACE (no version history this round).

Decisions 16 and 17 describe prompt 16's behavior. They are listed here only so the migration below creates the right columns the first time. Do NOT build the sending, the public page, or the accept-creates-job path in this session.

## The build

### A1. Migration: supabase/migrations/2026-07-12_estimate_objects.sql

- estimates.estimate_number: integer, unique, NOT populated by the client. Back it with a Postgres sequence starting at 102026 and a default, so two reps saving at once cannot collide. The UI renders it as EST-<number>.
- estimates.line_items jsonb (mirrors jobs.line_items, which is already jsonb): array of { id, label, description, qty, unit_price, total, optional (bool), selected_by_customer (bool), created_at }. Optional items are excluded from price until selected_by_customer is true.
- estimates.mvb text or a pair of columns: capture BOTH "MVB as an add-on to the system" and "MVB sold standalone". Pick one representation and defend it in a comment.
- estimates.flake_color text (nullable, filled in after presentation).
- estimates.customer_name / customer_email / customer_phone / customer_address (nullable text), prefilled from the lead.
- estimates.status: extend the allowed set to draft, sent, signed, accepted, change_requested, rejected, lost. Use a CHECK constraint so nothing can invent a seventh, the same discipline as leads_stage_check.
- estimates.change_request_note text, estimates.rejected_reason text, estimates.rejected_at timestamptz.
- Indexes: estimates(lead_id), estimates(status), estimates(created_at desc), unique on estimate_number, unique on public_token.
- RLS: staff read/write per the existing estimates policy; the public page reads through the service role in a Netlify function ONLY (never a public RLS grant on estimates).
- Footer check queries that prove each column and index exists, per the repo's migration convention.

Apply it to prod yourself via the Supabase MCP if you have it in-session; if not, hand it to Cowork.

### A2. The estimator modal (index.html)

- Replace the `<a href="/estimator/?lead_id=..." target="_blank">Start estimate</a>` at index.html:16630 with a button that opens a modal containing an iframe at /estimator/?lead_id=<id>&embed=1.
- Same for the sidebar Estimator button (wireEstimatorNav, index.html ~6476), which currently does window.location.assign('/estimator/'). It opens the same modal with no lead_id.
- ARCHITECTURE GOTCHA, from CLAUDE.md: there are TWO modal roots (#pecModalRoot with the openModal/closeModal helpers around index.html:4808, and #prodModalRoot with hand-rolled inline flows). Use #pecModalRoot and its helpers. Do not hand-roll a third pattern.
- The iframe talks to the dashboard by postMessage, and the dashboard MUST validate event.origin against its own origin before acting on any message. Messages: { type: 'pec-estimate-saved', estimate_id, estimate_number } and { type: 'pec-estimator-close' }. On saved: close the modal, refresh the lead detail, and open the new estimate's page.
- The estimator app reads ?embed=1 and hides its own topbar Dashboard link (it is inside the dashboard already).

### A3. Thin the estimator (apps/estimator)

- The default screen is: Salesperson, System type, Sqft, and an MVB control (off / add-on / standalone). That is the whole above-the-fold form. A price appears as soon as system and sqft are set.
- "More detail" is a collapsed section holding what exists today: the recipe slot pickers (prefilled from pec_prod_recipe_slots.default_product_id and editable), flake color, gate code, moisture, Mohs, grinder grit, additional non-slip, stem walls, special notes. A rep who never opens it still gets a correct price off the defaults.
- Areas stay, but a single "Main" area with a sqft box is the default and adding areas is one click. Do not make a one-garage estimate feel like a commercial bid.
- Customer block at the top: name, phone, email, address. Prefilled from the lead when lead_id is present (extend lib/lead.ts's loadLeadLink, which already fetches the lead), always editable, and written to the estimate's customer_* columns.
- Discount control: a sell-price input and a discount-% input, either of which drives the other. Below them, live GP$ and GP%, with the GP% turning red when it falls under the system's target_gp_pct. Never block the save.
- The save path (offline/estimates.ts) writes the new columns through the outbox unchanged, exactly as lead_id already does, so an estimate written with no signal still lands complete.

### A4. Pricing intelligence panel (in the modal, right side)

Two halves, and this split is deliberate:

- COMPS, rendered instantly from the database with NO model call, so the numbers are never gated behind an API: completed jobs matching rule 7 above, each row showing customer, sqft, price, $/sqft, and actual GP% (from pec_prod_job_costing: GP = (price - sum of all cost columns) / price). Show the group's MEDIAN $/sqft (median, not mean, because 35 jobs means one commercial outlier would wreck a mean). State exactly which rule produced the set and the sample size, e.g. "4 jobs, same system, 480 to 800 sqft, last 12 months" or "widened: same system, any size (2 exact-size matches found)".
- AI RECOMMENDATION, a new netlify/functions/pec-estimate-ai.cjs, fired automatically once system type and sqft are both present (debounce it; do not fire on every keystroke of the sqft field). It gets the comps, the calculator's price, and the system's target GP, and returns a recommended sell range with a one-paragraph why. It NEVER sets the price; the rep does.
  - Clone pec-lead-ai.cjs's dual auth (staff JWT or x-webhook-secret) and its AbortController-at-25s guard.
  - CRITICAL, this is the bug that just cost a day: extract the model's text with the textFromMessage() helper pattern from commit 613245a (filter content for type === 'text' and join). Do NOT index content[0].text. Block zero is not guaranteed to be the text block, and JSON.parse('') throws "Unexpected end of JSON input", which is exactly how the lead AI failed silently in prod.
  - Cache the result on the estimate row so reopening does not re-bill a model call. Regenerate when system type, sqft, or MVB changes.
  - When there are zero comps, the AI must SAY it is pricing without comparables rather than inventing confidence.

### A5. The estimate page and list (index.html)

- Estimate detail view: header with EST-<number>, status chip (draft / sent / signed / accepted / change requested / rejected), customer block, system + sqft + MVB, price with GP% and the discount applied, line items table (with an OPTIONAL ITEMS section), flake color (editable here, this is the post-presentation entry point Dylan asked for), the production detail, the comps and AI read that priced it, and an activity trail.
- Actions: Edit (reopens the estimator modal prefilled, edits in place), Mark accepted manually, Mark lost. Leave a disabled "Send to customer" button with a title explaining it lands in the next build, so the page does not look broken.
- Estimates list view in the sidebar: chronological (newest first), with a search bar matching estimate number, customer name, phone, and address. Columns: number, customer, system, sqft, price, GP%, status, age.
- The lead detail page gains an Estimates section listing that lead's estimates with their numbers and statuses, each linking to the estimate page.

## Guardrails

- Do not touch the invoicing, payment, commission, or change-order code paths. They were just stabilized.
- Do not reinstate a no-op auth lock in the supabase-js config, and keep timedFetch. See the wedge section of CLAUDE.md.
- Any modal lifecycle change must be applied to BOTH modal roots or explicitly justified for skipping one.
- No em dashes anywhere in code, comments, UI copy, or the log.
- What's New entries (help/whats-new.json) for the user-visible parts: the estimator modal, the estimate page and numbers. Internal plumbing gets none.
- Test with your usual harness: drive the REAL extracted functions, not reimplementations. Cover at minimum: the comps rule including the widen fallback and the empty case, the median $/sqft with the TEXT sqft column parsed, the GP-red threshold reading target_gp_pct per system, optional items excluded from the total until selected, the estimate number sequence handing out distinct numbers under concurrent saves, an estimate saved OFFLINE landing complete when the outbox drains, and the postMessage origin check rejecting a foreign origin.

## After

Append a PROJECT-LOG.md entry (By: Claude Code) at the TOP, with the commit SHAs, the migration's footer-check results, what you tested, and any judgment call you made that differs from this prompt. Name the estimate number you actually started the sequence at so Dylan can confirm 102026 was what he meant. End with a note that prompt 16 (customer-facing proposal) is the next build and what you left stubbed for it.

Handoffs: the migration goes to Cowork if you cannot apply it in-session. Everything else in this prompt is Claude Code's own work; do not hand off code edits.
