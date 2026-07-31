# Prompt 60: Google review ask drip, review intake, crew leader attribution, review bonus ledger

Written by Cowork 2026-07-31 after 21 locked questions with Dylan. Every LOCKED line below is Dylan's answer, not a suggestion. Do not re-decide them.

---

## Context

Dylan wants a NiceJob-style Google review campaign inside TopCoat. A job completes, the customer gets an easy one-tap ask, Anne follows up by phone as part of her normal call, and when a review lands it gets mapped back to the job so we can see how many reviews each crew leader earns. Confirmed 5-star reviews pay the crew leader a bonus.

Most of the machinery already exists and you are extending it, not building it fresh:

- The drip engine already supports `subject_type='job'` (Invoice payment reminders uses it), with the approval gate, quiet hours, claim-first concurrency, STOP handling, and dry_run mode. `_pec-drip.cjs`, `pec-drip-runner.cjs`.
- `pec_prod_jobs.crew_lead` (text) and `pec_prod_job_schedule_days.crew_lead` already exist and are populated.
- `settings` already holds `google_review_link_epoxy` and `google_review_link_paint`. They are rendered in a settings form at index.html:19380-19381 and are currently read by nothing else. This build gives the epoxy one a job.
- The `reviews` table exists but is a stub: `id, job_id, customer_id, rating, feedback, created_at`, 0 rows, RLS on. The Reviews view (`renderReviews`) is a read-only shell.

What does NOT exist and you are building: the ask trigger, the tracking link, the review-kind campaign, the Zapier review intake, the match/confirm workflow, the crew leader scoreboard, and a review bonus ledger that is deliberately separate from job costing.

Repo: `/Users/dylannordby/Claude-Code/HQ-Dashboard`, deploy `prescottepoxy.netlify.app`, Supabase project `zdfpzmmrgotynrwkeakd`.

---

## The two truths this build has to respect

**1. Attribution is inferred, never certain.** Google tells you a reviewer display name, a star rating, and text. It does not tell you which job the review came from. A tracking-link click proves intent, not a posted review. A name match proves similarity, not identity. Every part of this build has to stay honest about that: auto-matched reviews are labeled as auto-matched, and no auto-matched review is allowed to pay anyone. Only a human confirm turns a match into money.

**2. Google's review policies bind us.** No incentives offered to the customer for leaving a review, and no rating-routed gating (the "1-3 stars go to a private form, 4-5 go to Google" funnel). The close-out popup in Part B is an INTERNAL choice about whom to ask; it must never become a customer-facing "are you happy first?" screen. Do not add one, and do not let AI-generated copy offer anything of value in exchange for a review. Add this to the drip scrubber's forbidden list.

---

## Locked decisions

1. **Trigger: a human marks the job complete.** No touch-up gate, no paid-in-full gate. The close-out popup is the judgment call.
2. **Close-out popup, default ON.** When someone marks a job complete, TopCoat asks "Send a Google review request to this customer?" pre-set to Send. Whoever closes the job actively opts out for an unhappy customer.
3. **Reversible.** A "Request review" button on the job detail starts the campaign later if it was skipped.
4. **Cadence: 4 touches, day 1 SMS, day 3 SMS, day 7 email, day 14 SMS.** Same shape as the estimate drip.
5. **The copy names the crew leader** ("How did Kyle and the crew do?") when `crew_lead` is populated, generic wording when it is blank. This also improves matching, since customers repeat the name in the review text.
6. **PEC epoxy jobs only** for v1. FTP paint is out of scope, but the schema must not block adding it later.
7. **Attribution: tracking link + Google feed + human confirm queue.** All three legs.
8. **Review feed: Zapier Google Business Profile trigger** posting to a new TopCoat endpoint, same pattern as Routemize appointment intake. No Google API approval dependency.
9. **Crew credit: `pec_prod_jobs.crew_lead`, snapshotted at ask time.** One name per job, frozen. Split-crew jobs credit the primary only. Later schedule edits must not rewrite history.
10. **Scoreboard: Metrics page, new Reviews section.**
11. **List shows every review, 1 through 5 stars. Credit and bonus are confirmed-5-star only.** A bad review is never invisible.
12. **Bonus: flat dollar amount per human-confirmed 5-star review**, amount set in Settings.
13. **Review bonuses live in their own ledger and never touch job costing.** See landmine 3, this is the load-bearing one.
14. **Anne gets no new queue.** Her follow-up is her existing phone call. She gets a review-status chip on the job plus a filter in the Reviews view.
15. **Ships dry_run behind the approval gate**, same as every other campaign.
16. **Stop conditions: review detected for that job, customer replies by text or call, a touch-up or callback opens on the job, customer texts STOP or is opted out.**
17. **Backfill jobs completed in the last 30 days** on go-live. Must respect the dry_run gate so deploy does not text 20 people.

---

## Part A: Migration

New file `supabase/migrations/2026-08-04_review_drip.sql`, one transaction, with the rule-13 `@artifacts` header derived from its own SQL. Apply it yourself via the Supabase MCP against `zdfpzmmrgotynrwkeakd` and regenerate SCHEMA.md. Verify every constraint change with `pg_get_constraintdef`, since a CHECK is not an `@artifacts` kind.

**A1. Extend the campaign kind CHECK.** `pec_drip_campaigns.kind` is currently `CHECK (kind IN ('lead','estimate','invoice'))`. Add `'review'`. This is a real constraint, the same shape as the `material_type` lesson, so drop and recreate it rather than assuming it will accept a new value.

**A2. Seed the campaign and its steps.** One `pec_drip_campaigns` row: name "Review request", kind 'review', status 'active', mode **'dry_run'**, max_touches 4. Four `pec_drip_steps` rows at day_offset 1 / 3 / 7 / 14, channels sms / sms / email / sms, step_index 0-3. `ai_guidance` is the instruction to the model, not customer copy. Write guidance that: thanks them by first name, references the crew leader by name when supplied, asks for a Google review in one sentence, states that the link is one tap, invents no facts about the job, offers nothing in exchange, and uses no em dashes. The email step gets an `email_subject`.

**A3. New table `pec_review_requests`.** One row per ask, this is the unit Anne and the scoreboard read.

```
id                uuid pk default gen_random_uuid()
job_id            uuid not null references jobs(id)
prod_job_id       uuid references pec_prod_jobs(id)
customer_id       uuid references customers(id)
token             uuid not null unique default gen_random_uuid()
status            text not null default 'asked'
                    check (status in ('asked','clicked','reviewed','skipped','stopped'))
crew_lead         text          -- SNAPSHOT, never re-derived
crew_id           uuid          -- SNAPSHOT
brand             text not null default 'epoxy'   -- so FTP can be added later
asked_at          timestamptz
first_clicked_at  timestamptz
click_count       integer not null default 0
review_id         uuid references reviews(id)
skipped_at        timestamptz
skipped_by        text
stop_reason       text
created_at        timestamptz not null default now()
updated_at        timestamptz not null default now()
```

Partial unique index `idx_pec_review_req_one_open` on `(job_id)` where `status in ('asked','clicked')`, so a job can never hold two open asks. Index on `(status, asked_at)` for the Reviews view filter. RLS staff-only, matching the other `pec_*` tables. The public redirect function reads it with the service key, so no anon policy is needed.

**A4. Widen the `reviews` table.** Add:

```
source          text not null default 'manual' check (source in ('manual','zapier_gbp'))
platform        text not null default 'google'
external_id     text unique          -- Google review id, the idempotency key
reviewer_name   text
review_text     text                 -- keep the existing `feedback` column for internal notes
review_url      text
posted_at       timestamptz
match_status    text not null default 'unmatched'
                  check (match_status in ('unmatched','auto','confirmed','rejected'))
matched_by      text
matched_at      timestamptz
crew_lead       text                 -- copied from the request on confirm
crew_id         uuid
review_request_id uuid references pec_review_requests(id)
```

**And drop the NOT NULL on `reviews.job_id` and `reviews.customer_id`.** See landmine 1. This is not optional and it is the single easiest thing in this build to miss.

**A5. New table `pec_review_bonuses`**, deliberately parallel to `pec_prod_job_bonuses` and deliberately not it:

```
id               uuid pk default gen_random_uuid()
review_id        uuid not null unique references reviews(id)
job_id           uuid references jobs(id)
prod_job_id      uuid references pec_prod_jobs(id)
crew_lead        text not null
crew_member_id   uuid references pec_prod_crew_members(id)
amount           numeric not null default 0
status           text not null default 'pending'
                   check (status in ('pending','approved','paid','voided'))
approved_by      text
approved_at      timestamptz
paid_on          date
payroll_date     date
paid_by          text
voided_at        timestamptz
voided_by        text
void_reason      text
created_at       timestamptz not null default now()
updated_at       timestamptz not null default now()
```

The `unique` on `review_id` is the guarantee that one review can never pay twice, including through a double-click on Confirm.

**A6. Settings keys** (standing rule 12), inserted insert-only so live edits are never clobbered by a re-run:

| key | default | meaning |
|---|---|---|
| `review_drip_enabled` | `'true'` | master switch for the review campaign, independent of `drip_sending_enabled` |
| `review_ask_default_on` | `'true'` | whether the close-out popup pre-selects Send |
| `review_bonus_amount` | `'25'` | dollars per confirmed 5-star review |
| `review_bonus_min_stars` | `'5'` | minimum rating that earns credit and a bonus |
| `review_match_window_days` | `'45'` | how far back the intake looks for a candidate request |
| `review_stop_on_touchup` | `'true'` | a touch-up or callback opening stops the drip |

All six surfaced in Settings under a new "Reviews" group (rule 12). The Google review URL itself keeps using the existing `google_review_link_epoxy` key; do not create a duplicate.

---

## Part B: The close-out popup

`markJobComplete` at index.html:11666 is the main path, but it is **not the only one**. index.html:5940-5947 has a second path that stamps `completed_date` first-write-wins, and there is a `completeActiveJob` at index.html:36397. Grep `completed_date` across index.html and cover every path that stamps it, or the popup will silently never fire for whichever one you missed. Note the comment at index.html:6436, "completed_date is stamped ONLY by the manual completion paths, never derived", that comment is your inventory hint.

On completion, before the status write commits, show a modal:

- Title: Send a Google review request?
- Body: the customer name, the crew leader name, and the plain sentence that they will get a text in one day.
- Two buttons: **Send request** (default, focused, per `review_ask_default_on`) and **Skip for now**.
- Skipping is not a dead end; say so in the modal ("You can start it later from the job").

Both branches insert a `pec_review_requests` row. Send sets status 'asked', stamps `asked_at`, snapshots `crew_lead` and `crew_id` from `pec_prod_jobs`, and enrolls the job in the review campaign. Skip sets status 'skipped' with `skipped_at`/`skipped_by`, and does not enroll. Recording the skip matters: it is how you tell "we chose not to ask" apart from "we forgot".

Modal lifecycle: index.html has TWO modal roots (`#pecModalRoot` and `#prodModalRoot`, see the CLAUDE.md architecture gotcha). Use whichever root the surrounding completion flow already uses and do not introduce a third pattern.

**Job detail gets a "Request review" button** that opens the same flow for a job with no open request, so a skip is always recoverable.

---

## Part C: The tracking link

Add to netlify.toml, alongside the existing `/pay/*` rule at line 196:

```toml
[[redirects]]
  from = "/r/*"
  to = "/.netlify/functions/pec-review-redirect?token=:splat"
  status = 200
  force = true
```

New `netlify/functions/pec-review-redirect.cjs`:

1. Look up the token in `pec_review_requests`.
2. Stamp `first_clicked_at` (first-write-wins, do not overwrite), increment `click_count`, move status 'asked' to 'clicked' (never move 'reviewed' or 'skipped' backwards).
3. 302 to `settings.google_review_link_epoxy`.

**This function must never show a customer an error.** A bad token, a missing settings row, a dead database, any of it, and it still redirects to the Google link with the click simply unlogged. The customer's tap is the valuable thing; our bookkeeping is not worth breaking it. Wrap the entire logging block in its own try/catch and redirect in the `finally`.

The link is appended to message bodies **by code, never by the model**, exactly like the `/pay/token` link in the invoice campaign (`_pec-drip.cjs` around line 675). The scrubber already strips model-invented links; keep it that way.

---

## Part D: The review drip kind

In `_pec-drip.cjs`:

- **`enrollReviewDrip(sb, jobId)`**, mirroring `enrollInvoiceDrip` at line ~505 (`enrollSubject(sb, 'review', 'job', jobId, ...)`). `pec_drip_enrollments.subject_type` already allows `'job'` and `pec_drip_sends.subject_type` already allows `'job'`, so no CHECK change is needed there. Only the campaign `kind` CHECK changes (A1).
- **`KIND_CHECKS.review`** at the line ~565 map. Stop conditions, each with a distinct `stop_reason` so the Drips activity log stays readable:
  - `reviewed` : the job's `pec_review_requests` row has status 'reviewed' or a non-null `review_id`.
  - `touchup_opened` : the `pec_prod_jobs` row has an open `touchup_state` or `is_callback` is true, gated on `review_stop_on_touchup`.
  - `job_closed` : job voided or archived.
  - Replies (inbound SMS or call) and STOP/opt-out are handled by the universal core plus the existing job-kind recipient resolver (opt-out-only consent via `customers.sms_opt_out`); confirm they apply and do not re-implement them.
- **Render context** gains `crew_lead` (nullable) and the `/r/<token>` URL. Guidance must produce generic wording when `crew_lead` is null, not the string "null" or an empty name.
- **`review_drip_enabled`** is checked alongside the global `drip_sending_enabled` master switch. Both must be true.

The campaign ships `dry_run` and the approval gate (`drip_approval_required`) applies exactly as it does to the other kinds. Do not special-case it out of the gate.

---

## Part E: Zapier review intake

New `netlify/functions/pec-review-intake.cjs`, modeled on `pec-appt-intake.cjs`:

- Shared-secret header, per standing rule 7 use a placeholder env var (`REVIEW_INTAKE_SECRET`) and add a Handoff to Dylan to set it in Netlify.
- Accepts, defensively, whatever Zapier's Google Business Profile trigger actually sends. Read fields through a candidate-list pattern like `pec-appt-intake.cjs` line 231 does for status, because the Routemize lesson from prompt 56 was exactly this: a second payload shape with a different field vocabulary silently did nothing. Expect: reviewer display name, star rating, review text, review id, posted timestamp, review URL.
- **Idempotent on `external_id`.** A re-fire updates the existing row, never inserts a second. Never blind-retry a write (the CLAUDE.md non-idempotent-write rule).
- Always insert the review, even with no match. That is why `job_id` is nullable now.
- **Auto-match logic**, in this order:
  1. Candidate set: `pec_review_requests` with status 'asked' or 'clicked', `asked_at` within `review_match_window_days`.
  2. Score each candidate on reviewer name versus customer name (normalized, first-name plus last-initial tolerance), whether the crew leader's first name appears in the review text, and whether the request has a click.
  3. Exactly one clear candidate: `match_status = 'auto'`, set `job_id`, `customer_id`, `review_request_id`, copy `crew_lead`/`crew_id` from the request snapshot, move the request to status 'reviewed'.
  4. Zero or more than one: `match_status = 'unmatched'`, leave `job_id` null, touch no request.
- **Never write `match_status = 'confirmed'`.** Only a human does that, in Part F. This is what keeps landmine 9 true.
- Return 200 on anything it cannot parse, with a human-readable note, exactly like the Routemize adapter does. Zapier retries on non-2xx and you do not want a retry storm on a payload shape you have not mapped yet.

Every read in this function checks `res.error` before treating an empty result as empty (the supabase-js silent-empty gotcha in the project instructions).

---

## Part F: Reviews view and Metrics section

**Rebuild `renderReviews`** into the working surface:

- Every review, newest first, any rating: stars, reviewer name, posted date, review text, source, and the matched job with its crew leader.
- A match-status badge: Unmatched / Auto-matched / Confirmed / Rejected. Auto-matched must be visually distinct from Confirmed. Someone glancing at this page has to be able to tell inference from fact without clicking.
- Per row: **Confirm match**, **Reassign to a different job** (searchable job picker), **Reject** (not our review, or spam).
- A filter: **Asked, no review yet**, listing `pec_review_requests` with status 'asked' or 'clicked', days since ask, customer phone and email, so Anne can work a list when she wants one. This is a filter, not a queue, and it raises no notifications and no Ops Queue count. Decision 14.
- Confirming a 5-star match creates the `pec_review_bonuses` row (Part G). Confirming a 1-to-4-star match records the review and credits nothing.

**Job detail gets a review-status chip**: Not asked / Asked (day N) / Clicked / Reviewed (5 stars) / Skipped.

**Metrics gets a new Reviews section**:

- Per crew leader: confirmed 5-star count, all-review count, average rating.
- The funnel for the period: jobs completed, asked, clicked, reviewed, plus the ask rate and the review rate.
- Make it obvious that the per-crew-leader number counts confirmed 5-star reviews only, in the section's own label. A number nobody can define is a number that starts arguments.

Read the `dataviz` skill before writing any chart in this section.

---

## Part G: Review bonus ledger

On Confirm of a 5-star match, insert `pec_review_bonuses` with `amount` from `review_bonus_amount`, status 'pending', `crew_lead` copied from the review, and `crew_member_id` resolved from `pec_prod_crew_members` by name where it resolves cleanly (leave null when it does not, and show the name either way).

Bonus Report gets a **Review bonuses** section: pending list with Approve, approved list with Mark paid (payroll date), and a reversal path mirroring `pec_bonus_payouts.reversed_at/_by/reversal_reason`.

**Hard boundary, from decision 13:** this ledger must never write a `pec_prod_job_bonuses` row and must never contribute to `pec_prod_job_costing.bonus_cost`, `computeCostingRow`, or any GP calculation. Grep both before you finish and confirm zero coupling.

---

## Landmines

1. **`reviews.job_id` and `reviews.customer_id` are NOT NULL today.** A Google review arrives before we know whose job it is. If you do not drop those constraints in Part A, every unmatched intake insert fails and the whole feed silently produces nothing.
2. **`pec_drip_campaigns.kind` is a real CHECK constraint.** Same shape as the `material_type` lesson: a new value needs a migration that drops and recreates the constraint. Verify with `pg_get_constraintdef` after applying.
3. **Never write review bonuses into job costing.** `pec_prod_job_bonuses` rolls into `pec_prod_job_costing.bonus_cost`, which feeds job GP. A review landing three weeks after costing was finalized would retroactively move a finalized job's gross profit. That is precisely the prompt-56 failure that moved 34 finalized jobs by $4,785. The separate ledger exists for this reason and only this reason.
4. **Multiple completion paths.** index.html:11666, the path at 5940-5947, and 36397. Miss one and the popup never fires there, with no error to tell you.
5. **Snapshot the crew leader, do not re-derive it.** `pec_prod_jobs.crew_lead` can change after completion when someone edits the schedule. The scoreboard must reflect who ran the job, not who runs it now.
6. **Auto-matched never pays.** Only `match_status = 'confirmed'` creates a bonus. The intake function is forbidden from writing 'confirmed'.
7. **The redirect must never fail the customer.** Log-then-redirect wrapped so any error still lands them on Google.
8. **Idempotency on `external_id`.** Zapier re-fires. A duplicate review row would double-count a crew leader and, after confirm, double-pay them. The unique constraint on `pec_review_bonuses.review_id` is the second net.
9. **No em dashes in any customer-facing copy** (standing rule 6): SMS bodies, email bodies, subject lines, the What's New entry. Fine in the migration comments and the log entry.
10. **No incentives, no rating gating.** Add "offers nothing of value in exchange for a review" to the scrubber's rules and to every step's `ai_guidance`.
11. **Backfill respects dry_run.** The last-30-days backfill enrolls jobs, and because the campaign is `dry_run` at deploy nothing sends. Verify that ordering before you run it. Deploying and immediately texting 20 customers about a job from three weeks ago is the worst possible first impression of this feature.
12. **FTP is out of scope but not designed out.** `brand` on the request and `platform` on the review exist so adding paint later is a settings change, not a migration.
13. **Check `res.error` on every supabase-js read** before treating an empty result as meaningful.

---

## Acceptance criteria

1. Marking a job complete shows the popup, default Send; both branches write a `pec_review_requests` row, only Send enrolls.
2. `/r/<token>` on the live site redirects to the PEC Google review page and the request's `click_count` increments and status moves to 'clicked'. A garbage token still redirects.
3. The review campaign appears in the Drips view as dry_run, and a due step renders real copy naming the crew leader with the `/r/` link appended, sends nothing, and holds at the approval gate when the gate is on.
4. Posting a sample Zapier payload to `pec-review-intake` inserts a review; a matching customer name auto-matches with `match_status='auto'`; an unrecognizable name inserts with `job_id` null and `match_status='unmatched'`; re-posting the same `external_id` updates rather than duplicating.
5. Confirming a 5-star match in the Reviews view creates exactly one `pec_review_bonuses` row at the settings amount. Confirming a 4-star match creates none. Double-clicking Confirm still creates exactly one.
6. Metrics Reviews section shows per-crew-leader confirmed 5-star counts and the ask/click/review funnel.
7. `pec_prod_job_costing.bonus_cost` and every GP number are byte-identical before and after a review bonus is created and approved. Verify on a real finalized job.
8. Opening a touch-up on a job with a live review drip stops the enrollment with `stop_reason='touchup_opened'`.
9. `npm test` green.

## Tests

Extend `production/drip-phase3.test.cjs` (or a new `production/review-drip.test.cjs`) with: review-kind enrollment, each of the four stop conditions, crew-lead-null generic copy fallback, and the link-appended-by-code assertion. New `production/review-intake.test.cjs`: auto-match single candidate, ambiguous candidates leave unmatched, idempotent re-fire, unparseable payload returns 200 with a note, and the "intake never writes confirmed" assertion.

## Standing rules checklist

- **Rule 11 (What's New):** one entry covering the review request and the crew leader scoreboard. Plain language, no em dashes.
- **Rule 12 (settings):** the six keys in Part A6, surfaced in a Settings > Reviews group.
- **Rule 13 (@artifacts):** header on the migration covering the two new tables, the new `reviews` columns, and the six settings keys. The two CHECK changes and the NOT NULL drops are not expressible as artifact kinds, so note them and hand-verify with `pg_get_constraintdef` and `information_schema.columns`.
- **features.json:** update the existing "Reviews" entry (currently "Read-only view of collected customer reviews") and add a "Review request drip" entry. Update the "Lead drip engine" entry to mention the fourth kind.
- **SCHEMA.md:** regenerate after applying the migration.

## Handoff to Dylan

1. Set `REVIEW_INTAKE_SECRET` in Netlify env.
2. Confirm `google_review_link_epoxy` in Settings is the short one-tap review URL (the `.../review?placeid=` or `g.page/.../review` form that opens the star widget), not the plain business listing. The whole "as easy as possible" goal lives in that one string.
3. Build the Zap: Google Business Profile new-review trigger to a webhook POST at `https://prescottepoxy.netlify.app/.netlify/functions/pec-review-intake` with the secret header.
4. Review the generated dry_run copy in the Drips view, then flip the campaign to live yourself.
5. Set `review_bonus_amount` to the real number before flipping live, and tell the crew leaders the rule (confirmed 5-star only) before the first payout, not after.
