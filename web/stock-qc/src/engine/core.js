/*
 * RRS Stock & QC — engine core (no DOM). Runs in the browser, in Node tests and later in a Cloudflare Worker.
 *
 * Model: an append-only list of commits. A command is validated against the current state by prepare(), which
 * returns either errors (nothing changes) or ONE commit holding every row change ("effects"). reduce() applies a
 * commit. Because a commit is all-or-nothing and commits are applied in sequence, a document with one bad line
 * changes nothing, and a request id seen before never applies twice (also after a restart: the ids are rebuilt
 * from the commits).
 *
 * Commit: {seq, id (request id), kind, at, by, via, summary, payloadHash, effects:[{t, k, v}], prev, hash}
 *   effects: put row v at table t / key k (v === null deletes the row)
 * State:  {seq, head, tables:{name:{key:row}}, requests:{requestId:{seq, payloadHash}}}
 */
(function (root) {
  'use strict';
  const RRS = (root.RRS = root.RRS || {});

  // ---------------------------------------------------------------------------------------------------------
  // utilities
  // ---------------------------------------------------------------------------------------------------------
  const util = {};

  /** Lookup key of a code: upper case, no spaces / - _ / ( ) – 'rrs-t 001' and 'RRS-T-001' are the same. */
  util.ckey = function ckey(code) {
    return String(code == null ? '' : code).toUpperCase().replace(/[\s\-_/() .]+/g, '');
  };
  util.round = function round(n, d) {
    const p = Math.pow(10, d == null ? 6 : d);
    return Math.round((Number(n) || 0) * p) / p;
  };
  util.num = function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    const s = String(v == null ? '' : v).replace(/,/g, '').trim();
    if (s === '') return NaN;
    const n = Number(s);
    return isFinite(n) ? n : NaN;
  };
  util.trim = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  /** Main form of a code: trimmed, upper case, single spaces. */
  util.normCode = (code) => util.trim(code).toUpperCase();
  /** Bangkok date (UTC+7, no daylight saving) of an ISO time: 'YYYY-MM-DD'. */
  util.bkkDate = function bkkDate(iso) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return String(iso || '').slice(0, 10);
    return new Date(t + 7 * 3600e3).toISOString().slice(0, 10);
  };
  /** '2026-11-02' -> '02/11/2569' */
  util.beDate = function beDate(d) {
    const s = String(d || '').slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : s;
  };
  util.beDateTime = function beDateTime(iso) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return String(iso || '');
    const b = new Date(t + 7 * 3600e3).toISOString();
    return `${util.beDate(b.slice(0, 10))} ${b.slice(11, 16)}`;
  };
  util.daysBetween = function daysBetween(a, b) {
    return Math.round((Date.parse(String(b).slice(0, 10)) - Date.parse(String(a).slice(0, 10))) / 86400e3);
  };
  util.addDays = function addDays(d, n) {
    const t = Date.parse(String(d).slice(0, 10));
    return new Date(t + n * 86400e3).toISOString().slice(0, 10);
  };
  util.clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  /** JSON with sorted keys: the same value always gives the same text (hashes, request checks). */
  util.stable = function stable(v) {
    if (v === undefined) return 'null';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  };
  util.pad = (n, w) => String(n).padStart(w, '0');
  const own = Object.prototype.hasOwnProperty;
  /** obj[k] only when it is the object's own key (never Object.prototype members such as 'constructor'). */
  util.own = (obj, k) => (obj && own.call(obj, k) ? obj[k] : undefined);
  /** Keys that would change an object's prototype or shadow its members. */
  util.badKey = (k) => k === '__proto__' || k === 'prototype' || k === 'constructor' || (typeof k === 'string' && own.call(Object.prototype, k));
  util.sum = (arr, f) => arr.reduce((s, x) => s + (f ? f(x) : x), 0);

  // SHA-256 (synchronous, UTF-8) – commit hash chain and file fingerprints.
  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2]);
  util.sha256 = function sha256(input) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
    const len = bytes.length;
    const total = ((len + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor(len / 0x20000000), false);
    dv.setUint32(total - 4, (len << 3) >>> 0, false);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
      0x5be0cd19]);
    const W = new Uint32Array(64);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const a = W[i - 15], b = W[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K256[i] + W[i]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return Array.from(H, (x) => x.toString(16).padStart(8, '0')).join('');
  };
  RRS.util = util;

  // ---------------------------------------------------------------------------------------------------------
  // table registry: data dictionary, Google Sheet tab layout
  // ---------------------------------------------------------------------------------------------------------
  const schema = { tables: {} };
  /**
   * schema.define('items', {label, phase, key: 'code' | ['code','unit'], fields: [[name, type, label, note?]]})
   * The key fields are joined with '|' to make the row key.
   */
  schema.define = function define(name, def) {
    const fields = (def.fields || []).map((f) => (Array.isArray(f) ? { name: f[0], type: f[1], label: f[2], note: f[3] || '' } : f));
    schema.tables[name] = { name, label: def.label || name, phase: def.phase == null ? '' : def.phase,
      key: [].concat(def.key || 'id'), fields, note: def.note || '' };
    return schema.tables[name];
  };
  schema.rowKey = function rowKey(name, row) {
    const t = schema.tables[name];
    if (!t) throw new Error('unknown table ' + name);
    return t.key.map((k) => String(row[k] == null ? '' : row[k])).join('|');
  };
  RRS.schema = schema;

  // ---------------------------------------------------------------------------------------------------------
  // roles and permissions
  // ---------------------------------------------------------------------------------------------------------
  const ROLES = {
    admin: 'ผู้ดูแลระบบ',
    manager: 'ผู้บริหาร / เจ้าของโครงการ',
    store: 'สโตร์',
    store_lead: 'หัวหน้าสโตร์',
    planner: 'วางแผนผลิต',
    production: 'ฝ่ายผลิต',
    engineering: 'วิศวกรรม',
    purchasing: 'จัดซื้อ',
    purchasing_lead: 'หัวหน้าจัดซื้อ',
    accounting: 'บัญชี',
    qc: 'QC ผู้ตรวจ',
    qc_lead: 'หัวหน้า QC (อนุมัติปล่อยผ่าน)',
    viewer: 'ดูอย่างเดียว',
  };
  // permission -> roles that hold it ('admin' holds every permission; separation-of-duty checks still apply)
  const PERMS = {
    'settings.edit': ['manager'],
    'users.manage': [],
    'master.edit': ['store_lead', 'engineering'],
    'bom.approve': ['engineering'],
    'decision.record': ['manager', 'store_lead', 'accounting'],
    'kpi.record': ['manager', 'store_lead', 'qc_lead'],
    'doc.draft': ['store', 'store_lead', 'planner', 'production', 'purchasing'],
    'doc.post': ['store', 'store_lead'],
    'doc.postAdjust': ['store_lead'],
    'doc.cancel': ['store_lead'],
    'doc.markExpress': ['accounting', 'store_lead'],
    'stock.overrideApprove': ['store_lead', 'accounting'],
    'transfer.receive': ['store', 'store_lead'],
    'job.manage': ['planner'],
    'production.record': ['production', 'planner'],
    'reserve.manage': ['planner', 'store_lead'],
    'pick.post': ['store', 'store_lead'],
    'express.import': ['accounting', 'store_lead'],
    'express.reconcile': ['accounting'],
    'count.create': ['store_lead'],
    'count.enter': ['store', 'store_lead'],
    'count.approve': ['store_lead', 'accounting'],
    'supplier.manage': ['purchasing', 'purchasing_lead'],
    'pr.create': ['store', 'store_lead', 'planner', 'purchasing'],
    'pr.approve': ['purchasing_lead', 'manager'],
    'po.manage': ['purchasing', 'purchasing_lead'],
    'po.receive': ['store', 'store_lead'],
    'po.overReceive': ['purchasing_lead'],
    'po.close': ['purchasing_lead'],
    'qc.plan': ['engineering', 'qc_lead'],
    'qc.planApprove': ['engineering', 'qc_lead'],
    'qc.inspect': ['qc', 'qc_lead'],
    'qc.release': ['qc_lead'],
    'qc.quarantine': ['qc', 'qc_lead', 'store_lead'],
    'ncr.disposition': ['qc_lead', 'engineering'],
    'ncr.useAsIs': ['qc_lead'],
    'lot.manage': ['store', 'store_lead', 'qc', 'qc_lead'],
    'offcut.manage': ['store', 'store_lead', 'production'],
    'uat.record': ['manager', 'store', 'store_lead', 'planner', 'production', 'engineering', 'purchasing',
      'purchasing_lead', 'accounting', 'qc', 'qc_lead'],
    'backup.export': ['manager', 'accounting'],
    'backup.restore': [],
  };
  const PERM_LABELS = {
    'settings.edit': 'แก้ค่าตั้งระบบ', 'users.manage': 'จัดการผู้ใช้', 'master.edit': 'แก้ข้อมูลหลัก', 'bom.approve': 'อนุมัติ BOM',
    'decision.record': 'บันทึกข้อตกลง', 'kpi.record': 'บันทึกตัวชี้วัด', 'doc.draft': 'ร่างเอกสาร', 'doc.post': 'บันทึกรับ–จ่าย',
    'doc.postAdjust': 'บันทึกปรับยอด', 'doc.cancel': 'ยกเลิกเอกสาร', 'doc.markExpress': 'บันทึกเลขที่ Express',
    'stock.overrideApprove': 'อนุมัติข้อยกเว้นยอดติดลบ', 'transfer.receive': 'รับโอน', 'job.manage': 'จัดการงานผลิต',
    'production.record': 'บันทึกผลผลิต', 'reserve.manage': 'จองของให้งาน', 'pick.post': 'หยิบ/เบิกให้งาน',
    'express.import': 'นำเข้า Express', 'express.reconcile': 'กระทบยอด Express', 'count.create': 'เปิดรอบนับ',
    'count.enter': 'บันทึกผลนับ', 'count.approve': 'อนุมัติผลนับ', 'supplier.manage': 'จัดการผู้ขาย', 'pr.create': 'ขอซื้อ',
    'pr.approve': 'อนุมัติขอซื้อ', 'po.manage': 'จัดการใบสั่งซื้อ', 'po.receive': 'รับของตาม PO', 'po.overReceive': 'อนุมัติรับเกิน PO',
    'po.close': 'ปิด PO', 'qc.plan': 'ทำแผนตรวจ', 'qc.planApprove': 'อนุมัติแผนตรวจ', 'qc.inspect': 'บันทึกผลตรวจ QC',
    'qc.release': 'ปล่อยผ่าน QC', 'qc.quarantine': 'กักกันล็อต', 'ncr.disposition': 'ตัดสิน NCR', 'ncr.useAsIs': 'อนุมัติใช้ตามสภาพ',
    'lot.manage': 'จัดการล็อต/ใบรับรอง', 'offcut.manage': 'จัดการเศษเหล็ก', 'uat.record': 'บันทึกผลทดสอบรับงาน',
    'backup.export': 'สำรองข้อมูล', 'backup.restore': 'กู้คืนข้อมูล',
  };
  const auth = { ROLES, PERMS, PERM_LABELS };
  auth.definePerm = function definePerm(perm, roles, label) {
    PERMS[perm] = roles.slice();
    if (label) PERM_LABELS[perm] = label;
  };
  /** Can this user row do `perm` (optionally in warehouse `wh`)? */
  auth.can = function can(user, perm, wh) {
    if (!user || user.active === false) return false;
    const roles = user.roles || [];
    let ok = roles.indexOf('admin') >= 0 || (PERMS[perm] || []).some((r) => roles.indexOf(r) >= 0);
    if (ok && wh && user.warehouses && user.warehouses.length && roles.indexOf('admin') < 0) {
      ok = user.warehouses.indexOf(wh) >= 0 || wh === TRANSIT;
    }
    return ok;
  };
  auth.rolesFor = (perm) => ['admin'].concat(PERMS[perm] || []);
  RRS.auth = auth;

  // ---------------------------------------------------------------------------------------------------------
  // stock constants (quality status of a balance) – shared by every module
  // ---------------------------------------------------------------------------------------------------------
  const STATUS = { AVAILABLE: 'AVAILABLE', QC_HOLD: 'QC_HOLD', QUARANTINE: 'QUARANTINE', REWORK: 'REWORK' };
  const STATUS_LABEL = { AVAILABLE: 'ใช้ได้', QC_HOLD: 'รอตรวจ', QUARANTINE: 'กักกัน', REWORK: 'รอแก้ไข' };
  const TRANSIT = 'TRANSIT';
  RRS.STATUS = STATUS;
  RRS.STATUS_LABEL = STATUS_LABEL;
  RRS.TRANSIT = TRANSIT;

  schema.define('balances', {
    label: 'ยอดคงเหลือตามตำแหน่ง', phase: 1, key: ['code', 'wh', 'bin', 'status', 'lot'],
    fields: [['code', 'text', 'รหัสสินค้า (key)'], ['wh', 'text', 'คลัง'], ['bin', 'text', 'ช่องเก็บ'],
      ['status', 'enum', 'สถานะคุณภาพ', 'AVAILABLE/QC_HOLD/QUARANTINE/REWORK'], ['lot', 'text', 'ล็อต (ว่าง = ไม่ติดตาม)'],
      ['qty', 'number', 'จำนวน (หน่วยหลัก)'], ['updatedAt', 'datetime', 'ปรับล่าสุด'], ['lastIn', 'datetime', 'รับเข้าล่าสุด']],
  });
  schema.define('movements', {
    label: 'ประวัติเคลื่อนไหว', phase: 1, key: 'id',
    note: 'ไม่มีการแก้/ลบ การยกเลิกเป็นรายการกลับที่อ้าง reversalOf',
    fields: [['id', 'text', 'รหัสรายการ (seq.n)'], ['seq', 'number', 'ลำดับ commit'], ['at', 'datetime', 'เวลา'],
      ['date', 'date', 'วันที่เอกสาร'], ['docType', 'text', 'ประเภทเอกสาร'], ['docNo', 'text', 'เลขที่เอกสาร'],
      ['line', 'number', 'บรรทัด'], ['code', 'text', 'รหัสสินค้า'], ['wh', 'text', 'คลัง'], ['bin', 'text', 'ช่องเก็บ'],
      ['status', 'text', 'สถานะคุณภาพ'], ['lot', 'text', 'ล็อต'], ['qty', 'number', 'จำนวน (+ รับ / − จ่าย)'],
      ['balanceAfter', 'number', 'คงเหลือของตำแหน่งนี้หลังรายการ'], ['job', 'text', 'งาน/SO'], ['by', 'text', 'ผู้ทำ'],
      ['reversalOf', 'text', 'กลับรายการของ'], ['remark', 'text', 'หมายเหตุ']],
  });
  schema.define('counters', { label: 'ตัวนับเลขที่เอกสาร', phase: 1, key: 'prefix',
    fields: [['prefix', 'text', 'คำนำหน้า'], ['n', 'number', 'เลขล่าสุด']] });
  schema.define('audit', {
    label: 'บันทึกการทำรายการ (audit)', phase: 5, key: 'seq',
    fields: [['seq', 'number', 'ลำดับ'], ['at', 'datetime', 'เวลา'], ['by', 'text', 'ผู้ทำ'], ['via', 'text', 'บัญชีผู้ใช้'],
      ['kind', 'text', 'คำสั่ง'], ['summary', 'text', 'สรุป'], ['request', 'text', 'รหัสคำขอ'], ['hash', 'text', 'ลายนิ้วมือ']],
  });

  // ---------------------------------------------------------------------------------------------------------
  // state, commits
  // ---------------------------------------------------------------------------------------------------------
  const GENESIS = '0'.repeat(64);
  function createState() {
    return { seq: 0, head: GENESIS, tables: {}, requests: {} };
  }
  function tableOf(state, t) {
    return state.tables[t] || (state.tables[t] = {});
  }
  function commitHash(c) {
    const body = Object.assign({}, c);
    delete body.hash;
    return util.sha256(c.prev + util.stable(body));
  }
  /** Apply one commit (mutates state). Throws when the commit does not follow the state. */
  function reduce(state, commit) {
    if (commit.seq !== state.seq + 1) throw new Error(`commit ${commit.seq} does not follow ${state.seq}`);
    if (commit.prev !== state.head) throw new Error(`commit ${commit.seq} was made on another history`);
    for (const e of commit.effects) {
      const tbl = tableOf(state, e.t);
      if (util.badKey(e.k) || util.badKey(e.t)) throw new Error(`commit ${commit.seq} has a forbidden key ${e.t}/${e.k}`);
      if (e.v === null) delete tbl[e.k];
      else tbl[e.k] = e.v;
    }
    state.seq = commit.seq;
    state.head = commit.hash;
    if (commit.id && !util.badKey(commit.id)) state.requests[commit.id] = { seq: commit.seq, payloadHash: commit.payloadHash };
    return state;
  }
  function verifyCommit(c) {
    return commitHash(c) === c.hash;
  }

  // ---------------------------------------------------------------------------------------------------------
  // commands and hooks
  // ---------------------------------------------------------------------------------------------------------
  const commands = {};
  const hooks = {};
  RRS.commands = {
    defs: commands,
    /** define(kind, {label, perm: string | (tx,p)=>string|null, bootstrap?: bool (allowed while there are no users),
     *  public?: bool (allowed for anyone, e.g. asking for access), prepare(tx, payload)}) */
    define(kind, def) {
      commands[kind] = Object.assign({ kind }, def);
      return commands[kind];
    },
  };
  RRS.hooks = {
    on(name, fn) {
      (hooks[name] || (hooks[name] = [])).push(fn);
    },
    run(name) {
      const args = Array.prototype.slice.call(arguments, 1);
      for (const fn of hooks[name] || []) fn.apply(null, args);
    },
  };

  /** Error codes shown to people come with Thai text; `code` stays machine-readable. */
  function err(code, message, where) {
    return Object.assign({ code, message }, where || {});
  }

  /**
   * Transaction builder handed to command.prepare(). Reads see this command's own pending writes.
   * Nothing touches the state: the effects become the commit, or are dropped when there is an error.
   */
  class Tx {
    constructor(state, ctx, kind) {
      this.state = state;
      this.ctx = ctx;
      this.kind = kind;
      this.seq = state.seq + 1;
      this.now = ctx.now;
      this.date = util.bkkDate(ctx.now);
      this.userId = ctx.user;
      this.user = (state.tables.users || {})[ctx.user] || ctx.bootstrapUser || null;
      this.errors = [];
      this.warnings = [];
      this.pending = {}; // t -> {k: row|null}
      this.order = []; // [t, k] in write order
      this.summary = '';
      this.result = {};
      this.moveN = 0;
    }
    get(t, k) {
      const p = this.pending[t];
      if (p && Object.prototype.hasOwnProperty.call(p, k)) return p[k];
      const tbl = this.state.tables[t];
      return (tbl && util.own(tbl, k)) || null;
    }
    /** Rows of a table with this command's writes applied (filter optional). */
    all(t, filter) {
      const base = this.state.tables[t] || {};
      const p = this.pending[t] || {};
      const out = [];
      for (const k in base) if (!Object.prototype.hasOwnProperty.call(p, k)) out.push(base[k]);
      for (const k in p) if (p[k] !== null) out.push(p[k]);
      return filter ? out.filter(filter) : out;
    }
    put(t, k, v) {
      if (util.badKey(k) || util.badKey(t)) {
        this.error('BAD_KEY', `รหัส "${k}" ใช้เป็นรหัสข้อมูลไม่ได้`);
        return null;
      }
      const p = this.pending[t] || (this.pending[t] = {});
      if (!Object.prototype.hasOwnProperty.call(p, k)) this.order.push([t, k]);
      p[k] = v === null ? null : util.clone(v);
      return p[k];
    }
    putRow(t, row) {
      return this.put(t, schema.rowKey(t, row), row);
    }
    del(t, k) {
      this.put(t, k, null);
    }
    error(code, message, where) {
      this.errors.push(err(code, message, where));
      return false;
    }
    warn(message) {
      this.warnings.push(message);
    }
    get ok() {
      return this.errors.length === 0;
    }
    can(perm, wh) {
      return auth.can(this.user, perm, wh);
    }
    /** Fails the command when the user lacks perm (returns false). */
    need(perm, wh, where) {
      if (this.can(perm, wh)) return true;
      const roles = auth.rolesFor(perm).map((r) => ROLES[r] || r).join(', ');
      return this.error('NO_PERMISSION', `ไม่มีสิทธิ์ (${PERM_LABELS[perm] || perm}${wh ? ' คลัง ' + wh : ''}) – ต้องเป็น: ${roles}`, where);
    }
    /** Separation of duties: the same person may not do both steps (when the policy is on). */
    different(otherUserId, what, where) {
      const pol = this.settings().policies || {};
      if (pol.sod === false || !otherUserId || otherUserId !== this.userId) return true;
      return this.error('SAME_PERSON', `${what} ต้องเป็นคนละคนกับผู้ทำรายการ (แยกหน้าที่)`, where);
    }
    settings() {
      return this.get('settings', 'main') || RRS.defaultSettings();
    }
    /** Next running number: TYPE + พ.ศ. 2 หลัก + เดือน + '-' + 4 หลัก, e.g. PD6911-0001. */
    nextNo(type, date) {
      const d = String(date || this.date);
      const prefix = `${type}${util.pad((Number(d.slice(0, 4)) + 543) % 100, 2)}${d.slice(5, 7)}`;
      const c = this.get('counters', prefix);
      const n = (c ? c.n : 0) + 1;
      this.put('counters', prefix, { prefix, n });
      return `${prefix}-${util.pad(n, 4)}`;
    }
    nextId(type) {
      const c = this.get('counters', type);
      const n = (c ? c.n : 0) + 1;
      this.put('counters', type, { prefix: type, n });
      return `${type}-${util.pad(n, 5)}`;
    }

    // ---- stock balances ----------------------------------------------------------------------------------
    /** Balance row (or a zero row) at an exact location. */
    balanceAt(loc) {
      const k = balanceKey(loc);
      return this.get('balances', k) || { code: loc.code, wh: loc.wh, bin: loc.bin || '', status: loc.status || STATUS.AVAILABLE,
        lot: loc.lot || '', qty: 0 };
    }
    /**
     * Change a balance by `delta` (base unit) and record the movement. A balance can never go below zero here,
     * unless opts.allowNegative (an approved exception – the caller checks who approved it).
     * mv: {docType, docNo, line, job, remark, reversalOf}
     */
    move(loc, delta, mv, opts) {
      const row = Object.assign({}, this.balanceAt(loc));
      row.bin = row.bin || '';
      row.lot = row.lot || '';
      row.status = row.status || STATUS.AVAILABLE;
      const qty = util.round(row.qty + delta);
      if (qty < 0 && !(opts && opts.allowNegative)) {
        this.error('NEGATIVE', `${loc.code} ที่ ${loc.wh}${loc.bin ? '/' + loc.bin : ''}${row.status !== STATUS.AVAILABLE ? ' (' + STATUS_LABEL[row.status] + ')' : ''}${row.lot ? ' ล็อต ' + row.lot : ''} มี ${util.round(row.qty)} ต้องการ ${util.round(-delta)}`, mv && mv.line != null ? { line: mv.line } : undefined);
        return null;
      }
      row.qty = qty;
      row.updatedAt = this.now;
      if (delta > 0) row.lastIn = this.now;
      const k = balanceKey(row);
      if (qty === 0) this.put('balances', k, null);
      else this.put('balances', k, row);
      this.moveN += 1;
      const m = {
        id: `${this.seq}.${this.moveN}`, seq: this.seq, at: this.now, date: (mv && mv.date) || this.date,
        docType: (mv && mv.docType) || '', docNo: (mv && mv.docNo) || '', line: mv && mv.line != null ? mv.line : '',
        code: row.code, wh: row.wh, bin: row.bin, status: row.status, lot: row.lot, qty: util.round(delta), balanceAfter: qty,
        job: (mv && mv.job) || '', by: this.userId, reversalOf: (mv && mv.reversalOf) || '', remark: (mv && mv.remark) || '',
      };
      this.put('movements', m.id, m);
      return m;
    }
  }
  function balanceKey(loc) {
    return [loc.code, loc.wh, loc.bin || '', loc.status || STATUS.AVAILABLE, loc.lot || ''].join('|');
  }
  RRS.balanceKey = balanceKey;

  /**
   * Validate a command and build its commit. Returns
   *   {ok:true, commit, warnings, result}           – apply with reduce()
   *   {ok:true, duplicate:true, seq}                – this request id was applied before: nothing to do
   *   {ok:false, errors:[{code, message, line?, field?}]}
   * ctx: {now: ISO time, user: user id, via?: account id, mode?: 'sandbox'|'shared'|'local'}
   */
  function prepare(state, command, ctx) {
    const def = command && util.own(commands, command.kind);
    if (!def) return { ok: false, errors: [err('UNKNOWN_COMMAND', `ไม่รู้จักคำสั่ง ${command && command.kind}`)] };
    const payload = command.payload || {};
    const payloadHash = util.sha256(util.stable({ kind: command.kind, payload }));
    if (command.requestId) {
      if (util.badKey(command.requestId)) return { ok: false, errors: [err('BAD_REQUEST_ID', 'รหัสคำขอนี้ใช้ไม่ได้')] };
      const seen = util.own(state.requests, command.requestId);
      if (seen) {
        if (seen.payloadHash === payloadHash) return { ok: true, duplicate: true, seq: seen.seq };
        return { ok: false, errors: [err('REQUEST_REUSED', 'รหัสคำขอนี้เคยใช้กับข้อมูลอื่นแล้ว – สร้างคำขอใหม่')] };
      }
    }
    if (!ctx || !ctx.now) return { ok: false, errors: [err('NO_TIME', 'ไม่มีเวลาของคำสั่ง')] };
    const tx = new Tx(state, ctx, command.kind);
    const users = state.tables.users || {};
    const hasUsers = Object.keys(users).length > 0;
    const open = (def.bootstrap && !hasUsers) || def.public;
    if (!open) {
      if (!tx.user) return { ok: false, errors: [err('NO_USER', 'ไม่พบผู้ใช้นี้ในระบบ – ให้ผู้ดูแลเพิ่มผู้ใช้ก่อน')] };
      if (tx.user.active === false) return { ok: false, errors: [err('USER_INACTIVE', 'ผู้ใช้นี้ถูกปิดการใช้งาน')] };
    }
    const perm = typeof def.perm === 'function' ? def.perm(tx, payload) : def.perm;
    if (perm && !open && !tx.need(perm)) return { ok: false, errors: tx.errors };
    try {
      def.prepare(tx, payload);
    } catch (e) {
      return { ok: false, errors: [err('INTERNAL', 'ระบบทำคำสั่งไม่สำเร็จ: ' + (e && e.message))] };
    }
    if (!tx.ok) return { ok: false, errors: tx.errors, warnings: tx.warnings };
    const effects = tx.order.map(([t, k]) => ({ t, k, v: tx.pending[t][k] }));
    effects.push({ t: 'audit', k: String(tx.seq), v: { seq: tx.seq, at: ctx.now, by: ctx.user || '', via: ctx.via || '',
      kind: command.kind, summary: tx.summary || def.label || command.kind, request: command.requestId || '' } });
    const commit = { seq: tx.seq, id: command.requestId || '', kind: command.kind, at: ctx.now, by: ctx.user || '',
      via: ctx.via || '', summary: tx.summary || def.label || command.kind, payloadHash, effects, prev: state.head };
    commit.hash = commitHash(commit);
    return { ok: true, commit, warnings: tx.warnings, result: tx.result };
  }

  // ---------------------------------------------------------------------------------------------------------
  // queries on a state (read only)
  // ---------------------------------------------------------------------------------------------------------
  const q = {};
  q.rows = (state, t, filter) => {
    const out = Object.values(state.tables[t] || {});
    return filter ? out.filter(filter) : out;
  };
  q.get = (state, t, k) => util.own(state.tables[t] || {}, k) || null;
  /** Item by its code, Express code or stock-count code. */
  q.item = function item(state, code) {
    const k = util.ckey(code);
    if (!k) return null;
    const items = state.tables.items || {};
    const direct = util.own(items, util.normCode(code));
    if (direct) return direct;
    for (const id in items) {
      const it = items[id];
      if (util.ckey(it.id) === k || util.ckey(it.expressCode) === k || util.ckey(it.countCode) === k) return it;
    }
    return null;
  };
  /** Sum of balances matching {code, wh, bin, status, lot} (missing fields = any). */
  q.qty = function qty(state, f) {
    let s = 0;
    const b = state.tables.balances || {};
    for (const k in b) {
      const r = b[k];
      if (f.code && r.code !== f.code) continue;
      if (f.wh && r.wh !== f.wh) continue;
      if (f.bin != null && f.bin !== undefined && f.bin !== '*' && r.bin !== f.bin) continue;
      if (f.status && r.status !== f.status) continue;
      if (f.lot != null && f.lot !== '*' && r.lot !== f.lot) continue;
      s += r.qty;
    }
    return util.round(s);
  };
  RRS.q = q;

  // Tx gets the same helpers over its overlay view
  Tx.prototype.item = function (code) {
    const k = util.ckey(code);
    if (!k) return null;
    const direct = this.get('items', util.normCode(code));
    if (direct) return direct;
    return this.all('items').find((it) => util.ckey(it.id) === k || util.ckey(it.expressCode) === k || util.ckey(it.countCode) === k) || null;
  };
  Tx.prototype.qty = function (f) {
    let s = 0;
    for (const r of this.all('balances')) {
      if (f.code && r.code !== f.code) continue;
      if (f.wh && r.wh !== f.wh) continue;
      if (f.bin != null && f.bin !== '*' && r.bin !== f.bin) continue;
      if (f.status && r.status !== f.status) continue;
      if (f.lot != null && f.lot !== '*' && r.lot !== f.lot) continue;
      s += r.qty;
    }
    return util.round(s);
  };

  RRS.defaultSettings = function defaultSettings() {
    return {
      company: '',
      pilot: { groups: [], warehouses: [], note: '' },
      ownership: { qty: 'RRS', cost: 'Express', accountingDocs: 'Express', qc: 'RRS' },
      cutoffAt: '',
      policies: {
        negativeStock: 'block', // block | approve (an approved exception per document)
        sod: true, // the maker cannot approve their own count, PR, QC release, NCR
        overReceivePct: 0, // receive more than the PO line without approval up to this %
        recountPct: 2, // count difference over this % of the system qty -> recount
        recountQty: 1, // ... or over this many units
        countMode: 'timestamp', // timestamp: adjust by the difference at count time | freeze: block movements
        lateIsUncertain: true, // late PO lines are left out of the 'sure' incoming
        nonMovingDays: 90,
      },
      express: { defaultWarehouse: '01' },
    };
  };

  RRS.core = { createState, reduce, prepare, verifyCommit, commitHash, Tx, err, GENESIS, tableOf };
})(typeof globalThis !== 'undefined' ? globalThis : this);
