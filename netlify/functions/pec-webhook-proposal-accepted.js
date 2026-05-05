// DripJobs webhook: proposal accepted.
// Creates (or upserts) a customer and a job with a default timeline.
// POST /.netlify/functions/pec-webhook-proposal-accepted
// Header: x-webhook-secret: <PEC_WEBHOOK_SECRET>

const { sb, epoxyStages, paintStages, badSecret, json, randomToken } = require('./_pec-supabase.js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'Method not allowed' });
  if (badSecret(event)) return json(401, { success: false, error: 'Invalid webhook secret' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { success: false, error: 'Invalid JSON' }); }

  const {
    customer_name, customer_email, customer_phone, company,
    deal_id, address, job_type, package: pkg, scope, sqft,
    price, monthly_payment, dripjobs_url, warranty,
  } = body;

  if (!customer_name) return json(400, { success: false, error: 'customer_name is required' });

  try {
    // Upsert by email (fall back to create if no email)
    let customer;
    if (customer_email) {
      const existing = await sb('GET', `/customers?email=eq.${encodeURIComponent(customer_email)}&select=*&limit=1`);
      if (existing.length) {
        const updated = await sb('PATCH', `/customers?id=eq.${existing[0].id}`, {
          name: customer_name,
          phone: customer_phone || existing[0].phone,
        }, true);
        customer = updated[0];
      }
    }
    if (!customer) {
      const created = await sb('POST', '/customers', {
        token: randomToken(),
        name: customer_name,
        email: customer_email || null,
        phone: customer_phone || null,
        company: company || 'prescott-epoxy',
      }, true);
      customer = created[0];
    }

    const type = (job_type === 'paint') ? 'paint' : 'epoxy';
    const createdJobs = await sb('POST', '/jobs', {
      customer_id: customer.id,
      type,
      address: address || null,
      package: pkg || null,
      scope: scope || null,
      sqft: sqft || null,
      price: price ? parseFloat(price) : null,
      monthly_payment: monthly_payment ? parseFloat(monthly_payment) : null,
      warranty: warranty || null,
      dripjobs_url: dripjobs_url || null,
      dripjobs_deal_id: deal_id || null,
      source: 'dripjobs',
    }, true);
    const job = createdJobs[0];

    // Create default timeline stages
    const stages = (type === 'epoxy' ? epoxyStages : paintStages).map((name, i) => ({
      job_id: job.id,
      stage_name: name,
      status: i === 0 ? 'completed' : 'pending',
      completed_at: i === 0 ? new Date().toISOString() : null,
      sort_order: i,
    }));
    await sb('POST', '/timeline_stages', stages);

    // Auto-bridge: create the matching pec_prod_jobs row so this proposal lands
    // in the PEC Job Schedule's Pending Jobs sidebar immediately. install_date
    // stays null (PM picks days in the schedule popup). Idempotent against
    // re-deliveries via dripjobs_deal_id check; failures here do NOT roll back
    // the public.jobs side.
    //
    // Brand gate: pec_prod_* tables are PEC-only. FTP customers come through
    // the same webhook (one DripJobs endpoint, payload field `company`
    // distinguishes), so skip the bridge when company is anything other than
    // 'prescott-epoxy'. The FTP equivalent (separate table or a `company`
    // column on pec_prod_jobs) is logged in docs/job-schedule-future-todos.md.
    const companyKey = customer.company || company || 'prescott-epoxy';
    let prodJobId = null;
    if (companyKey === 'prescott-epoxy') {
      try {
        if (deal_id) {
          const existing = await sb('GET', `/pec_prod_jobs?dripjobs_deal_id=eq.${encodeURIComponent(deal_id)}&select=id&limit=1`);
          if (!existing.length) {
            const proposalNumber = String(deal_id);
            const created = await sb('POST', '/pec_prod_jobs', {
              proposal_number: proposalNumber,
              customer_id: customer.id,
              customer_name: customer_name,
              address: address || null,
              revenue: price ? parseFloat(price) : null,
              status: 'unscheduled',
              sync_status: 'dirty',
              dripjobs_deal_id: deal_id,
              notes: scope || null,
            }, true);
            prodJobId = created && created[0] ? created[0].id : null;
          } else {
            prodJobId = existing[0].id;
          }
        }
      } catch (bridgeErr) {
        console.error('pec-webhook-proposal-accepted: prod auto-bridge failed (non-fatal):', bridgeErr);
      }
    }

    return json(200, {
      success: true,
      data: {
        customer_token: customer.token,
        customer_id: customer.id,
        job_id: job.id,
        prod_job_id: prodJobId,
        portal_link: `/?portal=${customer.token}`,
      },
    });
  } catch (err) {
    console.error('pec-webhook-proposal-accepted error:', err);
    return json(500, { success: false, error: err.message });
  }
};
