const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../apps/estimator/node_modules/typescript');
const formatting = require('./estimate-formatting.cjs');

const source = fs.readFileSync(path.join(__dirname, '../apps/estimator/src/lib/lineTemplates.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const ID = '6a57ab20-75f7-4ed0-87bd-f88b5013c4a1';
const USER = '654f23c7-42d8-46c7-8e91-177a04363f3a';
const OTHER = '8b2b8c34-145d-44b1-8b73-0b16fe7b0847';
const DESCRIPTION = '  **{{area_name}} — {{sqft}} sqft**\n\n- Prepare concrete\n- Apply *epoxy* finish\n  ';
const input = (overrides = {}) => ({ id: ID, name: 'Garage floor', description: DESCRIPTION, createdBy: USER, ...overrides });
const record = (overrides = {}) => ({ id: ID, name: 'Garage floor', description: DESCRIPTION, active: true, created_by: USER, created_at: '2026-09-14T23:00:00Z', ...overrides });
const plain = value => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  const account = { ownerId: USER, sessionId: 'fixture-session', generation: 1 };
  const rows = (options.rows || []).map(row => ({ ...row }));
  const writes = [], reads = [], rpcCalls = [], cacheWrites = [];
  let cache = options.cache;
  const supabase = {
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      if (options.rpcThrow) throw new Error('permission unavailable');
      return options.rpc?.[name] || { data: true, error: null };
    },
    from(table) {
      assert.equal(table, 'pec_estimate_line_templates');
      let columns, insert, single = false;
      const filters = [], orders = [];
      const finish = async () => {
        if (insert) {
          writes.push(plain(insert));
          if (options.insertError) return { data: null, error: options.insertError };
          if (options.insertZero) return { data: null, error: null };
          if (rows.some(row => row.id === insert.id)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          const saved = record(insert);
          rows.push(saved);
          if (options.loseResponse) throw new Error('response interrupted');
          return { data: plain(saved), error: null };
        }
        reads.push({ columns, filters: plain(filters), orders: [...orders], single });
        if (options.readError) return { data: null, error: options.readError };
        if (options.readThrow) throw new Error('lookup interrupted');
        if (options.readNull) return { data: null, error: null };
        const selected = rows.filter(row => filters.every(([key, value]) => row[key] === value));
        selected.sort((a, b) => { for (const key of orders) { const compare = a[key].localeCompare(b[key]); if (compare) return compare; } return 0; });
        const projected = selected.map(row => Object.fromEntries(columns.split(',').map(key => [key, row[key]])));
        return { data: single ? projected[0] || null : projected, error: null };
      };
      const q = {
        select(value) { columns = value; return q; },
        eq(key, value) { filters.push([key, value]); return q; },
        order(key) { orders.push(key); return q; },
        insert(value) { insert = value; return q; },
        maybeSingle() { single = true; return finish(); },
        then(resolve, reject) { return finish().then(resolve, reject); },
      };
      return q;
    },
  };
  const idb = {
    async idbGet(store, key) {
      assert.equal(store, 'catalog'); assert.equal(key, 'description-templates');
      if (options.cacheReadError) throw new Error('storage locked');
      return cache;
    },
    async idbPut(store, value, key) {
      assert.equal(store, 'catalog'); assert.equal(key, 'description-templates');
      if (options.cacheWriteError) throw new Error('storage full');
      cacheWrites.push(plain(value)); cache = plain(value); return key;
    },
  };
  const context = vm.createContext({ exports: {}, navigator: { onLine: options.online !== false }, require(name) {
    if (name === './supabase') return { scopedSupabase: () => supabase };
    if (name === '../offline/account') return {
      captureAccount: () => account,
      assertAccount: scope => assert.equal(scope, account),
    };
    if (name === '../offline/idb') return idb;
    if (name.endsWith('estimate-formatting.cjs')) return formatting;
    throw new Error('Unexpected import ' + name);
  } });
  vm.runInContext(compiled, context);
  return { api: context.exports, rows, reads, writes, rpcCalls, cacheWrites };
}

test('description templates round-trip formatting and tokens, with no pricing or customer fields', async () => {
  const h = harness();
  const saved = await h.api.saveLineTemplate(input({ name: '  Garage floor  ', customer_id: 'customer', estimate_id: 'estimate', price: 1500, quantity: 400, payload: { product: 'x' } }));
  assert.deepEqual(plain(saved), record());
  assert.equal(h.writes[0].description, DESCRIPTION);
  assert.deepEqual(Object.keys(h.writes[0]).sort(), ['active', 'created_by', 'description', 'id', 'name']);
  assert.deepEqual(plain(await h.api.loadLineTemplates()), [record()]);
  assert.equal(h.rows.length, 1);
});

test('visible text validation rejects empty formatting and malformed inputs before writing', async () => {
  const h = harness();
  for (const overrides of [{ name: ' ' }, { name: 'x'.repeat(161) }, { description: ' \n\t' }, { description: '**\n-\n1.\n#' }, { description: 'x'.repeat(30001) }, { description: null }, { id: 'not-uuid' }, { createdBy: null }]) {
    await assert.rejects(h.api.saveLineTemplate(input(overrides)));
  }
  assert.equal(h.api.templateValidationError('Name', '{{area_name}}'), null);
  assert.equal(h.api.templateValidationError('Name', DESCRIPTION), null);
  assert.equal(h.writes.length, 0);
  assert.equal(h.reads.length, 0);
});

test('active templates load in stable name/id order and refresh their separate cache', async () => {
  const h = harness({ rows: [record({ name: 'Zebra' }), record({ id: OTHER, name: 'Alpha' }), record({ id: USER, active: false })] });
  const loaded = await h.api.loadLineTemplates();
  assert.deepEqual(loaded.map(row => row.name), ['Alpha', 'Zebra']);
  assert.deepEqual(h.reads[0].filters, [['active', true]]);
  assert.deepEqual(h.reads[0].orders, ['name', 'id']);
  assert.deepEqual(h.cacheWrites[0], plain(loaded));
});

test('cached reads are independent copies and omit inactive or unexpected fields', async () => {
  const cached = [record({ estimate_id: 'private', customer_name: 'Private person' }), record({ id: OTHER, active: false })];
  const h = harness({ cache: cached });
  const first = await h.api.getCachedLineTemplates();
  first[0].name = 'Changed locally';
  assert.equal((await h.api.getCachedLineTemplates())[0].name, 'Garage floor');
  assert.equal(cached[0].name, 'Garage floor');
  assert.equal(first.length, 1);
  assert.equal('estimate_id' in first[0], false);
  assert.equal('customer_name' in first[0], false);
  assert.deepEqual(plain(await harness({ cache: [{ bad: true }] }).api.getCachedLineTemplates()), []);
  assert.deepEqual(plain(await harness({ cacheReadError: true }).api.getCachedLineTemplates()), []);
});

test('online loading errors stay visible instead of claiming cached templates are current', async () => {
  for (const options of [{ readError: { message: 'permission denied' } }, { readThrow: true }, { readNull: true }, { rows: [record({ created_at: undefined })] }]) {
    const h = harness({ cache: [record()], ...options });
    await assert.rejects(h.api.loadLineTemplates());
    assert.equal(h.cacheWrites.length, 0);
  }
});

test('creation permission requires both the existing staff and catalog-edit helpers', async () => {
  const h = harness();
  assert.equal(await h.api.canSaveLineTemplates(), true);
  assert.deepEqual(plain(h.rpcCalls), [{ name: 'is_admin_staff' }, { name: 'has_permission', args: { p_perm: 'can_edit_catalog' } }]);
  for (const options of [{ rpc: { is_admin_staff: { data: false } } }, { rpc: { has_permission: { data: false } } }, { rpc: { has_permission: { data: true, error: { message: 'denied' } } } }, { rpcThrow: true }]) {
    assert.equal(await harness(options).api.canSaveLineTemplates(), false);
  }
});

test('a lost insert response is recovered by reading the exact captured ID', async () => {
  const h = harness({ loseResponse: true });
  assert.deepEqual(plain(await h.api.saveLineTemplate(input())), record());
  assert.equal(h.writes.length, 1);
  assert.equal(h.rows.length, 1);
  assert.deepEqual(h.reads[0].filters, [['id', ID]]);
  assert.equal(h.reads[0].single, true);
  assert.deepEqual(plain(await h.api.saveLineTemplate(input())), record());
  assert.equal(h.rows.length, 1, 'same-ID retry must never duplicate the saved template');
});

test('an existing ID with different text or creator is never overwritten or reported saved', async () => {
  for (const overrides of [{ description: 'Earlier version' }, { name: 'Earlier name' }, { created_by: OTHER }, { active: false }]) {
    const existing = record(overrides), h = harness({ rows: [existing] });
    await assert.rejects(h.api.saveLineTemplate(input()), /already saved with different content/);
    assert.deepEqual(h.rows, [existing]);
    assert.equal(h.cacheWrites.length, 0);
  }
});

test('denied and zero-row writes fail without a matching persisted record', async () => {
  for (const options of [{ insertError: { message: 'permission denied' } }, { insertZero: true }, { insertZero: true, readError: { message: 'network unavailable' } }]) {
    const h = harness(options);
    await assert.rejects(h.api.saveLineTemplate(input()));
    assert.equal(h.rows.length, 0);
    assert.equal(h.cacheWrites.length, 0);
  }
});

test('cache failures never turn a confirmed server save or successful list into an error', async () => {
  const h = harness({ cacheReadError: true, cacheWriteError: true });
  assert.deepEqual(plain(await h.api.saveLineTemplate(input())), record());
  assert.deepEqual(plain(await h.api.loadLineTemplates()), [record()]);
});

test('offline creation is refused before any write or confirmation query', async () => {
  const h = harness({ online: false });
  await assert.rejects(h.api.saveLineTemplate(input()), /Reconnect/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.reads.length, 0);
});
