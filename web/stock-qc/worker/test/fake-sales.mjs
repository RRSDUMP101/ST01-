// A local fake of Sales Office's Part List bridge (branch codex/rrs-workflow-partlist-20261027,
// lib/rrs/partlist-bridge.ts + partlist-store.ts + operations-schema.ts) that enforces the same rules:
//   auth: X-RRS-Connector-Id + Bearer secret of the mode's workspace (401), bridge off → 503, https only;
//   GET: latest command per job (blocked ones left out), job_id > cursor, ≤ 50 per page and ≈ 1.5 MB, nextCursor;
//   POST: {events: 1..20} strict schema (400 for the whole request), validateStatus() (400: materialStatus 'ready' needs
//   every part reserved ≥ required and shortage 0, revisionApproved needs revisions + fingerprint + evidence, quantities
//   ≤ required, observedAt not in the future), then per event: workspace_mismatch, event_conflict (same id, other
//   content), unknown_job, blocked_command, stale_command, stale_status (sourceVersion not above the last, observedAt
//   going back), mapping_conflict (externalJobId changed / linked to another job).
import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const HEX64 = /^[a-f0-9]{64}$/;
class Bad extends Error {}
const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
const finiteNonNeg = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const knownQty = (v) => v === null || finiteNonNeg(v);
const salesDate = (v) => typeof v === 'string' && v.length <= 70 && (!v || Number.isFinite(Date.parse(v)));

/** The event as Sales Office's zod schema returns it (schema key order, unknown status keys dropped) – its hash input. */
function canonical(e) {
  const s = e.status;
  const parts = s.parts.map((p) => {
    const o = { partId: p.partId, required: p.required, reserved: p.reserved, shortage: p.shortage, unit: p.unit };
    if (p.completed !== undefined) o.completed = p.completed;
    if (p.stationDone !== undefined) o.stationDone = p.stationDone;
    return o;
  });
  return { eventId: e.eventId, commandId: e.commandId, commandVersion: e.commandVersion, payloadHash: e.payloadHash, workspace: e.workspace,
    orderId: e.orderId, productionJobId: e.productionJobId, status: { externalJobId: s.externalJobId, sourceVersion: s.sourceVersion,
      bomRevision: s.bomRevision, drawingRevision: s.drawingRevision, bomFingerprint: s.bomFingerprint, revisionApproved: s.revisionApproved,
      revisionEvidence: s.revisionEvidence, materialStatus: s.materialStatus, parts, station: s.station, good: s.good, scrap: s.scrap,
      rework: s.rework, blockers: s.blockers, eta: s.eta, observedAt: s.observedAt } };
}
function parseEvent(e) {
  const keys = ['eventId', 'commandId', 'commandVersion', 'payloadHash', 'workspace', 'orderId', 'productionJobId', 'status'];
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Bad('event');
  if (Object.keys(e).some((k) => !keys.includes(k)) || keys.some((k) => !(k in e))) throw new Bad('event keys (strict)');
  if (!isStr(e.eventId, 1, 500) || !isStr(e.commandId, 1, 500) || !isStr(e.orderId, 1, 500) || !isStr(e.productionJobId, 1, 500)) throw new Bad('ids');
  if (!Number.isInteger(e.commandVersion) || e.commandVersion < 1) throw new Bad('commandVersion');
  if (typeof e.payloadHash !== 'string' || !HEX64.test(e.payloadHash)) throw new Bad('payloadHash');
  if (e.workspace !== 'domestic' && e.workspace !== 'export') throw new Bad('workspace');
  const s = e.status;
  if (!s || typeof s !== 'object') throw new Bad('status');
  if (!isStr(s.externalJobId, 1, 500) || !Number.isInteger(s.sourceVersion) || s.sourceVersion < 1) throw new Bad('status ids');
  for (const k of ['bomRevision', 'drawingRevision']) if (!(s[k] === null || isStr(s[k], 0, 500))) throw new Bad(k);
  if (!(s.bomFingerprint === null || (typeof s.bomFingerprint === 'string' && HEX64.test(s.bomFingerprint)))) throw new Bad('bomFingerprint');
  if (typeof s.revisionApproved !== 'boolean' || !(s.revisionEvidence === null || isStr(s.revisionEvidence, 0, 30000))) throw new Bad('revision');
  if (!['unknown', 'ready', 'short'].includes(s.materialStatus)) throw new Bad('materialStatus');
  if (!Array.isArray(s.parts) || s.parts.length > 2000) throw new Bad('parts');
  for (const p of s.parts) {
    if (!p || !isStr(p.partId, 1, 500) || !finiteNonNeg(p.required) || !knownQty(p.reserved) || !knownQty(p.shortage) || !isStr(p.unit, 0, 500)) throw new Bad('part');
    if (p.completed !== undefined && !finiteNonNeg(p.completed)) throw new Bad('completed');
  }
  if (!(s.station === null || isStr(s.station, 0, 500)) || !knownQty(s.good) || !knownQty(s.scrap) || !knownQty(s.rework)) throw new Bad('counts');
  if (!Array.isArray(s.blockers) || s.blockers.length > 100 || !s.blockers.every((b) => isStr(b, 0, 500))) throw new Bad('blockers');
  if (!(s.eta === null || salesDate(s.eta)) || !salesDate(s.observedAt) || !s.observedAt) throw new Bad('dates');
  return e;
}
/** partlist-bridge.ts validateStatus(): any failure is a 400 for the whole request. */
function validateStatus(e) {
  const s = e.status;
  if (!Number.isFinite(Date.parse(s.observedAt)) || Date.parse(s.observedAt) > Date.now() + 300000) throw new Bad('observedAt');
  if (new Set(s.parts.map((p) => p.partId)).size !== s.parts.length) throw new Bad('duplicate partId');
  if (s.parts.some((p) => (p.reserved !== null && p.reserved > p.required) || (p.shortage !== null && p.shortage > p.required) || (p.completed != null && p.completed > p.required))) {
    throw new Bad('quantities above required');
  }
  if (s.revisionApproved && (!s.bomRevision || !s.drawingRevision || !s.bomFingerprint || !(s.revisionEvidence || '').trim())) throw new Bad('revision evidence');
  if (s.materialStatus === 'ready' && (!s.parts.length || s.parts.some((p) => p.reserved === null || p.reserved < p.required || p.shortage !== 0))) {
    throw new Bad('materialStatus ready without full reservation');
  }
}

export function fakeSales({ connectorId, secrets }) {
  const ws = () => ({ commands: new Map(), events: new Map(), jobs: new Map(), links: new Map(), lastPollAt: null });
  const f = { enabled: true, unavailable: false, postUnavailable: false, pageSize: 50, pageBytes: 1500000, log: [], badRequests: [], space: { domestic: ws(), export: ws() } };
  /** Adds the next version of a job's command, built like partlist-store.ts. → the command object as sent. */
  f.addCommand = (workspace, { productionJobId, orderId, payload, blocked }) => {
    const sp = f.space[workspace];
    const list = sp.commands.get(productionJobId) || [];
    const version = list.length ? list[list.length - 1].version + 1 : 1;
    const payloadHash = sha(JSON.stringify(payload));
    const commandId = 'pl:' + sha(JSON.stringify([workspace === 'export' ? 'live' : 'domestic', productionJobId, version, payloadHash]));
    const command = { schemaVersion: 1, commandId, workspace, orderId, productionJobId, version, type: 'upsert_draft', payloadHash, payload };
    list.push({ command, version, status: blocked ? 'blocked' : 'pending' });
    sp.commands.set(productionJobId, list);
    if (!sp.jobs.has(productionJobId)) sp.jobs.set(productionJobId, { orderId, bridge: null });
    return command;
  };
  /** Raw row (tests that make Sales Office misbehave: same id with another payload, a command of the other workspace …). */
  f.addRaw = (workspace, command) => {
    const sp = f.space[workspace];
    const list = sp.commands.get(command.productionJobId) || [];
    list.push({ command, version: command.version, status: 'pending' });
    sp.commands.set(command.productionJobId, list);
    if (!sp.jobs.has(command.productionJobId)) sp.jobs.set(command.productionJobId, { orderId: command.orderId, bridge: null });
  };
  const latest = (sp, jobId) => {
    const list = sp.commands.get(jobId) || [];
    return list.reduce((m, r) => (!m || r.version >= m.version ? r : m), null);
  };
  f.statusOf = (workspace, jobId) => {
    const j = f.space[workspace].jobs.get(jobId);
    return j && j.bridge ? j.bridge.status : null;
  };
  f.eventCount = (workspace) => f.space[workspace].events.size;

  function access(req, url) {
    if (!f.enabled || f.unavailable) return { error: json({ error: 'ตัวเชื่อม Part List ยังไม่เปิดใช้งาน', code: 503 }, 503) };
    const mode = url.searchParams.get('mode');
    if (mode !== 'domestic' && mode !== 'export') return { error: json({ error: 'ระบุพื้นที่ domestic หรือ export', code: 400 }, 400) };
    const secret = secrets[mode];
    if (!connectorId || !secret || secret.length < 32) return { error: json({ error: 'ยังไม่ได้ตั้งค่าตัวเชื่อม', code: 503 }, 503) };
    if (secrets.domestic && secrets.domestic === secrets.export) return { error: json({ error: 'ต้องใช้รหัสแยก', code: 503 }, 503) };
    const bearer = req.headers.get('authorization') || '';
    if (req.headers.get('x-rrs-connector-id') !== connectorId || !bearer.startsWith('Bearer ') || bearer.slice(7) !== secret) {
      return { error: json({ error: 'สิทธิ์ตัวเชื่อมไม่ถูกต้อง', code: 401 }, 401) };
    }
    if (url.protocol !== 'https:') return { error: json({ error: 'ตัวเชื่อมต้องใช้ HTTPS', code: 400 }, 400) };
    return { mode, sp: f.space[mode] };
  }
  function acceptEvent(mode, sp, e) {
    if (e.workspace !== mode) return 'workspace_mismatch';
    validateStatus(e);
    const hash = sha(JSON.stringify(canonical(e)));
    const seen = sp.events.get(e.eventId);
    if (seen) return seen.hash === hash ? null : 'event_conflict';
    const job = sp.jobs.get(e.productionJobId);
    const command = latest(sp, e.productionJobId);
    if (!job || job.orderId !== e.orderId) return 'unknown_job';
    if (command && command.status === 'blocked') return 'blocked_command';
    if (!command || command.command.commandId !== e.commandId || command.version !== e.commandVersion || command.command.payloadHash !== e.payloadHash) return 'stale_command';
    let prev = job.bridge ? job.bridge.status.sourceVersion : 0;
    for (const x of sp.events.values()) if (x.jobId === e.productionJobId) prev = Math.max(prev, x.sourceVersion);
    if (e.status.sourceVersion <= prev) return 'stale_status';
    if (job.bridge && Date.parse(e.status.observedAt) < Date.parse(job.bridge.status.observedAt)) return 'stale_status';
    if (job.bridge && job.bridge.status.externalJobId !== e.status.externalJobId) return 'mapping_conflict';
    const link = sp.links.get(e.status.externalJobId);
    if (link && link !== e.productionJobId) return 'mapping_conflict';
    sp.events.set(e.eventId, { hash, jobId: e.productionJobId, sourceVersion: e.status.sourceVersion });
    sp.links.set(e.status.externalJobId, e.productionJobId);
    job.bridge = { status: JSON.parse(JSON.stringify(canonical(e).status)), lastEventId: e.eventId, commandVersion: e.commandVersion };
    command.status = 'acknowledged';
    return null;
  }

  f.handle = async (req) => {
    const url = new URL(req.url);
    f.log.push({ method: req.method, path: url.pathname, mode: url.searchParams.get('mode'), cursor: url.searchParams.get('cursor') || '',
      auth: !!req.headers.get('authorization') });
    if (url.pathname !== '/api/rrs/partlist/bridge') return json({ error: 'not found' }, 404);
    const a = access(req, url);
    if (a.error) return a.error;
    const { mode, sp } = a;
    if (req.method === 'GET') {
      sp.lastPollAt = new Date().toISOString();
      const cursor = url.searchParams.get('cursor') || '';
      if (cursor.length > 500) return json({ error: 'cursor ไม่ถูกต้อง', code: 400 }, 400);
      const rows = [...sp.commands.keys()].sort().filter((id) => id > cursor).map((id) => latest(sp, id)).filter((r) => r && r.status !== 'blocked');
      const page = [];
      let bytes = 0;
      for (const r of rows.slice(0, f.pageSize)) {
        const size = Buffer.byteLength(JSON.stringify(r.command));
        if (page.length && bytes + size > f.pageBytes) break;
        page.push(r);
        bytes += size;
      }
      return json({ commands: page.map((r) => JSON.parse(JSON.stringify(r.command))), nextCursor: rows.length > page.length && page.length ? page[page.length - 1].command.productionJobId : null,
        serverTime: new Date().toISOString() });
    }
    if (req.method === 'POST') {
      if (f.postUnavailable) return json({ error: 'ระบบยังไม่พร้อม กรุณาลองซิงก์อีกครั้ง', code: 503 }, 503);
      const text = await req.text();
      if (Buffer.byteLength(text) > 1048576) return json({ error: 'ข้อมูลครั้งละไม่เกิน 1 MB', code: 413 }, 413);
      const accepted = [];
      const rejected = [];
      try {
        const body = JSON.parse(text);
        if (!body || typeof body !== 'object' || Object.keys(body).some((k) => k !== 'events') || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 20) {
          throw new Bad('events');
        }
        const events = body.events.map(parseEvent);
        for (const e of events) {
          const code = acceptEvent(mode, sp, e);
          if (code) rejected.push({ eventId: e.eventId, code });
          else accepted.push(e.eventId);
        }
      } catch (e) {
        if (e instanceof Bad || e instanceof SyntaxError) {
          f.badRequests.push(String(e.message));
          return json({ error: 'รูปแบบข้อมูลตัวเชื่อมไม่ถูกต้อง', code: 400 }, 400);
        }
        throw e;
      }
      return json({ accepted, rejected, serverTime: new Date().toISOString() });
    }
    return json({ error: 'method' }, 405);
  };
  return f;
}
