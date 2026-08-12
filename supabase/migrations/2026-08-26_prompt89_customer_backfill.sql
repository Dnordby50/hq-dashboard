-- @artifacts
--   none: data-only backfill (no schema objects created)
-- @end
-- ============================================================================
-- 2026-08-26: customers become the source of truth (prompt 89 backfill).
-- Author: Claude Code. APPLIED to prod via MCP on 2026-08-12. Idempotent:
-- every pass filters on customer_id IS NULL, so a replay is a no-op.
--
-- WHY: every lead and appointment now hangs off a customer row (the person
-- exists ONCE). Forward paths were fixed in code the same day (pec-lead-
-- intake, pec-appt-intake createRoutemizeLead, the manual new-lead modal,
-- the appointment modal); this links what already existed.
--
-- HOW pass 2+3 work together: INSERT..SELECT cannot RETURN source-row ids,
-- so instead of tracking which created customer belongs to which lead, pass
-- 2 creates customers FROM the lead fields and pass 3 re-runs the pass-1
-- same-human match (last-10 phone via customers.phone_norm, or exact email);
-- the created rows match their own source leads by construction. Bonus: two
-- same-human leads fold onto ONE customer row instead of two.
--
-- Measured on prod (2026-08-12): 11 live unlinked leads, 0 matched existing
-- customers, 11 customers created (101 -> 112 live), 4 soft-deleted/archived
-- leads matched nothing and stayed unlinked (dead leads never get creates),
-- 8 lead-linked appointments stamped (4 -> 12 rows with customer_id).
-- ============================================================================

begin;

-- Pass 1: link any unlinked lead (live or dead) to a matching live customer.
update leads l
set customer_id = (
  select c.id from customers c
  where c.archived_at is null
    and ( (length(regexp_replace(coalesce(l.phone,''), '\D', '', 'g')) >= 10
           and c.phone_norm = right(regexp_replace(coalesce(l.phone,''), '\D', '', 'g'), 10))
       or (l.email is not null and lower(c.email) = lower(l.email)) )
  order by c.created_at desc limit 1)
where l.customer_id is null
  and exists (
    select 1 from customers c
    where c.archived_at is null
      and ( (length(regexp_replace(coalesce(l.phone,''), '\D', '', 'g')) >= 10
             and c.phone_norm = right(regexp_replace(coalesce(l.phone,''), '\D', '', 'g'), 10))
         or (l.email is not null and lower(c.email) = lower(l.email)) ));

-- Pass 2: create customer rows for LIVE unlinked leads only. A lead with
-- neither email nor a 10-digit phone is skipped (it could never re-match).
insert into customers (token, name, first_name, last_name, company_name, email, phone,
                       billing_address_line1, billing_city, billing_state, billing_zip,
                       lead_source, company)
select encode(gen_random_bytes(32), 'hex'),
       coalesce(l.full_name, l.business_name, 'Customer'),
       l.first_name, l.last_name, l.business_name, l.email, l.phone,
       l.address, l.city, l.state, l.zip, l.source,
       case when l.brand in ('FTP', 'finishing-touch') then 'finishing-touch' else 'prescott-epoxy' end
from leads l
where l.customer_id is null and l.deleted_at is null and l.archived_at is null
  and (l.email is not null or length(regexp_replace(coalesce(l.phone,''), '\D', '', 'g')) >= 10);

-- Pass 3: identical to pass 1; the pass-2 customers match their source leads.
update leads l
set customer_id = (
  select c.id from customers c
  where c.archived_at is null
    and ( (length(regexp_replace(coalesce(l.phone,''), '\D', '', 'g')) >= 10
           and c.phone_norm = right(regexp_replace(coalesce(l.phone,''), '\D', '', 'g'), 10))
       or (l.email is not null and lower(c.email) = lower(l.email)) )
  order by c.created_at desc limit 1)
where l.customer_id is null
  and exists (
    select 1 from customers c
    where c.archived_at is null
      and ( (length(regexp_replace(coalesce(l.phone,''), '\D', '', 'g')) >= 10
             and c.phone_norm = right(regexp_replace(coalesce(l.phone,''), '\D', '', 'g'), 10))
         or (l.email is not null and lower(c.email) = lower(l.email)) ));

-- Pass 4: stamp customer_id on lead-linked appointments from their lead.
update pec_appointments a
set customer_id = l.customer_id
from leads l
where a.lead_id = l.id and a.customer_id is null and l.customer_id is not null;

commit;
