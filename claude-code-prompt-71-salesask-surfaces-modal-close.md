# Claude Code prompt 71: SalesAsk go-live, recording surfaces on customer / pipeline / estimate, and a modal you can actually close

Scoped by Cowork 2026-08-05 from Dylan's request. Two unrelated asks in one prompt because the second is small.

Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first, per standing rule 4.

---

## What Dylan asked for

1. "Want to be able to see the SalesAsk appointment information on the customer card and also the estimate card." Clarified with him: he means the SalesAsk **insights, the process score, and an option to open the full transcript, collapsed by default**.
2. "On email log, there needs to be an X button in the top right of the modal, and the box is too long. You can't see the close button at the bottom."

## What Cowork verified live before scoping this (prod `zdfpzmmrgotynrwkeakd`, 2026-08-05, Supabase MCP)

**Finding 1, the blocker. The SalesAsk migration was never applied to production.**

- `select count(*) from pec_salesask_recordings` returns `ERROR: 42P01: relation "pec_salesask_recordings" does not exist`.
- `information_schema` count for `pec_appointments.salesask_synced_at` = 0, `pec_appointments.salesask_sync_hash` = 0, `pec_sales_team_members.salesask_email` = 0.
- Zero rows in `settings` where `key like 'salesask%'`.
- `SCHEMA.md` has no `pec_salesask_recordings` section, consistent with the above.
- `features.json` describes the integration as shipped, and `index.html` renders `customerSalesAskCardHtml` today.

So the code shipped and the schema did not. Every SalesAsk surface in production currently hits the catch branch in `mountCustomerSalesAsk` and shows "Run the 2026-07-31_salesask_integration.sql migration to enable sales visit recordings." Nothing pushes to SalesAsk, nothing ingests, no recording has ever landed. Dylan did not know this. It is the reason his request looks like a missing feature rather than a broken one.

**Finding 2, the linkage. Every customer join on this path is null in prod.**

| measure | value |
|---|---|
| `pec_appointments` rows | 11 (10 `source='routemize'`) |
| appointments with `lead_id` | 8 |
| appointments with `customer_id` | **0** |
| `estimates` rows | 11 |
| estimates with `lead_id` | 7 |
| estimates with `customer_id` | **0** |
| `leads` rows | 15 (all live) |
| leads with `customer_id` | **0** |
| estimates whose lead has any appointment | 2 of 11 |

`mountCustomerSalesAsk` (`index.html:21868`) reads `.eq('customer_id', c.id)`. A recording gets its `customer_id` from the appointment it matched, and no appointment has one, and no lead has one to inherit. **Applying the migration alone leaves the customer card permanently empty.** The lead is the only populated join in this system today. Part A exists because of this and is not optional; skipping it ships three cards that render nothing forever and look like a UI bug.

---

## Locked decisions (Dylan chose these on 2026-08-05)

1. **Data shown**: SalesAsk recording insights, not appointment metadata. Add the `coaching` and `tags` fields to what renders (today only `summary` and `action_items` render).
2. **Score**: a prominent colored badge, thresholds configurable in Settings.
3. **Transcript**: collapsed by default, openable.
4. **Customer surface**: BOTH the customer detail page and the pipeline lead card.
5. **Pipeline card**: score chip only, nothing else.
6. **Estimate surface**: the estimate detail page in the dashboard. Not the estimator app, not the estimates list.
7. **How many**: all recordings on the customer card, the most recent one on the estimate card.
8. **RLS**: widen `pec_salesask_recordings` read from `is_admin_staff()` to **any signed-in staff**, so reps see their own visit feedback.
9. **Migration**: apply `2026-07-31_salesask_integration.sql` to prod as step one of this prompt, then build on top.
10. **Sync**: full go-live. The env vars and webhook registration are a Cowork handoff; the `salesask_sync_enabled` flip happens after Cowork confirms them, not blind in this session.
11. **Modal fix**: applies to **every modal, both roots**, not just the email log.

Two items Dylan delegated to Cowork's judgment; these are Cowork's calls, override them if you disagree with the reasoning and say so in the log entry:

12. **Empty state**: hide the card entirely on the estimate page and the pipeline card when there is no recording. Keep the existing explainer on customer detail (it is the one place where "this feature exists and is waiting for data" is useful). Exception on the estimate page: if the estimate's lead HAS an appointment but no recording came back, render a single quiet line saying so, because "the rep did not record" is a management signal and a blank space is not.
13. **Escape key**: do NOT make Escape global. See Part E.

---

## Part 0: apply the migration, verify it, regenerate SCHEMA.md

1. Apply `supabase/migrations/2026-07-31_salesask_integration.sql` to prod via the Supabase MCP `apply_migration`. It is written idempotent (`create table if not exists`, `add column if not exists`, insert-only settings seeds), so it is safe as written. Do not edit it; a fresh-database replay must still produce the original shape.

2. Write a NEW migration `supabase/migrations/2026-08-11_prompt71_salesask_read_all_staff.sql` that replaces the read policy:

   ```sql
   drop policy if exists pec_salesask_recordings_read on public.pec_salesask_recordings;
   ```

   and creates an all-staff read policy. **Copy the predicate from an existing all-staff read policy in this database rather than inventing one** (check what `pec_call_log` or `pec_email_log` use for their staff-read policy and match it exactly). Header, per standing rule 13:

   ```sql
   -- @artifacts
   --   none: replaces an RLS policy on public.pec_salesask_recordings; policy changes are not expressible in the four artifact kinds
   -- @end
   ```

   Also append ` (superseded-by: 2026-08-11_prompt71_salesask_read_all_staff.sql)` to nothing in the 2026-07-31 header, because that header declares no policy line. Leave it untouched.

3. Verify by live re-query, not by assuming the apply worked: the table exists, the three columns exist, the three `salesask_*` settings rows exist, and the new policy is the only select policy on the table. Record the before and after `settings` row count in the log entry.

4. Regenerate `SCHEMA.md` (standing rule 9) and update the SalesAsk entry in `features.json`.

5. `salesask_sync_enabled` stays `'false'` at the end of this prompt. Flipping it before `SALESASK_API_KEY` exists in Netlify makes the 15-minute cron fail every run. The flip is in the Cowork handoff.

## Part A: make the linkage real

Without this, Parts B, C and D render nothing. Four sub-parts, in dependency order.

**A1. Write the customer back to the lead and its appointments when a customer is created or matched.**

`netlify/functions/pec-public-estimate.cjs` resolves or creates the customer row on accept (the find-by-`customer_id`, find-by-email, find-by-name, then `POST /customers` ladder around lines 853-905). After `customerId` is settled there, and only when the estimate carries a `lead_id`:

- `PATCH /leads?id=eq.<lead_id>&customer_id=is.null` setting `customer_id`.
- `PATCH /pec_appointments?lead_id=eq.<lead_id>&customer_id=is.null` setting `customer_id`.

Both are fill-if-blank by the filter itself, so a re-run or a repeat accept cannot overwrite a corrected link. Both are best-effort: a failure here must NOT fail the accept. The accept path is the one flow in this app where a thrown error costs a real signed job. Wrap, log, continue.

**A2. Set the appointment's customer at intake when the lead already has one.**

`netlify/functions/pec-appt-intake.cjs` uses `_pec-lead-match.cjs`, which already selects `customer_id` on the matched lead (`_pec-lead-match.cjs:42`). When the matched lead has a non-null `customer_id`, carry it onto the `pec_appointments` insert. This is a one-line change and it is why the match helper selects that column.

**A3. One-time backfill, as its own data-only migration** `supabase/migrations/2026-08-12_prompt71_lead_customer_backfill.sql`:

Match `leads` to `customers` in this precedence, most reliable first, stopping at the first hit per lead:
1. exact email, case-insensitive, both non-null and non-empty
2. exact phone after normalizing to digits only, last 10 digits compared
3. exact `name` match AND `customers.company = 'prescott-epoxy'`

Then propagate to `pec_appointments.customer_id` where it is null and the appointment's lead now has one.

Guardrails on the backfill: never match on name alone when both rows have phones and the phones differ. Never write over a non-null `customer_id`. `@artifacts` header is `none: data-only backfill`. Report the row counts changed (leads updated, appointments updated) in the log entry, actual numbers from the run, not the SQL's intent. Expect a small number, possibly zero: there are 15 leads and 91 customers and the two sets barely overlap yet.

**A4. The read path must not depend on A1-A3 having found everything.**

Every SalesAsk read in Parts B, C and D resolves recordings by customer through TWO keys, not one:

1. `pec_salesask_recordings.customer_id = <customer id>`
2. OR `pec_salesask_recordings.lead_id IN (<that customer's lead ids>)`

Do this as two steps (select the customer's lead ids, then one `.or()` or two queries merged and de-duped by `id`), not as an OR across a PostgREST embed. Order the merged set by `occurred_at desc nulls last`. This is what makes the card work for a customer whose lead link was never written.

Reminder from the project instructions: supabase-js returns an empty-looking response for a nonexistent column WITHOUT throwing. Check `res.error` explicitly on every one of these reads before concluding "no recordings".

## Part B: customer detail card

Upgrade the existing `salesAskRowHtml` / `mountCustomerSalesAsk` (`index.html:21829-21890`). Do not write a second renderer; the estimate card in Part D reuses this one.

**B1. Score badge.** Today the score is `process 7/9` inside a grey meta line (`salesAskRowHtml`, the `score` const). Promote it: a pill at the top of the card showing the percentage and the raw fraction, e.g. `78% · 7 of 9 steps`. Color from the new settings thresholds (Part F): at or above green threshold = green, at or above amber = amber, below = red. Neutral grey when `process_total` is null or zero, never a divide-by-zero and never a 0% for missing data. Verify contrast in BOTH themes; the dashboard has a light default and a dark mode and saturated pills routinely fail one of them.

**B2. Coaching and tags.** Both are `jsonb` and **no row has ever been written, so their real shape is unverified.** Render defensively and do not guess a shape into the DOM:

- array of strings, render as bullets through the existing `qoBulletsHtml`
- array of objects, use `text` / `title` / `label` / `note` in that order, skip entries with none
- object with string values, render `key: value` rows with the key title-cased
- anything else, render nothing for that field rather than `[object Object]`

Put coaching under its own "Coaching" heading below action items, tags as small chips under the meta line. If the payload turns out to carry something richer once a real recording lands, that is a follow-up prompt, not a guess now.

**B3. Transcript.** The transcript `<details>` already exists but its `<summary>` is EMPTY with only an `aria-label` (`salesAskRowHtml`, the `transcriptHtml` const). That is almost certainly why Dylan asked for a way to open the transcript: there is no visible label to click, only whatever the `.qo-tr` CSS draws. Give the summary a visible label, "Full transcript", with a chevron, keeping it collapsed by default and keeping the existing `aria-label` behavior intact.

**B4.** Keep all recordings on this card, newest first, limit 25 as today. Swap the query for the Part A4 two-key resolution.

## Part C: pipeline lead card

`leadCardHtml` (`index.html:26338`), rendered by `renderLeads` from `loadLeadsData`.

Score chip only: one small pill, same color logic as B1, reading `SalesAsk 78%`. Nothing else. No summary text, no icon-only variant, no separate click target.

**The chip is display-only.** The lead card is already a click target and the board supports drag-to-move-stage (`moveLeadStage`). A nested clickable element inside a draggable card is a reliable source of "the card jumped when I clicked" bugs, and the lead detail view already carries the recording on its timeline via `leadEventHtml`. If Dylan wants the chip itself clickable later, that is a deliberate follow-up with drag testing attached.

**Load the scores in ONE batched query inside `loadLeadsData`**, keyed by the lead ids already in hand, then attach to each lead object. A per-card query on a kanban with dozens of cards is a hard no. Show the chip only when a recording exists for that lead; no chip and no placeholder otherwise.

## Part D: estimate detail card

`renderEstimateDetail` (`index.html:28031`).

**Resolution order** for "the recording for this estimate":
1. `estimate.lead_id` is set, take the most recent recording with that `lead_id`
2. else `estimate.customer_id` is set, use the Part A4 two-key resolution and take the most recent
3. else nothing

Most recent by `occurred_at desc nulls last`, falling back to `created_at`.

**Render** the same `salesAskRowHtml` block as Part B, so the two surfaces cannot drift, with the score badge, coaching, action items, the SalesAsk link and the collapsed transcript. Place it directly ABOVE the Pricing intelligence card from prompt 70. What the customer asked for in the room is context for how the estimate got priced, and it belongs next to it.

**When there is no recording**: hide the card, with the one exception in locked decision 12. Cheap query for that exception: does an appointment exist on this estimate's `lead_id` with `start_at` in the past. If yes, render one line, muted, "On-site visit Aug 4, no SalesAsk recording captured." Do not render that line for a future appointment.

**Do not add a column to `estimates`.** The relational path is the design (see the header comment in `2026-07-31_salesask_integration.sql`) and prompt 70's `pricing_snapshot` work already proved the estimate row is crowded enough.

## Part E: modal close affordance, both roots

**Diagnose before you change anything.** The obvious reading of "the box is too long" is wrong, and CLAUDE.md's bug workflow says prove the cause first:

- `.pec-modal` ALREADY has `max-height:92vh; overflow-y:auto` (`index.html:632`). The modal is not taller than the viewport; its content scrolls.
- The email log body is a sandboxed 480px `<iframe>` (`openEmailLogDetail`, `index.html:22246-22252`). **A wheel event over an iframe is consumed by the iframe**, so scrolling with the pointer where it naturally lands does nothing to the modal, and the bottom Close button never comes into view. That is the real mechanism.
- `openModal`'s backdrop-click guard (`index.html:8196`) explicitly checks for `iframe` in the modal, so click-outside is disabled here BY DESIGN (the comment names the estimator case).
- Escape is off because this modal is not opened with `dismissible: true`.

Three independent reasons the modal feels stuck. Confirm the iframe-scroll one in DevTools (scroll with the pointer over the meta table versus over the iframe) before writing code, and say in the log entry what you observed.

**E1. Sticky close header, applied globally.** The markup already exists: `.pec-modal-xhead` and `.pec-modal-xclose` (`index.html:640-642`), used by the estimator modal. Make `openModal` render that header by default, with the modal's title if the caller passes one, and a `✕` on the right. Make it `position: sticky` at the top of the scrolling `.pec-modal` with the modal background color and a z-index above the body, accounting for the container's 24px padding so no content slides underneath it.

Add an opt-out, `openModal(html, { closeButton: false })`, and **audit every existing `openModal` caller before shipping**: any modal that already renders its own `✕` or close control in its own header must either opt out or have its hand-rolled one removed. Two close buttons stacked is a worse bug than the one being fixed. Grep for `pec-modal-xclose` and for close glyphs inside modal template strings.

Keep the existing bottom Close/Cancel buttons. They are muscle memory and they cost nothing.

**E2. `#prodModalRoot`, the second root** (CLAUDE.md architecture gotcha: two roots, shared CSS, no shared JS). These are hand-rolled `innerHTML` assignments, each with its own closer. Give each the same sticky header wired to its existing close function. Current sites, verify each by grep since line numbers drift:

`index.html:38757`, `38844` (closer at `38918`), the job detail at `39511` (closer `closeJobDetail` at `39505`), `39773` (closer `39797`), `39992` (closer `40051`), `40445` (closer `40491`), `40542` (closer `40585`).

A shared helper that returns the header HTML plus a wire-up function is fine and preferable to seven copies, as long as it does not drag `#prodModalRoot` into `openModal`'s lifecycle. Do not migrate these modals to `openModal`; that is a much larger change and not what was asked.

**E3. Escape stays scoped, not global.** `dismissible: true` keeps owning Escape and backdrop-click. The comments at `openModal` document why: a stray Escape over a half-typed change order is silent data loss, and prompt 63 Part D already litigated this. What DOES change: pass `dismissible: true` to the email log modal specifically, since it is read-only, which also restores click-outside for it. If Dylan wants Escape everywhere later, that is a separate decision with its own testing, and it should be argued on its merits rather than smuggled in here.

**E4. Height.** Do not shrink the 480px iframe. It is already the right size for reading an email and the scroll problem is not a height problem. Once the sticky ✕ is there, the height is irrelevant.

## Part F: settings (standing rule 12)

`renderSettingsAppointments` already has the SalesAsk card (master toggle, push window, lookback, per-member `salesask_email`). Add to it:

- `salesask_score_green_pct`, default `90`
- `salesask_score_amber_pct`, default `70`

Seed insert-only in the Part 0 policy migration or a sibling, with `@artifacts` `setting:` lines for both. Validate green > amber in the UI and refuse to save an inverted pair rather than silently rendering everything red.

## Part G: What's New (standing rule 11)

One entry in `help/whats-new.json`, newest first. User-facing: sales visit insights now appear on the customer, the pipeline and the estimate, and every popup has a close X in the corner. Plain language, 2-3 how-to steps, **no em dashes**.

## Guardrails

- Do not touch prompt 70's pricing intelligence code, `buildComps`, `ai-lines.cjs`, or `pricing_snapshot`.
- Do not touch `apps/estimator` or the built `estimator/` output. Dylan explicitly scoped the estimator out.
- `pec_salesask_recordings` stays service-role write. This prompt widens READ only.
- No per-card, per-row, or per-render queries on the pipeline board.
- Do not change `pec-salesask-sync.cjs` or `pec-webhook-salesask.cjs` behavior. They are correct; they have simply never had a schema to write into.
- The accept flow in `pec-public-estimate.cjs` must not gain a new way to throw. Best-effort patches only.
- `npm test` green before you commit. Baseline is 783 checks, 0 failed (prompt 70).
- Commit per standing rule 1, log per rules 2 and 5.

## Verification, in this order

1. Migration applied, re-queried live, `SCHEMA.md` regenerated and containing `pec_salesask_recordings`.
2. `pec-migration-drift` run clean against the new `@artifacts` headers.
3. Seed ONE fake `pec_salesask_recordings` row against a real lead that has both an estimate and an appointment, with a summary, action items, a coaching payload, tags, `process_followed`/`process_total`, and a two-turn transcript. Confirm all three surfaces render it: customer detail, pipeline chip, estimate card. **Then delete it and re-query to zero**, the way the 2026-08-04 BusyBusy entry did it. State the before and after counts in the log.
4. Score badge and chip checked in BOTH light and dark mode, at desktop and phone widths.
5. Sign in as a non-admin staff user, or confirm by policy inspection if no test account exists, that the widened read actually returns rows. A policy that still evaluates `is_admin_staff()` is the likeliest way this silently ships broken.
6. Modal sweep: open every modal in both roots and confirm exactly one ✕, correct sticky behavior when the content scrolls, and no double close control. The email log modal specifically: ✕ closes it, click-outside closes it, Escape closes it, and the bottom Close still works.
7. Confirm a data-entry modal (change order, payment) still survives Escape and a backdrop click without losing typed input.

## Handoff to Cowork

Write this as a `## Handoff to Cowork` section in the PROJECT-LOG entry, and print the standalone Cowork prompt in chat per the CLAUDE.md handoff format:

1. Set `SALESASK_API_KEY` and `SALESASK_WEBHOOK_SECRET` in Netlify for the production site, then **redeploy** (the 2026-08-04 BusyBusy entry proved env vars do not reach running functions without one).
2. Register the webhook in SalesAsk pointing at `https://prescottepoxy.netlify.app/api/salesask/webhook?secret=<the secret>`.
3. Fill `salesask_email` for each rep in `pec_sales_team_members` from their SalesAsk login.
4. Only then flip `salesask_sync_enabled` to `true` in Settings, wait one cron cycle (15 min), and confirm an upcoming appointment appears in SalesAsk as a scheduled task with `event_id` equal to our appointment id.
5. Report back the first real recording's `coaching` and `tags` payload shape, since Part B renders those defensively against an unverified shape.
