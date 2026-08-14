-- @artifacts
--   column: public.pec_sales_team_members.salesask_uid
-- @end
--
-- SalesAsk rep identity. The live recording document identifies its rep only
-- by `uid` (a Firebase UID); it carries no email field at all (2026-08-08
-- Cowork audit, mismatch 2). salesask_email stays as the PUSH-direction
-- fallback; this column is the pull-direction key the matcher resolves
-- uid -> member through (loadRepEmailMap byUid in _pec-salesask.cjs).

alter table public.pec_sales_team_members
  add column if not exists salesask_uid text;

comment on column public.pec_sales_team_members.salesask_uid is
  'SalesAsk (Firebase) user uid for this rep; recording documents carry only this identity. Null = rep never recorded with SalesAsk.';
