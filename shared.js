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
 * Build the QR image URL via the api.qrserver.com image API.
 */
function qrApiUrl(text){
  return 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=0&data=' + encodeURIComponent(text);
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
