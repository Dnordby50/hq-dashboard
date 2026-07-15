-- ============================================================================
-- 2026-07-15 (build 23, estimator phase 1): conservative backfill of the new
-- split customer fields from the combined columns. Author: Claude Code.
-- Idempotent, reversible, NOT applied from the build session; Cowork runs it
-- AFTER 2026-07-15_estimate_customer_fields.sql.
--
-- Principles (Dylan's locked decisions):
--   * NEVER modify customer_name or customer_address. They stay the source
--     of truth for old rows; this only populates the new split fields.
--   * Never guess company vs person: customer_company and
--     customer_is_commercial stay NULL for backfilled rows (Dylan spot-checks
--     and flips real commercial customers by editing the estimate).
--   * Only touch rows where the split fields are still NULL, so re-running is
--     a no-op and rows saved by the new estimator are never rewritten.
--
-- Name rule: first whitespace token -> customer_first_name, remainder ->
-- customer_last_name ("Mary Jo Smith" becomes "Mary" / "Jo Smith"; naive on
-- purpose, the original is untouched).
--
-- Address rule: split customer_address on commas. Part 1 -> customer_address1.
-- When there are 3+ parts and the LAST part cleanly matches "ST 12345[-6789]",
-- map last -> state + zip, second-to-last -> city, and anything between into
-- customer_address2. Otherwise city/state/zip stay NULL and the remaining
-- parts go into customer_address2 rather than being dropped: the estimator
-- recomposes customer_address from the split fields on the next save, so a
-- remainder left out of the split fields would silently vanish from the
-- composed address the first time an old estimate is edited and re-saved.
-- ============================================================================

begin;

-- ---- Names -----------------------------------------------------------------
update public.estimates
set customer_first_name = regexp_replace(btrim(customer_name), '\s.*$', ''),
    customer_last_name  = nullif(regexp_replace(btrim(customer_name), '^\S+\s*', ''), '')
where customer_name is not null
  and btrim(customer_name) <> ''
  and customer_first_name is null
  and customer_last_name is null;

-- ---- Addresses ---------------------------------------------------------------
with src as (
  select id,
         array(
           select btrim(x)
           from unnest(string_to_array(customer_address, ',')) as x
           where btrim(x) <> ''
         ) as parts
  from public.estimates
  where customer_address is not null
    and btrim(customer_address) <> ''
    and customer_address1 is null
    and customer_address2 is null
    and customer_city     is null
    and customer_state    is null
    and customer_zip      is null
),
parsed as (
  select id,
         parts,
         cardinality(parts) as n,
         parts[cardinality(parts)] as last_part,
         (cardinality(parts) >= 3
           and parts[cardinality(parts)] ~ '^[A-Za-z]{2}\s+\d{5}(-\d{4})?$') as clean_tail
  from src
  where cardinality(parts) >= 1
)
update public.estimates e
set customer_address1 = p.parts[1],
    customer_address2 = case
      when p.clean_tail then nullif(array_to_string(p.parts[2:p.n - 2], ', '), '')
      else nullif(array_to_string(p.parts[2:p.n], ', '), '')
    end,
    customer_city  = case when p.clean_tail then p.parts[p.n - 1] end,
    customer_state = case when p.clean_tail then upper(substring(p.last_part from '^[A-Za-z]{2}')) end,
    customer_zip   = case when p.clean_tail then substring(p.last_part from '\d{5}(?:-\d{4})?$') end
from parsed p
where e.id = p.id;

commit;

-- Verify (capture before/after in the log):
--   select count(*) filter (where customer_first_name is not null) as with_first,
--          count(*) filter (where customer_address1 is not null)  as with_addr1,
--          count(*) as total
--   from public.estimates;
-- Reverse (if ever needed; originals were never touched):
--   update public.estimates set customer_first_name=null, customer_last_name=null,
--     customer_address1=null, customer_address2=null, customer_city=null,
--     customer_state=null, customer_zip=null
--   where customer_company is null and customer_is_commercial is null;
