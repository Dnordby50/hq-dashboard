// Routemize -> TopCoat appointment intake (prompt 43). Zapier posts every
// Routemize appointment event here (Created / Updated / Cancelled / Deleted),
// so appointments booked in Routemize land on the TopCoat calendar as the
// system of record, linked to the originating lead so the lead -> drip ->
// appointment pipeline stays connected. Same house pattern as
// pec-lead-intake.cjs: WE define the contract below, Zapier maps Routemize's
// real fields onto it (adding a source is a Zapier change, not a code change).
//
// POST /.netlify/functions/pec-appt-intake
// Header: x-webhook-secret: <PEC_WEBHOOK_SECRET>   (same secret every intake
//         webhook uses; already set in Netlify env)
//
// Body:
//   {
//     action: 'created' | 'updated' | 'canceled' | 'deleted'   // default 'created'
//     routemize_appt_id: string      // REQUIRED: idempotency + update/cancel key
//     appt_type: string              // optional; on_site_estimate (default) /
//                                    //   project_walkthrough / site_visit / other
//     title: string                  // optional; default customer name, else type label
//     start_at: string               // REQUIRED for created/updated. ISO 8601;
//                                    //   a BARE datetime is read as America/Phoenix
//                                    //   (fixed -07:00, the project convention)
//     end_at: string                 // optional; default start_at + 60 min
//     all_day: boolean               // optional; default false
//     customer_name, phone, email    // lead/customer match + carry-on-appt
//     address, city, state, zip      // optional -> location_* columns
//     assigned_member_email          // -> pec_sales_team_members.google_email
//     assigned_member_name           // -> pec_sales_team_members.name (fallback)
//     notes: string                  // internal Company notes
//     customer_notes: string         // customer-facing Job notes
//   }
//
// Behavior:
//   - created: insert with source='routemize', status='scheduled'; if a row
//     already exists for that routemize_appt_id, treat as an update (Zapier
//     retries and double-fires are harmless).
//   - updated: patch the matched row; if missing, insert (upsert-safe).
//     google_* columns are never touched (the existing push owns them).
//   - canceled / deleted: set status='canceled' on the matched row (never a
//     hard delete; the existing pec-appt-sync-push removes the Google event
//     off that status on its next kick). No-op if not found.
//   - Lead linkage (locked decision 3): match a LIVE lead by last-10 phone or
//     email and link it (plus its customer); else a customer by the same
//     keys; else leave both null and carry name/phone on the appointment
//     itself. Never auto-create a lead or customer here (would collide with
//     the other intake paths).
//   - Rep mapping (decision 5): assigned_member_email -> google_email, else
//     assigned_member_name -> name, both case-insensitive; no match leaves
//     the appointment unassigned and notes it in the internal notes.
//   - NEW lead-linked appointments get the SAME lead-side state as an in-app
//     booking via apptBookingLeadEffects (stage new->contacted for on-site
//     estimates + stage_change lead_event + nurture-drip pause) and a staff
//     bell row, then a best-effort runApptReminders kick so the consented
//     customer confirmation goes out now (the 15-min runner is the safety
//     net). None of these can turn a good intake into a non-200: Zapier
//     retries non-200s, and a retried side effect is worse than a late one.
//   - Every attempt writes pec_webhook_ingest_log (endpoint 'appt-intake')
//     so the Sync Health view can answer "did the Zap fire?".

const { sb, json, badSecret, logIngest } = require('./_pec-supabase.cjs');
const { runApptReminders, apptBookingLeadEffects, apptDateStr, apptTimeStr } = require('./_pec-appt.cjs');

const ENDPOINT = 'appt-intake';
const APPT_TYPES = ['on_site_estimate', 'project_walkthrough', 'site_visit', 'other'];
const TYPE_LABELS = {
  on_site_estimate: 'On-site estimate',
  project_walkthrough: 'Project walkthrough',
  site_visit: 'Site visit',
  other: 'Appointment',
};
// Loose labels Zapier might pass before anyone maps the field properly.
const TYPE_ALIASES = {
  estimate: 'on_site_estimate', onsite_estimate: 'on_site_estimate', on_site: 'on_site_estimate',
  walkthrough: 'project_walkthrough', project_walk_through: 'project_walkthrough',
};
const DEFAULT_DURATION_MS = 60 * 60000;

function cleanStr(s) {
  const out = String(s == null ? '' : s).trim();
  return out || null;
}

// Last 10 digits, so '+1 (928) 555-1212' and '9285551212' match (the same
// normalization pec-lead-intake writes into leads.phone).
function normPhone(s) {
  const d = String(s == null ? '' : s).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : (d || null);
}

function normApptType(s) {
  const k = String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (APPT_TYPES.includes(k)) return k;
  if (TYPE_ALIASES[k]) return TYPE_ALIASES[k];
  return 'on_site_estimate'; // decision 6: these are booked estimate visits
}

// Datetime contract: an explicit offset (or Z) is trusted; a BARE datetime or
// date is Phoenix wall clock at the project's fixed -07:00 (same convention as
// pec-appt-sync-push). Returns a UTC ISO string or null if unparseable.
function parseApptDate(s) {
  const str = cleanStr(s);
  if (!str) return null;
  if (/(z|[+-]\d{2}:?\d{2})$/i.test(str)) {
    const d = new Date(str);
    return isNaN(d) ? null : d.toISOString();
  }
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2, '0')}:${m[5]}:${m[6] || '00'}-07:00`);
    return isNaN(d) ? null : d.toISOString();
  }
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00-07:00`).toISOString();
  const d = new Date(str); // last resort for oddball Zapier formats
  return isNaN(d) ? null : d.toISOString();
}

// Decision 5: google_email (case-insensitive) else exact name
// (case-insensitive); no match -> null (lands unassigned, noted in notes).
async function resolveSalesMember(db, memberEmail, memberName) {
  if (!memberEmail && !memberName) return null;
  const rows = await db('GET', '/pec_sales_team_members?select=id,name,google_email');
  const members = Array.isArray(rows) ? rows : [];
  const lcEmail = memberEmail ? memberEmail.toLowerCase() : null;
  const lcName = memberName ? memberName.toLowerCase() : null;
  if (lcEmail) {
    const hit = members.find(m => String(m.google_email || '').toLowerCase() === lcEmail);
    if (hit) return hit;
  }
  if (lcName) {
    const hit = members.find(m => String(m.name || '').trim().toLowerCase() === lcName);
    if (hit) return hit;
  }
  return null;
}

// Decision 3: link, never create. Live lead by last-10 phone / email first
// (the pec-lead-intake dedupe query without its recency window: an old lead
// booking an estimate is exactly the linkage we want); else a customer by the
// same keys; else nothing.
async function resolveContact(db, phone10, email) {
  const out = { lead_id: null, customer_id: null };
  if (!phone10 && !email) return out;
  const orParts = [];
  if (phone10) orParts.push(`phone.ilike.*${phone10}`);
  if (email) orParts.push(`email.eq.${email}`);
  const or = encodeURIComponent(orParts.join(','));
  const leads = await db('GET',
    `/leads?or=(${or})&deleted_at=is.null&select=id,customer_id&order=created_at.desc&limit=1`);
  if (Array.isArray(leads) && leads.length) {
    out.lead_id = leads[0].id;
    out.customer_id = leads[0].customer_id || null;
    return out;
  }
  const customers = await db('GET',
    `/customers?or=(${or})&archived_at=is.null&select=id&order=created_at.desc&limit=1`);
  if (Array.isArray(customers) && customers.length) out.customer_id = customers[0].id;
  return out;
}

// Staff bell for a Routemize booking: the in-app path goes through the
// log_appointment_booked RPC (client JS cannot insert pec_notifications under
// RLS); the service role writes the same row shape directly.
async function notifyBell(db, appt, salesName) {
  const when = `${apptDateStr(appt.start_at)} at ${apptTimeStr(appt.start_at)}`;
  await db('POST', '/pec_notifications', {
    type: 'appointment_booked',
    body: `Routemize booked ${appt.title || TYPE_LABELS[appt.appt_type] || 'an appointment'}`
      + (salesName ? ` for ${salesName}` : '') + ` (${when})`,
    target_view: 'appointments',
    target_id: appt.id,
  });
}

// The whole behavior with injectable deps ({ sb, logIngest, runReminders,
// now }) so the fixture test drives the REAL flow against the mini-PostgREST.
// Returns { status, body }; the handler wraps it in json().
async function processApptIntake(deps, body) {
  const db = deps.sb;
  const log = deps.logIngest || logIngest;
  const runReminders = deps.runReminders || ((d, o) => runApptReminders(d, o));
  const now = deps.now ? deps.now() : new Date();

  const action = cleanStr(body.action) || 'created';
  const rmId = cleanStr(body.routemize_appt_id);
  const customerName = cleanStr(body.customer_name);

  if (!['created', 'updated', 'canceled', 'deleted'].includes(action)) {
    await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'rejected', status_code: 400, message: `unknown action '${action}'`, payload: body });
    return { status: 400, body: { success: false, error: `unknown action '${action}'` } };
  }
  if (!rmId) {
    await log({ endpoint: ENDPOINT, deal_id: null, customer_name: customerName, outcome: 'rejected', status_code: 400, message: 'routemize_appt_id is required', payload: body });
    return { status: 400, body: { success: false, error: 'routemize_appt_id is required' } };
  }

  try {
    // ---- canceled / deleted: same outcome by locked decision 2 -------------
    if (action === 'canceled' || action === 'deleted') {
      const rows = await db('GET', `/pec_appointments?routemize_appt_id=eq.${encodeURIComponent(rmId)}&select=id,status&limit=1`);
      const appt = Array.isArray(rows) && rows[0];
      if (!appt) {
        await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'ok', status_code: 200, message: `${action}: no matching appointment (no-op)`, payload: body });
        return { status: 200, body: { success: true, matched: false } };
      }
      await db('PATCH', `/pec_appointments?id=eq.${encodeURIComponent(appt.id)}`, { status: 'canceled' });
      await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'ok', status_code: 200, message: `${action}: appointment ${appt.id} canceled`, payload: body });
      return { status: 200, body: { success: true, canceled: true, appointment_id: appt.id } };
    }

    // ---- created / updated -------------------------------------------------
    const startAt = parseApptDate(body.start_at);
    if (!startAt) {
      await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'rejected', status_code: 400, message: 'start_at is required (ISO 8601)', payload: body });
      return { status: 400, body: { success: false, error: 'start_at is required and must be a parseable datetime' } };
    }
    const endAt = parseApptDate(body.end_at) || new Date(new Date(startAt).getTime() + DEFAULT_DURATION_MS).toISOString();
    const apptType = normApptType(body.appt_type);
    const phone10 = normPhone(cleanStr(body.phone));
    const email = cleanStr(body.email) ? cleanStr(body.email).toLowerCase() : null;
    const memberEmail = cleanStr(body.assigned_member_email);
    const memberName = cleanStr(body.assigned_member_name);

    const [contact, member] = [
      await resolveContact(db, phone10, email),
      await resolveSalesMember(db, memberEmail, memberName),
    ];

    // Internal notes: what Zapier sent, plus anything a rep must act on
    // because we could not link it (unmatched contact keeps its phone here so
    // the appointment is still workable; unmatched rep is called out so
    // someone assigns it). Internal-only text, never customer-facing.
    const noteLines = [];
    if (cleanStr(body.notes)) noteLines.push(cleanStr(body.notes));
    if (!contact.lead_id && !contact.customer_id && (customerName || phone10 || email)) {
      noteLines.push('Routemize contact (no matching lead/customer): '
        + [customerName, phone10, email].filter(Boolean).join(' / '));
    }
    if (!member && (memberEmail || memberName)) {
      noteLines.push(`Routemize assigned rep not matched to the roster: ${memberEmail || memberName}`);
    }

    const existing = await db('GET', `/pec_appointments?routemize_appt_id=eq.${encodeURIComponent(rmId)}&select=*&limit=1`);
    const existingRow = Array.isArray(existing) && existing[0];

    // Field set common to insert and update. Built only from what the payload
    // carries (an omitted optional field never nulls out a stored value), and
    // google_* is never in here: the existing push owns those columns.
    const fields = {
      appt_type: apptType,
      start_at: startAt,
      end_at: endAt,
      all_day: body.all_day === true,
      status: 'scheduled', // an 'updated' from Routemize means the booking is live
    };
    const title = cleanStr(body.title) || customerName || TYPE_LABELS[apptType];
    if (cleanStr(body.title) || customerName || !existingRow) fields.title = title;
    if (cleanStr(body.address)) fields.location_address = cleanStr(body.address);
    if (cleanStr(body.city)) fields.location_city = cleanStr(body.city);
    if (cleanStr(body.state)) fields.location_state = cleanStr(body.state);
    if (cleanStr(body.zip)) fields.location_zip = cleanStr(body.zip);
    if (noteLines.length || !existingRow) fields.notes = noteLines.join('\n') || null;
    if (cleanStr(body.customer_notes)) fields.customer_notes = cleanStr(body.customer_notes);
    if (member) fields.sales_member_id = member.id;

    if (existingRow) {
      // Update (or a 'created' retry). Linkage only fills gaps: a link a
      // staff member set by hand in TopCoat is never clobbered.
      if (!existingRow.lead_id && contact.lead_id) fields.lead_id = contact.lead_id;
      if (!existingRow.customer_id && contact.customer_id) fields.customer_id = contact.customer_id;
      await db('PATCH', `/pec_appointments?id=eq.${encodeURIComponent(existingRow.id)}`, fields);
      await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'ok', status_code: 200, message: `${action}: appointment ${existingRow.id} updated`, payload: body });
      return { status: 200, body: { success: true, updated: true, appointment_id: existingRow.id, lead_id: fields.lead_id || existingRow.lead_id || null } };
    }

    // Fresh insert.
    let inserted;
    try {
      inserted = await db('POST', '/pec_appointments', {
        ...fields,
        routemize_appt_id: rmId,
        source: 'routemize',
        lead_id: contact.lead_id,
        customer_id: contact.customer_id,
        sales_member_id: member ? member.id : null,
      }, true);
    } catch (err) {
      // The partial unique index on routemize_appt_id: a concurrent Zap retry
      // beat us between the existence check and the insert. Its row is the
      // row; nothing to do.
      if (/409|23505|duplicate/i.test(String(err && err.message))) {
        await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'ok', status_code: 200, message: 'created: deduped on routemize_appt_id (concurrent retry)', payload: body });
        return { status: 200, body: { success: true, deduped: true } };
      }
      throw err;
    }
    const appt = inserted[0];

    // Side effects, every one best-effort: the row is saved, and Zapier
    // retrying a non-200 would re-run them, which is worse than missing one
    // (the 15-minute runner backstops the confirmation anyway).
    let effects = { staged: false, drip_stopped: 0 };
    if (appt.lead_id) {
      try { effects = await apptBookingLeadEffects(db, appt, { advanceStage: true, now: () => now }); }
      catch (e) { console.warn('pec-appt-intake: lead effects failed (non-fatal):', e && e.message); }
    }
    if (appt.lead_id || appt.customer_id) {
      try { await notifyBell(db, appt, member ? member.name : ''); }
      catch (e) { console.warn('pec-appt-intake: bell failed (non-fatal):', e && e.message); }
    }
    try { await runReminders({ sb: db }, { appointmentId: appt.id }); }
    catch (e) { console.warn('pec-appt-intake: confirmation kick failed (non-fatal):', e && e.message); }

    await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'ok', status_code: 200, message: `created: appointment ${appt.id}${appt.lead_id ? ` linked to lead ${appt.lead_id}` : ''}${member ? '' : (memberEmail || memberName ? ' (rep unmatched)' : '')}`, payload: body });
    return {
      status: 200,
      body: {
        success: true, created: true, appointment_id: appt.id,
        lead_id: appt.lead_id, customer_id: appt.customer_id,
        sales_member_id: appt.sales_member_id,
        lead_effects: effects,
      },
    };
  } catch (err) {
    console.error('pec-appt-intake failed:', err);
    await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'error', status_code: 500, message: err && err.message, payload: body });
    return { status: 500, body: { success: false, error: 'Internal error ingesting appointment' } };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'Method not allowed' });
  if (badSecret(event)) return json(401, { success: false, error: 'Invalid webhook secret' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { success: false, error: 'Invalid JSON' }); }

  const out = await processApptIntake({ sb, logIngest }, body);
  return json(out.status, out.body);
};

// Exported for the fixture test (production/appt-intake.test.cjs).
exports.processApptIntake = processApptIntake;
exports.parseApptDate = parseApptDate;
exports.normApptType = normApptType;
