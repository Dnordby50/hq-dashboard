// Zapier Google Business Profile -> TopCoat review intake (prompt 60, Parts
// E + I). Modeled on pec-appt-intake.cjs. A Zap fires on each new Google
// review and POSTs it here; we record EVERY review (matched or not), try to
// auto-match it to a pec_review_requests ask, and alert on bad ones.
//
// POST /.netlify/functions/pec-review-intake
// Header: x-webhook-secret: <REVIEW_INTAKE_SECRET>
//
// THE TWO TRUTHS THIS FUNCTION RESPECTS:
//   1. Attribution is inferred, never certain. Google hands over a reviewer
//      display name, stars, and text: nothing that identifies a job. So the
//      best this code ever writes is match_status='auto'. It is FORBIDDEN
//      from writing 'confirmed'; only a human in the Reviews view does that,
//      and only 'confirmed' can pay a bonus (landmines 6 and 9).
//   2. Zapier re-fires. external_id (the Google review id) is the idempotency
//      key: a re-fire UPDATES the existing row, never inserts a second, and
//      never re-raises the bad-review alert (Part I would otherwise turn a
//      retry storm into a notification storm).
//
// Field reading is the candidate-list pattern from pec-appt-intake.cjs line
// ~231 (the Routemize lesson from prompt 56: a second payload shape with a
// different field vocabulary silently did nothing). Zapier's GBP trigger has
// shipped at least these vocabularies: the raw API resource (reviewId,
// reviewer.displayName, starRating as a WORD like "FIVE", comment,
// createTime) and flattened snake_case variants. Anything unreadable answers
// 200 with a human-readable note: Zapier retries non-2xx, and a retry storm
// on an unmapped shape helps nobody.
//
// Auto-match (Part E), in order:
//   1. Candidate set: pec_review_requests status asked/clicked, asked_at
//      within review_match_window_days (settings, default 45).
//   2. Score: reviewer name vs customer name (normalized; first-name plus
//      last-initial tolerance), crew leader's first name appearing in the
//      review text, and whether the ask was clicked.
//   3. Exactly one clear candidate: match_status='auto', link the review,
//      move the request to 'reviewed'. Zero or a tie: 'unmatched', job_id
//      stays null, no request is touched.
//
// Bad reviews (Part I): rating <= review_alert_max_stars (default 3) raises
// a pec_notifications bell (clickable through to the Reviews view) and stops
// any live review enrollment for the matched job with stop_reason
// 'bad_review'. An UNMATCHED bad review still alerts: not knowing whose job
// it was is exactly when a human needs to go look. Insert-only, never on a
// re-fire.

const crypto = require('crypto');
const { sb, json, safeEqual, logIngest } = require('./_pec-supabase.cjs');

const ENDPOINT = 'review-intake';

function cleanStr(s) {
  const out = String(s == null ? '' : s).trim();
  return out || null;
}

// Bounded nested lookup, same shape as pec-appt-intake's findNestedKey: top
// level, then one level of nested objects. Never deeper.
function findNestedKey(data, key) {
  if (data == null || typeof data !== 'object') return null;
  if (data[key] != null) return data[key];
  for (const v of Object.values(data)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && v[key] != null) return v[key];
  }
  return null;
}
function firstOf(data, keys) {
  for (const k of keys) {
    const v = findNestedKey(data, k);
    if (v != null && (typeof v !== 'string' || v.trim() !== '')) return v;
  }
  return null;
}

// Google's API sends starRating as a WORD ("FIVE"); Zapier sometimes maps it
// to a number or a numeric string. Read them all; null means unreadable.
const STAR_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5 };
function parseRating(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v >= 1 && v <= 5 ? Math.round(v) : null;
  const s = String(v).trim().toLowerCase();
  if (STAR_WORDS[s] != null) return STAR_WORDS[s];
  const m = s.match(/^([1-5])(\.\d+)?( ?\/ ?5| stars?)?$/);
  if (m) return Number(m[1]);
  return null;
}

const RATING_KEYS = ['rating', 'star_rating', 'starRating', 'stars', 'rating_value', 'ratingValue', 'Rating', 'StarRating'];
const REVIEWER_KEYS = ['reviewer_name', 'reviewerName', 'display_name', 'displayName', 'author_name', 'authorName', 'author', 'reviewer_display_name'];
const TEXT_KEYS = ['review_text', 'reviewText', 'comment', 'Comment', 'text', 'body', 'review_body', 'snippet', 'content'];
const ID_KEYS = ['external_id', 'review_id', 'reviewId', 'ReviewId', 'id'];
const URL_KEYS = ['review_url', 'reviewUrl', 'review_link', 'reviewLink', 'url', 'link'];
const POSTED_KEYS = ['posted_at', 'postedAt', 'create_time', 'createTime', 'created_at', 'createdAt', 'review_date', 'reviewDate', 'date', 'update_time', 'updateTime'];

// One defensive read of whatever Zapier actually sent.
function readReviewFields(body) {
  const data = (body && typeof body === 'object') ? body : {};
  // reviewer may be a nested object ({ reviewer: { displayName } }) or a
  // plain string field; findNestedKey covers the nested displayName, and a
  // string 'reviewer' field covers the flat shape.
  let reviewerName = cleanStr(firstOf(data, REVIEWER_KEYS));
  if (!reviewerName && typeof data.reviewer === 'string') reviewerName = cleanStr(data.reviewer);
  if (!reviewerName && typeof data.name === 'string' && !/\//.test(data.name)) {
    // 'name' is ambiguous: the GBP resource path (accounts/../reviews/..)
    // also lives under 'name'. Only read it as a person when it has no slash.
    reviewerName = cleanStr(data.name);
  }

  let externalId = cleanStr(firstOf(data, ID_KEYS));
  if (!externalId && typeof data.name === 'string' && /\/reviews\//.test(data.name)) {
    externalId = cleanStr(data.name);   // the GBP resource path IS a stable id
  }

  let postedAt = null;
  const rawPosted = cleanStr(firstOf(data, POSTED_KEYS));
  if (rawPosted) {
    const d = new Date(rawPosted);
    if (!isNaN(d)) postedAt = d.toISOString();
  }

  const fields = {
    rating: parseRating(firstOf(data, RATING_KEYS)),
    reviewerName,
    reviewText: cleanStr(firstOf(data, TEXT_KEYS)),
    externalId,
    reviewUrl: cleanStr(firstOf(data, URL_KEYS)),
    postedAt,
  };
  // No id from Google but enough identity to be deterministic: synthesize a
  // stable key so Zapier re-fires of the same review still dedupe.
  if (!fields.externalId && fields.reviewerName && (fields.postedAt || fields.reviewText)) {
    fields.externalId = 'gbp-synth:' + crypto.createHash('sha1')
      .update([fields.reviewerName, fields.rating, fields.postedAt || '', fields.reviewText || ''].join('|'))
      .digest('hex');
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Name scoring: similarity, not identity (truth 1). Normalized lowercase
// letters; exact full name 3, first name + matching last initial 2, first
// name with a missing last name on either side 1, and a first-name match
// with a CONTRADICTING last initial scores 0 (that is a different person,
// not a weaker match).
// ---------------------------------------------------------------------------
function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function nameScore(reviewerName, customerName) {
  const r = normName(reviewerName), c = normName(customerName);
  if (!r || !c) return 0;
  if (r === c) return 3;
  const rp = r.split(' '), cp = c.split(' ');
  if (rp[0] !== cp[0]) return 0;
  const rLast = rp.length > 1 ? rp[rp.length - 1] : null;
  const cLast = cp.length > 1 ? cp[cp.length - 1] : null;
  if (rLast && cLast) return rLast[0] === cLast[0] ? 2 : 0;
  return 1;
}

// Does the crew leader's FIRST name appear in the review text as a word?
// (The ask copy names the crew leader on purpose; customers repeat it.)
function crewMentioned(reviewText, crewLead) {
  const first = normName(crewLead).split(' ')[0];
  if (!first || first.length < 3) return false;   // 2-letter names false-positive on ordinary words
  return new RegExp(`\\b${first}\\b`, 'i').test(String(reviewText || ''));
}

async function getSetting(db, key, dflt) {
  try {
    const rows = await db('GET', `/settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
    const v = Array.isArray(rows) && rows[0] ? rows[0].value : null;
    return v != null && String(v).trim() !== '' ? String(v).trim() : dflt;
  } catch (_) {
    return dflt;
  }
}

// Stop any ACTIVE review-kind enrollment for this job. reason is
// 'bad_review' (Part I) or 'reviewed' (a good review landed; the next runner
// tick would catch it anyway, this is just the eager version).
async function stopReviewEnrollment(db, jobId, reason, nowIso) {
  const camps = await db('GET', `/pec_drip_campaigns?kind=eq.review&select=id`);
  const ids = (Array.isArray(camps) ? camps : []).map(c => c.id);
  if (!ids.length) return 0;
  const patched = await db('PATCH',
    `/pec_drip_enrollments?subject_type=eq.job&subject_id=eq.${encodeURIComponent(jobId)}&status=eq.active&campaign_id=in.(${ids.join(',')})`,
    { status: 'stopped', stop_reason: reason, stopped_at: nowIso, next_send_at: null }, true);
  return Array.isArray(patched) ? patched.length : 0;
}

// The whole behavior with injectable deps ({ sb, logIngest, now }) so the
// fixture test drives the REAL flow. Returns { status, body }.
async function processReviewIntake(deps, body) {
  const db = deps.sb;
  const log = deps.logIngest || logIngest;
  const now = deps.now ? deps.now() : new Date();
  const nowIso = now.toISOString();
  const rawPayload = body;

  const f = readReviewFields(body);

  // Unreadable rating: 200 with a note, never a 4xx (Zapier retries non-2xx).
  if (f.rating == null) {
    await log({ endpoint: ENDPOINT, deal_id: f.externalId, customer_name: f.reviewerName, outcome: 'ok', status_code: 200, message: 'no readable star rating in payload; nothing recorded', payload: rawPayload });
    return { status: 200, body: { success: true, recorded: false, note: 'no readable star rating in payload' } };
  }
  if (!f.externalId) {
    await log({ endpoint: ENDPOINT, deal_id: null, customer_name: f.reviewerName, outcome: 'ok', status_code: 200, message: 'no review id and not enough identity to synthesize one; nothing recorded', payload: rawPayload });
    return { status: 200, body: { success: true, recorded: false, note: 'no readable review id in payload' } };
  }

  try {
    // ---- Idempotency: a re-fire updates, never inserts, never re-alerts ----
    const eid = encodeURIComponent(f.externalId);
    const existing = await db('GET', `/reviews?external_id=eq.${eid}&select=id,match_status&limit=1`);
    if (Array.isArray(existing) && existing.length) {
      const patch = { rating: f.rating };
      if (f.reviewerName) patch.reviewer_name = f.reviewerName;
      if (f.reviewText) patch.review_text = f.reviewText;
      if (f.reviewUrl) patch.review_url = f.reviewUrl;
      if (f.postedAt) patch.posted_at = f.postedAt;
      await db('PATCH', `/reviews?id=eq.${encodeURIComponent(existing[0].id)}`, patch);
      await log({ endpoint: ENDPOINT, deal_id: f.externalId, customer_name: f.reviewerName, outcome: 'ok', status_code: 200, message: `re-fire: review ${existing[0].id} updated (no new alert)`, payload: rawPayload });
      return { status: 200, body: { success: true, updated: true, review_id: existing[0].id } };
    }

    // ---- Insert (unmatched first; job_id/customer_id are nullable now) -----
    let inserted;
    try {
      inserted = await db('POST', '/reviews', {
        source: 'zapier_gbp',
        platform: 'google',
        external_id: f.externalId,
        rating: f.rating,
        reviewer_name: f.reviewerName,
        review_text: f.reviewText,
        review_url: f.reviewUrl,
        posted_at: f.postedAt,
        match_status: 'unmatched',
      }, true);
    } catch (err) {
      // uq_reviews_external_id: a concurrent re-fire beat us between the
      // existence check and the insert. Its row is the row; no second alert.
      if (/409|23505|duplicate/i.test(String(err && err.message))) {
        await log({ endpoint: ENDPOINT, deal_id: f.externalId, customer_name: f.reviewerName, outcome: 'ok', status_code: 200, message: 'deduped on external_id (concurrent re-fire)', payload: rawPayload });
        return { status: 200, body: { success: true, deduped: true } };
      }
      throw err;
    }
    const review = inserted[0];

    // ---- Auto-match ---------------------------------------------------------
    // Best-effort: a matching failure must never lose the recorded review.
    let matched = null;
    try {
      const windowDays = Number(await getSetting(db, 'review_match_window_days', '45')) || 45;
      const sinceIso = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
      const cands = await db('GET',
        `/pec_review_requests?status=in.(asked,clicked)&asked_at=gte.${encodeURIComponent(sinceIso)}&select=*`);
      const list = Array.isArray(cands) ? cands : [];
      const custIds = [...new Set(list.map(r => r.customer_id).filter(Boolean))];
      const custRows = custIds.length
        ? await db('GET', `/customers?id=in.(${custIds.join(',')})&select=id,name,first_name,last_name`)
        : [];
      const custMap = new Map((Array.isArray(custRows) ? custRows : []).map(c => [c.id, c]));

      const scored = list.map(req => {
        const cust = custMap.get(req.customer_id);
        const custName = cust
          ? (cust.first_name ? `${cust.first_name} ${cust.last_name || ''}`.trim() : cust.name)
          : null;
        const nScore = nameScore(f.reviewerName, custName);
        if (!nScore) return null;   // no name evidence at all: not a candidate
        let score = nScore;
        if (crewMentioned(f.reviewText, req.crew_lead)) score += 1;
        if (req.status === 'clicked' || req.first_clicked_at) score += 1;
        return { req, score };
      }).filter(Boolean).sort((a, b) => b.score - a.score);

      // "Exactly one clear candidate": the top score clears the bar AND
      // nothing ties it. A tie between two plausible jobs stays unmatched
      // for a human to sort out; guessing pays the wrong crew leader.
      if (scored.length && scored[0].score >= 2
        && (scored.length === 1 || scored[1].score < scored[0].score)) {
        matched = scored[0].req;
      }
    } catch (err) {
      console.warn('pec-review-intake: auto-match skipped:', String(err && err.message || err));
    }

    if (matched) {
      // NEVER 'confirmed' here (landmine 6): auto is the ceiling for a machine.
      await db('PATCH', `/reviews?id=eq.${encodeURIComponent(review.id)}`, {
        match_status: 'auto',
        job_id: matched.job_id,
        customer_id: matched.customer_id,
        review_request_id: matched.id,
        crew_lead: matched.crew_lead,   // the ask-time SNAPSHOT, never re-derived
        crew_id: matched.crew_id,
        matched_at: nowIso,
        matched_by: 'auto',
      });
      await db('PATCH', `/pec_review_requests?id=eq.${encodeURIComponent(matched.id)}&status=in.(asked,clicked)`, {
        status: 'reviewed', review_id: review.id,
      });
    }

    // ---- Part I: bad-review alert (insert only, never a re-fire) -----------
    const alertMax = Number(await getSetting(db, 'review_alert_max_stars', '3')) || 3;
    let alerted = false, stopped = 0;
    if (f.rating <= alertMax) {
      alerted = true;
      let who = f.reviewerName || 'an unidentified reviewer';
      if (matched) {
        const cust = matched.customer_id
          ? await db('GET', `/customers?id=eq.${encodeURIComponent(matched.customer_id)}&select=name&limit=1`).catch(() => null)
          : null;
        if (Array.isArray(cust) && cust[0] && cust[0].name) who = cust[0].name;
      }
      // One broadcast bell (the pec_notifications mechanism has no recipient
      // targeting; Dylan and Anne both see it), clickable through to Reviews.
      await db('POST', '/pec_notifications', {
        type: 'bad_review',
        priority: 'high',
        job_id: matched ? matched.job_id : null,
        body: `${f.rating}-star Google review from ${who}${matched ? '' : ' (not matched to a job yet)'}. Open Reviews to read it.`,
        target_view: 'reviews',
        target_id: review.id,
      }).catch(e => console.error('pec-review-intake: bad-review bell failed', e && e.message));
      if (matched && matched.job_id) {
        stopped = await stopReviewEnrollment(db, matched.job_id, 'bad_review', nowIso)
          .catch(e => { console.error('pec-review-intake: enrollment stop failed', e && e.message); return 0; });
      }
    } else if (matched && matched.job_id) {
      // Good review: eager stop with 'reviewed' (the runner's kill-switch
      // would catch it next tick; this just stops the drip instantly).
      stopped = await stopReviewEnrollment(db, matched.job_id, 'reviewed', nowIso)
        .catch(e => { console.error('pec-review-intake: enrollment stop failed', e && e.message); return 0; });
    }

    await log({
      endpoint: ENDPOINT, deal_id: f.externalId, customer_name: f.reviewerName, outcome: 'ok', status_code: 200,
      message: `created: review ${review.id} (${f.rating} stars, ${matched ? `auto-matched to job ${matched.job_id}` : 'unmatched'}${alerted ? ', bad-review alert raised' : ''}${stopped ? `, ${stopped} enrollment stopped` : ''})`,
      payload: rawPayload,
    });
    return {
      status: 200,
      body: {
        success: true, created: true, review_id: review.id,
        match_status: matched ? 'auto' : 'unmatched',
        job_id: matched ? matched.job_id : null,
        alerted, enrollments_stopped: stopped,
      },
    };
  } catch (err) {
    console.error('pec-review-intake failed:', err);
    await log({ endpoint: ENDPOINT, deal_id: f.externalId, customer_name: f.reviewerName, outcome: 'error', status_code: 500, message: err && err.message, payload: rawPayload });
    return { status: 500, body: { success: false, error: 'Internal error ingesting review' } };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'Method not allowed' });
  // Own secret (REVIEW_INTAKE_SECRET) so the Zapier credential can rotate
  // independently of the DripJobs webhook secret. Standing rule 7: the value
  // lives in Netlify env, never in code.
  const secret = process.env.REVIEW_INTAKE_SECRET;
  const got = event.headers['x-webhook-secret'] || event.headers['X-Webhook-Secret'];
  if (!secret || !got || !safeEqual(got, secret)) {
    return json(401, { success: false, error: 'Invalid webhook secret' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { success: false, error: 'Invalid JSON' }); }

  const out = await processReviewIntake({ sb, logIngest }, body);
  return json(out.status, out.body);
};

// Exported for the fixture test (production/review-intake.test.cjs).
exports.processReviewIntake = processReviewIntake;
exports.readReviewFields = readReviewFields;
exports.parseRating = parseRating;
exports.nameScore = nameScore;
exports.crewMentioned = crewMentioned;
