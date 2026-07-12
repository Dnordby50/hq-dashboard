-- ============================================================================
-- 2026-07-12: Estimates become first-class numbered objects (build prompt 15).
-- Author: Claude Code. Idempotent. Applied to prod from the build session via
-- the Supabase MCP.
--
-- Why: an estimate saved from the estimator was a dead end (no number, no page,
-- no reopen path). This gives it an identity: a sequential EST-<n> number, line
-- items with customer-optional upsells, MVB capture, customer contact fields,
-- and the status vocabulary the customer-facing proposal (build prompt 16)
-- will drive. Prompt 16 is additive on top of this; it reshapes nothing here.
--
-- Pre-existing plumbing this build reuses instead of re-creating: public_token
-- (unique index estimates_public_token_key), signature/signed_* columns,
-- sent_at, job_id, and the indexes idx_estimates_lead, idx_estimates_status,
-- idx_estimates_live (created_at desc where deleted_at is null) all shipped
-- with 2026-06-21_estimator_core.sql and have never been used.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The estimate number. A Postgres sequence (NOT a client-side max()+1) so
--    two reps saving at the same moment can never collide: nextval() is atomic
--    and never hands out the same value twice. Starts at 102026 per Dylan
--    ("start at a 102026"), so the first numbered estimate is EST-102026.
--    The UI owns the EST- prefix; the column stays a plain integer.
--
--    Deliberate ordering: the column is added FIRST (no default), THEN the
--    default is attached. Adding a column with a volatile default would
--    backfill the one legacy draft row with 102026 and shift Dylan's first
--    real estimate to 102027. This way the legacy row keeps a NULL number
--    (rendered as "unnumbered") and EST-102026 goes to the first estimate
--    saved after this migration.
-- ----------------------------------------------------------------------------
create sequence if not exists public.estimates_estimate_number_seq start with 102026;
alter table public.estimates add column if not exists estimate_number integer;
alter table public.estimates
  alter column estimate_number set default nextval('public.estimates_estimate_number_seq');
alter sequence public.estimates_estimate_number_seq owned by public.estimates.estimate_number;
create unique index if not exists estimates_estimate_number_key
  on public.estimates (estimate_number);

-- ----------------------------------------------------------------------------
-- 2. Line items. Mirrors jobs.line_items (also jsonb). Array of:
--    { id, label, description, qty, unit_price, total, optional (bool),
--      selected_by_customer (bool), created_at }
--    Rule enforced in code (both the estimate page and the future public page):
--    a line with optional=true is EXCLUDED from the estimate total until
--    selected_by_customer=true. This is the upsell mechanism (stem walls, MVB,
--    extra bay) prompt 16's customer page will let the customer tick.
-- ----------------------------------------------------------------------------
alter table public.estimates add column if not exists line_items jsonb;

-- ----------------------------------------------------------------------------
-- 3. MVB (moisture vapor barrier). ONE text enum column, not two booleans:
--    'none' | 'addon' | 'standalone'. The three states are mutually exclusive
--    on a single estimate (MVB is either absent, an extra coat under a system,
--    or the whole job), and a pair of booleans would admit the contradictory
--    both-true row. Matches the estimator's one tri-state control.
-- ----------------------------------------------------------------------------
alter table public.estimates add column if not exists mvb text not null default 'none';
alter table public.estimates drop constraint if exists estimates_mvb_check;
alter table public.estimates
  add constraint estimates_mvb_check check (mvb in ('none', 'addon', 'standalone'));

-- ----------------------------------------------------------------------------
-- 4. Flake color, estimate-level. Nullable on purpose: the customer usually
--    picks the color AFTER the presentation, so the estimate page (not just
--    the estimator) can fill it in later.
-- ----------------------------------------------------------------------------
alter table public.estimates add column if not exists flake_color text;

-- ----------------------------------------------------------------------------
-- 5. Customer contact, captured on the estimate itself (prefilled from the
--    lead when there is one, editable always; walk-up estimates have no lead
--    row to lean on). Prompt 16's customer-facing document reads these.
-- ----------------------------------------------------------------------------
alter table public.estimates
  add column if not exists customer_name    text,
  add column if not exists customer_email   text,
  add column if not exists customer_phone   text,
  add column if not exists customer_address text;

-- ----------------------------------------------------------------------------
-- 6. Status vocabulary. Replaces the original check (draft/sent/presented/
--    accepted/lost/expired; zero rows use presented or expired) with the
--    seven-state proposal lifecycle. Same discipline as leads_stage_check:
--    the CHECK is the only stage list, nothing can invent an eighth.
--    sent / signed / change_requested / rejected are driven by prompt 16.
-- ----------------------------------------------------------------------------
alter table public.estimates drop constraint if exists estimates_status_check;
alter table public.estimates
  add constraint estimates_status_check check (status in
    ('draft', 'sent', 'signed', 'accepted', 'change_requested', 'rejected', 'lost'));

-- ----------------------------------------------------------------------------
-- 7. Customer response capture (written by prompt 16's public page through the
--    service role; displayed on the internal estimate page).
-- ----------------------------------------------------------------------------
alter table public.estimates
  add column if not exists change_request_note text,
  add column if not exists rejected_reason     text,
  add column if not exists rejected_at         timestamptz;

-- ----------------------------------------------------------------------------
-- 8. Pricing snapshot: the comps and AI read that priced the estimate, plus
--    the inputs they were generated from. Persisted so (a) reopening an
--    estimate never re-bills a model call for unchanged inputs, and (b) the
--    estimate page can show exactly what the rep saw when they priced it.
--    Shape: { inputs_key, comps: { rule, sample_size, median_ppsf, rows[] },
--             ai: { recommended_low, recommended_high, why, model,
--                   generated_at } }
-- ----------------------------------------------------------------------------
alter table public.estimates add column if not exists pricing_snapshot jsonb;

-- ----------------------------------------------------------------------------
-- 9. Indexes the estimate list + lead detail reads lean on. Most shipped with
--    estimator_core (see header); create-if-not-exists keeps this idempotent
--    either way. idx_estimates_created_at is the full-table twin of the
--    partial idx_estimates_live for reads that include soft-deleted rows.
-- ----------------------------------------------------------------------------
create index if not exists idx_estimates_lead       on public.estimates (lead_id);
create index if not exists idx_estimates_status     on public.estimates (status);
create index if not exists idx_estimates_created_at on public.estimates (created_at desc);

-- ----------------------------------------------------------------------------
-- 10. RLS: unchanged on purpose. The existing estimates_staff policy
--     (is_admin_staff(), ALL commands) already covers staff read/write. The
--     future public estimate page reads through the SERVICE ROLE inside a
--     Netlify function ONLY; estimates gets no anon/public grant, ever, same
--     posture as invoices (/pay) and change orders (/co).
-- ----------------------------------------------------------------------------

commit;

-- ============================================================================
-- Verify after running:
--   select column_name from information_schema.columns
--     where table_name='estimates' and column_name in
--     ('estimate_number','line_items','mvb','flake_color','customer_name',
--      'customer_email','customer_phone','customer_address',
--      'change_request_note','rejected_reason','rejected_at',
--      'pricing_snapshot');                                        -- 12 rows
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--     where conrelid='public.estimates'::regclass and contype='c'; -- status (7 states) + mvb (3 states)
--   select indexname from pg_indexes where tablename='estimates'
--     and indexname in ('estimates_estimate_number_key','estimates_public_token_key',
--     'idx_estimates_lead','idx_estimates_status','idx_estimates_created_at'); -- 5 rows
--   select last_value, is_called from public.estimates_estimate_number_seq;    -- 102026, false (until first save)
--   select count(*) from estimates where estimate_number is not null;          -- 0 (legacy draft stays unnumbered)
-- ============================================================================
