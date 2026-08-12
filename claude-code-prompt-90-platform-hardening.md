# Claude Code Prompt 90: platform hardening. The system watches itself, the security surface shrinks, and the money math gets tests.

Run this AFTER the three prompts queued ahead of it (87-89, arriving from Cowork). If one of those already claimed the number 90, renumber this file; the content stands alone. Each task below is its own commit; sessions can stop cleanly between tasks.

## Context

Repo: HQ-Dashboard, branch `main`. Deploy: Netlify, https://prescottepoxy.netlify.app. Supabase project "HQ Dashboard" (ref zdfpzmmrgotynrwkeakd), reachable via the Supabase MCP tools.

This prompt comes out of the 2026-08-11 gaps review (see the PROJECT-LOG entry "Platform gaps review"). The motivating incident: the Google review link was dead FROM LAUNCH until 2026-08-10, silently 302ing every customer to google.com's homepage, and it was caught only because Dylan happened to squint at an email. Nothing in the system would ever have noticed. TopCoat now runs scheduled functions, drips, webhooks, Stripe, and review campaigns with no one watching any of them.

Dylan's standing constraint for this prompt and beyond: he has ADHD and very little time. Route EVERYTHING possible to Cowork or to automation. A task that ends with "Dylan verifies X in a browser" is a design failure if Cowork could verify it instead; a check that needs a human at all is a design failure if a scheduled function could do it. When a handoff is unavoidable, make it one tap or one glance.

Decisions already locked (2026-08-11, do not re-ask):

1. All four tasks are approved. Priority order is A, B, C, D.
2. Leaked-password protection and the backup/PITR verification are COWORK's, already handed off in a separate prompt. Do not block on them and do not redo them; read the PROJECT-LOG for their outcome.
3. The DripJobs bulk proposal import is NOT in this prompt. Check whether prompts 87-89 covered it; if not, it stays the top named item on the backlog and deserves its own prompt.

## Task A: the system heartbeat (biggest win, first commit)

A scheduled Netlify function (daily, morning MST) that checks the machines and files failures where Dylan already looks: the Ops Queue, plus one Slack line.

What it checks, minimum set:

1. **Scheduled functions ran.** Every scheduled .cjs in netlify/functions (enumerate them from netlify.toml at build time or a hardcoded list with a comment to update it) writes a heartbeat row (table or settings-style row, your call; a `pec_heartbeats` table keyed by function name with last_ok_at is the obvious shape) at the end of a successful run. The monitor flags any function whose last_ok_at is older than its cadence plus slack. Instrumenting each scheduled function to write its heartbeat is part of this task; keep the write best-effort (a heartbeat failure must never fail the job, same philosophy as logIngest).
2. **Webhook health.** pec_webhook_ingest_log rows with outcome in ('error','bridge_failed') in the last 24h.
3. **Send failures.** pec_email_log and pec_sms_log rows with a failed status in the last 24h, counted by kind.
4. **The review redirect is alive.** Fetch https://prescottepoxy.netlify.app/r/heartbeat-probe with redirect:'manual' and assert the Location host is google.com or search.google.com. This single check would have caught the dead review link on day one. (The probe token does not exist; that is fine, the function redirects unconditionally by design.)
5. **Stripe webhook freshness.** If pec_stripe_pending has rows stuck 'pending' older than 7 business days, flag them (ACH settles in 3-5).
6. **Public page probes.** GET one known-good public estimate URL shape and the /pay/ shape with a bogus token; assert they return the expected 404-style response, not a 500 (a 500 means the function itself is broken).

How it reports:

- Failures become DERIVED Ops Queue items using the existing derived-check pattern (they self-clear when the underlying condition heals; see the pec_ops_items section of SCHEMA.md for the check_key convention and WHAT THIS TABLE IS NOT). Do not insert rows per-failure-per-day; the derived pattern re-derives at render.
- Plus ONE summary line to Slack #epoxysales (channel id in CLAUDE.md) only when something is failing: "Heartbeat: 2 issues (drip sender stale 3d, 4 SMS failures)". Silence when green. Reuse the existing Slack send path if one exists in netlify/functions (grep for the webhook/chat.postMessage pattern) rather than inventing one.
- Settings keys per rule 12 (front-of-card: on/off and the staleness slack hours; everything else behind Advanced on a new Settings > System health card, which also shows the latest run's results read-only).

## Task B: security hardening from the 2026-08-11 advisor scan

The scan (Supabase MCP get_advisors, security) found: 21 SECURITY DEFINER functions executable by `anon`, 33 by `authenticated`, 4 functions with mutable search_path, 1 RLS-enabled table with no policy, extension in public. No ERRORs.

1. **Audit the 21 anon-executable SECURITY DEFINER functions.** Re-pull the advisor list live (it may have changed). For each function: what it does, who calls it (grep netlify/functions and index.html and the estimator), and the verdict — KEEP (customer-facing token flows genuinely need anon: the /e/ accept path, /pay/, review redirect internals, etc.) or REVOKE from anon. Print the full table in the PROJECT-LOG entry. Then one migration revoking the unjustified ones. Be conservative: a wrong revoke breaks a customer-facing page, so anything uncertain stays KEEP with a note, and the migration is rehearsed per the new rule from Task D if it touches accept/payment paths.
2. **Pin search_path on the 4 mutable functions** (one migration, `SET search_path = public` or the function's actual needs; the revoke-login migration is the in-repo example of doing this right).
3. **The no-policy RLS table and the public extension:** identify them, state whether they matter, fix only if trivial and safe; otherwise log the finding with a recommendation.
4. Re-run get_advisors after; the delta goes in the log entry.

## Task C: the money math gets fixture tests

Inventory index.html for money computations that are NOT yet backed by production/*.cjs exports: payment allocation, AR totals (pec_job_ar consumers aggregate client-side in places), installment math outside the estimate-side module, change-order totals, deposit logic. The established pattern (production/optional-lines.cjs, estimate-installments, calculator.js) is: shared .cjs with the pure rule, fixture tests in production/*.test.js, index.html and functions require the same export so the surfaces can never disagree.

- Extract with NO behavior change; the tests prove parity (fixture the current outputs first, then swap the call sites).
- Prioritize by blast radius: anything that decides what a customer is charged or what AR reports comes first.
- If something is too entangled to extract cleanly in one commit, extract what is clean and log the remainder as named follow-ups rather than forcing it.

## Task D: process + automation, so this stays true without anyone remembering

1. **CLAUDE.md standing rule (add as the next number):** migrations that touch money tables (pec_payments, pec_invoice_installments, jobs price/AR columns), auth (admin_users, user_permissions, anything SECURITY DEFINER), or estimates.status must be rehearsed on a Supabase branch database via MCP (create_branch, apply there, verify, merge or discard) before touching prod. Plain additive columns elsewhere stay direct-to-prod as today.
2. **The weekly TopCoat health report, as a scheduled routine.** Use the /schedule skill in the executing session to create a weekly cloud agent that: runs the migration drift checker, re-pulls Supabase advisors and diffs against the last report, scans the last week of PROJECT-LOG for unresolved `## Handoff to` sections older than 7 days, probes the public URLs from Task A item 6, and posts a SHORT report (10 lines max) plus Ops Queue items for anything red. Dylan should be able to ignore it safely because the Ops Queue catches what matters; reading it is optional. If the scheduled-agent environment cannot reach a needed tool (e.g. MCP auth headless), degrade that check to "skipped, reason" rather than failing the run.

## Guardrails

- Task A's heartbeat writes are best-effort everywhere; observability must never break the thing it observes.
- Task B: no revoke ships without the call-site grep proving nothing anon-reachable uses it; when in doubt, KEEP and log.
- Task C: zero behavior change; if a fixture disagrees with current output, the CURRENT output wins the fixture and the discrepancy is logged as a suspected bug, not silently "fixed".
- No em dashes in customer-facing or Ops-item copy (rule 6).
- Route verification to Cowork, not Dylan, per the standing constraint above.

## Verification

1. npm test green from the repo root after every task (Task C grows the suite; note before/after counts).
2. node --check on every new/touched .cjs; the index.html inline-script parse check matches HEAD's baseline.
3. Task A: trigger the heartbeat function once manually (netlify CLI or a temporary invoke), confirm an induced failure (e.g. point the review-probe assertion at a wrong host in a test invocation) produces the Ops item and the Slack line, then confirm it self-clears.
4. Task B: after the revoke migration, click through one customer estimate accept flow and one /pay/ page on a test token (Cowork if a real sign-off is needed).
5. Task D: confirm the routine's first run arrives and the report reads in under 2 minutes.

## Standing rules for this session

Commit per task (`ops:`, `security:`, `money:`, `process:` prefixes as fits rule 1). PROJECT-LOG entry per task at the TOP, By: Claude Code, each naming what a future reader needs (especially Task B's keep/revoke table and Task C's extraction inventory). What's New entries only where Dylan sees something (the System health Settings card; Ops Queue items). features.json entries for the heartbeat and the health card. Handoffs go to Cowork unless the thing literally requires Dylan.
