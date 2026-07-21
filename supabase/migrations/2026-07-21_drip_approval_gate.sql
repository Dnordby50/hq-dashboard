-- Prompt 42: drip go-live with a human approval gate.
--
-- WHY: all three drip campaigns are about to go live, but for the first week
-- every message is held for a human (Anne) to review, edit, and approve in
-- the new Drip Approvals view before anything reaches a customer. The hold is
-- modeled as a new pec_drip_sends status 'pending': the runner renders the
-- real would-send copy into a pending row and does NOT advance the
-- enrollment; approving sends it (re-checking consent + kill-switches first)
-- and advances, skipping advances without sending.
--
-- Apply with the usual Cowork flow; regenerate SCHEMA.md afterward
-- (pec_drip_sends status CHECK + new index, settings row count).

-- 1) Extend the send-ledger status CHECK with 'pending' (a rendered message
--    held for human approval). Drop + re-add in one transaction, same
--    pattern as the Phase 3 migration that last touched this constraint.
alter table public.pec_drip_sends
  drop constraint if exists pec_drip_sends_status_check;
alter table public.pec_drip_sends
  add constraint pec_drip_sends_status_check
  check (status in ('queued','sending','sent','failed','skipped','dry_run','pending'));

-- 2) Idempotency backstop: at most ONE pending row per enrollment step leg,
--    no matter how many runner ticks race. The engine checks first and this
--    index makes the race a clean 409 instead of a duplicate approval item.
create unique index if not exists uq_pec_drip_sends_pending_leg
  on public.pec_drip_sends (enrollment_id, step_index, channel)
  where status = 'pending';

-- 3) Seed the approval-gate + quiet-hours settings (insert-only: never
--    clobber a value Dylan or Anne already saved in company Settings).
--    drip_approval_required ships 'true' so week one runs live-but-held;
--    Dylan flips it off after the supervised week. Quiet hours default to
--    the window the engine previously hardcoded (08:00-20:00 Phoenix),
--    now Mon-Sat per Dylan's 2026-07-21 decision.
insert into public.settings (key, value) values
  ('drip_approval_required', 'true'),
  ('drip_quiet_start', '08:00'),
  ('drip_quiet_end', '20:00'),
  ('drip_quiet_days', 'mon,tue,wed,thu,fri,sat')
on conflict (key) do nothing;

-- Verify:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'pec_drip_sends_status_check';           -- includes 'pending'
--   select indexname from pg_indexes
--    where indexname = 'uq_pec_drip_sends_pending_leg';       -- 1 row
--   select key, value from public.settings where key like 'drip_%' order by key;
