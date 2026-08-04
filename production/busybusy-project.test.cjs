// Fixture tests for the BusyBusy project auto-creation (prompt 68), driving
// the REAL modules: the payload builder and orchestrator from
// netlify/functions/_pec-busybusy.cjs directly, and the REAL ensureJobCreated
// from pec-public-estimate.cjs with _pec-supabase mocked through the require
// cache (the estimate15b harness convention), so the survives-a-failing-hook
// proof exercises the actual accept path, not a reimplementation.
// Run: node production/busybusy-project.test.cjs
'use strict';

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}

const { buildBusybusyProjectPayload, maybeCreateBusybusyProject } = require('../netlify/functions/_pec-busybusy.cjs');

// ---------------------------------------------------------------------------
// 1) Payload builder fixtures
// ---------------------------------------------------------------------------
console.log('# payload builder');
{
  const residential = buildBusybusyProjectPayload({
    estimateNumber: 102047, customerName: 'Tom Bechtel',
    address1: '4744 Sharp Shooter Way', city: 'Prescott', state: 'AZ', zip: '86301',
    phone: '(702) 281-3194', radius: 200, reminders: false, isCallback: false, topcoatJobId: 'prod-1',
  });
  ok(residential.title === 'Tom Bechtel' && residential.customer === 'Tom Bechtel',
    'residential: title and customer are the stored name, exactly');
  ok(residential.project_number === '102047', 'residential: project_number is the estimate digits');
  ok(residential.address_1 === '4744 Sharp Shooter Way' && residential.city === 'Prescott'
    && residential.state === 'AZ' && residential.postal_code === '86301' && residential.phone === '(702) 281-3194',
    'residential: full address + phone mapped to BusyBusy field names');
  ok(residential.radius === 200 && residential.reminders === false && residential.onsite_verification === 'none',
    'residential: radius kept, reminders off, onsite_verification none');
  ok(residential.topcoat_job_id === 'prod-1' && residential.estimate_number === 102047,
    'residential: traceability fields ride along');

  const business = buildBusybusyProjectPayload({
    estimateNumber: 'EST-102050', customerName: 'Haley Construction',
    address1: '1100 Sheldon St', city: 'Prescott', state: 'AZ', zip: '86305',
    isCallback: false,
  });
  ok(business.title === 'Haley Construction', 'business: title is the business name as stored (no EST number in it)');
  ok(business.project_number === '102050', 'business: digits extracted from a formatted estimate number');
  ok(business.radius === 150, 'business: radius defaults to 150 when unset');

  const noAddress = buildBusybusyProjectPayload({ estimateNumber: 102051, customerName: 'Lisa Santana', isCallback: false });
  ok(noAddress !== null && noAddress.title === 'Lisa Santana', 'no address: payload still builds (project without geofence beats no project)');
  ok(noAddress.address_1 === null && noAddress.city === null && noAddress.postal_code === null && noAddress.phone === null,
    'no address: address fields are null, never empty strings or "undefined"');

  ok(buildBusybusyProjectPayload({ estimateNumber: 102052, customerName: 'Mark Thorn', isCallback: true }) === null,
    'callback job: NO payload (touch-up hours belong to the original job)');
  ok(buildBusybusyProjectPayload({ estimateNumber: 102053, customerName: '   ', isCallback: false }) === null,
    'no customer name: NO payload (an unnamed clock-in project would collect orphan hours)');
  ok(buildBusybusyProjectPayload({ estimateNumber: null, customerName: 'No Number Yet', isCallback: false }).project_number === null,
    'unnumbered estimate: project_number null (name-keyed), not "" and not "null"');
  ok(buildBusybusyProjectPayload({ estimateNumber: 1, customerName: 'X Y', radius: 40, isCallback: false }).radius === 150,
    'radius below the BusyBusy minimum (100) falls back to the 150 default');
}

// ---------------------------------------------------------------------------
// Shared stub plumbing for the orchestrator tests
// ---------------------------------------------------------------------------
function makeStub({ settingsRows, existingProjects, fetchImpl }) {
  const calls = { gets: [], posts: [], fetches: 0 };
  const projects = (existingProjects || []).slice();
  const sb = async (method, path, body) => {
    if (method === 'GET' && path.startsWith('/settings')) { calls.gets.push(path); return settingsRows || []; }
    if (method === 'GET' && path.startsWith('/pec_prod_busybusy_projects')) { calls.gets.push(path); return projects.length ? [{ id: 'bb-1' }] : []; }
    if (method === 'POST' && path.startsWith('/pec_prod_busybusy_projects')) { calls.posts.push(body); projects.push(body); return [body]; }
    // Everything else the accept path touches: tolerant defaults.
    if (method === 'GET') return [];
    if (method === 'POST') return [Object.assign({ id: (body && body.id) || 'gen-' + calls.posts.length }, Array.isArray(body) ? {} : body)];
    return [body];
  };
  const fetchFn = async (...args) => { calls.fetches++; return fetchImpl(...args); };
  return { sb, fetchFn, calls, projects };
}

const EST = {
  id: 'est-1', estimate_number: 102047, customer_name: 'Tom Bechtel',
  customer_address1: '4744 Sharp Shooter Way', customer_city: 'Prescott',
  customer_state: 'AZ', customer_zip: '86301', customer_phone: '(702) 281-3194',
  lead_id: null,
};
const ENV = { ZAPIER_BUSYBUSY_HOOK_URL: 'https://hooks.zapier.example/catch/1/abc', ZAPIER_BUSYBUSY_HOOK_SECRET: 's3cret' };

// ---------------------------------------------------------------------------
// 2) Orchestrator: gates, idempotency, secret
// ---------------------------------------------------------------------------
(async () => {
  console.log('# orchestrator gates');
  {
    const { sb, fetchFn, calls } = makeStub({ fetchImpl: async () => ({ status: 200 }) });
    const r = await maybeCreateBusybusyProject({ sb, fetchFn, env: {}, est: EST, prodJobId: 'prod-1' });
    ok(r.skipped === 'unconfigured' && calls.gets.length === 0 && calls.fetches === 0,
      'no hook env var: clean no-op, zero reads, zero network');
  }
  {
    const { sb, fetchFn, calls } = makeStub({
      settingsRows: [{ key: 'busybusy_autocreate_enabled', value: 'false' }],
      fetchImpl: async () => ({ status: 200 }),
    });
    const r = await maybeCreateBusybusyProject({ sb, fetchFn, env: ENV, est: EST, prodJobId: 'prod-1' });
    ok(r.skipped === 'disabled' && calls.posts.length === 0 && calls.fetches === 0,
      'settings switch off: gated before any row or network call');
  }
  {
    const { sb, fetchFn, calls } = makeStub({ fetchImpl: async () => ({ status: 200 }) });
    const r = await maybeCreateBusybusyProject({ sb, fetchFn, env: ENV, est: { ...EST, customer_name: '' }, prodJobId: 'prod-1' });
    ok(r.skipped === 'no-payload' && calls.posts.length === 0, 'builder refusal (no name) stops the orchestrator too');
  }

  console.log('# idempotency: same job twice = one payload, one row');
  {
    const stub = makeStub({ fetchImpl: async (url, opts) => ({ status: 200, _body: opts.body }) });
    const r1 = await maybeCreateBusybusyProject({ sb: stub.sb, fetchFn: stub.fetchFn, env: ENV, est: EST, prodJobId: 'prod-1' });
    const r2 = await maybeCreateBusybusyProject({ sb: stub.sb, fetchFn: stub.fetchFn, env: ENV, est: EST, prodJobId: 'prod-1' });
    ok(r1.posted === true && r2.skipped === 'exists', 'first run posts, second run skips on the existing row');
    ok(stub.calls.posts.length === 1 && stub.calls.fetches === 1, 'exactly ONE pec_prod_busybusy_projects insert and ONE hook POST');
    ok(stub.calls.posts[0].project_number === '102047' && stub.calls.posts[0].project_name === 'Tom Bechtel'
      && stub.calls.posts[0].job_id === 'prod-1', 'the local link row carries number, name, and job id');
    ok(!('linked_at' in stub.calls.posts[0]) && !('linked_by' in stub.calls.posts[0]),
      'pending state = linked_by/linked_at left null (the existing nullable convention, no new column)');
  }

  console.log('# secret rides in header AND body');
  {
    let seen = null;
    const stub = makeStub({ fetchImpl: async (url, opts) => { seen = opts; return { status: 200 }; } });
    await maybeCreateBusybusyProject({ sb: stub.sb, fetchFn: stub.fetchFn, env: ENV, est: EST, prodJobId: 'prod-1' });
    ok(seen.headers['x-topcoat-secret'] === 's3cret' && JSON.parse(seen.body).secret === 's3cret',
      'shared secret present in the x-topcoat-secret header and the body field');
    ok(JSON.parse(seen.body).title === 'Tom Bechtel' && JSON.parse(seen.body).project_number === '102047',
      'hook body is the builder payload');
  }

  // -------------------------------------------------------------------------
  // 3) THE test: the accept path survives a failing hook. Drives the REAL
  //    ensureJobCreated with _pec-supabase mocked through the require cache.
  // -------------------------------------------------------------------------
  console.log('# accept path survives a failing hook (real ensureJobCreated)');
  {
    const sbCalls = { posts: {} };
    const tolerantSb = async (method, path, body) => {
      const table = path.replace(/^\//, '').split('?')[0];
      if (method === 'GET' && table === 'settings') {
        return [{ key: 'busybusy_autocreate_enabled', value: 'true' }, { key: 'busybusy_autocreate_radius_m', value: '150' }];
      }
      if (method === 'GET') return [];
      if (method === 'POST') {
        sbCalls.posts[table] = (sbCalls.posts[table] || 0) + 1;
        const row = Array.isArray(body) ? body[0] : body;
        return [Object.assign({ id: (row && row.id) || 'gen' }, row)];
      }
      return [Array.isArray(body) ? body[0] : body];
    };
    const supaPath = require.resolve('../netlify/functions/_pec-supabase.cjs');
    const realSupa = require(supaPath);
    require.cache[supaPath].exports = Object.assign({}, realSupa, { sb: tolerantSb });
    delete require.cache[require.resolve('../netlify/functions/_pec-busybusy.cjs')];
    delete require.cache[require.resolve('../netlify/functions/pec-public-estimate.cjs')];
    // _pec-installments / _pec-financing also read _pec-supabase; drop them so
    // they re-require the mocked sb too.
    for (const m of ['../netlify/functions/_pec-installments.cjs', '../netlify/functions/_pec-financing.cjs']) {
      try { delete require.cache[require.resolve(m)]; } catch (_) {}
    }
    const { _internals } = require('../netlify/functions/pec-public-estimate.cjs');

    process.env.ZAPIER_BUSYBUSY_HOOK_URL = 'https://hooks.zapier.example/catch/1/abc';
    const realFetch = global.fetch;
    const fullEst = { ...EST, price: 4200, line_items: [], intake: {}, customer_email: 'tom@example.com' };

    try {
      // Rejected fetch (network down / DNS dead).
      global.fetch = async () => { throw new Error('ECONNREFUSED (simulated)'); };
      const r1 = await _internals.ensureJobCreated(fullEst);
      ok(!!(r1 && r1.jobId && r1.prodJobId), 'rejected fetch: acceptance still returns jobId + prodJobId (job created)');
      ok(sbCalls.posts.jobs === 1 && sbCalls.posts.pec_prod_jobs === 1, 'rejected fetch: BOTH job rows were written');

      // 500 from the hook.
      sbCalls.posts = {};
      global.fetch = async () => ({ status: 500, ok: false });
      const r2 = await _internals.ensureJobCreated({ ...fullEst, id: 'est-2', estimate_number: 102048 });
      ok(!!(r2 && r2.jobId && r2.prodJobId), 'hook 500: acceptance still returns jobId + prodJobId');
      ok(sbCalls.posts.jobs === 1 && sbCalls.posts.pec_prod_jobs === 1, 'hook 500: BOTH job rows were written');
      ok(sbCalls.posts.pec_prod_busybusy_projects === 1, 'hook 500: the pending link row still exists for the human/importer to see');
    } finally {
      global.fetch = realFetch;
      delete process.env.ZAPIER_BUSYBUSY_HOOK_URL;
      require.cache[supaPath].exports = realSupa;
      delete require.cache[require.resolve('../netlify/functions/pec-public-estimate.cjs')];
      delete require.cache[require.resolve('../netlify/functions/_pec-busybusy.cjs')];
    }
  }

  console.log(`${passed + failed === 0 ? 0 : passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
