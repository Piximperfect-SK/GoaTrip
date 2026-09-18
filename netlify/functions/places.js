// Place resolution + photo matching. Fronts OpenStreetMap Nominatim (free,
// no key) for geocoding and Wikipedia/Wikimedia Commons for photos, with a
// Postgres cache so the same place is only ever resolved once across ALL
// visitors, not once per browser session. Read-only from the client's
// point of view — no session token required, same as registration/
// itinerary GET endpoints.
//
// ARCHITECTURE NOTE (photo matching): this used to be split — this file
// only geocoded a name to lat/lng, and itinerary.html separately guessed
// a photo client-side by text-searching Wikipedia/Commons/Unsplash for
// the raw typed string. That meant the photo search had no idea WHERE
// the place actually was, so "Baga" could just as easily pull a photo
// for a same-named place on the other side of the world, or for a
// same-named-but-different attraction one town over. Everything now
// happens here, in one place, once we already know the resolved
// coordinates — so photo candidates are found NEAR those coordinates
// first (geosearch), scored against the typed name, and only fall back
// to a plain text search (with a sanity distance-check) if nothing
// nearby matches. The client (shared.js's resolvePlace) just gets back
// { lat, lng, photo, photoTitle, photoSource, photoCandidates } already
// matched and ranked — it doesn't do any matching of its own anymore.
const { query } = require('./lib/db');
const { ok, badRequest, serverError } = require('./lib/http');
const { sanitizeText } = require('./lib/validate');

const GOA_VIEWBOX = '73.4,15.85,74.35,14.85'; // lon1,lat1,lon2,lat2 — loose box around Goa, a ranking bias only
const CONFIDENCE_FLOOR = 0.18;

// ---- photo-match tuning ----
const GEOSEARCH_RADIUS_M = 10000; // Wikipedia/Commons geosearch API caps at 10km
const NEARBY_MATCH_FLOOR = 0.32; // min combined (word-overlap + proximity) score to trust a geosearch hit
const TEXTSEARCH_SANITY_KM = 60; // if a text-search hit HAS coordinates, reject it if this far from the resolved place
const MAX_PHOTO_CANDIDATES = 4;

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
  // Photo fields, added alongside the original geocode-only columns.
  await query('ALTER TABLE resolved_places ADD COLUMN IF NOT EXISTS photo_url TEXT');
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
    photo: r.photo_url || null,
    photoTitle: r.photo_title || null,
    photoSource: r.photo_source || '',
    photoCandidates: r.photo_candidates || [],
  };
}

// ============================================================
// Geocoding (place name -> canonical lat/lng), unchanged in approach
// from before — Nominatim, Goa-biased, importance-floor filtered.
// ============================================================
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
      'User-Agent': 'GoaTripApp/1.0 (trip-planning tool; place resolution cache)',
    },
  });
  if (!res.ok) return null;
  const hits = await res.json();
  if (!hits || !hits.length) return null;

  const best = hits[0];
  const importance = typeof best.importance === 'number' ? best.importance : 0;
  if (importance < CONFIDENCE_FLOOR && hits.length > 1) return null;

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

// ============================================================
// Scoring helpers shared by the Wikipedia/Commons matchers
// ============================================================
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'in', 'at', 'and', 'de', 'da']);

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
}

// Fraction of the SHORTER token set that also appears in the other —
// deliberately lenient about extra words on either side (e.g. matching
// "Baga" against "Baga Beach" or "Fort Aguada, Goa" against "Aguada").
function wordOverlapScore(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((w) => { if (B.has(w)) inter++; });
  return inter / Math.min(A.size, B.size);
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Distance decay over the geosearch radius — a hit right at the resolved
// coordinates scores 1, one at the edge of the search radius scores ~0.
function proximityScore(distanceKm) {
  const radiusKm = GEOSEARCH_RADIUS_M / 1000;
  return Math.max(0, 1 - distanceKm / radiusKm);
}

// Filenames/titles that are almost never a useful photo of the place
// itself — icons, flags, locator maps, coats of arms, generic logos —
// even when they technically match on keywords (a district's Commons
// category is full of these). Filtered out of every candidate list
// regardless of source.
const GENERIC_FILE_RE = /\b(icon|flag|logo|locator|location map|coa|coat of arms|seal|emblem|symbol|favicon|placeholder|qr code)\b/i;
const BITMAP_EXT_RE = /\.(jpe?g|png|webp)$/i;

function isUsablePhotoFile(titleOrUrl) {
  if (!titleOrUrl) return false;
  if (GENERIC_FILE_RE.test(titleOrUrl)) return false;
  return true;
}

function dedupeCandidates(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (!c || !c.url) continue;
    if (seen.has(c.url)) continue;
    if (!isUsablePhotoFile(c.title || c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
}

// ============================================================
// Wikipedia matching — geosearch first (coordinate-aware), then a
// text-search fallback with a sanity distance check.
// ============================================================
async function wikiApi(params) {
  const url = 'https://en.wikipedia.org/w/api.php?' + new URLSearchParams({ format: 'json', origin: '*', ...params }).toString();
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  return res.json();
}

// Finds the best-matching Wikipedia article within GEOSEARCH_RADIUS_M of
// (lat,lng), scored by name overlap + proximity. Returns null if nothing
// clears NEARBY_MATCH_FLOOR — a near-but-unrelated article (e.g. the
// district page) shouldn't win just because it's the only thing close by.
async function bestWikipediaTitleNear(name, lat, lng) {
  const data = await wikiApi({
    action: 'query', list: 'geosearch',
    gscoord: `${lat}|${lng}`, gsradius: String(GEOSEARCH_RADIUS_M), gslimit: '10',
  });
  const hits = data && data.query && data.query.geosearch;
  if (!hits || !hits.length) return null;

  let best = null;
  for (const h of hits) {
    const overlap = wordOverlapScore(name, h.title);
    const dist = haversineKm({ lat, lng }, { lat: h.lat, lng: h.lon });
    const score = 0.6 * overlap + 0.4 * proximityScore(dist);
    if (!best || score > best.score) best = { title: h.title, score, dist, overlap };
  }
  if (!best || best.score < NEARBY_MATCH_FLOOR) return null;
  return best.title;
}

async function resolveWikipediaTitleByText(name) {
  const data = await wikiApi({ action: 'query', list: 'search', srlimit: '3', srsearch: name });
  const hits = data && data.query && data.query.search;
  if (!hits || !hits.length) return null;
  // Among the top few text hits, prefer whichever has the best name
  // overlap rather than blindly taking Wikipedia's #1 result — guards
  // against a loosely-related page outranking the literal match.
  let best = null;
  for (const h of hits) {
    const overlap = wordOverlapScore(name, h.title);
    if (!best || overlap > best.overlap) best = { title: h.title, overlap };
  }
  return best ? best.title : null;
}

async function fetchWikipediaCoords(title) {
  const data = await wikiApi({ action: 'query', prop: 'coordinates', titles: title });
  const pages = data && data.query && data.query.pages;
  if (!pages) return null;
  const page = Object.values(pages)[0];
  const c = page && page.coordinates && page.coordinates[0];
  if (!c) return null;
  return { lat: c.lat, lng: c.lon };
}

async function fetchWikiSummary(title) {
  const res = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title), {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.type === 'disambiguation') return null;
  const photo = (data.originalimage && data.originalimage.source) || (data.thumbnail && data.thumbnail.source);
  if (!photo) return null;
  return { photo, title: data.title };
}

// Pulls every usable bitmap image actually embedded in the matched
// article (not just its lead image) — this is what lets "multiple
// images for the same place" be handled consistently: they all come
// from the one already-disambiguated article, so they're guaranteed to
// be of the right place, just different angles/crops of it.
async function fetchWikipediaArticleImages(title) {
  const data = await wikiApi({
    action: 'query', prop: 'images', titles: title, imlimit: '20',
  });
  const pages = data && data.query && data.query.pages;
  if (!pages) return [];
  const page = Object.values(pages)[0];
  const files = ((page && page.images) || [])
    .map((f) => f.title)
    .filter((t) => BITMAP_EXT_RE.test(t) && isUsablePhotoFile(t))
    .slice(0, 6);
  if (!files.length) return [];

  const infoData = await wikiApi({
    action: 'query', prop: 'imageinfo', titles: files.join('|'), iiprop: 'url', iiurlwidth: '1000', format: 'json',
  });
  const infoPages = infoData && infoData.query && infoData.query.pages;
  if (!infoPages) return [];
  return Object.values(infoPages)
    .map((p) => {
      const info = p.imageinfo && p.imageinfo[0];
      const url = info && (info.thumburl || info.url);
      if (!url) return null;
      const cleanTitle = (p.title || '').replace(/^File:/, '').replace(/\.[a-zA-Z0-9]+$/, '');
      return { url, title: cleanTitle };
    })
    .filter(Boolean);
}

async function matchWikipedia(name, lat, lng) {
  let title = Number.isFinite(lat) && Number.isFinite(lng) ? await bestWikipediaTitleNear(name, lat, lng) : null;

  if (!title) {
    title = await resolveWikipediaTitleByText(name);
    if (title && Number.isFinite(lat) && Number.isFinite(lng)) {
      const coords = await fetchWikipediaCoords(title);
      // Page has coordinates and they're way off from where we resolved
      // the place to be — almost certainly a same-named place elsewhere
      // (or a different landmark entirely). Discard rather than show a
      // confidently-wrong photo.
      if (coords && haversineKm(coords, { lat, lng }) > TEXTSEARCH_SANITY_KM) title = null;
    }
  }
  if (!title) return [];

  const [summary, images] = await Promise.all([fetchWikiSummary(title), fetchWikipediaArticleImages(title)]);
  const candidates = [];
  if (summary && summary.photo) candidates.push({ url: summary.photo, title: summary.title });
  images.forEach((img) => candidates.push(img));
  return candidates;
}

// ============================================================
// Wikimedia Commons matching — geosearch first, text search fallback.
// Independent of whether the place has an English Wikipedia article.
// ============================================================
async function commonsApi(params) {
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({ format: 'json', origin: '*', ...params }).toString();
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  return res.json();
}

async function commonsImageInfoFor(titles) {
  if (!titles.length) return {};
  const data = await commonsApi({ action: 'query', prop: 'imageinfo', titles: titles.join('|'), iiprop: 'url', iiurlwidth: '1000' });
  const pages = data && data.query && data.query.pages;
  if (!pages) return {};
  const out = {};
  Object.values(pages).forEach((p) => {
    const info = p.imageinfo && p.imageinfo[0];
    const url = info && (info.thumburl || info.url);
    if (url) out[p.title] = url;
  });
  return out;
}

async function matchCommonsNear(name, lat, lng) {
  const data = await commonsApi({
    action: 'query', list: 'geosearch',
    gscoord: `${lat}|${lng}`, gsradius: String(GEOSEARCH_RADIUS_M), gsnamespace: '6', gslimit: '15',
  });
  const hits = data && data.query && data.query.geosearch;
  if (!hits || !hits.length) return [];

  // Score every nearby file the same way as the Wikipedia geosearch
  // match, then take the top few rather than just the single best —
  // Commons often has several legitimately-good, differently-cropped
  // photos of the same landmark filed as separate pages.
  const scored = hits
    .filter((h) => BITMAP_EXT_RE.test(h.title) && isUsablePhotoFile(h.title))
    .map((h) => {
      const overlap = wordOverlapScore(name, h.title);
      const dist = haversineKm({ lat, lng }, { lat: h.lat, lng: h.lon });
      return { title: h.title, score: 0.5 * overlap + 0.5 * proximityScore(dist) };
    })
    .filter((h) => h.score >= NEARBY_MATCH_FLOOR * 0.75) // slightly more lenient than Wikipedia — Commons filenames are noisier
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PHOTO_CANDIDATES);
  if (!scored.length) return [];

  const urls = await commonsImageInfoFor(scored.map((s) => s.title));
  return scored
    .map((s) => ({ url: urls[s.title], title: s.title.replace(/^File:/, '').replace(/\.[a-zA-Z0-9]+$/, '') }))
    .filter((c) => c.url);
}

async function matchCommonsByText(name) {
  const data = await commonsApi({
    action: 'query', generator: 'search',
    gsrsearch: name + ' filetype:bitmap', gsrnamespace: '6', gsrlimit: '3',
    prop: 'imageinfo', iiprop: 'url', iiurlwidth: '1000',
  });
  const pages = data && data.query && data.query.pages;
  if (!pages) return [];
  return Object.values(pages)
    .filter((p) => isUsablePhotoFile(p.title))
    .map((p) => {
      const info = p.imageinfo && p.imageinfo[0];
      const url = info && (info.thumburl || info.url);
      if (!url) return null;
      return { url, title: (p.title || '').replace(/^File:/, '').replace(/\.[a-zA-Z0-9]+$/, '') };
    })
    .filter(Boolean);
}

// ============================================================
// Unsplash — last-resort fallback only (a generic-but-relevant photo
// beats no photo at all), and only if a key is configured server-side.
// Server-side (rather than the old client-side call) keeps the key out
// of the browser entirely.
// ============================================================
async function matchUnsplash(name) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return [];
  const res = await fetch('https://api.unsplash.com/search/photos?per_page=1&query=' + encodeURIComponent(name + ' Goa'), {
    headers: { Authorization: 'Client-ID ' + key },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const hit = data.results && data.results[0];
  if (!hit) return [];
  return [{ url: hit.urls.regular, title: hit.alt_description || name }];
}

// ============================================================
// Orchestration — tries each source in order of how trustworthy its
// match is (coordinate-verified first), stops once it has enough
// candidates, and always returns a *ranked, deduped, filtered* list
// rather than a single guess — so a bad first pick doesn't silently
// become the only option.
// ============================================================
async function matchPlacePhoto(name, lat, lng) {
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  let candidates = [];

  try {
    candidates = candidates.concat(await matchWikipedia(name, lat, lng));
  } catch (e) { console.warn('places: wikipedia match failed', e.message); }

  if (candidates.length < 2 && hasCoords) {
    try {
      candidates = candidates.concat(await matchCommonsNear(name, lat, lng));
    } catch (e) { console.warn('places: commons geosearch failed', e.message); }
  }

  if (!candidates.length) {
    try {
      candidates = candidates.concat(await matchCommonsByText(name));
    } catch (e) { console.warn('places: commons text search failed', e.message); }
  }

  if (!candidates.length) {
    try {
      candidates = candidates.concat(await matchUnsplash(name));
    } catch (e) { console.warn('places: unsplash fallback failed', e.message); }
  }

  const deduped = dedupeCandidates(candidates).slice(0, MAX_PHOTO_CANDIDATES);
  if (!deduped.length) {
    // No confident photo anywhere — explicit "no match" rather than a
    // guess. The client shows a clean placeholder (place name + pin
    // icon) instead of a wrong or generic stock photo.
    return { photo: null, photoTitle: null, photoSource: '', photoCandidates: [] };
  }
  const primary = deduped[0];
  const source = primary.url.includes('wikimedia.org/wikipedia/commons') || primary.url.includes('commons.wikimedia')
    ? 'commons'
    : primary.url.includes('images.unsplash.com') ? 'unsplash' : 'wikipedia';
  return { photo: primary.url, photoTitle: primary.title, photoSource: source, photoCandidates: deduped };
}

// ============================================================
// Top-level resolve (geocode + photo match), cached as one row.
// ============================================================
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

  const photoMatch = await matchPlacePhoto(result.name || rawQuery, result.lat, result.lng);

  await query(
    `INSERT INTO resolved_places (query_key, resolved, name, display_name, lat, lng, place_id, place_type, confidence,
       photo_url, photo_title, photo_source, photo_candidates)
     VALUES ($1, true, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (query_key) DO UPDATE SET
       name = EXCLUDED.name, display_name = EXCLUDED.display_name, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
       place_id = EXCLUDED.place_id, place_type = EXCLUDED.place_type, confidence = EXCLUDED.confidence,
       photo_url = EXCLUDED.photo_url, photo_title = EXCLUDED.photo_title, photo_source = EXCLUDED.photo_source,
       photo_candidates = EXCLUDED.photo_candidates`,
    [
      key, result.name, result.displayName, result.lat, result.lng, result.placeId, result.type, result.confidence,
      photoMatch.photo, photoMatch.photoTitle, photoMatch.photoSource, JSON.stringify(photoMatch.photoCandidates),
    ]
  );
  return { resolved: true, ...result, ...photoMatch };
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
    // Nominatim's data or the matched photo changes, or a bad cache entry
    // needs clearing) without needing direct DB access.
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
