-- @artifacts
--   table: public.pec_heartbeats
--   setting: system_health_enabled
--   setting: system_health_stale_hours
--   setting: system_health_slack_enabled
--   setting: system_health_stripe_stale_days
-- @end
-- ============================================================================
-- 2026-08-27: the system watches itself (prompt 90 Task A).
-- Author: Claude Code. Idempotent. Additive only.
--
-- WHY: the Google review link was dead FROM LAUNCH until 2026-08-10 and
-- nothing in the system would ever have noticed. TopCoat runs ten scheduled
-- functions, drips, webhooks, and Stripe with no one watching. Every
-- scheduled function now stamps a heartbeat row on a successful run
-- (writeHeartbeat in _pec-supabase.cjs, best-effort: observability must
-- never break the thing it observes), and the daily pec-system-heartbeat
-- monitor checks staleness plus five other machine checks, storing its
-- latest result as its own row's details JSON. The Ops Queue and the
-- Settings > System health card DERIVE their display from these rows at
-- render (nothing inserted per failure, the prompt-55 pattern), so issues
-- self-clear when a later run comes back green.
--
-- RLS: staff can READ (the Ops Queue and Settings card render client-side);
-- writes are service-role only (no insert/update policy on purpose).
-- ============================================================================

create table if not exists public.pec_heartbeats (
  function_name text primary key,
  last_ok_at    timestamptz,
  details       jsonb,
  updated_at    timestamptz not null default now()
);

alter table public.pec_heartbeats enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'pec_heartbeats' and policyname = 'pec_heartbeats_staff_read') then
    create policy pec_heartbeats_staff_read on public.pec_heartbeats
      for select using (is_admin_staff());
  end if;
end $$;

insert into public.settings (key, value) values
  ('system_health_enabled', 'true'),
  ('system_health_stale_hours', '6'),
  ('system_health_slack_enabled', 'true'),
  ('system_health_stripe_stale_days', '7')
on conflict (key) do nothing;
