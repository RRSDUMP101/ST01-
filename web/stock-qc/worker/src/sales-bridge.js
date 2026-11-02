// Sales Office connector (BACKEND_DESIGN.md "Sales Office connector") – the client side of Sales Office's Part List
// bridge, protocol exactly as branch codex/rrs-workflow-partlist-20261027 (lib/rrs/partlist-bridge.ts,
// lib/rrs/partlist-store.ts, lib/rrs/operations-schema.ts):
//   GET  {SQ_SALES_URL}/api/rrs/partlist/bridge?mode=domestic|export[&cursor=…]  → {commands, nextCursor, serverTime}
//   POST same URL {events:[≤ 20]}                                                → {accepted:[eventId], rejected:[{eventId, code}]}
//   headers Authorization: Bearer <secret of that workspace>, X-RRS-Connector-Id. HTTP 503 = try again later.
//
// Modes (SQ_SALES_BRIDGE): off (default – no request of any kind) | pull (GET only, never POST) | pull_push.
// Domestic and Export are separate all the way: their own secret (each ≥ 32 characters and never the same value – like
// Sales Office), their own lease, a command must carry the workspace of the feed it came from, the engine job key holds
// the workspace, and events are only built for jobs of that workspace. Nothing is ever matched by customer name; the
// customer name and SO owner are dropped from the journal (sq_bridge_commands keeps IDs, lines, release, hashes).
//
// Pull: every page (nextCursor until null) → each command checked (envelope, workspace, sha256(payload) = payloadHash)
//   → sq_bridge_commands deduped by (workspace, command id) + payload hash. A known command id with another payload, or
//   the same job + version under another command id → status/issue 'blocked' and recorded in sq_bridge_issues, never
//   applied. New versions go through the server ledger as engine command sales.syncJob, run as the engine user bound
//   to the owner account (ADMIN_USERNAME) with via 'sales-bridge:<workspace>' – one hash-chained commit each.
// Push (pull_push): per job whose stock status changed (content hash without sourceVersion/observedAt) one event:
//   eventId = sha256 of the event content (status included), sourceVersion = previous + 1 per job, observedAt = now;
//   stored in sq_bridge_events first, then sent ≤ 20 per POST and ≤ 1 MB per request; the exact stored event is re-sent
//   until Sales Office answers (503/429/5xx/timeouts and its own 'conflict' rejection = later). Results and rejection
//   codes are recorded per event.
import { db, str, bridgeMode, HttpError } from './runtime.js';
import { digest, securityEvent } from './security.js';
import { boundedFetch, jsonObject, OutboundError, errorCode } from './outbound.js';
import * as ledger from './ledger.js';

const RRS = globalThis.RRS;

export const SYNC_CRON = '*/15 * * * *';
export const WORKSPACES = ['domestic', 'export'];
export const BRIDGE_PATH = '/api/rrs/partlist/bridge';
const SECRET_ENV = { domestic: 'SQ_SALES_DOMESTIC_SECRET', export: 'SQ_SALES_EXPORT_SECRET' };
const MAX_PAGES = 40; // × ≤ 50 commands per page (Sales Office) per run; the rest continues next run from the cursor
const PAGE_MAX_BYTES = 3 * 1024 * 1024; // Sales Office pages are ≤ 1.5 MB
const POST_MAX_BYTES = 256 * 1024; // answer to a POST
export const POST_BODY_BYTES = 1000000; // request body budget: Sales Office refuses more than 1 MiB (1048576 bytes) with 413
export const EVENTS_PER_POST = 20;
const MAX_POSTS = 25;
const LEASE_MS = 5 * 60 * 1000;
const MAX_COMMAND_BYTES = 250000;
const HEX64 = /^[a-f0-9]{64}$/;
const JOB_ID_RE = /^[A-Za-z0-9._:@/-]{1,120}$/;
const CTRL = /[\u0000-\u001f\u007f]/;
const HEADER_SAFE = /^[\x21-\x7e]+$/;
const BLOCKING_ENGINE_CODES = { BAD_COMMAND: true, PAYLOAD_HASH: true, MAPPING_CONFLICT: true };
const SYSTEM_ENGINE_CODES = { NO_PERMISSION: true, BRIDGE_ONLY: true, NO_USER: true, USER_INACTIVE: true, UNKNOWN_COMMAND: true };

export const MESSAGES = {
  BRIDGE_OFF: 'ตัวเชื่อม Sales Office ปิดอยู่ (SQ_SALES_BRIDGE=off)',
  NOT_CONFIGURED: 'ยังตั้งค่าตัวเชื่อมของพื้นที่นี้ไม่ครบหรือไม่ปลอดภัย',
  BUSY: 'กำลังซิงก์พื้นที่นี้อยู่ – รอรอบเดิมเสร็จก่อน',
  OWNER_NOT_BOUND: 'บัญชีเจ้าของระบบยังไม่ผูกกับผู้ใช้ในระบบสต็อก – ตัวเชื่อมบันทึกใบงานไม่ได้',
  OWNER_NO_PERMISSION: 'ผู้ใช้ที่ผูกกับบัญชีเจ้าของระบบไม่มีสิทธิ์จัดการใบงาน (job.manage) หรือถูกปิดใช้งาน',
  AUTH_FAILED: 'Sales Office ไม่รับรหัสตัวเชื่อม – ตรวจ SQ_SALES_CONNECTOR_ID และ secret ของพื้นที่นี้',
  SALES_UNAVAILABLE: 'Sales Office ไม่พร้อมชั่วคราว (503) – จะลองใหม่รอบถัดไป',
  SALES_RATE_LIMITED: 'Sales Office จำกัดจำนวนคำขอ – จะลองใหม่รอบถัดไป',
  SALES_ERROR: 'Sales Office ตอบกลับผิดพลาด',
  SALES_BAD_REQUEST: 'Sales Office ไม่รับรูปแบบคำขอ',
  INVALID_SALES_RESPONSE: 'คำตอบจาก Sales Office ไม่ถูกต้อง',
  CURSOR_LOOP: 'Sales Office ส่ง cursor ซ้ำ – หยุดดึงเพื่อไม่ให้วนไม่จบ',
  REQUEST_TIMEOUT: 'Sales Office ไม่ตอบในเวลาที่กำหนด – จะลองใหม่รอบถัดไป',
  NETWORK_UNCERTAIN: 'เชื่อมต่อ Sales Office ไม่สำเร็จ – จะลองใหม่รอบถัดไป',
  UNEXPECTED_REDIRECT: 'Sales Office ตอบแบบเปลี่ยนเส้นทาง – ไม่ส่งรหัสตัวเชื่อมต่อ',
  RESPONSE_TOO_LARGE: 'คำตอบจาก Sales Office ใหญ่ผิดปกติ',
  LEASE_LOST: 'รอบซิงก์นี้หมดเวลา',
  LEDGER_BUSY: 'มีผู้บันทึกพร้อมกันมาก – จะลองใหม่รอบถัดไป',
  LEDGER_INTEGRITY: 'ข้อมูล commit ไม่ตรงลายนิ้วมือ – หยุดบันทึก แจ้งผู้ดูแลระบบ',
  NO_USER: 'บัญชีเจ้าของระบบยังไม่ผูกกับผู้ใช้ในระบบสต็อก',
  USER_INACTIVE: 'ผู้ใช้ที่ผูกกับบัญชีเจ้าของระบบถูกปิดใช้งาน',
  NO_PERMISSION: 'ผู้ใช้ที่ผูกกับบัญชีเจ้าของระบบไม่มีสิทธิ์จัดการใบงาน',
  INTERNAL_ERROR: 'ซิงก์ไม่สำเร็จ',
  // command / issue codes
  INVALID_COMMAND: 'คำสั่งจาก Sales Office รูปแบบไม่ถูกต้อง',
  TOO_LARGE: 'คำสั่งจาก Sales Office ใหญ่เกิน 250,000 bytes',
  WORKSPACE_MISMATCH: 'คำสั่งของอีกพื้นที่หนึ่งมาในช่องทางนี้ – ไม่รับ',
  PAYLOAD_HASH_MISMATCH: 'ลายนิ้วมือข้อมูลคำสั่งไม่ตรงกับข้อมูล – ไม่รับ',
  PAYLOAD_CONFLICT: 'รหัสคำสั่งเดิมแต่ข้อมูลต่างจากที่เคยรับ – หยุดไว้ให้ตรวจ',
  VERSION_CONFLICT: 'งานและฉบับเดียวกันมาด้วยรหัสคำสั่งอื่น – หยุดไว้ให้ตรวจ',
  BAD_COMMAND: 'ข้อมูลคำสั่งไม่ผ่านการตรวจ',
  PAYLOAD_HASH: 'ลายนิ้วมือข้อมูลคำสั่งไม่ตรง',
  MAPPING_CONFLICT: 'รหัสงานผูกกับ SO หรือใบงานอื่นอยู่แล้ว',
  OLDER_VERSION: 'มีคำสั่งฉบับใหม่กว่าแล้ว',
};
const fail = (code, retryable) => new OutboundError(code, retryable);
const nowIso = () => new Date().toISOString();

// ---- configuration (names and problem codes only, never a value) --------------------------------------------------
export function salesConfig(env) {
  const mode = bridgeMode(env);
  const problems = [];
  const raw = str(env, 'SQ_SALES_URL').trim();
  let origin = '';
  let host = '';
  if (!raw) problems.push('SQ_SALES_URL_MISSING');
  else {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) problems.push('SQ_SALES_URL_INVALID');
      else {
        origin = u.origin;
        host = u.host;
      }
    } catch (e) {
      problems.push('SQ_SALES_URL_INVALID');
    }
  }
  const connectorId = str(env, 'SQ_SALES_CONNECTOR_ID').trim();
  if (!connectorId) problems.push('SQ_SALES_CONNECTOR_ID_MISSING');
  else if (connectorId.length > 200 || !HEADER_SAFE.test(connectorId)) problems.push('SQ_SALES_CONNECTOR_ID_INVALID');
  const domestic = str(env, SECRET_ENV.domestic);
  const exp = str(env, SECRET_ENV.export);
  if (domestic && domestic === exp) problems.push('SQ_SALES_SECRETS_EQUAL');
  if (!str(env, 'ADMIN_USERNAME')) problems.push('ADMIN_USERNAME_MISSING');
  const workspaces = {};
  for (const ws of WORKSPACES) {
    const secret = ws === 'domestic' ? domestic : exp;
    const own = [];
    if (!secret) own.push(SECRET_ENV[ws] + '_MISSING');
    else if (secret.length < 32) own.push(SECRET_ENV[ws] + '_TOO_SHORT');
    else if (secret.length > 4096 || !HEADER_SAFE.test(secret)) own.push(SECRET_ENV[ws] + '_INVALID');
    workspaces[ws] = { ready: !problems.length && !own.length, problems: own };
  }
  return { mode, origin, host, connectorId, problems, workspaces, ready: WORKSPACES.some((ws) => workspaces[ws].ready) };
}
const secretOf = (env, ws) => str(env, SECRET_ENV[ws]);

// ---- leases (sq_leases): one sync per workspace at a time -----------------------------------------------------------
async function acquireLease(env, name) {
  const holder = crypto.randomUUID();
  const now = Date.now();
  const r = await db(env).prepare(`INSERT INTO sq_leases (name,holder,lease_until,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET holder=excluded.holder, lease_until=excluded.lease_until, updated_at=excluded.updated_at
    WHERE sq_leases.lease_until<=?`).bind(name, holder, now + LEASE_MS, new Date(now).toISOString(), now).run();
  return r.meta.changes === 1 ? holder : null;
}
async function renewLease(env, name, holder) {
  const now = Date.now();
  const r = await db(env).prepare('UPDATE sq_leases SET lease_until=?, updated_at=? WHERE name=? AND holder=? AND lease_until>?')
    .bind(now + LEASE_MS, new Date(now).toISOString(), name, holder, now).run();
  if (r.meta.changes !== 1) throw fail('LEASE_LOST');
}
async function releaseLease(env, name, holder) {
  await db(env).prepare('UPDATE sq_leases SET lease_until=0, updated_at=? WHERE name=? AND holder=?').bind(nowIso(), name, holder).run();
}

// ---- HTTP to Sales Office ----------------------------------------------------------------------------------------
function bridgeUrl(ctx, cursor) {
  return `${ctx.origin}${BRIDGE_PATH}?mode=${ctx.ws}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
}
function headers(ctx, json) {
  const h = { Authorization: `Bearer ${ctx.secret}`, 'X-RRS-Connector-Id': ctx.connectorId, Accept: 'application/json' };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}
function httpError(status) {
  if (status === 401 || status === 403) return fail('AUTH_FAILED');
  if (status === 503) return fail('SALES_UNAVAILABLE', true);
  if (status === 429) return fail('SALES_RATE_LIMITED', true);
  if (status === 400 || status === 413) return fail('SALES_BAD_REQUEST');
  return fail('SALES_ERROR', status >= 500);
}

// ---- journal --------------------------------------------------------------------------------------------------------
/** Records a command that needs a person (deduplicated; the first time also a security event). Never the payload. */
async function recordIssue(env, ws, code, f) {
  const at = nowIso();
  const id = await digest(['issue', ws, code, f.commandId || '', f.jobId || '', f.version || 0, f.receivedHash || ''].join('\n'));
  const row = await db(env).prepare(`INSERT INTO sq_bridge_issues (id,workspace,code,command_id,job_id,version,known_hash,received_hash,detail,first_seen_at,last_seen_at,seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at, seen=seen+1 RETURNING seen`)
    .bind(id, ws, code, String(f.commandId || '').slice(0, 500), String(f.jobId || '').slice(0, 200), Number.isSafeInteger(f.version) ? f.version : 0,
      f.knownHash || '', f.receivedHash || '', String(f.detail || MESSAGES[code] || '').slice(0, 500), at, at).first();
  if (row && Number(row.seen) === 1) {
    await securityEvent(env, null, 'sales_bridge_' + code.toLowerCase(), 'warning', `${ws} ${String(f.commandId || '').slice(0, 80)} ${String(f.jobId || '').slice(0, 80)} v${f.version || 0}`);
  }
}
async function setCommandStatus(env, ws, commandId, status, error, seq) {
  await db(env).prepare('UPDATE sq_bridge_commands SET status=?, error=?, applied_seq=COALESCE(?, applied_seq) WHERE workspace=? AND command_id=?')
    .bind(status, String(error || '').slice(0, 300), seq == null ? null : seq, ws, commandId).run();
}
/** The command as stored in the journal: customer name and SO owner left out (IDs, lines and release stay). */
function journalText(cmd) {
  const payload = Object.assign({}, cmd.payload);
  delete payload.customerName;
  delete payload.owner;
  return JSON.stringify(Object.assign({}, cmd, { payload }));
}

/** Envelope checks before anything is stored or applied (the engine checks the payload fields again). */
async function envelope(ws, raw) {
  const out = { ok: false, code: 'INVALID_COMMAND', commandId: '', jobId: '', version: 0, receivedHash: '' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.commandId === 'string') out.commandId = raw.commandId.slice(0, 500);
  if (typeof raw.productionJobId === 'string') out.jobId = raw.productionJobId.slice(0, 200);
  if (Number.isSafeInteger(raw.version)) out.version = raw.version;
  if (typeof raw.payloadHash === 'string') out.receivedHash = raw.payloadHash.slice(0, 64);
  const text = JSON.stringify(raw);
  if (new TextEncoder().encode(text).length > MAX_COMMAND_BYTES) return Object.assign(out, { code: 'TOO_LARGE' });
  if (raw.schemaVersion !== 1 || raw.type !== 'upsert_draft') return out;
  if (typeof raw.commandId !== 'string' || !raw.commandId.trim() || raw.commandId.length > 500 || CTRL.test(raw.commandId)) return out;
  if (typeof raw.orderId !== 'string' || !raw.orderId.trim() || raw.orderId.length > 500 || CTRL.test(raw.orderId)) return out;
  if (typeof raw.productionJobId !== 'string' || !JOB_ID_RE.test(raw.productionJobId)) return out;
  if (!Number.isSafeInteger(raw.version) || raw.version < 1) return out;
  if (typeof raw.payloadHash !== 'string' || !HEX64.test(raw.payloadHash)) return out;
  if (!raw.payload || typeof raw.payload !== 'object' || Array.isArray(raw.payload)) return out;
  if (raw.workspace !== ws) return Object.assign(out, { code: 'WORKSPACE_MISMATCH' });
  if ((await digest(JSON.stringify(raw.payload))) !== raw.payloadHash) return Object.assign(out, { code: 'PAYLOAD_HASH_MISMATCH' });
  return { ok: true, command: raw, commandId: raw.commandId, jobId: raw.productionJobId, orderId: raw.orderId, version: raw.version,
    payloadHash: raw.payloadHash, receivedHash: raw.payloadHash };
}

// so.<workspace>.<…>: a request-id namespace only server jobs may use (ledger.normalizeCommand refuses it from a page).
const requestIdFor = async (ws, commandId) => `${ledger.SERVER_REQUEST_PREFIX}${ws}.${(await digest(commandId)).slice(0, 48)}`;

/** Applies one journaled command through the server ledger. Throws an OutboundError for a problem that stops the run. */
async function apply(env, ctx, c) {
  const state = await ledger.catchUp(env);
  const key = RRS.sales.jobKeyFor(ctx.ws, c.jobId);
  const job = (state.tables.jobs || {})[key];
  if (job && job.source === 'sales' && job.productionJobId === c.jobId && job.orderId === c.orderId && (job.salesVersion || 0) >= c.version) {
    await setCommandStatus(env, ctx.ws, c.commandId, 'ignored', 'OLDER_VERSION');
    ctx.summary.ignored += 1;
    return;
  }
  let r;
  try {
    r = await ledger.execute(env, { kind: 'sales.syncJob', payload: c.command, requestId: await requestIdFor(ctx.ws, c.commandId) }, ctx.session,
      { via: 'sales-bridge:' + ctx.ws });
  } catch (e) {
    const code = e instanceof HttpError && e.extra && e.extra.code ? (e.extra.code === 'BUSY' ? 'LEDGER_BUSY' : e.extra.code) : errorCode(e);
    await setCommandStatus(env, ctx.ws, c.commandId, 'failed', code);
    ctx.summary.failed += 1;
    throw fail(code, code === 'LEDGER_BUSY');
  }
  if (r.ok) {
    await setCommandStatus(env, ctx.ws, c.commandId, 'applied', '', r.duplicate ? r.seq : r.commit.seq);
    ctx.summary.applied += 1;
    return;
  }
  const first = (r.errors && r.errors[0]) || { code: 'INTERNAL_ERROR', message: '' };
  const detail = `${first.code}: ${String(first.message || '').slice(0, 250)}`;
  if (first.code === 'OLDER_VERSION') {
    await setCommandStatus(env, ctx.ws, c.commandId, 'ignored', detail);
    ctx.summary.ignored += 1;
  } else if (BLOCKING_ENGINE_CODES[first.code]) {
    await setCommandStatus(env, ctx.ws, c.commandId, 'blocked', detail);
    await recordIssue(env, ctx.ws, first.code, { commandId: c.commandId, jobId: c.jobId, version: c.version, receivedHash: c.payloadHash, detail });
    ctx.summary.blocked += 1;
  } else {
    await setCommandStatus(env, ctx.ws, c.commandId, 'failed', detail);
    ctx.summary.failed += 1;
    if (SYSTEM_ENGINE_CODES[first.code]) throw fail(first.code);
  }
}

/** One page of commands: envelope → journal (dedupe/conflicts) → apply. */
async function handleCommands(env, ctx, commands) {
  const d = db(env);
  const ws = ctx.ws;
  const checked = [];
  for (const raw of commands) {
    const c = await envelope(ws, raw);
    ctx.summary.received += 1;
    if (!c.ok) {
      await recordIssue(env, ws, c.code, c);
      ctx.summary.blocked += 1;
      continue;
    }
    checked.push(c);
  }
  if (!checked.length) return;
  const known = {};
  for (const r of (await d.prepare('SELECT command_id,payload_hash,status,error,job_id,version FROM sq_bridge_commands WHERE workspace=? AND command_id IN (SELECT value FROM json_each(?))')
    .bind(ws, JSON.stringify(checked.map((c) => c.commandId))).all()).results || []) known[r.command_id] = r;
  const byJobVersion = {};
  for (const r of (await d.prepare(`SELECT command_id,job_id,version FROM sq_bridge_commands WHERE workspace=? AND (job_id,version) IN
    (SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(?))`)
    .bind(ws, JSON.stringify(checked.map((c) => [c.jobId, c.version]))).all()).results || []) byJobVersion[r.job_id + '\n' + r.version] = r;
  for (const c of checked) {
    const k = known[c.commandId];
    if (k) {
      if (k.payload_hash !== c.payloadHash) {
        if (k.status !== 'blocked' || !/^PAYLOAD_CONFLICT/.test(String(k.error || ''))) await setCommandStatus(env, ws, c.commandId, 'blocked', 'PAYLOAD_CONFLICT');
        await recordIssue(env, ws, 'PAYLOAD_CONFLICT', { commandId: c.commandId, jobId: c.jobId, version: c.version, knownHash: k.payload_hash, receivedHash: c.payloadHash });
        ctx.summary.blocked += 1;
        continue;
      }
      if (k.status === 'applied' || k.status === 'ignored') {
        ctx.summary.unchanged += 1;
        continue;
      }
      if (k.status === 'blocked') {
        // still blocked: count the sighting on its issue row (same id → seen + 1)
        const code = String(k.error || '').split(':')[0];
        if (/^[A-Z][A-Z_]{1,40}$/.test(code)) {
          await recordIssue(env, ws, code, { commandId: c.commandId, jobId: c.jobId, version: c.version, receivedHash: c.payloadHash });
        }
        ctx.summary.blocked += 1;
        continue;
      }
    } else {
      const other = byJobVersion[c.jobId + '\n' + c.version];
      if (other && other.command_id !== c.commandId) {
        await recordIssue(env, ws, 'VERSION_CONFLICT', { commandId: c.commandId, jobId: c.jobId, version: c.version, receivedHash: c.payloadHash,
          detail: `${MESSAGES.VERSION_CONFLICT} (รหัสเดิม ${String(other.command_id).slice(0, 120)})` });
        ctx.summary.blocked += 1;
        continue;
      }
      const ins = await d.prepare(`INSERT INTO sq_bridge_commands (workspace,command_id,job_id,order_id,version,payload_hash,payload,received_at,status)
        VALUES (?,?,?,?,?,?,?,?,'received') ON CONFLICT DO NOTHING`)
        .bind(ws, c.commandId, c.jobId, c.orderId, c.version, c.payloadHash, journalText(c.command), nowIso()).run();
      if (ins.meta.changes !== 1) {
        // another run stored it a moment ago (or a job/version clash appeared): the next run looks again
        ctx.summary.unchanged += 1;
        continue;
      }
    }
    await apply(env, ctx, c);
  }
}

async function saveHealth(env, ctx, fields) {
  const at = nowIso();
  await db(env).prepare(`INSERT INTO sq_bridge_health (workspace,connector_id,pull_cursor,last_pull_at,last_push_at,last_error,updated_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(workspace) DO UPDATE SET connector_id=excluded.connector_id,
      pull_cursor=CASE WHEN ?8 THEN excluded.pull_cursor ELSE sq_bridge_health.pull_cursor END,
      last_pull_at=COALESCE(excluded.last_pull_at, sq_bridge_health.last_pull_at),
      last_push_at=COALESCE(excluded.last_push_at, sq_bridge_health.last_push_at),
      last_error=excluded.last_error, updated_at=excluded.updated_at`)
    .bind(ctx.ws, ctx.connectorId, fields.cursor === undefined ? '' : fields.cursor, fields.pulled ? at : null, fields.pushed ? at : null,
      fields.error || '', at, fields.cursor === undefined ? 0 : 1).run();
}

async function pull(env, ctx) {
  const row = await db(env).prepare('SELECT pull_cursor FROM sq_bridge_health WHERE workspace=?').bind(ctx.ws).first();
  let cursor = (row && row.pull_cursor) || '';
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await boundedFetch(bridgeUrl(ctx, cursor), { method: 'GET', headers: headers(ctx) }, { maxBytes: PAGE_MAX_BYTES });
    if (res.status !== 200) throw httpError(res.status);
    const body = jsonObject(res);
    const next = body && body.nextCursor;
    if (!body || !Array.isArray(body.commands) || body.commands.length > 200
      || !(next === null || next === undefined || (typeof next === 'string' && next.length <= 500))) throw fail('INVALID_SALES_RESPONSE');
    ctx.summary.pages += 1;
    await handleCommands(env, ctx, body.commands);
    await renewLease(env, ctx.leaseName, ctx.holder);
    if (!next) {
      await saveHealth(env, ctx, { cursor: '', pulled: true });
      return;
    }
    if (next === cursor || seen.has(next)) throw fail('CURSOR_LOOP');
    seen.add(next);
    cursor = next;
  }
  // page limit reached: continue from here next run (the page budget bounds one run's time and requests)
  await saveHealth(env, ctx, { cursor, pulled: true });
  ctx.summary.more = true;
}

// ---- push -----------------------------------------------------------------------------------------------------------
const REJECT_CODE = /^[a-z][a-z0-9_]{0,59}$/;
// Rejection codes that are Sales Office's own temporary state, not a verdict on the event: 'conflict' = its workspace
// revision CAS lost 3 times in a row (partlist-bridge.ts acceptEvent). The same stored event is sent again next run.
const RETRY_REJECTIONS = { conflict: true };
async function markEvents(env, ws, rows, result, error) {
  if (!rows.length) return;
  const d = db(env);
  const at = nowIso();
  await d.batch(rows.map((r) => d.prepare("UPDATE sq_bridge_events SET result=?, error=?, sent_at=? WHERE workspace=? AND event_id=? AND result='pending'")
    .bind(result, typeof error === 'function' ? error(r) : error || '', at, ws, r.event_id)));
}
/**
 * Pending rows → POST batches of at most `maxEvents` events and about `maxBytes` of request body (Sales Office: ≤ 20
 * events and ≤ 1 MiB per request). A single event bigger than the budget goes alone (Sales Office then answers 413).
 */
export function packEvents(rows, maxEvents, maxBytes) {
  const batches = [];
  let cur = [];
  let size = 0;
  const OVERHEAD = '{"events":[]}'.length;
  for (const r of rows) {
    const n = new TextEncoder().encode(r.payload).length + 1;
    if (cur.length && (cur.length >= maxEvents || OVERHEAD + size + n > maxBytes)) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(r);
    size += n;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
/** POST stored events; a 400/413 for a batch is retried event by event so one bad event cannot hold the rest. */
async function postEvents(env, ctx, rows) {
  const events = rows.map((r) => JSON.parse(r.payload));
  const res = await boundedFetch(bridgeUrl(ctx, ''), { method: 'POST', headers: headers(ctx, true), body: JSON.stringify({ events }) },
    { maxBytes: POST_MAX_BYTES });
  ctx.summary.posts += 1;
  if (res.status === 200) {
    const body = jsonObject(res);
    if (!body || !Array.isArray(body.accepted) || !Array.isArray(body.rejected)) throw fail('INVALID_SALES_RESPONSE');
    const accepted = new Set(body.accepted.filter((x) => typeof x === 'string'));
    const rejected = {};
    for (const x of body.rejected) {
      if (x && typeof x.eventId === 'string') rejected[x.eventId] = typeof x.code === 'string' && REJECT_CODE.test(x.code) ? x.code : 'rejected';
    }
    const ok = rows.filter((r) => accepted.has(r.event_id));
    const no = rows.filter((r) => !accepted.has(r.event_id) && rejected[r.event_id] && !RETRY_REJECTIONS[rejected[r.event_id]]);
    const later = rows.filter((r) => !accepted.has(r.event_id) && RETRY_REJECTIONS[rejected[r.event_id]]);
    await markEvents(env, ctx.ws, ok, 'accepted', '');
    await markEvents(env, ctx.ws, no, 'rejected', (r) => rejected[r.event_id]);
    if (later.length) {
      // stays pending (re-sent unchanged next run); the code is kept so the status page shows why
      const d = db(env);
      await d.batch(later.map((r) => d.prepare("UPDATE sq_bridge_events SET error=?, sent_at=? WHERE workspace=? AND event_id=? AND result='pending'")
        .bind(rejected[r.event_id], nowIso(), ctx.ws, r.event_id)));
    }
    ctx.summary.accepted += ok.length;
    ctx.summary.rejected += no.length;
    ctx.summary.retryLater += rows.length - ok.length - no.length;
    return;
  }
  if ((res.status === 400 || res.status === 413) && rows.length > 1) {
    for (const r of rows) await postEvents(env, ctx, [r]);
    return;
  }
  if (res.status === 400 || res.status === 413) {
    await markEvents(env, ctx.ws, rows, 'rejected', res.status === 413 ? 'too_large' : 'bad_request');
    ctx.summary.rejected += rows.length;
    return;
  }
  throw httpError(res.status);
}

async function push(env, ctx) {
  const d = db(env);
  const ws = ctx.ws;
  const state = await ledger.catchUp(env);
  const jobs = RRS.sales.jobs(state, { workspace: ws }).filter((j) => j.salesCommandId && j.productionJobId);
  const latest = {};
  for (const r of (await d.prepare(`SELECT e.job_id, e.source_version, e.event_hash, e.result FROM sq_bridge_events e WHERE e.workspace=?
    AND e.source_version=(SELECT MAX(x.source_version) FROM sq_bridge_events x WHERE x.workspace=e.workspace AND x.job_id=e.job_id)`).bind(ws).all()).results || []) {
    latest[r.job_id] = r;
  }
  const commandState = {};
  const newest = {};
  for (const r of (await d.prepare('SELECT command_id, job_id, version, status FROM sq_bridge_commands WHERE workspace=?').bind(ws).all()).results || []) {
    commandState[r.command_id] = r.status;
    if (r.status !== 'ignored') newest[r.job_id] = Math.max(newest[r.job_id] || 0, Number(r.version));
  }
  const now = nowIso();
  const statements = [];
  for (const job of jobs) {
    // a newer command from Sales Office is waiting (failed/blocked): Sales Office would refuse a status bound to the old one
    if ((newest[job.productionJobId] || 0) > (job.salesVersion || 0) || commandState[job.salesCommandId] !== 'applied') {
      ctx.summary.waiting += 1;
      continue;
    }
    const prev = latest[job.productionJobId];
    const status = RRS.sales.statusFor(state, job.jobNo, prev ? Number(prev.source_version) : 0, { now });
    if (!status) continue;
    const binding = { commandId: job.salesCommandId, commandVersion: job.salesVersion, payloadHash: job.salesPayloadHash, workspace: ws,
      orderId: job.orderId, productionJobId: job.productionJobId };
    const contentHash = await digest(RRS.util.stable({ binding, status: RRS.sales.statusContent(status) }));
    if (prev && prev.event_hash === contentHash) continue; // nothing changed since the last event (a pending one is re-sent below)
    const event = Object.assign({ eventId: '' }, binding, { status });
    const body = Object.assign({}, event);
    delete body.eventId;
    event.eventId = await digest(RRS.util.stable(body));
    statements.push(d.prepare("UPDATE sq_bridge_events SET result='superseded' WHERE workspace=? AND job_id=? AND result='pending'").bind(ws, job.productionJobId));
    statements.push(d.prepare(`INSERT INTO sq_bridge_events (workspace,event_id,event_hash,job_id,command_id,source_version,payload,created_at,result)
      VALUES (?,?,?,?,?,?,?,?,'pending') ON CONFLICT DO NOTHING`)
      .bind(ws, event.eventId, contentHash, job.productionJobId, job.salesCommandId, status.sourceVersion, JSON.stringify(event), now));
    ctx.summary.queued += 1;
  }
  for (let i = 0; i < statements.length; i += 50) await d.batch(statements.slice(i, i + 50));
  const pending = (await d.prepare("SELECT event_id, payload FROM sq_bridge_events WHERE workspace=? AND result='pending' ORDER BY job_id, source_version LIMIT ?")
    .bind(ws, EVENTS_PER_POST * MAX_POSTS).all()).results || [];
  const batches = packEvents(pending, EVENTS_PER_POST, POST_BODY_BYTES);
  for (const batch of batches.slice(0, MAX_POSTS)) {
    await postEvents(env, ctx, batch);
    await renewLease(env, ctx.leaseName, ctx.holder);
  }
  if (batches.length > MAX_POSTS) ctx.summary.more = true; // the rest stays pending for the next run
  await saveHealth(env, ctx, { pushed: true });
}

// ---- runs -----------------------------------------------------------------------------------------------------------
function emptySummary(ws) {
  return { workspace: ws, received: 0, applied: 0, ignored: 0, unchanged: 0, blocked: 0, failed: 0, pages: 0, more: false,
    queued: 0, posts: 0, accepted: 0, rejected: 0, retryLater: 0, waiting: 0 };
}

async function syncWorkspace(env, cfg, ws) {
  const summary = emptySummary(ws);
  if (!cfg.workspaces[ws].ready) return Object.assign(summary, { skipped: true, code: 'NOT_CONFIGURED', message: MESSAGES.NOT_CONFIGURED,
    problems: cfg.problems.concat(cfg.workspaces[ws].problems) });
  const owner = str(env, 'ADMIN_USERNAME');
  const state = await ledger.catchUp(env);
  const user = ledger.engineUserFor(state, owner);
  if (!user) return Object.assign(summary, { skipped: true, code: 'OWNER_NOT_BOUND', message: MESSAGES.OWNER_NOT_BOUND });
  if (user.active === false || !RRS.auth.can(user, 'job.manage')) {
    return Object.assign(summary, { skipped: true, code: 'OWNER_NO_PERMISSION', message: MESSAGES.OWNER_NO_PERMISSION });
  }
  const leaseName = 'sales-sync:' + ws;
  const holder = await acquireLease(env, leaseName);
  if (!holder) return Object.assign(summary, { skipped: true, code: 'BUSY', message: MESSAGES.BUSY });
  const ctx = { ws, origin: cfg.origin, connectorId: cfg.connectorId, secret: secretOf(env, ws), session: { username: owner, owner: true },
    leaseName, holder, summary };
  try {
    await pull(env, ctx);
    if (cfg.mode === 'pull_push') await push(env, ctx);
    else await saveHealth(env, ctx, {});
    summary.ok = true;
  } catch (e) {
    const code = errorCode(e);
    summary.ok = false;
    summary.code = code;
    summary.message = MESSAGES[code] || MESSAGES.INTERNAL_ERROR;
    summary.retryLater = summary.retryLater || 0;
    summary.retryable = !!(e && e.retryable);
    await saveHealth(env, ctx, { error: code });
    if (code === 'AUTH_FAILED' || code === 'LEDGER_INTEGRITY') {
      await securityEvent(env, null, 'sales_bridge_' + code.toLowerCase(), code === 'LEDGER_INTEGRITY' ? 'critical' : 'warning', ws);
    }
  } finally {
    await releaseLease(env, leaseName, holder);
  }
  return summary;
}

/**
 * One sync (cron or POST /api/sales/sync). opts: {workspace?: 'domestic'|'export'}. → {ok, mode, results:[summary per
 * workspace]} | {ok:false, code:'BRIDGE_OFF'} (mode off: not a single request is made).
 */
export async function syncAll(env, opts) {
  const cfg = salesConfig(env);
  if (cfg.mode === 'off') return { ok: false, code: 'BRIDGE_OFF', message: MESSAGES.BRIDGE_OFF, mode: 'off', results: [] };
  const list = opts && opts.workspace ? [opts.workspace] : WORKSPACES;
  const results = [];
  for (const ws of list) results.push(await syncWorkspace(env, cfg, ws));
  return { ok: results.every((r) => r.ok), mode: cfg.mode, results };
}

/** GET /api/sales/status: mode, which settings are missing (names/codes), last contact and counts – never a secret. */
export async function salesStatus(env) {
  const cfg = salesConfig(env);
  const d = db(env);
  const workspaces = {};
  for (const ws of WORKSPACES) {
    const h = await d.prepare('SELECT connector_id,pull_cursor,last_pull_at,last_push_at,last_error,updated_at FROM sq_bridge_health WHERE workspace=?').bind(ws).first();
    const commands = {};
    for (const r of (await d.prepare('SELECT status, COUNT(*) AS n FROM sq_bridge_commands WHERE workspace=? GROUP BY status').bind(ws).all()).results || []) commands[r.status] = Number(r.n);
    const events = {};
    for (const r of (await d.prepare('SELECT result, COUNT(*) AS n FROM sq_bridge_events WHERE workspace=? GROUP BY result').bind(ws).all()).results || []) events[r.result || 'pending'] = Number(r.n);
    const issues = ((await d.prepare('SELECT code,command_id,job_id,version,first_seen_at,last_seen_at,seen FROM sq_bridge_issues WHERE workspace=? ORDER BY last_seen_at DESC LIMIT 10').bind(ws).all()).results || [])
      .map((r) => ({ code: r.code, message: MESSAGES[r.code] || '', commandId: r.command_id, jobId: r.job_id, version: Number(r.version),
        firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, seen: Number(r.seen) }));
    const lease = await d.prepare('SELECT lease_until FROM sq_leases WHERE name=?').bind('sales-sync:' + ws).first();
    workspaces[ws] = {
      label: ws === 'domestic' ? 'ในประเทศ (Domestic)' : 'ต่างประเทศ (Export)', ready: cfg.workspaces[ws].ready, problems: cfg.workspaces[ws].problems,
      running: !!(lease && Number(lease.lease_until) > Date.now()), lastPullAt: (h && h.last_pull_at) || null, lastPushAt: (h && h.last_push_at) || null,
      morePages: !!(h && h.pull_cursor), lastError: (h && h.last_error) || null, lastErrorMessage: h && h.last_error ? MESSAGES[h.last_error] || MESSAGES.INTERNAL_ERROR : null,
      commands, events, issues,
    };
  }
  return {
    ok: true, mode: cfg.mode, push: cfg.mode === 'pull_push', configured: cfg.ready, problems: cfg.problems, salesHost: cfg.host || null,
    connectorId: cfg.connectorId && !cfg.problems.includes('SQ_SALES_CONNECTOR_ID_INVALID') ? cfg.connectorId : null,
    schedule: { cron: SYNC_CRON, every: 'ทุก 15 นาที', active: cfg.mode !== 'off' && cfg.ready },
    runsAs: 'ผู้ใช้ในระบบสต็อกที่ผูกกับบัญชีเจ้าของระบบ (ADMIN_USERNAME) ผ่าน sales-bridge',
    workspaces,
  };
}
