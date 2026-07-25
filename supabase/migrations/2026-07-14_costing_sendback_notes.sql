-- @artifacts
--   table: public.pec_prod_costing_sendbacks
--   index: pec_prod_costing_sendbacks_job_id_idx
-- @end
-- ============================================================================
-- 2026-07-14: Job Costing "send back with a note". Author: Claude Code.
-- RUN BY COWORK on the PEC Supabase project ("HQ Dashboard",
-- zdfpzmmrgotynrwkeakd). Idempotent. NOT applied to prod from the Claude Code
-- session, per the standing do-not-touch-prod rule.
--
-- Feature: when the reviewer sends a submitted job costing back to the submitter,
-- they must give a REASON. Reasons are kept as a full history (thread) on the job
-- and shown to the submitter three ways: a banner on the costing job, a bell
-- notification, and a #epoxysales Slack post. This migration adds the history
-- table and the bell RPC. The Slack post is a Netlify function (server side).
-- ============================================================================

begin;

-- 1) Send-back history. One row per send-back, newest read first by created_at.
--    Cascade on job delete so a removed job takes its notes with it.
create table if not exists public.pec_prod_costing_sendbacks (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.pec_prod_jobs(id) on delete cascade,
  note         text not null,
  sent_back_by text,
  created_at   timestamptz not null default now()
);

create index if not exists pec_prod_costing_sendbacks_job_id_idx
  on public.pec_prod_costing_sendbacks (job_id);

-- 2) Staff-only RLS, mirroring pec_prod_crews / pec_prod_jobs (2026-04-28).
alter table public.pec_prod_costing_sendbacks enable row level security;
drop policy if exists pec_prod_costing_sendbacks_staff on public.pec_prod_costing_sendbacks;
create policy pec_prod_costing_sendbacks_staff on public.pec_prod_costing_sendbacks for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

-- 3) Bell notification when a job is sent back. Same shape + rationale as
--    log_costing_submitted (2026-06-27): client JS cannot insert into
--    pec_notifications directly (RLS grants staff SELECT/UPDATE only), so this is
--    a SECURITY DEFINER function. job_id is intentionally left null: a costing job
--    is a pec_prod_jobs row, but pec_notifications.job_id FKs public.jobs(id), so
--    the body names the customer and the reason instead.
create or replace function public.log_costing_sent_back(p_customer text, p_note text)
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
    values ('costing_sent_back',
            coalesce(v_actor, 'Someone') || ' sent '
              || coalesce(nullif(p_customer, ''), 'a job') || ' job costing back: ' || p_note);
end
$$;

-- Staff only (the app calls it as the authenticated user).
grant execute on function public.log_costing_sent_back(text, text) to authenticated;

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_name = 'pec_prod_costing_sendbacks';                          -- 5 rows
--   select proname from pg_proc where proname = 'log_costing_sent_back';        -- 1 row
--   select polname from pg_policies where tablename = 'pec_prod_costing_sendbacks'; -- 1 row (…_staff)
--   -- then send a test job costing back as the reviewer and confirm a
--   -- 'costing_sent_back' row appears:
--   --   select type, body from public.pec_notifications order by created_at desc limit 1;
