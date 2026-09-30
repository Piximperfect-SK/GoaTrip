// Trip registry: list/get/create/update. Create/update require an admin session token.
const { query, withTransaction } = require('./lib/db');
const { ok, badRequest, unauthorized, serverError, parseBody } = require('./lib/http');
const { verifySessionToken } = require('./lib/auth');
const { sanitizeText } = require('./lib/validate');

// villa_lat/villa_lng: a fixed reference point (not a text address) that
// every gallery card's distance is measured from — see getOriginCoords()
// in index.html. ADD COLUMN IF NOT EXISTS so this rolls out safely onto
// an existing trips table without a separate migration step, mirroring
// the same one-time-ensure pattern places.js uses for its own table.
let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  await query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS villa_lat DOUBLE PRECISION');
  await query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS villa_lng DOUBLE PRECISION');

  // One-time backfill: goa-2026's villa reference point, supplied directly
  // instead of requiring a manual SQL console visit. Only fills it in if
  // it's not already set, so this is safe to leave in permanently — it
  // will never overwrite a value set later through the admin UI/API.
  await query(
    `UPDATE trips SET villa_lat = $2, villa_lng = $3
     WHERE id = $1 AND villa_lat IS NULL AND villa_lng IS NULL`,
    ['goa-2026', 15.586784797901393, 73.78030810131766]
  );

  schemaEnsured = true;
}

const TRIP_ROW_TO_JSON = (r) => ({
  id: r.id,
  name: r.name,
  shortDates: r.short_dates,
  startDate: r.start_date,
  endDate: r.end_date,
  origin: r.origin,
  destination: r.destination,
  waypoint: r.waypoint,
  villa: r.villa,
  villaLat: r.villa_lat != null ? Number(r.villa_lat) : null,
  villaLng: r.villa_lng != null ? Number(r.villa_lng) : null,
  participantCount: r.participant_count,
  routeLegs: r.route_legs,
  galleryPlaces: r.gallery_places,
  defaultItinerary: r.default_itinerary,
  categories: r.categories,
  walletParticipants: r.wallet_participants,
  registrationOpen: r.registration_open,
  isActive: r.is_active,
});

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const DEFAULT_CATEGORIES = ['Travel', 'Stay', 'Food', 'Activities', 'Shopping', 'Misc'];
const CREATE_DEFAULTS = {
  name: '', short_dates: '', start_date: null, end_date: null, origin: '', destination: '', waypoint: '', villa: '',
  villa_lat: null, villa_lng: null, participant_count: 0,
  route_legs: '[]', gallery_places: '[]', default_itinerary: '[]',
  categories: JSON.stringify(DEFAULT_CATEGORIES), wallet_participants: '[]',
};

// payload key -> [column, kind, maxLen]. Column names here are the ONLY
// ones that ever reach the SQL text in create/update.
const TRIP_FIELD_MAP = {
  name: ['name', 'text', 120],
  shortDates: ['short_dates', 'text', 60],
  origin: ['origin', 'text', 80],
  destination: ['destination', 'text', 80],
  waypoint: ['waypoint', 'text', 80],
  villa: ['villa', 'text', 80],
  startDate: ['start_date', 'date'],
  endDate: ['end_date', 'date'],
  villaLat: ['villa_lat', 'lat'],
  villaLng: ['villa_lng', 'lng'],
  participantCount: ['participant_count', 'count'],
  routeLegs: ['route_legs', 'json-array'],
  galleryPlaces: ['gallery_places', 'json-array'],
  defaultItinerary: ['default_itinerary', 'json-array'],
  categories: ['categories', 'json-array'],
  walletParticipants: ['wallet_participants', 'names'],
};

// Returns { fields } containing ONLY the keys present in the payload,
// or { error } for a present-but-invalid value.
function parseTripFields(p) {
  const fields = {};
  for (const key of Object.keys(TRIP_FIELD_MAP)) {
    if (!has(p, key)) continue;
    const [col, kind, maxLen] = TRIP_FIELD_MAP[key];
    const v = p[key];
    if (kind === 'text') {
      fields[col] = sanitizeText(v, maxLen);
    } else if (kind === 'date') {
      fields[col] = v || null; // explicit empty/null clears the date
    } else if (kind === 'lat' || kind === 'lng') {
      if (v === null || v === '') { fields[col] = null; continue; } // explicit clear
      const n = Number(v);
      const limit = kind === 'lat' ? 90 : 180;
      if (!Number.isFinite(n) || n < -limit || n > limit) return { error: `${key} must be a number between -${limit} and ${limit}.` };
      fields[col] = n;
    } else if (kind === 'count') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 1000) return { error: 'participantCount must be a whole number between 0 and 1000.' };
      fields[col] = n;
    } else if (kind === 'json-array') {
      if (!Array.isArray(v)) return { error: `${key} must be a list.` };
      fields[col] = JSON.stringify(v);
    } else if (kind === 'names') {
      if (!Array.isArray(v) || v.length > 100) return { error: `${key} must be a list of names.` };
      fields[col] = JSON.stringify(v.map((n) => sanitizeText(n, 80)).filter(Boolean));
    }
  }
  return { fields };
}

exports.handler = async (event) => {
  try {
    await ensureSchema();

    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      if (params.id) {
        const { rows } = await query('SELECT * FROM trips WHERE id = $1', [params.id]);
        if (!rows.length) return badRequest('Trip not found.');
        return ok({ trip: TRIP_ROW_TO_JSON(rows[0]) });
      }
      if (params.active === '1') {
        const { rows } = await query('SELECT * FROM trips WHERE is_active = true LIMIT 1');
        if (!rows.length) return badRequest('No active trip configured.');
        return ok({ trip: TRIP_ROW_TO_JSON(rows[0]) });
      }
      const { rows } = await query('SELECT * FROM trips ORDER BY created_at DESC');
      return ok({ trips: rows.map(TRIP_ROW_TO_JSON) });
    }

    if (event.httpMethod === 'POST') {
      const body = parseBody(event);
      if (!body) return badRequest('Invalid JSON body.');
      const name = verifySessionToken(body.token);
      if (!name) return unauthorized('Session expired or invalid — please log in again.');

      const p = body.payload || {};
      const id = sanitizeText(p.id, 60);
      if (!id || !/^[a-z0-9-]+$/.test(id)) return badRequest('Trip id must be lowercase letters, numbers and hyphens only.');

      if (body.action === 'createTrip') {
        const parsed = parseTripFields(p);
        if (parsed.error) return badRequest(parsed.error);
        // A new trip starts from defaults for anything not supplied.
        const fields = { ...CREATE_DEFAULTS, ...parsed.fields };
        if (!fields.name) return badRequest('Trip name is required.');

        const { rows: existing } = await query('SELECT id FROM trips WHERE id = $1', [id]);
        if (existing.length) return badRequest('A trip with this id already exists.');
        const cols = Object.keys(fields); // keys come from the fixed column map below, never from the request
        const placeholders = cols.map((_, i) => `$${i + 2}`);
        await query(
          `INSERT INTO trips (id, ${cols.join(', ')}) VALUES ($1, ${placeholders.join(', ')})`,
          [id, ...cols.map((c) => fields[c])]
        );
        const { rows } = await query('SELECT * FROM trips WHERE id = $1', [id]);
        return ok({ ok: true, trip: TRIP_ROW_TO_JSON(rows[0]) });
      }

      if (body.action === 'updateTrip') {
        // PARTIAL update: only keys actually present in the payload are
        // written. A missing key leaves the stored value alone (it used
        // to be coerced to []/null/'' and written, wiping wallet
        // participants, gallery places, villa coordinates, etc.). To
        // clear a field deliberately, send it explicitly (e.g. [] or null).
        const parsed = parseTripFields(p);
        if (parsed.error) return badRequest(parsed.error);
        const cols = Object.keys(parsed.fields);
        if (!cols.length) return badRequest('No fields to update.');
        if (has(parsed.fields, 'name') && !parsed.fields.name) return badRequest('Trip name cannot be empty.');

        const sets = cols.map((c, i) => `${c} = $${i + 2}`);
        const result = await query(
          `UPDATE trips SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
          [id, ...cols.map((c) => parsed.fields[c])]
        );
        if (!result.rows.length) return badRequest('Trip not found.');
        return ok({ ok: true, trip: TRIP_ROW_TO_JSON(result.rows[0]) });
      }

      if (body.action === 'setActive') {
        // One transaction, and the target is checked first: previously the
        // "deactivate all" ran unconditionally, so an unknown id (or a
        // failure between the two statements) left NO active trip.
        const activated = await withTransaction(async (client) => {
          const { rows } = await client.query('SELECT id FROM trips WHERE id = $1 FOR UPDATE', [id]);
          if (!rows.length) return false;
          await client.query('UPDATE trips SET is_active = (id = $1)', [id]);
          return true;
        });
        if (!activated) return badRequest('Trip not found.');
        return ok({ ok: true });
      }

      return badRequest('Unknown action.');
    }

    return badRequest('Unsupported method.');
  } catch (err) {
    return serverError(err);
  }
};
