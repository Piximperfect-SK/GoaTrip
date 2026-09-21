// Content manager: lets admins edit the hardcoded copy on index.html
// (hero text, countdown target, footer/social links, etc.) from the
// admin dashboard instead of editing HTML. Mirrors admin.js's own
// conventions (query/ok/badRequest/verifySessionToken/sanitizeText)
// so it drops into the same netlify/functions/ folder unchanged.
//
// Storage: one row per (trip_id, content_key). Content is intentionally
// NOT merged with defaults here — index.html keeps its own hardcoded
// defaults and only overwrites what this table actually has a value
// for, so a brand-new trip with an empty table still renders correctly.
const { query } = require('./lib/db');
const { ok, badRequest, unauthorized, serverError, parseBody } = require('./lib/http');
const { sanitizeText } = require('./lib/validate');
const { verifySessionToken } = require('./lib/auth');

// Keys this endpoint will accept. Keeping an explicit allow-list (rather
// than writing whatever key the client sends) means a typo'd key in the
// admin form fails loudly instead of silently creating a dead row.
const ALLOWED_KEYS = new Set([
  // hero.titleLine1 removed deliberately: that line is now derived live
  // from trip.participantCount in index.html (renderHeroFromTrip), not
  // from admin-entered text. A hand-typed count here went stale
  // ("Twelve tickets." long after the group grew to 13) with no UI to
  // ever catch it. Dropping the key from this allow-list means any old
  // stored row is simply ignored, and a client that still POSTs it gets
  // that one field silently skipped rather than reintroducing the bug.
  'hero.eyebrow', 'hero.titleLine2', 'hero.subtext',
  'hero.ctaPrimary', 'hero.ctaSecondary',
  'hero.countdownTarget', 'hero.tripEndTarget', 'hero.countdownCaption',
  'footer.tagline', 'footer.credit',
  'social.github', 'social.instagram', 'social.twitter', 'social.linkedin',
  'social.whatsapp', 'social.youtube', 'social.facebook', 'social.email',
]);
const MAX_VALUE_LEN = 2000; // generous — the longest field is hero.subtext

let schemaReady = false;
async function ensureContentTable() {
  if (schemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS site_content (
      trip_id TEXT NOT NULL,
      content_key TEXT NOT NULL,
      content_value TEXT,
      updated_by TEXT,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (trip_id, content_key)
    )
  `);
  schemaReady = true;
}

async function getContent(tripId) {
  await ensureContentTable();
  const { rows } = await query(
    'SELECT content_key, content_value FROM site_content WHERE trip_id = $1',
    [tripId]
  );
  const content = {};
  rows.forEach((r) => { content[r.content_key] = r.content_value; });
  return content;
}

async function updateContentBatch(tripId, fields, adminName) {
  await ensureContentTable();
  const entries = Object.entries(fields || {}).filter(([k]) => ALLOWED_KEYS.has(k));
  if (!entries.length) throw new Error('No recognised content keys in this save.');
  for (const [key, rawValue] of entries) {
    // Empty string clears the override (index.html falls back to its own
    // default) rather than storing a blank value forever.
    const value = sanitizeText(String(rawValue ?? ''), MAX_VALUE_LEN);
    if (value === '') {
      await query('DELETE FROM site_content WHERE trip_id = $1 AND content_key = $2', [tripId, key]);
    } else {
      await query(
        `INSERT INTO site_content (trip_id, content_key, content_value, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (trip_id, content_key) DO UPDATE SET content_value=$3, updated_by=$4, updated_at=now()`,
        [tripId, key, value, adminName]
      );
    }
  }
  return getContent(tripId);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      if (params.action === 'get') {
        const tripId = params.tripId;
        if (!tripId) return badRequest('tripId is required.');
        return ok({ content: await getContent(tripId) });
      }
      return badRequest('Unknown action.');
    }

    if (event.httpMethod === 'POST') {
      const body = parseBody(event);
      if (body.action === 'updateContentBatch') {
        const name = verifySessionToken(body.token);
        if (!name) return unauthorized('Session expired or invalid — please log in again.');
        const tripId = body.tripId;
        if (!tripId) return badRequest('tripId is required.');
        const content = await updateContentBatch(tripId, body.fields, name);
        return ok({ ok: true, content });
      }
      return badRequest('Unknown action.');
    }

    return badRequest('Unsupported method.');
  } catch (err) {
    return serverError(err);
  }
};
