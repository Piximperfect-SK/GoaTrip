// Registration: read config/participants, submit a new registration.
const { query } = require('./lib/db');
const { ok, badRequest, unauthorized, serverError, parseBody } = require('./lib/http');
const { sanitizeText, validatePayload } = require('./lib/validate');
const { isFeatureEnabled } = require('./lib/flags');
const { verifySessionToken } = require('./lib/auth');

async function readParticipantNames(tripId) {
  const { rows } = await query(
    'SELECT DISTINCT ON (lower(name)) name FROM registrations WHERE trip_id = $1 ORDER BY lower(name), ts ASC',
    [tripId]
  );
  return rows.map((r) => r.name);
}

const REGISTER_SCHEMA = {
  name: { type: 'string', maxLen: 120, required: true },
  phone: { type: 'string', maxLen: 30, required: true },
  email: { type: 'string', maxLen: 120 },
  travellingFrom: { type: 'string', maxLen: 80 },
  food: { type: 'string', maxLen: 40 },
  notes: { type: 'string', maxLen: 500 },
};

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const tripId = params.tripId;
    if (!tripId) return badRequest('tripId is required.');

    if (event.httpMethod === 'GET') {
      const { rows } = await query('SELECT registration_open FROM trips WHERE id = $1', [tripId]);
      if (!rows.length) return badRequest('Trip not found.');
      const type = params.type || 'all';
      const registrationOpen = rows[0].registration_open;
      if (type === 'config') return ok({ registrationOpen });
      if (type === 'participants') return ok({ participants: await readParticipantNames(tripId) });
      return ok({ registrationOpen, participants: await readParticipantNames(tripId) });
    }

    if (event.httpMethod === 'POST') {
      const body = parseBody(event);
      if (!body) return badRequest('Invalid JSON body.');

      // Admin-only management actions — require a valid session token.
      if (body.action === 'listRegistrations' || body.action === 'deleteRegistration') {
        const name = verifySessionToken(body.token);
        if (!name) return unauthorized('Session expired or invalid — please log in again.');

        if (body.action === 'listRegistrations') {
          const { rows } = await query(
            'SELECT id, ts, name, phone, email, travelling_from, food, notes FROM registrations WHERE trip_id = $1 ORDER BY ts DESC',
            [tripId]
          );
          return ok({
            ok: true,
            registrations: rows.map((r) => ({
              id: r.id, ts: r.ts, name: r.name, phone: r.phone, email: r.email,
              travellingFrom: r.travelling_from, food: r.food, notes: r.notes,
            })),
          });
        }

        if (body.action === 'deleteRegistration') {
          const id = Number(body.id);
          if (!id) return badRequest('id is required.');
          await query('DELETE FROM registrations WHERE trip_id = $1 AND id = $2', [tripId, id]);
          return ok({ ok: true });
        }
      }

      if (body.action !== 'register') return badRequest('Unknown action.');
      const { rows } = await query('SELECT registration_open FROM trips WHERE id = $1', [tripId]);
      if (!rows.length) return badRequest('Trip not found.');
      if (!rows[0].registration_open || !(await isFeatureEnabled(tripId, 'index.registration'))) {
        return badRequest('Registration is currently closed.');
      }
      const payload = body.payload || {};
      const validationError = validatePayload(REGISTER_SCHEMA, payload);
      if (validationError) return badRequest(validationError);

      await query(
        `INSERT INTO registrations (trip_id, name, phone, email, travelling_from, food, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          tripId,
          sanitizeText(payload.name, 120),
          sanitizeText(payload.phone, 30),
          sanitizeText(payload.email || '', 120),
          sanitizeText(payload.travellingFrom || '', 80),
          sanitizeText(payload.food || '', 40),
          sanitizeText(payload.notes || '', 500),
        ]
      );
      return ok({ ok: true, registrationOpen: true, participants: await readParticipantNames(tripId) });
    }

    return badRequest('Unsupported method.');
  } catch (err) {
    return serverError(err);
  }
};
