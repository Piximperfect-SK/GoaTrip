// Crew photo storage: admin-uploaded crew member photos, stored in
// Netlify Blobs (not Postgres — crew.js only ever stores the resulting
// `photo_key` string). Mirrors crew.js's own auth pattern
// (verifySessionToken on every write) and content.js's request shape
// (action-based POST body).
//
// GET  ?key=<photoKey>            -> streams the image bytes (public — the
//                                     crew section on index.html is public,
//                                     so this intentionally needs no token)
// POST { action:'upload', token, tripId, imageDataUrl, oldKey? }
//                                  -> stores a new photo, returns { photoKey }
// POST { action:'delete', token, key }
//                                  -> removes a photo from the store
//
// Client-side (admin.html) is responsible for resizing/compressing the
// image before it ever reaches this function — this function just
// re-validates the result server-side so a modified client (or a direct
// POST to this endpoint) can't smuggle in something huge or the wrong type.
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { ok, badRequest, unauthorized, serverError, parseBody } = require('./lib/http');
const { sanitizeText } = require('./lib/validate');
const { verifySessionToken } = require('./lib/auth');

// Keep this in sync with the client-side resize target in admin.html —
// the client compresses well below this, this is just the hard ceiling
// so a bypassed client (or a raw POST) can't push an oversized blob.
const MAX_BYTES = 2 * 1024 * 1024; // 2MB, post-compression
const ALLOWED_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function store() {
  // Single shared store for all trips — keys are namespaced by tripId
  // below, same convention as the trip_id column on crew_members.
  return getStore('crew-photos');
}

function decodeDataUrl(dataUrl) {
  // Expects "data:image/webp;base64,AAAA..." — anything else is rejected
  // rather than guessed at.
  const match = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) return null;
  const mime = match[1].toLowerCase();
  if (!ALLOWED_MIME[mime]) return null;
  const buffer = Buffer.from(match[2], 'base64');
  return { mime, buffer };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      const key = params.key;
      if (!key) return badRequest('key is required.');
      const s = store();
      const meta = await s.getMetadata(key);
      const data = await s.get(key, { type: 'arrayBuffer' });
      if (!data) {
        return { statusCode: 404, headers: { 'Content-Type': 'text/plain' }, body: 'Not found' };
      }
      return {
        statusCode: 200,
        headers: {
          'Content-Type': (meta && meta.metadata && meta.metadata.mime) || 'image/webp',
          // Photo keys are content-addressed by a fresh random id on every
          // upload (never reused in place), so this is safe to cache hard.
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
        body: Buffer.from(data).toString('base64'),
        isBase64Encoded: true,
      };
    }

    if (event.httpMethod !== 'POST') return badRequest('Unsupported method.');
    const body = parseBody(event);
    if (!body) return badRequest('Invalid JSON body.');

    const name = verifySessionToken(body.token);
    if (!name) return unauthorized('Session expired or invalid — please log in again.');

    if (body.action === 'upload') {
      const tripId = sanitizeText(body.tripId || '', 80);
      if (!tripId) return badRequest('tripId is required.');
      const decoded = decodeDataUrl(body.imageDataUrl);
      if (!decoded) return badRequest('Please upload a JPEG, PNG or WebP image.');
      if (decoded.buffer.length > MAX_BYTES) {
        return badRequest('That image is still too large after compression — try a smaller photo.');
      }
      const ext = ALLOWED_MIME[decoded.mime];
      const key = `${tripId}/${crypto.randomUUID()}.${ext}`;
      await store().set(key, decoded.buffer, { metadata: { mime: decoded.mime, uploadedBy: name } });

      // Replacing an existing photo — clean up the old blob so it
      // doesn't linger orphaned in the store forever.
      const oldKey = sanitizeText(body.oldKey || '', 300);
      if (oldKey && oldKey !== key) {
        try { await store().delete(oldKey); } catch (_) { /* best-effort */ }
      }
      return ok({ ok: true, photoKey: key });
    }

    if (body.action === 'delete') {
      const key = sanitizeText(body.key || '', 300);
      if (!key) return badRequest('key is required.');
      await store().delete(key);
      return ok({ ok: true });
    }

    return badRequest('Unknown action.');
  } catch (err) {
    return serverError(err);
  }
};
