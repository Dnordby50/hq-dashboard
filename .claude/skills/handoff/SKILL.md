---
name: handoff
description: Write a self-contained Cowork handoff prompt for the TopCoat HQ Dashboard project, with mandatory schema verification for any embedded SQL. Use when a task needs Cowork to do something outside this session's reach (third-party web UI, prod migration, file upload, sheet edit).
---

# Cowork Handoff

Produce a Cowork handoff prompt. Cowork is a separate operator with no chat history, no familiarity with this session's reasoning, and no access to this conversation. The prompt MUST be self-contained.

## Step 1: Verify before you write (mandatory)

Before writing the prompt:

1. **Schema check.** Every table and column named in any SQL or supabase-js snippet you embed MUST be confirmed against SCHEMA.md (repo root), or against supabase/migrations if SCHEMA.md looks stale. Do not assume plausible-looking names. Known traps that have burned us: customer name lives on public.customers (reached via jobs.customer_id), jobs has no customer_name; pec_email_log's only timestamp is sent_at (no created_at), while pec_sms_log has created_at. If a name you wanted does not exist, find the real one; never ship the guess.
2. **Commit pin.** Note the current commit SHA on main (`git log -1 --format=%H`) so Cowork works against a known version.
3. **Path check.** Every file path, sheet ID, and URL you reference must be real; grep or ls to confirm. Key resource IDs are in CLAUDE.md.

## Step 2: Write the prompt

Print it in chat as a fenced code block in exactly this shape:

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

Rules of thumb: include actual SQL / file snippets when they're short. Point Cowork at the specific commit on main so versions don't drift. Never assume Cowork has read PROJECT-LOG; if a past entry matters, paste the relevant line. If a task requires a credential or context Cowork would have to ask Dylan for anyway (which sheet, which Supabase project, which API key), name it explicitly so Cowork can ask Dylan once instead of bouncing back. No em dashes in any customer-facing text the handoff asks Cowork to publish (project standing rule 6); internal prompt text is exempt.

## Step 3: Log it

Also add the handoff as a `## Handoff to Cowork` section in the PROJECT-LOG.md entry for this session's work, per standing rule 5.
