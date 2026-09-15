# Engineering reference: load for the affected task

The short canonical rules are in `AGENTS.md`. This file preserves detailed procedures without forcing them into every startup. Current user authorization takes precedence over old operator boundaries.

## Risk-sensitive module invariants

- **Auth:** preserve the real exclusive `navigator.locks` behavior and `timedFetch` aborts. A no-op auth lock previously stranded the client. Reads may recover/retry; non-idempotent writes require verification before retry. Module/classic script scopes differ; deliberate shared state lives on `window.pecState`.
- **Modals:** `pecModalRoot` and `prodModalRoot` have separate JavaScript lifecycles. Audit both when changing close, focus, sizing, or safety-net behavior. CSS shared by both can cover both deliberately.
- **Jobs:** `jobs`/`customers` and `pec_prod_jobs`/schedule days serve distinct workflows. Preserve explicit `crm_job_id` pairing and verify source precedence. Do not merge or delete records because a DripJobs ID is null. Native TopCoat rows may legitimately lack it.
- **Money:** preserve typed costs and historical overrides unless the owner explicitly chooses recalculation. Count and inspect affected rows before changing source precedence. Change-order material pushes are additive; do not replay them for edits/deletes. Pending-state compare-and-set guards protect concurrent customer acceptance.
- **Estimates:** the estimator does not own sent/accepted status. Preserve write locks, cold reopen, offline drafts, custom-line measurements, formatting, and visible-text send validation. Rebuild `apps/estimator`; inspect the live bundle before diagnosing a supposedly missing shipped fix.
- **Appointments:** availability and the locked booking RPC must enforce the same overlaps, blocked days, and calendar-health rules. A completed Google pull with no pending continuation matters; a recent attempt alone is not proof. Preserve incremental `syncToken` query shape and bound new local recurrence inserts rather than altering it.
- **Notes and customer data:** internal appointment content belongs in `notes`; `customer_notes` is sent in confirmations/reminders. Resolve shared identity through literal filters; check query errors and zero affected rows instead of assuming a successful write.
- **Owner plans:** source documents stay immutable, yearly working records stay separate, manual blank/zero overrides persist, and unsupported source coverage stays unknown. Revision conflicts must preserve the user's draft. Private AI generation is explicit and must not enter shared caches.
- **Catalog:** `material_type` constraints can span products, recipe slots, and material lines. A system needs populated recipe slots before activation. Review shared enum/status lists when extending a category or stage.
- **Headers:** preserve same-origin estimator/presentation frames and permitted public booking embeds. A frame-denial header once broke embedded workflows. Enforced policy changes require relevant UI verification and any necessary design approval.

## Migrations and settings

Read the relevant `SCHEMA.md` section before SQL. Check live schema when a migration or grant matters; historical comments such as "Applied to PROD" are not evidence. Identify whether money, auth, `SECURITY DEFINER`, RLS, or `estimates.status` requires rehearsal under the shared contract.

Every migration begins with its own artifact declarations:

```sql
-- @artifacts
--   table: public.example
--   column: public.example.field
--   index: example_field_idx
--   setting: example_enabled
-- @end
```

The four artifact kinds are `table`, `column`, `index`, and `setting`. Use `none: <reason>` for functions, views, triggers, constraints, or data-only changes the drift checker cannot inspect. When a later migration replaces an artifact, keep the original declaration and append ` (superseded-by: <file>.sql)`; a replay still creates it. Keep the generated `_migration-manifest.json` committed and regenerate when migrations change.

Verify role boundaries and applied artifacts after migration. Refresh only relevant schema sections with a dated source/evidence note. Do not describe a migration-derived document as a live schema refresh. Never ship dependent code while the required migration is only a handoff.

Settings hold operator choices, with two commonly tuned controls visible and the rest under Advanced. Persist app-generated counters, caches, and state separately. Store secrets in environment variables. A browser Google key must be referrer/API restricted; server Routes calls use a separate server key.

## Validation and publication

Run the task's meaningful focused checks first, then the required release checks:

```text
npm test
node --check <each changed .cjs>
npm --prefix apps/estimator run build  (when estimator source changes)
git diff --check
```

Parse changed `features.json` and `help/whats-new.json` with JSON.parse. For dashboard inline scripts, compare a per-script parse run with HEAD rather than freezing a historical known-failure count. Check relevant desktop/mobile workflows with synthetic records and a 360px viewport when applicable. Do not send customer communications or create production fixtures merely to test the UI.

Inspect the final diff, required schema state, deployment commit, and relevant live output. Preserve standing publication authorization; report actual failures or holds. Stage specific files, commit meaningful changes, and prepend a log entry with `By: Codex`, `By: Claude Code`, or `By: Cowork` as appropriate. Never alter previous log entries. What's New is for user-visible behavior, not internal housekeeping.

## Handoff format

Use `.claude/skills/handoff/SKILL.md` when work genuinely requires another operator. Verify embedded schema names, pin the current commit, and confirm paths/resource identifiers before writing the prompt. Do not hand off code work available to the current session.

```text
Context: repository, deployment URL, source commit, completed work, blocker.
Tasks: ordered actions, exact location, acceptance evidence, and guardrails.
After: what the operator should verify, record in PROJECT-LOG, and report.
```

Print the full self-contained handoff in chat and record it in a new log entry. The recipient does not have the conversation. Keep the task's current state explicit; an old handoff section is not an active task queue.

## Resource references

The MCP endpoint uses `MCP_BEARER_TOKEN_V2`, `MCP_OAUTH_CLIENT_ID_V2`, and `MCP_OAUTH_CLIENT_SECRET_V2`. Old credential names are intentionally ignored; missing replacement values must deny access. Historical environment-variable lists are not the current credential contract. Keep values in Netlify, never in this document.

Verify these before use when the task depends on them: Supabase `zdfpzmmrgotynrwkeakd`; site `https://prescottepoxy.netlify.app`; Booked Jobs Sheet `1oNMMiuPmtrmu-x9Vxcy4kz0xxzQV00WNCGvk35rGLr4`; Dashboard Data Sheet `1445T0CPavFCWEj2soegc599nCZrbWLgDsCnjQGChI74`; MBP 2026 Sheet `1vlumbi2mh_mjtmO1ZiTxMy0BTXbtNCNV-FOM-LVZ_s0`; Slack `#epoxysales` `C09AZE8CU0Z`. These are identifiers, not permission to write. The HQ vault at `/Users/dylannordby/Desktop/HQ` is read-only reference from this project.
