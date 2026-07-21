# Claude Code Prompt 40: Manual completion as source of truth + Invoicing AR cleanup

## Context

Dylan reported: jobs that still have scheduled days on the calendar are showing up as **completed** on the Invoicing tab, cluttering AR and making it unclear what is actually receivable.

Root cause (diagnosed, do not re-litigate): the status state machine **auto-completes** a job the day after its last scheduled day (`today > end -> 'completed'`), and then **locks** it (`storedStatus === 'completed'` returns null / the trigger's `status <> 'completed'` guard), so it never re-evaluates. When a day is later added back to an already-completed job (reschedule, a later phase, a warranty/callback day), the job stays `completed` while carrying a future scheduled day, and lands in the "Completed, not paid in full" AR bucket.

This rule lives in **two canonical places that must stay in lockstep** (this is the important part):
- Client: `deriveJobStatus()` at index.html:6347 (the `today > end -> 'completed'` branch, line ~6354).
- Server: the `pec_prod_jobs_sync_public_status()` trigger in `supabase/migrations/2026-06-09_unified_status_trigger.sql` (the `else target := 'completed'` branch, lines ~76-78). This is a path-independent backstop; a client-only change is silently overridden by this trigger.

Dylan's decision: **manual completion becomes the source of truth.** A job should NOT auto-complete just because its schedule ran out. It only becomes `completed` when a human clicks Mark Complete (job detail / invoicing) or drags it to Complete in the pipeline. Because that flips the risk (finished work never entering AR if nobody marks it complete), we pair it with a "Ready to invoice" safety-net section.

Repo: `/Users/dylannordby/Claude-Code/HQ-Dashboard`. Single-file dashboard is index.html. Follow standing rules in CLAUDE.md (features.json + SCHEMA.md before searching/SQL; What's New entry; commit + PROJECT-LOG per change). Prescott Epoxy only (the AR view filters `customer_company = 'prescott-epoxy'`).

Ship as **TWO commits** in this order.

---

## COMMIT 1 (immediate relief): Invoicing tab moves "completed but still scheduled" jobs out of AR

Goal: without touching any stored status, stop auto-completed jobs that still have a strictly-future scheduled day from counting as AR. This cleans up the existing backlog by display, since Commit 2 is "going forward only" (no DB backfill).

Where: `renderInvoicing()` at index.html:8791.

Rules:
- A completed AR row is **parked** (pulled out of the "Completed, not paid in full" bucket and the Total AR figure) when ALL of:
  1. `status === 'completed'` and `balance > EPS` (i.e., it is currently in the completed bucket), AND
  2. it has at least one schedule day dated **strictly after today** (Phoenix; use the existing `invToday()`), AND
  3. it was **auto-completed, not manually completed**: `status_manual_at IS NULL`. A human who explicitly marked it complete keeps it in AR even with a future day (respect manual completions).
- Parked jobs render in a **new labeled section** on the Invoicing tab titled "Completed, but still on the schedule" (or similar), collapsed-friendly like the other `pec-ar-sec` cards. Show customer, address, balance, salesperson, and **the next scheduled date** ("next day: Aug 3") so it is obvious why it is parked. It is NOT counted in Total AR or the AR job count.
- Everything else about the completed bucket (last-invoiced cell, ACH chips, flags) stays as-is for the jobs that remain.

Bridging the AR row to schedule days (both bridges, per Dylan):
- The AR rows come from `pec_job_ar` (public.jobs based); schedule days live on `pec_prod_job_schedule_days.job_id -> pec_prod_jobs.id`. The reliable link is `dripjobs_deal_id`. `renderInvoicing` already fetches `pec_prod_jobs (dripjobs_deal_id, install_date)`; extend that read to also get `id` and (for the name+address fallback) `customer_name, address`.
- For jobs with **no deal id**, fall back to the normalized **name + address** match (reuse `_nameAddrKey` / `_normKey` at index.html:6363-6367). This mirrors how `mirrorProdStatus` handles manual prod-only rows.
- Add ONE batched read of `pec_prod_job_schedule_days` (select `job_id, scheduled_date`) for the relevant prod job ids, and compute per prod job: `hasFutureDay = max(scheduled_date) ... any > today`, plus `maxScheduledDate` and `minScheduledDate` (Commit 2 reuses these). Never query per-row.

Verify `pec_job_ar` actually exposes `status_manual_at`. Check the view definition (migrations `2026-05-27_invoicing_ar.sql`, `2026-07-10_ar_exclude_archived.sql`) against SCHEMA.md. If the column is not in the view, either (a) add it to the view in a small migration (Claude Code writes, Cowork applies), or (b) read it with one extra batched `jobs` select keyed on the completed ids. Prefer (a) for cleanliness if the view is easy to extend; note the choice in the log.

---

## COMMIT 2 (root cause): remove schedule auto-completion + add the "Ready to invoice" safety net

### 2a. Stop auto-completing (client + server, in lockstep)

- **Client** `deriveJobStatus()` (index.html:6347): change the final branch so `today > end` yields **`'in_progress'`**, not `'completed'`. A job that has run past its last scheduled day stays in progress until a human completes it. Keep rules 1-3 (already-completed returns null; manual pin returns null; no start -> 'signed'; start > today -> 'scheduled').
- **Stop auto-stamping `completed_date`.** Remove the auto-complete `completed_date` writes that pair with the removed branch: the client persist at index.html:~12927 (`if (statusTarget === 'completed' && !job.completed_date) ...`), and the equivalent in `syncPublicJobStatusFromSchedule` at ~6415. `completed_date` is now stamped ONLY by the manual `markJobComplete` path (index.html:10544) and the pipeline drag-to-complete. (Dylan: clear/never auto-stamp; the real completion date comes from the human action.) Confirm `markJobComplete` stamps `completed_date` when it sets status completed; if not, add it there.
- **`mirrorProdStatus`** and the pipeline/job-detail sync paths: audit that none of them still push `'completed'` off the schedule. Manual completion still mirrors fine (that is a genuine status write, not schedule-derived).
- **Server trigger** (new migration `supabase/migrations/2026-07-21_manual_completion_source_of_truth.sql`, Claude Code WRITES, Cowork APPLIES): `create or replace` `pec_prod_jobs_sync_public_status()` changing the final `else target := 'completed'` (lines ~76-78 of the 2026-06-09 migration) to `target := 'in_progress'`, and drop the `completed_date = case when target = 'completed' ...` auto-stamp (that branch can no longer be reached from the schedule path anyway, but remove it so the trigger never stamps a completion date). Keep the `NEW.status = 'completed' -> 'completed'` branch (a prod row genuinely marked complete still mirrors) and keep the `and status <> 'completed'` guard. Include the verify query and make it idempotent, matching the existing migration's header style. **Going forward only: no data backfill; do not touch existing rows' stored status.**

Net effect: the "Completed, not paid in full" AR bucket now contains ONLY jobs a human marked complete. Finished-but-unmarked work sits in `in_progress`, surfaced by 2b.

### 2b. "Ready to invoice" section on the Invoicing tab (safety net)

Because completion is now manual, a finished job that nobody marks complete would never appear in AR. Add a section so it never slips:
- New section titled "Ready to invoice (work finished, not marked complete)".
- Contents: bridged jobs with `status === 'in_progress'`, not archived, whose **latest** schedule day is **strictly before today** (i.e., all scheduled days are in the past = work physically done). Reuse the `maxScheduledDate` computed in Commit 1.
- Each row: customer, address, price/balance, salesperson, last scheduled date, and a **Mark Complete** button (reuse `markJobComplete`) plus View Invoice. Clicking Mark Complete moves it into the real Completed AR bucket.
- De-dupe: such jobs may currently also qualify for the existing "Active" (deposit-paid, in-progress) bucket. Show each finished-work job in "Ready to invoice" ONLY (subtract it from Active) so it appears once. Active keeps in-progress jobs whose last day is today or later.

---

## Packaging, What's New, verification

- Commit 1: `invoicing: park completed jobs that still have future scheduled days out of AR`.
- Commit 2: `jobs: manual completion is source of truth (no schedule auto-complete) + ready-to-invoice list` (plus the migration file).
- What's New (help/whats-new.json, 2 staff-facing entries, no em dashes): (1) "Jobs only count as complete when you mark them complete" -- explain a job past its last scheduled day now waits in progress until you hit Mark Complete, so AR only shows truly done work. (2) "New Ready to invoice list on the Invoicing tab" -- where finished jobs wait for you to confirm and invoice; plus the note that jobs still on the schedule no longer clutter AR.
- Verify: all inline index.html JS blocks `node --check`; features.json + whats-new.json validate; `npm test`. Confirm on data (or a reasoned walkthrough) that: an auto-completed job with a future day drops out of Total AR into the parked section (Commit 1); a manually-completed job with a future day STAYS in AR; a job whose last day just passed shows in Ready to invoice, not Completed, and Mark Complete moves it to Completed AR; deriveJobStatus and the trigger produce the SAME status for the same span (they must not drift).
- Update the affected features.json entry (Invoicing) and, if the view changed, regenerate SCHEMA.md via Cowork.

## Handoff to Cowork
Apply the new trigger migration `2026-07-21_manual_completion_source_of_truth.sql` to PROD ("HQ Dashboard", zdfpzmmrgotynrwkeakd), run its verify query, and regenerate SCHEMA.md if the pec_job_ar view was modified. Report the trigger row count and confirm no existing rows were backfilled.

## Handoff to Dylan
git push when ready (commits are local on main). After deploy: confirm the Invoicing tab no longer shows still-scheduled jobs in AR, and that the new "Ready to invoice" list is catching finished work so nothing goes uninvoiced.
