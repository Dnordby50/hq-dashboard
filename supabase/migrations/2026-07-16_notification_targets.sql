-- ============================================================================
-- 2026-07-16: clickable bell notifications (routing targets)
-- ============================================================================
-- Gives a pec_notifications row a way to say WHERE a click should land, not
-- just carry a public.jobs id:
--   target_view - the CRM view to open ('jobs' | 'costing' | 'invoicing')
--   target_id   - the id to open IN that view. Deliberately NO foreign key:
--                 which table the id references depends on target_view
--                 ('costing' ids live on pec_prod_jobs, 'jobs'/'invoicing'
--                 ids live on public.jobs), so one FK cannot cover it. The
--                 client treats a dangling id as a normal not-found page.
--
-- The existing job_id column stays untouched for back-compat: old rows keep
-- clicking through to the job card (the client's legacy path), and the portal
-- RPCs (portal_log_view, portal_set_area_colors) keep writing job_id, which
-- already IS their sensible destination. Only the producers that today have
-- NO usable link change here:
--   log_costing_submitted / log_costing_sent_back - gain p_job_id (a
--     pec_prod_jobs id, the reason job_id could never carry it) and write
--     target_view='costing' so the click lands on that job's costing view.
--     Signature change, so drop-then-create; p_job_id defaults null so a
--     not-yet-redeployed client calling with the old arg shape still works.
--   log_payment_edited / log_payment_deleted - write target_view='invoicing'
--     (payments live on the invoice page). Same signatures, so plain
--     create-or-replace; payment_deleted also keeps writing job_id.
-- customer_deleted stays text-only on purpose: the customer is gone, there
-- is nowhere sensible to land.
--
-- Additive + idempotent. Safe to re-run.
-- ============================================================================

begin;

-- 1. Routing columns -----------------------------------------------------------
alter table public.pec_notifications
  add column if not exists target_view text,
  add column if not exists target_id   uuid;

-- 2. Costing RPCs now carry the pec_prod_jobs id -------------------------------
-- Drop first: adding a defaulted parameter via create-or-replace would create
-- an OVERLOAD next to the old signature, and PostgREST refuses ambiguous rpc
-- names. Confirmed live 2026-07-16: exactly one overload of each exists.
drop function if exists public.log_costing_submitted(text);
create function public.log_costing_submitted(p_customer text, p_job_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text;
begin
  select coalesce(name, email) into v_actor from public.admin_users where auth_user_id = auth.uid();
  insert into public.pec_notifications (type, body, target_view, target_id)
    values ('costing_submitted',
            coalesce(v_actor, 'Someone') || ' submitted job costing for '
              || coalesce(nullif(p_customer, ''), 'a job') || ' for review',
            case when p_job_id is not null then 'costing' end,
            p_job_id);
end
$$;
grant execute on function public.log_costing_submitted(text, uuid) to authenticated;

drop function if exists public.log_costing_sent_back(text, text);
create function public.log_costing_sent_back(p_customer text, p_note text, p_job_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text;
begin
  select coalesce(name, email) into v_actor from public.admin_users where auth_user_id = auth.uid();
  insert into public.pec_notifications (type, body, target_view, target_id)
    values ('costing_sent_back',
            coalesce(v_actor, 'Someone') || ' sent '
              || coalesce(nullif(p_customer, ''), 'a job') || ' job costing back: ' || p_note,
            case when p_job_id is not null then 'costing' end,
            p_job_id);
end
$$;
grant execute on function public.log_costing_sent_back(text, text, uuid) to authenticated;

-- 3. Payment RPCs land on the invoice page --------------------------------------
-- Same signatures as 2026-06-08_edit_payment.sql / 2026-06-22_log_payment_deleted.sql
-- (confirmed live), so create-or-replace is safe.
create or replace function public.log_payment_edited(
  p_job_id         uuid,
  p_amount_before  numeric,
  p_amount_after   numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text;
  v_cust  text;
begin
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
$$;
grant execute on function public.log_payment_edited(uuid, numeric, numeric) to authenticated;

create or replace function public.log_payment_deleted(p_job_id uuid, p_amount numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text;
  v_cust  text;
begin
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
$$;
grant execute on function public.log_payment_deleted(uuid, numeric) to authenticated;

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='pec_notifications'
--       and column_name in ('target_view','target_id');                    -- 2 rows
--   select proname, pg_get_function_identity_arguments(p.oid)
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname='public' and proname in
--      ('log_costing_submitted','log_costing_sent_back');
--     -- exactly 2 rows: (text, uuid) and (text, text, uuid), no old overloads
--   -- then send a test costing back and confirm the new row routes:
--   --   select type, target_view, target_id from public.pec_notifications
--   --     order by created_at desc limit 1;   -- costing_sent_back / costing / <uuid>
