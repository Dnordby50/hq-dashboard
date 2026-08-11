# Claude Code Prompt 85: the Save button went missing again (custom-line-only estimate, phone browser), plus the payment schedule did not seed

Run this BEFORE prompt 86. It is the urgent one: Dylan cannot finish estimates on his phone.

## Context

Repo: HQ-Dashboard, branch `main`. Deploy: Netlify, https://prescottepoxy.netlify.app. The file is `apps/estimator/src/features/estimator/EstimatorScreen.tsx` (estimator PWA source). `estimator/` at the repo root is the BUILT output, is gitignored, and is rebuilt by Netlify on deploy; never hand-edit it.

**What happened.** On the morning of 2026-08-11 Dylan built a proposal for a customer named Lance McDonald. He was in the estimator at the `/estimator/` URL **in a normal mobile browser tab** (not the installed home-screen PWA, not the inline embed on the estimate detail page). The estimate had **custom line items only, no measured areas**. There was **no Save button anywhere on the screen**. He also reports that the **payment schedule did not appear**: the card sat in its collapsed "Set up payment schedule" state instead of arriving pre-seeded.

**What you must not do: re-fix prompt 82.** Prompt 82 (commit `efd035d`, 2026-08-10) fixed exactly this estimate shape, and its fix is present in the source at HEAD. Verified before this prompt was written:

- `saveRow` is built at `EstimatorScreen.tsx:2636` and rendered **unconditionally** at `:3342`, inside `<section className="card result">` inside `<div className="right">`, outside every pricing gate.
- The blocker string `Add at least one area or custom line.` is in the source and in the locally built bundle.
- `git status` is clean and `git log origin/main..HEAD` is empty, so nothing is sitting unpushed.

So the code at HEAD is correct and the bug Dylan hit is **not a missing fix**. Your first job is to find out why his phone did not have it.

## The strongest hypothesis, stated so you can try to kill it

Both of Dylan's symptoms fall out of ONE cause: **his phone was running the pre-prompt-82 JavaScript bundle.**

On the old bundle, a custom-line-only estimate produces `pricing === null`, which cascades to `totalPrice === null`. That gives you:

1. No Save button (the old code rendered the whole money block, save row included, inside a `hasPrice && pricing && adjusted` gate). That is symptom one.
2. No payment schedule. The autoseed effect at `EstimatorScreen.tsx:~1246` is gated on `hasOpeningTotal` (`totalPrice != null && totalPrice > 0`) and it is the thing that calls `setScheduleOpen(true)`. With `totalPrice` null it never fires, so the card stays collapsed on its "Set up payment schedule" link. That is symptom two, exactly as Dylan described it.

One cause, both symptoms, no coincidence required. Treat it as the leading hypothesis, and confirm or kill it with evidence before you write a line of code.

## Task A: root cause. Report before you fix.

Work this ladder in order. Each rung is cheap and decisive. Print what you find.

**A1. Is the LIVE deploy actually carrying prompt 82?**

```bash
curl -s https://prescottepoxy.netlify.app/estimator/index.html | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
curl -s "https://prescottepoxy.netlify.app/estimator/assets/<that-file>" | grep -c 'Add at least one area or custom line'
```

Zero matches means the deployed bundle predates prompt 82 and **the deploy is the root cause** (a failed or never-triggered Netlify build). If so, stop the ladder, say so plainly, and put the Netlify investigation in the Handoff to Dylan section (checking the Netlify deploy log is a browser action, not yours).

Also compare that live asset hash to the local build output hash. They should match a fresh `npm run build` of `apps/estimator`.

**A2. Service worker staleness.**

If A1 shows the fix IS live, this is the next candidate and it fits Dylan's report precisely. `apps/estimator/vite.config.ts` configures VitePWA with `registerType: 'autoUpdate'`, workbox precaching `**/*.{js,css,html,svg,woff2}` and a `NavigationRoute` bound to the precached `/estimator/index.html`. `src/main.tsx` calls `registerSW({ immediate: true })`. The built `sw.js` does `skipWaiting()` + `clientsClaim()`.

The gap: the precached `index.html` is served to the page **before** the new service worker finishes installing. A tab opened cold after a deploy renders the OLD `index.html`, which references the OLD hashed JS, and it keeps running that bundle for the entire session. `clientsClaim()` claims the client but does not swap the JavaScript already executing. Dylan opens the estimator on his phone, works for twenty minutes, never reloads. He would see prompt-82-era behavior the whole time.

Confirm the mechanism against the built `sw.js` and `main.tsx`. State clearly whether it can produce a full working session on a stale bundle.

**A3. Layout reachability at phone width.**

`.cols` is `grid-template-columns: 1fr` below 760px (`apps/estimator/src/styles.css:186-198`), so `.right` (which holds the result card and the save row) stacks **after** the entire left column. Confirm that at 390px width the save row is present in the DOM and reachable by scrolling. If something clips it (an overflow container, an iOS viewport-height issue, a fixed element), name it with the CSS rule that proves it.

**A4. Data-shape hole.**

Rule out that a custom-line-only estimate still produces `totalPrice === null` at HEAD. Build one in a local dev run: one custom line, a typed price, a customer last name, a salesperson. Then check, in this order: `pricing`, `hasPrice`, `engineDormant`, `adjusted`, `totalPrice`, `hasOpeningTotal`, `saveBlockers`, `canSave`. Print each. If `totalPrice` is null at HEAD for this shape, prompt 82 fixed the render gate but not the money chain, and **that** is the root cause, which would also explain the payment schedule.

**Report the ladder result, name the cause in one sentence, then continue.**

## Task B: the sticky mobile save bar

Dylan explicitly declined this during prompt 82 and has now reversed that decision. Build it regardless of what Task A finds.

- Below 760px, the save row pins to the bottom of the viewport and stays visible at every scroll position.
- It must be **the same `saveRow` element**, moved or positioned, **not a second copy**. Prompt 82 collapsed two near-identical save rows into one specifically so they could never drift apart again. Do not undo that. If sticky positioning forces a wrapper, the wrapper wraps the one `saveRow`.
- Keep everything the row already does: the disabled state, the "Saving…" / "Save changes" / "Save estimate" label logic, the saved/error notes, and the first `saveBlockers` entry beside the button. On a narrow screen truncate the blocker text to one line with ellipsis rather than letting the bar grow tall.
- Respect the iOS home indicator: `padding-bottom: env(safe-area-inset-bottom)`.
- Give the page enough bottom padding that the bar never covers the last real control.
- At 760px and above, nothing changes. The bar is phone-only.
- The embed shell matters here: the estimator renders inside an iframe on the estimate detail page and the dashboard side has an iframe height listener (see the phase-4 comment at `EstimatorScreen.tsx:~3444`). `position: fixed` inside an auto-height iframe pins to the **iframe** viewport, which may not be the visible one. Check the `embed` prop path (`<div className={embed ? 'screen embed' : 'screen'}>` at `:2655`) and, if fixed positioning misbehaves in the embed, use `position: sticky; bottom: 0` there, or scope the bar to `!embed`. Say which you chose and why.

## Task C: the payment schedule seeds and opens on every new estimate

Dylan's ask: the payment schedule should be there by default, not sitting behind "Set up payment schedule".

Facts already established, so you do not have to rediscover them:

- The default bottom tab is Settings (`estTab` initialises to `'settings'` at `:505`), and the payment schedule card lives on that tab (`:3464`), so a seeded schedule is visible without tapping anything. The tab is not the problem.
- `scheduleEnabled` reads `config.estimateScheduleEnabled !== false` (`:1176`) and `scheduleAutoseedOn` reads `scheduleEnabled && config.estimateScheduleAutoseed !== false` (`:1244`). Both default to true in code (`apps/estimator/src/lib/catalog.ts:190` uses `String(settings[key] ?? 'true') !== 'false'`).
- The autoseed effect (`:1246`) is gated on `!editing && scheduleAutoseedOn && !scheduleTouched && !scheduleRemoved && hasOpeningTotal`, and `hasOpeningTotal` is `totalPrice != null && totalPrice > 0`.

Do this:

1. Read the live values of `estimate_schedule_enabled` and `estimate_schedule_autoseed` in the `settings` table (Supabase MCP, a plain select). If either is `'false'`, that alone explains it; report it and put flipping it in the Handoff (it is a settings row, and Settings > Estimates already has the toggle at `index.html:20803`).
2. If both are on, make the seed fire for a **custom-line-only** estimate. The correct mental model, same one prompt 82 established: the calculator engine is a pricer for calculator lines, and an estimate with zero calculator lines still has a real total, the sum of its typed custom line prices. Whatever in the chain still yields a null total for that shape is the bug. Fix the chain, not the gate.
3. Once the schedule seeds, `setScheduleOpen(true)` already runs. Verify the card renders expanded with rows, not the collapsed link.
4. Do not change the seeded shape (deposit percent by dominant system type + balance at completion), do not touch the "edits never auto-seed" rule, and do not make it seed on an existing estimate being edited. Those are prompt-74 and 2026-08-18 locked decisions.

## Task D: conditional, only if Task A lands on A1 or A2

If the root cause is a stale deployed bundle (A1) or a stale service worker (A2), then **the sticky save bar in Task B does not fix Dylan's bug.** It makes the button impossible to lose to layout, which is worth having, but a phone running last week's JavaScript will keep showing last week's behavior.

In that case, add the smallest honest fix for staleness:

- On app open, when online, fetch `/estimator/index.html` with `cache: 'no-store'` and compare the referenced main asset hash to the one currently running. If they differ, and **no work is in progress** (no typed customer name, no lines, no `editing`), reload the page so the rep starts on current code. If work IS in progress, never reload; show a one-line, non-blocking notice that a newer version is available and to reload when the estimate is saved. Silently destroying a rep's typed estimate to install an update would be a worse bug than the one you are fixing.
- Alternatively, if you judge a workbox `NetworkFirst` navigation strategy to be a cleaner fix than an in-app version check, take that route and explain the trade-off against the offline-first requirement. The estimator must still open with no signal in a customer's driveway. That is non-negotiable and predates this prompt.

If Task A lands on A3 or A4 instead, skip Task D entirely and say so.

## Guardrails

- Do not add shell-specific code paths (standalone PWA vs browser tab vs embed) beyond the `embed` handling already discussed in Task B. One component, one behavior.
- Do not touch the offline outbox, `performSave`'s save semantics, the send gate, or `saveBlockers` wording.
- Do not hand-edit anything under `estimator/`.
- Do not use em dashes in anything the customer or the rep reads on screen (standing rule 6).

## Verification

1. `npm test` from the repo root, green.
2. `npx tsc --noEmit` in `apps/estimator`, clean.
3. `npm run build` in `apps/estimator`, green, and note the new asset hash.
4. Build a custom-line-only estimate at 390px width and confirm: the Save button is visible without scrolling (sticky bar), it enables once the customer last name and the line price are filled, the estimate saves, and the payment schedule card is expanded with seeded rows.
5. Repeat at 1280px and confirm the desktop layout is unchanged.
6. Repeat inside the inline embed on the estimate detail page and confirm the bar behaves and the iframe height listener still sizes the frame correctly.
7. Confirm `saveRow` still appears exactly once in the file.

## Standing rules for this session

Commit per rule 1 (`estimator: <what changed>`). Prompt 85 is its own commit, separate from prompt 86. Append a PROJECT-LOG.md entry at the TOP per rule 2, with `By: Claude Code`, naming the root cause you actually proved in Task A and, if Task D was skipped, why. Add a What's New entry per rule 11 (the sticky save bar and the default payment schedule are both user-visible). Update the relevant `features.json` entries per rule 9. End with a `## Handoff to Dylan` section telling him, in one line, whether he needs to hard-reload his phone browser (and how) for the fix to take effect.
