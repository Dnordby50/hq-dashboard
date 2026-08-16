# Claude Code Prompt 94: Scope templates replace Generate Scope, and the sold-on-site metric

## Context

Repo: `/Users/dylannordby/Claude-Code/HQ-Dashboard`. Base commit on `main`: **bd0f820**. Deploy: Netlify site `prescottepoxy`. Supabase project `zdfpzmmrgotynrwkeakd`.

Dylan gave nine requests on 2026-08-16, split into three prompts. **This is prompt 94 of 3.** Prompt 92 = mobile calendar / bell / payment notifications. Prompt 93 = estimate document package. Do not do their work here.

This prompt has the highest chance of breaking a working sales flow, because it removes a button Dylan uses daily and changes what lands in the customer-facing line description. Read the guardrails before you write code.

All anchors verified against the working tree at bd0f820 and live Supabase on 2026-08-16.

---

## Task A: Diagnose the mobile Generate Scope bug FIRST

Before building anything, diagnose this. Dylan, 2026-08-16:

> "I didn't see a pop-up on the mobile version today when I used it and I typed out a scope of work. When I pressed Generate Scope, it didn't take into account any of the scope that I already wrote and just put a blank template in there."

Two distinct failures in that sentence:

1. **No confirmation pop-up.** The dashboard requires `force: true` plus a confirm dialog to regenerate over a hand edit (index.html:31691-31694, comment: *"the server also refuses without force, so the UI cannot bypass the rule"*). If Dylan saw no dialog, either he was on the **estimator PWA** (which has its own per-line "Generate with AI" in `apps/estimator/src/lib/ai.ts` + `EstimatorScreen.tsx`, gated by setting `estimate_line_generate_enabled`) and that path has no equivalent guard, or `estimates.scope_edited_at` was never stamped for his typed text so the code did not consider it a human edit.
2. **A blank template landed.** "Blank template" strongly suggests a `scope_template` containing unfilled `BLANK` / `___` placeholders was inserted verbatim. The blank detector already exists (`estScopeBlanks`, index.html:31779-31798, mirroring `scopeBlanks` in `production/scope.cjs`: literal `\bBLANK\b` case-sensitive, unresolved `is/is not` choices, `_{3,}` runs) and the send gate (`estimateSendGateOk`, index.html:31799+) hard-blocks on them. So the blanks were caught later, not at insert.

**Before diagnosing anything else, check the live estimator bundle.** There is a known failure mode where the PWA precache serves stale JS for an entire session and one old bundle looks like two separate bugs. `curl` the live bundle at https://prescottepoxy.netlify.app and confirm the deployed hash matches the current build output. If it is stale, that is the answer to at least part of this, and the fix is a cache-busting one, not a logic one.

Then: name the root cause in one sentence with the `file:line` that proves it, list other plausible causes ranked, and state what changes because of the finding. Task B may make part of this moot; say which part.

---

## Task B: Replace Generate Scope with system templates

### What exists today

**Templates already exist as columns on the system type**, not in a templates table:

- `pec_prod_system_types.scope_template` (SCHEMA.md:1688)
- `pec_prod_system_types.scope_template_mvb` (SCHEMA.md:1689)
- `pec_prod_addons.scope_snippet` (SCHEMA.md:1136)

**Live coverage** (queried 2026-08-16):

| Active system | scope_template | scope_template_mvb |
|---|---|---|
| Concrete Polishing | yes | no |
| Grind and Seal | yes | no |
| Metallic | yes | no |
| MVB Only | yes | no |
| Quartz | yes | no |
| Standard Flake | yes | **yes** |
| Polydeck System | **NO** | no |
| Custom System | no (correct, it is a text slot) | no |

**There is no UI to edit them.** The system-type editor modal (index.html:44060-44090) shows a "no scope template" warning pill in the catalog list (index.html:43978) but its save payload (index.html:44104-44121) writes only `name, description, active, color, labor_budget_pct, materials_budget_pct, target_gp_pct, deposit_pct, notes`. Templates are DB-only, edited through Supabase Studio.

**Where scope lives:**

- `estimate_line_items.description` — **the customer-facing scope** since prompt 74. Rendered by `liDescHtml` (pec-public-estimate.cjs:243-256). Starts null on a new line.
- `estimate_areas` is the one line unit (SCHEMA.md:229-232). `estimate_areas.custom_scope` = rep-typed text for a custom line. `estimate_areas.notes` = internal-only, fed to generation, never customer-facing.
- `estimates.scope_of_work` = the internal whole-document record. Its UI card was deleted in prompt 76; the server still writes it and it feeds `jobScope` and the crew scope.
- `jobs.scope` and `job_areas.description` are written at accept (pec-public-estimate.cjs:1322, 1426, 1490).

**AI touchpoints to be removed or repointed:** dashboard button `estScopeGen` (index.html:31200), handler (:31689-31709), HTTP call to `/.netlify/functions/pec-estimate-scope` (:31576-31588), auto-refresh on line change (`afterEstimateChanged`, :31589-31597), "Save answers & rewrite scope" (:31660-31682), and the estimator PWA per-line Generate with AI.

### Decisions locked by Dylan (2026-08-16)

**B1. Auto-fill the template when a system is picked on a line. The Generate Scope button is removed entirely.**

- Selecting a system type on a line drops that system's `scope_template` into the line description immediately, fully editable.
- If the line is MVB (`estimate_areas.mvb = true`), use `scope_template_mvb` when present, else fall back to `scope_template`. Today only Standard Flake has an MVB variant.
- **It must never overwrite text the rep already typed.** The existing rule is `estimates.scope_edited_at`-based at the estimate level; at the line level the equivalent signal is that `description` is non-null and does not match the machine fingerprint `EST_CLOBBER_DESC_RE = /^\s*\d+\s*sq\s*ft/i` (index.html:31771). Reuse that fingerprint, and add: a description that is byte-identical to some system's rendered template is machine-written and may be replaced when the system changes.
- Changing the system on a line that has rep-typed text must **prompt** ("Replace the scope you wrote with the Standard Flake template?") and default to keeping the rep's text. This is the dialog Dylan did not see. Make sure it fires on the **estimator PWA too**, not just the dashboard.
- Nothing auto-fills after the estimate is sent. `estimates.scope_of_work` is never rewritten after signature (pec-public-estimate.cjs:1318, Decision 10) and line descriptions must inherit that rule.

**B2. Job-specific values are supplied through fill-in tokens with a small form on the line.**

- Templates carry named tokens: `{{install_date}}`, `{{stem_walls}}`, and whatever else the template author writes. Token syntax is `{{snake_case_name}}`.
- When a template with tokens lands on a line, the line editor shows a **compact form of just those fields** (one input per distinct token in that line's template), not a wall of text. Filling a field substitutes it live into the description.
- Token types: keep it to `text` and `date` in this build. Infer `date` from a token name ending in `_date`, everything else is text. Do not build a type system.
- **Unfilled tokens must block the send.** The existing blank detector (`estScopeBlanks`, index.html:31779-31798, and `scopeBlanks` in `production/scope.cjs`) already blocks `BLANK`, unresolved `is/is not`, and `___` runs, and the send gate (`estimateSendGateOk`, index.html:31799+) hard-blocks with no override. **Extend both detectors to also catch an unsubstituted `{{token}}`**, in the shared `production/scope.cjs` module so the client mirror and the server stay in sync. There is an existing mirror-pair convention here (`production/optional-lines.cjs scopeSendBlockers`); follow it, do not fork the logic.
- Once the rep edits the description by hand, tokens already substituted stay substituted. Do not re-templatize on every keystroke.

**B3. Add a scope-template editor to the system-type modal.**

Two textareas in the system-type editor (index.html:44060-44090), `scope_template` and `scope_template_mvb`, added to the save payload at index.html:44104-44121. Show the detected token list under each textarea as a live preview so whoever writes a template can see what the rep will be asked for. Keep the existing "no scope template" warning pill working (index.html:43978).

**B4. What happens to the AI.**

Remove the Generate Scope button and its handler. Do **not** delete `netlify/functions/pec-estimate-scope.cjs`, `pec-estimate-custom-polish.cjs`, or `pec-estimate-crew-notes.cjs` in this prompt, and do not drop the `estimates.scope_*` columns. Reasons:

- `pec-estimate-crew-notes.cjs` writes the internal crew brief and is unrelated to the customer scope.
- `estimates.scope_of_work` still feeds `jobs.scope` at accept; that path must keep working.
- Ripping out a function and its columns in the same session that changes the entry point makes a rollback expensive.

Gate the AI paths behind the existing `estimate_ai_enabled` and `estimate_line_generate_enabled` settings and flip `estimate_line_generate_enabled` to `'false'` in prod once templates are live. Removal of dead code is a later, separate prompt. **Say this explicitly in the log entry** so it does not become another stranded handoff.

### Guardrails

- `estimate_line_items.description` is what the customer reads. Any bug here is visible on a proposal. Test the full path: line created → system picked → template lands → tokens filled → send gate → customer page render (`liDescHtml`, pec-public-estimate.cjs:243-256) → accept → `job_areas.description` (pec-public-estimate.cjs:1490).
- Custom lines (`estimate_areas.is_custom = true`, no `system_type_id`) are **verbatim rep text** and must be untouched by all of this. The existing writer already skips them; keep it that way.
- **Polydeck System has no scope template and zero recipe slots.** Do not write one for it. Flag it to Dylan (it also breaks material cost and GP on any Polydeck line).
- Only Standard Flake has an MVB template. Every other system on an MVB line will silently fall back to the non-MVB text. Flag that too rather than papering over it.
- Rebuild the estimator PWA (`apps/estimator/`, `tsc --noEmit` + `vite build`) and commit the built output in `estimator/`. Never hand-edit `estimator/`.

---

## Task C: Sold-on-site metric

### Dylan's ask

> "Add sold on site as a metric that gets tracked. Sold on site would be the customer accepting the quote while I'm still there. I'm not sure how we would track it, whether it's within a certain amount of time or if it's something that we have to go back in and manually add, but I want to be able to track how often we're closing in the home."

### The hard constraint

**Nothing currently records how an estimate was accepted.** There is no `accepted_via` column anywhere. `signature.via` at pec-public-estimate.cjs:1747 is a hardcoded `'public_estimate_page'` literal. This is by design (index.html:31978-31981): Present mode loads the real public page with `?token=…&present=1` after the same `markEstimateSent` flip, so an on-site signature runs the **byte-identical accept path** the emailed link runs. `present=1` only suppresses the view log (pec-public-estimate.cjs:2082-2090).

The manual "Mark accepted" button (index.html:31111, handler :31520-31524) writes only `{ status:'accepted', accepted_at }` with no signature at all.

### Decision locked by Dylan (2026-08-16): appointment time window plus grace, tunable, with a manual override

Dylan considered the Present-mode signal and chose the time window. Build it as a **derived value with an explicit override**, never a bare derivation.

**C1. The rule**

An accepted estimate is sold-on-site when `estimates.accepted_at` falls between `pec_appointments.start_at` and `pec_appointments.end_at + grace`, for an appointment matched to that estimate.

- Grace: `sold_on_site_grace_minutes` (settings, default `120`).
- Appointment match, in this order: `estimates.lead_id = pec_appointments.lead_id`, else `estimates.customer_id = pec_appointments.customer_id`. There is **no `estimate_id` on `pec_appointments`**; this indirect join is the existing precedent (index.html:28991-28993, 27041-27046, 24057).
- Filter to `pec_appointments.appt_type = 'on_site_estimate'` and `status <> 'canceled'`.
- If more than one appointment matches, use the one whose `start_at` is nearest before `accepted_at`. Ties: take the earliest id, deterministically. Document the choice in code.
- No matching appointment = not sold on site (not "unknown"). Say so in the UI copy.

**C2. Storage**

Two nullable columns on `estimates`:

- `sold_on_site boolean` — the derived answer, computed and stamped at accept time. Stamping at accept (rather than deriving live on every metrics render) means a later appointment edit cannot silently rewrite history. This matters; see C4.
- `sold_on_site_override boolean` — NULL means "use the derived value", true/false means a human corrected it.

Effective value = `coalesce(sold_on_site_override, sold_on_site, false)`.

**Trigger warning:** `trg_estimate_status_guard` (SCHEMA.md:373) rejects any UPDATE that moves `status` backwards (rank `draft(0) < sent(1) = change_requested(1) < signed(2) < accepted(3) = rejected(3) = lost(3)`). The accept-time stamp happens inside the same accept PATCH at pec-public-estimate.cjs:1736-1751, which is fine. The **override** must be PATCHed on its own, without `status` in the payload, or every override attempt fails.

**C3. Surfaces**

- **Override toggle** on the estimate detail page, near the status/accepted info. Label it plainly: "Sold on site" with a small note showing what the rule decided and why ("matched your 2:00 PM on-site estimate; accepted 3:14 PM"). A metric nobody can audit is a metric nobody trusts.
- **KPI card** in Metrics. Register it in `kpiIds` (index.html:14130-14160) with a `regDrill(...)` drilldown like every other card, alongside `soldInWin` (index.html:13840). Show it as a **rate** (sold on site ÷ total accepted in window) with the prior-window delta via `deltaHtml` (index.html:14121-14129), plus the raw count. Rate is the number Dylan actually wants: "how often we're closing in the home."
- Add it to the AI metrics payload (index.html:14491-14510) next to `jobs_signed` and `conversion_by_source`.
- **Per-salesperson breakdown** in the existing per-salesperson volume section (index.html:13931-13938). Close-in-the-home rate by rep is the whole point of the metric.

**C4. Backfill, and count it before you run it**

There are accepted estimates in prod today with no `sold_on_site` value. A backfill runs the rule over history.

**Before applying any backfill, run the derivation as a read-only query and report the counts**: how many historical accepted estimates the rule would mark true, how many false, and how many have no matching appointment at all. Put those three numbers in the log entry. Then apply.

This is not optional caution. Prompt 56 shipped a derived-beats-stored rule that silently moved GP on 34 finalized jobs by $4,785 because nobody counted first. A metric that quietly asserts "you closed 8 of 40 in the home" when the appointment data is thin is worse than no metric.

If the no-match count is large, stop and put it in the Handoff to Dylan instead of backfilling. `pec_appointments` only has data as far back as the appointments feature; estimates predating it cannot be classified and must read as no-data, not as false.

**C5. Settings (standing rule 12)**

Front-of-card, Settings → Estimates (`renderSettingsEstimates`, index.html:20194):

- `sold_on_site_enabled` (default `'true'`).
- `sold_on_site_grace_minutes` (default `'120'`).

Behind **Advanced**:

- `sold_on_site_appt_types` (default `'on_site_estimate'`) — comma-separated appointment types that count.
- `sold_on_site_lookback_hours` (default `'0'`) — allow accepts slightly BEFORE `start_at` (a customer who signs while you are setting up). Zero means off.

### Migration

Plain additive nullable columns on `estimates`. `@artifacts` header (standing rule 13):

```sql
-- @artifacts
--   column: public.estimates.sold_on_site
--   column: public.estimates.sold_on_site_override
--   setting: sold_on_site_enabled
--   setting: sold_on_site_grace_minutes
--   setting: sold_on_site_appt_types
--   setting: sold_on_site_lookback_hours
-- @end
```

**Standing rule 14:** these are additive columns on a non-money table and do not touch `estimates.status`, auth, or RLS, so direct to prod is correct. State that reasoning in the log entry rather than skipping the question.

---

## Standing rules checklist

- [ ] Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first (rule 4).
- [ ] `features.json` anchors + `SCHEMA.md` before grepping or writing SQL (rule 9); never read `index.html` or `PROJECT-LOG.md` end to end (rule 10).
- [ ] Commit after each meaningful change (rule 1); ONE PROJECT-LOG.md entry at the TOP (rules 2, 3).
- [ ] What's New entries (rule 11): the scope-template change is very user-facing and needs a clear one ("the Generate Scope button is gone, here is what replaced it"). The sold-on-site metric needs one. **No em dashes** (rule 6).
- [ ] Update `features.json` for scope generation, the system-type catalog, metrics, and the estimator.
- [ ] Regenerate `SCHEMA.md` after migrations (rule 9).
- [ ] Rebuild the estimator PWA and commit `estimator/`.

## Verification before the log entry

Report actual results, not intentions:

1. `npm test` green (`production/scope.cjs` has tests; the token detector needs new ones — write them).
2. All `index.html` script blocks parse; `node --check` on every edited `.cjs`; estimator `tsc --noEmit` + `vite build` green.
3. Migration artifacts re-queried against `information_schema`; new `settings` rows re-queried by value.
4. Full scope path walked end to end: new line → pick Standard Flake → template lands → `{{install_date}}` form appears → leave it blank → **send is blocked** → fill it → send allowed → customer page shows the substituted text → accept → `job_areas.description` carries it.
5. Change a system on a line with rep-typed text and confirm the prompt appears **on both the dashboard and the estimator PWA**.
6. The three backfill counts from C4, stated as numbers.
7. **List explicitly what you could not verify.** A real on-site close cannot be simulated from this session.

## Handoff to Dylan (put this in the log entry)

1. **Polydeck System**: no scope template, zero recipe slots. Broken material cost and GP on any line using it. Write its slots and template or deactivate it.
2. **MVB templates**: only Standard Flake has one. Every other system on an MVB line falls back to the non-MVB text. Which systems need MVB variants written?
3. **Token conventions**: the build ships the mechanism. Dylan (or Cowork) needs to go through each of the 6 existing templates and replace the hand-written blanks with `{{tokens}}` so the fill-in form actually appears. Until that happens the templates land as static text with `BLANK`/`___` placeholders, which the send gate will block, same as today.
4. **`estimate_line_generate_enabled` flip**: confirm the AI per-line generate should be turned off in prod once templates are live.
5. Backfill numbers from C4 and whether to proceed.
