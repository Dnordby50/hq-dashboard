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

// The three totals of a mixed estimate (decisions 6 and 7). They are three
// DIFFERENT numbers on purpose:
//   requiredOnly: the guaranteed floor (what estimates.price stores pre-accept)
//   allIn:        every line at full value (estimates.price_all_options)
//   opening:      required + currently-selected optional lines (what the
//                 customer sees when the page opens; never stored, always
//                 computed live from the rows)
function splitLineTotals(items) {
  let requiredOnly = 0;
  let allIn = 0;
  let opening = 0;
  for (const li of (Array.isArray(items) ? items : [])) {
    if (!li) continue;
    const t = lineTotal(li);
    allIn += t;
    if (!isOptionalLine(li)) {
      requiredOnly += t;
      opening += t;
    } else if (li.selected_by_customer === true) {
      opening += t;
    }
  }
  return { requiredOnly: round2(requiredOnly), allIn: round2(allIn), opening: round2(opening) };
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

// The accept guard (decision 4): the rep gate makes a zero-selection accept
// unreachable through the UI; this is the defense against a crafted POST.
// True when nothing survives selection or the surviving total is zero.
function acceptSelectionInvalid(items) {
  const included = (Array.isArray(items) ? items : []).filter(
    (li) => li && (!isOptionalLine(li) || li.selected_by_customer === true)
  );
  if (!included.length) return true;
  const total = included.reduce((s, li) => s + lineTotal(li), 0);
  return !(total > 0);
}

// Declined record (decision 9): after accept, a line with is_optional AND NOT
// selected IS the declined record; no new column. These helpers read it.
const isDeclinedLine = (li) => isOptionalLine(li) && !(li && li.selected_by_customer === true);
function declinedAreaIdSet(items) {
  const set = new Set();
  for (const li of (Array.isArray(items) ? items : [])) {
    if (isDeclinedLine(li) && li.estimate_area_id) set.add(li.estimate_area_id);
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
const usdWhole = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
function declinedNoteLine(declinedLines) {
  const list = (Array.isArray(declinedLines) ? declinedLines : []).filter(Boolean);
  if (!list.length) return null;
  return 'Declined by customer: ' + list.map((li) => `${li.label || 'Line'}, ${usdWhole(lineTotal(li))}`).join('; ');
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
function scopeSendBlockers({ scopeStale, items, customAreaIds }) {
  const blockers = [];
  if (scopeStale === true) {
    blockers.push('The scope of work is out of date: the estimate changed after the scope was written. Regenerate the scope, then send.');
  }
  const customSet = customAreaIds instanceof Set ? customAreaIds : new Set(customAreaIds || []);
  for (const li of (Array.isArray(items) ? items : [])) {
    if (!li) continue;
    const label = li.label || 'Line';
    const desc = String(li.description == null ? '' : li.description).trim();
    if (!li.estimate_area_id) {
      // Add-on / one-off lines: many legitimately ship without scope language
      // (Drive Time has no snippet), so only the clobber fingerprint blocks.
      if (CLOBBER_DESC_RE.test(desc)) {
        blockers.push(`"${label}" still shows only square footage where its scope should be. Regenerate the scope.`);
      }
      continue;
    }
    if (customSet.has(li.estimate_area_id)) continue; // typed scope is the rep's call
    if (!desc) {
      blockers.push(`"${label}" has no scope of work yet. Generate the scope, then send.`);
    } else if (CLOBBER_DESC_RE.test(desc)) {
      blockers.push(`"${label}" still shows only square footage where its scope should be. Regenerate the scope.`);
    }
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
};
