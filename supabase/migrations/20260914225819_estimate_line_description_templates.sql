-- @artifacts
--   table: public.pec_estimate_line_templates
--   setting: estimate_line_templates_enabled
-- @end
-- Reusable description text only. Applying a template never carries pricing,
-- quantities, products, customer details or estimate identity.
begin;

create table if not exists public.pec_estimate_line_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  description text not null check (char_length(description) between 1 and 30000 and btrim(description) <> ''),
  active boolean not null default true,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.pec_estimate_line_templates enable row level security;
revoke all on table public.pec_estimate_line_templates from anon, authenticated;
grant select, insert on table public.pec_estimate_line_templates to authenticated;
grant all on table public.pec_estimate_line_templates to service_role;

drop policy if exists pec_estimate_line_templates_read on public.pec_estimate_line_templates;
create policy pec_estimate_line_templates_read on public.pec_estimate_line_templates
  for select to authenticated using (public.is_admin_staff());

-- Same create permission as the existing add-on and system catalogs.
-- No UPDATE/DELETE grants or policies: this feature creates new templates.
drop policy if exists pec_estimate_line_templates_create on public.pec_estimate_line_templates;
create policy pec_estimate_line_templates_create on public.pec_estimate_line_templates
  for insert to authenticated with check (
    public.is_admin_staff()
    and public.has_permission('can_edit_catalog')
    and created_by = (select auth.uid())
  );

insert into public.settings (key, value)
values ('estimate_line_templates_enabled', 'true')
on conflict (key) do nothing;

commit;
