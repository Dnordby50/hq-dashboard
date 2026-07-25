-- @artifacts
--   column: public.pec_email_log.body_html
-- @end
-- 2026-07-20_email_log_body.sql
-- Email Log (prompt 36): store the final wrapped HTML of every transactional
-- send so staff can open a log row and read exactly what the customer got.
--
-- WHY a new column instead of reusing pec_drip_sends.body: drips and blasts
-- already keep their rendered body in the pec_drip_sends ledger (joined to
-- pec_email_log via provider_id = resend_id), but transactional sends
-- (pec-send-email.cjs, template + compose modes) build the wrapped HTML in
-- memory and throw it away after POSTing to Resend. This column is where that
-- HTML lands going forward. Historical rows stay NULL on purpose (no backfill;
-- the UI shows a "body not captured" note for them).
--
-- Additive and idempotent. Safe to run more than once. No RLS change needed:
-- the existing pec_email_log_read select policy (is_admin_staff()) covers the
-- new column, and writes still come only from service-role functions.

alter table public.pec_email_log
  add column if not exists body_html text;

-- Verify (run after applying; expected results in the trailing comments):
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'pec_email_log'
   and column_name  = 'body_html';
--   1 row: body_html / text / YES (present, nullable)
