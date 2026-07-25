// Migration drift checker (prompt 48, Part A). Detects repo migrations that
// never reached prod -- the failure that let 2026-07-18_crew_notes.sql silently
// break every estimator save for a week.
//
// Detection is by ARTIFACT PROBE, not filename matching:
// supabase_migrations.schema_migrations records names that do not reliably
// match repo filenames ('invoice_installments', '2026_07_20_appointments'),
// and a checker that cries wolf gets muted. Instead each migration's
// @artifacts header (CLAUDE.md rule 13) is compiled at BUILD time into
// _migration-manifest.json (scripts/build-migration-manifest.mjs, wired into
// the netlify.toml build command -- the deployed function has no repo tree to
// read), and every declared artifact is probed against the LIVE schema in one
// batched pec_schema_probe RPC call. That also catches a PARTIALLY applied
// migration, which name matching structurally cannot.
//
// Runs daily on a Netlify schedule (see netlify.toml, 14:00 UTC = 07:00 MST,
// after the 06:00 auto-progress sweep). Also callable on-demand:
//   curl 'https://prescottepoxy.netlify.app/.netlify/functions/pec-migration-drift?manual=1&notify=0'
// ?manual=1 skips the migration_drift_check_enabled gate (the Settings >
// Diagnostics panel uses this so the on-demand view always works);
// ?notify=0 suppresses bell notifications (panel default -- results are on
// screen). Idempotent: read-only apart from de-duped pec_notifications
// inserts, so repeated runs while a migration stays pending add nothing.

const { sb, json } = require('./_pec-supabase.cjs');
const manifest = require('./_migration-manifest.json');

const PROBE_MIGRATION = '2026-07-25_migration_drift_probe.sql';

// One bell per (type, subject) while an unread one is outstanding. A migration
// pending for two weeks must not generate fourteen notifications; the next
// bell only fires after an admin reads the last one.
async function notifyDeduped({ type, subject, body, priority }) {
  const dupes = await sb(
    'GET',
    `/pec_notifications?type=eq.${type}&read_at=is.null&body=ilike.${encodeURIComponent(`*${subject}*`)}&select=id&limit=1`
  );
  if ((dupes || []).length) return false;
  await sb('POST', '/pec_notifications', {
    type,
    body,
    priority: priority || 'normal',
    target_view: 'schema-drift',
    target_id: null,
  });
  return true;
}

exports.handler = async (event) => {
  try {
    const qs = (event && event.queryStringParameters) || {};
    const manual = qs.manual === '1';
    const notify = qs.notify !== '0';

    // Settings: enabled gate (scheduled runs only) + baseline.
    let settings = {};
    try {
      const rows = await sb('GET', '/settings?key=in.(migration_drift_check_enabled,migration_drift_baseline)&select=key,value');
      settings = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
    } catch (_) { /* fall through to defaults */ }
    if (!manual && String(settings.migration_drift_check_enabled || 'true') === 'false') {
      return json(200, { ok: true, skipped: 'migration_drift_check_enabled is false' });
    }
    const baseline = /^\d{4}-\d{2}-\d{2}$/.test(settings.migration_drift_baseline || '')
      ? settings.migration_drift_baseline
      : '2026-07-01';

    const inScope = manifest.migrations.filter((m) => m.date && m.date >= baseline);

    // Batch every declared artifact into ONE probe call. Column names arrive
    // in the header as public.<table>.<column>; the RPC takes <table>.<column>.
    const items = [];
    for (const m of inScope) {
      for (const a of m.artifacts) {
        items.push({ kind: a.kind, name: a.name.replace(/^public\./, '') });
      }
    }

    let probe;
    try {
      probe = await sb('POST', '/rpc/pec_schema_probe', { items });
    } catch (err) {
      // Bootstrap: the probe RPC is itself shipped by a migration, so its
      // absence IS drift -- fail loudly, never silently, and never guess.
      const msg = `Migration drift checker cannot run: the pec_schema_probe RPC is missing. Apply ${PROBE_MIGRATION} to prod.`;
      let notified = false;
      if (notify) {
        try {
          notified = await notifyDeduped({ type: 'migration_drift', subject: PROBE_MIGRATION, body: msg, priority: 'high' });
        } catch (_) { /* notification is best-effort */ }
      }
      return json(200, { ok: false, error: msg, detail: err.message || String(err), notified });
    }

    const present = new Map(); // 'kind:name' -> boolean
    for (const r of (probe && probe.results) || []) present.set(`${r.kind}:${r.name}`, !!r.present);
    const has = (a) => present.get(`${a.kind}:${a.name.replace(/^public\./, '')}`) === true;

    // Classify each in-scope migration:
    //   applied  -- every declared artifact exists
    //   missing  -- none exist (the migration never ran)
    //   partial  -- some exist, some do not (a migration HALF-ran; loudest)
    //   unknown  -- no header, or a 'none:' header (nothing probeable); listed,
    //               never guessed either way
    const applied = [];
    const missing = [];
    const partial = [];
    const unknown = [];
    for (const m of inScope) {
      if (!m.hasHeader) {
        unknown.push({ file: m.file, reason: 'no @artifacts header' });
        continue;
      }
      if (!m.artifacts.length) {
        unknown.push({ file: m.file, reason: m.none || 'header declares no artifacts' });
        continue;
      }
      const absent = m.artifacts.filter((a) => !has(a)).map((a) => `${a.kind}: ${a.name}`);
      const found = m.artifacts.filter(has).map((a) => `${a.kind}: ${a.name}`);
      if (!absent.length) applied.push(m.file);
      else if (!found.length) missing.push({ file: m.file, absent });
      else partial.push({ file: m.file, absent, present: found });
    }

    // Reverse drift (informational, lower severity, never notifies): live
    // public tables that NO repo SQL file creates. knownTables is built from
    // every file under supabase/ (base schema + all migrations, headered or
    // not), so pre-baseline tables never false-positive.
    const known = new Set(manifest.knownTables);
    for (const m of manifest.migrations) {
      for (const a of m.artifacts) {
        if (a.kind === 'table') known.add(a.name.replace(/^public\./, ''));
      }
    }
    const liveTables = (probe && probe.tables) || [];
    const reverseAll = liveTables.filter((t) => !known.has(t));
    const REVERSE_CAP = 40;
    const reverse = {
      note: 'informational: live tables no repo SQL file creates; not part of drift severity',
      tables: reverseAll.slice(0, REVERSE_CAP),
      truncated: Math.max(0, reverseAll.length - REVERSE_CAP),
    };

    // Bell notifications: one per migration per detection, de-duped against
    // unread rows so a known-pending migration never generates daily noise.
    // partial = high (a half-run migration is an inconsistent schema);
    // missing = normal. Reverse drift alone never notifies.
    let notified = 0;
    if (notify) {
      for (const p of partial) {
        try {
          if (await notifyDeduped({
            type: 'migration_drift',
            subject: p.file,
            body: `Migration ${p.file} is PARTIALLY applied to prod. Absent: ${p.absent.join(', ')}. See Settings > Diagnostics > Schema drift.`,
            priority: 'high',
          })) notified++;
        } catch (_) { /* best-effort */ }
      }
      for (const m of missing) {
        try {
          if (await notifyDeduped({
            type: 'migration_drift',
            subject: m.file,
            body: `Migration ${m.file} has not been applied to prod. Absent: ${m.absent.join(', ')}. See Settings > Diagnostics > Schema drift.`,
            priority: 'normal',
          })) notified++;
        } catch (_) { /* best-effort */ }
      }
    }

    return json(200, {
      ok: true,
      checkedAt: new Date().toISOString(),
      baseline,
      checked: inScope.length,
      applied: applied.length,
      appliedFiles: applied,
      missing,
      partial,
      unknown,
      reverse,
      notified,
    });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
