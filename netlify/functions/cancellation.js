// Trip cancellation requests: participant submit/status-check, admin review/approve/reject.
const { query } = require('./lib/db');
const { ok, badRequest, unauthorized, serverError, parseBody } = require('./lib/http');
const { sanitizeText, validatePayload } = require('./lib/validate');
const { verifySessionToken } = require('./lib/auth');

let ensured = false;
async function ensureSchema() {
  if (ensured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS cancellations (
      id SERIAL PRIMARY KEY,
      cancellation_id TEXT UNIQUE NOT NULL,
      trip_id TEXT NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      mobile TEXT NOT NULL,
      trip_name TEXT NOT NULL,
      destination TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      booking_ref TEXT NOT NULL,
      reason TEXT NOT NULL,
      remarks TEXT DEFAULT '',
      place TEXT NOT NULL DEFAULT 'Hinjewadi, Pune',
      status TEXT NOT NULL DEFAULT 'IN REVIEW',
      admin_remarks TEXT DEFAULT '',
      board_signatures JSONB DEFAULT '[]',
      processed_by TEXT,
      processed_at TIMESTAMPTZ,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS board_members (
      id SERIAL PRIMARY KEY,
      trip_id TEXT NOT NULL,
      name TEXT NOT NULL,
      designation TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  ensured = true;
}

async function nextCancellationId() {
  const { rows } = await query("SELECT COUNT(*)::int AS n FROM cancellations");
  const seq = (rows[0]?.n || 0) + 1;
  return `TTPL/CNL/${String(seq).padStart(4, '0')}`;
}

function serializeRow(r) {
  return {
    id: r.id,
    cancellationId: r.cancellation_id,
    tripId: r.trip_id,
    fullName: r.full_name,
    email: r.email,
    mobile: r.mobile,
    tripName: r.trip_name,
    destination: r.destination,
    startDate: r.start_date,
    endDate: r.end_date,
    bookingRef: r.booking_ref,
    reason: r.reason,
    remarks: r.remarks,
    place: r.place,
    status: r.status,
    adminRemarks: r.admin_remarks,
    boardSignatures: r.board_signatures || [],
    processedBy: r.processed_by,
    processedAt: r.processed_at,
    submittedAt: r.submitted_at,
  };
}

const SUBMIT_SCHEMA = {
  fullName: { type: 'string', maxLen: 120, required: true },
  email: { type: 'string', maxLen: 120, required: true },
  mobile: { type: 'string', maxLen: 30, required: true },
  tripName: { type: 'string', maxLen: 160, required: true },
  destination: { type: 'string', maxLen: 120, required: true },
  startDate: { type: 'string', maxLen: 20, required: true },
  endDate: { type: 'string', maxLen: 20, required: true },
  bookingRef: { type: 'string', maxLen: 80, required: true },
  reason: { type: 'string', maxLen: 500, required: true },
  remarks: { type: 'string', maxLen: 800 },
};

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return badRequest('Unsupported method.');
    await ensureSchema();
    const body = parseBody(event);
    if (!body) return badRequest('Invalid JSON body.');
    const action = body.action;

    if (action === 'submit') {
      const payload = body.payload || {};
      const validationError = validatePayload(SUBMIT_SCHEMA, payload);
      if (validationError) return badRequest(validationError);
      const tripId = sanitizeText(body.tripId || '', 80) || 'default';
      const cancellationId = await nextCancellationId();
      const { rows } = await query(
        `INSERT INTO cancellations
          (cancellation_id, trip_id, full_name, email, mobile, trip_name, destination, start_date, end_date, booking_ref, reason, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          cancellationId,
          tripId,
          sanitizeText(payload.fullName, 120),
          sanitizeText(payload.email, 120),
          sanitizeText(payload.mobile, 30),
          sanitizeText(payload.tripName, 160),
          sanitizeText(payload.destination, 120),
          sanitizeText(payload.startDate, 20),
          sanitizeText(payload.endDate, 20),
          sanitizeText(payload.bookingRef, 80),
          sanitizeText(payload.reason, 500),
          sanitizeText(payload.remarks || '', 800),
        ]
      );
      return ok({ ok: true, request: serializeRow(rows[0]) });
    }

    if (action === 'status') {
      const cancellationId = sanitizeText(body.cancellationId || '', 40);
      const fullName = sanitizeText(body.fullName || '', 120);
      if (!cancellationId || !fullName) return badRequest('Cancellation ID and full name are required.');
      const { rows } = await query(
        'SELECT * FROM cancellations WHERE cancellation_id = $1 AND lower(full_name) = lower($2)',
        [cancellationId, fullName]
      );
      if (!rows.length) return badRequest('No matching cancellation request found. Check the ID and name and try again.');
      return ok({ ok: true, request: serializeRow(rows[0]) });
    }

    // Everything below requires an authenticated admin session.
    const name = verifySessionToken(body.token);
    if (!name) return unauthorized('Session expired or invalid — please log in again.');

    if (action === 'list') {
      const tripId = body.tripId ? sanitizeText(body.tripId, 80) : null;
      const { rows } = tripId
        ? await query('SELECT * FROM cancellations WHERE trip_id = $1 ORDER BY submitted_at DESC', [tripId])
        : await query('SELECT * FROM cancellations ORDER BY submitted_at DESC');
      return ok({ ok: true, requests: rows.map(serializeRow) });
    }

    if (action === 'get') {
      const id = Number(body.id);
      if (!id) return badRequest('id is required.');
      const { rows } = await query('SELECT * FROM cancellations WHERE id = $1', [id]);
      if (!rows.length) return badRequest('Request not found.');
      return ok({ ok: true, request: serializeRow(rows[0]) });
    }

    if (action === 'listBoardMembers') {
      const tripId = sanitizeText(body.tripId || '', 80) || 'default';
      const { rows } = await query('SELECT * FROM board_members WHERE trip_id = $1 ORDER BY created_at ASC', [tripId]);
      return ok({ ok: true, members: rows.map((r) => ({ id: r.id, name: r.name, designation: r.designation })) });
    }

    if (action === 'addBoardMember') {
      const tripId = sanitizeText(body.tripId || '', 80) || 'default';
      const memberName = sanitizeText(body.name || '', 120);
      const designation = sanitizeText(body.designation || '', 120);
      if (!memberName || !designation) return badRequest('Name and designation are required.');
      const { rows } = await query(
        'INSERT INTO board_members (trip_id, name, designation) VALUES ($1,$2,$3) RETURNING *',
        [tripId, memberName, designation]
      );
      return ok({ ok: true, member: { id: rows[0].id, name: rows[0].name, designation: rows[0].designation } });
    }

    if (action === 'removeBoardMember') {
      const id = Number(body.id);
      if (!id) return badRequest('id is required.');
      await query('DELETE FROM board_members WHERE id = $1', [id]);
      return ok({ ok: true });
    }

    if (action === 'decide') {
      const id = Number(body.id);
      const decision = body.decision === 'approve' ? 'APPROVED' : body.decision === 'reject' ? 'REJECTED' : null;
      if (!id || !decision) return badRequest('id and a valid decision are required.');
      const adminRemarks = sanitizeText(body.adminRemarks || '', 800);
      const boardSignatures = Array.isArray(body.boardSignatures)
        ? body.boardSignatures.slice(0, 3).map((s) => ({
            name: sanitizeText(s.name || '', 120),
            designation: sanitizeText(s.designation || '', 120),
          }))
        : [];
      const { rows } = await query(
        `UPDATE cancellations
         SET status = $1, admin_remarks = $2, board_signatures = $3, processed_by = $4, processed_at = now()
         WHERE id = $5
         RETURNING *`,
        [decision, adminRemarks, JSON.stringify(boardSignatures), name, id]
      );
      if (!rows.length) return badRequest('Request not found.');
      return ok({ ok: true, request: serializeRow(rows[0]) });
    }

    return badRequest('Unknown action.');
  } catch (err) {
    return serverError(err);
  }
};
