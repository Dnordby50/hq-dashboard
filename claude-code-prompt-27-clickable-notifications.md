# Claude Code Prompt 27: make every bell notification clickable, and route job-costing notifications to the job's costing view

## Context

When a job costing is sent back to the submitter (Anne gets it), she gets a bell notification but cannot click it to jump to the job costing. Dylan wants notifications to be clickable so each one takes you right to whatever it is about. Cowork scoped this with Dylan on 2026-07-16. Decisions locked:

1. ALL notification types deep-link to their source when clicked (not just costing).
2. Job-costing notifications (sent back, submitted) land on the Job Costing VIEW filtered to that one job (renderUnifiedJob), not the generic Jobs list.
3. Delivery is unchanged: keep the existing bell badge. NO realtime pop-up toast this build.

Repo: HQ-Dashboard, main. All UI is in index.html. Supabase project "HQ Dashboard" (zdfpzmmrgotynrwkeakd).

## What the code does today (evidence, read it first)

- loadNotifications reads pec_notifications: `select id,type,job_id,body,priority,created_at,read_at ... order created_at desc limit 30` (index.html:6095-6098). refreshBell / renderBellPanel / wireBell are index.html:6100-6154.
- The click handler is index.html:6135-6141. It marks the row read, then, ONLY if the row has a job_id, does `state.view='jobs'; state.openJobId=jobId; switchView('jobs')`. So today only public.jobs-linked notifications are clickable, and they always land on the generic Jobs page.
- renderBellPanel (index.html:6124) gates the pointer cursor and the data-job attribute on `n.job_id` being present, so rows without a job_id render as non-clickable text.
- The Job Costing view is renderJobCosting, registered as view 'costing' (index.html:7157). Opening ONE job's costing is done elsewhere with `state.openUnifiedJobId = jobId; switchView('costing')` (see index.html:14202, 19946-19947, 12221-12222). Reuse that exact pattern. The costing view is gated by can_view_job_costing (setNav('costing', can('can_view_job_costing')) at index.html:6742).
- THE WRINKLE, already documented in the code at index.html:23019-23021: `pec_notifications.job_id` FKs `public.jobs`, but job costing rows live on `pec_prod_jobs` (the parallel table, see CLAUDE.md "Two parallel job tables"). That is exactly WHY the costing RPCs `log_costing_submitted` (called at 23022) and `log_costing_sent_back` (called at 23068) pass only `p_customer` and store NO job link. Costing notifications are text-only today and cannot be made clickable without giving the row a way to reference a pec_prod_jobs id plus a destination view.
- Portal-sourced notifications (customer viewed, color confirmed, collisions) are inserted server-side via RPCs because the client cannot insert pec_notifications under RLS (see the note at index.html:7784).

## The build

1. Give notifications a routing target (schema). Add two columns to pec_notifications so a row can say WHERE to go, not just carry a public.jobs id: `target_view text` (for example 'jobs' or 'costing') and `target_id uuid` (the id to open in that view). Leave the existing `job_id` and `type` columns intact for back-compat. WRITE a new dated migration under supabase/migrations (additive + idempotent). Per do-not-touch-prod, do NOT apply it; hand the application to Cowork in your log entry.

2. Costing RPCs carry the prod job id. Update `log_costing_submitted` and `log_costing_sent_back` (Supabase RPC functions) to accept the pec_prod_jobs id and write `target_view='costing'`, `target_id=<that prod job id>` on the notification row they insert. Update the two callers to pass it: the submit handler (index.html:23013-23024, jobId is in scope) and the send-back handler (index.html:23047-23074, jobId is in scope). Put the function definitions in the same migration.

3. Click handler routes generically (index.html:6135-6141). On click, keep the mark-read behavior, then route by precedence: if `target_view`/`target_id` are present, dispatch to that view with the correct state key (costing -> `state.openUnifiedJobId = target_id; switchView('costing')`; jobs -> `state.openJobId = target_id; switchView('jobs')`). Keep the LEGACY path working for old rows that predate target_view: if there is no target_view but there is a job_id, do today's jobs+openJobId behavior. Close the panel before navigating, same as today.

4. Make rows clickable whenever there is a resolvable target. Update renderBellPanel (index.html:6115-6127) so the pointer cursor and data attributes are set when the row has EITHER a target_view/target_id OR a legacy job_id, not only when job_id is set. Add the new columns to the loadNotifications select (index.html:6097).

5. Respect permissions. A costing deep-link must only render clickable and navigate for users who can_view_job_costing (mirror the setNav gating). For a user without that capability, render the costing notification as plain non-clickable text so a tap never dumps them on a dead/blocked view.

6. Audit the other producers. For the portal RPCs that insert pec_notifications (customer viewed, color confirmed, collisions), set target_view/target_id where a sensible destination exists (for example a customer-viewed notification could open that job). Where there is no clean destination, leave it text-only rather than guessing. In your log entry, list which notification types you wired to a destination and which you deliberately left text-only, and why.

## Acceptance

- Anne receives a costing send-back notification; clicking it opens the Job Costing view on that exact job (renderUnifiedJob), not the generic Jobs list.
- An older notification that has only a job_id still clicks through to the job (legacy path intact).
- A user WITHOUT job-costing permission sees the costing notification as plain text, not a broken link.

## Standing rules

Commit per meaningful change (`<area>: <what changed>`, no secrets). node --check every touched inline script block and function; run npm test and report pass/fail. No em dashes anywhere. Append a PROJECT-LOG.md entry at the TOP. This is a user-facing change, so add one What's New entry to help/whats-new.json (id, date, title, one-line summary, 2-3 plain-language how-to steps, no em dashes). do-not-touch-prod: write the migration and hand its application to Cowork in a `## Handoff to Cowork` section (exact migration path plus a verify query).

## Handoff to Dylan (put in your log entry)

Plain English: costing notifications never carried a clickable job link because job costing lives in a different table (pec_prod_jobs) than the one notifications point at (public.jobs), so the code left the link off on purpose. Explain what you added, and that Cowork must apply the migration before costing notifications become clickable. Then have Dylan send a costing back on a test job and confirm the bell item opens that job's costing.
