'use strict';

// Simulated database RPC boundary for intake tests. The migration's locking,
// privileges and triggers are covered separately by its database tests.
function withSalesLeadRpc(fixture, now) {
  const base = fixture.sb;
  fixture.salesLeadCalls = [];
  fixture.inquiryRequests = new Map();
  fixture.sb = async (method, path, payload, returnRow) => {
    // The mini-PostgREST fixture does not decode scalar eq filters itself.
    path = path.replace(/(intake_request_key=eq\.)([^&]*)/, (_, prefix, value) => prefix + decodeURIComponent(value));
    if (method === 'POST' && path === '/rpc/resolve_sales_customer') {
      const p=payload.p_profile;
      const matches=fixture.db.customers.filter(c=>c.company===p.company&&!c.archived_at&&((p.phone&&c.phone===p.phone)||(p.email&&c.email===p.email)));
      if(matches.length>1)throw new Error('Several customers match; review the identity before linking this inquiry');
      if(matches[0])return matches[0].id;
      const rows=await base('POST','/customers',{...p,archived_at:null},true);
      return rows[0].id;
    }
    if (method === 'POST' && path === '/rpc/record_sales_inquiry') {
      fixture.salesLeadCalls.push(payload);
      const c=fixture.db.customers.find(c=>c.id===payload.p_customer_id);
      if(!c||c.archived_at||c.company!==(payload.p_brand==='FTP'?'finishing-touch':'prescott-epoxy'))throw new Error('A live customer in this company is required');
      const key=payload.p_brand+':'+payload.p_request_key;
      const retry=fixture.inquiryRequests.get(key);
      if(retry){if(retry.customer_id!==c.id)throw new Error('Request identifier conflicts with the saved inquiry');return retry.id;}
      const active=fixture.db.leads.filter(l=>l.customer_id===c.id&&(l.brand||'PEC')===payload.p_brand&&!l.deleted_at&&!l.archived_at&&!['accepted','lost'].includes(l.stage));
      let l=payload.p_lead_id?active.find(l=>l.id===payload.p_lead_id):null;
      if(payload.p_mode!=='new'){
        if(!l&&active.length>1)throw new Error('Choose the inquiry this follows; this customer has several open requests');
        l=l||active[0];
      }
      if(!l){
        if(payload.p_origin==='source_event'&&!payload.p_inquiry_date)throw new Error('Original inquiry date required');
        const id='canonical-'+c.id+(fixture.db.leads.some(l=>l.id==='canonical-'+c.id)?'-'+fixture.db.leads.length:'');
        l={id,customer_id:c.id,brand:payload.p_brand,full_name:c.name,first_name:c.first_name,last_name:c.last_name,email:c.email,phone:c.phone,address:c.billing_address_line1,city:c.billing_city,state:c.billing_state,zip:c.billing_zip,source:c.lead_source||null,stage:'new',sms_consent:false,opted_out:false,created_at:now.toISOString(),deleted_at:null,archived_at:null,inquiry_date:payload.p_inquiry_date||now.toISOString().slice(0,10),intake_request_key:payload.p_request_key};
        fixture.db.leads.push(l);
        await base('POST','/lead_events',{lead_id:id,event_type:'created',to_stage:'new',payload:{via:'sales_inquiry',inquiry_date:l.inquiry_date,origin:payload.p_origin}});
      }
      fixture.inquiryRequests.set(key,l);return l.id;
    }
    if (method !== 'POST' || path !== '/rpc/ensure_sales_lead') return base(method, path, payload, returnRow);
    fixture.salesLeadCalls.push(payload);
    const customer = fixture.db.customers.find(row => row.id === payload.p_customer_id);
    if (!customer) throw new Error('Customer not found');
    const existing = fixture.db.leads.find(row => row.customer_id === customer.id && !row.deleted_at && (row.brand || 'PEC') === payload.p_brand);
    if (existing) return existing.id;
    const id = 'canonical-' + customer.id;
    fixture.db.leads.push({
      id, customer_id: customer.id, brand: payload.p_brand, full_name: customer.name,
      email: customer.email, phone: customer.phone, stage: 'new', source: customer.lead_source || null,
      created_at: payload.p_occurred_at || now.toISOString(), deleted_at: null, archived_at: null,
    });
    return id;
  };
  return fixture;
}

module.exports = { withSalesLeadRpc };
