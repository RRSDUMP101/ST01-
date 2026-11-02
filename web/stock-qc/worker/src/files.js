// QC photos, material certificates and imported files in R2 (BACKEND_DESIGN.md "Files").
//   POST /api/files      multipart/form-data field "file" (what the page sends) or the raw bytes with Content-Type and
//                        X-File-Name (URI-encoded). ≤ 10 MB; JPEG/PNG/WEBP/PDF/CSV/XLSX, and the bytes must look like the
//                        declared type. Stored once per content at stockqc/files/<sha256>, metadata in sq_files.
//   GET /api/files/<sha256>  streams the file back: images inline, everything else as an attachment; nosniff + sandbox.
// Engine rows keep only the file id (sha256).
import { db, bucket, HttpError, json, API_HEADERS } from './runtime.js';
import { digest, limitedBody } from './security.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
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

async function readUpload(req) {
  const ct = req.headers.get('content-type') || '';
  if (/^multipart\/form-data/i.test(ct)) {
    const raw = await limitedBody(req, MAX_FILE_BYTES + MULTIPART_OVERHEAD);
    let form;
    try {
      form = await new Response(raw, { headers: { 'content-type': ct } }).formData();
    } catch (e) {
      throw new HttpError(400, 'อ่านไฟล์ที่ส่งมาไม่ได้');
    }
    const file = form.get('file');
    if (!file || typeof file === 'string') throw new HttpError(400, 'ไม่พบไฟล์ (ช่อง file)');
    return { type: baseType(file.type), name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
  }
  let name = req.headers.get('x-file-name') || '';
  try {
    name = decodeURIComponent(name);
  } catch (e) {
    name = '';
  }
  return { type: baseType(ct), name, bytes: await limitedBody(req, MAX_FILE_BYTES) };
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
  const id = await digest(bytes);
  const d = db(env);
  const found = await d.prepare('SELECT id,name,type,size,uploaded_at FROM sq_files WHERE id=?').bind(id).first();
  if (found) {
    return json({ ok: true, id, name: found.name, type: found.type, size: Number(found.size), uploadedAt: found.uploaded_at, url: `/api/files/${id}`, existing: true });
  }
  const key = `stockqc/files/${id}`;
  const clean = cleanName(name, type);
  const at = new Date().toISOString();
  await bucket(env).put(key, bytes, { sha256: id, httpMetadata: { contentType: type } });
  await d.prepare('INSERT OR IGNORE INTO sq_files (id,r2_key,name,type,size,uploaded_by,uploaded_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, key, clean, type, bytes.length, session.username, at).run();
  return json({ ok: true, id, name: clean, type, size: bytes.length, uploadedAt: at, url: `/api/files/${id}`, existing: false }, 201);
}

export async function download(env, id) {
  if (!ID_RE.test(id)) throw new HttpError(404, 'ไม่พบไฟล์');
  const row = await db(env).prepare('SELECT id,r2_key,name,type,size FROM sq_files WHERE id=?').bind(id).first();
  if (!row || !FILE_TYPES[row.type]) throw new HttpError(404, 'ไม่พบไฟล์');
  const obj = await bucket(env).get(row.r2_key);
  if (!obj) throw new HttpError(404, 'ไม่พบไฟล์');
  const def = FILE_TYPES[row.type];
  const ascii = cleanName(row.name, row.type).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const disposition = `${def.inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.name)}`;
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
