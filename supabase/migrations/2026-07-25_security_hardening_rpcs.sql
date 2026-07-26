-- @artifacts
--   none: guards/grants/policies/search_path only; no table/column/index/setting to probe
-- @end
-- ============================================================================
-- 2026-07-25: security hardening of SECURITY DEFINER RPCs (audit findings M6/L16)
-- ============================================================================
-- Context: the 2026-07-25 security assessment (plan wild-meandering-dijkstra) found
-- that the six log_* notification RPCs were SECURITY DEFINER, executable by anon
-- (the default PUBLIC EXECUTE grant was never revoked), and had NO internal auth
-- guard. So any internet client holding the public anon key could POST forged
-- staff notifications (spoofed "payment deleted", "customer deleted", etc.) into
-- pec_notifications -- an integrity / social-engineering vector, though no PII was
-- read and no real business/financial table was written.
--
-- Fix, two layers of defense:
--   1. Each function now silently no-ops for a non-staff caller. A SILENT return
--      (not `raise`) is deliberate: these are best-effort loggers called AFTER the
--      real action, and several callers do not wrap the rpc() in try/catch, so a
--      raised exception could surface as a spurious error. A staff call behaves
--      exactly as before; an anon/non-staff call writes nothing.
--   2. EXECUTE is revoked from anon and PUBLIC on these six, leaving only
--      authenticated (the staff app) and service_role. Belt and suspenders with #1.
--
-- Bodies below are the live definitions verbatim, with only the guard line added.
-- Idempotent (create or replace + revoke/grant + drop policy if exists).
-- ============================================================================

create or replace function public.log_appointment_booked(p_appointment_id uuid, p_title text, p_sales_name text, p_when text)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_actor text;
begin
  if not public.is_admin_staff() then return; end if;
  select coalesce(name, email) into v_actor from public.admin_users where auth_user_id = auth.uid();
  insert into public.pec_notifications (type, body, target_view, target_id)
    values ('appointment_booked',
            coalesce(v_actor, 'Someone') || ' booked ' || coalesce(nullif(p_title, ''), 'an appointment')
              || case when nullif(p_sales_name, '') is not null then ' for ' || p_sales_name else '' end
              || case when nullif(p_when, '') is not null then ' (' || p_when || ')' else '' end,
            'appointments', p_appointment_id);
end
$function$;

create or replace function public.log_costing_sent_back(p_customer text, p_note text, p_job_id uuid default null::uuid)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_actor text;
begin
  if not public.is_admin_staff() then return; end if;
  select coalesce(name, email) into v_actor from public.admin_users where auth_user_id = auth.uid();
  insert into public.pec_notifications (type, body, target_view, target_id)
    values ('costing_sent_back',
            coalesce(v_actor, 'Someone') || ' sent '
              || coalesce(nullif(p_customer, ''), 'a job') || ' job costing back: ' || p_note,
            case when p_job_id is not null then 'costing' end,
            p_job_id);
end
$function$;

create or replace function public.log_costing_submitted(p_customer text, p_job_id uuid default null::uuid)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_actor text;
begin
  if not public.is_admin_staff() then return; end if;
  select coalesce(name, email) into v_actor from public.admin_users where auth_user_id = auth.uid();
  insert into public.pec_notifications (type, body, target_view, target_id)
    values ('costing_submitted',
            coalesce(v_actor, 'Someone') || ' submitted job costing for '
              || coalesce(nullif(p_customer, ''), 'a job') || ' for review',
            case when p_job_id is not null then 'costing' end,
            p_job_id);
end
$function$;

create or replace function public.log_customer_deleted(p_customer_id uuid, p_name text)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare v_actor text;
begin
  if not public.is_admin_staff() then return; end if;
  select coalesce(name, email) into v_actor from public.admin_users where auth_user_id = auth.uid();
  insert into public.pec_notifications (type, body)
    values ('customer_deleted', coalesce(v_actor, 'Someone') || ' deleted customer ' || coalesce(nullif(p_name, ''), p_customer_id::text));
end
$function$;

create or replace function public.log_payment_deleted(p_job_id uuid, p_amount numeric)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_actor text;
  v_cust  text;
begin
  if not public.is_admin_staff() then return; end if;
  select coalesce(name, email) into v_actor from public.admin_users where auth_user_id = auth.uid();
  select c.name into v_cust
    from public.jobs j left join public.customers c on c.id = j.customer_id
   where j.id = p_job_id;
  insert into public.pec_notifications (type, job_id, body, target_view, target_id)
    values ('payment_deleted', p_job_id,
            coalesce(v_actor, 'Someone') || ' deleted a payment'
            || coalesce(' for ' || nullif(v_cust, ''), '')
            || ' ($' || to_char(coalesce(p_amount, 0), 'FM999999990.00') || ')',
            case when p_job_id is not null then 'invoicing' end,
            p_job_id);
end
$function$;

create or replace function public.log_payment_edited(p_job_id uuid, p_amount_before numeric, p_amount_after numeric)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_actor text;
  v_cust  text;
begin
  if not public.is_admin_staff() then return; end if;
  select coalesce(name, email) into v_actor from public.admin_users where auth_user_id = auth.uid();
  select c.name into v_cust
    from public.jobs j left join public.customers c on c.id = j.customer_id
   where j.id = p_job_id;
  insert into public.pec_notifications (type, body, target_view, target_id)
    values ('payment_edited',
            coalesce(v_actor, 'Someone') || ' edited a payment'
            || coalesce(' for ' || nullif(v_cust, ''), '')
            || ' (was $' || to_char(coalesce(p_amount_before, 0), 'FM999999990.00')
            || ', now $' || to_char(coalesce(p_amount_after, 0), 'FM999999990.00') || ')',
            case when p_job_id is not null then 'invoicing' end,
            p_job_id);
end
$function$;

-- Remove the default PUBLIC/anon reachability on the six loggers (authenticated
-- staff + service_role keep it). Layer 2 of the defense.
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.log_appointment_booked(uuid, text, text, text)',
    'public.log_costing_sent_back(text, text, uuid)',
    'public.log_costing_submitted(text, uuid)',
    'public.log_customer_deleted(uuid, text)',
    'public.log_payment_deleted(uuid, numeric)',
    'public.log_payment_edited(uuid, numeric, numeric)'
  ] loop
    execute format('revoke execute on function %s from anon, public', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- RLS-enabled-no-policy tables (advisor L16). Two tables have RLS on but no
-- policy, which means deny-all to the anon/authenticated keys today.
-- ----------------------------------------------------------------------------
-- pec_portal_views is staff analytics (portal open counts), written by the
-- SECURITY DEFINER portal_log_view RPC. Staff should be able to read it from the
-- dashboard, so add an explicit staff-read policy (writes still go through the
-- definer RPC / service role).
drop policy if exists pec_portal_views_staff_read on public.pec_portal_views;
create policy pec_portal_views_staff_read on public.pec_portal_views
  for select using (public.is_admin_staff());

-- pec_sales_member_google_tokens holds Google OAuth access/refresh tokens. These
-- must NEVER be readable by a client key, only by the Netlify functions via the
-- service role (which bypasses RLS). So the correct posture is deny-all: we
-- intentionally add NO policy here. The advisor will keep flagging it INFO-level
-- rls_enabled_no_policy; that is expected and desired for a secrets table.

-- ----------------------------------------------------------------------------
-- Pin search_path on the functions the advisor flagged with a mutable search_path
-- (advisor 0011). ALTER (not recreate) so bodies are untouched. Pinning prevents
-- a caller from shadowing an unqualified name via their own search_path.
-- ----------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('pec_prod_touch_updated_at','phone_digits',
                         'pec_costing_commission_for','pec_costing_set_commission',
                         'pec_job_recompute_costing_commission')
  loop
    execute format('alter function %s set search_path = public', r.sig);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Defense-in-depth: remove anon reachability on the guarded staff / trigger RPCs
-- that anon never legitimately calls (they already no-op for non-staff via an
-- internal is_admin_staff() guard, or are trigger/event-trigger functions the API
-- should never invoke). Keeps authenticated so the staff app still works.
--
-- Deliberately EXCLUDED from this revoke:
--   * is_admin_staff() / is_admin_role() -- referenced by RLS policies, which are
--     evaluated under the QUERYING role, so that role needs EXECUTE; revoking from
--     anon would turn an anon table query into a "permission denied for function"
--     error instead of the intended empty result.
--   * portal_* / get_portal_* -- anon (the customer, no login) MUST call these;
--     they are token-gated internally.
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.edit_recorded_payment(uuid, numeric, text, text, date)',
    'public.search_jobs(text, integer)',
    'public.pec_replace_job_areas(uuid, jsonb, jsonb)',
    'public.pec_prod_jobs_sync_public_status()',
    'public.rls_auto_enable()'
  ] loop
    execute format('revoke execute on function %s from anon, public', fn);
  end loop;
end $$;

-- NOT done here (deliberately): moving pg_trgm out of the public schema (advisor
-- extension_in_public). search_jobs relies on the % / similarity operators with
-- search_path = public, extensions; relocating the installed extension risks the
-- live fuzzy-search indexes. Low severity (WARN). Track as a separate, tested change.
