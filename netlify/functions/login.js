// User login: shared trip password + pick-your-name. Issues the same
// kind of signed session token admin.js already uses (via auth.js), just
// with role:'user' — see auth.js's verifySessionTokenFull() for how that
// role is read back by wallet.js/itinerary.js/etc.
//
// This is intentionally the lightest-weight option of the three discussed
// (per-person PIN / OTP-to-phone / shared password): one password known
// to all ~12 participants, then they pick their own already-registered
// name. It is NOT strong authentication — anyone with the password can
// mint a session as ANY registered name. That trade-off was accepted for
// a small-trusted-group trip rather than build OTP delivery. If that
// changes, only this file and the admin-set-password action below need
// replacing — wallet.js/itinerary.js only care that a valid session
// token exists, not how it was obtained.
const { query } = require('./lib/db');
const { ok, badRequest, unauthorized, serverError, parseBody } = require('./lib/http');
const { sanitizeText } = require('./lib/validate');
const { generateSalt, hashPin, verifyPin, createSessionToken, verifySessionToken } = require('./lib/auth');

let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  // Stored the same way admin PINs are (scryptSync hash + per-row salt,
  // see auth.js) rather than plaintext, even though this is a shared
  // group password and not a high-value secret — no reason to be the one
  // place on this site that breaks that pattern.
  await query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS trip_password_hash TEXT');
  await query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS trip_password_salt TEXT');
  schemaEnsured = true;
}

async function readParticipantNames(tripId) {
  // Mirrors registration.js's readParticipantNames() exactly (trimmed,
  // case-insensitive de-duped) — kept as its own copy here rather than a
  // shared import to avoid coupling two Netlify functions' cold-start
  // requires together for one small query; if it drifts, sync it back
  // with registration.js's version.
  const { rows } = await query(
    'SELECT DISTINCT ON (lower(trim(name))) trim(name) AS name FROM registrations WHERE trip_id = $1 ORDER BY lower(trim(name)), ts ASC',
    [tripId]
  );
  return rows.map((r) => r.name);
}

exports.handler = async (event) => {
  try {
    await ensureSchema();
    if (event.httpMethod !== 'POST') return badRequest('Unsupported method.');
    const body = parseBody(event);
    if (!body) return badRequest('Invalid JSON body.');
    const params = event.queryStringParameters || {};
    const tripId = params.tripId || body.tripId;
    if (!tripId) return badRequest('tripId is required.');

    // action: 'login' (any participant, needs the shared password) or
    // 'setPassword' (admin-only, sets/rotates the shared password — the
    // one write path in this file, so it needs an admin session, same
    // pattern wallet.js uses for its own admin-gated actions).
    if (body.action === 'setPassword') {
      const adminName = body.token ? verifySessionToken(body.token) : null;
      if (!adminName) return unauthorized('Setting the trip password requires an admin session — please log in as admin.');
      const newPassword = sanitizeText(body.password || '', 80);
      if (newPassword.length < 6) return badRequest('Password must be at least 6 characters.');
      const salt = generateSalt();
      const hash = hashPin(newPassword, salt);
      await query('UPDATE trips SET trip_password_hash=$2, trip_password_salt=$3 WHERE id=$1', [tripId, hash, salt]);
      return ok({ ok: true });
    }

    if (body.action === 'login') {
      const name = sanitizeText(body.name || '', 80);
      const password = sanitizeText(body.password || '', 80);
      if (!name || !password) return badRequest('Name and password are required.');

      const { rows } = await query('SELECT trip_password_hash, trip_password_salt FROM trips WHERE id=$1', [tripId]);
      if (!rows.length || !rows[0].trip_password_hash) {
        return badRequest('Login is not set up for this trip yet — ask your admin.');
      }
      if (!verifyPin(password, rows[0].trip_password_salt, rows[0].trip_password_hash)) {
        return unauthorized('Incorrect password.');
      }

      // The name has to match an actual registered participant, case/
      // whitespace-insensitively — this is what stops "the shared
      // password lets you mint a session as anyone" from also meaning
      // "as literally any string" showing up in the audit trail.
      const participants = await readParticipantNames(tripId);
      const match = participants.find((p) => p.trim().toLowerCase() === name.trim().toLowerCase());
      if (!match) {
        return badRequest('That name isn\u2019t on the registered participant list for this trip.');
      }

      const token = createSessionToken(match, 'user');
      return ok({ ok: true, token, name: match, role: 'user' });
    }

    if (body.action === 'participants') {
      // So the frontend's "pick your name" dropdown has something to
      // populate before the password is even entered.
      return ok({ participants: await readParticipantNames(tripId) });
    }

    return badRequest('Unknown action.');
  } catch (err) {
    return serverError(err);
  }
};
