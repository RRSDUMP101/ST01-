// Login / logout / session / password change / user credentials – the behaviour of Sales Office lib/rrs/auth.ts:
//   owner account from ADMIN_USERNAME + ADMIN_PASSWORD_HASH (bcrypt cost 12–16), other accounts in sq_app_users;
//   SESSION_SECRET ≥ 32 chars; the session id stored is HMAC(token); auth_version = HMAC(username:hash) so a new password
//   ends old sessions; one generic Thai error; rate limit 10/IP/15 min and 100 overall; every attempt audited.
// Roles and warehouses are NOT here: they live in the engine `users` table (accountId = username).
import bcrypt from 'bcryptjs';
import { db, str, HttpError, json } from './runtime.js';
import { digest, hmac, randomToken, secretEqual, readJson, clientIP, securityEvent, byteLength } from './security.js';

export const SESSION_COOKIE = '__Host-sq_session';
export const SESSION_SECONDS = 8 * 60 * 60;
export const BCRYPT_COST = 12;
export const USERNAME_RE = /^[A-Za-z0-9._@-]{3,100}$/;
const HASH_RE = /^\$2[ab]\$(1[2-6])\$[./A-Za-z0-9]{53}$/;
const GENERIC_ERROR = 'เข้าสู่ระบบไม่สำเร็จ กรุณาตรวจสอบข้อมูลหรือลองใหม่ภายหลัง';
const WINDOW_MS = 15 * 60 * 1000;
const PER_IP = 10;
const OVERALL = 100;

/**
 * Names of Object.prototype (__proto__, constructor, toString, …) are never account names: an account name becomes an
 * engine row key (access_requests is keyed by it), and '__proto__' as a key would swap a state table's prototype.
 */
export function reservedName(name) {
  return Object.prototype.hasOwnProperty.call(Object.prototype, String(name));
}
/** A name that may be an account (owner included): A-Z a-z 0-9 . _ @ -, 3–100 characters, not an Object.prototype name. */
export function validUsername(name) {
  return typeof name === 'string' && USERNAME_RE.test(name) && !reservedName(name);
}
/**
 * bcrypt "hash" for usernames that cannot log in (unknown, switched off): same cost as the accounts' own hashes
 * (BCRYPT_COST), so a failed login takes as long whether the account exists or not. Before, ADMIN_PASSWORD_HASH was
 * used (cost 12–16 allowed): with a cost-14 owner hash an unknown name answered 4× slower than a real one. The hash part
 * is a fixed filler – no password gives it, so the comparison is always false. (The owner's own login runs at the cost
 * of ADMIN_PASSWORD_HASH: keep it at 12, as scripts/hash-password.mjs does, so the owner's name does not stand out.)
 */
const DUMMY_HASH = `$2b$${String(BCRYPT_COST).padStart(2, '0')}$${'x'.repeat(53)}`;

export function authConfiguration(env) {
  const missing = ['ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH', 'SESSION_SECRET'].filter((k) => !str(env, k));
  const invalid = [];
  if (str(env, 'ADMIN_USERNAME') && !validUsername(str(env, 'ADMIN_USERNAME'))) invalid.push('ADMIN_USERNAME');
  if (str(env, 'ADMIN_PASSWORD_HASH') && !HASH_RE.test(str(env, 'ADMIN_PASSWORD_HASH'))) invalid.push('ADMIN_PASSWORD_HASH');
  if (str(env, 'SESSION_SECRET') && str(env, 'SESSION_SECRET').length < 32) invalid.push('SESSION_SECRET');
  return { ready: !missing.length && !invalid.length, missing, invalid };
}

function cookieToken(req) {
  const values = (req.headers.get('cookie') || '').split(';').map((v) => v.trim()).filter((v) => v.startsWith(SESSION_COOKIE + '='));
  if (values.length !== 1) return '';
  const token = values[0].slice(SESSION_COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : '';
}
function sessionCookie(token, expires) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}; Expires=${new Date(expires).toUTCString()}`;
}
function clearedCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** The account that may log in with this username (owner or an active sq_app_users row), or null. */
async function account(env, username) {
  const owner = str(env, 'ADMIN_USERNAME');
  if (owner && (await secretEqual(username, owner))) {
    return { username: owner, passwordHash: str(env, 'ADMIN_PASSWORD_HASH'), owner: true, mustChange: false };
  }
  if (!validUsername(username)) return null;
  const u = await db(env).prepare('SELECT username,password_hash,active,must_change FROM sq_app_users WHERE username=?').bind(username).first();
  return u && Number(u.active) === 1
    ? { username: u.username, passwordHash: u.password_hash, owner: false, mustChange: Number(u.must_change) === 1 }
    : null;
}
async function authVersion(env, username, hash) {
  return hmac(str(env, 'SESSION_SECRET'), `credentials:${username}:${hash}`);
}

/** {id, username, owner, mustChange, expiresAt} for a valid session cookie, else null. */
export async function getSession(env, req) {
  const token = cookieToken(req);
  if (!token || !authConfiguration(env).ready) return null;
  const id = await hmac(str(env, 'SESSION_SECRET'), token);
  const row = await db(env).prepare('SELECT id,username,expires_at,auth_version FROM sq_sessions WHERE id=? AND expires_at>? AND revoked_at IS NULL')
    .bind(id, Date.now()).first();
  if (!row) return null;
  const user = await account(env, row.username);
  if (!user || !(await secretEqual(row.auth_version, await authVersion(env, user.username, user.passwordHash)))) return null;
  return { id: row.id, username: user.username, owner: user.owner, mustChange: user.mustChange, expiresAt: Number(row.expires_at) };
}
export async function requireSession(env, req) {
  const session = await getSession(env, req);
  if (!session) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
  return session;
}

async function audit(env, ip, event) {
  await db(env).prepare('INSERT INTO sq_auth_audit (id,time,ip,event) VALUES (?,?,?,?)').bind(crypto.randomUUID(), Date.now(), ip, event).run();
}
/** Atomic counters: every attempt counts, whatever the username and whether it succeeds. */
async function rateLimit(env, ip, scope, message) {
  const window = Math.floor(Date.now() / WINDOW_MS);
  const keys = [`${scope}:ip:${await digest(ip)}:${window}`, `${scope}:global:${window}`];
  const d = db(env);
  const results = await d.batch(keys.map((key) => d.prepare('INSERT INTO sq_auth_limits (id,count,expires_at) VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1 RETURNING count')
    .bind(key, (window + 2) * WINDOW_MS)));
  const perIp = Number(results[0].results[0].count);
  const overall = Number(results[1].results[0].count);
  if (perIp > PER_IP || overall > OVERALL) {
    await audit(env, ip, scope === 'login' ? 'rate_limited' : `${scope}_rate_limited`);
    throw new HttpError(429, message);
  }
}

export function checkNewPassword(password, username) {
  if (typeof password !== 'string' || password.length < 12 || byteLength(password) > 72) {
    throw new HttpError(400, 'รหัสผ่านต้องยาวอย่างน้อย 12 ตัวอักษรและไม่เกิน 72 bytes');
  }
  if (username && password.toLowerCase().indexOf(String(username).toLowerCase()) >= 0) {
    throw new HttpError(400, 'รหัสผ่านต้องไม่มีชื่อผู้ใช้อยู่ในนั้น');
  }
}

// ---- POST /api/auth/login {username, password} --------------------------------------------------------------
export async function login(env, req) {
  const ip = clientIP(req);
  await rateLimit(env, ip, 'login', GENERIC_ERROR);
  let input;
  try {
    input = await readJson(req, 4096);
  } catch (e) {
    if (e instanceof HttpError && e.status === 413) throw e;
    await audit(env, ip, 'login_failed');
    throw new HttpError(401, GENERIC_ERROR);
  }
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (!authConfiguration(env).ready) {
    await audit(env, ip, 'not_configured');
    throw new HttpError(503, GENERIC_ERROR);
  }
  // The password is compared even for an unknown username: the answer never says which part was wrong.
  const acceptable = password.length > 0 && byteLength(password) <= 72 && username.length > 0 && username.length <= 128;
  const user = acceptable ? await account(env, username) : null;
  const passwordOK = await bcrypt.compare(acceptable ? password : randomToken(), user ? user.passwordHash : DUMMY_HASH);
  if (!acceptable || !passwordOK || !user) {
    await audit(env, ip, 'login_failed');
    throw new HttpError(401, GENERIC_ERROR);
  }
  const secret = str(env, 'SESSION_SECRET');
  const token = randomToken();
  const id = await hmac(secret, token);
  const now = Date.now();
  const expires = now + SESSION_SECONDS * 1000;
  const d = db(env);
  const statements = [d.prepare('INSERT INTO sq_sessions (id,username,created_at,expires_at,auth_version) VALUES (?,?,?,?,?)')
    .bind(id, user.username, now, expires, await authVersion(env, user.username, user.passwordHash))];
  const previous = cookieToken(req);
  if (previous) statements.push(d.prepare('UPDATE sq_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(now, await hmac(secret, previous)));
  statements.push(d.prepare('DELETE FROM sq_sessions WHERE expires_at<?').bind(now - 86400000));
  statements.push(d.prepare('DELETE FROM sq_auth_limits WHERE expires_at<?').bind(now));
  await d.batch(statements);
  await audit(env, ip, 'login_success');
  return json({ ok: true, username: user.username, owner: user.owner, mustChange: user.mustChange, expiresAt: new Date(expires).toISOString() }, 200,
    { 'Set-Cookie': sessionCookie(token, expires) });
}

// ---- POST /api/auth/logout ------------------------------------------------------------------------------------
export async function logout(env, req) {
  const session = await getSession(env, req);
  if (session) {
    await db(env).prepare('UPDATE sq_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(Date.now(), session.id).run();
    await audit(env, clientIP(req), 'logout');
  }
  return json({ ok: true }, 200, { 'Set-Cookie': clearedCookie(), 'Clear-Site-Data': '"cache"' });
}

// ---- POST /api/auth/password {current, next} ------------------------------------------------------------------
/** A new password ends every session of the account (this one too): log in again on every device. */
export async function changePassword(env, req) {
  const session = await requireSession(env, req);
  const ip = clientIP(req);
  await rateLimit(env, ip, 'password', 'ลองเปลี่ยนรหัสผ่านหลายครั้งเกินไป กรุณารอ 15 นาที');
  const input = await readJson(req, 4096);
  if (session.owner) {
    throw new HttpError(400, 'รหัสผ่านบัญชีเจ้าของระบบตั้งที่ค่า ADMIN_PASSWORD_HASH ของเซิร์ฟเวอร์ – เปลี่ยนจากหน้านี้ไม่ได้');
  }
  const current = typeof input.current === 'string' ? input.current : '';
  const next = typeof input.next === 'string' ? input.next : '';
  const user = await account(env, session.username);
  if (!user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
  const currentOK = current.length > 0 && byteLength(current) <= 72 && (await bcrypt.compare(current, user.passwordHash));
  if (!currentOK) {
    await audit(env, ip, 'password_change_failed');
    // 400, not 401: the session is still valid, only the old password was wrong.
    throw new HttpError(400, 'รหัสผ่านเดิมไม่ถูกต้อง');
  }
  checkNewPassword(next, session.username);
  if (next === current) throw new HttpError(400, 'รหัสผ่านใหม่ต้องไม่ซ้ำรหัสผ่านเดิม');
  const hash = await bcrypt.hash(next, BCRYPT_COST);
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const d = db(env);
  const results = await d.batch([
    d.prepare('UPDATE sq_app_users SET password_hash=?,must_change=0,updated_at=?,updated_by=? WHERE username=? AND password_hash=? AND active=1')
      .bind(hash, iso, session.username, session.username, user.passwordHash),
    d.prepare('UPDATE sq_sessions SET revoked_at=? WHERE username=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM sq_app_users WHERE username=? AND password_hash=?)')
      .bind(now, session.username, session.username, hash),
  ]);
  if (results[0].meta.changes !== 1) throw new HttpError(409, 'บัญชีเปลี่ยนระหว่างบันทึก กรุณาเข้าสู่ระบบใหม่');
  await audit(env, ip, 'password_changed');
  await securityEvent(env, req, 'password_changed', 'info', session.username);
  return json({ ok: true, relogin: true }, 200, { 'Set-Cookie': clearedCookie() });
}

// ---- POST /api/admin/credentials {username, password?, active?} -----------------------------------------------
/**
 * Create an account, set a temporary password (must_change) or turn an account on/off. The caller has already checked
 * that `session` may manage users (owner, or an engine user with users.manage). Sessions of the account end when its
 * password is set or it is turned off.
 */
export async function setCredentials(env, req, session) {
  const input = await readJson(req, 4096);
  const unknown = Object.keys(input).filter((k) => ['username', 'password', 'active'].indexOf(k) < 0);
  if (unknown.length) throw new HttpError(400, `ไม่รู้จักข้อมูล: ${unknown.join(', ')}`);
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  if (!USERNAME_RE.test(username)) throw new HttpError(400, 'ชื่อผู้ใช้ใช้ได้ A-Z a-z 0-9 . _ @ - ยาว 3–100 ตัว');
  if (reservedName(username)) throw new HttpError(400, `ใช้ชื่อ ${username} เป็นชื่อผู้ใช้ไม่ได้ (ชื่อสงวนของระบบ)`);
  const owner = str(env, 'ADMIN_USERNAME');
  if (owner && (await secretEqual(username, owner))) {
    throw new HttpError(400, 'บัญชีเจ้าของระบบสงวนไว้ ตั้งได้ที่ค่า ADMIN_USERNAME / ADMIN_PASSWORD_HASH ของเซิร์ฟเวอร์เท่านั้น');
  }
  if (input.password !== undefined && typeof input.password !== 'string') throw new HttpError(400, 'รหัสผ่านต้องเป็นข้อความ');
  if (input.active !== undefined && typeof input.active !== 'boolean') throw new HttpError(400, 'active ต้องเป็น true หรือ false');
  const password = input.password || '';
  if (password) checkNewPassword(password, username);
  const d = db(env);
  const old = await d.prepare('SELECT username,active,must_change,updated_at FROM sq_app_users WHERE username=?').bind(username).first();
  if (!old && !password) throw new HttpError(400, 'ระบุรหัสผ่านสำหรับบัญชีใหม่');
  if (old && !password && input.active === undefined) throw new HttpError(400, 'ไม่มีข้อมูลที่จะเปลี่ยน');
  const active = input.active === undefined ? (old ? Number(old.active) : 1) : input.active ? 1 : 0;
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const statements = [];
  if (password) {
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    statements.push(old
      ? d.prepare('UPDATE sq_app_users SET password_hash=?,active=?,must_change=1,updated_at=?,updated_by=? WHERE username=? AND updated_at=?')
        .bind(hash, active, iso, session.username, username, old.updated_at)
      : d.prepare('INSERT INTO sq_app_users (username,password_hash,active,must_change,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,1,?,?,?,?) ON CONFLICT(username) DO NOTHING')
        .bind(username, hash, active, iso, iso, session.username, session.username));
  } else {
    statements.push(d.prepare('UPDATE sq_app_users SET active=?,updated_at=?,updated_by=? WHERE username=? AND updated_at=?')
      .bind(active, iso, session.username, username, old.updated_at));
  }
  if (password || !active) {
    statements.push(d.prepare('UPDATE sq_sessions SET revoked_at=? WHERE username=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM sq_app_users WHERE username=? AND updated_at=?)')
      .bind(now, username, username, iso));
  }
  const results = await d.batch(statements);
  if (results[0].meta.changes !== 1) throw new HttpError(409, 'บัญชีเปลี่ยนระหว่างบันทึก กรุณาลองใหม่');
  await securityEvent(env, req, 'credentials_set', 'info',
    `${session.username} → ${username}: ${old ? 'แก้' : 'สร้าง'}${password ? ' ตั้งรหัสผ่านชั่วคราว' : ''} ${active ? 'เปิด' : 'ปิด'}`);
  return json({ ok: true, username, active: active === 1, mustChange: password ? true : Number(old.must_change) === 1, created: !old });
}
