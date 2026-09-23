#!/usr/bin/env node
// One-time (re-runnable, idempotent) backfill of Quo contact names from the
// existing leads and customers (prompt 107, locked decision 10).
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... QUO_API_KEY=... \
//     node scripts/backfill-quo-contacts.cjs --dry-run > /tmp/quo-backfill-dry.json
//   ... node scripts/backfill-quo-contacts.cjs            (LIVE: enqueues rows)
//
// ALWAYS run --dry-run first and hand the list to Dylan: it names every Quo
// contact the sync would CREATE, RENAME (old name -> new name) or SKIP and
// why (fuller name already in Quo, same name, older duplicates left alone),
// plus the leads/customers with no phone. The live run only ENQUEUES rows
// into pec_quo_contact_sync (upsert by phone, so re-running changes nothing
// already queued or done); the scheduled worker pushes them over the next
// few 5-minute ticks with the normal retry and Ops Queue behavior. Nothing
// here writes to Quo directly.
//
// The same plan is reachable without local secrets after deploy:
//   POST /.netlify/functions/pec-quo-contact-sync-run {"backfill":"dry"}
// with a staff JWT (the Ops Queue's Run now pattern).

const { planBackfill } = require('../netlify/functions/_pec-quo-contacts.cjs');

const DRY = process.argv.includes('--dry-run');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !(process.env.QUO_API_KEY || process.env.OPENPHONE_API_KEY)) {
  console.error('Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and QUO_API_KEY first.');
  process.exit(2);
}
planBackfill({ dry: DRY }).then((report) => {
  console.log(JSON.stringify({ mode: DRY ? 'dry-run' : 'live', ...report }, null, 2));
  console.error(`${DRY ? 'DRY RUN' : 'LIVE'}: create ${report.counts.create}, rename ${report.counts.rename}, skip (fuller in Quo) ${report.counts.skip_fuller}, skip (same) ${report.counts.skip_same}, older duplicates left ${report.counts.skip_duplicate_older}, no phone ${report.counts.no_phone.leads} leads / ${report.counts.no_phone.customers} customers${DRY ? '' : `, queued ${report.queued}`}`);
}).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
