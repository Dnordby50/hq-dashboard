// DripJobs webhook: proposal accepted.
// Creates (or upserts) a customer and a job with a default timeline.
// POST /.netlify/functions/pec-webhook-proposal-accepted
// Header: x-webhook-secret: <PEC_WEBHOOK_SECRET>

const { sb, badSecret, json, logIngest } = require('./_pec-supabase.cjs');
const { prepareDepositInstallment } = require('./_pec-installments.cjs');
const { resolveDefaultTerms } = require('./_pec-invoice-terms.cjs');

const ENDPOINT = 'proposal-accepted';

// DripJobs sends scope/notes wrapped in HTML (<p>...</p>, <br>, entities).
// Stored raw, those tags show up as literal text in the CRM. Convert to plain
// text on the way in: block tags become line breaks, other tags are dropped,
// common entities are decoded. Returns null for empty input so callers can
// keep their `|| null` semantics.
function stripHtml(s) {
  if (s == null) return null;
  let out = String(s)
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out || null;
}

const { sourceEvent, stageException, resolveException } = require('./_pec-job-events.cjs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'Method not allowed' });
  if (badSecret(event)) return json(401, { success: false, error: 'Invalid webhook secret' });
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { success:false, error:'Invalid JSON' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400,{success:false,error:'Expected a JSON object'});
  const { deal_id, customer_name, company } = body;
  const occurrence = sourceEvent(body, 'booked');
  try {
    if (!occurrence.ok || !deal_id || !customer_name) {
      const reason = !occurrence.ok ? occurrence.reason : 'Proposal identity and customer name are required';
      const key = await stageException(sb, body, 'booked', reason, occurrence.eventKey);
      await logIngest({ endpoint:ENDPOINT,deal_id,customer_name,company,outcome:'rejected',status_code:202,message:reason,payload:body });
      return json(202, { success:false, review_required:true, source_event_key:key, error:reason });
    }
    let termsSettings = {};
    try {
      const rows = await sb('GET','/settings?key=in.(invoice_terms_residential_default,invoice_terms_commercial_default)&select=key,value');
      termsSettings = Object.fromEntries(rows.map(r => [r.key,r.value]));
    } catch (_) { /* existing locked terms defaults */ }
    let customerCompany = body.company_name || null;
    if (body.customer_email) {
      const matches = await sb('GET',`/customers?email=eq.${encodeURIComponent(body.customer_email)}&company=eq.${encodeURIComponent(company || 'prescott-epoxy')}&select=company_name&limit=2`);
      if (matches.length === 1) customerCompany = matches[0].company_name || customerCompany;
    }
    const result = await sb('POST','/rpc/pec_accept_external_job',{ p_payload:{
      ...body, scope:stripHtml(body.scope), signed_date:occurrence.businessDate, occurred_at:occurrence.occurredAt,
      invoice_terms:resolveDefaultTerms({ companyName:customerCompany },termsSettings),
    }});
    // Deposit preparation is independently idempotent; no customer messages are sent.
    try { await prepareDepositInstallment(sb,result.job_id,{}); }
    catch (error) { console.error('proposal-accepted deposit preparation:',String(error.message)); }
    await resolveException(sb,occurrence.eventKey,'booked','Accepted with original source date and atomic CRM/production link');
    await logIngest({ endpoint:ENDPOINT,deal_id,customer_name,company,outcome:'ok',status_code:200,message:result.created?'job created atomically':'existing job reused',payload:body,public_job_id:result.job_id,prod_job_id:result.prod_job_id });
    return json(200,{ success:true,data:{ ...result,portal_link:`/?portal=${result.customer_token}` }});
  } catch (error) {
    // A conflicting identity/date must remain visible. Database transaction has
    // rolled back, so neither a partial job nor a false booking is reported.
    if (/conflict|Multiple|matches multiple|linked to another|Unknown company|contract price is required|Date accepted|Invalid original|date\/time field/i.test(String(error.message))) {
      await stageException(sb,body,'booked',String(error.message),occurrence.eventKey);
      return json(202,{ success:false,review_required:true,error:String(error.message) });
    }
    console.error('pec-webhook-proposal-accepted error:',error);
    await logIngest({ endpoint:ENDPOINT,deal_id,customer_name,company,outcome:'error',status_code:500,message:String(error.message),payload:body });
    return json(500,{ success:false,error:String(error.message) });
  }
};
