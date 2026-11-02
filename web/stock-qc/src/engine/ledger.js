/*
 * Ledger: runs commands against a store, one writer at a time.
 *
 * A store keeps the commits in order and refuses a commit whose seq is not the next one ("conflict"), so two
 * people saving at the same moment cannot both succeed against the same balance: the second is prepared again
 * on top of the first and fails validation if the stock is gone.
 *
 * Store interface (all async):
 *   load(afterSeq)        -> commits with seq > afterSeq, in order
 *   append(commit)        -> {ok:true} | {ok:false, conflict:true} | {ok:false, error}
 *   lock?(holder)         -> release function, or null when someone else holds the lock (try again)
 *   subscribe?(onChange)  -> unsubscribe; onChange() when other people may have added commits
 */
(function (root) {
  'use strict';
  const RRS = (root.RRS = root.RRS || {});
  const { createState, reduce, prepare, verifyCommit } = RRS.core;

  class Ledger {
    constructor(store, opts) {
      this.store = store;
      this.state = createState();
      this.listeners = [];
      this.holder = (opts && opts.holder) || 'tab';
      this.clock = (opts && opts.clock) || (() => new Date().toISOString());
      this.maxAttempts = (opts && opts.maxAttempts) || 8;
      this.sleep = (opts && opts.sleep) || ((ms) => new Promise((r) => setTimeout(r, ms)));
      this.busy = Promise.resolve();
    }
    onChange(fn) {
      this.listeners.push(fn);
      return () => {
        this.listeners = this.listeners.filter((x) => x !== fn);
      };
    }
    emit(info) {
      for (const fn of this.listeners) {
        try {
          fn(this.state, info || {});
        } catch (e) {
          if (root.console) root.console.error(e);
        }
      }
    }
    /** Read commits added by others and apply them. Verifies the hash chain. */
    async catchUp() {
      const commits = await this.store.load(this.state.seq);
      let n = 0;
      for (const c of commits) {
        if (c.seq <= this.state.seq) continue;
        if (!verifyCommit(c)) throw new Error(`ข้อมูล commit ${c.seq} ไม่ตรงลายนิ้วมือ – ข้อมูลอาจถูกแก้ไข`);
        reduce(this.state, c);
        n += 1;
      }
      if (n) this.emit({ remote: true, count: n });
      return n;
    }
    /** Run commands one after another in this tab. */
    execute(command, ctx) {
      const run = () => this._execute(command, ctx);
      const p = this.busy.then(run, run);
      this.busy = p.catch(() => {});
      return p;
    }
    async _execute(command, ctx) {
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        let release = null;
        if (this.store.lock) {
          release = await this.store.lock(this.holder);
          if (!release) {
            await this.sleep(150 * attempt + ((attempt * 37) % 90));
            continue;
          }
        }
        try {
          await this.catchUp();
          const c = Object.assign({}, ctx, { now: (ctx && ctx.now) || this.clock() });
          const r = prepare(this.state, command, c);
          if (!r.ok || r.duplicate) return r;
          const ap = await this.store.append(r.commit);
          if (ap.ok) {
            reduce(this.state, r.commit);
            this.emit({ local: true, commit: r.commit });
            return r;
          }
          if (!ap.conflict) return { ok: false, errors: [{ code: 'STORE', message: 'บันทึกไม่สำเร็จ: ' + (ap.error || 'ไม่ทราบสาเหตุ') }] };
        } finally {
          if (release) await release();
        }
        await this.sleep(40 * attempt);
      }
      return { ok: false, errors: [{ code: 'BUSY', message: 'มีคนกำลังบันทึกพร้อมกันหลายรายการ – ลองอีกครั้ง' }] };
    }
    /** Check a command without saving (shows the errors a save would give). */
    check(command, ctx) {
      const c = Object.assign({}, ctx, { now: (ctx && ctx.now) || this.clock() });
      return prepare(this.state, command, c);
    }
  }

  /** Commits in memory (tests, sandbox). Shared by several Ledgers to act as several people. */
  class MemoryStore {
    constructor() {
      this.commits = [];
      this.subs = [];
      this.delay = 0;
    }
    async load(afterSeq) {
      if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
      return this.commits.filter((c) => c.seq > afterSeq);
    }
    async append(commit) {
      if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
      if (commit.seq !== this.commits.length + 1) return { ok: false, conflict: true };
      const last = this.commits[this.commits.length - 1];
      if (last && last.hash !== commit.prev) return { ok: false, conflict: true };
      this.commits.push(JSON.parse(JSON.stringify(commit)));
      for (const fn of this.subs) setTimeout(fn, 0);
      return { ok: true };
    }
    subscribe(fn) {
      this.subs.push(fn);
      return () => {
        this.subs = this.subs.filter((x) => x !== fn);
      };
    }
  }

  RRS.Ledger = Ledger;
  RRS.MemoryStore = MemoryStore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
