-- @artifacts
--   setting: owner_mbp_autosave_ms
--   setting: owner_mbp_workbook_default_sheet
-- @end

-- Full-screen MBP workbook: idle delay before a typed cell saves itself, and the sheet
-- the workbook opens on. Insert only so an existing owner preference is never replaced.
insert into public.settings (key, value) values
  ('owner_mbp_autosave_ms', '800'),
  ('owner_mbp_workbook_default_sheet', 'sales_total')
on conflict (key) do nothing;
