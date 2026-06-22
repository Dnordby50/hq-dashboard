# Claude Code Framework: Front-End Estimator + Lead/Drip/Sales CRM (Beta)

Status: PLANNING BRIEF. This is the framework Dylan wants Claude Code to plan from, not a finished implementation spec. Claude Code should read it, then produce its own implementation plan (phasing, file structure, migrations, test plan) before writing code. Do not start building until the plan is reviewed.

Owner: Dylan Nordby. Repo: HQ-Dashboard (PEC CRM / TopCoat). Deploy: Netlify (prescottepoxy.netlify.app). Source of truth for state: PROJECT-LOG.md + CLAUDE.md.

---

## 1. What we are building and why

A new, hidden, admin-only area of the active CRM: a customer-facing, on-site ESTIMATOR plus the lead management, drip, sales-activity, presentation, and metrics layers that turn it into a full sales front end. Over roughly the next month this replaces DripJobs as the system of record. Dylan runs PEC and FTP; this beta is PEC (epoxy) only for v1.

The differentiator (Dylan's words): heavy on metrics, estimation, and presentation, with AI deeply involved through the existing Topcoat MCP connector. "Something no other CRM uses." The estimator must do on-site what DripJobs does slowly and generically: select a system type, answer the same questions that are on the work order, and instantly generate scope of work, material usage (behind the scenes during beta), labor hours, price, GP, and commission, then build a value-building presentation to show and send.

### The single most important architectural fact

We are NOT writing new estimating math. A real estimating engine already exists in this repo and is the source of truth for job costing. The beta LIFTS that logic onto a mobile, customer-facing front end and adds pricing, presentation, and AI on top. Reusing it (not rewriting) keeps one source of truth and honors Dylan's standing rule: "exactly what is on the front-end job estimation is what populates into Job Costing. Nothing different at all."

---

## 2. Decisions locked in the discovery interview (2026-06-21)

| Area | Decision |
|---|---|
| Structure | New area inside the ACTIVE CRM, admin-gated so the team does not see it mid-build. A major final piece, not a separate repo. |
| Tech stack | Claude Code's call, optimizing for cleanest / most professional. (Recommendation + constraints in section 9.) |
| DripJobs | Augment now, run in parallel ~1 month, then cut over and jump off DripJobs. |
| Offline | The WHOLE CRM must work offline and re-sync when reconnected. (Biggest architectural driver. See section 8.) |
| Pricing | Cost-plus to a target margin. Global target GP ~50% (configurable; confirm exact figure). |
| Systems | All 5 existing systems: Flake, Quartz, Metallic, Grind and Seal, Grind Stain and Seal. |
| Labor | Keep the current model: per-system labor_budget_pct of revenue. |
| Commission | Percent of revenue. |
| AI in estimate | All four: show comparable past jobs, auto-draft scope of work, sanity-check price + flag margin risk, suggest next questions from past jobs. Suggest-only (rep confirms every number). |
| AI data source | Both: live Topcoat MCP connector data + a curated playbook layer. |
| AI elsewhere | Drip copy, next-best-action / follow-up timing, presentation personalization, lead scoring. |
| Presentation | Interactive live link + auto-generated PDF fallback. Value blocks: FloorWiz color viz, warranty + system/process, before/after gallery + reviews, financing + good/better/best. |
| Acceptance | E-signature + deposit in-app. |
| Brand scope | PEC epoxy only for v1. |
| Send channels | Text via OpenPhone; email via the CRM's existing Resend email platform. |
| Drip | Fully automated sending (compliance guardrails are mandatory, see section 7). |
| Lead sources | Manual entry, DripJobs import, inbound call/text auto-capture (OpenPhone), web form / Google LSA, Meta lead ads, Angi. |
| Users/roles | Dylan only during beta; role logic (rep vs admin) built but dormant until cutover. |
| Metrics | Sales volume, average job size (AJS), GP$/GP% per estimate and job, conversion (estimate-to-sold), and closing ratio sliced by salesperson, lead source, and system type; plus drip + lead-source ROI and pipeline by stage. |
| v1 cut-line | Dylan wants everything at once for cutover. (Honest risk note in section 11.) |

---

## 3. What already exists in this repo (reuse, do not rebuild)

Claude Code: read these before planning. file:line anchors are from the current main.

### Estimating engine (the core to lift)
- `window.computeJobEstimate` (index.html ~17498-17522, mirrored in `production/calculator.js`): the ONE shared estimate function. Inputs an area set; returns materialsBudget, laborPct, laborBudget, budgetedHours, and materialLines.
- `computeMaterialPlan` -> `_planForArea` (~17606-17676) + `_mergeAcrossAreas` (~17677-17726): material quantity math. `qty_needed = CEILING(sqft_total / spread_rate / kit_size)`, summing sqft across areas BEFORE the ceiling so the same product across areas does not over-order. `line_cost = qty_needed * unit_cost_snapshot`.
- `computeCostingRow` (~14833-14915): GP math. GP = revenue - (materials used + labor + burden + bonus + commission + equipment + subs + misc). Returns gp, gpPct, gpPerHour, budgetedHours, laborBudget, buckets. The estimate-time GP must use the SAME bucket definitions (materials, labor, commission) so estimate and costing never disagree.
- `computeCrewBonus` (~14947-14976): 75%-of-labor-savings split, 25% burden, OT-aware (1.5x). Not needed at estimate time, but it consumes laborBudget, so the estimate's laborBudget must stay identical.

### System / recipe / material catalog (Supabase)
- `pec_prod_system_types`: name, labor_budget_pct, materials_budget_pct, requires_flake_color, requires_basecoat_color, active, sort_order. (Seeded: Flake, Quartz, Metallic, Grind and Seal, Grind Stain and Seal.)
- `pec_prod_recipe_slots`: per-system ordered slots (material_type, slot_kind product|multi_product|choice|text, label, min/max_select, default_product_id, required, editor_hidden, options jsonb). This is the question/recipe spine for each system. The estimator's question flow per system should be GENERATED from these slots, not hardcoded.
- `pec_prod_products`: name, supplier, color, material_type, spread_rate, kit_size, unit_cost, cure speed variants. Drives all quantity + cost math.
- `job_areas` / `pec_prod_areas` + `job_area_materials`: per-area sqft, system, and chosen products (incl. multi-product picks).

### Work-order intake fields (the on-site questions)
Already columns on `public.jobs` (migration 2026-05-24_job_card_fields.sql): `gate_code`, `coat_past_garage` (bool), `stem_walls` (bool), `moisture` (int 1-5), `mohs_hardness` (int 1-10), `additional_non_slip` (text), `grinder_tooling_grit` (text). The estimator asks exactly these, plus system-specific slot questions. Special notes -> a free-text field.

### Delivery + money infra (reuse)
- Email: full Resend platform already built. `netlify/functions/pec-send-email.cjs` (service-role send), `pec_email_senders` / `pec_email_templates` / `pec_email_log` (migration 2026-05-31_email_platform.sql), open/click/bounce tracking via `pec-webhook-resend.cjs`. Estimate-send email AND drip email both ride this. Do not build a second email path.
- Payments: existing payment insert path + recover-verify-retry pattern (CLAUDE.md "supabase-js wedge" section). The deposit-at-acceptance flow must reuse the existing idempotent payment write, never a blind retry.
- Connector: Topcoat MCP (`netlify/functions/mcp.cjs`, v0.2, read-only): get_schedule, get_sales_summary, find_customers, find_jobs, list_pipeline. This is the AI's live data source. A v0.3 may need read tools for estimates/leads once those tables exist.

### Architecture gotchas to respect (from CLAUDE.md)
- Two parallel job tables (`public.jobs` vs `pec_prod_jobs`) — understand which the new estimate writes to and how it bridges.
- Two modal roots — any shared modal lifecycle work must cover both.
- The supabase-js auth-lock wedge — keep `timedFetch`, the recover/retry helpers, and never wrap a non-idempotent write in a blind retry.

---

## 4. The pricing engine (the new math — get this exactly right)

This is the one genuinely new calculation. Cost-plus to a target margin, with labor and commission both defined as a percent of revenue, is mildly circular (labor and commission depend on revenue; revenue depends on total cost). It has a clean closed-form solution. Build it as one pure, unit-tested function mirrored into `production/calculator.js` exactly like `computeJobEstimate`.

Definitions (per estimate):
- `M` = estimated material cost = sum of `qty_needed * unit_cost_snapshot` from the existing material plan.
- `F` = fixed / direct add-ons not proportional to revenue (e.g., extra prep, mobilization, optional adders). Default 0.
- `laborPct` = `system.labor_budget_pct / 100`.
- `commPct` = commission rate as a fraction of revenue.
- `targetGP` = target gross-profit fraction (default 0.50, configurable; per-system override allowed).

Solve for revenue `R` such that GP% = targetGP, where cost buckets match `computeCostingRow`:

```
GP = R - (M + laborPct*R + commPct*R + F)
GP/R = targetGP
=> R * (1 - laborPct - commPct - targetGP) = M + F
=> R = (M + F) / (1 - laborPct - commPct - targetGP)
```

Guard: if `(1 - laborPct - commPct - targetGP) <= 0`, the target is mathematically impossible for those inputs — surface a clear error, do not divide. Round R to a sane price increment (e.g., nearest $5 or $25) and recompute GP so the displayed GP matches the rounded price.

Worked example (illustrative numbers; real M comes from the DB):
- 400 sqft flake garage. M = $600, laborPct = 0.20, commPct = 0.08, targetGP = 0.50, F = 0.
- R = 600 / (1 - 0.20 - 0.08 - 0.50) = 600 / 0.22 = $2,727.
- labor = 0.20 * 2727 = $545; commission = 0.08 * 2727 = $218; GP = 2727 - 600 - 545 - 218 = $1,364 = 50.0%. Correct.

The estimate screen shows, live as the rep answers questions: price, GP$, GP%, GP/hr, commission$, budgeted hours. Material quantities are computed (they drive M) but the rep-facing quantity readout stays HIDDEN until after beta validation, per Dylan. The hidden-vs-shown line should be a single feature flag.

Required inputs to confirm before this is real (see section 12): exact target GP% (global ~50% assumed), the commission rate, and whether targetGP varies per system.

---

## 5. The estimate flow (on-site UX)

1. Pick or create a lead/customer (works offline).
2. Select system type (one of the 5). The question set is generated from `pec_prod_recipe_slots` for that system plus the standard work-order intake questions.
3. Answer questions: area name + sqft (multi-area supported), stem walls, coat past garage door, moisture (1-5), MOHS hardness (1-10), additional non-slip, grinder grit (grind systems), gate code, special notes, and system-specific slot picks (e.g., flake color, basecoat color, metallic pigments, quartz broadcast). AI suggests the next relevant questions from comparable past jobs (suggest-only).
4. Engine computes material plan (existing), then the pricing engine computes R, GP, commission, hours — live.
5. AI sanity-checks: compares price/sqft, GP, and hours to comparable past jobs (via the connector) and flags anomalies. AI auto-drafts the scope-of-work narrative from the structured inputs (rep edits/approves).
6. Build presentation (section 6) and present on the tablet.
7. Send by text (OpenPhone) + email (Resend). Capture e-signature + optional deposit.
8. Everything persists locally and syncs to Supabase when connected, then (during the parallel month) optionally bridges to the existing job pipeline so production still sees booked work.

---

## 6. Presentation + acceptance

- Format: interactive, swipeable web presentation (the live link), with an auto-generated branded PDF fallback. One content source renders both.
- Value blocks: (a) FloorWiz color visualization, (b) warranty + system/process explained, (c) before/after gallery + Google reviews, (d) financing + good/better/best tiered options (anchors value, lifts AJS). AI personalizes ordering/emphasis to what the customer said they care about (durability, look, price, speed).
- Acceptance: e-signature + optional deposit inside the presentation. Reuse the existing idempotent payment path for the deposit. Signature captured to the lead/estimate record.
- Tracking: opens/clicks via the existing Resend webhooks for email; link-open tracking for the web presentation so the metrics layer and next-best-action AI can see engagement.

### FloorWiz (investigated)
FloorWiz is a hosted epoxy floor visualizer with a CMS, website embed, lead capture, 2D/3D scenes, a custom flake-blend builder, and (per their site) custom CRM API integration available at the Pro+ tier. Recommended path: BETA = embed/link the FloorWiz visualizer and let the rep attach the generated color image to the presentation (no integration dependency, ships day one). PHASE 2 = once on FloorWiz Pro+, wire their API to pull the render and the selected blend straight into the presentation and onto the order/work-order. Treat the API path as an enhancement, not a v1 blocker. Confirm Dylan's FloorWiz tier (section 12).

---

## 7. Lead management + drip

- Lead intake from: manual entry (offline-capable), DripJobs import (one-time + ongoing during the parallel month), OpenPhone inbound call/text auto-capture (new caller/texter -> lead with transcript attached; the connected messaging connector exposes fetch-messages / fetch-call-transcripts / fetch-missed-calls / list-inboxes / send-message), web form / Google LSA, Meta lead ads, and Angi. Each source is an adapter writing into one normalized `leads` table with a `source` field (powers closing-ratio-by-source metrics).
- Pipeline stages: lead -> contacted -> estimate sent -> presented -> accepted/lost, with timestamps for speed-to-lead and stage-conversion metrics.
- Drip: fully automated sequences keyed to stage + source, with AI-drafted, personalized copy (text via OpenPhone, email via Resend). Next-best-action AI surfaces who to follow up with and when.

MANDATORY drip guardrails (non-negotiable for automated sending, and a real legal exposure for SMS):
- Per-contact opt-out / STOP handling and a global suppression list. A reply of STOP must halt all sequences for that contact immediately.
- Quiet hours (no texts outside ~8am-9pm local) and per-contact rate limiting / dedupe so no one gets double-touched.
- A kill switch and a visible queue of what is about to send, with full send logging (reuse pec_email_log pattern; add an sms_log).
- Consent capture on lead intake where the source allows it. Build these BEFORE enabling auto-send, even though Dylan chose full automation.

---

## 8. Offline-first (the hardest part — plan it first)

Dylan wants the WHOLE CRM available offline with re-sync. Offline-first across an entire CRM is one of the hardest things in software; it deserves the most planning and is the most likely thing to slip. Claude Code should evaluate two routes in its plan and recommend one:

- Route A (recommended to evaluate first): a purpose-built Postgres/Supabase sync engine — PowerSync or ElectricSQL — which gives local-first reads/writes and conflict handling against the existing Supabase tables with far less hand-rolled risk. Validate it coexists with the current dashboard's auth and RLS.
- Route B: hand-rolled IndexedDB local store + an outbox/queue of mutations + a sync reconciler. Maximum control, maximum risk, slowest to get correct (conflict resolution, ordering, partial failures).

Either way, define the conflict model (last-write-wins vs per-field merge), what is cached for offline (the estimator path is the must-have; full-CRM-offline is the stretch), and how money actions (deposits) are handled offline (recommendation: deposits require connectivity; queue everything else). Strongly consider scoping v1 offline to the estimate-capture flow and expanding outward, rather than blocking cutover on the entire CRM working offline.

---

## 9. Tech, deployment, and hiding it from the team

- The existing dashboard is a single-file vanilla `index.html`. This beta is too stateful (multi-step estimator, live presentation, offline sync) to live cleanly in that pattern. Recommendation: build it as a modern component app (React + Vite PWA — clean, professional, offline-capable, deployable on Netlify alongside the current site), reached from a single admin-only nav button in the existing dashboard. That satisfies "an area or button only I can see" without bloating index.html. Claude Code may propose an alternative if it argues the trade-offs.
- Gate it behind the existing admin role check + a feature flag, so reps never see it until cutover.
- Reuse the existing Supabase project, auth, RLS patterns, email platform, payment path, and MCP connector. New tables get RLS consistent with `is_admin_staff()`.
- New AI calls run server-side in a Netlify Function using the Anthropic key (never in the browser), and/or orchestrate the Topcoat MCP read tools. Connector may need a v0.3 read tool set once `leads`/`estimates` tables exist.

---

## 10. Data model (new tables — Claude Code to finalize in its plan)

Sketch, not final. Respect existing tables; add:
- `leads` (id, source, contact info, status/stage, owner, score, consent flags, timestamps).
- `estimates` (id, lead_id, system_type_id, areas snapshot, intake answers, M cost, R price, GP, commission, hours, scope_of_work text, status, signed_at, deposit ref, created_by). Areas detail in a child table or jsonb.
- `presentations` (id, estimate_id, content/version, public_link_token, opened_at events).
- `drip_sequences` + `drip_steps` + `drip_enrollments` + `sms_log` (email reuses pec_email_log).
- Pricing config: target_gp_pct (global setting + optional per-system override on pec_prod_system_types), commission_pct.
All additive, idempotent migrations, NOT applied from Claude Code's session — hand off to Cowork to apply to prod per standing rules.

---

## 11. Phasing and an honest risk read

Dylan wants everything at once for cutover in ~a month. That is a large surface: a new estimator, a new pricing engine, full AI (4 in-estimate + 4 elsewhere), fully automated multi-channel drip with compliance, e-sign + deposit, six lead-source integrations, a deep metrics layer, AND whole-CRM offline-first — all customer-facing and replacing the system of record. Shipped well, that is more than a month; shipped fast, the risk is a half-built tool replacing a working one.

Recommended critical path inside the "everything" goal (so cutover is sequenced, not abandoned):
1. Foundation: app shell, auth/admin gating, Supabase tables, offline route decision + spike.
2. Estimator end-to-end: question flow from recipe slots + work-order fields, material plan reuse, pricing engine (unit-tested), live GP/commission/hours.
3. Presentation + send + e-sign + deposit (FloorWiz embedded, API later).
4. Leads + pipeline + DripJobs import; then the other lead-source adapters.
5. Drip with guardrails (build guardrails before enabling auto-send).
6. AI: ship comparable-jobs + scope-drafting first (highest leverage, lowest risk), then price sanity-check, then drip copy / next-best-action / personalization / lead scoring.
7. Metrics layer.
Treat full-CRM-offline and lead scoring as the two most likely to slip; do not let either block the DripJobs cutover.

Claude Code: produce a realistic week-by-week plan against this. If the timeline is infeasible, say so and propose the smallest cutover-capable scope.

---

## 12. Inputs Dylan / Cowork must provide (collect before/early in build)
- Exact target GP% (global ~50% assumed) and whether it varies by system; the commission rate (% of revenue).
- FloorWiz subscription tier (does Pro+ API access exist, or embed-only for now?).
- OpenPhone API access/credentials for send + inbound capture (and confirm OpenPhone is the texting service).
- Resend sending domains verified for PEC; confirm the from-identity.
- Brand assets: logo, warranty language, system/process copy, before/after photos, Google review source, financing terms + good/better/best tier definitions.
- Lead-source access: Meta lead ads, Angi, Google LSA, web form endpoint.
- Confirm how an accepted estimate bridges into the existing production pipeline during the parallel month (so crews still get the work before full cutover).

---

## 13. Standing rules for this build (from CLAUDE.md)
- Commit after every meaningful change; update PROJECT-LOG.md (newest on top); never push without Dylan; never commit secrets/.env.
- No em dashes in output.
- Domain-restricted client keys may ship to client code only if referrer-restricted and added to netlify.toml's secret-scan omit list.
- Migrations are applied by Cowork to prod, not from Claude Code's session — write them idempotent and hand off.
- Reuse, do not fork: the estimate math, email platform, payment path, and connector already exist.
