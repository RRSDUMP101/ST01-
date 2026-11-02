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
// The same guarantees as Sales Office's workspace revision/token CAS (lib/rrs/server.ts commit()).
import './engine-imports.js';
import { db, bucket, str, HttpError } from './runtime.js';
import { digest, byteLength, formatBytes, securityEvent } from './security.js';

const RRS = globalThis.RRS;
const { core, util } = RRS;

export const READ_CHUNK = 100; // commits per D1 query
export const PAGE_COMMITS = 500; // GET /api/commits: at most this many commits …
export const PAGE_BYTES = 4 * 1024 * 1024; // … and about this many bytes per page
export const MAX_ATTEMPTS = 5;
export const MAX_COMMIT_BYTES = 1800000; // one D1 row holds at most 2 MB
export const MAX_COMMAND_BYTES = 2 * 1024 * 1024;
export const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,100}$/;
const KIND_RE = /^[a-z][A-Za-z0-9_.-]{0,63}$/;
const SNAPSHOT_FORMAT = 'rrs-stockqc-snapshot';
const COLUMNS = 'seq,request_id,kind,at,"by",via,summary,payload_hash,prev,hash,effects';

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

function rowToCommit(r) {
  return { seq: Number(r.seq), id: r.request_id || '', kind: r.kind, at: r.at, by: r.by, via: r.via, summary: r.summary,
    payloadHash: r.payload_hash, effects: JSON.parse(r.effects), prev: r.prev, hash: r.hash };
}
/** Commit as JSON text without parsing its effects again (they are stored as JSON). */
function commitJson(r) {
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
/** Who runs the command: the engine user bound to the session, or the owner starting an empty system. */
function actorFor(state, session, command) {
  const user = engineUserFor(state, session.username);
  if (user) {
    if (user.active === false) throw inactiveUser();
    return { userId: user.id, bootstrap: false };
  }
  if (command.kind === 'system.bootstrap' && session.owner && !hasEngineUsers(state)) {
    return { userId: util.normCode(command.payload.userId || 'ADMIN'), bootstrap: true };
  }
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

export function normalizeCommand(input) {
  const kind = typeof input.kind === 'string' ? input.kind : '';
  if (!KIND_RE.test(kind)) throw new HttpError(400, 'คำสั่ง (kind) ไม่ถูกต้อง');
  const payload = input.payload === undefined || input.payload === null ? {} : input.payload;
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, 'payload ต้องเป็น JSON object');
  const requestId = input.requestId;
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    throw new HttpError(400, 'ต้องมีรหัสคำขอ (requestId) ยาว 8–100 ตัว ใช้ A-Z a-z 0-9 . _ : -');
  }
  return { kind, payload, requestId };
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
 */
export async function execute(env, input, session) {
  const command = normalizeCommand(input);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const state = await catchUp(env);
    const actor = actorFor(state, session, command);
    const payload = actor.bootstrap ? Object.assign({}, command.payload, { accountId: session.username }) : command.payload;
    const r = core.prepare(state, { kind: command.kind, payload, requestId: command.requestId },
      { now: new Date().toISOString(), user: actor.userId, via: session.username });
    if (!r.ok || r.duplicate) return r;
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
