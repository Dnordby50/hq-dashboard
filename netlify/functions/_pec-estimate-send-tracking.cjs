'use strict';

const { randomUUID } = require('node:crypto');

// Persist the proposal identity before making a non-idempotent provider call.
// A pending row is deliberately left unresolved when delivery is uncertain.
// Only provider acceptance with a real message ID can create a first-send fact.
async function sendTrackedEstimate({ db, estimateId, brand, channel, recipient, send, now = () => new Date(), uuid = randomUUID }) {
  const attemptId = uuid();
  const tracking = { tracking_attempt_id: attemptId };
  const normalizedBrand = ({ PEC: 'PEC', FTP: 'FTP', 'prescott-epoxy': 'PEC', 'finishing-touch': 'FTP' })[brand];
  try {
    if (!estimateId || !normalizedBrand || !['email', 'sms'].includes(channel) || typeof recipient !== 'string' || !recipient.trim()) throw new Error('Invalid proposal send identity.');
    const pending = await db('GET', `/pec_estimate_send_attempts?estimate_id=eq.${encodeURIComponent(estimateId)}&channel=eq.${channel}&status=eq.pending&select=id&order=started_at.asc&limit=1`);
    if (!Array.isArray(pending)) throw new Error('Proposal send history could not be checked.');
    if (pending.length) return { state: 'unknown', tracking_attempt_id: pending[0].id, error: 'An earlier delivery of this proposal is still unconfirmed. Check the provider message history and reconcile that attempt before sending again.' };
    const row = { id: attemptId, estimate_id: estimateId, brand: normalizedBrand, channel, recipient: recipient.trim(), status: 'pending', started_at: now().toISOString() };
    const inserted = await db('POST', '/pec_estimate_send_attempts', row, true);
    if (!Array.isArray(inserted) || inserted.length !== 1 || inserted[0].id !== attemptId || inserted[0].status !== 'pending') throw new Error('Proposal send attempt was not recorded.');
  } catch (_) {
    return { state: 'not_sent', ...tracking, error: 'The proposal was not sent because its reporting record could not be created. Try again after the connection is restored.' };
  }

  let response, body;
  try {
    response = await send();
    body = await response.json().catch(() => ({}));
  } catch (_) {
    return { state: 'unknown', ...tracking, error: 'Delivery could not be confirmed. Check the provider message history before sending this proposal again.' };
  }
  if (!response.ok) {
    // A server error or request timeout can arrive after the provider accepted
    // delivery. Only a definite client rejection permits a later retry.
    if (!(response.status >= 400 && response.status < 500) || response.status === 408) {
      return { state: 'unknown', ...tracking, error: 'The provider returned an uncertain delivery result. Check the provider message history before sending this proposal again.' };
    }
    const reason = body?.message || body?.error?.message || body?.error || `Provider rejected the message (${response.status}).`;
    let trackingPending = false;
    try {
      const failed = await db('PATCH', `/pec_estimate_send_attempts?id=eq.${attemptId}&status=eq.pending`, { status: 'failed', completed_at: now().toISOString(), error: String(reason).slice(0, 500) }, true);
      if (!Array.isArray(failed) || failed.length !== 1 || failed[0].id !== attemptId || failed[0].status !== 'failed') throw new Error('Proposal rejection was not recorded.');
    } catch (_) { trackingPending = true; }
    return { state: 'rejected', response, body, ...tracking, tracking_pending: trackingPending };
  }

  const providerId = channel === 'sms' ? body?.data?.id || body?.id : body?.id;
  if (typeof providerId !== 'string' || !providerId.trim()) {
    return { state: 'unknown', ...tracking, error: 'The provider accepted the request without a message reference. Verify delivery in the provider message history before sending again.' };
  }
  const completedAt = now().toISOString();
  let trackingPending = false;
  try {
    const completed = await db('PATCH', `/pec_estimate_send_attempts?id=eq.${attemptId}&status=eq.pending`, { status: 'sent', provider_id: providerId, completed_at: completedAt, error: null }, true);
    if (!Array.isArray(completed) || completed.length !== 1 || completed[0].id !== attemptId || completed[0].status !== 'sent' || completed[0].provider_id !== providerId) throw new Error('Proposal send completion was not recorded.');
  } catch (_) { trackingPending = true; }
  return {
    state: 'sent', response, body, providerId, ...tracking, tracking_pending: trackingPending,
    ...(trackingPending ? { warning: 'The proposal was sent, but its reporting record is pending. Do not resend it; the delivery needs to be reconciled.' } : {}),
  };
}

function trackingResponse(result) {
  return {
    tracking_attempt_id: result.tracking_attempt_id,
    tracking_pending: result.tracking_pending === true,
    ...(result.warning ? { warning: result.warning } : {}),
  };
}

module.exports = { sendTrackedEstimate, trackingResponse };
