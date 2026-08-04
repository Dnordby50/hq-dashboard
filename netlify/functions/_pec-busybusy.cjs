// Outbound BusyBusy project auto-creation (prompt 68). The accept path fires
// a POST at a Zapier Catch Hook (ZAPIER_BUSYBUSY_HOOK_URL) whose Zap runs
// BusyBusy Create Project. A Netlify function cannot call the Zapier MCP
// tools (assistant-side capability), and BusyBusy's own APIs are dead ends
// (export.busybusy.io is a read-only CSV snapshot; graphql.busybusy.io has
// 401'd since 2026-06-13), so the Catch Hook is the ONLY outbound path: the
// Routemize intake pattern in reverse.
//
// Naming rule (Dylan, prompt 68 decision 3): title = the customer name
// EXACTLY as TopCoat stores it, project_number = the estimate number's
// digits, customer = the customer name again. The title carries no estimate
// number ON PURPOSE: pec_prod_busybusy_projects links by NAME ONCE THEN
// NUMBER (SCHEMA.md), so a title like "Tom Bechtel EST-102047" would fail
// the importer's normalized name match. Because we also SUPPLY the number
// and write the pec_prod_busybusy_projects row ourselves at creation, the
// importer matches on the number the first time hours arrive and the name
// match is only a fallback.
//
// Everything here is best-effort by contract: a signed estimate becoming a
// job is the single most important write in the product, so no error,
// timeout, or missing env var may ever reject the accept path. The caller
// wraps the call AND maybeCreateBusybusyProject never throws.

// Build the Catch Hook payload, or null when this job must not create a
// project. Pure and dependency-free so the test fixtures drive it directly.
function buildBusybusyProjectPayload(input) {
  const i = input || {};
  // A callback / touch-up job never gets its own project: its hours belong
  // to the original job (prompt 68 guardrail).
  if (i.isCallback === true) return null;
  const name = String(i.customerName || '').trim();
  // No customer name -> no project. A BusyBusy title is what the crew picks
  // when clocking in; an unnamed project would collect orphan hours.
  if (!name) return null;
  const digits = String(i.estimateNumber == null ? '' : i.estimateNumber).replace(/\D/g, '');
  const radiusNum = Number(i.radius);
  // BusyBusy's geofence minimum is 100 m; default 150 when unset/invalid.
  const radius = Number.isFinite(radiusNum) && radiusNum >= 100 ? Math.round(radiusNum) : 150;
  const s = (v) => {
    const t = String(v == null ? '' : v).trim();
    return t || null;
  };
  return {
    title: name,
    project_number: digits || null,
    customer: name,
    address_1: s(i.address1),
    city: s(i.city),
    state: s(i.state),
    postal_code: s(i.zip),
    phone: s(i.phone),
    radius,
    reminders: i.reminders === true,
    onsite_verification: 'none',
    // Traceability only (shows in the Zap run history; the Zap does not map
    // these into BusyBusy fields).
    topcoat_job_id: s(i.topcoatJobId),
    estimate_number: i.estimateNumber != null ? i.estimateNumber : null,
  };
}

// The accept-path orchestrator. NEVER throws; every failure returns a
// { skipped } result and logs one warn line. Dependency-injected (sb,
// fetchFn, env) so the test harness proves the failure modes honestly.
//
// Order of operations is deliberate: settings gate -> idempotency check ->
// LOCAL pec_prod_busybusy_projects row (the pending link: linked_by/linked_at
// stay null until a human or the importer touches it, which is the existing
// nullable-state convention on that table; no new column needed) -> the POST.
// The local row lands first so the job-to-project link exists even if the
// Zap is slow or its run fails, and the unique partial indexes on
// project_number / lower(project_name) make a concurrent double-accept lose
// the insert race and skip the POST: two projects for one job is worse than
// none.
async function maybeCreateBusybusyProject({ sb, fetchFn, env, est, prodJobId, isCallback }) {
  try {
    const hook = (env || {}).ZAPIER_BUSYBUSY_HOOK_URL;
    if (!hook) return { skipped: 'unconfigured' }; // clean no-op, like the Google OAuth path

    const set = await sb('GET', '/settings?key=in.(busybusy_autocreate_enabled,busybusy_autocreate_radius_m,busybusy_autocreate_reminders)&select=key,value');
    const cfg = Object.fromEntries((set || []).map((r) => [r.key, r.value]));
    if (String(cfg.busybusy_autocreate_enabled == null ? 'true' : cfg.busybusy_autocreate_enabled) === 'false') {
      return { skipped: 'disabled' };
    }

    const payload = buildBusybusyProjectPayload({
      estimateNumber: est.estimate_number,
      customerName: est.customer_name,
      address1: est.customer_address1 || est.customer_address || null,
      city: est.customer_city,
      state: est.customer_state,
      zip: est.customer_zip,
      phone: est.customer_phone,
      radius: cfg.busybusy_autocreate_radius_m,
      reminders: String(cfg.busybusy_autocreate_reminders || 'false') === 'true',
      isCallback: isCallback === true,
      topcoatJobId: prodJobId,
    });
    if (!payload) return { skipped: 'no-payload' };

    // Idempotency: one project per job AND per number, ever. A double accept,
    // a heal-path re-run, or a retry storm all land here and skip.
    const numClause = payload.project_number ? `,project_number.eq.${encodeURIComponent(payload.project_number)}` : '';
    const existing = await sb('GET',
      `/pec_prod_busybusy_projects?or=(job_id.eq.${encodeURIComponent(prodJobId)}${numClause})&select=id&limit=1`);
    if ((existing || []).length) return { skipped: 'exists' };

    await sb('POST', '/pec_prod_busybusy_projects', {
      project_number: payload.project_number,
      project_name: payload.title,
      job_id: prodJobId,
    });

    const secret = (env || {}).ZAPIER_BUSYBUSY_HOOK_SECRET || null;
    // The secret rides in BOTH a header and the body: a Zapier Catch Hook
    // exposes the body to a Filter step reliably; the header covers any
    // future receiver that can read headers (Routemize-intake style).
    const body = secret ? { ...payload, secret } : payload;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const res = await (fetchFn || fetch)(hook, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(secret ? { 'x-topcoat-secret': secret } : {}) },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      return { posted: true, status: res && res.status };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.warn('busybusy project create skipped (acceptance unaffected):', String((err && err.message) || err));
    return { skipped: 'error', error: String((err && err.message) || err) };
  }
}

module.exports = { buildBusybusyProjectPayload, maybeCreateBusybusyProject };
