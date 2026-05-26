-- ============================================================================
-- 2026-05-25: convert public.jobs.additional_non_slip from text to boolean
-- ============================================================================
-- Dylan: "make additional non slip yes/no dropdown." Today the column is
-- text (per 2026-05-24_job_card_fields.sql), but every value collected so
-- far is effectively yes/no -- field crews don't type prose, they type the
-- word "yes" or leave it blank. Converting to boolean lines this column up
-- with coat_past_garage and stem_walls (both boolean) so the work-order
-- intake row has a consistent Yes / No / N/A shape across all three fields.
--
-- LOSSY: any free-text value that doesn't match the yes/no map below
-- collapses to NULL ("N/A"). This is intentional: rather than try to parse
-- "Add grit to ramp area only" into a boolean, drop the note and let the
-- crew re-enter it as a real boolean. If you need to preserve historical
-- notes, take a snapshot of (jobs.id, jobs.additional_non_slip) BEFORE
-- running this migration -- there's no path back once the column is recast.
--
-- Mapping:
--   trim+lower in ('yes','y','true','t','1')  -> true
--   trim+lower in ('no','n','false','f','0')  -> false
--   everything else (including non-empty notes and blanks) -> null
--
-- Idempotent: re-running on an already-boolean column is a no-op because of
-- the information_schema guard.
-- ============================================================================

begin;

do $$
declare
  current_type text;
begin
  select data_type into current_type
    from information_schema.columns
   where table_schema='public' and table_name='jobs' and column_name='additional_non_slip';

  if current_type = 'text' then
    alter table public.jobs
      alter column additional_non_slip type boolean
      using case lower(trim(additional_non_slip))
        when 'yes'   then true
        when 'y'     then true
        when 'true'  then true
        when 't'     then true
        when '1'     then true
        when 'no'    then false
        when 'n'     then false
        when 'false' then false
        when 'f'     then false
        when '0'     then false
        else null
      end;
  end if;
end$$;

commit;

-- Verify after running:
--   select data_type from information_schema.columns
--     where table_schema='public' and table_name='jobs' and column_name='additional_non_slip';
--   -- expect: boolean.
--   select additional_non_slip, count(*)
--     from public.jobs group by 1 order by 1 nulls last;
--   -- expect: counts split across true / false / null with no surprises.
