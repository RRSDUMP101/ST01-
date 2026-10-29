// Talking to the program on the PC: token, errors, changes made while the Wi-Fi drops, live updates.
import { local, store, toast, uid, useEffect, useRef, useState, useStore } from './lib.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const auth = {
  get token() { return local.get('token', ''); },
  set token(v) { local.set('token', v || null); },
};

async function call(method, path, body, { timeout = 15000, rid = '' } = {}) {
  const headers = { Accept: 'application/json' };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (rid) headers['X-Request-Id'] = rid;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(`api/${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal, cache: 'no-store',
    });
  } catch (e) {
    clearTimeout(timer);
    if (store.state.online) store.set({ online: false });
    throw new ApiError(0, 'เชื่อมต่อโปรแกรมบนคอมไม่ได้ – ตรวจ Wi-Fi และให้คอมเปิดโหมดมือถืออยู่');
  }
  clearTimeout(timer);
  if (!store.state.online) store.set({ online: true });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 401) {
    store.set({ paired: false });
    throw new ApiError(401, (data && data.error) || 'ยังไม่ได้จับคู่เครื่องนี้');
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `ผิดพลาด (${res.status})`);
  return data;
}

export const api = {
  get(path, params) {
    const qs = params ? `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''))}` : '';
    return call('GET', path + (qs === '?' ? '' : qs));
  },
  post(path, body, opts) { return call('POST', path, body || {}, opts); },

  // changes the phone keeps and sends again when the PC answers (same request id = done once)
  async change(path, body, label) {
    const rid = uid();
    try {
      return await call('POST', path, body, { rid });
    } catch (e) {
      if (e.status !== 0) throw e;
      const queue = local.get('outbox', []);
      queue.push({ rid, path, body, label, at: new Date().toISOString() });
      local.set('outbox', queue);
      store.set({ queue: queue.length });
      toast(`เก็บไว้ในเครื่องก่อน – ส่งให้เมื่อเชื่อมต่อได้ (${label || path})`, 'warn', 3600);
      return { queued: true };
    }
  },

  async flush() {
    if (this.flushing) return 0;
    this.flushing = true;
    let sent = 0;
    try {
      for (;;) {
        const queue = local.get('outbox', []);
        if (!queue.length) break;
        const item = queue[0];
        try {
          await call('POST', item.path, item.body, { rid: item.rid });
          sent += 1;
        } catch (e) {
          if (e.status === 0) break; // still no connection: keep them all
          // refused by the PC (job closed, wrong quantity …): drop it and say so
          toast(`ส่งไม่สำเร็จ: ${item.label || item.path} – ${e.message}`, 'bad', 5000);
        }
        local.set('outbox', local.get('outbox', []).filter((q) => q.rid !== item.rid));
      }
    } finally {
      this.flushing = false;
      store.set({ queue: local.get('outbox', []).length });
    }
    if (sent) toast(`ส่งรายการที่ค้างแล้ว ${sent} รายการ`, 'ok');
    return sent;
  },

  // pictures need the token: fetched once and kept as object URLs
  blobs: new Map(),
  async blobUrl(path) {
    if (this.blobs.has(path)) return this.blobs.get(path);
    const res = await fetch(`api/${path}`, { headers: { Authorization: `Bearer ${auth.token}` } });
    if (!res.ok) throw new ApiError(res.status, 'ไม่มีรูป');
    const url = URL.createObjectURL(await res.blob());
    this.blobs.set(path, url);
    return url;
  },
};

// ---- live updates: long poll /api/events, then the screens fetch again --------------------------------------
let polling = false;
export function startEvents() {
  if (polling) return;
  polling = true;
  let since = 0;
  const loop = async () => {
    while (polling) {
      if (!auth.token || store.state.paired === false) { await sleep(2000); continue; }
      try {
        const ans = await call('GET', `events?since=${since}`, undefined, { timeout: 30000 });
        if (ans && ans.version !== since) {
          const first = since === 0;
          since = ans.version;
          if (!first) store.set({ version: ans.version, kinds: ans.kinds });
        }
        if (local.get('outbox', []).length) await api.flush();
      } catch (e) {
        await sleep(e.status === 0 ? 4000 : 6000);
      }
    }
  };
  loop();
  window.addEventListener('online', () => api.flush());
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- data of a screen: fetched again when the PC says something changed ---------------------------------------
export function useData(path, params, deps = []) {
  const version = useStore((s) => s.version);
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const key = `${path}?${JSON.stringify(params || {})}`;
  const last = useRef('');
  const load = async (quiet = false) => {
    if (!path) return;
    if (!quiet) setState((s) => ({ ...s, loading: true }));
    try {
      const data = await api.get(path, params);
      last.current = key;
      setState({ data, error: null, loading: false });
    } catch (e) {
      setState((s) => ({ data: last.current === key ? s.data : null, error: e, loading: false }));
    }
  };
  useEffect(() => { load(last.current === key); }, [key, version, ...deps]);
  return { ...state, reload: () => load(true) };
}
