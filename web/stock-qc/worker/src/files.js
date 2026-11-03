// QC photos, material certificates and imported files in R2 (BACKEND_DESIGN.md "Files").
//   POST /api/files      multipart/form-data field "file" (what the page sends) or the raw bytes with Content-Type and
//                        X-File-Name (URI-encoded). ≤ 10 MB; JPEG/PNG/WEBP/PDF/CSV/XLSX, and the bytes must look like the
//                        declared type. Stored once per content at stockqc/files/<sha256>, metadata in sq_files.
//   GET /api/files/<sha256>  streams the file back: images inline, everything else as an attachment; nosniff + sandbox.
// Engine rows keep only the file id (sha256).
import { db, bucket, HttpError, json, API_HEADERS } from './runtime.js';
import { digest, limitedBody, readJson } from './security.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_ITEM_PHOTOS = 8;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MULTIPART_OVERHEAD = 64 * 1024;
export const FILE_TYPES = {
  'image/jpeg': { ext: 'jpg', inline: true },
  'image/png': { ext: 'png', inline: true },
  'image/webp': { ext: 'webp', inline: true },
  'application/pdf': { ext: 'pdf', inline: false },
  'text/csv': { ext: 'csv', inline: false },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: 'xlsx', inline: false },
};
const ID_RE = /^[a-f0-9]{64}$/;
const EXT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const ALIASES = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'application/x-pdf': 'application/pdf', 'text/x-csv': 'text/csv',
  'application/csv': 'text/csv' };
// Types browsers send for files they do not know well (Windows reports .csv as application/vnd.ms-excel when Excel is
// installed): then the file extension decides, and the bytes are checked against it right after.
const GENERIC = ['', 'application/octet-stream', 'application/vnd.ms-excel', 'text/plain'];
export function resolveType(declared, name) {
  const t = ALIASES[declared] || declared;
  if (FILE_TYPES[t]) return t;
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  const byExt = m && EXT_TYPES[m[1].toLowerCase()];
  return byExt && GENERIC.indexOf(t) >= 0 ? byExt : t;
}

const starts = (bytes, sig, at) => sig.every((b, i) => bytes[(at || 0) + i] === b);
/** Do the bytes look like `type`? (magic numbers; CSV = text without NUL bytes, any encoding – Express may save TIS-620) */
export function looksLike(type, bytes) {
  switch (type) {
    case 'image/jpeg': return starts(bytes, [0xff, 0xd8, 0xff]);
    case 'image/png': return starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/webp': return starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8);
    case 'application/pdf': return starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return starts(bytes, [0x50, 0x4b, 0x03, 0x04]);
    case 'text/csv': return bytes.indexOf(0) < 0;
    default: return false;
  }
}
const baseType = (t) => String(t || '').split(';')[0].trim().toLowerCase();

/** File name kept for display/download: no path, no control characters, ≤ 160 characters. */
export function cleanName(name, type) {
  let n = String(name || '').replace(/\\/g, '/').split('/').pop();
  n = n.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const ext = FILE_TYPES[type] ? FILE_TYPES[type].ext : 'bin';
  return n && n !== '.' && n !== '..' ? n : `file.${ext}`;
}

async function readUpload(req, maxBytes = MAX_FILE_BYTES, singleFile = false) {
  const ct = req.headers.get('content-type') || '';
  if (/^multipart\/form-data/i.test(ct)) {
    const raw = await limitedBody(req, maxBytes + MULTIPART_OVERHEAD);
    let form;
    try {
      form = await new Response(raw, { headers: { 'content-type': ct } }).formData();
    } catch (e) {
      throw new HttpError(400, 'อ่านไฟล์ที่ส่งมาไม่ได้');
    }
    const file = form.get('file');
    if (!file || typeof file === 'string') throw new HttpError(400, 'ไม่พบไฟล์ (ช่อง file)');
    if (singleFile && (form.getAll('file').length !== 1 || [...form.keys()].some((key) => key !== 'file'))) throw new HttpError(400, 'ส่งรูปสินค้าได้ครั้งละหนึ่งไฟล์เท่านั้น');
    return { type: baseType(file.type), name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
  }
  let name = req.headers.get('x-file-name') || '';
  try {
    name = decodeURIComponent(name);
  } catch (e) {
    name = '';
  }
  return { type: baseType(ct), name, bytes: await limitedBody(req, maxBytes) };
}

/** session: {username}. Returns {ok, id, name, type, size, uploadedAt, url, existing}. */
export async function upload(env, req, session) {
  const upload = await readUpload(req);
  const { name, bytes } = upload;
  const type = resolveType(upload.type, name);
  if (!FILE_TYPES[type]) throw new HttpError(415, 'ชนิดไฟล์นี้อัปโหลดไม่ได้ – รับเฉพาะ JPG, PNG, WEBP, PDF, CSV, XLSX');
  if (!bytes.length) throw new HttpError(400, 'ไฟล์ว่าง');
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, 'ไฟล์ใหญ่เกิน 10 MB');
  if (!looksLike(type, bytes)) throw new HttpError(415, 'ชนิดไฟล์ไม่ตรงกับเนื้อไฟล์ หรือไฟล์ไม่ปลอดภัย');
  const result = await persistFile(env, name, bytes, type, session);
  return json(result, result.existing ? 200 : 201);
}

async function persistFile(env, name, bytes, type, session) {
  const id = await digest(bytes);
  const d = db(env);
  const found = await d.prepare('SELECT id,name,type,size,uploaded_at FROM sq_files WHERE id=?').bind(id).first();
  if (found) {
    return { ok: true, id, name: found.name, type: found.type, size: Number(found.size), uploadedAt: found.uploaded_at, url: `/api/files/${id}`, existing: true };
  }
  const key = `stockqc/files/${id}`;
  const clean = cleanName(name, type);
  const at = new Date().toISOString();
  await bucket(env).put(key, bytes, { sha256: id, httpMetadata: { contentType: type } });
  const inserted = await d.prepare('INSERT OR IGNORE INTO sq_files (id,r2_key,name,type,size,uploaded_by,uploaded_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, key, clean, type, bytes.length, session.username, at).run();
  // Concurrent uploads may use a different display name/type for identical bytes. Always return the stored winner.
  const stored = await d.prepare('SELECT name,type,size,uploaded_at FROM sq_files WHERE id=?').bind(id).first();
  if (!stored) throw new HttpError(503, 'ยืนยันการบันทึกไฟล์ไม่ได้ กรุณาลองใหม่');
  return { ok: true, id, name: stored.name, type: stored.type, size: Number(stored.size), uploadedAt: stored.uploaded_at,
    url: `/api/files/${id}`, existing: inserted.meta.changes === 0 };
}

const PHOTO_COLUMNS = 'p.item_id,p.file_id,p.is_primary,p.name,p.uploaded_at,p.uploaded_by,f.type,f.size';
function publicPhoto(row) {
  return { id: row.file_id, name: row.name, type: row.type, size: Number(row.size), primary: Number(row.is_primary) === 1,
    uploadedAt: row.uploaded_at, uploadedBy: row.uploaded_by, url: `/api/items/photos/${row.file_id}?code=${encodeURIComponent(row.item_id)}` };
}
async function photoRows(env, itemId) {
  const result = await db(env).prepare(`SELECT ${PHOTO_COLUMNS} FROM sq_item_photos p JOIN sq_files f ON f.id=p.file_id WHERE p.item_id=? ORDER BY p.slot`).bind(itemId).all();
  return result.results.map(publicPhoto);
}
/** All entry points receive a canonical item id after the route checked current engine access and item existence. */
export async function listItemPhotos(env, itemId, canEdit) {
  return json({ ok: true, itemId, photos: await photoRows(env, itemId), maxPhotos: MAX_ITEM_PHOTOS, maxBytes: MAX_PHOTO_BYTES, canEdit });
}
export async function itemPhotoThumbnails(env, itemIds) {
  if (!itemIds.length || itemIds.length > 100) throw new HttpError(400, 'ขอรูปสินค้าได้ครั้งละ 1–100 รายการ');
  const rows = await db(env).prepare(`SELECT ${PHOTO_COLUMNS},(SELECT COUNT(*) FROM sq_item_photos n WHERE n.item_id=p.item_id) AS photo_count
    FROM sq_item_photos p JOIN sq_files f ON f.id=p.file_id WHERE p.is_primary=1 AND p.item_id IN (${itemIds.map(() => '?').join(',')})`).bind(...itemIds).all();
  const byId = new Map(rows.results.map((row) => [row.item_id, row]));
  return json({ ok: true, items: itemIds.map((itemId) => { const row = byId.get(itemId); return { itemId, photo: row ? publicPhoto(row) : null, count: row ? Number(row.photo_count) : 0 }; }) });
}
export async function uploadItemPhoto(env, req, session, itemId) {
  const input = await readUpload(req, MAX_PHOTO_BYTES, true);
  const type = resolveType(input.type, input.name);
  if (!PHOTO_TYPES.has(type)) throw new HttpError(415, 'รูปสินค้ารับเฉพาะ JPEG, PNG และ WebP');
  if (!input.bytes.length) throw new HttpError(400, 'ไฟล์ว่าง');
  if (input.bytes.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'รูปสินค้าใหญ่เกิน 5 MB');
  if (!looksLike(type, input.bytes)) throw new HttpError(415, 'ชนิดรูปไม่ตรงกับเนื้อไฟล์');
  const d = db(env), id = await digest(input.bytes);
  const prior = await photoRows(env, itemId);
  const same = prior.find((photo) => photo.id === id);
  if (same) return json({ ok: true, itemId, photo: same, photos: prior, existing: true });
  if (prior.length >= MAX_ITEM_PHOTOS) throw new HttpError(409, 'สินค้านี้มีรูปครบ 8 รูปแล้ว', { code: 'PHOTO_LIMIT' });
  const file = await persistFile(env, input.name, input.bytes, type, session);
  if (file.type !== type || !PHOTO_TYPES.has(file.type)) throw new HttpError(415, 'ข้อมูลชนิดไฟล์เดิมไม่ตรงกับรูปสินค้า');
  // A finite slot set and UNIQUE(item_id,slot) enforce the gallery limit across concurrent Worker isolates.
  const result = await d.prepare(`INSERT OR IGNORE INTO sq_item_photos (item_id,file_id,slot,is_primary,name,uploaded_by,uploaded_at)
    SELECT ?,?,s.value,CASE WHEN EXISTS(SELECT 1 FROM sq_item_photos WHERE item_id=?) THEN 0 ELSE 1 END,?,?,?
    FROM json_each('[1,2,3,4,5,6,7,8]') s
    WHERE NOT EXISTS(SELECT 1 FROM sq_item_photos WHERE item_id=? AND slot=s.value) ORDER BY s.value LIMIT 1`)
    .bind(itemId, id, itemId, cleanName(input.name, type), session.username, new Date().toISOString(), itemId).run();
  const photos = await photoRows(env, itemId), photo = photos.find((entry) => entry.id === id);
  if (!photo) throw new HttpError(409, 'สินค้านี้มีรูปครบ 8 รูปแล้ว', { code: 'PHOTO_LIMIT' });
  return json({ ok: true, itemId, photo, photos, existing: result.meta.changes === 0 }, result.meta.changes ? 201 : 200);
}
export async function setPrimaryItemPhoto(env, req, itemId) {
  const input = await readJson(req, 1024);
  if (Object.keys(input).some((key) => key !== 'id') || typeof input.id !== 'string' || !ID_RE.test(input.id)) throw new HttpError(400, 'ระบุรหัสรูปสินค้าให้ถูกต้อง');
  const d = db(env);
  const results = await d.batch([
    d.prepare('UPDATE sq_item_photos SET is_primary=0 WHERE item_id=? AND EXISTS(SELECT 1 FROM sq_item_photos target WHERE target.item_id=? AND target.file_id=?)').bind(itemId, itemId, input.id),
    d.prepare('UPDATE sq_item_photos SET is_primary=1 WHERE item_id=? AND file_id=?').bind(itemId, input.id),
  ]);
  if (results[1].meta.changes !== 1) throw new HttpError(404, 'ไม่พบรูปนี้ในสินค้า');
  return json({ ok: true, itemId, photos: await photoRows(env, itemId) });
}
export async function downloadItemPhoto(env, itemId, id) {
  if (!ID_RE.test(id)) throw new HttpError(404, 'ไม่พบรูปสินค้า');
  const row = await db(env).prepare('SELECT f.type FROM sq_item_photos p JOIN sq_files f ON f.id=p.file_id WHERE p.item_id=? AND p.file_id=?').bind(itemId, id).first();
  if (!row || !PHOTO_TYPES.has(row.type)) throw new HttpError(404, 'ไม่พบรูปนี้ในสินค้า');
  return download(env, id);
}

/** RFC 8187 ext-value: encodeURIComponent leaves ' ( ) * ! as they are; ' ( ) * are not attr-chars, so they are encoded too. */
export function rfc8187(name) {
  return encodeURIComponent(String(name)).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export async function download(env, id) {
  if (!ID_RE.test(id)) throw new HttpError(404, 'ไม่พบไฟล์');
  const row = await db(env).prepare('SELECT id,r2_key,name,type,size FROM sq_files WHERE id=?').bind(id).first();
  if (!row || !FILE_TYPES[row.type]) throw new HttpError(404, 'ไม่พบไฟล์');
  const obj = await bucket(env).get(row.r2_key);
  if (!obj) throw new HttpError(404, 'ไม่พบไฟล์');
  const def = FILE_TYPES[row.type];
  const ascii = cleanName(row.name, row.type).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const disposition = `${def.inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${rfc8187(cleanName(row.name, row.type))}`;
  return new Response(obj.body, {
    status: 200,
    headers: Object.assign({}, API_HEADERS, {
      'Content-Type': row.type,
      'Content-Disposition': disposition,
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox",
      ETag: `"${id}"`,
    }),
  });
}
