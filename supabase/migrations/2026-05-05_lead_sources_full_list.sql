-- 2026-05-05: bring lead-source list into alignment with the DripJobs export
-- the user is migrating from. Adds 10 new sources, deactivates two that the
-- user no longer uses (Door Hanger, Truck Lettering). Idempotent.
--
-- Also forces PostgREST to reload its schema cache. After the prior
-- 2026-05-04_customer_fields.sql migration created pec_lead_sources, the
-- Supabase API may have been returning "Could not find the table
-- 'pec_lead_sources' in the schema cache" until the auto-reload kicked in.
-- The NOTIFY at the end of this file makes the reload happen now.

begin;

-- ============================================================================
-- 1) Add the lead sources from the DripJobs export that aren't already seeded.
--    The Tags/Sources shown in DripJobs: Google, Facebook, Yard Sign, Repeat
--    Customer, Website, Instagram, Mail, Other, Home Show, Referral,
--    Magazine AD, Walk In, Parade, Google PPC, Home Show 2025, Saw our truck,
--    Postcard Mailer.
-- ============================================================================
insert into public.pec_lead_sources (name) values
  ('Website'),
  ('Instagram'),
  ('Mail'),
  ('Magazine AD'),
  ('Walk In'),
  ('Parade'),
  ('Google PPC'),
  ('Home Show 2025'),
  ('Saw our truck'),
  ('Postcard Mailer')
on conflict (name) do nothing;

-- ============================================================================
-- 2) Deactivate the two values from the original seed that aren't in the
--    user's actual workflow. Not deleted so historical customers tagged with
--    these stay tagged; just hidden from the picker (which filters active=true).
-- ============================================================================
update public.pec_lead_sources
   set active = false
 where name in ('Door Hanger', 'Truck Lettering');

commit;

-- Force PostgREST to refresh its in-memory schema cache so the
-- /rest/v1/pec_lead_sources endpoint starts answering immediately. Run this
-- separately from the transaction (NOTIFY in a transaction is queued and only
-- delivered on commit, but Supabase's cache reload can also race with that).
notify pgrst, 'reload schema';

-- Verify after running:
--   select name, active from public.pec_lead_sources order by active desc, name;
--   -- expect 17 active rows matching the screenshot, plus 2 inactive
--   --   (Door Hanger, Truck Lettering).
