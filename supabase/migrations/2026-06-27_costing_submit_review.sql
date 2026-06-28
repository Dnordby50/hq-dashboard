-- ============================================================================
-- 2026-06-27: Job Costing submit-for-review approval step. Author: Claude Code.
-- RUN BY COWORK on the PEC Supabase project. Idempotent. NOT applied to prod
-- from the Claude Code session, per the standing do-not-touch-prod rule.
--
-- Adds a "submitted for review" lifecycle stage between Draft and Finalized so a
-- non-admin (Anne) fills in costing and SUBMITS, and only an admin (Dylan)
-- FINALIZES. No enum: the stage is read off two stamps, mirroring the existing
-- costing_finalized_at/by pair from 2026-06-14_costing_lifecycle.sql:
--   Draft            : costing_submitted_at null  AND costing_finalized_at null
--   Submitted/review : costing_submitted_at set   AND costing_finalized_at null
--   Finalized        : costing_finalized_at set   (unchanged from today)
-- Home is pec_prod_jobs, same as the finalize stamps, so renderUnifiedJob reads
-- them as job fields and writes them through saveJobField -> pec_prod_jobs.update.
-- ============================================================================

begin;

-- 1) Submit-for-review stamps on the job (who submitted + when).
alter table public.pec_prod_jobs
  add column if not exists costing_submitted_at timestamptz,
  add column if not exists costing_submitted_by text;

-- 2) Bell notification when a non-admin submits costing for review. Client JS
--    cannot insert into pec_notifications directly (RLS grants staff
--    SELECT/UPDATE only), so this is a SECURITY DEFINER function, matching the
--    portal + log_customer_deleted notification RPCs. job_id is intentionally
--    left null: pec_notifications.job_id FKs public.jobs(id), but a costing job
--    is a pec_prod_jobs row (different id space), so the body names the customer
--    instead. The bell item is then non-clickable, which is correct -- the admin
--    reviews from the Job Costing "Submitted for review" queue.
create or replace function public.log_costing_submitted(p_customer text)
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
    values ('costing_submitted',
            coalesce(v_actor, 'Someone') || ' submitted job costing for '
              || coalesce(nullif(p_customer, ''), 'a job') || ' for review');
end
$$;

-- Staff only (the app calls it as the authenticated user).
grant execute on function public.log_costing_submitted(text) to authenticated;

-- No new RLS: pec_prod_jobs already carries its policies, and the added columns
-- live on that existing table.

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_name = 'pec_prod_jobs'
--       and column_name in ('costing_submitted_at','costing_submitted_by');  -- 2 rows
--   select proname from pg_proc where proname = 'log_costing_submitted';      -- 1 row
--   -- then submit a test job costing as a non-admin and confirm a
--   -- 'costing_submitted' row appears:
--   --   select type, body from public.pec_notifications order by created_at desc limit 1;
