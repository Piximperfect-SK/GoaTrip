// Place resolution cache. Fronts OpenStreetMap Nominatim (free, no key)
// with a Postgres cache so the same place name is only ever geocoded
// once across ALL visitors, not once per browser session. Read-only
// from the client's point of view — no session token required, same
// as registration/itinerary GET endpoints.
//
// Called from shared.js's resolvePlace() instead of hitting Nominatim
// directly from the browser. The extraction/cleanup of raw itinerary
// text into a place phrase still happens client-side (extractPlacePhrase
// in shared.js) — this endpoint just resolves an already-cleaned phrase
// to a canonical place, and remembers the answer.
const { query } = require('./lib/db');
const { ok, badRequest, serverError } = require('./lib/http');
const { sanitizeText } = require('./lib/validate');

const GOA_VIEWBOX = '73.4,15.85,74.35,14.85'; // lon1,lat1,lon2,lat2 — loose box around Goa, a ranking bias only
const CONFIDENCE_FLOOR = 0.18;

let ensured = false;
async function ensureSchema() {
  if (ensured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS resolved_places (
      query_key TEXT PRIMARY KEY,
      resolved BOOLEAN NOT NULL,
      name TEXT,
      display_name TEXT,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      place_id TEXT,
      place_type TEXT,
      confidence DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  ensured = true;
}

function normalizeKey(q) {
  return String(q || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function serializeCacheRow(r) {
  if (!r.resolved) return { resolved: false };
  return {
    resolved: true,
    name: r.name,
    displayName: r.display_name,
    lat: Number(r.lat),
    lng: Number(r.lng),
    placeId: r.place_id,
    type: r.place_type,
    confidence: Number(r.confidence),
  };
}

// A handful of concurrent Netlify function invocations can each cold-start
// with their own module scope, so this is a best-effort courtesy delay
// rather than a hard global rate limit — the Postgres cache is what
// actually keeps repeat lookups from ever reaching Nominatim again, which
// matters far more than perfect request pacing on the first lookup.
let lastNominatimCallAt = 0;
async function politeDelay() {
  const minGapMs = 1100;
  const wait = minGapMs - (Date.now() - lastNominatimCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatimCallAt = Date.now();
}

async function geocodeViaNominatim(q, biasToGoa) {
  const params = new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', limit: '3' });
  if (biasToGoa) {
    params.set('viewbox', GOA_VIEWBOX);
    params.set('bounded', '0');
    params.set('countrycodes', 'in');
  }
  await politeDelay();
  const res = await fetch('https://nominatim.openstreetmap.org/search?' + params.toString(), {
    headers: {
      Accept: 'application/json',
      // Nominatim's usage policy requires a real identifying User-Agent.
      'User-Agent': 'GoaTripApp/1.0 (trip-planning tool; place resolution cache)',
    },
  });
  if (!res.ok) return null;
  const hits = await res.json();
  if (!hits || !hits.length) return null;

  const best = hits[0];
  const importance = typeof best.importance === 'number' ? best.importance : 0;
  // Reject a weak match regardless of how many candidates came back —
  // a single low-importance hit for an ambiguous name used to be
  // accepted outright (the old check only rejected weak hits when
  // there were multiple candidates to choose from), which could
  // silently resolve to the wrong place. The caller (resolveAndCache)
  // already retries once without the Goa bias, so rejecting here just
  // gives that fallback a chance instead of locking in a bad guess.
  if (importance < CONFIDENCE_FLOOR) return null;

  const lat = parseFloat(best.lat);
  const lng = parseFloat(best.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    name: (best.namedetails && best.namedetails.name) || best.display_name.split(',')[0],
    displayName: best.display_name,
    lat,
    lng,
    placeId: String(best.place_id || ''),
    type: best.type || best.class || '',
    confidence: importance,
  };
}

async function resolveAndCache(rawQuery) {
  const key = normalizeKey(rawQuery);
  if (!key) return { resolved: false };

  const { rows } = await query('SELECT * FROM resolved_places WHERE query_key = $1', [key]);
  if (rows.length) return serializeCacheRow(rows[0]);

  let result = await geocodeViaNominatim(rawQuery, true);
  if (!result) result = await geocodeViaNominatim(rawQuery, false);

  if (!result) {
    await query(
      `INSERT INTO resolved_places (query_key, resolved) VALUES ($1, false)
       ON CONFLICT (query_key) DO NOTHING`,
      [key]
    );
    return { resolved: false };
  }

  await query(
    `INSERT INTO resolved_places (query_key, resolved, name, display_name, lat, lng, place_id, place_type, confidence)
     VALUES ($1, true, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (query_key) DO UPDATE SET
       name = EXCLUDED.name, display_name = EXCLUDED.display_name, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
       place_id = EXCLUDED.place_id, place_type = EXCLUDED.place_type, confidence = EXCLUDED.confidence`,
    [key, result.name, result.displayName, result.lat, result.lng, result.placeId, result.type, result.confidence]
  );
  return { resolved: true, ...result };
}

exports.handler = async (event) => {
  try {
    await ensureSchema();

    if (event.httpMethod !== 'GET') return badRequest('Unsupported method.');
    const params = event.queryStringParameters || {};
    const action = params.action || 'resolve';

    if (action === 'resolve') {
      const q = sanitizeText(params.q || '', 200);
      if (!q) return badRequest('q is required.');
      return ok(await resolveAndCache(q));
    }

    // Admin/debug convenience: force a place to be re-resolved (e.g. if
    // Nominatim's data for it changes, or a bad cache entry needs clearing)
    // without needing direct DB access.
    if (action === 'refresh') {
      const q = sanitizeText(params.q || '', 200);
      if (!q) return badRequest('q is required.');
      const key = normalizeKey(q);
      await query('DELETE FROM resolved_places WHERE query_key = $1', [key]);
      return ok(await resolveAndCache(q));
    }

    return badRequest('Unknown action.');
  } catch (err) {
    return serverError(err);
  }
};
