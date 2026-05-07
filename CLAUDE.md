# CRM / Dashboard Project — Claude Code Instructions

## Context
This project contains the multi-arm platform for Prescott Epoxy Company (PEC) and Finishing Touch Painting (FTP).

- ARM 1: Production dashboard (live)
- ARM 2: Customer portal (target Q3 2026)
- ARM 3: Custom CRM (2027)

Owner: Dylan Nordby. Other tools touching this project: Cowork (executes manual tasks), chat-based Claude (planning, review). Treat this file and PROJECT-LOG.md as the source of truth for project state.

## Standing Rules

1. Commit after every meaningful change.
   - Format: `<area>: <what changed>` (example: `dashboard: fix Booked Jobs pull for empty rows`)
   - Never commit secrets, API keys, credentials, or .env files.

2. Update PROJECT-LOG.md after every meaningful change.
   - Append a new entry at the TOP of the log (newest first).
   - Use the entry template at the bottom of PROJECT-LOG.md.
   - Write it for a human, not for a machine.

3. Never delete PROJECT-LOG.md entries. Append only. If something was wrong, write a correction entry referencing the original.

4. Before starting any task, read CLAUDE.md and the last 3 entries of PROJECT-LOG.md. This catches anything Cowork or Dylan did between sessions.

5. Flag handoffs explicitly. If a task needs Cowork or Dylan to do something manually (web action, file upload, paste into a sheet, etc.), end your log entry with a `## Handoff to Cowork` or `## Handoff to Dylan` section listing exactly what they need to do.

6. Never use em dashes in any output. Use commas, parentheses, or two sentences instead.

7. Keep secrets out of code. If a credential is needed, put a placeholder in the code and add a Handoff entry asking Dylan to set the env variable.

   Exception: domain-restricted client-side API keys (Google Sheets, Maps, etc.) are by design committed to client code, since the architecture requires the browser to call Google directly. To make this safe: (a) the key MUST be restricted in Google Cloud Console to specific HTTP referrers (the live Netlify domain plus any custom domain) AND restricted to the minimum APIs it needs, and (b) the key value MUST be added to SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES in netlify.toml so the secret scanner allows the deploy. If you rotate one of these keys, update both index.html and netlify.toml in the same commit.

8. Default to Cowork for inputs and verifications, not direct questions to Dylan. When something would otherwise need Dylan to provide a value, verify a result in a third-party UI, run a migration, or perform a manual web action, package it as a Cowork handoff (in the PROJECT-LOG entry AND as a standalone Cowork prompt printed in chat) instead of asking Dylan directly. Cowork has its own asynchronous workflow with Dylan and can collect inputs without interrupting the current Claude Code session.

   Stay direct (still ask Dylan) when this Claude Code session is BLOCKED on a binary architectural choice that fundamentally changes downstream work, or when waiting on Cowork would cost more than the answer is worth (a 1-2 word reply that unblocks 30+ minutes of work). The trigger for direct asking is "this session is stalled until I get this answer", not "this needs Dylan's input eventually". When in doubt, write the Cowork prompt.

## Cowork Handoff Prompt Format

Cowork prompts go to a separate operator with no chat history, no familiarity with the current session's reasoning, and no access to this conversation. They MUST be self-contained. When you write one, print it in chat as a fenced code block in this shape:

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

Rules of thumb: include actual SQL / file snippets when they're short. Point Cowork at the specific commit on `main` so versions don't drift. Never assume Cowork has read PROJECT-LOG; if a past entry matters, paste the relevant line. If a task requires a credential or context Cowork would have to ask Dylan for anyway (which sheet, which Supabase project, which API key), name it explicitly so Cowork can ask Dylan once instead of bouncing back.

## Bug Diagnosis Workflow

When Dylan reports a bug or unexpected behavior, follow this workflow:

1. Diagnose from the code, not from guessing. Read the relevant files, grep for the symptom, identify the most likely root cause(s) with line numbers as evidence. Do not propose a fix until you have read the code.

2. Present findings in this order:
   a. The most likely cause, named in one sentence with the file:line that proves it.
   b. Other plausible causes ranked by likelihood, each with its file:line.
   c. A cheap way for Dylan to confirm which one it is (DevTools check, console command, network tab, log line) before changing code.

3. Default to fixing the bug yourself, in this session. Edit the code, commit per standing rules, log per standing rules. Do NOT produce a Cowork prompt for work you can do directly. Code edits in this repo are not a Cowork handoff.

4. Hand off to Cowork only when the task literally cannot be done from this session, per standing rule 5. That means actions that require something outside Claude Code's reach: clicking around a third-party web UI (DripJobs, Supabase Studio, Netlify dashboard, Google Sheets), uploading a file via a browser, running a migration in prod, pasting a value into a sheet, or running a CLI tool that needs auth this session does not have. When this happens, write a `## Handoff to Cowork` section in the PROJECT-LOG.md entry listing exactly what Cowork needs to do.

5. After fixing, give Dylan a plain-English explanation of the root cause and the fix, written so he learns the underlying concept, not just the patch. Keep it concrete: tie every claim to the actual code in this repo.

## Architecture Gotchas

These are non-obvious shapes of the codebase that have caused bugs. Keep them in mind when touching related code.

- Two modal-root containers, not one. index.html:1781 has `#pecModalRoot` (used by the helpers `openModal()` / `closeModal()` around index.html:4808) and index.html:1782 has `#prodModalRoot` (used by hand-rolled inline modal flows in the production / catalog views around index.html:7531, 7923, 8225, 8369, 8434, 8544). They share the same `.pec-modal-bg` CSS class but no JS. Any fix that touches modal lifecycle (safety nets, focus traps, escape-to-close, etc.) MUST be applied to both roots, or audited and explicitly justified for skipping one.

## Key Resource IDs

- Booked Jobs Sheet: 1oNMMiuPmtrmu-x9Vxcy4kz0xxzQV00WNCGvk35rGLr4
- Dashboard Data Sheet: 1445T0CPavFCWEj2soegc599nCZrbWLgDsCnjQGChI74
- MBP 2026 Sheet: 1vlumbi2mh_mjtmO1ZiTxMy0BTXbtNCNV-FOM-LVZ_s0
- Slack #epoxysales channel: C09AZE8CU0Z

## File Layout

- index.html: Single-file production dashboard (ARM 1). All UI lives here.
- netlify.toml: Netlify build and deploy config.
- netlify/functions/: Serverless endpoints (Netlify Functions).
  - sop-chat.js: SOP chat backend.
  - _pec-supabase.js: Shared Supabase client helper for PEC functions.
  - pec-create-staff.js: Provisions PEC staff records.
  - pec-log-signin.js: Logs PEC staff sign-ins.
  - pec-webhook-proposal-accepted.js: Webhook handler for proposal accepted.
  - pec-webhook-stage-changed.js: Webhook handler for project stage changed.
  - pec-webhook-project-completed.js: Webhook handler for project completed.
- supabase/: Database schema, RLS policies, seed data, migrations, and SETUP.md for the PEC Supabase project.
- .htaccess: Apache rewrites for legacy hosting.
- sync-braindump.sh: Local helper script for braindump sync.
- SETUP.md: Original dashboard setup notes.
- SOP-SETUP.md: SOP backend setup notes.
- coach-log-setup.md: Coach log setup notes.
- CLAUDE.md: This file. Standing rules for Claude Code.
- PROJECT-LOG.md: Append-only history of meaningful changes by Claude Code, Cowork, and Dylan.

## Related but separate
- Obsidian HQ vault: read-only reference for SOPs and context. Never modify from this project.
