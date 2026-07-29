-- @artifacts
--   column: public.pec_prod_crews.color
-- @end
--
-- Prompt 57 Part F: the Job Schedule bars are now filled by CREW color (who is
-- where), with the system type riding along as a thin top banner. This adds
-- the crew color column and backfills the four existing crews with distinct,
-- legible defaults, keyed by name so the assignment is deterministic and
-- reviewable. All four are clearly distinguishable from each other, from the
-- callback sky blue (#0ea5e9), and hold up at small size in dark mode.
-- A crew left NULL falls back to the system color in the UI, never grey.

alter table public.pec_prod_crews add column if not exists color text;

update public.pec_prod_crews set color = '#8b5cf6' where color is null and name = 'Kyle';    -- violet
update public.pec_prod_crews set color = '#f59e0b' where color is null and name = 'Landen';  -- amber
update public.pec_prod_crews set color = '#10b981' where color is null and name = 'Davey';   -- emerald
update public.pec_prod_crews set color = '#ec4899' where color is null and name = 'Dylan';   -- pink (inactive crew today, colored anyway)

-- Verify:
--   select name, color, active from pec_prod_crews order by name;
--   -- expect: Davey #10b981, Dylan #ec4899, Kyle #8b5cf6, Landen #f59e0b
