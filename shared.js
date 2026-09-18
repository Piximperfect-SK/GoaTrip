/* ============================================================
   shared.js — GoaTrip common utility functions
   Used by: index.html, itinerary.html, goa-wallet.html, boarding-pass.html
   Keep this file dependency-free (no DOM assumptions beyond the
   ids documented per-function) so any page can include it safely.
   ============================================================ */

/* ============================================================
   TRIP CONTEXT — resolves which trip is active for this page load
   and exposes it as window.TRIP. Every page must call
   `await initTripContext()` before rendering any trip-specific
   content or calling other backend endpoints.
   Trip selection order: ?trip= query param -> sessionStorage
   (last one the visitor picked) -> the backend's active/default trip.
   ============================================================ */
const FUNCTIONS_BASE = '/.netlify/functions';

function resolveTripIdFromUrl(){
  return new URLSearchParams(window.location.search).get('trip');
}

async function loadTripConfig(tripId){
  const url = tripId
    ? FUNCTIONS_BASE + '/trips?id=' + encodeURIComponent(tripId)
    : FUNCTIONS_BASE + '/trips?active=1';
  const res = await fetch(url);
  const data = await res.json();
  if(!data || !data.trip) throw new Error(data && data.error || 'Trip not found.');
  return data.trip;
}

/**
 * Resolves the active trip and stores it on window.TRIP. Call once,
 * before rendering trip-specific content. Returns the resolved trip.
 */
async function initTripContext(){
  const urlTripId = resolveTripIdFromUrl();
  const tripId = urlTripId || sessionStorage.getItem('goatrip:lastTrip') || null;
  const trip = await loadTripConfig(tripId);
  sessionStorage.setItem('goatrip:lastTrip', trip.id);
  window.TRIP = trip;
  return trip;
}

/**
 * Appends the currently selected trip id to an internal link/URL so
 * navigation between pages preserves it.
 */
function withTrip(url){
  const tripId = window.TRIP && window.TRIP.id;
  if(!tripId) return url;
  const [path, hash] = String(url).split('#');
  const sep = path.includes('?') ? '&' : '?';
  return path + sep + 'trip=' + encodeURIComponent(tripId) + (hash ? '#' + hash : '');
}

/**
 * Escape a string for safe insertion into innerHTML.
 * (Covers what index.html called escapeHtml and itinerary.html called escAttr.)
 */
function escapeHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Truncate a string to `max` chars, adding an ellipsis if cut.
 */
function clip(str, max){
  str = String(str == null ? '' : str);
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/**
 * Show a status banner inside a container with id="bannerZone".
 * kind: 'ok' | 'bad' | 'info'
 */
function showBanner(kind, html){
  const zone = document.getElementById('bannerZone');
  if(!zone) return;
  zone.innerHTML = html ? `<div class="banner ${kind}">${html}</div>` : '';
}

function clearBanner(){
  const zone = document.getElementById('bannerZone');
  if(zone) zone.innerHTML = '';
}

/**
 * Update the sync indicator dot + label.
 * Expects elements with id="syncDot" and id="syncLabel".
 * state: 'ok' | 'bad' | anything else = pending/syncing
 */
function setSyncStatus(state, meta){
  const dot = document.getElementById('syncDot');
  const label = document.getElementById('syncLabel');
  if(dot) dot.className = 'sync-dot ' + (state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : 'pending');
  if(label){
    label.textContent = state === 'ok' ? 'Synced' : state === 'bad' ? 'Offline — saved locally' : 'Syncing…';
    if(meta) label.title = meta;
  }
}

/**
 * Animate a numeric value inside an element from its current text to endValue.
 * prefix is prepended to the rendered number (e.g. '₹').
 */
function animateValue(el, endValue, prefix){
  if(!el) return;
  prefix = prefix || '';
  const start = parseFloat((el.textContent || '0').replace(/[^0-9.-]/g, '')) || 0;
  const end = Number(endValue) || 0;
  const duration = 400;
  const startTime = performance.now();
  function tick(now){
    const p = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    const val = start + (end - start) * eased;
    el.textContent = prefix + Math.round(val).toLocaleString('en-IN');
    if(p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/**
 * Two-letter initials from a display name, e.g. "Pixim Kadam" -> "PK".
 */
function initials(name){
  return String(name || '').split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

/**
 * Resolve once every <img> inside `container` has loaded (or errored),
 * or after timeoutMs, whichever comes first. Used to gate html2canvas
 * captures until logos/QR images are actually painted.
 */
function waitForImagesToLoad(container, timeoutMs){
  timeoutMs = timeoutMs || 8000;
  const imgs = Array.from(container.querySelectorAll('img'));
  if(imgs.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let remaining = imgs.length;
    let done = false;
    const finish = () => { if(!done){ done = true; resolve(); } };
    const timer = setTimeout(finish, timeoutMs);
    imgs.forEach(img => {
      if(img.complete){
        remaining--;
        if(remaining <= 0){ clearTimeout(timer); finish(); }
        return;
      }
      const onSettle = () => {
        remaining--;
        if(remaining <= 0){ clearTimeout(timer); finish(); }
      };
      img.addEventListener('load', onSettle, { once:true });
      img.addEventListener('error', onSettle, { once:true });
    });
  });
}

/**
 * Start Lenis smooth scrolling if the CDN script (lenis.min.js) has
 * loaded on this page. Lenis honors prefers-reduced-motion itself
 * (locks lerp to 1, jumps instant on programmatic scroll) so no
 * extra reduced-motion handling is needed here — it matches the
 * kill-switch behaviour the rest of the site already uses.
 * Returns the Lenis instance, or null if the script wasn't present
 * (e.g. a page that intentionally opts out, like boarding-pass.html).
 */
function initSmoothScroll(options){
  if(typeof Lenis === 'undefined') return null;
  const lenis = new Lenis(Object.assign({ autoRaf: true, autoToggle: true }, options || {}));
  return lenis;
}

/**
 * Great-circle ("as the crow flies") distance in km between two
 * {lat,lng} points, via the haversine formula.
 */
function haversineKm(a, b){
  const R = 6371; // Earth radius, km
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
}

/**
 * Initial compass bearing in degrees (0 = north, 90 = east) for the
 * great-circle path from point a to point b.
 */
function bearingDeg(a, b){
  const toRad = d => d * Math.PI / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
            Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * Google Maps "get directions" deep link — opens the native Google Maps
 * app automatically on iOS/Android, and maps.google.com in a desktop browser.
 */
function mapsDirectionsUrl(origin, destination){
  return `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&destination=${destination.lat},${destination.lng}&travelmode=driving`;
}

/**
 * Build the QR image URL via the api.qrserver.com image API.
 */
function qrApiUrl(text){
  return 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=0&data=' + encodeURIComponent(text);
}

/* ============================================================
   PLACE RESOLUTION — turns free-typed itinerary text ("Morning -
   Visit Aguada Fort after breakfast", "Baga", "Fort Aguada") into a
   canonical place: { query, name, lat, lng, displayName, confidence }.

   Used by itinerary.html (resolve + cache when a place is edited)
   and index.html (render the homepage carousel/map/directions from
   whatever the itinerary already resolved — nothing here is a fixed
   name->place lookup table; every result comes from a live geocoding
   call, so it works for any place typed in the future).

   Resolution itself is delegated to the /places serverless function,
   which fronts OpenStreetMap Nominatim with a Postgres cache — so the
   same place name is only ever geocoded once across every visitor,
   not once per browser session. This file keeps a thin sessionStorage
   layer on top purely to avoid a repeat network round-trip within the
   same page session (e.g. re-rendering the carousel).
   ============================================================ */
const PLACE_RESOLVE_CACHE_PREFIX = 'goatrip:place:';

/**
 * Strip itinerary scaffolding words around a place name, e.g.
 * "Morning - Visit Aguada Fort after breakfast" -> "Aguada Fort".
 * Deliberately conservative: only trims recognizable time-of-day /
 * verb / trailing-clause noise, never guesses or rewrites the core
 * name itself.
 */
function extractPlacePhrase(text){
  let s = String(text || '').trim();
  if(!s) return '';
  // Drop a leading "Morning - ", "Afternoon:", "Evening —" style prefix.
  s = s.replace(/^\s*(early\s+)?(morning|afternoon|evening|night|noon)\s*[-:–—]\s*/i, '');
  // Drop a leading action verb ("Visit", "Go to", "Explore", "Check out", "See").
  s = s.replace(/^\s*(visit|go\s+to|head\s+to|explore|check\s+out|stop\s+(at|by)|see|drive\s+to|walk\s+to)\s+/i, '');
  // Drop a trailing clause starting with a connector word.
  s = s.replace(/\s+(after|before|then|followed\s+by|and\s+then)\b.*$/i, '');
  // Collapse stray punctuation/whitespace left behind.
  s = s.replace(/^[\s\-:–—,.]+|[\s\-:–—,.]+$/g, '').replace(/\s{2,}/g, ' ');
  return s.trim();
}

function normalizePlaceKey(s){
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function readPlaceCache(key){
  try{
    const raw = sessionStorage.getItem(PLACE_RESOLVE_CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}
function writePlaceCache(key, value){
  try{ sessionStorage.setItem(PLACE_RESOLVE_CACHE_PREFIX + key, JSON.stringify(value)); }catch(e){ /* storage full/unavailable — non-fatal */ }
}

/**
 * Resolve free-typed itinerary text to a canonical place via the
 * /places backend (Postgres cache in front of Nominatim). Returns
 * null (never a guess) when nothing sufficiently confident is found,
 * so callers can show an "unresolved" state instead of a wrong
 * photo/pin. Caches per normalized input for the session on top of
 * the server-side cache, so a page that resolves the same place
 * several times (e.g. re-rendering the carousel) doesn't even repeat
 * the round-trip to our own backend.
 */
async function resolvePlace(rawText){
  const cleaned = extractPlacePhrase(rawText);
  if(!cleaned) return null;
  const key = normalizePlaceKey(cleaned);
  const cached = readPlaceCache(key);
  if(cached !== null) return cached; // includes cached "null" (a prior confirmed non-match)

  let result = null;
  try{
    const res = await fetch(FUNCTIONS_BASE + '/places?action=resolve&q=' + encodeURIComponent(cleaned));
    const data = await res.json();
    if(data && data.resolved){
      result = {
        query: cleaned, name: data.name, displayName: data.displayName,
        lat: data.lat, lng: data.lng, placeId: data.placeId,
        type: data.type, confidence: data.confidence,
        // Photo matching now happens server-side (in the /places function),
        // coordinate-aware and pre-ranked — this is already the best
        // available match (or null if none was confident enough), plus a
        // few alternates in case a caller wants to offer "try another photo".
        photo: data.photo || null, photoTitle: data.photoTitle || null,
        photoSource: data.photoSource || '', photoCandidates: data.photoCandidates || [],
      };
    }
  }catch(e){
    console.warn('Place resolution request failed:', e);
    return null; // network failure — don't cache, so it retries next time rather than sticking as "unresolved"
  }
  writePlaceCache(key, result);
  return result;
}

/* ============================================================
   FEATURE FLAGS (admin console)
   Any page can call applyFeatureFlags(tripId) once on load. It fetches
   the public flag list for that trip (no auth needed to read) and,
   for every element on the page carrying data-feature="someKey",
   hides it (or disables it, for inputs/buttons/forms) if that
   flag is turned off in the admin console. A flag that doesn't
   exist yet defaults to enabled, so untagged pages are unaffected.
   ============================================================ */
async function applyFeatureFlags(tripId){
  if(!tripId) return {};
  let flags = {};
  try{
    const res = await fetch(FUNCTIONS_BASE + '/admin?action=flags&tripId=' + encodeURIComponent(tripId));
    const data = await res.json();
    (data.flags || []).forEach(f => { flags[f.featureKey] = !!f.enabled; });
  }catch(e){
    console.warn('Could not load feature flags — leaving all features enabled.', e);
    return {};
  }
  document.querySelectorAll('[data-feature]').forEach(node => {
    const key = node.dataset.feature;
    if(flags[key] === false){
      if(['INPUT','BUTTON','SELECT','TEXTAREA','FORM'].includes(node.tagName)){
        node.setAttribute('disabled', 'disabled');
        node.title = 'This feature is currently restricted.';
      }else{
        node.style.display = 'none';
      }
      node.classList.add('feature-restricted');
    }
  });
  return flags;
}

/**
 * Render a QR code into `el` (an <img> or container) from plain text,
 * falling back gracefully if the request fails.
 */
function renderQrSafely(el, text){
  if(!el) return;
  const url = qrApiUrl(text);
  if(el.tagName === 'IMG'){
    el.src = url;
    el.onerror = () => { el.style.display = 'none'; };
  } else {
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'QR code';
    img.onerror = () => { img.style.display = 'none'; };
    el.appendChild(img);
  }
}
