// Scheduled function: flip public.jobs.status from 'scheduled' to 'in_progress'
// for every job whose bridged pec_prod_jobs.install_date is today.
//
// Runs daily on a Netlify schedule (see netlify.toml). Also callable on-demand
// from the browser / curl for manual sweeps and verification:
//   curl https://prescottepoxy.netlify.app/.netlify/functions/pec-auto-progress
//
// Pairs with the client-side runAutoProgressSweep() in index.html, which runs
// the same logic at app boot. Idempotent: only rows with status='scheduled'
// flip, so repeated invocations on the same day are a no-op after the first.
//
// Today is computed in MST (UTC-7, project is single-timezone per CLAUDE.md
// context). Run at 13:00 UTC = 06:00 MST so the flip lands before the office
// opens.

const { sb, json } = require('./_pec-supabase.cjs');

const SYSTEM_EMAIL = 'system@pec-auto';

// Format Date as YYYY-MM-DD in MST (UTC-7). No DST per project context.
function todayMst() {
  const now = new Date();
  const mst = new Date(now.getTime() - 7 * 60 * 60 * 1000);
  return mst.toISOString().slice(0, 10);
}

exports.handler = async () => {
  try {
    const today = todayMst();

    // 1) Production-side rows scheduled to install today, scoped to those with
    //    a DripJobs deal id so they can be bridged back to public.jobs.
    const dueProd = await sb(
      'GET',
      `/pec_prod_jobs?install_date=eq.${today}&dripjobs_deal_id=not.is.null&select=dripjobs_deal_id,install_date`
    );
    if (!dueProd.length) {
      return json(200, { ok: true, today, flipped: 0, skipped: 0, note: 'no installs today' });
    }
    const dealIds = [...new Set(dueProd.map(r => r.dripjobs_deal_id))];

    // 2) Matching CRM-side jobs currently in 'scheduled'. Anything already
    //    'in_progress' or further along is skipped (idempotency).
    const inClause = dealIds.map(id => `"${id.replace(/"/g, '\\"')}"`).join(',');
    // select=* (not an explicit list) so reading status_manual_at is safe before
    // the 2026-06-03 migration runs; it is undefined until the column exists.
    const candidates = await sb(
      'GET',
      `/jobs?dripjobs_deal_id=in.(${encodeURIComponent(inClause)})&select=*`
    );
    // Flip only 'scheduled' rows that an admin has NOT manually pinned. A set
    // status_manual_at means the override should survive the daily sweep.
    const toFlip = candidates.filter(j => j.status === 'scheduled' && !j.status_manual_at);
    const skipped = candidates.length - toFlip.length;

    // 3) Flip + audit, one at a time so a single bad row doesn't kill the rest.
    let flipped = 0;
    const failures = [];
    for (const j of toFlip) {
      try {
        await sb('PATCH', `/jobs?id=eq.${j.id}`, { status: 'in_progress' });
        await sb('POST', '/audit_log', {
          auth_user_id: null,
          admin_email: SYSTEM_EMAIL,
          action: 'status_change',
          entity_type: 'jobs',
          entity_id: j.id,
          before_json: { status: 'scheduled' },
          after_json: { status: 'in_progress', source: 'auto_install_day' },
        });
        flipped++;
      } catch (e) {
        failures.push({ id: j.id, error: e.message || String(e) });
      }
    }

    return json(200, { ok: true, today, flipped, skipped, failures });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
