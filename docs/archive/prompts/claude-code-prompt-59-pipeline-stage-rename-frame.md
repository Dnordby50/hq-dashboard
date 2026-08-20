# Prompt 59: Estimate Scheduled pipeline stage, Leads -> Sales Pipeline rename, estimator iframe hotfix

Written by Cowork 2026-07-29 after 12 scoping questions. Every "LOCKED" line below is Dylan's answer, not a suggestion. Do not re-litigate them.

## Read first

Standard startup (CLAUDE.md rule 4): CLAUDE.md plus the last 3 PROJECT-LOG.md entries. Two pieces of live state you need:

- `supabase/migrations/2026-08-01_routemize_contact_id.sql` is WRITTEN AND NOT APPLIED (prompt 56's Cowork handoff). **Do not apply it in this session.** Your migration must not depend on it.
- `claude-code-prompt-49-followup-queue.md` is written and has never been run. It assumes six lead stages. Part E item 6 tells you what to do about that.

Live schema facts already verified by Cowork against prod (`zdfpzmmrgotynrwkeakd`), so do not re-derive them:

- `leads_stage_check` = `CHECK (stage = ANY (ARRAY['new','contacted','estimate_sent','presented','accepted','lost']))`. A seventh value is a migration, exactly like the `material_type` CHECK was.
- `leads` has no `estimate_scheduled_at` column.
- `lead_events.from_stage` / `to_stage` have **no** CHECK constraint, so no migration is needed there.
- Open leads right now: 5 `contacted`, 1 `new`. There is nothing to backfill.

---

## Part A: X-Frame-Options hotfix. DO THIS FIRST, IN ITS OWN COMMIT, BEFORE ANYTHING ELSE.

**Symptom Dylan reported:** starting an estimate on https://prescottepoxy.netlify.app produced "prescottepoxy.netlify.app refused to connect."

**Root cause, already diagnosed:** `netlify.toml:331` sets `X-Frame-Options = "DENY"` on `for = "/*"` (added 2026-07-25, security remediation P1). `DENY` forbids **all** framing, including same-origin. The estimator opens as a same-origin iframe: `index.html:7116`, `<iframe class="pec-estimator-frame" src="/estimator/?${params}">`. So the browser refuses to render the frame and the modal shows the connection-refused page. `SAMEORIGIN` is the value that blocks other sites while allowing our own page to frame our own path.

Nobody has tried to start an estimate since 7/25, so treat this as a live outage of the estimator modal, not a Cowork-only quirk.

Changes:

1. `netlify.toml:331`: `X-Frame-Options = "DENY"` -> `"SAMEORIGIN"`.
2. Same block, the report-only CSP on line 336: `frame-ancestors 'none'` -> `frame-ancestors 'self'`. Leaving it at `'none'` means the day CSP is enforced it re-breaks exactly what you just fixed.
3. Update the comment block above the header rule (lines ~316-324) to say why SAMEORIGIN rather than DENY: the app frames its own estimator PWA, its own estimate-preview renderer, and a third-party financing widget. One sentence, no em dashes needed in code comments but keep it short.
4. Add a TODO line in that comment: enforcing the CSP later needs `frame-src 'self' <financing embed origin>`, because `default-src 'self'` would block the Enhancify iframe rendered at `index.html:19420`.

**LOCKED: do NOT flip the CSP from report-only to enforced in this session.** That is its own project with its own verification pass.

**LOCKED: do NOT change how the estimator launches.** The iframe modal and its postMessage handshake (`index.html:7095-7210`) stay exactly as they are.

Iframes that must work after this change, verify each:

- Estimator modal, `index.html:7116` (same-origin `/estimator/`). This is the reported break.
- Estimate preview modal, `index.html:25344` (same-origin, `#estPreviewFrame`).
- Email body viewer, `index.html:20447` (`srcdoc` + `sandbox=''`). Unaffected by X-Frame-Options; confirm it still renders and stays script-free.
- Financing embed, `index.html:19420` (third-party URL). Our X-Frame-Options never applied to it; it either works today or it is the vendor's header. Do not "fix" it here.

Verification: after the deploy, `curl -sI https://prescottepoxy.netlify.app/estimator/ | grep -i x-frame` returns `x-frame-options: SAMEORIGIN`, and starting an estimate from a lead card renders the estimator inside the modal.

Commit this alone: `security: allow same-origin framing so the estimator modal loads`.

**Rule 11 exception, deliberate:** no What's New entry for Part A. It restores intended behavior nobody had noticed was broken; an entry announcing that the estimator works would read as noise. Say so in the log entry so the skipped entry is on the record.

---

## Part B: the migration

New file `supabase/migrations/2026-08-03_lead_stage_estimate_scheduled.sql`.

```sql
-- @artifacts
--   column: public.leads.estimate_scheduled_at
-- @end
-- Also replaces leads_stage_check to admit 'estimate_scheduled'. A CHECK
-- constraint is not one of the four @artifacts kinds, so the drift checker
-- verifies only the column; the constraint is verified by hand (see below).

alter table public.leads drop constraint if exists leads_stage_check;
alter table public.leads add constraint leads_stage_check
  check (stage = any (array['new','contacted','estimate_scheduled','estimate_sent','presented','accepted','lost']));

alter table public.leads add column if not exists estimate_scheduled_at timestamptz;
```

Order matters: `'estimate_scheduled'` sits between `contacted` and `estimate_sent` in the array purely for readability; the CHECK is a set, not an order.

**Apply it yourself via the Supabase MCP** against `zdfpzmmrgotynrwkeakd` (same pattern as the 2026-07-29 Ordering entry), then regenerate `SCHEMA.md` in the same commit. Verify with:

```sql
select pg_get_constraintdef(oid) from pg_constraint where conname = 'leads_stage_check';
```

If the Supabase MCP is unavailable in your session, write the file, do NOT fake the apply, and add a `## Handoff to Cowork` section naming this file plus the verification query. Everything in Parts C and D will 400 on every stage write until it lands, so say that plainly in the handoff.

No backfill. No data migration. No settings key (see rule-12 note at the bottom).

---

## Part C: the new stage, client side (index.html)

LOCKED decisions this part implements:

- A **real seventh stage**, `estimate_scheduled`, titled "Estimate Scheduled", positioned **after Contacted and before Estimate Sent**.
- **Automatic on booking AND draggable.** Booking an on-site estimate advances the lead; a human can also drag a card in or out.
- **Canceling the appointment falls the lead back to Contacted.**
- **The nurture drip stops** while a lead is in this stage.
- It **counts as open pipeline** and gets its own first-touch timestamp.

Every anchor below is a current line number in `index.html`; grep the identifier, do not trust the number blindly.

1. **`LEAD_STAGES` (22806)**: insert `{ key: 'estimate_scheduled', title: 'Estimate Scheduled' }` immediately after `contacted`. This one edit is what gives you the kanban column (`renderLeads` columnsHtml at 24305), the lead-detail stage `<select>` (24556), and the Metrics stage table (`pipeByStage`, 12588) for free. Verify all three render; do not hand-edit them.

2. **`LEAD_STAGE_TS` (22817)**: add `estimate_scheduled: 'estimate_scheduled_at'`.

3. **`commitLeadStage` (24040)**: it stamps only `LEAD_STAGE_TS[toStage]`. Add one rule: when `toStage === 'estimate_scheduled'` and `lead.contacted_at` is null, also stamp `contacted_at`. **Landmine 2 below explains why this is not optional.**

4. **`openScheduleEstimateFromLead` (24093)**: currently advances only a `new` lead, and only to `contacted`, with a comment at 24085-24092 saying LEAD_STAGES has no estimate stage. It does now. Rewrite the comment (do not leave the stale note, and do not delete the reasoning about why `estimate_sent` is still off limits) and change the behavior to: on save, if `appt.appt_type === 'on_site_estimate'` and `lead.stage` is `new` or `contacted`, `commitLeadStage(lead, 'estimate_scheduled')`. A lead already at `estimate_sent` or beyond keeps its stage (the existing at-or-past guard). Toast becomes "Lead moved to Estimate Scheduled".

5. **Appointment form lead picker (22583)**: `.in('stage', ['new','contacted','estimate_sent','presented'])` must gain `'estimate_scheduled'`. Leaving it out hides exactly the leads most likely to need a second appointment.

6. **Blast wizard (23641 default set, 23646 `LEAD_STAGE_OPTS`)**: add `'estimate_scheduled'` to both. It belongs in the default audience alongside `contacted` and `estimate_sent`.

7. **`estimateSentLeadEffects` (25784, the `forward` test at 25789)**: `const forward = lead.stage === 'new' || lead.stage === 'contacted'` must also accept `'estimate_scheduled'`. Miss this and sending a real estimate to a lead in the new column silently fails to advance it to `estimate_sent`, which then breaks the estimate follow-up drip handoff and the conversion metrics.

8. **Appointment date on the card, and column sort.** `loadLeadsData` (23965) gains one query: `pec_appointments` where `lead_id` is in the loaded lead ids, `appt_type = 'on_site_estimate'`, `status = 'scheduled'`, ordered `start_at` ascending; keep the earliest per lead in a map on `state.leadsData`. Check `res.error` explicitly (supabase-js returns an empty result, not a throw, on a bad column name). Then:
   - `leadCardHtml` (24008): for a lead with an entry in that map, render a chip near the source badge reading the appointment date and time in Phoenix short form, e.g. `Est Mon 8/3 8:00 AM`. Reuse the existing chip styling, not a new class.
   - `renderLeads` column sort (the `defaultCmp` block at ~24309): the `estimate_scheduled` column sorts by appointment `start_at` **ascending** (soonest visit first), mirroring the existing "New sorts oldest first" reasoning. Leads in that column with no appointment (dragged in by hand) sort last. The AI-score sort still wins when selected.

9. **Do NOT change the Schedule Estimate button gate at 24033** (`['new','contacted']`). A lead already in Estimate Scheduled has an appointment; adding a second one is a deliberate trip through the Appointments screen. This is a decision, not an oversight, so leave a one-line comment saying so.

10. **Cancel fallback, client side.** New function `apptCancelLeadEffects(appt)` next to `apptBookingSideEffects` (22519). Behavior: if `appt.lead_id` and the lead's stage is `estimate_scheduled`, and there is **no other** `pec_appointments` row for that lead with `appt_type='on_site_estimate'` and `status='scheduled'` (excluding this one), then move the lead to `contacted` with a `stage_change` `lead_event` carrying `payload.via = 'appointment_canceled'` and the appointment id. Use a guarded update (`.eq('stage','estimate_scheduled')`) so a race writes nothing. Best-effort throughout: a failure here must never make a canceled appointment look uncanceled, so log and toast softly, never throw.
    Call it from `apptPostWrite` (22478) when `opts.canceled` or `opts.deleted` is set. Both call sites already pass those flags: the cancel button at 22788 and the delete button at 22773.
    **The "no other scheduled estimate" check is the whole point of the guard.** A reschedule that cancels the old appointment and books a new one must leave the lead in Estimate Scheduled.

---

## Part D: the new stage, server side

1. **`_pec-appt.cjs`, `apptBookingLeadEffects` (~245-270).** Today it PATCHes guarded on `stage=eq.new` to `{ stage: 'contacted', contacted_at }`. Replace with two guarded PATCHes, in this order, stopping after the first that returns a row:
   - `stage=eq.new` -> `{ stage: 'estimate_scheduled', contacted_at: nowIso, estimate_scheduled_at: nowIso }` (a booked visit proves contact was made; see landmine 2).
   - `stage=eq.contacted` -> `{ stage: 'estimate_scheduled', estimate_scheduled_at: nowIso }` (leave `contacted_at` alone; first touch wins).
   The `lead_event` keeps its existing shape with `to_stage: 'estimate_scheduled'` and the real `from_stage`, and is still written only when a PATCH actually flipped a row. The existing drip stop with `stop_reason: 'appointment_booked'` stays exactly as it is.
   Update that function's header comment, which currently promises parity with "a NEW lead advances to 'contacted'".

2. **`_pec-appt.cjs`, new export `apptCancelLeadEffects(sb, appt)`** as the server twin of Part C item 10. Same rules, same guard, same best-effort contract (never throws). Add it to `module.exports` (389). Call it from `pec-appt-intake.cjs` in the canceled/deleted branch (~488-497), after the status PATCH succeeds and before the log line, so a Routemize cancellation walks the lead back too.

3. **`_pec-drip.cjs`, `KIND_CHECKS.lead` (571)**: add `'estimate_scheduled'` to the `['estimate_sent','presented','accepted']` stop list, and update the comment above it (566) which says `'new'/'contacted'` keep dripping. Booking already stops the enrollment eagerly with `appointment_booked`; this covers the card a human drags in, where nothing server-side fires.

4. **Tests.** `production/appt-intake.test.cjs` is already in `npm test` (100 assertions). Extend it:
   - native booking advances a `new` lead to `estimate_scheduled` and stamps both timestamps;
   - native booking advances a `contacted` lead and does NOT rewrite `contacted_at`;
   - a lead at `estimate_sent` is untouched;
   - a Routemize cancellation walks an `estimate_scheduled` lead back to `contacted` and writes the event;
   - a cancellation while a SECOND scheduled on-site estimate exists leaves the stage alone.
   Add the drip stop case to the existing drip runner suite. Full `npm test` must be green (330 assertions before your additions).

---

## Part E: rename Leads -> Sales Pipeline

LOCKED: **the board is renamed, the records are not.** "Sales Pipeline" is the screen. An individual record stays a **Lead** (New Lead button, lead detail, toasts, "Open leads" tile, every filter label). No DB rename, no code-identifier rename, no `state.leads*` rename, no `data-pec-view` or hash change.

LOCKED: rail group becomes **"Sales Pipeline"**, the item inside it becomes **"Pipeline"**. LOCKED: the Production **"Jobs pipeline"** item is left exactly as it is.

1. `index.html:2507`: `<div class="pec-subnav-group">Leads</div>` -> `Sales Pipeline`.
2. `index.html:2508`: `<button data-pec-view="leads">Leads</button>` -> `>Pipeline<`. **The attribute stays `leads`.** `switchView`, the hash router, and the rail renderer all key off it, and old bookmarks (`#leads`) must keep working.
3. `refreshTitle` (5446-5470) derives the CRM page title from the active rail button's `textContent`, so this rename would put a bare "Pipeline" in the page header, ambiguous against the Jobs pipeline. Fix it properly: give the button a `data-pec-title="Sales Pipeline"` attribute and have `refreshTitle` prefer `dataset.pecTitle` over `textContent` when present. That is a two-line change that also gives every future rail item a way to have a short label and a long title. Do not special-case the string "Pipeline" in JS.
4. Grep `help/` for copy that names the Leads nav item (help content, the help assistant's index, `whats-new.json` history is append-only and stays as written) and update only the sentences that tell a user where to click. Do not rewrite historical What's New entries.
5. `features.json`: rename entry 13 `"Leads pipeline board"` -> `"Sales Pipeline board"`, and update its description plus the grouped-navigation entry (45) where they name the rail item. Also add the new stage to entry 13's description and note the appointment-driven entry/exit in entry 71 (Appointments calendar).
6. **Append a note to the top of `claude-code-prompt-49-followup-queue.md`** (do not rewrite the prompt): a seventh stage `estimate_scheduled` now exists, so prompt 49's per-stage overdue settings need a `followup_overdue_days_estimate_scheduled` key, and its `fallbackPriority` stage weighting needs a weight for it. Prompt 49 has never run; whoever runs it must not silently drop the stage.
7. **What's New (rule 11): one entry** covering both user-visible changes: the rail item is now Sales Pipeline, and there is a new Estimate Scheduled column that fills itself when an estimate appointment is booked and empties when it is canceled. Two or three how-to steps, plain language, **no em dashes** (customer-facing rule applies to help and What's New content).

---

## Landmines

1. **Order of operations.** Part B must be applied before any code path can write `'estimate_scheduled'`. Until then every drag and every booking PATCH 400s on `leads_stage_check`. If you cannot apply the migration, say so loudly in the log entry and the handoff.
2. **`contacted_at` is load-bearing.** The speed-to-lead metric and prompt 49's overdue math read it. A `new` lead that jumps straight to `estimate_scheduled` without stamping `contacted_at` reads forever as "never contacted", which would put a lead with a booked appointment at the top of an urgency list. Stamp it on entry, both client (Part C item 3) and server (Part D item 1).
3. **`estimate_sent` stays reserved for a real document going out.** Never stamp `estimate_sent_at` or set stage `estimate_sent` from a booking. `estimateSentLeadEffects` owns that transition, it feeds conversion metrics and the drip kill-switch, and faking it corrupts both. This was the original reason the stage did not exist; the fix is the new stage, not a shortcut.
4. **Do not restore the stale comment at 24085-24092** saying LEAD_STAGES has no estimate stage. Rewrite it to describe the new behavior.
5. **Do not apply `2026-08-01_routemize_contact_id.sql`.** It is Cowork's open handoff from prompt 56 and out of scope here.
6. **supabase-js silent-empty gotcha.** The new appointments query in `loadLeadsData` must check `res.error` before concluding a lead has no appointment. A misspelled column returns an empty result with an error object, not a throw.
7. **`pipeByStage` (12588) filters out `accepted` and `lost` only**, so the new stage joins the Metrics stage table and open pipeline value automatically. Verify rather than edit; an extra hand-written row would double-count.
8. **Two modal roots** (CLAUDE.md gotcha) if you touch any modal lifecycle. Part C item 10 does not, it only reads and writes rows.

---

## Acceptance criteria

- `curl -sI https://prescottepoxy.netlify.app/estimator/` shows `x-frame-options: SAMEORIGIN`; starting an estimate from a lead card renders the estimator inside the modal instead of a refused-to-connect page.
- `select pg_get_constraintdef(oid) from pg_constraint where conname='leads_stage_check'` includes `estimate_scheduled`; `leads.estimate_scheduled_at` exists; `SCHEMA.md` regenerated and Schema Drift clean.
- The board shows seven columns, Estimate Scheduled third.
- Booking an on-site estimate from a `new` lead card moves it to Estimate Scheduled with both timestamps stamped, and the card shows the appointment date chip.
- Booking from a `contacted` lead moves it and leaves `contacted_at` unchanged.
- Canceling that appointment moves the lead back to Contacted with a `stage_change` event; canceling one of two scheduled estimates does not.
- A lead dragged into Estimate Scheduled has its active nurture enrollment stop on the next runner pass.
- Sending a real estimate to a lead in Estimate Scheduled advances it to Estimate Sent.
- The rail reads Sales Pipeline > Pipeline, the page header reads Sales Pipeline, `#leads` still routes there, and Production still reads Jobs pipeline.
- `npm test` green.

## Commits expected

1. `security: allow same-origin framing so the estimator modal loads` (Part A alone).
2. `leads: add estimate_scheduled stage (migration + SCHEMA.md)`.
3. `leads: wire estimate_scheduled through booking, cancel, drips, blast, and metrics`.
4. `nav: rename the Leads board to Sales Pipeline`.

Squashing 3 and 4 is fine if they land together; keeping Part A separate is not optional, it should be deployable on its own.

## Rule 12 note

No settings surface in this prompt, deliberately. The only tunable this feature implies is a per-stage follow-up threshold, which belongs to unrun prompt 49 (Part E item 6 routes it there). Column order and stage titles are structure, not configuration. State this in the log entry so the rule-12 skip is justified on the record rather than looking forgotten.

## Log entry

Append at the TOP of PROJECT-LOG.md, `By: Claude Code`. Include: the X-Frame-Options root cause in one sentence a future reader can learn from (DENY blocks same-origin framing, SAMEORIGIN does not), whether the migration was applied by you or handed to Cowork, the exact anchors you touched, the assertion count after your test additions, the deliberate rule-11 skip for Part A, the rule-12 justification, and the note you appended to prompt 49. If anything stopped early, log it anyway.
