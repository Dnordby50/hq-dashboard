# PM Module Unification Plan

North-star sketch for unifying the CRM customer side (`customers`, `jobs`, `timeline_stages`) with the production side (`pec_prod_jobs`, `pec_prod_areas`, `pec_prod_material_lines`, etc.).

Status: Phase 1 (push live) and Phase 2 (forward-compat columns) are done. Phase 3 is deferred. This doc captures the target so the next session can pick it up cleanly.

## Why

Today the two halves are isolated: `pec_prod_jobs.customer_name` is plain text and there is no link back to a `customers` row, and no concept of a "proposal" exists as its own entity. That is intentional for the current standalone-ordering workflow, but it means a single real-world job lives in two unconnected places once we hook DripJobs to material ordering.

The user's intent: when a lead lands, become a `customers` row. Under that customer, all proposals and jobs roll up in one view. When a proposal is accepted, the same accept event creates (or links) the production job so material ordering and job costing happen against the same record, not a parallel one.

## Target schema

```
customers
  │  (existing)  id, token, name, email, phone, company, archived_at, created_at
  │
  └─ proposals  (NEW in Phase 3)
       ├─ id uuid pk
       ├─ customer_id uuid not null -> customers
       ├─ proposal_number text unique not null  (the DripJobs-facing id)
       ├─ dripjobs_deal_id text unique
       ├─ dripjobs_url text
       ├─ status text: 'pending' | 'accepted' | 'rejected' | 'expired'
       ├─ type text: 'epoxy' | 'paint'
       ├─ price, monthly_payment, scope, sqft, warranty, package
       ├─ accepted_at timestamptz
       └─ created_at, updated_at
```

On accept (`status` flips from `pending` to `accepted`):

```
proposal accepted
   │
   ├─→ public.jobs row inserted
   │     ├─ customer_id (existing)
   │     ├─ proposal_id (NEW column)  -> proposals(id)
   │     └─ everything else unchanged (timeline_stages, signature, portal token via customer)
   │
   └─→ public.pec_prod_jobs row inserted
         ├─ customer_id  (column lands in Phase 2 migration: 2026-05-03_pec_prod_link_columns.sql)
         ├─ proposal_id  (column lands in Phase 2; FK constraint added in Phase 3)
         ├─ proposal_number = proposals.proposal_number  (denormalized; kept for offline sheet sync)
         ├─ customer_name  = customers.name             (denormalized; same reason)
         └─ status = 'unscheduled' (existing default)
```

Standalone production jobs (no proposal, no customer) stay valid: both FKs are nullable.

## Phase 2 done (current state)

`supabase/migrations/2026-05-03_pec_prod_link_columns.sql` adds:
- `pec_prod_jobs.customer_id uuid references customers(id) on delete set null`
- `pec_prod_jobs.proposal_id uuid` (no FK yet; placeholder for Phase 3)
- partial indexes on each, gated on `is not null`

No code consumes the columns yet.

## Phase 3 plan

When ready to do the unification, the work is roughly:

1. **Schema migration** (`supabase/migrations/<date>_proposals.sql`):
   - Create `public.proposals` per the target above.
   - Add `public.jobs.proposal_id uuid references public.proposals(id) on delete set null`.
   - Add the FK constraint to `public.pec_prod_jobs.proposal_id` (column already exists from Phase 2).
   - RLS policies for `proposals` matching the existing `is_admin_staff` pattern used by other tables.

2. **Backfill**:
   - For each `public.jobs` row with `dripjobs_deal_id`, insert a corresponding `proposals` row with `status='accepted'`, `accepted_at = jobs.confirmed_at` (or `created_at` if null), and copy price/scope/etc. Set `jobs.proposal_id` to the new row.
   - `pec_prod_jobs` rows stay as-is (they were entered manually). Optionally a one-shot SQL helper that, for each `pec_prod_jobs.proposal_number` matching a `proposals.proposal_number`, sets `pec_prod_jobs.proposal_id` and `customer_id` from the proposal's customer.

3. **Webhook refactor** (`netlify/functions/`):
   - `pec-webhook-proposal-accepted.js`: upsert customer (unchanged), insert `proposals` row with `status='accepted'`, insert `public.jobs` row with `proposal_id` (existing customer-portal flow continues). New: also insert a `pec_prod_jobs` row pre-linked to both `customer_id` and `proposal_id`, status `'unscheduled'`. The function staff still have to fill in install_date, areas, system, etc. via the Ordering UI; the webhook just stages the row so it shows up in the production list immediately.
   - `pec-webhook-stage-changed.js` and `pec-webhook-project-completed.js`: keep updating `public.jobs` + timeline. Optionally also flip the linked `pec_prod_jobs.status` based on stage if Dylan wants the production list to track installation progress automatically.

4. **CRM customer-detail view** (`index.html`):
   - Replace the current customer edit modal with a real detail panel reachable from the customer row. Sections: customer fields (existing), proposals list (new), jobs/timeline (existing data, regrouped under the matching proposal), production jobs (new, same data the Ordering tab shows, filtered to this customer).
   - The Ordering tab keeps its standalone "+ New Job" path. New manual jobs created there have null `customer_id` / `proposal_id`. From the Ordering job detail, add a "Link to customer" affordance that lets the user search and attach an existing `customers` row when applicable.

5. **Apps Script proxy** (`production/sheets-proxy-snippet.js`): no change required. The Sheet payload uses the denormalized `proposal_number` and `customer_name` columns.

## Open questions for that future session

- "Lead vs customer": do we want a status column on `customers` (e.g. `'lead' | 'customer'`), or is it implicit (a customer with no accepted proposals is a lead)?
- Customer-portal token + signature: currently lives on `customers` (token) and `public.jobs` (signature_data, confirmed_at). Stay there or move signature onto `proposals`?
- `proposal_number`: keep it on both `proposals` and `pec_prod_jobs` as a denormalized convenience, or strict FK only? Sheet sync makes denormalization useful.
- Manually-created production jobs: do they all need to be back-linked to a customer, or is "ad-hoc, no customer" a permanent valid state?

## Out of scope

- Removing or renaming `pec_prod_jobs.customer_name`. Keep it as the denormalized display string. Cheap and survives any future RLS quirks.
- Touching the calculator (`production/calculator.js`). Pure function, no data model dependency.
- Touching the Material Catalog admin (system types, products, recipe slots, color pairings). Orthogonal to the customer/proposal flow.
