/* ============================================================
   shared.js — GoaTrip common utility functions
   Used by: index.html, itinerary.html, goa-wallet.html, boarding-pass.html
   Keep this file dependency-free (no DOM assumptions beyond the
   ids documented per-function) so any page can include it safely.
   ============================================================ */

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
   FEATURE FLAGS (admin console)
   Any page can call applyFeatureFlags(ADMIN_ENDPOINT) once on load.
   It fetches the public flag list (no auth needed to read) and,
   for every element on the page carrying data-feature="someKey",
   hides it (or disables it, for inputs/buttons/forms) if that
   flag is turned off in the admin console. A flag that doesn't
   exist yet defaults to enabled, so untagged pages are unaffected.
   ============================================================ */
async function applyFeatureFlags(adminEndpoint){
  if(!adminEndpoint) return {};
  let flags = {};
  try{
    const res = await fetch(adminEndpoint + '?action=flags');
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
