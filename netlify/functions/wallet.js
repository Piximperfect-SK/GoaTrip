// Wallet: expenses/settlements/deposits/activity for a trip. Read-modify-write
// via Postgres statements; validation ported from the original Apps Script
// SCHEMAS/validateAction_ pattern before any write happens.
const crypto = require('crypto');
const { query } = require('./lib/db');
const { ok, badRequest, unauthorized, serverError, parseBody } = require('./lib/http');
const { sanitizeText, sanitizeNumber, normalizeDepositType, validatePayload } = require('./lib/validate');
const { verifySessionTokenFull } = require('./lib/auth');

// Not a secret (visible in this repo/front-end) — a "type this exact phrase"
// guard against one stray/automated POST wiping a trip's wallet, same as
// the original Apps Script design.
const RESET_CONFIRM_PHRASE = process.env.WALLET_RESET_CONFIRM_PHRASE || 'RESET-GOATRIP-WALLET';

// Phase 4: DRAFT -> PENDING_APPROVAL -> APPROVED/REJECTED state machine.
// One small map instead of three near-identical branches, since
// submitForApproval/approveRecord/rejectRecord all need to (a) know which
// table a recordType lives in and (b) know which column records who
// created/logged/acted on that row, since the three tables don't share a
// column name for that (expenses: created_by, settlements: actor,
// deposits: logged_by).
const RECORD_TABLES = {
  expense: { table: 'expenses', ownerColumn: 'created_by' },
  settlement: { table: 'settlements', ownerColumn: 'actor' },
  deposit: { table: 'deposits', ownerColumn: 'logged_by' },
};

const SCHEMAS = {
  addExpense: {
    id: { type: 'string', maxLen: 60, required: true },
    title: { type: 'string', maxLen: 120, required: true },
    category: { type: 'string', maxLen: 40 },
    amount: { type: 'number', min: 0, max: 10000000, required: true },
    payer: { type: 'string', maxLen: 80, required: true },
    date: { type: 'string', maxLen: 20 },
    splitType: { type: 'string', maxLen: 20 },
    split: { type: 'array', maxLen: 50 },
    depositUsedFrom: { type: 'string', maxLen: 80 },
  },
  editExpense: {
    id: { type: 'string', maxLen: 60, required: true },
    title: { type: 'string', maxLen: 120, required: true },
    category: { type: 'string', maxLen: 40 },
    amount: { type: 'number', min: 0, max: 10000000, required: true },
    payer: { type: 'string', maxLen: 80, required: true },
    date: { type: 'string', maxLen: 20 },
    splitType: { type: 'string', maxLen: 20 },
    split: { type: 'array', maxLen: 50 },
    depositUsedFrom: { type: 'string', maxLen: 80 },
  },
  removeExpense: { id: { type: 'string', maxLen: 60, required: true } },
  addSettlement: {
    id: { type: 'string', maxLen: 60, required: true },
    from: { type: 'string', maxLen: 80, required: true },
    to: { type: 'string', maxLen: 80, required: true },
    amount: { type: 'number', min: 0, max: 10000000, required: true },
    note: { type: 'string', maxLen: 200 },
  },
  removeSettlement: { id: { type: 'string', maxLen: 60, required: true } },
  addDeposit: {
    id: { type: 'string', maxLen: 60, required: true },
    person: { type: 'string', maxLen: 80, required: true },
    amount: { type: 'number', min: 0.01, max: 10000000, required: true },
    date: { type: 'string', maxLen: 20 },
    note: { type: 'string', maxLen: 200 },
    type: { type: 'string', maxLen: 20 },
  },
  editDeposit: {
    id: { type: 'string', maxLen: 60, required: true },
    person: { type: 'string', maxLen: 80, required: true },
    amount: { type: 'number', min: 0.01, max: 10000000, required: true },
    date: { type: 'string', maxLen: 20 },
    note: { type: 'string', maxLen: 200 },
    type: { type: 'string', maxLen: 20 },
  },
  deleteDeposit: { id: { type: 'string', maxLen: 60, required: true } },
  resetWallet: {},
  submitForApproval: {
    recordType: { type: 'string', maxLen: 20, required: true },
    id: { type: 'string', maxLen: 60, required: true },
  },
  approveRecord: {
    recordType: { type: 'string', maxLen: 20, required: true },
    id: { type: 'string', maxLen: 60, required: true },
  },
  rejectRecord: {
    recordType: { type: 'string', maxLen: 20, required: true },
    id: { type: 'string', maxLen: 60, required: true },
    reason: { type: 'string', maxLen: 300 },
  },
};

function validateSplitAmounts(action, payload) {
  if ((action === 'addExpense' || action === 'editExpense') && payload.splitAmounts) {
    if (typeof payload.splitAmounts !== 'object' || Array.isArray(payload.splitAmounts)) {
      return 'splitAmounts must be an object.';
    }
    const keys = Object.keys(payload.splitAmounts);
    if (keys.length > 50) return 'splitAmounts has too many entries.';
    for (const k of keys) {
      if (k.length > 80) return 'splitAmounts has an invalid name.';
      if (sanitizeNumber(payload.splitAmounts[k], 0, 10000000) === null) {
        return `splitAmounts has an invalid amount for ${k}.`;
      }
    }
  }
  return null;
}

// Self-healing column for the "final submission" lock — toggled from
// admin.html's feature-flags panel (featureKey 'wallet.locked'), mirroring
// how 'index.registration' flips trips.registration_open. Declared here
// too (not just in admin.js) so wallet.js never depends on admin.js
// having run first on a cold instance.
let walletLockSchemaEnsured = false;
async function ensureWalletLockSchema() {
  if (walletLockSchemaEnsured) return;
  await query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS wallet_locked BOOLEAN DEFAULT false');
  walletLockSchemaEnsured = true;
}

async function getWalletLockState(tripId) {
  await ensureWalletLockSchema();
  const { rows } = await query('SELECT wallet_locked FROM trips WHERE id=$1', [tripId]);
  return !!(rows[0] && rows[0].wallet_locked);
}

// Phase 2 schema, added here (not just once at boot) for the same
// cold-start-independence reason as ensureWalletLockSchema above.
// DEFAULT 'approved' on the new status column is deliberate: it's a
// backfill default, not just a column default, so every row that
// existed before this migration ran gets grandfathered in as approved
// (they were already fully visible to everyone under the old no-approval
// model — this migration must not un-show anyone's existing data). New
// rows override that default explicitly at INSERT time, see addExpense/
// addSettlement/addDeposit below, which insert status='draft'.
let approvalSchemaEnsured = false;
async function ensureApprovalSchema() {
  if (approvalSchemaEnsured) return;
  for (const { table } of Object.values(RECORD_TABLES)) {
    await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'approved'`);
    await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS submitted_by TEXT`);
    await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ`);
    await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS approved_by TEXT`);
    await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
    await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS rejected_by TEXT`);
    await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ`);
    await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS rejection_reason TEXT`);
  }
  approvalSchemaEnsured = true;
}

// Fetches one record for the approval actions, keyed by (recordType, id).
// Returns null if the recordType is invalid or no matching row exists.
async function getRecordForApproval(tripId, recordType, id) {
  const def = RECORD_TABLES[recordType];
  if (!def) return null;
  const { rows } = await query(`SELECT * FROM ${def.table} WHERE trip_id=$1 AND id=$2`, [tripId, id]);
  if (!rows.length) return null;
  return { ...rows[0], _table: def.table, _ownerColumn: def.ownerColumn };
}

// Phase 7 visibility rule: everyone sees every APPROVED record (that's the
// shared, settled truth of the trip's finances); a non-admin also sees
// their own not-yet-approved records (their own drafts/pending/rejected
// stay visible to them so they can find and resubmit/edit them), but not
// anyone else's. Admins see everything, at every status, since they're
// the ones who have to review the pending queue. ownerField is the
// camelCase field name on the already-mapped record (createdBy / actor /
// loggedBy) that readState()'s three .map() calls produce.
function filterVisible(records, ownerField, viewer) {
  if (viewer.isAdmin) return records;
  return records.filter((r) => r.status === 'approved' || r[ownerField] === viewer.name);
}

async function readState(tripId, viewer) {
  await ensureWalletLockSchema();
  await ensureApprovalSchema();
  const [expenses, settlements, deposits, activity, trip] = await Promise.all([
    query('SELECT * FROM expenses WHERE trip_id=$1 ORDER BY created_at', [tripId]),
    query('SELECT * FROM settlements WHERE trip_id=$1 ORDER BY ts', [tripId]),
    query('SELECT * FROM deposits WHERE trip_id=$1 ORDER BY ts', [tripId]),
    query('SELECT * FROM activity WHERE trip_id=$1 ORDER BY ts', [tripId]),
    query('SELECT wallet_participants, wallet_locked FROM trips WHERE id=$1', [tripId]),
  ]);
  const mappedExpenses = expenses.rows.map((r) => ({
    id: r.id, title: r.title, category: r.category, amount: Number(r.amount), payer: r.payer,
    split: r.split || [], date: r.date, createdBy: r.created_by, createdAt: r.created_at,
    updatedBy: r.updated_by, updatedAt: r.updated_at, splitType: r.split_type,
    splitAmounts: r.split_amounts, paidFromDeposit: r.paid_from_deposit, depositUsedFrom: r.deposit_used_from,
    ...approvalFields(r),
  }));
  const mappedSettlements = settlements.rows.map((r) => ({
    id: r.id, from: r.from_person, to: r.to_person, amount: Number(r.amount), note: r.note,
    actor: r.actor, ts: r.ts, usedDeposit: r.used_deposit,
    ...approvalFields(r),
  }));
  const mappedDeposits = deposits.rows.map((r) => ({
    id: r.id, person: r.person, amount: Number(r.amount), date: r.date, note: r.note,
    loggedBy: r.logged_by, ts: r.ts, type: normalizeDepositType(r.type),
    ...approvalFields(r),
  }));
  return {
    expenses: filterVisible(mappedExpenses, 'createdBy', viewer),
    settlements: filterVisible(mappedSettlements, 'actor', viewer),
    deposits: filterVisible(mappedDeposits, 'loggedBy', viewer),
    activity: activity.rows.map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, action: r.action, detail: r.detail })),
    participants: (trip.rows[0] && trip.rows[0].wallet_participants) || [],
    // Signed-in users (admin or participant) get this back so
    // goa-wallet.html can switch itself into read-only mode client-side,
    // on top of the real enforcement below on POST.
    locked: !!(trip.rows[0] && trip.rows[0].wallet_locked),
  };
}

async function logActivity(tripId, id, actor, action, detail) {
  await query('INSERT INTO activity (id, trip_id, actor, action, detail) VALUES ($1,$2,$3,$4,$5)', [
    sanitizeText(id, 60), tripId, actor, action, sanitizeText(detail, 200),
  ]);
}

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const tripId = params.tripId;
    if (!tripId) return badRequest('tripId is required.');
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return badRequest('Unsupported method.');

    const body = event.httpMethod === 'POST' ? parseBody(event) : null;
    if (event.httpMethod === 'POST' && !body) return badRequest('Invalid JSON body.');

    // Reads now require a session too — the wallet holds real financial
    // data, so "anyone with the trip link" is no longer an acceptable
    // access model (previously GET was intentionally public; see the
    // frontend gate in goa-wallet.html for the corresponding change).
    // Token travels as a query param on GET since there's no body.
    if (event.httpMethod === 'GET') {
      const session = params.token ? verifySessionTokenFull(params.token) : null;
      if (!session) {
        return unauthorized('Please sign in to view the wallet.');
      }
      return ok(await readState(tripId, { name: sanitizeText(session.name, 80), isAdmin: session.role === 'admin' }));
    }

    const { action } = body;
    const payload = body.payload || {};

    if (!SCHEMAS.hasOwnProperty(action)) return badRequest('Unknown or invalid action.');

    // Identity now comes ONLY from a verified session token — body.actor
    // is gone. Previously any caller could POST any actor name they liked
    // (a free-text field the frontend happened to fill in), which meant
    // the audit trail (created_by/updated_by/activity log) recorded
    // whatever the client claimed rather than who was actually logged in.
    // Both regular users and admins hold session tokens now (see login.js),
    // so "no token" simply means "not logged in" — there's no more
    // unauthenticated-but-named write path at all, locked or not.
    const session = body.token ? verifySessionTokenFull(body.token) : null;
    if (!session) {
      return unauthorized('Please log in to make changes to the wallet.');
    }
    const actor = sanitizeText(session.name, 80);
    const isAdmin = session.role === 'admin';

    // Access rule: before the trip's admin marks the wallet "locked" (final
    // submission), any logged-in participant can log expenses/settlements/
    // deposits under their own session identity. Once locked, only admins
    // can write. resetWallet is always admin-only regardless of lock state
    // — wiping a trip's whole wallet is too destructive to leave open to
    // every participant.
    // approveRecord/rejectRecord are always admin-only, lock state aside —
    // the whole point of the approval step is that a participant can't be
    // the one who approves their own (or anyone else's) submission.
    const locked = await getWalletLockState(tripId);
    const requiresAdmin = action === 'resetWallet' || action === 'approveRecord' || action === 'rejectRecord' || locked;
    if (requiresAdmin && !isAdmin) {
      return unauthorized(
        action === 'resetWallet'
          ? 'Resetting the wallet requires an admin session — please log in as admin.'
          : action === 'approveRecord' || action === 'rejectRecord'
          ? 'Approving or rejecting records requires an admin session — please log in as admin.'
          : 'The wallet is locked for final submission — only admins can make changes now. Please log in as admin.'
      );
    }

    const validationError = validatePayload(SCHEMAS[action], payload) || validateSplitAmounts(action, payload);
    if (validationError) return badRequest(validationError);
    if (action === 'resetWallet' && payload.confirm !== RESET_CONFIRM_PHRASE) {
      return badRequest('Reset not confirmed — missing or incorrect confirmation phrase.');
    }

    // Needed before any of the branches below touch status/submitted_by/
    // approved_by/etc, whether that's an INSERT (add*) or an UPDATE
    // (submitForApproval/approveRecord/rejectRecord).
    await ensureApprovalSchema();

    if (action === 'addExpense') {
      const amount = sanitizeNumber(payload.amount, 0, 10000000) || 0;
      const splitType = payload.splitType === 'individual' ? 'individual' : 'equal';
      await query(
        `INSERT INTO expenses (id, trip_id, title, category, amount, payer, split, date, created_by, split_type,
           split_amounts, paid_from_deposit, deposit_used_from, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft')`,
        [
          sanitizeText(payload.id, 60), tripId, sanitizeText(payload.title, 120), sanitizeText(payload.category || 'Misc', 40),
          amount, sanitizeText(payload.payer, 80), JSON.stringify((payload.split || []).map((s) => sanitizeText(s, 80))),
          sanitizeText(payload.date || '', 20), actor, splitType,
          payload.splitAmounts ? JSON.stringify(payload.splitAmounts) : null,
          !!payload.paidFromDeposit, sanitizeText(payload.depositUsedFrom || '', 80),
        ]
      );
      await logActivity(tripId, payload.id, actor, 'add_expense', `${sanitizeText(payload.title, 120)} (Rs.${amount})`);
    } else if (action === 'editExpense') {
      const amount = sanitizeNumber(payload.amount, 0, 10000000) || 0;
      const splitType = payload.splitType === 'individual' ? 'individual' : 'equal';
      // A non-admin editing their own expense sends it back to 'draft' and
      // clears any prior approval/rejection — otherwise a participant could
      // get a record approved, then edit the amount afterward with no
      // re-approval step, which defeats the point of having one. Admin
      // edits don't reset status, since admins are the approvers and this
      // is mainly a correction/typo-fix path for them, not a resubmission.
      const statusClause = isAdmin ? '' : `, status='draft', submitted_by=NULL, submitted_at=NULL,
           approved_by=NULL, approved_at=NULL, rejected_by=NULL, rejected_at=NULL, rejection_reason=NULL`;
      await query(
        `UPDATE expenses SET title=$3, category=$4, amount=$5, payer=$6, split=$7, date=$8, updated_by=$9,
           updated_at=now(), split_type=$10, split_amounts=$11, paid_from_deposit=$12, deposit_used_from=$13${statusClause}
         WHERE trip_id=$1 AND id=$2`,
        [
          tripId, sanitizeText(payload.id, 60), sanitizeText(payload.title, 120), sanitizeText(payload.category || 'Misc', 40),
          amount, sanitizeText(payload.payer, 80), JSON.stringify((payload.split || []).map((s) => sanitizeText(s, 80))),
          sanitizeText(payload.date || '', 20), actor, splitType,
          payload.splitAmounts ? JSON.stringify(payload.splitAmounts) : null,
          !!payload.paidFromDeposit, sanitizeText(payload.depositUsedFrom || '', 80),
        ]
      );
      await logActivity(tripId, payload.id, actor, 'edit_expense', `${sanitizeText(payload.title, 120)} (Rs.${amount})`);
    } else if (action === 'removeExpense') {
      await query('DELETE FROM expenses WHERE trip_id=$1 AND id=$2', [tripId, payload.id]);
      await logActivity(tripId, payload.id, actor, 'remove_expense', payload.id);
    } else if (action === 'addSettlement') {
      const amount = sanitizeNumber(payload.amount, 0, 10000000) || 0;
      await query(
        `INSERT INTO settlements (id, trip_id, from_person, to_person, amount, note, actor, used_deposit, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft')`,
        [sanitizeText(payload.id, 60), tripId, sanitizeText(payload.from, 80), sanitizeText(payload.to, 80), amount,
          sanitizeText(payload.note || '', 200), actor, !!payload.usedDeposit]
      );
      await logActivity(tripId, payload.id, actor, 'add_settlement', `${sanitizeText(payload.from, 80)} to ${sanitizeText(payload.to, 80)} (Rs.${amount})`);
    } else if (action === 'removeSettlement') {
      await query('DELETE FROM settlements WHERE trip_id=$1 AND id=$2', [tripId, payload.id]);
      await logActivity(tripId, payload.id, actor, 'remove_settlement', payload.id);
    } else if (action === 'addDeposit') {
      const amount = sanitizeNumber(payload.amount, 0.01, 10000000) || 0;
      const type = normalizeDepositType(payload.type);
      await query(
        `INSERT INTO deposits (id, trip_id, person, amount, date, note, logged_by, type, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft')`,
        [sanitizeText(payload.id, 60), tripId, sanitizeText(payload.person, 80), amount,
          sanitizeText(payload.date || '', 20), sanitizeText(payload.note || '', 200), actor, type]
      );
      await logActivity(tripId, payload.id, actor, type === 'withdrawal' ? 'add_withdrawal' : 'add_deposit',
        `${sanitizeText(payload.person, 80)} ${type === 'withdrawal' ? 'withdrew' : 'deposited'} Rs.${amount}`);
    } else if (action === 'editDeposit') {
      const amount = sanitizeNumber(payload.amount, 0.01, 10000000) || 0;
      const type = normalizeDepositType(payload.type);
      // Same re-approval-on-edit rule as editExpense above.
      const statusClause = isAdmin ? '' : `, status='draft', submitted_by=NULL, submitted_at=NULL,
           approved_by=NULL, approved_at=NULL, rejected_by=NULL, rejected_at=NULL, rejection_reason=NULL`;
      await query(
        `UPDATE deposits SET person=$3, amount=$4, date=$5, note=$6, type=$7${statusClause} WHERE trip_id=$1 AND id=$2`,
        [tripId, sanitizeText(payload.id, 60), sanitizeText(payload.person, 80), amount,
          sanitizeText(payload.date || '', 20), sanitizeText(payload.note || '', 200), type]
      );
      await logActivity(tripId, payload.id, actor, type === 'withdrawal' ? 'edit_withdrawal' : 'edit_deposit',
        `${sanitizeText(payload.person, 80)} updated to Rs.${amount}`);
    } else if (action === 'deleteDeposit') {
      await query('DELETE FROM deposits WHERE trip_id=$1 AND id=$2', [tripId, payload.id]);
      await logActivity(tripId, payload.id, actor, 'delete_deposit', payload.id);
    } else if (action === 'submitForApproval') {
      const record = await getRecordForApproval(tripId, payload.recordType, payload.id);
      if (!record) return badRequest('Record not found.');
      // Only the record's own creator/actor, or an admin on their behalf,
      // can submit it — otherwise anyone signed in could push anyone
      // else's draft into the approval queue.
      if (!isAdmin && record[record._ownerColumn] !== actor) {
        return unauthorized('You can only submit your own records for approval.');
      }
      if (record.status !== 'draft' && record.status !== 'rejected') {
        return badRequest(`This record is already ${record.status} and can't be resubmitted.`);
      }
      await query(
        `UPDATE ${record._table} SET status='pending_approval', submitted_by=$3, submitted_at=now(),
           approved_by=NULL, approved_at=NULL, rejected_by=NULL, rejected_at=NULL, rejection_reason=NULL
         WHERE trip_id=$1 AND id=$2`,
        [tripId, payload.id, actor]
      );
      await logActivity(tripId, payload.id, actor, 'submit_for_approval', `${payload.recordType} ${payload.id}`);
    } else if (action === 'approveRecord') {
      const record = await getRecordForApproval(tripId, payload.recordType, payload.id);
      if (!record) return badRequest('Record not found.');
      if (record.status !== 'pending_approval') {
        return badRequest('Only records pending approval can be approved.');
      }
      await query(
        `UPDATE ${record._table} SET status='approved', approved_by=$3, approved_at=now(),
           rejected_by=NULL, rejected_at=NULL, rejection_reason=NULL
         WHERE trip_id=$1 AND id=$2`,
        [tripId, payload.id, actor]
      );
      await logActivity(tripId, payload.id, actor, 'approve_record', `${payload.recordType} ${payload.id}`);
    } else if (action === 'rejectRecord') {
      const record = await getRecordForApproval(tripId, payload.recordType, payload.id);
      if (!record) return badRequest('Record not found.');
      if (record.status !== 'pending_approval') {
        return badRequest('Only records pending approval can be rejected.');
      }
      const reason = sanitizeText(payload.reason || '', 300);
      await query(
        `UPDATE ${record._table} SET status='rejected', rejected_by=$3, rejected_at=now(), rejection_reason=$4,
           approved_by=NULL, approved_at=NULL
         WHERE trip_id=$1 AND id=$2`,
        [tripId, payload.id, actor, reason]
      );
      await logActivity(tripId, payload.id, actor, 'reject_record', `${payload.recordType} ${payload.id}${reason ? `: ${reason}` : ''}`);
    } else if (action === 'resetWallet') {
      await query('DELETE FROM expenses WHERE trip_id=$1', [tripId]);
      await query('DELETE FROM settlements WHERE trip_id=$1', [tripId]);
      await query('DELETE FROM deposits WHERE trip_id=$1', [tripId]);
      await query('DELETE FROM activity WHERE trip_id=$1', [tripId]);
      await logActivity(tripId, `reset_${crypto.randomUUID()}`, actor, 'reset_wallet', 'Wallet reset');
    }

    return ok(await readState(tripId, { name: actor, isAdmin }));
  } catch (err) {
    return serverError(err);
  }
};
