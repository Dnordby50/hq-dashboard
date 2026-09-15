# Scoped context and task packets

## Source hierarchy

1. Current user instructions and accepted decisions define the authorized outcome.
2. `AGENTS.md` is the single shared contract; `docs/product-charter.md` defines product boundaries.
3. Current code, live deployment/schema checks, and the task's evidence describe observed state. A live bug does not override the intended behavior.
4. `features.json` routes to relevant functions, files, and tables; use the relevant `SCHEMA.md` section before database work.
5. Project logs, archived prompts, the old handover, and vault notes are dated references. Verify facts that may have changed.

Do not load `index.html`, the full project log/archive, the full feature catalog, or the full schema into an agent conversation. Do not reload unchanged startup documents within a task. Topic-specific engineering guidance is in `docs/engineering-workflow.md`; import it only when needed. Automatically importing every reference would recreate the same context cost.

## Context command

```text
node scripts/context-packet.mjs
node scripts/context-packet.mjs --feature "Online booking"
node scripts/context-packet.mjs --feature "In-house estimator" --max-chars 12000
```

The command is read-only. It prints current commit/status/lock information, up to three log summaries, and at most two matching feature entries with anchored file paths. It reads a bounded prefix of the log and never loads dashboard source. It marks truncation and missing feature paths instead of silently treating partial context as complete. The default output ceiling is 12,000 characters; the command's byte/character estimates are not billed token usage.

The command does not verify a deployment, apply a migration, inspect secrets, or fetch private customer data. Check those only when the task requires them. A log saying "verified" is evidence recorded at that time; verify again when current live state is material.

## Task packet

```text
Task: one observable outcome
Why: role, workflow, expected improvement
Scope: feature and owned files
Acceptance: 3-6 observable conditions
Preserve: visible summaries, data, permissions, compatibility
Decisions: accepted choices and any material unresolved choice
Evidence: source commit, anchors, schema/deployment checks with dates
Validation: focused tests and required release checks
Publication: current authorization or explicit hold
Checkpoint: completed work, blocker, next action, diff owner
```

Keep a short packet in the task and update it at meaningful checkpoints. Pass that packet to a bounded independent subagent instead of the entire history when practical. One agent owns integration and release; parallel edits use separate worktrees or clearly non-overlapping files. Include all agents when measuring usage.

Persistent packets containing internal business facts, incidents, customer information, or financial details belong in an approved private workspace, not public site assets. Repository visibility and deployment exclusion are separate boundaries. Do not turn this guide into a second unmaintained backlog: active work needs an owner and completion evidence in the system actually used to track it.

## Measure improvement

Compare similar completed tasks using common startup context, task-specific reading, total input/output/cache usage where available, number of agents, repeated investigations, completion, and reopened defects. Measure tokens per accepted change. Keep the required safety and validation bar; a smaller prompt is useful only if the completed result remains correct.
