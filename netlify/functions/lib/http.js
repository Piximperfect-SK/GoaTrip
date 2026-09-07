// Shared HTTP response helpers for Netlify Functions.
function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
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
