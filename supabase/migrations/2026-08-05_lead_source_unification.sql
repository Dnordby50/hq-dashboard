-- @artifacts
--   column: public.pec_lead_sources.aliases
-- @end
-- Not expressible as artifact kinds (hand-verify with the queries at the
-- bottom): the alias seed rows, the six new managed rows, and the
-- leads.source / customers.lead_source data rewrite are data-only changes.
-- ============================================================================
-- 2026-08-05: lead source unification (prompt 61 Part D)
-- ============================================================================
-- ONE managed list (pec_lead_sources) now drives BOTH leads.source and
-- customers.lead_source. Before this, leads.source held feed code tokens
-- ('meta', 'webform', ...) while customers.lead_source held managed names
-- ('Facebook', 'Website'): two vocabularies for one concept.
--
-- aliases[] is what makes a future feed a DATA change instead of a code
-- change (rule 12): intake resolves a raw token against name (exact, then
-- case-insensitive) then aliases, and the Settings lead-source editor edits
-- the alias list. Tokens with no obvious managed counterpart got their OWN
-- new rows (Google LSA, Manual entry, Word of Mouth, Angi, Phone Call,
-- DripJobs), never a silently merged bucket.
--
-- Rewrite rule (landmine 12): rows matching a name or alias
-- case-insensitively become the canonical name; rows matching NOTHING are
-- LEFT ALONE (attribution is never nulled or guessed).
--
-- Live inventory at write time (2026-07-31): leads had meta x3, google x2,
-- manual, other, Other, webform, word_of_mouth (10 rows, all mappable);
-- customers already used exact managed names (36 rows) or null (55, left
-- alone). Expected rewrite: 9 lead rows (the 'Other' row is already
-- canonical), 0 customer rows.
--
-- Idempotent / safe to re-run (adds guard on existence, appends guard on
-- membership, rewrite guards on inequality).
-- ============================================================================

begin;

-- 1. The alias vocabulary ----------------------------------------------------
alter table public.pec_lead_sources
  add column if not exists aliases text[] not null default '{}';

-- 2. New managed rows for tokens with no counterpart --------------------------
insert into public.pec_lead_sources (name, active, aliases)
select v.name, true, v.aliases from (values
  ('Google LSA',    array['google_lsa']),
  ('Manual entry',  array['manual']),
  ('Word of Mouth', array['word_of_mouth']),
  ('Angi',          array['angi']),
  ('Phone Call',    array['openphone']),
  ('DripJobs',      array['dripjobs'])
) as v(name, aliases)
where not exists (select 1 from public.pec_lead_sources p where lower(p.name) = lower(v.name));

-- 3. Aliases on existing rows -------------------------------------------------
update public.pec_lead_sources set aliases = aliases || '{meta}'
  where lower(name) = 'facebook' and not ('meta' = any(aliases));
update public.pec_lead_sources set aliases = aliases || '{webform}'
  where lower(name) = 'website' and not ('webform' = any(aliases));

-- 4. Rewrite the stored data to canonical names -------------------------------
update public.leads l
   set source = p.name
  from public.pec_lead_sources p
 where l.source is not null
   and l.source <> p.name
   and (lower(l.source) = lower(p.name)
        or lower(l.source) in (select lower(a) from unnest(p.aliases) a));

update public.customers c
   set lead_source = p.name
  from public.pec_lead_sources p
 where c.lead_source is not null
   and c.lead_source <> p.name
   and (lower(c.lead_source) = lower(p.name)
        or lower(c.lead_source) in (select lower(a) from unnest(p.aliases) a));

commit;

-- Verify after running:
--   select name, active, aliases from public.pec_lead_sources order by name;
--       -- 25 rows; the six new ones present with their aliases
--   select coalesce(source,'(null)') s, count(*) from public.leads
--    where deleted_at is null group by 1 order by 2 desc;
--       -- every value a managed NAME (or an explicitly unmapped leftover)
--   select coalesce(lead_source,'(null)') s, count(*) from public.customers
--    group by 1 order by 2 desc;
--       -- unchanged except case-normalization; nulls untouched
