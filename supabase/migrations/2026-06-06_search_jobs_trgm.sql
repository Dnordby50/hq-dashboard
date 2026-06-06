-- ============================================================================
-- 2026-06-06: typo-tolerant job search (pg_trgm + search_jobs RPC)
-- ============================================================================
-- Adds fuzzy search over jobs by customer name, job address, and phone. The
-- dashboard search box queries this instead of just filtering visible DOM rows.
--
-- WHY an RPC and not a PostgREST .or(): searching jobs by the CUSTOMER's name
-- or phone is a filter on an EMBEDDED table (jobs -> customers). PostgREST
-- cannot filter the parent jobs rows by an embedded customers column via a
-- top-level .or(), so the cross-join fuzzy search has to live in a function.
--
-- WHY pg_trgm: trigram similarity tolerates transposed / missing letters
-- ("jonh smyth" still matches "John Smith") which a plain ILIKE cannot. The
-- function also keeps an ILIKE substring branch so exact substrings always
-- match regardless of the similarity threshold.
--
-- *** COWORK HANDOFF: run this migration in the PROD Supabase project. ***
-- Until it runs, public.search_jobs does not exist; the client detects the
-- missing-function error and falls back to client-side substring filtering of
-- the already-loaded jobs, so there is no regression. Full fuzzy search lights
-- up automatically once this function exists.
--
-- Idempotent / safe to re-run.
-- ============================================================================

-- 1. Trigram extension. On Supabase it installs into the `extensions` schema.
create extension if not exists pg_trgm;

-- 2. Immutable digits-only normalizer so we can build an expression index on it
--    (regexp_replace is immutable, so an index on it is allowed) and match a
--    typed "(555) 123" against a stored "5551234..." on both sides.
create or replace function public.phone_digits(p text)
returns text
language sql
immutable
as $$ select regexp_replace(coalesce(p, ''), '\D', '', 'g') $$;

-- 3. Trigram GIN indexes. Case is handled by indexing lower(...).
create index if not exists idx_customers_name_trgm
  on public.customers using gin (lower(name) gin_trgm_ops);
create index if not exists idx_jobs_address_trgm
  on public.jobs using gin (lower(address) gin_trgm_ops);
create index if not exists idx_customers_phone_digits_trgm
  on public.customers using gin (public.phone_digits(phone) gin_trgm_ops);

-- 4. The search RPC. SECURITY DEFINER (matches the repo's other staff RPCs and
--    lets the planner skip RLS predicates) but guarded by is_admin_staff(), so
--    it returns nothing to a non-staff caller -- the same access as the jobs
--    page. search_path pins public + extensions so the % / similarity operators
--    resolve regardless of the caller's search_path.
create or replace function public.search_jobs(q text, lim int default 20)
returns table (
  job_id        uuid,
  customer_name text,
  address       text,
  phone         text,
  status        text,
  price         numeric,
  created_at    timestamptz,
  score         real
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_q   text := lower(btrim(coalesce(q, '')));
  v_dig text := regexp_replace(coalesce(q, ''), '\D', '', 'g');
  v_lim int  := least(greatest(coalesce(lim, 20), 1), 50);
begin
  if not public.is_admin_staff() then
    raise exception 'not authorized';
  end if;
  if length(v_q) < 2 then
    return;  -- too short: return no rows
  end if;
  -- Pin the trigram threshold for the % operator so results are independent of
  -- the session default (0.3 is the pg_trgm default; lower = looser matching).
  perform set_limit(0.3);

  return query
  select
    j.id,
    c.name,
    j.address,
    c.phone,
    j.status,
    j.price,
    j.created_at,
    greatest(
      similarity(lower(c.name), v_q),
      similarity(lower(coalesce(j.address, '')), v_q),
      case when length(v_dig) >= 3
           then similarity(public.phone_digits(c.phone), v_dig) else 0 end
    )::real as score
  from public.jobs j
  join public.customers c on c.id = j.customer_id
  where j.archived_at is null
    and c.archived_at is null
    and (
         lower(c.name) % v_q                                   -- fuzzy name
      or lower(coalesce(j.address, '')) % v_q                  -- fuzzy address
      or lower(c.name) ilike '%' || v_q || '%'                 -- substring name
      or lower(coalesce(j.address, '')) ilike '%' || v_q || '%' -- substring address
      or (length(v_dig) >= 3 and public.phone_digits(c.phone) ilike '%' || v_dig || '%') -- phone
    )
  order by score desc, j.created_at desc
  limit v_lim;
end;
$$;

grant execute on function public.search_jobs(text, int) to authenticated;

-- Verify after running:
--   select extname from pg_extension where extname = 'pg_trgm';        -- 1 row
--   select proname from pg_proc where proname = 'search_jobs';         -- 1 row
--   select job_id, customer_name, score from public.search_jobs('jonh smyth', 10);
