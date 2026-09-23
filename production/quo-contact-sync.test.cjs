'use strict';
// Prompt 107: Quo contact sync. Pure rules from production/quo-contact-sync.cjs
// plus the REAL worker pass (_pec-quo-contacts.cjs runSyncPass) over the
// mini-PostgREST and a fake Quo client. No network, no production records.
// Run: node --test production/quo-contact-sync.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('./quo-contact-sync.cjs');
const { makeDb } = require('./_drip-test-kit.cjs');
const { runSyncPass, planBackfill } = require('../netlify/functions/_pec-quo-contacts.cjs');

const contact = (id, first, last, extra = {}) => ({
  id, externalId: null, source: 'openphone', createdAt: '2026-01-01T00:00:00Z',
  defaultFields: { firstName: first, lastName: last, company: null, role: null, emails: [], phoneNumbers: [{ id: 'p1', name: 'Mobile', value: '+19285551212' }] },
  customFields: [], ...extra,
});

test('naming rule (decision 6): person in first/last, business in company, business alone becomes the first name, legacy full name splits', () => {
  assert.deepEqual(rules.desiredName({ first_name: 'Kyle', last_name: 'Kirby', business_name: 'Kirby Homes' }), { firstName: 'Kyle', lastName: 'Kirby', company: 'Kirby Homes' });
  assert.deepEqual(rules.desiredName({ first_name: null, last_name: null, company_name: 'Acme Floors' }), { firstName: 'Acme Floors', lastName: null, company: null });
  assert.deepEqual(rules.desiredName({ first_name: '', last_name: '', full_name: 'Marianne Thorstad' }), { firstName: 'Marianne', lastName: 'Thorstad', company: null });
  assert.deepEqual(rules.desiredName({ name: 'Cher' }), { firstName: 'Cher', lastName: null, company: null });
  assert.deepEqual(rules.desiredName({ first_name: ' Ann ', last_name: null, company_name: ' ' }), { firstName: 'Ann', lastName: null, company: null });
  // A legacy customers.name that just repeats the company is a business, not a person "Acme Floors".
  assert.deepEqual(rules.desiredName({ name: 'Acme Floors', company_name: 'acme floors' }), { firstName: 'acme floors', lastName: null, company: null });
  assert.deepEqual(rules.desiredName({ name: 'Kyle Kirby', company_name: 'Kirby Homes' }), { firstName: 'Kyle', lastName: 'Kirby', company: 'Kirby Homes' });
});

test('keep the fuller name (decision 8): first-name-only never clobbers a fuller Quo name; a real difference always renames', () => {
  const quo = { firstName: 'Kyle', lastName: 'Kirby', company: null };
  assert.deepEqual(rules.shouldRename(quo, { firstName: 'Kyle', lastName: null }), { rename: false, reason: 'fuller_in_quo' });
  assert.deepEqual(rules.shouldRename(quo, { firstName: 'kyle', lastName: null }), { rename: false, reason: 'fuller_in_quo' });
  assert.deepEqual(rules.shouldRename(quo, { firstName: 'Kyle', lastName: 'Kirby' }), { rename: false, reason: 'same' });
  assert.deepEqual(rules.shouldRename(quo, { firstName: 'KYLE', lastName: ' kirby ' }), { rename: false, reason: 'same' });
  assert.deepEqual(rules.shouldRename(quo, { firstName: 'Kyle', lastName: 'Kirby', company: 'Kirby Homes' }), { rename: true, reason: 'different' });
  assert.deepEqual(rules.shouldRename(quo, { firstName: 'Kyle', lastName: 'Kirbe' }), { rename: true, reason: 'different' });
  assert.deepEqual(rules.shouldRename(quo, { firstName: 'Chris', lastName: null }), { rename: true, reason: 'different' });
  assert.deepEqual(rules.shouldRename(quo, { firstName: null, lastName: null }), { rename: false, reason: 'blank' });
  assert.deepEqual(rules.shouldRename({ firstName: 'Kyle', lastName: null }, { firstName: 'Kyle', lastName: 'Kirby' }), { rename: true, reason: 'different' });
  assert.deepEqual(rules.shouldRename({ firstName: 'Marianne Thorstad Husband Cell', lastName: null }, { firstName: 'Marianne', lastName: null }), { rename: false, reason: 'fuller_in_quo' });
});

test('newest duplicate (decision 4) is the one written; a TopCoat-created contact wins outright', () => {
  const older = contact('c-old', 'Kyle', null, { createdAt: '2026-02-01T00:00:00Z' });
  const newer = contact('c-new', 'Kyle', 'Kirby', { createdAt: '2026-05-01T00:00:00Z' });
  assert.equal(rules.pickContact([older, newer], '9285551212').id, 'c-new');
  assert.equal(rules.pickContact([newer, older], '9285551212').id, 'c-new');
  const ours = contact('c-ours', 'Kyle', 'K', { createdAt: '2025-01-01T00:00:00Z', externalId: 'topcoat:9285551212' });
  assert.equal(rules.pickContact([older, newer, ours], '9285551212').id, 'c-ours');
  assert.equal(rules.pickContact([], '9285551212'), null);
  const idx = rules.indexContactsByPhone([older, newer, contact('c-x', 'X', null, { defaultFields: { firstName: 'X', phoneNumbers: [{ value: '+1 (602) 702-0711' }] } })]);
  assert.deepEqual(idx.get('9285551212').map(c => c.id), ['c-old', 'c-new']);
  assert.deepEqual(idx.get('6027020711').map(c => c.id), ['c-x']);
});

test('PATCH body carries emails, phone numbers, role and custom fields back verbatim (Quo replaces, decision 3)', () => {
  const c = contact('c1', 'Kyle', null, { defaultFields: { firstName: 'Kyle', lastName: null, company: null, role: 'Owner',
    emails: [{ id: 'e1', name: 'Home', value: 'kyle@home.test' }], phoneNumbers: [{ id: 'p1', name: 'Mobile', value: '+19285551212' }] },
    customFields: [{ key: 'brand', value: 'PEC', id: 'cf1' }] });
  const body = rules.buildPatchBody(c, { firstName: 'Kyle', lastName: 'Kirby', company: 'Kirby Homes', email: 'kyle@topcoat.test' }, '9285551212');
  assert.deepEqual(body, { defaultFields: { firstName: 'Kyle', lastName: 'Kirby', company: 'Kirby Homes', role: 'Owner',
    emails: [{ name: 'Home', value: 'kyle@home.test' }], phoneNumbers: [{ name: 'Mobile', value: '+19285551212' }] },
    customFields: [{ key: 'brand', value: 'PEC' }] });
  // Our own contact may also get its email kept in sync.
  const ours = { ...c, externalId: 'topcoat:9285551212' };
  const b2 = rules.buildPatchBody(ours, { firstName: 'Kyle', lastName: 'Kirby', email: 'kyle@topcoat.test' }, '9285551212');
  assert.deepEqual(b2.defaultFields.emails, [{ name: 'Email', value: 'kyle@topcoat.test' }, { name: 'Home', value: 'kyle@home.test' }]);
  assert.equal(b2.defaultFields.company, null);
  const create = rules.buildCreateBody({ firstName: 'Acme Floors', lastName: null, company: null, email: 'a@acme.test' }, '9285550108');
  assert.deepEqual(create, { defaultFields: { firstName: 'Acme Floors', lastName: null, company: null, emails: [{ name: 'Email', value: 'a@acme.test' }], phoneNumbers: [{ name: 'Mobile', value: '+19285550108' }] }, externalId: 'topcoat:9285550108', source: 'topcoat' });
});

test('planSync: create when missing, update on a real difference, skip fuller/same, honor the create/edit switches', () => {
  const row = { phone_norm: '9285551212', first_name: 'Kyle', last_name: 'Kirby', company: null, email: null, origin: 'insert' };
  assert.equal(rules.planSync(row, [], {}).action, 'create');
  assert.equal(rules.planSync(row, [], { createMissing: false }).action, 'skip');
  assert.equal(rules.planSync(row, [contact('c1', 'Kyle', null)], {}).action, 'update');
  assert.equal(rules.planSync({ ...row, last_name: null }, [contact('c1', 'Kyle', 'Kirby')], {}).reason, 'fuller_in_quo');
  assert.equal(rules.planSync(row, [contact('c1', 'kyle', 'KIRBY')], {}).reason, 'same');
  assert.equal(rules.planSync({ ...row, origin: 'update' }, [contact('c1', 'Kyle', null)], { onEdit: false }).reason, 'edits_off');
  assert.equal(rules.planSync({ ...row, origin: 'update' }, [contact('c1', 'Kyle', null)], { onEdit: true }).action, 'update');
});

test('backoff: four attempts over about an hour', () => {
  assert.deepEqual([1, 2, 3, 4, 9].map(rules.backoffMinutes), [2, 8, 20, 30, 30]);
  assert.equal(rules.BACKOFF_MINUTES.slice(0, 3).reduce((a, b) => a + b, 0), 30);
});

test('coalescing: one desired row per phone, customer over lead, newest within a table', () => {
  const leads = [
    { id: 'l1', phone_norm: '9285551212', first_name: 'Kyle', created_at: '2026-01-01' },
    { id: 'l2', phone_norm: '9285551212', first_name: 'Kyle', last_name: 'Kirby', created_at: '2026-02-01' },
    { id: 'l3', phone_norm: '9285550000', first_name: 'Solo', last_name: 'Lead', created_at: '2026-02-01' },
    { id: 'l4', phone_norm: '9285550001', first_name: 'Gone', deleted_at: '2026-02-01', created_at: '2026-02-01' },
    { id: 'l5', phone_norm: null, first_name: 'No', last_name: 'Phone' },
  ];
  const customers = [
    { id: 'c1', phone_norm: '9285551212', first_name: 'Kyle', last_name: 'Kirby', company_name: 'Kirby Homes', created_at: '2026-03-01' },
    { id: 'c2', phone_norm: '9285550002', name: 'Legacy Name', created_at: '2026-03-01' },
    { id: 'c3', phone_norm: '9285550003', name: 'Archived', archived_at: '2026-03-01' },
  ];
  const out = rules.coalesceDesired(leads, customers).sort((a, b) => a.phone_norm.localeCompare(b.phone_norm));
  assert.deepEqual(out.map(r => `${r.phone_norm}:${r.source_table}:${r.first_name} ${r.last_name || ''}${r.company ? ' (' + r.company + ')' : ''}`.trim()),
    ['9285550000:leads:Solo Lead', '9285550002:customers:Legacy Name', '9285551212:customers:Kyle Kirby (Kirby Homes)']);
});

// ---------------------------------------------------------------------------
// The real worker pass over the fixture queue with a fake Quo.
// ---------------------------------------------------------------------------
function fakeQuo(seed = [], opts = {}) {
  const store = seed.map(c => ({ ...c }));
  const calls = [];
  let nextId = 1;
  return {
    calls, store,
    async listAll() { calls.push(['list']); if (opts.listFails) throw Object.assign(new Error('boom'), opts.listFails === 429 ? { rateLimited: true, status: 429 } : {}); return { contacts: store.map(c => ({ ...c })), truncated: false }; },
    async byExternalId(ext) { calls.push(['byExternalId', ext]); return store.filter(c => c.externalId === ext); },
    async create(body) { calls.push(['create', body]); if (opts.createFails) throw Object.assign(new Error(opts.createFails === 429 ? '429' : 'create failed'), opts.createFails === 429 ? { rateLimited: true } : {}); const c = { id: 'q' + (nextId++), createdAt: '2026-09-23T00:00:00Z', ...body }; store.push(c); return c; },
    async update(id, body) { calls.push(['update', id, body]); const c = store.find(x => x.id === id); Object.assign(c, body); return c; },
  };
}
const queueRow = (over = {}) => ({ phone_norm: '9285551212', source_table: 'leads', source_id: 'l1', first_name: 'Kyle', last_name: 'Kirby', company: null, email: 'kyle@topcoat.test', origin: 'insert', status: 'pending', attempts: 0, next_attempt_at: '2026-09-23T00:00:00Z', last_error: null, quo_contact_id: null, ...over });
const NOW = new Date('2026-09-23T12:00:00Z');
const tables = (rows, settings = []) => ({ settings, pec_quo_contact_sync: rows, leads: [], customers: [], pec_heartbeats: [] });

test('worker: a pending row with no Quo contact creates one with our externalId and marks the row done', async () => {
  const fx = makeDb(tables([queueRow()]));
  const quo = fakeQuo();
  const out = await runSyncPass({ db: fx.sb, quo, now: () => NOW, source: 'manual_run' });
  assert.deepEqual([out.created, out.updated, out.skipped, out.failed], [1, 0, 0, 0]);
  assert.equal(quo.calls[1][0], 'create');
  assert.equal(quo.store[0].externalId, 'topcoat:9285551212');
  assert.deepEqual(quo.store[0].defaultFields.phoneNumbers, [{ name: 'Mobile', value: '+19285551212' }]);
  const row = fx.db.pec_quo_contact_sync[0];
  assert.equal(row.status, 'done'); assert.equal(row.quo_contact_id, 'q1'); assert.ok(row.last_synced_at);
});

test('worker: newest duplicate renamed with everything else preserved; older duplicate untouched', async () => {
  const older = contact('c-old', 'Kyle', null, { createdAt: '2026-02-01T00:00:00Z' });
  const newer = contact('c-new', 'Kyle', null, { createdAt: '2026-05-01T00:00:00Z', defaultFields: { firstName: 'Kyle', lastName: null, company: null, role: 'Owner', emails: [{ id: 'e', name: 'Home', value: 'kyle@home.test' }], phoneNumbers: [{ id: 'p', name: 'Mobile', value: '+19285551212' }] }, customFields: [{ key: 'k', value: 'v' }] });
  const fx = makeDb(tables([queueRow()]));
  const quo = fakeQuo([older, newer]);
  const out = await runSyncPass({ db: fx.sb, quo, now: () => NOW, source: 'manual_run' });
  assert.deepEqual([out.created, out.updated], [0, 1]);
  const upd = quo.calls.find(c => c[0] === 'update');
  assert.equal(upd[1], 'c-new');
  assert.equal(upd[2].defaultFields.lastName, 'Kirby');
  assert.deepEqual(upd[2].defaultFields.emails, [{ name: 'Home', value: 'kyle@home.test' }], 'a hand-typed email on a non-TopCoat contact is preserved, not replaced');
  assert.deepEqual(upd[2].customFields, [{ key: 'k', value: 'v' }]);
  assert.equal(upd[2].defaultFields.role, 'Owner');
  assert.equal(quo.store.find(c => c.id === 'c-old').defaultFields.lastName, null, 'older duplicate untouched');
  assert.equal(fx.db.pec_quo_contact_sync[0].quo_contact_id, 'c-new');
});

test('worker: fuller name in Quo is skipped, recorded as skipped, no Quo write', async () => {
  const fx = makeDb(tables([queueRow({ last_name: null })]));
  const quo = fakeQuo([contact('c1', 'Kyle', 'Kirby')]);
  const out = await runSyncPass({ db: fx.sb, quo, now: () => NOW, source: 'manual_run' });
  assert.equal(out.skipped, 1);
  assert.equal(quo.calls.filter(c => c[0] !== 'list').length, 0);
  assert.equal(fx.db.pec_quo_contact_sync[0].status, 'skipped');
});

test('worker: failure retries with backoff, then surfaces as failed after max attempts; the record itself is never touched', async () => {
  const fx = makeDb(tables([queueRow({ attempts: 2 })], [{ key: 'quo_contact_sync_max_attempts', value: '4' }]));
  const quo = fakeQuo([], { createFails: true });
  let out = await runSyncPass({ db: fx.sb, quo, now: () => NOW, source: 'manual_run' });
  let row = fx.db.pec_quo_contact_sync[0];
  assert.deepEqual([out.failed, out.deferred, row.status, row.attempts], [0, 1, 'pending', 3]);
  assert.equal(row.next_attempt_at, new Date(NOW.getTime() + 20 * 60000).toISOString());
  assert.match(row.last_error, /create failed/);
  // Not due yet: nothing happens.
  out = await runSyncPass({ db: fx.sb, quo, now: () => NOW, source: 'manual_run' });
  assert.equal(out.processed, 0);
  out = await runSyncPass({ db: fx.sb, quo, now: () => new Date(NOW.getTime() + 21 * 60000), source: 'manual_run' });
  row = fx.db.pec_quo_contact_sync[0];
  assert.deepEqual([out.failed, row.status, row.attempts], [1, 'failed', 4]);
});

test('worker: a 429 stops the pass and leaves every row pending for the next tick', async () => {
  const fx = makeDb(tables([queueRow(), queueRow({ phone_norm: '9285550000', first_name: 'Solo', last_name: 'Lead' })]));
  const quo = fakeQuo([], { createFails: 429 });
  const out = await runSyncPass({ db: fx.sb, quo, now: () => NOW, source: 'manual_run' });
  assert.equal(out.deferred, 2);
  assert.ok(fx.db.pec_quo_contact_sync.every(r => r.status === 'pending' && r.attempts === 0));
});

test('worker: switched off, no key, or no table are silent no-ops', async () => {
  const off = makeDb(tables([queueRow()], [{ key: 'quo_contact_sync_enabled', value: 'false' }]));
  const quo = fakeQuo();
  assert.match((await runSyncPass({ db: off.sb, quo, now: () => NOW })).skipped, /enabled is false/);
  assert.equal(quo.calls.length, 0);
  const noTable = makeDb({ settings: [] });
  assert.match((await runSyncPass({ db: noTable.sb, quo, now: () => NOW })).skipped, /queue unavailable/);
});

test('backfill dry run: creates, renames, skips and older duplicates are reported; live enqueues one row per phone', async () => {
  const fx = makeDb({
    settings: [],
    leads: [{ id: 'l1', phone_norm: '9285550000', first_name: 'Solo', last_name: 'Lead', email: null, created_at: '2026-01-01', deleted_at: null, archived_at: null }],
    customers: [
      { id: 'c1', phone_norm: '9285551212', first_name: 'Kyle', last_name: 'Kirby', company_name: null, email: null, created_at: '2026-01-01', archived_at: null },
      { id: 'c2', phone_norm: '6027020711', first_name: 'Chris', last_name: null, company_name: null, email: null, created_at: '2026-01-01', archived_at: null },
    ],
    pec_quo_contact_sync: [],
  });
  const quo = fakeQuo([
    contact('k-old', 'Kyle', null, { createdAt: '2026-01-01T00:00:00Z' }),
    contact('k-new', 'Kyle', null, { createdAt: '2026-02-01T00:00:00Z' }),
    contact('chris', 'Chris', 'Clevenger', { defaultFields: { firstName: 'Chris', lastName: 'Clevenger', phoneNumbers: [{ value: '+16027020711' }] } }),
  ]);
  const report = await planBackfill({ db: fx.sb, quo, dry: true, now: () => NOW });
  assert.deepEqual(report.counts, { create: 1, rename: 1, skip_fuller: 1, skip_same: 0, skip_duplicate_older: 1, no_phone: { leads: 0, customers: 0 } });
  assert.match(report.rename[0], /"Kyle" -> "Kyle Kirby"/);
  assert.match(report.skip_fuller[0], /Quo has "Chris Clevenger"/);
  assert.equal(fx.db.pec_quo_contact_sync.length, 0, 'dry run writes nothing');
  assert.equal(quo.calls.filter(c => c[0] !== 'list').length, 0, 'dry run never writes to Quo');
  const live = await planBackfill({ db: fx.sb, quo, dry: false, now: () => NOW });
  assert.equal(live.queued, 3);
  assert.equal(fx.db.pec_quo_contact_sync.length, 3);
  assert.ok(fx.db.pec_quo_contact_sync.every(r => r.origin === 'backfill' && r.status === 'pending'));
});
