// Owner-initiated, session-bound OAuth. Refresh tokens stay encrypted in D1 and are never returned to the browser.
import { db, str, HttpError, json, withHeaders, API_HEADERS } from './runtime.js';
import { digest, randomToken, requireSameOrigin, limitedBody } from './security.js';
import { boundedFetch, jsonObject } from './outbound.js';
import { getSession } from './auth.js';

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive'; // Also authorizes native Sheets API operations.
export const GOOGLE_CALLBACK_PATH = '/api/backup/google/callback';
export const STATE_TTL_MS = 10 * 60 * 1000;
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CONNECTION_ID = 'google-drive';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const reconnect = () => new HttpError(503, 'ข้อมูลเชื่อมต่อ Google ใช้งานไม่ได้ กรุณาให้เจ้าของระบบเชื่อมต่อใหม่', { code: 'GOOGLE_RECONNECT_REQUIRED' });
const badState = () => new HttpError(400, 'รายการเชื่อมต่อหมดอายุหรือไม่ตรงกับบัญชีนี้ กรุณาเริ่มเชื่อมต่อใหม่', { code: 'GOOGLE_OAUTH_STATE_INVALID' });
const validToken = (value) => typeof value === 'string' && /^[\x21-\x7e]{1,8192}$/.test(value);
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw reconnect();
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), (c) => c.charCodeAt(0));
};

export function googleConfiguration(env) {
  const names = ['GOOGLE_DRIVE_CLIENT_ID', 'GOOGLE_DRIVE_CLIENT_SECRET', 'SESSION_SECRET', 'SQ_GOOGLE_REDIRECT_URI'];
  const missing = names.filter((name) => !str(env, name).trim());
  const invalid = [];
  if (str(env, 'SESSION_SECRET') && str(env, 'SESSION_SECRET').length < 32) invalid.push('SESSION_SECRET');
  if (str(env, 'SQ_GOOGLE_REDIRECT_URI')) {
    try {
      const u = new URL(str(env, 'SQ_GOOGLE_REDIRECT_URI'));
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== GOOGLE_CALLBACK_PATH || u.href !== str(env, 'SQ_GOOGLE_REDIRECT_URI')) invalid.push('SQ_GOOGLE_REDIRECT_URI');
    } catch { invalid.push('SQ_GOOGLE_REDIRECT_URI'); }
  }
  return { configured: !missing.length && !invalid.length, missing, invalid };
}
function requireConfigured(env, req) {
  if (!googleConfiguration(env).configured) throw new HttpError(503, 'ยังตั้งค่าการเชื่อม Google ไม่ครบ กรุณาติดต่อผู้ดูแลระบบ', { code: 'GOOGLE_OAUTH_NOT_CONFIGURED' });
  if (new URL(req.url).origin !== new URL(str(env, 'SQ_GOOGLE_REDIRECT_URI')).origin) throw new HttpError(403, 'กรุณาเชื่อม Google จากเว็บไซต์หลักของระบบ', { code: 'GOOGLE_OAUTH_ORIGIN_INVALID' });
}
function requireOwner(session) {
  if (!session || session.owner !== true) throw new HttpError(403, 'เฉพาะเจ้าของระบบเชื่อมบัญชี Google ได้', { code: 'NO_PERMISSION' });
}
async function encryptionKey(env) {
  const secret = str(env, 'SESSION_SECRET');
  if (secret.length < 32) throw reconnect();
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('rrs-stock-qc:google-oauth:v1'), info: encoder.encode('aes-256-gcm') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(env, value, purpose) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) }, await encryptionKey(env), encoder.encode(value));
  return JSON.stringify({ v: 1, iv: b64(iv), ciphertext: b64(ciphertext) });
}
async function unseal(env, envelope, purpose) {
  try {
    if (typeof envelope !== 'string' || envelope.length > 20000) throw reconnect();
    const value = JSON.parse(envelope);
    if (value.v !== 1 || unb64(value.iv).length !== 12) throw reconnect();
    return decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(value.iv), additionalData: encoder.encode(purpose) }, await encryptionKey(env), unb64(value.ciphertext)));
  } catch { throw reconnect(); }
}
const clientHash = (env) => digest(str(env, 'GOOGLE_DRIVE_CLIENT_ID'));
const refreshPurpose = (hash) => `google-drive:refresh:v1:${hash}`;
const verifierPurpose = (stateHash, sessionId) => `google-drive:pkce:v1:${stateHash}:${sessionId}`;

/** The stored connection wins. A corrupt/obsolete connection never silently falls back to an older secret. */
export async function resolvedGoogleEnv(env) {
  if (!env?.DB) return env;
  let row;
  try { row = await db(env).prepare('SELECT encrypted_value,client_id_hash FROM sq_integrations WHERE id=?').bind(CONNECTION_ID).first(); }
  catch { throw reconnect(); }
  if (!row) return env; // Supports installations provisioned with a server-side refresh-token secret.
  const hash = await clientHash(env);
  if (row.client_id_hash !== hash) throw reconnect();
  const refreshToken = await unseal(env, row.encrypted_value, refreshPurpose(hash));
  if (!validToken(refreshToken)) throw reconnect();
  return { ...env, GOOGLE_DRIVE_REFRESH_TOKEN: refreshToken };
}
/** Setting names and booleans only, never client values, tokens, provider bodies or ciphertext. */
export async function googleConnectionStatus(env) {
  const config = googleConfiguration(env);
  try {
    const resolved = await resolvedGoogleEnv(env);
    return { ...config, connected: !!str(resolved, 'GOOGLE_DRIVE_REFRESH_TOKEN') };
  } catch {
    return { ...config, connected: false, code: 'GOOGLE_RECONNECT_REQUIRED' };
  }
}

export async function connectGoogle(env, req, session) {
  requireOwner(session);
  requireSameOrigin(req);
  requireConfigured(env, req);
  const body = await limitedBody(req, 1024);
  if (body.length) {
    let value;
    try { value = JSON.parse(decoder.decode(body)); } catch { throw new HttpError(400, 'ข้อมูลที่ส่งมาไม่ถูกต้อง'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new HttpError(400, 'การเชื่อม Google ไม่รับค่าปลายทางจากหน้าเว็บ');
  }
  const state = randomToken(), stateHash = await digest(state), verifier = randomToken();
  const challenge = b64(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
  const expires = Math.min(Date.now() + STATE_TTL_MS, session.expiresAt);
  const redirectUri = str(env, 'SQ_GOOGLE_REDIRECT_URI'), hash = await clientHash(env);
  const encryptedVerifier = await seal(env, verifier, verifierPurpose(stateHash, session.id));
  await db(env).batch([
    db(env).prepare('DELETE FROM sq_google_oauth_states WHERE expires_at<=? OR session_id=?').bind(Date.now(), session.id),
    db(env).prepare('INSERT INTO sq_google_oauth_states (state_hash,session_id,verifier_ciphertext,client_id_hash,redirect_uri,expires_at) VALUES (?,?,?,?,?,?)')
      .bind(stateHash, session.id, encryptedVerifier, hash, redirectUri, expires),
  ]);
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({ client_id: str(env, 'GOOGLE_DRIVE_CLIENT_ID'), redirect_uri: redirectUri,
    response_type: 'code', scope: GOOGLE_SCOPE, access_type: 'offline', prompt: 'consent', state,
    code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  return json({ ok: true, authorizationUrl: url.href, expiresAt: new Date(expires).toISOString() });
}
function callbackRedirect(result) {
  return withHeaders(new Response(null, { status: 303, headers: { Location: `/?google=${result}#backup` } }), API_HEADERS);
}
export async function googleCallback(env, req, session) {
  requireOwner(session);
  requireConfigured(env, req);
  const url = new URL(req.url), params = url.searchParams;
  const state = params.get('state');
  if (url.pathname !== GOOGLE_CALLBACK_PATH || params.getAll('state').length !== 1 || !/^[a-f0-9]{64}$/.test(state || '')
    || params.getAll('code').length > 1 || params.getAll('error').length > 1) throw badState();
  const stateHash = await digest(state);
  // DELETE RETURNING is one D1 statement: two callbacks cannot redeem the same state, even on separate isolates.
  const row = await db(env).prepare('DELETE FROM sq_google_oauth_states WHERE state_hash=? AND session_id=? AND expires_at>? RETURNING verifier_ciphertext,client_id_hash,redirect_uri,expires_at')
    .bind(stateHash, session.id, Date.now()).first();
  if (!row || row.client_id_hash !== await clientHash(env) || row.redirect_uri !== str(env, 'SQ_GOOGLE_REDIRECT_URI')) throw badState();
  if (params.has('error')) return callbackRedirect('denied');
  const code = params.get('code');
  if (typeof code !== 'string' || !code || code.length > 4096) return callbackRedirect('failed');
  try {
    const verifier = await unseal(env, row.verifier_ciphertext, verifierPurpose(stateHash, session.id));
    if (!/^[a-f0-9]{64}$/.test(verifier)) throw reconnect();
    const response = await boundedFetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: str(env, 'GOOGLE_DRIVE_CLIENT_ID'), client_secret: str(env, 'GOOGLE_DRIVE_CLIENT_SECRET'),
        grant_type: 'authorization_code', code, redirect_uri: row.redirect_uri, code_verifier: verifier }).toString() }, { timeoutMs: 15000, maxBytes: 32768 });
    const data = jsonObject(response);
    if (response.status !== 200 || !data || !validToken(data.access_token) || !validToken(data.refresh_token) || data.token_type?.toLowerCase() !== 'bearer'
      || typeof data.scope !== 'string' || !data.scope.split(/\s+/).includes(GOOGLE_SCOPE)) return callbackRedirect('failed');
    const current = await getSession(env, req);
    if (!current?.owner || current.id !== session.id || row.expires_at <= Date.now()) return callbackRedirect('failed');
    const ciphertext = await seal(env, data.refresh_token, refreshPurpose(row.client_id_hash));
    await db(env).prepare('INSERT INTO sq_integrations (id,encrypted_value,client_id_hash,scope,updated_at,updated_by) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET encrypted_value=excluded.encrypted_value,client_id_hash=excluded.client_id_hash,scope=excluded.scope,updated_at=excluded.updated_at,updated_by=excluded.updated_by')
      .bind(CONNECTION_ID, ciphertext, row.client_id_hash, GOOGLE_SCOPE, new Date().toISOString(), session.username).run();
    return callbackRedirect('connected');
  } catch {
    // Provider error bodies may contain credentials. Only this fixed outcome reaches the page or logs.
    return callbackRedirect('failed');
  }
}
