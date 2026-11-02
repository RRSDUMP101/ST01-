// Env access, HttpError, JSON responses and security headers (pattern of Sales Office lib/rrs/runtime.ts).
// Every value of `env` stays on the server: responses say which features are configured, never a value.

export class HttpError extends Error {
  /** extra: more fields for the JSON body (e.g. {code, errors}) – never secrets. */
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || null;
  }
}

export function db(env) {
  if (!env || !env.DB) throw new HttpError(503, 'ฐานข้อมูลยังไม่พร้อมใช้งาน');
  return env.DB;
}
export function bucket(env) {
  if (!env || !env.BUCKET) throw new HttpError(503, 'พื้นที่ไฟล์ยังไม่พร้อมใช้งาน');
  return env.BUCKET;
}
/** String env value ('' when missing or not a string). */
export function str(env, name) {
  const v = env ? env[name] : undefined;
  return typeof v === 'string' ? v : '';
}
/**
 * true only for the exact text "true" (like Sales Office's RRS_PARTLIST_ENABLED==='true'): "TRUE", " true", "1" and
 * empty are all off, so a mistyped live flag fails closed.
 */
export function flag(env, name) {
  return str(env, name) === 'true';
}
/** Sales Office connector mode: off (default) | pull | pull_push – exact text only; anything else is off. */
export function bridgeMode(env) {
  const v = str(env, 'SQ_SALES_BRIDGE');
  return v === 'pull' || v === 'pull_push' ? v : 'off';
}

/** Headers on every /api response. */
export const API_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=15552000',
};
/**
 * Headers added to the page (HTML) and other static files served through the Worker. The page loads Google Fonts and
 * the xlsx library from cdnjs, so only framing, plugins and <base> are restricted here.
 */
export const PAGE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=15552000',
};
export const HTML_CSP = "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'";

export function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, API_HEADERS, headers || {}),
  });
}
/** JSON response from text that is already JSON (large commit pages are joined without parsing). */
export function jsonText(text, status, headers) {
  return new Response(text, {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, API_HEADERS, headers || {}),
  });
}
/** Copy of a response with more headers (the body is streamed, not read). */
export function withHeaders(response, headers) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
  return r;
}

export function errorResponse(e) {
  if (e instanceof HttpError) {
    return json(Object.assign({ ok: false, error: e.message }, e.extra || {}), e.status);
  }
  // Unexpected (D1/R2/engine): keep the detail out of the response. Our errors never carry tokens, passwords or
  // secret values, so the short message is safe for the Worker log.
  console.error('stock-qc: unexpected error', (e && e.name) || typeof e, String((e && e.message) || '').slice(0, 300));
  return json({ ok: false, error: 'ระบบขัดข้องชั่วคราว กรุณาลองใหม่' }, 500);
}
