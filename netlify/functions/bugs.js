// Bug reports + the admin "Fix Bug" todo board, backed by Neon Postgres.
//  - Public:  GET  ?action=public[&v=<version>]   live status of user-reported bugs (no contact info)
//             POST {action:'report', payload}     submit a bug (rate-limited, honeypot)
//  - Admin:   POST {action:'list'|'count'|'save'|'delete'|'importLocal', token, ...}  (admin session required)
// "Live" = version polling: every response carries a version (row count + newest update);
// clients send it back as `v` and get {unchanged:true} until something in the table changes.
const { query } = require('./lib/db');
const { ok, badRequest, unauthorized, serverError, parseBody } = require('./lib/http');
const { sanitizeText } = require('./lib/validate');
const { requireAdminSession } = require('./admin');
const SEED = require('./lib/bug-seed.json'); // prebuilt tasks moved out of the old HTML; used once, see ensureSchema()

const CATEGORIES = ['Bug Fix', 'Sync/API', 'Feature', 'Adjustment', 'General'];
const PRIORITIES = ['High', 'Medium', 'Low'];
const STATUSES = ['To Do', 'In Progress', 'Completed'];

let ready = false;
async function ensureSchema() {
  if (ready) return;
  await query(`CREATE TABLE IF NOT EXISTS bug_reports (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Bug Fix',
    priority TEXT NOT NULL DEFAULT 'Medium',
    status TEXT NOT NULL DEFAULT 'To Do',
    due_date TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    tag TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'admin',          -- 'seed' | 'user' | 'admin'
    is_public BOOLEAN NOT NULL DEFAULT false,      -- shown on the public Report a Bug status board
    reporter_name TEXT NOT NULL DEFAULT '',
    reporter_contact TEXT NOT NULL DEFAULT '',
    page TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS bug_meta (key TEXT PRIMARY KEY, value TEXT)`);
  // One-time seed. The marker row (not "table is empty") decides, so deleting every task never re-seeds.
  const { rows } = await query(`INSERT INTO bug_meta (key, value) VALUES ('seeded_v1', now()::text) ON CONFLICT DO NOTHING RETURNING key`);
  if (rows.length) {
    for (const t of SEED) {
      await query(
        `INSERT INTO bug_reports (id, title, category, priority, status, due_date, description, tag, source, is_public, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'seed',false,'seed') ON CONFLICT (id) DO NOTHING`,
        [t.id, t.title, t.category, t.priority, t.status, t.dueDate || '', t.description || '', t.tag || '']
      );
    }
  }
  ready = true;
}

async function version() {
  const { rows } = await query(`SELECT count(*)::int AS n, coalesce(extract(epoch from max(updated_at)),0)::text AS m FROM bug_reports`);
  return `${rows[0].n}:${rows[0].m}`;
}
// Aggregate counts over ALL tasks (public and admin-only). Numbers only, so nothing about individual admin-only tasks is exposed.
async function stats() {
  const { rows } = await query(`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE status = 'In Progress')::int AS in_progress,
    count(*) FILTER (WHERE status = 'Completed')::int AS fixed,
    count(*) FILTER (WHERE priority = 'High' AND status <> 'Completed')::int AS high_open FROM bug_reports`);
  const r = rows[0];
  return { total: r.total, inProgress: r.in_progress, fixed: r.fixed, highOpen: r.high_open };
}
const adminRow = (r) => ({
  id: r.id, title: r.title, category: r.category, priority: r.priority, status: r.status, dueDate: r.due_date,
  description: r.description, tag: r.tag, source: r.source, isPublic: r.is_public, reporterName: r.reporter_name,
  reporterContact: r.reporter_contact, page: r.page, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at,
});
// Public view: only rows flagged is_public, and never contact details or internal descriptions.
const publicRow = (r) => ({ id: r.id, title: r.title, category: r.category, status: r.status, page: r.page, createdAt: r.created_at, updatedAt: r.updated_at });

function clean(p) {
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  return {
    title: sanitizeText(p.title, 160), category: pick(p.category, CATEGORIES, 'General'),
    priority: pick(p.priority, PRIORITIES, 'Medium'), status: pick(p.status, STATUSES, 'To Do'),
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(p.dueDate || '') ? p.dueDate : '', description: sanitizeText(p.description, 4000),
    tag: sanitizeText(p.tag, 40), isPublic: !!p.isPublic,
  };
}

const hits = new Map(); // ip -> timestamps; best-effort per warm instance (same approach as admin.js)
function allowReport(ip) {
  const now = Date.now();
  const h = (hits.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (h.length >= 5) return false;
  h.push(now); hits.set(ip, h);
  return true;
}

exports.handler = async (event) => {
  try {
    await ensureSchema();
    const params = event.queryStringParameters || {};

    if (event.httpMethod === 'GET') {
      if ((params.action || 'public') !== 'public') return badRequest('Unknown action.');
      const v = await version();
      if (params.v && params.v === v) return ok({ unchanged: true, version: v });
      const { rows } = await query(`SELECT * FROM bug_reports WHERE is_public = true ORDER BY created_at DESC LIMIT 200`);
      return ok({ version: v, stats: await stats(), bugs: rows.map(publicRow) });
    }

    if (event.httpMethod !== 'POST') return badRequest('Unsupported method.');
    const body = parseBody(event);
    if (!body) return badRequest('Invalid JSON body.');

    if (body.action === 'report') {
      const p = body.payload || {};
      if (p.website) return ok({ ok: true }); // honeypot: bots fill hidden fields, silently drop
      const ip = (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'])) || 'unknown';
      if (!allowReport(ip)) return badRequest('Too many reports from this connection — please try again later.');
      const title = sanitizeText(p.title, 160);
      const description = sanitizeText(p.description, 2000);
      if (title.length < 4) return badRequest('Please give the bug a short title.');
      if (description.length < 10) return badRequest('Please describe what went wrong (at least a sentence).');
      const id = 'bug-u-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const cat = CATEGORIES.includes(p.category) ? p.category : 'Bug Fix';
      await query(
        `INSERT INTO bug_reports (id, title, category, priority, status, description, tag, source, is_public, reporter_name, reporter_contact, page, updated_by)
         VALUES ($1,$2,$3,'Medium','To Do',$4,'New','user',true,$5,$6,$7,'')`,
        [id, title, cat, description, sanitizeText(p.name, 80), sanitizeText(p.contact, 120), sanitizeText(p.page, 80)]
      );
      return ok({ ok: true, id });
    }

    // ---- everything below needs a live admin session (revoked / logged-out admins are rejected) ----
    const admin = await requireAdminSession(body.token);
    if (!admin) return unauthorized('Session expired or invalid — please log in again from the admin console.');
    const who = admin.name;

    if (body.action === 'count') {
      const { rows } = await query(`SELECT count(*) FILTER (WHERE status <> 'Completed')::int AS open,
        count(*) FILTER (WHERE status = 'To Do' AND source = 'user')::int AS fresh FROM bug_reports`);
      return ok(rows[0]);
    }
    if (body.action === 'list') {
      const v = await version();
      if (body.v && body.v === v) return ok({ unchanged: true, version: v });
      const { rows } = await query(`SELECT * FROM bug_reports ORDER BY created_at DESC, id`);
      return ok({ version: v, bugs: rows.map(adminRow), me: who });
    }
    if (body.action === 'save') {
      const p = body.payload || {};
      const c = clean(p);
      if (!c.title) return badRequest('Title is required.');
      const id = sanitizeText(p.id, 60);
      if (id) {
        const { rows } = await query(
          `UPDATE bug_reports SET title=$2, category=$3, priority=$4, status=$5, due_date=$6, description=$7, tag=$8,
             is_public=$9, updated_by=$10, updated_at=now() WHERE id=$1 RETURNING *`,
          [id, c.title, c.category, c.priority, c.status, c.dueDate, c.description, c.tag, c.isPublic, who]);
        if (!rows.length) return badRequest('Task not found — it may have been deleted.');
        return ok({ ok: true, bug: adminRow(rows[0]) });
      }
      const newId = 'task-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const { rows } = await query(
        `INSERT INTO bug_reports (id, title, category, priority, status, due_date, description, tag, source, is_public, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'admin',$9,$10) RETURNING *`,
        [newId, c.title, c.category, c.priority, c.status, c.dueDate, c.description, c.tag, c.isPublic, who]);
      return ok({ ok: true, bug: adminRow(rows[0]) });
    }
    if (body.action === 'delete') {
      const id = sanitizeText(body.id, 60);
      await query('DELETE FROM bug_reports WHERE id = $1', [id]);
      return ok({ ok: true });
    }
    // One-time move of a board saved in the old standalone HTML's localStorage into the database.
    if (body.action === 'importLocal') {
      const list = Array.isArray(body.tasks) ? body.tasks.slice(0, 300) : [];
      let n = 0;
      for (const t of list) {
        const c = clean(t);
        const id = sanitizeText(t.id, 60);
        if (!id || !c.title) continue;
        await query(
          `INSERT INTO bug_reports (id, title, category, priority, status, due_date, description, tag, source, is_public, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'admin',false,$9)
           ON CONFLICT (id) DO UPDATE SET title=$2, category=$3, priority=$4, status=$5, due_date=$6, description=$7, tag=$8, updated_by=$9, updated_at=now()`,
          [id, c.title, c.category, c.priority, c.status, c.dueDate, c.description, c.tag, who]);
        n++;
      }
      return ok({ ok: true, imported: n });
    }
    return badRequest('Unknown action.');
  } catch (err) {
    return serverError(err);
  }
};
