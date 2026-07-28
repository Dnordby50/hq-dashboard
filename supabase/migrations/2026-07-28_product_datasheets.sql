-- @artifacts
--   column: public.pec_prod_products.datasheet_path
--   column: public.pec_prod_products.msds_path
--   setting: datasheet_max_upload_mb
-- @end
-- ============================================================================
-- 2026-07-28 (prompt 53 Part B): product data sheets (TDS + MSDS/SDS PDFs).
-- Author: Claude Code. Idempotent, additive only. Written for Cowork to apply
-- (standing rule 8).
--
-- This is the app's FIRST Supabase Storage feature. The bucket and its
-- policies are created HERE, in SQL, so this file is the record of them and a
-- fresh-database replay reproduces the whole thing (the older pec-photos
-- bucket was clicked into being in Studio and its creation only survives as a
-- comment in policies.sql; not repeating that).
--
-- The columns store the storage OBJECT PATH (e.g. 'a1b2....pdf'), never a full
-- URL. The browser builds the URL at render time with
-- supabase.storage.from('pec-datasheets').getPublicUrl(path), so a file can be
-- replaced or deleted later and the public base URL is never baked into rows.
--
-- The bucket is PUBLIC by decision (Dylan, 2026-07-28): these are manufacturer
-- documents that are already public, and crew members in the field have no
-- TopCoat login, so a printed / texted public URL has to work without auth.
-- Writes are staff-only, matching the UI gate (catalog editing is behind
-- user_permissions.can_edit_catalog; the storage policy uses is_admin_staff()
-- like every other staff write, which is not looser than that UI gate since
-- only staff reach the catalog editor at all).
-- ============================================================================

BEGIN;

-- Two sheets per product, by decision: a data sheet (TDS) and an MSDS/SDS.
-- Nullable, so all 181 existing rows are untouched.
ALTER TABLE public.pec_prod_products
  ADD COLUMN IF NOT EXISTS datasheet_path text,  -- TDS, the product data sheet
  ADD COLUMN IF NOT EXISTS msds_path      text;  -- MSDS / SDS

-- The bucket. file_size_limit is bytes and mirrors the settings key below
-- (10 MB): the setting is what the UI enforces and what Dylan tunes from
-- Settings; the bucket limit is the server-side backstop. PDF only, at both
-- layers.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('pec-datasheets', 'pec-datasheets', true, 10485760, ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = 10485760,
      allowed_mime_types = ARRAY['application/pdf'];

-- Storage policies: public read (the point of a public bucket), staff-only
-- writes. Same shape as the pec_photos_* policies in policies.sql.
DROP POLICY IF EXISTS pec_datasheets_public_read ON storage.objects;
CREATE POLICY pec_datasheets_public_read ON storage.objects
  FOR SELECT USING (bucket_id = 'pec-datasheets');

DROP POLICY IF EXISTS pec_datasheets_staff_insert ON storage.objects;
CREATE POLICY pec_datasheets_staff_insert ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'pec-datasheets' AND public.is_admin_staff());

DROP POLICY IF EXISTS pec_datasheets_staff_update ON storage.objects;
CREATE POLICY pec_datasheets_staff_update ON storage.objects
  FOR UPDATE USING (bucket_id = 'pec-datasheets' AND public.is_admin_staff())
  WITH CHECK (bucket_id = 'pec-datasheets' AND public.is_admin_staff());

DROP POLICY IF EXISTS pec_datasheets_staff_delete ON storage.objects;
CREATE POLICY pec_datasheets_staff_delete ON storage.objects
  FOR DELETE USING (bucket_id = 'pec-datasheets' AND public.is_admin_staff());

-- Settings knob (standing rule 12). Idempotent: an existing value is untouched.
--   datasheet_max_upload_mb : max PDF size the upload UI accepts, in MB.
--                             The bucket's file_size_limit (10 MB) is the
--                             hard server ceiling; raising this setting above
--                             10 needs a bucket change too.
INSERT INTO public.settings (key, value) VALUES
  ('datasheet_max_upload_mb', '10')
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- Verify (run after applying):
--   select column_name from information_schema.columns
--     where table_name = 'pec_prod_products' and column_name in ('datasheet_path','msds_path');
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'pec-datasheets';
--   select policyname from pg_policies where tablename = 'objects' and policyname like 'pec_datasheets%';  -- expect 4
--   select key, value from public.settings where key = 'datasheet_max_upload_mb';
