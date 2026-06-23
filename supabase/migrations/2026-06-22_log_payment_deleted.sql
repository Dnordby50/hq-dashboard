-- ============================================================================
-- 2026-06-22: log_payment_deleted RPC (notification-bell parity for payment delete).
-- Author: Claude Code. RUN BY COWORK on PROD. Idempotent (create or replace).
--
-- Why: the invoice screen now lets admin staff DELETE a recorded payment. The
-- delete is already audited client-side via logJobActivity -> public.audit_log,
-- and the pec_payments_staff (for all) RLS policy already permits the delete, so
-- the feature works WITHOUT this migration. This RPC just mirrors the existing
-- log_payment_edited (2026-06-08_edit_payment.sql) so a delete also drops a row
-- in pec_notifications and lights up the header bell. The client calls it
-- best-effort (try/catch), so applying this is non-blocking.
--
-- SECURITY DEFINER so it can write pec_notifications + read admin_users/jobs/
-- customers regardless of the caller's row policies, exactly like log_payment_edited.
-- ============================================================================

begin;

create or replace function public.log_payment_deleted(
  p_job_id uuid,
  p_amount numeric
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
  insert into public.pec_notifications (type, job_id, body)
    values ('payment_deleted', p_job_id,
            coalesce(v_actor, 'Someone') || ' deleted a payment'
            || coalesce(' for ' || nullif(v_cust, ''), '')
            || ' ($' || to_char(coalesce(p_amount, 0), 'FM999999990.00') || ')');
end
$$;

grant execute on function public.log_payment_deleted(uuid, numeric) to authenticated;

commit;

-- Verify:
--   select proname from pg_proc where proname = 'log_payment_deleted';  -- 1 row
