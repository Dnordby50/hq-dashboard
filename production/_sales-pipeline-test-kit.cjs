'use strict';

// Simulated database RPC boundary for intake tests. The migration's locking,
// privileges and triggers are covered separately by its database tests.
function withSalesLeadRpc(fixture, now) {
  const base = fixture.sb;
  fixture.salesLeadCalls = [];
  fixture.sb = async (method, path, payload, returnRow) => {
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
