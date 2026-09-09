# AGENTS.md: TopCoat / HQ-Dashboard

This file is the entry point for GPT Codex (and any non-Claude coding agent) working in this repo. It carries the same standing rules as `CLAUDE.md`, which remains the canonical wording. If the two ever disagree, `CLAUDE.md` wins and the disagreement is a bug to report to Dylan.

The full operating picture (who the other agents are, infrastructure, the session loop, the Obsidian vault, the multi-agent contract, and the list of traps that have already cost time) is in **`CODEX-HANDOVER.md`** at the repo root. Read it once in full. Then use this file as the per-session checklist.

## Startup, every session

1. Read this file and `CLAUDE.md`.
2. Read the top 3 entries of `PROJECT-LOG.md` (`awk '/^## /{n++} n<=3' PROJECT-LOG.md`). Never read the file end to end.
3. `git status -sb`. Report `[ahead N]`, untracked files, and any `.git/*.lock` in your first reply.
4. Confirm in one sentence what the most recent log entry was and the project's current state.
5. Open the relevant `features.json` entry before grepping `index.html`, and the relevant `SCHEMA.md` section before writing any SQL or supabase-js select.
6. Do exactly the task. No scope expansion. If the task is unclear or conflicts with `CLAUDE.md` or a recent log entry, stop and ask.

## Standing rules (summary; full text in CLAUDE.md)

1. Commit after every meaningful change: `<area>: <what changed>`. Stage specific files, never `git add .`. Never commit secrets or `.env` files.
2. Append a PROJECT-LOG.md entry at the TOP after every meaningful change, using the template at the bottom of that file. `By: Codex`.
3. Never delete or edit past log entries. Corrections are new entries.
4. Read CLAUDE.md and the last 3 log entries before any task.
5. Flag handoffs explicitly: `## Handoff to Cowork` / `## Handoff to Dylan` in the log entry, plus a self-contained Cowork prompt printed in chat (format in CLAUDE.md and `.claude/skills/handoff/SKILL.md`).
6. No em dashes in anything customer-facing (estimates, invoices, scope text, portal pages, emails, SMS, What's New, help content).
7. Secrets stay in Netlify env vars. Placeholder in code plus a Handoff to Dylan. Exception: referrer-restricted client-side Google keys, which must also be in `SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES` in `netlify.toml`.
8. Default to a Cowork handoff for inputs and verifications, not direct questions to Dylan. Ask Dylan directly only when the session is blocked on a binary architectural choice.
9. `features.json` before grepping; `SCHEMA.md` before any SQL. Refresh SCHEMA.md after migrations; update features.json when a feature changes.
10. Token discipline: never read `index.html`, `PROJECT-LOG.md`, or `PROJECT-LOG-ARCHIVE.md` wholesale.
11. Every user-facing change gets a `help/whats-new.json` entry in the same session.
12. Every major feature gets a settings surface in the `settings` table: at most two controls front-of-card, the rest behind Advanced; state and caches are never settings.
13. Every migration starts with an `@artifacts` header (`table:`, `column:`, `index:`, `setting:`, or `none: <reason>`).
14. Migrations touching money tables, auth, or `estimates.status` rehearse on a branch (or a rolled-back prod transaction, stated in the log) before prod.

## Multi-agent contract (Codex alongside Claude Code)

- One agent per task. Uncommitted changes you did not make mean another session may be live: stop and ask.
- Number build prompts from `git log` and the current listing at write time, and re-check before committing. Highest at HEAD on 2026-09-07: 102.
- Dylan authorizes agents to commit and push tested, user-requested changes to `origin/main` without per-push confirmation, then verify the live deployment (updated 2026-09-09). Honor any explicit request to hold publication. Keep shared history intact and use revert commits for rollback. `git pull --ff-only` only; on failure, stop and tell Dylan.
- Stale `.git/index.lock` or `.git/HEAD.lock` with no git process running is Cowork's sandbox debris: delete it and say so.
- Do not edit `CLAUDE.md`, `AGENTS.md`, `.claude/settings*.json`, or the `netlify.toml` omit list without Dylan's explicit instruction.
- If you cannot apply a migration (no Supabase access), the session ends on that block with a printed Cowork prompt. Never log a migration as applied that you did not apply.
- "The fix didn't work" means check `[ahead N]` and the live estimator bundle before re-diagnosing.

## Verification bar

`npm test` green; `node --check` on every touched `.cjs`; per-script-block parse check on `index.html` matching HEAD's failure set; `features.json` and `help/whats-new.json` reload through `JSON.parse`. Log the exact checks you ran.

## Do not touch

`estimator/` (build output), the Obsidian vault at `/Users/dylannordby/Desktop/HQ` (read-only reference), Google Sheets listed in CLAUDE.md (Dylan confirms first), any non-idempotent write wrapped in a blind retry.

## Key resource IDs

- Supabase project `zdfpzmmrgotynrwkeakd`; site `https://prescottepoxy.netlify.app`
- Booked Jobs Sheet `1oNMMiuPmtrmu-x9Vxcy4kz0xxzQV00WNCGvk35rGLr4`
- Dashboard Data Sheet `1445T0CPavFCWEj2soegc599nCZrbWLgDsCnjQGChI74`
- MBP 2026 Sheet `1vlumbi2mh_mjtmO1ZiTxMy0BTXbtNCNV-FOM-LVZ_s0`
- Slack `#epoxysales` `C09AZE8CU0Z`
