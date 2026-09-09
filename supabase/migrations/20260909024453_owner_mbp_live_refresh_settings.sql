-- @artifacts
--   setting: owner_mbp_live_enabled
--   setting: owner_mbp_refresh_minutes
-- @end

-- Owner MBP: enable PEC actuals refresh and configure its interval in minutes.
-- Insert only so existing owner preferences and audit timestamps are preserved.
insert into public.settings (key, value) values
  ('owner_mbp_live_enabled', 'true'),
  ('owner_mbp_refresh_minutes', '5')
on conflict (key) do nothing;
