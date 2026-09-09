# TopCoat / HQ-Dashboard: Agent Handover for GPT Codex

Written 2026-09-07 by Cowork for Dylan Nordby. Snapshot of git HEAD `7ba5d23` on `main`.

This is the complete operating picture for a coding agent joining the TopCoat project. It exists so Codex does not have to reconstruct the workflow from the GitHub history, the Obsidian vault, or guesswork. It covers who the other agents are, what the repo is, how every session starts and ends, the standing rules, the infrastructure, the business context around the code, and the traps that have already cost real time.

Codex is joining ALONGSIDE Claude Code, not replacing it. Section 15 is the coordination contract between the two coding agents. Read it before touching anything.

How to read this: Sections 1 to 4 are context. Sections 5 to 11 are the rules and the loop you run every session. Sections 12 to 14 are the world outside the repo. Section 15 is the multi-agent contract. Section 16 is the scar tissue. Section 17 is what is open today.

---

## 1. Who and what this is

**Owner:** Dylan Nordby, Prescott, Arizona. Owns two home services companies that share crews, overhead, an office manager, and his attention:

- **Prescott Epoxy Company (PEC)**, founded 2022. Premium garage floor coatings, showroom, 10-year warranty. Single core system (Simiron full flake) with add-ons priced per square foot.
- **Finishing Touch Painting (FTP)**, founded 2019. Exterior repaints and commercial painting.

Dylan's stated goal is to build systems and reduce his direct involvement in day-to-day operations. He works with a business coach on an MBP (Monthly Business Performance) framework. He builds fast, dictates a lot (Plaud Pro), and forgets what already shipped. That last point matters: a meaningful fraction of his feature requests are already built. Check before building (Section 16).

**The software:** TopCoat is the custom CRM and operations platform Dylan is building to replace DripJobs. The repo is the "ARM platform":

- ARM 1: Production dashboard. Live.
- ARM 2: Customer portal. Target Q3 2026 (customer-facing estimate, invoice, change-order and booking pages already ship from Netlify functions).
- ARM 3: Custom CRM. Was slated for 2027; as of 2026-08-01 Dylan moved full adoption up and considers it roughly 75% built to his vision. PEC runs on it. FTP is the second use case to prove it adapts.

**Plan of record (Dylan, 2026-08-01):** integrate PEC fully, polish TopCoat, then use FTP as a second use case, then see where it goes.

---

## 2. The agent roster

Five actors touch this project. Each has a defined lane. Do not drift into another actor's lane without saying so.

| Actor | What it does | Where it works | Writes to the repo? |
|---|---|---|---|
| **Dylan** | Owner. Brings issues, build phases, bugs. Makes binary architectural calls. Gives agents standing authorization to push tested requested changes. Approves prod migrations on money/auth tables. | Everywhere | Yes (rarely directly) |
| **Claude Code** | Coding agent. Reads the repo, edits code, runs tests, applies migrations via the Supabase MCP, commits, writes PROJECT-LOG entries, prints Cowork handoff prompts. | Local terminal on Dylan's Mac, repo at `/Users/dylannordby/Claude-Code/HQ-Dashboard` | Yes. `By: Claude Code` in the log. |
| **Codex** (you) | Second coding agent. Same lane as Claude Code, same rules, plus the coordination contract in Section 15. | Same repo | Yes. `By: Codex` in the log. |
| **Cowork** | Anthropic's desktop agent, running as Dylan's operator for things a coding session cannot reach: third-party web UIs, Google Sheets, Google Docs, Supabase Studio, Netlify dashboard, Zapier, prod verification, writing build prompts from Dylan's requests, and audits. Has its own project instructions (Section 11). | Cloud sandbox with Dylan's Mac folders mounted | Yes. `By: Cowork` in the log. Commits and pushes tested requested changes under Dylan's standing authorization. |
| **Chat Claude projects** | Planning and review. Three claude.ai projects: **TopCoat CRM** (planning, review, writes build prompts), **Business Coach** (strategy, explicitly out of scope for CRM code), **Business Radar** (monitoring; reads Supabase, writes `pec_radar_alerts`, appends `RADAR-SIGNALS.md` in the vault). | claude.ai | No direct repo writes |

Log tallies at HEAD: 567 PROJECT-LOG entries since 2026-06-01, 307 by Claude Code and 264 by Cowork. That ratio is the workflow: the coding agent ships, Cowork verifies and operates, and both log.

**The handoff loop, in one paragraph.** Dylan describes a request (often several in one message). Cowork or chat Claude interrogates him (10+ multiple-choice questions is the project norm), audits the code and the live database for what already exists, and writes a numbered build prompt (`claude-code-prompt-NNN-<slug>.md` at the repo root). The coding agent runs the prompt: reads CLAUDE.md and the last three log entries, implements, tests, updates `features.json`, `help/whats-new.json` and `SCHEMA.md` as needed, logs, commits. Anything the coding agent cannot do from the terminal becomes a self-contained Cowork handoff prompt printed in chat AND logged. Cowork executes it, logs `By: Cowork`, commits and pushes after required checks pass. The agent that publishes verifies the live deployment; per-push confirmation is not required under Dylan's 2026-09-09 standing authorization.

---

## 3. Repository anatomy

Repo: `git@github.com:Dnordby50/hq-dashboard.git`, branch `main`, ~1,200 commits. Local path `/Users/dylannordby/Claude-Code/HQ-Dashboard`. No feature branches in practice; everything lands on `main`.

### Files you will touch

| Path | What it is | Size / notes |
|---|---|---|
| `index.html` | The entire production dashboard (ARM 1). All UI, all client JS, all CSS. | ~3.0 MB, ~28k lines. **Never read wholesale.** Navigate via `features.json` anchors plus grep. |
| `features.json` | Feature manifest: 99 entries, each a plain-English description plus code anchors (function names in index.html, Netlify function files, Supabase tables). Doubles as the product catalog. | 267 KB. Anchors are FUNCTION NAMES, never line numbers. Update the entry when you change a feature. |
| `SCHEMA.md` | Table and column reference generated from the LIVE Supabase schema (project `zdfpzmmrgotynrwkeakd`) via MCP `list_tables`, with a dated refresh log at the top. | 156 KB. Consult before ANY SQL or supabase-js select. Refresh the relevant section after applying a migration. |
| `PROJECT-LOG.md` | Append-only, newest-first history. Entries from 2026-06-01 onward. Entry template at the BOTTOM of the file. | 2.5 MB. Read the top 3 entries only. Never read end to end. |
| `PROJECT-LOG-ARCHIVE.md` | Entries before 2026-06-01, verbatim. | 639 KB. Rarely needed. |
| `CLAUDE.md` | Standing rules for Claude Code. Source of truth with PROJECT-LOG. Section 6 of this document transcribes it. | Do not edit without Dylan's say-so. |
| `AGENTS.md` | Codex's entry point (created 2026-09-07). Points here and carries the same rules. | Keep in sync with CLAUDE.md. |
| `netlify.toml` | Build command, env, redirects, 14 scheduled functions, secret-scanner omit list. | 21 KB. Read it once. |
| `netlify/functions/` | 86 files: 85 `.cjs` serverless functions plus `_migration-manifest.json`. `_pec-*.cjs` are shared helpers (not endpoints). `pec-webhook-*.cjs` are inbound webhooks. `pec-public-*.cjs` render customer-facing pages. `mcp.cjs` is the read-only Topcoat MCP server. | `.cjs`, never `.js` (package.json is `"type": "module"`). Bundled with esbuild. |
| `supabase/migrations/` | 196 migration files, named `YYYY-MM-DD_<slug>.sql`. Applied manually via the Supabase MCP or Studio; there is no migration runner. | Every file starts with an `@artifacts` header (rule 13). File dates are NOT applied dates; several run ahead of the calendar. |
| `supabase/` (root) | `schema.sql`, `policies.sql`, seed files, `SETUP.md` (original one-time setup). Historical; the migrations folder is the living record. | |
| `production/` | Node calculation logic and tests: `calculator.js`, `comps.js`, `scope.cjs`, `job-money.cjs`, `installments`, `pricing`, and 30 test files. This is what `npm test` runs. | Pure functions shared by client and server. Fixture-tested. |
| `apps/estimator/` | Source of the estimator PWA (TypeScript, React, Vite). | `estimator/` at repo root is the BUILT output, gitignored, rebuilt by Netlify. Never hand-edit it. |
| `help/whats-new.json` | Changelog read by the sign-in popup, the Help view, and the help assistant. Newest first. | Every user-facing change gets an entry (rule 11). |
| `help/crm-help.md` | Help content for the in-app assistant (`sop-chat.cjs`). | |
| `scripts/` | `build-migration-manifest.mjs` (runs first in the Netlify build), plus one-off idempotent backfills (`backfill-review-asks.cjs`, `enroll-lead-backlog.cjs`). | Backfills always support `--dry-run`; run it first and show Dylan the list. |
| `docs/` | Plans and runbooks (`pm-module-*`, `job-schedule-future-todos.md`, `sales/pec-sales-process-v3.md`) and `docs/archive/prompts/` (94 historical build prompts, 10 through 56 and named specs). | Reference only. Superseded by shipped code and log entries. |
| `claude-code-prompt-NNN-*.md` (root) | The two most recent unarchived build prompts (101 booking, 102 form builder). Older ones were moved to `docs/archive/prompts/`. | Highest number at HEAD: 102. |
| `.claude/settings.json` | Shared permission allowlist for Claude Code (git read commands, ls/grep/find/head/tail, `npm test`, `node --test`, JSON parse checks). | Codex has its own permission model; this file tells you what the team considers safe to auto-run. |
| `.claude/settings.local.json` | Dylan's local allowlist (includes `git add`, `git commit`, `git push`, awk/grep on index.html). | Not shared. |
| `.claude/skills/handoff/SKILL.md` | The `/handoff` skill: mandatory schema check, commit pin, path check, then the Cowork prompt format. Section 8 transcribes it. | |
| `.gitignore` | `node_modules`, `.env*`, `/estimator/`, `/_to_delete/`, build state. | |
| `_to_delete/` | Staging area for stale git lock files and temp objects that the cloud sandbox cannot delete (Section 15). Gitignored. | Dylan empties it. |
| `mockup.html`, `_prompt81-previews/`, `*-analysis.md`, `*-findings.md` at root | Working artifacts from past sessions. | Ignore unless a task names them. |

### Tests and verification commands

```
npm test                      # 30 production/*.test.* files, run serially by package.json
node --check <file.cjs>       # every touched Netlify function
```

For `index.html`, the convention is a per-script-block parse check: extract each `<script>` block and `node --check` it. There are 3 known blocks that fail (module / non-JS blocks); a change is clean when the failure set is IDENTICAL to HEAD. The log entries phrase this as "script-block parse check shows the identical failure set as HEAD". Also reload both JSON files (`features.json`, `help/whats-new.json`) through `JSON.parse` after editing.

The estimator: `npm --prefix apps/estimator run build` runs `tsc --noEmit && vite build`. Netlify does this on deploy; run it locally when you touch `apps/estimator/src`.

Netlify builds on push to `main`. The publishing agent verifies the deployment and relevant live behavior, and reports any failed build or delivery instead of assuming a successful push means the site changed.

---

## 4. Infrastructure and integrations

### Hosting: Netlify

- Live site: `https://prescottepoxy.netlify.app`. The older `https://hq-prescott.netlify.app` host is a netlify.toml redirect onto it. A custom domain is an open loop (deferred 2026-08-09; links already use `process.env.URL`, so a GoDaddy CNAME flips them, but the Google key referrer and a per-brand FTP host are the real work).
- Build: `node scripts/build-migration-manifest.mjs && npm --prefix apps/estimator ci && npm --prefix apps/estimator run build`. `publish = "."`. Node 20.
- Functions bundle with esbuild. Scheduled functions (cron in UTC; the project is single-timezone Arizona, no DST): `pec-auto-progress`, `pec-openphone-sync`, `pec-drip-runner`, `pec-appt-reminder-runner`, `pec-followup-rank`, `pec-followup-digest`, `pec-migration-drift`, `pec-birthday-reminders`, `pec-security-monitor`, `pec-google-calendar-pull`, `pec-lost-reason-backfill`, `pec-lead-score-runner`, `pec-salesask-sync`, `pec-system-heartbeat`.
- Secret scanner: client-side Google API keys are intentionally committed (rule 7 exception) and must be listed in `SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES` in `netlify.toml`. There are two values there; one is a transposed key that never existed but survives in append-only log text. Do not remove either.
- Redirects in `netlify.toml` map the old host, `/estimator/*`, `/mcp` plus its OAuth discovery and token endpoints, and the token-in-path public pages onto functions.

### Environment variables (names only; values live in Netlify, never in the repo)

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `PEC_WEBHOOK_SECRET`, `QUO_API_KEY`, `QUO_WEBHOOK_SECRET`, `OPENPHONE_API_KEY`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SLACK_LEADS_WEBHOOK`, `SLACK_OFFICE_WEBHOOK`, `OFFICE_NOTIFY_EMAIL`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_ROUTES_API_KEY`, `COMPANYCAM_API_TOKEN`, `BUSYBUSY_EXPORT_TOKEN`, `SALESASK_API_KEY`, `SALESASK_WEBHOOK_SECRET`, `REVIEW_INTAKE_SECRET`, `MCP_BEARER_TOKEN`, `MCP_OAUTH_CLIENT_ID`, `MCP_OAUTH_CLIENT_SECRET`, `PEC_ESTIMATE_AI_MODEL`, `PEC_FOLLOWUP_MODEL`, `PEC_LEAD_AI_MODEL`, `PEC_METRICS_AI_MODEL`, `PEC_SCOPE_AI_MODEL`, plus Netlify's own `URL` and `DEPLOY_PRIME_URL`. Build-time: `VITE_GOOGLE_MAPS_KEY` (in netlify.toml, referrer-restricted browser key).

If code needs a new credential: placeholder in code, `## Handoff to Dylan` asking him to set the env var (rule 7).

### Database: Supabase

- Project ref `zdfpzmmrgotynrwkeakd`, free plan (branch databases are NOT available; rule 14's branch rehearsal has in practice been done with rolled-back prod transactions under a simulated staff JWT when a branch could not be created).
- Client: supabase-js in the browser with the anon key (committed in `index.html` CONFIG, by design), service role only inside Netlify functions via `_pec-supabase.cjs`.
- RLS is on. Staff tables use `is_admin_staff()`; token vaults and sync tables have RLS on with zero policies (service-role only). Some tables grant column lists that deliberately exclude `ip_hash`, so `select=*` errors by design on those.
- Storage buckets: `pec-photos`, `pec-datasheets`, `pec-presentation`, `pec-docs`, `pec-pricing`.
- The `settings` table (216 rows live at the last SCHEMA.md refresh) is the tunable-parameter store. Rule 12 governs it.
- Migrations are applied by hand via the Supabase MCP (`apply_migration`, `execute_sql`) or Studio. The drift checker (`pec-migration-drift.cjs`, scheduled, surfaced as the Schema Drift panel in Settings) reads `_migration-manifest.json` and probes the live schema for every `@artifacts` line. Trust the drift panel over any "Applied to PROD" comment inside a migration file.
- supabase-js gotcha: selecting a nonexistent column returns an empty result WITHOUT throwing. If a read comes back mysteriously empty, check `res.error` before suspecting RLS.

### Third-party services wired into functions

| Service | Role | Entry points |
|---|---|---|
| Quo (formerly OpenPhone) | Business phone, both brands, three inboxes. Calls and SMS webhook into `pec_call_log` / `pec_sms_log`; outbound SMS. | `pec-webhook-quo.cjs`, `pec-send-sms.cjs`, `pec-openphone-sync.cjs` |
| Resend | Transactional email plus delivery webhooks. | `pec-send-email.cjs`, `pec-webhook-resend.cjs` |
| Stripe | Card and ACH payments on invoices. | `pec-stripe-checkout.cjs`, `pec-stripe-webhook.cjs`, `pec-invoice-intent.cjs` |
| Anthropic API | Estimate scope writing, lead scoring, follow-up ranking, metrics, help chat. Model names are env vars. | `pec-estimate-ai.cjs`, `pec-lead-ai.cjs`, `_pec-lead-score.cjs`, `pec-followup-rank*.cjs`, `pec-metrics-ai.cjs`, `sop-chat.cjs` |
| Google | Calendar two-way sync (OAuth per sales member, per-calendar sync tokens), Routes API (drive-time buffers, server key), Places (address autocomplete, browser key), Sheets (Booked Jobs via an Apps Script proxy). | `pec-google-*.cjs`, `_pec-google.cjs`, `_pec-booking-drive.cjs`, `sheets-proxy.cjs` |
| Slack | Lead alerts, office notifications, accept celebrations, follow-up digest. `#epoxysales` is `C09AZE8CU0Z`. | Webhook URLs in env |
| CompanyCam | Job photos on estimates. | `pec-companycam.cjs` |
| BusyBusy | Time tracking; CSV export replaced the dead GraphQL API. Snapshot, not sync: delete-then-insert by date range. | `pec-busybusy-export.cjs`, `_pec-busybusy.cjs` |
| SalesAsk | Sales call recordings matched to appointments by Firebase uid. | `pec-salesask-sync.cjs`, `pec-webhook-salesask.cjs` |
| DripJobs | The CRM being retired. Webhooks still land deals into BOTH `jobs` and `pec_prod_jobs`. Cutover audit 2026-07-28 said build ~done, cutover not started; since then PEC has moved onto TopCoat. | `pec-webhook-proposal-accepted.cjs`, `pec-webhook-stage-changed.cjs`, `pec-webhook-project-completed.cjs`, `pec-webhook-appointment-set.cjs` |
| Routemize | Online booking, cancelled 2026-08-19. Replaced by TopCoat-native booking (prompts 101/102). Intake path `pec-appt-intake.cjs` retained. | |
| Zapier | Meta Lead Ads and Angi into `pec-lead-intake.cjs` (header `x-webhook-secret`). Also historical Sheets automations (Section 12). | |
| Enhancify | Customer financing links. | `_pec-financing.cjs` |

### The Topcoat MCP server

`netlify/functions/mcp.cjs` exposes a read-only Streamable-HTTP MCP server at `https://<site>/mcp` with bearer auth: `get_schedule`, `get_sales_summary` (reads the Booked Jobs sheet, has timed out at 60s, keep it off scheduled paths), `find_customers`, `find_jobs`, `list_pipeline`, `get_sales_recordings`. Cowork and the chat projects use it as the preferred source for CRM data. No write path.

---

## 5. Startup procedure (every session, no exceptions)

1. Read `AGENTS.md` and `CLAUDE.md`. They are the same rules; CLAUDE.md is the canonical wording.
2. Read the top 3 entries of `PROJECT-LOG.md` (use `awk '/^## /{n++} n<=3' PROJECT-LOG.md`, not a full read). This catches what Cowork, Claude Code, or Dylan did since your last session.
3. Run `git status -sb`. Note whether `main` is `[ahead N]` of origin. Unpushed commits are the single most common cause of "the fix didn't work" (Section 16). Note any stray `.git/*.lock` files.
4. Confirm to Dylan in one sentence what the most recent entry was and what the project's current state is.
5. If the task names a feature, open its `features.json` entry before grepping. If it names a table, open its `SCHEMA.md` section before writing a query.
6. Then do exactly the task. Do not expand scope. If the task is unclear or conflicts with CLAUDE.md or a recent log entry, stop and ask before doing anything.

---

## 6. Standing rules (CLAUDE.md, adapted for any coding agent)

These are the 14 rules in CLAUDE.md. Wording is preserved where it matters; "Claude Code" is generalized to "the coding agent" because both Codex and Claude Code are bound by them.

1. **Commit after every meaningful change.** Format `<area>: <what changed>` (example: `dashboard: fix Booked Jobs pull for empty rows`). Never commit secrets, API keys, credentials, or `.env` files.

2. **Update PROJECT-LOG.md after every meaningful change.** Append a new entry at the TOP (newest first). Use the entry template at the bottom of the file. Write it for a human, not a machine.

3. **Never delete PROJECT-LOG.md entries.** Append only. If something was wrong, write a correction entry referencing the original.

4. **Before starting any task, read CLAUDE.md and the last 3 entries of PROJECT-LOG.md.**

5. **Flag handoffs explicitly.** If a task needs Cowork or Dylan to do something manually (web action, file upload, paste into a sheet), end the log entry with a `## Handoff to Cowork` or `## Handoff to Dylan` section listing exactly what they need to do. Also print the Cowork prompt in chat (Section 8).

6. **No em dashes in anything customer-facing**: estimates, invoices, scope text, portal pages, emails, SMS, What's New entries, help content. Use commas, parentheses, or two sentences. Em dashes are fine in code, comments, internal docs, and PROJECT-LOG entries. (Dylan's personal preference is stricter: he never wants them in output addressed to him either. When in doubt, do not use them.)

7. **Keep secrets out of code.** Placeholder in code plus a Handoff entry asking Dylan to set the env var. Exception: domain-restricted client-side Google keys (Sheets, Maps, Places) are committed by design; they MUST be referrer-restricted and API-restricted in Google Cloud Console AND listed in `SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES` in `netlify.toml`. Rotating one means updating `index.html` and `netlify.toml` in the same commit.

8. **Default to Cowork for inputs and verifications, not direct questions to Dylan.** When something would otherwise need Dylan to provide a value, verify a result in a third-party UI, run a migration, or perform a manual web action, package it as a Cowork handoff (in the log entry AND as a standalone prompt printed in chat). Stay direct (ask Dylan) only when the session is BLOCKED on a binary architectural choice, or when waiting on Cowork would cost more than a 1-2 word answer is worth. The trigger is "this session is stalled until I get this answer", not "this needs Dylan's input eventually".

9. **Consult the reference files before searching or guessing.** `features.json` before grepping `index.html`. `SCHEMA.md` before ANY SQL or supabase-js select (assumed column names have caused real bugs twice, and the /handoff skill lists the known traps: customer name lives on `public.customers` via `jobs.customer_id`, `jobs` has no `customer_name`; `pec_email_log`'s only timestamp is `sent_at`; `pec_sms_log` has `created_at`; `pec_call_log.direction` is `'in'`/`'out'`, not `'incoming'`/`'outgoing'`). Regenerate the relevant SCHEMA.md section after applying migrations; update the `features.json` entry when a feature's code or tables change.

10. **Token discipline.** Never read `index.html`, `PROJECT-LOG.md`, or `PROJECT-LOG-ARCHIVE.md` wholesale. Locate code via `features.json` anchors plus grep. Use subagents or scoped searches for broad sweeps so the main context stays small.

11. **Every user-facing change ships with a What's New entry** in `help/whats-new.json` (id, date, title, one-line summary, 2-3 how-to steps, plain language, no em dashes), newest first, in the same session. Internal-only changes (refactors, webhooks, migrations with no visible behavior change) do not get entries.

12. **Every major feature ships with a settings surface.** Key parameters (on/off, timing, limits, thresholds, quiet hours) live in the `settings` table and are tunable with no code change. Visibility is rationed: at most TWO controls per feature front-of-card; everything else behind that card's collapsed "Advanced" disclosure. State and caches are NOT settings and never get a control or a `settings` row. (Hardwired by Dylan 2026-07-21, amended 2026-08-08 after an audit found 16 of 78 UI-exposed knobs had never been saved and a dozen live parameters had no surface.)

13. **Every migration file starts with an `@artifacts` header** so the drift checker can probe the live schema. Four kinds only: `table: public.<name>`, `column: public.<table>.<column>`, `index: <indexname>`, `setting: <settings.key>`. Anything not expressible in those (views, triggers, functions, constraints, data-only) declares `none: <reason>` and is reported as unverifiable. If a later migration drops or replaces an artifact, keep the header line and append ` (superseded-by: <that-file>.sql)`.

   ```sql
   -- @artifacts
   --   column: public.estimates.crew_notes
   --   column: public.jobs.crew_notes
   -- @end
   ```

14. **High-risk migrations rehearse before prod.** Anything touching MONEY tables (`pec_payments`, `pec_invoice_installments`, `jobs` price/AR columns, `pec_job_ar`), AUTH (`admin_users`, `user_permissions`, anything SECURITY DEFINER, RLS policies on staff tables), or `estimates.status` is rehearsed on a Supabase branch first (create_branch, apply, verify with real queries, merge or discard). Plain additive columns elsewhere go direct to prod. The trigger is what the migration TOUCHES, not how big it looks. On the free plan, the fallback rehearsal has been a rolled-back prod transaction under a simulated staff JWT; say which you did in the log.

**Additional standing conventions that are not numbered in CLAUDE.md but are enforced in practice:**

- Stage specific files, never `git add .`.
- Dylan authorizes agents to commit and push tested, user-requested changes to `origin/main` without per-push confirmation (2026-09-09), then verify the live deployment. Honor an explicit publication hold. Keep shared history intact; use revert commits for rollback. Report any real blocker and pending commits.
- Never modify the Obsidian HQ vault from this project (read-only reference).
- Never touch `estimator/` (build output) by hand.
- One-off backfill scripts are idempotent, support `--dry-run`, and get Dylan's explicit yes before the live run.
- Dates in log headers are `[YYYY-MM-DD MST]` (the project runs on Arizona time, UTC-7 year-round).

---

## 7. The session loop, end to end

This is what a normal build session looks like from the first message to the last commit.

**Intake.** Dylan pastes a build prompt (`claude-code-prompt-NNN-*.md`) or describes a bug or a list of asks in his own words. Prompts carry a `## Context`, a `### Read before you start` list, `## Locked decisions (Dylan answered these on <date>)`, then parts A, B, C with acceptance criteria, then housekeeping (migration, SCHEMA.md refresh, features.json, What's New, log). Prompt 101 at the repo root is a representative example. When there is no prompt, the Bug Diagnosis Workflow (Section 9) applies.

**Check before building.** Grep `features.json` and the code, and query the live database, for what already exists. On 2026-08-16 three of nine requests were already shipped (Present mode, brand footer, scope templates). When something exists and Dylan did not know, the deliverable is a walkthrough, not a build. Open your reply with what already exists, before the questions.

**Implement.** Small commits per rule 1. Migrations get the `@artifacts` header, get applied (via the Supabase MCP if you have it; otherwise this is a Cowork handoff and the session ENDS on the block with a printed prompt rather than logging a handoff and continuing, see Section 16), and get their SCHEMA.md section refreshed with a dated line at the top of SCHEMA.md in the established format ("Refreshed YYYY-MM-DD (<agent>, <prompt>) after applying `<file>` live via MCP: ... Only those sections changed.").

**Verify.** `npm test` green. `node --check` on every touched `.cjs`. Script-block parse check on `index.html` matching HEAD's failure set. JSON files reload. When the change is visible, describe what Dylan should see after deploy plus hard reload; the estimator PWA precaches its bundle for a whole session, so "still broken on my phone" often means a stale bundle (curl the live bundle before re-diagnosing).

**Document.** `features.json` entry updated (anchor function names, tables). `help/whats-new.json` entry for anything user-facing. `SCHEMA.md` if the schema moved.

**Log.** One PROJECT-LOG entry at the top, using the template (Section 10). Real log entries are long: root cause, what changed and why, what was verified, files touched, commit SHAs, next steps, both handoff sections. The "Handoff to Dylan" section is written in plain language for him, not for an engineer.

**Commit.** `git add <specific files>` then `git commit -m "<area>: <what>"`. The docs commit that carries the log entry is usually separate from the code commits (the log then lists both).

**Publish.** After required checks pass, push the requested changes to `origin/main` and verify the live deployment. Dylan's 2026-09-09 standing authorization replaces the old per-push approval requirement. Honor any explicit request to hold publication.

**Report.** Tell Dylan what shipped and what he will see. Report any real blocker, failed deployment, or commits that remain unpublished.

---

## 8. Cowork handoff prompt format

Cowork prompts go to a separate operator with no chat history and no access to your conversation. They MUST be self-contained. The `/handoff` skill (`.claude/skills/handoff/SKILL.md`) adds three mandatory checks before you write one:

1. **Schema check.** Every table and column in any embedded SQL or supabase-js snippet confirmed against `SCHEMA.md` (or `supabase/migrations` if SCHEMA.md looks stale). Never ship the guess.
2. **Commit pin.** `git log -1 --format=%H` so Cowork works against a known version.
3. **Path check.** Every file path, sheet ID, and URL confirmed real with grep or ls. Key resource IDs are in CLAUDE.md.

Then print it in chat as a fenced code block in exactly this shape:

```
## Context
One paragraph. What just shipped (with commit SHAs if relevant), why this handoff exists, what is currently blocked on it. State the repo and the deploy URL so Cowork knows which environment.

## Tasks
Numbered list. Each task has:
- What to do (one sentence, imperative).
- Where to do it (file paths with line numbers, table names, sheet IDs, or URLs). Include enough that Cowork doesn't have to grep.
- Acceptance criteria (how Cowork knows it worked).
- What NOT to touch (guardrails).
Take tasks in dependency order; if task 2 needs task 1 to be live first, say so.

## After
What Cowork should update once tasks are done: the PROJECT-LOG entry to append (with `By: Cowork`), specific values to capture in the entry (counts, column letters, before/after values), and what to report back to Dylan.
```

Rules of thumb: include actual SQL or file snippets when short. Never assume Cowork has read PROJECT-LOG; paste the relevant line. If a task needs a credential or context Cowork would have to ask Dylan for anyway, name it so Cowork asks once. Also add the same content as a `## Handoff to Cowork` section in your log entry.

What belongs in a Cowork handoff: clicking around DripJobs, Supabase Studio, the Netlify dashboard, Google Sheets, Zapier; uploading a file via a browser; running a migration in prod when you cannot; pasting a value into a sheet; verifying a result in a third-party UI. What does NOT: code edits in this repo. Code edits are never a Cowork handoff.

---

## 9. Bug diagnosis workflow

When Dylan reports a bug or unexpected behavior:

1. **Diagnose from the code, not from guessing.** Read the relevant files, grep for the symptom, identify the most likely root cause(s) with line numbers as evidence. No fix proposal until you have read the code.
2. **Present findings in this order:** (a) the most likely cause in one sentence with the `file:line` that proves it; (b) other plausible causes ranked by likelihood, each with `file:line`; (c) a cheap way for Dylan to confirm which one it is (DevTools check, console command, network tab, log line) before changing code.
3. **Default to fixing it yourself, in this session.** Edit, commit, log. Do not produce a Cowork prompt for work you can do directly.
4. **Hand off to Cowork only when the task literally cannot be done from this session** (Section 8).
5. **After fixing, give Dylan a plain-English explanation of the root cause and the fix**, written so he learns the underlying concept, not just the patch. Tie every claim to actual code in this repo.

First move on any "the fix didn't work" or "it's still broken" report: `git status -sb` and check for `[ahead N]`. On 2026-08-10 the repo was `ahead 3` and prod was simply three commits behind. Second move for estimator complaints: curl the live bundle and compare to `apps/estimator/src`.

---

## 10. PROJECT-LOG entry conventions

Template (copied verbatim from the bottom of PROJECT-LOG.md; paste your entry ABOVE the most recent one):

```
## [YYYY-MM-DD HH:MM] Short title of what changed
By: Claude Code | Cowork | Dylan
Changed: One or two sentences on what was actually modified.
Why: The reason. Tie to a goal or fix.
Files touched: comma-separated list
Next steps: What should happen next, if anything.
Handoff to Cowork: Specific actions needed, or "None"
Handoff to Dylan: Specific actions needed, or "None"

---
```

Conventions the live entries follow beyond the template:

- Header format in practice is `## [2026-09-02 MST] Title`, with `By:` on its own line. Codex writes `By: Codex`.
- Numbered bold sections per item when a session shipped several things ("**1. ...**", "**2. ...**"), each with root cause, fix, and what was verified.
- Commit SHAs listed in a `Commits:` line or inside "Files touched".
- "Verified:" line naming the exact checks run.
- Both handoff lines always present, even when "None".
- A correction never edits an old entry; it is a new entry referencing the old one by date and title.
- Cowork entries begin "Cowork: ..." in the title and describe external artifacts (Google Doc IDs, sheet cells, Supabase rows) precisely enough that the next reader can find them.

The log is the project's memory. Every agent reads only the top three entries at startup, which means anything you leave open in a handoff section scrolls out of sight within about two days at Dylan's build pace. Section 16 covers what to do about that.

---

## 11. Cowork's project instructions (so you know what the operator on the other side is bound by)

Dylan's Cowork project for this repo is called "TopCoat CRM". For this repository, Dylan's 2026-09-09 standing push authorization supersedes the former push-confirmation requirement. Its instructions, condensed with that correction:

- Startup: read CLAUDE.md and the 3 most recent PROJECT-LOG entries; confirm in the first reply, in one sentence, what the most recent entry was and the project's current state; then do the task.
- Reference files instead of searching: `SCHEMA.md` for every table and column (if SCHEMA.md and reality disagree, trust the live schema and flag the drift in the log entry); `features.json` for where things live; never read `index.html` or the log end to end; check `res.error` on empty supabase-js reads.
- Do exactly what the task says, no scope expansion. If unclear or in conflict with CLAUDE.md or recent entries, stop and ask.
- STOP and confirm with Dylan before: sending any email or external communication; modifying any Google Sheet listed in CLAUDE.md; making any payment, purchase, or financial action; deleting files. Routine pushes of tested, user-requested changes to `origin/main` have Dylan's standing authorization (2026-09-09) and need no per-push confirmation; verify the live deployment.
- Logging: append a `By: Cowork` entry at the TOP of PROJECT-LOG.md after every task, including errors and early stops.
- Commits: stage specific files (never `git add .`), commit as `cowork: <short description>`. Never commit secrets.
- Style: no em dashes in anything customer-facing.
- For CRM data (booked jobs, schedule, revenue) pull through the Topcoat MCP connector, not the dashboard or Sheets via a browser.
- Before writing a build prompt from an issue or bug Dylan brings, ask a minimum of 10 multiple-choice questions that close real gaps (not ones CLAUDE.md, SCHEMA.md, or the recent log already answer).

Cowork's cloud-sandbox git quirk (Section 15 has the full procedure): the repo is a read-write mount that blocks unlink/rename, so every Cowork git command strands `.git/index.lock`, `.git/HEAD.lock`, and `tmp_obj_*` files. The commit still lands. Cowork moves the debris into `_to_delete/` as its final action. If you find a stale `.git/index.lock` at session start and `git add` fails with exit 128 "File exists", that is why; delete the lock (you can, Cowork cannot).

---

## 12. The Obsidian HQ vault

Path: `/Users/dylannordby/Desktop/HQ`. An Obsidian vault (Obsidian Sync) that is Dylan's business knowledge base. **From this project it is read-only reference.** Never write into it from a coding session. Cowork projects write into it under the routing rules in `06 - Automations & Tech/Active Automations/Cowork Output Standards.md`.

The vault itself is NOT a git repo. One subfolder is:

- `SOP Hub/` is a git checkout of `Dnordby50/hq-sops` (the SOP library for both companies: `PEC/`, `FTP/`, `Shared/`, `TRAINING/`, `_INBOX/`, `_REVIEW/`, `_LOGS/`). The Obsidian Git plugin is configured with `basePath: "SOP Hub"`, auto-commit every 10 minutes with message `vault backup: {{date}}`, auto-pull every 10 minutes and on boot, merge sync. A Google Drive mirror of the SOP folder exists (folder ID `1P8eAxJzIpQEb1mAXpGm7RSEuk9ASLCao`). The dashboard's SOPS tab shell exists but is not wired to this repo yet (open item since April). `SOP-Hub/` (with a hyphen) is a stray folder holding one NotebookLM log; ignore it. The last commit in `SOP Hub` is dated 2026-04-14, so the auto-sync has not been landing commits for months; treat the GitHub copy as stale.

Top-level layout:

| Folder | Contents |
|---|---|
| `00 - HQ/` | `Master Context.md` (the single source of truth about the businesses, the Google Sheets Registry, and the Sheet Automation Map; last substantively updated May 2026, so people facts are stale: it still lists Aron as PEC salesperson), `Home.md`, `Open Loops.md`, `Weekly Review.md`, `Dylan Voice and Tone.md`, daily briefings (March to May 2026, the pre-TopCoat Cowork briefing era). |
| `01 - Prescott Epoxy/` | `_PEC Overview.md`, Legal, Operations, Portal Project, Projects, Sales, meeting slide decks, warranty PDF. |
| `01 - Sales & Marketing/` | PEC sales material (the `PEC-SALES-NNN -- Title` filing convention). |
| `02 - FTP/` | `_FTP Overview.md`, Doug coaching log, Operations, Projects, Sales. |
| `03 - People & HR/` | Handbook, agreements, role charters (Dusty/Anne office roles, Kyle path to PM, Anne VA onboarding), team folder. |
| `04 - Finance/` | Job Costing, Monthly P&L, CFO dashboard, the Job Costing Master xlsx. |
| `05 - Marketing/` | Per-brand marketing, logo mockups, magazine ad. |
| `06 - Automations & Tech/` | `Active Automations/` (Apps Script sources for the Sheets bridge, Drive bridge, and Job Costing Watchdog; Cowork VA instructions; Cowork Output Standards; SOP capture rule; escalation log; setup notes for gspread and Zapier email AI step), `Skills/` (packaged `.skill` files: `pec-work-order`, `pec-order-sheet` (retired 2026-07-09, materials live in TopCoat now), `operations.plugin`, `ftp-standup-intake`), `Tools & Integrations/` (DripJobs, Protiv (cut 2026-04-10), Gmail, Outlook, Claude API prompt library, Cowork use cases), `Dashboard Pending Rows/`. |
| `07 - Coaching & MBP/` | Coaching log, MBP framework overview. |
| `08 - Templates/`, `09 - Inbox/` | Templates and unsorted intake. |
| Root files | `COACH-PROJECT-INSTRUCTIONS.md`, `COACH-LOG.md`, `RADAR-PROJECT-INSTRUCTIONS.md`, `RADAR-SIGNALS.md`, PEC team-meeting notes, and ~40 historical `claude-code-prompt-*.md` build prompts from May to July 2026 (the repo's `docs/archive/prompts/` is the canonical copy of the numbered ones; these are Cowork's working copies). |

When a task needs business context (how a process works, what a role owns, what a sheet is for), search the vault before asking Dylan. `Master Context.md` and the two `_Overview.md` files are the starting points. Treat any people or tooling fact older than August 2026 as possibly stale and confirm against PROJECT-LOG or the live database.

---

## 13. The operations layer around the code

You will meet these systems through the data they leave in Supabase and Google Sheets. Know what they are so you do not build a second one.

**Cowork VA (the original back-office agent, instructions dated 2026-03-30).** Pre-TopCoat, Cowork ran a set of projects (Daily Summary, PEC Sales Engine, Back End Office, CFO, PM for PEC, SOP Hub) that pulled from DripJobs and wrote into Google Sheets via Chrome, reporting to Dylan on Slack. Rules that still shape expectations: bias toward action; every task produces or refines an SOP; report only to Dylan, only via Slack, under 5 lines; flag rather than guess on financial or scheduling data; never delete source data. Most of the sheet-writing side has been superseded by TopCoat (order sheet retired 2026-07-09, job costing lives in `pec_prod_job_costing`, KPIs in the dashboard), but the sheets still exist and some are still Zapier-fed.

**Business Coach (claude.ai project).** Strategy only. Judges every recommendation against three goals in order: profit and owner take-home, owner independence, enterprise value. Explicitly out of scope: anything technical about the CRM build. Pulls numbers through the Topcoat MCP connector first, Supabase second. Keeps `COACH-LOG.md` in the vault. If a coding task originates from a coaching decision, the log entry there is the "why".

**Business Radar (claude.ai project, started 2026-08-18).** Early-warning monitoring across phone (Quo), CRM (TopCoat), and email. Reads Supabase directly (`pec_call_log`, `pec_sms_log`, leads, estimates, jobs, AR) and the Topcoat connector; writes findings to `pec_radar_alerts` (one row per finding, unique `dedupe_key`, status open/acked/resolved/muted) and appends weekly trend entries to `RADAR-SIGNALS.md`. Twelve `radar_*` settings keys hold its thresholds (Settings > Radar). Scheduled: morning brief weekdays 6:30 AM, pulse every 2 hours 9 to 5, weekly trend Monday 7 AM, all Phoenix time. Radar finds; the coach decides. If you touch `pec_call_log`, `pec_sms_log`, or the AR view, Radar is a downstream consumer.

**Google Sheets still in play** (full registry with IDs in `Master Context.md`; the three in CLAUDE.md are below in Section 14):

| Sheet | Role today | Access |
|---|---|---|
| Booked Jobs Tracker | Zapier-fed from DripJobs; read by `mcp.cjs` `get_schedule` / `get_sales_summary` through an Apps Script proxy. Doug Commission tab is hand-edited. | Read-only except Doug Commission |
| Dashboard Data | Historical Cowork output sink (DailySummary, SalesEngine, BackEndOffice, CFO, PMforPEC tabs). | Append-only |
| MBP 2026 | BTA Academy coaching template, 52+ tabs. Marketing Plan tab col M gets monthly spend (the `mbp-marketing-update` Cowork skill). JCC Pipeline tab is historical only. | Protected; write only to tabs you are told to |
| Job Costing Master | Replaced Protiv 2026-04-10. Largely superseded by TopCoat job costing. | Read-write (legacy) |
| Customer Communications | Quo transcripts and SMS via Zapier. Superseded by `pec_call_log` / `pec_sms_log`. | Read-only |
| PEC Order Sheet, Epoxy Price List | Retired 2026-07-09; materials and ordering live in TopCoat. | Do not write |
| On Site Referrals, Claude-Zapier Emails, FTP Daily Progress Tracker | Form- or Zapier-fed. | Read-only |

Rules Dylan set for every sheet: never guess a Sheet ID; respect the access column (writing to a Zapier-fed sheet breaks the automation); MBP 2026 is protected; append-only means append-only; read the tab structure before writing; register any new automation in the Sheet Automation Map in `Master Context.md`. Cowork must confirm with Dylan before modifying any sheet listed in CLAUDE.md. Extend that to yourself.

**Apps Script deployments** (sources in the vault's `Active Automations/`): the Sheets bridge proxy that `mcp.cjs` and `sheets-proxy.cjs` call (`https://script.google.com/macros/s/AKfycbx...` in `mcp.cjs`), a Drive bridge, and the Job Costing Watchdog (daily 7 AM trigger). If a Sheets read breaks, the proxy deployment is the first suspect.

**Slack.** `#epoxysales` (`C09AZE8CU0Z`) receives lead alerts, accept celebrations, and the follow-up digest. Office notifications go to a second webhook. Anne (remote VA) and Dusty (office manager, both companies) work from these and from the dashboard's Ops Queue.

**People you will see in data and settings:** Dylan (owner, currently the only active PEC sales rep since 2026-08-12), Dusty Wilson (office manager, both companies, inbound leads, scheduling, payroll), Anne (remote VA / admin), Doug (FTP sales and PM, effectively runs FTP), Kyle (PEC crew lead moving into production manager), Justin (lead installer), Davey and Silas (installers), Landen (special projects). Aron Bronson was the PEC salesperson until 2026-08-12; his Google connection must never be reconnected, his row is `active=false`, and his old Quo line `+19284931922` is now Dylan's PEC line (mapped in `quo_number_brand_map`).

---

## 14. Key resource IDs (do not modify without explicit permission)

- Supabase project: `zdfpzmmrgotynrwkeakd`
- Netlify site: `https://prescottepoxy.netlify.app` (`hq-prescott.netlify.app` redirects to it)
- GitHub: `Dnordby50/hq-dashboard` (this repo), `Dnordby50/hq-sops` (SOP Hub)
- Booked Jobs Sheet: `1oNMMiuPmtrmu-x9Vxcy4kz0xxzQV00WNCGvk35rGLr4`
- Dashboard Data Sheet: `1445T0CPavFCWEj2soegc599nCZrbWLgDsCnjQGChI74`
- MBP 2026 Sheet: `1vlumbi2mh_mjtmO1ZiTxMy0BTXbtNCNV-FOM-LVZ_s0`
- Job Costing Master Sheet: `1cb2QZLgK-wWQOX1bzB8SBv3RN6e-FXTEbI7AFfAr1HQ`
- SOP Google Drive folder: `1P8eAxJzIpQEb1mAXpGm7RSEuk9ASLCao`
- Slack `#epoxysales`: `C09AZE8CU0Z`
- Meta Lead Ads Zap: `373273604` (Page Prescott Epoxy Company, Form = Any Form)
- Obsidian vault: `/Users/dylannordby/Desktop/HQ` (read-only from here)

---

## 15. Coordination contract: Codex alongside Claude Code

Two coding agents on one `main` with no branches, no CI, and a shared append-only log is workable only if both follow the same mechanical rules. These are additive to Section 6.

1. **One agent per task.** Dylan hands a prompt or bug to exactly one agent. If you find uncommitted changes in the working tree that you did not make, stop and ask Dylan whether another session is live. Do not commit, stash, or revert someone else's work.

2. **`git status -sb` first, every time.** Note `[ahead N]`, note untracked files, note lock files. Report all three in your first reply.

3. **Number build prompts from git HEAD at write time, not from a listing taken earlier.** On 2026-08-19 two sessions both claimed prompt 99 and one had to be renumbered to 101/102 with every internal reference fixed. Run `ls claude-code-prompt-* docs/archive/prompts/ | sort -V | tail -3` and `git log --oneline -5` immediately before naming a file, and again before committing. Highest at HEAD: 102.

4. **Log identity is the coordination signal.** Write `By: Codex`. Never write `By: Claude Code`. The next agent's startup read of three entries is how it learns you were here.

5. **Publish tested requested changes without per-push confirmation.** Dylan gave standing authorization on 2026-09-09. Push to `origin/main` after required checks pass and verify the live deployment, unless Dylan explicitly asks to hold publication. Keep shared history intact and use revert commits for rollback. If `main` is behind origin, `git pull --ff-only` only; if that fails, stop and tell Dylan rather than merging.

6. **Lock files.** If `.git/index.lock` or `.git/HEAD.lock` exists at session start and no git process is running, it is Cowork's debris (Section 11). Delete it and say so in your reply. Never leave one behind yourself.

7. **Do not edit CLAUDE.md, AGENTS.md, `.claude/settings*.json`, or `netlify.toml`'s omit list without an explicit instruction from Dylan.** These are the shared contract. A rule change is a Dylan decision, logged as `By: Dylan` or with his name in the entry.

8. **Tool parity is not guaranteed.** Claude Code applies migrations through the Supabase MCP and regenerates SCHEMA.md from `list_tables`. If your session does not have equivalent access, a migration is a Cowork handoff, and per Section 16 the session ENDS on that block with the printed prompt. Do not write "applied" in a log entry for a migration you did not apply, and do not write "Refreshed ... from the live schema" in SCHEMA.md if you derived it from the migration file. Say which.

9. **Do not re-diagnose what the log says shipped without checking prod first.** A feature that is in the log, in `features.json`, and in `help/whats-new.json` but not in prod is an unpushed commit, not a missing feature.

10. **Same verification bar.** `npm test`, `node --check`, the script-block parse check, JSON reloads. Log the exact checks. Claude Code's entries are the reference for the expected level of detail; match it.

11. **Cowork prompts you print are indistinguishable from Claude Code's.** Same format (Section 8), same self-containment. Cowork does not know or care which agent wrote it, so do not reference "my session" or "above".

12. **When in doubt about whose lane something is, say so in the reply and stop.** The cost of asking is one message. The cost of two agents shipping overlapping fixes to a 3 MB single file is an afternoon.

---

## 16. Scar tissue: traps that have already cost real time

Each of these is recorded in Cowork's project memory or a log entry. They are stated as rules because they were learned the expensive way.

**Process traps**

- **Handoff sections die silently.** Nothing consumes a `## Handoff to Cowork` section. As of 2026-08-08 three migrations had been stranded, one since 08-05, two with their code already in prod. When asked "what's open", query prod for each claimed artifact (information_schema, `settings` keys, the Schema Drift panel) and diff `git log` against log entries; do not re-read handoff sections. When a migration might be blocked, gate everything on it and END the session on the block with a printed Cowork prompt.
- **A pushed commit is not a shipped feature.** Verify: log entry exists, What's New entry exists, migration applied, prod bundle contains the change.
- **Check before building.** 3 of 9 requests on 2026-08-16 were already shipped. Run the audit with parallel searches over `index.html`, `features.json`, `SCHEMA.md`, plus live data queries. Open the reply with what already exists.
- **Oversized prompts ship ~60% and strand the rest.** Nine requests become three themed prompts, not one.
- **Count what a derived-beats-stored rule will silently rewrite BEFORE the build.** Prompt 56 moved 34 finalized jobs' GP by $4,785 because a derived labor cost overrode typed values.
- **Never trust a migration file's own "Applied to PROD" comment.** Prompt 75's said applied; it was not.
- **Cowork's commits land despite unlink warnings.** Exit 128 "Unable to create index.lock: File exists" means blocked and nothing happened; unlink warnings plus a `[main <sha>]` line means it worked.

**Code and schema traps**

- **Two modal roots.** `#pecModalRoot` (via `openModal()`/`closeModal()`) and `#prodModalRoot` (hand-rolled inline flows in production and catalog views). Same `.pec-modal-bg` CSS, no shared JS. Any modal-lifecycle fix applies to both or is explicitly justified for skipping one. A CSS-only fix covers both automatically.
- **Two parallel job tables.** `public.jobs` (with `customers`, read by the Jobs page `renderJobs`) and `public.pec_prod_jobs` (with `pec_prod_job_schedule_days`, `pec_prod_crews`, `pec_prod_areas`, read by the Job Schedule `renderSchedule` / `loadScheduleData`). Siblings, not duplicates. The DripJobs accepted webhook writes both; manual "+ Add Job" entries write only `pec_prod_jobs` with `dripjobs_deal_id` null and `proposal_number` prefixed `MANUAL-`. `pec_prod_jobs.crm_job_id` (prompt 91) is the explicit pairing, top rung of `resolveCrmForProdJob`. `jobs.price` and `pec_prod_jobs.revenue` never sync; costing reads price.
- **The supabase-js "wedge" is an auth-lock problem.** Diagnosed live 2026-05-31: a custom no-op lock let GoTrue's `lockAcquired` strand true and every later call queued forever with zero network requests. Fix: default `navigator.locks` lock plus `timedFetch` (hard 8s abort on `/auth/v1/`). Keep `timedFetch`; never reinstate a non-exclusive lock; if the wedge returns, prefer a short-hold custom lock over a no-op. Recovery paths in place: `recoverWedgedClient()`, `withFreshSession` (reads, 10s refresh-retry), `withDeadline` (non-idempotent writes, no retry), `withFreshWriteRetry` (idempotent writes only), the payment recover-verify-retry, the visibilitychange idle probe, the 15s render fence. **Never wrap a non-idempotent write (payment insert, change order) in a blind auto-retry.**
- **Module vs classic script scope.** `index.html` has both module and classic `<script>` blocks. Module consts are invisible to classic blocks ("X is not defined"). Share through `window.pecState`.
- **`material_type` is CHECK-constrained** on `products`, `recipe_slots`, and `material_lines`. A new category is a migration extending all three, not a free-text value.
- **Never activate or repoint a `pec_prod_system_type` without checking `pec_prod_recipe_slots`.** Zero slots means no material cost and a broken GP.
- **A null `touchup_cause` vanishes from the breakdown.** Fill it; 60% of rework was crew workmanship once filled. `scheduled` touch-ups can carry past dates.
- **Ordering rows lie.** The ordering row's SYSTEM/SQFT read `pec_prod_areas` while the chip reads the CRM card; the order sheet also needs its checkbox ticked.
- **The estimator upserts `estimates.status` from an open-time snapshot** and can clobber sent back to draft; item-loop send gates pass an empty estimate. The estimator owns no status.
- **Estimator stale bundle.** The PWA precaches its JS for a whole session. "Still missing on my phone" means curl the live bundle first; one stale bundle can look like two bugs.
- **Referrer-restricted browser keys cannot serve Netlify functions.** The Routes API uses a separate server key (`GOOGLE_ROUTES_API_KEY`). Prove a fail-open feature is off via `pec_drive_time_cache`, not by hitting the endpoint. Flight events on a synced calendar poison drive-time math.
- **Google Calendar pull stall.** Events missing from the schedule: check `pec_heartbeats` and null `sync_token` first; the pull full-syncs calendar 1 forever and starves the rest.
- **Routemize (retired) update envelope.** `newStartTime`/`newEndTime`, bare datetimes are UTC, a bail-out dropped the whole update and returned a silent 200. Kept here because `pec-appt-intake.cjs` still carries the code.
- **X-Frame-Options DENY broke every same-origin iframe** for a week in July. Any header change gets an iframe check.
- **Adding a lead stage touches 5 hardcoded stage lists** and `contacted_at` must still be stamped.
- **`customer_notes` rides every appointment text and email.** Internal-only content goes in `notes`.
- **Change-order materials are additive and non-idempotent** (`pushChangeOrderMaterialsToProd`). Never re-push; edits and deletes tell the operator to adjust the order sheet by hand. All CO writes are CAS `.eq('status','pending')`; the customer wins every race.
- **The migration manifest is committed.** `scripts/build-migration-manifest.mjs` output (`_migration-manifest.json`) is deterministic and committed so local function runs work; it changes only when a migration file does.

---

## 17. State of the project on 2026-09-07, and honest weaknesses

**Open right now**

- `main` is `[ahead 2]` of origin: Cowork's two 2026-09-02 commits (Meta Lead Ads agency guide log entries) are unpushed. Prod was not affected (docs only). This is a historical 2026-09-07 snapshot, not a current publication instruction; see the standing agent-push authorization added 2026-09-09.
- Prompts 101 (TopCoat booking, replacing Routemize) and 102 (visual form builder) were written 2026-08-19 and both shipped by 2026-08-20 (`pec-booking.cjs`, `pec_booking_*` tables, `pec_drive_time_cache`, the "Online booking" feature entry). 102's Part C (the FTP form) was skipped by Dylan's call and remains open. The two prompt files still sit at the repo root because they are the live specs; they will move to `docs/archive/prompts/` on the next sweep.
- Custom domain deferred since 2026-08-09.
- Angi to Zapier intake built but unpublished, blocked on Angi firing one payload (2026-08-21).
- The dashboard's SOPS tab is a shell; `hq-sops` is not wired in, and the `SOP Hub` git checkout has not committed since 2026-04-14 despite the plugin's 10-minute schedule.
- `Master Context.md` in the vault still lists Aron as PEC's salesperson and the Classic/Signature/Showroom tiers. Both retired. Anyone reading the vault for people facts gets a wrong answer until it is updated.

**Weaknesses in the setup itself, stated plainly because a new agent will otherwise inherit them as if they were intentional**

1. **No CI, no branches, no preview deploys.** Every commit to `main` is a production deploy on push. Two agents make the odds of a red build higher. The cheapest fix is a Netlify build check on a `codex/*` or `cc/*` branch with deploy previews; the workflow above assumes it does not exist because it does not.
2. **The 3-entry startup read is the whole memory model.** It works at one agent's pace and already failed at Dylan's (Section 16, stranded handoffs). A second agent doubles the entry rate, which halves how long anything stays visible. The repo already has the fix half-built: the Schema Drift panel knows about unapplied migrations. An "open handoffs" list that is machine-readable (a JSON file or a `## Open handoffs` block at the top of the log that entries consume) would close the rest. Until then, Section 15 rule 9 and Section 16's "query prod, not the log" are the mitigation.
3. **A 3 MB single-file frontend with two script scopes and two modal roots.** Not a critique of the choice; a statement of the blast radius. Every UI change is a merge hazard between two agents. One agent per task is not optional.
4. **SCHEMA.md is hand-refreshed and has drifted before** (settings counts documented 105, live 118; documented 98, live 105). The drift checker verifies migrations, not the document. A generated SCHEMA.md from `list_tables` on a schedule would remove the class of bug that rule 9 exists for.
5. **Migration files are named by a date that is not the applied date** and run ahead of the calendar (files dated 2026-09-16 through 09-20 were applied in late August). Sorting by filename does not give you application order. The log and the drift panel do.
6. **The SOP Hub remote URL embeds a GitHub personal access token in plain text** in `SOP Hub/.git/config`. That token is in a file Obsidian Sync replicates and any process on the machine can read. It should be revoked and the remote switched to SSH or a credential helper. Not included in this document.
7. **Cowork's git debris in `_to_delete/`** is a manual chore for Dylan and a startup hazard for everyone else. Section 15 rule 6 is the workaround, not a fix.
8. **`Master Context.md` is the vault's declared source of truth and is four months stale on people.** The coding agents do not read it, which is why the drift went unnoticed. Either it gets a maintenance owner or the "single source of truth" line at its top should be removed so nobody trusts it.

---

## Appendix A: glossary

- **TopCoat**: the product name for the platform in this repo. **HQ Dashboard**: its older name, still the repo and site name.
- **ARM 1/2/3**: dashboard / customer portal / CRM phases.
- **PEC / FTP**: the two brands; most tables and settings carry a `brand` column or are PEC-only by design.
- **Prompt NNN**: a numbered build spec written by Cowork or chat Claude for the coding agent. Log entries and memory files reference features by prompt number.
- **Handoff**: a task packaged for Cowork or Dylan because the coding session cannot do it.
- **What's New**: `help/whats-new.json`, the user-facing changelog.
- **Drift panel / drift checker**: `pec-migration-drift.cjs` plus the Settings UI that shows unapplied migration artifacts.
- **Wedge**: the supabase-js auth-lock hang, Section 16.
- **MBP**: Monthly Business Performance, the coaching framework (BTA Academy).
- **Ops Queue**: the dashboard's admin work queue (built for Anne), fed by derived checks with `ops_*` settings keys.
- **Radar**: the Business Radar monitoring project; `pec_radar_alerts`, `radar_*` settings.
- **Quo**: the phone system (was OpenPhone; env var names still say OPENPHONE in places).
- **Cowork**: Anthropic's desktop agent, Dylan's operator. **Cowork VA**: the older name for its back-office role.

## Appendix B: the one-page checklist

Before: read AGENTS.md / CLAUDE.md; top 3 log entries; `git status -sb`; confirm state in one sentence; open the `features.json` entry and `SCHEMA.md` section for the task.

During: check before building; small commits `<area>: <what>`; `@artifacts` on migrations; rule 14 rehearsal on money/auth/status; settings surface for every feature; no em dashes customer-facing; secrets stay in env.

After: `npm test`; `node --check`; script-block parse check; JSON reloads; `features.json`; `help/whats-new.json`; `SCHEMA.md`; log entry at the top with `By: Codex`, both handoff lines, verified line, commit SHAs; stage specific files; commit and push tested requested changes without per-push confirmation; verify the live deployment; report real blockers or pending commits; print any Cowork prompt in the Section 8 format.

Never: read the 3 MB files wholesale; guess a column; write to the vault; touch `estimator/`; blind-retry a non-idempotent write; edit the shared contract files without Dylan; claim a migration applied that you did not apply.
