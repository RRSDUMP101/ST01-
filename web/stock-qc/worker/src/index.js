// RRS Stock & QC – Cloudflare Worker. Routes (BACKEND_DESIGN.md):
//   POST /api/auth/login          {username, password}              → session cookie __Host-sq_session
//   POST /api/auth/logout
//   GET  /api/auth/session                                            → {username, owner, mustChange, user, bootstrapped}
//   POST /api/auth/password       {current, next}                    → every session of the account ends
//   POST /api/admin/credentials   {username, password?, active?}     (owner, or engine permission users.manage)
//   POST /api/command             {kind, payload, requestId}         → the engine's result (one hash-chained commit)
//   GET  /api/commits?after=N                                        → {commits, more}
//   POST /api/files               (≤ 10 MB) / GET /api/files/<sha256>
//   GET  /api/health                                                 → which features are configured (never values)
// Everything else is the static page (../dist) through the ASSETS binding.
// Every POST must come from the same origin; every /api response carries no-store/nosniff/no-referrer/no-framing.
import { ENGINE_FILES } from './engine-imports.js';
import { HttpError, json, jsonText, errorResponse, withHeaders, flag, str, bridgeMode, PAGE_HEADERS, HTML_CSP } from './runtime.js';
import { requireSameOrigin, readJson, apiRateLimit } from './security.js';
import * as auth from './auth.js';
import * as ledger from './ledger.js';
import * as files from './files.js';

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

async function command(env, req) {
  const session = await auth.requireSession(env, req);
  if (session.mustChange) throw mustChangeError();
  const input = await readJson(req, ledger.MAX_COMMAND_BYTES);
  const r = await ledger.execute(env, input, session);
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
  const sales = ['SQ_SALES_URL', 'SQ_SALES_CONNECTOR_ID', 'SQ_SALES_DOMESTIC_SECRET', 'SQ_SALES_EXPORT_SECRET'];
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
      driveBackup: { enabled: flag(env, 'SQ_DRIVE_BACKUP_ENABLED'), configured: drive.every((k) => !!str(env, k)), built: false },
      salesBridge: { mode: bridgeMode(env), configured: sales.every((k) => !!str(env, k)), built: false },
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
    case '/api/command': return only('POST', () => command(env, req));
    case '/api/commits': return only('GET', () => commits(env, req, url));
    case '/api/files': return only('POST', () => uploadFile(env, req));
    default: {
      const m = FILE_PATH_RE.exec(path);
      if (m) return only('GET', () => downloadFile(env, req, m[1]));
      return json({ ok: false, error: 'ไม่พบ API นี้' }, 404);
    }
  }
}

async function page(req, env, url) {
  // dist/artifact.html is the claude.ai artifact build (browser-only data): not part of the server deployment.
  if (url.pathname === '/artifact.html') return withHeaders(new Response('ไม่พบหน้านี้', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }), PAGE_HEADERS);
  if (!env.ASSETS) return withHeaders(new Response('ยังไม่ได้ติดตั้งหน้าเว็บ', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }), PAGE_HEADERS);
  const res = await env.ASSETS.fetch(req);
  const headers = Object.assign({}, PAGE_HEADERS);
  if (/text\/html/i.test(res.headers.get('content-type') || '')) headers['Content-Security-Policy'] = HTML_CSP;
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
};
