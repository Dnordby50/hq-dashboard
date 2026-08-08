-- @artifacts
--   none: data-only backfill (leads.customer_id + pec_appointments.customer_id fill-if-blank)
-- @end
-- ============================================================================
-- 2026-08-12: one-time lead -> customer backfill (prompt 71 Part A3).
-- Author: Claude Code, prompt 77 session. Applied to PROD (zdfpzmmrgotynrwkeakd)
-- via MCP in that same session on 2026-08-08.
--
-- WHY: every SalesAsk read resolves recordings by customer through BOTH keys
-- (customer_id OR the customer's lead ids), and the accept path + appointment
-- intake now write the link forward. This reaches back and links the leads
-- that already existed. Match precedence per lead, most reliable first,
-- stopping at the first hit:
--   1. exact email, case-insensitive, both non-null and non-empty
--   2. exact phone after normalizing to digits only, last 10 digits compared
--      (both sides must have >= 10 digits so short fragments cannot match)
--   3. exact name AND customers.company = 'prescott-epoxy', and ONLY when the
--      two rows' phones do not contradict each other (never match on name
--      alone when both rows have phones and the phones differ)
--
-- Ties break deterministically on customers.created_at asc. Fill-if-blank
-- only: a non-null customer_id is never overwritten, so a re-run (or a
-- manually corrected link) is never clobbered. Then propagate to
-- pec_appointments.customer_id where null via the appointment's lead.
-- Idempotent: re-running matches the same rows and writes nothing new.
-- ============================================================================

begin;

with matched as (
  select l.id as lead_id,
    coalesce(
      -- 1. exact email, case-insensitive
      (select c.id from public.customers c
        where l.email is not null and btrim(l.email) <> ''
          and c.email is not null and btrim(c.email) <> ''
          and lower(btrim(c.email)) = lower(btrim(l.email))
        order by c.created_at asc limit 1),
      -- 2. phone, digits only, last 10 compared
      (select c.id from public.customers c
        where length(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g')) >= 10
          and length(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g')) >= 10
          and right(regexp_replace(l.phone, '\D', '', 'g'), 10)
            = right(regexp_replace(c.phone, '\D', '', 'g'), 10)
        order by c.created_at asc limit 1),
      -- 3. exact name, PEC company only, phones must not contradict
      (select c.id from public.customers c
        where l.full_name is not null and btrim(l.full_name) <> ''
          and c.name is not null
          and lower(btrim(c.name)) = lower(btrim(l.full_name))
          and c.company = 'prescott-epoxy'
          and not (
            length(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g')) >= 10
            and length(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g')) >= 10
            and right(regexp_replace(l.phone, '\D', '', 'g'), 10)
              <> right(regexp_replace(c.phone, '\D', '', 'g'), 10)
          )
        order by c.created_at asc limit 1)
    ) as customer_id
  from public.leads l
  where l.customer_id is null
)
update public.leads l
set customer_id = m.customer_id
from matched m
where l.id = m.lead_id and m.customer_id is not null and l.customer_id is null;

update public.pec_appointments a
set customer_id = l.customer_id
from public.leads l
where a.lead_id = l.id and a.customer_id is null and l.customer_id is not null;

commit;

-- Verify (report the ACTUAL counts from the run in the PROJECT-LOG entry):
--   select count(*) from leads where customer_id is not null;
--   select count(*) from pec_appointments where customer_id is not null;
