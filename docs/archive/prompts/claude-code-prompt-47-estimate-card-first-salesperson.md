# Claude Code Prompt 44: Estimate "card first" draft flow + current-user salesperson default

## Goal
Two connected changes to the estimator (React PWA at `apps/estimator/`, used both standalone and embedded in the dashboard via `openEstimatorModal`, index.html:6923):

A. **Card first.** When a rep starts a new estimate, persist the estimate row as an "In Draft" card as soon as they make the first edit in the estimator modal, so the card exists in the Estimates list right away and they continue building it afterward. (Today the row is only written on full Save.)

B. **Salesperson = current user by default.** Auto-select the logged-in user as the salesperson on a new estimate instead of defaulting to the first person in the list. Salesperson stays REQUIRED to save.

Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first (standing rule 4). Consult features.json + SCHEMA.md before grepping or writing SQL (standing rules 9, 10).

## Decisions locked (from Dylan, do not re-litigate)
- Surfaces: BOTH standalone PWA and dashboard-embedded estimator (one shared component).
- Basic info required to create the card: customer **name, phone, email, address** (these already carry over from the lead in the normal flow).
- Card create trigger: on the **first real edit** inside the estimator modal (not on open, so merely opening a lead estimate and backing out creates nothing). The existing Save button still does the full save.
- Estimate numbering: numbers are internal, gaps are fine. Keep the existing Postgres-sequence-on-insert behavior; do NOT delay or reserve numbers.
- Empty/unfinished draft: stays in the main Estimates list, with a visible **"In Draft"** badge on the list card AND at the top of the estimate detail page.
- Salesperson: **fully required** to save (both the early draft save and the full save). Defaulted to current user, but **freely editable** (anyone can change it, e.g. creating on behalf of another rep).
- Login model: each rep has their own login (so current-user mapping is reliable).
- Salesperson mapping: **add an `auth_user_id` column** to `pec_sales_team_members` linking each member to their auth login (chosen over name-matching, which is fragile).
- Fallback when the logged-in user has no matching salesperson record (e.g. admin, or an unmapped new hire): **leave salesperson blank and block the save with a clear prompt** telling them to get their login mapped to a salesperson (or pick one) before continuing. Do NOT silently fall back to salespeople[0].
- Carry to job: keep it flowing onto `jobs.salesperson` / `pec_prod_jobs.sales_team` on accept. This already happens in `pec-public-estimate.cjs` (:810 salesperson, :888 sales_team) from `intake.salesperson_name`; just VERIFY it, do not rebuild it.

## Part 1: Salesperson auth mapping + current-user default

### 1a. Migration (write it, do NOT apply to prod)
Add `auth_user_id uuid` to `public.pec_sales_team_members`, FK to `auth.users.id`, nullable (existing rows unmapped until an admin maps them), plus a partial unique index so one login maps to at most one member:
```sql
ALTER TABLE public.pec_sales_team_members ADD COLUMN auth_user_id uuid REFERENCES auth.users(id);
CREATE UNIQUE INDEX uq_pec_sales_team_members_auth_user
  ON public.pec_sales_team_members (auth_user_id) WHERE auth_user_id IS NOT NULL;
```
Put it in `supabase/migrations/2026-07-22_sales_member_auth_user.sql` with a verify block. Applying to prod + regenerating SCHEMA.md is a Cowork handoff (below).

### 1b. Settings surface (standing rule 12)
Add an admin Settings surface to map each `pec_sales_team_members` row to a login. This is the settings surface for this feature AND how the 2 existing members (and future hires) get their `auth_user_id` set. Simplest workable UI: in the existing Sales Team / team-members settings area, a per-member picker of eligible logins (admin_users, which already links `auth_user_id -> auth.users.id`, see SCHEMA.md admin_users). Writes `pec_sales_team_members.auth_user_id`. Admin-only; enforce with existing staff/admin gating.

### 1c. Catalog: surface auth_user_id to the client
- `apps/estimator/src/lib/catalog.ts`: add `auth_user_id: string | null` to the `SalesPerson` type (~line 7) and include it in the `pec_sales_team_members` select (~line 68).

### 1d. Default the salesperson to the current user
- `apps/estimator/src/App.tsx` already has the auth user id (`createdBy = sess.session.user?.id`, ~line 37). Thread the current auth user id into `EstimatorScreen` (prop or context).
- `apps/estimator/src/features/estimator/EstimatorScreen.tsx` (~line 176): change the `salespersonId` initial state. New estimate default priority:
  1. `editing` value if still valid (keep current behavior).
  2. else the salesperson whose `auth_user_id === currentUserId`.
  3. else **blank** (empty string). Do NOT fall back to `salespeople[0]`.
- Keep salesperson required (`canSave` already needs it). When it is blank because the current user is unmapped, the required-field block must show a clear message: e.g. "Your login is not linked to a salesperson yet. Ask an admin to map you in Settings > Sales Team, or pick a salesperson to continue." Apply this same gate to the new early draft save (Part 2), so an unmapped admin gets the prompt instead of a silent failure.

## Part 2: Card-first draft autosave + "In Draft" badge

### 2a. Early draft save on first edit
- Add a lighter draft-save path that fires on the FIRST real edit to the estimator modal (first system pick, sqft entry, field change, add-on, scope answer, etc.), debounced so it fires once. It writes the estimate row via the existing `saveEstimateOffline` (apps/estimator/src/offline/estimates.ts) with `status: 'draft'`, reusing the same generated id so the later full Save upserts the same row (the outbox already upserts by id).
- Required fields for the early draft save: name, phone, email, address, **and salesperson** (per the locked decisions). If any are missing, do not write the row yet; do not throw. In the normal lead-originated flow these are all prefilled, so the draft saves cleanly on first edit. If salesperson is blank because the user is unmapped, surface the Part 1d prompt.
- Do NOT require areas/systems/pricing/scope for the early draft save. The existing full `canSave` gate (areas, pricing, etc.) still governs the explicit Save button, unchanged.
- Idempotency: opening then backing out with no edit writes nothing. First edit writes exactly one row. Subsequent edits and the final Save upsert the same id.

### 2b. "In Draft" badge
- Estimates list (`renderEstimates`, index.html:21273): show an "In Draft" badge on each card whose estimate is still a draft (status `'draft'`, i.e. not yet sent/accepted). Reuse the existing `.pec-badge` styling; align with however status is already shown so we do not double-label.
- Estimate detail (`renderEstimateDetail`, index.html:21356): show the same "In Draft" badge prominently at the top of the card/header for draft estimates.
- No em dashes in any customer-facing or UI copy (standing rule 6). "In Draft" badge text is fine.

## Part 3: Verify carry-to-job (no rebuild)
Confirm that an estimate created through this new flow still lands `intake.salesperson_name` such that `pec-public-estimate.cjs` writes `jobs.salesperson` (:810) and `pec_prod_jobs.sales_team` (:888) on accept. `saveEstimateOffline` already writes `salesperson_name` into intake (~line 170). Just verify with a trace/test; only touch code if the name is not flowing.

## Standing-rules checklist (do all)
- Tests: add/extend fixture tests for the early-draft-save trigger (fires once on first edit, not on open; requires the 5 fields incl. salesperson; upserts same id on full save) and the current-user salesperson default (maps by auth_user_id; blank + block when unmapped; editable). Keep `npm test` green.
- `features.json`: update the "Numbered estimate records" (id 1) and "In-house estimator PWA" (id 0) entries, and add anchors for the new settings surface + migration.
- Regenerate nothing in SCHEMA.md yourself if you cannot apply the migration; flag it in the handoff.
- What's New (standing rule 11): append one entry to `help/whats-new.json` (plain language, no em dashes): estimates now save as an "In Draft" card as soon as you start, and new estimates default to you as the salesperson.
- PROJECT-LOG.md: append a top entry (standing rules 2, 3). Include the migration filename, the files touched, and the two handoff sections.
- Commit per standing rule 1 (`estimator: card-first draft save + current-user salesperson default`). Do not push (that is Dylan's step).

## Handoff to Cowork
1. Apply `supabase/migrations/2026-07-22_sales_member_auth_user.sql` to PROD ("HQ Dashboard", zdfpzmmrgotynrwkeakd); run its verify block (column exists, unique partial index exists).
2. Regenerate SCHEMA.md (pec_sales_team_members gains auth_user_id + the new index).
3. After the code deploys, use the new Settings > Sales Team mapping UI to link the 2 existing sales-team members to their logins (needs each member's auth login; ask Dylan which login is which). Capture the 2 member->login mappings in the PROJECT-LOG entry.

## Handoff to Dylan
1. `git push` to deploy (commits are local; the cloud sandbox cannot push).
2. After deploy + migration, confirm the 2 sales members are mapped in Settings so current-user default works for both reps.
