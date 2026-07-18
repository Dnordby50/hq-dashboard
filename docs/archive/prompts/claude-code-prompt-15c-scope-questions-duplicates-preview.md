# Claude Code build prompt 15c: scope questions, duplicate-estimate guard, estimate preview, comps costing fix

Run after 15b (shipped 2026-07-13, commits 7a5f633 through e5eb85b). Everything here came out of Cowork's live smoke test of 15b against prod on 2026-07-13, which PASSED on the things it was built to do (scope writer resolved the is/is-not placeholders from estimate data, kept every exclusion verbatim, wrote per-line scope; never-overwrite held with a real 409 needs_confirm and the hand-edited text untouched; the public page 404d on a real token before send; comps matched the database exactly at 10 jobs, same system, 450 to 750 sqft, median $5.93/sqft) and surfaced four things it did not.

## Context

Repo: hq-dashboard (github.com/Dnordby50/hq-dashboard, main). Deploy: prescottepoxy.netlify.app. Supabase: zdfpzmmrgotynrwkeakd. All of 15, 15b, and 16 are live in prod.

Dylan used the estimator for real and hit three gaps, and the smoke test found a fourth that is more dangerous than any of them. Take them in the order below; item 1 is the one that can cost him money today.

## 1. The comps GP% column is currently a fiction (fix the math, do NOT hide the number)

WHAT COWORK FOUND IN PROD: the Comparable jobs panel shows 82 to 94% gross profit on real completed jobs. It is not GP. Of 34 pec_prod_job_costing rows, 31 have salary_wages_cost, ZERO have any materials cost, and ZERO have commission_cost. So actualGpPct (production/comps.js:41) is computing (price - labor) / price and rendering it as gross profit. It only returns null when EVERY bucket is zero, so a wages-only row sails through. The calculator targets 52% GP. A rep reading "your comparable jobs run 89%" concludes there is a 35-point cushion to discount into, and there is not one.

DYLAN'S DECISION (2026-07-13): he is backfilling the costing data himself and does NOT want the number suppressed. Respect that. But two things change in code anyway:

a. THE DOUBLE-COUNT, and this one is not optional. actualGpPct sums BOTH materials_ordered_cost AND materials_used_cost (production/comps.js:44-49). Both are $0 today, so the bug is invisible. The moment Dylan backfills both, every comp double-counts materials and GP swings understated, which is a NEW wrong number produced BY his fix. Change it to: materials = materials_used_cost when it is greater than zero, else materials_ordered_cost. Never both. Comment why.

b. A COMPLETENESS NOTE next to the number (not a suppression): the panel says how many of the comps have complete costing, e.g. "GP% from costing; 0 of 10 comps have materials costed". Compute completeness as: has a positive materials cost AND a positive labor cost. Dylan explicitly asked NOT to blank the number out, so do not; just stop it from reading as gospel. He can strike this note if he hates it.

Both the shared production/comps.js and any index.html mirror have to change together, or the two surfaces will disagree.

## 2. The scope writer never asks about the BLANK placeholders

WHAT HAPPENED: Dylan's Quartz and Patio templates carry DripJobs' own literal "BLANK" text ("Scope of work for quartz coating BLANK AREA", "Expected project duration: BLANK"). 15b's scope writer correctly leaves unresolvable placeholders verbatim rather than inventing content (that was the right call and it stays), but that means a BLANK can ride all the way to a customer. Dylan wants to be ASKED.

DECISIONS:
- Scope: ONLY the literal BLANK placeholders. Do not turn this into a general questionnaire; "Tentative start date:" and "Expected project duration:" (the flake templates' empty-but-not-BLANK lines) keep flowing through as they do today unless they are literally the word BLANK.
- Detection is DATA-DRIVEN, not a hardcoded list. Scan the resolved template text for the literal token BLANK (word-boundary, case-sensitive, so a customer named Blank Smith does not trip it) and turn each occurrence into a question with enough surrounding text that the rep knows what is being asked ("Scope of work for quartz coating BLANK AREA" -> "What area is the quartz coating going on?"). If Dylan later edits a template and removes a BLANK, the question disappears on its own. Nothing to maintain.
- ASK IN BOTH PLACES:
  a. In the estimator, before Save: if the chosen systems' templates contain BLANKs, show the questions inline (the rep is standing in the garage with the customer, which is when they actually know the answer). Answers save onto the estimate.
  b. On the estimate page: any BLANK still unanswered appears in a "Finish the scope" card listing the open questions, so a rep who saved fast at the job site can finish at the desk.
- Answers are stored on the estimate (a scope_answers jsonb keyed by a stable hash of the placeholder's context, so re-generating does not lose them) and substituted by pec-estimate-scope.cjs on the next write.
- SEND GATE: warn, do not block. Sending an estimate whose scope still contains BLANK shows a clear confirm ("This estimate still says BLANK in the scope of work. Send anyway?"). Dylan chose warn-but-allow; honor it, but make the warning impossible to miss, because the failure mode is a customer reading the word BLANK in a document he is being asked to sign.

## 3. Duplicate estimates on a lead

WHAT HAPPENED: one lead ended up with three estimates because nothing stops Start estimate from minting a new one every click. (Reproduced on Cowork's own smoke-test lead, so no customer data was involved.)

DECISIONS:
- The guard fires ONLY when the lead has an OPEN estimate: status in (draft, sent, signed, change_requested). A rejected or lost estimate is dead, and re-estimating after a rejection is the normal thing to do; do not nag there.
- On Start estimate (lead detail) when an open estimate exists, show a modal: "This lead already has an open estimate, EST-<number>, <status>, $<price>, created <when>. Are you sure you want to create a new one?" with three actions: OPEN EXISTING (goes to that estimate's page), CREATE NEW ANYWAY (proceeds), CANCEL. If there are several, list them.
- Apply the same check on every path that creates an estimate for a lead, not just the lead detail button. Grep for them; a guard on one entry point is theater.
- The lead detail page's Estimates section shows the count and every estimate with number and status, so the rep can see this before they click anything.

## 4. Preview the estimate before sending

Dylan cannot see what the customer will get until it is already sent. Add a Preview action on the estimate page that renders the EXACT customer-facing page (pec-public-estimate.cjs output, the hero, the trust cards, the collapsible line items with their scope, the optional items, the deposit) as it will look, WITHOUT setting sent_at and WITHOUT making the public link live.

Implementation notes, and this is the part to get right: the preview must be the SAME renderer as the public page, not a second copy that drifts. Extract the page-rendering function out of pec-public-estimate.cjs so both the public route and a staff-authenticated preview route call it. If you find yourself copy-pasting the HTML, stop; a preview that is not byte-identical to what the customer sees is worse than no preview, because it builds false confidence.

The preview must NOT: set sent_at, flip status, mint or expose the public token in a way that survives (a staff preview is authenticated, not token-based), or render the Approve and Pay / Request changes / Reject buttons as live controls (show them disabled, with a "preview" banner across the top).

## Guardrails

- Do not touch invoicing, payments, commission, or change orders.
- The scope text still comes out of a language model; keep it sanitized on the way out (mdToSafeHtml). A preview route is one more place raw model output could reach HTML.
- Both modal roots if you touch modal lifecycle.
- No em dashes.
- What's New entries: the BLANK questions, the duplicate warning, and Preview are all user-visible. The comps math fix is internal (no entry), but SAY it in the log.
- Harness tests, driving the real extracted functions: a template containing BLANK produces questions and the answers substitute into the generated scope; a template with no BLANK produces no questions; an unanswered BLANK still generates (verbatim) and trips the send warning; the send warning does not block; the duplicate guard fires on draft/sent/signed/change_requested and stays silent on rejected/lost; the guard fires on EVERY create path; the preview renders identical HTML to the public route for the same estimate while leaving sent_at null and status unchanged; actualGpPct counts materials ONCE when both ordered and used are populated (this is the regression that would otherwise appear the day Dylan backfills); and the completeness note counts comps with materials AND labor.

## After

Append a PROJECT-LOG.md entry (By: Claude Code) at the TOP with commit SHAs, what you tested, and any judgment call that differs from this prompt. Note explicitly that Dylan chose to keep the comps GP% visible and backfill the costing data himself, so that the next reader does not "fix" it by hiding the number.

## Handoff to Dylan (put it in the log)

The costing backfill is his: pec_prod_job_costing has labor on 31 of 34 jobs and materials on ZERO. Until he fills in materials and commission, the comps GP% is (price minus labor) and reads roughly 30 points too high. The code will stop double-counting materials, but it cannot invent the numbers that are not there.
