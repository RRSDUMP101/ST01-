/*
 * Where commits are kept.
 *   LocalStore      this browser only (demo / trial data)
 *   ArtifactDbStore the shared database of the published page (claude.use('db')): every viewer sees the same data
 *   RemoteLedger    a server (Cloudflare Worker) that runs the same engine and keeps the data in Google Sheets –
 *                   the API this page expects is in web/stock-qc/README.md; nothing is configured yet
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;

  class LocalStore {
    constructor(key) {
      this.key = key;
      this.mem = null; // used when the browser refuses storage
      this.subs = [];
      try {
        root.addEventListener && root.addEventListener('storage', (e) => {
          if (e.key === this.key) for (const fn of this.subs) fn();
        });
      } catch (e) { /* no storage events */ }
    }
    _read() {
      if (this.mem) return this.mem;
      try {
        const txt = root.localStorage.getItem(this.key);
        return txt ? JSON.parse(txt) : [];
      } catch (e) {
        this.mem = this.mem || [];
        return this.mem;
      }
    }
    _write(list) {
      try {
        root.localStorage.setItem(this.key, JSON.stringify(list));
        this.mem = null;
        return true;
      } catch (e) {
        this.mem = list;
        return false;
      }
    }
    get persistent() {
      try {
        root.localStorage.setItem(this.key + ':probe', '1');
        root.localStorage.removeItem(this.key + ':probe');
        return !this.mem;
      } catch (e) {
        return false;
      }
    }
    async load(after) {
      return this._read().filter((c) => c.seq > after);
    }
    async append(commit) {
      const list = this._read();
      if (commit.seq !== list.length + 1) return { ok: false, conflict: true };
      if (list.length && list[list.length - 1].hash !== commit.prev) return { ok: false, conflict: true };
      list.push(commit);
      this._write(list);
      return { ok: true };
    }
    subscribe(fn) {
      this.subs.push(fn);
      return () => {
        this.subs = this.subs.filter((x) => x !== fn);
      };
    }
    clear() {
      try {
        root.localStorage.removeItem(this.key);
      } catch (e) { /* ignore */ }
      this.mem = null;
    }
  }

  /**
   * Shared database of the artifact. Layout:
   *   tx/c0000000001 … {seq, c: commit}   one document per commit (append only)
   *   meta/head        {seq, hash}         newest commit (a hint for listeners)
   *   meta/lock        lease               one writer at a time
   * The lease makes saving one-at-a-time for every viewer of the page; before writing commit N the writer checks
   * that tx/cN does not exist yet, and reads it back after writing.
   */
  class ArtifactDbStore {
    constructor(db, opts) {
      this.db = db;
      this.page = (opts && opts.page) || 500;
    }
    static id(seq) {
      return 'c' + String(seq).padStart(10, '0');
    }
    async load(after) {
      const out = [];
      let from = after;
      for (;;) {
        const snap = await this.db.collection('tx').where('seq', '>', from).orderBy('seq').limit(this.page).get();
        for (const d of snap.docs) {
          const body = d.data();
          if (body && body.c) out.push(body.c);
        }
        if (snap.size < this.page) break;
        from = out[out.length - 1].seq;
      }
      return out;
    }
    async lock(holder) {
      try {
        const r = await this.db.doc('meta/lock').acquire({ holder, ttlMs: 10000 });
        if (!r.acquired) return null;
        return async () => {
          try {
            await this.db.doc('meta/lock').acquire({ holder, ttlMs: 1000 }); // let it lapse in a second
          } catch (e) { /* it lapses anyway */ }
        };
      } catch (e) {
        if (e && e.code === 'resource_exhausted') return null;
        throw e;
      }
    }
    async append(commit) {
      const ref = this.db.collection('tx').doc(ArtifactDbStore.id(commit.seq));
      try {
        const existing = await ref.get();
        if (existing.exists) return { ok: false, conflict: true };
        const size = JSON.stringify(commit).length;
        if (size > 240000) return { ok: false, error: 'รายการใหญ่เกินกว่าที่ฐานข้อมูลของหน้านี้เก็บได้ในครั้งเดียว – แบ่งเป็นหลายครั้ง' };
        await ref.set({ seq: commit.seq, c: commit });
        const back = await ref.get();
        const c = back.exists && back.data().c;
        if (!c || c.hash !== commit.hash) return { ok: false, conflict: true };
        await this.db.doc('meta/head').set({ seq: commit.seq, hash: commit.hash, at: commit.at });
        return { ok: true };
      } catch (e) {
        if (e && e.code === 'quota_exceeded') return { ok: false, error: 'ฐานข้อมูลของหน้านี้เต็ม – สำรองข้อมูลแล้วย้ายไปใช้เซิร์ฟเวอร์ (Cloudflare + Google Sheet)' };
        if (e && e.code === 'invalid_argument') return { ok: false, error: 'บัญชีนี้ไม่มีสิทธิ์บันทึกข้อมูลร่วม (ต้องเป็นผู้ร่วมแก้ไขของหน้า)' };
        return { ok: false, error: (e && e.message) || String(e) };
      }
    }
    subscribe(fn, onError) {
      return this.db.doc('meta/head').onSnapshot(() => fn(), (e) => onError && onError(e));
    }
  }

  /**
   * Server mode: the Cloudflare Worker in web/stock-qc/worker runs the same engine and is the only writer
   * (D1 + R2 + session login, the way RRS Sale Office records data – see BACKEND_DESIGN.md):
   *   POST {api}/command   {kind, payload, requestId}  -> the same result shape as RRS.core.prepare
   *   GET  {api}/commits?after=N                       -> {commits:[…], more}
   * Same interface as RRS.Ledger, so the screens do not change.
   */
  class RemoteLedger {
    constructor(api, opts) {
      this.api = String(api).replace(/\/+$/, '');
      this.state = RRS.core.createState();
      this.listeners = [];
      this.headers = (opts && opts.headers) || {};
    }
    onChange(fn) {
      this.listeners.push(fn);
      return () => {
        this.listeners = this.listeners.filter((x) => x !== fn);
      };
    }
    emit(info) {
      for (const fn of this.listeners) fn(this.state, info || {});
    }
    async catchUp() {
      let n = 0;
      for (let page = 0; page < 1000; page++) {
        const r = await fetch(`${this.api}/commits?after=${this.state.seq}`, { headers: this.headers, credentials: 'same-origin' });
        if (r.status === 401) throw Object.assign(new Error('กรุณาเข้าสู่ระบบอีกครั้ง'), { status: 401 });
        if (!r.ok) throw new Error('อ่านข้อมูลจากเซิร์ฟเวอร์ไม่ได้ (' + r.status + ')');
        const body = await r.json();
        const before = this.state.seq;
        for (const c of body.commits || []) {
          if (c.seq <= this.state.seq) continue;
          if (!RRS.core.verifyCommit(c)) throw new Error(`commit ${c.seq} ไม่ตรงลายนิ้วมือ`);
          RRS.core.reduce(this.state, c);
          n++;
        }
        if (!body.more || this.state.seq === before) break;
      }
      if (n) this.emit({ remote: true, count: n });
      return n;
    }
    async execute(command, ctx) {
      const r = await fetch(`${this.api}/command`, { method: 'POST', credentials: 'same-origin',
        headers: Object.assign({ 'content-type': 'application/json' }, this.headers),
        body: JSON.stringify({ kind: command.kind, payload: command.payload, requestId: command.requestId }) }); // the server decides who you are from the session
      let body = null;
      try {
        body = await r.json();
      } catch (e) {
        body = null;
      }
      if (r.status === 401) return { ok: false, auth: true, errors: [{ code: 'AUTH', message: 'หมดเวลาเข้าสู่ระบบ – เข้าสู่ระบบอีกครั้ง' }] };
      if (!body) return { ok: false, errors: [{ code: 'STORE', message: 'เซิร์ฟเวอร์ไม่ตอบ (' + r.status + ')' }] };
      if (body.error && !body.errors) return { ok: false, errors: [{ code: 'HTTP_' + r.status, message: body.error }] };
      await this.catchUp();
      return body;
    }
    check(command, ctx) {
      return RRS.core.prepare(this.state, command, Object.assign({ now: new Date().toISOString() }, ctx));
    }
  }

  RRS.stores = { LocalStore, ArtifactDbStore, RemoteLedger };
})(typeof globalThis !== 'undefined' ? globalThis : this);
