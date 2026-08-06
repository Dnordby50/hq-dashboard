-- @artifacts
--   column: public.pec_drip_steps.fixed_template
--   column: public.pec_drip_steps.fixed_subject
--   column: public.pec_drip_steps.auto_send
--   setting: routemize_booking_url
--   setting: drip_instant_touch_enabled
--   setting: routemize_answer_routing
-- @end
--
-- Prompt 73: the day-0 instant touch on the lead-nurture campaign, plus the
-- Routemize answer-routing setting (Part A) and the booking-link setting.
--
-- WHY a new step 0 instead of a separate campaign: Dylan's decision 8. One
-- campaign, 9 steps at days 0, 1, 2, 4, 7, 11, 16, 22, 30; the existing 8
-- steps shift down one index. The renumber is safe ONLY because there are
-- zero active enrollments (re-verified inside the DO block below, and any
-- nonzero count gets its next_step_index bumped in the same transaction:
-- a silent reindex of a live enrollment sends someone the wrong message).
--
-- WHY the +100/-99 hop: UNIQUE (campaign_id, step_index) is not deferrable,
-- and Postgres checks it per-row mid-UPDATE, so incrementing 0..7 in place
-- can collide with itself. Shift the whole block clear, then land it.
--
-- New columns (forward-only; every existing step gets fixed_template null and
-- auto_send false, so pre-73 behavior is byte-identical):
--   fixed_template: when set, the step sends this text VERBATIM after token
--     substitution ({first_name}, {booking_link}, and the
--     {{#booking_link}}...{{/booking_link}} conditional block) and makes zero
--     model calls.
--   fixed_subject: email subject for a fixed-template step.
--   auto_send: this step bypasses the approval gate and quiet hours. PER-STEP
--     on purpose (landmine 2): a global flag would let one settings flip
--     auto-send 8 AI-written messages.
-- ai_guidance goes nullable because a fixed-template step has no AI
-- instruction; every AI step still carries one.
--
-- Settings are insert-only (on conflict do nothing) so a re-run never
-- clobbers a live edit. routemize_booking_url ships EMPTY: the build must
-- not invent a URL; Dylan supplies the real one in Settings > Drips and the
-- template conditional renders nothing until then.

alter table public.pec_drip_steps alter column ai_guidance drop not null;
alter table public.pec_drip_steps add column if not exists fixed_template text;
alter table public.pec_drip_steps add column if not exists fixed_subject text;
alter table public.pec_drip_steps add column if not exists auto_send boolean not null default false;

do $$
declare
  cid uuid := 'e646981a-7bc4-4b58-8da1-280d685d7c8a';  -- "Lead follow-up (30-day taper)"
  active_count int;
  step_count int;
begin
  -- Idempotency: a re-run against a database that already has the day-0 step
  -- must not double-shift the taper.
  if exists (select 1 from public.pec_drip_steps where campaign_id = cid and step_index = 0 and day_offset = 0) then
    raise notice 'prompt73: day-0 step already present; renumber skipped';
    return;
  end if;

  -- The guardrail (landmine 1): re-verify inside the transaction. Zero at
  -- scoping time, but a lead could have arrived since.
  select count(*) into active_count
  from public.pec_drip_enrollments where campaign_id = cid and status = 'active';
  raise notice 'prompt73: active enrollments on the lead campaign at renumber time: %', active_count;
  if active_count > 0 then
    update public.pec_drip_enrollments
    set next_step_index = next_step_index + 1
    where campaign_id = cid and status = 'active';
    raise notice 'prompt73: bumped next_step_index on % active enrollment(s)', active_count;
  end if;

  update public.pec_drip_steps set step_index = step_index + 100 where campaign_id = cid;
  update public.pec_drip_steps set step_index = step_index - 99 where campaign_id = cid;

  insert into public.pec_drip_steps
    (campaign_id, step_index, day_offset, channel, ai_guidance, email_subject, fixed_template, fixed_subject, auto_send, active)
  values
    (cid, 0, 0, 'both', null,
     'Thanks for reaching out to Prescott Epoxy Company',
     'Hi {first_name}, thanks for reaching out to Prescott Epoxy Company. We got your request and someone from our team will call you shortly.{{#booking_link}} If it is easier, you can pick a time for your free on site estimate right here: {booking_link}{{/booking_link}}',
     'Thanks for reaching out to Prescott Epoxy Company',
     true, true);

  update public.pec_drip_campaigns set max_touches = 9 where id = cid;

  select count(*) into step_count from public.pec_drip_steps where campaign_id = cid;
  raise notice 'prompt73: lead campaign now has % steps (expect 9)', step_count;
end $$;

insert into public.settings (key, value) values
  ('routemize_booking_url', ''),
  ('drip_instant_touch_enabled', 'true'),
  ('routemize_answer_routing', '{"605f816a-b861-c865-3e12-3a2177755a80":"customer","1077d4b4-4c1d-1f34-52a1-3a2177807ce1":"internal"}')
on conflict (key) do nothing;
