// Trip registry: list/get/create/update. Create/update require an admin session token.
const { query } = require('./lib/db');
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

      const villaLat = Number(p.villaLat);
      const villaLng = Number(p.villaLng);
      const villaLatValid = Number.isFinite(villaLat) && villaLat >= -90 && villaLat <= 90;
      const villaLngValid = Number.isFinite(villaLng) && villaLng >= -180 && villaLng <= 180;

      const fields = {
        name: sanitizeText(p.name, 120),
        short_dates: sanitizeText(p.shortDates || '', 60),
        start_date: p.startDate || null,
        end_date: p.endDate || null,
        origin: sanitizeText(p.origin || '', 80),
        destination: sanitizeText(p.destination || '', 80),
        waypoint: sanitizeText(p.waypoint || '', 80),
        villa: sanitizeText(p.villa || '', 80),
        villa_lat: villaLatValid ? villaLat : null,
        villa_lng: villaLngValid ? villaLng : null,
        participant_count: Number.isFinite(Number(p.participantCount)) ? Number(p.participantCount) : 0,
        route_legs: JSON.stringify(p.routeLegs || []),
        gallery_places: JSON.stringify(p.galleryPlaces || []),
        default_itinerary: JSON.stringify(p.defaultItinerary || []),
        categories: JSON.stringify(p.categories || ['Travel', 'Stay', 'Food', 'Activities', 'Shopping', 'Misc']),
        wallet_participants: JSON.stringify(p.walletParticipants || []),
      };

      if (body.action === 'createTrip') {
        const { rows: existing } = await query('SELECT id FROM trips WHERE id = $1', [id]);
        if (existing.length) return badRequest('A trip with this id already exists.');
        await query(
          `INSERT INTO trips (id, name, short_dates, start_date, end_date, origin, destination, waypoint, villa,
             villa_lat, villa_lng, participant_count, route_legs, gallery_places, default_itinerary, categories, wallet_participants)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [id, fields.name, fields.short_dates, fields.start_date, fields.end_date, fields.origin, fields.destination,
            fields.waypoint, fields.villa, fields.villa_lat, fields.villa_lng, fields.participant_count, fields.route_legs,
            fields.gallery_places, fields.default_itinerary, fields.categories, fields.wallet_participants]
        );
        const { rows } = await query('SELECT * FROM trips WHERE id = $1', [id]);
        return ok({ ok: true, trip: TRIP_ROW_TO_JSON(rows[0]) });
      }

      if (body.action === 'updateTrip') {
        const { rows: existing } = await query('SELECT id FROM trips WHERE id = $1', [id]);
        if (!existing.length) return badRequest('Trip not found.');
        await query(
          `UPDATE trips SET name=$2, short_dates=$3, start_date=$4, end_date=$5, origin=$6, destination=$7,
             waypoint=$8, villa=$9, villa_lat=$10, villa_lng=$11, participant_count=$12, route_legs=$13, gallery_places=$14,
             default_itinerary=$15, categories=$16, wallet_participants=$17 WHERE id=$1`,
          [id, fields.name, fields.short_dates, fields.start_date, fields.end_date, fields.origin, fields.destination,
            fields.waypoint, fields.villa, fields.villa_lat, fields.villa_lng, fields.participant_count, fields.route_legs,
            fields.gallery_places, fields.default_itinerary, fields.categories, fields.wallet_participants]
        );
        const { rows } = await query('SELECT * FROM trips WHERE id = $1', [id]);
        return ok({ ok: true, trip: TRIP_ROW_TO_JSON(rows[0]) });
      }

      if (body.action === 'setActive') {
        await query('UPDATE trips SET is_active = false');
        await query('UPDATE trips SET is_active = true WHERE id = $1', [id]);
        return ok({ ok: true });
      }

      return badRequest('Unknown action.');
    }

    return badRequest('Unsupported method.');
  } catch (err) {
    return serverError(err);
  }
};
