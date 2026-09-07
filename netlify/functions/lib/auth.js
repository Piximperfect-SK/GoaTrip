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

function createSessionToken(name) {
  const payload = JSON.stringify({ name, exp: Date.now() + SESSION_TTL_MS });
  const payloadB64 = base64url(payload);
  return `${payloadB64}.${signPayload(payloadB64)}`;
}

function verifySessionToken(token) {
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
  return payload.name;
}

module.exports = {
  generateSalt,
  hashPin,
  verifyPin,
  generateTempPin,
  createSessionToken,
  verifySessionToken,
};
