// Quo contact sync (prompt 107, 2026-09-23): the PURE rules, fixture-tested,
// shared by the worker (netlify/functions/_pec-quo-contacts.cjs), the manual
// run twin, and the backfill script. No network, no database here.
//
// A TopCoat person is a leads row, a customers row, or both on one phone
// (last 10 digits, phone_norm). The Postgres trigger derives ONE desired
// snapshot per phone (customer name wins); these helpers decide what that
// snapshot does to the Quo workspace contact list.
//
// Quo API facts the rules depend on (verified against quo.com/docs
// 2026-09-23): the list endpoint cannot filter by phone (only externalIds /
// sources, 50 per page); PATCH /contacts/{id} REPLACES the contact, so any
// emails / phoneNumbers / customFields left out of the body are DELETED,
// which is why buildPatchBody carries the existing ones back verbatim
// (locked decision 3: never touch what a person typed in Quo).

'use strict';

const SOURCE = 'topcoat';
const EXTERNAL_ID_PREFIX = 'topcoat:';

const clean = (s) => { const v = String(s == null ? '' : s).trim(); return v || null; };
const lower = (s) => String(s == null ? '' : s).trim().toLowerCase();
const collapse = (s) => lower(s).replace(/\s+/g, ' ');

// Last 10 digits, the phone_norm rule.
function normPhone(s) {
  const d = String(s == null ? '' : s).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}
const toE164 = (phone10) => (phone10 ? `+1${phone10}` : null);
const externalIdFor = (phone10) => `${EXTERNAL_ID_PREFIX}${phone10}`;

// Locked decision 6: person name in first/last, business in company; with no
// person name at all the business goes in first name. A legacy combined
// name splits on the first space only when both split columns are blank.
// Mirrors pec_quo_contact_enqueue in the migration; keep in lockstep.
function desiredName(row) {
  let first = clean(row && row.first_name);
  let last = clean(row && row.last_name);
  let company = clean(row && (row.company_name != null ? row.company_name : row.business_name));
  const full = clean(row && (row.full_name != null ? row.full_name : row.name));
  // A legacy name that is just the business name repeated is not a person.
  if (!first && !last && full && !(company && lower(full) === lower(company))) {
    const sp = full.indexOf(' ');
    first = sp < 0 ? full : full.slice(0, sp);
    last = sp < 0 ? null : clean(full.slice(sp + 1));
  }
  if (!first && !last && company) { first = company; company = null; }
  return { firstName: first, lastName: last, company };
}

const fullName = (n) => [clean(n && n.firstName), clean(n && n.lastName)].filter(Boolean).join(' ');

// Locked decision 8, "keep the fuller name". Returns { rename, reason }.
//   - desired blank -> skip (nothing to write)
//   - desired is a first name only and Quo's current full name already
//     contains it with more ("Kyle" vs "Kyle Kirby") -> skip
//   - otherwise any real difference in first / last / company -> rename
// Comparisons are case-insensitive and trimmed.
function shouldRename(current, desired) {
  const dFirst = clean(desired && desired.firstName), dLast = clean(desired && desired.lastName);
  const dCompany = clean(desired && desired.company);
  if (!dFirst && !dLast) return { rename: false, reason: 'blank' };
  const cFull = collapse(fullName(current));
  const dFull = collapse(fullName(desired));
  if (!dLast && cFull !== dFull && cFull.split(' ').includes(dFull) && cFull.length > dFull.length) {
    return { rename: false, reason: 'fuller_in_quo' };
  }
  const sameFirst = collapse(current && current.firstName) === collapse(dFirst);
  const sameLast = collapse(current && current.lastName) === collapse(dLast);
  const sameCompany = collapse(current && current.company) === collapse(dCompany);
  if (sameFirst && sameLast && sameCompany) return { rename: false, reason: 'same' };
  return { rename: true, reason: 'different' };
}

// The Quo contacts on a phone: every contact whose phoneNumbers carry that
// last-10. Index once per worker run.
function contactPhones(contact) {
  const list = contact && contact.defaultFields && Array.isArray(contact.defaultFields.phoneNumbers)
    ? contact.defaultFields.phoneNumbers : [];
  return list.map((p) => normPhone(p && p.value)).filter(Boolean);
}
function indexContactsByPhone(contacts) {
  const map = new Map();
  for (const c of (Array.isArray(contacts) ? contacts : [])) {
    for (const p of new Set(contactPhones(c))) {
      if (!map.has(p)) map.set(p, []);
      map.get(p).push(c);
    }
  }
  return map;
}

// Locked decision 4: with duplicates on a number, only the NEWEST by
// createdAt is written; older ones are left alone. A contact TopCoat created
// (our externalId) wins outright when present, so our own contact never
// loses to a later hand-typed duplicate.
function pickContact(contacts, phone10) {
  const list = (Array.isArray(contacts) ? contacts : []).filter(Boolean);
  if (!list.length) return null;
  const ours = list.find((c) => c.externalId === externalIdFor(phone10));
  if (ours) return ours;
  return list.reduce((best, c) => (best == null || String(c.createdAt || '') > String(best.createdAt || '') ? c : best), null);
}

const isOurs = (contact, phone10) => !!contact && contact.externalId === externalIdFor(phone10);
const currentName = (contact) => ({
  firstName: contact && contact.defaultFields ? contact.defaultFields.firstName : null,
  lastName: contact && contact.defaultFields ? contact.defaultFields.lastName : null,
  company: contact && contact.defaultFields ? contact.defaultFields.company : null,
});

// Strip Quo's per-item ids so the arrays can be sent back verbatim.
const stripIds = (list) => (Array.isArray(list) ? list : []).map((x) => ({ name: x && x.name != null ? x.name : 'Other', value: x ? x.value : null }));

// PATCH body: the name from TopCoat, EVERYTHING else carried back unchanged
// (the endpoint replaces rather than merges). Email is rewritten only on a
// contact TopCoat itself created (decision 3's one exception).
function buildPatchBody(contact, desired, phone10, opts) {
  const df = (contact && contact.defaultFields) || {};
  const ours = isOurs(contact, phone10);
  const desiredEmail = clean(desired && desired.email);
  let emails = stripIds(df.emails);
  if (ours && desiredEmail && !emails.some((e) => lower(e.value) === lower(desiredEmail))) {
    emails = [{ name: 'Email', value: desiredEmail }].concat(emails);
  }
  const body = {
    defaultFields: {
      firstName: clean(desired.firstName) || clean(df.firstName) || 'Contact',
      lastName: clean(desired.lastName),
      company: clean(desired.company),
      role: df.role != null ? df.role : null,
      emails,
      phoneNumbers: stripIds(df.phoneNumbers),
    },
    customFields: Array.isArray(contact && contact.customFields)
      ? contact.customFields.map((f) => ({ key: f.key, value: f.value })) : [],
  };
  if (opts && opts.claim && !contact.externalId) body.externalId = externalIdFor(phone10);
  return body;
}

// Create body: name, company, phone (E.164) and email, stamped with our
// stable externalId so later syncs find it without paging (decision 5).
function buildCreateBody(desired, phone10) {
  const email = clean(desired && desired.email);
  return {
    defaultFields: {
      firstName: clean(desired.firstName) || clean(desired.company) || 'Contact',
      lastName: clean(desired.lastName),
      company: clean(desired.company),
      emails: email ? [{ name: 'Email', value: email }] : [],
      phoneNumbers: [{ name: 'Mobile', value: toE164(phone10) }],
    },
    externalId: externalIdFor(phone10),
    source: SOURCE,
  };
}

// Retry schedule (decision 9): four attempts over about an hour.
// attempt 1 fails -> +2 min, 2 -> +8, 3 -> +20, 4 -> failed (surfaces).
const BACKOFF_MINUTES = [2, 8, 20, 30];
function backoffMinutes(attemptsSoFar) {
  return BACKOFF_MINUTES[Math.min(Math.max(attemptsSoFar - 1, 0), BACKOFF_MINUTES.length - 1)];
}

// The decision for one queue row against the contacts on its phone.
// Returns { action: 'create' | 'update' | 'skip', reason, contact, body }.
function planSync(row, contactsOnPhone, settings) {
  const s = settings || {};
  const phone10 = row.phone_norm;
  const desired = { firstName: row.first_name, lastName: row.last_name, company: row.company, email: row.email };
  if (row.origin === 'update' && s.onEdit === false) return { action: 'skip', reason: 'edits_off', contact: null, body: null };
  const contact = pickContact(contactsOnPhone, phone10);
  if (!contact) {
    if (s.createMissing === false) return { action: 'skip', reason: 'create_off', contact: null, body: null };
    return { action: 'create', reason: 'no_contact', contact: null, body: buildCreateBody(desired, phone10) };
  }
  const verdict = shouldRename(currentName(contact), desired);
  const ours = isOurs(contact, phone10);
  const desiredEmail = clean(desired.email);
  const emailChange = ours && desiredEmail
    && !stripIds(contact.defaultFields && contact.defaultFields.emails).some((e) => lower(e.value) === lower(desiredEmail));
  if (!verdict.rename && !emailChange) return { action: 'skip', reason: verdict.reason, contact, body: null };
  return {
    action: 'update',
    reason: verdict.rename ? verdict.reason : 'email',
    contact,
    body: buildPatchBody(contact, desired, phone10, { claim: false }),
  };
}

// Backfill coalescing (decision 1 + the queue's one-row-per-phone shape):
// fold leads and customers into one desired row per phone, customer first,
// newest first within a table. Pure so the dry run and the fixtures share it.
function coalesceDesired(leads, customers) {
  const byPhone = new Map();
  const consider = (row, table) => {
    const phone = row.phone_norm || normPhone(row.phone);
    if (!phone) return;
    const name = desiredName(row);
    if (!name.firstName && !name.lastName) return;
    const cur = byPhone.get(phone);
    const candidate = { phone_norm: phone, source_table: table, source_id: row.id, first_name: name.firstName, last_name: name.lastName, company: name.company, email: clean(row.email), created_at: row.created_at || '' };
    if (!cur) { byPhone.set(phone, candidate); return; }
    const curIsCustomer = cur.source_table === 'customers';
    if (table === 'customers' && !curIsCustomer) { byPhone.set(phone, candidate); return; }
    if (table === cur.source_table && String(candidate.created_at) > String(cur.created_at)) byPhone.set(phone, candidate);
  };
  for (const c of (Array.isArray(customers) ? customers : [])) if (c && !c.archived_at) consider(c, 'customers');
  for (const l of (Array.isArray(leads) ? leads : [])) if (l && !l.deleted_at && !l.archived_at) consider(l, 'leads');
  return [...byPhone.values()];
}

module.exports = {
  SOURCE, EXTERNAL_ID_PREFIX, BACKOFF_MINUTES,
  normPhone, toE164, externalIdFor, desiredName, fullName, shouldRename,
  contactPhones, indexContactsByPhone, pickContact, isOurs, currentName,
  buildPatchBody, buildCreateBody, backoffMinutes, planSync, coalesceDesired,
};
