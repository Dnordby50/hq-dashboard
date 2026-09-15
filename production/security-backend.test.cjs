// Defensive access-control regressions. Every identity/credential/record is
// synthetic, and every network boundary is mocked. Run with node --test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const configuredEnv = {
  MCP_OAUTH_CLIENT_ID_V2: 'fixture-client',
  MCP_OAUTH_CLIENT_SECRET_V2: 'fixture-secret',
  MCP_BEARER_TOKEN_V2: 'fixture-bearer',
  COMPANYCAM_API_TOKEN: 'fixture-camera',
  SUPABASE_URL: 'https://database.invalid',
};
function load(name, { overrides = {}, fetch = async () => { throw new Error('Unexpected network call'); }, env = configuredEnv } = {}) {
  const filename = path.join(root, 'netlify/functions', name);
  const module = { exports: {} };
  const nativeRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, require: name => Object.hasOwn(overrides, name) ? overrides[name] : nativeRequire(name),
    process: { env }, Buffer, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch, console: { log() {}, warn() {}, error() {} }, __filename: filename, __dirname: path.dirname(filename),
  }, { filename });
  return module.exports;
}
function request(route, method = 'POST', body = '', headers = {}) {
  return { path: route, httpMethod: method, headers: { host: 'example.invalid', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) };
}
const form = values => new URLSearchParams(values).toString();
const jsonResponse = data => ({ ok: true, status: 200, json: async () => data });

test('MCP anonymous registration and interactive authorization are denied without credentials or redirects', async () => {
  const { handler } = load('mcp.cjs');
  for (const route of ['/register', '/oauth/authorize']) {
    for (const method of ['GET', 'POST']) {
      const res = await handler(request(route, method, { token_endpoint_auth_method: 'client_secret_post' }));
      assert.equal(res.statusCode, 403);
      assert.equal(res.headers.Location, undefined);
      assert.equal(res.headers['Cache-Control'], 'no-store');
      const body = JSON.parse(res.body);
      for (const field of ['client_secret', 'access_token', 'refresh_token', 'code']) assert.equal(body[field], undefined);
    }
  }
});

test('MCP discovery advertises provisioned credentials only', async () => {
  const { handler } = load('mcp.cjs');
  const res = await handler(request('/.well-known/oauth-authorization-server', 'GET'));
  const metadata = JSON.parse(res.body);
  assert.deepEqual(metadata.grant_types_supported, ['client_credentials']);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['client_secret_basic', 'client_secret_post']);
  assert.equal(metadata.registration_endpoint, undefined);
  assert.equal(metadata.authorization_endpoint, undefined);
});

test('MCP rejects anonymous, partial and incorrect provisioned credentials', async () => {
  const { handler } = load('mcp.cjs');
  for (const credentials of [{}, { client_id: 'fixture-client' }, { client_secret: 'fixture-secret' },
    { client_id: 'different-client', client_secret: 'fixture-secret' }, { client_id: 'fixture-client', client_secret: 'different-secret' }]) {
    const res = await handler(request('/oauth/token', 'POST', form({ grant_type: 'client_credentials', ...credentials })));
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).access_token, undefined);
  }
  const res = await handler(request('/oauth/token', 'POST', form({ grant_type: 'client_credentials', client_id: 'fixture-client', client_secret: 'fixture-secret' }),
    { authorization: 'Basic ' + Buffer.from('fixture-client:').toString('base64') }));
  assert.equal(res.statusCode, 401, 'Do not combine partial Basic credentials with form credentials');
});

test('MCP refuses retired code/refresh grants and malformed request bodies', async () => {
  const { handler } = load('mcp.cjs');
  for (const grant_type of ['authorization_code', 'refresh_token', 'password', '']) {
    const res = await handler(request('/oauth/token', 'POST', form({ grant_type, client_id: 'fixture-client', client_secret: 'fixture-secret' })));
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).access_token, undefined);
  }
  const malformed = await handler(request('/oauth/token', 'POST', 'grant_type=%'));
  assert.equal(malformed.statusCode, 400);
});

test('MCP configured clients can use Basic and form credentials; missing server configuration fails closed', async () => {
  const { handler } = load('mcp.cjs');
  const cases = [
    request('/oauth/token', 'POST', form({ grant_type: 'client_credentials', client_id: 'fixture-client', client_secret: 'fixture-secret' })),
    request('/oauth/token', 'POST', form({ grant_type: 'client_credentials' }), { authorization: 'Basic ' + Buffer.from('fixture-client:fixture-secret').toString('base64') }),
  ];
  for (const event of cases) {
    const res = await handler(event);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    const body = JSON.parse(res.body);
    assert.equal(body.access_token, 'fixture-bearer');
    assert.equal(body.token_type, 'Bearer');
    assert.equal(body.refresh_token, undefined);
    assert.equal(body.expires_in, undefined, 'Static bearer must not claim an unenforced expiry');
  }
  const unavailable = await load('mcp.cjs', { env: {} }).handler(cases[0]);
  assert.equal(unavailable.statusCode, 503);
  assert.equal(JSON.parse(unavailable.body).access_token, undefined);
});

test('MCP direct configured bearer access still works and missing/wrong bearer is rejected', async () => {
  const { handler } = load('mcp.cjs');
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  for (const authorization of ['', 'Bearer different-bearer']) {
    const res = await handler(request('/mcp', 'POST', rpc, { authorization }));
    assert.equal(res.statusCode, 401);
  }
  const res = await handler(request('/mcp', 'POST', rpc, { authorization: 'Bearer fixture-bearer' }));
  assert.equal(res.statusCode, 200);
  assert.ok(JSON.parse(res.body).result.tools.some(t => t.name === 'find_customers'));
});

for (const gate of [{ ok: false, status: 401, error: 'Not authenticated' }, { ok: false, status: 403, error: 'Staff only' }, { ok: false, status: 403, error: 'Login revoked' }, { ok: false, status: 500, error: 'Authorization unavailable' }]) {
  test(`CompanyCam denies shared staff gate ${gate.error} before third-party data access`, async () => {
    let checks = 0;
    const { handler } = load('pec-companycam.cjs', { overrides: { './_pec-supabase.cjs': { requireStaff: async () => { checks++; return gate; } } } });
    const res = await handler(request('/.netlify/functions/pec-companycam', 'GET'));
    assert.equal(checks, 1);
    assert.equal(JSON.parse(res.body).error, 'Not authorized');
    assert.deepEqual(JSON.parse(res.body).projects, []);
  });
  test(`Estimate preview denies shared staff gate ${gate.error} before private reads`, async () => {
    let checks = 0;
    const { handler } = load('pec-public-estimate.cjs', { overrides: { './_pec-supabase.cjs': {
      requireStaff: async () => { checks++; return gate; }, sb: async () => { throw new Error('Unauthorized private read'); },
    } } });
    const res = await handler({ ...request('/.netlify/functions/pec-public-estimate', 'GET'), queryStringParameters: { preview: '11111111-1111-4111-8111-111111111111' } });
    assert.equal(checks, 1);
    assert.equal(res.statusCode, gate.status);
  });
}

test('CompanyCam authorized staff can still read projects and photos', async () => {
  const calls = [];
  const { handler } = load('pec-companycam.cjs', {
    overrides: { './_pec-supabase.cjs': { requireStaff: async () => ({ ok: true, user: { id: 'staff-fixture' } }) } },
    fetch: async (url, options) => { calls.push({ url, options }); return jsonResponse(url.includes('/photos?')
      ? [{ id: 'photo-fixture', uris: [{ type: 'web', uri: 'https://example.invalid/photo.jpg' }] }]
      : [{ id: 'project-fixture', name: 'Fixture project', address: { city: 'Fixture city' } }]); },
  });
  const projects = await handler(request('/.netlify/functions/pec-companycam', 'GET'));
  assert.equal(JSON.parse(projects.body).projects[0].name, 'Fixture project');
  const photos = await handler({ ...request('/.netlify/functions/pec-companycam', 'GET'), queryStringParameters: { action: 'photos', project_id: 'project-fixture' } });
  assert.equal(JSON.parse(photos.body).photos[0].url, 'https://example.invalid/photo.jpg');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.options.headers.Authorization === 'Bearer fixture-camera'));
});

test('Estimate preview authorized staff retains private lookup; public invalid-token requests do not require staff', async () => {
  let checks = 0;
  const reads = [];
  const { handler } = load('pec-public-estimate.cjs', { overrides: { './_pec-supabase.cjs': {
    requireStaff: async () => { checks++; return { ok: true, user: { id: 'staff-fixture' } }; },
    sb: async (method, route) => { reads.push(route); return []; }, tokenFromEvent: () => 'invalid',
  } } });
  const res = await handler({ ...request('/.netlify/functions/pec-public-estimate', 'GET'), queryStringParameters: { preview: '11111111-1111-4111-8111-111111111111' } });
  assert.equal(checks, 1);
  assert.equal(res.statusCode, 404, 'A missing synthetic estimate retains the existing not-found response');
  assert.ok(reads.some(p => p.startsWith('/estimates?id=eq.')));
  const publicResult = await handler({ ...request('/e/invalid', 'GET'), queryStringParameters: {} });
  assert.equal(publicResult.statusCode, 404);
  assert.equal(checks, 1, 'Customer token route does not gain a staff login requirement');
});

const crypto = require('node:crypto');
const googleEnv = { ...configuredEnv, GOOGLE_OAUTH_CLIENT_ID: 'fixture-google-client', GOOGLE_OAUTH_CLIENT_SECRET: 'fixture-google-secret' };
const staffIdentity = (role = 'office', id = 'fixture-user') => ({ ok: true, user: { id }, staff: { id: 'fixture-staff', role } });
function googleFixture({ role = 'office', owner = 'another-user', permission, failRead = false } = {}) {
  const reads = [], writes = [];
  const member = { id: 'fixture-member', name: 'Fixture rep', auth_user_id: owner, google_connected: true, google_calendar_id: 'fixture-topcoat' };
  const db = async (method, route, payload) => {
    if (method !== 'GET') { writes.push({ method, route, payload }); return [{ id: 'fixture-calendar' }]; }
    reads.push(route);
    if (failRead) throw new Error('Fixture unavailable');
    if (route.startsWith('/pec_sales_team_members?')) return [member];
    if (route.startsWith('/user_permissions?')) return permission === undefined ? [] : [{ can_manage_settings: permission }];
    if (route.startsWith('/pec_sales_member_google_calendars?')) return [{ id: 'fixture-calendar' }];
    return [];
  };
  const google = load('_pec-google.cjs', { env: googleEnv, overrides: { './_pec-supabase.cjs': { requireStaff: async () => staffIdentity(role) } } });
  return { google, db, reads, writes, member };
}

test('Google staff identity goes through the shared current-session gate', async () => {
  let checks = 0;
  const google = load('_pec-google.cjs', { overrides: { './_pec-supabase.cjs': { requireStaff: async () => { checks++; return { ok: false, status: 403 }; } } } });
  assert.equal(await google.getStaffUser(request('/')), null);
  assert.equal(checks, 1);
});

test('Google calendar member authorization permits self, admins and explicitly authorized Settings managers', async () => {
  for (const opts of [{ owner: 'fixture-user', permission: false }, { role: 'admin', permission: false }, { permission: true }]) {
    const f = googleFixture(opts);
    const user = await f.google.getStaffUser(request('/'));
    const result = await f.google.authorizeCalendarMember(f.db, user, f.member.id);
    assert.equal(result.ok, true);
    assert.equal(result.member.id, f.member.id);
  }
});

test('Google calendar member authorization denies absent/false permissions and failed reads', async () => {
  for (const opts of [{}, { permission: false }, { permission: 'true' }, { failRead: true }]) {
    const f = googleFixture(opts);
    const user = await f.google.getStaffUser(request('/'));
    const result = await f.google.authorizeCalendarMember(f.db, user, f.member.id);
    assert.equal(result.ok, false);
    assert.equal(result.status, opts.failRead ? 503 : 403);
    assert.equal(f.writes.length, 0);
  }
});

for (const filename of ['pec-google-oauth-start.cjs', 'pec-google-disconnect.cjs', 'pec-google-calendars.cjs']) {
  test(`${filename} rejects another member before obtaining or changing Google credentials`, async () => {
    const f = googleFixture({ permission: false });
    let credentialActions = 0;
    const forbidden = () => { credentialActions++; throw new Error('Unauthorized credential operation'); };
    const { handler } = load(filename, { env: googleEnv, overrides: {
      './_pec-supabase.cjs': { sb: f.db },
      './_pec-google.cjs': { ...f.google, consentUrl: forbidden, getTokenRow: forbidden, revokeToken: forbidden, getFreshAccessToken: forbidden, gcalFetch: forbidden },
    } });
    const res = await handler(request('/fixture', 'POST', { sales_member_id: f.member.id, member_id: f.member.id, calendar_id: 'fixture-personal', sync_enabled: false }));
    assert.equal(res.statusCode, 403);
    assert.equal(credentialActions, 0);
    assert.equal(f.writes.length, 0);
  });
}

test('Google self connection and authorized calendar toggle retain their existing response contracts', async () => {
  const f = googleFixture({ owner: 'fixture-user', permission: false });
  const overrides = { './_pec-supabase.cjs': { sb: f.db }, './_pec-google.cjs': f.google };
  const start = await load('pec-google-oauth-start.cjs', { env: googleEnv, overrides }).handler(request('/fixture', 'POST', { sales_member_id: f.member.id }));
  assert.equal(start.statusCode, 200);
  assert.equal(new URL(JSON.parse(start.body).url).hostname, 'accounts.google.com');
  const toggle = await load('pec-google-calendars.cjs', { env: googleEnv, overrides }).handler(request('/fixture', 'POST', { member_id: f.member.id, calendar_id: 'fixture-personal', sync_enabled: false }));
  assert.equal(toggle.statusCode, 200);
  assert.equal(JSON.parse(toggle.body).sync_enabled, false);
  assert.equal(f.writes.length, 1);
});

function signedWebhook(provider, timestamp, { body, version, secretHeader = false, legacy = false } = {}) {
  const payload = body || JSON.stringify({ type: 'fixture.ignored', created_at: '2020-01-01T00:00:00Z', data: {} });
  const key = Buffer.from('fixture-webhook-secret');
  const env = { ...configuredEnv, RESEND_WEBHOOK_SECRET: 'whsec_' + key.toString('base64'), QUO_WEBHOOK_SECRET: key.toString('base64'), ...(legacy ? { QUO_ALLOW_SHARED_SECRET_WEBHOOK: 'true' } : {}) };
  const headers = provider === 'resend'
    ? { 'svix-id': 'fixture-event', 'svix-timestamp': String(timestamp), 'svix-signature': `${version || 'v1'},` + crypto.createHmac('sha256', key).update(`fixture-event.${timestamp}.${payload}`).digest('base64') }
    : secretHeader ? { 'x-quo-secret': env.QUO_WEBHOOK_SECRET }
    : { 'openphone-signature': `hmac;${version || '1'};${timestamp};` + crypto.createHmac('sha256', key).update(`${timestamp}.${payload}`).digest('base64') };
  const json = (statusCode, data) => ({ statusCode, body: JSON.stringify(data) });
  const handler = load(`pec-webhook-${provider}.cjs`, { env, overrides: { './_pec-supabase.cjs': { json, sb: async () => { throw new Error('Ignored fixture must not write data'); } } } }).handler;
  return { handler, event: request('/fixture', 'POST', payload, headers) };
}

for (const provider of ['resend', 'quo']) {
  test(`${provider} rejects stale/future/malformed signed timestamps and accepts a fresh delivery of an older event`, async () => {
    const units = provider === 'resend' ? 1000 : 1;
    for (const shift of [-600000, 600000]) {
      const f = signedWebhook(provider, Math.floor((Date.now() + shift) / units));
      assert.equal((await f.handler(f.event)).statusCode, 401);
    }
    for (const stamp of ['NaN', '', '123junk']) {
      const f = signedWebhook(provider, stamp);
      assert.equal((await f.handler(f.event)).statusCode, 401);
    }
    const fresh = signedWebhook(provider, Math.floor(Date.now() / units));
    assert.equal((await fresh.handler(fresh.event)).statusCode, 200);
    const base64 = { ...fresh.event, isBase64Encoded: true, body: Buffer.from(fresh.event.body).toString('base64') };
    assert.equal((await fresh.handler(base64)).statusCode, 200);
    const badBody = { ...fresh.event, body: fresh.event.body + ' ' };
    assert.equal((await fresh.handler(badBody)).statusCode, 401, 'Verification uses exact raw bytes');
    const wrongVersion = signedWebhook(provider, Math.floor(Date.now() / units), { version: 'unsupported' });
    assert.equal((await wrongVersion.handler(wrongVersion.event)).statusCode, 401);
  });
}

test('Quo accepts signed second timestamps and requires explicit opt-in for legacy plain-secret deliveries', async () => {
  const seconds = signedWebhook('quo', Math.floor(Date.now() / 1000));
  assert.equal((await seconds.handler(seconds.event)).statusCode, 200);
  const plain = signedWebhook('quo', Date.now(), { secretHeader: true });
  assert.equal((await plain.handler(plain.event)).statusCode, 401);
  const legacy = signedWebhook('quo', Date.now(), { secretHeader: true, legacy: true });
  assert.equal((await legacy.handler(legacy.event)).statusCode, 200);
});

function busybusyFixture(baseUrl) {
  const calls = [];
  const { handler } = load('pec-busybusy-export.cjs', {
    env: { ...configuredEnv, BUSYBUSY_EXPORT_TOKEN: 'fixture-export' },
    overrides: { './_pec-supabase.cjs': {
      requireStaff: async (_event, opts) => { assert.equal(opts.adminOnly, true); return staffIdentity('admin'); },
      json: (statusCode, body) => ({ statusCode, body: JSON.stringify(body) }),
      sb: async (method, route) => route.startsWith('/settings?') ? [{ key: 'busybusy_export_base_url', value: baseUrl }] : [],
    } },
    fetch: async (url, options) => { calls.push({ url, options }); return { status: 404, ok: false }; },
  });
  return { calls, run: () => handler(request('/fixture', 'POST', { mode: 'preview', start: '2026-01-01', end: '2026-01-02' })) };
}

test('BusyBusy configured URL cannot send credentials to an untrusted destination', async () => {
  for (const url of ['http://export.busybusy.io/', 'https://other.invalid/', 'https://export.busybusy.io.other.invalid/', 'https://user:pass@export.busybusy.io/', 'https://export.busybusy.io:444/', 'https://export.busybusy.io/?redirect=other', 'https://export.busybusy.io/#fragment', 'http://127.0.0.1/', 'not-a-url']) {
    const f = busybusyFixture(url);
    const res = await f.run();
    assert.equal(res.statusCode, 502, url);
    assert.equal(f.calls.length, 0, url);
  }
});

test('BusyBusy approved HTTPS destination retains date parameters and never follows redirects with credentials', async () => {
  const f = busybusyFixture('https://export.busybusy.io/');
  const res = await f.run();
  assert.equal(res.statusCode, 200);
  assert.equal(f.calls.length, 1);
  const target = new URL(f.calls[0].url);
  assert.equal(target.hostname, 'export.busybusy.io');
  assert.equal(target.searchParams.get('start'), '2026-01-01 00:00:00');
  assert.equal(target.searchParams.get('end'), '2026-01-02 23:59:59');
  assert.equal(f.calls[0].options.redirect, 'error');
  assert.equal(f.calls[0].options.headers['Key-Authorization'], 'fixture-export');
});

function invoiceFixture({ rateFailure = false, initialAllowed = true } = {}) {
  let claimed = !initialAllowed;
  const sends = [], reservations = [];
  const { handler } = load('pec-invoice-intent.cjs', {
    env: { ...configuredEnv, RESEND_API_KEY: 'fixture-email', SLACK_OFFICE_WEBHOOK: 'https://slack.invalid/fixture' },
    overrides: { './_pec-supabase.cjs': { sb: async (method, route, payload) => {
      if (route.startsWith('/pec_job_ar?')) return [{ id: 'fixture-invoice', customer_name: 'Fixture customer', balance_remaining: 100 }];
      if (route === '/rpc/pec_take_rate_limit') {
        reservations.push(payload);
        if (rateFailure) throw new Error('Fixture database unavailable');
        const allowed = !claimed; claimed = true;
        return { allowed, retry_after: allowed ? 0 : 300 };
      }
      if (route.startsWith('/pec_email_senders?')) return [{ from_email: 'office@example.invalid' }];
      throw new Error('Unexpected database request');
    } } },
    fetch: async (url, options) => { sends.push({ url, options }); return { ok: true }; },
  });
  return { sends, reservations, run: method => handler(request('/fixture', 'POST', { token: '11111111-1111-4111-8111-111111111111', method: method || 'check' })) };
}

test('Invoice notification reserves one persistent allowance across concurrent calls and payment methods', async () => {
  const f = invoiceFixture();
  const results = await Promise.all([f.run('check'), f.run('cash'), f.run('zelle')]);
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 429, 429]);
  assert.equal(f.sends.length, 2, 'Only the winning request sends one email and one Slack notification');
  assert.equal(new Set(f.reservations.map(r => r.p_key)).size, 1);
  assert.ok(f.reservations.every(r => r.p_scope === 'invoice_intent' && r.p_limit === 1 && r.p_window_seconds === 300 && /^[0-9a-f]{64}$/.test(r.p_key)));
  assert.ok(results.filter(r => r.statusCode === 429).every(r => r.headers['Retry-After'] === '300'));
});

test('Invoice notification cooldown or unavailable durable guard sends nothing', async () => {
  for (const opts of [{ initialAllowed: false }, { rateFailure: true }]) {
    const f = invoiceFixture(opts);
    const res = await f.run();
    assert.equal(res.statusCode, opts.rateFailure ? 503 : 429);
    assert.equal(f.sends.length, 0);
  }
});

for (const filename of ['pec-public-estimate.cjs', 'pec-public-invoice.cjs', 'pec-public-change-order.cjs', 'pec-public-change-order-batch.cjs']) {
  test(`${filename} serves private customer pages with baseline response protections without changing iframe policy`, async () => {
    const { handler } = load(filename, { overrides: { './_pec-supabase.cjs': {
      tokenFromEvent: () => 'invalid', sb: async () => { throw new Error('Invalid token must not read data'); },
    } } });
    const response = await handler({ ...request('/fixture', 'GET'), queryStringParameters: {} });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(response.headers['Referrer-Policy'], 'no-referrer');
    assert.equal(response.headers['X-Frame-Options'], undefined);
    assert.equal(response.headers['Content-Security-Policy'], undefined);
  });
}

test('MCP retired credential configuration cannot restore access through headers, query strings or client credentials', async () => {
  const legacyEnv = { MCP_OAUTH_CLIENT_ID: 'retired-client', MCP_OAUTH_CLIENT_SECRET: 'retired-secret', MCP_BEARER_TOKEN: 'retired-bearer' };
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const events = [
    request('/mcp', 'POST', rpc, { authorization: 'Bearer retired-bearer' }),
    { ...request('/mcp', 'POST', rpc), queryStringParameters: { token: 'retired-bearer' } },
    request('/oauth/token', 'POST', form({ grant_type: 'client_credentials', client_id: 'retired-client', client_secret: 'retired-secret' })),
    request('/oauth/token', 'POST', form({ grant_type: 'client_credentials' }), { authorization: 'Basic ' + Buffer.from('retired-client:retired-secret').toString('base64') }),
  ];
  const unconfigured = load('mcp.cjs', { env: legacyEnv }).handler;
  for (const event of events) {
    const response = await unconfigured(event);
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.body).error, 'temporarily_unavailable');
    assert.equal(JSON.parse(response.body).access_token, undefined);
  }
  const rotated = load('mcp.cjs', { env: { ...legacyEnv, ...configuredEnv } }).handler;
  for (const event of events) assert.equal((await rotated(event)).statusCode, 401, 'Retired values remain invalid after new credentials are configured');
  assert.equal((await unconfigured(request('/.well-known/oauth-authorization-server', 'GET'))).statusCode, 200);
  assert.equal((await unconfigured(request('/register', 'POST'))).statusCode, 403);
  assert.equal((await unconfigured(request('/oauth/authorize', 'GET'))).statusCode, 403);
});
