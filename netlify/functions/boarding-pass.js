// Boarding pass lookup: read-only, filters tickets by trip + passenger name.
const { query } = require('./lib/db');
const { ok, badRequest, serverError } = require('./lib/http');

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') return badRequest('Unsupported method.');
    const params = event.queryStringParameters || {};
    const tripId = params.tripId;
    if (!tripId) return badRequest('tripId is required.');

    let rows;
    if (params.name) {
      ({ rows } = await query(
        'SELECT * FROM tickets WHERE trip_id = $1 AND lower(name) = lower($2) ORDER BY leg',
        [tripId, params.name.trim()]
      ));
    } else {
      ({ rows } = await query('SELECT * FROM tickets WHERE trip_id = $1 ORDER BY name, leg', [tripId]));
    }

    const tickets = rows.map((r) => ({
      id: r.id,
      name: r.name,
      leg: r.leg,
      fromcode: r.from_code,
      fromname: r.from_station,
      tocode: r.to_code,
      toname: r.to_station,
      date: r.journey_date,
      time: r.departure,
      trainno: r.train_no,
      trainname: r.train_name,
      cls: r.class,
      pnr: r.pnr,
      seat: r.coach_seat,
      fare: r.fare,
      createdat: r.created_at,
    }));

    return ok({ tickets });
  } catch (err) {
    return serverError(err);
  }
};
