// SalesAsk inbound webhook -> pec_salesask_recordings. Routed at
// /api/salesask/webhook (netlify.toml). SalesAsk POSTs here when a recording's
// AI analysis finishes (recording.processed) or a CRM sync updates it
// (recording.integration_updated).
//
// Delivery contract (docs.salesask.com/guides/webhooks) and why this handler
// is shaped the way it is:
//   - NO retries: a missed delivery is gone forever, so this function only
//     does cheap work and pec-salesask-sync's reconcile sweep is the safety
//     net that re-lists recent recordings from the REST API.
//   - Must 2xx within 10 seconds: the transcript is NEVER fetched inline.
//     The row is marked transcript_pending and the cron completes it.
//   - NO signature scheme: SalesAsk can't sign payloads, so the webhook URL
//     registered in their Settings carries ?secret=<SALESASK_WEBHOOK_SECRET>
//     and we compare it constant-time. Rotating = new secret in both places.
//
// The payload's `data` is rich enough for a useful row immediately (name,
// notes, action items, process score, meeting URL), so staff see the recording
// within seconds; the transcript and full document follow on the next cron
// tick. Verify-then-always-200 shape mirrors pec-webhook-quo.cjs: after auth,
// a soft failure logs and still 200s (a non-2xx buys nothing when the sender
// never retries anyway).

const { json, safeEqual, logIngest } = require('./_pec-supabase.cjs');
const {
  upsertRecording, extractRecordingFields, extractEventId,
  matchRecordingToAppointment, insertRecordingLeadEvent,
} = require('./_pec-salesask.cjs');

const WEBHOOK_SECRET = process.env.SALESASK_WEBHOOK_SECRET;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'Method not allowed' });

  const got = (event.queryStringParameters && event.queryStringParameters.secret) || '';
  if (!WEBHOOK_SECRET || !safeEqual(got, WEBHOOK_SECRET)) {
    return json(401, { success: false, error: 'Invalid secret' });
  }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  let payload;
  try { payload = JSON.parse(rawBody || '{}'); }
  catch { return json(200, { success: true, ignored: 'unparseable body' }); }

  try {
    const evType = String(payload.event || payload.type || '');
    const doc = payload.data || payload.recording || {};
    const recordingId = doc.id || doc.recordingId || null;

    await logIngest({
      endpoint: 'salesask-webhook',
      outcome: recordingId ? 'ok' : 'rejected',
      message: `${evType || 'unknown-event'} ${recordingId || 'no-recording-id'}`,
      payload,
    });
    if (!recordingId) return json(200, { success: true, ignored: 'no recording id' });

    // Thin upsert from the payload. recording.processed means the analysis is
    // done even when the payload omits a status field.
    const fields = extractRecordingFields(doc);
    if (!fields.status && /processed/i.test(evType)) fields.status = 'processed';
    const rec = await upsertRecording(recordingId, fields);

    // Best-effort inline match (cheap DB reads only — no SalesAsk API calls,
    // no email-map load; the rep_time_window fallback needs the map and runs
    // in the cron instead if this pass comes up empty).
    if (rec && !rec.appointment_id) {
      const eventId = extractEventId(doc);
      const matched = await matchRecordingToAppointment(rec, eventId, null).catch(() => rec);
      // If the payload already carried enough (summary + match), the timeline
      // event can land now; the cron's completion pass dedupes.
      if (matched.lead_id && (matched.status === 'processed')) {
        await insertRecordingLeadEvent(matched).catch(e =>
          console.error('pec-webhook-salesask: lead event insert failed', e.message));
      }
    }

    return json(200, { success: true });
  } catch (err) {
    // Never non-2xx after auth: SalesAsk doesn't retry, and the reconcile
    // sweep will pick the recording up regardless.
    console.error('pec-webhook-salesask error:', err.message);
    return json(200, { success: false, error: 'handled' });
  }
};
