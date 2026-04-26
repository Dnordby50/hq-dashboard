-- RLS policies and token-scoped RPC functions for the Prescott portal.
-- Run AFTER schema.sql.

-- Helper: is the current authenticated user an admin staff member?
create or replace function public.is_admin_staff()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.admin_users
    where auth_user_id = auth.uid()
  );
$$;

-- Helper: is the current authenticated user specifically in the `admin` role?
create or replace function public.is_admin_role()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.admin_users
    where auth_user_id = auth.uid() and role = 'admin'
  );
$$;

-- Enable RLS on everything
alter table public.admin_users       enable row level security;
alter table public.customers         enable row level security;
alter table public.colors            enable row level security;
alter table public.jobs              enable row level security;
alter table public.job_colors        enable row level security;
alter table public.timeline_stages   enable row level security;
alter table public.photos            enable row level security;
alter table public.referrals         enable row level security;
alter table public.reviews           enable row level security;
alter table public.settings          enable row level security;
alter table public.audit_log         enable row level security;
alter table public.sign_in_log       enable row level security;

-- admin_users: staff can read all rows, only `admin` can write
drop policy if exists admin_users_select on public.admin_users;
create policy admin_users_select on public.admin_users
  for select using (public.is_admin_staff());
drop policy if exists admin_users_modify on public.admin_users;
create policy admin_users_modify on public.admin_users
  for all using (public.is_admin_role()) with check (public.is_admin_role());

-- customers / jobs / related: staff full access; anon access via RPC (security definer) only
drop policy if exists customers_staff on public.customers;
create policy customers_staff on public.customers for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists colors_select_all on public.colors;
create policy colors_select_all on public.colors for select using (true);
drop policy if exists colors_staff_write on public.colors;
create policy colors_staff_write on public.colors for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists jobs_staff on public.jobs;
create policy jobs_staff on public.jobs for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists job_colors_staff on public.job_colors;
create policy job_colors_staff on public.job_colors for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists timeline_staff on public.timeline_stages;
create policy timeline_staff on public.timeline_stages for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists photos_staff on public.photos;
create policy photos_staff on public.photos for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists referrals_staff on public.referrals;
create policy referrals_staff on public.referrals for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists reviews_staff on public.reviews;
create policy reviews_staff on public.reviews for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists settings_staff on public.settings;
create policy settings_staff on public.settings for all
  using (public.is_admin_staff()) with check (public.is_admin_role());

drop policy if exists audit_staff on public.audit_log;
create policy audit_staff on public.audit_log for select using (public.is_admin_role());

-- sign_in_log: admin role can view; writes happen via service role (Netlify Function)
drop policy if exists sign_in_log_admin_select on public.sign_in_log;
create policy sign_in_log_admin_select on public.sign_in_log for select using (public.is_admin_role());

-- ============================================================================
-- Public token-scoped RPCs (callable with anon key; use SECURITY DEFINER to
-- sidestep RLS in a tightly-scoped way)
-- ============================================================================

-- Fetch the full portal bundle for a given customer token.
create or replace function public.get_portal_data(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_customer public.customers%rowtype;
  v_jobs jsonb;
  v_referral_reward text;
begin
  select * into v_customer from public.customers where token = p_token and archived_at is null;
  if v_customer.id is null then
    return null;
  end if;

  select value into v_referral_reward from public.settings where key = 'referral_reward_amount';

  select coalesce(jsonb_agg(row_to_json(j)::jsonb order by j.created_at desc), '[]'::jsonb) into v_jobs
  from (
    select
      j.*,
      (select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.sort_order), '[]'::jsonb)
         from public.timeline_stages t where t.job_id = j.id) as timeline,
      (select coalesce(jsonb_agg(jsonb_build_object(
                'id', jc.id, 'label', jc.label, 'name', c.name, 'type', c.type,
                'hex', c.hex, 'sku', c.sku, 'swatch_image', c.swatch_image)), '[]'::jsonb)
         from public.job_colors jc join public.colors c on jc.color_id = c.id
         where jc.job_id = j.id) as colors,
      (select coalesce(jsonb_agg(row_to_json(p)::jsonb order by p.created_at desc), '[]'::jsonb)
         from public.photos p where p.job_id = j.id) as photos,
      (select row_to_json(r)::jsonb from public.reviews r where r.job_id = j.id limit 1) as review
    from public.jobs j
    where j.customer_id = v_customer.id and j.archived_at is null
  ) j;

  return jsonb_build_object(
    'customer', row_to_json(v_customer)::jsonb,
    'jobs', v_jobs,
    'referral_reward_amount', coalesce(v_referral_reward, '50')
  );
end
$$;

grant execute on function public.get_portal_data(text) to anon, authenticated;

-- Confirm a job (signature + colors) from the customer portal.
create or replace function public.portal_confirm_job(
  p_token text,
  p_job_id uuid,
  p_signature text,
  p_colors jsonb           -- array of { color_id: uuid, label: text }
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
  v_job public.jobs%rowtype;
  r jsonb;
begin
  select id into v_customer_id from public.customers where token = p_token and archived_at is null;
  if v_customer_id is null then raise exception 'Invalid token'; end if;
  select * into v_job from public.jobs where id = p_job_id and customer_id = v_customer_id;
  if v_job.id is null then raise exception 'Job not found'; end if;

  update public.jobs
     set confirmed = true, signature_data = p_signature, confirmed_at = now()
   where id = p_job_id;

  if p_colors is not null then
    delete from public.job_colors where job_id = p_job_id;
    for r in select * from jsonb_array_elements(p_colors) loop
      insert into public.job_colors (job_id, color_id, label)
        values (p_job_id, (r->>'color_id')::uuid, r->>'label');
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'job_id', p_job_id);
end
$$;

grant execute on function public.portal_confirm_job(text, uuid, text, jsonb) to anon, authenticated;

-- Submit a referral from the customer portal.
create or replace function public.portal_submit_referral(
  p_token text,
  p_friend_name text,
  p_friend_phone text,
  p_friend_email text,
  p_service_interest text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
  v_id uuid;
begin
  select id into v_customer_id from public.customers where token = p_token and archived_at is null;
  if v_customer_id is null then raise exception 'Invalid token'; end if;

  insert into public.referrals (customer_id, friend_name, friend_phone, friend_email, service_interest)
    values (v_customer_id, p_friend_name, p_friend_phone, p_friend_email, p_service_interest)
    returning id into v_id;

  return jsonb_build_object('ok', true, 'referral_id', v_id);
end
$$;

grant execute on function public.portal_submit_referral(text, text, text, text, text) to anon, authenticated;

-- Submit a review from the customer portal.
create or replace function public.portal_submit_review(
  p_token text,
  p_job_id uuid,
  p_rating int,
  p_feedback text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
  v_id uuid;
begin
  select id into v_customer_id from public.customers where token = p_token and archived_at is null;
  if v_customer_id is null then raise exception 'Invalid token'; end if;

  if not exists (select 1 from public.jobs where id = p_job_id and customer_id = v_customer_id) then
    raise exception 'Job not found';
  end if;
  if p_rating < 1 or p_rating > 5 then
    raise exception 'Rating must be 1-5';
  end if;

  insert into public.reviews (job_id, customer_id, rating, feedback)
    values (p_job_id, v_customer_id, p_rating, p_feedback)
    returning id into v_id;

  return jsonb_build_object('ok', true, 'review_id', v_id);
end
$$;

grant execute on function public.portal_submit_review(text, uuid, int, text) to anon, authenticated;

-- ============================================================================
-- Storage policy for the pec-photos bucket (run AFTER creating the bucket in UI).
-- Public read; only staff can write.
-- ============================================================================
-- insert into storage.buckets (id, name, public) values ('pec-photos', 'pec-photos', true)
--   on conflict (id) do update set public = true;

drop policy if exists pec_photos_public_read on storage.objects;
create policy pec_photos_public_read on storage.objects
  for select using (bucket_id = 'pec-photos');

drop policy if exists pec_photos_staff_write on storage.objects;
create policy pec_photos_staff_write on storage.objects
  for insert with check (bucket_id = 'pec-photos' and public.is_admin_staff());

drop policy if exists pec_photos_staff_delete on storage.objects;
create policy pec_photos_staff_delete on storage.objects
  for delete using (bucket_id = 'pec-photos' and public.is_admin_staff());
