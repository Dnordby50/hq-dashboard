-- @artifacts
--   setting: estimate_warranty_pdf_path
-- @end
-- ============================================================================
-- 2026-09-19: warranty PDF on customer estimates (Dylan, 2026-08-26: "I want
-- to have our warranty attached towards the bottom of the quote... uploaded
-- to the Settings, and then it would pull from there"; he chose a PDF upload
-- over the prompt-93 typed sections, matching how DripJobs attached it).
-- Author: Claude Code. Direct to prod per rule 14: a new storage bucket, its
-- policies, and one settings seed; no money/auth/estimates.status. The bucket
-- and storage policies are not expressible in @artifacts' four kinds (the
-- datasheets migration set that precedent).
--
-- WHY a NEW bucket (pec-docs) instead of reusing pec-datasheets: datasheets
-- are per-product technical documents with their own lifecycle and cleanup
-- code; company documents (warranty today; insurance cert or license
-- tomorrow) should not share it. Public read because the customer estimate
-- page embeds the PDF without auth; staff-only writes; PDF-only, 10 MB.
--
-- WHY a settings key for the path (estimate_warranty_pdf_path): one document,
-- tunable with no deploy (rule 12), stored as the object PATH never a URL
-- (the datasheets convention). Unsuffixed = PEC per house convention; a
-- future FTP document becomes estimate_warranty_pdf_path_ftp.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pec-docs', 'pec-docs', true, 10485760, array['application/pdf'])
on conflict (id) do update
  set public = true,
      file_size_limit = 10485760,
      allowed_mime_types = array['application/pdf'];

drop policy if exists pec_docs_public_read on storage.objects;
create policy pec_docs_public_read on storage.objects
  for select using (bucket_id = 'pec-docs');

drop policy if exists pec_docs_staff_insert on storage.objects;
create policy pec_docs_staff_insert on storage.objects
  for insert with check (bucket_id = 'pec-docs' and public.is_admin_staff());

drop policy if exists pec_docs_staff_update on storage.objects;
create policy pec_docs_staff_update on storage.objects
  for update using (bucket_id = 'pec-docs' and public.is_admin_staff())
  with check (bucket_id = 'pec-docs' and public.is_admin_staff());

drop policy if exists pec_docs_staff_delete on storage.objects;
create policy pec_docs_staff_delete on storage.objects
  for delete using (bucket_id = 'pec-docs' and public.is_admin_staff());

insert into public.settings (key, value)
values ('estimate_warranty_pdf_path', '')
on conflict (key) do nothing;

-- Verify after applying:
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'pec-docs';
--   select policyname from pg_policies where tablename = 'objects' and policyname like 'pec_docs%';  -- expect 4
--   select key, value from public.settings where key = 'estimate_warranty_pdf_path';
