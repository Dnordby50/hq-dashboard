// On-book appointment notify kick (prompt 37). The dashboard calls this
// right after an appointment insert so the booking confirmation (the on_book
// reminder rules) goes out immediately instead of waiting for the 15-minute
// pec-appt-reminder-runner tick, which remains the safety net. Requires a
// staff Supabase JWT (same auth shape as pec-send-sms); the actual sends run
// with the service role inside runApptReminders. Always safe to re-kick: the
// reminder-sends ledger's unique index makes every leg exactly-once.

const { sb, requireStaff } = require('./_pec-supabase.cjs');
const { runApptReminders, apptBookingLeadEffects } = require('./_pec-appt.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function jc(statusCode, body) {
  return { statusCode, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function getUser(token) {
  if (!token || !SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jc(405, { ok: false, error: 'Method not allowed' });

  const gate = await requireStaff(event);
  if (!gate.ok) return jc(gate.status, { ok: false, error: gate.error });

  let input;
  try { input = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { ok: false, error: 'Invalid JSON' }); }
  if (!input.appointment_id) return jc(400, { ok: false, error: 'appointment_id is required' });

  try {
    const summary = await runApptReminders({ sb }, { appointmentId: String(input.appointment_id) });
    // Prompt 43: an in-app booking pauses the lead's active nurture drip too
    // (drip pause ONLY; the client's Schedule Estimate flow still owns the
    // stage advance, so advanceStage stays false here). Best-effort and
    // idempotent, so a re-kick is harmless.
    try {
      const rows = await sb('GET', `/pec_appointments?id=eq.${encodeURIComponent(String(input.appointment_id))}&select=id,lead_id,appt_type,source&limit=1`);
      const appt = Array.isArray(rows) && rows[0];
      if (appt && appt.lead_id) {
        const fx = await apptBookingLeadEffects(sb, appt, { advanceStage: false });
        if (fx.drip_stopped) summary.drip_stopped = fx.drip_stopped;
      }
    } catch (e) {
      console.warn('pec-appt-notify: lead effects skipped (non-fatal):', e && e.message);
    }
    console.log('pec-appt-notify:', JSON.stringify({ appointment_id: input.appointment_id, ...summary }));
    return jc(200, { ok: true, ...summary });
  } catch (err) {
    console.error('pec-appt-notify failed:', err && err.message || err);
    return jc(500, { ok: false, error: String(err && err.message || err) });
  }
};
