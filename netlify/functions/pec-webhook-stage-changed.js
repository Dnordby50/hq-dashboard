// DripJobs webhook: deal stage changed.
// Advances timeline to the named stage and updates job status accordingly.
// POST /.netlify/functions/pec-webhook-stage-changed

const { sb, badSecret, json } = require('./_pec-supabase.js');

const IN_PROGRESS_STAGES = ['Prep Day', 'Coating Day', 'Prep', 'Prime', 'Paint'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'Method not allowed' });
  if (badSecret(event)) return json(401, { success: false, error: 'Invalid webhook secret' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { success: false, error: 'Invalid JSON' }); }

  const { deal_id, new_stage } = body;
  if (!deal_id || !new_stage) return json(400, { success: false, error: 'deal_id and new_stage are required' });

  try {
    const jobs = await sb('GET', `/jobs?dripjobs_deal_id=eq.${encodeURIComponent(deal_id)}&select=*&limit=1`);
    if (!jobs.length) return json(404, { success: false, error: 'Job not found for this deal_id' });
    const job = jobs[0];

    const stages = await sb('GET', `/timeline_stages?job_id=eq.${job.id}&select=*&order=sort_order.asc`);
    const targetIdx = stages.findIndex(s => s.stage_name === new_stage);
    if (targetIdx === -1) return json(400, { success: false, error: `Stage "${new_stage}" not found` });

    // Mark every stage before target as completed; target as in_progress
    const now = new Date().toISOString();
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      if (i < targetIdx && s.status !== 'completed') {
        await sb('PATCH', `/timeline_stages?id=eq.${s.id}`, { status: 'completed', completed_at: now });
      } else if (i === targetIdx) {
        await sb('PATCH', `/timeline_stages?id=eq.${s.id}`, { status: 'in_progress' });
      }
    }

    let newJobStatus = null;
    if (IN_PROGRESS_STAGES.includes(new_stage)) newJobStatus = 'in_progress';
    else if (new_stage === 'Scheduled') newJobStatus = 'scheduled';
    if (newJobStatus) await sb('PATCH', `/jobs?id=eq.${job.id}`, { status: newJobStatus });

    return json(200, { success: true, data: { job_id: job.id, stage: new_stage } });
  } catch (err) {
    console.error('pec-webhook-stage-changed error:', err);
    return json(500, { success: false, error: err.message });
  }
};
