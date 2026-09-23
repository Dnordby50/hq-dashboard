// Scheduled Quo contact sync (prompt 107): every 5 minutes (netlify.toml),
// drains due pec_quo_contact_sync rows into Quo contacts. The queue is fed by
// database triggers on leads / customers; the rules are in
// production/quo-contact-sync.cjs and the pass in _pec-quo-contacts.cjs.
// Gated by quo_contact_sync_enabled; a no-op without QUO_API_KEY or before
// the migration lands. Manual runs and the backfill go through
// pec-quo-contact-sync-run (Netlify 403s direct invocation of
// schedule-declared functions).
const { json } = require('./_pec-supabase.cjs');
const { runSyncPass } = require('./_pec-quo-contacts.cjs');

exports.handler = async () => {
  try {
    const result = await runSyncPass({ source: 'scheduled' });
    console.log('pec-quo-contact-sync:', JSON.stringify(result));
    return json(200, result);
  } catch (err) {
    console.error('pec-quo-contact-sync failed:', err && err.message);
    return json(500, { ok: false, error: err && err.message });
  }
};
