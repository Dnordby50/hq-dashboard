-- ============================================================================
-- 2026-07-19: drip engine Phase 3 (prompt 35): subject generalization,
-- estimate + invoice campaigns, blast tool tables
-- ============================================================================
-- REQUIRES 2026-07-19_drip_engine.sql applied FIRST (same Cowork session is
-- fine; run the two files in order). Idempotent / safe to re-run.
--
-- WHAT CHANGES AND WHY:
--   1. Enrollments/sends gain (subject_type, subject_id). Phase 2 hard-keyed
--      everything to lead_id, which cannot represent a job-based invoice
--      reminder and blocks a lead from holding a lead-nurture drip AND an
--      estimate drip at once. subject_type is 'lead' (lead + estimate drips)
--      or 'job' (invoice drips). lead_id becomes NULLABLE but STAYS POPULATED
--      for lead subjects: the Phase 1 contact counter and the Quo STOP webhook
--      both join on it, so keeping it is cheaper and safer than migrating
--      those readers. subject_id carries no FK (polymorphic by design; the
--      runner treats a missing subject as a stop, so orphans self-clean).
--   2. The one-active-per-lead partial unique index becomes one-active-per
--      (subject_type, subject_id, campaign_id): a lead can now hold a
--      lead-nurture drip and an estimate drip simultaneously, but never two
--      of the SAME campaign. enrollLead's 409 handling is unchanged.
--   3. pec_blasts + pec_drip_sends.blast_id: blasts share the drip send
--      ledger (ONE outbound-touch record for metrics and contact counts).
--      Blast recipients are materialized as status 'queued' rows at confirm
--      time; the drain claims queued -> 'sending' -> sent/failed. That
--      queued-row materialization IS the resume mechanism and the
--      no-double-send guard. Blast rows have enrollment_id/campaign_id null
--      (blast_id set instead) and step_index 0; a CHECK enforces that every
--      row belongs to an enrollment or a blast.
--   4. Seeds: estimate follow-up campaign (days 1,3,7,14 after the estimate
--      goes out) and invoice payment reminders (days 0,3,7,14 after the
--      invoice first goes out; there is NO due-date column anywhere, so
--      invoice-sent time is the anchor, per prompt 35). BOTH dry_run: the
--      invoice one is auto-sent money talk and stays dry_run until Dylan has
--      read a few days of generated copy and flips it himself.
--
-- Trust model unchanged: staff-only is_admin_staff() FOR ALL, no anon; the
-- runner and drain use the service role. The blast wizard leans on the staff
-- policy for its client-side inserts (pec_blasts header + queued ledger rows).
--
-- *** COWORK HANDOFF: run 2026-07-19_drip_engine.sql then THIS FILE in the
-- PROD Supabase project, then regenerate SCHEMA.md. ***
-- ============================================================================

begin;

-- 1. Blast header table (before pec_drip_sends.blast_id can reference it) ----
create table if not exists public.pec_blasts (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  channel         text not null check (channel in ('sms','email','both')),
  sms_body        text,
  email_subject   text,
  email_body      text,
  audience_filter jsonb not null default '{}'::jsonb,  -- the filter as chosen, kept for the record
  status          text not null default 'draft'
                    check (status in ('draft','confirmed','sending','done','canceled')),
  total_queued    int not null default 0,
  total_sent      int not null default 0,
  total_failed    int not null default 0,
  total_skipped   int not null default 0,
  created_by      uuid,                                -- auth.uid() of the composer
  created_at      timestamptz not null default now(),
  confirmed_at    timestamptz,
  completed_at    timestamptz,
  updated_at      timestamptz not null default now()
);

alter table public.pec_blasts enable row level security;
drop policy if exists pec_blasts_staff on public.pec_blasts;
create policy pec_blasts_staff on public.pec_blasts for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());
drop trigger if exists trg_pec_blasts_touch on public.pec_blasts;
create trigger trg_pec_blasts_touch before update on public.pec_blasts
  for each row execute function public.pec_prod_touch_updated_at();

-- 2. Generalize enrollments ---------------------------------------------------
alter table public.pec_drip_enrollments add column if not exists subject_type text;
alter table public.pec_drip_enrollments add column if not exists subject_id uuid;

-- Backfill existing lead enrollments before tightening constraints.
update public.pec_drip_enrollments
   set subject_type = 'lead', subject_id = lead_id
 where subject_id is null;

alter table public.pec_drip_enrollments alter column subject_type set default 'lead';
alter table public.pec_drip_enrollments alter column subject_type set not null;
alter table public.pec_drip_enrollments alter column subject_id set not null;
alter table public.pec_drip_enrollments alter column lead_id drop not null;

alter table public.pec_drip_enrollments
  drop constraint if exists chk_pec_drip_enroll_subject_type;
alter table public.pec_drip_enrollments
  add constraint chk_pec_drip_enroll_subject_type
  check (subject_type in ('lead','job'));

-- Lead subjects must keep lead_id populated and equal to subject_id (the
-- contact counter and the Quo STOP stop-by-lead_id path depend on it).
alter table public.pec_drip_enrollments
  drop constraint if exists chk_pec_drip_enroll_lead_link;
alter table public.pec_drip_enrollments
  add constraint chk_pec_drip_enroll_lead_link
  check (subject_type <> 'lead' or lead_id = subject_id);

-- Index swap: one ACTIVE enrollment per subject per campaign.
drop index if exists idx_pec_drip_enroll_one_active;
create unique index if not exists idx_pec_drip_enroll_one_active_subj
  on public.pec_drip_enrollments (subject_type, subject_id, campaign_id)
  where status = 'active';

-- 3. Generalize the send ledger + attach blasts -------------------------------
alter table public.pec_drip_sends add column if not exists subject_type text;
alter table public.pec_drip_sends add column if not exists subject_id uuid;
alter table public.pec_drip_sends add column if not exists blast_id uuid
  references public.pec_blasts(id) on delete set null;  -- touch history outlives a deleted blast

update public.pec_drip_sends
   set subject_type = 'lead', subject_id = lead_id
 where subject_id is null;

-- Blast rows have no enrollment/campaign/lead; drip rows keep them.
alter table public.pec_drip_sends alter column enrollment_id drop not null;
alter table public.pec_drip_sends alter column campaign_id drop not null;
alter table public.pec_drip_sends alter column lead_id drop not null;

alter table public.pec_drip_sends
  drop constraint if exists chk_pec_drip_sends_subject_type;
alter table public.pec_drip_sends
  add constraint chk_pec_drip_sends_subject_type
  check (subject_type in ('lead','job','customer'));    -- 'customer' = blast recipient from customers

alter table public.pec_drip_sends
  drop constraint if exists chk_pec_drip_sends_origin;
alter table public.pec_drip_sends
  add constraint chk_pec_drip_sends_origin
  check (enrollment_id is not null or blast_id is not null);

-- Widen status: 'sending' is the blast drain's claim state (queued -> sending
-- -> sent/failed). The inline check from the Phase 2 file gets the
-- auto-generated name below; swap it for a named one.
alter table public.pec_drip_sends drop constraint if exists pec_drip_sends_status_check;
alter table public.pec_drip_sends
  add constraint pec_drip_sends_status_check
  check (status in ('queued','sending','sent','failed','skipped','dry_run'));

create index if not exists idx_pec_drip_sends_blast
  on public.pec_drip_sends (blast_id, status) where blast_id is not null;
create index if not exists idx_pec_drip_sends_subject
  on public.pec_drip_sends (subject_type, subject_id);

-- 4. Seed the estimate follow-up campaign (days 1,3,7,14, dry_run) -----------
-- ai_guidance is instruction TO THE MODEL, not customer copy. The estimate
-- link and any dollar amount are appended by CODE from real data (the render
-- scrubber strips model-written links), so every step says "no link".
do $$
declare cid uuid;
begin
  select id into cid from public.pec_drip_campaigns where kind = 'estimate' limit 1;
  if cid is null then
    insert into public.pec_drip_campaigns (name, kind, status, mode, max_touches)
      values ('Estimate follow-up (14-day taper)', 'estimate', 'active', 'dry_run', 4)
      returning id into cid;
    insert into public.pec_drip_steps (campaign_id, step_index, day_offset, channel, ai_guidance, email_subject) values
      (cid, 0, 1,  'both',  'The day after their estimate went out. Confirm the estimate reached them and offer to walk through it or answer questions by phone or text. You may mention the estimate price only if it is present in the record. Warm, zero pressure. Do not write a link; the system appends the estimate link automatically.', 'Your Prescott Epoxy estimate'),
      (cid, 1, 3,  'sms',   'Short check-in on the estimate they received. One or two sentences: happy to adjust the scope or answer any questions, whenever works for them. Do not write a link; the system appends it.', null),
      (cid, 2, 7,  'email', 'One-week follow-up on their estimate. Acknowledge they are probably weighing options and invite questions or a quick call. Never invent expiration dates, discounts, or schedule pressure. Do not write a link; the system appends it.', 'Any questions on your estimate?'),
      (cid, 3, 14, 'both',  'Final touch on this estimate, leave the door open. Say this is the last automatic reminder, the estimate stands, and they can reach out any time to move forward or ask questions. Gracious, zero pressure. Do not write a link; the system appends it.', 'Here whenever you are ready');
  end if;
end $$;

-- 5. Seed the invoice payment-reminder campaign (days 0,3,7,14, dry_run) -----
-- Anchored to the invoice first going out (no due-date column exists). The
-- REAL remaining balance and pay link are appended by code every send; the
-- model may state the balance passed in the record but can never invent one.
do $$
declare cid uuid;
begin
  select id into cid from public.pec_drip_campaigns where kind = 'invoice' limit 1;
  if cid is null then
    insert into public.pec_drip_campaigns (name, kind, status, mode, max_touches)
      values ('Invoice payment reminders', 'invoice', 'active', 'dry_run', 4)
      returning id into cid;
    insert into public.pec_drip_steps (campaign_id, step_index, day_offset, channel, ai_guidance, email_subject) values
      (cid, 0, 0,  'sms',   'Right after their invoice went out. One or two sentences: thank them for choosing Prescott Epoxy and note their invoice is on its way and paying online is easy. You may state the balance from the record. Do not write a link; the system appends the payment link automatically.', null),
      (cid, 1, 3,  'both',  'Friendly reminder a few days after the invoice. Reference the remaining balance from the record and note the payment link below is the fastest way to take care of it. Thank them for their business. Never guess at amounts and never mention late fees. Do not write a link; the system appends it.', 'Your Prescott Epoxy invoice'),
      (cid, 2, 7,  'both',  'One-week payment reminder. Kind and direct: the balance from the record is still open and the link below takes card or bank payment. Invite them to reply with any billing questions. No invented due dates or penalties. Do not write a link; the system appends it.', 'Quick reminder on your invoice'),
      (cid, 3, 14, 'both',  'Final automated reminder. Warm but clear: the balance remains open, ask them to pay via the link below, or reply if something looks wrong or they need to talk through timing. Say a team member will follow up personally after this. Do not write a link; the system appends it.', 'Following up on your invoice');
  end if;
end $$;

commit;

-- Verify after running:
--   select column_name, is_nullable from information_schema.columns
--    where table_name='pec_drip_enrollments' and column_name in ('subject_type','subject_id','lead_id');
--                                          -- subject_type NO, subject_id NO, lead_id YES
--   select count(*) from public.pec_drip_enrollments where subject_id is null;   -- 0
--   select indexname from pg_indexes where tablename='pec_drip_enrollments';
--                                          -- has idx_pec_drip_enroll_one_active_subj,
--                                          -- does NOT have idx_pec_drip_enroll_one_active
--   select column_name, is_nullable from information_schema.columns
--    where table_name='pec_drip_sends' and column_name in ('enrollment_id','campaign_id','lead_id','blast_id');
--                                          -- all YES (nullable), blast_id present
--   select conname from pg_constraint where conrelid='public.pec_drip_sends'::regclass
--    and conname in ('chk_pec_drip_sends_origin','pec_drip_sends_status_check');  -- 2 rows
--   select name, kind, status, mode, max_touches from public.pec_drip_campaigns order by kind;
--                                          -- estimate/active/dry_run/4, invoice/active/dry_run/4,
--                                          -- lead/active/dry_run/8 (from Phase 2)
--   select c.kind, s.step_index, s.day_offset, s.channel from public.pec_drip_steps s
--    join public.pec_drip_campaigns c on c.id = s.campaign_id
--    where c.kind <> 'lead' order by c.kind, s.step_index;
--                                          -- estimate day 1,3,7,14; invoice day 0,3,7,14
--   select tablename, count(*) from pg_policies where tablename='pec_blasts' group by 1;  -- 1 policy
--   select relrowsecurity from pg_class where relname='pec_blasts';                       -- true
--   select value from public.settings where key='drip_sending_enabled';  -- unchanged ('false')
