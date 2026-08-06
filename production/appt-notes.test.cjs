// Unit test for the Routemize customerAnswers mapping (prompt 65 Part A,
// reshaped by prompt 73 Part A). Routemize sends question UUIDs where
// question text belongs, and customer_notes rides on every customer-facing
// confirmation and reminder, so ID-shaped keys must be stripped at intake.
// Prompt 73 adds routing: a settings-driven questionId map sends each answer
// to the customer note, the internal (rep-only) notes, or the void, so the
// service-picker value stops dangling at the end of customer reminders
// ("...finished house floor.\nGrind and Seal"). A real Routemize payload
// cannot be faked honestly, so this drives the exported pure mapper with
// synthetic payloads (including the four REAL envelopes' answer shapes from
// the prompt-73 scoping) instead of the HTTP handler.
// Run: node production/appt-notes.test.cjs
'use strict';
const assert = require('assert');
const { mapCustomerAnswers, isIdLikeQuestionKey } = require('../netlify/functions/pec-appt-intake.cjs');

let checks = 0;
function ok(label, fn) {
  fn();
  checks++;
  console.log('  ✓ ' + label);
}

console.log('appt-notes.test.cjs (prompt 65 Part A + prompt 73 routing)');

// The live routing map: free-text description -> customer, picker -> internal.
const Q_DESC = '605f816a-b861-c865-3e12-3a2177755a80';
const Q_PICKER = '1077d4b4-4c1d-1f34-52a1-3a2177807ce1';
const ROUTING = { [Q_DESC]: 'customer', [Q_PICKER]: 'internal' };

// ---- prompt-65 behavior, preserved under the new two-stream shape ----------

ok('UUID question key is dropped; the customer line is just the answer', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([{ question: Q_DESC, answer: 'Had epoxy system installed' }]),
    { customer: ['Had epoxy system installed'], internal: [] },
  );
});

ok('human-text question key survives as "Question: answer"', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([{ question: "What's the project?", answer: 'Garage floor' }]),
    { customer: ["What's the project?: Garage floor"], internal: [] },
  );
});

ok('no question key keeps the bare answer', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([{ answer: 'Please use the side gate' }]),
    { customer: ['Please use the side gate'], internal: [] },
  );
});

ok('empty answer drops the line entirely, even with a real question', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([
      { question: 'Gate code?', answer: '' },
      { question: Q_PICKER, answer: null },
      { question: 'Anything else?' },
    ], ROUTING),
    { customer: [], internal: [] },
  );
});

// ---- prompt-73 routing: the four REAL envelopes from scoping ---------------

ok('Brent Boyer (description first): customer note is the description alone, picker goes internal', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([
      { questionId: Q_DESC, question: Q_DESC, answer: 'New house slab.  Want to grind and seal floor.  This will be the finished house floor.' },
      { questionId: Q_PICKER, question: Q_PICKER, answer: 'Grind and Seal' },
    ], ROUTING),
    {
      customer: ['New house slab.  Want to grind and seal floor.  This will be the finished house floor.'],
      internal: ['Service requested: Grind and Seal'],
    },
  );
});

ok('Rob Rudman (picker FIRST): order does not matter, no dangling "Other"', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([
      { questionId: Q_PICKER, question: Q_PICKER, answer: 'Other' },
      { questionId: Q_DESC, question: Q_DESC, answer: 'Interested in Quartz coating for front apron' },
    ], ROUTING),
    {
      customer: ['Interested in Quartz coating for front apron'],
      internal: ['Service requested: Other'],
    },
  );
});

ok('Lynette Williams: description alone, never the bare word "Other"', () => {
  const out = mapCustomerAnswers([
    { questionId: Q_DESC, question: Q_DESC, answer: 'Had epoxy system installed in garage and front apron 2 years ago - the front apron appears stained or possibly the clear coat is rubbing off and needs to be repaired - no gate or special directions' },
    { questionId: Q_PICKER, question: Q_PICKER, answer: 'Other' },
  ], ROUTING);
  assert.strictEqual(out.customer.length, 1);
  assert.ok(!out.customer.includes('Other'));
  assert.deepStrictEqual(out.internal, ['Service requested: Other']);
});

ok('picker-only envelope (Jason Magimel shape): customer stream can end up empty', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([{ questionId: Q_PICKER, question: Q_PICKER, answer: 'Epoxy Patio / Pool Deck' }], ROUTING),
    { customer: [], internal: ['Service requested: Epoxy Patio / Pool Deck'] },
  );
});

// ---- routing edges ----------------------------------------------------------

ok('unmapped questionId defaults to customer (and the UUID key is still stripped)', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([
      { questionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', question: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', answer: 'Brand new question the map has never seen' },
    ], ROUTING),
    { customer: ['Brand new question the map has never seen'], internal: [] },
  );
});

ok('drop route discards the answer entirely', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([{ questionId: Q_PICKER, answer: 'Other' }], { [Q_PICKER]: 'drop' }),
    { customer: [], internal: [] },
  );
});

ok('questionId absent: routing falls back to matching the question field', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([{ question: Q_PICKER, answer: 'Grind and Seal' }], ROUTING),
    { customer: [], internal: ['Service requested: Grind and Seal'] },
  );
});

ok('questionId wins over question when both are present and mapped differently', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([{ questionId: Q_DESC, question: Q_PICKER, answer: 'Porch' }], ROUTING),
    { customer: ['Porch'], internal: [] },
  );
});

ok('routing keys match case-insensitively (getter lowercases; mapper lowercases lookups)', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([{ questionId: Q_PICKER.toUpperCase(), answer: 'Other' }], { [Q_PICKER]: 'internal' }),
    { customer: [], internal: ['Service requested: Other'] },
  );
});

ok('no routing map at all keeps every answer customer-facing (pre-73 behavior)', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([
      { question: Q_DESC, answer: 'Porch' },
      { question: Q_PICKER, answer: 'Other' },
    ]),
    { customer: ['Porch', 'Other'], internal: [] },
  );
});

// ---- guardrails on the ID detector: conservative, keeps real text ----------

ok('detector edges: opaque tokens drop, real text stays', () => {
  assert.strictEqual(isIdLikeQuestionKey('605f816ab861c8653e123a2177755a80'), true);
  assert.strictEqual(isIdLikeQuestionKey('605F816A-B861-C865-3E12-3A2177755A80'), true);
  assert.strictEqual(isIdLikeQuestionKey("What's the project?"), false);
  assert.strictEqual(isIdLikeQuestionKey('Approximatelyhowbig'), false);
  assert.strictEqual(isIdLikeQuestionKey('Q1'), false);
  assert.strictEqual(isIdLikeQuestionKey('How many square feet is area 1?'), false);
  assert.strictEqual(isIdLikeQuestionKey(''), false);
  assert.strictEqual(isIdLikeQuestionKey(null), false);
});

// Malformed entries never throw and never emit garbage.
ok('malformed entries (non-object, null) are skipped', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([null, 'just a string', 42, { question: 'Real question?', answer: 'Yes' }]),
    { customer: ['Real question?: Yes'], internal: [] },
  );
  assert.deepStrictEqual(mapCustomerAnswers(undefined), { customer: [], internal: [] });
  assert.deepStrictEqual(mapCustomerAnswers('not an array'), { customer: [], internal: [] });
});

console.log(`appt-notes.test.cjs: ${checks} checks, 0 failed`);
