-- @artifacts
--   column: public.estimates.companycam_project_id
--   column: public.estimates.companycam_excluded
--   column: public.estimates.companycam_photos
--   setting: companycam_estimate_photos_enabled
--   setting: companycam_customer_photos_enabled
--   setting: companycam_name_match_min_score
--   setting: companycam_max_customer_photos
-- @end
--
-- Prompt 83: CompanyCam photos on estimates. Photos were job-side only, but a
-- jobs row exists only AFTER accept; estimating happens before, often off site
-- from someone else's photos, and the customer signs a proposal that shows
-- none of them. These columns bring the linked project to the estimate.

alter table public.estimates
  add column if not exists companycam_project_id text,
  add column if not exists companycam_excluded jsonb not null default '[]'::jsonb,
  add column if not exists companycam_photos jsonb;

-- EXCLUSIONS, not inclusions, on purpose: every photo starts customer-visible
-- and the project keeps gaining photos right up to the send. An inclusion list
-- would silently drop every photo shot after the rep last opened the card; an
-- exclusion list means "everything except what I vetoed".
comment on column public.estimates.companycam_excluded is
  'CompanyCam photo ids the rep UNTICKED (customer will not see them). Exclusion list by design: new photos default to visible.';
comment on column public.estimates.companycam_project_id is
  'Linked CompanyCam project (auto-matched by customer name or hand-picked). Copied to jobs.companycam_project_id on accept, fill-if-null.';
comment on column public.estimates.companycam_photos is
  'Frozen photo snapshot written at send: [{id,url,thumb,captured_at}] in display order, live-minus-exclusions capped by companycam_max_customer_photos. The public page renders ONLY this, never a live CompanyCam call.';

insert into public.settings (key, value) values
  ('companycam_estimate_photos_enabled', 'true'),
  ('companycam_customer_photos_enabled', 'true'),
  -- 0-100 Dice bigram similarity between the estimate customer name and the
  -- project name; a single candidate scoring >= this auto-links.
  ('companycam_name_match_min_score', '80'),
  ('companycam_max_customer_photos', '24')
on conflict (key) do nothing;
