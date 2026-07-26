// Approve or skip ONE held drip step from the Drip Approvals view
// (prompt 42). All the real logic lives in _pec-drip.cjs resolvePendingStep
// (injectable deps, fixture-tested); this is the thin authenticated HTTP
// shell around it, same posture as pec-blast-run.cjs: staff JWT required
// because this endpoint takes parameters and pushes real messages, so the
// open-runner posture would be wrong here.
//
// POST { enrollment_id, step_index, action: 'approve'|'skip',
//        edits: { [sendRowId]: { body, subject } } }
//
// Approve re-checks consent + kill-switches + quiet hours at THIS moment
// (never trusting render time), sends via the same providers as the runner,
// logs 'sent', and advances the enrollment exactly as an auto-send would.
// Skip advances without sending. Both are safe against double-clicks and
// concurrent reviewers (conditional claims inside resolvePendingStep).

const { sb, json, requireStaff } = require('./_pec-supabase.cjs');
const { resolvePendingStep } = require('./_pec-drip.cjs');

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
  const user = gate.user;

  let input;
  try { input = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { ok: false, error: 'Invalid JSON' }); }

  try {
    const result = await resolvePendingStep({ sb }, {
      enrollmentId: input.enrollment_id,
      stepIndex: input.step_index,
      action: input.action,
      edits: (input.edits && typeof input.edits === 'object') ? input.edits : {},
    });
    console.log('pec-drip-approve:', user.id, input.action, input.enrollment_id, 'step', input.step_index, JSON.stringify(result));
    if (!result.ok) {
      const code = result.error === 'bad_request' ? 400 : 409;
      return jc(code, { ok: false, error: result.error });
    }
    return jc(200, result);
  } catch (err) {
    console.error('pec-drip-approve failed:', err && err.message || err);
    return jc(500, { ok: false, error: String(err && err.message || err) });
  }
};
