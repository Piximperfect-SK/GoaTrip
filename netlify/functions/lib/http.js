// Shared HTTP response helpers for Netlify Functions.
function json(statusCode, body) {
  return {
    statusCode,
    // no-store on every function response, not just /wallet — these are
    // all dynamic/session-scoped (wallet, admin, login, registration...),
    // so nothing here should ever be cached by a browser or CDN/proxy in
    // front of Netlify. Belt-and-suspenders alongside the netlify.toml
    // header rule for /.netlify/functions/* and the client's
    // fetch(...,{cache:'no-store'}) on the wallet GET — this way it's
    // guaranteed at the source regardless of whether those are deployed.
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function ok(body) {
  return json(200, body);
}

function badRequest(message) {
  return json(400, { error: message });
}

function unauthorized(message) {
  return json(401, { error: message || 'Unauthorized.' });
}

function serverError(err) {
  // Never leak stack traces / internals to the client.
  console.error(err);
  return json(500, { error: 'Something went wrong. Please try again.' });
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch (e) {
    return null;
  }
}

module.exports = { json, ok, badRequest, unauthorized, serverError, parseBody };
