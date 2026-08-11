-- @artifacts
--   column: public.estimates.client_notes
--   column: public.estimates.company_notes
-- @end
-- ============================================================================
-- 2026-08-20: three-lane estimate notes (DripJobs-parity batch, phase 4).
-- Author: Claude Code. Idempotent.
--
-- WHY: DripJobs' proposal editor has a Notes tab with three lanes and TopCoat
-- had only one (crew_notes, team-only, printed on the crew work order). This
-- adds the other two lanes with the SAME visibility contract DripJobs uses:
--   client_notes  [CLIENT VISIBLE]  renders on the customer estimate page as
--                                   "A note from us" (pec-public-estimate).
--   company_notes [INTERNAL ONLY]   office-only; never printed, never sent.
-- crew_notes stays exactly as it is (prompt 32: crew work order only).
-- ============================================================================

alter table public.estimates add column if not exists client_notes text;
alter table public.estimates add column if not exists company_notes text;
