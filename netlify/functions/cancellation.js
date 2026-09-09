// Trip cancellation requests: participant submit/status-check, admin review/approve/reject.
const { query } = require('./lib/db');
const { ok, badRequest, unauthorized, serverError, parseBody } = require('./lib/http');
const { sanitizeText, validatePayload } = require('./lib/validate');
const { verifySessionToken } = require('./lib/auth');
const { sendEmail } = require('./lib/mailer');

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
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      signature_image TEXT DEFAULT ''
    )
  `);
  // Backfill the column for tables created before signatures existed —
  // ADD COLUMN IF NOT EXISTS is a no-op on a fresh table (the column is
  // already in the CREATE TABLE above) and a safe migration on an
  // existing one.
  await query(`ALTER TABLE cancellations ADD COLUMN IF NOT EXISTS signature_image TEXT DEFAULT ''`);
  await query(`ALTER TABLE cancellations ADD COLUMN IF NOT EXISTS pdf_snapshot TEXT DEFAULT ''`);
  await query(`ALTER TABLE cancellations ADD COLUMN IF NOT EXISTS pdf_archived_at TIMESTAMPTZ`);
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
    signatureImage: r.signature_image || '',
    // Only a flag here, never the actual blob — list/status responses
    // stay light. The real snapshot is only ever returned by
    // getArchivedPdf, gated behind an admin session.
    pdfArchived: !!(r.pdf_snapshot && r.pdf_snapshot.length > 0),
    pdfArchivedAt: r.pdf_archived_at || null,
  };
}

// Same reasoning as sanitizeSignatureImage: this is a large base64 blob,
// not short text, so it can't go through sanitizeText's truncation.
// Capped generously (~5MB of actual PDF bytes) since a 1-2 page letter
// with an embedded QR/signature comfortably fits well under that.
const MAX_PDF_LEN = 7000000;
function sanitizePdfDataUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  if (!/^data:application\/pdf;base64,[A-Za-z0-9+/=]+$/.test(value)) return '';
  if (value.length > MAX_PDF_LEN) return '';
  return value;
}

// The signature is a base64 PNG data URL, not a short text field, so it
// can't go through sanitizeText's normal maxLen truncation — truncating
// a base64 payload corrupts the image. Validate its shape and cap its
// size directly instead (roughly ~200KB of base64, comfortably enough
// for a drawn signature, while keeping the request/row size sane).
const MAX_SIGNATURE_LEN = 260000;
function sanitizeSignatureImage(value) {
  if (typeof value !== 'string' || !value) return '';
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)) return '';
  if (value.length > MAX_SIGNATURE_LEN) return '';
  return value;
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
      const signatureImage = sanitizeSignatureImage(payload.signatureImage);
      if (payload.signatureImage && !signatureImage) {
        return badRequest('Signature image is missing, invalid, or too large — please redraw it and try again.');
      }
      const { rows } = await query(
        `INSERT INTO cancellations
          (cancellation_id, trip_id, full_name, email, mobile, trip_name, destination, start_date, end_date, booking_ref, reason, remarks, signature_image)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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
          signatureImage,
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

    // Archives an immutable copy of the generated PDF the first time
    // anyone (participant or admin) views/downloads an APPROVED letter.
    // Authenticated the same lightweight way as 'status' (cancellation ID
    // + matching name) rather than requiring an admin session, since it's
    // triggered automatically from the public status-check page. Deliberately
    // write-once: the WHERE clause only lets this succeed if no snapshot
    // exists yet, so a later request (however it's issued) can never
    // overwrite the original evidentiary copy — that's the whole point of
    // keeping it as a defense against a false "that's not what I signed"
    // claim.
    if (action === 'archivePdf') {
      const cancellationId = sanitizeText(body.cancellationId || '', 40);
      const fullName = sanitizeText(body.fullName || '', 120);
      if (!cancellationId || !fullName) return badRequest('Cancellation ID and full name are required.');
      const pdfBase64 = sanitizePdfDataUrl(body.pdfBase64);
      if (!pdfBase64) return badRequest('PDF data is missing, invalid, or too large.');
      const { rows } = await query(
        `UPDATE cancellations
         SET pdf_snapshot = $1, pdf_archived_at = now()
         WHERE cancellation_id = $2 AND lower(full_name) = lower($3)
           AND status = 'APPROVED' AND (pdf_snapshot IS NULL OR pdf_snapshot = '')
         RETURNING *`,
        [pdfBase64, cancellationId, fullName]
      );
      const archived = rows.length > 0;
      // Only email on the actual first archive (not on a repeat call that
      // the write-once WHERE clause turned into a no-op) — otherwise every
      // subsequent status check would re-send the same letter.
      if (archived) {
        const req = rows[0];
        if (req.email) {
          try {
            await sendEmail({
              to: req.email,
              subject: `Your cancellation letter — ${req.cancellation_id}`,
              text: `Hi ${req.full_name},\n\nYour trip cancellation request (${req.cancellation_id}) has been approved. Your official cancellation letter is attached to this email as a PDF, and is also always available by checking your status at the trip site's Support / Cancellation page.\n\nThis is the same copy kept on file — please keep it for your records.\n\n— Tulip Travels Pvt. Ltd.`,
              attachments: [{ filename: `cancellation-letter-${req.cancellation_id.replace(/\//g, '-')}.pdf`, content: pdfBase64.split(',')[1] }],
            });
          } catch (err) {
            console.error('archivePdf: email send failed (archive still saved)', err);
          }
        }
      }
      return ok({ ok: true, archived });
    }

    // Everything below requires an authenticated admin session.
    const name = verifySessionToken(body.token);
    if (!name) return unauthorized('Session expired or invalid — please log in again.');

    // Lets an admin pull back the exact PDF that was archived at the time
    // it was first generated — the source of truth if a participant later
    // disputes what they signed/agreed to.
    if (action === 'getArchivedPdf') {
      const id = Number(body.id);
      if (!id) return badRequest('id is required.');
      const { rows } = await query('SELECT pdf_snapshot, pdf_archived_at FROM cancellations WHERE id = $1', [id]);
      if (!rows.length || !rows[0].pdf_snapshot) return badRequest('No archived PDF found for this request.');
      return ok({ ok: true, pdfBase64: rows[0].pdf_snapshot, archivedAt: rows[0].pdf_archived_at });
    }

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
      const req = rows[0];
      // Notify the participant right away — this is deliberately separate
      // from the PDF-attachment email in archivePdf above, since the letter
      // PDF itself is only ever generated client-side and isn't available
      // to the backend at decision time. Non-blocking: an email failure
      // here should never make the approve/reject action itself fail.
      if (req.email) {
        const siteBase = process.env.SITE_BASE_URL;
        const statusLink = siteBase ? `${siteBase}/cancellation.html` : null;
        const bodyText = decision === 'APPROVED'
          ? `Hi ${req.full_name},\n\nYour trip cancellation request (${req.cancellation_id}) has been approved by the Executive Board.\n\nYour official cancellation letter (with signatures) will be emailed to you as a PDF the next time you view your status${statusLink ? ` — head to ${statusLink} and check status with your Cancellation ID and name` : ''}.\n\n— Tulip Travels Pvt. Ltd.`
          : `Hi ${req.full_name},\n\nYour trip cancellation request (${req.cancellation_id}) was not approved.\n\nBoard remarks: ${req.admin_remarks || 'No remarks provided.'}\n\n${statusLink ? `You can check the full status at ${statusLink}.` : ''}\n\n— Tulip Travels Pvt. Ltd.`;
        try {
          await sendEmail({
            to: req.email,
            subject: decision === 'APPROVED'
              ? `Your cancellation has been approved — ${req.cancellation_id}`
              : `Your cancellation request update — ${req.cancellation_id}`,
            text: bodyText,
          });
        } catch (err) {
          console.error('decide: notification email failed (decision still applied)', err);
        }
      }
      return ok({ ok: true, request: serializeRow(rows[0]) });
    }

    return badRequest('Unknown action.');
  } catch (err) {
    return serverError(err);
  }
};
