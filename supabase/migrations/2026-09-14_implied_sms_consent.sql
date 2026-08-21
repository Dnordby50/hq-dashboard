-- @artifacts
--   none: column default change + data backfill on public.leads (no new table/column/index/setting)
-- @end
-- ============================================================================
-- 2026-09-14: implied SMS consent platform-wide (Dylan's policy decision,
-- 2026-08-21, verbatim: "Assume everyone who submits a request for a lead has
-- consented to SMS throughout the platform. If they reply stop, then they
-- will be opted out."). Author: Claude Code. Applied to PROD via MCP.
-- Idempotent. leads is not a money/auth table: direct to prod under rule 14.
--
-- WHAT CHANGES: leads.sms_consent now DEFAULTS true (every lead-creation
-- path that omits the column, estimator + manual add included, is covered by
-- the default), and every live, not-opted-out lead that was sitting at false
-- is backfilled to true with sms_consent_source naming this policy so the
-- record says WHY consent exists. STOP handling is untouched: the Quo
-- webhook flips leads.opted_out, and every send path already checks it.
-- The same policy lands in code in the three explicit writers
-- (pec-lead-intake, pec-appt-intake's createRoutemizeLead,
-- pec-booking's createBookingLead) in the same commit.
-- ============================================================================

begin;

alter table public.leads alter column sms_consent set default true;

update public.leads set
  sms_consent = true,
  sms_consent_source = coalesce(sms_consent_source, 'implied by inquiry (policy 2026-08-21)'),
  sms_consent_at = coalesce(sms_consent_at, now())
where sms_consent = false and opted_out = false and deleted_at is null;

commit;
