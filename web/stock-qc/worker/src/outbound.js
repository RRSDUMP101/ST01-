// Outbound HTTPS calls (Google Drive backup, Sales Office connector) – the pattern of Sales Office's boundedRequest():
// a timeout, a cap on the response size, redirects never followed (a bearer token is never forwarded to another
// origin) and errors reduced to a short code. Neither request nor response bodies, nor any header value, are ever
// logged or returned to a page.

export class OutboundError extends Error {
  /** code: short machine code safe to store/show (never a provider body or a credential). */
  constructor(code, retryable, status) {
    super(code);
    this.name = 'OutboundError';
    this.code = code;
    this.retryable = !!retryable;
    this.status = status || 0;
  }
}

export const DEFAULT_TIMEOUT_MS = 30000;

/**
 * fetch(url, init) with a timeout and a response cap. → {status, headers, bytes (Uint8Array), text()}.
 * opts: {timeoutMs, maxBytes}. Network failure / timeout → OutboundError (retryable: the outcome is uncertain).
 */
export async function boundedFetch(url, init, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const maxBytes = (opts && opts.maxBytes) || 256 * 1024;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new OutboundError('REQUEST_TIMEOUT', true));
    }, timeoutMs);
  });
  const run = async () => {
    const res = await fetch(url, Object.assign({}, init, { redirect: 'manual', signal: controller.signal }));
    if (res.status >= 300 && res.status < 400) {
      if (res.body) await res.body.cancel().catch(() => {});
      throw new OutboundError('UNEXPECTED_REDIRECT', false, res.status);
    }
    const chunks = [];
    let length = 0;
    if (res.body) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new OutboundError('RESPONSE_TOO_LARGE', false, res.status);
          }
          chunks.push(part.value);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch (e) {
          // already released
        }
      }
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    return { status: res.status, headers: res.headers, bytes, text: () => new TextDecoder().decode(bytes) };
  };
  try {
    return await Promise.race([run(), timeout]);
  } catch (e) {
    if (e instanceof OutboundError) throw e;
    throw new OutboundError('NETWORK_UNCERTAIN', true);
  } finally {
    clearTimeout(timer);
  }
}

/** JSON object of a response body ({} when empty); a body that is not a JSON object → null. */
export function jsonObject(res) {
  if (!res.bytes.length) return {};
  try {
    const v = JSON.parse(res.text());
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (e) {
    return null;
  }
}

/** Short code of any error for storage/display: an OutboundError/known code, else a generic one. */
export function errorCode(e, fallback) {
  const code = e && typeof e.code === 'string' ? e.code : '';
  return /^[A-Z][A-Z0-9_]{1,70}$/.test(code) ? code : fallback || 'INTERNAL_ERROR';
}
