'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bookingDiscovery } = require('./booking-discovery.cjs');

const brand = { business_name: 'Prescott Epoxy Company', phone: '(928) 800-8154' };
const form = { slug: 'pec', active: true, headline: 'Book your estimate', intro_text: 'Choose a time for your visit.', appt_types: [{ label: 'On-site estimate' }] };
const options = { brand, form, publicBooking: true, siteUrl: 'https://prescottepoxy.netlify.app' };
const schema = output => JSON.parse(output.head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);

test('public page describes the configured business and service without static availability', () => {
  const output = bookingDiscovery(options);
  assert.equal(output.canonicalUrl, 'https://prescottepoxy.netlify.app/book');
  assert.equal(output.robots, 'index, follow');
  const page = schema(output);
  assert.equal(page.name, form.headline);
  assert.equal(page.description, form.intro_text);
  assert.equal(page.mainEntity.name, 'On-site estimate');
  assert.equal(page.mainEntity.provider.name, brand.business_name);
  assert.equal(page.mainEntity.provider.telephone, brand.phone);
  assert.doesNotMatch(output.head, /offers|openingHours|availability|aggregateRating/);
});

test('private, closed, preview, embedded and missing forms never receive public metadata', () => {
  for (const change of [{ publicBooking: false }, { publicBooking: undefined }, { preview: true }, { embed: true }, { form: null }, { form: { ...form, active: false } }]) {
    assert.deepEqual(bookingDiscovery({ ...options, ...change }), { head: '', robots: 'noindex, nofollow', canonicalUrl: null });
  }
  assert.deepEqual(bookingDiscovery(), { head: '', robots: 'noindex, nofollow', canonicalUrl: null });
});

test('canonical URLs use the trusted origin and collapse PEC aliases', () => {
  assert.equal(bookingDiscovery({ ...options, siteUrl: 'https://booking.example.com/path?private=secret#fragment' }).canonicalUrl, 'https://booking.example.com/book');
  assert.equal(bookingDiscovery({ ...options, form: { ...form, slug: 'PEC' } }).canonicalUrl, options.siteUrl + '/book');
  assert.equal(bookingDiscovery({ ...options, form: { ...form, slug: 'painting' } }).canonicalUrl, options.siteUrl + '/book/painting');
  for (const slug of ['../manage/private', 'pec?token=secret', 'pec#private', '"><script>']) {
    assert.equal(bookingDiscovery({ ...options, form: { ...form, slug } }).canonicalUrl, null);
  }
});

test('invalid, credential-bearing and insecure origins use the production fallback', () => {
  for (const siteUrl of [undefined, 'not a url', '//evil.example', 'javascript:alert(1)', 'http://example.com', 'https://user:secret@example.com']) {
    assert.equal(bookingDiscovery({ ...options, siteUrl }).canonicalUrl, options.siteUrl + '/book');
  }
});

test('metadata escapes attribute and script injection while preserving readable values', () => {
  const injected = '\"><script>alert("x")</script>&\u2028\u2029';
  const output = bookingDiscovery({ ...options, brand: { business_name: injected, phone: injected }, form: { ...form, intro_text: injected, headline: injected, appt_types: [{ label: injected }] } });
  assert.equal((output.head.match(/<script/g) || []).length, 1);
  assert.equal((output.head.match(/<\/script>/g) || []).length, 1);
  assert.match(output.head, /content="&quot;&gt;&lt;script&gt;/);
  const page = schema(output);
  assert.equal(page.name, injected.trim());
  assert.equal(page.mainEntity.provider.name, injected.trim());
});

test('only public allowlisted fields appear in metadata', () => {
  const output = bookingDiscovery({ ...options, brand: { ...brand, api_key: 'secret-brand' }, form: { ...form, questions: [{ secret: 'secret-question' }], booking_manage_token: 'secret-token' }, request: { headers: { host: 'attacker.example' } } });
  assert.doesNotMatch(output.head, /secret-|attacker\.example|questions|booking_manage_token/);
});

test('missing optional copy and business fields produce no invented business information', () => {
  const page = schema(bookingDiscovery({ publicBooking: true, form: { slug: 'pec' } }));
  assert.equal(page.name, 'Book an appointment');
  assert.equal(page.mainEntity.name, 'Appointment');
  assert.equal(page.mainEntity.provider, undefined);
  assert.equal(page.mainEntity.address, undefined);
});
