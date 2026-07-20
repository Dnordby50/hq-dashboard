-- ============================================================================
-- 2026-07-21: appointment notes split (prompt 38, feature 1)
-- ============================================================================
-- pec_appointments.notes STAYS as the internal "Company notes" (no data
-- migration: everything already typed there was written as internal detail
-- and already feeds the Google Calendar event description). This adds the
-- customer-facing "Job notes" field, which the reminder engine appends to the
-- customer's confirmation and reminder texts/emails. customer_notes is NEVER
-- pushed to Google (the calendar description is the internal side).
--
-- Additive + idempotent. No RLS change: the existing all-staff FOR ALL policy
-- (pec_appointments_staff) covers the new column. All reads in the deployed
-- code are guarded for the pre-migration window (select('*') simply lacks the
-- column until this lands).
--
-- *** COWORK HANDOFF: run this file in the PROD Supabase project ("HQ
-- Dashboard", zdfpzmmrgotynrwkeakd), run the verify block, then regenerate
-- the pec_appointments section of SCHEMA.md (standing rule 9). ***
-- ============================================================================

begin;

alter table public.pec_appointments add column if not exists customer_notes text;

commit;

-- ============================================================================
-- VERIFY (run after applying; expected results in comments)
-- ============================================================================
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name = 'pec_appointments'
--      and column_name = 'customer_notes';
--   -- exactly 1 row: customer_notes / text / YES
