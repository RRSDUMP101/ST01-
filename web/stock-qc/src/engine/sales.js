/*
 * Sales Office → stock-qc: production jobs from confirmed SOs (BACKEND_DESIGN.md "Sales Office connector").
 *
 * No new table: a job from Sales Office is a row of the Phase 2 `jobs` table (planning.js) with source 'sales' and the
 * Sales Office identity kept exactly as received:
 *   workspace ('domestic' | 'export'), orderId, orderNumber, productionJobId, customerId, dealId (IDs only – the
 *   customer name and the SO owner are never stored), salesCommandId, salesVersion, salesPayloadHash, salesItems (the SO
 *   lines as given, read-only, qty kept as text), salesRelease {allowed, blockers, drawingRevision, bomRevision,
 *   bomFingerprint}, cancelled.
 *   Job key (jobNo) = normCode('SO-' + workspace + '-' + productionJobId): stable, never derived from names; Domestic and
 *   Export never share a job even when the IDs look alike.
 *
 * Commands
 *   sales.syncJob  (perm job.manage) – one bridge command `upsert_draft` as Sales Office sends it. Accepted only from the
 *                  connector (ctx.via 'sales-bridge:<workspace>'): the Worker runs it as the engine user bound to the owner
 *                  account (ADMIN_USERNAME), so the audit shows that user + via sales-bridge. Version ≤ the job's version
 *                  is refused with OLDER_VERSION (nothing changes). cancelled → job CANCELLED and its open reservations
 *                  released (same fields as planning's release); a later version that is not cancelled reopens a job that
 *                  Sales Office cancelled (never one a planner cancelled).
 *   sales.mapJob   (perm job.manage) {jobKey, product, bomRev?, qty} – the planner picks the product, which must have an
 *                  APPROVED BOM, and confirms the number of sets. Lines = BOM × qty (like job.create). The SO lines are shown
 *                  to the planner; their quantity is never turned into a stock quantity by the engine.
 * Read helpers (RRS.sales): jobKeyFor, jobs, fingerprint, itemsHash, statusFor(state, jobKey, prevSourceVersion, {now})
 *   → the status object Sales Office's bridge validates (materialStatus 'ready' only when every line is covered in full
 *   and nothing is short; revisionApproved only from the APPROVED BOM; QC facts as counts, never approvals).
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const P = RRS && RRS.planning;
  if (!RRS || !P || !RRS.schema.tables.jobs) return; // needs planning.js (order.json: right after it)
  const { util, schema, commands } = RRS;
  const define = commands.define;
  const round = util.round;
  const pos0 = (n) => Math.max(0, round(n));
  const clone = util.clone;

  const WORKSPACES = { domestic: 'ในประเทศ (Domestic)', export: 'ต่างประเทศ (Export)' };
  const OPEN_JOB = { OPEN: true, IN_PROGRESS: true };
  const MAX_COMMAND_BYTES = 250000; // Sales Office holds a larger command back ('payload_too_large')
  const MAX_ITEMS = 500;
  const MAX_TEXT = 30000;
  const HEX64 = /^[a-f0-9]{64}$/;
  const JOB_ID_RE = /^[A-Za-z0-9._:@/-]{1,120}$/;
  const CTRL = /[\u0000-\u001f\u007f]/;
  const VIA_RE = /^sales-bridge:(domestic|export)$/;
  const MAX_BLOCKERS = 100;
  const MAX_BLOCKER_CHARS = 500;

  // Extra fields of a job that came from Sales Office (data dictionary; the table itself belongs to planning.js).
  const EXTRA_FIELDS = [
    ['source', 'text', 'ที่มาของใบงาน (sales = Sales Office)'], ['workspace', 'enum', 'พื้นที่ขาย', 'domestic/export'],
    ['orderId', 'text', 'รหัส SO ใน Sales Office'], ['orderNumber', 'text', 'เลขที่ SO ที่แสดง'],
    ['productionJobId', 'text', 'รหัสงานผลิตใน Sales Office'], ['customerId', 'text', 'รหัสลูกค้า (ไม่เก็บชื่อ)'],
    ['dealId', 'text', 'รหัสดีล'], ['vehicle', 'text', 'รุ่นรถตาม SO'], ['salesCommandId', 'text', 'รหัสคำสั่งล่าสุดที่รับ'],
    ['salesVersion', 'number', 'ฉบับคำสั่งล่าสุดที่รับ'], ['salesPayloadHash', 'text', 'ลายนิ้วมือข้อมูลคำสั่ง'],
    ['salesItems', 'json', 'รายการ SO ตามที่ได้รับ (อ่านอย่างเดียว) {lineId, description, qty, unit, productId}'],
    ['salesRelease', 'json', 'สิทธิ์เริ่มผลิตจาก Sales Office {allowed, blockers, drawingRevision, bomRevision, bomFingerprint}'],
    ['salesDue', 'text', 'วันกำหนดตาม SO (ตามที่ได้รับ)'], ['cancelled', 'bool', 'Sales Office ยกเลิก SO'],
    ['cancelledBySales', 'bool', 'ยกเลิกโดย Sales Office (เปิดใหม่ได้เมื่อ SO เปิดใหม่)'],
    ['salesChanged', 'bool', 'รายการ SO เปลี่ยนหลังผูก BOM (ต้องผูกใหม่)'], ['mappedItemsHash', 'text', 'ลายนิ้วมือรายการ SO ตอนผูก BOM'],
    ['mappedBy', 'text', 'ผู้ผูก BOM'], ['mappedAt', 'datetime', 'ผูก BOM เมื่อ'], ['salesReceivedAt', 'datetime', 'รับคำสั่งล่าสุดเมื่อ'],
  ];
  const jobsDef = schema.tables.jobs;
  for (const f of EXTRA_FIELDS) {
    if (!jobsDef.fields.some((x) => x.name === f[0])) jobsDef.fields.push({ name: f[0], type: f[1], label: f[2], note: f[3] || '' });
  }

  // ---- helpers ------------------------------------------------------------------------------------------------
  function jobKeyFor(workspace, productionJobId) {
    return util.normCode('SO-' + workspace + '-' + productionJobId);
  }
  const textOk = (v, max, empty) => typeof v === 'string' && v.length <= max && (empty || v.trim().length > 0);
  const idOk = (v, max) => textOk(v, max) && !CTRL.test(v);
  const optText = (v, max) => v === null || v === undefined || (typeof v === 'string' && v.length <= max);
  /** Fingerprint of the SO lines (detects a change after the planner mapped the job). */
  function itemsHash(items) {
    return util.sha256(util.stable(items || []));
  }
  /** Fingerprint of what the job will make: product, BOM rev, sets and the planned lines (not progress counters). */
  function fingerprint(job) {
    const lines = (job.lines || []).filter((l) => !l.output && !l.extra).map((l) => ({ code: l.code, per: l.per, required: l.required }));
    return util.sha256(util.stable({ product: job.product || '', bomRev: job.bomRev || '', qty: job.qty || 0, lines }));
  }
  /** Sales Office date → YYYY-MM-DD (Bangkok) or '' when missing/unreadable. */
  function dueDate(v) {
    const s = util.trim(v);
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const t = Date.parse(s);
      return isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? s : '';
    }
    return isFinite(Date.parse(s)) ? util.bkkDate(s) : '';
  }
  function addLog(job, tx, action, detail) {
    job.log = (job.log || []).concat([{ at: tx.now, by: tx.userId, action, detail: detail || '' }]);
  }
  function releaseOpen(tx, job, reason) {
    const out = [];
    const rs = tx.all('reservations', (r) => r.jobNo === job.jobNo && P.isOpen(r))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    for (const r of rs) {
      const left = P.remaining(r);
      out.push({ id: r.id, code: r.code, wh: r.wh, qty: left });
      tx.put('reservations', r.id, Object.assign(clone(r), { status: 'RELEASED', releasedBy: tx.userId, releasedAt: tx.now,
        reason, releasedQty: left }));
    }
    return out;
  }

  /** Checks one bridge command (never trusted: types, sizes, workspace, payload hash). → normalized command or null. */
  function readCommand(tx, p) {
    const bad = (field, msg) => tx.error('BAD_COMMAND', `คำสั่งจาก Sales Office ไม่ถูกต้อง: ${msg}`, { field }) && null;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return bad('payload', 'ไม่มีข้อมูลคำสั่ง');
    if (p.schemaVersion !== 1) return bad('schemaVersion', 'รองรับเฉพาะ schemaVersion 1');
    if (p.type !== 'upsert_draft') return bad('type', 'รองรับเฉพาะคำสั่ง upsert_draft');
    if (!WORKSPACES[p.workspace]) return bad('workspace', 'พื้นที่ต้องเป็น domestic หรือ export');
    const via = VIA_RE.exec(String(tx.ctx.via || ''));
    if (!via || via[1] !== p.workspace) return bad('workspace', `คำสั่งของพื้นที่ ${p.workspace} ต้องมาจากตัวเชื่อมของพื้นที่เดียวกัน`);
    if (!idOk(p.commandId, 500)) return bad('commandId', 'ไม่มีรหัสคำสั่ง');
    if (!idOk(p.orderId, 500)) return bad('orderId', 'ไม่มีรหัส SO');
    if (typeof p.productionJobId !== 'string' || !JOB_ID_RE.test(p.productionJobId)) {
      return bad('productionJobId', 'รหัสงานผลิตต้องเป็น A-Z a-z 0-9 . _ : @ / - ไม่เกิน 120 ตัว');
    }
    if (!Number.isSafeInteger(p.version) || p.version < 1) return bad('version', 'ฉบับคำสั่งต้องเป็นจำนวนเต็มตั้งแต่ 1');
    if (typeof p.payloadHash !== 'string' || !HEX64.test(p.payloadHash)) return bad('payloadHash', 'ลายนิ้วมือข้อมูลต้องเป็น SHA-256');
    const pl = p.payload;
    if (!pl || typeof pl !== 'object' || Array.isArray(pl)) return bad('payload', 'ไม่มีข้อมูล SO');
    const text = JSON.stringify(p);
    if (new TextEncoder().encode(text).length > MAX_COMMAND_BYTES) return bad('payload', 'ข้อมูลใหญ่เกิน 250,000 bytes');
    if (util.sha256(JSON.stringify(pl)) !== p.payloadHash) {
      return tx.error('PAYLOAD_HASH', 'ลายนิ้วมือข้อมูล SO ไม่ตรงกับข้อมูลที่ได้รับ – ไม่รับคำสั่งนี้', { field: 'payloadHash' }) && null;
    }
    if (!idOk(pl.orderNumber, 500)) return bad('orderNumber', 'ไม่มีเลขที่ SO');
    for (const f of ['customerId', 'dealId', 'customerName', 'vehicle', 'due', 'owner']) {
      if (!optText(pl[f], MAX_TEXT)) return bad(f, `${f} ต้องเป็นข้อความ`);
    }
    if (!Array.isArray(pl.items) || pl.items.length < 1 || pl.items.length > MAX_ITEMS) return bad('items', `รายการ SO ต้องมี 1–${MAX_ITEMS} บรรทัด`);
    const seen = {};
    const items = [];
    for (let i = 0; i < pl.items.length; i++) {
      const it = pl.items[i];
      const n = i + 1;
      if (!it || typeof it !== 'object' || Array.isArray(it)) return bad('items', `บรรทัด ${n} ไม่ถูกต้อง`);
      if (!idOk(it.lineId, 500)) return bad('items', `บรรทัด ${n} ไม่มีรหัสบรรทัด`);
      if (seen[it.lineId]) return bad('items', `รหัสบรรทัด ${it.lineId} ซ้ำ`);
      seen[it.lineId] = true;
      const qtyOk = (typeof it.qty === 'string' && it.qty.length <= 100) || (typeof it.qty === 'number' && isFinite(it.qty));
      if (!qtyOk) return bad('items', `บรรทัด ${n} จำนวนไม่ถูกต้อง`);
      if (!textOk(it.description, MAX_TEXT + 1, true) || !textOk(it.unit, MAX_TEXT, true) || !textOk(it.productId, MAX_TEXT, true)) {
        return bad('items', `บรรทัด ${n} ข้อมูลไม่ครบ`);
      }
      items.push({ lineId: it.lineId, description: it.description, qty: String(it.qty), unit: it.unit, productId: it.productId });
    }
    const rel = pl.release;
    if (!rel || typeof rel !== 'object' || typeof rel.allowed !== 'boolean') return bad('release', 'ไม่มีสิทธิ์เริ่มผลิต (release)');
    if (!Array.isArray(rel.blockers) || rel.blockers.length > 200 || !rel.blockers.every((b) => typeof b === 'string' && b.length <= 2000)) {
      return bad('release', 'เงื่อนไขที่ยังขาดต้องเป็นรายการข้อความ');
    }
    for (const f of ['drawingRevision', 'bomRevision']) if (!optText(rel[f], 500)) return bad('release', `${f} ต้องเป็นข้อความ`);
    if (!(rel.bomFingerprint === null || rel.bomFingerprint === undefined || (typeof rel.bomFingerprint === 'string' && HEX64.test(rel.bomFingerprint)))) {
      return bad('release', 'bomFingerprint ต้องเป็น SHA-256');
    }
    if (typeof pl.cancelled !== 'boolean') return bad('cancelled', 'ไม่มีสถานะยกเลิก');
    return {
      workspace: p.workspace, commandId: p.commandId, orderId: p.orderId, productionJobId: p.productionJobId, version: p.version,
      payloadHash: p.payloadHash, orderNumber: pl.orderNumber, customerId: pl.customerId || '', dealId: pl.dealId || '',
      vehicle: util.trim(pl.vehicle), due: pl.due || '', items, cancelled: pl.cancelled,
      release: { allowed: rel.allowed, blockers: rel.blockers.slice(), drawingRevision: rel.drawingRevision || null,
        bomRevision: rel.bomRevision || null, bomFingerprint: rel.bomFingerprint || null },
    };
  }

  // ---- sales.syncJob ------------------------------------------------------------------------------------------
  define('sales.syncJob', {
    label: 'รับใบงานจาก Sales Office', perm: 'job.manage',
    prepare(tx, p) {
      if (!VIA_RE.test(String(tx.ctx.via || ''))) {
        return tx.error('BRIDGE_ONLY', 'คำสั่งนี้รับได้จากตัวเชื่อม Sales Office เท่านั้น – ใบงานจาก SO สร้างเองไม่ได้');
      }
      const c = readCommand(tx, p);
      if (!c) return;
      const key = jobKeyFor(c.workspace, c.productionJobId);
      const old = tx.get('jobs', key);
      if (old) {
        if (old.source !== 'sales' || old.workspace !== c.workspace || old.productionJobId !== c.productionJobId) {
          return tx.error('MAPPING_CONFLICT', `เลขใบงาน ${key} ใช้กับงานอื่นอยู่แล้ว – ไม่รับคำสั่งนี้ ให้ผู้ดูแลตรวจ`);
        }
        if (old.orderId !== c.orderId) {
          return tx.error('MAPPING_CONFLICT', `งานผลิต ${c.productionJobId} เคยเป็นของ SO รหัส ${old.orderId} ไม่ใช่ ${c.orderId} – ไม่รับคำสั่งนี้`);
        }
        if (c.version <= (old.salesVersion || 0)) {
          return tx.error('OLDER_VERSION', `ใบงาน ${key} มีคำสั่งฉบับ ${old.salesVersion} แล้ว – ไม่รับฉบับ ${c.version} ที่เก่ากว่าหรือซ้ำ`);
        }
      }
      const job = old ? clone(old) : {
        jobNo: key, soNo: '', product: '', bomRev: '', qty: 0, dueDate: '', priority: 3, status: 'OPEN', remark: '', lines: [],
        createdBy: tx.userId, createdAt: tx.now, updatedBy: '', updatedAt: '', doneBy: '', doneAt: '', deliveredBy: '',
        deliveredAt: '', cancelledBy: '', cancelledAt: '', cancelReason: '', forced: null, log: [],
        source: 'sales', workspace: c.workspace, orderId: c.orderId, productionJobId: c.productionJobId,
        cancelled: false, cancelledBySales: false, salesChanged: false, mappedItemsHash: '', mappedBy: '', mappedAt: '',
      };
      const changes = [];
      const newDue = dueDate(c.due);
      if (c.due && !newDue) tx.warn(`วันกำหนดจาก SO อ่านไม่ได้ (${String(c.due).slice(0, 40)}) – ใบงานยังไม่มีวันกำหนด`);
      if (old && newDue !== old.dueDate && OPEN_JOB[job.status]) {
        // open reservations that took the job's date follow it (as job.update does)
        for (const r of tx.all('reservations', (x) => x.jobNo === key && P.isOpen(x) && x.needDate === old.dueDate)) {
          tx.put('reservations', r.id, Object.assign(clone(r), { needDate: newDue, updatedBy: tx.userId, updatedAt: tx.now }));
        }
        changes.push(`วันกำหนด ${old.dueDate || '-'} → ${newDue || '-'}`);
      }
      const ih = itemsHash(c.items);
      if (old && itemsHash(old.salesItems) !== ih) changes.push('รายการ SO เปลี่ยน');
      Object.assign(job, {
        soNo: util.normCode(c.orderNumber), orderNumber: c.orderNumber, customerId: c.customerId, dealId: c.dealId,
        vehicle: c.vehicle, salesCommandId: c.commandId, salesVersion: c.version, salesPayloadHash: c.payloadHash,
        salesItems: c.items, salesRelease: c.release, salesDue: c.due, salesReceivedAt: tx.now, dueDate: newDue,
        salesChanged: !!(job.product && job.mappedItemsHash && job.mappedItemsHash !== ih),
      });
      let released = [];
      if (c.cancelled) {
        if (!job.cancelled) changes.push('SO ถูกยกเลิก');
        job.cancelled = true;
        if (OPEN_JOB[job.status]) {
          const reason = `Sales Office ยกเลิก SO ${c.orderNumber}`;
          released = releaseOpen(tx, job, reason);
          const outstanding = (job.lines || []).filter((l) => !l.output && l.issued > 0).map((l) => ({ line: l.line, code: l.code, issued: l.issued }));
          Object.assign(job, { status: 'CANCELLED', cancelledBy: tx.userId, cancelledAt: tx.now, cancelReason: reason, cancelledBySales: true });
          if (outstanding.length) {
            job.forced = { by: tx.userId, at: tx.now, reason, outstanding };
            tx.warn(`ใบงาน ${key} ยกเลิกตาม SO ทั้งที่มีของเบิกค้าง: ${outstanding.map((o) => `${o.code} ${o.issued}`).join(', ')} – ให้คืนเข้าคลัง (RT)`);
          }
        } else if (job.status === 'DONE' || job.status === 'DELIVERED') {
          tx.warn(`ใบงาน ${key} ${P.JOB_STATUS[job.status]} แล้ว – บันทึกว่า SO ถูกยกเลิก แต่ไม่เปลี่ยนสถานะงาน`);
        }
      } else {
        job.cancelled = false;
        if (job.status === 'CANCELLED' && job.cancelledBySales) {
          const started = (job.lines || []).some((l) => l.issued > 0 || l.finished > 0);
          Object.assign(job, { status: started ? 'IN_PROGRESS' : 'OPEN', cancelledBy: '', cancelledAt: '', cancelReason: '',
            cancelledBySales: false, forced: null });
          changes.push('Sales Office เปิด SO อีกครั้ง');
        }
      }
      if (old) {
        job.updatedBy = tx.userId;
        job.updatedAt = tx.now;
      }
      addLog(job, tx, old ? 'sales.update' : 'sales.create',
        `SO ${c.orderNumber} ฉบับ ${c.version}${changes.length ? ': ' + changes.join(', ') : ''}`);
      tx.put('jobs', key, job);
      Object.assign(tx.result, { jobNo: key, created: !old, version: c.version, status: job.status, cancelled: job.cancelled,
        released, changes });
      tx.summary = `${old ? 'ปรับ' : 'รับ'}ใบงานจาก Sales Office ${key} (SO ${c.orderNumber} ฉบับ ${c.version}${job.cancelled ? ' ยกเลิก' : ''})`;
    },
  });

  // ---- sales.mapJob -------------------------------------------------------------------------------------------
  define('sales.mapJob', {
    label: 'ผูกใบงาน SO กับสินค้าและ BOM', perm: 'job.manage',
    prepare(tx, p) {
      const key = util.normCode(p.jobKey || p.jobNo);
      if (!key) return tx.error('REQUIRED', 'ระบุใบงาน', { field: 'jobKey' });
      const old = tx.get('jobs', key);
      if (!old) return tx.error('NOT_FOUND', `ไม่พบใบงาน ${key}`, { field: 'jobKey' });
      if (old.source !== 'sales') return tx.error('NOT_SALES', `ใบงาน ${key} ไม่ได้มาจาก Sales Office – ใช้หน้าใบงานปกติ`, { field: 'jobKey' });
      if (old.cancelled) return tx.error('JOB_CLOSED', `SO ของใบงาน ${key} ถูกยกเลิกแล้ว – ผูก BOM ไม่ได้`);
      if (!OPEN_JOB[old.status]) return tx.error('JOB_CLOSED', `ใบงาน ${key} ${P.JOB_STATUS[old.status] || old.status} – ผูก BOM ไม่ได้`);
      if ((old.lines || []).some((l) => l.issued > 0 || l.finished > 0 || l.received > 0)) {
        return tx.error('JOB_STARTED', `ใบงาน ${key} เริ่มเบิก/ผลิตแล้ว – เปลี่ยน BOM ไม่ได้ ให้ตรวจผลกระทบและคืนของก่อน`);
      }
      if (tx.all('reservations', (r) => r.jobNo === key && P.isOpen(r)).length) {
        return tx.error('HAS_RESERVATIONS', `ใบงาน ${key} มีของจองอยู่ – ปล่อยการจองก่อนผูก BOM ใหม่`);
      }
      if (p.qty === undefined || p.qty === null || p.qty === '') {
        return tx.error('REQUIRED', 'ระบุจำนวนชุดที่จะผลิต (ยืนยันจากรายการ SO – ระบบไม่เดาจำนวนจาก SO)', { field: 'qty' });
      }
      const q = util.num(p.qty);
      if (!(q > 0) || q > 1e6) return tx.error('BAD_QTY', 'จำนวนชุดต้องเป็นตัวเลขมากกว่า 0', { field: 'qty' });
      const qty = round(q);
      const it = tx.item(p.product);
      if (!it) return tx.error('NOT_FOUND', `ไม่พบสินค้า ${p.product || '(ว่าง)'} ในทะเบียน`, { field: 'product' });
      if (it.active === false) return tx.error('INACTIVE', `${it.id} ปิดใช้งานแล้ว`, { field: 'product' });
      const approved = tx.all('boms', (b) => b.product === it.id && b.status === 'APPROVED')[0] || null;
      const want = util.normCode(p.bomRev);
      let bom = approved;
      if (want) {
        bom = tx.get('boms', it.id + '|' + want);
        if (!bom) return tx.error('NOT_FOUND', `ไม่พบ BOM ${it.id} ฉบับ ${want}`, { field: 'bomRev' });
        if (bom.status !== 'APPROVED') {
          return tx.error('BOM_NOT_APPROVED', `BOM ${it.id} ฉบับ ${want} ${bom.status === 'DRAFT' ? 'ยังเป็นร่าง' : 'เลิกใช้แล้ว'} – ใช้ได้เฉพาะฉบับที่อนุมัติ${approved ? ' (ตอนนี้คือฉบับ ' + approved.rev + ')' : ''}`, { field: 'bomRev' });
        }
      } else if (!bom) {
        return tx.error('NO_BOM', `${it.id} ยังไม่มี BOM ที่อนุมัติ – ให้วิศวกรรมอนุมัติก่อน`, { field: 'product' });
      }
      const merged = [];
      const seen = {};
      for (const l of bom.lines || []) {
        if (seen[l.code]) seen[l.code].per = round(seen[l.code].per + l.qty);
        else merged.push((seen[l.code] = { code: l.code, per: round(l.qty), note: l.note || '' }));
      }
      const lines = [{ line: 0, code: it.id, per: 0, required: 0, issued: 0, toMake: qty, finished: 0, received: 0,
        note: 'สินค้าที่ผลิตของงานนี้', output: true }].concat(merged.map((x, i) => ({ line: i + 1, code: x.code, per: x.per,
        required: round(x.per * qty), issued: 0, toMake: 0, finished: 0, received: 0, note: x.note })));
      const job = clone(old);
      const remap = !!job.product;
      Object.assign(job, { product: it.id, bomRev: bom.rev, qty, lines, mappedItemsHash: itemsHash(job.salesItems), salesChanged: false,
        mappedBy: tx.userId, mappedAt: tx.now, updatedBy: tx.userId, updatedAt: tx.now });
      addLog(job, tx, 'sales.map', `${remap ? 'ผูกใหม่ ' : ''}${it.id} ฉบับ ${bom.rev} × ${qty}`);
      tx.put('jobs', key, job);
      Object.assign(tx.result, { jobNo: key, product: it.id, bomRev: bom.rev, qty, lines: lines.length - 1, fingerprint: fingerprint(job) });
      tx.summary = `ผูกใบงาน ${key} (SO ${job.orderNumber}) กับ ${it.id} ฉบับ ${bom.rev} × ${qty} ชุด`;
    },
  });

  // ---- read helpers (pure functions of a state) ---------------------------------------------------------------
  const S = (RRS.sales = RRS.sales || {});
  Object.assign(S, { WORKSPACES, MAX_COMMAND_BYTES, jobKeyFor, itemsHash, fingerprint });

  /** Jobs from Sales Office, optionally of one workspace. */
  S.jobs = function jobs(state, f) {
    f = f || {};
    return RRS.q.rows(state, 'jobs', (j) => j.source === 'sales' && (!f.workspace || j.workspace === f.workspace))
      .sort((a, b) => String(a.jobNo).localeCompare(String(b.jobNo)));
  };

  /** QC facts of the job's product from the quality module's tables (null = not known: module not loaded / not mapped). */
  function qcFacts(state, job) {
    const known = !!job.product && !!schema.tables.inspections && !!schema.tables.ncrs;
    if (!known) return { good: null, scrap: null, rework: null };
    let good = 0;
    for (const i of RRS.q.rows(state, 'inspections', (x) => x.jobNo === job.jobNo && x.code === job.product && x.stage === 'FINAL' && x.result === 'PASS')) {
      good += Number(i.releasedQty) || 0;
    }
    let scrap = 0;
    let rework = 0;
    for (const n of RRS.q.rows(state, 'ncrs', (x) => x.jobNo === job.jobNo && x.code === job.product && x.status !== 'OPEN')) {
      if (n.disposition === 'SCRAP') scrap += Number(n.qty) || 0;
      if (n.disposition === 'REWORK') rework += Number(n.qty) || 0;
    }
    return { good: round(good), scrap: round(scrap), rework: round(rework) };
  }

  /**
   * Status of one Sales Office job in the shape the Sales Office bridge accepts (its validation rules hold by
   * construction: reserved/shortage/completed ≤ required, 'ready' only with every line covered and nothing short,
   * revisionApproved only with revisions + fingerprint + evidence). sourceVersion = prevSourceVersion + 1;
   * observedAt = opts.now (default: the current time). Returns null for an unknown or non-Sales job.
   *   parts[]: {partId: code, required, reserved (= issued + open reservations, at most required), shortage (what free
   *   stock cannot cover, planning readiness), unit, completed (= finished)}
   */
  S.statusFor = function statusFor(state, jobKey, prevSourceVersion, opts) {
    opts = opts || {};
    const job = RRS.q.get(state, 'jobs', util.normCode(jobKey));
    if (!job || job.source !== 'sales') return null;
    const items = state.tables.items || {};
    const prev = Math.max(0, Math.floor(Number(prevSourceVersion) || 0));
    const plan = (job.lines || []).filter((l) => !l.output && !l.extra);
    const mapped = !!job.product && !!job.bomRev && plan.length > 0;
    const cancelled = !!job.cancelled || job.status === 'CANCELLED';
    const closed = job.status === 'DONE' || job.status === 'DELIVERED';
    const ready = mapped ? P.readiness(state, job.jobNo, { today: util.bkkDate(opts.now || new Date().toISOString()) }) : null;
    const byLine = {};
    for (const l of (ready && ready.lines) || []) byLine[l.line] = l;
    // One part per code: Sales Office refuses the whole request when a partId repeats. sales.mapJob already merges a
    // code's BOM lines; should a job still hold one code on two lines, they are reported as one part: reservations
    // belong to job + code, so they are counted once, and whatever is not covered counts as short (never 'ready').
    const groups = {};
    const codes = [];
    for (const l of mapped ? plan : []) {
      if (!groups[l.code]) {
        groups[l.code] = [];
        codes.push(l.code);
      }
      groups[l.code].push(l);
    }
    const sumOf = (ls, f) => round(ls.reduce((s, l) => s + (Number(l[f]) || 0), 0));
    const parts = codes.map((code) => {
      const ls = groups[code];
      const r = byLine[ls[0].line] || { reservedRemaining: 0, missing: 0 };
      const required = sumOf(ls, 'required');
      const reserved = Math.min(required, pos0(sumOf(ls, 'issued') + (r.reservedRemaining || 0)));
      let shortage = 0;
      if (!cancelled && !closed) shortage = ls.length === 1 ? Math.min(required, pos0(r.missing)) : round(required - reserved);
      return { partId: code, required, reserved, shortage, unit: (items[code] || {}).baseUnit || '',
        completed: Math.min(required, pos0(sumOf(ls, 'finished'))) };
    });
    let materialStatus = 'unknown';
    if (mapped && !cancelled && parts.length) {
      if (parts.every((x) => x.reserved >= x.required && x.shortage === 0)) materialStatus = 'ready';
      else if (parts.some((x) => x.shortage > 0)) materialStatus = 'short';
    }
    const appr = job.product ? P.approvedBom(state, job.product) : null;
    const bom = mapped ? RRS.q.get(state, 'boms', job.product + '|' + job.bomRev) : null;
    const revisionApproved = mapped && !!appr && appr.rev === job.bomRev && !!bom;
    const fp = mapped ? fingerprint(job) : null;
    const rel = job.salesRelease || {};
    const blockers = [];
    if (job.cancelled) blockers.push('Sales Office ยกเลิก SO นี้แล้ว');
    else if (job.status === 'CANCELLED') blockers.push('ใบงานถูกยกเลิกในระบบสต็อก');
    if (cancelled && plan.some((l) => l.issued > 0)) blockers.push('มีของเบิกค้างจากงานที่ยกเลิก – ต้องคืนเข้าคลัง (RT)');
    if (!mapped) blockers.push('ยังไม่ได้ผูกใบงานกับสินค้าและ BOM ที่อนุมัติ – ฝ่ายวางแผนต้องยืนยันจำนวนชุด');
    else if (!revisionApproved) {
      blockers.push(`BOM ${job.product} ฉบับ ${job.bomRev} ไม่ใช่ฉบับที่อนุมัติ${appr ? ' (ฉบับที่อนุมัติ: ' + appr.rev + ')' : ''} – ต้องผูกใหม่`);
    }
    if (job.salesChanged) blockers.push('รายการใน SO เปลี่ยนหลังผูก BOM – ฝ่ายวางแผนต้องตรวจและผูกใหม่');
    if (mapped && rel.bomFingerprint && rel.bomFingerprint !== fp) blockers.push('BOM ที่ Sales Office อนุมัติไม่ตรงกับ BOM ของใบงานนี้');
    if (!cancelled && rel.allowed === false) blockers.push('รอ Sales Office อนุญาตเริ่มผลิต');
    if (!cancelled && !closed) {
      for (const x of parts) {
        if (x.shortage > 0) blockers.push(`${x.partId} ขาด ${x.shortage} ${x.unit}`.trim());
        else if (x.reserved < x.required) blockers.push(`${x.partId} ยังไม่ได้จอง ${round(x.required - x.reserved)} ${x.unit}`.trim());
      }
    }
    const qc = qcFacts(state, job);
    return {
      externalJobId: job.jobNo,
      sourceVersion: prev + 1,
      bomRevision: mapped ? job.bomRev : null,
      // stock-qc approves a drawing and its BOM together: bom.approve sets the item's drawingRev to the BOM rev
      drawingRevision: mapped ? job.bomRev : null,
      bomFingerprint: fp,
      revisionApproved,
      revisionEvidence: revisionApproved ? `BOM ${job.product} ฉบับ ${job.bomRev} อนุมัติในระบบสต็อกโดย ${bom.approvedBy || '-'} เมื่อ ${bom.approvedAt || '-'}` : null,
      materialStatus,
      parts,
      station: null,
      good: qc.good,
      scrap: qc.scrap,
      rework: qc.rework,
      blockers: blockers.slice(0, MAX_BLOCKERS).map((b) => b.slice(0, MAX_BLOCKER_CHARS)),
      eta: null,
      observedAt: opts.now || new Date().toISOString(),
    };
  };
  /** The status without the fields that change on every report (sourceVersion, observedAt): equal = nothing to send. */
  S.statusContent = function statusContent(status) {
    const out = Object.assign({}, status);
    delete out.sourceVersion;
    delete out.observedAt;
    return out;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
