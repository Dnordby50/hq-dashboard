# Prompt 106: Estimate choice group ("Customer chooses one")

Prompt number: 106 (highest existing was 105, committed 2026-09-21 as 373efea; checked against git log and the working tree before saving). Built 2026-09-21 by Claude Code.

Written 2026-09-21 from a chat scoping session with Dylan. 15 locked decisions below. Do exactly this scope. If anything here conflicts with CLAUDE.md, SCHEMA.md, or the last 3 PROJECT-LOG entries, stop and ask Dylan.

## Startup

1. Read CLAUDE.md and the 3 most recent PROJECT-LOG.md entries.
2. Use features.json to locate the estimator, public estimate page, send gate, acceptance path, PDF, and Present mode. Do not read index.html end to end.
3. Verify every table and column below against SCHEMA.md and the live schema before writing SQL.

## Problem

An estimate can only express "required" and "optional (additive)". There is no way to say "pick A or B". Dylan fakes it with one required area and one optional area, which is wrong in two ways:

1. If the customer wants B instead of A, Dylan has to edit the estimate before they can sign (extra step).
2. If the customer ticks the optional box, the totals STACK. This is a live pricing bug.

Live example, EST-102515 Jim Drinville (draft, id `3781b582-847b-4225-a1dd-71ef2dc8f5cf`):

| Area | is_optional | preselected | price_override |
|---|---|---|---|
| Border Area (Custom System) | false | true | 2950 |
| Entire Patio Grind and Seal, 645 sqft (Custom System) | true | false | 5450 |

`estimates.price` = 2950, `estimates.price_all_options` = 8400. The real outcomes are 2950 OR 5450. 8400 is never correct.

(Build note: on 2026-09-21 the live row was status `sent`, Entire Patio 3450, price_all_options 6400. The shape of the bug is identical; the numbers in the prompt were stale. The real estimate was not edited.)

## Existing pieces (verified in live schema 2026-09-21)

- `estimate_areas.is_optional`, `estimate_areas.preselected`
- `estimate_line_items.is_optional`, `estimate_line_items.selected_by_customer`, `estimate_line_items.estimate_area_id`, `estimate_line_items.addon_id`
- `estimates.price`, `estimates.price_all_options`, `estimates.line_items` (jsonb), `estimates.is_custom`
- `production/optional-lines.cjs` holds the optional-line logic including `sendGateError`
- `estimateSendGateOk` (dashboard), `pec-send-sms.cjs` and `pec-send-email.cjs` (server side send paths)
- `pec-public-estimate.cjs` renders the customer page
- `openPresentMode` and the estimate PDF path
- `jobs.price` is derived from estimate lines plus change orders on every save

Investigate first and report back in the log: how area rows and their mirrored `estimate_line_items` rows stay in sync, and how custom mode (`estimates.is_custom`, `estimates.line_items` jsonb) stores its lines. The feature must cover areas, add-on lines, and custom lines. If custom mode stores lines in a shape that cannot carry the new flags without a larger refactor, STOP and ask Dylan before building that part.

## Locked decisions

1. A choice is a single line. No multi-line packages.
2. Any line can be a choice: areas, add-on lines, custom lines.
3. Unlimited choices per group, minimum 2.
4. One choice group per estimate, maximum. Store a group key (text) on the line anyway, not a bare boolean, so a second group later is a UI change and not a migration. UI enforces one group.
5. Nothing starts preselected for the customer. Dylan can flag zero or one choice as "Recommended", which shows a badge only.
6. Customer sees NO total until they pick. Deposit amount and the financing monthly estimate are also hidden until a pick.
7. Signing is hard blocked with no pick, client side AND server side in the accept function. Never fall back to a default.
8. Customer layout is cards: own section above the line list, heading "Choose your project" (settings driven), each card shows label, full price, short scope, "View full scope", and the Recommended badge if flagged. Up to 3 across on desktop, stacked vertically on phones. Tap to select, selected card gets the accent border. Required lines and optional add-ons render below exactly as today.
9. Each card shows full price plus the difference against the cheapest choice as a small secondary line ("+$2,500 vs Border area"). Hidden on the cheapest card. Controlled by a setting, default on.
10. Optional add-ons stay estimate-wide. Do NOT build add-on-tied-to-choice. Do not block it either (`estimate_area_id` already exists for later).
11. After acceptance, unpicked choices stay on the estimate record labeled "Not selected". They are EXCLUDED from: job creation, `job_areas`, `jobs.line_items`, `jobs.price`, work order, material plan, ordering, costing, deposit and invoice math.
12. Internal value before a pick (`estimates.price`, pipeline card, sales metrics): the recommended choice, or the cheapest if none is flagged, plus required lines plus preselected optionals per today's rules. At acceptance `estimates.price` is rewritten to the picked total.
13. Estimator UI: a checkbox on each line, "Customer chooses one". Once checked, a "Recommended" toggle appears on that line. Mutual exclusion: a line cannot be both Optional and Customer chooses one (checking one clears the other). Max one Recommended per estimate (flagging one clears the others).
14. PDF and Present mode before signing: show all choices under a "Choose one" label with each price, NO grand total (show subtotal of required lines only if any exist, labeled clearly). After signing: picked choice with full total, unpicked listed as "Not selected".
15. Staff can set the pick from the dashboard estimate detail. Log who, when, and source. A staff-set pick shows as selected on the customer page and the customer can still change it until they sign. After signing, changes go through the existing change order path.
16. No backfill. Existing estimates with optional areas are left alone. Feature applies only to lines where the new checkbox is ticked.

## Data model (verify names, adjust if SCHEMA.md disagrees)

Migration:

- `estimate_areas`: add `choice_group text null`, `is_recommended boolean not null default false`
- `estimate_line_items`: add `choice_group text null`, `is_recommended boolean not null default false`
- `estimates`: add `choice_picked_line_id uuid null`, `choice_picked_at timestamptz null`, `choice_picked_by uuid null` (null when the customer picked), `choice_picked_source text null` check in ('customer','staff')
- CHECK on both line tables: `not (is_optional and choice_group is not null)`
- The picked state lives in ONE place (`estimates.choice_picked_line_id`). Do not also derive it from `selected_by_customer` or `preselected`. If those need to mirror it for legacy readers, write them from the pick in the same transaction and say so in the log.

Apply the migration to prod and confirm it landed. Three migrations stranded unapplied earlier this year, so verify with a live query and put the result in the log.

## Pricing rules

- `price_all_options` must NEVER sum more than one choice line. Define it as: required + all additive optionals + the most expensive choice.
- Any function that totals an estimate must treat the choice group as "exactly one counts". Find every totaling site (estimator, dashboard, public page, accept function, PDF, pipeline card, metrics, follow-up queue, Slack/bell notifications). List each one in the log with file and line.
- This is a derived-value change. Before building, run a baseline: for every non-deleted estimate, record `price` and `price_all_options`. After building, prove that every estimate with zero choice lines is numerically unchanged. Put both query results in the log. Expected affected rows at ship time: zero, because no line has `choice_group` set yet.

## Gates

- Send gate (client and server mirror): block if exactly one line has `choice_group` set. Message: "A choice group needs at least two lines." Keep the explicit has-content precondition ahead of any per-line loop (an empty estimate must not pass).
- Accept gate (server): reject if a choice group exists and `choice_picked_line_id` is null or points at a line not in the group.
- The estimator must NOT write `estimates.status` on save. Do not regress that.

## Estimator build

`estimator/` at the repo root is BUILT output of `apps/estimator` and lags the source. After changing estimator source, regenerate the build and commit the new bundle, or this ships as a no-op. Note the new bundle filename in the log. Bump whatever busts the PWA precache so Dylan's phone picks it up.

## Settings (no code edit to tune)

Add under the existing estimate or presentation settings:

- Section heading text (default "Choose your project")
- Recommended badge text (default "Recommended")
- Show price difference on cards (default on)
- No-pick prompt text for the total row and sign button (defaults "Select an option" and "Choose an option to sign")

## Customer-facing copy

No em dashes anywhere the customer can see (public page, PDF, Present mode, emails, SMS). Use commas, parentheses, or two sentences.

## Out of scope

- Multi-line packages
- More than one choice group per estimate
- Add-ons tied to a specific choice
- Converting or backfilling existing optional-area estimates
- Any change to how additive optional lines work

## Verify (do these, report each result in the log)

1. Baseline vs post-build price query: all estimates without choice lines unchanged.
2. On EST-102515 (draft): tick "Customer chooses one" on both areas, flag Entire Patio as Recommended. `price` = 5450, `price_all_options` = 5450, never 8400. Ask Dylan before saving changes to this estimate, it is a real customer.
3. Public page, no pick: no total, no deposit, no financing figure, sign blocked. Direct POST to the accept function with no pick is rejected.
4. Pick Border: total 2950, card shows no difference line. Pick Entire Patio: total 5450, card shows "+$2,500 vs Border Area".
5. Staff sets pick from dashboard: customer page opens with it selected, customer can change it, log fields populated.
6. Accept with Entire Patio picked on a TEST estimate (not Drinville): `estimates.price` = 5450, job created with only the picked area, `jobs.price` = 5450, material plan and work order contain no Border line, estimate detail shows Border as "Not selected".
7. Send gate blocks a one-line choice group. Optional and Customer chooses one cannot both be on.
8. PDF and Present mode match decision 14, before and after signing.
9. Phone check: 4 choices stack cleanly at 380px wide.
10. Estimator bundle filename changed and committed.

## Log and commit

Append a PROJECT-LOG.md entry at the TOP using the template, By: Claude Code. Include: the totaling sites list, baseline and post-build query results, migration confirmation, new bundle name, anything stopped or deferred. Stage specific files by name, never `git add .`. Update SCHEMA.md and features.json for the new columns and feature anchors.
