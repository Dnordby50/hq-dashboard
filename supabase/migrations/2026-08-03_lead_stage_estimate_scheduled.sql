-- @artifacts
--   column: public.leads.estimate_scheduled_at
-- @end
-- Also replaces leads_stage_check to admit 'estimate_scheduled'. A CHECK
-- constraint is not one of the four @artifacts kinds, so the drift checker
-- verifies only the column; the constraint is verified by hand (see below).

alter table public.leads drop constraint if exists leads_stage_check;
alter table public.leads add constraint leads_stage_check
  check (stage = any (array['new','contacted','estimate_scheduled','estimate_sent','presented','accepted','lost']));

alter table public.leads add column if not exists estimate_scheduled_at timestamptz;
