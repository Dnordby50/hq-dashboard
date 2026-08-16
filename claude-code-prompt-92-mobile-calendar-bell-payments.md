# Claude Code Prompt 92: Mobile job-schedule calendar, mobile bell panel, payment notifications

## Context

Repo: `/Users/dylannordby/Claude-Code/HQ-Dashboard` (ARM 1 dashboard, `index.html` single file, ~2.7 MB).
Base commit on `main`: **bd0f820** (`estimates: pricing cards off, defaults fixed, salesask mapper, companycam photos (prompt 83)`). Working tree clean at time of writing.
Deploy: Netlify site `prescottepoxy`, https://prescottepoxy.netlify.app (auto-deploys on push to `main`).

Dylan gave nine requests in one message on 2026-08-16. They were split into three prompts by theme so no single session runs out of context and strands half a feature. **This is prompt 92 of 3.** Prompt 93 is the estimate document package (showroom address/ROC in the header, color chart, warranty doc). Prompt 94 is scope templates + the sold-on-site metric. Do not do 93 or 94 work here.

All three items in this prompt are things Dylan hit **on his phone in the field today**, so mobile behaviour is the acceptance surface, not desktop.

Every anchor below was verified against the working tree at bd0f820 and against the live Supabase project `zdfpzmmrgotynrwkeakd` on 2026-08-16. Re-verify line numbers before editing (they drift); the function names and column names are exact.

---

## Task A: Real calendar for the job schedule on mobile

### What is wrong today

`renderScheduleCalendar` (index.html:33890) has exactly one mobile branch, at **index.html:34306-34324**:

```js
if (window.matchMedia && window.matchMedia('(max-width:720px)').matches) {
  host.innerHTML = `<div class="pec-cal-daylist">${weeks.map((w, wi) => ` ... `)}</div>`;
```

At ≤720px it throws away the 3-week grid entirely and renders a **vertical list of day cards** (reusing `dayCardHtml`, index.html:34212), grouped under a "Week of …" header. The comment at 34306-34311 explains why: multi-day job bars use explicit `grid-column: X / span N`, which cannot reflow.

Dylan's words: "Mobile version needs a real calendar for job schedule like the appointments calendar, very hard to read otherwise." Scrolling a flat list of 21 day cards gives no sense of the week's shape.

### What to build (decision locked by Dylan, 2026-08-16)

**A compact week grid on mobile that swipes horizontally between weeks.** Not a month grid, not a drill-in, not FullCalendar.

Requirements:

1. **One week visible at a time** at ≤720px. Seven narrow columns (Mon–Sun or Sun–Sat, match whatever the desktop 3-week view already uses; do not change the week start convention). Column headers show the weekday letter plus day number.
2. **Swipe left/right to change week.** Horizontal swipe on the calendar body advances/retreats one week. Also provide tappable ‹ › chevrons in the week header for people who do not swipe, and keep the existing week-of date label.
3. **Job bars keep their span within the visible week.** A job spanning Wed–Fri renders as one bar across three columns. A job that starts before or ends after the visible week gets a clipped bar with a visual continuation marker (a chevron or a flat edge, your call, but it must be visually distinct from a bar that genuinely starts/ends that day).
4. **Tap a bar** opens the same job modal the desktop bar opens (`wireTaskClicks` path, index.html ~34356 region). Do not build a second detail surface.
5. **Tap a day column header** expands that day's full `dayCardHtml` content underneath the grid (accordion, one day open at a time). This preserves the readability the current day-list gave, without making it the primary view.
6. **The week revenue panel survives.** `weekRevPanelHtml` / `wireWeekRevPanels` (index.html:34356) currently render per-week in the mobile day-list; keep an equivalent collapsed revenue row for the visible week.
7. **Bar labels must be legible at 390px.** Truncate to customer last name + system abbreviation, with the crew colour already used on desktop. Do not shrink font below 11px.
8. **Rotation must re-pick the layout.** The current code evaluates the 720px branch only at render time; the resize listener at index.html:33887 only re-runs the pending-panel height cap. Add a debounced resize/orientationchange handler that re-renders the calendar when the viewport crosses the 720px boundary in either direction. Debounce ≥150ms; do not re-render on every resize tick.
9. **Which week is shown on open**: the week containing today, unless `state` already holds a schedule anchor date from a prior interaction, in which case use that. Persist the selected week in the same `localStorage` pattern `pec_sched_mode` already uses (index.html:33656) so a reload does not bounce Dylan back to today mid-planning.
10. **Desktop is untouched.** Above 720px, `renderScheduleCalendar` must produce byte-identical output to today. Prove it: describe in the log entry how you verified (e.g. the >720px branch is entered by the same code path with no shared-state changes).

### Guardrails

- Do **not** introduce FullCalendar into the schedule view. The appointments calendar loads it lazily from CDN (`ensureFullCalendar`, index.html:26564) and does not itself have a mobile view; importing that dependency here buys nothing and adds a CDN failure mode to the production calendar.
- Do **not** touch `loadScheduleData` (index.html:25972) or any data shape. This is a render-layer change only.
- Touch-ups aside, Pending panel, and Next Day board keep their existing ≤720px CSS (index.html:40429-40501).
- Swipe handling: use pointer events with a movement threshold and an axis lock, so a vertical page scroll never triggers a week change. Do not add a gesture library.

### Settings (standing rule 12)

Two front-of-card controls on Settings → General (or wherever the schedule knobs already live; check before adding a card):

- `schedule_mobile_breakpoint_px` (default `720`) — the width below which the mobile week grid is used. Mirrors the existing `settings_rail_breakpoint_px` pattern (index.html:19730-19743); copy that loader shape.
- `schedule_mobile_week_start_day` — only if the desktop view already has a configurable week start. If it is hardcoded, skip this and note it, do not invent a second convention.

Anything else (swipe threshold, debounce ms, bar label truncation length) goes behind that card's collapsed **Advanced** disclosure, or stays a code constant if it is genuinely not something a human tunes. Do not create a `settings` row for anything the app writes to itself.

---

## Task B: Notification bell panel is unusable on mobile

### Root cause (already diagnosed, do not re-investigate)

There is **no CSS anywhere that hides the bell on mobile**. Grep for `pecBell` returns only index.html:1099-1100 (button colour), 2319-2320 (a dead-marker comment), and 5273-5283 (the markup). The bell renders fine.

The actual defect is at **index.html:5282**: `#pecBellPanel` is inline-styled `position:absolute; width:340px; max-height:440px; right:0; z-index:10001`, anchored to `#pecBell`, which sits **mid-row** in `#rdTopbar` (markup order at index.html:5268-5297: search → refresh → bell → `.rd-user` cluster). At ≤720px the only topbar media rule (index.html:1446-1456) sets `#rdTopbar { flex-wrap: wrap }` and pushes `#rdSearch` to `order:3` full-width, leaving refresh + bell + the whole user block crowded on row 1. The 340px panel then extends leftward off the viewport on a 390px phone. There is no `max-width` and no viewport clamp.

Dylan confirmed the symptom: **"Panel opens but is cut off / off-screen."**

The help panel already solves this correctly at index.html:1454: `width: calc(100vw - 24px)`. Copy that approach.

### What to build

1. **Clamp the panel width**: `width: min(340px, calc(100vw - 24px))` and ensure it cannot overflow either viewport edge. Move the sizing out of the inline style at index.html:5282 into a real CSS rule so a media query can act on it; keep the ID selectors.
2. **Anchor it to the viewport on mobile.** Below the topbar breakpoint, `position: fixed` with `left: 12px; right: 12px; top: <below the topbar>` is more robust than `right:0` on an element whose position in the wrapped flex row is not stable. Whichever you choose, the panel must be fully on screen at 360px, 390px, and 430px widths.
3. **Cap the height to the viewport**: `max-height: min(440px, calc(100vh - 120px))` with `overflow-y: auto`, so a long notification list scrolls inside the panel instead of running off the bottom.
4. **Reflow the topbar at ≤720px** so the bell is not crushed: give the bell `margin-left:auto` (or an explicit `order`) so it sits flush right next to the user cluster, and let the user block collapse its name/sub text to just the avatar below 480px. This is the secondary complaint ("acting glitchy") and it is cheap.
5. **Tap-outside and Escape close the panel** on mobile. Verify `wireBell` (index.html:6552) already does this; if it only handles a document click, confirm it works with touch.

### Guardrails

- Do not change `loadNotifications` (index.html:6417), `refreshBell` (6446), `notifTarget` (6468), or `renderBellPanel` (6502). This is layout only.
- Do not add a new modal root. The bell panel is not a `.pec-modal-bg` modal and must not become one (see CLAUDE.md Architecture Gotchas: two modal roots exist and any modal-lifecycle change must hit both).

---

## Task C: Payment notifications on the bell

### What exists today

`pec_notifications` (SCHEMA.md:1024-1042) columns: `id, type (text, NOT NULL, no CHECK), job_id (FK jobs.id), body, priority (default 'normal'), created_at, read_at, target_view, target_id, target_user_id (FK admin_users.id)`. RLS on; **staff sessions have SELECT/UPDATE only, no INSERT** — every producer is either a SECURITY DEFINER RPC or a service-role Netlify function (index.html:9418, 22678-22680, 26978-26980).

`notifTarget` (index.html:6468-6501) routes on `target_view`. Recognised values today: `schema-drift, people, ops, reviews, settings-appointments, costing, invoicing, jobs, appointments, leads, estimates`. Unrecognised values render text-only; a bare `job_id` falls back to the job card (index.html:6500).

**Nothing rings the bell for a payment today.** The only payment-related notifications are `log_payment_edited` (index.html:13145) and `log_payment_deleted` (index.html:13190) — both fire on corrections, never on a payment being received.

### Dylan's decision (2026-08-16): ring on all three events

| Event | Where it happens | Notes |
|---|---|---|
| **1. Customer online payment (card)** | `netlify/functions/pec-stripe-webhook.cjs` — `checkout.session.completed` with `payment_status:'paid'`, idempotent `pec_payments` insert keyed on the PaymentIntent id at **pec-stripe-webhook.cjs:75-96** | The insert is already dedupe-guarded by a `GET /pec_payments?reference=eq.<piId>` probe at :75. Hook the notification **inside the branch that actually inserted**, never on the dedupe-skip path, or a Stripe retry double-rings. |
| **2. Customer online payment (ACH settled)** | Same file, `checkout.session.async_payment_succeeded` at **:269-285** — same shared insert helper, then flips `pec_stripe_pending` to `'succeeded'` at :278 | Same idempotency rule. |
| **3. ACH failure** | Same file, `checkout.session.async_payment_failed` at **:286-303** — flips or inserts `pec_stripe_pending` with `status:'failed'` and `failure_message` | **This is the one that matters most.** Money that looked collected days ago just vanished. Give it `priority` above normal and distinct wording. |
| **4. Staff-recorded payment** | `index.html:13277` — the single point where the `pec_payments` insert is known-landed exactly once (`ins = await doInsert('payment')` at :13259, dedupe probe :13262-13268, `if (ins.error) throw` at :13277) | Client cannot INSERT into `pec_notifications`. Add a **SECURITY DEFINER RPC** (e.g. `log_payment_recorded(p_job_id uuid, p_amount numeric, p_method text)`) following the exact pattern of the existing `log_payment_edited` RPC, and call it from index.html:13277's success path. |

### Notification content rules

- `type`: use distinct values — `payment_received`, `payment_received_ach`, `payment_failed_ach`, `payment_recorded`. `type` is free text with no CHECK, so no migration is needed for the values themselves, but pick them deliberately; the migration-drift checker and future filters will key off them.
- `target_view`: `'invoicing'` (already routed at index.html:6470-6501) plus `job_id` set so the fallback job-card link works either way. Verify `notifTarget`'s `invoicing` branch lands somewhere useful for a payment; if it needs `target_id`, set it to the job id.
- `body`: plain language, **no em dashes** (standing rule 6 — this is staff-facing, not customer-facing, so em dashes are technically allowed, but keep it consistent and readable anyway). Include customer name, amount, and method. Example: `Merlin P paid $4,200.00 by card`. For the failure case: `ACH payment of $4,200.00 from Merlin P failed: insufficient funds. The invoice is unpaid again.`
- `target_user_id`: leave NULL (shared) for all four. These are office-wide events, not personal ones. Note that the client-side `.or('target_user_id.is.null,...')` filter (index.html:6432) is a **display filter, not a security boundary** (SCHEMA.md:1042).
- **Do not** notify on `log_payment_edited` / `log_payment_deleted` differently than today. Leave those alone.

### Settings (standing rule 12)

New Settings → Invoicing card (`renderSettingsInvoicing`, index.html:21280), two controls front-of-card:

- `payment_notifications_enabled` (default `'true'`) — master on/off for all four.
- `payment_notify_min_amount` (default `'0'`) — suppress bell rows below this dollar amount, so a $1 test charge does not ring.

Behind **Advanced** on that card:

- `payment_notify_staff_recorded` (default `'true'`) — item 4 only. Dylan may want this off once he sees how noisy it is when the office logs a batch of checks.
- `payment_notify_ach_failed_priority` (default `'high'`) — the `priority` value written for item 3.

The Netlify function must read these from `settings` server-side, same pattern as `estimate_view_notifications_enabled` in `pec-public-estimate.cjs:1945`. **A disabled toggle must still return `ok:true` and stamp the heartbeat** (the gated no-op contract from prompt 90); a misconfiguration must return `ok:false`. That distinction is exactly what let the SalesAsk misconfig read green for weeks — see the 2026-08-13 log entry.

### Guardrails

- **Never re-order or wrap the payment insert in anything that could retry it.** CLAUDE.md Architecture Gotchas is explicit: a blind auto-retry on a non-idempotent write can double-record. The notification is a side effect that happens **after** a confirmed insert and must never block, retry, or fail the payment path. Wrap the notify call so any error is logged and swallowed.
- The Slack webhook (`SLACK_OFFICE_WEBHOOK`, used at pec-public-estimate.cjs:1208-1230) is **out of scope**. Bell only. Do not add Slack payment posts in this prompt.

### Migration

The RPC for item 4 needs a migration file. Standing rule 13: it starts with an `@artifacts` header. An RPC is a function, which is not one of the four expressible kinds, so it declares:

```sql
-- @artifacts
--   none: creates a SECURITY DEFINER function (log_payment_recorded), not expressible as table/column/index/setting
-- @end
```

The four new `settings` rows ARE expressible and each gets a `setting:` line in whichever migration seeds them.

**Standing rule 14 check:** a SECURITY DEFINER function that writes notifications, called from a payment path, sits close enough to both MONEY and AUTH that it should **rehearse on a Supabase branch database first** (MCP `create_branch`, apply, verify with real queries, then merge). Do that. The plain `settings` seed rows can go direct to prod.

---

## Standing rules checklist for this session

- [ ] Read CLAUDE.md and the last 3 PROJECT-LOG.md entries before starting (rule 4).
- [ ] Consult `features.json` anchors and `SCHEMA.md` before grepping or writing SQL (rule 9). Never read `index.html` or `PROJECT-LOG.md` end to end (rule 10).
- [ ] Commit after each meaningful change, format `<area>: <what changed>` (rule 1).
- [ ] Append ONE new PROJECT-LOG.md entry at the TOP, written for a human (rules 2, 3).
- [ ] All three tasks are user-facing → append What's New entries to `help/whats-new.json`, newest first, plain language, no em dashes, 2-3 how-to steps each (rule 11). Three entries: mobile schedule calendar, bell panel fix, payment notifications.
- [ ] Update `features.json` for every feature whose code or tables changed (rule 9).
- [ ] Regenerate `SCHEMA.md` after the migrations land (rule 9).
- [ ] Settings surfaces per rule 12: at most TWO front-of-card controls per feature, everything else behind Advanced.
- [ ] `@artifacts` headers on every migration (rule 13); branch-rehearse the SECURITY DEFINER function (rule 14).
- [ ] Do not commit secrets (rule 7).

## Verification before you write the log entry

Run and report the actual results, not intentions:

1. `npm test` green.
2. All `index.html` script blocks parse (the existing parse check).
3. `node --check` on every edited `.cjs`.
4. Migration artifacts re-queried against `information_schema` / `pg_proc`.
5. The four new `settings` rows re-queried by value.
6. Mobile calendar: state the widths you tested at and how (DevTools device emulation is acceptable; say so). At minimum 390px portrait, 844px landscape, and 1280px desktop-unchanged.
7. **Explicitly list what you could NOT verify** and why. A live Stripe ACH failure cannot be triggered from this session; say that plainly rather than implying it was tested.

## Handoffs

If any task needs a browser action, a Stripe dashboard test event, a prod migration you cannot run, or a value only Dylan has, end the log entry with a `## Handoff to Cowork` or `## Handoff to Dylan` section per rule 5, and print the Cowork prompt in chat in the CLAUDE.md handoff format.

Known likely handoff: sending a Stripe test webhook (`checkout.session.async_payment_failed`) at the live site to confirm the failure bell renders and routes. That is a Stripe-dashboard action, so it is a Cowork task.
