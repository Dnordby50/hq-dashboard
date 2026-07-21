-- ============================================================================
-- 2026-07-21: Routemize appointment intake (prompt 43) schema support.
-- ============================================================================
-- Additive and idempotent; safe to re-run. Single transaction.
--
-- WHAT AND WHY:
--   1. pec_appointments.routemize_appt_id: the external Routemize appointment
--      id carried by every webhook event. It is BOTH the idempotency key
--      (a Zapier retry of "created" finds the row instead of duplicating it)
--      and the lookup key for updated/canceled/deleted, which arrive with no
--      TopCoat id. The table previously had no column for an external
--      appointment id (google_event_id is reserved for the Google sync).
--   2. Partial unique index on routemize_appt_id (where not null): update/
--      cancel/delete find exactly one row, and two concurrent Zap retries of
--      the same "created" collide harmlessly (the loser gets a clean 409 the
--      endpoint treats as "already ingested"). Partial so the millions of
--      null rows from other sources never conflict.
--   3. Extend the source CHECK to allow 'routemize' alongside 'topcoat' and
--      'google'. The constraint was created INLINE in the 2026-07-20
--      appointments migration, so Postgres auto-named it; the live catalog
--      (pg_constraint, verified 2026-07-21 on prod zdfpzmmrgotynrwkeakd)
--      names it pec_appointments_source_check. Same CHECK-constraint gotcha
--      as material_type: you cannot ALTER a CHECK in place, so drop and
--      re-add with the three-value list inside this one transaction (no
--      window where source is unconstrained is ever committed).
--
-- *** COWORK HANDOFF: run this file in the PROD Supabase project ("HQ
-- Dashboard", zdfpzmmrgotynrwkeakd), run the verify block at the bottom, then
-- regenerate the SCHEMA.md pec_appointments section. ***
-- ============================================================================

begin;

-- 1. External id column ------------------------------------------------------
alter table public.pec_appointments add column if not exists routemize_appt_id text;

-- 2. Partial unique index (the idempotency + lookup key) ----------------------
create unique index if not exists uq_pec_appointments_routemize_appt
  on public.pec_appointments (routemize_appt_id) where routemize_appt_id is not null;

-- 3. source CHECK now permits 'routemize' ------------------------------------
-- Constraint name read from the live catalog, not guessed (see header).
alter table public.pec_appointments drop constraint if exists pec_appointments_source_check;
alter table public.pec_appointments add constraint pec_appointments_source_check
  check (source in ('topcoat', 'google', 'routemize'));

commit;

-- ============================================================================
-- VERIFY (run after applying; expected results in comments)
-- ============================================================================
-- 1) Column exists:
--    select column_name from information_schema.columns
--      where table_name='pec_appointments' and column_name='routemize_appt_id';
--    -- 1 row: routemize_appt_id
-- 2) Partial unique index exists:
--    select indexname, indexdef from pg_indexes
--      where tablename='pec_appointments' and indexname='uq_pec_appointments_routemize_appt';
--    -- 1 row; indexdef contains UNIQUE and "WHERE (routemize_appt_id IS NOT NULL)"
-- 3) Constraint permits 'routemize':
--    select pg_get_constraintdef(oid) from pg_constraint
--      where conname='pec_appointments_source_check';
--    -- 1 row: CHECK ((source = ANY (ARRAY['topcoat'::text, 'google'::text, 'routemize'::text])))
-- 4) Smoke: this must succeed and roll back cleanly:
--    begin;
--      insert into public.pec_appointments
--        (appt_type, start_at, end_at, source, routemize_appt_id)
--        values ('on_site_estimate', now(), now() + interval '1 hour', 'routemize', 'verify-smoke-1');
--    rollback;
