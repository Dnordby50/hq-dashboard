// Original business dates are distinct from webhook receipt times.
const { createHash } = require('node:crypto');
const PHOENIX = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' });
function dateOfInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value)) || !validDate(value.slice(0,10))) return null;
  return PHOENIX.format(new Date(value));
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}
function sourceEvent(body, kind, now = new Date()) {
  const dates = kind === 'booked' ? ['accepted_date','signed_date'] : ['completed_date'];
  const instants = kind === 'booked' ? ['accepted_at','signed_at','occurred_at','event_occurred_at'] : ['completed_at','occurred_at','event_occurred_at'];
  const providedDates = dates.filter(k => body[k] != null && body[k] !== '').map(k => body[k]);
  const providedTimes = instants.filter(k => body[k] != null && body[k] !== '').map(k => body[k]);
  const eventKey = body.event_id || body.webhook_event_id || (body.deal_id ? `${kind}:${body.deal_id}` : null);
  if (!eventKey || !['string','number'].includes(typeof eventKey) || String(eventKey).length>180) return { ok:false, reason:'Missing stable source event or proposal identity' };
  if (providedDates.some(v => !validDate(v)) || providedTimes.some(v => !dateOfInstant(v))) return { ok:false, reason:'Invalid original event date or timestamp; timestamps need an explicit timezone', eventKey:String(eventKey) };
  if (providedTimes.some(v => Date.parse(v) > now.getTime())) return { ok:false, reason:'Original event timestamp is in the future', eventKey:String(eventKey) };
  const candidates = [...providedDates,...providedTimes.map(dateOfInstant)];
  if (!candidates.length) return { ok:false, reason:'Missing original event date; receipt date is not evidence', eventKey:String(eventKey) };
  if (new Set(candidates).size !== 1) return { ok:false, reason:'Original event dates disagree', eventKey:String(eventKey) };
  if (candidates[0] > PHOENIX.format(now)) return { ok:false, reason:'Original event date is in the future', eventKey:String(eventKey) };
  return { ok:true, eventKey:String(eventKey), businessDate:candidates[0], occurredAt:providedTimes[0] || null };
}
async function stageException(sb, body, kind, reason, eventKey) {
  const key = eventKey || createHash('sha256').update(JSON.stringify(body)).digest('hex');
  // The immutable source payload is retained on first delivery. Conflict retries
  // do not reopen a reviewed case or overwrite its original evidence.
  const rows = await sb('GET', `/pec_sales_integrity_exceptions?source=eq.dripjobs&source_event_key=eq.${encodeURIComponent(key)}&event_type=eq.${kind}&select=id&limit=1`);
  if (!rows.length) {
    try { await sb('POST','/pec_sales_integrity_exceptions', { brand:body.company==='finishing-touch'?'FTP':'PEC',source:'dripjobs',source_event_key:key,event_type:kind,entity_ref:body.deal_id ? String(body.deal_id) : null,reason,payload:body }); }
    catch (error) { if (!/23505|duplicate key/i.test(String(error.message))) throw error; }
  }
  return key;
}
async function resolveException(sb, key, kind, note) {
  await sb('PATCH', `/pec_sales_integrity_exceptions?source=eq.dripjobs&source_event_key=eq.${encodeURIComponent(key)}&event_type=eq.${kind}&state=eq.open`, { state:'resolved',resolved_at:new Date().toISOString(),resolution_note:note });
}
module.exports = { dateOfInstant, validDate, sourceEvent, stageException, resolveException };
