-- @artifacts
--   column: public.user_permissions.can_finalize_costing
-- @end
-- ============================================================================
-- 2026-07-06: can_finalize_costing (the Job Costing review gate)
-- ============================================================================
-- Dylan's decision (2026-07-06): Anne submits costing for review, ONLY Dylan
-- finalizes. Anne's login has role 'admin', which the app treats as a
-- super-role that passes every capability check, so the gate needs a switch
-- that can turn finalize OFF for a specific admin without touching the rest
-- of what the admin role grants her (status overrides, settings, the whole
-- toolkit she uses daily).
--
-- can_finalize_costing defaults TRUE: every existing user keeps exactly the
-- behavior they had before this column existed, and the app reads it with
-- explicit-false semantics (canFinalizeCosting in index.html: finalize needs
-- role admin AND the flag not explicitly false), so a missing row can never
-- lock Dylan out of finalize. Flipping Anne's row to false is the ONE data
-- change, listed as a separate step below so it is deliberate, not a side
-- effect of re-running the migration.
--
-- *** COWORK HANDOFF: run this in the PROD Supabase project, then run the
-- *** Anne update in step 2 of the handoff (verify the SELECT first).
-- Idempotent / safe to re-run (ADD COLUMN IF NOT EXISTS; no data changes).
-- ============================================================================

begin;

alter table public.user_permissions
  add column if not exists can_finalize_costing boolean not null default true;

commit;

-- Verify after running:
--   select column_name, data_type, column_default
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'user_permissions'
--      and column_name = 'can_finalize_costing';           -- 1 row, default true
--
-- Then the Anne flip (data change, run deliberately, NOT part of the
-- re-runnable migration body):
--   -- 1) Confirm exactly ONE row comes back and it is Anne:
--   select a.id, a.name, a.email, a.role
--     from public.admin_users a
--    where lower(a.name) like 'anne%';
--   -- 2) Turn finalize off for that one row (user_permissions has a
--   --    backfilled row per staff member since 2026-06-08, so UPDATE is
--   --    enough; the WHERE repeats the name guard):
--   update public.user_permissions up
--      set can_finalize_costing = false
--     from public.admin_users a
--    where a.id = up.admin_user_id
--      and lower(a.name) like 'anne%';
--   -- 3) Verify: expect exactly one false row, Anne's:
--   select a.name, up.can_finalize_costing
--     from public.user_permissions up
--     join public.admin_users a on a.id = up.admin_user_id
--    order by a.name;
