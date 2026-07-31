'use strict';
// Card-first draft flow + current-user salesperson default (prompt 47).
// ONE source of truth for the estimator's early-draft-save gate and the
// salesperson defaulting rule, required by BOTH the estimator screen (client,
// via Vite's CJS interop, same pattern as scope.cjs) and the fixture tests,
// so what the tests prove is literally the code the app runs.

// ---------------------------------------------------------------------------
// Required fields for the EARLY draft save (Dylan's locked decision): customer
// name, phone, email, address, AND salesperson. Name follows the estimator's
// identity gate: a commercial estimate's name is its company, a residential
// one's is the last name. Address means address1 (city/state/zip are never a
// gate; a rep in the driveway knows where they are).
//
// fields: { isCommercial, company, lastName, phone, email, address1, salespersonId }
// Returns the missing field names (empty array = ready to write the card).
function missingDraftFields(fields) {
  const f = fields || {};
  const has = (v) => String(v == null ? '' : v).trim() !== '';
  const missing = [];
  if (!(f.isCommercial ? has(f.company) : has(f.lastName))) missing.push('name');
  if (!has(f.phone)) missing.push('phone');
  if (!has(f.email)) missing.push('email');
  if (!has(f.address1)) missing.push('address');
  if (!has(f.salespersonId)) missing.push('salesperson');
  return missing;
}

function draftReady(fields) {
  return missingDraftFields(fields).length === 0;
}

// ---------------------------------------------------------------------------
// The fire-once trigger. The estimator calls signal(fields, {initial}) from
// the SAME effect that watches every form input, and this object owns the
// semantics:
//   - initial: true marks a run where the form still equals its open state
//     (the mount run, including StrictMode's dev double-run): it NEVER fires,
//     so opening a lead's prefilled estimate and backing out writes nothing,
//   - the first real change with every required field present fires exactly
//     once,
//   - a change with fields still missing does not consume the trigger; the
//     edit that completes the fields fires it,
//   - alreadyPersisted (editing an existing estimate) never fires: the card
//     already exists.
// reset() re-arms after a FAILED write so a transient error does not
// permanently lose the card.
function createDraftTrigger(opts) {
  let armed = !(opts && opts.alreadyPersisted === true);
  return {
    signal(fields, o) {
      if (o && o.initial === true) return false;
      if (!armed) return false;
      if (!draftReady(fields)) return false;
      armed = false;
      return true;
    },
    reset() {
      armed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Salesperson default for the estimator (locked priority):
//   1. the estimate-being-edited's salesperson, if still a valid choice,
//   2. else the salesperson whose auth_user_id matches the logged-in user,
//   3. else BLANK. Never salespeople[0]: a silent wrong default is worse than
//      a required field the rep has to fill.
// salespeople rows may predate the auth_user_id column (cached offline
// catalog); a missing key simply never matches.
function defaultSalespersonId(args) {
  const a = args || {};
  const list = Array.isArray(a.salespeople) ? a.salespeople : [];
  const fromEdit = a.editingSalespersonId != null ? String(a.editingSalespersonId) : '';
  if (fromEdit && list.some((s) => s && String(s.id) === fromEdit)) return fromEdit;
  const uid = a.currentUserId != null ? String(a.currentUserId) : '';
  if (uid) {
    const mine = list.find((s) => s && s.auth_user_id != null && String(s.auth_user_id) === uid);
    if (mine) return String(mine.id);
  }
  return '';
}

// True when the logged-in user has no salesperson mapped to their login: the
// save gate shows the "get your login mapped" prompt instead of the generic
// "pick a salesperson" hint.
function userUnmapped(salespeople, currentUserId) {
  const list = Array.isArray(salespeople) ? salespeople : [];
  const uid = currentUserId != null ? String(currentUserId) : '';
  if (!uid) return true;
  return !list.some((s) => s && s.auth_user_id != null && String(s.auth_user_id) === uid);
}

// The one id rule that makes the draft card and the full Save the same row:
// an edit keeps its id, a new estimate uses the screen's pre-minted draft id
// for BOTH the early draft save and the full save, so the outbox upserts the
// same row every time.
function estimateIdForSave(editingId, draftId) {
  return editingId != null && editingId !== '' ? editingId : draftId;
}

// Prompt 61 Part B: a dashboard-created draft loads through ?estimate_id=
// with ZERO areas (the row exists before the estimator ever opens), and the
// old editing path would render a form with no area row at all. Rule: an
// edited estimate WITH areas maps them straight in; one with none seeds the
// SAME single Main area the create path uses, defaults included. Pure so the
// fixture test drives the exact logic the screen runs; makeDefaultArea is
// injected because the default slot values come from the live catalog.
function initialAreas({ editingAreas, makeDefaultArea }) {
  if (Array.isArray(editingAreas) && editingAreas.length) return editingAreas;
  return [makeDefaultArea()];
}

module.exports = {
  missingDraftFields,
  draftReady,
  createDraftTrigger,
  defaultSalespersonId,
  userUnmapped,
  estimateIdForSave,
  initialAreas,
};
