// Place resolution cache. Fronts OpenStreetMap Nominatim (free, no key)
// for geocoding and Wikipedia's geosearch+pageimages API (free, no key)
// for a matching photo, with a Postgres cache so the same place name is
// only ever geocoded/photo-matched once across ALL visitors, not once
// per browser session. Read-only from the client's point of view — no
// session token required, same as registration/itinerary GET endpoints.
//
// Called from shared.js's resolvePlace() instead of hitting Nominatim/
// Wikipedia directly from the browser. The extraction/cleanup of raw
// itinerary text into a place phrase still happens client-side
// (extractPlacePhrase in shared.js) — this endpoint just resolves an
// already-cleaned phrase to a canonical place + photo, and remembers
// the answer.
const { query } = require('./lib/db');
const { ok, badRequest, serverError } = require('./lib/http');
const { sanitizeText } = require('./lib/validate');

const GOA_VIEWBOX = '73.4,15.85,74.35,14.85'; // lon1,lat1,lon2,lat2 — loose box around Goa, a ranking bias only
const CONFIDENCE_FLOOR = 0.18;

// Photo matching tuning. Wikipedia's geosearch returns pages near the
// resolved coordinate; we keep only ones close enough to plausibly BE
// the place (not just near it) and prefer whichever candidate's title
// textually overlaps the place name, since geosearch alone often
// surfaces a nearby village/ward/taluka page instead of the landmark.
const PHOTO_SEARCH_RADIUS_M = 4000;
const PHOTO_MAX_CANDIDATES = 5;
const PHOTO_THUMB_SIZE = 900;

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
  // Photo columns, added the same ADD COLUMN IF NOT EXISTS way trips.js
  // rolls out new columns — safe against an existing resolved_places
  // table from before photo matching existed, no separate migration.
  await query('ALTER TABLE resolved_places ADD COLUMN IF NOT EXISTS photo TEXT');
  await query('ALTER TABLE resolved_places ADD COLUMN IF NOT EXISTS photo_title TEXT');
  await query('ALTER TABLE resolved_places ADD COLUMN IF NOT EXISTS photo_source TEXT');
  await query('ALTER TABLE resolved_places ADD COLUMN IF NOT EXISTS photo_candidates JSONB');
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
    photo: r.photo || null,
    photoTitle: r.photo_title || null,
    photoSource: r.photo_source || '',
    photoCandidates: r.photo_candidates || [],
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

function titleOverlapScore(placeName, pageTitle) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const a = new Set(norm(placeName).split(' ').filter((w) => w.length > 2));
  const b = new Set(norm(pageTitle).split(' ').filter((w) => w.length > 2));
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const w of a) if (b.has(w)) hits += 1;
  return hits / a.size;
}

// Wikipedia geosearch (find pages near a coordinate) + pageimages
// (fetch a thumbnail for each) in one combined query, generator-style —
// this is the standard "photo near this point" pattern for MediaWiki's
// API and needs no key, same free-tier posture as Nominatim.
async function fetchWikipediaPhotos(lat, lng) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'geosearch',
    ggscoord: `${lat}|${lng}`,
    ggsradius: String(PHOTO_SEARCH_RADIUS_M),
    ggslimit: String(PHOTO_MAX_CANDIDATES),
    prop: 'pageimages|coordinates',
    piprop: 'thumbnail',
    pithumbsize: String(PHOTO_THUMB_SIZE),
    origin: '*',
  });
  // MediaWiki's generator params are gs*, but when combined with a
  // generator= the per-module prefix becomes gg* — this trips people up
  // constantly, so spelled out here rather than left implicit.
  const res = await fetch('https://en.wikipedia.org/w/api.php?' + params.toString(), {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const pages = (data && data.query && data.query.pages) || {};
  return Object.values(pages)
    .filter((p) => p && p.thumbnail && p.thumbnail.source)
    .map((p) => ({
      title: p.title,
      url: p.thumbnail.source,
      lat: p.coordinates && p.coordinates[0] ? p.coordinates[0].lat : null,
      lng: p.coordinates && p.coordinates[0] ? p.coordinates[0].lon : null,
    }));
}

async function matchPhoto(placeName, lat, lng) {
  let candidates = [];
  try {
    candidates = await fetchWikipediaPhotos(lat, lng);
  } catch (e) {
    return { photo: null, photoTitle: null, photoSource: '', photoCandidates: [] };
  }
  if (!candidates.length) return { photo: null, photoTitle: null, photoSource: '', photoCandidates: [] };

  // Rank by how much the page title textually overlaps the place name —
  // geosearch alone tends to surface the nearest village/ward page
  // rather than the specific landmark, so proximity alone isn't enough.
  const ranked = candidates
    .map((c) => ({ ...c, score: titleOverlapScore(placeName, c.title) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  return {
    photo: best.url,
    photoTitle: best.title,
    photoSource: 'wikipedia',
    photoCandidates: ranked.slice(0, PHOTO_MAX_CANDIDATES).map((c) => ({ url: c.url, title: c.title })),
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

  // Photo lookup is best-effort — a Wikipedia hiccup shouldn't fail the
  // whole place resolution; the caller already has a generic fallback
  // image for a null photo.
  let photoInfo = { photo: null, photoTitle: null, photoSource: '', photoCandidates: [] };
  try {
    photoInfo = await matchPhoto(result.name, result.lat, result.lng);
  } catch (e) {
    // swallow — keep photoInfo at its empty default
  }

  await query(
    `INSERT INTO resolved_places (query_key, resolved, name, display_name, lat, lng, place_id, place_type, confidence,
       photo, photo_title, photo_source, photo_candidates)
     VALUES ($1, true, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (query_key) DO UPDATE SET
       name = EXCLUDED.name, display_name = EXCLUDED.display_name, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
       place_id = EXCLUDED.place_id, place_type = EXCLUDED.place_type, confidence = EXCLUDED.confidence,
       photo = EXCLUDED.photo, photo_title = EXCLUDED.photo_title, photo_source = EXCLUDED.photo_source,
       photo_candidates = EXCLUDED.photo_candidates`,
    [
      key, result.name, result.displayName, result.lat, result.lng, result.placeId, result.type, result.confidence,
      photoInfo.photo, photoInfo.photoTitle, photoInfo.photoSource, JSON.stringify(photoInfo.photoCandidates),
    ]
  );
  return { resolved: true, ...result, ...photoInfo };
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
    // Nominatim's or Wikipedia's data for it changes, or a bad cache
    // entry needs clearing) without needing direct DB access.
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
