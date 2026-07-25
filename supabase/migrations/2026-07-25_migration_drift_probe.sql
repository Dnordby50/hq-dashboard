-- @artifacts
--   setting: migration_drift_check_enabled
--   setting: migration_drift_baseline
-- @end
-- ============================================================================
-- 2026-07-25 (prompt 48, Part A): schema probe RPC for the drift checker.
-- Author: Claude Code. Idempotent. Written for Cowork to apply (standing rule).
--
-- WHY an RPC: pec-migration-drift.cjs talks to Supabase over PostgREST, which
-- exposes only public tables/views -- it cannot see pg_indexes or pg_tables and
-- cannot run the union-all existence query directly. This function is that one
-- batched query, callable as POST /rpc/pec_schema_probe. Strictly READ-ONLY
-- (stable, selects only); the drift checker never writes schema by design.
--
-- Self-verifying bootstrap: the checker cannot detect its own missing probe by
-- probing (chicken and egg), so instead it fails LOUDLY when this RPC 404s,
-- naming this file, and raises a de-duped admin bell. Once the RPC answers,
-- this migration is by construction applied.
--
-- Security: SECURITY DEFINER so it can read pg_catalog regardless of caller,
-- with search_path pinned; EXECUTE revoked from everyone but service_role, so
-- only the Netlify functions (service key) can call it -- no browser exposure.
-- ============================================================================

begin;

create or replace function public.pec_schema_probe(items jsonb)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'results', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'kind', i.kind,
        'name', i.name,
        'present',
        case i.kind
          when 'table' then
            to_regclass('public.' || i.name) is not null
          when 'column' then
            -- name arrives as <table>.<column> (the header's public. prefix is
            -- stripped by the caller).
            exists (
              select 1 from information_schema.columns c
              where c.table_schema = 'public'
                and c.table_name  = split_part(i.name, '.', 1)
                and c.column_name = split_part(i.name, '.', 2)
            )
          when 'index' then
            exists (
              select 1 from pg_indexes x
              where x.schemaname = 'public' and x.indexname = i.name
            )
          when 'setting' then
            exists (select 1 from public.settings s where s.key = i.name)
          else false
        end
      )), '[]'::jsonb)
      from (
        select e->>'kind' as kind, e->>'name' as name
        from jsonb_array_elements(coalesce(items, '[]'::jsonb)) e
      ) i
    ),
    -- Reverse-drift input: every live public table, compared by the checker
    -- against tables any repo SQL file creates.
    'tables', (
      select coalesce(jsonb_agg(t.tablename order by t.tablename), '[]'::jsonb)
      from pg_tables t
      where t.schemaname = 'public'
    )
  );
$$;

revoke all on function public.pec_schema_probe(jsonb) from public;
revoke all on function public.pec_schema_probe(jsonb) from anon;
revoke all on function public.pec_schema_probe(jsonb) from authenticated;
grant execute on function public.pec_schema_probe(jsonb) to service_role;

-- Settings (rule 12), insert-only so live values are never clobbered:
--   migration_drift_check_enabled: master switch for the scheduled daily check
--     (the on-demand Settings > Diagnostics run always works).
--   migration_drift_baseline: only migrations dated on/after this are checked;
--     files older than the @artifacts convention have no headers to probe.
insert into public.settings (key, value)
select 'migration_drift_check_enabled', 'true'
where not exists (select 1 from public.settings where key = 'migration_drift_check_enabled');
insert into public.settings (key, value)
select 'migration_drift_baseline', '2026-07-01'
where not exists (select 1 from public.settings where key = 'migration_drift_baseline');

commit;

-- ============================================================================
-- Verify after running:
--   select public.pec_schema_probe('[{"kind":"table","name":"settings"},
--     {"kind":"column","name":"estimates.crew_notes"},
--     {"kind":"index","name":"uq_pec_drip_sends_pending_leg"},
--     {"kind":"setting","name":"migration_drift_baseline"}]'::jsonb);
--   -- every "present" should be true, and "tables" should list ~70+ names.
--   select key, value from settings
--     where key in ('migration_drift_check_enabled','migration_drift_baseline');
-- ============================================================================
