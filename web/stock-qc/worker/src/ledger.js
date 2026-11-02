// Server ledger: the Worker is the only writer of commits (BACKEND_DESIGN.md "Writing").
//
//   cache    module-level {state, seq, head} of this isolate (seq/head are read from the state)
//   catchUp  applies commits newer than the cache from sq_commits, verifying every hash (RRS.core.verifyCommit);
//            a cold isolate starts from the newest usable snapshot (sq_snapshots row → R2 object) and the commits after it
//   execute  catch up → RRS.core.prepare → ONE D1 batch: INSERT the commit (only if it follows the newest stored commit)
//            + upsert/delete sq_records from its effects. Losing the race (seq/hash/request id already taken) means someone
//            committed first: catch up and prepare again (≤ 5 times). The same request id prepared again answers
//            {ok:true, duplicate:true} – the same request is applied once.
//   snapshot every SQ_SNAPSHOT_EVERY (500) commits the state goes to R2 + sq_snapshots; a failed snapshot never fails
//            the command.
//   records  sq_records is only a readable copy: checkRecords() replays every commit from genesis (hash and chain
//            checked) and compares, and with repair rewrites the rows that differ (POST /api/admin/records).
// The same guarantees as Sales Office's workspace revision/token CAS (lib/rrs/server.ts commit()).
import './engine-imports.js';
import { db, bucket, str, HttpError, redactForLog } from './runtime.js';
import { digest, byteLength, formatBytes, securityEvent, apiRateLimit } from './security.js';

const RRS = globalThis.RRS;
const { core, util } = RRS;

export const READ_CHUNK = 100; // commits per D1 query
export const PAGE_COMMITS = 500; // GET /api/commits: at most this many commits …
export const PAGE_BYTES = 4 * 1024 * 1024; // … and about this many bytes per page
export const MAX_ATTEMPTS = 5;
export const MAX_COMMIT_BYTES = 1800000; // one D1 row holds at most 2 MB
export const MAX_COMMAND_BYTES = 2 * 1024 * 1024;
export const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,100}$/;
/** Request ids the server's own jobs use (the Sales Office connector: so.<workspace>.<sha256 of the command id>). */
export const SERVER_REQUEST_PREFIX = 'so.';
/** Public engine commands (user.requestAccess) run by an account without an engine user: this many per hour. */
export const PUBLIC_PER_HOUR = 10;
const protoName = (v) => Object.prototype.hasOwnProperty.call(Object.prototype, String(v));
const KIND_RE = /^[a-z][A-Za-z0-9_.-]{0,63}$/;
const SNAPSHOT_FORMAT = 'rrs-stockqc-snapshot';
export const COLUMNS = 'seq,request_id,kind,at,"by",via,summary,payload_hash,prev,hash,effects';

const cache = {
  state: null,
  source: '',
  get seq() {
    return this.state ? this.state.seq : 0;
  },
  get head() {
    return this.state ? this.state.head : core.GENESIS;
  },
};

export function snapshotEvery(env) {
  const n = Number.parseInt(str(env, 'SQ_SNAPSHOT_EVERY'), 10);
  return Number.isFinite(n) && n >= 1 ? n : 500;
}

export function rowToCommit(r) {
  return { seq: Number(r.seq), id: r.request_id || '', kind: r.kind, at: r.at, by: r.by, via: r.via, summary: r.summary,
    payloadHash: r.payload_hash, effects: JSON.parse(r.effects), prev: r.prev, hash: r.hash };
}
/** Commit as JSON text without parsing its effects again (they are stored as JSON). */
export function commitJson(r) {
  const head = JSON.stringify({ seq: Number(r.seq), id: r.request_id || '', kind: r.kind, at: r.at, by: r.by, via: r.via,
    summary: r.summary, payloadHash: r.payload_hash, prev: r.prev, hash: r.hash });
  return head.slice(0, -1) + ',"effects":' + r.effects + '}';
}
async function readRows(env, after, limit) {
  const res = await db(env).prepare(`SELECT ${COLUMNS} FROM sq_commits WHERE seq > ? ORDER BY seq LIMIT ?`).bind(after, limit).all();
  return res.results || [];
}

function integrityError(seq) {
  return new HttpError(500, `ข้อมูล commit ${seq} ไม่ตรงลายนิ้วมือหรือไม่ต่อเนื่อง – หยุดบันทึกเพื่อป้องกันข้อมูลเสียหาย แจ้งผู้ดูแลระบบ`,
    { code: 'LEDGER_INTEGRITY', errors: [{ code: 'LEDGER_INTEGRITY', message: `ข้อมูล commit ${seq} ไม่ตรงลายนิ้วมือ` }] });
}
/** Applies every stored commit newer than state.seq (verifying each hash). Returns how many were applied. */
async function applyNewCommits(env, state) {
  let n = 0;
  for (;;) {
    const rows = await readRows(env, state.seq, READ_CHUNK);
    // Synchronous from here: no other request can change `state` while these rows are applied.
    for (const r of rows) {
      const seq = Number(r.seq);
      if (seq <= state.seq) continue;
      const c = rowToCommit(r);
      if (!core.verifyCommit(c)) throw integrityError(seq);
      try {
        core.reduce(state, c);
      } catch (e) {
        throw integrityError(seq);
      }
      n += 1;
    }
    if (rows.length < READ_CHUNK) return n;
  }
}

async function readSnapshot(env, row) {
  const obj = await bucket(env).get(row.r2_key);
  if (!obj) throw new Error('ไม่พบไฟล์ snapshot ใน R2');
  const text = await obj.text();
  if ((await digest(text)) !== row.sha256) throw new Error('ลายนิ้วมือไฟล์ snapshot ไม่ตรง');
  const body = JSON.parse(text);
  const st = body && body.state;
  if (!body || body.format !== SNAPSHOT_FORMAT || !st || !st.tables || !st.requests || Number(st.seq) !== Number(row.seq) || st.head !== row.hash) {
    throw new Error('รูปแบบ snapshot ไม่ถูกต้อง');
  }
  const c = await db(env).prepare('SELECT hash FROM sq_commits WHERE seq=?').bind(Number(row.seq)).first();
  if (!c || c.hash !== row.hash) throw new Error('snapshot ไม่ตรงกับ commit ที่บันทึกไว้');
  st.seq = Number(st.seq);
  return st;
}

/**
 * State rebuilt from D1/R2 (no cache): the newest snapshot that checks out (R2 bytes = sha256 in D1, head = the stored
 * commit hash at that seq), else the genesis state, then every commit after it with hash checks.
 * → {state, source: 'snapshot' | 'genesis', snapshotSeq}
 */
export async function loadState(env) {
  let state = null;
  let source = 'genesis';
  let snapshotSeq = 0;
  const snaps = (await db(env).prepare('SELECT seq,r2_key,hash,sha256 FROM sq_snapshots ORDER BY seq DESC LIMIT 3').all()).results || [];
  for (const row of snaps) {
    if (!env.BUCKET) break;
    try {
      state = await readSnapshot(env, row);
      source = 'snapshot';
      snapshotSeq = Number(row.seq);
      break;
    } catch (e) {
      await securityEvent(env, null, 'snapshot_unusable', 'warning', `seq ${row.seq}: ${String((e && e.message) || e).slice(0, 200)}`);
    }
  }
  if (!state) state = core.createState();
  await applyNewCommits(env, state);
  return { state, source, snapshotSeq };
}

/** Brings this isolate's cache up to the newest stored commit and returns the state to prepare against. */
export async function catchUp(env) {
  try {
    if (!cache.state) {
      const loaded = await loadState(env);
      // Two cold requests may load at the same time: keep the newer state.
      if (!cache.state || cache.state.seq < loaded.state.seq) {
        cache.state = loaded.state;
        cache.source = loaded.source;
      }
    }
    const state = cache.state;
    await applyNewCommits(env, state);
    return state;
  } catch (e) {
    if (e instanceof HttpError && e.extra && e.extra.code === 'LEDGER_INTEGRITY') {
      cache.state = null;
      await securityEvent(env, null, 'ledger_integrity', 'critical', e.message);
    }
    throw e;
  }
}

/** The engine `users` row bound to this login account (accountId === username), or null. */
export function engineUserFor(state, username) {
  const users = (state && state.tables.users) || {};
  for (const id in users) {
    const u = users[id];
    if (u && u.accountId && u.accountId === username) return u;
  }
  return null;
}
export function hasEngineUsers(state) {
  return Object.keys((state && state.tables.users) || {}).length > 0;
}
function noUser() {
  const message = 'บัญชีนี้ยังไม่มีสิทธิ์ในระบบสต็อก – ให้ผู้ดูแลระบบเพิ่มผู้ใช้และผูกบัญชีนี้ในหน้า ผู้ใช้และสิทธิ์';
  return new HttpError(403, message, { code: 'NO_USER', errors: [{ code: 'NO_USER', message }] });
}
function inactiveUser() {
  const message = 'ผู้ใช้นี้ถูกปิดการใช้งานในระบบสต็อก';
  return new HttpError(403, message, { code: 'USER_INACTIVE', errors: [{ code: 'USER_INACTIVE', message }] });
}
/**
 * Who runs the command: the engine user bound to the session, the owner starting an empty system, or – for a command
 * the engine marks public (user.requestAccess: "ask for access") – the account itself with no engine user. The account
 * is always the session's (it becomes ctx.via); nothing in the request can name another user.
 */
function actorFor(state, session, command) {
  const user = engineUserFor(state, session.username);
  if (user) {
    if (user.active === false) throw inactiveUser();
    return { userId: user.id, bootstrap: false };
  }
  if (command.kind === 'system.bootstrap' && session.owner && !hasEngineUsers(state)) {
    return { userId: util.normCode(command.payload.userId || 'ADMIN'), bootstrap: true };
  }
  const def = Object.prototype.hasOwnProperty.call(RRS.commands.defs, command.kind) ? RRS.commands.defs[command.kind] : null;
  if (def && def.public === true) return { userId: '', bootstrap: false, anonymous: true };
  throw noUser();
}
/** Readers (commits, files): the owner, or an active engine user. */
export function requireReader(state, session) {
  if (session.owner) return engineUserFor(state, session.username);
  const user = engineUserFor(state, session.username);
  if (!user) throw noUser();
  if (user.active === false) throw inactiveUser();
  return user;
}

/** opts.server: the server's own job (the Sales Office connector) – only it may use SERVER_REQUEST_PREFIX ids. */
export function normalizeCommand(input, opts) {
  const kind = typeof input.kind === 'string' ? input.kind : '';
  if (!KIND_RE.test(kind)) throw new HttpError(400, 'คำสั่ง (kind) ไม่ถูกต้อง');
  const payload = input.payload === undefined || input.payload === null ? {} : input.payload;
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, 'payload ต้องเป็น JSON object');
  const requestId = input.requestId;
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId) || protoName(requestId)) {
    throw new HttpError(400, 'ต้องมีรหัสคำขอ (requestId) ยาว 8–100 ตัว ใช้ A-Z a-z 0-9 . _ : -');
  }
  // A page that took a connector request id first would make that Sales Office command REQUEST_REUSED for ever.
  if (!(opts && opts.server) && requestId.startsWith(SERVER_REQUEST_PREFIX)) {
    throw new HttpError(400, `รหัสคำขอที่ขึ้นต้นด้วย ${SERVER_REQUEST_PREFIX} สงวนไว้สำหรับตัวเชื่อม Sales Office`);
  }
  return { kind, payload, requestId };
}

const INTERNAL_MESSAGE = 'ระบบทำคำสั่งนี้กับข้อมูลที่ส่งมาไม่ได้ – ตรวจรูปแบบข้อมูลแล้วลองใหม่ หากยังไม่ได้ให้แจ้งผู้ดูแลระบบ (รหัส INTERNAL)';
/**
 * The engine reports an exception inside a command as {code:'INTERNAL', message:'…: ' + e.message}: JavaScript text
 * ("(p.roles || []).filter is not a function") that tells a caller how the code is written. The page gets a Thai
 * message instead; the original goes to the Worker log (kind and engine text only – never the payload).
 */
function sanitizeEngineErrors(r, kind) {
  if (!r || r.ok || !Array.isArray(r.errors) || !r.errors.some((e) => e && e.code === 'INTERNAL')) return r;
  for (const e of r.errors) if (e && e.code === 'INTERNAL') console.error('stock-qc: engine exception', kind, redactForLog(e.message, 200));
  return Object.assign({}, r, { errors: r.errors.map((e) => (e && e.code === 'INTERNAL' ? { code: 'INTERNAL', message: INTERNAL_MESSAGE } : e)) });
}
/**
 * A row key or table name that is an Object.prototype name ('__proto__', 'constructor', …) is refused: assigning
 * state.tables[t]['__proto__'] swaps the table's prototype (the live isolate and a snapshot or replay then disagree),
 * and such keys only come from a lookup that found Object.prototype instead of a row.
 */
function badKeyEffect(commit) {
  return commit.effects.find((e) => !e || protoName(e.t) || protoName(e.k)) || null;
}

const INSERT_COMMIT = `INSERT INTO sq_commits (seq,request_id,kind,at,"by",via,summary,payload_hash,prev,hash,effects)
  SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11
  WHERE COALESCE((SELECT MAX(seq) FROM sq_commits), 0) = ?1 - 1
    AND COALESCE((SELECT hash FROM sq_commits WHERE seq = ?1 - 1), ?12) = ?9`;
// Rows are taken from the commit just inserted (same seq AND hash): when the insert did not happen they change nothing.
const UPSERT_RECORDS = `INSERT INTO sq_records (tbl,id,data,seq)
  SELECT json_extract(e.value,'$.t'), json_extract(e.value,'$.k'), e.value -> '$.v', c.seq
  FROM sq_commits AS c, json_each(c.effects) AS e
  WHERE c.seq = ?1 AND c.hash = ?2 AND json_type(e.value,'$.v') <> 'null'
  ON CONFLICT (tbl,id) DO UPDATE SET data = excluded.data, seq = excluded.seq`;
const DELETE_RECORDS = `DELETE FROM sq_records WHERE (tbl,id) IN (
  SELECT json_extract(e.value,'$.t'), json_extract(e.value,'$.k')
  FROM sq_commits AS c, json_each(c.effects) AS e
  WHERE c.seq = ?1 AND c.hash = ?2 AND json_type(e.value,'$.v') = 'null')`;

/** One atomic batch. → {ok:true} | {conflict:true} (someone else's commit got this seq, or the request id is taken). */
async function append(env, commit, effectsText) {
  const d = db(env);
  const statements = [
    d.prepare(INSERT_COMMIT).bind(commit.seq, commit.id || null, commit.kind, commit.at, commit.by, commit.via, commit.summary,
      commit.payloadHash, commit.prev, commit.hash, effectsText, core.GENESIS),
    d.prepare(UPSERT_RECORDS).bind(commit.seq, commit.hash),
    d.prepare(DELETE_RECORDS).bind(commit.seq, commit.hash),
  ];
  try {
    const res = await d.batch(statements);
    return res[0].meta.changes === 1 ? { ok: true } : { conflict: true };
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(m)) return { conflict: true, requestId: /request_id/.test(m) };
    throw e;
  }
}

async function writeSnapshot(env, state) {
  const seq = state.seq;
  const head = state.head;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify({ format: SNAPSHOT_FORMAT, version: 1, at: new Date().toISOString(), state }));
    const sha = await digest(bytes);
    const key = `stockqc/snapshots/${String(seq).padStart(10, '0')}-${head.slice(0, 16)}.json`;
    await bucket(env).put(key, bytes, { sha256: sha, httpMetadata: { contentType: 'application/json' }, customMetadata: { seq: String(seq), head } });
    await db(env).prepare('INSERT OR IGNORE INTO sq_snapshots (seq,r2_key,hash,sha256,size,created_at) VALUES (?,?,?,?,?,?)')
      .bind(seq, key, head, sha, bytes.length, new Date().toISOString()).run();
  } catch (e) {
    await securityEvent(env, null, 'snapshot_failed', 'warning', `seq ${seq}: ${String((e && e.message) || e).slice(0, 200)}`);
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST /api/command body → the engine's result: {ok, commit, warnings, result} | {ok:true, duplicate:true, seq} |
 * {ok:false, errors}. session: {username, owner}. The client never says who it is or what time it is.
 * opts.via: the commit's `via` instead of the session username – only the server's own jobs set it (the Sales Office
 * connector runs as the owner account's engine user with via 'sales-bridge:<workspace>').
 */
export async function execute(env, input, session, opts) {
  const server = !!(opts && opts.via);
  const command = normalizeCommand(input, { server });
  let limited = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const state = await catchUp(env);
    const actor = actorFor(state, session, command);
    if (actor.anonymous && !limited) {
      // an account with credentials but no engine user may only ask for access, and only this often
      await apiRateLimit(env, (opts && opts.req) || null, 'public-command', session.username, PUBLIC_PER_HOUR, 60 * 60 * 1000);
      limited = true;
      continue; // the rate-limit write awaited: prepare on a state caught up again
    }
    const payload = actor.bootstrap ? Object.assign({}, command.payload, { accountId: session.username }) : command.payload;
    const r = core.prepare(state, { kind: command.kind, payload, requestId: command.requestId },
      { now: new Date().toISOString(), user: actor.userId, via: (opts && opts.via) || session.username });
    if (!r.ok || r.duplicate) return sanitizeEngineErrors(r, command.kind);
    const bad = badKeyEffect(r.commit);
    if (bad) {
      const message = 'รายการนี้มีรหัสที่ระบบใช้เป็นคีย์ข้อมูลไม่ได้ – ไม่บันทึก (ตรวจชื่อบัญชีหรือรหัสที่กรอก)';
      await securityEvent(env, (opts && opts.req) || null, 'bad_row_key', 'warning', `${command.kind} ${String(bad && bad.t).slice(0, 40)}`);
      return { ok: false, errors: [{ code: 'BAD_KEY', message }] };
    }
    const effectsText = JSON.stringify(r.commit.effects);
    const size = byteLength(effectsText);
    if (size > MAX_COMMIT_BYTES) {
      return { ok: false, errors: [{ code: 'TOO_LARGE', message: `รายการนี้ใหญ่เกินไป (${formatBytes(size)}) – แบ่งเป็นหลายเอกสาร` }] };
    }
    const ap = await append(env, r.commit, effectsText);
    if (ap.ok) {
      const live = cache.state;
      if (live && live.seq === r.commit.seq - 1 && live.head === r.commit.prev) core.reduce(live, r.commit);
      const every = snapshotEvery(env);
      if (r.commit.seq % every === 0) {
        if (live && live.seq === r.commit.seq) await writeSnapshot(env, live);
        else {
          const fresh = await catchUp(env);
          if (fresh.seq === r.commit.seq) await writeSnapshot(env, fresh);
        }
      }
      return r;
    }
    // Lost the race: another commit took this seq (or this request id was just stored). Catch up and prepare again –
    // the engine then answers duplicate for the same request, or validates against the new stock.
    await pause(Math.floor(Math.random() * 15 * attempt));
  }
  const message = 'มีผู้บันทึกพร้อมกันหลายรายการ – ลองอีกครั้ง';
  throw new HttpError(503, message, { code: 'BUSY', errors: [{ code: 'BUSY', message }] });
}

/**
 * GET /api/commits?after=N → JSON text {commits, more}: commits with seq > after in order, at most PAGE_COMMITS and about
 * PAGE_BYTES per page (always at least one commit when there is one).
 */
export async function commitsPage(env, after) {
  const parts = [];
  let bytes = 0;
  let more = false;
  let from = after;
  outer: for (;;) {
    const rows = await readRows(env, from, READ_CHUNK);
    for (const r of rows) {
      const text = commitJson(r);
      const size = byteLength(text) + 1;
      if (parts.length && (parts.length >= PAGE_COMMITS || bytes + size > PAGE_BYTES)) {
        more = true;
        break outer;
      }
      parts.push(text);
      bytes += size;
      from = Number(r.seq);
    }
    if (rows.length < READ_CHUNK) break;
  }
  return `{"commits":[${parts.join(',')}],"more":${more}}`;
}

/** Fingerprint of a state (tests and checks): the same commits always give the same value. */
export function stateFingerprint(state) {
  return util.sha256(util.stable({ seq: state.seq, head: state.head, tables: state.tables, requests: state.requests }));
}

// ---- sq_records: check against the commits, repair -------------------------------------------------------------------
const RECORD_PAGE = 500;
const REPAIR_BATCH = 100;
const SAMPLE_MAX = 20;
const recordKey = (t, k) => `${t}\u0000${k}`;

/**
 * sq_records is a readable copy written in the same D1 batch as each commit. checkRecords() proves it: every commit is
 * replayed from genesis (hash + chain checked like a cold start), the expected row and the seq of the last commit
 * that wrote it are compared with sq_records. opts.repair: the rows that differ are rewritten from the replay (missing
 * → inserted, different → replaced, a row no commit wrote → deleted), in batches guarded by "the newest commit is still
 * the one replayed" – a commit landing meanwhile writes its own rows and the repair stops with CHANGED (run it again).
 * → {ok, clean, head, rows, expected, missing, different, extra, repaired, samples:[{table, key, problem}], code?}
 */
export async function checkRecords(env, opts) {
  const repair = !!(opts && opts.repair);
  const state = core.createState();
  const lastSeq = new Map();
  for (;;) {
    const rows = await readRows(env, state.seq, READ_CHUNK);
    for (const r of rows) {
      const c = rowToCommit(r);
      if (!core.verifyCommit(c)) throw integrityError(c.seq);
      try {
        core.reduce(state, c);
      } catch (e) {
        throw integrityError(c.seq);
      }
      for (const e of c.effects) lastSeq.set(recordKey(e.t, e.k), c.seq);
    }
    if (rows.length < READ_CHUNK) break;
  }
  const head = state.seq;
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const expectedRow = (t, k) => (has(state.tables, t) && has(state.tables[t], k) ? state.tables[t][k] : undefined);
  const out = { ok: true, clean: true, head, rows: 0, expected: 0, missing: 0, different: 0, extra: 0, repaired: 0, samples: [] };
  const fixes = [];
  const note = (t, k, problem) => {
    out[problem] += 1;
    if (out.samples.length < SAMPLE_MAX) out.samples.push({ table: t, key: String(k).slice(0, 120), problem });
  };
  const seen = new Set();
  let after = ['', ''];
  for (;;) {
    const page = (await db(env).prepare('SELECT tbl,id,data,seq FROM sq_records WHERE (tbl,id) > (?,?) ORDER BY tbl,id LIMIT ?')
      .bind(after[0], after[1], RECORD_PAGE).all()).results || [];
    for (const r of page) {
      out.rows += 1;
      const key = recordKey(r.tbl, r.id);
      seen.add(key);
      const want = expectedRow(r.tbl, r.id);
      if (want === undefined || want === null) {
        note(r.tbl, r.id, 'extra');
        fixes.push({ del: true, t: r.tbl, k: r.id });
        continue;
      }
      let same = false;
      try {
        same = util.stable(JSON.parse(r.data)) === util.stable(want) && Number(r.seq) === lastSeq.get(key);
      } catch (e) {
        same = false;
      }
      if (!same) {
        note(r.tbl, r.id, 'different');
        fixes.push({ t: r.tbl, k: r.id, v: want, seq: lastSeq.get(key) || head });
      }
    }
    if (page.length < RECORD_PAGE) break;
    after = [page[page.length - 1].tbl, page[page.length - 1].id];
  }
  for (const t of Object.keys(state.tables)) {
    for (const k of Object.keys(state.tables[t])) {
      const v = state.tables[t][k];
      if (v === undefined || v === null) continue;
      out.expected += 1;
      if (!seen.has(recordKey(t, k))) {
        note(t, k, 'missing');
        fixes.push({ t, k, v, seq: lastSeq.get(recordKey(t, k)) || head });
      }
    }
  }
  out.clean = !fixes.length;
  if (!repair || !fixes.length) return out;
  const d = db(env);
  const GUARD = 'COALESCE((SELECT MAX(seq) FROM sq_commits), 0) = ?';
  for (let i = 0; i < fixes.length; i += REPAIR_BATCH) {
    const part = fixes.slice(i, i + REPAIR_BATCH);
    const res = await d.batch(part.map((f) => (f.del
      ? d.prepare(`DELETE FROM sq_records WHERE tbl=? AND id=? AND ${GUARD}`).bind(f.t, String(f.k), head)
      : d.prepare(`INSERT INTO sq_records (tbl,id,data,seq) SELECT ?,?,?,? WHERE ${GUARD}
          ON CONFLICT (tbl,id) DO UPDATE SET data = excluded.data, seq = excluded.seq`).bind(f.t, String(f.k), JSON.stringify(f.v), f.seq, head))));
    const done = res.filter((x) => x.meta.changes === 1).length;
    out.repaired += done;
    if (done !== part.length) {
      return Object.assign(out, { ok: false, code: 'CHANGED', message: 'มีรายการใหม่บันทึกระหว่างซ่อม – สั่งตรวจ/ซ่อมอีกครั้ง' });
    }
  }
  await securityEvent(env, null, 'records_repaired', 'warning', `head ${head}: missing ${out.missing}, different ${out.different}, extra ${out.extra}`);
  out.clean = true;
  return out;
}
