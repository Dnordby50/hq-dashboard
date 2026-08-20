// TopCoat online booking: drive time with a leash (prompt 101 Part C).
//
// The Google Routes API is the ONE part of the booking build with a
// per-request dollar cost and an external failure mode, and it sits behind a
// public page. Everything here is built so the slot list can NEVER fail
// because Google did:
//   - One batch computeRouteMatrix call per booking session, not one per
//     slot: the customer's address is fixed once they type it, so the
//     distinct neighbor addresses across the whole horizon (plus home base)
//     are the origins and the customer is the single destination.
//   - pec_drive_time_cache is read FIRST (TTL from settings); only cache
//     misses go to the network, and results are written back so a repeat
//     session costs zero.
//   - Budget: at most maxOrigins origins per request (excess pairs simply
//     fall back to the flat default buffer), a hard AbortController timeout,
//     and a missing key or any non-200 degrades to {} silently-logged.
//   - GOOGLE_ROUTES_API_KEY is a SERVER key in Netlify env. It is NOT the
//     referrer-restricted PEC_MAPS_KEY committed to index.html: a
//     referrer-restricted browser key does not authenticate a server call.
//     While unset, everything no-ops to the flat buffer and the build still
//     works (standing rule 7: placeholder + handoff, never a blocked ship).
//
// driveMinutesFor(db, origins, dest, cfg) -> { [originKey]: minutes }
//   db       the _pec-supabase sb(method, path, ...) helper
//   origins  [{ key, address }] distinct neighbor addresses (key from
//            booking-availability's addrKey; address is the human string
//            Google geocodes). HOME_KEY rides through like any other origin,
//            with the home-base setting text as its address.
//   dest     { key, address } the customer's address.
//   cfg      { enabled, apiKey, maxOrigins, timeoutMs, cacheTtlDays }
//
// The returned map is keyed exactly like the engine's driveTimes input, so
// the endpoint hands it straight to computeSlots. Missing keys are the
// engine's cue to use buffer_default_minutes; this module never invents a
// number it did not measure.

'use strict';

const ROUTES_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

function parseDurationSeconds(v) {
  const m = String(v == null ? '' : v).match(/^([\d.]+)s$/);
  return m ? Number(m[1]) : null;
}

async function readCache(db, originKeys, destKey, ttlDays) {
  const out = {};
  try {
    const cutoff = new Date(Date.now() - Math.max(Number(ttlDays) || 30, 1) * 86400 * 1000).toISOString();
    const rows = await db('GET',
      `/pec_drive_time_cache?dest_key=eq.${encodeURIComponent(destKey)}`
      + `&fetched_at=gte.${encodeURIComponent(cutoff)}&select=origin_key,minutes`);
    const wanted = new Set(originKeys);
    for (const r of (Array.isArray(rows) ? rows : [])) {
      if (wanted.has(r.origin_key) && r.minutes != null && isFinite(Number(r.minutes))) {
        out[r.origin_key] = Number(r.minutes);
      }
    }
  } catch (e) {
    console.warn('booking-drive: cache read failed (non-fatal):', e && e.message);
  }
  return out;
}

async function writeCache(db, pairs, destKey) {
  for (const p of pairs) {
    const row = {
      origin_key: p.key, dest_key: destKey,
      minutes: p.minutes, meters: p.meters == null ? null : p.meters,
      fetched_at: new Date().toISOString(),
    };
    try {
      await db('POST', '/pec_drive_time_cache', row);
    } catch (e) {
      if (/409|duplicate|unique/i.test(String(e && e.message))) {
        try {
          await db('PATCH',
            `/pec_drive_time_cache?origin_key=eq.${encodeURIComponent(p.key)}&dest_key=eq.${encodeURIComponent(destKey)}`,
            { minutes: row.minutes, meters: row.meters, fetched_at: row.fetched_at });
        } catch (e2) { console.warn('booking-drive: cache refresh failed (non-fatal):', e2 && e2.message); }
      } else {
        console.warn('booking-drive: cache write failed (non-fatal):', e && e.message);
      }
    }
  }
}

async function driveMinutesFor(db, origins, dest, cfg = {}) {
  const list = (origins || []).filter(o => o && o.key && o.address);
  if (!dest || !dest.key || !dest.address || !list.length) return {};
  if (cfg.enabled === false) return {};

  const ttlDays = cfg.cacheTtlDays != null ? cfg.cacheTtlDays : 30;
  const resolved = await readCache(db, list.map(o => o.key), dest.key, ttlDays);

  let missing = list.filter(o => resolved[o.key] == null);
  const maxOrigins = Math.max(1, Number(cfg.maxOrigins) || 25);
  if (missing.length > maxOrigins) {
    console.warn(`booking-drive: ${missing.length} uncached origins exceeds budget ${maxOrigins}; the excess uses the flat buffer`);
    missing = missing.slice(0, maxOrigins);
  }
  const apiKey = cfg.apiKey || process.env.GOOGLE_ROUTES_API_KEY || '';
  if (!missing.length) return resolved;
  if (!apiKey) return resolved; // unset key: cache hits still help, the rest flat-buffers

  const timeoutMs = Math.max(500, Number(cfg.timeoutMs) || 4000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ROUTES_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,condition',
      },
      body: JSON.stringify({
        origins: missing.map(o => ({ waypoint: { address: o.address } })),
        destinations: [{ waypoint: { address: dest.address } }],
        travelMode: 'DRIVE',
      }),
    });
    if (!res.ok) {
      console.warn(`booking-drive: Routes API ${res.status}; unresolved pairs use the flat buffer`);
      return resolved;
    }
    const body = await res.json();
    const fresh = [];
    for (const el of (Array.isArray(body) ? body : [])) {
      if (el == null || el.condition === 'ROUTE_NOT_FOUND') continue;
      const origin = missing[el.originIndex];
      const secs = parseDurationSeconds(el.duration);
      if (!origin || secs == null) continue;
      const minutes = Math.round(secs / 60);
      resolved[origin.key] = minutes;
      fresh.push({ key: origin.key, minutes, meters: el.distanceMeters != null ? Number(el.distanceMeters) : null });
    }
    if (fresh.length) await writeCache(db, fresh, dest.key);
    return resolved;
  } catch (e) {
    console.warn('booking-drive: Routes call failed (non-fatal):', e && (e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : e.message));
    return resolved;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { driveMinutesFor, parseDurationSeconds };
