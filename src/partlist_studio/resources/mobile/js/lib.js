// Preact + htm (vendored, no build step) and small helpers shared by every screen.
import { h, render, Fragment, createRef } from '../vendor/preact.module.js';
import {
  useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer,
} from '../vendor/hooks.module.js';
import htm from '../vendor/htm.module.js';

export const html = htm.bind(h);
export {
  h, render, Fragment, createRef, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer,
};

// ---- a tiny global store -------------------------------------------------------------------------
const listeners = new Set();
export const store = {
  state: {
    online: true, version: 0, toast: null, sheet: null, hello: null, device: null, queue: 0,
  },
  set(patch) {
    this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) };
    listeners.forEach((fn) => fn(this.state));
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useStore(select = (s) => s) {
  const [value, setValue] = useState(() => select(store.state));
  const ref = useRef(select);
  ref.current = select;
  useEffect(() => {
    const sync = (s) => {
      const next = ref.current(s);
      setValue((prev) => (Object.is(prev, next) ? prev : next));
    };
    const unsubscribe = store.subscribe(sync);
    sync(store.state); // a change made between the first render and this effect
    return unsubscribe;
  }, []);
  return value;
}

// ---- local settings and sessions kept on the phone -----------------------------------------------------
export const local = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`rrs.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(`rrs.${key}`);
      else localStorage.setItem(`rrs.${key}`, JSON.stringify(value));
    } catch (e) { /* private mode */ }
  },
};

// ---- formatting -------------------------------------------------------------------------------------
export function num(v, digits = 2) {
  const x = Number(v || 0);
  if (!Number.isFinite(x)) return '0';
  return x.toLocaleString('th-TH', { maximumFractionDigits: digits });
}

export function pct(v) {
  return `${Math.round((Number(v) || 0) * 100)}%`;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso.length <= 16 ? `${iso}:00` : iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'เมื่อสักครู่';
  if (s < 3600) return `${Math.floor(s / 60)} นาทีที่แล้ว`;
  if (s < 86400) return `${Math.floor(s / 3600)} ชม.ที่แล้ว`;
  const d = new Date(t);
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear() + 543} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function clock(iso) {
  if (!iso) return '';
  return iso.replace('T', ' ').slice(11, 16);
}

export function uid() {
  const a = new Uint8Array(8);
  (self.crypto || window.crypto).getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function norm(text) {
  return String(text || '').toUpperCase().replace(/[\s\-_/()]+/g, '');
}

export function cls(...names) {
  return names.filter(Boolean).join(' ');
}

// status words of the program -> a colour name of the app
export function tone(status = '') {
  const s = String(status);
  if (/^(เสร็จ|พอ|พร้อม|ยืนยันแล้ว|แก้แล้ว|ใช้จากสต็อก)/.test(s)) return 'ok';
  if (/^(ขาด|หมด|ไม่พบ|เลยกำหนด|รอแก้)/.test(s)) return 'bad';
  if (/^(ต่ำกว่า Min|รอตรวจ|ระหว่างผลิต|รอ)/.test(s)) return 'warn';
  return 'muted';
}

// ---- feedback: sound and vibration ---------------------------------------------------------------------
let audio = null;
export function unlockAudio() {
  if (audio) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audio = new Ctx();
  } catch (e) { audio = null; }
}

function tones(list) {
  if (!local.get('sound', true) || !audio) return;
  try {
    if (audio.state === 'suspended') audio.resume();
    let t = audio.currentTime;
    for (const [freq, dur, type = 'sine', gain = 0.18] of list) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
      t += dur * 0.9;
    }
  } catch (e) { /* no audio */ }
}

export const feedback = {
  tick() { buzz(12); tones([[1320, 0.05]]); },
  ok() { buzz([18, 40, 18]); tones([[880, 0.08], [1320, 0.12]]); },
  found() { buzz(30); tones([[1046, 0.07], [1568, 0.1]]); },
  error() { buzz([120, 60, 120, 60, 220]); tones([[220, 0.18, 'square', 0.12], [180, 0.28, 'square', 0.12]]); },
  warn() { buzz([60, 40, 60]); tones([[520, 0.12, 'triangle']]); },
};

function buzz(pattern) {
  if (!local.get('vibrate', true)) return;
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* no vibration */ }
}

// ---- toasts and bottom sheets ----------------------------------------------------------------------------
let toastTimer = 0;
export function toast(text, kind = 'info', ms = 2600) {
  clearTimeout(toastTimer);
  store.set({ toast: { text, kind, id: uid() } });
  toastTimer = setTimeout(() => store.set({ toast: null }), ms);
}

export function openSheet(render, opts = {}) {
  store.set({ sheet: { render, ...opts, id: uid() } });
}

export function closeSheet() {
  store.set({ sheet: null });
}

// ---- hash routes: #/prod/job/SO6910-015?tab=parts ---------------------------------------------------------
export function parseRoute(hash = location.hash) {
  const raw = (hash || '').replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  const params = Object.fromEntries(new URLSearchParams(query));
  return { name: parts[0] || 'home', parts, params, path };
}

let depth = 0; // pages opened with go() that history.back() can return from

export function go(path, replace = false) {
  const target = `#/${path.replace(/^#?\/?/, '')}`;
  if (location.hash === target) return;
  if (replace) {
    history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    depth += 1;
    location.hash = target;
  }
}

export function back(fallback = 'home') {
  if (depth > 0) {
    depth -= 1;
    history.back();
  } else {
    go(fallback, true);
  }
}

export function useRoute() {
  const [route, setRoute] = useState(parseRoute());
  useEffect(() => {
    const onChange = () => setRoute(parseRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
