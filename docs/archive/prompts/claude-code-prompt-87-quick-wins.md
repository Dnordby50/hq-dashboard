# Prompt 87: Quick wins — accept celebration (Slack + confetti), estimator declutter, estimate autosave

Written by Cowork on 2026-08-12 from Dylan's requests, after 15 clarifying questions. Four tasks, one session, in this order. Read CLAUDE.md and the last 3 PROJECT-LOG entries first per standing rule 4. Every task here is staff-facing, so em dashes are fine in the UI copy EXCEPT anything that could reach a customer (nothing here should).

Dylan's locked decisions (do not re-ask):
- Confetti fires on the STAFF dashboard, both live (an open dashboard learns of a new acceptance and celebrates) and on the next dashboard open after an acceptance nobody saw. NOT on the customer's public estimate page.
- The Slack accept notification is treated as a bug first: verify, then fix. Evidence below says it is genuinely broken.
- Estimator declutter: remove exactly the two collapsed cards ("Comparable jobs" and "AI price read") from the estimator screen. Auto pricing stays. The AI call keeps running silently so the estimate detail page keeps its snapshot render.
- Autosave: continuous debounced + flush on close. First save only once the estimate is real (customer selected AND at least one line/area). The save bar becomes a status indicator (Google Docs pattern); manual save remains possible.

---

## Task A: The Slack accept notification is not reaching #epoxysales. Diagnose, then fix.

Evidence gathered live on 2026-08-12 (Cowork, via Supabase MCP + Slack MCP):
- `estimates` has 5 acceptances since 2026-07-31: EST-102035 (07-31), EST-102046 (08-05), EST-102094 (08-10), EST-102098 (08-11), EST-102101 (08-11, $1,200).
- The last ~2 weeks of #epoxysales (C09AZE8CU0Z) contain ONLY Zapier "X just viewed their proposal!" messages (the DripJobs zap). ZERO TopCoat messages of any kind: no accepts, and also none of the prompt-75 estimate-view opens.
- The accept path posts via `notifyOffice(fresh, 'accepted', ...)` at netlify/functions/pec-public-estimate.cjs:1657, which fetches `SLACK_OFFICE_WEBHOOK` (read at :65, posted at :1146). The prompt-75 view notification uses the same env var (:1808, :1820).

So every TopCoat→Slack post shares one failure: `SLACK_OFFICE_WEBHOOK` is either unset in Netlify env or its incoming webhook is bound to a dead/wrong channel. Since NOTHING from TopCoat is arriving (accepts AND views), the env-level explanation is far more likely than a code bug. Diagnosis ladder:

1. A1: Check whether the env var is set: `netlify env:list` if the CLI is authed in this session. If the CLI is not authed, do NOT stall; write the Cowork handoff below and continue to the code half of the task.
2. A2: If set, its webhook may point at a different channel (the var is named OFFICE, not epoxysales) or the webhook was revoked. A test post to it proves which.
3. A3: Only if A1/A2 both pass, suspect the code path (e.g. `notifyOffice` failing silently; it logs `console.error` on non-ok, so Netlify function logs for pec-public-estimate around the 08-11 acceptance timestamps would show it).

The fix, whatever the diagnosis:
- Make the accept message a proper celebration, distinct from the informational ones: customer name, estimate number, total, salesperson, and a celebratory tone/emoji. Keep the view/decline messages as they are.
- Add a `settings` row ONLY if one does not already exist for accept notifications (the view notify already has `estimate_view_slack_enabled`). Follow rule 12 rationing; an accept notify on/off is reasonable behind Settings > Estimates' existing notification card, not a new front-of-card control.
- If the fix requires creating a new Slack incoming webhook or setting/rotating the Netlify env var, that is a web-UI action: write a `## Handoff to Cowork` section in your log entry with the exact env var name, the target channel (#epoxysales, C09AZE8CU0Z), and a curl to verify, per standing rules 5 and 8.

Guardrail: do not touch the Zapier/DripJobs "viewed their proposal" flow; it lives outside this repo.

## Task B: Confetti on acceptance, on the staff dashboard.

When an estimate is accepted (customer signs the public page), staff should get a moment of celebration in TopCoat:

- Live: a dashboard session that is open when an acceptance lands shows a confetti burst plus a small toast: customer name, estimate number, total. Piggyback on an EXISTING poll rather than adding a new one; candidates already in index.html: the bell/notifications refresh and the prompt-86 kill-switch poll (`login_revoked_poll_seconds`, default 60s). Sub-minute latency is not required; "while I'm looking at the dashboard it pops" is the bar.
- Catch-up: an acceptance that happened while no dashboard was open celebrates once on the next dashboard open (any view). Track "which acceptances have I celebrated" per browser (localStorage set of estimate ids or a high-water accepted_at mark). Multiple un-celebrated acceptances on open: one confetti burst + a toast listing them, not N sequential bursts.
- Exactly-once per browser per acceptance. Never on the customer-facing public page. Accept events only (not declines, not DripJobs webhook jobs — those have no `estimates` row acceptance; if a cheap way exists to include manual `markEstimateAccepted`-style flips, include them, since the data source below already does).
- Data source: `estimates.accepted_at` / status='accepted' is the truth; you do not need a new table or webhook. A poll comparing accepted_at > last-celebrated mark is enough.
- Implementation: self-contained canvas confetti (a small hand-rolled particle burst is fine, or the cdnjs canvas-confetti lib already allowed by CSP policy if index.html's CSP permits; check the CSP meta/headers first). Respect `prefers-reduced-motion`: skip the animation, keep the toast.
- Settings (rule 12): one front-of-card toggle, e.g. `accept_celebration_enabled` default 'true', in Settings > Estimates. No other knobs unless you find yourself hardcoding a threshold; then it goes behind Advanced.

## Task C: Remove the two pricing-intelligence boxes from the estimator screen.

Dylan: the estimator page is too cluttered. Remove exactly these two collapsed cards from apps/estimator/src/features/estimator/EstimatorScreen.tsx:

- `<details className="card comps">` ("Comparable jobs") at ~:3400
- `<details className="card ai-panel">` ("AI price read") at ~:3439

Keep (locked decision):
- Auto pricing: the calculator-driven line prices, margin, totals — untouched.
- The silent AI pipeline: the comps computation (~:1310-1330), the per-line AI fetch effect (~:1336-1411), and the pricing_snapshot write (~:2409) all keep running so the internal estimate detail page (index.html renderEstimateDetail, snapAi.lines) keeps rendering the read for every new estimate. Reps just stop seeing it while estimating.
- The Settings > Estimates > Pricing intelligence card (`estimate_ai_enabled`, `comps_min_sample`) — it now governs the silent pipeline; update its help text if it references the estimator panels.

Cleanup: removing the JSX orphans display-only helpers (`compsLabel`, `compsCaveat`, `mixedCompsNote`, possibly others). Delete what is truly display-only; keep anything the snapshot write consumes (`comps`, the AI inputs). tsc must come out clean with no unused-variable suppressions.

Note the JSX comment above those cards says the phase-4 declutter put them there deliberately; Dylan is now reversing that. Update the comment so the next session knows the panels moved OUT by decision, and the detail page is where the read lives.

## Task D: Estimate autosave in the estimator.

Behavior:
- Debounced autosave (2-3s after the last change) plus an immediate flush on close/navigate/tab-hide (visibilitychange + the estimator's own back/close actions). Continuous, not close-only.
- First save for a NEW estimate only once it is real: a customer is selected AND at least one area or custom line exists. Until then, nothing is written — no more hollow-shell draft rows (see the prompt-47 pre-minted draft card history before changing anything around it).
- The prompt-85 save bar (the ONE `saveRow`, EstimatorScreen.tsx ~:2636/:3342, sticky below 760px) becomes a live status indicator: "Saving…", "All changes saved HH:MM", "Offline — saved on this device, syncs when back online", "Save failed — Retry". The manual Save button stays and forces an immediate flush. Do not add a second save element; restyle the one that exists.

Traps, all confirmed history — read these before writing code:
1. **The estimator must NEVER write `estimates.status` on an edit.** It currently passes `status: editing?.status ?? 'draft'` from the open-time snapshot into `saveEstimateOffline`; a re-save after a send clobbers 'sent' back to 'draft' (Tom Bechtel EST-102054, 2026-08-10, prompt 84 fallout). Autosave multiplies write frequency, so this becomes a per-keystroke landmine. Fix it as part of this task: strip `status` from the estimator's upsert payload entirely (status is owned by the dashboard's send/accept paths). If prompt 84 already shipped a DB-level guard, verify autosave writes pass it; if it did not, add one (trigger rejecting a status downgrade from 'sent'/'accepted' by the estimator's write path).
2. **Offline outbox ordering.** Autosave rides the same `saveEstimateOffline` offline outbox as manual saves. Verify FIFO per-estimate ordering holds and that a flurry of debounced saves coalesces (queue at most one pending outbox row per estimate, newest wins) instead of stacking 40 upserts on a driveway estimate.
3. **Autosave vs send race.** A send from the dashboard while the estimator holds unsaved/queued edits must not interleave stale data over the sent snapshot. At minimum: flush before the estimator's own send-adjacent actions, and rely on (1) so status can never regress.
4. Per-keystroke server churn: the debounce plus coalescing keeps writes bounded; no non-idempotent writes ride autosave (estimate upserts are idempotent by id; nothing here may touch payments or sends).

Settings (rule 12): autosave should just work; if you expose anything, at most `estimate_autosave_enabled` behind Advanced. The debounce interval is not worth a knob.

## Verification (all four tasks)

- npm test green; tsc --noEmit clean; vite build green (new asset hash — note it in the log; prompt 85's version check will heal stale phones).
- Task A: a real or synthetic accept posts to #epoxysales (or the Cowork handoff is written with exact steps).
- Task B: simulate an acceptance (flip a test estimate's accepted_at) and see confetti live and on next open; second open stays quiet.
- Task C: estimator screen shows neither card; a NEW estimate still lands a pricing_snapshot with ai.lines; the detail page renders it.
- Task D: type-pause-close on a custom-line-only estimate on a 390px viewport; reopen shows the data; a sent estimate re-edited by autosave keeps status='sent' (check the row).
- What's New entries (rule 11) for Tasks B, C, D and, if the accept message changed visibly for staff... Slack is not in-app; skip A unless a setting surfaced.
- One commit per task or logically grouped, per standing rule 1; PROJECT-LOG entries per rule 2; features.json updates for the estimator PWA entry (C, D), Slack notifications entry (A), and a new or amended entry for the celebration (B).
