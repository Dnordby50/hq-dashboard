# Claude Code Prompt 84: a sent estimate says "Draft", and an empty estimate can be emailed to a customer

Run this AFTER Dylan pushes the commits waiting on `main` (prompt 81 modal CSS, prompt 82 Save gate). Two bugs, one theme: the estimate's state has to tell the truth. Two separate commits.

## Context

Two reports from Dylan on 2026-08-10, both confirmed against the live database by Cowork before this prompt was written.

**Report 1.** "Tom Bechtel's estimate was sent, but it still says it's in drafts."

**Report 2.** "Jason says sent, but there was never a proposal created and sent."

Repo: HQ-Dashboard, `main`. Deploy: Netlify. Supabase project `zdfpzmmrgotynrwkeakd` (HQ Dashboard). Surfaces involved: `index.html` (dashboard), `apps/estimator/src/` (estimator PWA source; `estimator/` at the root is BUILT output and is never hand-edited), `netlify/functions/pec-send-sms.cjs` and `pec-send-email.cjs`, `production/optional-lines.cjs` (the shared gate mirrors), `supabase/migrations/`.

## Bug 1 root cause, already diagnosed from live data. Confirm it, then fix it.

`estimates` row `6b328cec-2089-4d0a-b134-beb4263ea296` (EST-102054, Tom Bechtel) read, before Cowork repaired it:

```
status              draft
sent_at             2026-08-08 13:00:02.748+00
client_updated_at   2026-08-08 13:04:45.094+00
```

It was sent at 13:00, then re-saved from the estimator at 13:04, and the re-save wrote `status` back to `draft`. `sent_at` survived because the estimator never writes that column, which is exactly the fingerprint that identifies this bug in any other row.

The mechanism, in two files:

- `apps/estimator/src/features/estimator/EstimatorScreen.tsx` line ~2412, inside the `saveEstimateOffline({...})` call:

  ```ts
  status: editing?.status ?? 'draft',
  ```

  `editing` is the snapshot loaded when the screen opened (`src/lib/estimateLoad.ts` line ~256 maps `status`, line ~257 maps `sentAt`). If the estimator opened the estimate while it was a draft, `editing.status` is `'draft'` forever in that session, no matter what the server does afterward.

- `apps/estimator/src/offline/estimates.ts` line ~209 puts `status: args.status` into `estimateRow`, which is upserted (and, offline, enqueued into the FIFO outbox and replayed later). So a save queued in a driveway BEFORE a send can land AFTER the send and clobber it. That is why the code fix alone is not sufficient and a database guard is also required (locked decision 1).

The estimator has no business writing `status` on an edit at all. `status` is owned by the dashboard's send/accept/reject paths (`markEstimateSent` at index.html:30484 is the one sent-state flip, shared by every channel).

Note that the pipeline already compensates for this drift, which is why the card looked right in one place and wrong everywhere else. index.html:28082:

```js
const estColOf = e => e.status === 'draft' ? (e.sent_at ? 'estimate_sent' : 'drafts') : (EST_CARD_COLUMN[e.status] || null);
```

That rule is correct and is about to become the shared helper.

## Bug 2 root cause, already diagnosed from live data. Confirm it, then fix it.

`estimates` row `b08e261c-1e4c-4920-9506-96813a731bbd` (EST-102075, Jason Magimel):

```
status        sent
sent_at       2026-08-10 17:03:49.903+00   (10:03 AM MST today)
price         NULL
estimate_areas       0 rows
estimate_line_items  0 rows
```

`pec_email_log` and `pec_sms_log` both carry a delivery at 10:03 that morning: an email to the customer's address, subject "Your estimate EST-102075 from Prescott Epoxy Company", and a text to his phone. A real customer was sent a live `/e/<token>` link to an estimate with nothing in it. Dylan read this as "there was never a proposal created," which is right in substance: the row is the pre-minted early draft card (prompt 47) for an estimate a rep started on 2026-08-06 and never finished. It was never built, and it was sendable anyway.

The gate that should have stopped it is `estimateSendGateOk` (index.html:30071). Every blocker it produces comes out of a `for (const li of items)` loop over the line items, plus a scope-blank scan and a payment-schedule check. With zero line items the loop body never runs, so zero blockers are produced and the gate returns true. `estimateOptionalGateOk` (index.html:30021) has the same hole, and `production/optional-lines.cjs` `sendGateError` says so out loud in a comment:

```js
if (!list.length) return null; // no lines at all is a different problem, not this gate
```

That comment was right. This prompt is that different problem.

## Decisions locked with Dylan (12 multiple-choice questions, three rounds)

1. **Fix the estimator AND add a database guard.** Code alone cannot stop an already-queued offline outbox row from replaying stale status after a send.
2. **Editing a sent estimate keeps it sent, and says so.** Status stays `sent`; the estimate detail page shows an "edited after send" notice telling the rep the customer's link now shows different numbers, with a re-send affordance. Do not silently mutate state, do not block the edit, do not revert to draft.
3. **Tom's row is already repaired.** Cowork ran the UPDATE on 2026-08-10 (see the PROJECT-LOG entry). Do NOT ship a backfill; write the guard so it cannot recur.
4. **One shared helper for the derived state.** Extract the index.html:28082 rule into one function and route every surface through it: estimate list, estimate detail badge, follow-up queue, metrics, pipeline. No surface may key on `status` alone.
5. **An empty estimate is a HARD block on send, no override.** Same shape as the prompt 74 and 78 gates: named blocker, no confirm dialog. A confirm is what a rep in a driveway taps through.
6. **"Empty" means zero line items OR an opening total that is null or zero.** Both conditions, either one blocks.
7. **Enforce on the client AND the server.** The client gate gives the rep a named blocker before the tap; the server mirror means a stale tab or a crafted POST cannot email a blank estimate.
8. **The trigger blocks all status regressions.** Nothing in the app legitimately moves a sent estimate backward today. If an unsend feature is wanted later it gets built deliberately, with its own path.
9. **Leave Jason's row alone.** Dylan is handling EST-102075 himself. Do not modify it, do not revert it, do not message the customer.
10. **No change to how hollow draft cards render in the Drafts column.** The send gate is the fix; do not add markers, do not add an expiry job, do not delete anything.
11. One prompt, two commits (bug 1 with its migration, then bug 2).
12. Runs after Dylan pushes the waiting commits.

## What to build

### Commit 1: the estimate's status stops lying

**A. The estimator stops writing `status` on an edit.**

In `apps/estimator/src/offline/estimates.ts`, `status` must only be written when the row is being created. The upsert's on-conflict update only touches supplied columns (the same property the file already relies on for `estimate_number`), so omitting the key from `estimateRow` on an edit is sufficient and correct. Thread it through `SaveEstimateArgs` in whatever shape reads cleanly (an optional `status` that callers pass only for a create is the obvious one), and in `EstimatorScreen.tsx` stop passing `editing?.status ?? 'draft'` on the edit path. A brand-new estimate still lands `'draft'`.

Check the early draft-card write path (prompt 47's pre-minted row) with the same eye: it is a create, so it may write `'draft'`, but it must not write `status` again on any later save of the same id.

**B. A database trigger refuses status regressions.**

New migration `supabase/migrations/2026-08-17_prompt84_estimate_status_guard.sql`. A `BEFORE UPDATE` trigger on `public.estimates` that raises an exception when `status` moves backward along the lifecycle. Rank the statuses (`draft` < `sent` < `change_requested`-as-sent-equivalent < `signed` < `accepted`, with `rejected`/`lost` terminal) and reject any update that lowers the rank. Two rules to get right:

- `sent -> change_requested` and `change_requested -> sent` are both legal (a re-send after a change request is an existing, supported flow: see the `.in('status', ['draft','sent','change_requested'])` filter in `markEstimateSent`). Do not break it.
- The error message must be readable in a Supabase log by a human six months from now: name the row, the old status, and the new one.

Per standing rule 13, a trigger is not expressible in the four `@artifacts` kinds, so the header declares `none:` with the reason. Apply it via MCP, verify by re-query, and regenerate `SCHEMA.md`.

**C. One shared "is this estimate actually sent" helper in index.html.**

Extract the index.html:28082 rule into a named function near the other estimate helpers (`estimateOpeningTotal` is at index.html:30217; put it with that family or wherever the reader will find it) and use it in the pipeline's `estColOf`, the estimate list, the detail page's status badge, the follow-up queue, and the conversion metrics. Grep for `status === 'draft'`, `status !== 'sent'`, and `'draft'` comparisons against estimate rows and route each one through the helper or justify skipping it in the log entry. The helper's contract in one sentence: an estimate with a `sent_at` has been sent, whatever its `status` column says.

**D. "Edited after send" notice on the estimate detail page.**

`renderEstimateDetail` is at index.html:29235. When an estimate is sent (per the helper) and `client_updated_at > sent_at`, show a notice card: the estimate changed after it went out, the customer's link shows the new numbers, re-send to put the current version in their hands. Plain language, customer-neutral wording, no em dashes (standing rule 6 applies to anything that could be read aloud to a customer; keep this one clean regardless). Wire the existing send affordance, do not build a new one.

### Commit 2: an empty estimate cannot be sent

**E. The client gate.**

Add the emptiness blocker to `estimateSendGateOk` (index.html:30071), BEFORE the line-item loop, so it is the first thing reported. Blocks when the fresh read returns zero line items, or `estimateOpeningTotal` (index.html:30217) resolves to null, zero, or less. Message names the fix, not the failure: something like "This estimate has no priced lines yet. Open it in the estimator, add at least one line, and save before sending." Estimate-level blocker (no `sortOrder`), renders as a plain row like the stale-scope one.

Note the gate already does a fresh read of `estimate_line_items` at the top; use that same read, do not add a second round trip.

**F. The server mirror.**

Put the rule in `production/optional-lines.cjs` next to `sendGateError` (a new exported function; the existing one's comment explicitly defers this case to a different check, so do not overload it). Unit-test it in the matching `production/` test file: zero lines blocks, null total blocks, zero total blocks, one priced line passes.

`netlify/functions/pec-send-sms.cjs` already loads the estimate by `public_token` at line ~215 for `kind === 'estimate'`; extend that select and refuse with a 400 carrying the same message when the estimate is empty.

`pec-send-email.cjs` is the harder half: it has no estimate awareness at all (it runs in compose mode with a client-built body), which is why the blank estimate email went out. Give it the minimum it needs: the client passes the estimate id (or public token) on an estimate compose send, the function looks the estimate up and applies the same guard, and a compose send with no estimate id behaves exactly as it does today. Do not restructure compose mode.

**G. Present mode's flip.**

Present mode's open-for-signing path calls `markEstimateSent` too. Confirm it routes through the same gate; if it does not, make it. A blank estimate must not become live by any of the three channels.

## Do not change

- Jason's row `b08e261c-1e4c-4920-9506-96813a731bbd` and Tom's row `6b328cec-2089-4d0a-b134-beb4263ea296`. Both are Dylan's to handle; the first is untouched by design, the second is already correct.
- The Drafts column's contents, ordering, or footer.
- `sent_at` semantics anywhere. It stays the timestamp of the last successful send.
- The estimator's offline outbox ordering or its idempotency model.
- `estimate_number` assignment.

## Verification, required before you commit

1. `npm test` green, including the new `production/` cases.
2. `apps/estimator` `tsc --noEmit` clean, and the Vite build rebuilt.
3. Trigger proven live: attempt `UPDATE estimates SET status='draft' WHERE id = <a sent test row>` via MCP and show it rejected; then show `sent -> change_requested -> sent` still succeeding. Roll back any test row you touch.
4. Browser: open a sent estimate in the estimator, change something, save, and show the row still reads `status='sent'` afterward, with the detail page showing the edited-after-send notice.
5. Browser: on an estimate with no lines, show the send gate naming the blocker on both the email and the text path.
6. Report the exact count of rows where `status='draft' AND sent_at IS NOT NULL` after the change (expected: 0).

## Standing rules that apply

- Commit twice, `<area>: <what changed>` format, never `git add .`.
- PROJECT-LOG entry at the TOP, written for a human, `By: Claude Code`.
- What's New entry (standing rule 11): the edited-after-send notice and the send block are both user-facing.
- Regenerate `SCHEMA.md` after the migration; update the `features.json` entries for the estimate send path and the estimator save.
- No em dashes in anything customer-facing.
