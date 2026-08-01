// Fixture test for the lead-source vocabulary resolver (prompt 61 Part D),
// driving the REAL netlify/functions/_pec-lead-source.cjs against the shared
// mini-PostgREST harness. Run: node production/lead-source.test.cjs
'use strict';
const { resolveLeadSourceName } = require('../netlify/functions/_pec-lead-source.cjs');
const { makeDb, makeChecker } = require('./_drip-test-kit.cjs');

const { state, ok } = makeChecker();

const fx = makeDb({
  pec_lead_sources: [
    { id: 's1', name: 'Facebook', active: true, aliases: ['meta'] },
    { id: 's2', name: 'Google', active: true, aliases: [] },
    { id: 's3', name: 'Website', active: true, aliases: ['webform'] },
    { id: 's4', name: 'Google LSA', active: true, aliases: ['google_lsa'] },
    { id: 's5', name: 'Other', active: true, aliases: [] },
  ],
});

(async () => {
  console.log('# resolveLeadSourceName: exact > case-insensitive > alias > raw');
  ok(await resolveLeadSourceName(fx.sb, 'Facebook') === 'Facebook', 'exact name match returns the canonical name');
  ok(await resolveLeadSourceName(fx.sb, 'google') === 'Google', 'case-insensitive name match canonicalizes the case');
  ok(await resolveLeadSourceName(fx.sb, 'OTHER') === 'Other', 'all-caps still matches case-insensitively');
  ok(await resolveLeadSourceName(fx.sb, 'meta') === 'Facebook', 'alias resolves to its managed name');
  ok(await resolveLeadSourceName(fx.sb, 'WEBFORM') === 'Website', 'aliases match case-insensitively too');
  ok(await resolveLeadSourceName(fx.sb, 'google_lsa') === 'Google LSA', 'underscore token alias resolves');
  ok(await resolveLeadSourceName(fx.sb, 'routemize') === 'routemize', 'NO MATCH returns the raw value unchanged (attribution is never nulled or guessed)');
  ok(await resolveLeadSourceName(fx.sb, '  meta  ') === 'Facebook', 'surrounding whitespace is trimmed before matching');
  ok(await resolveLeadSourceName(fx.sb, '') === '' && await resolveLeadSourceName(fx.sb, null) === '', 'empty and null resolve to empty, never a guess');
  {
    // A failed list read must resolve to the raw value: intake never fails
    // because of a vocabulary lookup.
    const broken = async () => { throw new Error('supabase down'); };
    ok(await resolveLeadSourceName(broken, 'meta') === 'meta', 'a failed pec_lead_sources read keeps the raw value');
  }

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
})().catch(err => { console.error('fixture crashed:', err); process.exit(1); });
