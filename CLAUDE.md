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
