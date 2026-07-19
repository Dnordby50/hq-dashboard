// Scheduled function: the lead drip engine's tick. All logic lives in
// _pec-drip.cjs (runDrips) with injectable deps so the fixture test drives
// the same code. Runs every 15 minutes (netlify.toml); the taper is
// day-grained, so cadence is forgiving and overlapping runs are safe (the
// claim-first conditional advance in runDrips makes a double-send
// impossible).
//
// Also callable on-demand (curl / browser) for manual ticks and verification,
// same posture as pec-auto-progress: an outside call can only trigger an
// ordinary run, and with the master switch OFF (settings key
// 'drip_sending_enabled', seeded 'false') a run is a no-op.

const { sb, json } = require('./_pec-supabase.cjs');
const { runDrips, drainBlasts } = require('./_pec-drip.cjs');

exports.handler = async () => {
  try {
    const summary = await runDrips({ sb });
    // Phase 3: the same tick also drains any in-flight blasts (the safety net
    // behind pec-blast-run's immediate kick; resumes after crashes, quiet
    // hours, or the master switch turning on later). One pass per tick keeps
    // the combined work inside the function time limit; big blasts finish
    // over successive ticks or via pec-blast-run.
    let blasts = null;
    try { blasts = await drainBlasts({ sb }); }
    catch (err) { console.error('pec-drip-runner: blast drain failed:', err && err.message || err); }
    console.log('pec-drip-runner:', JSON.stringify({ ...summary, blasts }));
    return json(200, { ok: true, ...summary, blasts });
  } catch (err) {
    console.error('pec-drip-runner failed:', err && err.message || err);
    return json(500, { ok: false, error: String(err && err.message || err) });
  }
};
