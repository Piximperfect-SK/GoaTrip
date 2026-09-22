// Crew / Team members: shown on index.html's "Crew" section, fully
// managed from the admin dashboard. No names are hardcoded anywhere —
// index.html only ever renders whatever this endpoint returns.
// Mirrors the board_members pattern in cancellation.js.
//
// Photos: NOT uploaded through this API. They're static files checked
// into the repo under pictures/crew/ (same convention as the existing
// pictures/seal.png asset) and deployed with everything else. This
// table only stores the filename an admin typed in — `photo_file` —
// and photoUrl is just that filename resolved under pictures/crew/.
// Someone has to actually put the image file in the repo first; this
// endpoint has no way to write files itself.
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
  // Added for the photo feature. Nullable — a legacy row can exist with
  // no filename yet; see the module comment above for how that's
  // handled downstream (admin panel flags it, public site skips it).
  await query('ALTER TABLE crew_members ADD COLUMN IF NOT EXISTS photo_file TEXT');
  // Crop rectangle, as fractions (0..1) of the photo's natural pixel
  // size — crop_w/crop_h are locked to the public card's own aspect
  // ratio by the admin UI, so these four numbers alone are enough to
  // reproduce the exact framing with a CSS background-size/position
  // pair; no server-side image processing involved. All four are set
  // together or not at all (a member can have a photo with no crop yet,
  // which just renders as a plain centered cover).
  await query('ALTER TABLE crew_members ADD COLUMN IF NOT EXISTS crop_x REAL');
  await query('ALTER TABLE crew_members ADD COLUMN IF NOT EXISTS crop_y REAL');
  await query('ALTER TABLE crew_members ADD COLUMN IF NOT EXISTS crop_w REAL');
  await query('ALTER TABLE crew_members ADD COLUMN IF NOT EXISTS crop_h REAL');
  ensured = true;
}

function clamp01(n){ return Math.min(Math.max(Number(n) || 0, 0), 1); }

// Validates a {x,y,w,h} crop payload from the client. Returns a
// normalized object or null if the input isn't usable — callers treat
// null as "no crop supplied" rather than erroring the whole request,
// since a crop is an enhancement, not a required field.
function normalizeCrop(raw){
  if (!raw || typeof raw !== 'object') return null;
  const x = clamp01(raw.x), y = clamp01(raw.y);
  const w = Math.min(Math.max(Number(raw.w) || 0, 0.02), 1);
  const h = Math.min(Math.max(Number(raw.h) || 0, 0.02), 1);
  if (x + w > 1.001 || y + h > 1.001) return null;
  return { x, y, w, h };
}
// Only a bare filename — no path segments, no traversal. Someone typing
// "../../etc/passwd" or an absolute URL into this field should get
// rejected, not silently used to build an <img src>.
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(jpg|jpeg|png|webp|gif|avif)$/i;

function photoUrl(photoFile) {
  return photoFile ? `pictures/crew/${encodeURIComponent(photoFile)}` : null;
}

function serializeRow(r) {
  const hasCrop = r.crop_x != null && r.crop_y != null && r.crop_w != null && r.crop_h != null;
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    note: r.note || '',
    sortOrder: r.sort_order,
    photoFile: r.photo_file || null,
    photoUrl: photoUrl(r.photo_file),
    crop: hasCrop ? { x: r.crop_x, y: r.crop_y, w: r.crop_w, h: r.crop_h } : null,
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
      const photoFile = sanitizeText(p.photoFile || '', 120).trim();
      const crop = normalizeCrop(p.crop);
      if (!memberName || !role) return badRequest('Name and role/position are required.');
      if (!photoFile) return badRequest('A photo filename is required to add a crew member.');
      if (!SAFE_FILENAME.test(photoFile)) {
        return badRequest('Photo filename must be a plain image filename (e.g. shubham.jpg) — no folders or URLs.');
      }
      const sortOrder = await nextSortOrder(tripId);
      const { rows } = await query(
        `INSERT INTO crew_members (trip_id, name, role, note, sort_order, photo_file, crop_x, crop_y, crop_w, crop_h)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [tripId, memberName, role, note, sortOrder, photoFile,
          crop ? crop.x : null, crop ? crop.y : null, crop ? crop.w : null, crop ? crop.h : null]
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
        'SELECT photo_file, crop_x, crop_y, crop_w, crop_h FROM crew_members WHERE id=$1 AND trip_id=$2', [id, tripId]
      );
      if (!existingRows.length) return badRequest('Crew member not found.');
      const existing = existingRows[0];

      // photoFile present in the payload means "use this filename
      // instead". Omitted means "keep whatever's there" — editing
      // name/role/note doesn't force re-entering the photo every time.
      let photoFile = existing.photo_file;
      if (Object.prototype.hasOwnProperty.call(p, 'photoFile')) {
        photoFile = sanitizeText(p.photoFile || '', 120).trim();
        if (photoFile && !SAFE_FILENAME.test(photoFile)) {
          return badRequest('Photo filename must be a plain image filename (e.g. shubham.jpg) — no folders or URLs.');
        }
      }
      // Same "omitted = keep existing" rule for the crop — the admin UI
      // only sends crop when the crop tool was actually used this save.
      let crop = (existing.crop_x != null) ? {
        x: existing.crop_x, y: existing.crop_y, w: existing.crop_w, h: existing.crop_h,
      } : null;
      if (Object.prototype.hasOwnProperty.call(p, 'crop')) {
        crop = normalizeCrop(p.crop);
      }

      const { rows } = await query(
        `UPDATE crew_members SET name=$3, role=$4, note=$5, photo_file=$6, crop_x=$7, crop_y=$8, crop_w=$9, crop_h=$10
         WHERE id=$1 AND trip_id=$2 RETURNING *`,
        [id, tripId, memberName, role, note, photoFile || null,
          crop ? crop.x : null, crop ? crop.y : null, crop ? crop.w : null, crop ? crop.h : null]
      );
      if (!rows.length) return badRequest('Crew member not found.');
      return ok({ ok: true, member: serializeRow(rows[0]), crew: await listCrew(tripId) });
    }

    if (action === 'remove') {
      const id = Number(body.id);
      if (!id) return badRequest('id is required.');
      await query('DELETE FROM crew_members WHERE id = $1 AND trip_id = $2', [id, tripId]);
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
