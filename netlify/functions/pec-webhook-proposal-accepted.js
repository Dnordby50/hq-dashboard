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

    return json(200, {
      success: true,
      data: {
        customer_token: customer.token,
        customer_id: customer.id,
        job_id: job.id,
        portal_link: `/?portal=${customer.token}`,
      },
    });
  } catch (err) {
    console.error('pec-webhook-proposal-accepted error:', err);
    return json(500, { success: false, error: err.message });
  }
};
