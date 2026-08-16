-- Prompt 94: sold-on-site metric columns + settings, and the two data flips
-- that finish Task B (scope templates replace Generate Scope).
--
-- Rule 14 reasoning (stated, not skipped): additive nullable columns on
-- estimates that never touch estimates.status, money tables, auth, or RLS,
-- plus insert-only settings seeds and two data updates (a settings value and
-- a UI-only boolean flag). Direct to prod is correct; no branch rehearsal.
--
-- @artifacts
--   column: public.estimates.sold_on_site
--   column: public.estimates.sold_on_site_override
--   setting: sold_on_site_enabled
--   setting: sold_on_site_grace_minutes
--   setting: sold_on_site_appt_types
--   setting: sold_on_site_lookback_hours
-- @end

-- C2: the derived answer, stamped at accept time (stamping rather than
-- deriving live means a later appointment edit cannot rewrite history), and
-- the human override. NULL sold_on_site = unknown (accepted before the
-- metric existed, or derivation unavailable at accept). NULL override = use
-- the derived value. Effective = coalesce(override, sold_on_site, false).
alter table public.estimates add column if not exists sold_on_site boolean;
alter table public.estimates add column if not exists sold_on_site_override boolean;

-- C5 settings (rule 12): enabled + grace front-of-card in Settings >
-- Estimates; appt types + lookback behind that card's Advanced. All read at
-- accept time (server + dashboard mirror), so tuning needs no deploy.
insert into public.settings (key, value)
select v.key, v.value
from (values
  ('sold_on_site_enabled', 'true'),
  ('sold_on_site_grace_minutes', '120'),
  ('sold_on_site_appt_types', 'on_site_estimate'),
  ('sold_on_site_lookback_hours', '0')
) as v(key, value)
where not exists (select 1 from public.settings s where s.key = v.key);

-- Prompt 94 B4 (data): the AI per-line generate + scope writer go dark in
-- prod now that system templates fill line scopes at pick time. The code
-- stays (rollback = flip this back to 'true' in Settings > Estimates).
update public.settings set value = 'false' where key = 'estimate_line_generate_enabled';

-- Prompt 94 B (data): nothing sets scope_stale anymore and the Regenerate
-- button that cleared it is gone, so stuck-true rows would block sending
-- forever with no UI path out. 3 rows counted true on 2026-08-16 before this
-- ran. UI-only flag; the scope text itself is untouched.
update public.estimates set scope_stale = false where scope_stale = true;
