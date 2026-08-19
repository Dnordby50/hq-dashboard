// On-demand follow-up re-rank (prompt 98): the HTTP twin of the scheduled
// pec-followup-rank (Netlify 403s direct invocation of schedule-declared
// functions; the pec-system-heartbeat-run pattern). Two callers: the
// Follow-ups view's "Re-rank now" button (ADMIN JWT: prompt 49 locked the
// manual re-rank to admins because each press costs model calls) and
// Cowork's verification curl (x-webhook-secret). Same engine, same rules.
'use strict';

const { json, badSecret, requireStaff } = require('./_pec-supabase.cjs');
const { runFollowupRank } = require('./_pec-followup.cjs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  if (badSecret(event)) {
    const auth = await requireStaff(event, { adminOnly: true });
    if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });
  }
  try {
    const result = await runFollowupRank();
    console.log('pec-followup-rank-run:', JSON.stringify(result));
    return json(200, result);
  } catch (err) {
    console.error('pec-followup-rank-run failed:', err);
    return json(500, { ok: false, error: String(err && err.message || err) });
  }
};
