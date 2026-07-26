# Claude Code Prompt 45: Estimator polish (MVB change-order line, nav reorg, estimate view tracking, customer dedup)

Four related estimator/CRM changes for TopCoat. Read CLAUDE.md + the last 3 PROJECT-LOG.md entries first. Follow standing rules: commit per change, append a PROJECT-LOG entry, add What's New entries for user-facing changes, expose settings per rule 12, check SCHEMA.md before any SQL, and no em dashes in anything customer-facing. Migrations: WRITE them but do NOT apply them (Cowork applies per standing rule 9); list them in a `## Handoff to Cowork` block.

All four decisions below were confirmed with Dylan, do not re-litigate them.

---

## Feature 1: Add MVB as a change-order line item ("additional coats")

**The real scenario (important):** Dylan had an estimate that was already created and already had a change order, and wanted to add an MVB coat to it. So this is NOT a fresh-estimator flow. It is the change-order path on an existing job.

**Decisions:**
- Mechanism: MVB is added **as a change-order line item**, through the existing change-order modal on a job. Not by re-opening the estimator.
- Scope: **per-area** (added to a chosen flake area at that area's square footage), matching how the estimator models MVB today.
- Presentation: an **"Additional coat" picker** in the change-order modal. Only **MVB** is wired now, but build the option list / data shape so other coat types (extra topcoat, primer, etc.) can be added later without a rebuild. Do not hardcode a single MVB-only branch that can't extend.
- Pricing: **configurable each time.** The change-order modal already collects an amount; that amount IS the configurable price. Adding MVB should default an amount but let the rep edit it, including setting it to $0 to absorb it as internal cost with no customer price change. Make it explicit in the UI that $0 means "material/cost only, no customer charge" (which lowers GP).
- Effect: on save, the MVB product must flow to **both** the job costing card and the materials-needed (material pull) tab automatically, same as a normal change order's materials do.

**Where (anchors):**
- Change-order modal: `openChangeOrderModal(jobId, ...)` at index.html ~9368. It has a Simple mode (name/description/price) and an Area/Scope mode (title, sqft, system_type_id, description) that inserts a `job_areas` row with `is_change_order=true` and calls `pushChangeOrderMaterialsToProd(...)` at ~9552.
- Materials-to-production push: `pushChangeOrderMaterialsToProd(job, coArea, inputs)` at index.html ~9592. This is the existing path that makes a change order's materials show up on the production/material side. Reuse it.
- The MVB product: the estimator resolves it by name `Simiron MVB - Standalone` (apps/estimator/src/features/estimator/EstimatorScreen.tsx ~67) and there is an `MVB Only` system type (~40). The dashboard's per-area MVB adder lives in `computeMaterialPlan(... mvbProductId ...)` at index.html ~28649. **Resolve the MVB product the same way the dashboard's existing MVB path already resolves it (mvbProductId), do not blind-hardcode a name; if the estimator name and the dashboard resolution disagree, flag the drift in your log entry.**

**Recommended implementation (verify before committing):** the cleanest reuse is to have the "Additional coat -> MVB" option create the change-order area on the **`MVB Only` system type** at the flake area's sqft, so the existing `pushChangeOrderMaterialsToProd` recipe machinery emits exactly the standalone MVB product line into costing + materials with no new material-plumbing code. Confirm the `MVB Only` system's recipe yields only the standalone MVB product; if it doesn't, add the single MVB product line directly instead. Either way the CO amount stays the editable, configurable price.

**Acceptance:**
- On any job with a flake area, the change-order modal offers "Add additional coat -> MVB."
- Selecting it prefills a CO line at the chosen area's sqft with an editable price (editable down to $0).
- Saving adds the MVB product to that job's material pull tab and job costing card, and the CO amount (if > 0) raises the customer price exactly as a normal change order does.
- $0 amount adds material/cost only, no customer price change.

---

## Feature 2: Navigation rail reorg (new groups + move items out of Sales)

The left rail is derived from `#pecSubnav` (index.html ~2474-2523): each `<div class="pec-subnav-group">Label</div>` becomes a rail group, and the build-19 rail renderer parses it at index.html ~5150 (`railGroups`). Group icons are keyed by label in `RAIL_ICONS` at index.html ~5134. **Any new group label needs a matching `RAIL_ICONS` entry or its rail icon will be blank.**

**Target structure (confirmed with Dylan):**

- **Overview**: Dashboard, Metrics, To-dos (unchanged)
- **Sales**: Jobs, Customers, Messages, Email Log
- **Leads** (new): Leads, Appointments
- **Estimates** (new): Estimates
- **Drips** (new): Drips, Drip Approvals
- **Production**: Ordering, Job Schedule, Next Day Schedule, **Jobs pipeline** (moved in from Sales)
- **Finance**: Invoicing, Job Costing, Bonus Report, Commission (unchanged)
- **Settings** (new): Settings, Price & Material Catalog, DripJobs Sync Health (all moved out of the old Admin group)
- **Help**: Help (stays pinned via `RAIL_PIN`)

The old **Admin** group is now empty (its three items all moved to Settings), so remove the `Admin` group header and its `RAIL_ICONS` entry.

**Notes:**
- Keep `data-pec-view` values and all routing untouched. Reorder the buttons + group headers in `#pecSubnav` only, exactly as build 19 intended (it rewrites the render step, not the routing).
- Keep existing `RAIL_RELABEL` (catalog -> "Pricing"), `RAIL_SECTION` (dripjobs-sync-health -> "Diagnostics" divider), `pec-role-admin` gating. Drips, Drip Approvals, Settings, Catalog, Sync Health stay admin-only; the group-hides-when-all-items-hidden logic (index.html ~5351) will hide Drips + Settings groups for non-admins automatically. Verify that still holds.
- Add 4 new `RAIL_ICONS` SVGs (Leads, Estimates, Drips, Settings) in the same one-consistent inline-SVG style as the existing set. Suggested: Leads = a funnel, Estimates = a document/clipboard, Drips = a droplet, Settings = a gear.
- Suggested rail order: Overview, Sales, Leads, Estimates, Drips, Production, Finance, Settings, then Help pinned at the bottom.

**Acceptance:** rail shows the new groups with icons; Jobs pipeline appears under Production and no longer under Sales; Settings/Catalog/Sync Health appear under Settings; no empty Admin group; every destination still routes correctly; non-admins do not see admin-only groups.

---

## Feature 3: Show when a customer views an estimate (card timestamp + bell notification)

Mirror the existing job-portal view/notification pattern, but for the public estimate page.

**Decisions:**
- Log **every** open (no throttle).
- Notification goes to the **shared bell feed** all staff already see (`pec_notifications`), matching how the bell works today. No per-recipient targeting.
- On the estimate detail card, show a compact summary at the **bottom**: `Viewed N times, last on <date> at <time>`. (No view yet -> "Not viewed yet.")

**Where (anchors):**
- Public estimate page: `netlify/functions/pec-public-estimate.cjs`. It loads the estimate by `public_token` (~563) using the service-role key (~43) and returns the HTML. It does **not** currently log views. Add view logging + a notification insert on the GET that serves the page to the customer, server-side with the service role (same shape as the portal RPCs that already feed the bell).
- Bell: `pec_notifications` table (columns: type, job_id nullable, body, priority, created_at, read_at, target_view, target_id). Reader is `loadNotifications` / `refreshBell` at index.html ~6166. Click routing uses `target_view` + `target_id` (~6198). Use `type='estimate_viewed'`, `target_view='estimates'`, `target_id=<estimate.id>`, body like `Customer viewed estimate #<estimate_number>`. Wire the bell click so `target_view='estimates'` opens `renderEstimateDetail(target_id)` (renderEstimates at index.html ~21273 already supports `state.openEstimateId`).
- Estimate card render: `renderEstimateDetail(estimateId)` at index.html ~21356. Add the "Viewed ..." line near the bottom of the card, reading from the new view log.

**Data:** `pec_portal_views` is job-keyed and estimates may have no job yet, so add a small dedicated table (write a migration, do not apply it): e.g. `pec_estimate_views (id uuid pk, estimate_id uuid, viewed_at timestamptz default now(), user_agent text, ip text)` with RLS enabled + an admin/staff read policy, matching the project's existing RLS conventions. The card's "Viewed N times, last on ..." reads count + max(viewed_at) for that estimate_id.

**Judgment note to handle:** link-preview/unfurler bots (SMS and email clients pre-fetch the `/e/<token>` link) can create phantom "views." Dylan chose "every open," so don't throttle, but do a light bot-user-agent skip (bots/crawlers/preview fetchers) so the bell isn't lit by the customer's own SMS app pre-rendering the link. Note what you filtered in the log entry.

**Settings surface (rule 12):** add a Settings toggle to enable/disable estimate-view notifications (default on), and an optional "only notify first view per day" throttle switch (default off, since Dylan chose every-open) so it can be tuned later without a code change.

**Acceptance:** opening `/e/<token>` as a customer records a row and (when enabled) drops a bell notification for all staff; clicking the bell item opens that estimate; the estimate card bottom shows "Viewed N times, last on <date> at <time>."

---

## Feature 4: Search existing customers/leads when creating an estimate (dedup)

**Decisions:**
- Search across **both** `public.customers` AND `leads`.
- Match on **name, phone, email, and address**.
- On selecting a match: **prefill the customer fields AND link the estimate to that existing record** so no duplicate is created.

**Where (anchors):**
- Estimator is the React PWA: `apps/estimator/src/features/estimator/EstimatorScreen.tsx`. Customer form model: `apps/estimator/src/lib/customer.ts` (`CustomerForm`). Today the estimator only prefills from a lead passed in the URL (`apps/estimator/src/lib/lead.ts`: `?lead_id=`, `?estimate_id=`, `loadLeadLink`). There is no in-app customer search yet, add one.
- Estimates schema: `estimates` has `lead_id` (FK to leads) and `customer_name/customer_email/customer_phone/customer_address`, but **no `customer_id` column**. `leads` carries `customer_id` (a lead can reference a customer). Downstream (drips, appointments) key off `lead_id`, so **linking should keep `lead_id` as the spine:** if the match is a lead, set `estimates.lead_id` to it; if the match is a customer with no lead, find-or-create that customer's lead and link via `lead_id`. Confirm the leads<->customers relationship in SCHEMA.md before writing any query. If you conclude a direct `estimates.customer_id` column is genuinely needed, write it as a migration (do not apply) and justify it, but prefer the lead-spine approach.

**Implementation notes:**
- Add a "Search existing customer" input near the top of the estimator customer card. As the rep types (debounced), query customers + leads by name/phone/email/address, show a ranked result list (label each result as Customer or Lead, show name + phone + address so duplicates are distinguishable), and on pick, fill `CustomerForm` and set the link.
- Search needs to be online; degrade gracefully offline (hide/disable the search, existing lead-prefill still works). Keep the offline-first save path intact (offline/estimates.ts outbox).
- Respect RLS; use the estimator's existing authenticated supabase client (apps/estimator/src/lib/supabase.ts).

**Settings surface (rule 12):** a toggle to enable/disable the duplicate-search step (default on).

**Acceptance:** creating an estimate, typing a known customer's name/phone/email/address surfaces the existing customer or lead; picking it fills the fields and links the estimate to that record (via lead_id) instead of creating a fresh unlinked one.

---

## Build order (dependencies)
1. Feature 2 (nav) is independent, do it first, it is low-risk and gives Dylan an immediate visible win.
2. Feature 1 (MVB CO), Feature 3 (view tracking), Feature 4 (dedup) are independent of each other. Features 3 and 4 each ship a migration for Cowork to apply.

## After (per standing rules)
- Commit each feature separately (`<area>: <what>`), stage specific files (never `git add .`).
- Append ONE PROJECT-LOG.md entry at the top summarizing all four, with any MVB-product-name drift you found flagged.
- What's New entries (help/whats-new.json, no em dashes) for: MVB additional coat, the nav reorg, estimate-view notifications, and customer dedup search.
- Update features.json for the estimator/nav/notifications/change-order entries touched.
- `## Handoff to Cowork`: list the migrations to apply (pec_estimate_views, any estimates/leads change) with their file paths and a verify block, and ask Cowork to regenerate SCHEMA.md after applying. Note commits are local (Dylan pushes).
