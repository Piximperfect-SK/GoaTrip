// Crew / Team members: shown on index.html's "Crew" section, fully
// managed from the admin dashboard. No names are hardcoded anywhere —
// index.html only ever renders whatever this endpoint returns.
// Mirrors the board_members pattern in cancellation.js.
//
// Photos: stored out-of-band in Netlify Blobs (see crew-photo.js). This
// file only ever stores/returns the resulting `photo_key` string, never
// image bytes — matching content.js's own "don't put big blobs in
// Postgres" convention. A member with no photo_key is a legacy row
// (added before photos existed) or one mid-upload; it's still returned
// to the admin panel (so it can show a "Photo Required" badge) but
// photoUrl comes back null, and index.html's public renderer skips any
// member with no photoUrl rather than falling back to an initials
// avatar — see the implementation note in admin.html's crew editor.
const { getStore } = require('@netlify/blobs');
const { query } = require('./lib/db');
const { ok, badRequest, unauthorized, serverError, parseBody } = require('./lib/http');
const { sanitizeText } = require('./lib/validate');
const { verifySessionToken } = require('./lib/auth');

let ensured = false;
async function ensureSchema() {
  if (ensured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS crew_members (
      id SERIAL PRIMARY KEY,
      trip_id TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      note TEXT DEFAULT '',
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Added for the photo feature. Nullable on purpose — existing rows
  // predate photos and stay nullable until an admin uploads one; see
  // the module comment above for how a null key is handled downstream.
  await query('ALTER TABLE crew_members ADD COLUMN IF NOT EXISTS photo_key TEXT');
  ensured = true;
}

function photoUrl(photoKey) {
  return photoKey ? `/.netlify/functions/crew-photo?key=${encodeURIComponent(photoKey)}` : null;
}

function serializeRow(r) {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    note: r.note || '',
    sortOrder: r.sort_order,
    photoKey: r.photo_key || null,
    photoUrl: photoUrl(r.photo_key),
  };
}

async function listCrew(tripId) {
  const { rows } = await query(
    'SELECT * FROM crew_members WHERE trip_id = $1 ORDER BY sort_order ASC, id ASC',
    [tripId]
  );
  return rows.map(serializeRow);
}

async function nextSortOrder(tripId) {
  const { rows } = await query(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM crew_members WHERE trip_id = $1',
    [tripId]
  );
  return rows[0].next;
}

// Best-effort blob cleanup — a failed delete here should never block the
// Postgres write that already succeeded (an orphaned blob costs storage,
// a stuck row costs the admin their edit).
async function deletePhotoBlob(photoKey) {
  if (!photoKey) return;
  try { await getStore('crew-photos').delete(photoKey); } catch (_) { /* best-effort */ }
}

exports.handler = async (event) => {
  try {
    await ensureSchema();

    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      const tripId = params.tripId;
      if (!tripId) return badRequest('tripId is required.');
      return ok({ crew: await listCrew(tripId) });
    }

    if (event.httpMethod !== 'POST') return badRequest('Unsupported method.');

    const body = parseBody(event);
    if (!body) return badRequest('Invalid JSON body.');
    const { action } = body;

    // Every write action requires a valid admin session.
    const name = verifySessionToken(body.token);
    if (!name) return unauthorized('Session expired or invalid — please log in again.');

    const tripId = sanitizeText(body.tripId || '', 80);
    if (!tripId) return badRequest('tripId is required.');

    if (action === 'add') {
      const p = body.payload || {};
      const memberName = sanitizeText(p.name || '', 120);
      const role = sanitizeText(p.role || '', 120);
      const note = sanitizeText(p.note || '', 300);
      const photoKey = sanitizeText(p.photoKey || '', 300);
      if (!memberName || !role) return badRequest('Name and role/position are required.');
      // Photos are mandatory for new members — no initials-avatar
      // fallback, per the crew redesign spec.
      if (!photoKey) return badRequest('A photo is required to add a crew member.');
      const sortOrder = await nextSortOrder(tripId);
      const { rows } = await query(
        'INSERT INTO crew_members (trip_id, name, role, note, sort_order, photo_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [tripId, memberName, role, note, sortOrder, photoKey]
      );
      return ok({ ok: true, member: serializeRow(rows[0]), crew: await listCrew(tripId) });
    }

    if (action === 'update') {
      const p = body.payload || {};
      const id = Number(body.id);
      if (!id) return badRequest('id is required.');
      const memberName = sanitizeText(p.name || '', 120);
      const role = sanitizeText(p.role || '', 120);
      const note = sanitizeText(p.note || '', 300);
      if (!memberName || !role) return badRequest('Name and role/position are required.');

      const { rows: existingRows } = await query(
        'SELECT photo_key FROM crew_members WHERE id=$1 AND trip_id=$2', [id, tripId]
      );
      if (!existingRows.length) return badRequest('Crew member not found.');
      const existingPhotoKey = existingRows[0].photo_key;

      // photoKey present in the payload means "replace with this new
      // upload" (admin.html always sends the freshly-uploaded key when
      // the admin picks a new file). Omitted means "keep whatever's
      // there" — a legacy member without a photo yet can still have
      // their name/role/note edited without being forced to add a photo
      // in the same save; the public site just keeps hiding them until
      // one is added (see the module comment above).
      const photoKey = Object.prototype.hasOwnProperty.call(p, 'photoKey')
        ? sanitizeText(p.photoKey || '', 300)
        : existingPhotoKey;

      const { rows } = await query(
        'UPDATE crew_members SET name=$3, role=$4, note=$5, photo_key=$6 WHERE id=$1 AND trip_id=$2 RETURNING *',
        [id, tripId, memberName, role, note, photoKey || null]
      );
      if (!rows.length) return badRequest('Crew member not found.');

      if (photoKey && existingPhotoKey && photoKey !== existingPhotoKey) {
        await deletePhotoBlob(existingPhotoKey);
      }
      return ok({ ok: true, member: serializeRow(rows[0]), crew: await listCrew(tripId) });
    }

    if (action === 'remove') {
      const id = Number(body.id);
      if (!id) return badRequest('id is required.');
      const { rows } = await query(
        'DELETE FROM crew_members WHERE id = $1 AND trip_id = $2 RETURNING photo_key', [id, tripId]
      );
      if (rows.length) await deletePhotoBlob(rows[0].photo_key);
      return ok({ ok: true, crew: await listCrew(tripId) });
    }

    // Reorders the whole list in one call — body.order is an array of
    // ids in the desired final order. Only ids belonging to this trip
    // are touched, so a stray/foreign id can't move someone else's row.
    if (action === 'reorder') {
      const order = Array.isArray(body.order) ? body.order.map(Number).filter(Boolean) : [];
      if (!order.length) return badRequest('order (array of ids) is required.');
      for (let i = 0; i < order.length; i++) {
        await query('UPDATE crew_members SET sort_order = $1 WHERE id = $2 AND trip_id = $3', [i, order[i], tripId]);
      }
      return ok({ ok: true, crew: await listCrew(tripId) });
    }

    return badRequest('Unknown action.');
  } catch (err) {
    return serverError(err);
  }
};
