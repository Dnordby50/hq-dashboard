-- @artifacts
--   column: customers.drips_enabled
-- @end
-- A staff preference, separate from consent and manual communications.
alter table public.customers add column drips_enabled boolean not null default true;
comment on column public.customers.drips_enabled is 'Allows future automatic drip sequences. Disabling stops current sequences and cancels pending/queued drip messages; enabling does not resume them.';

create or replace function topcoat_security_private.customer_drips_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.drips_enabled = false and old.drips_enabled is distinct from new.drips_enabled then
    update public.pec_drip_enrollments e
       set status = 'stopped', stop_reason = 'customer_drips_disabled',
           stopped_at = now(), updated_at = now(), next_send_at = null
     where e.status = 'active' and (
       (e.subject_type = 'lead' and exists (select 1 from public.leads l where l.id = e.subject_id and l.customer_id = new.id))
       or (e.subject_type = 'job' and exists (select 1 from public.jobs j where j.id = e.subject_id and j.customer_id = new.id)));
    -- Include completed enrollments: approval can advance the last step before a queued SMS sends.
    update public.pec_drip_sends s set status = 'skipped', error_message = 'customer_drips_disabled'
     where s.status in ('pending', 'queued') and s.blast_id is null and exists (
       select 1 from public.pec_drip_enrollments e where e.id = s.enrollment_id and (
         (e.subject_type = 'lead' and exists (select 1 from public.leads l where l.id = e.subject_id and l.customer_id = new.id))
         or (e.subject_type = 'job' and exists (select 1 from public.jobs j where j.id = e.subject_id and j.customer_id = new.id))));
  end if;
  return new;
end;
$$;
revoke all on function topcoat_security_private.customer_drips_changed() from public, anon, authenticated, service_role;
create trigger customer_drips_changed after update of drips_enabled on public.customers
for each row execute function topcoat_security_private.customer_drips_changed();

create or replace function topcoat_security_private.guard_customer_drip_enrollment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare customer uuid; enabled boolean;
begin
  if new.status <> 'active' then return new; end if;
  if new.subject_type = 'lead' then
    select l.customer_id into customer from public.leads l where l.id = new.subject_id;
  elsif new.subject_type = 'job' then
    select j.customer_id into customer from public.jobs j where j.id = new.subject_id;
  end if;
  if customer is not null then
    -- Serialize a new enrollment with a concurrent preference update.
    select c.drips_enabled into enabled from public.customers c where c.id = customer for share;
    if enabled = false then raise exception 'customer_drips_disabled' using errcode = 'P0001'; end if;
  end if;
  return new;
end;
$$;
revoke all on function topcoat_security_private.guard_customer_drip_enrollment() from public, anon, authenticated, service_role;
create trigger guard_customer_drip_enrollment before insert or update of status, subject_type, subject_id
on public.pec_drip_enrollments for each row execute function topcoat_security_private.guard_customer_drip_enrollment();
