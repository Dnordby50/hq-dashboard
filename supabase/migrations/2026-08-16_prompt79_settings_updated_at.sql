-- @artifacts
--   column: public.settings.updated_at
--   setting: settings_rail_breakpoint_px
-- @end
--
-- Prompt 79: give the settings table a write timestamp, and seed the one
-- tunable prompt 80's Settings rail needs (rule 12).
--
-- updated_at is NULLABLE with NO column default and is NOT backfilled, on
-- purpose. A NULL row is one that has not been written since this migration
-- ran. That is the audit signal; backfilling now() would erase it. The
-- trigger is the only writer.

alter table public.settings
  add column if not exists updated_at timestamptz;

create or replace function public.settings_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists settings_touch_updated_at on public.settings;

create trigger settings_touch_updated_at
  before insert or update on public.settings
  for each row
  execute function public.settings_touch_updated_at();

-- settings_rail_breakpoint_px: below this viewport width the Settings rail
-- (prompt 80) collapses to a single dropdown instead of a vertical list.
-- Mirrors the estimator_line_sheet_breakpoint_px pattern from prompt 76.
-- Insert-only; never clobber a value Dylan has already tuned.
insert into public.settings (key, value)
values ('settings_rail_breakpoint_px', '900')
on conflict (key) do nothing;
