-- @artifacts
--   setting: estimate_ai_enabled
--   setting: comps_min_sample
-- @end
--
-- Prompt 70: pricing intelligence knobs (rule 12), data-only.
-- estimate_ai_enabled: master switch for the AI price read (server-gated in
-- pec-estimate-ai.cjs AND client-gated in the estimator; 'false' is the only
-- value that turns it off, and the server returns a clean disabled response,
-- never an error). comps_min_sample: the ONE sample-size knob shared by the
-- comps ladder (below it the exact rule widens to same-system any-size) and
-- the per-line AI confidence flag (below it a line reads thin_sample instead
-- of comps_backed), so the panel and the flag can never disagree about what
-- "thin" means. Server and client read both keys with IDENTICAL defaults
-- (true / 3), so behavior is the same before and after this seed.

BEGIN;

INSERT INTO public.settings (key, value)
SELECT k, v FROM (VALUES
  ('estimate_ai_enabled', 'true'),
  ('comps_min_sample',    '3')
) AS seed(k, v)
WHERE NOT EXISTS (SELECT 1 FROM public.settings s WHERE s.key = seed.k);

COMMIT;

-- Verify after running:
--   select key, value from public.settings where key in ('estimate_ai_enabled','comps_min_sample') order by key;
