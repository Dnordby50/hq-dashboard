# TopCoat: shared agent contract

Canonical rules for Codex, Claude Code, and Cowork. Dylan's current instructions and accepted decisions take precedence. `CLAUDE.md` imports this file; keep one contract, not parallel copies. Updated 2026-09-14 under the authorized security/context cleanup.

## Start narrowly

1. Read this contract and `docs/product-charter.md` once per task. Run `node scripts/context-packet.mjs --feature "<feature>"` for current git state, locks, three recent log summaries, and relevant feature anchors. Read a full relevant log entry when the summary omits a needed fact. Do not load the historical CODEX handover routinely.
2. Report the current state and latest work briefly. Inspect uncommitted changes, ahead/behind status, untracked files, and `.git/*.lock`. Preserve work owned by another session. Coordinate ownership or use an isolated worktree before overlapping edits; read-only investigation can continue.
3. Consult the relevant `features.json` entry before searching `index.html`, and the relevant `SCHEMA.md` section before any SQL or supabase-js select. Verify live evidence when migration/deployment state matters. Check what already exists before building.
4. Do the authorized task. Ask only for material missing decisions; do not use a quota of questions. Keep the outcome, acceptance criteria, must-preserve behavior, and next step in the current task, using the packet format in `docs/agent-context.md`. Do not write task state into that shared guide.

## Build boundaries

- Serve PEC/FTP operations and owner independence. Preserve essential visible summaries and existing workflows. A substantial redesign needs a concrete preview and approval before production implementation.
- Every major feature has human-tunable settings for its operating parameters. At most two frequently used controls sit front-of-card; others go under Advanced. App state, caches, and secrets are not settings.
- Enforce permissions, record ownership, status transitions, financial rules, and booking availability on the server/database write path. Do not rely on hidden controls. Preserve drafts even when sending is blocked.
- Never blind-retry a non-idempotent write. Verify whether the first payment/change order landed before retrying. Preserve manual financial inputs, original owner source documents, separate yearly records, and revision conflicts.
- Never delete records based only on a missing external integration ID. Cleanup requires verified provenance, a reviewed dry-run affected-record list, and authorization. One-off backfills are idempotent and support `--dry-run`; obtain explicit authorization before the live run.
- Edit estimator source in `apps/estimator`, then rebuild; never hand-edit `estimator/` output. Use the module invariants in `docs/engineering-workflow.md` when touching auth, jobs, modals, money, calendars, or estimates.
- No em dashes in customer-facing estimates, invoices, scopes, portals, email, SMS, help, or What's New.

## Data, secrets, and authority

- Keep credentials in deployment environment variables, never source, logs, prompts, or `.env` commits. The existing browser Google-key exception requires referrer/API restrictions and the matching secret-scan omit entry; server calls need a separate server credential. Do not expand omit lists to suppress real secrets.
- Do not edit this contract, the CLAUDE adapter, `.claude/settings*.json`, or the Netlify secret-scan omit list without Dylan's explicit instruction. Existing authorization persists; do not ask again for actions already authorized.
- The Obsidian HQ vault is read-only reference from this project. Do not modify protected Google Sheets, send external messages, make payments/purchases, or perform destructive actions without explicit authorization for that action. Use available tools directly for authorized work; hand off only an actual access/input blocker.
- Every migration starts with an `@artifacts` header. Rehearse money, auth/RLS/SECURITY DEFINER, and `estimates.status` changes before production. Prefer an isolated database; document a rolled-back production rehearsal if that is the available approved fallback. Apply and verify migrations before dependent code ships; never claim an unapplied migration is live. Refresh the relevant schema sections from verified evidence.

## Verify and release

- Run `npm test` including posttest; `node --check` every touched `.cjs`; compare dashboard script parse results with HEAD; parse changed manifests; run `git diff --check`. Build the estimator when its source changes. Validate affected UI behavior using synthetic fixtures, including 360px mobile when relevant. Log the exact checks, not assumed results.
- Commit meaningful changes as `<area>: <what changed>`, staging specific files. Prepend a new `PROJECT-LOG.md` entry with the correct `By:` identity; never edit/delete past entries. Update affected feature/schema references. Every user-facing change gets a plain-language `help/whats-new.json` entry; internal-only work does not.
- Dylan authorizes tested, requested changes to be committed and pushed to `origin/main` without per-push confirmation, then verified live. Honor a publication hold. Keep shared history intact; rollback through a revert. Pull fast-forward only; stop integration and report divergence.
- One integration/release owner per task. Delegate bounded independent work with explicit files. Recheck git/prompt numbering immediately before naming a numbered build spec and before committing. Remove a stale git lock only after confirming no live git process owns it; report removal.
- A release needs code, required migrations, tests, and live deployment verification. If access blocks completion, record the blocker and print a self-contained Cowork/Dylan handoff using `.claude/skills/handoff/SKILL.md`. Do not strand dependent production code behind a buried handoff.

Detailed migration syntax, test commands, pitfalls, and handoff format: `docs/engineering-workflow.md`. Historical reference: `CODEX-HANDOVER.md`. Internal rules, logs, schemas, migrations, task packets, and audits must never be included in public site assets.
