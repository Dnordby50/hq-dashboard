-- ============================================================================
-- 2026-07-01: crew tasks join the Next Day Schedule board
-- ============================================================================
-- Tasks (pec_prod_tasks, the calendar "+ Add Task" reminders) are sometimes
-- job-related work that must be built into the production day (material
-- pickups, warranty visits). To let the Next Day board slot them per crew
-- exactly like jobs, tasks need the same two coordinates a schedule day has:
--
--   crew_id   uuid FK -> pec_prod_crews. ON DELETE SET NULL so deleting a
--             crew orphans the slot assignment but never the task itself
--             (crew_lead keeps the name as text, same survival property the
--             original 2026-06-10 migration chose on purpose).
--   time_slot text, 'AM'/'PM'/'EXTRA' or NULL (null = not slotted yet),
--             the same values and CHECK shape as
--             pec_prod_job_schedule_days.time_slot
--             (2026-06-07_schedule_time_slot_extra.sql). The board displays
--             them as First/Second/Third.
--
-- crew_lead (name text) stays and stays authoritative for the calendar chips;
-- the board writes BOTH on a drop so calendar and board agree. The backfill
-- below links existing tasks to their crew row by exact name match so they
-- can be dragged on the board immediately.
--
-- Deliberately NOT touched: pec_prod_job_schedule_days, pec_prod_jobs, RLS
-- (the existing pec_prod_tasks_staff FOR ALL policy already covers the new
-- columns), and anything status-related. Tasks stay isolated from job status
-- logic.
--
-- *** COWORK HANDOFF: run this in the PROD Supabase project. ***
-- Idempotent / safe to re-run: ADD COLUMN IF NOT EXISTS skips existing
-- columns (including the FK, which is part of the skipped clause), the CHECK
-- is drop-then-add (the 2026-06-07 pattern), and the backfill only fills
-- rows where crew_id is still null.
-- ============================================================================

begin;

alter table public.pec_prod_tasks
  add column if not exists crew_id uuid references public.pec_prod_crews(id) on delete set null;

alter table public.pec_prod_tasks
  add column if not exists time_slot text;

alter table public.pec_prod_tasks
  drop constraint if exists pec_prod_tasks_time_slot_check;
alter table public.pec_prod_tasks
  add constraint pec_prod_tasks_time_slot_check
  check (time_slot is null or time_slot in ('AM','PM','EXTRA'));

-- Backfill: link existing tasks to their crew row by exact name match.
-- Crew names are unique in practice (small hand-managed list); if two crews
-- ever shared a name this would pick one arbitrarily, which is why the
-- verify step below also surfaces the unmatched leftovers for eyeballing.
update public.pec_prod_tasks t
   set crew_id = c.id
  from public.pec_prod_crews c
 where t.crew_id is null
   and t.crew_lead is not null
   and c.name = t.crew_lead;

commit;

-- Verify after running:
--   -- 1) Column list: expect crew_id (uuid) and time_slot (text) present.
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'pec_prod_tasks'
--    order by ordinal_position;
--
--   -- 2) Constraint shape: expect the AM/PM/EXTRA-or-null CHECK.
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'pec_prod_tasks_time_slot_check';
--
--   -- 3) Backfill count (report this number in the log entry): tasks whose
--   --    crew_id was set from the crew_lead name.
--   select count(*) as backfilled
--     from public.pec_prod_tasks
--    where crew_id is not null;
--
--   -- 4) Unmatched leftovers: tasks that name a crew but matched no crew
--   --    row (renamed or deleted crew). Expected small or zero; they simply
--   --    show as unslotted on the board until reassigned.
--   select id, task_date, crew_lead, description
--     from public.pec_prod_tasks
--    where crew_lead is not null and crew_id is null;
