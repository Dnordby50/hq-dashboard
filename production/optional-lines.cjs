// Prompt 72: optional line items on ANY line. Pure helpers shared by the
// estimator PWA, pec-public-estimate.cjs, and the dashboard where practical,
// with the fixture tests driving the same code (the scope.cjs pattern).
//
// Line shape everywhere here is the estimate_line_items ROW shape:
//   { label, total, is_optional, selected_by_customer, estimate_area_id }
// (the legacy jsonb `optional` key is tolerated like lineItemsTotal does).

const isOptionalLine = (li) => !!li && (li.is_optional === true || li.optional === true);
const lineTotal = (li) => {
  const t = Number(li && li.total);
  return Number.isFinite(t) ? t : 0;
};
const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Choice group (prompt 106, 2026-09-21): "Customer chooses one". A line with
// a non-blank choice_group is one of the alternatives the customer picks
// EXACTLY ONE of. The pick lives in one place, estimates.choice_picked_line_id
// (threaded in here as `pickedId`); it is never derived from
// selected_by_customer or preselected. These helpers are THE rule: every
// totaling site (estimator, dashboard, public page, accept, PDF/Present via
// the public renderer, pipeline card via the stored price) goes through them.
//
//   countedChoice(items, pickedId)  the ONE choice line that counts toward a
//       number: the valid pick, else the recommended line, else the cheapest
//       (locked decision 12). Null when the estimate has no choice lines.
//   isIncludedLine(li, countedId)   whether a line is part of "the job" for
//       totals and job creation: required lines always, optional lines when
//       selected, choice lines only when they are the counted one.
//   splitLineTotals(items, {pickedId})  the stored numbers:
//       requiredOnly = required + counted choice (estimates.price while open)
//       allIn        = required + every optional + the MOST EXPENSIVE choice
//                      (estimates.price_all_options; never sums two choices)
//       opening      = required + selected optionals + counted choice
//       cheapest     = required + optional discounts + the cheapest choice
//                      (the lowest total any customer selection can reach)
// ---------------------------------------------------------------------------
const choiceGroupOf = (li) => {
  const g = li && li.choice_group;
  return typeof g === 'string' && g.trim() ? g.trim() : null;
};
const isChoiceLine = (li) => !!choiceGroupOf(li);
const lineId = (li) => (li && li.id != null ? String(li.id) : null);
function choiceLines(items) {
  return (Array.isArray(items) ? items : []).filter(isChoiceLine);
}
function choicePickValid(items, pickedId) {
  if (pickedId == null || pickedId === '') return false;
  return choiceLines(items).some(li => lineId(li) === String(pickedId));
}
function countedChoice(items, pickedId) {
  const choices = choiceLines(items);
  if (!choices.length) return null;
  if (choicePickValid(choices, pickedId)) return choices.find(li => lineId(li) === String(pickedId));
  const rec = choices.find(li => li.is_recommended === true);
  if (rec) return rec;
  return choices.reduce((best, li) => (best == null || lineTotal(li) < lineTotal(best) ? li : best), null);
}
const countedChoiceId = (items, pickedId) => lineId(countedChoice(items, pickedId));
function isIncludedLine(li, countedId) {
  if (!li) return false;
  if (isChoiceLine(li)) return countedId != null && lineId(li) === String(countedId);
  return !isOptionalLine(li) || li.selected_by_customer === true;
}
function includedLines(items, pickedId) {
  const list = Array.isArray(items) ? items : [];
  const countedId = countedChoiceId(list, pickedId);
  return list.filter(li => isIncludedLine(li, countedId));
}

function splitLineTotals(items, opts) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  const pickedId = opts && opts.pickedId != null ? opts.pickedId : null;
  const counted = countedChoice(list, pickedId);
  const countedId = lineId(counted);
  let requiredOnly = 0;
  let allIn = 0;
  let opening = 0;
  let cheapest = 0;
  let maxChoice = null;
  let minChoice = null;
  for (const li of list) {
    const t = lineTotal(li);
    if (isChoiceLine(li)) {
      if (maxChoice == null || t > maxChoice) maxChoice = t;
      if (minChoice == null || t < minChoice) minChoice = t;
      if (countedId != null && lineId(li) === countedId) { requiredOnly += t; opening += t; }
      continue;
    }
    allIn += t;
    if (!isOptionalLine(li)) {
      requiredOnly += t;
      opening += t;
      cheapest += t;
    } else {
      if (li.selected_by_customer === true) opening += t;
      if (t < 0) cheapest += t;
    }
  }
  if (maxChoice != null) allIn += maxChoice;
  if (minChoice != null) cheapest += minChoice;
  return {
    requiredOnly: round2(requiredOnly), allIn: round2(allIn), opening: round2(opening), cheapest: round2(cheapest),
    hasChoice: counted != null, countedId, picked: choicePickValid(list, pickedId),
  };
}

// Send gate (prompt 106): a choice group is meaningless with one member.
// Exactly one line carrying choice_group blocks sending; zero or two-plus
// pass this rule. Checked AFTER the has-content precondition by every caller
// (emptySendError first), never inside a per-line loop.
const CHOICE_GROUP_SEND_MESSAGE = 'A choice group needs at least two lines.';
function choiceGroupSendError(items) {
  return choiceLines(items).length === 1 ? CHOICE_GROUP_SEND_MESSAGE : null;
}

// Accept gate (prompt 106, locked decision 7): a choice group with no valid
// pick can never be signed. Server-enforced in the accept function; the page
// mirrors it by disabling the sign button. Customer-facing text, no em dash.
const CHOICE_PICK_REQUIRED_MESSAGE = 'Please choose one of the project options before signing.';
function choiceAcceptError(items, pickedId) {
  if (!choiceLines(items).length) return null;
  return choicePickValid(items, pickedId) ? null : CHOICE_PICK_REQUIRED_MESSAGE;
}

// Unpicked choice lines after a pick: the "Not selected" record (decision
// 11). Excluded from the job exactly like declined optional lines, but they
// are NOT declined lines (is_optional stays false), so readers that want
// both use notSelectedChoiceLines alongside isDeclinedLine.
function notSelectedChoiceLines(items, pickedId) {
  const list = Array.isArray(items) ? items : [];
  const countedId = countedChoiceId(list, pickedId);
  return list.filter(li => isChoiceLine(li) && lineId(li) !== countedId);
}

// The send gate (decision 1): an estimate cannot be SENT with zero required
// lines, because required lines are what a customer cannot untick, which is
// what makes the customer floor automatic. Checked on the SEND path only, so
// a rep mid-build is never blocked by a half-built estimate.
const SEND_GATE_MESSAGE = 'At least one line has to be required. A customer cannot be sent an estimate they can untick to nothing.';
function sendGateError(items) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!list.length) return null; // no lines at all is a different problem, not this gate
  return list.every(isOptionalLine) ? SEND_GATE_MESSAGE : null;
}

// Prompt 84 (Bug 2): "the different problem" the comment above always
// deferred to, built. An EMPTY estimate must never reach a customer: EST-
// 102075 (a prompt-47 pre-minted draft card, zero areas, zero line items,
// null price) was emailed AND texted to a real customer because every
// existing blocker came out of a loop over the line items, and zero items
// produced zero blockers. HARD block, no override (locked decision 5), same
// shape as sendGateError. Empty means (locked decision 6): zero line items,
// OR an opening total (required + currently selected optional lines, the
// exact number the public page shows when the link opens) that is null or
// zero. Either one blocks. The message names the fix, not the failure.
// Mirrored by the client gate in index.html estimateSendGateOk; keep in
// lockstep. Customer-adjacent text: no em dashes (rule 6).
const EMPTY_SEND_MESSAGE = 'This estimate has no priced lines yet. Open it in the estimator, add at least one line, and save before sending.';
function emptySendError(items) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!list.length) return EMPTY_SEND_MESSAGE;
  const { opening } = splitLineTotals(list);
  if (!(opening > 0)) return EMPTY_SEND_MESSAGE;
  // Every discount must fit the required work even if the customer declines
  // all positive optional lines and selects every optional discount (and,
  // with a choice group, picks the cheapest choice). Keep draft saves
  // possible; this rule is used only on customer-facing paths.
  if (list.some(li => lineTotal(li) < 0)) {
    const minimum = splitLineTotals(list).cheapest;
    if (!(minimum > 0)) return 'Discounts must leave the required work above $0 for every customer selection. Reduce the discount or make more work required before sending.';
  }
  return null;
}

// The accept guard (decision 4): the rep gate makes a zero-selection accept
// unreachable through the UI; this is the defense against a crafted POST.
// True when nothing survives selection or the surviving total is zero.
// pickedId (prompt 106) decides which choice line, if any, is included.
function acceptSelectionInvalid(items, pickedId) {
  const included = includedLines(items, pickedId);
  if (!included.length) return true;
  const total = included.reduce((s, li) => s + lineTotal(li), 0);
  return !(total > 0);
}

// Declined record (decision 9): after accept, a line with is_optional AND NOT
// selected IS the declined record; no new column. These helpers read it.
// Prompt 106: declinedAreaIdSet also drops the areas of NOT SELECTED choice
// lines when a pick is threaded in, so job creation (job_areas,
// pec_prod_areas, the material plan) never carries the option the customer
// did not take. The keep-unmatched guardrail in filterAreasForJob is
// unchanged: only areas named on a declined or unpicked line drop.
const isDeclinedLine = (li) => isOptionalLine(li) && !(li && li.selected_by_customer === true);
function declinedAreaIdSet(items, pickedId) {
  const set = new Set();
  const list = Array.isArray(items) ? items : [];
  for (const li of list) {
    if (isDeclinedLine(li) && li.estimate_area_id) set.add(li.estimate_area_id);
  }
  for (const li of notSelectedChoiceLines(list, pickedId)) {
    if (li.estimate_area_id) set.add(li.estimate_area_id);
  }
  return set;
}

// Area filter for job creation (E1). GUARDRAIL: an area with NO line item at
// all is KEPT, structurally, because the declined set only ever contains
// area ids that appear on a declined line. A missing line item is a data bug,
// and silently deleting a bay from a signed job would be a far worse failure
// than carrying an extra one.
function filterAreasForJob(areas, declinedIds) {
  const set = declinedIds instanceof Set ? declinedIds : new Set(declinedIds || []);
  return (Array.isArray(areas) ? areas : []).filter((a) => !(a && a.id && set.has(a.id)));
}

// The crew-facing note line for what was offered and not sold, so nobody
// coats a patio out of muscle memory. Customer-adjacent internal text: no em
// dashes (rule 6).
const usdWhole = (n) => (Number(n) < 0 ? '-' : '') + '$' + Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-US');
function declinedNoteLine(declinedLines) {
  const list = (Array.isArray(declinedLines) ? declinedLines : []).filter(Boolean);
  if (!list.length) return null;
  return 'Declined by customer: ' + list.map((li) => `${li.label || 'Line'}, ${usdWhole(lineTotal(li))}`).join('; ');
}
// Same shape for the choice the customer did NOT take (prompt 106): the crew
// sees which option was sold and which were offered.
function notSelectedNoteLine(items, pickedId) {
  const list = Array.isArray(items) ? items : [];
  const chosen = countedChoice(list, pickedId);
  const others = notSelectedChoiceLines(list, pickedId);
  if (!chosen || !others.length) return null;
  return `Customer chose ${chosen.label || 'Line'}, ${usdWhole(lineTotal(chosen))}. Not selected: ` + others.map((li) => `${li.label || 'Line'}, ${usdWhole(lineTotal(li))}`).join('; ');
}

// Selected-lines scope document (E4), in the SAME per-line shape the scope
// writer assembles (## label + body, --- separators), used for the JOB side
// only when something was declined. estimates.scope_of_work is NEVER
// rewritten after signature; that document is what the customer read and
// signed.
function selectedScopeDoc(includedLines) {
  const sections = (Array.isArray(includedLines) ? includedLines : []).filter(Boolean).map((li) => {
    const head = `## ${li.label || 'Line'}`;
    const body = li.description ? String(li.description) : '';
    return body ? `${head}\n\n${body}` : head;
  });
  return sections.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Prompt 74 send gate: per-line SCOPE. The customer page now renders each
// line's description as its scope of work, so an estimate must not go out
// while any scope-bearing line is empty or still carries the clobber
// fingerprint (the old save path overwrote descriptions with "970 sqft";
// prompt 74 Part A killed the writer, this catches a stale client that is
// still writing it). Mirrored by the client gates in index.html; keep in
// lockstep. HARD BLOCK, not a warning (locked decision 4), and the messages
// NAME the offending lines: the rep is standing in a driveway.
// ---------------------------------------------------------------------------
const CLOBBER_DESC_RE = /^\s*\d+\s*sq\s*ft/i;
const { scopePlainText } = require('./estimate-formatting.cjs');

// Prompt 78 D2: the blank scan (literal BLANK, unresolved is/is not choices,
// underscore fill-in runs) shares ONE detector with the estimator and the
// scope writer. The failure this prevents: a customer reading the word BLANK
// in a document they are being asked to sign.
const { scopeBlanks } = require('./scope.cjs');

// Prompt 76 Part B: the EXACT clobber fingerprint ("385 sqft" and nothing
// else). The scope writer uses this to decide a description is machine junk
// it may CLEAR on a templateless line. Deliberately stricter than the send
// gate's prefix regex above: the gate may nag about "970 sqft, includes MVB"
// (a human can fix it), but the writer must never DELETE text a human might
// have typed after the number.
const CLOBBER_DESC_EXACT_RE = /^\s*\d+\s*sq\s*ft\s*$/i;

// items: estimate_line_items rows. customAreaIds: Set of estimate_areas ids
// whose is_custom is true (a custom line's typed scope is the rep's own words
// and is never required to exist). scopeStale: estimates.scope_stale.
// The old MVB-only exemption is GONE (2026-08-08): Dylan approved a scope
// template for the MVB Only system, so its lines generate like any other
// area line and the gate requires their scope like any other.
function scopeSendBlockers({ scopeStale, items, customAreaIds, scopeOfWork }) {
  const blockers = [];
  if (scopeStale === true) {
    // Prompt 94: the Regenerate button is gone (templates fill line scopes
    // now), so the fix is a re-save from the estimator, which clears the flag.
    blockers.push('The scope of work is out of date: the estimate changed after the scope was written. Open the estimate in the estimator, review the line scopes, and save.');
  }
  const customSet = customAreaIds instanceof Set ? customAreaIds : new Set(customAreaIds || []);
  for (const li of (Array.isArray(items) ? items : [])) {
    if (!li) continue;
    const label = li.label || 'Line';
    const desc = String(li.description == null ? '' : li.description).trim();
    const visibleDesc = scopePlainText(desc);
    // Prompt 78 D2: blanks block on EVERY line, add-on and custom lines
    // included. Custom lines stay exempt from the empty-description rule
    // below (a typed scope is the rep's call), but a pasted template with an
    // unfilled BLANK in a custom line is exactly the failure this catches.
    // One blocker per line, quoting the first offending snippet.
    const blanks = scopeBlanks(desc).concat(scopeBlanks(visibleDesc));
    if (blanks.length) {
      // Prompt 94 B2: a 'token' finding gets its own wording, because the fix
      // is the fill-in form on the line editor, not hand-editing the text.
      blockers.push(blanks[0].kind === 'token'
        ? `"${label}" still has an unfilled field in its scope: "${blanks[0].snippet}". Fill it in on the line editor, then send.`
        : `"${label}" still has a blank in its scope of work: "${blanks[0].snippet}". Fill it in, then send.`);
    }
    if (!li.estimate_area_id) {
      // Add-on / one-off lines: many legitimately ship without scope language
      // (Drive Time has no snippet), so only the clobber fingerprint blocks.
      if (CLOBBER_DESC_RE.test(visibleDesc)) {
        blockers.push(`"${label}" still shows only square footage where its scope should be. Regenerate the scope.`);
      }
      continue;
    }
    if (customSet.has(li.estimate_area_id)) continue; // typed scope is the rep's call
    if (!visibleDesc) {
      blockers.push(`"${label}" has no scope of work yet. Generate the scope, then send.`);
    } else if (CLOBBER_DESC_RE.test(visibleDesc)) {
      blockers.push(`"${label}" still shows only square footage where its scope should be. Regenerate the scope.`);
    }
  }
  // Prompt 78 D2: estimates.scope_of_work is the internal record feeding the
  // job and the crew scope; a blank there ships to the crew even though the
  // customer page no longer renders it. Estimate-level blocker.
  const sowBlanks = scopeBlanks(String(scopeOfWork == null ? '' : scopeOfWork)).concat(scopeBlanks(scopePlainText(scopeOfWork)));
  if (sowBlanks.length) {
    // Prompt 94: the answers card is gone; the document assembles from the
    // line scopes, so the fix lives in the estimator's line editor. An
    // unfilled token gets token wording (Cowork's copy-debt finding).
    blockers.push(sowBlanks[0].kind === 'token'
      ? `The scope of work still has an unfilled field: "${sowBlanks[0].snippet}". Fill it in on the line editor, then send.`
      : `The scope of work still has a blank: "${sowBlanks[0].snippet}". Fix the line scopes in the estimator, then send.`);
  }
  return blockers;
}

// The create-gate rule (optional_lines_enabled): when off, the Optional
// checkbox does not render for a line that is not already optional, so no
// NEW optional lines can be created; a line that IS optional keeps its
// controls so existing estimates still render and still work. A data gate
// would hide real state; this is a create gate only.
function optionalControlsVisible(enabled, isOptional) {
  return enabled !== false || isOptional === true;
}

module.exports = {
  optionalControlsVisible,
  SEND_GATE_MESSAGE,
  EMPTY_SEND_MESSAGE,
  emptySendError,
  CLOBBER_DESC_RE,
  CLOBBER_DESC_EXACT_RE,
  scopeSendBlockers,
  isOptionalLine,
  isDeclinedLine,
  splitLineTotals,
  sendGateError,
  acceptSelectionInvalid,
  declinedAreaIdSet,
  filterAreasForJob,
  declinedNoteLine,
  selectedScopeDoc,
  // Choice group (prompt 106)
  choiceGroupOf,
  isChoiceLine,
  choiceLines,
  choicePickValid,
  countedChoice,
  countedChoiceId,
  isIncludedLine,
  includedLines,
  notSelectedChoiceLines,
  notSelectedNoteLine,
  choiceGroupSendError,
  choiceAcceptError,
  CHOICE_GROUP_SEND_MESSAGE,
  CHOICE_PICK_REQUIRED_MESSAGE,
};
