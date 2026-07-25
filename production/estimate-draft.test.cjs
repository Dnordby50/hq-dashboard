// Fixture test for the card-first draft flow + current-user salesperson
// default (prompt 47), driving the SAME production/estimate-draft.cjs module
// the estimator screen imports (the scope.cjs sharing pattern), so what
// passes here is literally what runs in the app:
//   - the draft trigger fires exactly ONCE on the first real edit, never on
//     open (including StrictMode's initial re-run), and only once the five
//    required fields (name, phone, email, address, salesperson) are present;
//   - the salesperson default resolves editing pick > auth_user_id match >
//     blank, with NO salespeople[0] fallback;
//   - the id rule that makes the early draft card and the full Save the same
//     upserted row.
// Run: node production/estimate-draft.test.cjs
'use strict';
const {
  missingDraftFields, draftReady, createDraftTrigger,
  defaultSalespersonId, userUnmapped, estimateIdForSave,
} = require('./estimate-draft.cjs');
const { makeChecker } = require('./_drip-test-kit.cjs');

const { state, ok } = makeChecker();

// A lead-prefilled residential customer: the normal card-first happy path.
const FULL = {
  isCommercial: false, company: '', lastName: 'Jones', phone: '928-555-0100',
  email: 'sam@example.com', address1: '123 Main St', salespersonId: 'sp1',
};

(() => {
  console.log('# required-field gate (name, phone, email, address, salesperson)');
  {
    ok(missingDraftFields(FULL).length === 0 && draftReady(FULL), 'lead-prefilled residential estimate is draft-ready');
    ok(missingDraftFields({ ...FULL, lastName: '' }).join(',') === 'name', 'residential name = last name');
    ok(missingDraftFields({ ...FULL, isCommercial: true, lastName: 'Jones', company: '' }).join(',') === 'name', 'commercial name = company (contact last name does not count)');
    ok(draftReady({ ...FULL, isCommercial: true, company: 'Acme Floors', lastName: '' }), 'commercial with company is ready');
    ok(missingDraftFields({ ...FULL, phone: '  ', email: '', address1: '', salespersonId: '' }).join(',') === 'phone,email,address,salesperson',
      'every missing field is named (whitespace = missing)');
  }

  console.log('# trigger: never on open, once on first real edit');
  {
    const t = createDraftTrigger({ alreadyPersisted: false });
    ok(t.signal(FULL, { initial: true }) === false, 'the open never fires, even with all fields prefilled');
    ok(t.signal(FULL, { initial: true }) === false, 'a StrictMode-style second initial run never fires either');
    ok(t.signal(FULL) === true, 'the first real edit fires');
    ok(t.signal(FULL) === false && t.signal(FULL) === false, 'every later edit is a no-op (fires exactly once)');
  }

  console.log('# trigger: missing fields do not consume it');
  {
    const t = createDraftTrigger({});
    t.signal(FULL, { initial: true });
    ok(t.signal({ ...FULL, email: '' }) === false, 'a first edit with a required field missing does not fire');
    ok(t.signal({ ...FULL, email: '' }) === false, 'still armed while fields stay incomplete');
    ok(t.signal(FULL) === true, 'the edit that completes the fields fires it');
    ok(t.signal(FULL) === false, 'and only once');
  }

  console.log('# trigger: blank salesperson (unmapped login) blocks the draft');
  {
    const t = createDraftTrigger({});
    t.signal(FULL, { initial: true });
    ok(t.signal({ ...FULL, salespersonId: '' }) === false, 'no salesperson = no card (the unmapped-login prompt shows instead)');
    ok(t.signal(FULL) === true, 'picking (or being defaulted to) a salesperson unblocks it');
  }

  console.log('# trigger: editing an existing estimate never fires');
  {
    const t = createDraftTrigger({ alreadyPersisted: true });
    t.signal(FULL, { initial: true });
    ok(t.signal(FULL) === false && t.signal(FULL) === false, 'the card already exists; edits never draft-save');
  }

  console.log('# trigger: reset() re-arms after a failed write');
  {
    const t = createDraftTrigger({});
    t.signal(FULL, { initial: true });
    ok(t.signal(FULL) === true, 'fires');
    t.reset(); // the write threw; the card was NOT created
    ok(t.signal(FULL) === true, 'a later edit retries the card');
    ok(t.signal(FULL) === false, 'and again only once');
  }

  console.log('# salesperson default: editing pick > auth match > blank');
  {
    const SP = [
      { id: 'sp1', name: 'Alice', auth_user_id: 'auth-alice' },
      { id: 'sp2', name: 'Bob', auth_user_id: null },
    ];
    ok(defaultSalespersonId({ editingSalespersonId: 'sp2', salespeople: SP, currentUserId: 'auth-alice' }) === 'sp2',
      'a reopened estimate keeps its own salesperson even when the login maps elsewhere');
    ok(defaultSalespersonId({ editingSalespersonId: 'sp-gone', salespeople: SP, currentUserId: 'auth-alice' }) === 'sp1',
      'an invalid stored pick falls to the auth_user_id match');
    ok(defaultSalespersonId({ editingSalespersonId: '', salespeople: SP, currentUserId: 'auth-alice' }) === 'sp1',
      'a new estimate defaults to the logged-in rep');
    ok(defaultSalespersonId({ editingSalespersonId: '', salespeople: SP, currentUserId: 'auth-carol' }) === '',
      'an unmapped login gets BLANK, never salespeople[0]');
    ok(defaultSalespersonId({ editingSalespersonId: '', salespeople: SP, currentUserId: null }) === '',
      'no session user id gets blank too');
    // Cached catalog from before the migration: rows carry no auth_user_id key.
    ok(defaultSalespersonId({ editingSalespersonId: '', salespeople: [{ id: 'sp1', name: 'Alice' }], currentUserId: 'auth-alice' }) === '',
      'a pre-migration cached catalog simply never matches (blank, no crash)');
  }

  console.log('# unmapped detection drives the get-mapped prompt');
  {
    const SP = [{ id: 'sp1', auth_user_id: 'auth-alice' }];
    ok(userUnmapped(SP, 'auth-alice') === false, 'mapped login is not unmapped');
    ok(userUnmapped(SP, 'auth-carol') === true, 'unknown login is unmapped');
    ok(userUnmapped([], 'auth-alice') === true, 'empty roster means unmapped');
  }

  console.log('# same-id upsert: draft card and full Save are one row');
  {
    ok(estimateIdForSave(null, 'draft-uuid') === 'draft-uuid', 'a new estimate always saves under the pre-minted draft id');
    ok(estimateIdForSave('est-77', 'draft-uuid') === 'est-77', 'an edit keeps its own id');
    // The full flow: the draft writes under draftId, the later Save resolves
    // to the SAME id, which is what makes the outbox upsert one row.
    const draftId = 'e0e0-1111';
    ok(estimateIdForSave(null, draftId) === estimateIdForSave(null, draftId), 'draft save and full save resolve identically');
  }

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  if (state.failed) process.exit(1);
})();
