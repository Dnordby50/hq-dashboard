// Unit test for the Routemize customerAnswers -> customer_notes mapping
// (prompt 65 Part A). Routemize sends question UUIDs where question text
// belongs, and customer_notes rides on every customer-facing confirmation
// and reminder, so ID-shaped keys must be stripped at intake. A real
// Routemize payload cannot be faked honestly, so this drives the exported
// pure mapper with a synthetic payload instead of the HTTP handler.
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

console.log('appt-notes.test.cjs (prompt 65 Part A)');

// The four required cases: UUID key, human-text key, no key, empty answer.
ok('UUID question key is dropped; the line is just the answer', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([{ question: '605f816a-b861-c865-3e12-3a2177755a80', answer: 'Had epoxy system installed' }]),
    ['Had epoxy system installed'],
  );
});

ok('human-text question key survives as "Question: answer"', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([{ question: "What's the project?", answer: 'Garage floor' }]),
    ["What's the project?: Garage floor"],
  );
});

ok('no question key keeps the bare answer (today\'s behavior)', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([{ answer: 'Please use the side gate' }]),
    ['Please use the side gate'],
  );
});

ok('empty answer drops the line entirely, even with a real question', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([
      { question: 'Gate code?', answer: '' },
      { question: '1077d4b4-4c1d-1f34-52a1-3a2177807ce1', answer: null },
      { question: 'Anything else?' },
    ]),
    [],
  );
});

// The exact two lines Dylan pasted from the live bug, end to end.
ok('the live payload shape: both stored lines lose their UUID prefixes', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([
      {
        question: '605f816a-b861-c865-3e12-3a2177755a80',
        answer: 'Had epoxy system installed in garage and front apron 2 years ago - the front apron appears stained or possibly the clear coat is rubbing off and needs to be repaired - no gate or special directions',
      },
      { question: '1077d4b4-4c1d-1f34-52a1-3a2177807ce1', answer: 'Other' },
    ]),
    [
      'Had epoxy system installed in garage and front apron 2 years ago - the front apron appears stained or possibly the clear coat is rubbing off and needs to be repaired - no gate or special directions',
      'Other',
    ],
  );
});

// Guardrails on the ID detector: conservative, keeps real text.
ok('detector edges: opaque tokens drop, real text stays', () => {
  // Non-hyphenated UUID / long hex token with no spaces: ID.
  assert.strictEqual(isIdLikeQuestionKey('605f816ab861c8653e123a2177755a80'), true);
  // Hyphenated UUID, uppercase: ID.
  assert.strictEqual(isIdLikeQuestionKey('605F816A-B861-C865-3E12-3A2177755A80'), true);
  // Short question with spaces: real text.
  assert.strictEqual(isIdLikeQuestionKey("What's the project?"), false);
  // Long single word with no digits: real text (conservative rule).
  assert.strictEqual(isIdLikeQuestionKey('Approximatelyhowbig'), false);
  // Short token: real text (below the 16-char opaque threshold).
  assert.strictEqual(isIdLikeQuestionKey('Q1'), false);
  // Sentence containing digits and spaces: real text.
  assert.strictEqual(isIdLikeQuestionKey('How many square feet is area 1?'), false);
  // Empty / missing: not an ID (the no-key branch handles it).
  assert.strictEqual(isIdLikeQuestionKey(''), false);
  assert.strictEqual(isIdLikeQuestionKey(null), false);
});

// Malformed entries never throw and never emit garbage.
ok('malformed entries (non-object, null) are skipped', () => {
  assert.deepStrictEqual(
    mapCustomerAnswers([null, 'just a string', 42, { question: 'Real question?', answer: 'Yes' }]),
    ['Real question?: Yes'],
  );
  assert.deepStrictEqual(mapCustomerAnswers(undefined), []);
  assert.deepStrictEqual(mapCustomerAnswers('not an array'), []);
});

console.log(`appt-notes.test.cjs: ${checks} checks, 0 failed`);
