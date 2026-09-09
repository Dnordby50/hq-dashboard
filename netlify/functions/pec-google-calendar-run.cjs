// Staff-only on-demand continuation of the same leased scheduled worker.
const { requireStaff, json } = require('./_pec-supabase.cjs');
const { runGooglePull } = require('./_pec-google-pull.cjs');
exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  const auth = await requireStaff(event, { timeoutMs: 3000 });
  if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });
  const out = await runGooglePull();
  return json(out.ok ? 200 : 503, out);
};
