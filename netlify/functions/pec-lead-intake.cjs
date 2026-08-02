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
const { enrollLead } = require('./_pec-drip.cjs');
// Same-human matching lives in _pec-lead-match.cjs (prompt 56) so this
// intake and the Routemize appointment intake share ONE dedupe rule.
const { normPhone, findRecentLiveLead } = require('./_pec-lead-match.cjs');
const { resolveLeadSourceName } = require('./_pec-lead-source.cjs');

const ENDPOINT = 'lead-intake';

function cleanStr(s) {
  const out = String(s == null ? '' : s).trim();
  return out || null;
}

// Kick off the per-lead AI analysis for a freshly inserted lead (Dylan's
// decision: AI runs on arrival plus on-demand refresh). Best-effort by
// contract: a slow or failed analysis must NEVER fail or delay the intake
// response, because Zapier treats non-200s as retryable and would re-fire.
//
// HOW the timeout works: we POST to pec-lead-ai (its own Netlify invocation)
// and wait at most AI_TRIGGER_WAIT_MS for the request to be ACCEPTED. The
// race is awaited (not fire-and-forget: a dangling promise can be frozen
// when this lambda returns), but once the HTTP request has left this
// function, pec-lead-ai runs to completion on its own invocation even if we
// stopped waiting. Every failure path lands in console.warn and nothing else.
const AI_TRIGGER_WAIT_MS = 2500;
async function triggerLeadAi(leadId) {
  try {
    const base = process.env.URL || 'https://prescottepoxy.netlify.app';
    const req = fetch(`${base}/.netlify/functions/pec-lead-ai`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': process.env.PEC_WEBHOOK_SECRET || '',
      },
      body: JSON.stringify({ lead_id: leadId }),
    }).then(
      (res) => { if (!res.ok) console.warn(`pec-lead-intake: AI trigger returned ${res.status} for lead ${leadId}`); },
      (err) => { console.warn('pec-lead-intake: AI trigger failed:', err && err.message); }
    );
    const timeout = new Promise((resolve) => setTimeout(resolve, AI_TRIGGER_WAIT_MS));
    await Promise.race([req, timeout]);
  } catch (err) {
    console.warn('pec-lead-intake: AI trigger threw:', err && err.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'Method not allowed' });
  if (badSecret(event)) return json(401, { success: false, error: 'Invalid webhook secret' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { success: false, error: 'Invalid JSON' }); }

  // Prompt 61 Part D: the raw feed token maps to the managed
  // pec_lead_sources NAME here, BEFORE the source+source_ref dedupe query
  // below (landmine 9): stored rows are canonical names now, so deduping on
  // the raw token would miss every prior row and turn each Zapier retry into
  // a duplicate lead. Map first, then dedupe.
  const source = await resolveLeadSourceName(sb, cleanStr(body.source) || 'webform');
  const sourceRef = cleanStr(body.source_ref);
  const firstName = cleanStr(body.first_name);
  const lastName = cleanStr(body.last_name);
  // Prompt 62 Part B: a company / business / organization field maps onto
  // leads.business_name. It also backstops full_name so a business-only
  // submission is not rejected as nameless.
  const businessName = cleanStr(body.business_name) || cleanStr(body.company_name)
    || cleanStr(body.company) || cleanStr(body.business) || cleanStr(body.organization);
  const fullName = cleanStr(body.full_name) || cleanStr(body.name)
    || (firstName ? `${firstName}${lastName ? ' ' + lastName : ''}` : null)
    || businessName;
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
    const dupHuman = await findRecentLiveLead(sb, { phone10, email });
    if (dupHuman) {
      await sb('POST', '/lead_events', {
        lead_id: dupHuman.id,
        event_type: 'duplicate_intake',
        payload: { source, raw: body },
      });
      await logIngest({ endpoint: ENDPOINT, deal_id: sourceRef, customer_name: fullName, outcome: 'ok', status_code: 200, message: `deduped onto existing lead ${dupHuman.id} (stage ${dupHuman.stage})`, payload: body });
      return json(200, { success: true, deduped: true, lead_id: dupHuman.id });
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
      business_name: businessName,
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

    // NEW leads only: both dedupe paths return above, so a Zapier retry or a
    // repeat inquiry never re-runs (and re-bills) the analysis.
    await triggerLeadAi(lead.id);

    // Auto-enroll into the active lead drip campaign (prompt 34). NEW leads
    // only, same reasoning as the AI trigger: dedupe paths returned above, so
    // a retry or repeat inquiry never re-enrolls (and the partial unique
    // index would swallow it anyway). Best-effort by contract: enrollLead
    // never throws, so a drip hiccup (or the migration not being applied
    // yet) can never fail the intake response.
    const enrolled = await enrollLead(sb, lead.id);
    if (!enrolled.enrolled && enrolled.reason === 'error') {
      console.warn('pec-lead-intake: drip enroll failed (non-fatal):', enrolled.error);
    }

    await logIngest({ endpoint: ENDPOINT, deal_id: sourceRef, customer_name: fullName, outcome: 'ok', status_code: 200, message: `lead created (${source})`, payload: body });
    return json(200, { success: true, deduped: false, lead_id: lead.id });
  } catch (err) {
    console.error('pec-lead-intake failed:', err);
    await logIngest({ endpoint: ENDPOINT, deal_id: sourceRef, customer_name: fullName, outcome: 'error', status_code: 500, message: err && err.message, payload: body });
    return json(500, { success: false, error: 'Internal error ingesting lead' });
  }
};
