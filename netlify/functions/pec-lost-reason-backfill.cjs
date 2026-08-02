// Nightly lost-reason backfill (prompt 62 Part G item 4): for leads already
// marked lost with NO reason yet, find their most recent pec_call_log row and
// fill lost_reason (one of the six fixed values, via the same keyword
// classifier the Mark-lost modal uses) plus lost_notes (the call summary's
// first line).
//
// HOW IT STAYS SAFE:
//   - It can NEVER overwrite a human value: the query only selects leads with
//     lost_reason IS NULL, and the PATCH itself re-asserts &lost_reason=is.null
//     so a human save landing between read and write wins.
//   - lost_notes is only written when it is also still null.
//   - Every fill writes a 'lost_reason_ai' lead_events row (the provenance
//     tag the lead timeline renders), so an AI-written value is always
//     tellable from a typed one.
//   - pec_call_log links to CUSTOMERS, not leads: matching goes through
//     leads.customer_id first, then last-10 phone digits against
//     from_number / to_number (both sides normalized the same way phone_norm
//     is). No match = no write.
//
// Gated by the settings key lost_reason_ai_backfill_enabled (missing or
// 'true' = on; 'false' = a logged no-op), per standing rule 12. Also callable
// on demand:
//   curl https://prescottepoxy.netlify.app/.netlify/functions/pec-lost-reason-backfill

const { sb, json } = require('./_pec-supabase.cjs');
const { normPhone } = require('./_pec-lead-match.cjs');

const REASONS = ['Price', 'Went with competitor', 'Timing / not ready', 'No response', 'Not a fit', 'Other'];

// Mirrors suggestLostReason in index.html; keep the two in sync.
function suggestLostReason(text) {
  const t = String(text || '').toLowerCase();
  if (/(price|expensive|cost|budget|afford|cheaper|too much|lower (bid|quote))/.test(t)) return 'Price';
  if (/(competitor|another company|other company|someone else|went with|hired (another|someone))/.test(t)) return 'Went with competitor';
  if (/(not ready|later|next year|next spring|timing|postpon|hold off|delay|push(ed)? (it|back))/.test(t)) return 'Timing / not ready';
  if (/(no answer|no response|voicemail|left a message|didn'?t (pick up|answer|respond|call back)|unreachable|never heard)/.test(t)) return 'No response';
  if (/(not a fit|out of (our |the )?(area|service)|too (small|far)|don'?t (do|offer|service)|wrong (kind|type))/.test(t)) return 'Not a fit';
  return 'Other';
}

// Prefer the stored summary; only read the transcript when the summary is
// empty (prompt 62 Part G item 5). Transcript is jsonb: an array of turns, or
// an object with a dialogue array, depending on the Quo payload era.
function callText(call) {
  const summary = String(call.summary || '').trim();
  if (summary) return summary;
  try {
    const t = call.transcript;
    const parts = Array.isArray(t) ? t : (t && Array.isArray(t.dialogue) ? t.dialogue : []);
    return parts.map(p => (p && (p.content || p.text)) || '').filter(Boolean).join(' ').slice(0, 400);
  } catch (_) { return ''; }
}

exports.handler = async () => {
  try {
    // Master switch (rule 12): missing row = on, so the feature works before
    // anyone visits Settings; 'false' = off.
    try {
      const rows = await sb('GET', '/settings?key=eq.lost_reason_ai_backfill_enabled&select=value&limit=1');
      if (Array.isArray(rows) && rows[0] && rows[0].value === 'false') {
        return json(200, { ok: true, skipped: 'lost_reason_ai_backfill_enabled is false' });
      }
    } catch (_) { /* settings read failure: default on */ }

    const leads = await sb('GET',
      '/leads?stage=eq.lost&lost_reason=is.null&deleted_at=is.null&select=id,customer_id,phone,phone_norm,lost_notes&limit=200');
    if (!Array.isArray(leads) || !leads.length) {
      return json(200, { ok: true, filled: 0, note: 'no lost leads missing a reason' });
    }

    let filled = 0, unmatched = 0;
    for (const lead of leads) {
      let call = null;
      if (lead.customer_id) {
        const r = await sb('GET',
          `/pec_call_log?customer_id=eq.${encodeURIComponent(lead.customer_id)}&select=quo_call_id,summary,transcript,occurred_at&order=occurred_at.desc&limit=1`);
        call = (Array.isArray(r) && r[0]) || null;
      }
      const tail = lead.phone_norm || normPhone(lead.phone);
      if (!call && tail) {
        const r = await sb('GET',
          `/pec_call_log?or=(from_number.ilike.*${tail},to_number.ilike.*${tail})&select=quo_call_id,summary,transcript,occurred_at&order=occurred_at.desc&limit=1`);
        call = (Array.isArray(r) && r[0]) || null;
      }
      if (!call) { unmatched++; continue; }
      const text = callText(call);
      if (!text) { unmatched++; continue; }

      const reason = suggestLostReason(text);
      if (!REASONS.includes(reason)) continue; // cannot happen; belt + suspenders
      const notes = text.split(/(?<=[.!?])\s+/)[0].slice(0, 200);
      const patch = { lost_reason: reason };
      if (!lead.lost_notes) patch.lost_notes = notes;

      // The is.null re-assert makes this write lose to any concurrent human
      // save; an empty PATCH result means exactly that, and we skip the event.
      const updated = await sb('PATCH',
        `/leads?id=eq.${encodeURIComponent(lead.id)}&lost_reason=is.null`, patch, true);
      if (!Array.isArray(updated) || !updated.length) continue;

      await sb('POST', '/lead_events', {
        lead_id: lead.id,
        event_type: 'lost_reason_ai',
        payload: {
          lost_reason: reason,
          lost_notes: patch.lost_notes || null,
          source: 'nightly_backfill',
          quo_call_id: call.quo_call_id || null,
          call_at: call.occurred_at || null,
        },
      }).catch(e => console.warn('pec-lost-reason-backfill: event insert failed (non-fatal):', e && e.message));
      filled++;
    }

    return json(200, { ok: true, scanned: leads.length, filled, unmatched });
  } catch (err) {
    console.error('pec-lost-reason-backfill failed:', err);
    return json(500, { ok: false, error: String(err && err.message || err) });
  }
};
