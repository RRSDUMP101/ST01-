// RRS Stock & QC – Cloudflare Worker. Routes (BACKEND_DESIGN.md):
//   POST /api/auth/login          {username, password}              → session cookie __Host-sq_session
//   POST /api/auth/logout
//   GET  /api/auth/session                                            → {username, owner, mustChange, user, bootstrapped}
//   POST /api/auth/password       {current, next}                    → every session of the account ends
//   POST /api/admin/credentials   {username, password?, active?}     (owner, or engine permission users.manage)
//   POST /api/admin/records       {repair?: boolean}                 (owner, or engine perm backup.restore) → sq_records
//                                                                      checked against a verified replay of sq_commits
//   POST /api/command             {kind, payload, requestId}         → the engine's result (one hash-chained commit)
//   GET  /api/commits?after=N                                        → {commits, more}
//   POST /api/files               (≤ 10 MB) / GET /api/files/<sha256>
//   GET  /api/health                                                 → which features are configured (never values)
//   POST /api/backup/run          (owner or engine perm backup.export) → one Google Drive backup run (off unless enabled)
//   GET  /api/backup/status       (owner or engine perm backup.export) → settings present, schedule, last runs
//   POST /api/sales/sync          {workspace?} (owner or engine perm job.manage) → one Sales Office sync (off by default)
//   GET  /api/sales/status        (owner or an active engine user)   → connector mode, last contact, counts, issues
// Cron (wrangler.toml [triggers]): BACKUP_CRON → Drive backup, SYNC_CRON → Sales Office sync; each does nothing unless
// its own flag is on (SQ_DRIVE_BACKUP_ENABLED=true / SQ_SALES_BRIDGE=pull|pull_push) and it is fully configured.
// Everything else is the static page (../dist) through the ASSETS binding – every request runs this Worker first
// (wrangler.toml run_worker_first = true), so each static file gets the headers below and only "/" serves HTML.
// Every POST must come from the same origin; every /api response carries no-store/nosniff/no-referrer/no-framing.
import { ENGINE_FILES } from './engine-imports.js';
import { HttpError, json, jsonText, errorResponse, withHeaders, flag, str, bridgeMode, PAGE_HEADERS, HTML_CSP } from './runtime.js';
import { requireSameOrigin, readJson, limitedBody, apiRateLimit } from './security.js';
import { errorCode } from './outbound.js';
import * as auth from './auth.js';
import * as ledger from './ledger.js';
import * as files from './files.js';
import * as backup from './backup.js';
import * as sales from './sales-bridge.js';

const RRS = globalThis.RRS;
const FILE_PATH_RE = /^\/api\/files\/([^/]+)$/;

function methodNotAllowed(allow) {
  return json({ ok: false, error: 'ไม่รองรับวิธีเรียกนี้' }, 405, { Allow: allow });
}
const mustChangeError = () => new HttpError(403, 'ต้องเปลี่ยนรหัสผ่านที่ผู้ดูแลตั้งให้ก่อนบันทึกข้อมูล – กด "เปลี่ยนรหัสผ่าน"', {
  code: 'MUST_CHANGE_PASSWORD', errors: [{ code: 'MUST_CHANGE_PASSWORD', message: 'ต้องเปลี่ยนรหัสผ่านก่อนบันทึกข้อมูล' }],
});

async function sessionInfo(env, req) {
  const session = await auth.getSession(env, req);
  if (!session) return json({ ok: false, error: 'กรุณาเข้าสู่ระบบ', configured: auth.authConfiguration(env).ready }, 401);
  const state = await ledger.catchUp(env);
  const user = ledger.engineUserFor(state, session.username);
  return json({ ok: true, username: session.username, owner: session.owner, mustChange: session.mustChange,
    expiresAt: new Date(session.expiresAt).toISOString(), user: user || null, bootstrapped: ledger.hasEngineUsers(state) });
}

/** Commands that only the server's own jobs may run (never a page). */
const SERVER_ONLY = { 'sales.syncJob': 'ใบงานจาก Sales Office รับได้จากตัวเชื่อมเท่านั้น – สร้างหรือแก้จากหน้าเว็บไม่ได้' };

async function command(env, req) {
  const session = await auth.requireSession(env, req);
  if (session.mustChange) throw mustChangeError();
  const input = await readJson(req, ledger.MAX_COMMAND_BYTES);
  if (typeof input.kind === 'string' && Object.prototype.hasOwnProperty.call(SERVER_ONLY, input.kind)) {
    const message = SERVER_ONLY[input.kind];
    throw new HttpError(403, message, { code: 'BRIDGE_ONLY', errors: [{ code: 'BRIDGE_ONLY', message }] });
  }
  const r = await ledger.execute(env, input, session, { req });
  return json(r, r.ok ? 200 : 422);
}

async function commits(env, req, url) {
  const session = await auth.requireSession(env, req);
  const raw = url.searchParams.get('after');
  const after = raw === null || raw === '' ? 0 : Number(raw);
  if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'after ต้องเป็นเลขจำนวนเต็มไม่ติดลบ');
  ledger.requireReader(await ledger.catchUp(env), session);
  return jsonText(await ledger.commitsPage(env, after));
}

async function credentials(env, req) {
  const session = await auth.requireSession(env, req);
  if (session.mustChange) throw mustChangeError();
  if (!session.owner) {
    const user = ledger.engineUserFor(await ledger.catchUp(env), session.username);
    if (!user || user.active === false || !RRS.auth.can(user, 'users.manage')) {
      throw new HttpError(403, 'เฉพาะเจ้าของระบบหรือผู้ดูแลระบบ (สิทธิ์ users.manage) จัดการบัญชีเข้าระบบได้');
    }
  }
  return auth.setCredentials(env, req, session);
}

async function uploadFile(env, req) {
  const session = await auth.requireSession(env, req);
  if (session.mustChange) throw mustChangeError();
  const user = ledger.requireReader(await ledger.catchUp(env), session);
  // Read-only accounts look but do not add files (Sales Office writeAccess).
  if (!session.owner && !(user.roles || []).some((r) => r !== 'viewer')) throw new HttpError(403, 'สิทธิ์นี้ดูข้อมูลได้อย่างเดียว อัปโหลดไฟล์ไม่ได้');
  await apiRateLimit(env, req, 'files', session.username, 120, 15 * 60 * 1000);
  return files.upload(env, req, session);
}

async function downloadFile(env, req, id) {
  const session = await auth.requireSession(env, req);
  ledger.requireReader(await ledger.catchUp(env), session);
  return files.download(env, id);
}

/** The owner, or an active engine user holding `perm`. */
function requirePerm(state, session, perm, message) {
  if (session.owner) return;
  const user = ledger.requireReader(state, session);
  if (!RRS.auth.can(user, perm)) throw new HttpError(403, message, { code: 'NO_PERMISSION' });
}
/** Optional small JSON object body (absent/empty → {}). */
async function optionalJson(req) {
  const raw = await limitedBody(req, 4096);
  if (!raw.length) return {};
  let v;
  try {
    v = JSON.parse(new TextDecoder().decode(raw), (k, x) => (k === '__proto__' ? undefined : x));
  } catch (e) {
    throw new HttpError(400, 'ข้อมูลที่ส่งมาไม่ใช่ JSON ที่ถูกต้อง');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'ข้อมูลที่ส่งมาต้องเป็น JSON object');
  return v;
}

/** POST /api/admin/records {repair?}: check sq_records against a verified replay of sq_commits, optionally repair. */
async function records(env, req) {
  const session = await auth.requireSession(env, req);
  if (session.mustChange) throw mustChangeError();
  requirePerm(await ledger.catchUp(env), session, 'backup.restore', 'เฉพาะเจ้าของระบบหรือผู้มีสิทธิ์กู้คืนข้อมูล (backup.restore) ตรวจ/ซ่อมตารางอ่านเร็วได้');
  const input = await optionalJson(req);
  const unknown = Object.keys(input).filter((k) => k !== 'repair');
  if (unknown.length) throw new HttpError(400, `ไม่รู้จักข้อมูล: ${unknown.join(', ')}`);
  if (input.repair !== undefined && typeof input.repair !== 'boolean') throw new HttpError(400, 'repair ต้องเป็น true หรือ false');
  await apiRateLimit(env, req, 'records', session.username, 10, 60 * 60 * 1000);
  const r = await ledger.checkRecords(env, { repair: input.repair === true });
  return json(r, r.code === 'CHANGED' ? 409 : 200);
}

const BACKUP_HTTP = { DISABLED: 409, BUSY: 409, ALREADY_DONE: 409, CONFIGURATION_MISSING: 503, LEDGER_INTEGRITY: 500 };
async function backupRun(env, req) {
  const session = await auth.requireSession(env, req);
  if (session.mustChange) throw mustChangeError();
  requirePerm(await ledger.catchUp(env), session, 'backup.export', 'เฉพาะเจ้าของระบบหรือผู้มีสิทธิ์สำรองข้อมูล (backup.export) สั่งสำรองได้');
  await apiRateLimit(env, req, 'backup', session.username, 6, 60 * 60 * 1000);
  const r = await backup.runBackup(env, { trigger: 'manual', requestedBy: session.username });
  return json(r, r.ok ? 200 : BACKUP_HTTP[r.code] || 502);
}
async function backupStatus(env, req) {
  const session = await auth.requireSession(env, req);
  requirePerm(await ledger.catchUp(env), session, 'backup.export', 'เฉพาะเจ้าของระบบหรือผู้มีสิทธิ์สำรองข้อมูล (backup.export) ดูสถานะได้');
  return json(await backup.backupStatus(env));
}
async function salesSync(env, req) {
  const session = await auth.requireSession(env, req);
  if (session.mustChange) throw mustChangeError();
  requirePerm(await ledger.catchUp(env), session, 'job.manage', 'เฉพาะเจ้าของระบบหรือผู้มีสิทธิ์จัดการใบงาน (job.manage) สั่งซิงก์ได้');
  const input = await optionalJson(req);
  const unknown = Object.keys(input).filter((k) => k !== 'workspace');
  if (unknown.length) throw new HttpError(400, `ไม่รู้จักข้อมูล: ${unknown.join(', ')}`);
  if (input.workspace !== undefined && sales.WORKSPACES.indexOf(input.workspace) < 0) throw new HttpError(400, 'workspace ต้องเป็น domestic หรือ export');
  await apiRateLimit(env, req, 'sales-sync', session.username, 30, 15 * 60 * 1000);
  const r = await sales.syncAll(env, { workspace: input.workspace });
  return json(r, r.code === 'BRIDGE_OFF' ? 409 : 200);
}
async function salesStatus(env, req) {
  const session = await auth.requireSession(env, req);
  ledger.requireReader(await ledger.catchUp(env), session);
  return json(await sales.salesStatus(env));
}

async function health(env) {
  let database = 'missing';
  if (env.DB) {
    try {
      await env.DB.prepare('SELECT 1 FROM sq_commits LIMIT 0').all();
      database = 'ready';
    } catch (e) {
      database = 'not_migrated';
    }
  }
  const drive = ['GOOGLE_DRIVE_CLIENT_ID', 'GOOGLE_DRIVE_CLIENT_SECRET', 'GOOGLE_DRIVE_REFRESH_TOKEN', 'SQ_DRIVE_BACKUP_FOLDER_ID'];
  const salesNames = ['SQ_SALES_URL', 'SQ_SALES_CONNECTOR_ID', 'SQ_SALES_DOMESTIC_SECRET', 'SQ_SALES_EXPORT_SECRET'];
  return json({
    ok: true,
    service: 'rrs-stock-qc',
    environment: str(env, 'SQ_ENV') || 'unset',
    time: new Date().toISOString(),
    engine: { files: ENGINE_FILES, commands: Object.keys(RRS.commands.defs).length },
    features: {
      login: auth.authConfiguration(env).ready,
      database,
      files: !!env.BUCKET,
      page: !!env.ASSETS,
      snapshotsEvery: ledger.snapshotEvery(env),
      driveBackup: { enabled: flag(env, 'SQ_DRIVE_BACKUP_ENABLED'), configured: drive.every((k) => !!str(env, k)), built: true },
      salesBridge: { mode: bridgeMode(env), configured: salesNames.every((k) => !!str(env, k)), built: true },
    },
  });
}

async function api(req, env, url) {
  const path = url.pathname;
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD') requireSameOrigin(req);
  const only = (m, fn) => (method === m ? fn() : methodNotAllowed(m));
  switch (path) {
    case '/api/health': return only('GET', () => health(env));
    case '/api/auth/login': return only('POST', () => auth.login(env, req));
    case '/api/auth/logout': return only('POST', () => auth.logout(env, req));
    case '/api/auth/session': return only('GET', () => sessionInfo(env, req));
    case '/api/auth/password': return only('POST', () => auth.changePassword(env, req));
    case '/api/admin/credentials': return only('POST', () => credentials(env, req));
    case '/api/admin/records': return only('POST', () => records(env, req));
    case '/api/command': return only('POST', () => command(env, req));
    case '/api/commits': return only('GET', () => commits(env, req, url));
    case '/api/files': return only('POST', () => uploadFile(env, req));
    case '/api/backup/run': return only('POST', () => backupRun(env, req));
    case '/api/backup/status': return only('GET', () => backupStatus(env, req));
    case '/api/sales/sync': return only('POST', () => salesSync(env, req));
    case '/api/sales/status': return only('GET', () => salesStatus(env, req));
    default: {
      const m = FILE_PATH_RE.exec(path);
      if (m) return only('GET', () => downloadFile(env, req, m[1]));
      return json({ ok: false, error: 'ไม่พบ API นี้' }, 404);
    }
  }
}

/** Paths that may answer with HTML: the page itself. */
const PAGE_PATHS = ['/', '/index.html'];
const notFound = (text) => withHeaders(new Response(text, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }), PAGE_HEADERS);
async function page(req, env, url) {
  // dist/artifact.html is the claude.ai artifact build (browser storage, demo data): not part of the server deployment.
  // Cloudflare's html_handling also serves it at /artifact, /artifact/ … – so besides this early answer, any HTML the
  // asset store returns for a path other than the page itself is refused below.
  if (/^\/artifact(\.html)?\/?$/i.test(url.pathname)) return notFound('ไม่พบหน้านี้');
  if (!env.ASSETS) return notFound('ยังไม่ได้ติดตั้งหน้าเว็บ');
  const res = await env.ASSETS.fetch(req);
  const html = /text\/html/i.test(res.headers.get('content-type') || '');
  if (html && res.status < 300 && PAGE_PATHS.indexOf(url.pathname) < 0) {
    if (res.body) await res.body.cancel().catch(() => {});
    return notFound('ไม่พบหน้านี้');
  }
  const headers = Object.assign({}, PAGE_HEADERS);
  if (html) headers['Content-Security-Policy'] = HTML_CSP;
  return withHeaders(res, headers);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await api(req, env, url);
      } catch (e) {
        return errorResponse(e);
      }
    }
    try {
      return await page(req, env, url);
    } catch (e) {
      return errorResponse(e);
    }
  },
  /** Cron triggers: each job checks its own flag first, so with the staging defaults nothing is sent anywhere. */
  async scheduled(controller, env) {
    const cron = controller && controller.cron;
    try {
      if (cron === backup.BACKUP_CRON) await backup.scheduledBackup(env);
      else if (cron === sales.SYNC_CRON) await sales.syncAll(env, {});
    } catch (e) {
      console.error('stock-qc: scheduled job failed', String(cron || ''), errorCode(e));
    }
  },
};
