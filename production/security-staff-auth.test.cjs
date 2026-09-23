const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(options = {}) {
  const calls = [];
  const user = options.user === undefined ? { id: 'fixture-user' } : options.user;
  const staff = options.staff === undefined ? { id: 'fixture-staff', auth_user_id: 'fixture-user', role: 'admin' } : options.staff;
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const isUser = url.endsWith('/auth/v1/user');
    const value = isUser ? user : staff;
    return {
      ok: !(isUser ? options.userFailure : options.rpcFailure),
      status: (isUser ? options.userFailure : options.rpcFailure) ? 403 : 200,
      headers: { get: () => 'application/json' },
      text: async () => 'fixture failure',
      json: async () => value,
    };
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../netlify/functions/_pec-supabase.cjs'), 'utf8'), {
    module, exports: module.exports, require, fetch, AbortController, setTimeout, clearTimeout, Buffer,
    process: { env: { SUPABASE_URL: 'https://database.invalid', SUPABASE_SERVICE_ROLE_KEY: 'server-fixture' } },
    console,
  });
  return { helper: module.exports, calls };
}
const event = { headers: { authorization: 'Bearer signed-user-fixture' } };

test('staff authorization forwards the caller JWT into the session RPC', async () => {
  const { helper, calls } = fixture();
  const result = await helper.requireStaff(event);
  assert.equal(result.ok, true);
  assert.equal(result.staff.id, 'fixture-staff');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://database.invalid/rest/v1/rpc/pec_staff_session');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer signed-user-fixture');
  assert.equal(calls[1].init.headers.apikey, 'server-fixture');
  assert.equal(calls[1].init.body, '{}');
});

test('revoked or removed sessions fail closed even when Auth accepts the JWT', async () => {
  const { helper } = fixture({ staff: null });
  const result = await helper.requireStaff(event);
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('the staff RPC cannot substitute a different identity', async () => {
  const { helper } = fixture({ staff: { id: 'other-staff', auth_user_id: 'different-user', role: 'admin' } });
  assert.equal((await helper.requireStaff(event)).ok, false);
});

test('missing migration or unavailable authorization fails closed', async () => {
  const { helper } = fixture({ rpcFailure: true });
  const result = await helper.requireStaff(event);
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
});

test('anonymous identities and invalid Auth responses cannot reach the database gate', async () => {
  for (const options of [{ user: { id: 'fixture-user', is_anonymous: true } }, { userFailure: true }, { user: null }]) {
    const { helper, calls } = fixture(options);
    assert.equal((await helper.requireStaff(event)).status, 401);
    assert.equal(calls.length, 1);
  }
});

test('admin-only endpoints retain their stricter role gate', async () => {
  const { helper } = fixture({ staff: { id: 'fixture-staff', auth_user_id: 'fixture-user', role: 'pm' } });
  assert.equal((await helper.requireStaff(event)).ok, true);
  assert.equal((await helper.requireStaff(event, { adminOnly: true })).status, 403);
});

test('missing bearer token does not make network requests', async () => {
  const { helper, calls } = fixture();
  assert.equal((await helper.requireStaff({ headers: {} })).status, 401);
  assert.equal(calls.length, 0);
});

test('advertiser identity never grants operational server access', async () => {
  const { helper } = fixture({ staff: { id: 'fixture-staff', auth_user_id: 'fixture-user', role: 'advertiser' } });
  assert.equal((await helper.requireStaff(event)).status, 403);
  assert.equal((await helper.requireStaff(event, { adminOnly: true })).status, 403);
});
