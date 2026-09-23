// Quo contact sync core (prompt 107): the API client and the pass the
// scheduled worker, the manual twin and the backfill share. Rules live in
// production/quo-contact-sync.cjs (pure, fixture-tested); this file only
// talks to Quo and to the pec_quo_contact_sync queue.
//
// Quo (OpenPhone) API facts verified 2026-09-23 against quo.com/docs:
//   GET  /v1/contacts?maxResults=50&pageToken=...  (no phone filter; only
//        externalIds / sources), each contact {id, externalId, source,
//        createdAt, defaultFields{firstName,lastName,company,role,emails[],
//        phoneNumbers[]}, customFields[]}
//   POST /v1/contacts   {defaultFields, externalId, source}
//   PATCH /v1/contacts/{id}   REPLACES the contact (omitted emails /
//        phoneNumbers / customFields are deleted), hence buildPatchBody.
//   10 requests per second per key; 429 -> exponential backoff.
//   Authorization: the raw key (no Bearer), QUO_API_KEY in Netlify, the same
//   key pec-send-sms and pec-openphone-sync use against api.openphone.com
//   (the documented host is api.quo.com; both serve the same API and the
//   openphone host is the one proven in production, so it stays).
//
// ECHO SAFETY: this module writes TopCoat names INTO Quo and never reads a
// Quo name back onto leads / customers. pec-webhook-quo handles message and
// call events only. If a contact webhook is ever added it must NOT write
// back to TopCoat names, or the two systems will ping-pong renames.

'use strict';

const { sb, writeHeartbeat } = require('./_pec-supabase.cjs');
const rules = require('../../production/quo-contact-sync.cjs');

const QUO_API_KEY = process.env.QUO_API_KEY || process.env.OPENPHONE_API_KEY;
const QUO_BASE = process.env.QUO_API_BASE || 'https://api.openphone.com/v1';
const PAGE_SIZE = 50;
const MAX_PAGES = Number(process.env.QUO_CONTACT_MAX_PAGES) > 0 ? Number(process.env.QUO_CONTACT_MAX_PAGES) : 40; // 2,000 contacts
const MIN_GAP_MS = 150; // ~6 req/s, under Quo's 10/s

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One throttled client per pass. 429 raises a RateLimited error the pass
// turns into "stop now, rows stay pending, next tick retries".
function makeQuoClient({ fetchImpl, apiKey, base } = {}) {
  const f = fetchImpl || fetch;
  const key = apiKey || QUO_API_KEY;
  let lastAt = 0;
  async function call(method, path, body) {
    const wait = MIN_GAP_MS - (Date.now() - lastAt);
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    const res = await f(`${base || QUO_BASE}${path}`, {
      method,
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    if (res.status === 429) {
      const err = new Error('Quo rate limit (429)'); err.status = 429; err.rateLimited = true; throw err;
    }
    if (!res.ok) {
      const err = new Error(`Quo ${method} ${path} ${res.status}: ${String(text).slice(0, 300)}`);
      err.status = res.status; throw err;
    }
    return json;
  }
  return {
    async listAll() {
      const out = [];
      let pageToken = null;
      let truncated = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const qs = `?maxResults=${PAGE_SIZE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const res = await call('GET', `/contacts${qs}`);
        out.push(...((res && res.data) || []));
        pageToken = (res && res.nextPageToken) || null;
        if (!pageToken) break;
        if (page === MAX_PAGES - 1) truncated = true;
      }
      return { contacts: out, truncated };
    },
    async byExternalId(externalId) {
      const res = await call('GET', `/contacts?maxResults=${PAGE_SIZE}&externalIds=${encodeURIComponent(externalId)}`);
      return ((res && res.data) || []).filter((c) => c && c.externalId === externalId);
    },
    create: (body) => call('POST', '/contacts', body).then((r) => (r && r.data) || r),
    update: (id, body) => call('PATCH', `/contacts/${encodeURIComponent(id)}`, body).then((r) => (r && r.data) || r),
  };
}

async function loadSettings(db) {
  const keys = ['quo_contact_sync_enabled', 'quo_contact_sync_max_attempts', 'quo_contact_sync_create_missing', 'quo_contact_sync_on_edit'];
  const out = { enabled: true, maxAttempts: 4, createMissing: true, onEdit: true };
  try {
    const rows = await db('GET', `/settings?key=in.(${keys.join(',')})&select=key,value`);
    const map = Object.fromEntries((Array.isArray(rows) ? rows : []).map((r) => [r.key, r.value]));
    out.enabled = String(map.quo_contact_sync_enabled == null ? 'true' : map.quo_contact_sync_enabled) !== 'false';
    const n = parseInt(map.quo_contact_sync_max_attempts, 10);
    if (Number.isFinite(n) && n > 0) out.maxAttempts = n;
    out.createMissing = String(map.quo_contact_sync_create_missing == null ? 'true' : map.quo_contact_sync_create_missing) !== 'false';
    out.onEdit = String(map.quo_contact_sync_on_edit == null ? 'true' : map.quo_contact_sync_on_edit) !== 'false';
  } catch (e) { console.warn('quo-contacts: settings read failed, defaults apply:', e && e.message); }
  return out;
}

// Drain due queue rows. Returns counts; never throws on a single row.
async function runSyncPass({ db = sb, quo, now = () => new Date(), cap = 40, source = 'scheduled' } = {}) {
  const settings = await loadSettings(db);
  if (!settings.enabled) return { ok: true, skipped: 'quo_contact_sync_enabled is false' };
  if (!QUO_API_KEY && !quo) return { ok: true, skipped: 'no QUO_API_KEY; sync idle' };
  const nowIso = now().toISOString();
  let due;
  try {
    due = await db('GET', `/pec_quo_contact_sync?status=eq.pending&next_attempt_at=lte.${encodeURIComponent(nowIso)}&select=*&order=next_attempt_at.asc&limit=${cap}`);
  } catch (e) {
    // Table not there yet (migration pending): a silent no-op, never an error tick.
    return { ok: true, skipped: `queue unavailable: ${e && e.message}` };
  }
  if (!Array.isArray(due) || !due.length) return { ok: true, processed: 0, created: 0, updated: 0, skipped: 0, failed: 0, deferred: 0 };

  const client = quo || makeQuoClient();
  const counts = { processed: 0, created: 0, updated: 0, skipped: 0, failed: 0, deferred: 0, truncated: false };
  let index;
  try {
    const listed = await client.listAll();
    counts.truncated = listed.truncated;
    index = rules.indexContactsByPhone(listed.contacts);
  } catch (e) {
    if (e && e.rateLimited) return { ok: true, ...counts, deferred: due.length, note: 'rate limited before the list loaded; rows stay pending' };
    return { ok: false, error: `contact list failed: ${e && e.message}`, ...counts };
  }

  const patchRow = (phone, patch) => db('PATCH', `/pec_quo_contact_sync?phone_norm=eq.${encodeURIComponent(phone)}`, { ...patch, updated_at: now().toISOString() });
  for (const row of due) {
    counts.processed++;
    try {
      let contacts = index.get(row.phone_norm) || [];
      // If the list was cut short, a contact we created is still findable by
      // its externalId without paging (decision 5).
      if (!contacts.length && counts.truncated) contacts = await client.byExternalId(rules.externalIdFor(row.phone_norm));
      const plan = rules.planSync(row, contacts, settings);
      if (plan.action === 'skip') {
        counts.skipped++;
        await patchRow(row.phone_norm, { status: 'skipped', last_error: null, quo_contact_id: plan.contact ? plan.contact.id : row.quo_contact_id || null, last_synced_at: now().toISOString() });
        continue;
      }
      let result;
      if (plan.action === 'create') { result = await client.create(plan.body); counts.created++; }
      else { result = await client.update(plan.contact.id, plan.body); counts.updated++; }
      const contactId = (result && result.id) || (plan.contact && plan.contact.id) || null;
      await patchRow(row.phone_norm, { status: 'done', last_error: null, quo_contact_id: contactId, last_synced_at: now().toISOString() });
      // Keep the in-memory index honest for a later row on the same pass.
      if (result && result.id && plan.action === 'create') index.set(row.phone_norm, [result]);
    } catch (e) {
      if (e && e.rateLimited) { counts.deferred += due.length - counts.processed + 1; counts.processed--; break; }
      const attempts = (Number(row.attempts) || 0) + 1;
      const failed = attempts >= settings.maxAttempts;
      counts.failed += failed ? 1 : 0;
      if (!failed) counts.deferred++;
      const nextAt = new Date(now().getTime() + rules.backoffMinutes(attempts) * 60000).toISOString();
      await patchRow(row.phone_norm, {
        attempts, status: failed ? 'failed' : 'pending', next_attempt_at: nextAt,
        last_error: String(e && e.message || e).slice(0, 500),
      }).catch((pe) => console.warn('quo-contacts: could not record failure:', pe && pe.message));
    }
  }
  if (source === 'scheduled') { try { await writeHeartbeat('pec-quo-contact-sync', counts); } catch (_) { /* observability only */ } }
  return { ok: true, ...counts };
}

// Backfill plan (decision 10): one desired row per phone over the live leads
// and customers, compared against the whole Quo list. dry=true only reports;
// live enqueues the rows the worker will push (idempotent upsert, so a
// second live run changes nothing already queued or done).
async function planBackfill({ db = sb, quo, dry = true, now = () => new Date() } = {}) {
  const [leads, customers] = await Promise.all([
    db('GET', '/leads?deleted_at=is.null&archived_at=is.null&phone_norm=not.is.null&select=id,first_name,last_name,full_name,business_name,email,phone,phone_norm,created_at,deleted_at,archived_at&order=created_at.asc&limit=5000'),
    db('GET', '/customers?archived_at=is.null&phone_norm=not.is.null&select=id,first_name,last_name,name,company_name,email,phone,phone_norm,created_at,archived_at&order=created_at.asc&limit=5000'),
  ]);
  const desired = rules.coalesceDesired(leads, customers);
  const noPhone = { leads: (await db('GET', '/leads?deleted_at=is.null&archived_at=is.null&phone_norm=is.null&select=id&limit=5000')).length,
    customers: (await db('GET', '/customers?archived_at=is.null&phone_norm=is.null&select=id&limit=5000')).length };
  const client = quo || makeQuoClient();
  const listed = await client.listAll();
  const index = rules.indexContactsByPhone(listed.contacts);
  const settings = await loadSettings(db);
  const report = { create: [], rename: [], skip_fuller: [], skip_same: [], skip_duplicate_older: [], no_name: 0, no_phone: noPhone, quo_contacts: listed.contacts.length, truncated: listed.truncated };
  for (const row of desired) {
    const contacts = index.get(row.phone_norm) || [];
    const plan = rules.planSync({ ...row, origin: 'backfill' }, contacts, { ...settings, onEdit: true });
    const label = `${row.phone_norm} ${rules.fullName({ firstName: row.first_name, lastName: row.last_name })}${row.company ? ` (${row.company})` : ''} [${row.source_table}]`;
    if (plan.action === 'create') report.create.push(label);
    else if (plan.action === 'update') {
      const cur = rules.currentName(plan.contact);
      report.rename.push(`${label}: "${rules.fullName(cur)}${cur.company ? ' (' + cur.company + ')' : ''}" -> "${rules.fullName({ firstName: row.first_name, lastName: row.last_name })}${row.company ? ' (' + row.company + ')' : ''}"`);
      if (contacts.length > 1) report.skip_duplicate_older.push(`${row.phone_norm}: ${contacts.length - 1} older duplicate(s) left untouched (newest ${plan.contact.id} updated)`);
    } else if (plan.reason === 'fuller_in_quo') report.skip_fuller.push(`${label}: Quo has "${rules.fullName(rules.currentName(plan.contact))}"`);
    else report.skip_same.push(label);
  }
  report.counts = { create: report.create.length, rename: report.rename.length, skip_fuller: report.skip_fuller.length, skip_same: report.skip_same.length, skip_duplicate_older: report.skip_duplicate_older.length, no_phone: noPhone };
  if (!dry) {
    let queued = 0;
    for (const row of desired) {
      await db('POST', '/pec_quo_contact_sync', { phone_norm: row.phone_norm, source_table: row.source_table, source_id: row.source_id, first_name: row.first_name, last_name: row.last_name, company: row.company, email: row.email, origin: 'backfill', status: 'pending', attempts: 0, next_attempt_at: now().toISOString(), last_error: null }, { headers: { Prefer: 'resolution=merge-duplicates' } });
      queued++;
    }
    report.queued = queued;
  }
  return report;
}

module.exports = { makeQuoClient, loadSettings, runSyncPass, planBackfill, QUO_BASE, MAX_PAGES };
