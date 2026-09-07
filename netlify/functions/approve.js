// Approve/reject admin access requests via emailed links (called from approve.html).
const { badRequest, serverError, ok } = require('./lib/http');
const { approveAdmin, rejectAdmin } = require('./admin');

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') return badRequest('Unsupported method.');
    const params = event.queryStringParameters || {};
    const { action, token } = params;
    if (!token) return badRequest('Missing token.');
    if (action === 'approve') return ok(await approveAdmin(token));
    if (action === 'reject') return ok(await rejectAdmin(token));
    return badRequest('Unknown action.');
  } catch (err) {
    return serverError(err);
  }
};
