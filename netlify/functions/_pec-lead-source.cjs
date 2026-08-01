// Lead-source name resolution (prompt 61 Part D). ONE managed list
// (pec_lead_sources) drives leads.source and customers.lead_source; intake
// feeds send tokens ('meta', 'webform', Routemize's leadSourceText slugs) and
// this maps them to the canonical managed NAME at the door.
//
// Match order: exact name, case-insensitive name, then alias
// (case-insensitive). No match returns the raw trimmed string UNCHANGED with
// a console.warn, so an unmapped feed shows up in the function log instead of
// vanishing, and attribution is never nulled or guessed (landmine 12).
// Adding a new feed vocabulary is a Settings edit (the Aliases field on the
// lead-source editor), never a code change (rule 12).
//
// db is the REST-style sb(method, path) helper. Best-effort: a failed list
// read resolves to the raw value (intake must never fail because of a
// vocabulary lookup).

async function resolveLeadSourceName(db, raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return s;
  let rows;
  try {
    rows = await db('GET', '/pec_lead_sources?select=name,aliases');
  } catch (err) {
    console.warn('resolveLeadSourceName: pec_lead_sources read failed, keeping raw value:', String(err && err.message || err));
    return s;
  }
  const list = Array.isArray(rows) ? rows : [];
  const exact = list.find(r => r.name === s);
  if (exact) return exact.name;
  const lower = s.toLowerCase();
  const ci = list.find(r => String(r.name || '').toLowerCase() === lower);
  if (ci) return ci.name;
  const byAlias = list.find(r => (Array.isArray(r.aliases) ? r.aliases : []).some(a => String(a || '').toLowerCase() === lower));
  if (byAlias) return byAlias.name;
  console.warn(`resolveLeadSourceName: no managed lead source matches '${s}'; keeping it as-is. Add it (or an alias) in Settings > Lead sources.`);
  return s;
}

module.exports = { resolveLeadSourceName };
