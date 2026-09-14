-- @artifacts
--   index: pec_estimate_line_templates_created_by_idx
-- @end
-- Keep author cleanup efficient when an auth user is removed.
create index if not exists pec_estimate_line_templates_created_by_idx
  on public.pec_estimate_line_templates (created_by);
