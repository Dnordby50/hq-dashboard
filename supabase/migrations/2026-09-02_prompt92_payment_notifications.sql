-- @artifacts
--   setting: payment_notifications_enabled
--   setting: payment_notify_min_amount
--   setting: payment_notify_staff_recorded
--   setting: payment_notify_ach_failed_priority
--   none: also creates a SECURITY DEFINER function (log_payment_recorded), not expressible as table/column/index/setting
-- @end
-- ============================================================================
-- 2026-09-02: payment notifications on the bell (prompt 92 Task C).
-- Author: Claude Code. Idempotent. Rule 14 (rehearse on a branch database)
-- could NOT be followed literally: create_branch returned "Branching is
-- supported only on the Pro plan or above" (free-tier org, 2026-08-16).
-- Rehearsed instead via BEGIN/ROLLBACK transactions on prod with a simulated
-- staff JWT (set_config request.jwt.claims): the happy path wrote the exact
-- intended row, and all four gates (master off, staff-recorded off, min
-- amount, no JWT) suppressed it; every rehearsal rolled back, zero residue.
--
-- WHY: nothing rang the bell for a payment being RECEIVED (only the
-- log_payment_edited / log_payment_deleted correction RPCs existed). Dylan
-- (2026-08-16) chose four events: card paid + ACH settled + ACH failed (all
-- written by pec-stripe-webhook.cjs via the service role, no schema change
-- needed) and staff-recorded payments, which need this RPC because staff
-- sessions have SELECT/UPDATE only on pec_notifications, no INSERT (same
-- pattern as log_payment_edited).
--
-- The four settings gate ALL four events server-side (the webhook reads them
-- per event; this RPC reads the three that apply to it), so the bells are
-- tunable with no code change. Missing rows = the seeded defaults.
-- ============================================================================

begin;

insert into public.settings (key, value) values
  ('payment_notifications_enabled', 'true'),
  ('payment_notify_min_amount', '0'),
  ('payment_notify_staff_recorded', 'true'),
  ('payment_notify_ach_failed_priority', 'high')
on conflict (key) do nothing;

-- Bell row for a staff-recorded payment. SECURITY DEFINER so it can write
-- pec_notifications + read admin_users/jobs/customers/settings regardless of
-- the caller's row policies, exactly like log_payment_edited. Gating order:
-- staff caller -> master switch -> staff-recorded toggle -> minimum amount.
-- Every gate returns void silently: the client calls this fire-and-forget
-- after a CONFIRMED pec_payments insert, and a suppressed bell must never
-- surface as an error on the payment path.
create or replace function public.log_payment_recorded(p_job_id uuid, p_amount numeric, p_method text)
returns void language plpgsql security definer set search_path to 'public'
as $$
declare
  v_actor text;
  v_cust  text;
  v_val   text;
  v_min   numeric := 0;
begin
  if not public.is_admin_staff() then return; end if;
  select value into v_val from public.settings where key = 'payment_notifications_enabled';
  if coalesce(v_val, 'true') = 'false' then return; end if;
  select value into v_val from public.settings where key = 'payment_notify_staff_recorded';
  if coalesce(v_val, 'true') = 'false' then return; end if;
  select value into v_val from public.settings where key = 'payment_notify_min_amount';
  begin
    v_min := coalesce(nullif(trim(v_val), '')::numeric, 0);
  exception when others then
    v_min := 0; -- an unparseable floor never mutes the bell
  end;
  if coalesce(p_amount, 0) < v_min then return; end if;

  select coalesce(name, email) into v_actor from public.admin_users where auth_user_id = auth.uid();
  select c.name into v_cust
    from public.jobs j left join public.customers c on c.id = j.customer_id
   where j.id = p_job_id;
  insert into public.pec_notifications (type, job_id, body, priority, target_view, target_id)
    values ('payment_recorded', p_job_id,
            coalesce(v_actor, 'Someone') || ' recorded a $'
              || to_char(coalesce(p_amount, 0), 'FM999,999,990.00')
              || ' ' || coalesce(nullif(trim(p_method), ''), 'payment') || ' payment'
              || coalesce(' from ' || nullif(v_cust, ''), ''),
            'normal',
            case when p_job_id is not null then 'invoicing' end,
            p_job_id);
end
$$;

-- Same reachability posture as the other six loggers (2026-07-25 hardening):
-- authenticated staff only, no anon/PUBLIC.
revoke execute on function public.log_payment_recorded(uuid, numeric, text) from anon, public;
grant execute on function public.log_payment_recorded(uuid, numeric, text) to authenticated;

commit;

-- Verify:
--   select proname, prosecdef from pg_proc where proname = 'log_payment_recorded';  -- 1 row, prosecdef true
--   select key, value from settings where key like 'payment_notif%' or key like 'payment_notify%' order by key;  -- 4 rows
