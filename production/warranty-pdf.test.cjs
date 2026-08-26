'use strict';
// Warranty PDF on customer estimates (2026-08-26): loadWarranty precedence,
// warrantyBlockHtml rendering, the bottom-of-document placement, and the
// accept-path lead_source stamp. Drives the REAL pec-public-estimate.cjs
// internals with _pec-supabase's sb mocked through the require cache (the
// busybusy-project.test.cjs pattern).
// Run: node production/warranty-pdf.test.cjs

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${label}`); }
}

// Route-aware sb stub: settings + warranty sections + the ensureJobCreated
// touches. Each test tweaks `state`.
const state = {
  settings: { estimate_warranty_enabled: 'true', estimate_warranty_pdf_path: '' },
  sections: [],
  customersFound: [],
  posts: {},
};
async function sbStub(method, path, payload) {
  if (method === 'GET' && path.startsWith('/settings')) {
    return Object.entries(state.settings).map(([key, value]) => ({ key, value }));
  }
  if (method === 'GET' && path.startsWith('/pec_presentation_sections')) return state.sections;
  if (method === 'GET' && path.startsWith('/customers')) return state.customersFound;
  if (method === 'GET') return [];
  if (method === 'POST') {
    const table = path.replace(/^\//, '').split('?')[0];
    (state.posts[table] ||= []).push(payload);
    return [{ id: 'row-' + table, ...payload }];
  }
  return [];
}

const supaPath = require.resolve('../netlify/functions/_pec-supabase.cjs');
const realSupa = require(supaPath);
require.cache[supaPath].exports = Object.assign({}, realSupa, {
  sb: sbStub,
  randomToken: () => 'tok-test',
});
delete require.cache[require.resolve('../netlify/functions/pec-public-estimate.cjs')];
for (const m of ['../netlify/functions/_pec-installments.cjs', '../netlify/functions/_pec-financing.cjs', '../netlify/functions/_pec-busybusy.cjs']) {
  try { delete require.cache[require.resolve(m)]; } catch (_) {}
}
const { _internals } = require('../netlify/functions/pec-public-estimate.cjs');
const { loadWarranty, warrantyBlockHtml } = _internals;

(async () => {
  const SECTION = { id: 's1', title: 'Ten Year Warranty', body: 'We stand behind it.', images: [] };

  // ---- loadWarranty precedence ---------------------------------------------
  {
    // Snapshot with pdf wins over live everything.
    const est = { status: 'sent', brand: 'PEC', warranty_snapshot: { sections: [], pdf_path: 'abc.pdf', frozen_at: 'x' } };
    state.sections = [SECTION];
    state.settings.estimate_warranty_pdf_path = 'live.pdf';
    const w = await loadWarranty(est);
    ok(w && w.source === 'snapshot' && w.pdfPath === 'abc.pdf' && w.sections.length === 0, 'snapshot pdf wins over live');
  }
  {
    // Legacy {sections, frozen_at} snapshot: no pdf, sections render.
    const est = { status: 'sent', brand: 'PEC', warranty_snapshot: { sections: [SECTION], frozen_at: 'x' } };
    const w = await loadWarranty(est);
    ok(w && w.source === 'snapshot' && w.pdfPath == null && w.sections.length === 1, 'legacy snapshot shape reads pdf-less');
  }
  {
    // Accepted with no snapshot renders nothing, even with live content.
    const est = { status: 'accepted', brand: 'PEC', warranty_snapshot: null };
    state.sections = [SECTION];
    state.settings.estimate_warranty_pdf_path = 'live.pdf';
    ok((await loadWarranty(est)) === null, 'accepted + no snapshot renders nothing');
  }
  {
    // Open estimate, no snapshot: live sections + live pdf.
    const est = { status: 'sent', brand: 'PEC', warranty_snapshot: null };
    state.sections = [SECTION];
    state.settings.estimate_warranty_pdf_path = 'live.pdf';
    const w = await loadWarranty(est);
    ok(w && w.source === 'live' && w.pdfPath === 'live.pdf' && w.sections.length === 1, 'open estimate reads live sections + pdf');
  }
  {
    // Pdf-only (no sections anywhere): still renders.
    const est = { status: 'sent', brand: 'PEC', warranty_snapshot: null };
    state.sections = [];
    state.settings.estimate_warranty_pdf_path = 'only.pdf';
    const w = await loadWarranty(est);
    ok(w && w.pdfPath === 'only.pdf' && w.sections.length === 0, 'pdf-only still returns a warranty');
  }
  {
    // Disabled: nothing, snapshot or not.
    state.settings.estimate_warranty_enabled = 'false';
    const est = { status: 'sent', brand: 'PEC', warranty_snapshot: { sections: [SECTION], pdf_path: 'abc.pdf', frozen_at: 'x' } };
    ok((await loadWarranty(est)) === null, 'disabled setting suppresses everything');
    state.settings.estimate_warranty_enabled = 'true';
  }

  // ---- warrantyBlockHtml ----------------------------------------------------
  {
    const html = warrantyBlockHtml({ sections: [], pdfPath: 'w.pdf', source: 'live' });
    ok(html.includes('<iframe') && html.includes('noprint'), 'pdf card embeds a noprint iframe');
    ok(html.includes('/storage/v1/object/public/pec-docs/w.pdf'), 'pdf card links the pec-docs public URL');
    ok(html.includes('View or download our warranty (PDF)'), 'pdf card carries the printing link line');
    ok(html.includes('Our warranty'), 'pdf-only card still carries the eyebrow');
  }
  {
    const html = warrantyBlockHtml({ sections: [SECTION], pdfPath: 'w.pdf', source: 'snapshot' });
    ok(html.indexOf('Ten Year Warranty') < html.indexOf('<iframe'), 'text sections render above the pdf card');
  }
  ok(warrantyBlockHtml({ sections: [], pdfPath: null }) === '', 'empty warranty renders nothing');
  ok(warrantyBlockHtml(null) === '', 'null warranty renders nothing');

  // ---- Page ordering: warranty is the LAST content block --------------------
  {
    const est = {
      id: 'est-1', status: 'sent', brand: 'PEC', estimate_number: 102001,
      customer_name: 'Test Person', price: 5000, line_items: [], intake: {},
      created_at: '2026-08-01T00:00:00Z', sent_at: '2026-08-02T00:00:00Z',
    };
    const brand = { business_name: 'Prescott Epoxy Company', accent_color: '#D8531C' };
    const html = _internals.estimatePage(est, brand, {
      warranty: { sections: [], pdfPath: 'w.pdf', source: 'live' },
      literature: { sections: [{ id: 'l1', kind: 'why_us', title: 'Why us', body: 'Because.', images: [] }], reviews: [] },
    }).body;
    const iWarranty = html.indexOf('View or download our warranty (PDF)');
    const iLiterature = html.indexOf('Why us');
    const iPrintBtn = html.indexOf('Print / Save as PDF');
    const iTerms = html.indexOf('termsbox');
    ok(iWarranty > 0 && iLiterature > 0 && iPrintBtn > 0, 'page renders all three markers');
    ok(iWarranty > iLiterature, 'warranty renders AFTER the literature');
    ok(iWarranty < iPrintBtn, 'warranty renders before the print button');
    ok(iTerms < 0 || iWarranty > iTerms, 'warranty no longer pinned to the terms');
  }

  // ---- Accept path: created customer carries estimates.lead_source ----------
  {
    state.posts = {};
    state.customersFound = [];
    const est = {
      id: '11111111-1111-1111-1111-111111111111', status: 'accepted', brand: 'PEC',
      estimate_number: 102002, customer_name: 'Jane Doe', customer_first_name: 'Jane',
      customer_last_name: 'Doe', customer_email: 'jane@example.com', customer_phone: '9285551212',
      lead_source: 'Facebook', price: 4200, line_items: [], intake: {},
    };
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    try { await _internals.ensureJobCreated(est); } catch (_) { /* downstream stubs are partial; the customer POST is what we assert */ }
    global.fetch = realFetch;
    const custPosts = state.posts.customers || [];
    ok(custPosts.length === 1, 'accept created exactly one customer');
    ok(custPosts[0] && custPosts[0].lead_source === 'Facebook', 'created customer carries estimates.lead_source');
  }

  console.log(`warranty-pdf: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
