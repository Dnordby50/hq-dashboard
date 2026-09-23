// DripJobs original completion event. Delivery time is never completion evidence.
const { sb, badSecret, json } = require('./_pec-supabase.cjs');
const { sourceEvent, stageException, resolveException } = require('./_pec-job-events.cjs');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405,{ success:false,error:'Method not allowed' });
  if (badSecret(event)) return json(401,{ success:false,error:'Invalid webhook secret' });
  let body;
  try { body=JSON.parse(event.body || '{}'); } catch { return json(400,{ success:false,error:'Invalid JSON' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400,{success:false,error:'Expected a JSON object'});
  const occurrence=sourceEvent(body,'completed');
  try {
    if (!occurrence.ok || !body.deal_id) {
      const reason=!occurrence.ok ? occurrence.reason : 'Proposal identity required';
      const key=await stageException(sb,body,'completed',reason,occurrence.eventKey);
      return json(202,{ success:false,review_required:true,source_event_key:key,error:reason });
    }
    const company=body.company || 'prescott-epoxy';
    const jobs=await sb('GET',`/jobs?dripjobs_deal_id=eq.${encodeURIComponent(body.deal_id)}&customers.company=eq.${encodeURIComponent(company)}&select=id,customers!inner(company)&limit=2`);
    if (jobs.length !== 1) {
      const reason=jobs.length ? 'Multiple CRM jobs match the external proposal' : 'No CRM job matches the external proposal';
      await stageException(sb,body,'completed',reason,occurrence.eventKey);
      return json(202,{ success:false,review_required:true,error:reason });
    }
    const result=await sb('POST','/rpc/pec_complete_job',{
      p_job_id:jobs[0].id,p_completed_date:occurrence.businessDate,
      p_request_key:`dripjobs:completed:${occurrence.eventKey}`,p_occurred_at:occurrence.occurredAt,
      p_evidence_ref:`DripJobs proposal ${body.deal_id}; event ${occurrence.eventKey}`,
    });
    await resolveException(sb,occurrence.eventKey,'completed','Completion applied atomically with original source date');
    return json(200,{ success:true,data:result });
  } catch(error) {
    if (/conflict|Multiple|linked|date already|Active CRM/i.test(String(error.message))) {
      await stageException(sb,body,'completed',String(error.message),occurrence.eventKey);
      return json(202,{ success:false,review_required:true,error:String(error.message) });
    }
    console.error('pec-webhook-project-completed error:',error);
    return json(500,{ success:false,error:String(error.message) });
  }
};
