// Admin auth helpers: PIN hashing (scrypt) + HMAC-signed session tokens.
// Replaces the Apps Script iterated-SHA256 + custom token scheme with
// Node's built-in crypto primitives (scrypt is the standard choice for
// password/PIN hashing; HMAC-signed JSON for stateless sessions).
const crypto = require('crypto');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h, matches original

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not configured.');
  return secret;
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 64).toString('hex');
}

function verifyPin(pin, salt, hash) {
  const candidate = hashPin(pin, salt);
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function generateTempPin() {
  return String(crypto.randomInt(100000, 1000000));
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signPayload(payloadB64) {
  return crypto.createHmac('sha256', getSessionSecret()).update(payloadB64).digest('base64url');
}

function createSessionToken(name, role) {
  // role defaults to 'admin' so every existing call site — admin.js's
  // login flow calls this with just a name — keeps minting admin
  // sessions exactly as before. login.js (user login) is the only
  // caller that will ever pass role='user'.
  const payload = JSON.stringify({ name, role: role || 'admin', exp: Date.now() + SESSION_TTL_MS });
  const payloadB64 = base64url(payload);
  return `${payloadB64}.${signPayload(payloadB64)}`;
}

// Unchanged contract: returns the name string for any validly-signed,
// unexpired token, admin or user alike, or null. Every existing caller
// (admin.js, wallet.js's old code, trips.js, registration.js, itinerary.js)
// only ever needed "is this session valid, and whose is it" — this keeps
// answering exactly that, so none of them need touching for this change.
function verifySessionToken(token) {
  const full = verifySessionTokenFull(token);
  return full ? full.name : null;
}

// New: for code that also needs to know WHICH role the session holds —
// e.g. wallet.js gating admin-only actions now that both admins and
// regular users hold valid session tokens, not just admins.
function verifySessionTokenFull(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [payloadB64, sig] = token.split('.');
  const expected = signPayload(payloadB64);
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || !payload.exp || Date.now() > payload.exp) return null;
  // Tokens minted before this change have no role field at all — treat
  // those as 'admin' too, since createSessionToken was admin-only before
  // today, so every pre-existing token in the wild really was an admin
  // session regardless of it never having said so explicitly.
  return { name: payload.name, role: payload.role || 'admin', exp: payload.exp };
}

module.exports = {
  generateSalt,
  hashPin,
  verifyPin,
  generateTempPin,
  createSessionToken,
  verifySessionToken,
  verifySessionTokenFull,
  SESSION_TTL_MS,
};
