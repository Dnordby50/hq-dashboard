'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('../apps/estimator/node_modules/jsdom');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('function portalSettingsPatch(values)'), html.indexOf('async function renderSettings()'));
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const dom = new JSDOM('<main id="pecViewRoot"></main>', { runScripts: 'outside-only' });
  const w = dom.window;
  let data = [], loadError = null, saveError = null, read = null, saving = null;
  const writes = [];
  w.$ = id => w.document.getElementById(id);
  w.state = { view: 'settings', settingsTab: 'portal' };
  w.esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  w.settingsTabBar = () => '';
  w.wireSettingsTabs = () => {};
  w.withFreshSession = fn => fn();
  w.withFreshWriteRetry = fn => fn();
  w.supabase = { from: table => {
    assert.equal(table, 'settings');
    return {
      select: () => ({ in: async () => read ? read() : ({ data, error: loadError }) }),
      upsert: (rows, options) => { writes.push(JSON.parse(JSON.stringify({ rows, options }))); return { select: async () => {
        if (saving) await saving;
        return { data: rows.map(row => ({ key: row.key })), error: saveError };
      } }; },
    };
  } };
  new vm.Script(source).runInContext(dom.getInternalVMContext());
  return { w, writes, close: () => dom.window.close(), render: () => w.renderSettingsPortal(),
    load(value, error = null) { data = value; loadError = error; }, failSave(error) { saveError = error; },
    deferRead(fn) { read = fn; }, deferSave(promise) { saving = promise; },
    async submit() { w.$('portalSettingsForm').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(); },
  };
}
test('portal settings save flags and all brand destinations in one write', async t => {
  const h = harness(); t.after(h.close); await h.render();
  const form = h.w.$('portalSettingsForm');
  assert.equal(form.querySelectorAll('input[type=checkbox]:checked').length, 2);
  form.elements.namedItem('customer_portal_reviews_enabled').checked = false;
  form.elements.namedItem('google_review_link_epoxy').value = 'https://g.page/r/example/review';
  form.elements.namedItem('portal_yelp_link_paint').value = 'https://www.yelp.com/biz/example-painting';
  await h.submit();
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].options, { onConflict: 'key' });
  const values = Object.fromEntries(h.writes[0].rows.map(row => [row.key, row.value]));
  assert.equal(Object.keys(values).length, 6);
  assert.equal(values.customer_portal_reviews_enabled, 'false');
  assert.equal(values.customer_portal_referrals_enabled, 'true');
  assert.equal(values.portal_yelp_link_paint, 'https://www.yelp.com/biz/example-painting');
  assert.match(h.w.$('portalSettingsMessage').textContent, /Saved/);
});
test('portal link validation blocks deceptive hosts and keeps the form draft', async t => {
  const h = harness(); t.after(h.close); await h.render();
  const field = h.w.$('portalSettingsForm').elements.namedItem('portal_yelp_link_epoxy');
  for (const bad of ['https://yelp.com.evil.test/biz/example', 'https://www.yelp.com/search', 'https://user@yelp.com/biz/example', 'http://yelp.com/biz/example', 'https://yelp.com:444/biz/example']) {
    field.value = bad; await h.submit(); assert.equal(h.writes.length, 0); assert.equal(field.value, bad);
    assert.match(h.w.$('portalSettingsMessage').textContent, /official/);
  }
  const google = h.w.$('portalSettingsForm').elements.namedItem('google_review_link_epoxy');
  field.value = ''; google.value = 'https://google.com.evil.test'; await h.submit(); assert.equal(h.writes.length, 0);
});
test('failed settings reads cannot be mistaken for blank saved values', async t => {
  const h = harness(); t.after(h.close); h.load([], new Error('offline')); await h.render();
  assert.equal(h.w.$('portalSettingsForm'), null); assert.ok(h.w.$('portalSettingsRetry'));
  h.load([{ key: 'customer_portal_reviews_enabled', value: 'false' }]); await h.render();
  assert.equal(h.w.$('portalSettingsForm').elements.namedItem('customer_portal_reviews_enabled').checked, false);
});
test('failed and in-flight saves preserve edits and prevent duplicate submissions', async t => {
  const h = harness(); t.after(h.close); await h.render();
  const field = h.w.$('portalSettingsForm').elements.namedItem('portal_yelp_link_epoxy');
  field.value = 'https://yelp.com/biz/example';
  let release; h.deferSave(new Promise(resolve => { release = resolve; })); h.failSave(new Error('Save unavailable'));
  await h.submit(); await h.submit(); assert.equal(h.writes.length, 1); assert.equal(field.disabled, true);
  release(); await tick(); assert.equal(field.disabled, false); assert.equal(field.value, 'https://yelp.com/biz/example');
  assert.match(h.w.$('portalSettingsMessage').textContent, /Save unavailable/);
});
test('older settings loads cannot overwrite a newer portal settings screen', async t => {
  const h = harness(); t.after(h.close); let finishOld;
  h.deferRead(() => new Promise(resolve => { finishOld = resolve; })); const first = h.render();
  h.deferRead(null); h.load([{ key: 'google_review_link_epoxy', value: 'https://g.page/new' }]); await h.render();
  finishOld({ data: [{ key: 'google_review_link_epoxy', value: 'https://g.page/old' }], error: null }); await first;
  assert.equal(h.w.$('portalSettingsForm').elements.namedItem('google_review_link_epoxy').value, 'https://g.page/new');
});
