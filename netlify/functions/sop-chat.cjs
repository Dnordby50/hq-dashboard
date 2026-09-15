// Staff-only TopCoat help. The server owns instructions, model and cost bounds.
const { createHash } = require('node:crypto');
const { requireStaff, sb } = require('./_pec-supabase.cjs');
const { LIMITS, prepareContext } = require('./_pec-help-context.cjs');
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (statusCode, body, extra = {}) => ({ statusCode, headers: { ...headers, ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const hash = value => createHash('sha256').update(value).digest('hex');
async function quota(scope, key, limit, window) {
  const result = await sb('POST', '/rpc/pec_take_rate_limit', { p_scope: scope, p_key: hash(key), p_limit: limit, p_window_seconds: window }, { timeoutMs: 8000 });
  if (!result || typeof result.allowed !== 'boolean') throw new Error('Quota unavailable');
  return result;
}
exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return reply(204, '');
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  const auth = await requireStaff(event, { timeoutMs: 4000 });
  if (!auth.ok) return reply(auth.status, { error: auth.error });
  if (event.isBase64Encoded || Buffer.byteLength(event.body || '', 'utf8') > LIMITS.bodyBytes) return reply(413, { error: 'Request is too large' });
  let context;
  try { context = prepareContext(JSON.parse(event.body || '{}')); }
  catch (_) { return reply(400, { error: 'Send a valid conversation with a question of 8000 characters or fewer' }); }
  if (!process.env.ANTHROPIC_API_KEY) return reply(503, { error: 'Help is temporarily unavailable' });
  try {
    const personal = await quota('help_staff_hour', auth.user.id, 30, 3600);
    const total = personal.allowed ? await quota('help_total_day', 'topcoat-help', 200, 86400) : personal;
    if (!personal.allowed || !total.allowed) return reply(429, { error: 'Help request limit reached. Please try again later.' }, { 'Retry-After': String(total.retry_after || 3600) });
  } catch (_) { return reply(503, { error: 'Help is temporarily unavailable' }); }
  const controller = new AbortController();
  // Auth (2 x 4s), quotas (2 x 8s), and provider (28s) fit the host's 60s limit.
  const timer = setTimeout(() => controller.abort(), 28000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.TOPCOAT_HELP_MODEL || 'claude-sonnet-4-6', max_tokens: LIMITS.outputTokens, system: context.system, messages: context.messages }),
    });
    const data = await res.json();
    if (!res.ok) return reply(502, { error: 'Help could not answer right now. Please try again.' });
    const usage = data.usage || {};
    console.info(JSON.stringify({ event: 'topcoat_help_usage', feature: context.mode.toLowerCase(), ...context.metrics, input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, cache_read_input_tokens: usage.cache_read_input_tokens || 0, cache_creation_input_tokens: usage.cache_creation_input_tokens || 0 }));
    return reply(200, data);
  } catch (_) { return reply(502, { error: 'Help could not answer right now. Please try again.' }); }
  finally { clearTimeout(timer); }
};
