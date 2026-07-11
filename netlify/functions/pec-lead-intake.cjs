// Generic lead-intake webhook: Zapier posts new leads here from Meta Lead Ads,
// Google Lead Forms, or any future source (Angi, website form). One endpoint,
// source attribution via the payload, so adding a source is a Zapier change,
// not a code change.
//
// POST /.netlify/functions/pec-lead-intake
// Header: x-webhook-secret: <PEC_WEBHOOK_SECRET>   (same secret the DripJobs
//         webhooks use; already set in Netlify env)
//
// Body (all optional except one of name/full_name/first_name and one of
// phone/email; Zapier maps platform fields to these):
//   {
//     source: 'meta' | 'google_lsa' | 'angi' | 'webform' | ...   (default 'webform')
//     source_ref: platform lead id, for idempotent retries
//     full_name / name / first_name + last_name,
//     email, phone, address, city, state, zip,
//     campaign, adset, ad_name, form_name, utm_source, utm_medium, utm_campaign,
//     notes / message / comments
//   }
//
// Behavior:
//   - Dedupe 1 (idempotency): same source + source_ref already ingested -> 200,
//     deduped, no new row. Zapier retries and double-fires are harmless.
//   - Dedupe 2 (same human): live lead with the same normalized phone (last 10
//     digits) or same email, created in the last 90 days -> no new lead; a
//     'duplicate_intake' lead_event is appended to the existing lead so the
//     rep sees the person reached out again (that is a buying signal, not noise).
//   - Otherwise insert the lead (stage 'new') + a 'created' lead_event carrying
//     the full raw payload.
//   - Every attempt writes pec_webhook_ingest_log (endpoint 'lead-intake') so
//     the Sync Health view can answer "did the Zap fire?".
//
// SMS consent is NOT inferred: sms_consent stays false unless the payload
// explicitly says sms_consent true (Meta forms can carry a consent checkbox;
// map it in Zapier). TCPA is not a place to guess.

const { sb, json, badSecret, logIngest } = require('./_pec-supabase.cjs');

const ENDPOINT = 'lead-intake';
const DEDUPE_WINDOW_DAYS = 90;

// Last 10 digits, so '+1 (928) 555-1212' and '9285551212' match.
function normPhone(s) {
  const d = String(s == null ? '' : s).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : (d || null);
}

function cleanStr(s) {
  const out = String(s == null ? '' : s).trim();
  return out || null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'Method not allowed' });
  if (badSecret(event)) return json(401, { success: false, error: 'Invalid webhook secret' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { success: false, error: 'Invalid JSON' }); }

  const source = cleanStr(body.source) || 'webform';
  const sourceRef = cleanStr(body.source_ref);
  const firstName = cleanStr(body.first_name);
  const lastName = cleanStr(body.last_name);
  const fullName = cleanStr(body.full_name) || cleanStr(body.name)
    || (firstName ? `${firstName}${lastName ? ' ' + lastName : ''}` : null);
  const email = cleanStr(body.email) ? cleanStr(body.email).toLowerCase() : null;
  const phoneRaw = cleanStr(body.phone);
  const phone10 = normPhone(phoneRaw);
  const notes = cleanStr(body.notes) || cleanStr(body.message) || cleanStr(body.comments);

  if (!fullName) {
    await logIngest({ endpoint: ENDPOINT, deal_id: sourceRef, customer_name: null, outcome: 'rejected', status_code: 400, message: 'name is required', payload: body });
    return json(400, { success: false, error: 'name is required (full_name, name, or first_name)' });
  }
  if (!phone10 && !email) {
    await logIngest({ endpoint: ENDPOINT, deal_id: sourceRef, customer_name: fullName, outcome: 'rejected', status_code: 400, message: 'phone or email is required', payload: body });
    return json(400, { success: false, error: 'phone or email is required' });
  }

  try {
    // Dedupe 1: idempotent on source + source_ref (platform lead id).
    if (sourceRef) {
      const dupRef = await sb('GET', `/leads?source=eq.${encodeURIComponent(source)}&source_ref=eq.${encodeURIComponent(sourceRef)}&deleted_at=is.null&select=id&limit=1`);
      if (dupRef.length) {
        await logIngest({ endpoint: ENDPOINT, deal_id: sourceRef, customer_name: fullName, outcome: 'ok', status_code: 200, message: 'deduped on source_ref', payload: body });
        return json(200, { success: true, deduped: true, lead_id: dupRef[0].id });
      }
    }

    // Dedupe 2: same person reaching out again inside the window.
    const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const orParts = [];
    if (phone10) orParts.push(`phone.ilike.*${phone10}`);
    if (email) orParts.push(`email.eq.${email}`);
    const dupHuman = await sb('GET',
      `/leads?or=(${encodeURIComponent(orParts.join(','))})&deleted_at=is.null&created_at=gte.${encodeURIComponent(sinceIso)}&select=id,stage&order=created_at.desc&limit=1`);
    if (dupHuman.length) {
      await sb('POST', '/lead_events', {
        lead_id: dupHuman[0].id,
        event_type: 'duplicate_intake',
        payload: { source, raw: body },
      });
      await logIngest({ endpoint: ENDPOINT, deal_id: sourceRef, customer_name: fullName, outcome: 'ok', status_code: 200, message: `deduped onto existing lead ${dupHuman[0].id} (stage ${dupHuman[0].stage})`, payload: body });
      return json(200, { success: true, deduped: true, lead_id: dupHuman[0].id });
    }

    // Insert the lead.
    const adMeta = {};
    for (const k of ['adset', 'ad_name', 'form_name', 'form_id', 'ad_id', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
      if (cleanStr(body[k])) adMeta[k] = cleanStr(body[k]);
    }
    const created = await sb('POST', '/leads', {
      brand: 'PEC',
      source,
      source_ref: sourceRef,
      first_name: firstName,
      last_name: lastName,
      full_name: fullName,
      email,
      phone: phoneRaw ? (phone10 || phoneRaw) : null,
      address: cleanStr(body.address),
      city: cleanStr(body.city),
      state: cleanStr(body.state),
      zip: cleanStr(body.zip),
      stage: 'new',
      campaign: cleanStr(body.campaign) || cleanStr(body.utm_campaign),
      ad_meta: Object.keys(adMeta).length ? adMeta : null,
      notes,
      sms_consent: body.sms_consent === true,
      sms_consent_source: body.sms_consent === true ? `${source} form` : null,
      sms_consent_at: body.sms_consent === true ? new Date().toISOString() : null,
    }, true);
    const lead = created[0];

    await sb('POST', '/lead_events', {
      lead_id: lead.id,
      event_type: 'created',
      to_stage: 'new',
      payload: { source, raw: body },
    });

    await logIngest({ endpoint: ENDPOINT, deal_id: sourceRef, customer_name: fullName, outcome: 'ok', status_code: 200, message: `lead created (${source})`, payload: body });
    return json(200, { success: true, deduped: false, lead_id: lead.id });
  } catch (err) {
    console.error('pec-lead-intake failed:', err);
    await logIngest({ endpoint: ENDPOINT, deal_id: sourceRef, customer_name: fullName, outcome: 'error', status_code: 500, message: err && err.message, payload: body });
    return json(500, { success: false, error: 'Internal error ingesting lead' });
  }
};
