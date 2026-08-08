# Claude Code prompt 77: backlog clearance

Three stranded migrations, prompt 76's missing record, the sqft clobber survivors, catalog integrity, and SalesAsk go-live.

---

## Read before you touch anything

1. `CLAUDE.md` (all standing rules apply, especially 1, 2, 9, 11, 12, 13).
2. The top 3 entries of `PROJECT-LOG.md`. The newest is Cowork's 2026-08-08 open-loop sweep. **This prompt executes that audit.** Its findings are the spec.
3. `claude-code-prompt-71-salesask-surfaces-modal-close.md` **in full, all 245 lines**. Part C below is that file unchanged. Do not re-scope it, do not re-derive its decisions, do not re-verify what it already verified. Read it and build it.

Do NOT read `index.html` or `PROJECT-LOG.md` end to end. Use `features.json` anchors and grep.

---

## Why this prompt exists

Five separate sessions each ended with a handoff, and nothing consumed the handoffs. Prompt 71's migration has been pending since 2026-08-05. Prompt 75's has been pending since 2026-08-07 with its code already deployed. Prompt 76 shipped to production on 2026-08-07 at 05:58 MST with no PROJECT-LOG entry and no What's New entry at all. This session closes every one of them in dependency order.

The failure mode is worth naming, because Part 0 is designed around it: **a session hits a permission wall on prod DDL, writes a handoff, and continues.** The handoff then dies in the log. Part 0's stop rule exists so that cannot happen a fourth time.

---

## What Cowork verified live (2026-08-08, prod `zdfpzmmrgotynrwkeakd`, Supabase MCP, read-only)

Trust these numbers. They were queried, not inferred from `features.json` or `SCHEMA.md`.

**Migrations, all three unapplied:**

- `2026-07-31_salesask_integration.sql` (prompt 71): zero tables matching `%salesask%` exist. The feature is dead in prod while `features.json` describes it as shipped and `index.html` renders its card.
- `2026-08-14_prompt75_notification_targeting.sql`: `pec_notifications.target_user_id` does not exist; `estimate_view_slack_enabled`, `estimate_hot_min_views`, `estimate_hot_window_hours` do not exist in `settings`.
- `2026-08-15_prompt76_line_editor_settings.sql`: `estimate_line_generate_enabled` and `estimator_line_sheet_breakpoint_px` do not exist in `settings`.

**A documentation trap.** The prompt 75 migration file's own header comment reads "Applied to PROD (zdfpzmmrgotynrwkeakd) via MCP from the prompt 75 session." **That is false.** The PROJECT-LOG entry is the honest record (permission mode blocked the DDL write). Fix the comment as part of 0.2 so the next reader is not misled.

**Prompt 76 is live and undocumented.** Pushed to `origin/main` 2026-08-07 05:58 MST, five commits:

```
72704ad  scope writer: clear the exact sqft clobber fingerprint on templateless lines, tag skip reasons with area_id + needs_rep_text (prompt 76 Part B)
81c4bf7  estimator: line list collapses to a tappable table with a bottom-sheet line editor; per-line editable descriptions; one context-branching Generate button (prompt 76 Parts A, C, D1, E1-E2)
1daa49b  estimates: whole-document Scope card deleted from the detail page, Regenerate + stale/BLANK banners move to Line items; send-gate blockers become tappable links that open the offending line's sheet (prompt 76 Parts D2-D3, F)
cdbf432  catalog + settings: templateless and recipeless system-type warnings, Line editor settings card, prompt 76 settings migration
62a0e9d  estimates: the send gate re-reads line items, areas, and scope_stale fresh instead of trusting the page's in-memory snapshot (prompt 76 Part F follow-through)
```

There is no `claude-code-prompt-76-*.md` on disk. Cowork delivered prompt 76 in chat only. The commits and their diffs are the only surviving spec.

**The sqft clobber survivors.** Seven `estimate_line_items` rows still match `^\s*\d+\s*sq\s*ft`, plus one `job_areas` row. Full list, with the fact that decides what can be done to each:

| line_id | est | status | deleted | description | system | template? |
|---|---|---|---|---|---|---|
| `46fd03f2-7800-483d-af4c-2e7e1bc0a286` | 102038 | draft | no | `1100 sqft` | Standard Flake | **yes** |
| `6fe72c33-3ca5-4b3e-9428-f8f71c4298a3` | 102064 | **sent** | no | `1430 sqft` | Standard Flake | **yes** |
| `e8c01acd-9a0f-40cb-9aa7-d86eae75acfd` | 102033 | draft | no | `500 sqft` | Polydeck System | **NO** |
| `4f86a1fc-fee8-471e-a4fe-829e4a29a5ea` | 102046 | **accepted** | no | `50 sqft` | Custom System | **NO** |
| `910ef34c-b62f-c98f-4001-44a83e33f0ab` | 102026 | draft | yes | `1000 sqft` | Standard Flake | yes |
| `4e2aa5d6-7d38-41fa-9abb-ba841ae4239d` | (none) | draft | yes | `1000 sqft` | Standard Flake | yes |
| `2330506e-1d42-4327-9691-2d0a54695f8d` | 102035 | accepted | yes | `1100 sqft` | Standard Flake | yes |

The `job_areas` row: `8f5d0ce4-7639-4531-a298-dc12fa29c998`, job `07ffeba7-6b11-5bee-88c4-55dbb500ef37` (Lynette Williams, status `signed`), area "Garage Skirt", 50 sqft, **system Custom System, templateless**.

**The finding that reshapes Part A.** Dylan chose "backfill everything fixable." Only **two** of the four live rows are actually fixable by regeneration (102038 and 102064, both Standard Flake). EST-102033, EST-102046, and Lynette's job area all sit on templateless systems, so `pec-estimate-scope.cjs` skips them by construction and regeneration writes nothing. Since prompt 76's Part B, the writer now *clears* the fingerprint on a templateless line instead of leaving it, which turns "500 sqft" into an empty description that the rep must fill. That is correct behavior and it is also a customer-visible change on an accepted job, so Part A treats those three separately and deliberately.

Note the label format on all of these: `Standard Flake floor coating system`, not `Area: System`. These are pre-per-line-pricing vintage estimates with one line covering the whole estimate. Any join you write from `estimate_line_items.label` back to `estimate_areas.name` will return null. Key off `estimate_id` plus `sort_order`.

**Catalog integrity:**

- `Polydeck System` is `active = true` with **zero** rows in `pec_prod_recipe_slots`. Anything estimated on it prices with no material cost and lands with broken GP.
- Six system types have `scope_template IS NULL`: Metallic, Grind and Seal - Urethane, Flake, Custom System, MVB Only, Polydeck System.
- `Grind and Seal` (active, 723 chars) opens with `Scope of work for grind, stain, and seal garage floor` and its body contains no stain step. `Grind Stain and Seal` now exists as its own system with its own 2,144-char template (seeded by Cowork 2026-08-07, still `active = false` pending a recipe).
- `pec_brand_identity` has exactly **one** row, `brand = 'prescott-epoxy'`. There is no `finishing-touch` row, so every FTP estimate and invoice renders with PEC's name, address, license, colors, and terms. PK is `brand`; there is no CHECK constraint on it. NOT NULL columns: `brand`, `primary_color`, `accent_color`, `business_name`, `address_line`, `card_surcharge_pct`.
- PEC's `estimate_terms_text` IS written (starts `## Scope of Work and Pricing`). That handoff item is closed; do not re-open it.

**Still empty, not this session's job:** `routemize_booking_url`. See the Cowork handoff at the bottom.

---

## Locked decisions (Dylan, 2026-08-08)

1. One prompt, phased. Parts run in order; Part 0 gates everything.
2. Polydeck: **build the recipe and keep it active**, but Dylan supplies the spec. Part B2 is a BLOCKED task, not a guess.
3. Templates: draft **Metallic and MVB Only only**, to a file, for approval. Do not write templates to the database. Custom System stays templateless by design.
4. EST-102064 (Susan Nasser, sent): **fix live, send no email.** Same pattern Cowork used for Merlin on 2026-08-07.
5. Clobber cleanup: **backfill everything fixable**, which the data says is two rows. The three templateless ones get the explicit treatment in A2.
6. `Grind and Seal`: **fix the title, drop "stain."** Do not add a stain step to the body.
7. FTP: **seed the brand row, leave `estimate_terms_text` NULL** so the terms card does not render until Dylan writes it.
8. SalesAsk: **build prompt 71 exactly as scoped**, all three surfaces plus the modal close X.
9. Migrations: **Claude Code applies them via Supabase MCP.** If blocked, STOP (see 0.6).
10. Prompt 76 docs: **Claude Code reconstructs them from the five commit diffs.**
11. Prompt 73 leftovers travel with this build as a ready-to-paste Cowork handoff.
12. Verification: full live E2E, per the repo's established standard.

---

## Part 0: migrations and documentation debt

**Nothing else in this prompt is valid until Part 0 lands.** Prompt 71's Part 0 is subsumed here; do not run it twice.

**0.1 Apply three migrations via Supabase MCP `apply_migration`, in this order:**

```
supabase/migrations/2026-07-31_salesask_integration.sql
supabase/migrations/2026-08-14_prompt75_notification_targeting.sql
supabase/migrations/2026-08-15_prompt76_line_editor_settings.sql
```

All three are additive and idempotent. Verify each with the verification query in its own footer, plus:

```sql
select
 (select count(*) from information_schema.tables  where table_name like '%salesask%') as salesask_tables,
 (select count(*) from information_schema.columns where table_name='pec_notifications' and column_name='target_user_id') as p75_col,
 (select count(*) from settings where key in (
   'estimate_view_slack_enabled','estimate_hot_min_views','estimate_hot_window_hours',
   'estimate_line_generate_enabled','estimator_line_sheet_breakpoint_px')) as new_settings;
```

Expected after: `salesask_tables` > 0, `p75_col` = 1, `new_settings` = 5.

**0.2** Correct the false "Applied to PROD" claim in `2026-08-14_prompt75_notification_targeting.sql`'s header comment. Replace it with the truth: authored in the prompt 75 session, applied in the prompt 77 session on 2026-08-08. Do not touch the `@artifacts` block.

**0.3** Regenerate `SCHEMA.md` per the standing process and regenerate `netlify/functions/_migration-manifest.json`. Confirm the Schema Drift panel goes clean for all three migrations.

**0.4** Write prompt 76's missing `PROJECT-LOG.md` entry. Reconstruct it from the five commit diffs listed above (`git show <sha>` each). Date it 2026-08-07, `By: Claude Code`, and open it with a one-line note that it is a **late entry written in the prompt 77 session**, so the out-of-order date is not mistaken for a mistake. Per standing rule 3 this is a new entry, not an edit to an existing one. Insert it in date order, below the 2026-08-08 sweep and above the prompt 75 entry. Cover at minimum: the bottom-sheet line editor and its breakpoint, per-line editable descriptions and the rep-edit-wins rule, the fingerprint-clearing change to the scope writer and its `needs_rep_text` tag, deletion of the whole-document Scope card, the send gate's fresh re-read, and the catalog warnings.

**0.5** Append prompt 76's What's New entry to `help/whats-new.json` (standing rule 11): the editable per-line description and the tappable line editor are the user-visible change. Plain language, 2 to 3 how-to steps, **no em dashes**.

**0.6 STOP RULE.** If any `apply_migration` call is refused by permission mode: **stop the session.** Do not proceed to Parts A through D. Do not write a PROJECT-LOG handoff and continue, because that is exactly the failure this prompt exists to clean up. Print a self-contained Cowork prompt in chat, in the CLAUDE.md handoff format, naming the three files and their verification queries, and end the session there.

---

## Part A: the sqft clobber survivors

**A0.** Before writing anything, confirm from the prompt 76 diffs (`72704ad`) what the scope writer now does with a templateless line carrying the fingerprint. A2 depends on it. If it already clears on regenerate, A2 is about what fills the gap, not about the clearing.

**A1. The two regenerable rows.** For EST-102038 (draft) and EST-102064 (sent, Susan Nasser), run the existing scope generation path (`pec-estimate-scope.cjs`), the same one the Regenerate button calls. Do not hand-write scope text and do not construct the description in SQL.

- **EST-102064 is customer-facing and already sent. Send no email.** Rewrite the description, then load the public estimate URL and confirm the scope renders. Report the URL and the before/after character counts in the log entry.
- EST-102038 is a draft and would have self-healed on next open; regenerate it anyway so the fingerprint count reaches zero for live regenerable rows.
- Do not touch `estimates.scope_stale` semantics or trip the send gate on either.

**A2. The three that cannot be regenerated.** EST-102033 (Polydeck, draft), EST-102046 (Custom System, accepted, Lynette Williams), and job area `8f5d0ce4` (Lynette's "Garage Skirt", Custom System, job `signed`).

Regeneration writes nothing for these because the system has no template. Do this instead:

- **Do not** leave `500 sqft` / `50 sqft` sitting in a customer-facing or crew-facing field. A square-footage string is not a scope of work.
- For EST-102033 (draft): clear the description to NULL. The rep types it in prompt 76's line editor next time the estimate is opened, and the send gate blocks it from going out empty. This is the designed path.
- For EST-102046 and job area `8f5d0ce4` (Lynette, accepted and signed): the crew work order currently reads `50 sqft` for a 50 sqft garage skirt. Clearing it to NULL leaves a crew with a blank scope, which is worse than a wrong one. **Write a short, accurate, plain-language scope for a 50 sqft garage skirt from the existing area data (`job_areas.name`, `sqft`, the job's other areas, and any `notes`), in house voice, no em dashes, and print the exact text in chat before writing it.** If the area data does not support writing anything truthful, clear to NULL and say so explicitly rather than inventing work.
- Keep `estimate_line_items` and `job_areas` in sync for Lynette: whatever the line says, the job area says.

**A3. The three soft-deleted rows** (102026, 102035, and the null-numbered draft): leave them alone. Report them in the log entry as knowingly skipped.

**A4.** After A1 and A2, re-run the fingerprint query on both tables and report the counts. Live non-deleted rows should be zero.

---

## Part B: catalog integrity

**B1. `Grind and Seal` title.** Change the template's first line from `Scope of work for grind, stain, and seal garage floor` to `Scope of work for grind and seal garage floor`. **First line only.** Do not touch the remaining 723 characters, and do not add a stain step. `Grind Stain and Seal` is now its own system and carries the stain language. This template is live on real estimates, so re-query and print the new first line to confirm the edit landed exactly.

**B2. Polydeck System recipe. BLOCKED TASK, do not guess.**

`Polydeck System` is active with zero recipe slots. Dylan's decision is to build the recipe and keep it active, and he supplies the spec. He has not supplied it yet.

Do this and only this:

1. Query and print what already exists: every `pec_prod_products` row plausibly belonging to a Polydeck system, and the full `pec_prod_recipe_slots` shape of one working system (Standard Flake) so Dylan can see what a complete recipe looks like.
2. Print, in chat, the exact list of values you need from him: per slot, the product, the `material_type`, the coverage or spread rate, the unit, and whether the slot is required.
3. **Do not** write recipe slots. **Do not** deactivate Polydeck. **Do not** copy Standard Flake's rates as a placeholder, because a wrong coverage rate produces a confidently wrong GP, which is worse than an obviously missing one.
4. Recall the standing landmine (memory: "Check recipe slots before activating a system", and `material_type` is CHECK-constrained across three tables). If the spec Dylan gives back introduces a new `material_type`, that needs a migration extending the CHECK, not an insert.
5. Report in chat and in the log entry whether any live estimate or job already used Polydeck, so Dylan knows the exposure while the recipe is pending. EST-102033 is one such draft.

**B3. Draft two scope templates for approval.** Write `dripjobs-scope-templates.md`-style drafts for **Metallic** and **MVB Only** into a NEW file, `docs/draft-scope-templates-metallic-mvb.md`. House voice, no em dashes, structured like the `Grind Stain and Seal` template that Cowork wrote (surface prep, system build, finish, exclusions). **Do not write either one to `pec_prod_system_types`.** Dylan approves first. The other four templateless systems are out of scope: Custom System is templateless by design, Flake and Grind and Seal - Urethane are inactive, and Polydeck is gated on B2.

**B4. Seed the FTP brand row.**

```sql
insert into public.pec_brand_identity (brand, business_name, address_line, phone, website, primary_color, accent_color)
values ('finishing-touch', 'Finishing Touch Painting', '<PEC address, shared shop>', '<PEC phone>', null, '<FTP primary>', '<FTP accent>')
on conflict (brand) do nothing;
```

Rules for the values:

- `brand` is exactly `finishing-touch`. That token is what `pec-public-estimate.cjs:880`, `pec-send-sms.cjs:41`, `mcp.cjs:357` and 20 sites in `index.html` already use. Do not invent `ftp`.
- `business_name` is `Finishing Touch Painting` (matches `index.html:37428`).
- `address_line` and `phone`: reuse PEC's, same shop and same phone tree, unless you find FTP-specific values in the codebase.
- `primary_color` / `accent_color`: pull from the existing `brand-ftp` CSS class in `index.html` (see `document.body.classList.toggle('brand-ftp', ...)` near :37429). If no FTP palette exists there, use the column defaults and flag it.
- `license_number`: leave NULL. PEC's `ROC353243` is an epoxy license and must not appear on painting paperwork.
- `estimate_terms_text`: leave NULL, per decision 7. The terms card renders nothing when empty, which is the intent.
- Everything you could not source, list in the Handoff to Dylan section so he fills it in Settings > Brand.

Then verify: load an FTP-company estimate (or temporarily point a test one at `finishing-touch`) and confirm the public page picks up the new row instead of falling through to PEC. Clean up any test row.

---

## Part C: prompt 71, SalesAsk surfaces and modal close

Build `claude-code-prompt-71-salesask-surfaces-modal-close.md` in full: Part A (linkage), Part B (customer detail card), Part C (pipeline lead card, score chip only), Part D (estimate detail card), Part E (modal close affordance, **both** roots), Part F (settings), Part G (What's New).

Its Part 0 is already done by this prompt's Part 0. Skip it.

Two things from that file to hold onto, because they are the ones that break builds:

- **Every `customer_id` join on the appointment / estimate / recording path is null in prod.** As of 2026-08-05: appointments 11 rows (8 with `lead_id`, 0 with `customer_id`), estimates 11 (7 with `lead_id`, 0 with `customer_id`), leads 15 (0 with `customer_id`). `lead_id` is the only populated join. Any read keyed on `customer_id` returns empty. Re-query these counts before building Part A, since prompts 74 through 76 have run since and may have changed them.
- **The email log modal is not too tall.** `.pec-modal` already has `max-height:92vh` + `overflow-y:auto`. Three separate causes: the 480px sandboxed iframe eats the wheel event, `openModal`'s backdrop guard disables click-outside whenever an iframe is present (deliberate, for the estimator), and Escape is off for non-dismissible modals. **A global Escape-to-close is the wrong fix**; prompt 63 Part D established that data-entry modals must not die to a stray Escape. The sticky close X is the fix.

Architecture gotcha that Part E lives on top of: there are **two** modal roots, `#pecModalRoot` (:1781, the `openModal`/`closeModal` helpers) and `#prodModalRoot` (:1782, hand-rolled inline flows in production and catalog views). They share CSS and no JS. Part E must land in both, or you must justify skipping one explicitly.

---

## Part D: housekeeping

- `features.json`: amend the SalesAsk entry (it currently claims shipped while the tables did not exist), the estimate scope entries touched in Part A, and the catalog entry if B1 or B4 change behavior. Add nothing for Part 0.
- `help/whats-new.json`: prompt 76's entry (0.5) plus prompt 71's entry (its Part G). Two entries, both plain language, **no em dashes**. Parts 0, A, B2 and B3 are internal and get none. B4 is arguably user-visible for FTP; use judgment and say which way you went.
- Commit after every meaningful change, `<area>: <what changed>` format.
- One PROJECT-LOG entry for this session on top, plus the late prompt 76 entry from 0.4. Two entries total.

---

## Guardrails

- **Never commit secrets.** If anything needs a credential, placeholder plus a handoff line.
- **No em dashes** in scope text, templates, What's New, or anything a customer or crew reads. Em dashes are fine in code, comments, and PROJECT-LOG entries.
- **Send no email or SMS to any customer.** Not for Susan Nasser, not for Lynette, not for a test. If a code path you exercise would send, disable it first and restore it after, and log both.
- **Verify every column name against `SCHEMA.md`** before writing SQL, and remember that supabase-js returns an empty response for a nonexistent column without throwing. Check `res.error` before suspecting RLS.
- Do not deactivate `Polydeck System` and do not write its recipe. B2 is blocked on Dylan by his own decision.
- Do not write Metallic or MVB Only templates to the database. B3 is a file.
- Do not touch soft-deleted rows.
- Do not rewrite `estimates.scope_of_work` on any sent or accepted estimate. It is internal-only since prompt 74 but it still feeds `jobScope`, the crew scope, and the prompt 72 declined filter.
- If any live write touches a customer-facing or crew-facing string, **print the exact before and after text in chat** before writing it.

---

## Verification, in this order

1. All three migrations applied, verified by the combined query in 0.1. Schema Drift panel clean.
2. `SCHEMA.md` and `_migration-manifest.json` regenerated.
3. Both PROJECT-LOG entries present, prompt 76's What's New present.
4. Fingerprint query returns zero live non-deleted rows in `estimate_line_items` and `job_areas`.
5. EST-102064's public page renders real scope. URL and character counts reported. No email sent.
6. Lynette's job: line item and job area agree, and the crew work order renders something a crew can actually work from.
7. `Grind and Seal` first line re-queried and printed. Body length still 723 minus the seven characters removed.
8. FTP brand row exists; an FTP-branded estimate renders FTP's name, not PEC's; no PEC license number on it. Test data cleaned to zero residue.
9. `docs/draft-scope-templates-metallic-mvb.md` exists; `pec_prod_system_types` template count unchanged except for B1's edit.
10. `npm test` green. Every inline script block in `index.html` parses (`node --check` per block).
11. Prompt 71's own verification section, run in full.
12. Baseline row counts captured before and after any live E2E, all matching.

---

## Handoff to Cowork (print this in chat as a fenced block at the end of the session)

These three cannot be done from a code session and have been open since prompt 73 shipped on 2026-08-06.

```
## Context
Prompt 77 cleared the code and migration backlog on the TopCoat CRM
(repo: /Users/dylannordby/Claude-Code/HQ-Dashboard, deploy:
https://prescottepoxy.netlify.app, Supabase prod: zdfpzmmrgotynrwkeakd).
Three items from prompt 73 (shipped 2026-08-06) require actions outside a
code session and are still blocking the lead drip's day-0 instant touch
and its Slack alerting. Verified still open 2026-08-08: settings key
`routemize_booking_url` is an empty string in prod.

## Tasks
1. Create the leads Slack channel and its incoming webhook.
   - Where: the PEC Slack workspace. The existing office webhook posts to
     #epoxysales (channel C09AZE8CU0Z); leads need their own channel.
   - Acceptance: a test post lands in the new channel.
   - Do NOT reuse or modify the #epoxysales webhook.

2. Set SLACK_LEADS_WEBHOOK in Netlify and redeploy.
   - Where: Netlify site settings, environment variables, then trigger a
     deploy so the functions pick it up.
   - Acceptance: a new lead through the intake endpoint posts to the new
     channel. Confirm the #epoxysales estimate-view posts still work.
   - Do NOT put the webhook URL in any committed file.

3. Collect the Routemize booking URL from Dylan and set it.
   - Where: settings key `routemize_booking_url` (currently ''), via
     Settings in the dashboard, not a raw SQL write, so the UI path gets
     exercised.
   - Acceptance: the day-0 instant-touch drip email renders a working
     booking link. Send one test to an internal address only.
   - Do NOT send any test to a real lead.

Take them in order; task 2 needs task 1 live first.

## After
Append a PROJECT-LOG entry at the top with By: Cowork, capturing the new
channel name, whether the redeploy succeeded, the booking URL that was
set, and the result of the test drip send. Report back to Dylan whether
the day-0 instant touch is now fully live end to end.
```

---

## Handoff to Dylan (put this at the end of the PROJECT-LOG entry)

1. **Polydeck recipe spec.** Part B2 printed exactly what is needed. Until it lands, Polydeck is active with no material cost and EST-102033 is a live draft using it.
2. **Approve or edit `docs/draft-scope-templates-metallic-mvb.md`.** Nothing was written to the database.
3. **FTP brand row** is seeded with what the codebase knew. Fill the gaps in Settings > Brand: FTP's own license number, website, and terms and conditions text. Until the terms text exists, the terms card does not render on FTP estimates.
4. **Susan Nasser (EST-102064)** now has correct scope on the link she already holds. No new email went out. Someone should call her if the original conversation left her confused.
5. **Lynette Williams' work order** now reads whatever Part A2 wrote. Check that it matches what her crew actually did on the garage skirt.
