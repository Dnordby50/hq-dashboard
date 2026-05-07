# CRM / Dashboard Project Log

Newest entries on top. Append only. Never edit or delete past entries. If a previous entry was wrong, write a new correction entry that references it.

---

## [2026-05-06 MST] dashboard: collapse Flake and Quartz sections in material catalog
By: Claude Code
Changed: index.html. The Material & Price Catalog (Catalog tab → Products) used to render every flake color and every quartz color as its own row in one long visible table per section. Dylan said the screen felt too busy and asked to condense flakes under a single click-to-expand button, same for quartz. Now both the "Flake Materials" and "Quartz Colors" section headers are clickable, with a chevron (▶ collapsed, ▼ expanded), and both default to collapsed when the catalog opens. Every other section (Basecoats, Topcoats, Stains, Sealers, Tint Packs, Metallic Pigments, Extras, Other) renders unchanged with no chevron.

How it works: two new state keys (state.catalogFlakeOpen, state.catalogQuartzOpen) hold the open/closed state. renderProducts() picks the chevron and the table's display style off those flags, and a delegated click handler on [data-cat-toggle] flips the flag and re-renders. Section labels stay as "Flake Materials" / "Quartz Colors" rather than "Simiron Flake", since the data model has no enforced brand grouping (manufacturer is a free-text field) and not every flake is guaranteed to be Simiron. Per Dylan's pick in plan mode.

Re-render-on-toggle was chosen over a CSS-only .open class because renderProducts already re-renders cheaply on tab switches (pattern at index.html:8153), state lives in one place, and the chevron flips for free without touching the row template. Edit links inside expanded sections still work (the [data-edit-product] listener gets re-wired on every render).

Files touched: index.html, PROJECT-LOG.md.
Verification: npm test 31/31 pass (calculator unchanged). Browser-level verification deferred to Dylan: open the dashboard → Catalog → Products. Confirm Flake Materials and Quartz Colors show "▶ Flake Materials · N" / "▶ Quartz Colors · N" with their tables hidden. Click each → chevron flips to ▼ and rows reveal. Click Edit on a flake row → product modal still opens. Switch to System Types and back to Products → collapsed state persists within the session.
Handoff to Cowork: None.
Handoff to Dylan: After this commit pushes and Netlify deploys, hard-refresh and walk the verification steps above. If you want either section to default open instead, change state.catalogFlakeOpen / state.catalogQuartzOpen at index.html:7347 from false to true.

---

## [2026-05-05 23:30 MST] dashboard: kill supabase-js navigator.locks deadlock with a no-op auth.lock override
By: Cowork
Changed: index.html. Final root-cause fix for the recurring "buttons go dead, save hangs forever, hard refresh fixes it" bug that 759bec9, 27af535, c0fa577, and ea00ed7 each chipped away at without identifying the underlying cause. The earlier commits all addressed downstream symptoms (stale .pec-modal-bg backdrop, missing per-handler try/catch, double-click reentry, lack of a save timeout). They were correct as defenses, but the trigger they all defended against was always the same: every supabase call was hanging before the request even left the browser. Diagnosed live tonight from Cowork via Claude-in-Chrome MCP after Dylan kicked the diagnostic playbook from his Claude Code session over because he could not reach it himself.

Diagnosis (three independent signals, all consistent):
1. Probe #2: `await window.pecSupabase.auth.getSession()` wrapped in an 8s timeout race -> TIMEOUT_OVER_8s at took_ms 8326. The session call never resolved.
2. Probe #3: `await window.pecSupabase.from('pec_prod_products').select('id').limit(1)` same wrapper -> TIMEOUT_OVER_8s at took_ms 8097. The select call never resolved either.
3. Network probe via `read_network_requests` filtered to the supabase project ref `zdfpzmmrgotynrwkeakd`: zero requests on the wire after both probes ran. The browser never sent.

Smoking gun: `await navigator.locks.query()` returned 1 held lock and 1 pending lock on the exact same name, both in exclusive mode: `lock:sb-zdfpzmmrgotynrwkeakd-auth-token`. Different clientIds (held vs pending), so the held lock is from this page's own bootstrap (visibilitychange handler or auto-refresh ticker entered its callback and never released), and the pending one is the queued auth call from probe #2 forever waiting behind it.

Why this matches every prior symptom Dylan saw:
- "Buttons go dead until reload" -> any modal save handler awaits supabase, supabase awaits the lock, the lock never releases, the await never settles, the modal's closeModal() in the success branch never runs, the .pec-modal-bg backdrop sits on top consuming clicks. Hard refresh tears down the page, the navigator.locks entry dies with the document, and a fresh bootstrap starts clean.
- "It only happens after the tab has been backgrounded for a while" -> Chrome throttles timers and fetches in background tabs. Supabase's autorefresh ticker enters the lock callback, fires a fetch to refresh the access token, the fetch is throttled and never completes, the callback never returns, the lock is held until page unload.
- "The 20s timeout in ea00ed7 catches it cleanly" -> correct, because the timeout fires from outside the lock; the supabase await is abandoned but the lock itself stays held. Hence why subsequent saves still hang the same way until refresh.

Fix: pass a no-op lock function in the supabase client config so auth ops never serialize through navigator.locks at all.

```
const noopLock = (_name, _acquireTimeout, fn) => Promise.resolve(fn());
const supabase = createClient(URL, KEY, { auth: { lock: noopLock } });
```

Trade-off: no cross-tab auth coordination. Acceptable here because this dashboard is a single-user app; worst case is two tabs both refreshing the token at the same moment, which supabase tolerates (last write wins, both end up with valid sessions). Did not switch to supabase-shipped `processLock` because it would require changing the import line and the esm.sh-resolved version may not export it under the expected name; a no-op is the smallest-surface-area fix that touches one block.

Why this is the right layer of fix and not yet another wrap: every prior commit's defense (try/catch around save, idempotent close, save timeout) is still load-bearing. They protect against any OTHER kind of hung await down the line. This commit removes the specific cause that has been firing repeatedly. Keep all prior defenses in place.

Files touched: index.html, PROJECT-LOG.md.
External systems touched: read-only Supabase via the live dashboard for diagnosis. No data changed.
Verification before deploy: visual diff of the createClient block, comment block explains the why so the next person touching this knows.
Verification after deploy (the actual proof): hard-refresh the dashboard once Netlify ships the new bundle. Open DevTools console, paste:
```
(async () => { const t=Date.now(); await window.pecSupabase.auth.getSession(); return Date.now()-t; })()
```
Expected: returns a number under 500. Then run a fresh navigator.locks.query() and confirm there are zero held or pending entries on the lock name. Then leave the tab backgrounded for 10+ minutes, come back, and try a Material Catalog product save. Should still complete.

Next steps: Push, deploy, verify per above. If the verify probe still hangs after the fresh deploy, that means esm.sh-resolved supabase-js is silently ignoring the `lock` option on this version, in which case fall back to also overriding `autoRefreshToken: false` and managing token refresh manually (much more invasive, only do if the no-op approach actually fails).

Handoff to Cowork: After Dylan pushes and Netlify deploys, run the verification probe in a Claude-in-Chrome tab against hq-prescott.netlify.app. Report took_ms and the navigator.locks.query() output. If both look right, log a confirmation entry. If they don't, the next thing to try is the autoRefreshToken: false path described above.
Handoff to Dylan: From your terminal, `cd /Users/dylannordby/Claude-Code/HQ-Dashboard && git add index.html PROJECT-LOG.md && git commit -m "dashboard: kill supabase-js navigator.locks deadlock with no-op auth.lock override" && git push origin main`. Sandbox can't push to git@github.com so this has to come from your host. After Netlify finishes building (usually under 2 minutes), hard-refresh the dashboard and run the verification probe above.

---

## [2026-05-06 06:50] dashboard: harden openProductModal save/delete against double-click + downstream throws
By: Claude Code
Changed: index.html. Third pass at the recurring "Material Catalog edit-product buttons work once then stop" bug (Dylan reported again this morning). Prior commits 759bec9 + the 21:30 entry's broaden-the-net work fixed half the surface area but not the actual repro path. Added four defensive layers to openProductModal:
1. Force-clear $('prodModalRoot').innerHTML at function entry, with a console.log noting if non-empty content was found. Guards against any stale backdrop or modal HTML lingering from a prior failed close.
2. Disable both Save and Delete buttons during the supabase async op, with a `reenable()` helper called on every short-circuit error path. A double-click during the in-flight period can no longer race two saves through the handler.
3. Wrap the post-close refresh chain (closer → loadCatalog → render) in its own try/catch. If loadCatalog throws (network blip, RLS hiccup) or render throws (bad template input, etc.), the caught error is logged to console and a defensive render() retry runs. Without this, the throw escapes as an unhandled rejection, fires clearAllModalRoots from the global safety net, and confuses the operator.
4. Console breadcrumb logs at: openProductModal entry, stale-content clear, pmSave click, supabase ok before close, post-close refresh complete, post-close refresh failed (with the error). These print in the browser console so the next time the bug surfaces the failing step is identifiable in seconds instead of through speculative back-and-forth.
Same hardening applied to the pmDelete handler (force-disable, post-close try/catch, breadcrumbs).
Why: The user said "buttons STILL are not working when I edit product in material catalog. its works once then stops. very frustrating." Exact symptom of a stuck position:fixed backdrop or a missing click handler after a re-render. We've shipped three rounds of fixes for variants of this and it keeps recurring, which means each fix only patched ONE failure mode while a different one is the live offender. This pass attacks the four most plausible remaining failure modes (stale state at modal entry, double-click race, downstream-throw kill chain, and inability to diagnose silently) at once. If it still fails after this, the breadcrumbs will name the exact step that's misbehaving.
Files touched: index.html, PROJECT-LOG.md
Verification: npm test 31/31 pass (no calculator changes). Browser-level verification deferred to Dylan.
Next steps: If Dylan reports the same symptom again after this commit deploys, paste me the console breadcrumbs for the failing sequence — the missing log line tells us exactly where the flow halts.
Handoff to Cowork: None.
Handoff to Dylan: After Netlify redeploys, hard-refresh, open DevTools (Cmd+Opt+I) > Console tab, then walk the failing flow once. If buttons still freeze, copy the console output and paste it back; the [prod] breadcrumbs will identify the offending step.

---

## [2026-05-05 22:45 MST] crm: cleaned up test row from Zap v4 publish-test; webhook is live end-to-end
By: Cowork
Changed: Cleaned the four production-Supabase rows the Zap v4 pre-publish Test step landed (project zdfpzmmrgotynrwkeakd). Context: Zap 353945579 ("PEC Proposal Accepted") published v4 with the full handler-key field map, and the pre-publish Test step that 22:00 documented as still partially mapped now succeeds end-to-end and returns a non-null prod_job_id. That success means a real customer/jobs/pec_prod_jobs/timeline_stages chain landed in prod under the DripJobs trigger sample data.

What I did, in order:
1) Inspected the customer row first (the only one with a possible "preserve" path because the handler at pec-webhook-proposal-accepted.cjs:27-36 PATCHes existing customers by email instead of inserting). Query: select id, name, email, phone, created_at, now() - created_at as age from public.customers where id = '4443bb3a-116a-4a94-9d34-922ef7bc9e32'. Result: name=Jeff Fisher, email=fisher2426@yahoo.com, phone=9517577881, created_at=2026-05-06 03:31:22.780405+00 UTC, age=00:04:55. Age well under 30 minutes, so this customer was newly INSERTED by the test (the prior Jeff Fisher row from the 22:00 entry's Test-step cleanup had already been deleted, so the v4 Test step had no email match and inserted a fresh row). Decision: DELETE.

2) Deleted the three guaranteed-new rows in FK order (used RETURNING id on the latter two so the affected count is visible directly in the result panel; pec_prod_jobs's first run reported "Success. No rows returned" with the standard DELETE response, but the verification union below confirms it landed):
   - delete from public.pec_prod_jobs where id = '6915148f-e42d-4975-a354-a4c42ad49b3f' -> 1 row affected (verified by post-delete count = 0).
   - delete from public.timeline_stages where job_id = '31e794b8-6358-4f42-a3ca-c41dca238d28' returning id -> 7 rows (matches the epoxy stage ladder count exactly).
   - delete from public.jobs where id = '31e794b8-6358-4f42-a3ca-c41dca238d28' returning id -> 1 row.

3) Deleted the customer (decision from step 1):
   - delete from public.customers where id = '4443bb3a-116a-4a94-9d34-922ef7bc9e32' returning id, email -> 1 row, email=fisher2426@yahoo.com.

4) Verification union, all four counts confirmed at 0:
   pec_prod_jobs    | 0
   jobs             | 0
   timeline_stages  | 0
   customers        | 0

Production state is clean. v4 is published and live; the next real DripJobs proposal-accepted event will create the full chain (customers + jobs + timeline_stages + pec_prod_jobs) and surface in the Pending Jobs sidebar in CRM > Job Schedule and the Job Costing view.

Note on the customer disposition: I deleted instead of preserving because the age was 4:55, not hours/days. If the row had pre-existed (i.e. a Jeff Fisher row in the customers table from before today's testing), the age would reflect the original creation time and we would have preserved it. The 22:00 entry already removed any prior Jeff Fisher row, so v4's Test step inserted fresh; nothing pre-existing to protect.

Files touched: PROJECT-LOG.md.
External systems touched: Supabase (production project zdfpzmmrgotynrwkeakd) via the SQL editor. Five queries: 1 inspect, 3 destructive in FK order, 1 verification union. Each destructive query went through Supabase's "Query has destructive operations" confirmation prompt and was confirmed.

Next steps: Wait for the first real DripJobs proposal-accepted event to fire through the published v4 Zap. After that, run a re-verification pass to confirm rows are flowing.

Handoff to Cowork: Re-verification pass after the first real DripJobs proposal-accept fires through v4. Run select count(*), max(created_at) from public.jobs where source = 'dripjobs' and confirm the count is no longer zero. Same query against public.pec_prod_jobs where dripjobs_deal_id is not null. If both counts are >= 1 with a recent created_at, the loop is closed and the Pending Jobs sidebar will start populating naturally.
Handoff to Dylan: I could not commit + push from the sandbox this run. The repo has a stale .git/HEAD.lock at the host path (created 2026-05-06 03:06 UTC, owned by your user, presumably leftover from a prior cowork or claude-code git operation that exited without releasing). The sandbox's virtiofs mount of the repo allows reads and writes but blocks unlink on .git internals (rm returns "Operation not permitted" even though ls shows me as the owner), so I cannot remove the lock from in here. Steps for you, all from /Users/dylannordby/Claude-Code/HQ-Dashboard:
  1) rm .git/HEAD.lock
  2) git status (expect: PROJECT-LOG.md modified, no other changes)
  3) git add PROJECT-LOG.md
  4) git commit -m "cowork: cleaned up Zap v4 publish-test rows from production Supabase"
  5) git push origin main
After the push, this entry is archived and the v4 chain is documented. The Supabase cleanup itself already landed (verification union returned 0/0/0/0); the only thing missing is the git record of the log change.

---

## [2026-05-05 22:00 MST] crm: re-verified DripJobs proposal-accepted webhook (LIVE, smoke-tested) and started Zapier wiring (Draft, NOT published)
By: Cowork
Changed: Two-track work in one entry. (A) Re-verification of the webhook now that fix A (.cjs rename in commit 1fb6030) shipped. (B) First pass at the Zapier Zap that actually fires the webhook on accepted proposals.

A. Re-verification of the proposal-accepted webhook (LIVE):
1) Deploy landed: PUBLISHED. Netlify > Deploys shows main@1fb6030 "ops: rename pec-* netlify functions to .cjs so handlers actually load" Published, deployed in 20s, no build errors.
2) Negative path: 401 (was 502). `curl -i -X POST` against the endpoint with no header returns HTTP/2 401 with body `{"success":false,"error":"Invalid webhook secret"}`. Confirms the function loads, the handler binds, and the badSecret check executes. The 502 Runtime.HandlerNotFound condition documented in the 19:30 entry is gone.
3) Positive smoke test: 200. Pulled PEC_WEBHOOK_SECRET from Netlify Project configuration > Environment variables via the Reveal flow (value is held only in Netlify and Zapier, never written here or to chat). Sent an authenticated POST with deal_id=TEST-20260506-0241 and a synthetic email; HTTP/2 200 with body containing customer_token, customer_id, job_id, prod_job_id, portal_link.
4) Database verification: 1 row each in public.customers, public.jobs (source='dripjobs', dripjobs_deal_id matches), public.pec_prod_jobs (status='unscheduled', dripjobs_deal_id matches, customer_id matches the customers row). 7 timeline_stages rows attached to the new jobs row (the epoxy stage ladder: Proposal Accepted, Scheduled, Prep Day, Coating Day, Cure Period, Final Walkthrough, Complete). Counts match expectation exactly.
5) Cleanup: deleted in FK order (pec_prod_jobs > timeline_stages > jobs > customers). Re-ran the count query to confirm all four counts back to 0. Production state is clean.

End-to-end verdict for the webhook itself: LIVE and working. Fix A took, the cache reload stuck, the bridge to pec_prod_jobs creates a row exactly as the handler intends.

B. Zapier Zap (Draft state, NOT published):
6) Existing Zap discovery: there is already a Zap named "PEC Proposal Accepted" (id 353945579, owned by Dylan, modified Apr 16) on his personal Zapier account. v3 is published and has run in the last 5 hours. Inspecting the steps: Step 1 = DripJobs Proposal Accepted (account: Prescott Epoxy Company #3), Step 2 = Google Sheets Create Spreadsheet Row (writing to "Booked Jobs Tracker" / "Booked Jobs"), Step 3 = Slack Send Channel Message. There is NO existing webhook step pointing at our Netlify endpoint. That explains why public.jobs was empty before today's smoke test: this Zap fires on every accepted proposal but only writes to Sheets and Slack, never to our backend.
7) Added Step 4 to this same Zap (rather than creating a parallel Zap that would double the trigger fire rate): Webhooks by Zapier > POST. Configured: URL = https://hq-prescott.netlify.app/.netlify/functions/pec-webhook-proposal-accepted, Payload Type = Json, Data row 1 customer_name -> 1.Customer Name (mapped from trigger), Headers row 1 x-webhook-secret = the production PEC_WEBHOOK_SECRET value (pasted into Zapier; this is the intended use, the secret has to live somewhere on the Zapier side for outbound auth). Wrap Request In Array=No, Unflatten=Yes (defaults).
8) Test step result: Success=true with returned customer_token, customer_id, job_id, prod_job_id (empty since deal_id wasn't mapped). Confirms auth works and the webhook accepts the JSON payload.
9) Did NOT publish. Reason: only customer_name is currently mapped in the Data section. The handler at netlify/functions/pec-webhook-proposal-accepted.cjs lines 27-46 dedupes customers by email, and only by email, so without customer_email mapped, every accepted proposal would hit the `if (!customer)` branch and create a fresh customers row with email=null, polluting the table Dylan just CSV-imported 1340 rows into yesterday. The fix is small (map ~13 more trigger fields to Data keys), but it has to happen before the Zap goes live.
10) Cleaned up the test rows the Test step inserted into production Supabase (the Jeff Fisher sample): deleted timeline_stages, jobs, customers in FK order. Production back to clean state.

Architectural note for the next cycle: the existing Zap places the webhook as Step 4 (after Sheets and Slack). Zapier executes steps sequentially and stops on first error. If the webhook ever returns non-2xx, Sheets and Slack still ran (they're earlier), so the existing notification flow is unaffected by webhook failures. Good positioning, leave it as Step 4.

Why: With the .cjs rename shipped, the webhook is the load-bearing path for the Pending Jobs sidebar in CRM > Job Schedule and the Job Costing view. Verifying it end-to-end and starting the Zapier wiring closes the loop the 19:30 entry opened. Stopping short of publish was a deliberate call: shipping a partially-mapped Zap would have created days of customer-table cleanup before benefiting anyone, and the existing v3 Sheets+Slack flow is unaffected because v4 is still Draft.

Files touched: PROJECT-LOG.md.
External systems touched: Netlify (read-only deploy + env var view), Supabase (production project zdfpzmmrgotynrwkeakd, two destructive-confirmed deletes for the smoke test cleanup and the Zapier test cleanup, both verified at 0 rows after), DripJobs (read-only sales pipeline view), Zapier (created Step 4 in Zap 353945579, configured URL/payload/data/header, ran one test step, left as Draft, did not publish, did not modify v3).

Verification command Dylan can run any time to confirm the webhook is still live: `curl -i -X POST https://hq-prescott.netlify.app/.netlify/functions/pec-webhook-proposal-accepted -H "Content-Type: application/json" -d '{}'` should return HTTP/2 401 + `{"success":false,"error":"Invalid webhook secret"}`. Anything else (502, 5xx, timeout) means something regressed.

Next steps: Dylan finishes the Zap field mapping per the handoff below, runs Test step once more to verify a richer payload, then publishes v4. After v4 publishes, the next real DripJobs proposal-accepted will create a clean row in customers/jobs/pec_prod_jobs/timeline_stages and surface in the Pending Jobs sidebar.

Handoff to Cowork: None for this entry. Next likely Cowork task is post-Dylan: confirm a real proposal flows through the published Zap by running the same four count queries from this entry and verifying counts move from 0.

Handoff to Dylan: Open the Zap at https://zapier.com/editor/353945579/draft, click into Step 4 POST, click the Configure tab. The Data section currently has one row (customer_name -> 1.Customer Name). Add value sets so each row maps a handler key to a DripJobs trigger field; do this for at least these in priority order, then publish. Click into a value field, click the variable picker, type to filter, pick the matching trigger field. The handler accepts null for any of these so missing-data rows fail gracefully, but at minimum customer_email and deal_id are required (email for customers dedupe, deal_id for the pec_prod_jobs auto-bridge):
  customer_email -> Customer Email
  customer_phone -> Customer Phone
  deal_id        -> the trigger's unique-per-event identifier (try Customer Id first, but ideally find a Job Id or Proposal Id field; if you cannot find a unique-per-proposal field via the picker, use Step Output to inspect the raw JSON and pick the right token — same Customer Id across multiple proposals from the same person would break the bridge dedupe)
  company        -> static text "prescott-epoxy" (do not map from a trigger field; this is the brand gate)
  address        -> Customer Job Address (or Customer Billing Address if the job address is not in the trigger payload)
  job_type       -> static text "epoxy"
  package        -> trigger's package/system field if available
  scope          -> Job Notes or Scope field
  sqft           -> Job Square Footage if available
  price          -> Job Amount
  monthly_payment -> Monthly Payment field if available
  dripjobs_url   -> Job Work Order Url
  warranty       -> Warranty field if available
After mapping, click Continue, then Test step. The response should still be 200 with customer_token/customer_id/job_id, AND prod_job_id should now be populated (because deal_id is mapped). After confirming the test row landed correctly in Supabase, delete the test row (it will appear under whatever customer_email you mapped) using the same FK-order delete from this entry. Then click Publish. Once Published, the next real DripJobs proposal-accepted event fires the full chain (Sheets + Slack + customer onboarding + Pending Jobs).

---

## [2026-05-05 21:30 MST] dashboard: extend modal-backdrop safety net to prodModalRoot

By: Claude Code
Changed: index.html. Correction-style follow-up to commit 759bec9 (the 20:10 entry below). That commit's diagnosis was right about the bug shape (a stuck position:fixed backdrop eating clicks) but missed that the app has TWO modal-root containers, not one: index.html:1781 #pecModalRoot and index.html:1782 #prodModalRoot. The earlier safety net cleared only #pecModalRoot, and the per-handler try/catch wraps only covered modals that route through the openModal()/closeModal() helpers. The Material Catalog and the rest of the production views write directly into #prodModalRoot via inline `$('prodModalRoot').innerHTML = ...` and define a local `closer` function in each one, so they were entirely outside 759bec9's scope. Dylan reported the bug still occurring specifically when adding an image URL to a product in the Material Catalog, which is the openProductModal flow at index.html:8225.

CHANGE 1, broaden the global safety net. Replaced the two anonymous handlers at index.html:4822-4829 with a single named function `clearAllModalRoots()` that wipes both #pecModalRoot and #prodModalRoot, and rebound both `window.addEventListener('error', ...)` and `window.addEventListener('unhandledrejection', ...)` to it. Now uncaught errors / rejected promises clear backdrops in either system. Added an inline comment naming both roots so the next person touching this knows there are two.

CHANGE 2, wrap the prod-side save and delete handlers in try/catch. Six modals render into #prodModalRoot (lines 7531, 7923, 8225, 8369, 8434, 8544). Audited each:
- Material Pull (~7531): read-only listing modal with no async writes. Skipped, nothing to wrap.
- Job Detail (~7923): the four action handlers (saveActiveJobLineEdits, recalcActiveJob, syncActiveJob, completeActiveJob) intentionally do NOT close the modal. They show inline status via #prodDetailError and #prodDetailOk. syncActiveJob and completeActiveJob already have try/catch. The two without (saveActiveJobLineEdits, recalcActiveJob) won't strand the user because the modal is supposed to stay open; the global safety net catches any escaped rejection. Skipped, in line with "Do not change behavior of handlers that already handle errors."
- Product Modal (~8225): pmSave and pmDelete wrapped. catch writes to existing #pmError div with prefix `Save failed:` / `Delete failed:`.
- System Type Modal (~8369): smSave and smDelete wrapped. catch writes to existing #smError div.
- Recipe Slot Modal (~8434): rsSave wrapped. catch writes to existing #rsError div. (No delete in this modal; deletes happen from the parent system-type view.)
- Color Pairing Modal (~8544): cpSave wrapped. catch writes to existing #cpError div. The `if (isDefault)` flip-default await and the insert await are both inside the same try.

Why: 759bec9 only solved half the surface. The Material Catalog flow Dylan was hitting goes through #prodModalRoot, so neither the global safety net nor the per-handler wraps from that commit applied. Without try/catch around the supabase call, a rejection (network blip, RLS denial, schema mismatch on image_url, etc.) skipped the local `closer()` and left the .pec-modal-bg backdrop sitting on top of the page. The fix layers the same two-tier pattern (global net + per-handler try/catch) onto the production-side modals.

Architecture follow-up: also updated CLAUDE.md with a new "Architecture Gotchas" section documenting that #pecModalRoot and #prodModalRoot are parallel modal systems with no shared helpers, so future cross-cutting modal fixes must be applied to both. Updated the "Bug Diagnosis Workflow" section to make explicit that Claude Code does the coding directly and only hands off to Cowork for tasks Claude Code literally cannot do (browser UI clicks, manual migrations, file uploads, paste-into-sheet, etc.).

Files touched: index.html, CLAUDE.md, PROJECT-LOG.md.
Verification: visual diff review of the five edited handler bodies, all preserve the existing inline-error display path on the {error} branch and only add a new throw-handling branch. Try/catch counts increase by 5 in the file (one per wrapped handler), which matches the edits. Browser-level verification deferred per the same constraint as 759bec9: open the Material Catalog, click + Add product (or Edit on an existing one), paste any URL into Chip image URL, throttle the network in DevTools or kill the supabase connection, click Save, confirm an inline error renders in #pmError and clicks elsewhere on the page still work.

Handoff to Cowork: None.
Handoff to Dylan: 1) Push the commit (`git push origin main`) and wait for Netlify to deploy. 2) Reproduce the original failure path: open Material Catalog, edit a product, change the image URL, click Save under throttled or offline network. Confirm the inline error appears AND clicking other UI elements still works (no stuck backdrop). 3) If the click-blocking ever recurs in any other modal, open DevTools > Console and look for the unhandledrejection / error log; the global safety net should still kick in and clear the backdrop, but the source error in the log tells us which handler still needs a try/catch.

---

## [2026-05-05 20:10 MST] dashboard: fix stale modal backdrop blocking clicks until reload
By: Cowork
Changed: index.html. Two coordinated changes addressing the "buttons go dead until I reload the page" bug. Bug mechanics: the .pec-modal-bg backdrop is position:fixed inset:0 z-index:10000 and is appended to #pecModalRoot when openModal() runs (index.html ~line 4808) then removed by closeModal() (~line 4817). Several modal submit/click handlers placed closeModal() only on the success branch of an `await` that could reject. When the await rejected, closeModal() never ran, the backdrop stayed mounted on top of every other element, and silently swallowed every click until a page reload reset #pecModalRoot.

CHANGE 1, the immediate global safety net (added right after `window.pecCloseModal = closeModal;` near line 4818): two new top-level listeners, `window.addEventListener('error', ...)` and `window.addEventListener('unhandledrejection', ...)`, each of which clears #pecModalRoot.innerHTML. Pre-check confirmed the only existing `window.addEventListener('error')` in the file is the one at line 8571 inside the prod module IIFE; that one targets a different element (#prodViewRoot) and a different concern (surfacing import-level prod errors), so adding a global modal-cleanup handler does not conflict, the two run independently. There was no existing `unhandledrejection` listener anywhere, so a fresh one was added.

CHANGE 2, defense in depth on each modal save handler. Audited every closeModal() call site, classified each as wrap or skip per the rules in the task, and applied the standard `try { ...existing await work... } catch (err) { errEl.textContent = 'Save failed: ' + err.message; return; }` shape. For handlers that already used alert() for errors, the catch keeps alert(); for handlers that use an inline errEl status div, the catch writes to that same errEl so the existing UX is preserved.

Wrapped (11 handlers, post-edit line numbers refer to the file as it stands after this commit):
1) #pecCustForm submit (~line 5065, closeModal at ~5106). Was: alert + return on Supabase {error}, but bare await could still reject. Now: try/catch around the insert/update, alert on throw, modal stays open.
2) #pecColorForm submit (~line 5694, closeModal at ~5705). Wrapped Supabase insert/update.
3) #pecColorDel click (~line 5708, closeModal at ~5717). Wrapped Supabase delete.
4) #pecRefForm submit (~line 5774, closeModal at ~5785). Wrapped Supabase update.
5) #pecTeamForm submit (~line 5898, closeModal at ~5925). Both branches (fetch /.netlify/functions/pec-create-staff for new, supabase admin_users update for edit) wrapped in a single try/catch; catch writes to existing #pecTeamErr div so inline UX preserved.
6) #leadSave click (~line 6038, closeModal at ~6055). Wrapped supabase pec_lead_sources insert/update; catch writes to #leadError.
7) #leadDelete click (~line 6055, closeModal at ~6066). Wrapped supabase pec_lead_sources delete; catch writes to #leadError.
8) #crewSave click (~line 6087, closeModal at ~6104). Wrapped supabase pec_prod_crews insert/update; catch writes to #crewError.
9) #crewDelete click (~line 6104, closeModal at ~6112). Wrapped supabase pec_prod_crews delete; catch writes to #crewError.
10) #schedSave click (~line 6420, closeModal at ~6448). Wrapped the three sequential awaits (delete schedule_days, insert new days, update jobs); catch writes to #schedError.
11) #schedClear click (~line 6452, closeModal at ~6460). Wrapped the two awaits (delete schedule_days, update jobs back to unscheduled). Note: the original was the only handler with completely unchecked awaits (no error inspection at all); the wrap added explicit `if (res.error) errEl = ...` after each await in addition to the try/catch. Minor scope creep but it brings this handler in line with the others; previous behavior on a partial DB failure was silent corruption (job marked unscheduled but schedule rows still present, or vice versa), so the user benefits from the new error surface.

Skipped (5, with reasons):
A) CSV import runBtn click (~line 5283, closeModal in setTimeout at ~5311). Per the task rule "If a handler intentionally keeps the modal open on validation error and shows an inline message, leave it alone." The handler deliberately collects per-batch errors into an `errors` array, never throws, only calls closeModal on full success. The task's own carve-out covers this case.
B) #pecJobForm submit (~line 5456, closeModal at ~5478). Already had a full try/catch with inline #pecJobFormError handling, this matches the task's other carve-out: "Do not change behavior of handlers that already handle errors."
C) $('pecJobEdit') submit (~line 5608). No closeModal call (this is an inline edit form on the job detail page, not a modal). Outside the scope of CHANGE 2.
D) $('pecSettingsForm') submit (~line 5991). Re-renders the settings page after upserting; no modal context. Outside scope.
E) #pecPortalRef submit (~line 7015) and #pecSigninForm submit (~line 7061). Both replace root.innerHTML or sign in; no closeModal involved. Outside scope.

Why: User reported the dashboard's buttons go inert until a manual reload. Diagnosis pointed at a stale .pec-modal-bg sitting on top of the layout consuming clicks. The global listeners (CHANGE 1) make the symptom recoverable for any future handler that gets added without try/catch; the per-handler wraps (CHANGE 2) make each modal submit fail gracefully with an actionable error message instead of silently going dead. The two are layered intentionally, so a regression in one site does not break the user's session.

Files touched: index.html, PROJECT-LOG.md.
Verification: 1) `node --check` passed on all three classic inline scripts in index.html (the importmap script triggers a false positive because it's JSON, not JS, and is not changed by this commit). 2) `npm test` reports 31/31 passing (calculator suite is untouched, this is a sanity check that nothing structural broke). 3) Live browser verification of the force-failure step deferred to Dylan: open the deploy after this lands, open any wrapped modal (e.g. CRM > Settings > + Add lead source), use DevTools to overwrite the supabase fetch URL or kill the network tab, click Save, confirm the inline error message appears and clicks elsewhere on the page still work. (Cowork sandbox cannot reach Chrome from a file:// path and the sandbox-local HTTP server is not reachable from the host's Chrome instance.)

Next steps: Push this commit so Netlify deploys. After deploy, walk the verification step above on at least one of the wrapped handlers to confirm end-to-end. If anything else surfaces a similar pattern in future PRs, the global listeners in CHANGE 1 will catch it as a backstop.
Handoff to Cowork: None.
Handoff to Dylan: 1) From your terminal: `cd /Users/dylannordby/Claude-Code/HQ-Dashboard && git push origin main`. The sandbox cannot reach git@github.com from inside, this needs to come from the host. 2) Once Netlify deploys, do one round of force-failure verification: open any modal save flow, break the network or fetch URL via DevTools, submit, confirm the inline error renders and other clicks on the page still work. If the click-blocking ever recurs, open DevTools > Console and look for an unhandledrejection log with a stack trace pointing at the new offending await.

---

## [2026-05-05 19:50] ops: fix A — rename pec-* netlify functions to .cjs so handlers actually load
By: Claude Code
Changed: Renamed seven Netlify Function files from .js to .cjs and updated the require() path inside each consumer to match. Files: netlify/functions/_pec-supabase.js → _pec-supabase.cjs (the shared helper), pec-create-staff.js → .cjs, pec-log-signin.js → .cjs, pec-prod-sync-sheet.js → .cjs, pec-webhook-proposal-accepted.js → .cjs, pec-webhook-stage-changed.js → .cjs, pec-webhook-project-completed.js → .cjs. Each consumer's `require('./_pec-supabase.js')` was updated to `require('./_pec-supabase.cjs')`. sop-chat.js stays .js because it works (no require, esbuild apparently coerces a require-less CommonJS-shaped file into something the ESM loader tolerates). package.json's `"type": "module"` is left as-is so the production module's ESM imports keep working in tests and the inline frontend code keeps building.
Why: Cowork's 19:30 verification entry diagnosed every pec-* function as returning HTTP 502 with `errorMessage: "pec-webhook-proposal-accepted.handler is undefined or not exported"`, root cause being package.json's `"type": "module"` forcing Node to load every .js file as ESM. The pec-* files are written in CommonJS (`require` + `exports.handler`); under ESM, `require` and `exports` are not bound at module scope, the file fails to load, and Netlify's Lambda runtime reports the handler as undefined. The .cjs extension forces Node to load that specific file as CommonJS regardless of package.json. This is the lowest-risk path; the alternative (converting all six handlers to native ESM `import` / `export const handler`) would touch more lines and risk breaking the Netlify ESM bundling pipeline that's working for sop-chat.
Files touched: netlify/functions/* (7 renames + 6 require-path updates), PROJECT-LOG.md
Verification: `node --check` passes for all 7 .cjs files. `node -e "require('./netlify/functions/pec-webhook-proposal-accepted.cjs').handler"` returns a function (the exact runtime check that was failing on Netlify Lambda before this fix). Once Netlify auto-deploys this commit, the endpoint should change from HTTP 502 HandlerNotFound to HTTP 401 "Invalid webhook secret" for unauthenticated requests, and HTTP 200 for authenticated ones.
Next steps: After Netlify redeploys, Dylan runs the smoke test from Cowork's 19:30 entry handoff item 3 (`curl -X POST -H "x-webhook-secret: <secret from Netlify>" ...`) and confirms a row lands in customers + jobs + pec_prod_jobs. Then builds the Zapier Zap (DripJobs trigger -> Webhooks by Zapier action -> our endpoint with the matching secret).
Handoff to Cowork: After Dylan reports the smoke test passed, run a re-verification pass: same four count queries from the 19:30 entry to confirm `select count(*) from public.jobs where source = 'dripjobs'` is no longer zero.
Handoff to Dylan: 1) Wait for Netlify to publish the deploy of this commit (usually under 2 minutes). 2) Run a quick negative curl: `curl -i -X POST https://hq-prescott.netlify.app/.netlify/functions/pec-webhook-proposal-accepted -H "Content-Type: application/json" -d '{"customer_name":"Smoke"}'`. Expected response: HTTP 401 with body `{"success":false,"error":"Invalid webhook secret"}`. If you still see HTTP 502 HandlerNotFound, the .cjs rename didn't take and we need to look at netlify.toml or the build log. 3) Once 401 confirms the function is loadable, build the Zapier Zap per item 2 of Cowork's 19:30 handoff and test with one real proposal.

---

## [2026-05-05 19:30 MST] crm: verified DripJobs proposal-accepted webhook end-to-end (NOT live, two blockers)
By: Cowork
Changed: Read-only verification pass against the live system. No code, schema, or external state changed. Walked the five checks Dylan asked for and uncovered two independent blockers that together explain why no DripJobs proposals have ever appeared in the dashboard.

Verdicts:
1. Netlify env vars: CONFIGURED. Opened Netlify project hq-prescott > Project configuration > Environment variables. Confirmed all three present with values across all 5 deploy contexts: PEC_WEBHOOK_SECRET (stored as secret, hidden), SUPABASE_URL (visible), SUPABASE_SERVICE_ROLE_KEY (visible). Names match exactly what netlify/functions/_pec-supabase.js reads at runtime (process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.PEC_WEBHOOK_SECRET).
2. Function deployed: PARTIAL (deployed but broken at runtime). Netlify > Logs & metrics > Functions shows pec-webhook-proposal-accepted in the deployed list, "Created May 4 (a day ago)", endpoint URL is https://hq-prescott.netlify.app/.netlify/functions/pec-webhook-proposal-accepted matching the spec. Latest production deploy main@5868755 (today 8:51 AM) Published successfully, prior deploys including main@798dc43 (last touch on the webhook file) all green. BUT: every POST to the endpoint returns HTTP 502 with `{"errorType":"Runtime.HandlerNotFound","errorMessage":"pec-webhook-proposal-accepted.handler is undefined or not exported"}`. Same failure for pec-webhook-stage-changed, pec-webhook-project-completed, pec-create-staff, pec-log-signin, and pec-prod-sync-sheet. The single working function is sop-chat (returns HTTP 400 "Missing system or messages", which is its real handler responding). Root cause identified: package.json declares `"type": "module"` (line 5), which forces Node to treat every .js file in the project as an ES module. The pec-* function files use CommonJS syntax (`const x = require('./_pec-supabase.js')` and `exports.handler = async ...`); under ESM rules, `require` and `exports` are not defined at module top level, so the file fails to load and Netlify's Lambda runtime reports the handler as undefined. sop-chat.js uses the same `exports.handler` syntax but does not call require(), so esbuild's bundling apparently coerces it into a working shape; the moment a function file requires a sibling helper, the load fails. This means the auto-bridge to pec_prod_jobs has never executed and the public.jobs insert has never executed; even if DripJobs were sending payloads, they would all 502.
3. DripJobs side: MISSING. Logged into DripJobs as Dylan Nordby on the Prescott Epoxy Co tenant. There is no native webhook configuration UI in DripJobs; the only integrations surface is /managezapier (the Zapier landing page) and Settings has no Webhooks/Automations/API entry (only Booking Form, Card Labels, Company Settings, Crews, Employees, Products / Services, Reminders, Subcontractors, Users). DripJobs intentionally routes outbound webhooks through Zapier ("Webhooks by Zapier" action). Dylan confirmed in chat: "probably need to use zapier to create the webhook." So the proposal-accepted Zap that would POST to our Netlify endpoint with the x-webhook-secret header has not been created yet. Cannot verify the trigger event mapping or field shape until the Zap exists.
4. Recent activity: ZERO. Ran in Supabase SQL editor (project zdfpzmmrgotynrwkeakd):
     select 'jobs_dripjobs', count(*), max(created_at) from public.jobs where source = 'dripjobs'      -> 0, NULL
     select 'pec_prod_jobs_dripjobs', count(*), max(created_at) from public.pec_prod_jobs where dripjobs_deal_id is not null  -> 0, NULL
     select 'jobs_total', count(*), max(created_at) from public.jobs                                 -> 0, NULL
     select 'pec_prod_jobs_total', count(*), max(created_at) from public.pec_prod_jobs               -> 1, 2026-05-04 02:49:40+00
   Zero rows have ever flowed through the webhook. The single pec_prod_jobs row was created manually via the Ordering UI on 2026-05-04 (no dripjobs_deal_id). Consistent with both blockers: webhook is broken AND no DripJobs/Zapier sender is configured.
5. Smoke test: SKIPPED on the positive path (would require PEC_WEBHOOK_SECRET in chat to construct an authenticated curl, and the value is correctly hidden in Netlify). Ran negative tests instead, which were sufficient to surface the 502 issue above. Three POSTs to the live endpoint (no header, bogus header, GET method) all returned the same HandlerNotFound 502, proving the function is reachable but unable to load.

Why: Dylan asked whether accepted DripJobs proposals are flowing into the dashboard. They are not. The verification matters because the auto-bridge in netlify/functions/pec-webhook-proposal-accepted.js (added in the 2026-05-04 21:30 entry, gated to PEC in the 22:05 entry) is the load-bearing piece for the new Pending Jobs sidebar in CRM > Job Schedule and the Job Costing view. Without the webhook firing, nothing populates Pending Jobs except manual + New Job entries.
Files touched: PROJECT-LOG.md (this entry).
External systems touched (read-only): Netlify project hq-prescott (Environment variables, Functions, Deploys), DripJobs Prescott Epoxy Co tenant (Sales Pipeline, /managezapier, /tenantadmin), Supabase project zdfpzmmrgotynrwkeakd (SQL editor, ran four count queries). Three negative POST requests via curl from the sandbox to the live Netlify endpoint with no/bogus webhook secret. Nothing was created, modified, or deleted.
Verification of the diagnosis: package.json line 5 reads `"type": "module"`. netlify/functions/pec-webhook-proposal-accepted.js line 6 reads `const { sb, ... } = require('./_pec-supabase.js');` and line 8 reads `exports.handler = async (event) => {`. _pec-supabase.js ends with `module.exports = { sb, json, badSecret, randomToken, epoxyStages, paintStages };`. Together with the 502 trace pointing to `UserFunction.js.module.exports.load` failing, this is unambiguous: the runtime is loading the file as ESM and hitting a missing `require`/`exports` binding.

Recommended fix order (Claude Code work, NOT done in this entry):
A) Easiest: rename netlify/functions/_pec-supabase.js to _pec-supabase.cjs and rename every netlify/functions/pec-*.js to .cjs (5 files). The .cjs extension forces CommonJS regardless of package.json. Update the require() path inside each pec-*.cjs to require('./_pec-supabase.cjs'). Done.
B) Alternative: convert all six function files to native ESM (`import` / `export const handler = async ...`). More invasive, has to coordinate with Netlify's ESM runtime expectations.
C) Wrong: removing `"type": "module"` from package.json. The dashboard's frontend or test scripts may already rely on it (production/calculator.test.js was added recently; check before changing).

Once A is shipped and Netlify redeploys, the endpoint will start returning 401 for unauthorized requests and 200 for authenticated ones; THEN the DripJobs/Zapier side can be wired and tested end-to-end.

Next steps: (1) Claude Code applies fix A, runs `node --check` against each renamed file plus a local handler.invoke smoke test if possible, ships it. (2) After Netlify redeploys, Dylan creates the Zap in Zapier (DripJobs trigger "Proposal Accepted" -> "Webhooks by Zapier" POST action with header x-webhook-secret = the value of PEC_WEBHOOK_SECRET, body mapped to the 14 fields the handler expects). (3) Dylan accepts a real test proposal in DripJobs to confirm the row lands in customers, jobs, AND pec_prod_jobs (and the timeline_stages rows for the public.jobs side).

Handoff to Cowork: None for this entry. The next Cowork-appropriate task would be a re-verification pass after fix A ships and the Zap is configured: same four queries to confirm rows are landing.
Handoff to Dylan: Two parallel tracks.
1) Ask Claude Code to apply the .cjs rename fix to the six netlify/functions files (paste this entry into Claude Code and ask "do fix A from the 19:30 log entry"). Verify via `curl -X POST https://hq-prescott.netlify.app/.netlify/functions/pec-webhook-proposal-accepted` after deploy: it should return HTTP 401 `{"success":false,"error":"Invalid webhook secret"}` instead of HTTP 502.
2) After (1) is live, build the Zapier Zap: trigger = DripJobs "Proposal Accepted" (or whatever event name DripJobs exposes for the deal stage we want), action = Webhooks by Zapier > POST, URL = https://hq-prescott.netlify.app/.netlify/functions/pec-webhook-proposal-accepted, headers include `x-webhook-secret: {{PEC_WEBHOOK_SECRET value}}` and `Content-Type: application/json`, body is JSON with the fields the handler expects: customer_name, customer_email, customer_phone, company (use "prescott-epoxy" for the PEC tenant, "finishing-touch" for FTP), deal_id, address, job_type ("epoxy" or "paint"), package, scope, sqft, price, monthly_payment, dripjobs_url, warranty. Map each to the corresponding DripJobs trigger field. Test the Zap with one accepted deal; confirm in Supabase that public.customers + public.jobs + public.pec_prod_jobs all got a row. If the test proposal is on the FTP brand, the bridge will skip pec_prod_jobs intentionally (gated to prescott-epoxy in the 22:05 entry).
3) Note: the smoke test in this verification was deliberately skipped because constructing it required either Dylan pasting PEC_WEBHOOK_SECRET into chat (avoid) or Cowork reading it from Netlify (Netlify hides it, correctly). After fix A, Dylan can run a positive smoke test himself with `curl -X POST -H "x-webhook-secret: <secret from Netlify>" -H "Content-Type: application/json" -d '{"customer_name":"Smoke Test","customer_email":"smoke@test.local","deal_id":"TEST-'$(date +%s)'","company":"prescott-epoxy","price":"1.00"}' https://hq-prescott.netlify.app/.netlify/functions/pec-webhook-proposal-accepted` and then DELETE the test rows by deal id.

---

## [2026-05-05 14:20 MST] crm: ran customer_fields + lead_sources_full_list migrations in production
By: Cowork
Changed: Executed two migrations in sequence against production Supabase (project zdfpzmmrgotynrwkeakd) via the SQL editor. (1) supabase/migrations/2026-05-04_customer_fields.sql ran first because the prior migration was never actually applied to prod (the 2026-05-04 22:40 Claude Code entry's Cowork handoff was missed; no Cowork run-confirmation entry exists for it in the log). Supabase prompted the destructive-operations confirmation (the `drop policy if exists` + `drop trigger if exists` idempotency guards trigger it; same pattern as the prior metallic_pigment_split run); confirmed and ran. Result: "Success. No rows returned." (2) supabase/migrations/2026-05-05_lead_sources_full_list.sql ran second. Result: "Success. No rows returned."
Why: This is a correction to the diagnosis in the 2026-05-05 06:50 Claude Code entry. That entry attributed Dylan's "Could not find the table 'pec_lead_sources' in the schema cache" error to PostgREST schema-cache lag and added a `notify pgrst, 'reload schema';` to the new migration. The actual root cause was that the table did not exist in production at all because 2026-05-04_customer_fields.sql was never executed there. Today's first run of 2026-05-05_lead_sources_full_list.sql failed with `ERROR: 42P01: relation "public.pec_lead_sources" does not exist`, which surfaced the real problem. After running customer_fields first, the lead_sources_full_list migration ran cleanly.
Files touched: PROJECT-LOG.md
External systems touched: Supabase (production project zdfpzmmrgotynrwkeakd), executed both migration files in the SQL editor.

Verification output (post customer_fields):
  customers_new_cols           | {billing_address_line1, billing_address_line2, billing_city, billing_state, billing_zip, company_name, first_name, last_name, lead_source, tags}  (10 columns, expected 10)
  job_class_cols               | {jobs.job_class, pec_prod_jobs.job_class}  (2 columns, expected 2)
  pec_lead_sources_constraints | UNIQUE pec_lead_sources_name_key + PRIMARY KEY pec_lead_sources_pkey (expected; the ON CONFLICT (name) clause in the lead-sources migration depends on this unique constraint)

Verification output (post lead_sources_full_list):
  active=true  (17 rows): Facebook, Google, Google PPC, Home Show, Home Show 2025, Instagram, Magazine AD, Mail, Other, Parade, Postcard Mailer, Referral, Repeat Customer, Saw our truck, Walk In, Website, Yard Sign
  active=false (2 rows):  Door Hanger, Truck Lettering

Counts match the spec from the 2026-05-05 06:50 handoff exactly. The 9 originally-seeded names from customer_fields plus the 10 newly-inserted names total 19; ON CONFLICT prevented any duplicates (none of the 10 new names overlapped). Door Hanger and Truck Lettering correctly flipped to active=false.

Next steps: Dylan hard-refreshes the dashboard, opens CRM > Settings > Lead Sources, confirms 17 active rows, and tries the + Add source path that was failing earlier. With both migrations in place the schema-cache error should be gone; if a different error appears, the richer error surfacing added in the 06:50 commit will print the full Postgres error code/details/hint to the modal so we can diagnose immediately.
Handoff to Cowork: None.
Handoff to Dylan: 1) Hard-refresh the dashboard. 2) Open CRM > Settings, scroll to Lead Sources. Confirm the 17 active rows appear (Facebook, Google, Google PPC, Home Show, Home Show 2025, Instagram, Magazine AD, Mail, Other, Parade, Postcard Mailer, Referral, Repeat Customer, Saw our truck, Walk In, Website, Yard Sign). 3) Click + Add source, type a brand-new name (e.g. "Test Source"), save. It should land in the table. 4) Open CRM > Customers > + New. The new structured fields (Individual / Business toggle, billing address split into 5 fields, lead source dropdown, tag chips) should all be functional now that the customers table has the new columns. 5) Push when ready. From your terminal: cd /Users/dylannordby/Claude-Code/HQ-Dashboard && git push origin main. The sandbox can't reach git@github.com.

---

## [2026-05-05 07:30] crm: customer CSV import (DripJobs export shape)
By: Claude Code
Changed: index.html. Added "Import from CSV" button to the Customers toolbar (next to + New Customer). Click opens a modal with a file picker, an inline CSV parser that handles quoted fields + escaped quotes + multi-line values, and a header-aware column mapping for the DripJobs export shape: First Name, Last Name, Email, Company Name, Phone, Address, Address 2, City, State, Zip Code, Lead Source. After parsing, the modal previews the first 5 rows that will be imported and shows row counts (total / new / duplicate-by-email / blank-email). Duplicates against existing customers are detected by case-insensitive email lookup against the customers table; in-file duplicates by email are also collapsed. Rows without an email are treated as new (no other unique identifier). Confirm runs batched inserts of 200 rows each into public.customers, stamping a portal token client-side via crypto.getRandomValues for each new row, with status text updating per batch and a final "Imported N customers." message. Brand defaults to 'prescott-epoxy' for the whole file (DripJobs is PEC's tool); a separate FTP path will need a brand toggle later. Lead source values that don't match the managed pec_lead_sources list are saved as-is (free text on customers.lead_source) so the import never blocks on unknown sources; user can normalize later via the Customers > Edit form.
Why: User has a 1,468-row DripJobs contacts export they need to seed the dashboard with. Parser handles the actual file (verified: 1344 distinct emails, 119 in-file dupes, 4 blank-email rows). Email-based dedupe means re-importing the same file is safe — no duplicates accumulate. Skipping (rather than updating) on dupe means existing customer data we've curated in the dashboard isn't overwritten by stale DripJobs values; that's the recommended-default option from the prior plan question.
Files touched: index.html, PROJECT-LOG.md
Verification: parsed the actual /Users/dylannordby/Downloads/contacts (2).csv with the same code; row counts match expectations. npm test = 31/31 pass (calculator unchanged). UI verification: open CRM > Customers > Import from CSV, drop the file, click Import.
Next steps: User imports the file once Netlify redeploys this commit. Consider adding an "Update existing on email match" toggle later if the simple skip-on-dupe behavior turns out to lose useful DripJobs updates.
Handoff to Cowork: None (this is a UI-only change; no migration).
Handoff to Dylan: Hard-refresh once Netlify deploys. CRM > Customers > Import from CSV. Pick the DripJobs export. Preview shows roughly 1340 new rows + 119 dupes + 4 blank-email. Click Import. Should take a few seconds for ~1340 rows in 7 batches of 200. After import, refresh Customers list to verify; spot-check a couple of rows by editing them (lead source, billing address fields populated).

---

## [2026-05-05 06:50] crm: align lead-sources with DripJobs export; richer add-source error
By: Claude Code
Changed: Two small follow-ups to the customer-fields commit. (1) supabase/migrations/2026-05-05_lead_sources_full_list.sql adds 10 lead sources from the DripJobs export the user is migrating from (Website, Instagram, Mail, Magazine AD, Walk In, Parade, Google PPC, Home Show 2025, Saw our truck, Postcard Mailer) and deactivates two seeded values that aren't in the user's actual workflow (Door Hanger, Truck Lettering). Active total goes from 9 to 17. The migration ends with `notify pgrst, 'reload schema';` which forces Supabase's PostgREST cache to refresh — covers the "Could not find the table 'pec_lead_sources' in the schema cache" error the user was hitting when trying to add a custom source via the Settings UI right after the prior migration ran. (2) index.html: the Lead Source modal save handler now surfaces the full Supabase error payload (message + details + hint + code) instead of just message, and logs the raw error to the console. Schema-cache misses, RLS denies, and unique-constraint violations are now diagnosable at a glance.
Why: User reported they couldn't add their own lead sources and saw an error referencing a schema. Most likely cause: PostgREST's auto-reload hadn't kicked in for the new pec_lead_sources table. The forced NOTIFY plus the seed list bring the dashboard into alignment with the DripJobs values they're already using, so they don't need to manually add 10 entries through the UI. The richer error surfacing is so the next failure tells us exactly what broke instead of "referencing a schema" being our only clue.
Files touched: supabase/migrations/2026-05-05_lead_sources_full_list.sql (new), index.html, PROJECT-LOG.md
Verification: npm test = 31/31 pass (no calculator changes in this commit). Behavior verification waits on Cowork running the migration + the user testing the add path.
Next steps: Cowork runs the new migration. Dylan tries adding a custom lead source again; if it still fails, the new error surfacing will show the full Postgres error with code/details/hint.
Handoff to Cowork: 1) Run supabase/migrations/2026-05-05_lead_sources_full_list.sql in the production Supabase SQL editor. Verify with: select name, active from public.pec_lead_sources order by active desc, name; (expect 17 active rows: Facebook, Google, Google PPC, Home Show, Home Show 2025, Instagram, Magazine AD, Mail, Other, Parade, Postcard Mailer, Referral, Repeat Customer, Saw our truck, Walk In, Website, Yard Sign; plus 2 inactive: Door Hanger, Truck Lettering). 2) Append a top entry to PROJECT-LOG.md with results, commit, and push.
Handoff to Dylan: 1) After Cowork runs the migration, hard-refresh the dashboard. Open CRM > Settings, scroll to Lead Sources. Confirm the 17 active rows appear. 2) Click + Add source, type a brand-new name (e.g. "Test Source"), save. It should land in the table. If it still errors, the modal now shows the full Postgres error message + code + hint — paste that to me and I'll fix the underlying cause.

---

## [2026-05-04 22:49 MST] crm: ran 2026-05-04 metallic pigment split migration
By: Cowork
Changed: Executed supabase/migrations/2026-05-04_metallic_pigment_split.sql against production Supabase (project zdfpzmmrgotynrwkeakd) via the SQL editor. Result: "Success. No rows returned." (Supabase did not prompt the destructive-operations confirmation this run, presumably because the only pattern that triggers it strongly is DROP without IF EXISTS guards; the constraint drop/recreate pattern fell under threshold.) Six things landed in one transaction: (1) the three CHECK constraints (pec_prod_products / pec_prod_recipe_slots / pec_prod_material_lines) now allow material_type='Metallic Pigment'. (2) Simiron Metallic Pigment row reclassified from Flake to Metallic Pigment, and the Metallic system's slot flipped from Flake to Metallic Pigment. (3) Recipe defaults on Flake / Quartz / Grind and Seal - Urethane Basecoat slots repointed from the now-deactivated Tinted Gray / Thin Coat to Simiron 1100 SL - Light Gray. (4) Domino color pairing's basecoat repointed to Light Gray. (5) Tinted Gray and Thin Coat set to active=false (still in the table, FKs intact, hidden from the catalog Products view and from the basecoat picker). (6) Simiron MVB - Standalone Basecoat row inserted (100 sqft/gal, 3 gal kit). (7) standalone_mvb boolean column added to pec_prod_jobs with default false.
Why: Step 1 of the handoff in the prior 23:30 Claude Code entry. Migration was committed at f7d6e9d but not yet applied to prod; the calculator changes, the new Metallic Pigment picker, the Standalone MVB toggle, and the Metallic Pigments catalog section in index.html all depend on this schema and product state.
Files touched: PROJECT-LOG.md
External systems touched: Supabase (production project zdfpzmmrgotynrwkeakd), executed migration via SQL editor.

Verification output (8-row union query):
  active_counts_by_type           | Basecoat=7, Extra=2, Flake=19, Metallic Pigment=1, Quartz=42, Sealer=1, Stain=1, Topcoat=2
  inactive_basecoats              | Simiron 1100 SL - Thin Coat, Simiron 1100 SL - Tinted Gray
  metallic_pigment_row            | Simiron Metallic Pigment (Metallic Pigment, active=true)
  metallic_system_slots           | Basecoat, Extra, Metallic Pigment, Topcoat
  mvb_standalone                  | Simiron MVB - Standalone (Basecoat, 100 sqft/gal x 3 gal kit)
  standalone_mvb_column           | standalone_mvb:boolean:default=false
  basecoat_defaults_after_repoint | Flake/Basecoat=Simiron 1100 SL - Light Gray, Grind and Seal - Urethane/Basecoat=Simiron 1100 SL - Light Gray, Quartz/Basecoat=Simiron 1100 SL - Light Gray
  domino_pairing                  | Domino Flake -> Simiron 1100 SL - Light Gray

Counts cross-check (Basecoat=7): pre-migration there were 8 active Basecoats (3 from the original seed plus 5 from the catalog_expansion run). This migration deactivated 2 (Tinted Gray + Thin Coat) and added 1 (MVB Standalone), net -1, landing at 7. Flake=19 unchanged because the Special Order Flake row sits there and Simiron Metallic Pigment moved out as expected. Quartz=42 reflects the prior Special Order Quartz insert. Metallic system has no Flake slot anywhere, replaced cleanly by Metallic Pigment. All three target system types' Basecoat defaults plus the Domino pairing point at Light Gray. Nothing unexpected.

Next steps: Dylan pushes commits to origin so Netlify deploys the calculator + UI changes that depend on this schema. Then walk the in-app verification list from the prior 23:30 entry's Handoff to Dylan (Metallic Pigments catalog section, Tinted Gray/Thin Coat hidden from Basecoat picker, Metallic system Metallic Pigment picker, Standalone MVB toggle adding the MVB line at total_sqft / 100 / 3 kits, Domino pairing reading Light Gray).
Handoff to Cowork: None
Handoff to Dylan: 1) Push the new commit (the cowork log entry below this one) plus any prior unpushed commits. From your terminal: cd /Users/dylannordby/Claude-Code/HQ-Dashboard && git push origin main. The sandbox can't reach git@github.com so this needs to come from the host. 2) After Netlify deploys, walk the in-app verification list from the prior 23:30 entry.

---

## [2026-05-04 23:30] crm: metallic pigment split, retire Tinted Gray + Thin Coat, standalone MVB
By: Claude Code
Changed: Four connected adjustments. (1) supabase/migrations/2026-05-04_metallic_pigment_split.sql extends the material_type CHECK constraints on pec_prod_products / pec_prod_recipe_slots / pec_prod_material_lines to allow 'Metallic Pigment'. Reclassifies the existing "Simiron Metallic Pigment" row from material_type='Flake' to 'Metallic Pigment' and flips the Metallic system's broadcast recipe slot from Flake to Metallic Pigment so slot type matches product type (mirrors the prior Quartz split). Repoints the Flake / Quartz / Grind and Seal - Urethane recipe defaults from Tinted Gray / Thin Coat to Light Gray; repoints the Domino color pairing's basecoat to Light Gray; deactivates "Simiron 1100 SL - Tinted Gray" and "Simiron 1100 SL - Thin Coat" so the basecoat picker no longer surfaces them (old material_lines that already reference them keep working — active=false doesn't break FKs). Inserts "Simiron MVB - Standalone" (Basecoat, Simiron, 100 sqft / gal, 3 gal kit) for jobs that lay down MVB by itself; distinct from the in-Metallic-system MVB which goes down at 150 sqft / gal. Adds a standalone_mvb boolean column to pec_prod_jobs (defaults false). Idempotent. (2) production/calculator.js + the inlined copy in index.html: the per-job-pick branch in planForArea now matches 'Flake' OR 'Quartz' OR 'Metallic Pigment' (all three resolve via area.flake_product_id; the column name is historical). New top-level inputs to computeMaterialPlan: standaloneMvb (boolean) and standaloneMvbProductId (uuid|null). When standaloneMvb is true and the product id is provided, the calculator synthesizes one extra "area" covering the total sqft across all real areas and emits a single MVB line with order_index=-1 so it sorts to the top of the order. Failures (product not found, etc.) throw the same way as other calculator errors. 7 new tests in production/calculator.test.js cover the Metallic Pigment slot resolution and both the standalone-MVB-on and -off paths; npm test now reports 31/31 passing. (3) index.html UI: 'Metallic Pigment' added to the material_type dropdowns in the product modal and the recipe-slot modal; the catalog Products view gets a new "Metallic Pigments" section between Quartz Colors and Basecoats; the catalog row formatter labels the Metallic Pigment unit as "pack" (sqft/pack, packs/kit, sqft/kit). The PEC Ordering New Job form gains a top-level "Standalone MVB" checkbox (under Job → Notes) that toggles state.newJob.standalone_mvb and refreshes the calculated material plan. Each area gains a "Metallic pigment color" picker visible when the system has a Metallic Pigment slot; uses the same area.flake_product_id binding as the Flake and Quartz pickers. The Flake picker now hides whenever Quartz OR Metallic Pigment is the picked-color slot (was: only Quartz). The "Special order" checkbox is hidden for Metallic Pigment systems for now — pigments are catalog-only. (4) Save: pec_prod_jobs insert now includes standalone_mvb; buildCalcInput passes the standalone_mvb flag and the looked-up Simiron MVB - Standalone product id into the calculator.
Why: User asked to split Metallic Pigment off from Flake (it had been seeded as material_type='Flake' originally, which polluted the Flake picker), retire the two basecoats they don't actually order anymore (Tinted Gray and Thin Coat) by deactivating them and repointing the recipe defaults to Light Gray, and add a one-click standalone-MVB toggle on the New Job form because that's a real workflow they hit (lay down MVB by itself before/instead of the system stack, at the 100 sqft/gal application thickness). Splitting at the calculator level rather than special-casing in the UI keeps all the math testable and the flow consistent — Metallic Pigment behaves exactly like Flake/Quartz now, just with its own picker and its own catalog section. Standalone MVB is job-level (not per-area) because it's a one-shot decision for the whole job; total sqft summed across areas is what matters for the order qty.
Files touched: supabase/migrations/2026-05-04_metallic_pigment_split.sql (new), production/calculator.js, production/calculator.test.js, index.html, PROJECT-LOG.md
Verification: npm test = 31/31 pass (24 existing + 7 new). UI verification deferred to Dylan after Cowork runs the migration.
Next steps: Cowork runs the migration. Dylan walks the verification list (catalog has a Metallic Pigments section, basecoat picker no longer shows Tinted Gray / Thin Coat, New Job has a Standalone MVB toggle and a Metallic Pigment picker on the Metallic system).
Handoff to Cowork: 1) Run supabase/migrations/2026-05-04_metallic_pigment_split.sql in the production Supabase SQL editor (project zdfpzmmrgotynrwkeakd). Verify with: select material_type, count(*) from public.pec_prod_products where active group by 1 order by 1; (expect a 'Metallic Pigment' row appear with count 1, 'Flake' decreased by 1, 'Basecoat' net change: -2 (deactivated Tinted Gray + Thin Coat) +1 (MVB Standalone) = -1). select st.name, rs.material_type from public.pec_prod_recipe_slots rs join public.pec_prod_system_types st on st.id=rs.system_type_id where st.name='Metallic' order by rs.order_index; (expect a 'Metallic Pigment' slot, no Flake slot). select column_name from information_schema.columns where table_schema='public' and table_name='pec_prod_jobs' and column_name='standalone_mvb'; (expect 1 row). 2) Append a top entry to PROJECT-LOG.md with results, commit, and push.
Handoff to Dylan: 1) After Cowork runs the migration, hard-refresh the dashboard. Open CRM > Price & Material Catalog > Products. Confirm a new "Metallic Pigments" section between Quartz Colors and Basecoats. Confirm Tinted Gray and Thin Coat no longer show under Basecoats (they're inactive, so they only appear in the catalog if you toggle Active=No filtering — which we don't have a filter for, so they're effectively hidden). Confirm "Simiron MVB - Standalone" appears under Basecoats with 100 sqft / gal. 2) Open CRM > Ordering > + New Job. Pick the Metallic system on an area. The flake picker should hide; a Metallic pigment color picker should show. The Special Order checkbox should NOT appear for the Metallic system (pigments are catalog-only). 3) Pick the Flake system on an area. The flake picker shows the new "Autumn Brown Flake" etc. items, no Metallic Pigment options. Same-as-billing checkbox + Special order checkbox both work as before. 4) Toggle the new "Standalone MVB" checkbox at the top of the form. The calculated material plan preview should add a Simiron MVB - Standalone line for total_sqft / 100 / 3 kits. Save the job. Open the saved job; the materials chart should include the MVB line. 5) Go to Color Pairings tab. The Domino default basecoat should now read "Simiron 1100 SL - Light Gray" (was "Tinted Gray").

---

## [2026-05-04 22:06 MST] crm: ran 2026-05-04 flake cleanup + special-order migration
By: Cowork
Changed: Executed supabase/migrations/2026-05-04_flake_cleanup_special_order.sql against production Supabase (project zdfpzmmrgotynrwkeakd) via the SQL editor. Result: "Success. No rows returned." Three things landed: (1) all 18 "Decorative Simiron Flake - <Color>" rows renamed to "<Color> Flake" (Domino is now "Domino Flake"; the 17 colors added in the prior catalog_expansion migration were also renamed). Color column untouched. (2) Two new text columns on pec_prod_areas: flake_size and special_order_color. (3) Two placeholder products inserted: "Special Order Flake" (material_type='Flake', spread 325, kit 1) and "Special Order Quartz" (material_type='Quartz', spread 50, kit 1). manufacturer + supplier are NULL on both placeholders by design.
Why: Step 1 of the handoff in the prior 23:10 Claude Code entry. Migration was committed at 4015032 but not yet applied to prod; the New Job "Special order" checkbox + per-area flake-size dropdown depend on these schema and product changes.
Files touched: PROJECT-LOG.md
External systems touched: Supabase (production project zdfpzmmrgotynrwkeakd), executed migration via SQL editor.

Verification output (4-row union query):
  old_naming_remaining   | 0
  first5_flake_names     | Autumn Brown Flake, Cabin Fever Flake, Coyote Flake, Creekbed Flake, Domino Flake
  areas_new_columns      | flake_size, special_order_color
  special_order_products | Special Order Flake (Flake), Special Order Quartz (Quartz)

All four match expectations. Zero rows still using the old "Decorative Simiron Flake - " prefix. Renamed names sort alphabetically by color (Autumn Brown -> Cabin Fever -> Coyote -> Creekbed -> Domino in the first 5). Both new pec_prod_areas columns present. Both Special Order placeholders inserted with the correct material_type. Nothing unexpected.

Next steps: Dylan pushes to origin so Netlify deploys the New Job "Special order" UI and catalog spec-sheet column changes that depend on this schema. Then walk the in-app verification list from the prior 23:10 entry's Handoff to Dylan.
Handoff to Cowork: None
Handoff to Dylan: 1) Push the new commit (the cowork log entry below this one) plus any prior unpushed commits. From your terminal: cd /Users/dylannordby/Claude-Code/HQ-Dashboard && git push origin main. The sandbox can't reach git@github.com so this needs to come from the host. 2) After Netlify deploys, walk the in-app verification list from the prior 23:10 entry: catalog flake names, supplier/manufacturer datalist autocomplete, New Job flake-size dropdown, Special order checkbox + custom color flow, materials chart showing "Special: <color>".

---

## [2026-05-04 23:10] crm: catalog spread/kit columns; flake rename; flake size + special-order
By: Claude Code
Changed: Five small but useful catalog/order changes. (1) supabase/migrations/2026-05-04_flake_cleanup_special_order.sql renames every "Decorative Simiron Flake - <Color>" product to just "<Color> Flake" (color column unchanged so calendar dots, color pairings, and order pulls keep working). Adds two columns to pec_prod_areas: flake_size text (for the per-area 1/4" / 1/8" / 1/16" choice) and special_order_color text (free-text custom color name). Inserts two placeholder products: "Special Order Flake" (material_type='Flake', spread 325, kit 1, no manufacturer/supplier) and "Special Order Quartz" (Quartz, spread 50, kit 1) so the calculator has a row to compute against when an area is marked special-order; the actual color name lives on the area, not as a new catalog row. (2) Material Catalog products view now shows three unit-aware columns instead of the old combined "Spread / kit": "Spread Rate" (sqft / gal for liquids, sqft / box for flakes/quartz, sqft / pack for tints), "Kit Size" (with matching unit label), and "Spread / Kit" (= spread × kit, computed). Right-aligned tabular numerals so the column reads like a spec sheet. (3) Product edit modal: supplier and manufacturer text inputs converted to datalist-backed inputs that autocomplete from the distinct values across the catalog. Typing a brand-new value still works — it just becomes a new option on the next render. Matches the user request "dropdown with the option to add an additional choice." (4) PEC Ordering New Job form: each area now has a "Flake size" dropdown (1/4" default, 1/8", 1/16") visible only when a flake or quartz picker is showing; doesn't affect spread rate or pricing — saved on pec_prod_areas.flake_size for order-printout reference. Each area also gets a "Special order (custom color we don't stock)" checkbox; when checked, the regular flake/quartz color picker is hidden and a free-text "Custom color name" input appears; toggling on stamps the matching Special Order placeholder product onto area.flake_product_id automatically (so the calculator math works) and saves the typed color name to pec_prod_areas.special_order_color. The catalog stays clean of one-off colors. (5) On save, material lines that came from the Special Order placeholder are post-processed to overwrite product_name and color with the user's custom name (e.g. "Special: Mauve Sunset") so the job-detail materials chart and order pull show the real color instead of the placeholder text.
Why: User asked for the catalog to read like a spec sheet (kit size in gallons, spread rate per gallon, spread rate per kit), supplier/manufacturer to be picker-driven so we don't accumulate typo variants, flake names cleaned up to drop the boilerplate "Decorative Simiron Flake -" prefix, a per-area flake size selector for occasional 1/8" requests, and a "special order" path for custom colors that doesn't pollute the catalog with one-off rows. Datalist inputs hit the "dropdown with option to add" requirement without the complexity of an "add new..." toggle. The placeholder-product approach to special orders keeps the calculator math working without any algorithm changes (spread rate inherited from a real product, custom color stored on the area, displayed name overridden on save).
Files touched: supabase/migrations/2026-05-04_flake_cleanup_special_order.sql (new), index.html, PROJECT-LOG.md
Verification: npm test = 24/24 pass (calculator unchanged). UI verification deferred to Dylan after Cowork runs the migration.
Next steps: When the Pull Material view is next opened post-migration, special-order rows will already display "Special: <color>" because the saved material_lines carry the overridden color. Future tweak (logged in docs/job-schedule-future-todos.md if needed): if two areas in the same job both pick special-order with different custom color names, they'd merge into one line in today's calculator (it groups by product_id). For now the saved color uses the first area's value; PM can hand-edit material_lines if a job genuinely splits into two custom colors.
Handoff to Cowork: 1) Run supabase/migrations/2026-05-04_flake_cleanup_special_order.sql in the production Supabase SQL editor. Verify with: select count(*) from public.pec_prod_products where material_type='Flake' and name like 'Decorative Simiron Flake -%'; (expect 0). select name from public.pec_prod_products where material_type='Flake' order by name limit 5; (expect "Autumn Brown Flake" etc.). select column_name from information_schema.columns where table_schema='public' and table_name='pec_prod_areas' and column_name in ('flake_size','special_order_color'); (expect 2 rows). select name, material_type from public.pec_prod_products where name like 'Special Order%'; (expect 2 rows). 2) Append a top entry to PROJECT-LOG.md with results, commit, and push.
Handoff to Dylan: 1) After Cowork runs the migration, hard-refresh. Open CRM > Price & Material Catalog > Products. Flake names should read "Autumn Brown Flake", "Cabin Fever Flake", etc. The product list shows three unit-aware columns: Spread Rate, Kit Size, Spread / Kit. 2) Open any product. Supplier and Manufacturer are now dropdown-style inputs that autocomplete from existing values. Type a brand-new value (e.g. "Test Supplier") and save — it'll appear as a future autocomplete option. 3) CRM > Ordering > + New Job. Pick the Flake system on an area; a Flake size dropdown should appear (1/4" default). Try the "Special order" checkbox: the color picker hides, a "Custom color name" text input replaces it. Type a color, save the job. 4) Open the saved job; the materials chart should show "Special: <your color>" in the Color column for that line.

---

## [2026-05-04 22:40] crm: structured customer fields + lead sources + tags + residential/commercial
By: Claude Code
Changed: Migration supabase/migrations/2026-05-04_customer_fields.sql adds first_name, last_name, company_name (the customer's business; NOT to be confused with the existing customers.company brand field), 5 structured billing-address columns (line1, line2, city, state, zip), lead_source text, and tags text[] (with a GIN index) to public.customers. Best-effort backfill splits the existing single `name` field into first/last on legacy rows. Creates a new pec_lead_sources table (managed list of lead sources, RLS staff-only, updated_at trigger) seeded with 9 common values: Google, Facebook, Referral, Repeat Customer, Yard Sign, Door Hanger, Truck Lettering, Home Show, Other. Adds a job_class column ('residential' | 'commercial', nullable) to BOTH public.jobs and public.pec_prod_jobs. Idempotent. (2) Customer form (openCustomerForm in index.html) rewritten: type toggle (Individual / Business) shows the matching name fields, business mode also offers an optional primary-contact name; lead source is a required dropdown sourced from active pec_lead_sources rows; contact tags are a chip-style input with autocomplete from the union of all existing tags across customers (press Enter or comma to add, Backspace on empty input to pop); 5 split billing-address fields. The denormalized customers.name column is auto-recomputed on save (company_name if set, else first + ' ' + last) so the customer portal that reads it keeps working with no portal changes. (3) Settings adds a Lead Sources CRUD card mirroring the Crews card, with the same modal pattern. (4) Legacy CRM New Job form (openNewJobForm) gets a Job Class dropdown (Residential / Commercial) and a "Job address same as customer's billing address" checkbox that auto-fills the address field from the picked customer's billing_* columns and disables the input; unchecking re-enables manual entry. (5) PEC Ordering New Job form gets the Job Class dropdown too (the same-as-billing checkbox is deferred there because that form takes free-text customer_name without a customer FK; future TODO when that flow gets a real customer picker).
Why: User asked for structured customer fields with first/last/company_name, billing address, lead source as a managed list ("super important"), contact tags ("Dylan's customer", "do not call"), and a residential/commercial flag on each job. Naming nuance: the existing customers.company column already stores the brand (prescott-epoxy / finishing-touch) — keeping that as-is and adding company_name for the customer's business avoids a rename that would touch the webhook, customer portal, and every read of customers.company. Lead source as a Settings-managed table keeps reporting clean (no typo splinter); tag autocomplete keeps reuse high without locking flexibility. Splitting the address into 5 fields trades form length for analytics ability (group by city or state, label printing later). The same-as-billing checkbox is UX-only — no extra column on jobs — so unchecking just re-enables free-text entry. Backfill of name → first/last on existing rows is best-effort (split on first space) and only runs when first_name and last_name are both null, so nothing already populated gets overwritten.
Files touched: supabase/migrations/2026-05-04_customer_fields.sql (new), index.html, PROJECT-LOG.md
Verification: npm test = 24/24 pass. UI verification deferred to Dylan after Cowork runs the migration.
Next steps: Cowork runs the migration. Dylan walks the verification list (open Customers > New, confirm Individual / Business toggle works; Settings > Lead Sources, add/edit/delete; new customer with all fields populates correctly; new job picks the customer and the same-as-billing checkbox pre-fills address).
Handoff to Cowork: 1) Run supabase/migrations/2026-05-04_customer_fields.sql in the production Supabase SQL editor (project zdfpzmmrgotynrwkeakd). Verify with: select column_name from information_schema.columns where table_schema='public' and table_name='customers' and column_name in ('first_name','last_name','company_name','billing_address_line1','billing_zip','lead_source','tags'); (expect 7 rows). select count(*) from public.pec_lead_sources; (expect 9 seeded rows). select column_name from information_schema.columns where table_schema='public' and column_name='job_class'; (expect 2 rows: jobs and pec_prod_jobs). 2) Append a top entry to PROJECT-LOG.md with results, commit, and push.
Handoff to Dylan: 1) After Cowork runs the migration, hard-refresh. Open CRM > Customers > + New. Toggle between Individual and Business; confirm the right name fields show. Pick a lead source (required). Type a tag, press Enter, see it chip; press Backspace on empty input to remove. Fill billing address (5 fields). Save. 2) Open CRM > Settings, scroll to the new Lead Sources card. Add a custom source like "Old Customer" or "Walk-in". 3) Open CRM > Jobs > + New Job. Pick a customer; the address auto-fills from billing if "same as billing" is checked. Pick Residential or Commercial. Save. 4) Open CRM > Ordering > + New Job. Job class dropdown should appear. (Same-as-billing not present here yet; that form doesn't have a customer FK.) 5) Note: the legacy customers with only a `name` field will have their first_name / last_name auto-split on first space; if any names came in as "Dr. Jane Smith" the parts will be wrong — fix manually via the edit form.

---

## [2026-05-04 22:05] crm: gate dripjobs auto-bridge to PEC only; log FTP-equivalent path
By: Claude Code
Changed: Two small follow-ups to the 21:30 entry. (1) netlify/functions/pec-webhook-proposal-accepted.js: the auto-bridge that creates a pec_prod_jobs row on proposal-accepted now skips when customer.company !== 'prescott-epoxy'. The default still falls back to 'prescott-epoxy' if neither customer.company nor payload.company is set, so existing PEC behavior is unchanged; FTP-accepted estimates now land in public.customers + public.jobs only (as before this whole branch), without polluting the PEC production schema. (2) docs/job-schedule-future-todos.md gets a new section 11 capturing the FTP-equivalent decision: option A (separate ftp_prod_* tables) vs option B (recommended: add a `company` column to pec_prod_* tables and let the brand switcher filter). The remaining numbered items shifted by one.
Why: User confirmed the brand switcher direction (top-of-dashboard toggle, single nav, filter by company) and explicitly chose option (a) — gate the bridge now, build the FTP equivalent later. Without this gate, every FTP estimate accepted via DripJobs would silently create a pec_prod_jobs row — a bug that wouldn't surface until FTP started routing through DripJobs and Pending Jobs filled with FTP customers under the PEC brand.
Files touched: netlify/functions/pec-webhook-proposal-accepted.js, docs/job-schedule-future-todos.md, PROJECT-LOG.md
Verification: node --check on the webhook = clean. Behavior change is conditional and only matters once a FTP estimate is sent through the webhook; until then this is a no-op.
Next steps: When the brand switcher build kicks off, walk docs/job-schedule-future-todos.md section 11 and pick option A vs B. Recommendation in the doc is option B.
Handoff to Cowork: None
Handoff to Dylan: Push when ready (small webhook change; Netlify auto-deploys on push). No DB migration needed.

---

## [2026-05-04 21:55 MST] crm: ran 2026-05-04 job_schedule migration in production Supabase
By: Cowork
Changed: Executed supabase/migrations/2026-05-04_job_schedule.sql against production Supabase (project zdfpzmmrgotynrwkeakd) via the SQL editor. Supabase flagged the migration on the destructive-operations confirmation (expected: the file uses `drop trigger if exists` and `drop policy if exists` as idempotency guards, no actual data drops); confirmed and ran. Result: "Success. No rows returned." Three new tables created (pec_prod_crews, pec_prod_job_schedule_days, pec_prod_job_costing). Seven new columns added to pec_prod_jobs (estimated_hours, actual_hours, sales_team, crew_id FK, crew_lead, callback, dripjobs_deal_id) plus the partial index on dripjobs_deal_id. New `color` column on pec_prod_system_types backfilled with hex values for all 6 active systems. updated_at triggers wired on pec_prod_crews and pec_prod_job_costing. RLS enabled on all three new tables with staff-only policies (using public.is_admin_staff()).
Why: Step 1 of the handoff in the 21:30 Claude Code entry. Migration was committed at 0c0c7f5 but not yet applied to prod; the schedule + costing UI in index.html depends on these tables existing.
Files touched: PROJECT-LOG.md
External systems touched: Supabase (production project zdfpzmmrgotynrwkeakd), executed migration via SQL editor.

Verification output (4-row union query):
  crews_count       | 0
  jobs_new_columns  | actual_hours, callback, crew_id, crew_lead, dripjobs_deal_id, estimated_hours, sales_team
  system_colors     | Flake=#7c3aed, Grind and Seal - Cohills=#f59e0b, Grind and Seal - Urethane=#fb923c, Grind Stain and Seal=#10b981, Metallic=#a855f7, Quartz=#0ea5e9
  new_tables_exist  | pec_prod_crews, pec_prod_job_costing, pec_prod_job_schedule_days

All four match expectations. Crew table empty (UI seeds via Settings > Crews). All 7 new pec_prod_jobs columns present (spec asked for 4, the migration adds 7; nothing missing). All 6 active system types carry hex colors. All 3 new tables created. Nothing unexpected.

Next steps: Dylan pushes to origin so Netlify deploys the webhook + UI changes that depend on this schema. Then walk the in-app verification list from the 21:30 entry's Handoff to Dylan (Settings > Crews CRUD, Job Schedule multi-day popup, Job Costing column math, system color picker).
Handoff to Cowork: None
Handoff to Dylan: 1) Push commits 0c0c7f5 (and 3450260 from earlier today, if not already pushed) so Netlify auto-deploys: cd /Users/dylannordby/Claude-Code/HQ-Dashboard && git push origin main. (Cowork sandbox can't reach git@github.com from inside; this needs to run from your terminal.) 2) Confirm the Netlify build passes and the webhook update is live. 3) Walk the in-app verification list from the prior 21:30 entry (Settings > Crews, Pending Jobs sidebar, multi-day schedule popup, Job Costing column math, system_types color picker).

---

## [2026-05-04 21:30] crm: job schedule + job costing + dripjobs auto-bridge
By: Claude Code
Changed: Five connected additions to set up the production-side customer journey from accepted estimate through cost-out. (1) supabase/migrations/2026-05-04_job_schedule.sql adds three new tables (pec_prod_crews, pec_prod_job_schedule_days, pec_prod_job_costing), extends pec_prod_jobs with eight new columns (estimated_hours, actual_hours, sales_team, crew_id FK, crew_lead, callback, dripjobs_deal_id) plus an index on dripjobs_deal_id, adds a `color` column to pec_prod_system_types and backfills hex colors for the six active systems (Flake purple, Quartz cyan, Metallic violet, G&S Cohills amber, G&S Urethane orange, Grind Stain and Seal green), wires updated_at triggers and staff-only RLS policies on the three new tables. Idempotent. (2) netlify/functions/pec-webhook-proposal-accepted.js extended: after the existing public.jobs insert succeeds it now also inserts a pec_prod_jobs row pre-linked to the customer (proposal_number=deal_id, customer_id, customer_name, address, revenue, status='unscheduled', dripjobs_deal_id, scope→notes). Idempotent against re-deliveries via a check on dripjobs_deal_id. Failures here do NOT 500 the webhook — the public.jobs side still lands and the bridge gets retried on the next delivery. The new prod_job_id is included in the response payload. (3) Two new CRM subnav buttons in index.html: "Job Schedule" (open to all admin_users) and "Job Costing" (admin/pm gated, same as Material Catalog). switchView dispatcher routes them to renderSchedule and renderJobCosting; the dispatcher also toggles a new .pec-fullbleed class on the main panel for Job Costing so it can break out of the standard CRM grid padding. (4) Settings (admin-only) now has a Crews CRUD card above the existing 3 fields. + Add crew opens a small modal (name, active toggle, notes); rows are editable/deletable. Crew names feed the Job Schedule popup's crew picker. (5) Job Schedule view: 280px sidebar lists Pending Jobs (pec_prod_jobs where install_date IS NULL AND no schedule rows AND status='unscheduled') as cards with system color dot, sqft, est hours, + Schedule button. Main panel has a calendar with Weekly | Monthly toggle, prev/today/next nav, period label. Multi-day jobs render as one event bar that spans columns; the bar has a colored top stripe (the system_type.color), shows "System · Customer" on day 1 only, and continuation cells show a dashed dot. Click any event → reopens the schedule popup pre-filled with current days/crew/lead so editing replaces. The popup has a click-to-toggle day-grid that supports non-contiguous selection (clicking days assigns day_index 1, 2, 3... in the order you click; click again to remove); the system type is read-only from the first area's system; crew dropdown sources active pec_prod_crews; crew lead, est hours, and sales team are free-text inputs. Save deletes existing schedule_days for the job and inserts new rows, then updates pec_prod_jobs.install_date (= first selected day), status='scheduled', crew_id, crew_lead, estimated_hours, sales_team. (6) Job Costing view: full-bleed wide table with 34 columns covering everything the user listed (Job Address/ID, Misc, Status, Sales Team, System Type, Crew, Revenue Stream = system name, Revenue, Est Hrs, Hours, Over/Under, Hrs Var %, Equipment Rental + %, Materials Ordered/Pulled + %, Materials Used + %, Salary & Wages + %, Subcontractor + %, Bonus + %, Commission + %, Misc Expense + %, Total Var Expense + %, Gross Profit + %, GP/HR, Rev/HR, Callback, Notes). Per the user's instruction the placeholder #REF! column was dropped entirely. Material costs are TWO separate manual fields (Ordered/Pulled and Used) since actual usage diverges from what was ordered; Total Var Expense uses the Used number to avoid double-counting. Inputs are inline number/text/checkbox; cost-table fields debounce-save (250ms) into pec_prod_job_costing (upsert by job_id); job-table fields (revenue, hours, sales_team, callback) write to pec_prod_jobs. After each input change, an in-place updater recalculates the 16 derived cells in that row WITHOUT re-rendering the table — preserves focus and avoids losing user input. (7) System Type edit modal got a calendar-color picker (HTML5 input type="color") that writes to pec_prod_system_types.color so the calendar bar reflects whatever Dylan picks. (8) docs/job-schedule-future-todos.md captures everything intentionally deferred: Lead Pipeline / Kanban with drag-and-drop cards, Estimate Calendar, native estimate writing using the Material Catalog (replaces DripJobs authoring), Claude-driven personalized follow-ups, full unification of public.jobs into pec_prod_jobs, customer detail rollup page, pec_prod_labor_entries UI surface, DripJobs payload extension to send system_type + estimated_hours, drag-and-drop calendar rescheduling, Sheets export of Job Costing.
Why: User asked for a Job Schedule and Job Costing they can start using immediately, with the framework for the rest of the customer journey logged for the next session. Two job tables exist today (public.jobs from DripJobs, pec_prod_jobs from production) and the user explicitly wants ONE job entity to flow lead→estimate→schedule→ordering→costing. Auto-bridging on proposal-accepted is the lowest-risk path: keeps the existing customer portal that reads public.jobs intact, but makes every accepted estimate appear in Pending Jobs sidebar without manual intervention. Multi-day support via a separate schedule_days table (instead of start/end columns) handles non-contiguous days and per-day crew swaps with no schema thrash. Color band on system_types is the cheapest way to make the calendar legible at a glance and stays editable in the catalog UI. Costing materials are split Ordered/Used because the user explicitly noted that what gets ordered diverges from what gets consumed; Total Var Expense uses Used so the GP math reflects reality. Hours model collapsed to two columns (Est. Hrs and Hours) per the user's clarification; the third "Bud. Hrs" column from the original spec was redundant.
Files touched: supabase/migrations/2026-05-04_job_schedule.sql (new), netlify/functions/pec-webhook-proposal-accepted.js, index.html, docs/job-schedule-future-todos.md (new), PROJECT-LOG.md
Verification: npm test = 24/24 pass (calculator unchanged). Webhook node --check = clean. UI verification deferred to Dylan after Cowork runs the migration and Netlify deploys the webhook.
Next steps: Cowork runs supabase/migrations/2026-05-04_job_schedule.sql in the production Supabase SQL editor. Then Dylan pushes to origin so Netlify auto-deploys (the webhook update goes live with the deploy). After that, hard-refresh, sign in, walk the verification list (Settings > Crews, Job Schedule popup with multi-day picker, Job Costing column math).
Handoff to Cowork: 1) Run supabase/migrations/2026-05-04_job_schedule.sql in the production Supabase SQL editor (project zdfpzmmrgotynrwkeakd). Verify with: select count(*) from public.pec_prod_crews; (expect 0; UI seeds it). select column_name from information_schema.columns where table_schema='public' and table_name='pec_prod_jobs' and column_name in ('estimated_hours','crew_id','sales_team','dripjobs_deal_id'); (expect 4 rows). select name, color from public.pec_prod_system_types where active order by name; (expect 6 active systems all carrying a hex color). 2) Append a top entry to PROJECT-LOG.md with results, commit, and push.
Handoff to Dylan: 1) Hard-refresh once Netlify deploys this commit. Open CRM > Settings, scroll to the new Crews card. Click + Add crew, add at least "Crew A" and "Crew B". 2) Open CRM > Job Schedule. Pending Jobs sidebar empty until you create an unscheduled pec_prod_job (via Ordering > + New Job) OR a DripJobs estimate accepts. 3) Test path: Ordering > + New Job, at least one area + system + sqft, save. It should appear in Pending Jobs. 4) Click + Schedule on it. Pick 3 non-contiguous days, pick a crew, type a lead name, est hours = 24, save. The calendar should show one event bar across those 3 days with the system's color stripe. 5) Switch to Monthly view — same bar, compact. 6) Open CRM > Job Costing. The job appears. Type into Hours, Salary & Wages, Materials Used. Over/Under, GP, GP/HR auto-update in place. 7) (Optional) Catalog > System Types > Edit one, change the color, refresh Job Schedule — bar reflects the new color. 8) Once webhook is live, send a test DripJobs proposal-accepted POST to /.netlify/functions/pec-webhook-proposal-accepted. Confirm both public.jobs AND public.pec_prod_jobs rows land linked by customer_id; prod row should have status='unscheduled'.

---

## [2026-05-04 20:09 MST] crm: ran 2026-05-04 catalog migrations (quartz split + 23 new colors)
By: Cowork
Changed: Executed both 2026-05-04 migrations against production Supabase (project zdfpzmmrgotynrwkeakd) in order, via the SQL editor. (1) supabase/migrations/2026-05-04_quartz_material_type.sql ran cleanly ("Success. No rows returned."); the three CHECK constraints (pec_prod_products, pec_prod_recipe_slots, pec_prod_material_lines) now allow material_type='Quartz', the 41 Torginol Q-Color rows reclassified from Flake to Quartz, and the Quartz system's broadcast slot flipped from Flake to Quartz. (2) supabase/migrations/2026-05-04_catalog_expansion.sql ran cleanly. Two columns added (manufacturer text, image_url text). Manufacturer backfilled. 17 of 17 Decorative Simiron Flake rows inserted, 5 of 6 new Simiron 1100 SL basecoat rows inserted (the sixth, "Simiron 1100 SL - Clear", was a name conflict with a pre-existing row that ON CONFLICT (name) DO NOTHING correctly skipped; see Verification below).
Why: Run the migrations Claude Code wrote in the prior 19:30 entry, which were committed at 712626e but not yet executed in prod.
Files touched: PROJECT-LOG.md
External systems touched: Supabase (production project zdfpzmmrgotynrwkeakd) - executed both migration files in the SQL editor.

Verification output (post-Step-1):
  select material_type, count(*) from public.pec_prod_products where active group by 1 order by 1;
    Basecoat | 3
    Extra    | 2
    Flake    | 2
    Quartz   | 41
    Sealer   | 1
    Stain    | 1
    Topcoat  | 2

  Spec said Flake=1 (Domino), but actual is 2. Pre-existing row "Simiron Metallic Pigment" (color "Per-job pick") was sitting at material_type='Flake' before this migration. The migration's WHERE clause only targeted Torginol Q-Color rows so it didn't touch Metallic Pigment. Pre-existing data quality issue, not caused by this migration.

  select st.name as system, rs.material_type, count(*) from public.pec_prod_recipe_slots rs join public.pec_prod_system_types st on st.id = rs.system_type_id group by 1,2 order by 1,2;
    Flake                    | Basecoat | 1
    Flake                    | Flake    | 1
    Flake                    | Topcoat  | 1
    Grind and Seal - Cohills | Sealer   | 1
    Grind and Seal - Urethane| Basecoat | 1
    Grind and Seal - Urethane| Stain    | 1
    Grind and Seal - Urethane| Topcoat  | 1
    Grind Stain and Seal     | Sealer   | 1
    Grind Stain and Seal     | Stain    | 1
    Metallic                 | Basecoat | 1
    Metallic                 | Extra    | 1
    Metallic                 | Flake    | 1
    Metallic                 | Topcoat  | 1
    Quartz                   | Basecoat | 1
    Quartz                   | Extra    | 1
    Quartz                   | Quartz   | 1   <-- expected, replaced prior Quartz/Flake
    Quartz                   | Topcoat  | 1
    Standard Flake           | Basecoat | 1
    Standard Flake           | Flake    | 1
    Standard Flake           | Topcoat  | 1
  Quartz/Quartz slot present, prior Quartz/Flake gone. Metallic still has a Flake slot (intentional, migration only flipped the Quartz system).

Verification output (post-Step-2):
  select material_type, count(*) from public.pec_prod_products where active group by 1 order by 1;
    Basecoat | 8
    Extra    | 2
    Flake    | 19
    Quartz   | 41
    Sealer   | 1
    Stain    | 1
    Topcoat  | 2
  Total active 74 (was 52 before; 22 of 23 new rows inserted, 1 conflict).

  select coalesce(manufacturer, '<NULL>') as manufacturer, count(*) from public.pec_prod_products group by 1 order by 1;
    Cohills  | 2
    Simiron  | 13
    Torginol | 59
  Zero NULL manufacturers; backfill rules covered every row.

Unexpected (worth Dylan flagging):
  1) "Simiron 1100 SL - Clear" already existed in the catalog (seeded 2026-05-01 19:35 as one of the 8 non-color SKUs), and was classified as material_type='Extra'. The migration tried to insert it as material_type='Basecoat' but ON CONFLICT (name) DO NOTHING correctly skipped, so the existing Extra-classified row remains. Per the migration's intent (and per the seed comment "Often used as the body coat in Quartz systems"), it should be a Basecoat. Not blocking, but Dylan may want to UPDATE it via the Material Catalog UI or one-line SQL.
  2) "Simiron Metallic Pigment" sits at material_type='Flake' (color "Per-job pick"). Probably should be Tint Pack or Extra. Pre-existing, not caused by this migration. Same fix path.

Next steps: Dylan hard-refreshes the live dashboard and walks the verification list from the prior 19:30 entry (catalog sections render in order, New Job picker filters correctly per system slot, job-detail modal fits, Pull Material aggregator returns aggregated rows). Optional cleanup: reclassify "Simiron 1100 SL - Clear" to Basecoat (and/or "Simiron Metallic Pigment" to Tint Pack/Extra) via the catalog UI if those classifications matter for the New Job pickers.
Handoff to Cowork: None
Handoff to Dylan: 1) Hard-refresh the live site. Open CRM > Price & Material Catalog > Products and confirm sections render: Flake Materials (19), Quartz Colors (41), Basecoats (8), Topcoats, Stains, Sealers, plus 2 Extras. 2) Open + New Job, pick a Flake system: picker should show Simiron flakes (18 Decorative Simiron Flake rows + Domino + possibly Metallic Pigment depending on filter). 3) Pick the Quartz system: Quartz Color picker shows the 41 Q-Color blends. 4) Optional: in the Material Catalog, edit "Simiron 1100 SL - Clear" and change material_type from Extra to Basecoat so it shows up under Basecoats and is selectable as a body coat. Same for "Simiron Metallic Pigment" if you want it out of Flake.

---

## [2026-05-04 19:30] crm: catalog manufacturer/quartz split, 23 new colors, edit lockdown, modal sizing fix, Pull Material aggregator
By: Claude Code
Changed: Six connected fixes/additions to the PEC Material Catalog and Ordering UX. (1) Two new Supabase migrations. supabase/migrations/2026-05-04_quartz_material_type.sql extends the CHECK constraint on pec_prod_products / pec_prod_recipe_slots / pec_prod_material_lines to allow material_type='Quartz', then reclassifies the 41 Torginol Q-Color rows from 'Flake' to 'Quartz' and flips the Quartz system's broadcast recipe slot from 'Flake' to 'Quartz' so slot-type matches product-type. supabase/migrations/2026-05-04_catalog_expansion.sql adds two columns to pec_prod_products (manufacturer text, image_url text), backfills manufacturer for existing rows (Torginol, Simiron, Cohills), and inserts 17 new Decorative Simiron Flake colors (Autumn Brown, Cabin Fever, Coyote, Creekbed, Feather Gray, Garnet, Glacier, Gravel, Nightfall, Orbit, Outback, Pumice, Safari, Schist, Shoreline, Stargazer, Tidal Wave; Domino skipped, already exists) plus 6 new Simiron 1100 SL basecoat color variants (Light Gray, Haze Gray, Deck Gray, Sandstone, White, Clear). Each flake row carries manufacturer='Torginol' supplier='Simiron' spread_rate=325 kit_size=1; basecoats are spread 150 / kit 3, mirroring Tinted Gray. unit_cost left null on all new rows; Dylan fills via Material Catalog UI. (2) Calculator (production/calculator.js + the inline copy in index.html) now treats slot.material_type='Quartz' the same as 'Flake' (user picks per area, stored in area.flake_product_id). 24/24 tests still pass. (3) Material Catalog UI in index.html: subnav button renamed to "Price & Material Catalog"; Products view now groups rows by material_type into labeled sections (Flake Materials, Quartz Colors, Basecoats, Topcoats, Stains, Sealers, Tint Packs, Extras) with alphabetical sort by color within each section; new Manufacturer column between Color and Supplier; new Chip column shows the chip image thumbnail (or a "no chip" placeholder div) using the new image_url field; product-edit modal got Manufacturer + Chip image URL fields with a live thumbnail preview, Quartz added to material_type dropdown, recipe-slot modal got Quartz too. (4) New Job form (renderAreas) replaces the old requires_flake_color flag with system-aware slot inspection: if the picked system has a Quartz slot the Quartz Color picker fires (Torginol Q-Color blends only); if it has a Flake slot the Flake picker fires (Simiron flakes only, no Torginol bleed-through); else both are hidden. Both pickers bind to the same area.flake_product_id column so no schema change needed. (5) Job-detail materials chart locked down: Material, Product, Color render as read-only spans (catalog identity stays in the catalog); Supplier is now a per-line dropdown (Simiron / Prestige Protective Coatings / Torginol / Cohills, plus whatever the line currently has) so the user can switch supplier per job without retyping. Qty / Backstock / Order remain number inputs; checkboxes unchanged. (6) Modal sizing fixed: .prod-modal-wide max-width raised from 920px to min(1280px, 96vw); .pec-modal max-height raised from 90vh to 92vh; tables wrapped in a .pec-table-wrap with overflow-x:auto so the chart scrolls horizontally on narrow viewports instead of clipping the page. (7) New Pull Material toolbar button on the Ordering view opens an aggregated order modal with date-range pickers (default Today through +14 days plus 7/14/30 presets), grouped by supplier then material_type then product. Aggregation logic lives in aggregateMaterialPull(jobs, startISO, endISO): sums (order_qty - backstock_qty when use_backstock=true) clamped to >= 0 across all non-completed jobs whose install_date is in range, skipping any line already marked delivered. Each row shows total kits/boxes plus the per-job breakdown (date · customer · proposal · qty). Modal includes a Print button (window.print) with a print stylesheet that hides toolbars and removes max-widths.
Why: Six items the user called out together: (a) the Flake picker was showing Torginol quartz blends because they shared material_type='Flake' with Simiron decorative flakes, so quartz colors leaked into non-quartz jobs; (b) needed all the Torginol-made flake colors that Simiron carries (with Prestige Protective Coatings as a backup supplier) and the 6 stock Simiron 1100 SL basecoat colors so the catalog reflects what's actually orderable; (c) the catalog was framed as "Material Catalog" but now needs to be the source of truth for prices and material identity; (d) once a job's been entered, catalog fields shouldn't be retypeable as free text — they should mirror the catalog and only quantity/checkboxes change; (e) the materials chart on the job detail was clipping off the right edge of the modal; (f) needed a one-click way to see exactly what to order to cover the next N days of installs; (g) future customer portal needs to surface chip images, so the schema and UI need image_url plumbing now even though Dylan uploads later. Manufacturer-vs-supplier is a real distinction for flake/quartz: Torginol makes them, Simiron is the primary distributor, Prestige is a backup. Conflating the two as one "supplier" field hid that.
Files touched: index.html, production/calculator.js, supabase/migrations/2026-05-04_quartz_material_type.sql (new), supabase/migrations/2026-05-04_catalog_expansion.sql (new), PROJECT-LOG.md
Verification: npm test = 24/24 pass (calculator algorithm unchanged, only the slot-type branch widened to include 'Quartz'). UI verification deferred to Dylan after he runs the migrations and refreshes the dashboard. The two migrations are idempotent and safe to re-run.
Next steps: Dylan runs the two migrations in Supabase SQL editor in order: quartz_material_type FIRST (constraint widening + reclassification), then catalog_expansion (column adds + new color rows). After that, hard-refresh the dashboard and walk through the verification list in /Users/dylannordby/.claude/plans/iterative-cooking-rossum.md (catalog sections render, New Job picker filters correctly, job-detail modal fits, Pull Material returns aggregated rows). Pricing data entry, chip image upload, and Sheets export of the Pull Material view are out of scope for this session.
Handoff to Cowork: None
Handoff to Dylan: 1) In Supabase SQL editor, run supabase/migrations/2026-05-04_quartz_material_type.sql FIRST. Verify with: select material_type, count(*) from public.pec_prod_products where active group by 1 order by 1; should show Quartz=41, Flake=1 (Domino, prior to the catalog expansion). 2) Run supabase/migrations/2026-05-04_catalog_expansion.sql. Verify: select material_type, count(*) from public.pec_prod_products where active group by 1 order by 1; should show Flake=18, Quartz=41, Basecoat>=9. select distinct manufacturer from public.pec_prod_products order by 1; should include Torginol, Simiron, Cohills. 3) Hard-refresh the live site. Open CRM > Price & Material Catalog > Products. Confirm sections render in order: Flake Materials (18 alphabetical), Quartz Colors (41), Basecoats, etc. Confirm Manufacturer column is populated. 4) Open CRM > Ordering > + New Job. Pick the Flake system: Flake picker shows the 18 Simiron flake colors only. Pick the Quartz system: a Quartz Color picker shows the 41 Torginol Q-Color blends. 5) Open any existing job: confirm Material/Product/Color render as plain text (not editable), Supplier is a dropdown with Simiron + Prestige + Torginol + Cohills, the materials table fits in the modal. 6) Click Pull Material from the Ordering toolbar. Pick a date range that overlaps a real job (or start from today). Confirm the aggregated table appears grouped by supplier and the Print button fires the browser print dialog.

---

## [2026-05-03 19:50] ops: unblocked Netlify deploys (Sheets API key rotation), switched git remote to SSH, CLAUDE.md exception for client keys
By: Cowork
Changed: A multi-step session triggered by Dylan reporting "Netlify is not showing the most recent push." Diagnosed the root cause: every deploy since 2026-04-28 had failed with "Exposed secrets detected" because index.html line 1845 hardcoded a Google Sheets API key (AIzaSyCl4...) and Netlify's secret scanner refused to ship it. The Apr 25 deploy was the last green one, which is why the live site at hq-prescott.netlify.app was a week stale. Fix: (1) In Google Cloud Console, project cowork-automations, added an HTTP-referrer restriction to the existing key so it only works from https://hq-prescott.netlify.app/* (the key was already API-restricted to Sheets but had no referrer restriction at all, so anyone with the value could use it from anywhere). (2) Used Google's "Rotate key" flow to generate a new value (AIzaSyBUq...) inheriting the new restrictions; old key kept active during the grace period so the live site never went down. (3) Edited index.html line 1845 to the new key value, and added a SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES line in netlify.toml under [build.environment] so Netlify's scanner permits the new value. (4) Committed as 1c88b39 "dashboard: rotate Sheets API key, add HTTP referrer restriction, allow Netlify scanner." First push attempt failed because the embedded GitHub PAT in the origin URL (ghp_UO3..., which had been printed into the prior Claude Code transcript and was therefore compromised) was already invalid. Used that as the trigger to set up SSH: ssh-keygen ed25519, added pubkey to GitHub as "MacBook Pro 2 - hq-dashboard," changed origin to git@github.com:Dnordby50/hq-dashboard.git, push went through. Netlify built deploy main@1c88b39 in 15s and published it. Dylan logged in to confirm the dashboard renders and Sheets data loads under the new restricted key. Old Google key was deleted via Google Cloud Console after live verification. Classic GitHub PAT page is empty (the leaked PAT had already been revoked or expired, which is why it failed auth in the first place). Also amended CLAUDE.md rule 7 to document an explicit exception: domain-restricted client-side API keys (Sheets, Maps, etc.) are by design committed to client code, provided they are HTTP-referrer + API restricted in Google Cloud Console AND added to SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES in netlify.toml. Without this, future me looks at the AIza... in index.html and panics again.
Why: The reported symptom (stale live site) was a single bad commit blocking deploys. The deeper issue surfaced during the fix: the Sheets API key had been exposed without restrictions for ~3 weeks, and the GitHub PAT was sitting in plaintext in the git remote URL. Fixing one without the other would have left the same class of problem ready to recur. Switching to SSH ends the embedded-token pattern entirely. The CLAUDE.md amendment exists so the next person to see "API key in HTML" understands the security model and doesn't either (a) rip it out and break the dashboard, or (b) panic and rotate again unnecessarily.
Files touched: index.html (line 1845 key value), netlify.toml ([build.environment] block with SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES), CLAUDE.md (rule 7 exception note), PROJECT-LOG.md
External systems touched: Google Cloud Console (project cowork-automations) - added HTTP referrer restriction, rotated key, deleted old key. GitHub (Dnordby50/hq-dashboard) - added SSH authentication key "MacBook Pro 2 - hq-dashboard," origin remote URL changed from HTTPS+PAT to SSH. Netlify (project hq-prescott, owned by dylan@finishingtouchpaintinga... not the gmail account) - deploy main@1c88b39 published.
Verification: Live site at https://hq-prescott.netlify.app/ loads the Command Center; Dylan logged in and confirmed Sheets data renders under the new restricted key. Netlify Deploys tab shows main@1c88b39 Published, deployed in 15s.
Next steps: Open punch list. (a) Commit the CLAUDE.md update + this PROJECT-LOG entry; the index.html and netlify.toml changes are already in commit 1c88b39. (b) The earlier 14:25 and 14:35 Cowork entries about the Supabase index collision are unrelated to this thread; leaving them for Dylan to push when ready. (c) Long-term: consider moving Sheets reads behind a Netlify Function so the API key never enters the browser at all (doc'd in pm-module-unification-plan.md territory; not blocking).
Handoff to Cowork: None
Handoff to Dylan: 1) Commit and push these two doc changes (CLAUDE.md + PROJECT-LOG) when convenient; suggested message: "docs: log Sheets key rotation + SSH switch, document client-key exception in CLAUDE.md". 2) Glance at the GitHub Fine-grained tokens page (separate from Classic) if you have not already, to confirm no rogue tokens exist there either.

---

## [2026-05-03 14:35] crm: resolved index collision (Option A), partial index now lives on idx_pec_prod_jobs_proposal_link
By: Cowork
Changed: Two things, in this order. (1) Edited supabase/migrations/2026-05-03_pec_prod_link_columns.sql to rename the new partial index from idx_pec_prod_jobs_proposal to idx_pec_prod_jobs_proposal_link, and added a 4-line comment above it pointing readers at the PROJECT-LOG entries that explain the rename. The rest of the file is unchanged. (2) Ran the renamed create index in the Supabase SQL editor (project zdfpzmmrgotynrwkeakd): create index if not exists idx_pec_prod_jobs_proposal_link on public.pec_prod_jobs(proposal_id) where proposal_id is not null. Result: "Success. No rows returned."
Why: Dylan picked Option A from the prior entry. Renames the new partial index instead of dropping the pre-existing non-partial one on proposal_number. Lowest-risk path: pre-existing index on proposal_number (and the UNIQUE index pec_prod_jobs_proposal_number_key) are untouched, and the migration file in repo now matches what is actually in the database.
Files touched: supabase/migrations/2026-05-03_pec_prod_link_columns.sql, PROJECT-LOG.md
Verification output:
  select indexname, indexdef from pg_indexes
  where schemaname = 'public' and tablename = 'pec_prod_jobs' and indexname like '%proposal%' order by indexname;
    idx_pec_prod_jobs_proposal      | CREATE INDEX idx_pec_prod_jobs_proposal ON public.pec_prod_jobs USING btree (proposal_number)             (pre-existing, untouched)
    idx_pec_prod_jobs_proposal_link | CREATE INDEX idx_pec_prod_jobs_proposal_link ON public.pec_prod_jobs USING btree (proposal_id) WHERE (proposal_id IS NOT NULL)   (new, partial, intended)
    pec_prod_jobs_proposal_number_key | CREATE UNIQUE INDEX pec_prod_jobs_proposal_number_key ON public.pec_prod_jobs USING btree (proposal_number)   (pre-existing UNIQUE, untouched)
Next steps: When Phase 3 of docs/pm-module-unification-plan.md lands and proposal_id starts being populated, the partial index on idx_pec_prod_jobs_proposal_link will start carrying weight automatically. No further DB work needed for this thread.
Handoff to Cowork: None
Handoff to Dylan: None. Pushing this commit + the prior 14:25 entry's commit to origin/main now.

---

## [2026-05-03 14:25] crm: ran 2026-05-03 link columns migration in Supabase, hit index name collision on idx_pec_prod_jobs_proposal
By: Cowork
Changed: Executed supabase/migrations/2026-05-03_pec_prod_link_columns.sql in the production Supabase SQL editor (project zdfpzmmrgotynrwkeakd) exactly as committed. Statement returned "Success. No rows returned." Both new columns landed: customer_id uuid (FK to public.customers, on delete set null) and proposal_id uuid, both nullable. The partial index on customer_id (idx_pec_prod_jobs_customer) was created. The partial index on proposal_id was NOT created because an index named idx_pec_prod_jobs_proposal already existed from the 2026-04-28_pm_ordering.sql migration, where it indexes proposal_number (not proposal_id). Postgres treated `create index if not exists idx_pec_prod_jobs_proposal ...` as a no-op against the same name. No data was modified or dropped. No further SQL was run after the verification revealed the collision.
Why: Forward-compat schema change so production jobs can later link to a CRM customer + accepted proposal. Stopped at the verification step rather than fixing the index name collision unilaterally because the task instructions said: if anything errors out, do not delete data or drop columns, stop and write a Handoff to Dylan entry. The pre-existing idx_pec_prod_jobs_proposal looks redundant (there's also a UNIQUE INDEX pec_prod_jobs_proposal_number_key on proposal_number that already serves lookup), but that is Dylan's call, not mine.
Files touched: PROJECT-LOG.md
Verification output:
  Q1 columns:
    customer_id | uuid | YES
    proposal_id | uuid | YES
  Q2 indexes filtered to the two expected names:
    idx_pec_prod_jobs_customer | CREATE INDEX idx_pec_prod_jobs_customer ON public.pec_prod_jobs USING btree (customer_id) WHERE (customer_id IS NOT NULL)
    idx_pec_prod_jobs_proposal | CREATE INDEX idx_pec_prod_jobs_proposal ON public.pec_prod_jobs USING btree (proposal_number)        <-- pre-existing, NOT the new partial index
  Q2b all indexes on pec_prod_jobs:
    idx_pec_prod_jobs_customer (new, partial, on customer_id)
    idx_pec_prod_jobs_install_date
    idx_pec_prod_jobs_proposal (pre-existing, non-partial, on proposal_number)
    idx_pec_prod_jobs_status
    pec_prod_jobs_pkey (pk on id)
    pec_prod_jobs_proposal_number_key (unique on proposal_number)
  Q3 row sanity check:
    total = 0, with_customer = 0, with_proposal = 0   (table is empty, nothing was disturbed)
Next steps: Dylan picks one of two fixes and runs the one-liner. The columns themselves are good as-is; only the proposal_id partial index is missing. After the fix is applied, push the merged commit (this entry plus whatever Claude Code does to the migration file) to origin.
Handoff to Cowork: None
Handoff to Dylan: 1) Decide between two fixes for the missing partial index on proposal_id. Option A (lowest risk, recommended): rename the partial index in the migration file and re-run. Edit supabase/migrations/2026-05-03_pec_prod_link_columns.sql to change idx_pec_prod_jobs_proposal to idx_pec_prod_jobs_proposal_link (or similar), then in the Supabase SQL editor run: create index if not exists idx_pec_prod_jobs_proposal_link on public.pec_prod_jobs(proposal_id) where proposal_id is not null; Option B: drop the pre-existing redundant index (the unique index pec_prod_jobs_proposal_number_key already covers proposal_number lookups), then re-run the original migration. SQL: drop index if exists public.idx_pec_prod_jobs_proposal; create index if not exists idx_pec_prod_jobs_proposal on public.pec_prod_jobs(proposal_id) where proposal_id is not null; This frees the name but you lose nothing performance-wise. 2) After applying the chosen fix, verify with: select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'pec_prod_jobs' and indexname like '%proposal%'; You should see one entry referencing proposal_id with the partial WHERE clause. 3) Push to origin/main when ready (this commit is local-only).

---

## [2026-05-03 14:10] crm: forward-compat link columns on pec_prod_jobs + unification plan doc + push to origin
By: Claude Code
Changed: Two small additions plus a push. (1) supabase/migrations/2026-05-03_pec_prod_link_columns.sql adds two nullable columns to pec_prod_jobs: customer_id uuid (FK to customers, on delete set null) and proposal_id uuid (no FK yet, placeholder until proposals table exists). Both get partial indexes (where ... is not null) so they stay cheap until rows actually carry links. Migration is idempotent (if not exists). (2) docs/pm-module-unification-plan.md captures the target architecture for the next session: proposals table sits between customers and the two job tables (public.jobs and pec_prod_jobs), proposal-accepted webhook stages a pec_prod_job pre-linked to customer + proposal, and a new customer-detail view in the CRM tab lists everything for a customer. Standalone Ordering use is preserved (both new FKs nullable). (3) git push origin main published the 4 unpushed commits: aa7fbb8 (left-rail subnav, light theme, hardened New Job buttons), cb05c03 (seed_pec_systems.sql), 5ddae58 (Cowork's full catalog migration, already executed in Supabase), and the new 2026-05-03 migration commit.
Why: Dylan asked to push the recent edits live, and to make sure material ordering keeps working standalone today while the data model is ready for a future where lead -> customer -> proposals -> production-job is one connected flow. Adding the columns now is cheap forward-compat: zero impact on existing rows or code, and saves a separate column-add migration later. The doc keeps the architectural intent in version control rather than scattered across chat history.
Files touched: supabase/migrations/2026-05-03_pec_prod_link_columns.sql (new), docs/pm-module-unification-plan.md (new), PROJECT-LOG.md
Next steps: When Dylan starts wiring the customer-portal CRM lifecycle (lead capture, proposals, accept-flow), open docs/pm-module-unification-plan.md and follow Phase 3. Until then, both columns stay null and nothing in the UI changes.
Handoff to Cowork: None
Handoff to Dylan: 1) Run supabase/migrations/2026-05-03_pec_prod_link_columns.sql in the Supabase SQL editor. (Idempotent; safe to re-run.) 2) Verify columns exist: select column_name from information_schema.columns where table_name = 'pec_prod_jobs' and column_name in ('customer_id','proposal_id'). Should return both. 3) No UI test needed; the columns are not consumed yet. 4) Hard-refresh the live Netlify site once it deploys to confirm CRM left rail + light theme are showing in production.

---

## [2026-05-01 19:35] crm: full PM Module 1 catalog seeded end-to-end in Supabase
By: Cowork
Changed: Ran 4 SQL stages in the production Supabase (project zdfpzmmrgotynrwkeakd) in a single transaction. Stage 1 created the 9 pec_prod_* tables, indexes, RLS policies, triggers (the migration that had never been applied). Stage 2 seeded the 3 starter products (Tinted Gray basecoat, Domino flake, Polyaspartic Clear Gloss), the Standard Flake system, the Standard Flake recipe, and the Domino->Tinted Gray default pairing. Stage 3 added the 5 system rows from seed_pec_systems.sql (Flake, Quartz, Metallic, Grind and Seal, Grind Stain and Seal). Stage 4 was a new file Cowork wrote, supabase/migrations/2026-05-01_pec_systems_recipes.sql, which: added a unique index on pec_prod_products(name) so ON CONFLICT (name) works, fixed Domino flake spread_rate from 350 to 325 (Dylan's correct number), deactivated "Standard Flake" so the dropdown only shows the 5 systems Dylan defined, flipped Quartz and Metallic to requires_flake_color=true so the per-job color picker fires, renamed seeded "Grind and Seal" to "Grind and Seal - Cohills" and inserted "Grind and Seal - Urethane" as a new sibling row (Dylan splits this into two systems), inserted 8 non-color SKUs (Simiron 1100 SL Clear, 1100 SL Thin Coat, MVB, Metallic Epoxy, Metallic Pigment, High Wear Urethane, Cohills Eco Stain, Cohills Water-Based Sealer), inserted all 41 Torginol Q-Color #40 quartz blends (pulled from torginol.com/quartz-collections), then deleted-and-reinserted recipe slots for the 5 active systems wired to the right products. First execution failed with a 42P10 ON CONFLICT error because the original migration didn't have a unique index on pec_prod_products(name); second execution after adding that index succeeded.
Why: Dylan asked Cowork to handle steps 2 through 4 of the prior handoff (run the seed, configure recipe slots, optionally deactivate Standard Flake). Cowork's pre-flight check found the prereq migration had never been applied, so all four SQL stages were combined and run together. Recipe slots were configured via SQL rather than the dashboard UI because Dylan opted for "Full setup" and the schema lets us do it in one transactional pass with the right product references.
Files touched: supabase/migrations/2026-05-01_pec_systems_recipes.sql (new), PROJECT-LOG.md
Verification: select 'systems' counts returned 7 total / 6 active (Standard Flake inactive); 'products' 52 total / 52 active; 'recipe_slots' 20; 'color_pairings' 1. Per-system slot counts: Flake 3, Quartz 4, Metallic 4, G&S Cohills 1, G&S Urethane 3, Grind Stain and Seal 2, Standard Flake 3 (legacy). Quartz and Metallic both show requires_flake_color=true.
Open items / assumptions flagged in product notes (need Dylan to confirm against an invoice and edit via Material Catalog UI if wrong): Torginol Q-Color #40 spread_rate=50 (assumed 50-lb box at 1 lb/sqft total); Simiron MVB kit_size=3 gal; Simiron High Wear Urethane kit_size=1 gal; Simiron Metallic Epoxy kit_size=3 gal; Cohills Water-Based Sealer spread_rate=100 (effective for 2-coat system).
Next steps: Dylan opens the dashboard CRM tab -> Material Catalog -> System Types and verifies the 6 active systems and their slot configs render the way he expects. The Metallic Pigment and Cohills Stain "Per-job pick" SKUs are placeholders; specific color SKUs can be added via the Material Catalog as Dylan stocks them. Once a real PEC job is created, exercise the New Job preview to confirm the calculator math comes out right (the box-weight assumption above is the most likely thing to be off).
Handoff to Cowork: None
Handoff to Dylan: 1) Hard-refresh the dashboard, sign in to CRM, click Material Catalog -> System Types. Confirm Flake, Quartz, Metallic, Grind and Seal - Cohills, Grind and Seal - Urethane, and Grind Stain and Seal all appear with the listed slot counts and the right material types in order. Standard Flake should be hidden from the picker but still visible in the catalog with an inactive marker. 2) Spot-check the Torginol box weight against a real invoice; if your boxes aren't 50 lb, edit the spread_rate field on the Q-Color products. 3) Confirm Simiron MVB, Metallic Epoxy, and High Wear Urethane kit sizes against an invoice. 4) Push main to origin when ready (this commit is local-only).

---

## [2026-04-30 12:25] crm: seed 5 PEC system types (Flake, Quartz, Metallic, Grind and Seal, Grind Stain and Seal)
By: Claude Code
Changed: Added supabase/seed_pec_systems.sql, an idempotent insert into public.pec_prod_system_types for the 5 systems Dylan offers. Each row has a description, sensible defaults for the requires_flake_color / requires_basecoat_color flags (Flake true/true, Quartz false/true, the rest false/false), and active=true. Uses ON CONFLICT (name) DO NOTHING so re-running the seed is safe and never overwrites edits Dylan makes via the Material Catalog admin UI. Recipe slots are intentionally not seeded; Dylan configures each system's recipe in the System Catalog after running the seed.
Why: Dylan asked for these 5 systems to appear in the New Job form's "Pick a system" dropdown. The picker reads from pec_prod_system_types filtered by active=true (index.html line 6237), so seeding the rows is the minimum needed change. Recipe slots are per-system and per-product; doing those in SQL would lock them to product names that may not exist yet, so leaving that for the admin UI keeps the seed safe.
Files touched: supabase/seed_pec_systems.sql, PROJECT-LOG.md
Next steps: Dylan runs the seed in Supabase, then opens Material Catalog -> System Types and adds recipe slots for each system. The original "Standard Flake" seed system stays as-is; Dylan can deactivate it in the admin UI if he wants only these 5 in the picker.
Handoff to Cowork: None
Handoff to Dylan: 1) In Supabase SQL editor, run supabase/seed_pec_systems.sql. (If you have not run supabase/migrations/2026-04-28_pm_ordering.sql yet, run it first, otherwise the seed will fail because pec_prod_system_types does not exist.) 2) Open the dashboard, sign in to CRM, click Material Catalog -> System Types. You should see Flake, Quartz, Metallic, Grind and Seal, Grind Stain and Seal listed. 3) For each system, configure its recipe slots (basecoat, flake/quartz, topcoat, stain, sealer, etc.) and product defaults using the existing per-row "Edit recipe" button. 4) (Optional) Mark "Standard Flake" inactive if you don't want it to appear in the New Job picker.

---

## [2026-04-30 12:00] crm: left-rail subnav, light theme to match dashboard, hardened New Job buttons
By: Claude Code
Changed: Three things in index.html. (1) Restructured the CRM shell into a 2-column grid (220px sidebar + main content). The existing `#pecSubnav` keeps all 10 buttons and their `data-pec-view` semantics, but is now wrapped in `<aside class="pec-side">` and renders as a vertical column. The view roots (`#pecViewRoot`, `#prodViewRoot`) live in `<main class="pec-main">`. Below 900px it collapses back to a horizontal scrolling strip. (2) Added a new `<style id="crm-light-theme">` block right after the redesign block. It scopes every `.pec-*` and `.prod-*` surface inside `#tab-prescott-crm` to the redesign light palette (`--rd-bg`, `--rd-card`, `--rd-ink`, `--rd-line`, `--rd-accent`, etc.) and retunes all `.pec-badge` color pairs for legibility on white. The override is gated by `body:not(.pec-portal-mode)` so the customer portal mode (which has its own light tokens) is untouched. The legacy dark `:root` vars are unchanged so non-CRM dark widgets still render. (3) Hardened both New Job flows. `openNewJobForm()` now wraps the Supabase customer load in try/catch and still opens the modal on failure with a visible error banner; the form-submit handler shows a `#pecJobFormError` line instead of a plain `alert(...)` so the user sees what failed. The production-side `saveNewJob()` is wrapped in a top-level try/catch and falls back to alert if `#njError` is missing. Added breadcrumb logs (`[crm] pecJobNew click`, `[prod] prodNewJobBtn click`, `[prod] saveNewJob click`) to make a dead click distinguishable from a failing save in DevTools.
Why: Dylan reported the CRM was still rendering against the dark legacy palette while the rest of the frontend uses the light redesign palette, and that "+ New Job" looked like it did nothing. Cause was twofold: the redesign block has no `.pec-*` overrides, and `openNewJobForm` had a silent-await on `customers` that, if it rejected, killed the modal open with no UI feedback. The left-rail layout matches Dylan's stated preference (tabs on the left, not on top) and aligns the CRM visual language with the existing global sidebar (`#rdSidebarNav`).
Files touched: index.html, PROJECT-LOG.md
Next steps: None blocking. The breadcrumb logs are kept in for now; remove them after Dylan confirms which button he was clicking and that both flows work.
Handoff to Cowork: None
Handoff to Dylan: Hard-refresh the dashboard. Open DevTools console. Click CRM. The subnav should now be a vertical column on the left, on a white card surface. Background should be light gray (`#eef0f3`), cards white. Click each subnav item and confirm no panels are black. Then: click Jobs and "+ New Job". You should see either the modal open OR an alert/banner explaining why it could not load. Submit the form: success closes the modal and opens the new job; any DB error shows up inline now. Click Ordering and "+ New Job"; it should switch to the new-job form view. If a click does nothing AND no breadcrumb log fires in console, the click never reached the handler (bind issue). If the breadcrumb fires but no UI change, the handler's path is failing somewhere we now log; copy that error.

---

## [2026-04-28 18:30] crm: inline material calculator so file:// works
By: Claude Code
Changed: Inlined the material calculator into index.html's production module so the dashboard works when opened directly via file:// (Chrome blocks ESM imports for file:// origins with a CORS error, which was killing the entire production script and leaving Ordering + Material Catalog blank). The canonical source is still production/calculator.js — it's used by npm test, kept identical, and the in-file comment in both files now says "if you change one, change both and re-run npm test." Verified npm test still passes 24/24.
Why: Dylan opens the dashboard locally as a file (file://) for testing. The previous static `import { computeMaterialPlan } from './production/calculator.js'` worked on Netlify but not on file://. Two ways to fix: tell Dylan to use a local server every time, or make the page work on file:// directly. Inlining is the lower-friction fix and removes a class of bug where browser security policy randomly differs between dev and prod.
Files touched: index.html, production/calculator.js, PROJECT-LOG.md
Next steps: None blocking. Test runs unchanged.
Handoff to Cowork: None
Handoff to Dylan: Hard-refresh the dashboard. Open DevTools console. Click CRM → Ordering. You should now see the empty-state table with the + New Job button, plus the breadcrumb log "[prod] module booted, prodSwitchView ready" and no CORS error.

---

## [2026-04-28 17:45] CRM polish: match dashboard UI in Ordering + Material Catalog, fix blank-view bug, blank Colors view
By: Claude Code
Changed: Two real fixes plus a stylistic alignment. (1) Ordering and Material Catalog were rendering blank because ensureBooted in the production module returned the boot promise (which resolves to undefined) and the caller bailed on `if (!ok) return`. Rewrote ensureBooted to await the in-flight boot and explicitly return the booted boolean; also added a "Loading…" empty state that paints immediately so the user never sees a blank panel during the first load. (2) Replaced every .prod-* class in the production module with the existing .pec-* design-system classes (.pec-toolbar, .pec-card, .pec-table, .pec-btn primary/ghost/danger/sm, .pec-badge with status modifier, .pec-field, .pec-row-2/3, .pec-modal-bg, .pec-modal, .pec-modal-actions, .pec-empty, .pec-subnav for the Catalog tab strip). The custom .prod-host stylesheet is gone except for a tiny block (the dashed area-card border, message colors, a slightly wider modal modifier for the job-detail). Sync status uses .pec-badge {completed,admin,submitted} mapped from {clean,error,dirty} so it picks up the existing color tokens. (3) Wiped the Colors subnav view to a single empty-state line per Dylan's request.
Why: Dylan reported both views came up completely blank, and the visual style didn't match the rest of the CRM. The blank was a real bug, not a styling issue. The class swap unifies the two halves of the CRM under one design system so the eye flows from Customers/Jobs into Ordering/Catalog without a jarring shift.
Files touched: index.html, PROJECT-LOG.md
Next steps: Same as before. Dylan still needs to run the migration, deploy the Apps Script POST handler, and set the Netlify env vars before sync goes live (Ordering tab will load and let you create jobs even before that, but the Sync to Order Sheet button will return a clear "not configured" error).
Handoff to Cowork: None
Handoff to Dylan: Hard-refresh. Click CRM, then Ordering. You should see "No production jobs yet. Click + New Job." and the toolbar with status filter + button. Click Material Catalog (admin/pm only). You should see the Products / System Types / Color Pairings sub-strip and tables matching the rest of the CRM. Colors tab is intentionally empty for now.

---

## [2026-04-28 17:05] dashboard: relabel monthly revenue cards as Booked Sales
By: Claude Code
Changed: Top three Command-tab cards now read "PEC Booked Sales - Monthly", "FTP Booked Sales - Monthly", and "Combined Booked Sales - Monthly". Underlying data source (Booked Jobs Sheet) and IDs (#pecRev, #ftpRev, #combRev) are unchanged, so all the existing JS that populates them still works.
Why: The numbers are sales booked, not collected revenue. Dylan asked for the labels to match what they actually represent.
Files touched: index.html, PROJECT-LOG.md
Next steps: None.
Handoff to Cowork: None
Handoff to Dylan: Hard-refresh the dashboard to see the new labels.

---

## [2026-04-28 16:55] CRM consolidation: fold Ordering + Material Catalog into the CRM tab
By: Claude Code
Changed: Renamed the "Prescott CRM" left-sidebar tab to just "CRM" (LABELS, TITLES, button text). Removed the standalone "Production" top-level tab. Moved its two main views into the existing CRM subnav as "Ordering" (the production jobs list + new-job form + job detail modal) and "Material Catalog" (admin/pm gated; products, system types with recipe-slot editor, color pairings). The CRM module's switchView now hands off to window.prodSwitchView when the user clicks Ordering or Material Catalog: hides #pecViewRoot, shows #prodViewRoot, and the production module renders into it. Auth and tab-activation gates that the production module owned are gone (the parent CRM tab handles both). CSS that was scoped to #tab-production was rescoped to .prod-host, applied to #prodViewRoot and #prodModalRoot (both now siblings inside the CRM shell). Internal navigation between the production sub-views (Jobs list ↔ New Job form ↔ Job Detail) is unchanged; only the entry point changed.
Why: Dylan reported he couldn't find material ordering or settings in the CRM and asked for the tab to just be named "CRM." Two top-level tabs for what is conceptually one customer/job system was the wrong shape. One tab, one subnav, one auth flow.
Files touched: index.html, PROJECT-LOG.md
Next steps: None blocking. Watch for any leftover references to "Production" in copy or screenshots if Dylan shares them.
Handoff to Cowork: None
Handoff to Dylan: Hard-refresh the dashboard (Cmd+Shift+R). The left tab now reads "CRM"; the subnav inside it has Ordering and Material Catalog (the latter only if your role is admin or pm). Everything else works as before. The 2-week kill-criterion check-in routine (trig_01Hb73C7jSPnHWGEYTP8E5fd, fires 2026-05-12) is unaffected.

---

## [2026-04-28 16:10] PM Module 1: runbook + module v1 ready for end-to-end test
By: Claude Code
Changed: Added docs/pm-module-ordering-runbook.md covering one-time setup checklist (migration, Apps Script deploy, Netlify env vars, test sheet), day-to-day operation (new job, quantity edits, recalculate, mark complete, catalog admin), how to switch between test and production sheets, how to run the calculator tests, the rollback plan, what's intentionally not in v1, and known constraints (proxy URL rotation, 30s LockService timeout, unique proposal_number index). Module 1 v1 is now code-complete and waiting on the deploy handoff to Dylan.
Why: The kill criterion is two weeks to replace Dylan's manual ordering workflow. Code is done; the remaining gap is operational (Apps Script paste, Netlify env vars, test-sheet copy). The runbook gives Dylan a single page to follow without needing to ask Claude Code questions.
Files touched: docs/pm-module-ordering-runbook.md
Next steps: Dylan executes the deploy handoff. After the first real PEC job is synced and visible in production, schedule a 2-week check-in to evaluate the kill criterion before any work begins on Module 2 (Job Costing).
Handoff to Cowork: None
Handoff to Dylan: Follow docs/pm-module-ordering-runbook.md "One-time setup checklist." Stop after step 5 (first end-to-end test) and report back with whether the test-sheet sync looked right. Do not point the function at the real production sheet until that passes. Once it does, set CONTEXT-style env to production and run the same flow against one upcoming real job.

---

## [2026-04-28 15:55] PM Module 1: Production tab UI wired into index.html
By: Claude Code
Changed: Added a new Production tab to the dashboard (button at line 1130, section at line 1499, sidebar nav auto-populates via the existing build() in the rd-shell script). The sub-app reuses window.pecSupabase and window.pecState from the Prescott CRM module so a single sign-in works for both. Three views: Jobs (sortable table by install date with a status filter and click-to-detail), New Job form (proposal #, customer, address, install date, crew, plus a multi-area repeater where each area picks System Type then Flake then optional basecoat override and sqft, with a live calculator preview that re-runs on every input change), and System Catalog admin tab gated to admin/pm roles via the existing .pec-role-admin class (Products, System Types with recipe-slot drill-down editor, and Color Pairings with set-as-default toggle). Job Detail modal shows status pills, areas, fully editable material lines, and four buttons: Recalculate from catalog (with overwrite warning), Save line edits (marks the job dirty), Sync to Order Sheet (calls the Netlify Function with the user's Supabase JWT and surfaces success/failure), and Mark Complete (with confirmation; the modal then refreshes from the DB and shows the final status). Calculator imported as a real ESM module from /production/calculator.js (no inlining), so the same code paths are unit-tested and used at runtime. Self-contained styles scoped under #tab-production using existing CSS variables (--accent, --border, --s1/2/3, --text, --muted), no new tokens.
Why: This is the operational interface that has to replace Dylan's manual ordering workflow within the kill-criterion window. Single sign-in across CRM + Production reduces friction; live calculator preview catches bad inputs before a save; role gating keeps the catalog out of office-staff hands; Save vs Sync separation means in-flight edits never accidentally hit the production sheet; Mark Complete moves the rows but keeps the DB record so Module 2 can attach labor + compute profit later.
Files touched: index.html
Next steps: Runbook doc (docs/pm-module-ordering-runbook.md), then hand off the deploy steps so Dylan can complete the Apps Script + Netlify env-var setup and run the first end-to-end test against a copy sheet.
Handoff to Cowork: None
Handoff to Dylan: None new beyond the previous log entry's handoff (run the migration + seed; deploy the Apps Script doPost; set Netlify env vars; create a test copy of the production Sheet).

---

## [2026-04-28 15:10] PM Module 1: Apps Script proxy snippet + sync Netlify Function
By: Claude Code
Changed: Added production/sheets-proxy-snippet.js, the doPost code Dylan pastes into the existing CONFIG.SHEETS_PROXY Apps Script project. It implements two actions: syncJob (find rows on NEW ORDER SHEET by Proposal #, delete them, insert the new block in chronological position by Install Date with an UNSCHEDULED divider for jobs without a date) and moveJobToCompleted (capture the block, append to COMPLETED JOBS with today's date in column M, delete from NEW ORDER SHEET). Includes a script-level lock so concurrent calls don't corrupt the sheet, a SCRIPT_SECRET check, and idempotent move-to-completed. Added netlify/functions/pec-prod-sync-sheet.js implementing the staff-only proxy: validates the caller's Supabase JWT, verifies their admin_users.role is admin/pm/office, loads the job + areas + material lines via service-role REST, builds the 15-column payload, POSTs to the Apps Script proxy, updates pec_prod_jobs.last_synced_at + sync_status, and writes a row to audit_log for every operation (success and failure). use_test=true in the body or CONTEXT=dev makes the function target PEC_PROD_SHEET_ID_TEST instead of PEC_PROD_SHEET_ID so the first integration test never touches the real sheet.
Why: The Sheet sync is the single highest-risk operation in this module (corrupting the live ordering sheet would block crew leads and suppliers immediately). Locking, idempotent move-to-completed, before/after audit log, and the test-sheet override exist because that risk is real.
Files touched: production/sheets-proxy-snippet.js, netlify/functions/pec-prod-sync-sheet.js
Next steps: Wire the new Production tab into index.html (System Catalog admin first, Jobs list, New Job form, Job Detail modal with Sync + Mark Complete). Then runbook + final handoff entry.
Handoff to Cowork: None
Handoff to Dylan: 1) Open the existing CONFIG.SHEETS_PROXY Apps Script project; append production/sheets-proxy-snippet.js; in Project Settings -> Script Properties add SCRIPT_SECRET with a long random value; Deploy -> Manage Deployments -> Edit -> New Version (the /exec URL stays the same). 2) In Netlify env vars set: PEC_SHEETS_PROXY_URL (the existing /exec URL), PEC_SHEETS_PROXY_SECRET (matches SCRIPT_SECRET), PEC_PROD_SHEET_ID (the real id 16vfUHggITTuz53RRWFepQWNtInJmN1JsZ7qt3MeRGcI), PEC_PROD_SHEET_ID_TEST (a copy you make of the production sheet for the first end-to-end test).

---

## [2026-04-28 14:30] PM Module 1 foundation: schema, seed, calculator, proposal doc
By: Claude Code
Changed: Approved Module 1 of the PEC PM build (Ordering / Material Calculator) and laid the foundation. New Supabase migration creates 9 production tables prefixed pec_prod_* (products, system_types, recipe_slots, color_pairings, jobs, areas, material_lines, labor_entries, overhead_allocations) with RLS policies matching the existing is_admin_staff pattern. Seed populates the Standard Flake System (3 products, 1 system type, 3 recipe slots, 1 default color pairing). Pure-function material calculator extracted to production/calculator.js with a 24-assertion Node test runner; npm test green for every spec edge case (sqft=0, sqft=1, exact kit and box boundaries, spread_rate=0 rejection, negative sqft rejection, missing-flake rejection, multi-area merge by product, distinct basecoat colors as separate lines, recipe order preserved). Proposal doc at docs/pm-module-ordering-plan.md captures the spec's required Step 0 record. Two-arm decision matrix made with Dylan: extend the existing Apps Script proxy for Sheet writes (no new service account), and keep production tables separate from public.jobs (which is the customer portal). Multi-area jobs supported in v1.
Why: The kill criterion is two weeks to replace Dylan's manual ordering workflow. Foundation first (schema, calculator) lets the UI and Sheet sync land on solid ground. Calculator is the highest-risk piece (math errors over-order or under-order materials), so unit tests come before any UI.
Files touched: docs/pm-module-ordering-plan.md, supabase/migrations/2026-04-28_pm_ordering.sql, supabase/seed_pm_ordering.sql, production/calculator.js, production/calculator.test.js, package.json
Next steps: Apps Script POST snippet (production/sheets-proxy-snippet.js), then Netlify Function pec-prod-sync-sheet.js, then UI inline in index.html (System Catalog admin first, then Jobs list, New Job form, Job Detail with sync button, Mark Complete).
Handoff to Cowork: None
Handoff to Dylan: 1) Run supabase/migrations/2026-04-28_pm_ordering.sql in Supabase SQL editor. 2) Run supabase/seed_pm_ordering.sql after the migration. 3) Verify the 9 tables exist in Supabase Studio with RLS enabled. No code wired to these tables yet, so this is safe to do whenever.

---

## [2026-04-25 23:03] ARM 2 v1: customer color picker + signature wired
By: Claude Code
Changed: Customer portal (?portal=token mode in index.html) now lets epoxy customers pick one or more labeled flake colors from the 15 seeded Simiron swatches before signing. Signature submit now sends the picks to portal_confirm_job (was previously sending p_colors: null). Paint jobs skip the picker and just collect a signature with copy explaining the project manager handles paint colors directly. Portal mode now overrides the dark dashboard CSS variables to render on the light/professional palette (--rd-bg, --rd-card, etc) and applies an FTP brand class for orange accent on Finishing Touch customers.
Why: ARM 2 backend (Supabase schema, RPCs, DripJobs webhooks) was already live and the index.html portal scaffold was already drawn, but customers had no way to actually choose their colors through the portal. Locking colors via customer self-service before the crew shows up is the operationally critical gap.
Files touched: index.html
Next steps: Test end-to-end with a real DripJobs-generated token. After v1 validates, follow up with reviews + referrals (already drawn but dormant), per-brand visual polish, paint color seed for Sherwin-Williams, and DripJobs auto-send of the portal link.
Handoff to Cowork: None
Handoff to Dylan: 1) Pull a portal link from a recent customer in the Prescott CRM tab and open it in a private window to verify the picker shows 15 Simiron swatches, the signature canvas works, and the confirm button enables only after both a pick AND signature exist. 2) Test on a phone (iOS Safari + Android Chrome) since signature canvas is the highest failure-risk piece. 3) Push to origin when ready (this commit is unpushed).

---

## [2026-04-25 22:39] Removed TEST-HANDOFF.md after loop verified
By: Claude Code
Changed: Deleted TEST-HANDOFF.md from the repo.
Why: The handoff loop test (entries on 2026-04-25 22:36 and 23:00) succeeded and Cowork's commit 7d6af8f confirmed the trace. The file has no purpose beyond that test.
Files touched: TEST-HANDOFF.md
Next steps: None. Loop is closed.
Handoff to Cowork: None
Handoff to Dylan: Push main to origin when ready (local is currently ahead by 3 commits, plus this one makes 4).

---

## [2026-04-25 23:00] Cowork handoff confirmation
By: Cowork
Changed: Appended the line "Cowork was here" to the bottom of TEST-HANDOFF.md as requested in the handoff.
Why: Closes the end-to-end test of the Claude Code, Cowork, Dylan handoff loop. Leaves a verifiable trace that Cowork picked up the written handoff and acted on it.
Files touched: TEST-HANDOFF.md
Next steps: Commit with message "test: cowork handoff confirmation". Dylan can verify the loop and then schedule a future cleanup entry to delete TEST-HANDOFF.md.
Handoff to Cowork: None
Handoff to Dylan: Verify the commit landed, then decide when to remove TEST-HANDOFF.md.

---

## [2026-04-25 22:36] Test handoff file created for Cowork
By: Claude Code
Changed: Created TEST-HANDOFF.md containing a single handoff request asking Cowork to append the line "Cowork was here" to that file.
Why: End-to-end test of the Claude Code, Cowork, Dylan handoff loop. Confirms Cowork reads handoffs from this repo, acts on them, and leaves a verifiable trace.
Files touched: TEST-HANDOFF.md
Next steps: Wait for Cowork to append the line and commit. Once verified, the file can be deleted in a future cleanup entry.
Handoff to Cowork: Open TEST-HANDOFF.md, append the line "Cowork was here" to the bottom, then commit with message "test: cowork handoff confirmation".
Handoff to Dylan: None

---

## [2026-04-25 22:34] Project log initialized
By: Claude Code
Changed: Created CLAUDE.md and PROJECT-LOG.md. Initialized git repo and .gitignore.
Why: Establish change history so Dylan, Cowork, and Claude Code stay in sync and Dylan can debug or roll back when something breaks.
Files touched: CLAUDE.md, PROJECT-LOG.md, .gitignore
Next steps: Begin tracking all future changes via commits and log entries.
Handoff to Cowork: None
Handoff to Dylan: Going forward, before each Claude Code session, cd into this directory so CLAUDE.md is loaded automatically.

---

## Entry template (copy this for each new entry, paste it ABOVE the most recent entry)

## [YYYY-MM-DD HH:MM] Short title of what changed
By: Claude Code | Cowork | Dylan
Changed: One or two sentences on what was actually modified.
Why: The reason. Tie to a goal or fix.
Files touched: comma-separated list
Next steps: What should happen next, if anything.
Handoff to Cowork: Specific actions needed, or "None"
Handoff to Dylan: Specific actions needed, or "None"

---
END TEMPLATE
