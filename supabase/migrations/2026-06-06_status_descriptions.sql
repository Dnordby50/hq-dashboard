-- ============================================================================
-- 2026-06-06: editable per-status customer descriptions
-- ============================================================================
-- Each job status (signed / scheduled / in_progress / completed) should show
-- the customer a short plain-English description of what is happening, and that
-- text must be editable by staff in Settings so it can change later without a
-- code deploy. Store one row per (brand, status). The portal reads it directly
-- as anon (select-all, like public.colors); staff edit it from Settings
-- (authenticated write, like pec_brand_identity).
--
-- Tokens: body_text may contain {scheduled_date}, which the portal renderer
-- replaces with the job's install date (falls back gracefully when unscheduled).

begin;

create table if not exists public.pec_status_descriptions (
  brand      text not null default 'prescott-epoxy',
  status     text not null check (status in ('signed','scheduled','in_progress','completed')),
  body_text  text not null default '',
  updated_at timestamptz not null default now(),
  primary key (brand, status)
);

alter table public.pec_status_descriptions enable row level security;
-- Anon (the customer portal) may READ; staff may write. Mirrors public.colors.
drop policy if exists pec_status_descriptions_select_all on public.pec_status_descriptions;
create policy pec_status_descriptions_select_all on public.pec_status_descriptions for select using (true);
drop policy if exists pec_status_descriptions_staff_write on public.pec_status_descriptions;
create policy pec_status_descriptions_staff_write on public.pec_status_descriptions for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());
grant select on public.pec_status_descriptions to anon, authenticated;
grant insert, update on public.pec_status_descriptions to authenticated;

-- Seed sensible defaults (only if missing; never clobber edited text on re-run).
insert into public.pec_status_descriptions (brand, status, body_text) values
  ('prescott-epoxy', 'signed',
    'Thanks for choosing us! Your project is signed and in our queue. We will reach out soon to schedule your install date.'),
  ('prescott-epoxy', 'scheduled',
    'Your job is scheduled for {scheduled_date}. We will contact you the week before to confirm the date, and the day before to confirm the time.'),
  ('prescott-epoxy', 'in_progress',
    'Our crew is on the job. We will keep you posted and let you know as soon as the work is complete.'),
  ('prescott-epoxy', 'completed',
    'Your project is complete. Thank you for your business! If you have a moment, we would really appreciate a review.')
on conflict (brand, status) do nothing;

commit;

-- Verify after running:
--   select status, left(body_text, 40) from public.pec_status_descriptions order by status;  -- 4 rows
