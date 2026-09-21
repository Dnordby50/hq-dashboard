-- @artifacts
--   column: public.estimate_areas.choice_group
--   column: public.estimate_areas.is_recommended
--   column: public.estimate_line_items.choice_group
--   column: public.estimate_line_items.is_recommended
--   column: public.estimates.choice_picked_line_id
--   column: public.estimates.choice_picked_at
--   column: public.estimates.choice_picked_by
--   column: public.estimates.choice_picked_source
--   setting: estimate_choice_heading
--   setting: estimate_choice_recommended_label
--   setting: estimate_choice_show_difference
--   setting: estimate_choice_no_pick_total_text
--   setting: estimate_choice_no_pick_sign_text
-- @end
-- ============================================================================
-- 2026-09-21 (prompt 106): estimate choice group ("Customer chooses one").
-- Author: Claude Code.
--
-- WHY: an estimate could only say "required" or "optional (additive)". Dylan
-- faked "pick A or B" with one required area plus one optional area, which
-- (1) forces an edit before the customer can sign B, and (2) STACKS the two
-- when the customer ticks the optional box (EST-102515: Border Area 2950
-- required + Entire Patio optional gave price_all_options 6400, a number that
-- can never be sold). This build adds a real either/or.
--
-- WHAT:
--   1. choice_group text (null = ordinary line) + is_recommended on BOTH line
--      tables (estimate_areas is the estimator's source of truth for area and
--      custom lines and is mirrored onto estimate_line_items at save; add-on
--      lines live only on estimate_line_items). Stored as a group KEY, not a
--      boolean, so a second group later is a UI change, not a migration; the
--      UI enforces one group per estimate today. CHECK: a line cannot be both
--      optional and a choice.
--   2. The pick lives in ONE place: estimates.choice_picked_line_id (+ at /
--      by / source). No FK on purpose: the estimator deletes and re-inserts
--      every child row with fresh ids on each save and re-points the pick in
--      the same save; readers treat a dangling id as "no pick" and the accept
--      gate refuses it. selected_by_customer / preselected are NOT mirrors of
--      the pick (they keep their optional-line meaning).
--   3. Settings (insert-only): the customer-facing copy and the difference
--      line switch, so none of this needs a code edit to tune.
--
-- No backfill (locked decision 16): existing optional-area estimates are left
-- alone; nothing gets a choice_group until a rep ticks the new checkbox, so
-- every stored price / price_all_options is numerically unchanged by this
-- migration (proved by the before/after digest in PROJECT-LOG).
-- No SECURITY DEFINER, no RLS change (the existing staff policies on the
-- three tables cover the new columns); rehearsed rolled-back on production
-- anyway. Idempotent.
-- ============================================================================

begin;

alter table public.estimate_areas
  add column if not exists choice_group text,
  add column if not exists is_recommended boolean not null default false;
alter table public.estimate_areas drop constraint if exists estimate_areas_choice_not_optional;
alter table public.estimate_areas add constraint estimate_areas_choice_not_optional
  check (not (is_optional and choice_group is not null));
alter table public.estimate_areas drop constraint if exists estimate_areas_choice_group_nonblank;
alter table public.estimate_areas add constraint estimate_areas_choice_group_nonblank
  check (choice_group is null or length(btrim(choice_group)) > 0);

alter table public.estimate_line_items
  add column if not exists choice_group text,
  add column if not exists is_recommended boolean not null default false;
alter table public.estimate_line_items drop constraint if exists estimate_line_items_choice_not_optional;
alter table public.estimate_line_items add constraint estimate_line_items_choice_not_optional
  check (not (is_optional and choice_group is not null));
alter table public.estimate_line_items drop constraint if exists estimate_line_items_choice_group_nonblank;
alter table public.estimate_line_items add constraint estimate_line_items_choice_group_nonblank
  check (choice_group is null or length(btrim(choice_group)) > 0);

alter table public.estimates
  add column if not exists choice_picked_line_id uuid,
  add column if not exists choice_picked_at timestamptz,
  add column if not exists choice_picked_by uuid,
  add column if not exists choice_picked_source text;
alter table public.estimates drop constraint if exists estimates_choice_picked_source_check;
alter table public.estimates add constraint estimates_choice_picked_source_check
  check (choice_picked_source is null or choice_picked_source in ('customer', 'staff'));

-- Settings (insert-only; an existing value is never overwritten). Customer-
-- facing copy: no em dashes.
insert into public.settings (key, value)
select k, v from (values
  ('estimate_choice_heading', 'Choose your project'),
  ('estimate_choice_recommended_label', 'Recommended'),
  ('estimate_choice_show_difference', 'true'),
  ('estimate_choice_no_pick_total_text', 'Select an option'),
  ('estimate_choice_no_pick_sign_text', 'Choose an option to sign')
) as s(k, v)
where not exists (select 1 from public.settings where settings.key = s.k);

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_name in ('estimate_areas','estimate_line_items') and column_name in ('choice_group','is_recommended');  -- 4 rows
--   select column_name from information_schema.columns
--     where table_name = 'estimates' and column_name like 'choice_picked_%';  -- 4 rows
--   select key, value from public.settings where key like 'estimate_choice_%';  -- 5 rows
--   select count(*) from public.estimate_line_items where choice_group is not null;  -- 0 (no backfill)
