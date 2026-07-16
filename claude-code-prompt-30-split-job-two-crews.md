# Claude Code prompt 30: split a Next Day job across two crews (schedule simultaneously)

## Context
Dylan wants to split a single job on the Next Day Schedule so two EXISTING crews are scheduled on it at the same time (both teams on site the same day to finish a big job faster). Today the Next Day board (renderNextDay in index.html) reads pec_prod_job_schedule_days and places each job as ONE card under its crew_id column, in a First / Second / Third time slot (stored time_slot values AM / PM / EXTRA, mapped by the slotLabel helper). A job's schedule for a given date is a single row: (job_id, scheduled_date, crew_id, crew_lead, time_slot, day_index). There is no way today to put one job under two crews at once.

Scope is deliberately small. Dylan's exact framing: "just need to be able to split a job on next day to be able to be scheduled simultaneously between 2 existing crews. thats all." Do not build capacity or availability logic, costing changes, bonus or commission changes, or a job-level rework. Two existing crews only, exactly two max.

Repo: hq-dashboard. Deploy: https://prescottepoxy.netlify.app.

### Locked decisions (Cowork scoping, 2026-07-16)
- Situation: two crews, SAME day, in parallel.
- Assigned per scheduled day on the Next Day board, not job-wide.
- Exactly two crews max (the primary already on the card, plus one second).
- The control lives on the Next Day Schedule board.
- Both crews scheduled SIMULTANEOUSLY: the second crew defaults to the SAME time slot as the primary card. An independent slot is not required, keep it simple.
- Show a "2 teams" (shared) badge on BOTH crew cards.
- Print on BOTH crews' run sheets (nextDayPrintHtml).
- No capacity or availability blocking, no costing change, no bonus or commission change, no calendar changes.

### Verified DB facts (checked live against prod, so do not re-derive; still confirm the insert path works)
- pec_prod_job_schedule_days has NO unique constraint on (job_id, scheduled_date). Its only unique index is the primary key on id; idx_pec_prod_jsd_date and idx_pec_prod_jsd_job are both non-unique. So a SECOND row for the same job and date with a different crew_id is allowed, and that is the natural mechanism for "two crews, same day." No schema migration is required.
- crew_id is a FK to pec_prod_crews with on delete set null; crew_lead, notes, time_slot, day_index are free.
- "Shared / 2 teams" is DERIVABLE, not stored: for a given scheduled_date, a job whose schedule rows span two distinct crew_ids that day is doubled. No new column or flag is needed.
- Only add a migration if you hit a real blocker. If you do, STOP and hand it to Cowork to apply. Do not apply migrations yourself. (This project keeps repo migrations as the source of truth and Cowork applies them to prod.)

## Tasks
1. Add a "Split to 2nd crew" control (button or small menu action) on each Next Day board job card, or in the day / schedule modal that the card opens, whichever fits the existing pattern cleanest. It should:
   - Let the user pick a SECOND existing crew from pec_prod_crews (active only), excluding the crew already on that card.
   - Insert a second pec_prod_job_schedule_days row for the same job_id and scheduled_date with the chosen crew_id, defaulting time_slot to the primary card's time_slot (simultaneous) and day_index to match the primary row, with crew_lead blank (settable later like any card).
   - Enforce the max of two: if the job already has two crew rows on that date, disable or hide the control.
2. Render the doubled job as a card under BOTH crew columns on the Next Day board, each in its slot, each showing a "2 teams" shared badge. When building the board, a job with two crew rows on that date yields one card per crew.
3. Add a remove path: an x or remove action on the SECOND team's card that deletes only that second schedule-day row, reverting the day to a single crew. Never delete the primary row through this control.
4. Print: nextDayPrintHtml must place the doubled job in BOTH crews' First / Second / Third columns on the run sheet, carrying the same "2 teams" marker. Keep the print-side marker plain text (a plain hyphen, never an em dash, per standing rule 6).
5. What's New entry (standing rule 9, this is user-facing): help/whats-new.json, next id in sequence, today's date, title like "Split a job across two crews on the Next Day Schedule," a one-line summary, and 2 to 3 plain-language steps (open Next Day Schedule, on a job card choose Split to 2nd crew, pick the other team). No em dashes.

## Guardrails
- Two EXISTING crews only. Do not add crew-creation UI here. Exactly two max per job per date.
- Do NOT change costing (pec_prod_job_costing), bonuses, commissions, BusyBusy hours, or hours reconciliation. Labor already attaches per crew member, which already covers both crews.
- Do NOT add availability or capacity blocking, and do not touch the main calendar (renderScheduleCalendar) beyond sharing an existing helper if strictly needed. This is the Next Day board plus its run sheet only.
- Do NOT add a unique constraint on (job_id, scheduled_date); that would break both this feature and normal multi-day scheduling.
- CRITICAL, the subtle risk: adding a second schedule-day row for the SAME date must not double-count the job anywhere. A job with two same-date crew rows is still ONE job scheduled on ONE day, not two days. Audit and preserve: deriveJobStatus, runScheduleStatusSync and the prod_status_sync_trigger, any day_index or "days scheduled" counting, job-count badges, and the Next Day "jobs tomorrow" count. If any of these count schedule rows, dedupe by job_id so doubling a job does not inflate counts or corrupt status. Call out in your log entry exactly which counters you checked and how you kept them correct.
- Keep the existing drag and drop slot logic working for both cards. Moving one crew's card must change only that crew's row.
- No em dashes anywhere (standing rule 6).

## Acceptance
- On the Next Day board, a job can be split to a second existing crew and then appears under both crew columns simultaneously, each card badged "2 teams."
- The second team can be removed, reverting to one crew, without affecting the primary card.
- The run sheet prints the job under both crews.
- Job counts, the "jobs tomorrow" count, day counts, and job status are all UNCHANGED by doubling a job (still one job, one scheduled day).
- Both production test suites pass, all inline script blocks parse clean, and whats-new.json validates.

## After
- Commit per standing rules, for example: nextday: split a job across two crews.
- Append a PROJECT-LOG.md entry at the top (By: Claude Code) naming the functions changed (renderNextDay, the day or schedule modal, nextDayPrintHtml, the slot grouping logic, the What's New id), stating that NO migration was needed because pec_prod_job_schedule_days already allows a second same-date row (verified: no unique constraint) and "shared" is derived from two distinct crew_ids on the date. Explicitly record which counters and status paths you checked for the double-count guardrail and how you kept them correct.
- No Cowork handoff is expected (front-end only, no schema, no prod data touched). If a migration turns out to be necessary after all, STOP and hand it to Cowork to apply rather than applying it yourself.
- Run node --check and the existing production tests if they are part of your normal flow.
