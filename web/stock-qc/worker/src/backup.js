// Google Drive backup of the commit ledger (BACKEND_DESIGN.md "Google Drive backup"). The OAuth refresh-token exchange
// and the Drive calls follow Sales Office lib/integrations/google-drive-backup.ts (private-folder check, pre-allocated
// file ids so a retry after an uncertain outcome never makes a second copy, Drive's sha256Checksum checked against the
// bytes sent); the run bookkeeping is simpler than Sales Office drive-backup.ts because the source is one append-only
// table.
//
//   Off unless SQ_DRIVE_BACKUP_ENABLED === 'true' and GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET,
//   GOOGLE_DRIVE_REFRESH_TOKEN, SQ_DRIVE_BACKUP_FOLDER_ID are all set (manual runs too: off means nothing is sent).
//   A run: lease (one running run at a time, renewed after every part) → token → root folder must be private, a folder,
//   writable (checked again, up the folder chain to the root, before every write) → head = newest commit → dated
//   sub-folder → commits 1..head as JSONL parts ≤ 4 MB (one commit per line,
//   the GET /api/commits format; every hash and prev link checked while reading) → manifest.json last (seq range, head
//   hash, size + sha256 of each part). A folder without manifest.json is an incomplete backup.
//   sq_backup_runs: one row per run (status running/ok/failed, error = a short code, never a provider body);
//   sq_backup_parts: one row per uploaded file. Scheduled runs: at most one per Bangkok day (unique index).
import { db, str, flag } from './runtime.js';
import { digest, securityEvent } from './security.js';
import { boundedFetch, jsonObject, OutboundError, errorCode } from './outbound.js';
import { COLUMNS, rowToCommit, commitJson } from './ledger.js';
import { SHEETS_MIME, sheetsProjection, projectSheetsCommit, sheetsDataset, exportNativeSpreadsheet } from './sheets-export.js';

const RRS = globalThis.RRS;
const { util, core } = RRS;

export const BACKUP_CRON = '0 20 * * *'; // 03:00 Asia/Bangkok, daily (the preceding UTC day)
export const PART_BYTES = 4 * 1024 * 1024;
export const FORMAT = 'rrs-stockqc-drive-backup';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const PART_MIME = 'application/x-ndjson';
const MANIFEST_MIME = 'application/json';
const FILE_FIELDS = 'id,name,mimeType,trashed,shared,ownedByMe,driveId,parents,capabilities(canAddChildren),permissions(id,type,role,deleted),appProperties,size,sha256Checksum';
const LEASE_MS = 10 * 60 * 1000;
const READ_CHUNK = 100;
const UPLOAD_ATTEMPTS = 3;
export const ENV_NAMES = ['GOOGLE_DRIVE_CLIENT_ID', 'GOOGLE_DRIVE_CLIENT_SECRET', 'GOOGLE_DRIVE_REFRESH_TOKEN', 'SQ_DRIVE_BACKUP_FOLDER_ID'];
const validId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(v);
const encoder = new TextEncoder();

export const MESSAGES = {
  DISABLED: 'ปิดการสำรองข้อมูลไป Google Drive อยู่ (SQ_DRIVE_BACKUP_ENABLED ไม่ใช่ true)',
  CONFIGURATION_MISSING: 'ยังตั้งค่า Google Drive ไม่ครบหรือไม่ถูกต้อง',
  BUSY: 'กำลังสำรองข้อมูลอยู่ – รอให้รอบเดิมเสร็จก่อน',
  ALREADY_DONE: 'วันนี้สำรองข้อมูลตามรอบแล้ว',
  AUTH_REAUTHORIZE_REQUIRED: 'สิทธิ์ Google Drive หมดอายุหรือถูกยกเลิก – ต้องเชื่อมบัญชี Google ใหม่ (refresh token)',
  AUTHENTICATION_FAILED: 'เข้าสู่ Google Drive ไม่สำเร็จ – ตรวจ client id/secret',
  INVALID_AUTH_RESPONSE: 'คำตอบการเข้าสู่ระบบจาก Google ไม่ถูกต้อง',
  DRIVE_ACCESS_DENIED: 'Google Drive ไม่อนุญาตให้ทำรายการนี้',
  FOLDER_NOT_FOUND: 'ไม่พบโฟลเดอร์สำรองใน Google Drive',
  FILE_NOT_FOUND: 'ไม่พบไฟล์ใน Google Drive',
  DESTINATION_NOT_FOLDER: 'ปลายทางใน Google Drive ไม่ใช่โฟลเดอร์',
  DESTINATION_NOT_PRIVATE: 'โฟลเดอร์สำรองแชร์ให้ผู้อื่นหรืออยู่ในไดรฟ์ที่แชร์ – หยุดเพื่อไม่ให้ข้อมูลรั่ว',
  DESTINATION_NOT_WRITABLE: 'เพิ่มไฟล์ในโฟลเดอร์สำรองไม่ได้',
  DESTINATION_OUTSIDE_BACKUP_FOLDER: 'ปลายทางไม่ได้อยู่ในโฟลเดอร์สำรองที่ตั้งไว้ – ไม่เขียนไฟล์',
  FILE_ID_CONFLICT: 'ไฟล์ใน Google Drive ไม่ตรงกับที่ระบบส่ง',
  REMOTE_CHECKSUM_MISMATCH: 'ขนาดหรือลายนิ้วมือไฟล์ใน Google Drive ไม่ตรงกับข้อมูลที่ส่ง',
  COMMIT_NOT_CONFIRMED: 'ยืนยันไม่ได้ว่า Google Drive บันทึกไฟล์แล้ว',
  DRIVE_RATE_LIMITED: 'Google Drive จำกัดจำนวนคำขอ – ลองใหม่ภายหลัง',
  DRIVE_UNAVAILABLE: 'Google Drive ไม่พร้อมใช้งานชั่วคราว – ลองใหม่ภายหลัง',
  DRIVE_REQUEST_FAILED: 'Google Drive ตอบกลับผิดพลาด',
  REQUEST_TIMEOUT: 'Google Drive ไม่ตอบในเวลาที่กำหนด',
  NETWORK_UNCERTAIN: 'เชื่อมต่อ Google ไม่สำเร็จ',
  UNEXPECTED_REDIRECT: 'Google ตอบกลับแบบเปลี่ยนเส้นทาง – ไม่ส่งข้อมูลต่อ',
  RESPONSE_TOO_LARGE: 'คำตอบจาก Google ใหญ่ผิดปกติ',
  INVALID_PROVIDER_RESPONSE: 'คำตอบจาก Google Drive ไม่ถูกต้อง',
  INVALID_BACKUP_INPUT: 'ข้อมูลสำรองไม่ถูกต้อง',
  PART_TOO_LARGE: 'commit หนึ่งรายการใหญ่เกินขนาดไฟล์ย่อย',
  LEDGER_INTEGRITY: 'ข้อมูล commit ไม่ต่อเนื่องหรือลายนิ้วมือไม่ตรง – ไม่สำรองข้อมูลที่เสียหาย แจ้งผู้ดูแลระบบ',
  LEASE_LOST: 'รอบสำรองนี้หมดเวลาหรือถูกแทนที่',
  LEASE_EXPIRED: 'รอบสำรองหยุดกลางทาง (หมดเวลา) – ไฟล์ในโฟลเดอร์ของรอบนี้ไม่ครบ ไม่มี manifest.json',
  INTERNAL_ERROR: 'สำรองข้อมูลไม่สำเร็จ',
  SHEETS_DATA_TOO_LARGE: 'ข้อมูลเกินขนาดส่งออก Google Sheets ที่กำหนด รอบนี้ไม่สมบูรณ์',
  SHEETS_CELL_TOO_LARGE: 'ข้อมูลหนึ่งช่องยาวเกินขนาด Google Sheets ที่กำหนด',
  SHEETS_ROW_TOO_LARGE: 'ข้อมูลหนึ่งแถวใหญ่เกินขนาดส่งออก Google Sheets ที่กำหนด',
  SHEETS_RATE_LIMITED: 'Google Sheets จำกัดจำนวนคำขอหลังลองใหม่แล้ว',
  SHEETS_UNAVAILABLE: 'Google Sheets ไม่พร้อมใช้งานหลังลองใหม่แล้ว',
  SHEETS_ACCESS_DENIED: 'Google Sheets ไม่อนุญาตให้เขียน – ตรวจสิทธิ์ Google และการเปิดใช้ Sheets API',
  SHEETS_REQUEST_FAILED: 'ส่งออก Google Sheets ไม่สำเร็จ',
  SHEETS_WRITE_NOT_CONFIRMED: 'ข้อมูลที่ Google Sheets ตอบกลับไม่ตรงกับข้อมูลที่ส่ง',
  SHEETS_CREATE_UNCERTAIN: 'ยืนยันการสร้าง Google Sheets ไม่ได้ – รอบนี้ล้มเหลวและไม่สร้างไฟล์ซ้ำอัตโนมัติ',
};
const fail = (code, retryable) => new OutboundError(code, retryable);

/** Which settings are there (names only, never a value). */
export function backupConfig(env) {
  const missing = ENV_NAMES.filter((k) => !str(env, k).trim());
  const invalid = [];
  const folder = str(env, 'SQ_DRIVE_BACKUP_FOLDER_ID').trim();
  if (folder && !validId(folder)) invalid.push('SQ_DRIVE_BACKUP_FOLDER_ID');
  return { enabled: flag(env, 'SQ_DRIVE_BACKUP_ENABLED'), configured: !missing.length && !invalid.length, missing, invalid };
}
/** Optional smaller part size (tests); never above 4 MB. */
function partBytes(env) {
  const n = Number.parseInt(str(env, 'SQ_BACKUP_PART_BYTES'), 10);
  return Number.isFinite(n) && n >= 1024 && n < PART_BYTES ? n : PART_BYTES;
}
const bangkok = (ms) => new Date(ms + 7 * 3600e3).toISOString();

function statusError(status) {
  if (status === 401) return fail('AUTHENTICATION_FAILED');
  if (status === 403) return fail('DRIVE_ACCESS_DENIED');
  if (status === 404) return fail('FILE_NOT_FOUND');
  if (status === 429) return fail('DRIVE_RATE_LIMITED', true);
  if (status >= 500) return fail('DRIVE_UNAVAILABLE', true);
  return fail('DRIVE_REQUEST_FAILED');
}
/** Fail closed: anything shared, in a shared drive, trashed or with metadata missing is not private. */
function requirePrivate(f) {
  if (f.trashed !== false) throw fail('FILE_ID_CONFLICT');
  const perms = f.permissions;
  if (f.shared !== false || f.ownedByMe !== true || f.driveId || !Array.isArray(perms) || perms.length !== 1
    || perms.some((p) => !p || typeof p !== 'object' || p.type !== 'user' || p.role !== 'owner' || p.deleted === true)) {
    throw fail('DESTINATION_NOT_PRIVATE');
  }
}
function sameObject(f, input, kind) {
  requirePrivate(f);
  const ap = f.appProperties || {};
  if (f.id !== input.id || f.name !== input.name || !Array.isArray(f.parents) || f.parents.length !== 1 || f.parents[0] !== input.parentId
    || ap.sqBackupRunId !== input.runId || ap.sqBackupKind !== kind) {
    throw fail('FILE_ID_CONFLICT');
  }
}

/** Drive client for one run: access token from the refresh token, every call bounded (outbound.js). */
function driveClient(env) {
  const rootId = str(env, 'SQ_DRIVE_BACKUP_FOLDER_ID').trim();
  let token = '';
  let expires = 0;
  const pool = [];
  async function refresh() {
    const body = new URLSearchParams({ client_id: str(env, 'GOOGLE_DRIVE_CLIENT_ID').trim(), client_secret: str(env, 'GOOGLE_DRIVE_CLIENT_SECRET').trim(),
      refresh_token: str(env, 'GOOGLE_DRIVE_REFRESH_TOKEN').trim(), grant_type: 'refresh_token' });
    const res = await boundedFetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString() });
    const data = jsonObject(res) || {};
    if (res.status < 200 || res.status >= 300) {
      if (res.status >= 500 || res.status === 429) throw statusError(res.status);
      throw fail(data.error === 'invalid_grant' ? 'AUTH_REAUTHORIZE_REQUIRED' : 'AUTHENTICATION_FAILED');
    }
    const t = typeof data.access_token === 'string' ? data.access_token.trim() : '';
    const seconds = Number(data.expires_in);
    if (!t || t.length > 16384 || /[\r\n]/.test(t) || !Number.isFinite(seconds) || seconds <= 0
      || (data.token_type !== undefined && String(data.token_type).trim().toLowerCase() !== 'bearer')) {
      throw fail('INVALID_AUTH_RESPONSE');
    }
    token = t;
    expires = Date.now() + Math.max(0, seconds - 60) * 1000;
  }
  async function request(url, init, maxBytes) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!token || Date.now() >= expires) await refresh();
      const headers = new Headers((init && init.headers) || {});
      headers.set('Authorization', `Bearer ${token}`);
      const res = await boundedFetch(url, Object.assign({}, init, { headers }), { maxBytes: maxBytes || 128 * 1024 });
      if (res.status === 401 && attempt === 0) {
        token = '';
        continue;
      }
      return res;
    }
    throw fail('AUTHENTICATION_FAILED');
  }
  async function getFile(id) {
    if (!validId(id)) throw fail('INVALID_BACKUP_INPUT');
    const res = await request(`${API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}`, { method: 'GET' });
    if (res.status === 404) return null;
    if (res.status !== 200) throw statusError(res.status);
    const f = jsonObject(res);
    if (!f || f.id !== id || typeof f.name !== 'string' || typeof f.mimeType !== 'string') throw fail('INVALID_PROVIDER_RESPONSE');
    return f;
  }
  async function validateFolder(id) {
    const f = await getFile(id);
    if (!f) throw fail('FOLDER_NOT_FOUND');
    requirePrivate(f);
    if (f.mimeType !== FOLDER_MIME) throw fail('DESTINATION_NOT_FOLDER');
    if (!f.capabilities || f.capabilities.canAddChildren !== true) throw fail('DESTINATION_NOT_WRITABLE');
    return f;
  }
  /**
   * Checked again right before every write, retries included (Sales Office validateDestination): the parent and each
   * folder above it must still be a private, writable folder up to the backup root – sharing may change during a run.
   */
  async function validateDestination(parentId) {
    let id = parentId;
    const visited = new Set();
    for (let depth = 0; depth < 8; depth++) {
      if (visited.has(id)) break;
      visited.add(id);
      const folder = await validateFolder(id);
      if (id === rootId) return;
      if (!Array.isArray(folder.parents) || folder.parents.length !== 1) break;
      id = folder.parents[0];
    }
    throw fail('DESTINATION_OUTSIDE_BACKUP_FOLDER');
  }
  /** A Drive file id reserved before the create/upload, so a retry reuses it (409 = it is already there). */
  async function allocateId() {
    if (!pool.length) {
      const res = await request(`${API}/files/generateIds?count=20&space=drive&type=files`, { method: 'GET' });
      if (res.status !== 200) throw statusError(res.status);
      const d = jsonObject(res);
      const ids = d && d.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 20 || !ids.every(validId)) throw fail('INVALID_PROVIDER_RESPONSE');
      pool.push(...ids);
    }
    return pool.shift();
  }
  async function ensureFolder(input) {
    if (!validId(input.id) || !validId(input.parentId) || !input.name || input.name.length > 200) throw fail('INVALID_BACKUP_INPUT');
    await validateDestination(input.parentId);
    const res = await request(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ id: input.id, name: input.name, mimeType: FOLDER_MIME, parents: [input.parentId],
        appProperties: { sqBackupRunId: input.runId, sqBackupKind: 'folder' } }) });
    if ((res.status < 200 || res.status >= 300) && res.status !== 409) throw statusError(res.status);
    const f = await getFile(input.id);
    if (!f) throw fail('COMMIT_NOT_CONFIRMED', true);
    sameObject(f, input, 'folder');
    if (f.mimeType !== FOLDER_MIME) throw fail('FILE_ID_CONFLICT');
    if (!f.capabilities || f.capabilities.canAddChildren !== true) throw fail('DESTINATION_NOT_WRITABLE');
    return f;
  }
  function verifyUpload(f, input) {
    sameObject(f, input, input.kind);
    const ap = f.appProperties || {};
    if (f.mimeType !== input.mimeType || ap.sqBackupSha256 !== input.sha256) throw fail('FILE_ID_CONFLICT');
    if (String(f.size) !== String(input.bytes.byteLength) || typeof f.sha256Checksum !== 'string' || f.sha256Checksum.toLowerCase() !== input.sha256) {
      throw fail('REMOTE_CHECKSUM_MISMATCH');
    }
    return { id: f.id, size: input.bytes.byteLength, sha256: input.sha256 };
  }
  /**
   * Multipart upload (one request per file, ≤ 5 MB) with the reserved id. Every attempt first checks the destination
   * again; a retry then looks the reserved id up (a stored file is checked, never sent twice). After the upload the
   * file is read back and its size + sha256Checksum compared with the bytes sent (Sales Office uploadPart does the same).
   */
  async function uploadFile(input) {
    let lastError = null;
    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
      try {
        await validateDestination(input.parentId);
        if (attempt > 1) {
          const existing = await getFile(input.id);
          if (existing) return verifyUpload(existing, input);
        }
        const boundary = 'sq-backup-' + Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
        const metadata = { id: input.id, name: input.name, mimeType: input.mimeType, parents: [input.parentId],
          appProperties: { sqBackupRunId: input.runId, sqBackupKind: input.kind, sqBackupSha256: input.sha256 } };
        const head = encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
          + `--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`);
        const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
        const body = new Uint8Array(head.length + input.bytes.length + tail.length);
        body.set(head, 0);
        body.set(input.bytes, head.length);
        body.set(tail, head.length + input.bytes.length);
        const res = await request(`${UPLOAD}?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`, { method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
        if (res.status === 409) {
          const committed = await getFile(input.id);
          if (!committed) throw fail('COMMIT_NOT_CONFIRMED', true);
          return verifyUpload(committed, input);
        }
        if (res.status < 200 || res.status >= 300) throw statusError(res.status);
        const f = jsonObject(res);
        if (!f || f.id !== input.id) throw fail('INVALID_PROVIDER_RESPONSE');
        const committed = await getFile(input.id);
        if (!committed) throw fail('COMMIT_NOT_CONFIRMED', true);
        return verifyUpload(committed, input);
      } catch (e) {
        lastError = e;
        if (!(e instanceof OutboundError && e.retryable) || attempt === UPLOAD_ATTEMPTS) throw e;
      }
    }
    throw lastError || fail('INTERNAL_ERROR');
  }
  // Native Workspace files cannot use generateIds. Create exactly once; a lost response fails this run instead of
  // creating duplicate workbooks. INCOMPLETE in the initial name remains visible if the Worker stops mid-export.
  async function createSpreadsheet(input) {
    await validateDestination(input.parentId);
    let res;
    try {
      res = await request(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `INCOMPLETE - ${input.name}`, mimeType: SHEETS_MIME, parents: [input.parentId],
          appProperties: { sqBackupRunId: input.runId, sqBackupKind: 'sheets', sqBackupStatus: 'running' } }) });
    } catch (e) {
      if (e instanceof OutboundError && e.retryable) throw fail('SHEETS_CREATE_UNCERTAIN');
      throw e;
    }
    if (res.status >= 500) throw fail('SHEETS_CREATE_UNCERTAIN');
    if (res.status < 200 || res.status >= 300) throw statusError(res.status);
    const f = jsonObject(res);
    if (!validId(f?.id)) throw fail('SHEETS_CREATE_UNCERTAIN');
    return { id: f.id };
  }
  async function verifySpreadsheet(input) {
    await validateDestination(input.parentId);
    const f = await getFile(input.id);
    if (!f) throw fail('FILE_NOT_FOUND');
    requirePrivate(f);
    if (f.mimeType !== SHEETS_MIME || !Array.isArray(f.parents) || f.parents.length !== 1 || f.parents[0] !== input.parentId
      || f.appProperties?.sqBackupRunId !== input.runId || f.appProperties?.sqBackupKind !== 'sheets') throw fail('FILE_ID_CONFLICT');
    return f;
  }
  async function markSpreadsheet(input, status) {
    await verifySpreadsheet(input);
    const name = status === 'complete' ? input.name : `FAILED - ${input.name}`;
    const res = await request(`${API}/files/${encodeURIComponent(input.id)}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, appProperties: { sqBackupRunId: input.runId, sqBackupKind: 'sheets', sqBackupStatus: status } }) });
    if (res.status < 200 || res.status >= 300) throw statusError(res.status);
    const f = await verifySpreadsheet(input);
    if (f.name !== name || f.appProperties?.sqBackupStatus !== status) throw fail('COMMIT_NOT_CONFIRMED', true);
  }
  return { validateFolder, allocateId, ensureFolder, uploadFile, request, createSpreadsheet, verifySpreadsheet, markSpreadsheet };
}

// ---- run bookkeeping ------------------------------------------------------------------------------------------------
/** Runs whose lease ran out while 'running' (the Worker stopped mid-way) are closed as failed. */
async function expireStale(env, now) {
  await db(env).prepare("UPDATE sq_backup_runs SET status='failed', error='LEASE_EXPIRED', lease='', finished_at=? WHERE status='running' AND lease_until<=?")
    .bind(new Date(now).toISOString(), now).run();
}
const PROGRESS = "UPDATE sq_backup_runs SET parts=?, commits=?, bytes=?, from_seq=?, to_seq=?, head=?, folder_id=?, lease_until=? WHERE id=? AND lease=? AND status='running' AND lease_until>?";
function progressStatement(env, run, cutoff) {
  return db(env).prepare(PROGRESS).bind(run.parts, run.commits, run.bytes, run.fromSeq, run.toSeq, run.head, run.folderId,
    cutoff + LEASE_MS, run.id, run.lease, cutoff);
}
async function saveProgress(env, run) {
  const r = await progressStatement(env, run, Date.now()).run();
  if (r.meta.changes !== 1) throw fail('LEASE_LOST');
}
async function savePart(env, run, part) {
  const d = db(env);
  const cutoff = Date.now();
  const res = await d.batch([
    d.prepare(`INSERT INTO sq_backup_parts (run_id,part_no,kind,name,drive_id,from_seq,to_seq,commits,bytes,sha256,uploaded_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM sq_backup_runs WHERE id=? AND lease=? AND status='running' AND lease_until>?)`)
      .bind(run.id, part.partNo, part.kind, part.name, part.driveId, part.fromSeq, part.toSeq, part.commits, part.bytes, part.sha256,
        new Date(cutoff).toISOString(), run.id, run.lease, cutoff),
    progressStatement(env, run, cutoff),
  ]);
  if (res[1].meta.changes !== 1) throw fail('LEASE_LOST');
}

/** Same hash as RRS.core.commitHash, with the platform's SHA-256 (fast on large ledgers). */
async function commitHashOk(c) {
  const body = Object.assign({}, c);
  delete body.hash;
  return (await digest(c.prev + util.stable(body))) === c.hash;
}

/**
 * One backup run. opts: {trigger: 'manual'|'scheduled', requestedBy}. → {ok, code?, message?, run?}
 * (never throws for an expected failure: the run row says what happened).
 */
export async function runBackup(env, opts) {
  const trigger = opts && opts.trigger === 'scheduled' ? 'scheduled' : 'manual';
  const cfg = backupConfig(env);
  if (!cfg.enabled) return { ok: false, code: 'DISABLED', message: MESSAGES.DISABLED };
  if (!cfg.configured) return { ok: false, code: 'CONFIGURATION_MISSING', message: MESSAGES.CONFIGURATION_MISSING, missing: cfg.missing, invalid: cfg.invalid };
  const d = db(env);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const day = util.bkkDate(startedAt);
  await expireStale(env, started);
  const run = { id: crypto.randomUUID(), lease: crypto.randomUUID(), trigger, day, parts: 0, commits: 0, bytes: 0, fromSeq: 0, toSeq: 0,
    head: core.GENESIS, folderId: '' };
  const claimed = await d.prepare(`INSERT OR IGNORE INTO sq_backup_runs (id,trigger_kind,day,status,requested_by,lease,lease_until,started_at)
    SELECT ?,?,?,'running',?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM sq_backup_runs WHERE status='running' AND lease_until>?)`)
    .bind(run.id, trigger, day, String((opts && opts.requestedBy) || '').slice(0, 100), run.lease, started + LEASE_MS, startedAt, started).run();
  if (claimed.meta.changes !== 1) {
    const done = trigger === 'scheduled'
      ? await d.prepare("SELECT id FROM sq_backup_runs WHERE trigger_kind='scheduled' AND day=?").bind(day).first() : null;
    const code = done ? 'ALREADY_DONE' : 'BUSY';
    return { ok: false, code, message: MESSAGES[code] };
  }
  const rootId = str(env, 'SQ_DRIVE_BACKUP_FOLDER_ID').trim();
  const maxPart = partBytes(env);
  const nativeSheets = flag(env, 'SQ_SHEETS_EXPORT_ENABLED');
  const projection = nativeSheets ? sheetsProjection() : null;
  let client, spreadsheet, spreadsheetInput;
  try {
    client = driveClient(env);
    await client.validateFolder(rootId);
    const top = await d.prepare('SELECT seq,hash FROM sq_commits ORDER BY seq DESC LIMIT 1').first();
    run.toSeq = top ? Number(top.seq) : 0;
    run.head = top ? top.hash : core.GENESIS;
    run.fromSeq = run.toSeq ? 1 : 0;
    run.folderId = await client.allocateId();
    const folderName = `rrs-stockqc-${day}-${bangkok(started).slice(11, 16).replace(':', '')}-${trigger}-${run.id.slice(0, 8)}`;
    await client.ensureFolder({ id: run.folderId, name: folderName, parentId: rootId, runId: run.id });
    await saveProgress(env, run);

    const parts = [];
    let lines = [];
    let size = 0;
    let first = 0;
    let last = 0;
    const flush = async () => {
      const text = lines.join('');
      const bytes = encoder.encode(text);
      const sha256 = await digest(bytes);
      const partNo = parts.length + 1;
      const name = `commits-${String(partNo).padStart(4, '0')}.jsonl`;
      const id = await client.allocateId();
      await client.uploadFile({ id, name, parentId: run.folderId, runId: run.id, kind: 'commits', mimeType: PART_MIME, bytes, sha256 });
      const part = { partNo, kind: 'commits', name, driveId: id, fromSeq: first, toSeq: last, commits: lines.length, bytes: bytes.length, sha256 };
      parts.push(part);
      run.parts += 1;
      run.commits += lines.length;
      run.bytes += bytes.length;
      await savePart(env, run, part);
      lines = [];
      size = 0;
    };
    let expect = 1;
    let prev = core.GENESIS;
    let after = 0;
    while (after < run.toSeq) {
      const rows = (await d.prepare(`SELECT ${COLUMNS} FROM sq_commits WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?`)
        .bind(after, run.toSeq, READ_CHUNK).all()).results || [];
      if (!rows.length) throw fail('LEDGER_INTEGRITY');
      for (const r of rows) {
        const c = rowToCommit(r);
        if (c.seq !== expect || c.prev !== prev || !(await commitHashOk(c))) throw fail('LEDGER_INTEGRITY');
        if (projection) projectSheetsCommit(projection, c);
        const line = commitJson(r) + '\n';
        const n = encoder.encode(line).length;
        if (n > maxPart) throw fail('PART_TOO_LARGE');
        if (lines.length && size + n > maxPart) await flush();
        if (!lines.length) first = c.seq;
        lines.push(line);
        size += n;
        last = c.seq;
        prev = c.hash;
        expect += 1;
        after = c.seq;
      }
    }
    if (lines.length) await flush();
    if (prev !== run.head) throw fail('LEDGER_INTEGRITY');

    if (projection) {
      const dataset = sheetsDataset(projection, { day, startedAt, toSeq: run.toSeq, head: run.head, runId: run.id });
      spreadsheetInput = { name: `Nexus Part Terminal ${day} ${bangkok(started).slice(11, 16).replace(':', '')}`,
        parentId: run.folderId, runId: run.id, heartbeat: () => saveProgress(env, run) };
      spreadsheet = await exportNativeSpreadsheet(client, dataset, spreadsheetInput);
    }

    const manifest = {
      format: FORMAT, version: 1, complete: true, runId: run.id, trigger, businessDate: day, timezone: 'Asia/Bangkok',
      startedAt, createdAt: new Date().toISOString(), service: 'rrs-stock-qc', environment: str(env, 'SQ_ENV') || 'unset',
      commits: { fromSeq: run.fromSeq, toSeq: run.toSeq, count: run.commits, head: run.head, genesis: core.GENESIS },
      parts: parts.map((p) => ({ partNo: p.partNo, name: p.name, driveId: p.driveId, mimeType: PART_MIME, fromSeq: p.fromSeq, toSeq: p.toSeq,
        commits: p.commits, bytes: p.bytes, sha256: p.sha256 })),
      totals: { parts: parts.length, bytes: run.bytes },
      encoding: 'UTF-8 JSONL: หนึ่งบรรทัด = หนึ่ง commit {seq,id,kind,at,by,via,summary,payloadHash,prev,hash,effects} รูปแบบเดียวกับ GET /api/commits',
      scope: 'ทุก commit ของระบบสต็อกตั้งแต่เริ่มระบบถึง head – เล่นซ้ำตามลำดับแล้วได้ข้อมูลทุกตาราง',
      excluded: ['รหัสผ่าน เซสชัน และค่า secret ทุกชนิด', 'ไฟล์ใน R2 (รูป QC ใบรับรอง ไฟล์นำเข้า) – commit เก็บเฉพาะรหัสไฟล์ sha256',
        'ตารางอ่านเร็ว sq_records และ snapshot ใน R2 (สร้างใหม่ได้จาก commit)', 'บันทึกการเข้าสู่ระบบและเหตุการณ์ความปลอดภัย',
        'บันทึกตัวเชื่อม Sales Office (sq_bridge_*)'],
      restore: { automaticRestore: false,
        instructions: 'ตรวจขนาดและ SHA-256 ของทุกไฟล์ตาม manifest ต่อบรรทัด JSONL ตามลำดับ part แล้วตรวจด้วย RRS.reports.verifyBackup (หน้า "สำรองและกู้คืน") – ลองกู้ในระบบทดสอบที่แยกต่างหากก่อนเสมอ ห้ามเขียนทับระบบจริง' },
    };
    if (spreadsheet) manifest.spreadsheet = spreadsheet;
    const mBytes = encoder.encode(JSON.stringify(manifest, null, 2));
    const mSha = await digest(mBytes);
    const mId = await client.allocateId();
    await client.uploadFile({ id: mId, name: 'manifest.json', parentId: run.folderId, runId: run.id, kind: 'manifest', mimeType: MANIFEST_MIME,
      bytes: mBytes, sha256: mSha });
    await savePart(env, run, { partNo: parts.length + 1, kind: 'manifest', name: 'manifest.json', driveId: mId, fromSeq: run.fromSeq,
      toSeq: run.toSeq, commits: run.commits, bytes: mBytes.length, sha256: mSha });
    const done = await d.prepare("UPDATE sq_backup_runs SET status='ok', error='', lease='', lease_until=0, finished_at=? WHERE id=? AND lease=? AND status='running'")
      .bind(new Date().toISOString(), run.id, run.lease).run();
    if (done.meta.changes !== 1) throw fail('LEASE_LOST');
    return { ok: true, run: Object.assign(publicRun(await runRow(env, run.id)), spreadsheet ? { spreadsheet } : {}) };
  } catch (e) {
    if (spreadsheet) await client.markSpreadsheet(Object.assign({}, spreadsheetInput, { id: spreadsheet.id }), 'failed').catch(() => {});
    const code = errorCode(e);
    await d.prepare("UPDATE sq_backup_runs SET status='failed', error=?, lease='', lease_until=0, finished_at=? WHERE id=? AND lease=? AND status='running'")
      .bind(code, new Date().toISOString(), run.id, run.lease).run();
    await securityEvent(env, null, code === 'LEDGER_INTEGRITY' ? 'ledger_integrity' : 'drive_backup_failed',
      code === 'LEDGER_INTEGRITY' ? 'critical' : 'warning', `${trigger} ${run.id}: ${code}`);
    const row = await runRow(env, run.id);
    return { ok: false, code, message: MESSAGES[code] || MESSAGES.INTERNAL_ERROR, run: row ? publicRun(row) : null };
  }
}

/** Cron: only when switched on and fully configured (otherwise nothing is called). */
export async function scheduledBackup(env) {
  const cfg = backupConfig(env);
  if (!cfg.enabled) return { ok: false, skipped: true, code: 'DISABLED' };
  if (!cfg.configured) return { ok: false, skipped: true, code: 'CONFIGURATION_MISSING' };
  return runBackup(env, { trigger: 'scheduled', requestedBy: 'cron' });
}

const RUN_COLUMNS = 'id,trigger_kind,day,status,from_seq,to_seq,head,commits,bytes,parts,folder_id,requested_by,error,started_at,finished_at,lease_until';
async function runRow(env, id) {
  return db(env).prepare(`SELECT ${RUN_COLUMNS} FROM sq_backup_runs WHERE id=?`).bind(id).first();
}
function publicRun(r) {
  return {
    id: r.id, trigger: r.trigger_kind, day: r.day, status: r.status, fromSeq: Number(r.from_seq), toSeq: Number(r.to_seq), head: r.head,
    commits: Number(r.commits), parts: Number(r.parts), bytes: Number(r.bytes), requestedBy: r.requested_by,
    folderUrl: r.status === 'ok' && r.folder_id ? 'https://drive.google.com/drive/folders/' + encodeURIComponent(r.folder_id) : null,
    error: r.error || null, message: r.error ? MESSAGES[r.error] || MESSAGES.INTERNAL_ERROR : null, startedAt: r.started_at, finishedAt: r.finished_at || null,
  };
}

/** GET /api/backup/status: settings present (names only), schedule, the last runs. Never a value or a token. */
export async function backupStatus(env) {
  const cfg = backupConfig(env);
  const now = Date.now();
  const rows = (await db(env).prepare(`SELECT ${RUN_COLUMNS} FROM sq_backup_runs ORDER BY started_at DESC, id DESC LIMIT 10`).all()).results || [];
  const lastOk = await db(env).prepare(`SELECT ${RUN_COLUMNS} FROM sq_backup_runs WHERE status='ok' ORDER BY started_at DESC LIMIT 1`).first();
  return {
    ok: true, enabled: cfg.enabled, configured: cfg.configured, missing: cfg.missing, invalid: cfg.invalid,
    schedule: { cron: BACKUP_CRON, time: '03:00', timezone: 'Asia/Bangkok', active: cfg.enabled && cfg.configured },
    nativeSheets: { enabled: flag(env, 'SQ_SHEETS_EXPORT_ENABLED'), format: 'google-sheets', snapshotOnly: true },
    partBytes: PART_BYTES,
    running: rows.some((r) => r.status === 'running' && Number(r.lease_until) > now),
    lastOk: lastOk ? publicRun(lastOk) : null,
    runs: rows.map(publicRun),
  };
}
