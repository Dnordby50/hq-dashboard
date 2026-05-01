-- PEC system types Dylan offers, seeded into pec_prod_system_types.
-- Idempotent: safe to re-run. Only adds rows; never overwrites edits Dylan
-- has made via the Material Catalog admin UI (uses ON CONFLICT (name) DO NOTHING).
-- Run after supabase/migrations/2026-04-28_pm_ordering.sql.
--
-- Recipe slots are intentionally NOT seeded here. Configure each system's
-- materials (basecoat, flake/quartz, topcoat, sealer, etc.) in the Material
-- Catalog tab, "System Types" subnav, after running this seed.
--
-- requires_flake_color / requires_basecoat_color drive whether the New Job
-- form shows the flake-color and basecoat-color pickers when this system is
-- selected. Conservative defaults below; toggle via admin UI as needed.

insert into public.pec_prod_system_types
  (name, description, requires_flake_color, requires_basecoat_color, active, notes)
values
  ('Flake',
   'Tinted basecoat, broadcast decorative flake, polyaspartic topcoat.',
   true, true, true,
   'Configure recipe slots in System Catalog. Customer picks flake color per job.'),
  ('Quartz',
   'Tinted basecoat, broadcast quartz aggregate, polyaspartic topcoat.',
   false, true, true,
   'Quartz aggregate replaces flake. Customer typically picks the basecoat color shade through the quartz.'),
  ('Metallic',
   'Metallic pigment dispersed in basecoat, polyaspartic topcoat.',
   false, false, true,
   'Pigment color set per job, not via flake/basecoat pickers. Configure recipe slots accordingly.'),
  ('Grind and Seal',
   'Mechanical grind followed by clear penetrating or topical sealer.',
   false, false, true,
   'No basecoat or flake. Single material slot for the sealer.'),
  ('Grind Stain and Seal',
   'Mechanical grind, acid or water-based concrete stain, clear sealer.',
   false, false, true,
   'Stain color picked per job. Configure stain + sealer slots in System Catalog.')
on conflict (name) do nothing;
