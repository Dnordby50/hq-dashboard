-- @artifacts
--   table: public.pec_drip_campaigns
--   table: public.pec_drip_steps
--   table: public.pec_drip_enrollments
--   table: public.pec_drip_sends
--   index: idx_pec_drip_steps_campaign
--   index: idx_pec_drip_enroll_one_active
--   index: idx_pec_drip_enroll_due
--   index: idx_pec_drip_sends_lead
--   index: idx_pec_drip_sends_enrollment
--   setting: drip_sending_enabled
-- @end
-- ============================================================================
-- 2026-07-19: lead drip engine (prompt 34, Phase 2 of the leads-robustness build)
-- ============================================================================
-- Four tables + one settings row. The engine is GENERIC (kind column, channel
-- per step) so Phase 3's estimate/invoice drips are new campaign rows + new
-- triggers, not schema work.
--
-- HOW THE PIECES FIT:
--   pec_drip_campaigns: one row per sequence. mode 'dry_run' (the default)
--     makes the runner write fully-rendered would-send copy into
--     pec_drip_sends WITHOUT calling Quo/Resend, so Dylan reviews real AI
--     output before flipping a campaign to 'live'.
--   pec_drip_steps: the taper. day_offset counts from enrolled_at.
--     ai_guidance is the per-step instruction the model tailors from.
--   pec_drip_enrollments: one ACTIVE enrollment per lead, enforced by a
--     partial unique index (mirrors the one-pending-batch pattern from
--     2026-07-17_change_order_batches). next_step_index is the concurrency
--     token: the runner's conditional advance on it is the claim that makes
--     double-sending impossible.
--   pec_drip_sends: the send ledger, one row per channel leg per step
--     (statuses queued/sent/failed/skipped/dry_run). This is also the fourth
--     source for the Phase 1 times-contacted count (status 'sent' only).
--
-- The GLOBAL MASTER SWITCH rides the existing public.settings key/value table
-- (key 'drip_sending_enabled'), seeded 'false' so NOTHING sends until Dylan
-- turns it on from the Drips admin view.
--
-- Trust model: staff-only via is_admin_staff() FOR ALL, NO anon policy (the
-- runner and webhooks use the service role). Same RLS shape as
-- pec_change_order_batches.
--
-- *** COWORK HANDOFF: run this in the PROD Supabase project. ***
-- Idempotent / safe to re-run (seeds guard on existence).
-- ============================================================================

begin;

-- 1. Campaigns ----------------------------------------------------------------
create table if not exists public.pec_drip_campaigns (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  kind         text not null default 'lead' check (kind in ('lead','estimate','invoice')),
  status       text not null default 'active' check (status in ('active','paused')),
  mode         text not null default 'dry_run' check (mode in ('dry_run','live')),
  max_touches  int  not null default 8,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.pec_drip_campaigns enable row level security;
drop policy if exists pec_drip_campaigns_staff on public.pec_drip_campaigns;
create policy pec_drip_campaigns_staff on public.pec_drip_campaigns for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());
drop trigger if exists trg_pec_drip_campaigns_touch on public.pec_drip_campaigns;
create trigger trg_pec_drip_campaigns_touch before update on public.pec_drip_campaigns
  for each row execute function public.pec_prod_touch_updated_at();

-- 2. Steps --------------------------------------------------------------------
create table if not exists public.pec_drip_steps (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references public.pec_drip_campaigns(id) on delete cascade,
  step_index    int  not null,
  day_offset    int  not null,
  channel       text not null check (channel in ('sms','email','both')),
  ai_guidance   text not null,
  email_subject text,
  active        bool not null default true,
  unique (campaign_id, step_index)
);
create index if not exists idx_pec_drip_steps_campaign on public.pec_drip_steps (campaign_id, step_index);

alter table public.pec_drip_steps enable row level security;
drop policy if exists pec_drip_steps_staff on public.pec_drip_steps;
create policy pec_drip_steps_staff on public.pec_drip_steps for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

-- 3. Enrollments --------------------------------------------------------------
create table if not exists public.pec_drip_enrollments (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references public.leads(id) on delete cascade,
  campaign_id      uuid not null references public.pec_drip_campaigns(id) on delete cascade,
  status           text not null default 'active' check (status in ('active','stopped','completed')),
  next_step_index  int  not null default 0,
  next_send_at     timestamptz,
  stop_reason      text,
  enrolled_at      timestamptz not null default now(),
  stopped_at       timestamptz,
  updated_at       timestamptz not null default now()
);

-- ONE live enrollment per lead; stopped/completed rows accumulate as history.
create unique index if not exists idx_pec_drip_enroll_one_active
  on public.pec_drip_enrollments (lead_id) where status = 'active';
-- The runner's due-work scan.
create index if not exists idx_pec_drip_enroll_due
  on public.pec_drip_enrollments (status, next_send_at);

alter table public.pec_drip_enrollments enable row level security;
drop policy if exists pec_drip_enrollments_staff on public.pec_drip_enrollments;
create policy pec_drip_enrollments_staff on public.pec_drip_enrollments for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());
drop trigger if exists trg_pec_drip_enroll_touch on public.pec_drip_enrollments;
create trigger trg_pec_drip_enroll_touch before update on public.pec_drip_enrollments
  for each row execute function public.pec_prod_touch_updated_at();

-- 4. Send ledger --------------------------------------------------------------
create table if not exists public.pec_drip_sends (
  id            uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.pec_drip_enrollments(id) on delete cascade,
  lead_id       uuid not null references public.leads(id) on delete cascade,
  campaign_id   uuid not null references public.pec_drip_campaigns(id) on delete cascade,
  step_index    int  not null,
  channel       text not null check (channel in ('sms','email')),
  status        text not null check (status in ('queued','sent','failed','skipped','dry_run')),
  scheduled_for timestamptz,
  sent_at       timestamptz,
  subject       text,
  body          text,
  provider_id   text,           -- quo_message_id or resend_id
  error_message text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_pec_drip_sends_lead on public.pec_drip_sends (lead_id, status);
create index if not exists idx_pec_drip_sends_enrollment on public.pec_drip_sends (enrollment_id, step_index);

alter table public.pec_drip_sends enable row level security;
drop policy if exists pec_drip_sends_staff on public.pec_drip_sends;
create policy pec_drip_sends_staff on public.pec_drip_sends for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

-- 5. Global master switch (existing settings key/value table). Seed OFF. -----
insert into public.settings (key, value)
select 'drip_sending_enabled', 'false'
where not exists (select 1 from public.settings where key = 'drip_sending_enabled');

-- 6. Seed the ONE lead campaign + its 8-step taper ----------------------------
-- Days 1,2,4,7,11,16,22,30 after enrollment. Channels alternate so the lead is
-- not carpet-bombed on one channel; early steps hit both while interest is
-- hottest. ai_guidance is instruction TO THE MODEL, not customer copy (the
-- model writes the customer text at send time, per lead). Customer-facing
-- output rules (no invented facts, no em dashes) live in the runner's system
-- prompt, not here.
do $$
declare cid uuid;
begin
  select id into cid from public.pec_drip_campaigns where kind = 'lead' limit 1;
  if cid is null then
    insert into public.pec_drip_campaigns (name, kind, status, mode, max_touches)
      values ('Lead follow-up (30-day taper)', 'lead', 'active', 'dry_run', 8)
      returning id into cid;
    insert into public.pec_drip_steps (campaign_id, step_index, day_offset, channel, ai_guidance, email_subject) values
      (cid, 0, 1,  'both',  'Friendly first follow-up, the day after they reached out. Introduce Prescott Epoxy briefly, thank them for their interest in an epoxy floor, and ask when would be a good time for a quick call to talk through their project. Warm, zero pressure.', 'Your epoxy floor project'),
      (cid, 1, 2,  'sms',   'Short, casual nudge. One or two sentences: still happy to help whenever they are ready, offer to answer any quick questions by text.', null),
      (cid, 2, 4,  'email', 'Helpful value touch. Briefly explain what makes a quality epoxy floor last (surface prep and moisture testing matter more than the coating brand) and invite them to book a free quote. Educational, not salesy.', 'What makes an epoxy floor actually last'),
      (cid, 3, 7,  'both',  'One-week check-in. Acknowledge they are probably busy, ask if the project is still on their radar, and offer two easy next steps: a quick call or a free in-person quote.', 'Still thinking about your floor?'),
      (cid, 4, 11, 'sms',   'Light nudge. Mention the team is scheduling projects in their area soon and it is a good time to get a quote on the calendar. Do not invent specific dates or crews.', null),
      (cid, 5, 16, 'email', 'Social proof touch. Mention that local homeowners routinely tell the team how much a finished garage floor changed how they use the space. Keep it generic, no named customers, no invented reviews or numbers. Invite them to reply with questions.', 'What our floors do for a garage'),
      (cid, 6, 22, 'sms',   'Simple, respectful check-in. One sentence asking if they would still like a free quote, one sentence saying no worries if the timing is not right.', null),
      (cid, 7, 30, 'both',  'Final touch, leave the door open. Say this is the last note so their phone is not cluttered, the offer of a free quote stands whenever they are ready, and they can reach out any time. Gracious, zero pressure.', 'Here whenever you are ready');
  end if;
end $$;

commit;

-- Verify after running:
--   select table_name from information_schema.tables where table_schema='public'
--    and table_name in ('pec_drip_campaigns','pec_drip_steps','pec_drip_enrollments','pec_drip_sends');
--                                                       -- 4 rows
--   select indexdef from pg_indexes
--    where tablename='pec_drip_enrollments' and indexname='idx_pec_drip_enroll_one_active';
--                                                       -- UNIQUE ... WHERE (status = 'active')
--   select tablename, count(*) from pg_policies
--    where tablename like 'pec_drip_%' group by tablename;
--                                                       -- 4 tables x 1 policy (staff FOR ALL), zero anon
--   select relname, relrowsecurity from pg_class
--    where relname like 'pec_drip_%' and relkind='r';   -- rowsecurity true on all 4
--   select value from public.settings where key='drip_sending_enabled';  -- 'false'
--   select name, kind, status, mode, max_touches from public.pec_drip_campaigns;
--                                                       -- 1 row: lead, active, dry_run, 8
--   select step_index, day_offset, channel from public.pec_drip_steps order by step_index;
--                                                       -- 8 rows, day_offset 1,2,4,7,11,16,22,30
