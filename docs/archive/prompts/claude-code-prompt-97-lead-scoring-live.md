# Claude Code prompt 97: make the Hot/Warm/Cold score real (every lead scored, refreshed nightly)

## Context

Dylan, 2026-08-18, asked for a sales follow-up list ranked by Hot leads. The badge for that already exists and has since prompt 42; the data behind it does not.

Live counts, 2026-08-18:

- 22 leads total, **4 with a score**. Of the 18 open (not archived) leads, **17 have `score` null**, and the one that is scored is Cold.
- 13 leads carry a `routemize_contact_id`, meaning they were created by the Routemize intake.

Root cause: `leads.score` is written only by `pec-lead-ai.cjs`, which runs on the web-form intake path (`pec-lead-intake.cjs` :115-125 fires it server-to-server) and on the lead detail page's Refresh button. `createRoutemizeLead` in `pec-appt-intake.cjs` deliberately does not kick it (the comment reads "DELIBERATELY NOT nurture-enrolled (landmine 3) and no AI kick"), which was right for drip enrollment and wrong for scoring. Since Routemize became the booking front end, most new leads arrive through that door, so the score column went quiet.

Second problem, which prompt 49 already named: even a scored lead is scored **once, at intake, forever**. It is a snapshot of inquiry quality, not a read on who to call today. Sorting a pipeline Hot-first by a number that never moves is close to sorting by arrival order.

This prompt fixes the data. Prompt 98 builds the follow-up queue on top of it. Ship this one first; the queue is worthless on 17 unscored leads.

### Read before you start

CLAUDE.md, the top 3 entries of PROJECT-LOG.md, features.json entries "Sales Pipeline board", "Lead detail with AI game plan", "Instant lead touch and new-lead alerts", SCHEMA.md for `leads`, `lead_events`, `settings`. Files: `netlify/functions/pec-lead-ai.cjs`, `pec-lead-intake.cjs`, `pec-appt-intake.cjs` (`createRoutemizeLead`), and `leadScoreBadge` / `leadScoreBand` in index.html.

---

## Locked decisions (Dylan, 2026-08-18)

1. **Every lead gets scored regardless of source**, and **open leads re-score nightly** so the number reflects what has happened since intake.
2. Keep the existing 1-100 AI score and the 70/40 Hot/Warm/Cold cutoffs. This is not a rewrite of the scoring model, it is coverage plus freshness.
3. The AI still never contacts a customer. Drafts stay copy-paste material for a human (Dylan's 2026-07-10 decision, restated in the header of `pec-lead-ai.cjs`). Keep it that way.

---

## Part A: close the Routemize gap

In `createRoutemizeLead` (pec-appt-intake.cjs ~:462), kick `pec-lead-ai` for the newly created lead using the same fire-and-forget pattern `pec-lead-intake.cjs` uses (:115-125): its own Netlify invocation, server-to-server with `x-webhook-secret`, not awaited past the request, best-effort, never able to turn a good appointment intake into a non-200.

Leave the "no nurture enrollment" behavior exactly as it is. That decision was about drips, not scoring, and re-enrolling a booked lead in nurture is still wrong.

Also check the other lead-creation doors and kick from each one that is missing it: the manual "Add lead" flow in index.html, and any other server path that inserts into `leads`. List in the log entry which doors you found and which now kick.

## Part B: the nightly re-score runner

New scheduled function `pec-lead-score-runner.cjs`, on the same posture as `pec-drip-runner` and `pec-lost-reason-backfill`:

1. Schedule it in netlify.toml, nightly, offset from the existing 15:00 UTC backfill so two AI jobs do not stack.
2. Subject set: leads that are not archived, not soft-deleted, not `lost`, not `accepted`, and whose stage is in a settings-controlled list (default: `new`, `contacted`, `estimate_scheduled`, `presented`, `estimate_sent`). Opted-out leads still score: opting out of texts does not mean the lead is dead.
3. Order by staleness (never scored first, then oldest `scored_at`), cap the batch at a settings value (default 50), so a bad day costs a bounded number of model calls. Today's real number is 18.
4. Reuse `pec-lead-ai`'s existing gather-and-score path rather than forking a second scoring implementation. If that means extracting the core into a shared module, do it, and keep the endpoint's behavior identical for the Refresh button.
5. Add `leads.scored_at` (nullable timestamptz) and stamp it on every run, including the intake kick. The `ai_analysis` blob and the `ai_analysis` lead_event keep working as they do now.
6. **Do not write a lead_event on every nightly run.** Eighteen leads a night times an event row each is timeline noise that buries the real history. Write an event only when the score band changes (Cold to Warm, Warm to Hot, and the reverse), and say so in the entry.
7. Settings (rule 12), on the Drips card or a new Leads card, at most two front-of-card: `lead_score_nightly_enabled` (default on) and `lead_score_batch_cap`; behind Advanced: the stage list and the model override.
8. Heartbeat: wrap the handler the way `pec-google-calendar-pull.cjs` does (prompt 90 Task A) so Sync Health sees it.

## Part C: make staleness visible

1. The score badge (`leadScoreBadge`) gets a tooltip carrying when it was scored ("Scored 2 days ago"), read from `scored_at`.
2. A never-scored lead must not read as Cold. Check `leadScoreBand`'s handling of null today and render an explicit "Not scored yet" state instead of anything that looks like a judgment. That is the current bug behind "sorting by Hot shows nothing useful".
3. The pipeline's Hot-first sort puts unscored leads after scored ones, not at the bottom under Cold. An unscored lead is unknown, not bad.

## Part D: backfill

Score the 17 unscored open leads once, through the runner with the cap temporarily lifted or by running it on consecutive ticks. Report in the log entry: how many were scored, the resulting Hot / Warm / Cold / unscored counts, and the total model cost if it is measurable. Per the prompt-56 lesson, count before you apply: a backfill that writes `ai_analysis` over an existing blob on a lead somebody already refreshed by hand should be skipped, so exclude leads scored in the last 24 hours.

## Part E: docs and ship

features.json (the pipeline and lead-detail entries), SCHEMA.md after the migration, migration with the `@artifacts` header, one What's New entry ("Every lead now gets a score, and it refreshes nightly"), tests for the runner's subject selection, the batch cap, the band-change event rule, and the null-score rendering. Commit and log per standing rules.

## Acceptance criteria

- Booking a Routemize appointment for a brand-new contact produces a lead with a non-null `score` within a minute or two, without a human pressing Refresh.
- After the backfill, every open lead has a score and a `scored_at`, and the pipeline's Hot-first sort returns a meaningful order. State the actual distribution in the log entry.
- A lead whose situation changed (an estimate sent, an inbound call logged) reads a different score the next morning. Prove it on one real lead rather than asserting it.
- The nightly run costs a bounded, stated number of model calls and appears in Sync Health.
- `npm test` green, `node --check` clean, index.html script blocks parse.

## Do not touch

The scoring model's prompt wording or the 70/40 cutoffs (that is a tuning conversation, not this build). Drip enrollment behavior on any path. The instant-touch flow.
