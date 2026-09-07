// Admin: request access, login (PIN + lockout), change PIN, whoAmI, feature flags.
// Admins are GLOBAL (one login list manages every trip); feature flags are per-trip.
const crypto = require('crypto');
const { query } = require('./lib/db');
const { ok, badRequest, unauthorized, serverError, parseBody } = require('./lib/http');
const { sanitizeText } = require('./lib/validate');
const {
  generateSalt, hashPin, verifyPin, generateTempPin, createSessionToken, verifySessionToken,
} = require('./lib/auth');
const { sendEmail } = require('./lib/mailer');

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 10 * 60 * 1000;

async function findAdminByName(name) {
  const { rows } = await query('SELECT * FROM admins WHERE lower(name) = lower($1)', [name]);
  return rows[0] || null;
}

async function getPublicFlags(tripId) {
  const { rows } = await query(
    'SELECT feature_key, label, page, enabled FROM feature_flags WHERE trip_id = $1',
    [tripId]
  );
  return rows.map((f) => ({ featureKey: f.feature_key, label: f.label, page: f.page, enabled: f.enabled }));
}

async function requestAdmin(name, email) {
  name = sanitizeText(name, 80);
  email = sanitizeText(email, 120);
  if (!name || !email) throw new Error('Name and email are required.');
  const existing = await findAdminByName(name);
  if (existing && existing.status === 'Approved') throw new Error('This name is already an approved admin.');
  if (existing && existing.status === 'Pending') throw new Error('A request for this name is already pending approval.');

  const token = crypto.randomUUID();
  await query(
    `INSERT INTO admins (name, email, status, token) VALUES ($1,$2,'Pending',$3)
     ON CONFLICT (name) DO UPDATE SET email = $2, status = 'Pending', token = $3, requested_at = now()`,
    [name, email, token]
  );

  const siteBase = process.env.SITE_BASE_URL;
  const approverEmail = process.env.APPROVER_EMAIL;
  if (!siteBase || !approverEmail) throw new Error('Admin request routing is not configured.');
  const approveUrl = `${siteBase}/approve.html?action=approve&token=${encodeURIComponent(token)}`;
  const rejectUrl = `${siteBase}/approve.html?action=reject&token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: approverEmail,
    subject: `GoaTrip admin request: ${name}`,
    text: `Admin access requested.\n\nName: ${name}\nEmail: ${email}\n\nApprove -> ${approveUrl}\nReject  -> ${rejectUrl}\n\nIf you did not expect this, click Reject or ignore this email.`,
  });
}

async function approveAdmin(token) {
  const { rows } = await query("SELECT * FROM admins WHERE token = $1 AND status = 'Pending'", [token]);
  if (!rows.length) return { ok: false, message: 'This approval link is invalid, already used, or expired.' };
  const admin = rows[0];
  const tempPin = generateTempPin();
  const salt = generateSalt();
  const hash = hashPin(tempPin, salt);

  await query(
    `UPDATE admins SET status='Approved', token=NULL, approved_at=now(), pin_hash=$2, pin_salt=$3,
       must_change_pin=true, failed_attempts=0, locked_until=NULL WHERE id=$1`,
    [admin.id, hash, salt]
  );

  await sendEmail({
    to: admin.email,
    subject: 'Your GoaTrip admin access is approved',
    text: `You have been approved as a GoaTrip admin.\n\nYour temporary PIN: ${tempPin}\n\nLog in at admin.html with your name and this PIN. You'll be asked to set your own permanent 6-digit PIN immediately after.`,
  });
  return { ok: true, message: `Approved ${admin.name}. Temporary PIN emailed to ${admin.email}.` };
}

async function rejectAdmin(token) {
  const { rows } = await query("UPDATE admins SET status='Rejected', token=NULL WHERE token=$1 AND status='Pending' RETURNING name", [token]);
  if (!rows.length) return { ok: false, message: 'This link is invalid or already used.' };
  return { ok: true, message: `Request from ${rows[0].name} has been rejected.` };
}

async function loginAdmin(name, pin) {
  const admin = await findAdminByName(name);
  if (!admin || admin.status !== 'Approved' || !admin.pin_hash) {
    return { ok: false, message: 'No approved admin found with that name.' };
  }

  const lockedUntil = admin.locked_until ? new Date(admin.locked_until).getTime() : 0;
  if (lockedUntil && Date.now() < lockedUntil) {
    const minsLeft = Math.ceil((lockedUntil - Date.now()) / 60000);
    return { ok: false, message: `Too many attempts. Try again in ${minsLeft} minute${minsLeft === 1 ? '' : 's'}.` };
  }

  const validFormat = /^\d{6}$/.test(String(pin || '').trim());
  const valid = validFormat && verifyPin(String(pin).trim(), admin.pin_salt, admin.pin_hash);

  if (!valid) {
    const attempts = (admin.failed_attempts || 0) + 1;
    if (attempts >= LOGIN_MAX_ATTEMPTS) {
      await query('UPDATE admins SET failed_attempts=0, locked_until=$2 WHERE id=$1', [admin.id, new Date(Date.now() + LOGIN_LOCKOUT_MS)]);
      return { ok: false, message: 'Too many attempts. Try again in 10 minutes.' };
    }
    await query('UPDATE admins SET failed_attempts=$2 WHERE id=$1', [admin.id, attempts]);
    return { ok: false, message: 'Incorrect PIN.' };
  }

  await query('UPDATE admins SET failed_attempts=0, locked_until=NULL WHERE id=$1', [admin.id]);
  return { ok: true, token: createSessionToken(admin.name), mustChangePin: !!admin.must_change_pin };
}

async function changePin(token, newPin) {
  const name = verifySessionToken(token);
  if (!name) return { ok: false, message: 'Session expired or invalid — please log in again.' };
  if (!/^\d{6}$/.test(String(newPin || '').trim())) return { ok: false, message: 'PIN must be exactly 6 digits.' };
  const salt = generateSalt();
  const hash = hashPin(String(newPin).trim(), salt);
  await query(
    "UPDATE admins SET pin_hash=$2, pin_salt=$3, must_change_pin=false, failed_attempts=0, locked_until=NULL WHERE lower(name)=lower($1)",
    [name, hash, salt]
  );
  return { ok: true, message: 'PIN updated.' };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      if (params.action === 'flags') {
        if (!params.tripId) return badRequest('tripId is required.');
        return ok({ flags: await getPublicFlags(params.tripId) });
      }
      return badRequest('Unknown action.');
    }

    if (event.httpMethod === 'POST') {
      const body = parseBody(event);
      if (!body) return badRequest('Invalid JSON body.');

      if (body.action === 'requestAdmin') {
        await requestAdmin(body.name, body.email);
        return ok({ ok: true, message: 'Request sent for approval.' });
      }
      if (body.action === 'login') return ok(await loginAdmin(body.name, body.code));
      if (body.action === 'changePin') return ok(await changePin(body.token, body.newPin));
      if (body.action === 'whoAmI') {
        const n = verifySessionToken(body.token);
        if (!n) return ok({ ok: false, name: null });
        const admin = await findAdminByName(n);
        return ok({ ok: true, name: n, mustChangePin: !!(admin && admin.must_change_pin) });
      }
      if (body.action === 'updateFlag') {
        const name = verifySessionToken(body.token);
        if (!name) return unauthorized('Session expired or invalid — please log in again.');
        const admin = await findAdminByName(name);
        if (admin && admin.must_change_pin) return badRequest('Set a permanent PIN before making changes.');
        const tripId = body.tripId;
        if (!tripId) return badRequest('tripId is required.');
        const featureKey = sanitizeText(body.featureKey, 80);
        const enabled = !!body.enabled;
        await query(
          `INSERT INTO feature_flags (trip_id, feature_key, label, page, enabled, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,now())
           ON CONFLICT (trip_id, feature_key) DO UPDATE SET enabled=$5, updated_by=$6, updated_at=now()`,
          [tripId, featureKey, sanitizeText(body.label || featureKey, 120), sanitizeText(body.page || 'Custom', 60), enabled, name]
        );
        if (featureKey === 'index.registration') {
          await query('UPDATE trips SET registration_open = $2 WHERE id = $1', [tripId, enabled]);
        }
        return ok({ ok: true, flags: await getPublicFlags(tripId) });
      }

      return badRequest('Unknown action.');
    }

    return badRequest('Unsupported method.');
  } catch (err) {
    return serverError(err);
  }
};

module.exports.approveAdmin = approveAdmin;
module.exports.rejectAdmin = rejectAdmin;
