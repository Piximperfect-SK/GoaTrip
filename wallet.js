// Wallet: expenses/settlements/deposits/activity for a trip. Read-modify-write
// via Postgres statements; validation ported from the original Apps Script
// SCHEMAS/validateAction_ pattern before any write happens.
const crypto = require('crypto');
const { query } = require('./lib/db');
const { ok, badRequest, unauthorized, serverError, parseBody } = require('./lib/http');
const { sanitizeText, sanitizeNumber, normalizeDepositType, validatePayload } = require('./lib/validate');
const { verifySessionTokenFull } = require('./lib/auth');
const { notifyAdminsPendingApproval } = require('./lib/notify');

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
    // Not required at the schema level any more — a "pre-logged" common
    // expense (payload.unpaid === true) is deliberately submitted with no
    // payer yet. The handler below still enforces payer as required
    // whenever unpaid isn't set, so a normal expense can't slip through
    // without one; this just moves that check from unconditional to
    // conditional on unpaid.
    payer: { type: 'string', maxLen: 80 },
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
    // See addExpense's payer comment — same conditional-on-unpaid rule.
    payer: { type: 'string', maxLen: 80 },
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
  addAdjustment: {
    id: { type: 'string', maxLen: 60, required: true },
    person: { type: 'string', maxLen: 80, required: true },
    amount: { type: 'number', min: -10000000, max: 10000000, required: true },
    note: { type: 'string', maxLen: 200, required: true },
  },
  deleteAdjustment: { id: { type: 'string', maxLen: 60, required: true } },
  renameParticipant: {
    oldName: { type: 'string', maxLen: 80, required: true },
    newName: { type: 'string', maxLen: 80, required: true },
  },
  mergeParticipant: {
    source: { type: 'string', maxLen: 80, required: true },
    target: { type: 'string', maxLen: 80, required: true },
  },
};

const SAFE_RECORD_ID = /^[A-Za-z0-9_-]{1,60}$/;
const SAFE_DATE = /^[0-9A-Za-z:.+\/ -]{1,20}$/;
const SAFE_PARTICIPANT_NAME = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .-]*$/;

function hasMarkup(value) { return typeof value === 'string' && /[<>]/.test(value); }
function safeParticipantName(value) {
  const name = sanitizeText(value, 80);
  return SAFE_PARTICIPANT_NAME.test(name) ? name : 'Unknown participant';
}
function safeRecordId(value) { return SAFE_RECORD_ID.test(String(value || '')) ? String(value) : ''; }
function validateSafeWalletInput(action, payload) {
  if (payload.id && !SAFE_RECORD_ID.test(payload.id)) return 'Invalid record id.';
  const fields = ['title', 'category', 'payer', 'depositUsedFrom', 'person', 'from', 'to', 'note', 'oldName', 'newName', 'source', 'target', 'reason', 'splitType', 'type', 'recordType', 'date'];
  for (const field of fields) if (hasMarkup(payload[field])) return `${field} cannot contain < or >.`;
  // Dates are rendered on the page too — only plain date/time characters allowed.
  if (payload.date && !SAFE_DATE.test(String(payload.date))) return 'Invalid date.';
  if (Array.isArray(payload.split) && payload.split.some((name) => hasMarkup(name))) return 'Participant names cannot contain < or >.';
  if (payload.splitAmounts && Object.keys(payload.splitAmounts).some((name) => hasMarkup(name))) return 'Participant names cannot contain < or >.';
  for (const field of ['payer', 'depositUsedFrom', 'person', 'from', 'to', 'oldName', 'newName', 'source', 'target']) {
    if (payload[field] && !SAFE_PARTICIPANT_NAME.test(sanitizeText(payload[field], 80))) return `${field} contains invalid participant-name characters.`;
  }
  return null;
}

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

// "Pre-logged" common expenses — a shared cost the group knows is coming
// (or has already happened) but that nobody has personally fronted the
// money for yet. Stored as a normal expense row with unpaid=true and
// payer='' so it still shows in the expense list/activity/category
// totals like any other expense, but readState/computeNetBalances on the
// frontend deliberately skip crediting anyone for having "paid" it until
// someone actually settles it (at which point an edit sets payer + flips
// unpaid back to false, same row/id — not a new record).
let unpaidExpenseSchemaEnsured = false;
async function ensureUnpaidExpenseSchema() {
  if (unpaidExpenseSchemaEnsured) return;
  await query('ALTER TABLE expenses ADD COLUMN IF NOT EXISTS unpaid BOOLEAN DEFAULT false');
  unpaidExpenseSchemaEnsured = true;
}

// Shared administrative wallet state. Keeping adjustments and name aliases in
// dedicated tables makes them visible on every device and preserves the raw
// registration identity used by login.js.
let sharedWalletStateSchemaEnsured = false;
async function ensureSharedWalletStateSchema() {
  if (sharedWalletStateSchemaEnsured) return;
  await query(`CREATE TABLE IF NOT EXISTS wallet_adjustments (
    id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, person TEXT NOT NULL,
    amount NUMERIC NOT NULL, note TEXT NOT NULL, actor TEXT NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS wallet_participant_aliases (
    trip_id TEXT NOT NULL, source_name TEXT NOT NULL, target_name TEXT NOT NULL,
    PRIMARY KEY (trip_id, source_name)
  )`);
  sharedWalletStateSchemaEnsured = true;
}

function resolveAlias(name, aliases) {
  let value = name;
  const seen = new Set();
  while (aliases[value] && !seen.has(value)) {
    seen.add(value);
    value = aliases[value];
  }
  return value;
}

function remapExpensePeople(expense, person) {
  const split = [];
  (expense.split || []).map(person).forEach((name) => {
    if (!split.includes(name)) split.push(name);
  });
  let splitAmounts = expense.splitAmounts;
  if (splitAmounts) {
    splitAmounts = {};
    Object.entries(expense.splitAmounts).forEach(([name, amount]) => {
      const mapped = person(name);
      splitAmounts[mapped] = (Number(splitAmounts[mapped]) || 0) + (Number(amount) || 0);
    });
  }
  return { ...expense, payer: safeParticipantName(person(expense.payer)), depositUsedFrom: safeParticipantName(person(expense.depositUsedFrom)), split: split.map(safeParticipantName), splitAmounts };
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
  // A "paid from deposit" expense owns exactly one withdrawal row; this
  // column points that row back at its expense so the two can be
  // created, submitted, approved, rejected and deleted as one unit.
  await query('ALTER TABLE deposits ADD COLUMN IF NOT EXISTS linked_expense_id TEXT');
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

// Deterministic id for the withdrawal that belongs to an expense, so the
// client can predict it and retries can't create a second one.
function withdrawalIdFor(expenseId) { return ('wd-' + expenseId).slice(0, 60); }

// A person's spendable deposit balance = APPROVED deposits minus APPROVED
// withdrawals (same rule the frontend uses via isCountable). excludeId
// leaves one row out, used when that row is being edited/replaced.
async function approvedDepositBalance(tripId, person, excludeId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(CASE WHEN COALESCE(type,'deposit')='withdrawal' THEN -amount ELSE amount END), 0) AS bal
       FROM deposits
      WHERE trip_id=$1 AND person=$2
        AND COALESCE(status,'approved') IN ('approved','published')
        AND ($3::text IS NULL OR id <> $3::text)`,
    [tripId, person, excludeId || null]
  );
  return Number(rows[0] && rows[0].bal) || 0;
}
function insufficientBalanceMsg(person, bal, amount) {
  return `${person}'s approved deposit balance is Rs.${Math.max(bal, 0).toFixed(2)} — not enough for Rs.${Number(amount).toFixed(2)}.`;
}

// Expense <-> auto-withdrawal pairing. Returns the OTHER half of the pair
// (plus the withdrawal's own details, needed for the balance check), or
// null when the record isn't part of a pair.
async function getLinkedPair(tripId, recordType, record) {
  if (recordType === 'expense') {
    const { rows } = await query(
      'SELECT id, status, person, amount FROM deposits WHERE trip_id=$1 AND linked_expense_id=$2 LIMIT 1', [tripId, record.id]);
    if (!rows.length) return null;
    return { table: 'deposits', id: rows[0].id, status: rows[0].status || 'approved',
      withdrawal: { id: rows[0].id, person: rows[0].person, amount: Number(rows[0].amount) } };
  }
  if (recordType === 'deposit' && record.linked_expense_id) {
    const { rows } = await query('SELECT id, status FROM expenses WHERE trip_id=$1 AND id=$2', [tripId, record.linked_expense_id]);
    if (!rows.length) return null;
    return { table: 'expenses', id: rows[0].id, status: rows[0].status || 'approved',
      withdrawal: { id: record.id, person: record.person, amount: Number(record.amount) } };
  }
  return null;
}

// A "self-only" expense: the actor paid it themselves, out of their own
// pocket (not from the shared deposit pool), and the only person in the
// split is that same actor. Nobody else owes or is owed anything on it, so
// there is nothing for an admin to review — a non-admin's self-only expense
// is auto-approved instead of entering the approval queue. Anything that
// involves another person, a deposit, or an unpaid/pre-logged record still
// goes through normal approval. Enforced here (not just in the UI) so it
// can't be spoofed from the frontend: `actor` comes from the session.
function isSelfOnlyExpense(payload, actor) {
  const norm = (v) => String(v || '').trim().toLowerCase();
  const me = norm(actor);
  if (!me || payload.unpaid || payload.paidFromDeposit) return false;
  if (norm(payload.payer) !== me) return false;
  const split = Array.isArray(payload.split) ? payload.split : [];
  return split.length > 0 && split.every((p) => norm(p) === me);
}
const AUTO_APPROVED_BY = 'auto (self-only expense)';

// Phase 7 visibility rule: everyone sees every APPROVED or PUBLISHED
// record (that's the shared, settled truth of the trip's finances); a
// non-admin also sees their own not-yet-approved records (their own
// drafts/pending/rejected stay visible to them so they can find and
// resubmit/edit them), but not anyone else's. Admins see everything, at
// every status, since they're the ones who have to review the pending
// queue. ownerField is the camelCase field name on the already-mapped
// record (createdBy / actor / loggedBy) that readState()'s three .map()
// calls produce.
function filterVisible(records, ownerField, viewer) {
  const base = viewer.isAdmin
    ? records
    : records.filter((r) => r.status === 'approved' || r.status === 'published' || r[ownerField] === viewer.name);
  // Self-only expenses (auto-approved, see isSelfOnlyExpense) are private:
  // only the person who logged them sees them — not other participants and
  // not admins either.
  return base.filter((r) => r.approvedBy !== AUTO_APPROVED_BY || r[ownerField] === viewer.name);
}

// Maps a record's raw DB approval columns onto the camelCase shape the
// frontend expects. This was being called from readState() below without
// ever being defined — that ReferenceError is what was 500-ing every
// wallet GET and POST (any request that reaches readState() at the end).
function approvalFields(r) {
  return {
    status: r.status || 'approved',
    submittedBy: r.submitted_by,
    submittedAt: r.submitted_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    rejectedBy: r.rejected_by,
    rejectedAt: r.rejected_at,
    rejectionReason: r.rejection_reason,
  };
}

async function readState(tripId, viewer) {
  await ensureWalletLockSchema();
  await ensureApprovalSchema();
  await ensureUnpaidExpenseSchema();
  await ensureSharedWalletStateSchema();
  const [expenses, settlements, deposits, activity, trip, adjustments, aliases] = await Promise.all([
    query('SELECT * FROM expenses WHERE trip_id=$1 ORDER BY created_at', [tripId]),
    query('SELECT * FROM settlements WHERE trip_id=$1 ORDER BY ts', [tripId]),
    query('SELECT * FROM deposits WHERE trip_id=$1 ORDER BY ts', [tripId]),
    query('SELECT * FROM activity WHERE trip_id=$1 ORDER BY ts', [tripId]),
    query('SELECT wallet_participants, wallet_locked FROM trips WHERE id=$1', [tripId]),
    query('SELECT id, person, amount, note, actor, ts FROM wallet_adjustments WHERE trip_id=$1 ORDER BY ts', [tripId]),
    query('SELECT source_name, target_name FROM wallet_participant_aliases WHERE trip_id=$1', [tripId]),
  ]);
  const aliasMap = Object.fromEntries(aliases.rows.map((r) => [r.source_name, r.target_name]));
  const person = (name) => resolveAlias(name, aliasMap);
  const mappedExpenses = expenses.rows.map((r) => ({
    id: safeRecordId(r.id), title: r.title, category: r.category, amount: Number(r.amount), payer: r.payer,
    split: r.split || [], date: r.date, createdBy: r.created_by, createdAt: r.created_at,
    updatedBy: r.updated_by, updatedAt: r.updated_at, splitType: r.split_type,
    splitAmounts: r.split_amounts, paidFromDeposit: r.paid_from_deposit, depositUsedFrom: r.deposit_used_from,
    unpaid: !!r.unpaid,
    ...approvalFields(r),
  })).map((r) => remapExpensePeople(r, person));
  const mappedSettlements = settlements.rows.map((r) => ({
    id: safeRecordId(r.id), from: safeParticipantName(person(r.from_person)), to: safeParticipantName(person(r.to_person)), amount: Number(r.amount), note: r.note,
    actor: r.actor, ts: r.ts, usedDeposit: r.used_deposit,
    ...approvalFields(r),
  }));
  const mappedDeposits = deposits.rows.map((r) => ({
    id: safeRecordId(r.id), person: safeParticipantName(person(r.person)), amount: Number(r.amount), date: r.date, note: r.note,
    loggedBy: r.logged_by, ts: r.ts, type: normalizeDepositType(r.type), linkedExpenseId: r.linked_expense_id || null,
    ...approvalFields(r),
  }));
  return {
    expenses: filterVisible(mappedExpenses, 'createdBy', viewer),
    settlements: filterVisible(mappedSettlements, 'actor', viewer),
    deposits: filterVisible(mappedDeposits, 'loggedBy', viewer),
    activity: activity.rows.map((r) => ({ id: r.id, ts: r.ts, actor: safeParticipantName(person(r.actor)), action: r.action, detail: r.detail })),
    adjustments: adjustments.rows.map((r) => ({ id: safeRecordId(r.id), person: safeParticipantName(person(r.person)), amount: Number(r.amount), note: r.note, actor: safeParticipantName(r.actor), ts: r.ts })),
    participantAliases: aliasMap,
    participants: ((trip.rows[0] && trip.rows[0].wallet_participants) || []).map(person).map(safeParticipantName).filter((name) => name !== 'Unknown participant'),
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
    // removeExpense/removeSettlement/deleteDeposit are always admin-only
    // too, lock state aside — a normal participant can add/edit their own
    // records (and those still go through the approval queue), but
    // deleting a record removes it outright with no review step, so that
    // stays admin-only the same way resetWallet/approveRecord do.
    const ALWAYS_ADMIN_ACTIONS = ['resetWallet', 'approveRecord', 'rejectRecord', 'removeExpense', 'removeSettlement', 'deleteDeposit', 'addAdjustment', 'deleteAdjustment', 'renameParticipant', 'mergeParticipant'];
    const locked = await getWalletLockState(tripId);
    // Exception: a user may delete their OWN self-only expense (private,
    // never reviewed by anyone) — unless the wallet is locked.
    let ownSelfOnlyDelete = false;
    if (action === 'removeExpense' && !isAdmin && !locked) {
      const { rows: own } = await query(
        'SELECT created_by, approved_by FROM expenses WHERE trip_id=$1 AND id=$2', [tripId, payload && payload.id]
      );
      ownSelfOnlyDelete = own.length > 0 && own[0].approved_by === AUTO_APPROVED_BY && own[0].created_by === actor;
    }
    const requiresAdmin = (ALWAYS_ADMIN_ACTIONS.includes(action) && !ownSelfOnlyDelete) || locked;
    if (requiresAdmin && !isAdmin) {
      return unauthorized(
        action === 'resetWallet'
          ? 'Resetting the wallet requires an admin session — please log in as admin.'
          : action === 'approveRecord' || action === 'rejectRecord'
          ? 'Approving or rejecting records requires an admin session — please log in as admin.'
          : action === 'removeExpense' || action === 'removeSettlement' || action === 'deleteDeposit'
          ? 'Deleting records requires an admin session — please log in as admin.'
          : 'The wallet is locked for final submission — only admins can make changes now. Please log in as admin.'
      );
    }

    const validationError = validatePayload(SCHEMAS[action], payload) || validateSplitAmounts(action, payload) || validateSafeWalletInput(action, payload);
    if (validationError) return badRequest(validationError);
    if (action === 'resetWallet' && payload.confirm !== RESET_CONFIRM_PHRASE) {
      return badRequest('Reset not confirmed — missing or incorrect confirmation phrase.');
    }

    // Needed before any of the branches below touch status/submitted_by/
    // approved_by/etc, whether that's an INSERT (add*) or an UPDATE
    // (submitForApproval/approveRecord/rejectRecord).
    await ensureApprovalSchema();
    await ensureUnpaidExpenseSchema();
    await ensureSharedWalletStateSchema();

    if (action === 'addExpense' || action === 'editExpense') {
      // Conditional payer requirement: schema no longer enforces it
      // unconditionally (see the SCHEMAS comment above), so a normal
      // expense that isn't explicitly marked unpaid still needs one.
      const isUnpaid = !!payload.unpaid;
      if (!isUnpaid && !sanitizeText(payload.payer, 80)) {
        return badRequest('Pick who paid, or mark this as a pre-logged / not-yet-paid expense.');
      }
    }

    if (action === 'addExpense') {
      const amount = sanitizeNumber(payload.amount, 0, 10000000) || 0;
      const splitType = payload.splitType === 'individual' ? 'individual' : 'equal';
      const isUnpaid = !!payload.unpaid;
      const selfOnly = !isAdmin && isSelfOnlyExpense(payload, actor);
      // Paid-from-deposit: the expense and its withdrawal are created in ONE
      // statement (a data-modifying CTE), so either both rows exist or
      // neither does — the old client flow sent them as separate writes and
      // could leave an expense without a withdrawal or vice versa.
      const depositPerson = sanitizeText(payload.depositUsedFrom || '', 80);
      const fromDeposit = !!payload.paidFromDeposit;
      if (fromDeposit) {
        if (isUnpaid) return badRequest("A pre-logged / unpaid expense can't also be paid from a deposit.");
        if (!depositPerson) return badRequest("Pick whose deposit this expense is paid from.");
        if (!(amount > 0)) return badRequest('Amount must be greater than 0 to pay from a deposit.');
        const bal = await approvedDepositBalance(tripId, depositPerson, null);
        if (amount > bal + 0.005) return badRequest(insufficientBalanceMsg(depositPerson, bal, amount));
      }
      const expenseInsertSql = `INSERT INTO expenses (id, trip_id, title, category, amount, payer, split, date, created_by, split_type,
           split_amounts, paid_from_deposit, deposit_used_from, status, unpaid, approved_by, approved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$15,$14,$16,$17)`;
      const withdrawalCte = `WITH wd AS (
           INSERT INTO deposits (id, trip_id, person, amount, date, note, logged_by, type, status, linked_expense_id)
           VALUES ($18,$19,$20,$21,$22,$23,$24,'withdrawal','draft',$25) RETURNING id
         ) `;
      await query(
        (fromDeposit ? withdrawalCte : '') + expenseInsertSql,
        [
          sanitizeText(payload.id, 60), tripId, sanitizeText(payload.title, 120), sanitizeText(payload.category || 'Misc', 40),
          amount, isUnpaid ? '' : sanitizeText(payload.payer, 80), JSON.stringify((payload.split || []).map((s) => sanitizeText(s, 80))),
          sanitizeText(payload.date || '', 20), actor, splitType,
          payload.splitAmounts ? JSON.stringify(payload.splitAmounts) : null,
          !!payload.paidFromDeposit, sanitizeText(payload.depositUsedFrom || '', 80), isUnpaid,
          selfOnly ? 'approved' : 'draft', selfOnly ? AUTO_APPROVED_BY : null, selfOnly ? new Date().toISOString() : null,
          ...(fromDeposit ? [
            withdrawalIdFor(sanitizeText(payload.id, 60)), tripId, depositPerson, amount, sanitizeText(payload.date || '', 20),
            sanitizeText(`Paid for: ${sanitizeText(payload.title, 120)}`, 200), actor, sanitizeText(payload.id, 60),
          ] : []),
        ]
      );
      // Private self-only expenses leave no trace in the shared activity log.
      if (!selfOnly) await logActivity(
        tripId, payload.id, actor, 'add_expense',
        isUnpaid
          ? `${sanitizeText(payload.title, 120)} (Rs.${amount}) — pre-logged, not yet paid`
          : `${sanitizeText(payload.title, 120)} (Rs.${amount})`
      );
    } else if (action === 'editExpense') {
      const amount = sanitizeNumber(payload.amount, 0, 10000000) || 0;
      const splitType = payload.splitType === 'individual' ? 'individual' : 'equal';
      const isUnpaid = !!payload.unpaid;
      // A non-admin editing their own expense sends it back to 'draft' and
      // clears any prior approval/rejection — otherwise a participant could
      // get a record approved, then edit the amount afterward with no
      // re-approval step, which defeats the point of having one. Admin
      // edits don't reset status, since admins are the approvers and this
      // is mainly a correction/typo-fix path for them, not a resubmission.
      // Exception: a self-only expense (see isSelfOnlyExpense) stays/goes
      // auto-approved, since nobody else is affected.
      // Only the record's own creator can make it self-only (otherwise
      // someone could hide another person's expense by editing it).
      let ownsRecord = false;
      if (!isAdmin) {
        const { rows: cur } = await query('SELECT created_by FROM expenses WHERE trip_id=$1 AND id=$2', [tripId, payload.id]);
        ownsRecord = cur.length > 0 && cur[0].created_by === actor;
      }
      const selfOnly = !isAdmin && ownsRecord && isSelfOnlyExpense(payload, actor);

      // Keep the paired withdrawal consistent with the edited expense, and
      // validate BEFORE touching anything so a rejected edit changes nothing.
      const depositPerson = sanitizeText(payload.depositUsedFrom || '', 80);
      if (payload.paidFromDeposit && isUnpaid) return badRequest("A pre-logged / unpaid expense can't also be paid from a deposit.");
      if (payload.paidFromDeposit && !depositPerson) return badRequest('Pick whose deposit this expense is paid from.');
      const wantsDeposit = !!payload.paidFromDeposit;
      const { rows: curExp } = await query('SELECT paid_from_deposit, status FROM expenses WHERE trip_id=$1 AND id=$2', [tripId, payload.id]);
      const { rows: linkedRows } = await query('SELECT id, status FROM deposits WHERE trip_id=$1 AND linked_expense_id=$2', [tripId, payload.id]);
      const linked = linkedRows[0] || null;
      // Expenses created before the pairing existed have a withdrawal we
      // can't identify — leave those alone rather than creating a duplicate.
      const legacyPaidFromDeposit = !!(curExp[0] && curExp[0].paid_from_deposit) && !linked;
      if (wantsDeposit && !legacyPaidFromDeposit) {
        if (!(amount > 0)) return badRequest('Amount must be greater than 0 to pay from a deposit.');
        const bal = await approvedDepositBalance(tripId, depositPerson, linked ? linked.id : null);
        if (amount > bal + 0.005) return badRequest(insufficientBalanceMsg(depositPerson, bal, amount));
      }
      const statusClause = isAdmin ? '' : selfOnly
        ? `, status='approved', submitted_by=NULL, submitted_at=NULL, approved_by='${AUTO_APPROVED_BY}', approved_at=now(),
           rejected_by=NULL, rejected_at=NULL, rejection_reason=NULL`
        : `, status='draft', submitted_by=NULL, submitted_at=NULL,
           approved_by=NULL, approved_at=NULL, rejected_by=NULL, rejected_at=NULL, rejection_reason=NULL`;
      await query(
        `UPDATE expenses SET title=$3, category=$4, amount=$5, payer=$6, split=$7, date=$8, updated_by=$9,
           updated_at=now(), split_type=$10, split_amounts=$11, paid_from_deposit=$12, deposit_used_from=$13,
           unpaid=$14${statusClause}
         WHERE trip_id=$1 AND id=$2`,
        [
          tripId, sanitizeText(payload.id, 60), sanitizeText(payload.title, 120), sanitizeText(payload.category || 'Misc', 40),
          amount, isUnpaid ? '' : sanitizeText(payload.payer, 80), JSON.stringify((payload.split || []).map((s) => sanitizeText(s, 80))),
          sanitizeText(payload.date || '', 20), actor, splitType,
          payload.splitAmounts ? JSON.stringify(payload.splitAmounts) : null,
          !!payload.paidFromDeposit, sanitizeText(payload.depositUsedFrom || '', 80), isUnpaid,
        ]
      );
      const wdNote = sanitizeText(`Paid for: ${sanitizeText(payload.title, 120)}`, 200);
      const wdDate = sanitizeText(payload.date || '', 20);
      if (linked && !wantsDeposit) {
        await query('DELETE FROM deposits WHERE trip_id=$1 AND id=$2', [tripId, linked.id]);
      } else if (linked && wantsDeposit) {
        // A non-admin edit sends the expense back to draft, so its withdrawal goes back too.
        const wdReset = isAdmin ? '' : `, status='draft', submitted_by=NULL, submitted_at=NULL,
           approved_by=NULL, approved_at=NULL, rejected_by=NULL, rejected_at=NULL, rejection_reason=NULL`;
        await query(
          `UPDATE deposits SET person=$3, amount=$4, date=$5, note=$6${wdReset} WHERE trip_id=$1 AND id=$2`,
          [tripId, linked.id, depositPerson, amount, wdDate, wdNote]
        );
      } else if (!linked && wantsDeposit && !legacyPaidFromDeposit) {
        // Admin edits keep the expense's status (see above), so the new
        // withdrawal mirrors it; non-admin edits always restart at draft.
        const expStatus = (curExp[0] && curExp[0].status) || 'draft';
        const wdStatus = isAdmin && expStatus !== 'rejected' ? expStatus : 'draft';
        await query(
          `INSERT INTO deposits (id, trip_id, person, amount, date, note, logged_by, type, status, linked_expense_id, approved_by, approved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'withdrawal',$8,$9,$10,$11)`,
          [withdrawalIdFor(sanitizeText(payload.id, 60)), tripId, depositPerson, amount, wdDate, wdNote, actor, wdStatus,
            sanitizeText(payload.id, 60), wdStatus === 'approved' ? actor : null, wdStatus === 'approved' ? new Date().toISOString() : null]
        );
      }
      // Editing an unpaid record to finally add a payer (isUnpaid now
      // false, but the row previously had none) is the "someone settled
      // this" moment — worth its own activity-log wording rather than a
      // generic edit, same idea as the pre-logged note on add above.
      // Private self-only expenses leave no trace in the shared activity log.
      if (!selfOnly) await logActivity(
        tripId, payload.id, actor, 'edit_expense',
        isUnpaid
          ? `${sanitizeText(payload.title, 120)} (Rs.${amount}) — pre-logged, not yet paid`
          : `${sanitizeText(payload.title, 120)} (Rs.${amount})`
      );
    } else if (action === 'removeExpense') {
      await query(
        `WITH wd AS (DELETE FROM deposits WHERE trip_id=$1 AND linked_expense_id=$2)
         DELETE FROM expenses WHERE trip_id=$1 AND id=$2`,
        [tripId, payload.id]
      );
      // Private self-only deletions leave no trace in the shared activity log.
      if (!ownSelfOnlyDelete) await logActivity(tripId, payload.id, actor, 'remove_expense', payload.id);
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
      if (type === 'withdrawal') {
        const bal = await approvedDepositBalance(tripId, sanitizeText(payload.person, 80), null);
        if (amount > bal + 0.005) return badRequest(insufficientBalanceMsg(sanitizeText(payload.person, 80), bal, amount));
      }
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
      const { rows: depRows } = await query('SELECT linked_expense_id FROM deposits WHERE trip_id=$1 AND id=$2', [tripId, payload.id]);
      if (depRows[0] && depRows[0].linked_expense_id) {
        return badRequest('This withdrawal belongs to an expense — edit the expense instead.');
      }
      if (type === 'withdrawal') {
        const bal = await approvedDepositBalance(tripId, sanitizeText(payload.person, 80), sanitizeText(payload.id, 60));
        if (amount > bal + 0.005) return badRequest(insufficientBalanceMsg(sanitizeText(payload.person, 80), bal, amount));
      }
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
      const { rows: delRows } = await query('SELECT linked_expense_id FROM deposits WHERE trip_id=$1 AND id=$2', [tripId, payload.id]);
      if (delRows[0] && delRows[0].linked_expense_id) {
        return badRequest('This withdrawal belongs to an expense — delete or edit the expense instead.');
      }
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
      const pair = await getLinkedPair(tripId, payload.recordType, record);
      const submitSet = `status='pending_approval', submitted_by=$3, submitted_at=now(),
           approved_by=NULL, approved_at=NULL, rejected_by=NULL, rejected_at=NULL, rejection_reason=NULL`;
      if (pair) {
        // One statement: the expense and its withdrawal enter the queue together.
        await query(
          `WITH a AS (UPDATE ${record._table} SET ${submitSet} WHERE trip_id=$1 AND id=$2 RETURNING id)
           UPDATE ${pair.table} SET ${submitSet} WHERE trip_id=$1 AND id=$4 AND status IN ('draft','rejected')`,
          [tripId, payload.id, actor, pair.id]
        );
      } else {
        await query(`UPDATE ${record._table} SET ${submitSet} WHERE trip_id=$1 AND id=$2`, [tripId, payload.id, actor]);
      }
      await logActivity(tripId, payload.id, actor, 'submit_for_approval', `${payload.recordType} ${payload.id}`);
      // Phone push to the admins. Awaited (a Netlify Function may be frozen once
      // the handler returns) but internally time-boxed and never throws, so a
      // Telegram hiccup can't fail the submit. A paid-from-deposit expense and
      // its withdrawal are submitted together and produce ONE message (the
      // primary record), not two.
      await notifyAdminsPendingApproval({ tripId, recordType: payload.recordType, record, submittedBy: actor });
    } else if (action === 'approveRecord') {
      const record = await getRecordForApproval(tripId, payload.recordType, payload.id);
      if (!record) return badRequest('Record not found.');
      if (record.status !== 'pending_approval') {
        return badRequest('Only records pending approval can be approved.');
      }
      const pair = await getLinkedPair(tripId, payload.recordType, record);
      if (pair && pair.status !== 'pending_approval') {
        return badRequest('The linked expense/withdrawal pair is out of sync — ask the submitter to edit and resubmit it.');
      }
      // The authoritative overdraw gate: a withdrawal (standalone or the half
      // of a paid-from-deposit expense) may only be approved while it still
      // fits inside the person's APPROVED balance right now. Two pending
      // withdrawals that each looked fine at submit time can't both pass.
      const wd = pair ? pair.withdrawal
        : (payload.recordType === 'deposit' && normalizeDepositType(record.type) === 'withdrawal'
          ? { id: record.id, person: record.person, amount: Number(record.amount) } : null);
      if (wd) {
        const bal = await approvedDepositBalance(tripId, wd.person, wd.id);
        if (wd.amount > bal + 0.005) {
          return badRequest(`Can't approve: ${insufficientBalanceMsg(wd.person, bal, wd.amount)}`);
        }
      }
      const approveSet = `status='approved', approved_by=$3, approved_at=now(),
           rejected_by=NULL, rejected_at=NULL, rejection_reason=NULL`;
      if (pair) {
        await query(
          `WITH a AS (UPDATE ${record._table} SET ${approveSet} WHERE trip_id=$1 AND id=$2 RETURNING id)
           UPDATE ${pair.table} SET ${approveSet} WHERE trip_id=$1 AND id=$4 AND status='pending_approval'`,
          [tripId, payload.id, actor, pair.id]
        );
      } else {
        await query(`UPDATE ${record._table} SET ${approveSet} WHERE trip_id=$1 AND id=$2`, [tripId, payload.id, actor]);
      }
      await logActivity(tripId, payload.id, actor, 'approve_record', `${payload.recordType} ${payload.id}`);
    } else if (action === 'rejectRecord') {
      const record = await getRecordForApproval(tripId, payload.recordType, payload.id);
      if (!record) return badRequest('Record not found.');
      if (record.status !== 'pending_approval') {
        return badRequest('Only records pending approval can be rejected.');
      }
      const reason = sanitizeText(payload.reason || '', 300);
      const pair = await getLinkedPair(tripId, payload.recordType, record);
      const rejectSet = `status='rejected', rejected_by=$3, rejected_at=now(), rejection_reason=$4,
           approved_by=NULL, approved_at=NULL`;
      if (pair) {
        await query(
          `WITH a AS (UPDATE ${record._table} SET ${rejectSet} WHERE trip_id=$1 AND id=$2 RETURNING id)
           UPDATE ${pair.table} SET ${rejectSet} WHERE trip_id=$1 AND id=$5 AND status='pending_approval'`,
          [tripId, payload.id, actor, reason, pair.id]
        );
      } else {
        await query(`UPDATE ${record._table} SET ${rejectSet} WHERE trip_id=$1 AND id=$2`, [tripId, payload.id, actor, reason]);
      }
      await logActivity(tripId, payload.id, actor, 'reject_record', `${payload.recordType} ${payload.id}${reason ? `: ${reason}` : ''}`);
    } else if (action === 'addAdjustment') {
      if (!payload.amount) return badRequest('Adjustment amount cannot be zero.');
      await query(
        'INSERT INTO wallet_adjustments (id, trip_id, person, amount, note, actor) VALUES ($1,$2,$3,$4,$5,$6)',
        [payload.id, tripId, sanitizeText(payload.person, 80), payload.amount, sanitizeText(payload.note, 200), actor]
      );
      await logActivity(tripId, payload.id, actor, 'add_adjustment', `${payload.person}: Rs.${payload.amount} (${payload.note})`);
    } else if (action === 'deleteAdjustment') {
      await query('DELETE FROM wallet_adjustments WHERE trip_id=$1 AND id=$2', [tripId, payload.id]);
      await logActivity(tripId, payload.id, actor, 'delete_adjustment', payload.id);
    } else if (action === 'renameParticipant' || action === 'mergeParticipant') {
      const source = sanitizeText(action === 'renameParticipant' ? payload.oldName : payload.source, 80);
      const target = sanitizeText(action === 'renameParticipant' ? payload.newName : payload.target, 80);
      if (source === target) return badRequest('Choose a different participant name.');
      await query('UPDATE wallet_participant_aliases SET target_name=$3 WHERE trip_id=$1 AND target_name=$2', [tripId, source, target]);
      await query(`INSERT INTO wallet_participant_aliases (trip_id, source_name, target_name) VALUES ($1,$2,$3)
        ON CONFLICT (trip_id, source_name) DO UPDATE SET target_name=EXCLUDED.target_name`, [tripId, source, target]);
      await logActivity(tripId, `participant_${crypto.randomUUID()}`, actor,
        action === 'renameParticipant' ? 'rename_participant' : 'merge_participant', `${source} -> ${target}`);
    } else if (action === 'resetWallet') {
      await query('DELETE FROM expenses WHERE trip_id=$1', [tripId]);
      await query('DELETE FROM settlements WHERE trip_id=$1', [tripId]);
      await query('DELETE FROM deposits WHERE trip_id=$1', [tripId]);
      await query('DELETE FROM activity WHERE trip_id=$1', [tripId]);
      await query('DELETE FROM wallet_adjustments WHERE trip_id=$1', [tripId]);
      await query('DELETE FROM wallet_participant_aliases WHERE trip_id=$1', [tripId]);
      await logActivity(tripId, `reset_${crypto.randomUUID()}`, actor, 'reset_wallet', 'Wallet reset');
    }

    return ok(await readState(tripId, { name: actor, isAdmin }));
  } catch (err) {
    return serverError(err);
  }
};
