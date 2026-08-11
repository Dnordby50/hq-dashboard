-- Prompt 84 (Bug 1, locked decisions 1 + 8): a BEFORE UPDATE trigger on
-- public.estimates that refuses to move status BACKWARD along the lifecycle.
--
-- WHY a trigger and not just the code fix: the estimator's offline outbox is
-- a FIFO replay queue. A save enqueued in a driveway BEFORE a send can land
-- AFTER the send, and until prompt 84 that save carried status='draft' from
-- the open-time snapshot, clobbering a sent estimate back to draft
-- (EST-102054, Tom Bechtel, 2026-08-08: sent 13:00, re-saved 13:04, status
-- read 'draft' with sent_at intact). The estimator no longer writes status on
-- an edit, but an already-queued row or an old cached client still can; only
-- the database can refuse that write.
--
-- The rank ladder: draft(0) < sent(1) = change_requested(1) < signed(2) <
-- accepted(3) = rejected(3) = lost(3).
--   * sent <-> change_requested are the SAME rank on purpose: a re-send after
--     a change request is an existing, supported flow (markEstimateSent's
--     .in('status', ['draft','sent','change_requested']) filter depends on
--     both directions being legal).
--   * rejected / lost / accepted share the terminal rank so the existing
--     "Mark accepted" on a lost/rejected estimate (a customer changing their
--     mind) keeps working, while none of the three can fall back to
--     draft/sent without deliberate intervention.
--   * A status outside the ladder (never written by the app today) is left
--     alone rather than bricking every update against an unknown value.
-- Nothing in the app legitimately moves a sent estimate backward today; if an
-- unsend feature is ever wanted it gets built deliberately, with its own path
-- (that path starts by changing this function).
--
-- The exception message names the row, the old status, and the new one, so a
-- human reading a Supabase log six months from now knows exactly which
-- estimate was protected and from what.

-- @artifacts
--   none: creates a function (public.estimate_status_guard) and a BEFORE UPDATE trigger (trg_estimate_status_guard on public.estimates); triggers/functions are not expressible in the four artifact kinds
-- @end

create or replace function public.estimate_status_guard()
returns trigger
language plpgsql
as $$
declare
  old_rank int;
  new_rank int;
begin
  old_rank := case old.status
    when 'draft' then 0
    when 'sent' then 1
    when 'change_requested' then 1
    when 'signed' then 2
    when 'accepted' then 3
    when 'rejected' then 3
    when 'lost' then 3
    else null
  end;
  new_rank := case new.status
    when 'draft' then 0
    when 'sent' then 1
    when 'change_requested' then 1
    when 'signed' then 2
    when 'accepted' then 3
    when 'rejected' then 3
    when 'lost' then 3
    else null
  end;
  if old_rank is not null and new_rank is not null and new_rank < old_rank then
    raise exception 'estimates.status may not move backward: estimate % (EST-%) is ''%'' and cannot become ''%''. Status regressions are blocked by trg_estimate_status_guard (prompt 84); if this change is truly intended it needs its own deliberate path.',
      old.id, coalesce(old.estimate_number::text, 'unnumbered'), old.status, new.status;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_estimate_status_guard on public.estimates;
create trigger trg_estimate_status_guard
  before update of status on public.estimates
  for each row
  when (old.status is distinct from new.status)
  execute function public.estimate_status_guard();
