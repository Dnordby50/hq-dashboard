'use strict';
// Canonical BLANK-placeholder detection for the estimate scope of work.
// ONE source of truth, required by BOTH the estimator (client, via Vite's
// CJS interop) and pec-estimate-scope.cjs (server), so the KEYS they compute
// for the same placeholder match and an answer collected in the estimator is
// the same answer the server substitutes on the next scope write.
//
// Dylan's DripJobs templates carry the literal word BLANK ("Scope of work for
// quartz coating BLANK AREA", "Expected project duration: BLANK"). 15b's scope
// writer correctly leaves unresolvable placeholders verbatim rather than
// inventing content, which means a BLANK can ride to a customer. 15c turns each
// literal BLANK into a question the rep answers; the answer is substituted here
// before the text reaches the model, and any unanswered BLANK stays verbatim
// (and trips the send warning).
//
// Detection is DATA-DRIVEN: scan for the literal token BLANK (word boundary,
// case sensitive, so a customer named Blank Smith never trips it). If Dylan
// edits a template and removes a BLANK, its question disappears on its own.

// Word-boundary, case-sensitive. Global so we can walk every occurrence.
const BLANK_RE = /\bBLANK\b/g;
const TOKEN = 'BLANK';

// Does this text still contain a literal BLANK? Drives the send-gate warning.
function containsBlank(text) {
  BLANK_RE.lastIndex = 0;
  return BLANK_RE.test(String(text == null ? '' : text));
}

function lineBounds(text, idx) {
  const start = text.lastIndexOf('\n', idx - 1) + 1;
  let end = text.indexOf('\n', idx);
  if (end === -1) end = text.length;
  return { start, end };
}

// Nearest non-empty line ABOVE lineStart (so a lone "BLANK" borrows the label
// of the "Expected project duration:" line above it).
function prevNonEmptyLine(text, lineStart) {
  let end = lineStart - 1;
  while (end > 0) {
    const s = text.lastIndexOf('\n', end - 1) + 1;
    const line = text.slice(s, end).trim();
    if (line) return line;
    end = s - 1;
  }
  return '';
}

// Dependency-free stable hash (djb2) of the placeholder's CONTEXT, so an
// answer survives a regeneration (same template -> same key) but a template
// edit that changes the surrounding words retires the old key naturally.
function stableKey(contextLabel, context, ordinal) {
  const norm = (String(contextLabel || '') + '|' + String(context || '')).toLowerCase().replace(/\s+/g, ' ').trim();
  let h = 5381;
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) >>> 0;
  return 'b' + h.toString(16) + (ordinal ? '-' + ordinal : '');
}

// Every literal BLANK in `text`, each as a question with a stable key and
// enough context that the rep knows what is being asked. contextLabel names
// where the text came from (system or add-on name) so identical wording across
// two templates does not collide.
//   { key, label, context, contextLabel, index }
// label is the short prompt shown to the rep; index is the char offset (used by
// applyAnswers to substitute in place).
function detectBlanks(text, contextLabel) {
  const src = String(text == null ? '' : text);
  const out = [];
  const seen = Object.create(null);
  let m;
  BLANK_RE.lastIndex = 0;
  while ((m = BLANK_RE.exec(src)) !== null) {
    const idx = m.index;
    const { start, end } = lineBounds(src, idx);
    const line = src.slice(start, end).trim();
    const isLone = line === TOKEN;
    const context = isLone ? (prevNonEmptyLine(src, start) || 'Scope detail') : line;
    const ord = (seen[context] = (seen[context] || 0) + 1) - 1; // 0-based within identical contexts
    const key = stableKey(contextLabel, context, ord);
    const label = isLone
      ? context.replace(/:\s*$/, '')
      : line.replace(/\bBLANK\b/, '____');
    out.push({ key, label, context, contextLabel: contextLabel || null, index: idx });
  }
  return out;
}

// Substitute answers into `text`. Each BLANK is replaced by its answer (keyed by
// the same stableKey detectBlanks computes) or left as the literal BLANK when
// unanswered. Walks occurrences in order so indices stay valid.
function applyAnswers(text, answersByKey, contextLabel) {
  const src = String(text == null ? '' : text);
  const blanks = detectBlanks(src, contextLabel);
  if (!blanks.length) return src;
  const ans = answersByKey || {};
  let out = '';
  let cursor = 0;
  for (const b of blanks) {
    out += src.slice(cursor, b.index);
    const v = ans[b.key];
    out += (v != null && String(v).trim()) ? String(v).trim() : TOKEN;
    cursor = b.index + TOKEN.length;
  }
  out += src.slice(cursor);
  return out;
}

// Prompt 78 D1: every customer-visible unfilled placeholder in `text`, as
// structured findings so the send gate can quote the offending text back to
// the rep. Three detectors, and no others:
//   blank      the literal BLANK (BLANK_RE above; case sensitivity is
//              deliberate and load-bearing: a customer named Blank Smith must
//              never trip it)
//   choice     an unresolved "is/is not" or "are/are not" template choice.
//              Dylan's templates carry "Stem walls are/are not included"; the
//              scope writer leaves them verbatim when the intake cannot
//              resolve them. The live Metallic template has a DOUBLE space in
//              "is/is not  included", so \s+ on the tail is required, not
//              cosmetic.
//   underscore a ___ fill-in run. mdToSafeHtml renders --- as a horizontal
//              rule and never ___, so an underscore run in a scope is always
//              a fill-in; no divider heuristic needed.
// Each finding is {kind, snippet}: snippet is the trimmed surrounding line,
// capped at 60 characters, so the blocker message shows what to look for.
const CHOICE_RE = /\b(is|are)\s*\/\s*(is|are)\s+not\b/gi;
const UNDERSCORE_RE = /_{3,}/g;

function scopeBlanks(text) {
  const src = String(text == null ? '' : text);
  const out = [];
  const scan = (re, kind) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const { start, end } = lineBounds(src, m.index);
      let snippet = src.slice(start, end).trim();
      if (snippet.length > 60) snippet = snippet.slice(0, 57) + '...';
      out.push({ kind, snippet });
    }
  };
  scan(BLANK_RE, 'blank');
  scan(CHOICE_RE, 'choice');
  scan(UNDERSCORE_RE, 'underscore');
  return out;
}

// Open questions across a set of {text, contextLabel} sources, deduped by key,
// EXCLUDING any the given answers already cover. This is what both the
// estimator (from the chosen systems' templates) and the estimate page (from
// the server-stored list) render.
function openQuestions(sources, answersByKey) {
  const ans = answersByKey || {};
  const byKey = new Map();
  for (const s of (sources || [])) {
    for (const q of detectBlanks(s.text, s.contextLabel)) {
      const answered = ans[q.key] != null && String(ans[q.key]).trim() !== '';
      if (!answered && !byKey.has(q.key)) {
        byKey.set(q.key, { key: q.key, label: q.label, context: q.context, contextLabel: q.contextLabel });
      }
    }
  }
  return [...byKey.values()];
}

module.exports = { containsBlank, detectBlanks, applyAnswers, openQuestions, stableKey, scopeBlanks };
