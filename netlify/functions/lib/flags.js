// Shared feature-flag lookup, used by registration/itinerary/admin functions
// to gate actions the same way the original Apps Script did per trip.
const { query } = require('./db');

async function isFeatureEnabled(tripId, key) {
  const { rows } = await query(
    'SELECT enabled FROM feature_flags WHERE trip_id = $1 AND feature_key = $2',
    [tripId, key]
  );
  if (!rows.length) return true; // default enabled if not found, fail-open (matches original)
  return rows[0].enabled;
}

module.exports = { isFeatureEnabled };
