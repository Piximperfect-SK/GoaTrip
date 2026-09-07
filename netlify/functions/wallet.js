// Wallet: expenses/settlements/deposits/activity for a trip. Read-modify-write
// via Postgres statements; validation ported from the original Apps Script
// SCHEMAS/validateAction_ pattern before any write happens.
const crypto = require('crypto');
const { query } = require('./lib/db');
const { ok, badRequest, serverError, parseBody } = require('./lib/http');
const { sanitizeText, sanitizeNumber, normalizeDepositType, validatePayload } = require('./lib/validate');

// Not a secret (visible in this repo/front-end) — a "type this exact phrase"
// guard against one stray/automated POST wiping a trip's wallet, same as
// the original Apps Script design.
const RESET_CONFIRM_PHRASE = process.env.WALLET_RESET_CONFIRM_PHRASE || 'RESET-GOATRIP-WALLET';

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

async function readState(tripId) {
  const [expenses, settlements, deposits, activity, trip] = await Promise.all([
    query('SELECT * FROM expenses WHERE trip_id=$1 ORDER BY created_at', [tripId]),
    query('SELECT * FROM settlements WHERE trip_id=$1 ORDER BY ts', [tripId]),
    query('SELECT * FROM deposits WHERE trip_id=$1 ORDER BY ts', [tripId]),
    query('SELECT * FROM activity WHERE trip_id=$1 ORDER BY ts', [tripId]),
    query('SELECT wallet_participants FROM trips WHERE id=$1', [tripId]),
  ]);
  return {
    expenses: expenses.rows.map((r) => ({
      id: r.id, title: r.title, category: r.category, amount: Number(r.amount), payer: r.payer,
      split: r.split || [], date: r.date, createdBy: r.created_by, createdAt: r.created_at,
      updatedBy: r.updated_by, updatedAt: r.updated_at, splitType: r.split_type,
      splitAmounts: r.split_amounts, paidFromDeposit: r.paid_from_deposit, depositUsedFrom: r.deposit_used_from,
    })),
    settlements: settlements.rows.map((r) => ({
      id: r.id, from: r.from_person, to: r.to_person, amount: Number(r.amount), note: r.note,
      actor: r.actor, ts: r.ts, usedDeposit: r.used_deposit,
    })),
    deposits: deposits.rows.map((r) => ({
      id: r.id, person: r.person, amount: Number(r.amount), date: r.date, note: r.note,
      loggedBy: r.logged_by, ts: r.ts, type: normalizeDepositType(r.type),
    })),
    activity: activity.rows.map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, action: r.action, detail: r.detail })),
    participants: (trip.rows[0] && trip.rows[0].wallet_participants) || [],
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

    if (event.httpMethod === 'GET') return ok(await readState(tripId));

    if (event.httpMethod !== 'POST') return badRequest('Unsupported method.');

    const body = parseBody(event);
    if (!body) return badRequest('Invalid JSON body.');
    const { action } = body;
    const payload = body.payload || {};
    let actor = sanitizeText(body.actor || 'Unknown', 80);

    if (!SCHEMAS.hasOwnProperty(action)) return badRequest('Unknown or invalid action.');
    if (typeof body.actor !== 'string' || body.actor.length < 1 || body.actor.length > 80) {
      return badRequest('Invalid actor name.');
    }
    const validationError = validatePayload(SCHEMAS[action], payload) || validateSplitAmounts(action, payload);
    if (validationError) return badRequest(validationError);
    if (action === 'resetWallet' && payload.confirm !== RESET_CONFIRM_PHRASE) {
      return badRequest('Reset not confirmed — missing or incorrect confirmation phrase.');
    }

    if (action === 'addExpense') {
      const amount = sanitizeNumber(payload.amount, 0, 10000000) || 0;
      const splitType = payload.splitType === 'individual' ? 'individual' : 'equal';
      await query(
        `INSERT INTO expenses (id, trip_id, title, category, amount, payer, split, date, created_by, split_type,
           split_amounts, paid_from_deposit, deposit_used_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
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
      await query(
        `UPDATE expenses SET title=$3, category=$4, amount=$5, payer=$6, split=$7, date=$8, updated_by=$9,
           updated_at=now(), split_type=$10, split_amounts=$11, paid_from_deposit=$12, deposit_used_from=$13
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
        `INSERT INTO settlements (id, trip_id, from_person, to_person, amount, note, actor, used_deposit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
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
        `INSERT INTO deposits (id, trip_id, person, amount, date, note, logged_by, type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [sanitizeText(payload.id, 60), tripId, sanitizeText(payload.person, 80), amount,
          sanitizeText(payload.date || '', 20), sanitizeText(payload.note || '', 200), actor, type]
      );
      await logActivity(tripId, payload.id, actor, type === 'withdrawal' ? 'add_withdrawal' : 'add_deposit',
        `${sanitizeText(payload.person, 80)} ${type === 'withdrawal' ? 'withdrew' : 'deposited'} Rs.${amount}`);
    } else if (action === 'editDeposit') {
      const amount = sanitizeNumber(payload.amount, 0.01, 10000000) || 0;
      const type = normalizeDepositType(payload.type);
      await query(
        `UPDATE deposits SET person=$3, amount=$4, date=$5, note=$6, type=$7 WHERE trip_id=$1 AND id=$2`,
        [tripId, sanitizeText(payload.id, 60), sanitizeText(payload.person, 80), amount,
          sanitizeText(payload.date || '', 20), sanitizeText(payload.note || '', 200), type]
      );
      await logActivity(tripId, payload.id, actor, type === 'withdrawal' ? 'edit_withdrawal' : 'edit_deposit',
        `${sanitizeText(payload.person, 80)} updated to Rs.${amount}`);
    } else if (action === 'deleteDeposit') {
      await query('DELETE FROM deposits WHERE trip_id=$1 AND id=$2', [tripId, payload.id]);
      await logActivity(tripId, payload.id, actor, 'delete_deposit', payload.id);
    } else if (action === 'resetWallet') {
      await query('DELETE FROM expenses WHERE trip_id=$1', [tripId]);
      await query('DELETE FROM settlements WHERE trip_id=$1', [tripId]);
      await query('DELETE FROM deposits WHERE trip_id=$1', [tripId]);
      await query('DELETE FROM activity WHERE trip_id=$1', [tripId]);
      await logActivity(tripId, `reset_${crypto.randomUUID()}`, actor, 'reset_wallet', 'Wallet reset');
    }

    return ok(await readState(tripId));
  } catch (err) {
    return serverError(err);
  }
};
