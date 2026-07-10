# Claude Code Prompt 10: Itemized subcontractor expenses on Job Costing + subcontracted-job flag

## Context

Dylan wants subcontractor expenses properly recorded on jobs PEC subs out. Scoped by Cowork on 2026-07-06 through 13 multiple-choice decisions. Repo: HQ-Dashboard, branch main. Run AFTER prompts 8 and 9; line numbers below predate them, grep for symbols.

## What exists today

- pec_prod_job_costing.subcontractor_cost is a single per-job dollar field, edited via moneyInput('Subcontractor', 'subcontractor_cost', ...) on the costing detail (~16995, ~17724 pre-prompt-8).
- It already flows into Total Var and GP (computeCostingRow ~16597-16603) and every rollup aggregate (~16904-16909). Nothing else reads it.
- There is no per-line expense table for subs and no way to mark a job as subcontracted.

## Dylan's decisions (all final)

1. A Subcontractors section (card) on the Job Costing detail, next to materials and hours. No new nav tab.
2. Line items per job. Each row has exactly TWO entry boxes: subcontractor name (free text, no directory) and dollar amount. No description, date, invoice number, or paid-status tracking (Dylan explicitly declined those; created_at can exist in the table for ordering, just not as an entry box).
3. Line items SUM into the existing subcontractor_cost bucket so GP math and all rollups keep working unchanged. Single source of truth: once a job has line items, the old single money input becomes read-only display of the sum (or is replaced by the section total). No double-counting under any sequence of edits.
4. Backfill: every job with a nonzero subcontractor_cost gets ONE line item named "Prior entry" for that amount in the migration, so the bucket totals are identical before and after and everything is itemized going forward.
5. Subcontracted-job flag: a checkbox on the costing detail marking the whole job as subcontracted. Flagged jobs are EXCLUDED from crew-hours expectations and the crew bonus calculation (no crew worked it, nobody should earn a labor-savings bonus from unspent budgeted labor). Think through what finalize records for a flagged job: bonus pool zero, no pending bonus suggested, and the Bonus Report untouched by it. If a job already has manual hours or bonus rows when flagged, do not delete data; exclude it from the calc and show a small note ("subcontracted, crew bonus skipped").
6. Flag visibility: costing surfaces only (the costing detail and the costing list rows). No badges on Jobs, Schedule, or Invoicing.
7. Permissions: same gate as the rest of the costing detail (can_view_job_costing). Finalized costing locks the section exactly like the other costing inputs (respect the prompt-8 review-gate behavior: submitted-for-review also locks for the submitter).
8. Rollups: no new visible Subcontractor column; the bucket keeps flowing into Total Var / GP as today.

## Build notes

- Migration (idempotent, verify queries at the bottom, Cowork applies to PROD): new table pec_prod_job_sub_expenses (id uuid pk default gen_random_uuid(), job_id uuid FK to pec_prod_jobs ON DELETE CASCADE, name text not null, amount numeric not null default 0, created_at timestamptz default now()), RLS matching the sibling costing tables (one FOR ALL staff policy, same pattern as pec_prod_job_manual_labor in 2026-06-15_crew_bonus_manual_and_payouts.sql); plus subcontracted boolean not null default false on pec_prod_jobs; plus the "Prior entry" backfill (INSERT ... SELECT from pec_prod_job_costing where subcontractor_cost > 0, guarded so re-running cannot duplicate, e.g. only insert when the job has zero existing sub-expense rows).
- Deploy-order safety, same discipline as prompts 6 and 8: the UI must degrade gracefully before the migration lands (missing table returns an error INSIDE the supabase-js result, never a throw; render an "apply the 2026-07-06 sub expenses migration" note instead of breaking the costing detail).
- Sum-into-bucket mechanics: on every line add/edit/delete, recompute the sum and write it to pec_prod_job_costing.subcontractor_cost (upsert onConflict job_id, the same debounced-field pattern at ~16757 or a direct write). The write is idempotent full-value, so withFreshWriteRetry is appropriate for edit/delete; the line INSERT itself is non-idempotent: withFreshWrite, button disabled during save, no blind retry (bonus-insert pattern ~17042).
- The Eric Harris lesson from prompt 8 applies: if you ever rewrite the whole line set, serialize per job and verify deletes landed before inserting. Prefer per-row insert/update/delete over delete-then-insert here; there is no derive step for sub expenses, so delete-then-insert is not needed at all.
- Crew bonus exclusion: the bonus calc and its formula card live in the costing detail (bonusCalc / manualLaborEditorHtml region ~17420-17460 pre-prompt-8). Gate on job.subcontracted. Also check bonusTotalForJob and the finalize path so a flagged job cannot record a bonus at finalize time.
- Standing rules: commit per meaningful change, node --check the extracted script blocks, no em dashes anywhere, PROJECT-LOG.md entry at the top, migration NOT applied from your session (Cowork handoff).

## Handoff to Cowork (put in your log entry)

1. Apply the new migration to PROD, run its verify queries, and report: table exists with RLS, subcontracted column present, backfill count (jobs that got a "Prior entry" line) and that sum(line amounts) equals the old subcontractor_cost total per job (a checksum query, include it in the migration file).
2. Post-deploy verification with Dylan: add two expense lines to a test job and confirm the Subcontractor bucket, Total Var, and GP move by exactly the sum; delete a line and confirm the bucket follows; flag a job subcontracted and confirm the crew bonus card shows the skip note and finalize records zero bonus; confirm a job with an old single-field amount shows its "Prior entry" line and the same GP as before.
