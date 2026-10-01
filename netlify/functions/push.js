// netlify/functions/push.js — stores admin devices' push subscriptions.
//   GET  ?action=key                      -> { publicKey }
//   POST ?tripId=…  {action:'subscribe',   token, subscription}   (admin session only)
//   POST ?tripId=…  {action:'unsubscribe', token, endpoint}       (admin session only)
const { query } = require('./lib/db');
const { ok, badRequest, unauthorized, serverError, parseBody } = require('./lib/http');
const { verifySessionTokenFull } = require('./lib/auth');
const { ensurePushSchema } = require('./lib/notify');

const str = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : '');

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};

    if (event.httpMethod === 'GET') {
      if (params.action !== 'key') return badRequest('Unknown action.');
      return ok({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
    }
    if (event.httpMethod !== 'POST') return badRequest('Unsupported method.');

    const tripId = str(params.tripId, 80);
    if (!tripId) return badRequest('tripId is required.');
    const body = parseBody(event);
    if (!body) return badRequest('Invalid JSON body.');

    const session = body.token ? verifySessionTokenFull(body.token) : null;
    if (!session || session.role !== 'admin') return unauthorized('Admin sign-in required.');

    await ensurePushSchema();

    if (body.action === 'subscribe') {
      const sub = body.subscription || {};
      const endpoint = str(sub.endpoint, 1000);
      const p256dh = str(sub.keys && sub.keys.p256dh, 200);
      const auth = str(sub.keys && sub.keys.auth, 100);
      if (!endpoint.startsWith('https://') || !p256dh || !auth) return badRequest('Invalid subscription.');
      await query(
        `INSERT INTO push_subscriptions (endpoint, trip_id, name, p256dh, auth) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (endpoint) DO UPDATE SET trip_id=EXCLUDED.trip_id, name=EXCLUDED.name, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth`,
        [endpoint, tripId, str(session.name, 80), p256dh, auth]
      );
      return ok({ subscribed: true });
    }
    if (body.action === 'unsubscribe') {
      const endpoint = str(body.endpoint, 1000);
      if (!endpoint) return badRequest('endpoint is required.');
      await query('DELETE FROM push_subscriptions WHERE endpoint=$1 AND trip_id=$2', [endpoint, tripId]);
      return ok({ subscribed: false });
    }
    return badRequest('Unknown action.');
  } catch (err) {
    return serverError(err);
  }
};
