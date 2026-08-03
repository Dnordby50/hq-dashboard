-- @artifacts
--   table: public.pec_presentation_sections
--   index: idx_pec_presentation_brand_order
--   setting: presentation_reviews_count
--   setting: presentation_reviews_min_rating
-- @end
-- Not expressible as artifact kinds (hand-verify after applying):
--   - storage bucket 'pec-presentation' (storage.buckets row, public, 5 MB, images only)
--   - four storage.objects policies pec_presentation_* (public read, staff write)
--   - RLS policy pec_presentation_staff on the new table

-- Prompt 64: on-site presentation view (SumoQuote-style literature).
--
-- One content store, two consumers: the dashboard's Present mode and the
-- public estimate page (pec-public-estimate.cjs) both read these rows, so the
-- story the rep tells in the driveway is the same one the spouse reads at the
-- kitchen table. There is deliberately NO per-estimate storage: all active
-- sections show for the estimate's brand, in sort order, and the rep skips
-- live. brand is REQUIRED and CHECKed (the landmine: a section without a
-- brand, or a silent fallback, shows a homeowner the wrong company's
-- warranty). Keys match pec_brand_identity.brand ('prescott-epoxy' /
-- 'finishing-touch'), the same long-form keys loadBrand() resolves;
-- estimates.brand short forms (PEC/FTP) are mapped at read time.
--
-- images is a jsonb array of storage paths inside the public
-- 'pec-presentation' bucket (uploads are resized client-side in Settings
-- before upload; the bucket's 5 MB limit is only the server-side backstop).

CREATE TABLE IF NOT EXISTS public.pec_presentation_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand text NOT NULL CHECK (brand IN ('prescott-epoxy', 'finishing-touch')),
  kind text NOT NULL CHECK (kind IN ('why_us', 'process', 'gallery', 'financing')),
  title text NOT NULL,
  body text,
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pec_presentation_brand_order
  ON public.pec_presentation_sections (brand, active, sort_order);

ALTER TABLE public.pec_presentation_sections ENABLE ROW LEVEL SECURITY;

-- Staff-wide read/write, same shape as the other pec_* content tables. The
-- public page reads through the service role (Netlify function), not RLS.
DROP POLICY IF EXISTS pec_presentation_staff ON public.pec_presentation_sections;
CREATE POLICY pec_presentation_staff ON public.pec_presentation_sections
  FOR ALL USING (public.is_admin_staff()) WITH CHECK (public.is_admin_staff());

-- Curated presentation photos. Public bucket (the estimate page shows them to
-- customers without auth), staff-only writes; images only, 5 MB backstop
-- (Settings resizes to ~1600 px JPEG before upload, so real files are far
-- smaller; this only stops a raw-camera-file bypass).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('pec-presentation', 'pec-presentation', true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = 5242880,
      allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

DROP POLICY IF EXISTS pec_presentation_public_read ON storage.objects;
CREATE POLICY pec_presentation_public_read ON storage.objects
  FOR SELECT USING (bucket_id = 'pec-presentation');

DROP POLICY IF EXISTS pec_presentation_staff_insert ON storage.objects;
CREATE POLICY pec_presentation_staff_insert ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'pec-presentation' AND public.is_admin_staff());

DROP POLICY IF EXISTS pec_presentation_staff_update ON storage.objects;
CREATE POLICY pec_presentation_staff_update ON storage.objects
  FOR UPDATE USING (bucket_id = 'pec-presentation' AND public.is_admin_staff())
  WITH CHECK (bucket_id = 'pec-presentation' AND public.is_admin_staff());

DROP POLICY IF EXISTS pec_presentation_staff_delete ON storage.objects;
CREATE POLICY pec_presentation_staff_delete ON storage.objects
  FOR DELETE USING (bucket_id = 'pec-presentation' AND public.is_admin_staff());

-- Settings knobs (standing rule 12): how many recent reviews the gallery
-- section shows, and the minimum star rating that qualifies. Values are
-- Settings-tunable, never constants. Idempotent seeds; existing values win.
INSERT INTO public.settings (key, value)
SELECT 'presentation_reviews_count', '3'
WHERE NOT EXISTS (SELECT 1 FROM public.settings WHERE key = 'presentation_reviews_count');

INSERT INTO public.settings (key, value)
SELECT 'presentation_reviews_min_rating', '4'
WHERE NOT EXISTS (SELECT 1 FROM public.settings WHERE key = 'presentation_reviews_min_rating');
