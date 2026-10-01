// lib/notify.js (lives at netlify/functions/lib/notify.js)
// Chrome / browser push to admin devices via Web Push (VAPID).
//
// Env vars (Netlify):  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (e.g. mailto:you@example.com)
// Never throws, time-boxed, silent no-op until configured, so it can't break approvals.
// The `web-push` package is required lazily so a missing dependency can't crash wallet.js.

const { query } = require('./db');

let schemaEnsured = false;
async function ensurePushSchema() {
  if (schemaEnsured) return;
  await query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL,
    name TEXT,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  schemaEnsured = true;
}

function inr(n) {
  const x = Number(n);
  return '₹' + (Number.isFinite(x) ? x.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '0');
}
function describe(recordType, r) {
  if (recordType === 'expense') return `Expense ${inr(r.amount)} · ${r.title || ''}`;
  if (recordType === 'settlement') return `Settlement ${inr(r.amount)} · ${r.from_person || ''} → ${r.to_person || ''}`;
  const wd = String(r.type || '').toLowerCase() === 'withdrawal';
  return `${wd ? 'Withdrawal' : 'Deposit'} ${inr(r.amount)} · ${r.person || ''}`;
}

async function notifyAdminsPendingApproval({ tripId, recordType, record, submittedBy }) {
  try {
    const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
    if (!pub || !priv || !tripId) {
      console.warn('push: skipped — missing', !pub ? 'VAPID_PUBLIC_KEY' : '', !priv ? 'VAPID_PRIVATE_KEY' : '', !tripId ? 'tripId' : '');
      return; // not configured yet
    }
    const webpush = require('web-push');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', pub, priv);

    await ensurePushSchema();
    const { rows } = await query('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE trip_id=$1', [tripId]);
    console.log('push: approval for trip', tripId, '- subscriptions found:', rows.length);
    if (!rows.length) return;

    const payload = JSON.stringify({
      title: 'Approval needed — GoaTrip Wallet',
      body: `${describe(recordType, record)}\nSubmitted by ${submittedBy}`,
      tag: `approval-${record.id}`,
      url: '/goa-wallet.html',
    });

    await Promise.all(rows.map(async (row) => {
      try {
        const r = await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          payload,
          { TTL: 3600, urgency: 'high', timeout: 4000 }
        );
        console.log('push: sent, status', r && r.statusCode, new URL(row.endpoint).host);
      } catch (e) {
        // 404/410 = the browser unsubscribed or the permission was revoked: drop the dead row.
        if (e && (e.statusCode === 404 || e.statusCode === 410)) {
          try { await query('DELETE FROM push_subscriptions WHERE endpoint=$1', [row.endpoint]); } catch (_) {}
        } else {
          console.warn('push: send failed', e && e.statusCode, e && e.body, new URL(row.endpoint).host);
        }
      }
    }));
  } catch (e) {
    console.warn('push: unexpected failure', e && e.message);
  }
}

module.exports = { notifyAdminsPendingApproval, ensurePushSchema };
