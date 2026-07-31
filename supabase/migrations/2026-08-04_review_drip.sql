-- @artifacts
--   table: public.pec_review_requests
--   table: public.pec_review_bonuses
--   column: public.reviews.source
--   column: public.reviews.platform
--   column: public.reviews.external_id
--   column: public.reviews.reviewer_name
--   column: public.reviews.review_text
--   column: public.reviews.review_url
--   column: public.reviews.posted_at
--   column: public.reviews.match_status
--   column: public.reviews.matched_by
--   column: public.reviews.matched_at
--   column: public.reviews.crew_lead
--   column: public.reviews.crew_id
--   column: public.reviews.review_request_id
--   index: idx_pec_review_req_one_open
--   index: idx_pec_review_req_status_asked
--   setting: review_drip_enabled
--   setting: review_ask_default_on
--   setting: review_bonus_amount
--   setting: review_bonus_min_stars
--   setting: review_match_window_days
--   setting: review_stop_on_touchup
--   setting: review_alert_max_stars
-- @end
-- Not expressible as artifact kinds (hand-verify with pg_get_constraintdef /
-- information_schema.columns after applying):
--   - pec_drip_campaigns_kind_check recreated to admit 'review'
--   - reviews.job_id and reviews.customer_id NOT NULL dropped (a Google review
--     arrives before we know whose job it is; unmatched inserts must succeed)
-- ============================================================================
-- 2026-08-04: Google review ask drip (prompt 60)
-- ============================================================================
-- A fourth drip kind ('review'): a completed job asks the customer for a
-- Google review (4 touches, day 1/3/7/14), a /r/<token> tracking link records
-- clicks, a Zapier Google Business Profile feed lands posted reviews, and a
-- human confirm turns an inferred match into crew-leader credit and a flat
-- bonus. Two truths the schema encodes:
--   1. Attribution is inferred, never certain: reviews.match_status separates
--      'auto' (machine guess) from 'confirmed' (human fact), and only
--      'confirmed' can ever create a pec_review_bonuses row.
--   2. Review bonuses live in their OWN ledger (pec_review_bonuses), parallel
--      to pec_prod_job_bonuses and deliberately not it: job bonuses roll into
--      pec_prod_job_costing.bonus_cost which feeds finalized job GP, and a
--      review landing weeks later must never move a finalized job's numbers
--      (the prompt-56 failure: 34 finalized jobs, $4,785 of GP moved).
--
-- CAMPAIGN MODE IS 'live' (decision 15, deliberate departure from the other
-- three kinds): no dry_run cushion. The drip_approval_required gate is the
-- ONLY thing between this campaign and a real customer's phone, so the code
-- side adds an enroll-time guard that refuses to enroll while the gate is
-- off and the campaign has never had an approved send.
--
-- Idempotent / safe to re-run (seeds guard on existence, settings insert-only).
-- ============================================================================

begin;

-- 1. Extend the campaign kind CHECK to admit 'review' -------------------------
-- A real constraint (the material_type lesson): drop and recreate, never
-- assume it will accept a new value.
alter table public.pec_drip_campaigns
  drop constraint if exists pec_drip_campaigns_kind_check;
alter table public.pec_drip_campaigns
  add constraint pec_drip_campaigns_kind_check
  check (kind in ('lead','estimate','invoice','review'));

-- 2. The ask ledger: one row per review ask ----------------------------------
-- The unit Anne and the scoreboard read. crew_lead / crew_id are SNAPSHOTS
-- taken at ask time and never re-derived: the scoreboard reflects who ran the
-- job, not who runs it now. brand exists so FTP paint is a settings change
-- later, not a migration. job_completed_date preserves the real completion
-- date for backfilled asks (asked_at is stamped at enrollment time, so the
-- Reviews view can show "completed 25 days ago, asked today").
create table if not exists public.pec_review_requests (
  id                 uuid primary key default gen_random_uuid(),
  job_id             uuid not null references public.jobs(id) on delete cascade,
  prod_job_id        uuid references public.pec_prod_jobs(id) on delete set null,
  customer_id        uuid references public.customers(id) on delete set null,
  token              uuid not null unique default gen_random_uuid(),
  status             text not null default 'asked'
                       check (status in ('asked','clicked','reviewed','skipped','stopped')),
  crew_lead          text,          -- SNAPSHOT at ask time, never re-derived
  crew_id            uuid,          -- SNAPSHOT
  brand              text not null default 'epoxy',
  asked_at           timestamptz,
  job_completed_date date,
  first_clicked_at   timestamptz,
  click_count        integer not null default 0,
  review_id          uuid references public.reviews(id) on delete set null,
  skipped_at         timestamptz,
  skipped_by         text,
  stop_reason        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- A job can never hold two open asks.
create unique index if not exists idx_pec_review_req_one_open
  on public.pec_review_requests (job_id) where status in ('asked','clicked');
-- The Reviews view "asked, no review yet" filter.
create index if not exists idx_pec_review_req_status_asked
  on public.pec_review_requests (status, asked_at);

alter table public.pec_review_requests enable row level security;
drop policy if exists pec_review_requests_staff on public.pec_review_requests;
create policy pec_review_requests_staff on public.pec_review_requests for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());
-- No anon policy on purpose: the public /r/ redirect reads with the service key.
drop trigger if exists trg_pec_review_req_touch on public.pec_review_requests;
create trigger trg_pec_review_req_touch before update on public.pec_review_requests
  for each row execute function public.pec_prod_touch_updated_at();

-- 3. Widen the reviews stub for the Google feed -------------------------------
alter table public.reviews add column if not exists source text not null default 'manual';
alter table public.reviews drop constraint if exists reviews_source_check;
alter table public.reviews add constraint reviews_source_check
  check (source in ('manual','zapier_gbp'));
alter table public.reviews add column if not exists platform text not null default 'google';
alter table public.reviews add column if not exists external_id text;           -- Google review id, the idempotency key
alter table public.reviews add column if not exists reviewer_name text;
alter table public.reviews add column if not exists review_text text;           -- `feedback` stays for internal notes
alter table public.reviews add column if not exists review_url text;
alter table public.reviews add column if not exists posted_at timestamptz;
alter table public.reviews add column if not exists match_status text not null default 'unmatched';
alter table public.reviews drop constraint if exists reviews_match_status_check;
alter table public.reviews add constraint reviews_match_status_check
  check (match_status in ('unmatched','auto','confirmed','rejected'));
alter table public.reviews add column if not exists matched_by text;
alter table public.reviews add column if not exists matched_at timestamptz;
alter table public.reviews add column if not exists crew_lead text;             -- copied from the request on confirm
alter table public.reviews add column if not exists crew_id uuid;
alter table public.reviews add column if not exists review_request_id uuid references public.pec_review_requests(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_indexes where indexname = 'uq_reviews_external_id') then
    create unique index uq_reviews_external_id on public.reviews (external_id)
      where external_id is not null;
  end if;
end $$;

-- THE load-bearing drops (landmine 1): a Google review always arrives before
-- we know whose job it is. Without these, every unmatched intake insert fails
-- and the whole feed silently produces nothing.
alter table public.reviews alter column job_id drop not null;
alter table public.reviews alter column customer_id drop not null;

-- 4. The review bonus ledger --------------------------------------------------
-- Deliberately parallel to pec_prod_job_bonuses and deliberately NOT it: this
-- table must never feed pec_prod_job_costing.bonus_cost or any GP number.
-- The UNIQUE on review_id is the guarantee one review can never pay twice,
-- including through a double-click on Confirm.
create table if not exists public.pec_review_bonuses (
  id               uuid primary key default gen_random_uuid(),
  review_id        uuid not null unique references public.reviews(id) on delete cascade,
  job_id           uuid references public.jobs(id) on delete set null,
  prod_job_id      uuid references public.pec_prod_jobs(id) on delete set null,
  crew_lead        text not null,
  crew_member_id   uuid references public.pec_prod_crew_members(id) on delete set null,
  amount           numeric not null default 0,
  status           text not null default 'pending'
                     check (status in ('pending','approved','paid','voided')),
  approved_by      text,
  approved_at      timestamptz,
  paid_on          date,
  payroll_date     date,
  paid_by          text,
  voided_at        timestamptz,
  voided_by        text,
  void_reason      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.pec_review_bonuses enable row level security;
drop policy if exists pec_review_bonuses_staff on public.pec_review_bonuses;
create policy pec_review_bonuses_staff on public.pec_review_bonuses for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());
drop trigger if exists trg_pec_review_bonus_touch on public.pec_review_bonuses;
create trigger trg_pec_review_bonus_touch before update on public.pec_review_bonuses
  for each row execute function public.pec_prod_touch_updated_at();

-- 5. Settings (standing rule 12), insert-only so live edits survive a re-run --
-- The Google review URL itself keeps using the existing google_review_link_epoxy
-- key; deliberately NOT duplicated here.
insert into public.settings (key, value)
select k, v from (values
  ('review_drip_enabled',      'true'),  -- master switch for the review campaign, independent of drip_sending_enabled
  ('review_ask_default_on',    'true'),  -- close-out popup pre-selects Send
  ('review_bonus_amount',      '25'),    -- dollars per confirmed 5-star review
  ('review_bonus_min_stars',   '5'),     -- minimum rating that earns credit and a bonus
  ('review_match_window_days', '45'),    -- how far back the intake looks for a candidate request
  ('review_stop_on_touchup',   'true'),  -- a touch-up or callback opening stops the drip
  ('review_alert_max_stars',   '3')      -- a review at or below this alerts Dylan and Anne
) as s(k, v)
where not exists (select 1 from public.settings where key = s.k);

-- 6. Seed the review campaign + its 4-step taper ------------------------------
-- mode 'live' by decision 15: the approval gate is this campaign's safety,
-- not dry_run. ai_guidance is instruction TO THE MODEL, not customer copy.
-- Google policy is baked into every step: nothing of value is ever offered
-- in exchange for a review, and there is no rating-routed gating anywhere.
do $$
declare cid uuid;
begin
  select id into cid from public.pec_drip_campaigns where kind = 'review' limit 1;
  if cid is null then
    insert into public.pec_drip_campaigns (name, kind, status, mode, max_touches)
      values ('Review request', 'review', 'active', 'live', 4)
      returning id into cid;
    insert into public.pec_drip_steps (campaign_id, step_index, day_offset, channel, ai_guidance, email_subject) values
      (cid, 0, 1,  'sms',   'Day-after thank you. Thank them by first name for choosing Prescott Epoxy. If a crew leader name is in the record, ask how the crew leader and the crew did, naming the crew leader; if no crew leader name is given, ask how the crew did, with no name. Ask in one sentence if they would leave a Google review, and say the link takes one tap. Invent nothing about the job. Never offer anything of value in exchange for a review. No em dashes.', null),
      (cid, 1, 3,  'sms',   'Short, warm nudge. One or two sentences: hope the new floor is treating them well, and if they have a moment a quick Google review would mean a lot to the crew (name the crew leader if one is in the record, otherwise no name). State that the link is one tap. Invent nothing, offer nothing in exchange for a review, no pressure. No em dashes.', null),
      (cid, 2, 7,  'email', 'One-week follow-up email. Thank them by first name for their business, mention the crew leader by name if one is in the record (otherwise refer to the crew generally), and ask in one sentence if they would share a Google review, noting the link is one tap. Two to four short sentences total. Invent no facts about the job, offer nothing of value in exchange for a review. No em dashes.', 'How did we do on your floor?'),
      (cid, 3, 14, 'sms',   'Final, gracious ask. Say this is the last note about it so their phone is not cluttered, a one-tap Google review would help the crew a lot (name the crew leader if one is in the record), and thank them either way. Invent nothing, offer nothing in exchange for a review. No em dashes.', null);
  end if;
end $$;

commit;

-- Verify after running:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'pec_drip_campaigns_kind_check';
--        -- includes 'review'
--   select is_nullable from information_schema.columns
--    where table_name='reviews' and column_name in ('job_id','customer_id');
--        -- YES, YES
--   select indexdef from pg_indexes where indexname='idx_pec_review_req_one_open';
--        -- UNIQUE ... WHERE status IN ('asked','clicked')
--   select name, kind, status, mode, max_touches from public.pec_drip_campaigns where kind='review';
--        -- 1 row: Review request, review, active, live, 4
--   select step_index, day_offset, channel from public.pec_drip_steps
--    where campaign_id = (select id from public.pec_drip_campaigns where kind='review')
--    order by step_index;
--        -- 4 rows: (0,1,sms) (1,3,sms) (2,7,email) (3,14,sms)
--   select key, value from public.settings where key like 'review_%' order by key;
--        -- 7 rows
