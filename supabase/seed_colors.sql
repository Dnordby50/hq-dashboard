-- Simiron flake palette (epoxy only — other libraries like Sherwin-Williams come later).
-- Simiron ships the 1/4″ chip by default; the SKU below is the 1/4″ product code.
-- Hex values are visual approximations for swatch rendering; real product photos
-- can be uploaded later via swatch_image.

insert into public.colors (name, type, category, hex, sku) values
  ('Autumn Brown', 'simiron', 'flake-blend', '#8B5A3C', '40001056'),
  ('Cabin Fever',  'simiron', 'flake-blend', '#5E4A3E', '40005924'),
  ('Coyote',       'simiron', 'flake-blend', '#8B7355', '40007041'),
  ('Creekbed',     'simiron', 'flake-blend', '#6B5E4F', '40005955'),
  ('Domino',       'simiron', 'flake-blend', '#3D3D3D', '40007447'),
  ('Feather Gray', 'simiron', 'flake-blend', '#B8B8B8', '40007102'),
  ('Glacier',      'simiron', 'flake-blend', '#8BA7B8', '40000967'),
  ('Gravel',       'simiron', 'flake-blend', '#7A7A72', '40005986'),
  ('Nightfall',    'simiron', 'flake-blend', '#2C3E50', '40006105'),
  ('Orbit',        'simiron', 'flake-blend', '#42454D', '40006679'),
  ('Outback',      'simiron', 'flake-blend', '#A0764A', '40005894'),
  ('Safari',       'simiron', 'flake-blend', '#8F7E5C', '40006136'),
  ('Shoreline',    'simiron', 'flake-blend', '#7FA5BA', '40005863'),
  ('Stargazer',    'simiron', 'flake-blend', '#2F3545', '40007331'),
  ('Tidal Wave',   'simiron', 'flake-blend', '#5A7A93', '40007430')
on conflict do nothing;
