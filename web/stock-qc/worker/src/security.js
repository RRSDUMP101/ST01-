// sha256 / hmac / random tokens / constant-time compare / body limits / client IP / security events
// (pattern of Sales Office lib/rrs/security.ts). Web Crypto only – the same code runs in the Worker and in Node tests.
import { db, HttpError } from './runtime.js';

const encoder = new TextEncoder();

export const hex = (buf) => [...new Uint8Array(buf)].map((v) => v.toString(16).padStart(2, '0')).join('');
export async function digest(value) {
  return hex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value));
}
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
export async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
/** Constant-time comparison of two strings (compares their SHA-256, so the length does not leak either). */
export async function secretEqual(a, b) {
  const x = await digest(String(a));
  const y = await digest(String(b));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
export const byteLength = (s) => encoder.encode(s).length;

/** Reads the body up to `max` bytes (stops reading as soon as it is over). */
export async function limitedBody(req, max) {
  const tooLarge = () => new HttpError(413, `ข้อมูลที่ส่งมาใหญ่เกินกำหนด (สูงสุด ${formatBytes(max)})`);
  if (Number(req.headers.get('content-length') || 0) > max) throw tooLarge();
  const reader = req.body ? req.body.getReader() : null;
  if (!reader) return new Uint8Array();
  const chunks = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > max) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(part.value);
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
/** JSON object body (≤ max bytes). A body that is not a JSON object is refused with 400. */
export async function readJson(req, max) {
  const raw = await limitedBody(req, max);
  let value;
  try {
    // "__proto__" keys are dropped: input is data, it never changes an object's prototype.
    value = JSON.parse(new TextDecoder().decode(raw), (k, v) => (k === '__proto__' ? undefined : v));
  } catch (e) {
    throw new HttpError(400, 'ข้อมูลที่ส่งมาไม่ใช่ JSON ที่ถูกต้อง');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'ข้อมูลที่ส่งมาต้องเป็น JSON object');
  return value;
}
export function formatBytes(n) {
  return n >= 1048576 ? `${Math.round(n / 104857.6) / 10} MB` : `${Math.round(n / 1024)} KB`;
}

export function clientIP(req) {
  return (req.headers.get('cf-connecting-ip') || 'unknown').slice(0, 64);
}

/**
 * POST/PUT/PATCH/DELETE must come from this site: Origin equal to the request origin and not a cross-site fetch
 * (Sales Office requireSameOrigin).
 */
export function requireSameOrigin(req) {
  if (req.headers.get('origin') !== new URL(req.url).origin || req.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HttpError(403, 'ไม่อนุญาตคำขอจากเว็บไซต์อื่น');
  }
}

/** Security event row (never pass secrets or tokens in detail). Failure to write it never fails the request. */
export async function securityEvent(env, req, event, severity, detail) {
  try {
    await db(env).prepare('INSERT INTO sq_security_events (id,time,ip,event,severity,detail) VALUES (?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), Date.now(), req ? clientIP(req) : 'server', event, severity, String(detail || '').slice(0, 500)).run();
  } catch (e) {
    console.error('stock-qc: security event not written', event);
  }
}

/**
 * Counter in sq_security_limits: `key` may be used `limit` times per window. Over the limit → 429 (with an event).
 * The key is hashed, so neither IPs nor usernames are stored in clear.
 */
export async function apiRateLimit(env, req, scope, subject, limit, windowMs) {
  const slot = Math.floor(Date.now() / windowMs);
  const key = `${scope}:${await digest(String(subject))}:${slot}`;
  const row = await db(env).prepare('INSERT INTO sq_security_limits (id,count,expires_at) VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1 RETURNING count')
    .bind(key, (slot + 2) * windowMs).first();
  if (((row && row.count) || 0) > limit) {
    await securityEvent(env, req, 'api_rate_limited', 'warning', scope);
    throw new HttpError(429, 'มีคำขอจำนวนมากเกินไป กรุณารอสักครู่');
  }
  if (Math.random() < 0.02) await db(env).prepare('DELETE FROM sq_security_limits WHERE expires_at<?').bind(Date.now()).run();
}
