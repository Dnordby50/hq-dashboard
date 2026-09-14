'use strict';

// Run the actual public booking page scripts with a small DOM and fixture
// transport. This checks navigation/state without a browser login, production
// appointment, customer record, or outbound notification.
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { bookingPageInner } = require('../netlify/functions/pec-booking.cjs');

function decode(value) {
  return String(value).replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos|nbsp);/gi, (_, code, name) => code
    ? String.fromCodePoint(code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code))
    : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name]);
}

class Element {
  constructor(tagName = 'div', text = '') {
    this.tagName = tagName.toUpperCase();
    this.attributes = {}; this.style = {}; this.dataset = {};
    this.children = []; this.parentNode = null; this.listeners = {};
    this.value = ''; this.disabled = false; this._text = text;
    this.classList = {
      add: (...names) => { this.className = [...new Set(this.className.split(/\s+/).filter(Boolean).concat(names))].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(n => !names.includes(n)).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, on) => { const next = on === undefined ? !this.classList.contains(name) : on; this.classList[next ? 'add' : 'remove'](name); return next; },
    };
  }
  get id() { return this.attributes.id || ''; }
  set id(value) { this.attributes.id = value; }
  get className() { return this.attributes.class || ''; }
  set className(value) { this.attributes.class = value; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this._text = String(value); }
  get innerHTML() { return this._html || ''; }
  set innerHTML(value) { this.textContent = ''; this._html = value; parseInto(String(value), this); }
  get firstChild() { return this.children[0] || null; }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  append(...children) { children.forEach(child => this.appendChild(typeof child === 'string' ? new Element('#text', child) : child)); }
  replaceChildren(...children) { this.textContent = ''; this.append(...children); }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(child) { return this === child || this.children.some(node => node.contains(child)); }
  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key === 'style') String(value).split(';').forEach(rule => { const [name, val] = rule.split(':'); if (name && val) this.style[name.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val.trim(); });
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
    if (key === 'disabled') this.disabled = true;
    if (key === 'value') this.value = decode(value);
  }
  getAttribute(key) { return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null; }
  hasAttribute(key) { return Object.hasOwn(this.attributes, key); }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'disabled') this.disabled = false; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  dispatchEvent(event) { event.target ||= this; event.preventDefault ||= () => {}; (this.listeners[event.type] || []).forEach(fn => fn.call(this, event)); return true; }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
  focus() { this.focused = true; }
  scrollIntoView() {}
  cloneNode() { return new Element(this.tagName, this._text); }
  matches(selector) {
    if (selector === '*') return true;
    const attr = selector.match(/\[([^\]=]+)(?:=["']?([^\]"']+)["']?)?\]/);
    if (attr && (!this.hasAttribute(attr[1]) || (attr[2] !== undefined && this.getAttribute(attr[1]) !== attr[2]))) return false;
    const base = selector.replace(/\[[^\]]+\]/g, '');
    const id = base.match(/#([\w-]+)/); if (id && this.id !== id[1]) return false;
    const classes = [...base.matchAll(/\.([\w-]+)/g)]; if (classes.some(m => !this.classList.contains(m[1]))) return false;
    const tag = base.match(/^[\w-]+/); return !tag || this.tagName === tag[0].toUpperCase();
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(s => s.trim());
    const result = [];
    const visit = node => node.children.forEach(child => { if (selectors.some(s => child.matches(s))) result.push(child); visit(child); });
    visit(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function parseInto(html, root) {
  const stack = [root];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  for (const match of html.matchAll(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)) {
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (token.startsWith('<')) {
      const tag = token.match(/^<([\w-]+)/); if (!tag) continue;
      const node = new Element(tag[1]);
      const attrs = token.slice(tag[0].length).replace(/\/?\s*>$/, '');
      for (const attr of attrs.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) node.setAttribute(attr[1], decode(attr[2] ?? attr[3] ?? attr[4] ?? ''));
      stack.at(-1).appendChild(node);
      if (!voidTags.has(tag[1].toLowerCase()) && !token.endsWith('/>')) stack.push(node);
    } else stack.at(-1).appendChild(new Element('#text', decode(token)));
  }
}

const QUESTIONS = [
  { id: 'source', label: 'How did you hear about us?', type: 'choice', required: true, options: ['Google', 'Referral'] },
  { id: 'project', label: 'What do you have in mind?', type: 'long_text', required: false },
];
const FORM = { slug: 'pec', questions: QUESTIONS, appt_types: [{ label: 'On-site estimate', duration_minutes: 60 }], headline: 'Book an estimate', intro_text: '', success_message: 'Your visit is booked.' };
const DAYS = Array.from({ length: 12 }, (_, i) => {
  const date = '2026-10-' + String(i + 1).padStart(2, '0');
  return { date, label: 'October ' + (i + 1), slots: [
    { start: date + 'T16:00:00.000Z', label: '9:00 AM' },
    { start: date + 'T18:00:00.000Z', label: '11:00 AM' },
  ] };
});

async function fixture(options = {}) {
  const html = bookingPageInner(FORM, '', { preview: !!options.preview, brand: { business_name: 'Prescott Epoxy Company', phone: '(928) 800-8154' } });
  const body = new Element('body');
  parseInto(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''), body);
  const document = { body, head: new Element('head'), documentElement: body,
    getElementById: id => body.querySelector('#' + id), createElement: tag => new Element(tag),
    createTextNode: value => new Element('#text', String(value)),
    querySelectorAll: selector => body.querySelectorAll(selector), querySelector: selector => body.querySelector(selector),
    addEventListener: body.addEventListener.bind(body),
  };
  const window = new Element('window'); window.parent = window; window.location = { origin: 'http://booking.test' };
  const requests = [];
  const responses = { slots: [], book: [], lead: [] };
  const context = vm.createContext({ window, document, console, URL, Date,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    MutationObserver: class { observe() {} },
    fetch: async (url, init) => {
      const path = String(url).split('/').at(-1).split('?')[0];
      const request = { path, body: init?.body ? JSON.parse(init.body) : null }; requests.push(request);
      if (path === 'config') return { status: 200, json: async () => ({ disclosure: 'Appointment text message disclosure.' }) };
      const next = responses[path]?.shift();
      const result = typeof next === 'function' ? await next(request) : next || (path === 'slots' ? { ok: true, in_area: true, days: DAYS } : { ok: true, message: 'Confirmed.', when: 'October 1, 9 AM' });
      return { status: result.status || 200, json: async () => result };
    },
  });
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) vm.runInContext(script[1], context);
  async function settle() { await new Promise(resolve => setImmediate(resolve)); }
  await settle();
  const $ = id => { const el = document.getElementById(id); assert.ok(el, 'Rendered element exists: ' + id); return el; };
  const visible = id => { let el = $(id); while (el) { if (el.style.display === 'none') return false; el = el.parentNode; } return true; };
  const click = async id => { $(id).click(); await settle(); };
  const buttons = id => $(id).querySelectorAll('button');
  async function address() { $('bkAddr').value = '123 Test Street'; $('bkCity').value = 'Prescott'; $('bkZip').value = '86301'; await click('bkAddrNext'); }
  async function selectTime(day = 0, slot = 0) { buttons('bkDays')[day].click(); buttons('bkTimeBtns')[slot].click(); await settle(); }
  async function details() {
    await address(); await selectTime(); await click('bkContinue');
    $('bkName').value = 'Taylor Example'; $('bkPhone').value = '9285550100'; $('bkEmail').value = 'taylor@example.com';
    $('q_source').value = 'Referral';
  }
  return { $, visible, click, buttons, settle, address, selectTime, details, requests, responses, window, context, html };
}

test('address comes first and no later step can bypass validated availability', async () => {
  const f = await fixture();
  assert.equal(f.visible('stepAddr'), true);
  assert.equal(f.visible('stepTime'), false);
  assert.equal(f.visible('stepDetails'), false);
  await f.click('bkAddrNext');
  assert.match(f.$('bkAddrErr').textContent, /address/i);
  assert.equal(f.requests.some(r => r.path === 'slots'), false);
  await f.click('st2'); await f.click('st3'); await f.click('bkContinue');
  assert.equal(f.visible('stepAddr'), true);
  assert.equal(f.requests.some(r => r.path === 'book'), false);
  await f.address();
  assert.deepEqual(f.requests.find(r => r.path === 'slots').body, { form: 'pec', address1: '123 Test Street', city: 'Prescott', zip: '86301' });
  assert.equal(f.visible('stepTime'), true);
  assert.equal(f.$('bkContinue').disabled, true);
});

test('every available day remains reachable in five-day pages', async () => {
  const f = await fixture(); await f.address();
  const seen = [];
  for (let page = 0; page < 3; page++) {
    const buttons = f.buttons('bkDays'); assert.equal(buttons.length, page === 2 ? 2 : 5);
    buttons.forEach(button => { button.click(); seen.push(f.$('bkTimeDay').textContent); });
    if (page < 2) await f.click('bkDateNext');
  }
  assert.equal(new Set(seen).size, DAYS.length);
  DAYS.forEach(day => assert.ok(seen.some(label => label.includes(day.label)), 'Reachable: ' + day.label));
  assert.equal(f.$('bkDateNext').disabled, true);
  await f.click('bkDatePrev'); await f.click('bkDatePrev');
  assert.equal(f.$('bkDatePrev').disabled, true);
  assert.equal(f.buttons('bkDays').length, 5);
});

test('selecting a time requires Continue, changing the day clears that selection', async () => {
  const f = await fixture(); await f.address(); await f.selectTime(0, 1);
  assert.equal(f.visible('stepTime'), true);
  assert.equal(f.visible('stepDetails'), false);
  assert.equal(f.$('bkContinue').disabled, false);
  assert.match(f.$('bkSelectedTime').textContent, /11:00/);
  f.buttons('bkDays')[1].click();
  assert.equal(f.$('bkContinue').disabled, true);
  await f.click('bkContinue');
  assert.equal(f.visible('stepDetails'), false);
  f.buttons('bkTimeBtns')[0].click(); await f.click('bkContinue');
  assert.equal(f.visible('stepDetails'), true);
  assert.match(f.$('bkChosen').textContent, /October 2/);
  assert.match(f.$('bkChosen').textContent, /9:00/);
});

test('the enabled Your details step renders questions just like Continue', async () => {
  const f = await fixture(); await f.address(); await f.selectTime();
  assert.equal(f.$('st3').disabled, false);
  await f.click('st3');
  assert.equal(f.visible('stepDetails'), true);
  assert.ok(f.$('q_source'));
  assert.ok(f.$('q_project'));
});

test('backward navigation preserves entered contact details and form questions', async () => {
  const f = await fixture(); await f.details();
  f.$('bkName').value = 'Taylor Example'; f.$('bkPhone').value = '9285550100'; f.$('bkEmail').value = 'taylor@example.com';
  f.$('q_source').value = 'Referral'; f.$('q_project').value = 'Garage floor and patio';
  await f.click('bkChangeTime');
  assert.equal(f.visible('stepTime'), true);
  await f.selectTime(1, 1); await f.click('bkContinue');
  assert.equal(f.$('q_source').value, 'Referral');
  assert.equal(f.$('q_project').value, 'Garage floor and patio');
  assert.equal(f.$('bkName').value, 'Taylor Example');
  await f.click('bkBook');
  const booking = f.requests.find(r => r.path === 'book');
  assert.equal(booking.body.start, DAYS[1].slots[1].start);
  assert.deepEqual(booking.body.answers, { source: 'Referral', project: 'Garage floor and patio' });
  assert.equal(booking.body.sms_consent, 'true');
  assert.equal(booking.body.address1, '123 Test Street');
  assert.equal(f.visible('stepDone'), true);
});

test('changing the address clears the prior selection and checks availability again', async () => {
  const f = await fixture(); await f.details(); await f.click('st1');
  assert.equal(f.visible('stepAddr'), true);
  f.$('bkAddr').value = '456 Next Street';
  f.responses.slots.push({ ok: true, in_area: true, days: [DAYS[7]] });
  await f.click('bkAddrNext');
  assert.equal(f.$('bkContinue').disabled, true);
  assert.equal(f.buttons('bkDays').length, 1);
  await f.selectTime(); await f.click('bkContinue'); await f.click('bkBook');
  const booking = f.requests.find(r => r.path === 'book');
  assert.equal(booking.body.address1, '456 Next Street');
  assert.equal(booking.body.start, DAYS[7].slots[0].start);
});

test('a taken slot refreshes dates and cannot reuse the stale selection', async () => {
  const f = await fixture(); await f.details();
  f.$('q_project').value = 'Keep this answer';
  f.responses.book.push({ ok: false, taken: true, days: [DAYS[10]], error: 'That appointment is no longer available.' });
  await f.click('bkBook');
  assert.equal(f.visible('stepTime'), true);
  assert.equal(f.visible('stepDetails'), false);
  assert.equal(f.$('bkContinue').disabled, true);
  assert.equal(f.buttons('bkDays').length, 1);
  assert.match(f.$('bkTimeErr').textContent, /no longer available/);
  await f.selectTime(); await f.click('bkContinue');
  assert.equal(f.$('q_project').value, 'Keep this answer');
  await f.click('bkBook');
  assert.equal(f.requests.filter(r => r.path === 'book').at(-1).body.start, DAYS[10].slots[0].start);
});

test('a conflict with no remaining days clears every old date and time', async () => {
  const f = await fixture(); await f.details();
  f.responses.book.push({ ok: false, taken: true, days: [], error: 'No appointments remain.' });
  await f.click('bkBook');
  assert.equal(f.visible('stepTime'), true);
  assert.equal(f.buttons('bkDays').length, 0);
  assert.equal(f.buttons('bkTimeBtns').length, 0);
  assert.equal(f.$('bkContinue').disabled, true);
  await f.click('st3'); await f.click('bkContinue');
  assert.equal(f.visible('stepDetails'), false);
  assert.equal(f.requests.filter(r => r.path === 'book').length, 1);
});

test('out-of-area addresses retain the callback flow and original address', async () => {
  const f = await fixture(); f.responses.slots.push({ ok: true, in_area: false }); await f.address();
  assert.equal(f.visible('stepOut'), true);
  assert.equal(f.visible('stepTime'), false);
  f.$('ooName').value = 'Sam Example'; f.$('ooPhone').value = '9285550101'; f.$('ooEmail').value = 'sam@example.com'; f.$('ooProject').value = 'Patio';
  await f.click('ooSend');
  assert.equal(f.requests.find(r => r.path === 'lead').body.address1, '123 Test Street');
  assert.equal(f.visible('stepDone'), true);
});

test('closed and unavailable slots remain on the address step without enabling booking', async () => {
  for (const response of [{ open: false }, { ok: false, error: 'Availability cannot be confirmed.' }, { ok: true, in_area: true, days: [] }]) {
    const f = await fixture(); f.responses.slots.push(response); await f.address();
    assert.equal(f.visible('stepAddr'), true);
    assert.equal(f.visible('stepDetails'), false);
    assert.equal(f.$('bkAddrNext').disabled, false);
    assert.ok(f.$('bkAddrErr').textContent);
  }
});

test('the address availability request cannot be double-clicked and can recover from a network error', async () => {
  const f = await fixture(); let fail;
  f.responses.slots.push(() => new Promise((resolve, reject) => { fail = reject; }));
  await f.address();
  assert.equal(f.$('bkAddrNext').disabled, true);
  await f.click('bkAddrNext');
  assert.equal(f.requests.filter(r => r.path === 'slots').length, 1);
  fail(new Error('Offline')); await f.settle();
  assert.equal(f.$('bkAddrNext').disabled, false);
  assert.ok(f.$('bkAddrErr').textContent);
  await f.click('bkAddrNext');
  assert.equal(f.requests.filter(r => r.path === 'slots').length, 2);
  assert.equal(f.visible('stepTime'), true);
});

test('booking stays single-submit while pending and preserves answers after a network error', async () => {
  const f = await fixture(); await f.details(); let fail;
  f.$('q_project').value = 'Keep this project text';
  f.responses.book.push(() => new Promise((resolve, reject) => { fail = reject; }));
  await f.click('bkBook');
  assert.equal(f.$('bkBook').disabled, true);
  await f.click('bkBook');
  assert.equal(f.requests.filter(r => r.path === 'book').length, 1);
  fail(new Error('Offline')); await f.settle();
  assert.equal(f.$('bkBook').disabled, false);
  assert.equal(f.visible('stepDetails'), true);
  assert.equal(f.$('q_project').value, 'Keep this project text');
  assert.ok(f.$('bkErr').textContent);
});

test('builder preview disables navigation and submissions while accepting live form drafts', async () => {
  const f = await fixture({ preview: true });
  for (const id of ['st1', 'st2', 'st3', 'bkAddrNext', 'bkDatePrev', 'bkDateNext', 'bkContinue', 'bkChangeAddress', 'bkChangeTime', 'ooChangeAddress', 'bkBook', 'ooSend']) {
    assert.equal(f.$(id).disabled, true, id + ' disabled in preview');
    await f.click(id);
  }
  assert.equal(f.requests.some(r => ['slots', 'book', 'lead'].includes(r.path)), false);
  assert.equal(f.visible('stepAddr'), true);
  assert.equal(f.visible('stepTime'), true);
  assert.equal(f.visible('stepDetails'), true);
  f.window.dispatchEvent({ type: 'message', data: { pecBookingPreview: {
    headline: 'A visit for your project', intro: 'Choose a time that works.', success: 'See you then.',
    typeLabel: 'Walkthrough', duration: 30,
    questions: [{ id: 'new_question', label: 'Project type', type: 'short_text', required: false }],
  } } });
  assert.equal(f.$('bkHeadline').textContent, 'A visit for your project');
  assert.equal(f.$('bkIntro').textContent, 'Choose a time that works.');
  assert.equal(f.$('doneMsg').textContent, 'See you then.');
  assert.match(f.$('bkChosen').textContent, /Walkthrough.*30/);
  assert.ok(f.$('q_new_question'));
  assert.equal(f.$('bkQuestions').querySelector('#q_source'), null);
});
