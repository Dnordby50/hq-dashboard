-- ============================================================================
-- BusyBusy time entries + job<->project link (Part B of the Job Costing build).
-- Author: Claude Code (2026-06-13). RUN BY COWORK on the PEC Supabase project.
-- Idempotent.
--
-- Granular storage so an edit in BusyBusy is just an UPSERT on
-- busybusy_entry_id and per-person-per-job hours fall out of a SUM. Actual
-- hours stay correct when a time entry is edited or deleted in BusyBusy: the
-- sync upserts by busybusy_entry_id and soft-deletes (deleted_at) entries that
-- BusyBusy no longer reports. NOTHING is ever written back to BusyBusy.
-- ============================================================================

-- 1) One row per BusyBusy time entry.
create table if not exists public.pec_prod_busybusy_time_entries (
  id uuid primary key default gen_random_uuid(),
  busybusy_entry_id   text not null unique,   -- upsert / delete key from BusyBusy
  busybusy_member_id  text,                   -- raw BusyBusy member id
  crew_member_id      uuid references public.pec_prod_crew_members(id) on delete set null,
  busybusy_project_id text,                   -- raw BusyBusy project id
  job_id              uuid references public.pec_prod_jobs(id) on delete cascade,
  work_date           date,
  hours               numeric(10,4) not null default 0,
  started_at          timestamptz,
  ended_at            timestamptz,
  deleted_at          timestamptz,            -- soft delete (entry voided in BusyBusy)
  updated_at          timestamptz not null default now(),
  created_at          timestamptz not null default now()
);
create index if not exists idx_pec_busybusy_time_job
  on public.pec_prod_busybusy_time_entries(job_id);
create index if not exists idx_pec_busybusy_time_member
  on public.pec_prod_busybusy_time_entries(crew_member_id);
create index if not exists idx_pec_busybusy_time_project
  on public.pec_prod_busybusy_time_entries(busybusy_project_id);

-- 2) Tie a BusyBusy project to a PEC job (mirror of companycam_project_id).
--    The link is auto-matched by name/address then confirmed by a human.
alter table public.pec_prod_jobs
  add column if not exists busybusy_project_id text;

-- 3) RLS: same is_admin_staff() gate the rest of the costing tables use, so a
--    staff member who can read job costing can read these too. Writes go
--    through the server (service role) sync, never the browser.
alter table public.pec_prod_busybusy_time_entries enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'pec_prod_busybusy_time_entries'
      and policyname = 'busybusy_time_admin_read'
  ) then
    create policy busybusy_time_admin_read
      on public.pec_prod_busybusy_time_entries
      for select
      using (public.is_admin_staff());
  end if;
end $$;
