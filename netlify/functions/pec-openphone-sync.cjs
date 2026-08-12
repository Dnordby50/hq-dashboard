// Scheduled sync: pull recent OpenPhone calls (and transcripts where the plan
// exposes them), match them to live leads by normalized phone (last 10
// digits), and store each as a 'call' lead_events row with the transcript in
// payload. The lead AI panel and pec-lead-ai's timeline gather read exactly
// this shape (see the 2026-07-11 migration's idx_lead_events_type note).
//
// Runs every 15 minutes on a Netlify schedule (netlify.toml); also curl-able
// for manual sweeps:
//   curl https://prescottepoxy.netlify.app/.netlify/functions/pec-openphone-sync
//
// Idempotency, two layers (mirrors the lead-intake webhook's philosophy):
//   1. Cursor: settings key 'openphone_sync_cursor' holds the newest call
//      createdAt already processed; each run asks OpenPhone for calls after
//      it (minus a 5-minute overlap so a slow-to-index call is not skipped).
//   2. Dedupe: payload openphone_call_id is checked against existing 'call'
//      events before insert, so a rewound or overlapping cursor re-inserts
//      nothing. The cursor is a fast-forward hint, the call id is the truth.
//
// KEY (corrected 2026-07-11, Cowork): this does NOT need a new env var.
// OpenPhone is now branded Quo, and the key for this exact API already lives in
// Netlify as QUO_API_KEY, where pec-send-sms.cjs uses it against the SAME base
// (api.openphone.com/v1) with the SAME raw-key Authorization header. So
// QUO_API_KEY is the primary and OPENPHONE_API_KEY is only a fallback, kept so
// a separately-scoped key can be swapped in later without a code change.
// Neither set exits 200 with a note, so the schedule stays harmless.
// Per-call try/catch like pec-auto-progress: one bad call never kills the sweep.

const { sb, json } = require('./_pec-supabase.cjs');

const OPENPHONE_API_KEY = process.env.QUO_API_KEY || process.env.OPENPHONE_API_KEY;
const CURSOR_KEY = 'openphone_sync_cursor';
const OVERLAP_MS = 5 * 60 * 1000;
const MAX_PAGES = 5; // 5 x 50 calls per sweep; the 15-minute cadence catches up

// Last 10 digits, same rule as pec-lead-intake's normPhone.
function normPhone(s) {
  const d = String(s == null ? '' : s).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : (d || null);
}

async function op(path) {
  const res = await fetch(`https://api.openphone.com/v1${path}`, {
    headers: { Authorization: OPENPHONE_API_KEY },
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`OpenPhone ${path} ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

exports.handler = async () => {
  if (!OPENPHONE_API_KEY) {
    return json(200, { ok: true, skipped: true, note: 'no QUO_API_KEY / OPENPHONE_API_KEY; sync idle' });
  }
  try {
    // Cursor (with overlap) -> createdAfter for the calls list.
    let cursorIso = null;
    const curRows = await sb('GET', `/settings?key=eq.${CURSOR_KEY}&select=value&limit=1`);
    if (curRows.length) { try { cursorIso = JSON.parse(curRows[0].value).last_synced_at || null; } catch (_) {} }
    const since = cursorIso
      ? new Date(new Date(cursorIso).getTime() - OVERLAP_MS).toISOString()
      : new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(); // first run: last 7 days

    // Live leads with phones, indexed by last-10. Newest lead wins a number
    // collision (the person most recently in play gets the call history).
    const leads = await sb('GET', '/leads?deleted_at=is.null&phone=not.is.null&select=id,phone&order=created_at.asc');
    const leadByPhone = {};
    for (const l of leads) { const p = normPhone(l.phone); if (p) leadByPhone[p] = l.id; }

    // Page through recent calls.
    const calls = [];
    let pageToken = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = `?maxResults=50&createdAfter=${encodeURIComponent(since)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const out = await op(`/calls${qs}`);
      calls.push(...(out.data || []));
      pageToken = out.nextPageToken || null;
      if (!pageToken) break;
    }
    if (!calls.length) return json(200, { ok: true, since, matched: 0, inserted: 0, note: 'no new calls' });

    // Match calls to leads by any participant number.
    const matched = [];
    for (const c of calls) {
      const nums = [c.from, c.to, ...(Array.isArray(c.participants) ? c.participants : [])]
        .map(v => (v && typeof v === 'object') ? (v.phoneNumber || v.number) : v)
        .map(normPhone).filter(Boolean);
      const leadId = nums.map(n => leadByPhone[n]).find(Boolean);
      if (leadId) matched.push({ call: c, leadId });
    }

    // Dedupe on openphone_call_id among each lead's existing 'call' events.
    let inserted = 0, skippedDup = 0;
    const failures = [];
    for (const { call, leadId } of matched) {
      try {
        const dup = await sb('GET',
          `/lead_events?lead_id=eq.${encodeURIComponent(leadId)}&event_type=eq.call&payload-%3E%3Eopenphone_call_id=eq.${encodeURIComponent(call.id)}&select=id&limit=1`);
        if (dup.length) { skippedDup++; continue; }
        // Transcript is best-effort: not every plan or call has one, and a
        // 4xx here must not lose the call event itself.
        let transcript = null;
        try {
          const tr = await op(`/call-transcripts/${encodeURIComponent(call.id)}`);
          const segs = tr && tr.data && Array.isArray(tr.data.dialogue) ? tr.data.dialogue : null;
          if (segs) transcript = segs.map(s => `${s.identifier || s.userId || 'Speaker'}: ${s.content || ''}`).join('\n');
        } catch (_) { /* no transcript on this plan/call */ }
        await sb('POST', '/lead_events', {
          lead_id: leadId,
          event_type: 'call',
          payload: {
            openphone_call_id: call.id,
            direction: call.direction || null,
            duration: call.duration || null,
            phone: normPhone(call.direction === 'outgoing' ? call.to : call.from),
            created_at_openphone: call.createdAt || null,
            transcript,
          },
        });
        inserted++;
      } catch (err) {
        failures.push({ call_id: call.id, error: err.message });
      }
    }

    // Fast-forward the cursor to the newest call seen (matched or not).
    const newest = calls.map(c => c.createdAt).filter(Boolean).sort().pop();
    if (newest) {
      const value = JSON.stringify({ last_synced_at: newest });
      if (curRows.length) await sb('PATCH', `/settings?key=eq.${CURSOR_KEY}`, { value });
      else await sb('POST', '/settings', { key: CURSOR_KEY, value });
    }

    return json(200, { ok: true, since, calls: calls.length, matched: matched.length, inserted, skippedDup, failures });
  } catch (err) {
    console.error('pec-openphone-sync failed:', err);
    // 200 with ok:false on purpose: a scheduled function's non-2xx would mark
    // the deploy's function unhealthy; the failure is queryable in logs.
    return json(200, { ok: false, error: err && err.message });
  }
};

// Heartbeat (prompt 90 Task A): stamp AFTER a successful run by wrapping the
// handler, so every ok exit path stamps (including gated no-ops: the
// SCHEDULE firing is what the monitor watches, not the feature toggle)
// without touching each return site. Best-effort by contract; a heartbeat
// failure never fails the job.
{
  const { writeHeartbeat } = require('./_pec-supabase.cjs');
  const _handler = exports.handler;
  exports.handler = async (event, context) => {
    const res = await _handler(event, context);
    try {
      if (res && res.statusCode === 200 && JSON.parse(res.body || '{}').ok === true) await writeHeartbeat('pec-openphone-sync');
    } catch (_) { /* best-effort */ }
    return res;
  };
}
