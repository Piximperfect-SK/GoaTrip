// Registration: read config/participants, submit a new registration.
const { query } = require('./lib/db');
const { ok, badRequest, unauthorized, serverError, parseBody } = require('./lib/http');
const { sanitizeText, validatePayload } = require('./lib/validate');
const { isFeatureEnabled } = require('./lib/flags');
const { verifySessionToken } = require('./lib/auth');

async function readParticipantNames(tripId) {
  // DISTINCT ON (lower(trim(name))) — trimmed AND case-insensitive, so
  // "Apporv Pratik" and " Apporv Pratik " (accidental leading/trailing
  // whitespace from a phone keyboard, autocomplete, etc.) collapse into
  // one participant instead of showing up twice everywhere this list is
  // used (wallet sync, boarding-pass lookup, itinerary places, etc.).
  const { rows } = await query(
    'SELECT DISTINCT ON (lower(trim(name))) trim(name) AS name FROM registrations WHERE trip_id = $1 ORDER BY lower(trim(name)), ts ASC',
    [tripId]
  );
  return rows.map((r) => r.name);
}

// Catches the common "fake but format-valid" 10-digit patterns people
// type to get past the phone field without giving a real number —
// all-same-digit, the two full sequential runs, an alternating 2-digit
// block repeated, or the same 5 digits typed twice. Deliberately not
// exhaustive (it can't be — any real check would need OTP verification),
// just closes the obvious gaps a plain \d{10} regex lets through.
function isFakeLookingPhone(phone) {
  if (/^(\d)\1{9}$/.test(phone)) return true; // 9999999999
  if (phone === '0123456789' || phone === '9876543210') return true; // full run
  if (/^(\d{2})\1{4}$/.test(phone)) return true; // e.g. 1212121212
  if (/^(\d{5})\1$/.test(phone)) return true; // e.g. 1234512345
  return false;
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
      if (type === 'checkPhone') {
        // Live "already registered?" lookup used by the wizard's phone-field
        // blur handler. Only confirms/denies a well-formed 10-digit number —
        // never leaks anything else about who holds it.
        const phone = String(params.phone || '').trim();
        if (!/^\d{10}$/.test(phone)) return ok({ available: null });
        const { rows } = await query(
          'SELECT 1 FROM registrations WHERE trip_id = $1 AND phone = $2 LIMIT 1',
          [tripId, phone]
        );
        return ok({ available: rows.length === 0 });
      }
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

      // validatePayload above only checks type/length/required — it has no
      // idea what a "valid" name, phone or email actually looks like, which
      // is exactly why a single digit or a string of letters was passing
      // as a phone number before. Enforce the real formats here, server
      // side, since client-side validation (the wizard's Next-button
      // guard) is only a UX nicety — it can't be trusted as the actual
      // security boundary; anyone can POST directly to this endpoint.
      const cleanName = sanitizeText(payload.name, 120).trim();
      if (cleanName.length < 2 || !/[A-Za-z]/.test(cleanName)) {
        return badRequest('Please enter a valid name.');
      }
      const cleanPhone = sanitizeText(payload.phone, 30).trim();
      if (!/^\d{10}$/.test(cleanPhone)) {
        return badRequest('Phone number must be exactly 10 digits, no letters or symbols.');
      }
      if (isFakeLookingPhone(cleanPhone)) {
        return badRequest('That doesn\u2019t look like a real phone number — please enter your actual mobile number.');
      }
      const { rows: dupeRows } = await query(
        'SELECT 1 FROM registrations WHERE trip_id = $1 AND phone = $2 LIMIT 1',
        [tripId, cleanPhone]
      );
      if (dupeRows.length) {
        return badRequest('This phone number is already registered for this trip.');
      }
      const cleanEmail = sanitizeText(payload.email || '', 120).trim();
      if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
        return badRequest('Please enter a valid email address, or leave it blank.');
      }

      await query(
        `INSERT INTO registrations (trip_id, name, phone, email, travelling_from, food, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          tripId,
          cleanName,
          cleanPhone,
          cleanEmail,
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
