// Itinerary: get/save the per-trip itinerary JSON blob (same shape as the
// original single-blob design in Apps Script's Itinerary sheet).
const { query } = require('./lib/db');
const { ok, badRequest, serverError, parseBody } = require('./lib/http');
const { isFeatureEnabled } = require('./lib/flags');

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const tripId = params.tripId;
    if (!tripId) return badRequest('tripId is required.');

    if (event.httpMethod === 'GET') {
      const { rows } = await query('SELECT itinerary_json FROM trips WHERE id = $1', [tripId]);
      if (!rows.length) return badRequest('Trip not found.');
      return ok({ days: rows[0].itinerary_json || [] });
    }

    if (event.httpMethod === 'POST') {
      const body = parseBody(event);
      if (!body || body.action !== 'saveItinerary') return badRequest('Unknown action.');
      if (!(await isFeatureEnabled(tripId, 'itinerary.editing'))) {
        return badRequest('Itinerary editing is currently restricted.');
      }
      const days = (body.payload && body.payload.days) || [];
      if (!Array.isArray(days) || days.length > 60) return badRequest('Invalid itinerary payload.');

      const { rows } = await query(
        `UPDATE trips SET itinerary_json = $2, itinerary_updated_at = now() WHERE id = $1 RETURNING itinerary_json`,
        [tripId, JSON.stringify(days)]
      );
      if (!rows.length) return badRequest('Trip not found.');
      return ok({ ok: true, days: rows[0].itinerary_json });
    }

    return badRequest('Unsupported method.');
  } catch (err) {
    return serverError(err);
  }
};
