// Prompt 70 tests: the comps HARD system filter and the per-line AI logic
// (production/ai-lines.cjs). Self-asserting Node script, no framework.
// Run with `npm test` or `node production/ai-lines.test.cjs`.

const {
  MIN_COMPS_SAMPLE,
  NO_COMPS_STATEMENT,
  LINES_SYSTEM_PROMPT,
  lineConfidence,
  scopeHash,
  linesInputsKey,
  buildLinesUserPrompt,
  parseLinesRecommendation,
  finalizeLinesRecommendation,
} = require('./ai-lines.cjs');

let passed = 0;
let failed = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  ok   ${label}`); }
  else {
    failed++;
    console.error(`  FAIL ${label}`);
    console.error(`       expected: ${e}`);
    console.error(`       actual:   ${a}`);
  }
}
function assertThrows(fn, re, label) {
  try { fn(); failed++; console.error(`  FAIL ${label} (expected throw)`); }
  catch (err) {
    if (re.test(String(err.message))) { passed++; console.log(`  ok   ${label}`); }
    else { failed++; console.error(`  FAIL ${label} (got: ${err.message})`); }
  }
}

console.log('ai-lines.test.cjs');

// ---------------------------------------------------------------------------
// The comps HARD system filter (production/comps.js, ESM: dynamic import)
// ---------------------------------------------------------------------------
(async () => {
  const { buildComps, compsRuleLabel } = await import('./comps.js');
  const now = Date.parse('2026-08-04');
  const day = (d) => new Date(now - d * 86400000).toISOString();
  const cand = (id, sys, sqft, price, daysAgo) => ({
    id, customer_name: id, system_type_id: sys, completed_date: day(daysAgo),
    sqft, price, ppsf: price / sqft, gp_pct: null, gp_complete: false,
  });
  // 1 quartz job, 5 flake jobs, all in-window. The OLD ladder would have
  // priced a quartz estimate off the flake set once same-system fell short.
  const candidates = [
    cand('q1', 'quartz', 2000, 16000, 30), // outside the 25% band of a 1000-sqft target

    cand('f1', 'flake', 800, 5600, 10),
    cand('f2', 'flake', 900, 6000, 20),
    cand('f3', 'flake', 1000, 6400, 40),
    cand('f4', 'flake', 1100, 7000, 50),
    cand('f5', 'flake', 2400, 12000, 60),
  ];

  {
    const c = buildComps({ candidates, systemTypeId: 'quartz', sqft: 1000, now });
    assertEq(c.rule, 'same_system', 'hard filter: one quartz job -> same_system rule, NEVER cross-system');
    assertEq(c.sample_size, 1, 'hard filter: exactly the 1 quartz job, not the 5 flake jobs');
    assertEq(c.rows[0].id, 'q1', 'hard filter: the quartz job is the comp');
  }
  {
    const c = buildComps({ candidates, systemTypeId: 'metallic', sqft: 1000, now });
    assertEq(c.rule, 'none', 'hard filter: ZERO same-system jobs -> none, not a widened set');
    assertEq(c.sample_size, 0, 'hard filter: zero comps is the honest answer');
    assertEq(/no completed .* jobs/.test(compsRuleLabel(c, 'Metallic')), true, 'none label names the system');
  }
  {
    const c = buildComps({ candidates, systemTypeId: 'flake', sqft: 1000, now });
    assertEq(c.rule, 'exact', 'exact rule still wins with >= 3 similar-size same-system jobs');
    assertEq(c.sample_size, 4, 'exact set: the four flake jobs inside the 25% band');
  }
  {
    const c = buildComps({ candidates, systemTypeId: 'flake', sqft: 1000, now, minSample: 5 });
    assertEq(c.rule, 'same_system', 'minSample knob: raising it to 5 widens to same-system any-size');
    assertEq(c.sample_size, 5, 'minSample knob: all five flake jobs');
  }
  {
    const c = buildComps({ candidates, systemTypeId: null, sqft: 1000, now });
    assertEq(c.rule, 'none', 'no system (a custom line) -> no comps, never a cross-system guess');
  }

  // -------------------------------------------------------------------------
  // Confidence: a SERVER-computed fact from the sample, never model-claimed
  // -------------------------------------------------------------------------
  assertEq(lineConfidence(null), 'no_comps', 'confidence: null comps (custom line) -> no_comps');
  assertEq(lineConfidence({ sample_size: 0 }), 'no_comps', 'confidence: zero sample -> no_comps');
  assertEq(lineConfidence({ sample_size: 1 }), 'thin_sample', 'confidence: 1 comp -> thin_sample');
  assertEq(lineConfidence({ sample_size: 2 }), 'thin_sample', 'confidence: 2 comps -> thin_sample');
  assertEq(lineConfidence({ sample_size: 3 }), 'comps_backed', 'confidence: 3 comps -> comps_backed (default min)');
  assertEq(lineConfidence({ sample_size: 3 }, 5), 'thin_sample', 'confidence: min 5 -> 3 comps is thin');
  assertEq(MIN_COMPS_SAMPLE, 3, 'default min sample matches the comps ladder');

  // -------------------------------------------------------------------------
  // Inputs key: cheap, per-line, order-sensitive, scope-sensitive
  // -------------------------------------------------------------------------
  const calcLine = (key, sys, sqft, mvb) => ({ line_key: key, kind: 'calc', label: key, system_type_id: sys, system_type_name: sys, sqft, mvb, calc_price: 1000, target_gp_pct: 50, comps: null });
  const customLine = (key, price, scope) => ({ line_key: key, kind: 'custom', label: key, calc_price: price, scope_text: scope, comps: null });
  {
    const a = [calcLine('a', 'flake', 800, false), customLine('b', 1500, 'stairs')];
    const k1 = linesInputsKey(a);
    assertEq(k1, linesInputsKey([calcLine('a', 'flake', 800, false), customLine('b', 1500, 'stairs')]), 'inputs key: stable for identical lines');
    assertEq(k1 === linesInputsKey([calcLine('a', 'flake', 900, false), customLine('b', 1500, 'stairs')]), false, 'inputs key: sqft change changes the key');
    assertEq(k1 === linesInputsKey([calcLine('a', 'flake', 800, true), customLine('b', 1500, 'stairs')]), false, 'inputs key: mvb change changes the key');
    assertEq(k1 === linesInputsKey([calcLine('a', 'flake', 800, false), customLine('b', 1500, 'stairs REDONE')]), false, 'inputs key: custom scope edit changes the key');
    assertEq(k1 === linesInputsKey([customLine('b', 1500, 'stairs'), calcLine('a', 'flake', 800, false)]), false, 'inputs key: line order matters');
    assertEq(scopeHash('stairs') === scopeHash('stairs '), false, 'scope hash is content-sensitive');
  }

  // -------------------------------------------------------------------------
  // Prompt builder: per-line comps isolation + the custom no-comps framing
  // -------------------------------------------------------------------------
  {
    const lines = [
      { ...calcLine('L0', 'flake', 800, false), system_type_name: 'Standard Flake', comps: { rule: 'exact', rule_label: '4 jobs, same system', sample_size: 4, median_ppsf: 6.1, rows: [{ sqft: 900, price: 6000, ppsf: 6.67, gp_pct: 0.55 }] } },
      { ...customLine('L1', 1500, 'Coat a set of shop stairs. Handrails are not included.') },
    ];
    const prompt = buildLinesUserPrompt({ calc_price: 8350, sqft: 1200, lines }, { available: false });
    assertEq(/"line_key":"L0"/.test(prompt) && /"line_key":"L1"/.test(prompt), true, 'prompt carries every line by key');
    assertEq(/NONE\. No comparable jobs exist for this line\./.test(prompt), true, 'custom line prompt states no comparables');
    assertEq(/typed_scope_of_work/.test(prompt) && /shop stairs/.test(prompt), true, 'custom line reasons from the typed scope');
    assertEq(/NO CALL OR TEXT HISTORY/.test(prompt), true, 'empty history stays the honest framing');
    assertEq(/never mix one line's comps/i.test(LINES_SYSTEM_PROMPT), true, 'system prompt forbids cross-line comps mixing');
    assertEq(/MUST state explicitly that no comparable jobs exist/.test(LINES_SYSTEM_PROMPT), true, 'system prompt demands the no-comparables statement');
  }

  // -------------------------------------------------------------------------
  // Parse + finalize: validation, confidence stamping, rollup sums
  // -------------------------------------------------------------------------
  {
    const sent = [
      { ...calcLine('L0', 'flake', 800, false), comps: { rule: 'exact', rule_label: 'x', sample_size: 4, median_ppsf: 6, rows: [] } },
      { ...calcLine('L1', 'quartz', 400, false), comps: { rule: 'same_system', rule_label: 'x', sample_size: 1, median_ppsf: 7, rows: [] } },
      { ...customLine('L2', 1500, 'stairs') },
    ];
    const modelText = JSON.stringify({
      lines: [
        { line_key: 'L0', recommended_low: 4000, recommended_high: 4400, why: 'sits near the median.' },
        { line_key: 'L1', recommended_low: 2855, recommended_high: 3100, why: 'only one comp; thin.' },
        { line_key: 'L2', recommended_low: 1500, recommended_high: 1700, why: 'priced from the typed scope alone.' },
      ],
      rollup_why: 'The package holds its margins; the quartz line is the one to watch.',
      intent_read: null,
    });
    const parsed = parseLinesRecommendation(modelText, sent);
    const rec = finalizeLinesRecommendation(parsed, sent);
    assertEq(rec.lines.map((l) => l.confidence), ['comps_backed', 'thin_sample', 'no_comps'], 'confidence stamped per line from the SERVER-side sample counts');
    assertEq(rec.recommended_low, 4000 + 2855 + 1500, 'rollup low = SUM of line lows (server-derived, never model math)');
    assertEq(rec.recommended_high, 4400 + 3100 + 1700, 'rollup high = sum of line highs');
    assertEq(rec.why, 'The package holds its margins; the quartz line is the one to watch.', 'rollup why is the model paragraph');
    assertEq(rec.lines[2].why.startsWith(NO_COMPS_STATEMENT), true, 'custom why without the statement gets it PREPENDED deterministically');

    const modelText2 = JSON.stringify({
      lines: [
        { line_key: 'L0', recommended_low: 4000, recommended_high: 4400, why: 'ok' },
        { line_key: 'L1', recommended_low: 2855, recommended_high: 3100, why: 'ok' },
        { line_key: 'L2', recommended_low: 1500, recommended_high: 1700, why: 'No comparable jobs exist here; the typed scope carries it.' },
      ],
      rollup_why: 'fine', intent_read: null,
    });
    const rec2 = finalizeLinesRecommendation(parseLinesRecommendation(modelText2, sent), sent);
    assertEq(rec2.lines[2].why.startsWith(NO_COMPS_STATEMENT), false, 'custom why that already states it is left alone');

    assertThrows(() => parseLinesRecommendation(JSON.stringify({ lines: [{ line_key: 'L0', recommended_low: 4000, recommended_high: 4400, why: 'ok' }], rollup_why: 'x' }), sent), /omitted line/, 'a missing line throws, never a partial render');
    assertThrows(() => parseLinesRecommendation(JSON.stringify({ lines: [{ line_key: 'L0', recommended_low: 4400, recommended_high: 4000, why: 'ok' }], rollup_why: 'x' }), [sent[0]]), /valid low\/high/, 'an inverted range throws');
    assertThrows(() => parseLinesRecommendation(JSON.stringify({ lines: [{ line_key: 'L0', recommended_low: 4000, recommended_high: 4400, why: 'ok' }] }), [sent[0]]), /rollup_why/, 'a missing rollup throws');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => { console.error(err); process.exit(1); });
