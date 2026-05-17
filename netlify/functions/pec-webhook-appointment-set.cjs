// DripJobs webhook: appointment set / install date set.
// Writes install_date back to pec_prod_jobs by matching dripjobs_deal_id, so
// the CRM Job Schedule modal can pre-fill the date instead of forcing the PM
// to copy it from DripJobs. Companion to the existing proposal-accepted /
// stage-changed / project-completed handlers; mirrors their shape.
//
// POST /.netlify/functions/pec-webhook-appointment-set
// Header: x-webhook-secret: <PEC_WEBHOOK_SECRET>
// Body: { deal_id, install_date }  (also accepts appointment_date as a synonym)
//   install_date may be "YYYY-MM-DD" or a full ISO timestamp; we slice to date.
//
// pec_prod_jobs is PEC-only. If the deal_id has no matching row (FTP job, or
// the proposal-accepted bridge has not fired yet), we return 200 with
// matched:false so DripJobs does not retry forever.

const { sb, badSecret, json } = require('./_pec-supabase.cjs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'Method not allowed' });
  if (badSecret(event)) return json(401, { success: false, error: 'Invalid webhook secret' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { success: false, error: 'Invalid JSON' }); }

  const { deal_id, install_date, appointment_date } = body;
  const rawDate = install_date || appointment_date;
  if (!deal_id) return json(400, { success: false, error: 'deal_id is required' });
  if (!rawDate) return json(400, { success: false, error: 'install_date (or appointment_date) is required' });

  const iso = String(rawDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return json(400, { success: false, error: 'install_date must be YYYY-MM-DD or ISO 8601 timestamp' });
  }

  try {
    const existing = await sb(
      'GET',
      `/pec_prod_jobs?dripjobs_deal_id=eq.${encodeURIComponent(deal_id)}&select=id,install_date&limit=1`
    );
    if (!existing.length) {
      return json(200, { success: true, data: { matched: false, deal_id } });
    }
    const job = existing[0];
    await sb('PATCH', `/pec_prod_jobs?id=eq.${job.id}`, { install_date: iso });
    return json(200, {
      success: true,
      data: {
        matched: true,
        job_id: job.id,
        install_date: iso,
        previous_install_date: job.install_date || null,
      },
    });
  } catch (err) {
    console.error('pec-webhook-appointment-set error:', err);
    return json(500, { success: false, error: err.message });
  }
};
