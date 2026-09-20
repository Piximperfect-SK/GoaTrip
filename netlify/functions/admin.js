// Admin: request access, login (PIN + lockout), change PIN, whoAmI, feature flags.
// Admins are GLOBAL (one login list manages every trip); feature flags are per-trip.
//
// COLD START: with zero rows in `admins`, requestAdmin() has no existing
// approved admin to approve the request (approve.html/approve.js works off
// the admins table itself, not a separate superuser), and bootstrapAdminPin()
// below only ISSUES A PIN for a row that's already status='Approved' — it
// can't create that row from nothing. So the very first admin has to be
// seeded once, out of band: insert one `admins` row directly (e.g. via the
// Neon console) with status='Approved' and no pin_hash, then call
// bootstrapAdminPin with ADMIN_BOOTSTRAP_SECRET (a Netlify env var, never
// sent to the browser) to issue it a real, working PIN. Every admin after
// that can go through the normal request/approve flow.
const crypto = require('crypto');
const { query } = require('./lib/db');
const { ok, badRequest, unauthorized, serverError, parseBody } = require('./lib/http');
const { sanitizeText } = require('./lib/validate');
const {
  generateSalt, hashPin, verifyPin, generateTempPin, createSessionToken, verifySessionToken, SESSION_TTL_MS,
} = require('./lib/auth');
const { sendEmail } = require('./lib/mailer');

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 10 * 60 * 1000;
const TEMP_PIN_TTL_MS = 24 * 60 * 60 * 1000; // 24h — an unused temp PIN stops working after this

// Session tokens are stateless (HMAC-signed, not stored server-side), so
// by themselves they stay valid for their full 12h TTL even after the
// user clicks "log out" — logging out only cleared the browser's copy.
// session_invalidated_at gives logout real teeth: any token issued before
// that timestamp is rejected, even if it's still within its normal TTL.
let adminSchemaEnsured = false;
async function ensureAdminSchema() {
  if (adminSchemaEnsured) return;
  await query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS session_invalidated_at TIMESTAMPTZ');
  adminSchemaEnsured = true;
}

async function findAdminByName(name) {
  const { rows } = await query('SELECT * FROM admins WHERE lower(name) = lower($1)', [name]);
  return rows[0] || null;
}

// Shared auth check for every action below that requires a logged-in
// admin. Verifies the token's signature/expiry as before, then also
// rejects it if the admin has logged out (or been revoked) since the
// token was issued. Returns the admin row on success, or null.
async function requireSession(token) {
  const name = verifySessionToken(token);
  if (!name) return null;
  const admin = await findAdminByName(name);
  if (!admin) return null;
  if (admin.session_invalidated_at) {
    // The token's payload only carries `exp`, not its issue time — but
    // issue time is deterministic (exp - TTL), so it can be recovered
    // without changing the token format or auth.js's public signature.
    let issuedAt = null;
    try {
      const payloadB64 = String(token).split('.')[0];
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      issuedAt = payload.exp - SESSION_TTL_MS;
    } catch (e) {
      return null;
    }
    if (issuedAt < new Date(admin.session_invalidated_at).getTime()) return null;
  }
  return admin;
}

async function listPendingAdmins() {
  const { rows } = await query("SELECT name, email, token, requested_at FROM admins WHERE status = 'Pending' ORDER BY requested_at");
  return rows.map((r) => ({ name: r.name, email: r.email, token: r.token, requestedAt: r.requested_at }));
}

async function getPublicFlags(tripId) {
  const { rows } = await query(
    'SELECT feature_key, label, page, enabled FROM feature_flags WHERE trip_id = $1',
    [tripId]
  );
  return rows.map((f) => ({ featureKey: f.feature_key, label: f.label, page: f.page, enabled: f.enabled }));
}

// Best-effort rate limit: nothing previously stopped repeated/automated
// requestAdmin submissions (each with a different name) from flooding the
// approver's inbox or growing the admins table unbounded. This is
// in-memory per warm function instance rather than DB-backed — it won't
// catch an attacker spread across many cold starts / instances, but it
// stops the common case (a script hammering the endpoint from one place)
// without needing a new table.
const REQUEST_RATE_LIMIT = 5; // max requests
const REQUEST_RATE_WINDOW_MS = 15 * 60 * 1000; // per 15 minutes, per source IP
const requestAdminHits = new Map(); // ip -> [timestamps]

function checkRequestAdminRateLimit(ip) {
  const now = Date.now();
  const hits = (requestAdminHits.get(ip) || []).filter((t) => now - t < REQUEST_RATE_WINDOW_MS);
  if (hits.length >= REQUEST_RATE_LIMIT) return false;
  hits.push(now);
  requestAdminHits.set(ip, hits);
  return true;
}

const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function requestAdmin(name, email) {
  name = sanitizeText(name, 80);
  email = sanitizeText(email, 120);
  if (!name || !email) throw new Error('Name and email are required.');
  if (!EMAIL_FORMAT_RE.test(email)) throw new Error('Please enter a valid email address.');
  const existing = await findAdminByName(name);
  if (existing && existing.status === 'Approved') throw new Error('This name is already an approved admin.');
  if (existing && existing.status === 'Pending') throw new Error('A request for this name is already pending approval.');

  const token = crypto.randomUUID();
  // findAdminByName() above already matched case-insensitively, so branch
  // on that result rather than relying on `ON CONFLICT (name)` — that
  // conflict target is case-sensitive at the DB level, so it would miss
  // an existing "John Doe" row when this request comes in as "john doe",
  // silently creating a second, duplicate row for the same person instead
  // of updating the one `existing` already found.
  if (existing) {
    await query(
      `UPDATE admins SET name = $2, email = $3, status = 'Pending', token = $4, requested_at = now() WHERE id = $1`,
      [existing.id, name, email, token]
    );
  } else {
    await query(
      `INSERT INTO admins (name, email, status, token) VALUES ($1,$2,'Pending',$3)
       ON CONFLICT (name) DO UPDATE SET email = $2, status = 'Pending', token = $3, requested_at = now()`,
      [name, email, token]
    );
  }

  // The request is persisted above regardless of what happens next — an
  // email-delivery problem should never make it look like the request
  // itself failed (the pending row is what approveAdmin/rejectAdmin act on).
  const siteBase = process.env.SITE_BASE_URL;
  const approverEmail = process.env.APPROVER_EMAIL;
  if (!siteBase || !approverEmail) {
    return { emailed: false, reason: 'Admin request routing is not configured on the server.' };
  }
  const approveUrl = `${siteBase}/approve.html?action=approve&token=${encodeURIComponent(token)}`;
  const rejectUrl = `${siteBase}/approve.html?action=reject&token=${encodeURIComponent(token)}`;
  try {
    await sendEmail({
      to: approverEmail,
      subject: `GoaTrip admin request: ${name}`,
      text: `Admin access requested.\n\nName: ${name}\nEmail: ${email}\n\nApprove -> ${approveUrl}\nReject  -> ${rejectUrl}\n\nIf you did not expect this, click Reject or ignore this email.`,
    });
    return { emailed: true };
  } catch (err) {
    console.error('requestAdmin: email send failed (request still recorded)', err);
    return { emailed: false, reason: 'Could not send the notification email — ask the approver to check pending requests directly.' };
  }
}

async function approveAdmin(token) {
  // Look up the candidate row first just to generate its PIN against the
  // right id — the actual approval decision is made atomically by the
  // UPDATE below, not by this SELECT, so a second concurrent call (e.g.
  // a mail-scanner prefetch hitting the same link a moment after a human
  // click) can't also "win" and hand out a second, conflicting temp PIN.
  const { rows: candidateRows } = await query("SELECT * FROM admins WHERE token = $1 AND status = 'Pending'", [token]);
  if (!candidateRows.length) return { ok: false, message: 'This approval link is invalid, already used, or expired.' };
  const admin = candidateRows[0];
  const tempPin = generateTempPin();
  const salt = generateSalt();
  const hash = hashPin(tempPin, salt);

  // WHERE includes status='Pending' so only the FIRST caller to reach this
  // UPDATE actually flips the row — a concurrent second call (same token,
  // near-simultaneous request) affects 0 rows and is treated as "already
  // used" below, instead of silently generating a second, conflicting PIN.
  const { rows } = await query(
    `UPDATE admins SET status='Approved', token=NULL, approved_at=now(), pin_hash=$2, pin_salt=$3,
       must_change_pin=true, failed_attempts=0, locked_until=NULL
     WHERE id=$1 AND status='Pending' RETURNING *`,
    [admin.id, hash, salt]
  );
  if (!rows.length) return { ok: false, message: 'This approval link is invalid, already used, or expired.' };

  // Approval itself already happened above — an email failure here should
  // surface the PIN to the approver directly (they're already authenticated
  // by having clicked their own emailed approve link) rather than 500.
  try {
    await sendEmail({
      to: admin.email,
      subject: 'Your GoaTrip admin access is approved',
      text: `You have been approved as a GoaTrip admin.\n\nYour temporary PIN: ${tempPin}\n\nLog in at admin.html with your name and this PIN. You'll be asked to set your own permanent 6-digit PIN immediately after.`,
    });
    return { ok: true, message: `Approved ${admin.name}. Temporary PIN emailed to ${admin.email}.` };
  } catch (err) {
    console.error('approveAdmin: email send failed (approval still applied)', err);
    return { ok: true, message: `Approved ${admin.name}, but the email couldn't be sent — share this temporary PIN with them directly: ${tempPin}` };
  }
}

async function rejectAdmin(token) {
  const { rows } = await query("UPDATE admins SET status='Rejected', token=NULL WHERE token=$1 AND status='Pending' RETURNING name", [token]);
  if (!rows.length) return { ok: false, message: 'This link is invalid or already used.' };
  return { ok: true, message: `Request from ${rows[0].name} has been rejected.` };
}

// Full admin roster for the dashboard's Admins tab — never returns pin_hash/pin_salt/token.
async function listAdmins() {
  const { rows } = await query(
    `SELECT name, email, status, must_change_pin, failed_attempts, locked_until, requested_at, approved_at
     FROM admins ORDER BY requested_at DESC`
  );
  return rows.map((r) => ({
    name: r.name, email: r.email, status: r.status, mustChangePin: r.must_change_pin,
    failedAttempts: r.failed_attempts, lockedUntil: r.locked_until,
    requestedAt: r.requested_at, approvedAt: r.approved_at,
    isLocked: !!(r.locked_until && new Date(r.locked_until).getTime() > Date.now()),
  }));
}

// Revokes an approved admin's access (blocks login without deleting their history/record).
async function revokeAdmin(actorName, targetName) {
  if (String(targetName).toLowerCase() === String(actorName).toLowerCase()) {
    throw new Error('You cannot revoke your own access.');
  }
  const { rows } = await query("UPDATE admins SET status='Revoked' WHERE lower(name)=lower($1) AND status='Approved' RETURNING name", [targetName]);
  if (!rows.length) throw new Error('Admin not found or not currently approved.');
  return { ok: true, message: `Revoked access for ${rows[0].name}.` };
}

// Restores a previously revoked/rejected admin. A Revoked admin already
// has a working PIN from their original approval, so they just keep it.
// A Rejected admin was NEVER approved and has no pin_hash at all — simply
// flipping their status to Approved would leave them stuck (shown as
// Approved in the dashboard, but unable to log in, with no PIN and no
// email ever sent). So for that case this issues a fresh temp PIN and
// emails it, exactly like approveAdmin does for a brand-new request.
// Also clears any stale lockout state either way, so a previously
// locked-out admin isn't restored into a still-locked account.
async function reinstateAdmin(targetName) {
  const admin = await findAdminByName(targetName);
  if (!admin) throw new Error('Admin not found.');

  if (!admin.pin_hash) {
    // Never approved before (e.g. was Rejected) — needs a real PIN, not
    // just a status flip.
    const tempPin = generateTempPin();
    const salt = generateSalt();
    const hash = hashPin(tempPin, salt);
    await query(
      `UPDATE admins SET status='Approved', approved_at=now(), pin_hash=$2, pin_salt=$3,
         must_change_pin=true, failed_attempts=0, locked_until=NULL WHERE id=$1`,
      [admin.id, hash, salt]
    );
    try {
      await sendEmail({
        to: admin.email,
        subject: 'Your GoaTrip admin access is approved',
        text: `You have been approved as a GoaTrip admin.\n\nYour temporary PIN: ${tempPin}\n\nLog in at admin.html with your name and this PIN. You'll be asked to set your own permanent 6-digit PIN immediately after.`,
      });
      return { ok: true, message: `Restored ${admin.name} and emailed a temporary PIN to ${admin.email}.` };
    } catch (err) {
      console.error('reinstateAdmin: email send failed (restore still applied)', err);
      return { ok: true, message: `Restored ${admin.name}, but the email couldn't be sent — share this temporary PIN with them directly: ${tempPin}` };
    }
  }

  const { rows } = await query(
    "UPDATE admins SET status='Approved', failed_attempts=0, locked_until=NULL WHERE id=$1 RETURNING name",
    [admin.id]
  );
  if (!rows.length) throw new Error('Admin not found.');
  return { ok: true, message: `Restored access for ${rows[0].name}.` };
}

// Permanently deletes an admin row (unlike revoke, which just blocks
// login — this removes the record entirely, freeing up the name for a
// fresh request). Irreversible, so callers should confirm with the user
// before calling this.
async function deleteAdmin(actorName, targetName) {
  if (String(targetName).toLowerCase() === String(actorName).toLowerCase()) {
    throw new Error('You cannot delete your own account.');
  }
  const { rows } = await query('DELETE FROM admins WHERE lower(name)=lower($1) RETURNING name', [targetName]);
  if (!rows.length) throw new Error('Admin not found.');
  return { ok: true, message: `Deleted ${rows[0].name}.` };
}

// Manually clears a failed-login lockout — for when a legit admin got locked out.
async function unlockAdmin(targetName) {
  const { rows } = await query("UPDATE admins SET failed_attempts=0, locked_until=NULL WHERE lower(name)=lower($1) RETURNING name", [targetName]);
  if (!rows.length) throw new Error('Admin not found.');
  return { ok: true, message: `Unlocked ${rows[0].name}.` };
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

  if (admin.must_change_pin && admin.approved_at) {
    const approvedAt = new Date(admin.approved_at).getTime();
    if (Date.now() - approvedAt > TEMP_PIN_TTL_MS) {
      return { ok: false, message: 'Your temporary PIN has expired — ask an existing admin to restore your access so a new one is issued.' };
    }
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
  const admin = await requireSession(token);
  if (!admin) return { ok: false, message: 'Session expired or invalid — please log in again.' };
  if (!/^\d{6}$/.test(String(newPin || '').trim())) return { ok: false, message: 'PIN must be exactly 6 digits.' };
  const salt = generateSalt();
  const hash = hashPin(String(newPin).trim(), salt);
  await query(
    "UPDATE admins SET pin_hash=$2, pin_salt=$3, must_change_pin=false, failed_attempts=0, locked_until=NULL WHERE id=$1",
    [admin.id, hash, salt]
  );
  return { ok: true, message: 'PIN updated.' };
}

// Logout invalidation: bumps session_invalidated_at so every token issued
// before this moment — including the very one used to call this, and any
// other still-live sessions for this admin — is rejected by requireSession
// from now on, regardless of its remaining TTL.
async function logoutAdmin(token) {
  const admin = await requireSession(token);
  if (!admin) return { ok: true }; // already invalid/expired — nothing to do
  await query('UPDATE admins SET session_invalidated_at = now() WHERE id = $1', [admin.id]);
  return { ok: true };
}

// Recovery path for an admin row that's marked Approved but has no
// pin_hash — which normally can't happen (approveAdmin() sets status and
// the PIN together in one UPDATE), but does happen if a row was edited
// directly in the database (e.g. flipping status to Approved by hand in
// a table editor) rather than through the approve link. Mirrors exactly
// what approveAdmin() does — generate a temp PIN, hash it the same way,
// force a PIN change on next login — just without requiring a Pending
// row + emailed token first. Gated behind a server-only secret (never
// sent to or known by the browser) so this can't be used to reset an
// arbitrary admin's PIN by anyone who merely knows their name.
async function bootstrapAdminPin(secret, targetName) {
  const configured = process.env.ADMIN_BOOTSTRAP_SECRET;
  if (!configured) throw new Error('ADMIN_BOOTSTRAP_SECRET is not configured on the server — this recovery path is disabled.');
  if (!secret || secret !== configured) throw new Error('Invalid bootstrap secret.');
  const admin = await findAdminByName(targetName);
  if (!admin) throw new Error('No admin found with that name.');
  if (admin.status !== 'Approved') throw new Error(`This admin's status is "${admin.status}", not Approved — approve them first via the normal request-access flow.`);

  const tempPin = generateTempPin();
  const salt = generateSalt();
  const hash = hashPin(tempPin, salt);
  await query(
    `UPDATE admins SET pin_hash=$2, pin_salt=$3, must_change_pin=true, failed_attempts=0, locked_until=NULL WHERE id=$1`,
    [admin.id, hash, salt]
  );
  return { ok: true, message: `Temporary PIN for ${admin.name}: ${tempPin} — log in with this, you'll be asked to set a permanent PIN immediately after.`, tempPin };
}

exports.handler = async (event) => {
  try {
    await ensureAdminSchema();

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
        const ip = (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'])) || 'unknown';
        if (!checkRequestAdminRateLimit(ip)) {
          return badRequest('Too many requests from this connection — please wait a while before trying again.');
        }
        const result = await requestAdmin(body.name, body.email);
        return ok({
          ok: true,
          message: result.emailed
            ? 'Request sent for approval.'
            : `Request recorded, but the notification email couldn't be sent (${result.reason}). Ask the approver to check pending requests.`,
        });
      }
      if (body.action === 'login') return ok(await loginAdmin(body.name, body.code));
      if (body.action === 'changePin') return ok(await changePin(body.token, body.newPin));
      if (body.action === 'bootstrapAdminPin') return ok(await bootstrapAdminPin(body.secret, body.name));
      if (body.action === 'logout') return ok(await logoutAdmin(body.token));
      if (body.action === 'whoAmI') {
        const admin = await requireSession(body.token);
        if (!admin) return ok({ ok: false, name: null });
        return ok({ ok: true, name: admin.name, mustChangePin: !!admin.must_change_pin });
      }
      if (body.action === 'listPendingAdmins') {
        const admin = await requireSession(body.token);
        if (!admin) return unauthorized('Session expired or invalid — please log in again.');
        return ok({ ok: true, pending: await listPendingAdmins() });
      }
      if (body.action === 'listAdmins') {
        const admin = await requireSession(body.token);
        if (!admin) return unauthorized('Session expired or invalid — please log in again.');
        return ok({ ok: true, admins: await listAdmins() });
      }
      if (body.action === 'revokeAdmin') {
        const admin = await requireSession(body.token);
        if (!admin) return unauthorized('Session expired or invalid — please log in again.');
        if (admin.must_change_pin) return badRequest('Set a permanent PIN before making changes.');
        return ok(await revokeAdmin(admin.name, body.name));
      }
      if (body.action === 'reinstateAdmin') {
        const admin = await requireSession(body.token);
        if (!admin) return unauthorized('Session expired or invalid — please log in again.');
        if (admin.must_change_pin) return badRequest('Set a permanent PIN before making changes.');
        return ok(await reinstateAdmin(body.name));
      }
      if (body.action === 'deleteAdmin') {
        const admin = await requireSession(body.token);
        if (!admin) return unauthorized('Session expired or invalid — please log in again.');
        if (admin.must_change_pin) return badRequest('Set a permanent PIN before making changes.');
        return ok(await deleteAdmin(admin.name, body.name));
      }
      if (body.action === 'unlockAdmin') {
        const admin = await requireSession(body.token);
        if (!admin) return unauthorized('Session expired or invalid — please log in again.');
        if (admin.must_change_pin) return badRequest('Set a permanent PIN before making changes.');
        return ok(await unlockAdmin(body.name));
      }
      if (body.action === 'updateFlag') {
        const admin = await requireSession(body.token);
        if (!admin) return unauthorized('Session expired or invalid — please log in again.');
        if (admin.must_change_pin) return badRequest('Set a permanent PIN before making changes.');
        const tripId = body.tripId;
        if (!tripId) return badRequest('tripId is required.');
        const featureKey = sanitizeText(body.featureKey, 80);
        const enabled = !!body.enabled;
        await query(
          `INSERT INTO feature_flags (trip_id, feature_key, label, page, enabled, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,now())
           ON CONFLICT (trip_id, feature_key) DO UPDATE SET enabled=$5, updated_by=$6, updated_at=now()`,
          [tripId, featureKey, sanitizeText(body.label || featureKey, 120), sanitizeText(body.page || 'Custom', 60), enabled, admin.name]
        );
        if (featureKey === 'index.registration') {
          await query('UPDATE trips SET registration_open = $2 WHERE id = $1', [tripId, enabled]);
        }
        // 'Lock wallet (final submission)' — flips trips.wallet_locked,
        // which wallet.js enforces server-side on every write. The ALTER
        // here is defensive/idempotent so this works even if wallet.js
        // hasn't run yet on a cold instance.
        if (featureKey === 'wallet.locked') {
          await query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS wallet_locked BOOLEAN DEFAULT false');
          await query('UPDATE trips SET wallet_locked = $2 WHERE id = $1', [tripId, enabled]);
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
