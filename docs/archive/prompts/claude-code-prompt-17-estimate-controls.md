# Build prompt 17: estimate controls (archive, per-area MVB, sundries, pricing logic + manual override, price per sqft)

Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first (through the 2026-07-14 commission-as-a-derived-cost entry, commit f3e0fe6 on main). This prompt builds on 15b and 15c and it touches the pricing engine, so the standing rules about the index.html inline mirror of production/calculator.js, CALC_VERSION, and `npm test` all apply.

Five items. They share the calculator and the estimate modal, so build them together, one migration, one deploy. All five decisions below came from Dylan in a Cowork session on 2026-07-12 and are LOCKED. Where I flag a judgment call, make the call, then write it in the log entry.

Non-negotiable across everything here: THE CUSTOMER NEVER SEES A BREAKDOWN. The public estimate page shows a total price and the scope, exactly as it does today. Every cost, margin, sundry, $/sqft and override artifact in this prompt is INTERNAL, staff-only, and must never reach pec-public-estimate.cjs output (including its preview mode, which renders the customer page).

---

## 1. Archive an estimate (soft-delete)

Dylan's decisions: soft-delete only, any status, any staff.

- estimates.deleted_at already exists (Cowork soft-deleted EST-102027 with it during the 15b smoke test). Confirm the column and its type before adding anything.
- Add an Archive button to the estimate detail modal / estimate page in index.html (the same surface that has Preview and Regenerate scope). It sets deleted_at = now() and, if the schema supports it, records who archived it. Do not hard-delete anything, ever. No cascade deletes.
- Confirm dialog on the way out. If the estimate status is `accepted` (a job exists downstream), the confirm must be an explicit, hard-to-misread warning that the JOB is not archived and will still be there. Archiving an accepted estimate does not touch pec_prod_jobs or public.jobs.
- Downstream behavior, all four required:
  - The estimates list excludes archived rows by default. Add an "Archived" filter/toggle that shows only archived ones, with a Restore button (deleted_at = null). Restore is the whole reason this is a soft-delete.
  - The public link stops working: pec-public-estimate.cjs must 404 (or return the same not-available shape it uses for an unsent estimate) when deleted_at is not null, on BOTH the public-token route and the staff preview route.
  - Archived estimates are excluded from comps and from any estimate-derived metric. Audit every query that reads `estimates` and add the `deleted_at is null` filter. Grep for `.from('estimates')` and fix them all rather than the two you happen to remember. If a query intentionally includes archived rows (the Archived filter), say so in a comment.
  - The duplicate-estimate guard (inside the shared `openEstimatorModal`, shipped in 15c) ignores archived estimates: an archived open draft must not trigger the "lead already has an open estimate" prompt.

Acceptance: archive a draft, it leaves the list and its public token 404s; restore it from the Archived filter and it comes back whole with its line items and areas; archive an accepted estimate and confirm the job is untouched; a lead whose only open estimate is archived starts a fresh estimate with no warning.

---

## 2. Moisture vapor barrier moves from the estimate to the AREA

Today MVB is one estimate-level field, `estimates.mvb` in ('none','addon','standalone'), and it does two things: it feeds `standaloneMvb` / `standaloneMvbProductId` into computeEstimatePricing (one synthetic area across TOTAL sqft), and it swaps `scope_template` for `scope_template_mvb` for every system line (EstimatorScreen.tsx around 306 to 344). That is wrong for a two-area estimate where the garage needs MVB and the patio does not.

Dylan's decisions: per AREA (not per add-on line, an add-on is not a floor). Default OFF on every area, always. Turning it on is a COST ADDER on that area only, priced through the normal cost-plus solve. The estimate-level mvb field is RETIRED: migrate the data, keep the column in the DB but stop reading it (frozen, the way estimates.line_items jsonb was frozen in 15b).

Build:
- Migration: `estimate_areas.mvb boolean not null default false`. Backfill: every area of an estimate whose `mvb` is not 'none' gets true. Do the same for the production-side area table if the accept path copies areas into it, so an accepted job carries the flag.
- Calculator (production/calculator.js AND the index.html inline mirror, bump CALC_VERSION): MVB becomes a per-area material addition. The MVB product is applied at that area's sqft, merged into the material plan by product like everything else (so two MVB areas produce ONE summed MVB material line, which is the point of mergeAcrossAreas). The existing `standaloneMvb` / `standaloneMvbProductId` job-level path in computeMaterialPlan (calculator.js around 126) is the mechanism to generalize, not to keep alongside.
- Because MVB cost lands inside the area's materials, the existing weighted cost-plus solve prices it with no divisor change. Do not add a separate MVB line item and do not add a per-sqft MVB surcharge. One price, one solve.
- Scope: the template choice becomes PER LINE, not per estimate. A line whose area has mvb=true uses that system's `scope_template_mvb` if it exists, else `scope_template`. This is a change in both apps/estimator (the client-side scope assembly) and netlify/functions/pec-estimate-scope.cjs (the server writer). They must agree; the shared production/scope.cjs precedent from 15c is the model.
- Estimator UI: the MVB segmented control at the estimate header goes away and becomes an MVB checkbox on each area row, defaulted off. `mvbMissing` (no MVB product in the catalog) still blocks save, but now only when at least one area has it checked.
- JUDGMENT CALL you have to make and log: the old `mvb='standalone'` mode is an MVB-ONLY JOB (no coating system, MVB across total sqft), which is a job TYPE, not a per-area modifier, and per-area booleans do not express it on their own. Pick the cleanest representation (a dedicated MVB-only system type whose recipe is just the MVB product, or an area with a null system and mvb=true, or keeping the standalone path alive behind the scenes) and make sure every EXISTING standalone estimate still loads, prices, and renders its scope identically after the migration. Whichever you pick, the estimator must still be able to CREATE an MVB-only estimate. State the choice and why in the log.
- Anywhere the dashboard prints the MVB label off `est.mvb` (index.html around 17000, 17073, 17152) now reads the areas.

Acceptance: a two-area estimate with MVB on the garage only prices higher than the same estimate with MVB off, by roughly the MVB material cost divided by the divisor, and NOT by the MVB cost across both areas' sqft; its scope uses the MVB template for the garage line and the standard template for the patio line; a brand new area is created with MVB off; an existing MVB-on estimate opens with every area checked and prices the same as before.

---

## 3. Sundries and disposables: 2% of total job cost, every estimate, internal only

We do not currently book any cost for tape, blades, plastic, mixing sticks, rags, blades, grinder consumables. Every estimate should.

Dylan's decisions: it is a COST bucket at 2% of TOTAL JOB COST (materials + fixed add-ons + labor + commission), not a customer-visible line. The rate is CONFIGURABLE in Price & Material Catalog (a `sundries_pct` setting alongside the other pricing config, default 2), not a hard-coded constant. The customer sees the total price only, as always.

The math, because it is circular and there is a closed form (do not iterate):
Labor and commission are fractions of REVENUE (L and C), materials M and fixed add-ons F are not, target GP is g, sundries rate is s.

    cost      = M + F + L*P + C*P + s*(M + F + L*P + C*P)
    P         = cost + g*P
    =>  P * [ 1 - (L + C)*(1 + s) - g ] = (M + F) * (1 + s)
    =>  divisor = 1 - (L + C) * (1 + s) - g
    =>  P = (M + F) * (1 + s) / divisor

So the ONLY change to computeEstimatePricing is the divisor and the numerator, plus a new `sundriesDollars = s * (M + F + laborDollars + commissionDollars)` bucket recomputed at the rounded price, and gpDollars subtracting it. Realized GP at the solved price still equals the weighted target, which is the test that proves you got the algebra right. `divisor <= 0` still returns TARGET_UNREACHABLE.

- applySellPrice must apply the same sundries rule at the rep's chosen price (sundries = s * (M + F + L*sell + C*sell)), or an override will report a GP that is 2% of cost too high, which is exactly the class of bug the 15c comps entry is about.
- Bump CALC_VERSION and mirror into index.html. The existing $5,345 anchor test WILL move (it should, the job now carries a cost it did not before). Update the anchor deliberately and note the old and new numbers in the log, do not quietly re-baseline.
- Sundries appears in the pricing-logic panel (item 4) as its own line. It never appears on the public page.
- Out of scope, but write it in the log as a follow-up for Dylan: pec_prod_job_costing has no sundries bucket, so estimated sundries and ACTUAL sundries will not be comparable until one exists. Say so plainly.

Acceptance: with sundries at 2%, a job whose cost stack was $2,480 prices about 2% of its cost higher, realized GP% still lands on the weighted target, and setting sundries_pct to 0 in the catalog reproduces today's price EXACTLY (that is your regression test, and it must be an assertion).

---

## 4. Pricing logic panel + manual price override

Right now a rep sees a price and has to trust it. Show the work, and let a human move the number.

INTERNAL ONLY. This panel lives in the estimate modal / estimate detail in index.html and in the estimator's sell-price section. Never on the public page or the preview.

Show, under the sell price:
- **$/sqft for this estimate**: sell price divided by total sqft across areas. Big and obvious, this is the number Dylan wants at a glance.
- **The full cost stack**: materials, labor (dollars and budgeted hours at the labor rate), sundries, add-on cost, commission (budgeted, at the standard rate), total cost, target GP%, realized GP% and GP dollars, GP per hour. Every number already exists on the computeEstimatePricing result, this is display, not new math.
- **How the price was reached, in one plain-English line**: for example "cost of $2,480 divided by (1 minus 52% target GP) = $5,167, rounded to $5,165, weighted across 2 systems". If the charm-pricing rule fired (roundEstimatePrice), SAY SO, because that is the one place the realized GP legitimately dips under target and nobody should have to guess why.

Manual override (Dylan's decisions):
- The rep overrides the TOTAL SELL PRICE. Type a number. Not $/sqft, not the target GP.
- `applySellPrice` in calculator.js ALREADY does this math and the estimator already has a finalSell / discounted / adjusted path. REUSE IT. Do not write a second sell-price path. What is missing is (a) it is not on the dashboard estimate modal at all, and (b) nothing is persisted about the fact that a human overrode the number or why.
- Persist: keep the engine's computed price as `estimates.calc_price`, keep `estimates.price` as the number that actually sells (override or not, so every downstream reader keeps working untouched), and add `price_override_reason text`, `price_overridden_by`, `price_overridden_at`. Line item amounts re-allocate to the new total with the existing `allocateProportionally` so they still sum EXACTLY to the price.
- Guardrails, all three:
  - Realized GP% updates LIVE as they type, and goes red when it falls below target.
  - A reason note is REQUIRED to save an override (short free text: problem customer, large sqft, competitor match, whatever). Store it and show it on the estimate detail. This is the paper trail for who is discounting and why.
  - A configurable FLOOR GP% (new catalog setting, default 40). Going below it fires a hard confirm. It WARNS, it does not block. Same philosophy as the 15c BLANK-scope send gate.
- The override is visible on the estimate detail (calculated price, sold price, delta, reason, who, when) and in the Estimates list as a small marker.

Acceptance: override a $5,165 estimate down to $4,500 with no reason and you cannot save; add a reason and it saves; the estimate page then shows both prices, the delta, the reason, and a realized GP% derived from $4,500 (not from $5,165); the line items sum to exactly $4,500; the public page shows $4,500 and NOTHING else about any of this.

---

## 5. Price per sqft on jobs (list, detail, metrics)

Dylan's decisions: numerator is CONTRACT revenue (pec_prod_jobs.revenue), denominator is the job's total sqft. A job with no sqft on file shows a dash, never a fabricated number. Overridden prices are INCLUDED everywhere: a discounted job is what the job actually sold for, and that is the truth we need to see.

- Sqft source: prefer the real number, which is the sum of the areas on the estimate that created the job. Trace the estimate-to-job link (the accept path in pec-public-estimate.cjs writes both tables) and use it. Fall back to the existing `parseSqft` in production/comps.js for older jobs that predate the estimator, and REUSE that function, do not write a second parser. If neither yields sqft, show a dash.
- Surfaces, all four:
  - Jobs tab: a $/sqft column, SORTABLE, so an outlier is one click away.
  - Job detail (the unified job panel): $/sqft next to revenue, with the sqft and the system it is based on, so the number is auditable.
  - Metrics: average AND median $/sqft by system type (Standard Flake, Quartz, Grind and Seal, etc.) with the job count behind each. Median matters, one weird $18/sqft job should not move the number.
  - Metrics: $/sqft trend over time (by month), so drift is visible.
- Jobs with no sqft are EXCLUDED from the metric averages, not counted as zero, and the metric should say how many were excluded (same honesty principle as the comps completeness caveat from 15c: never print a number that quietly rests on missing data).

Acceptance: the jobs list sorts by $/sqft; a job with known areas shows revenue / sqft and the same $/sqft the comps panel would compute for it; a legacy job with no sqft shows a dash and is excluded from the by-system averages with the exclusion stated.

---

## Testing (standing rules, plus what this prompt specifically needs)

- `npm test` green across both suites. New assertions REQUIRED for:
  - sundries_pct = 0 reproduces today's exact price (the regression guard);
  - the sundries divisor: realized GP% at the solved price equals the weighted target with sundries on;
  - applySellPrice with sundries: GP at an overridden price counts sundries;
  - per-area MVB: MVB on one of two areas adds MVB material for that area's sqft ONLY, and two MVB areas merge into one material line;
  - the MVB scope template is chosen per line, and the estimator's choice matches the server writer's choice;
  - allocateProportionally after an override sums exactly to the override;
  - archived estimates are excluded from comps and from the duplicate guard, and the public route refuses them;
  - $/sqft is null (dash) with no sqft, and null jobs are excluded from the by-system average.
- CALC_VERSION mirror test still passes (the inline index.html copy carries the same version).
- All index.html script blocks parse, `node --check` on touched functions, estimator `tsc --noEmit` + `vite build` clean.
- Em-dash scan of every added line = 0.

## Ship with it

- Migration applied to prod from the session, footer checks green, per the recent precedent.
- What's New entries (help/whats-new.json, newest first, plain language, no em dashes) for the four USER-VISIBLE changes: archive an estimate, MVB per area, see the pricing logic and adjust the price, price per sqft on jobs. Sundries is arguably internal, but it CHANGES EVERY PRICE, so give it an entry too and say plainly that estimates now include a 2% sundries and disposables cost.
- Commit per standing rules, PROJECT-LOG entry at the top, and flag the two follow-ups explicitly: the missing sundries bucket on job costing, and the materials backfill that still makes comps GP% read high.
