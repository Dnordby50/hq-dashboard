// /r/<token> review tracking link (prompt 60, Part C). Logs the click on the
// pec_review_requests row, then 302s to the Google review page.
//
// THE ONE RULE THIS FUNCTION LIVES BY: it must never show a customer an
// error. A bad token, a missing settings row, a dead database, any of it,
// and the customer still lands on the Google review page with the click
// simply unlogged. The customer's tap is the valuable thing; our bookkeeping
// is not worth breaking it. So: the logging block is wrapped in its own
// try/catch, the settings read has its own, and the redirect happens
// unconditionally at the end with a hardcoded fallback URL.
//
// Click semantics:
//   - first_clicked_at is first-write-wins (never overwritten).
//   - click_count increments on every hit.
//   - status moves 'asked' -> 'clicked' ONLY (a 'reviewed'/'skipped'/'stopped'
//     request never moves backwards; its click still counts and stamps).

const { sb, tokenFromEvent } = require('./_pec-supabase.cjs');

// Same as the live settings value today; used only if the settings read fails
// or the row is missing, so the customer is never stranded.
const FALLBACK_REVIEW_URL = 'https://g.page/r/prescottepoxy/review';

exports.handler = async (event) => {
  let dest = FALLBACK_REVIEW_URL;

  // Destination first: even if logging explodes, we know where to send them.
  try {
    const rows = await sb('GET', `/settings?key=eq.google_review_link_epoxy&select=value&limit=1`);
    const url = Array.isArray(rows) && rows[0] && String(rows[0].value || '').trim();
    if (url && /^https?:\/\//i.test(url)) dest = url;
  } catch (err) {
    console.warn('pec-review-redirect: settings read failed, using fallback:', String(err && err.message || err));
  }

  // Bookkeeping, fully best-effort.
  try {
    const token = tokenFromEvent(event);
    if (token) {
      const t = encodeURIComponent(token);
      const reqs = await sb('GET', `/pec_review_requests?token=eq.${t}&select=id,status,first_clicked_at,click_count&limit=1`);
      const req = Array.isArray(reqs) && reqs[0];
      if (req) {
        const patch = { click_count: Number(req.click_count || 0) + 1 };
        if (!req.first_clicked_at) patch.first_clicked_at = new Date().toISOString();
        if (req.status === 'asked') patch.status = 'clicked';
        await sb('PATCH', `/pec_review_requests?id=eq.${encodeURIComponent(req.id)}`, patch);
      }
    }
  } catch (err) {
    console.warn('pec-review-redirect: click log failed (customer still redirected):', String(err && err.message || err));
  }

  return {
    statusCode: 302,
    headers: { Location: dest, 'Cache-Control': 'no-store' },
    body: '',
  };
};
