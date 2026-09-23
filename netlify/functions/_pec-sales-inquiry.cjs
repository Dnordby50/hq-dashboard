'use strict';
const crypto = require('node:crypto');
function originalInquiryDate(value) {
  const text = String(value || '').trim();
  let day;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0,10) !== text) return null;
    day = text;
  } else {
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(text) || !Number.isFinite(Date.parse(text))) return null;
    const calendar = text.slice(0,10);
    if (!Number.isFinite(Date.parse(calendar)) || new Date(calendar).toISOString().slice(0,10) !== calendar) return null;
    day = new Date(Date.parse(text)-7*3600000).toISOString().slice(0,10);
  }
  return day <= new Date(Date.now()-7*3600000).toISOString().slice(0,10) ? day : null;
}
async function stageInquiryReview(db, {key,endpoint,reason,payload}) {
  // A hash groups retries of an undated payload only; it is never an inquiry ID.
  const eventKey = key || 'unidentified:' + crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  try {
    await db('POST','/pec_sales_integrity_exceptions', {
      brand:'PEC',source:endpoint,source_event_key:eventKey,event_type:'inquiry',entity_ref:null,
      reason,payload,state:'open',
    });
  } catch(e) { if (!/23505|duplicate key/i.test(String(e && e.message))) throw e; }
}
async function recordInquiry(db,{customerId,key,leadId=null,mode='auto',date=null,origin='public_booking',evidence=null}) {
  const id=await db('POST','/rpc/record_sales_inquiry',{
    p_customer_id:customerId,p_request_key:key,p_brand:'PEC',p_mode:mode,p_lead_id:leadId,
    p_inquiry_date:date,p_origin:origin,p_evidence:evidence,
  });
  if (typeof id!=='string'||!id) throw new Error('Could not link the customer inquiry to the sales pipeline');
  return id;
}
module.exports={originalInquiryDate,stageInquiryReview,recordInquiry};
