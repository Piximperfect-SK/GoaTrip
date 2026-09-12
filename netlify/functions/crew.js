// Crew / Team members: shown on index.html's "Crew" section, fully
// managed from the admin dashboard. No names are hardcoded anywhere —
// index.html only ever renders whatever this endpoint returns.
// Mirrors the board_members pattern in cancellation.js.
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
  ensured = true;
}

function serializeRow(r) {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    note: r.note || '',
    sortOrder: r.sort_order,
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
      if (!memberName || !role) return badRequest('Name and role/position are required.');
      const sortOrder = await nextSortOrder(tripId);
      const { rows } = await query(
        'INSERT INTO crew_members (trip_id, name, role, note, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [tripId, memberName, role, note, sortOrder]
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
      const { rows } = await query(
        'UPDATE crew_members SET name=$3, role=$4, note=$5 WHERE id=$1 AND trip_id=$2 RETURNING *',
        [id, tripId, memberName, role, note]
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
