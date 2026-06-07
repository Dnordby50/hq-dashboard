-- ============================================================================
-- 2026-06-07: notify the CRM bell when a customer is deleted (archived)
-- ============================================================================
-- The customer Delete button soft-deletes (sets customers.archived_at) and then
-- calls this RPC to drop a row into pec_notifications so the deletion shows in
-- the bell, naming the customer and who did it. Client JS cannot insert into
-- pec_notifications directly (RLS allows staff SELECT/UPDATE only), so this is a
-- SECURITY DEFINER function, matching the portal notification RPCs.

begin;

create or replace function public.log_customer_deleted(p_customer_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text;
begin
  select coalesce(name, email) into v_actor from public.admin_users where auth_user_id = auth.uid();
  insert into public.pec_notifications (type, body)
    values ('customer_deleted',
            coalesce(v_actor, 'Someone') || ' deleted customer ' || coalesce(nullif(p_name, ''), p_customer_id::text));
end
$$;

-- Staff only (the app calls it as the authenticated user).
grant execute on function public.log_customer_deleted(uuid, text) to authenticated;

commit;

-- Verify after running:
--   select proname from pg_proc where proname = 'log_customer_deleted';  -- 1 row
--   -- then delete a test customer in the app and confirm a 'customer_deleted'
--   -- row appears: select type, body from public.pec_notifications order by created_at desc limit 1;
