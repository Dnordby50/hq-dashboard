'use strict';
// Prompt 94 B2: the {{token}} fill-in mechanism in production/scope.cjs.
// tokenFields drives the line editor's compact form, applyTokens substitutes
// answers, and scopeBlanks' 'token' scan is what makes an unfilled token a
// HARD send blocker on both the server gate (optional-lines.cjs
// scopeSendBlockers) and the dashboard mirror (index.html estScopeBlanks).

const { tokenFields, applyTokens, scopeBlanks } = require('./scope.cjs');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${label}`); }
}

// ---- tokenFields ----------------------------------------------------------
{
  const t = tokenFields('Install begins {{install_date}}. Stem walls: {{stem_walls}}. Done by {{install_date}}.');
  ok(t.length === 2, 'tokenFields dedupes repeated tokens');
  ok(t[0].name === 'install_date' && t[0].type === 'date', 'a _date suffix infers the date type');
  ok(t[0].label === 'Install date', 'label humanizes snake_case');
  ok(t[1].name === 'stem_walls' && t[1].type === 'text', 'everything else is text');
}
{
  ok(tokenFields('No tokens here, just BLANK and ___.').length === 0, 'BLANK and ___ are not tokens');
  ok(tokenFields('{{ spaced_name }}').length === 1 && tokenFields('{{ spaced_name }}')[0].name === 'spaced_name', 'inner whitespace tolerated');
  ok(tokenFields('{{Install_Date}} {{bad name}} {{9lives}}').length === 0, 'malformed tokens (caps, spaces, leading digit) get NO form field');
}

// ---- applyTokens ----------------------------------------------------------
{
  const src = 'Install begins {{install_date}} at {{address}}. Ends {{install_date}}.';
  const out = applyTokens(src, { install_date: 'September 3, 2026' });
  ok(out === 'Install begins September 3, 2026 at {{address}}. Ends September 3, 2026.',
    'applyTokens substitutes every occurrence of an answered token and leaves the rest verbatim');
  ok(applyTokens(src, { install_date: '   ' }) === src, 'a whitespace-only answer substitutes nothing');
  ok(applyTokens(src, {}) === src, 'no answers, no change');
  ok(applyTokens('{{Install_Date}}', { Install_Date: 'x' }) === '{{Install_Date}}',
    'malformed tokens never substitute (they block the send instead)');
}

// ---- scopeBlanks: the send gate scan --------------------------------------
{
  const found = scopeBlanks('Coating starts {{install_date}}.\nStem walls {{Stem Walls}} included.');
  const tokens = found.filter((f) => f.kind === 'token');
  ok(tokens.length === 2, 'both well-formed AND malformed {{...}} block the send');
  ok(tokens[0].snippet.includes('{{install_date}}'), 'the snippet quotes the offending line');
}
{
  const found = scopeBlanks('Duration: BLANK\nStem walls are/are not included.\nName: _____\nDate: {{install_date}}');
  const kinds = found.map((f) => f.kind).sort();
  ok(JSON.stringify(kinds) === JSON.stringify(['blank', 'choice', 'token', 'underscore']),
    'the token scan joins the three existing detectors without disturbing them');
}
{
  ok(scopeBlanks('A filled scope with no placeholders at all.').length === 0, 'clean text produces zero findings');
  ok(scopeBlanks('Braces in code {like this} are fine.').length === 0, 'single braces never trip the scan');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
