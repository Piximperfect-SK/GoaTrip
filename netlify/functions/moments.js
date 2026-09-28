// Moments: members-only photo/video gallery backed by a PRIVATE Cloudflare R2
// bucket. Files never pass through this function (Netlify caps request
// bodies at ~6 MB) — the browser uploads straight to R2 using a short-lived
// presigned PUT URL that this function hands out, then calls `confirm` so
// the row lands in Postgres. Every action requires a valid session token
// (the same signed token login.js / admin.js issue), which is what makes the
// page "registered members only".
//
// Actions (all POST, JSON body: { action, token, tripId?, ... }):
//   list           -> { items, hasMore, usedBytes, quotaBytes }   (thumb URLs signed)
//   presignUpload  -> { key, uploadUrl, thumbKey?, thumbUploadUrl? }
//   confirm        -> { item }             (verifies the object really exists in R2)
//   getUrl         -> { url }              (short-lived signed URL for viewing/streaming)
//   download       -> { url }              (same, but forces a file download)
//   delete         -> { deleted, skipped } (owner or admin; accepts { id } or { ids })
//   stats          -> { usedBytes, quotaBytes, count }
const crypto = require('crypto');
const {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { query } = require('./lib/db');
const { json, ok, badRequest, unauthorized, serverError, parseBody } = require('./lib/http');
const { sanitizeText, sanitizeNumber } = require('./lib/validate');
const { verifySessionTokenFull } = require('./lib/auth');

// ---------- limits ----------
const QUOTA_BYTES = Math.round(Number(process.env.MOMENTS_QUOTA_GB || 30) * 1024 * 1024 * 1024);
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;   // 50 MB
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB (R2 allows up to 5 GB per single PUT)
const MAX_THUMB_BYTES = 1 * 1024 * 1024;    // 1 MB
const PAGE_SIZE = 40;
const MAX_BULK_DELETE = 50;

const ALLOWED_TYPES = {
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/png': { ext: 'png', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
  'image/avif': { ext: 'avif', kind: 'image' },
  'image/heic': { ext: 'heic', kind: 'image' },
  'image/heif': { ext: 'heif', kind: 'image' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/quicktime': { ext: 'mov', kind: 'video' },
  'video/webm': { ext: 'webm', kind: 'video' },
};

// ---------- R2 client ----------
let s3;
function getS3() {
  if (!s3) {
    const R2_ACCESS_KEY_ID = (process.env.R2_ACCESS_KEY_ID || '').trim();
    const R2_SECRET_ACCESS_KEY = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
    // R2_ACCOUNT_ID should be just the 32-char id, but it's easy to paste the
    // whole S3 endpoint URL (https://<id>.r2.cloudflarestorage.com) instead —
    // that produced a malformed host like "bucket.https://<id>...". Reduce
    // whatever was pasted down to the bare id so both forms work.
    const accountId = (process.env.R2_ACCOUNT_ID || '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .split(/[./]/)[0];
    if (!accountId || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
      throw new Error('R2 credentials are not configured.');
    }
    s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
      // Newer AWS SDK versions add CRC32 checksum params to presigned URLs by
      // default, which R2 then rejects (the browser can't send a matching
      // checksum). Only compute checksums when an operation strictly needs one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return s3;
}
function bucket() {
  const name = (process.env.R2_BUCKET || '').trim();
  if (!name) throw new Error('R2_BUCKET is not configured.');
  return name;
}

// Thumbnails are signed against a signing date rounded down to the hour, so
// the same thumbnail gets the SAME url for up to an hour and the browser can
// cache it (a fresh timestamp on every list call would defeat caching).
function stableSigningDate() {
  return new Date(Math.floor(Date.now() / 3600000) * 3600000);
}

// ---------- schema ----------
let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  await query(`CREATE TABLE IF NOT EXISTS moments (
    id BIGSERIAL PRIMARY KEY,
    trip_id TEXT NOT NULL,
    object_key TEXT UNIQUE NOT NULL,
    thumb_key TEXT,
    kind TEXT NOT NULL,
    mime TEXT NOT NULL,
    filename TEXT,
    size_bytes BIGINT NOT NULL,
    thumb_bytes BIGINT NOT NULL DEFAULT 0,
    width INT,
    height INT,
    duration_s NUMERIC,
    caption TEXT,
    uploaded_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await query('CREATE INDEX IF NOT EXISTS moments_trip_id_idx ON moments (trip_id, id DESC)');
  schemaEnsured = true;
}

// ---------- helpers ----------
function tripSegment(tripId) {
  return String(tripId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function keyPattern(seg) {
  return new RegExp(`^moments/${seg}/\\d{4}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_t)?\\.[a-z0-9]{2,5}$`);
}

function safeFilename(name, fallbackExt) {
  let base = sanitizeText(name || '', 120).replace(/[\\/:*?"<>|]+/g, '_');
  if (!base) base = 'moment.' + fallbackExt;
  return base;
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function usedBytes(tripId) {
  const { rows } = await query(
    'SELECT COALESCE(SUM(size_bytes + thumb_bytes), 0) AS used, COUNT(*) AS n FROM moments WHERE trip_id = $1',
    [tripId]
  );
  return { used: Number(rows[0].used), count: Number(rows[0].n) };
}

async function deleteFromR2(row) {
  const client = getS3();
  await client.send(new DeleteObjectCommand({ Bucket: bucket(), Key: row.object_key }));
  if (row.thumb_key) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket(), Key: row.thumb_key }));
  }
}

async function shapeItem(row, session, withThumbUrl) {
  let thumbUrl = null;
  if (withThumbUrl && row.thumb_key) {
    thumbUrl = await getSignedUrl(
      getS3(),
      new GetObjectCommand({ Bucket: bucket(), Key: row.thumb_key, ResponseCacheControl: 'private, max-age=3600' }),
      { expiresIn: 7200, signingDate: stableSigningDate() }
    );
  }
  return {
    id: Number(row.id),
    kind: row.kind,
    mime: row.mime,
    filename: row.filename,
    sizeBytes: Number(row.size_bytes),
    width: row.width,
    height: row.height,
    durationS: row.duration_s === null ? null : Number(row.duration_s),
    caption: row.caption,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    thumbUrl,
    canDelete: session.role === 'admin' || sameName(row.uploaded_by, session.name),
  };
}

// ---------- actions ----------
async function actionList(tripId, session, body) {
  const before = sanitizeNumber(body.before, 1, Number.MAX_SAFE_INTEGER);
  const kind = body.kind === 'image' || body.kind === 'video' ? body.kind : null;
  const mine = body.mine === true;

  const where = ['trip_id = $1'];
  const params = [tripId];
  if (before !== null) { params.push(before); where.push(`id < $${params.length}`); }
  if (kind) { params.push(kind); where.push(`kind = $${params.length}`); }
  if (mine) { params.push(session.name.trim().toLowerCase()); where.push(`lower(trim(uploaded_by)) = $${params.length}`); }
  params.push(PAGE_SIZE + 1);

  const { rows } = await query(
    `SELECT * FROM moments WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);
  const items = await Promise.all(page.map((r) => shapeItem(r, session, true)));
  const { used } = await usedBytes(tripId);
  return ok({ items, hasMore, nextBefore: page.length ? Number(page[page.length - 1].id) : null, usedBytes: used, quotaBytes: QUOTA_BYTES });
}

async function actionStats(tripId) {
  const { used, count } = await usedBytes(tripId);
  return ok({ usedBytes: used, quotaBytes: QUOTA_BYTES, count });
}

async function actionPresignUpload(tripId, body) {
  const mime = sanitizeText(body.mime || '', 60).toLowerCase();
  const type = ALLOWED_TYPES[mime];
  if (!type) return badRequest('That file type isn\u2019t supported. Use JPG, PNG, WebP, GIF, AVIF, HEIC, MP4, MOV or WebM.');

  const size = sanitizeNumber(body.size, 1, Number.MAX_SAFE_INTEGER);
  if (size === null) return badRequest('File size is required.');
  const cap = type.kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (size > cap) {
    return badRequest(`That file is too large (max ${Math.round(cap / 1024 / 1024)} MB for ${type.kind}s).`);
  }

  const { used } = await usedBytes(tripId);
  if (used + size + MAX_THUMB_BYTES > QUOTA_BYTES) {
    return json(413, { error: 'The Moments storage is full. Ask an admin to delete some older items.' });
  }

  const seg = tripSegment(tripId);
  const year = new Date().getUTCFullYear();
  const id = crypto.randomUUID();
  const key = `moments/${seg}/${year}/${id}.${type.ext}`;

  const client = getS3();
  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: mime }),
    { expiresIn: 1800 }
  );
  const out = { key, uploadUrl, contentType: mime };

  if (body.withThumb) {
    const thumbKey = `moments/${seg}/${year}/${id}_t.webp`;
    out.thumbKey = thumbKey;
    out.thumbContentType = 'image/webp';
    out.thumbUploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: bucket(), Key: thumbKey, ContentType: 'image/webp' }),
      { expiresIn: 1800 }
    );
  }
  return ok(out);
}

async function headOrNull(key) {
  try {
    return await getS3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
  } catch (e) {
    if (e && (e.name === 'NotFound' || (e.$metadata && e.$metadata.httpStatusCode === 404))) return null;
    throw e;
  }
}

async function actionConfirm(tripId, session, body) {
  const seg = tripSegment(tripId);
  const pattern = keyPattern(seg);
  const key = sanitizeText(body.key || '', 200);
  const thumbKey = body.thumbKey ? sanitizeText(body.thumbKey, 200) : null;
  if (!pattern.test(key) || key.endsWith('_t.webp')) return badRequest('Invalid upload key.');
  if (thumbKey && (!pattern.test(thumbKey) || !thumbKey.endsWith('_t.webp'))) return badRequest('Invalid thumbnail key.');

  const mime = sanitizeText(body.mime || '', 60).toLowerCase();
  const type = ALLOWED_TYPES[mime];
  if (!type) return badRequest('Unsupported file type.');
  // The key's extension must agree with the declared type, so a client can't
  // register a random object under a different media kind.
  if (!key.endsWith('.' + type.ext)) return badRequest('File type doesn\u2019t match the upload.');

  const head = await headOrNull(key);
  if (!head) return badRequest('We couldn\u2019t find the uploaded file. Please try uploading again.');
  const size = Number(head.ContentLength);
  const cap = type.kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;

  let thumbBytes = 0;
  let finalThumbKey = null;
  if (thumbKey) {
    const th = await headOrNull(thumbKey);
    if (th && Number(th.ContentLength) <= MAX_THUMB_BYTES) {
      thumbBytes = Number(th.ContentLength);
      finalThumbKey = thumbKey;
    } else if (th) {
      await getS3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: thumbKey }));
    }
  }

  const rejectAndCleanup = async (status, message) => {
    await deleteFromR2({ object_key: key, thumb_key: finalThumbKey });
    return status === 413 ? json(413, { error: message }) : badRequest(message);
  };
  if (size > cap) return rejectAndCleanup(400, 'That file is too large.');
  const { used } = await usedBytes(tripId);
  if (used + size + thumbBytes > QUOTA_BYTES) {
    return rejectAndCleanup(413, 'The Moments storage is full. Ask an admin to delete some older items.');
  }

  const { rows } = await query(
    `INSERT INTO moments (trip_id, object_key, thumb_key, kind, mime, filename, size_bytes, thumb_bytes, width, height, duration_s, caption, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (object_key) DO NOTHING
     RETURNING *`,
    [
      tripId, key, finalThumbKey, type.kind, mime,
      safeFilename(body.filename, type.ext), size, thumbBytes,
      sanitizeNumber(body.width, 1, 20000), sanitizeNumber(body.height, 1, 20000),
      sanitizeNumber(body.durationS, 0, 86400),
      sanitizeText(body.caption || '', 200) || null,
      session.name,
    ]
  );
  if (!rows.length) return badRequest('That upload was already saved.');
  return ok({ item: await shapeItem(rows[0], session, true) });
}

async function findRow(tripId, id) {
  const n = sanitizeNumber(id, 1, Number.MAX_SAFE_INTEGER);
  if (n === null) return null;
  const { rows } = await query('SELECT * FROM moments WHERE id = $1 AND trip_id = $2', [n, tripId]);
  return rows[0] || null;
}

async function actionSignedGet(tripId, body, asDownload) {
  const row = await findRow(tripId, body.id);
  if (!row) return badRequest('That item no longer exists.');
  const cmd = new GetObjectCommand({
    Bucket: bucket(),
    Key: row.object_key,
    ...(asDownload ? { ResponseContentDisposition: contentDisposition(row.filename || 'moment') } : {}),
  });
  const url = await getSignedUrl(getS3(), cmd, { expiresIn: 900 });
  return ok({ url });
}

async function actionDelete(tripId, session, body) {
  let ids = Array.isArray(body.ids) ? body.ids : (body.id !== undefined ? [body.id] : []);
  ids = ids.map((i) => sanitizeNumber(i, 1, Number.MAX_SAFE_INTEGER)).filter((i) => i !== null);
  if (!ids.length) return badRequest('Nothing to delete.');
  if (ids.length > MAX_BULK_DELETE) return badRequest(`You can delete up to ${MAX_BULK_DELETE} items at once.`);

  const { rows } = await query('SELECT * FROM moments WHERE id = ANY($1::bigint[]) AND trip_id = $2', [ids, tripId]);
  const allowed = [];
  const skipped = [];
  for (const row of rows) {
    if (session.role === 'admin' || sameName(row.uploaded_by, session.name)) allowed.push(row);
    else skipped.push(Number(row.id));
  }

  const deleted = [];
  for (const row of allowed) {
    // R2 first, DB row second: if R2 fails we throw and the row stays, so the
    // delete can simply be retried (deleting a missing object is not an error).
    await deleteFromR2(row);
    await query('DELETE FROM moments WHERE id = $1', [row.id]);
    deleted.push(Number(row.id));
  }
  return ok({ deleted, skipped });
}

// ---------- handler ----------
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return badRequest('Unsupported method.');
    const body = parseBody(event);
    if (!body) return badRequest('Invalid JSON body.');
    const params = event.queryStringParameters || {};
    const tripId = sanitizeText(params.tripId || body.tripId || '', 80);
    if (!tripId || !tripSegment(tripId)) return badRequest('tripId is required.');

    // Members only: any valid, unexpired session (participant OR admin).
    const session = verifySessionTokenFull(body.token);
    if (!session) return unauthorized('Please log in to see Moments.');

    await ensureSchema();

    switch (body.action) {
      case 'list': return await actionList(tripId, session, body);
      case 'stats': return await actionStats(tripId);
      case 'presignUpload': return await actionPresignUpload(tripId, body);
      case 'confirm': return await actionConfirm(tripId, session, body);
      case 'getUrl': return await actionSignedGet(tripId, body, false);
      case 'download': return await actionSignedGet(tripId, body, true);
      case 'delete': return await actionDelete(tripId, session, body);
      default: return badRequest('Unknown action.');
    }
  } catch (err) {
    return serverError(err);
  }
};
