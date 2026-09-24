// Itinerary: get/save the per-trip itinerary JSON blob (same shape as the
// original single-blob design in Apps Script's Itinerary sheet).
const { query } = require('./lib/db');
const { ok, badRequest, unauthorized, serverError, parseBody } = require('./lib/http');
const { isFeatureEnabled } = require('./lib/flags');
const { verifySessionTokenFull } = require('./lib/auth');

// Self-healing column, same ALTER TABLE ADD COLUMN IF NOT EXISTS pattern
// used elsewhere (wallet_locked in wallet.js, the approval columns in
// wallet.js, session_invalidated_at in admin.js) — declared here so this
// function never depends on another function having run first on a cold
// instance.
let itinerarySchemaEnsured = false;
async function ensureItinerarySchema() {
  if (itinerarySchemaEnsured) return;
  await query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS itinerary_updated_by TEXT');
  itinerarySchemaEnsured = true;
}

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const tripId = params.tripId;
    if (!tripId) return badRequest('tripId is required.');
    await ensureItinerarySchema();

    if (event.httpMethod === 'GET') {
      // Left open (no session required) — the itinerary is public trip
      // content in the same way index.html/itinerary.html are, unlike
      // wallet.js's financial data. Phase 7 only calls for gating writes;
      // saveItinerary below is the actual access-control gap being closed.
      const { rows } = await query('SELECT itinerary_json FROM trips WHERE id = $1', [tripId]);
      if (!rows.length) return badRequest('Trip not found.');
      return ok({ days: rows[0].itinerary_json || [] });
    }

    if (event.httpMethod === 'POST') {
      const body = parseBody(event);
      if (!body || body.action !== 'saveItinerary') return badRequest('Unknown action.');

      // Previously this only checked the feature flag — any POST with
      // editing enabled could save, with no identity check at all. Now a
      // valid session is required too, and whoever holds it (admin or
      // regular participant) is recorded as the editor, the same
      // actor-from-session pattern wallet.js uses rather than trusting
      // anything the client claims about who's editing.
      const session = body.token ? verifySessionTokenFull(body.token) : null;
      if (!session) {
        return unauthorized('Please log in to edit the itinerary.');
      }
      if (!(await isFeatureEnabled(tripId, 'itinerary.editing'))) {
        return badRequest('Itinerary editing is currently restricted.');
      }
      const days = (body.payload && body.payload.days) || [];
      if (!Array.isArray(days) || days.length > 60) return badRequest('Invalid itinerary payload.');

      const { rows } = await query(
        `UPDATE trips SET itinerary_json = $2, itinerary_updated_at = now(), itinerary_updated_by = $3
         WHERE id = $1 RETURNING itinerary_json`,
        [tripId, JSON.stringify(days), session.name]
      );
      if (!rows.length) return badRequest('Trip not found.');
      return ok({ ok: true, days: rows[0].itinerary_json });
    }

    return badRequest('Unsupported method.');
  } catch (err) {
    return serverError(err);
  }
};
