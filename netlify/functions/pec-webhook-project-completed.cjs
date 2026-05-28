// DripJobs webhook: project completed.
// Marks job as completed and all timeline stages as completed.
// POST /.netlify/functions/pec-webhook-project-completed

const { sb, badSecret, json } = require('./_pec-supabase.cjs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'Method not allowed' });
  if (badSecret(event)) return json(401, { success: false, error: 'Invalid webhook secret' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { success: false, error: 'Invalid JSON' }); }

  const { deal_id } = body;
  if (!deal_id) return json(400, { success: false, error: 'deal_id is required' });

  try {
    const jobs = await sb('GET', `/jobs?dripjobs_deal_id=eq.${encodeURIComponent(deal_id)}&select=id,completed_date&limit=1`);
    if (!jobs.length) return json(404, { success: false, error: 'Job not found for this deal_id' });
    const jobId = jobs[0].id;

    // completed_date drives AR aging. The crew Mark Complete button is the
    // primary path, but this covers DripJobs-driven completion. Today in
    // America/Phoenix (no DST); only set it if not already recorded.
    const completedDate = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const jobPatch = { status: 'completed' };
    if (!jobs[0].completed_date) jobPatch.completed_date = completedDate;
    await sb('PATCH', `/jobs?id=eq.${jobId}`, jobPatch);

    const stages = await sb('GET', `/timeline_stages?job_id=eq.${jobId}&select=id,status,completed_at`);
    const now = new Date().toISOString();
    for (const s of stages) {
      if (s.status !== 'completed') {
        await sb('PATCH', `/timeline_stages?id=eq.${s.id}`, {
          status: 'completed',
          completed_at: s.completed_at || now,
        });
      }
    }

    return json(200, { success: true, data: { job_id: jobId } });
  } catch (err) {
    console.error('pec-webhook-project-completed error:', err);
    return json(500, { success: false, error: err.message });
  }
};
