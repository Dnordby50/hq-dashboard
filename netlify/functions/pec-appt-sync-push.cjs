// TopCoat -> Google push, HTTP endpoint (prompt 37, Phase B; core extracted
// to _pec-appt-push.cjs in prompt 88 so pec-appt-intake can push without
// HTTP self-invocation). The dashboard kicks this (staff JWT, best-effort,
// fire-and-forget) after every appointment write: create/update/cancel push
// into the assigned member's dedicated "TopCoat" calendar; a hard delete
// arrives as { action:'delete', google_event_id, google_calendar_id }
// captured before the row vanished. A push failure never blocks the local
// save; the row simply keeps google_event_id null ("not synced yet") and the
// next write re-kicks.

const { sb } = require('./_pec-supabase.cjs');
const { googleConfigured, getStaffUser } = require('./_pec-google.cjs');
const { pushApptById, deleteEvent } = require('./_pec-appt-push.cjs');

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
const jc = (statusCode, body) => ({ statusCode, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jc(405, { ok: false, error: 'Method not allowed' });

  const user = await getStaffUser(event);
  if (!user) return jc(401, { ok: false, error: 'Not authenticated' });
  if (!googleConfigured()) return jc(200, { ok: true, skipped: 'google_not_configured' });

  let input;
  try { input = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { ok: false, error: 'Invalid JSON' }); }

  try {
    // Hard delete: the row is gone; the client passed the Google identifiers.
    if (input.action === 'delete') {
      if (!input.google_event_id || !input.google_calendar_id) return jc(200, { ok: true, skipped: 'never_synced' });
      const out = await deleteEvent(sb, input.google_calendar_id, input.google_event_id);
      return jc(200, { ok: out.ok, ...out });
    }

    if (!input.appointment_id) return jc(400, { ok: false, error: 'appointment_id is required' });
    return jc(200, await pushApptById(sb, input.appointment_id));
  } catch (err) {
    console.error('pec-appt-sync-push failed:', err && err.message || err);
    return jc(500, { ok: false, error: String(err && err.message || err) });
  }
};
