-- @artifacts
--   setting: owner_income_default_company
--   setting: owner_income_show_empty
-- @end

-- Growth and Development income statement: which company view opens by default
-- (combined, PEC or FTP) and whether empty account slots start visible.
-- Insert only so existing owner preferences and audit timestamps are preserved.
insert into public.settings (key, value) values
  ('owner_income_default_company', 'combined'),
  ('owner_income_show_empty', 'false')
on conflict (key) do nothing;
