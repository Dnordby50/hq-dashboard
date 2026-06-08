-- Edit a recorded payment, atomically and auditable.
-- Payments are an insert-only ledger; this lets staff correct a recorded payment
-- (amount/method/reference/date) without a naive client UPDATE. The function sets
-- ABSOLUTE values (not a delta), so it is idempotent and safe to retry under the
-- session-wedge recover-retry path (re-running sets the same row, never double-
-- applies). Reuses public.is_admin_staff() and the pec_notifications pattern from
-- log_customer_deleted.

create or replace function public.edit_recorded_payment(
  p_payment_id   uuid,
  p_amount       numeric,
  p_method       text,
  p_reference    text,
  p_received_date date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin_staff() then
    raise exception 'not authorized';
  end if;
  update public.pec_payments
     set amount        = p_amount,
         method        = p_method,
         reference     = nullif(btrim(coalesce(p_reference, '')), ''),
         received_date = p_received_date
   where id = p_payment_id;
  if not found then
    raise exception 'payment % not found', p_payment_id;
  end if;
end
$$;

grant execute on function public.edit_recorded_payment(uuid, numeric, text, text, date) to authenticated;

-- Notification: drop a payment_edited row into the bell, naming the actor and the
-- before/after amount. Best-effort from the client (called after the edit), so a
-- missing function never blocks the edit.
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
  insert into public.pec_notifications (type, body)
    values ('payment_edited',
            coalesce(v_actor, 'Someone') || ' edited a payment'
            || coalesce(' for ' || nullif(v_cust, ''), '')
            || ' (was $' || to_char(coalesce(p_amount_before, 0), 'FM999999990.00')
            || ', now $' || to_char(coalesce(p_amount_after, 0), 'FM999999990.00') || ')');
end
$$;

grant execute on function public.log_payment_edited(uuid, numeric, numeric) to authenticated;
