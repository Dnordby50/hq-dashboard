// One-shot Google Calendar backfill (prompt 88). Re-pushes every appointment
// with status='scheduled' AND google_event_id IS NULL to its member's TopCoat
// calendar, for recovering from the 2026-07/08 outage (dead OAuth refresh
// tokens + the intake never kicking the push): 19 rows at write time had
// never been pushed. Safe to run repeatedly: the push core is idempotent (a
// stamped row PUTs, an unstamped one inserts), and a successful backfill
// leaves nothing for the next run to do. Canceled rows are excluded by the
// query on purpose (create-then-cancel churn in Google helps nobody);
// unassigned rows cannot push and are listed in the response instead.
//
// POST /.netlify/functions/pec-appt-backfill-push
// Header: x-webhook-secret: <PEC_WEBHOOK_SECRET>  (the same secret every
//         intake webhook uses; lets Cowork curl it without a staff JWT)
//
// Deliberately NO settings row and NO UI (rule 12: a recovery action is not
// a tunable). Invocation is documented in PROJECT-LOG (2026-08-12 entry).

const { sb, json, badSecret } = require('./_pec-supabase.cjs');
const { googleConfigured } = require('./_pec-google.cjs');
const { pushApptById } = require('./_pec-appt-push.cjs');

const ROW_CAP = 200; // 19 today; the cap only guards a runaway future call

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  if (badSecret(event)) return json(401, { ok: false, error: 'Invalid webhook secret' });
  if (!googleConfigured()) return json(200, { ok: true, skipped: 'google_not_configured' });

  const summary = { candidates: 0, pushed: 0, failed: 0, skipped: 0, unassigned: [], failures: [], by_member: {} };
  try {
    const rows = await sb('GET',
      `/pec_appointments?status=eq.scheduled&google_event_id=is.null&select=id,title,start_at,sales_member_id&order=start_at.asc&limit=${ROW_CAP}`);
    const appts = Array.isArray(rows) ? rows : [];
    summary.candidates = appts.length;

    // Member names once, for a per-member count Cowork can read back.
    const mRows = await sb('GET', '/pec_sales_team_members?select=id,name');
    const nameById = {};
    for (const m of (Array.isArray(mRows) ? mRows : [])) nameById[m.id] = m.name;

    for (const a of appts) {
      const label = `${a.title || 'untitled'} @ ${a.start_at}`;
      if (!a.sales_member_id) { summary.unassigned.push(`${a.id} (${label})`); continue; }
      let out;
      try { out = await pushApptById(sb, a.id); }
      catch (e) { out = { ok: false, error: String(e && e.message || e) }; }
      const who = nameById[a.sales_member_id] || a.sales_member_id;
      if (out.ok && out.google_event_id) {
        summary.pushed++;
        summary.by_member[who] = (summary.by_member[who] || 0) + 1;
      } else if (out.ok) {
        // skipped: member_not_connected / token_refresh_failed / row_gone
        summary.skipped++;
        summary.failures.push(`${a.id} (${label}, ${who}): ${out.skipped}`);
      } else {
        summary.failed++;
        summary.failures.push(`${a.id} (${label}, ${who}): ${out.error || 'push failed'}`);
      }
    }
    console.log('pec-appt-backfill-push:', JSON.stringify(summary));
    return json(200, { ok: summary.failed === 0, ...summary });
  } catch (err) {
    console.error('pec-appt-backfill-push failed:', err && err.message || err);
    return json(500, { ok: false, error: String(err && err.message || err), ...summary });
  }
};
