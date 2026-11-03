// Same accounts and MFA as Sales Office, through an explicit service binding only.
// Passwords, password hashes and auth secrets are never persisted in this application.
import { HttpError, json, str } from './runtime.js';
import { digest, readJson, requireSameOrigin, limitedBody } from './security.js';

const LOCAL_COOKIE = '__Host-sq_session';
const UPSTREAM_COOKIE = '__Host-rrs_session';
const SESSION_SECONDS = 8 * 60 * 60;
const TOKEN = /^[a-f0-9]{64}$/;
const ROLES = new Set(['owner', 'executive', 'sales', 'documents', 'viewer']);
const UNAVAILABLE = 'ระบบเข้าสู่ระบบ Sales Office ยังไม่พร้อม กรุณาลองใหม่ภายหลัง';

// Unknown provider values fail closed instead of silently enabling local credentials.
export const externalAuthSelected = (env) => !['', 'local'].includes(str(env, 'SQ_AUTH_PROVIDER'));

export function configuration(env) {
  const missing = [], invalid = [];
  if (!env?.SALES_AUTH || typeof env.SALES_AUTH.fetch !== 'function') missing.push('SALES_AUTH');
  if (!str(env, 'SQ_AUTH_ORIGIN')) missing.push('SQ_AUTH_ORIGIN');
  if (str(env, 'SQ_AUTH_PROVIDER') !== 'sales-office') invalid.push('SQ_AUTH_PROVIDER');
  try {
    const u = new URL(str(env, 'SQ_AUTH_ORIGIN'));
    if (u.protocol !== 'https:' || u.origin !== str(env, 'SQ_AUTH_ORIGIN')) invalid.push('SQ_AUTH_ORIGIN');
  } catch { if (!missing.includes('SQ_AUTH_ORIGIN')) invalid.push('SQ_AUTH_ORIGIN'); }
  return { ready: !missing.length && !invalid.length, missing, invalid, provider: 'sales-office' };
}

function configured(env) {
  if (!configuration(env).ready) throw new HttpError(503, UNAVAILABLE, { code: 'AUTH_UNAVAILABLE' });
}
export function validateLoginRequest(env, req) {
  requireSameOrigin(req);
  configured(env);
}
export function managedCredentials() {
  throw new HttpError(409, 'บัญชีนี้ใช้ระบบเข้าสู่ระบบของ Sales Office กรุณาจัดการบัญชีและรหัสผ่านที่ Sales Office',
    { code: 'AUTH_MANAGED_BY_SALES_OFFICE', authProvider: 'sales-office' });
}
function tokenFromRequest(req) {
  const cookies = (req.headers.get('cookie') || '').split(';').map(v => v.trim())
    .filter(v => v.startsWith(LOCAL_COOKIE + '='));
  if (cookies.length !== 1) return '';
  const token = cookies[0].slice(LOCAL_COOKIE.length + 1);
  return TOKEN.test(token) ? token : '';
}
function tokenFromResponse(res) {
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  const matches = cookies.filter(v => v.startsWith(UPSTREAM_COOKIE + '='));
  if (matches.length !== 1) return '';
  const value = matches[0], token = value.split(';')[0].slice(UPSTREAM_COOKIE.length + 1);
  // Refuse malformed/combined cookies and any attempt to broaden the cookie's scope.
  return TOKEN.test(token) && /;\s*HttpOnly(?:;|$)/i.test(value) && /;\s*Secure(?:;|$)/i.test(value)
    && /;\s*Path=\/(?:;|$)/i.test(value) && /;\s*SameSite=Lax(?:;|$)/i.test(value)
    && !/;\s*Domain=/i.test(value) && !value.includes(UPSTREAM_COOKIE + '=', UPSTREAM_COOKIE.length + 1) ? token : '';
}
function clearedCookie() {
  return `${LOCAL_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

async function upstream(env, path, method, token, input, req) {
  configured(env);
  if (!['/api/auth/login', '/api/auth/session', '/api/auth/logout'].includes(path)) throw new Error('Invalid auth route');
  const origin = str(env, 'SQ_AUTH_ORIGIN');
  const headers = new Headers({ Accept: 'application/json' });
  // Construct a fresh request: no client Authorization, forwarded host, Origin or arbitrary cookie is relayed.
  if (token) headers.set('Cookie', `${UPSTREAM_COOKIE}=${token}`);
  if (method === 'POST') {
    headers.set('Origin', origin);
    headers.set('Sec-Fetch-Site', 'same-origin');
    headers.set('Content-Type', 'application/json');
  }
  // Only CF's edge-populated client address is copied; X-Forwarded-For and user-provided override headers are ignored.
  // Our caller also applies the local D1 limiter before login, independent of downstream service IP semantics.
  const edgeIp = req?.headers.get('cf-connecting-ip') || '';
  if (/^[0-9a-fA-F:.]{3,64}$/.test(edgeIp)) headers.set('CF-Connecting-IP', edgeIp);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await env.SALES_AUTH.fetch(new Request(origin + path, {
      method, headers, body: method === 'POST' ? JSON.stringify(input || {}) : undefined,
      redirect: 'manual', signal: controller.signal,
    }));
    if (res.status >= 300 && res.status < 400) throw new Error('Unexpected auth redirect');
    return res;
  } catch { throw new HttpError(503, UNAVAILABLE, { code: 'AUTH_UNAVAILABLE' }); }
  finally { clearTimeout(timer); }
}

async function responseJson(res) {
  try {
    const bytes = await limitedBody(res, 16384);
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid auth response');
    return value;
  } catch { throw new HttpError(503, UNAVAILABLE, { code: 'AUTH_UNAVAILABLE' }); }
}
async function upstreamSession(env, token, req) {
  const res = await upstream(env, '/api/auth/session', 'GET', token, undefined, req);
  if (res.status === 401) { await res.body?.cancel(); return null; }
  if (!res.ok) { await res.body?.cancel(); throw new HttpError(503, UNAVAILABLE, { code: 'AUTH_UNAVAILABLE' }); }
  const data = await responseJson(res);
  const expiresAt = typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN;
  if (typeof data.username !== 'string' || !data.username || data.username.length > 128
    || Object.prototype.hasOwnProperty.call(Object.prototype, data.username) || !ROLES.has(data.role)
    || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + (SESSION_SECONDS + 60) * 1000) return null;
  return { id: await digest('sales-office:' + token), username: data.username, owner: data.role === 'owner',
    mustChange: false, expiresAt, authProvider: 'sales-office' };
}

export async function getSession(env, req) {
  configured(env);
  const token = tokenFromRequest(req);
  return token ? upstreamSession(env, token, req) : null;
}
export async function login(env, req) {
  validateLoginRequest(env, req);
  const body = await readJson(req, 4096);
  // Keep the credential payload narrow. The upstream handles exact credential limits and MFA verification.
  const input = { username: typeof body.username === 'string' ? body.username : '',
    password: typeof body.password === 'string' ? body.password : '' };
  if (typeof body.otp === 'string') input.otp = body.otp;
  const res = await upstream(env, '/api/auth/login', 'POST', tokenFromRequest(req), input, req);
  if (!res.ok) {
    const data = await responseJson(res);
    const status = [400, 401, 403, 413, 428, 429, 503].includes(res.status) ? res.status : 503;
    const error = typeof data.error === 'string' && data.error.length <= 500 ? data.error : UNAVAILABLE;
    const retry = res.headers.get('Retry-After');
    return json({ ok: false, error, authProvider: 'sales-office' }, status,
      status === 429 && /^\d{1,5}$/.test(retry || '') ? { 'Retry-After': retry } : undefined);
  }
  const token = tokenFromResponse(res);
  const data = await responseJson(res);
  if (!token || data.ok !== true) throw new HttpError(503, UNAVAILABLE, { code: 'AUTH_UNAVAILABLE' });
  const session = await upstreamSession(env, token, req);
  if (!session) throw new HttpError(401, 'กรุณาเข้าสู่ระบบอีกครั้ง');
  const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
  return json({ ok: true, username: session.username, owner: session.owner, mustChange: false,
    authProvider: 'sales-office', expiresAt: new Date(session.expiresAt).toISOString() }, 200,
  { 'Set-Cookie': `${LOCAL_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}; Expires=${new Date(session.expiresAt).toUTCString()}` });
}
export async function logout(env, req) {
  validateLoginRequest(env, req);
  const token = tokenFromRequest(req);
  if (token) {
    const res = await upstream(env, '/api/auth/logout', 'POST', token, {}, req);
    await res.body?.cancel();
    if (!res.ok && res.status !== 401) throw new HttpError(503, UNAVAILABLE, { code: 'AUTH_UNAVAILABLE' });
  }
  return json({ ok: true, authProvider: 'sales-office' }, 200,
    { 'Set-Cookie': clearedCookie(), 'Clear-Site-Data': '"cache"' });
}
