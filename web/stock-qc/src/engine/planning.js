/*
 * Phase 2 – จองราย SO/ใบงาน และเชื่อมการเบิกกับงานผลิต (P0).
 *
 * Tables: jobs (ใบงาน), reservations (ใบจอง) – shapes in ENGINE_CONTRACT.md (extra fields are listed in the schema).
 *
 * Rules (plan file 01, Phase 2):
 *  - a reservation takes only AVAILABLE stock of ONE warehouse, after the remaining qty of every open reservation of the
 *    same code + warehouse (free). Two SOs cannot reserve more than is there: over free → error, or (allowPartial) only
 *    the free part. QC_HOLD / QUARANTINE / REWORK stock, work in progress and PO stock still to come are never free.
 *  - a job made from a product takes the lines of the product's APPROVED BOM × qty (bomRev is stored); a job without a
 *    product lists its own lines, lines[].qty is per set (required = qty × line qty, qty defaults to 1).
 *    A job with a product also has line 0 = the product itself (output: true, required 0, toMake = qty) so the
 *    finished goods can be received (FR) against the job.
 *  - issues PD/OU with a job consume that job's reservations – the line's reservationId first, then the job's open
 *    reservations of that code + warehouse, oldest first – and add to the job line's issued (a code that is not in
 *    the job becomes an extra line, required 0). The job must be open. A delivery DL (defined by a later module)
 *    with a job only consumes that job's reservations and adds to an existing line – it may follow a finished job. RT with a job lowers issued (never below 0). FR with a job may receive at most
 *    finished − received of the job line. doc.cancel reverses all of it (in the same commit).
 *  - no other document can take stock reserved for another job (RRS.inventory.reservedElsewhere). Adjustments (AJ)
 *    are exempt – they record what is really there; an over-reserved warehouse then shows a flag in six(). A transfer
 *    between bins of the same warehouse is not taking stock (reservations are per warehouse).
 *  - nothing is deleted: a released reservation stays with who/when/why; every use of a reservation is kept in
 *    `uses` (a cancelled document adds a negative entry that points at the document). Forcing the cancel of a job
 *    that still holds issued material is an exception that another person than the job's creator must do.
 * Free-text jobs on documents (no row in jobs) are not linked – Phase 1 documents keep working unchanged.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { util, schema, commands, STATUS, TRANSIT } = RRS;
  const define = commands.define;
  const inv = RRS.inventory;

  schema.define('jobs', {
    label: 'ใบงาน / จองราย SO', phase: 2, key: 'jobNo',
    note: 'ใช้เลข SO ตรงตัว ไม่จับคู่จากชื่อ (ค-10); บรรทัด 0 = สินค้าที่ผลิตของงาน',
    fields: [['jobNo', 'text', 'เลขที่ใบงาน'], ['soNo', 'text', 'เลขที่ SO'], ['product', 'text', 'สินค้าที่ผลิต'],
      ['bomRev', 'text', 'ฉบับ BOM ที่ใช้'], ['qty', 'number', 'จำนวนชุด'], ['dueDate', 'date', 'วันต้องใช้/กำหนดเสร็จ'],
      ['priority', 'number', 'ลำดับความสำคัญ (1 สูงสุด … 5)'],
      ['status', 'enum', 'สถานะ', 'OPEN/IN_PROGRESS/DONE/DELIVERED/CANCELLED'], ['remark', 'text', 'หมายเหตุ'],
      ['lines', 'json', 'บรรทัด {line, code, per (ต่อชุด), required (ต้องใช้), issued (เบิกแล้ว), toMake (ผลิตเอง), finished (ผลิตเสร็จ), received (รับเข้าแล้ว), note, output, extra}'],
      ['createdBy', 'text', 'ผู้สร้าง'], ['createdAt', 'datetime', 'สร้างเมื่อ'], ['updatedBy', 'text', 'ผู้แก้ล่าสุด'],
      ['updatedAt', 'datetime', 'แก้ล่าสุดเมื่อ'], ['doneBy', 'text', 'ผู้ปิดงานผลิตเสร็จ'], ['doneAt', 'datetime', 'ผลิตเสร็จเมื่อ'],
      ['deliveredBy', 'text', 'ผู้บันทึกส่งมอบ'], ['deliveredAt', 'datetime', 'ส่งมอบเมื่อ'], ['cancelledBy', 'text', 'ผู้ยกเลิก'],
      ['cancelledAt', 'datetime', 'ยกเลิกเมื่อ'], ['cancelReason', 'text', 'เหตุผลยกเลิก'],
      ['forced', 'json', 'ยกเลิกแบบบังคับทั้งที่มีของเบิกค้าง {by, at, reason, outstanding}'],
      ['log', 'json', 'ประวัติการทำรายการของใบงาน {at, by, action, detail}']],
  });
  schema.define('reservations', {
    label: 'ใบจองสินค้าให้งาน', phase: 2, key: 'id',
    note: 'คงเหลือจอง = จอง − เบิกแล้ว เมื่อสถานะ OPEN/PARTIAL; ไม่ลบ – ปล่อยแล้วเก็บผู้ปล่อย/เวลา/เหตุผล',
    fields: [['id', 'text', 'เลขที่ใบจอง (RS-00001)'], ['jobNo', 'text', 'ใบงาน'], ['soNo', 'text', 'เลขที่ SO'],
      ['line', 'number', 'บรรทัดของใบงาน'], ['code', 'text', 'รหัสสินค้า'], ['wh', 'text', 'คลัง'],
      ['qty', 'number', 'จำนวนจอง (หน่วยหลัก)'], ['issued', 'number', 'เบิกแล้ว'], ['requested', 'number', 'จำนวนที่ขอจอง'],
      ['needDate', 'date', 'วันต้องใช้'], ['priority', 'number', 'ลำดับความสำคัญ'],
      ['status', 'enum', 'สถานะ', 'OPEN/PARTIAL/FILLED/RELEASED'], ['auto', 'bool', 'จองอัตโนมัติ'],
      ['createdBy', 'text', 'ผู้จอง'], ['createdAt', 'datetime', 'จองเมื่อ'], ['updatedBy', 'text', 'ผู้เปลี่ยนล่าสุด'],
      ['updatedAt', 'datetime', 'เปลี่ยนล่าสุดเมื่อ'], ['releasedBy', 'text', 'ผู้ปล่อยการจอง'], ['releasedAt', 'datetime', 'ปล่อยเมื่อ'],
      ['releasedQty', 'number', 'ยอดที่ปล่อยคืน'], ['reason', 'text', 'เหตุผลการปล่อย'],
      ['changes', 'json', 'ประวัติการเปลี่ยนจัดสรร {at, by, fromQty, toQty, fromWh, toWh}'],
      ['uses', 'json', 'การตัดใช้จากเอกสาร {docNo, docType, line, qty (+ เบิก / − ยกเลิก), at, by}']],
  });

  const JOB_STATUS = { OPEN: 'เปิด', IN_PROGRESS: 'กำลังทำ', DONE: 'ผลิตเสร็จ', DELIVERED: 'ส่งมอบแล้ว', CANCELLED: 'ยกเลิก' };
  const RES_STATUS = { OPEN: 'จองอยู่', PARTIAL: 'เบิกบางส่วน', FILLED: 'เบิกครบ', RELEASED: 'ปล่อยแล้ว' };
  const READY = { READY: 'พร้อม', QC: 'รอตรวจ', WIP: 'ระหว่างผลิต', SHORT: 'ขาด' };
  const SIX_LABELS = { onHand: 'ของมีจริง', qcHold: 'รอตรวจ/กักกัน', reserved: 'ของจอง', free: 'ของพร้อมเบิก',
    wip: 'ของกำลังผลิต', incoming: 'ของคาดว่าจะเข้า' };
  const OPEN_JOB = { OPEN: true, IN_PROGRESS: true };
  /** Document types that issue stock to an open job (consume its reservations, add to issued, extra lines). */
  const ISSUE_TYPES = { PD: true, OU: true };
  /** Outgoing types that consume the job's reservations (ISSUE_TYPES + delivery to the customer). */
  const CONSUME_TYPES = { PD: true, OU: true, DL: true };
  /** Document types that may take reserved stock (they record what is really there). */
  const EXEMPT_TYPES = { AJ: true };
  const HOLD = [STATUS.QC_HOLD, STATUS.QUARANTINE, STATUS.REWORK];

  const round = util.round;
  const pos0 = (n) => Math.max(0, round(n));
  const clone = util.clone;

  // ---- small helpers ---------------------------------------------------------------------------------------
  function isOpenRes(r) {
    return !!r && (r.status === 'OPEN' || r.status === 'PARTIAL');
  }
  function remaining(r) {
    return isOpenRes(r) ? pos0(r.qty - (r.issued || 0)) : 0;
  }
  function resStatus(r) {
    if (r.status === 'RELEASED') return 'RELEASED';
    const iss = round(r.issued || 0);
    if (iss >= round(r.qty)) return 'FILLED';
    return iss > 0 ? 'PARTIAL' : 'OPEN';
  }
  const jobKey = (v) => util.normCode(v);
  function jobOf(doc, line) {
    return jobKey(doc && doc.job) || jobKey(line && line.jobNo);
  }
  function compLine(job, code) {
    return (job.lines || []).find((l) => !l.output && l.code === code) || null;
  }
  function madeLine(job, code) {
    const ls = (job.lines || []).filter((l) => l.code === code);
    return ls.find((l) => l.toMake > 0) || ls[0] || null;
  }
  function jobOrder(a, b) {
    return (a.priority - b.priority) || String(a.dueDate).localeCompare(String(b.dueDate))
      || String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.jobNo).localeCompare(String(b.jobNo));
  }
  function byCreated(a, b) {
    return String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id));
  }
  function parseDate(v) {
    const s = util.trim(v).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const t = Date.parse(s);
    if (!isFinite(t) || new Date(t).toISOString().slice(0, 10) !== s) return null;
    return s;
  }
  function parsePriority(v, d) {
    if (v == null || v === '') return d;
    const n = util.num(v);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
  }
  const yes = (v) => v === true || v === 'true' || v === 1 || v === '1';
  function addLog(job, tx, action, detail) {
    job.log = (job.log || []).concat([{ at: tx.now, by: tx.userId, action, detail: detail || '' }]);
  }
  function touch(job, tx) {
    job.updatedBy = tx.userId;
    job.updatedAt = tx.now;
  }

  // ---- reads inside a command (see this command's own writes) -----------------------------------------------
  function getJob(tx, jobNo) {
    const k = jobKey(jobNo);
    if (!k) return tx.error('REQUIRED', 'ระบุเลขที่ใบงาน', { field: 'jobNo' }) && null;
    const j = tx.get('jobs', k);
    if (!j) return tx.error('NOT_FOUND', `ไม่พบใบงาน ${k}`, { field: 'jobNo' }) && null;
    return clone(j);
  }
  function needOpen(tx, job, what) {
    if (OPEN_JOB[job.status]) return true;
    return tx.error('JOB_CLOSED', `ใบงาน ${job.jobNo} ${JOB_STATUS[job.status] || job.status} – ${what}ไม่ได้`);
  }
  function txApprovedBom(tx, product) {
    return tx.all('boms', (b) => b.product === product && b.status === 'APPROVED')[0] || null;
  }
  function reservedAt(tx, code, wh, exceptId) {
    let s = 0;
    for (const r of tx.all('reservations', (x) => x.code === code && x.wh === wh && isOpenRes(x) && x.id !== exceptId)) s += remaining(r);
    return round(s);
  }
  /** AVAILABLE stock of code in wh not held by any open reservation (may be negative after an adjustment). */
  function freeAt(tx, code, wh, exceptId) {
    return round(tx.qty({ code, wh, status: STATUS.AVAILABLE }) - reservedAt(tx, code, wh, exceptId));
  }
  function jobReserved(tx, jobNo, code, exceptId) {
    let s = 0;
    for (const r of tx.all('reservations', (x) => x.jobNo === jobNo && x.code === code && isOpenRes(x) && x.id !== exceptId)) s += remaining(r);
    return round(s);
  }
  /** Still to cover by reservations: required − issued − open reservations of the job line. */
  function lineNeed(tx, job, jl, exceptId) {
    return pos0(jl.required - jl.issued - jobReserved(tx, job.jobNo, jl.code, exceptId));
  }
  function checkWh(tx, raw, perm, field) {
    const wh = util.normCode(raw);
    if (!wh) return tx.error('REQUIRED', 'ระบุคลัง', { field }) && null;
    if (wh === TRANSIT) return tx.error('RESERVED', `${TRANSIT} ใช้ภายในระบบ จองหรือหยิบตรงไม่ได้`, { field }) && null;
    const row = tx.get('warehouses', wh);
    if (!row) return tx.error('NOT_FOUND', `ไม่พบคลัง ${wh}`, { field }) && null;
    if (row.active === false) return tx.error('INACTIVE', `คลัง ${wh} ปิดใช้งาน`, { field }) && null;
    if (!tx.can(perm, wh)) return tx.need(perm, wh, { field }) && null;
    return wh;
  }
  function newReservation(tx, job, jl, wh, qty, extra) {
    extra = extra || {};
    const id = tx.nextId('RS');
    const row = {
      id, jobNo: job.jobNo, soNo: job.soNo, line: jl.line, code: jl.code, wh, qty: round(qty), issued: 0,
      requested: round(extra.requested == null ? qty : extra.requested), needDate: extra.needDate || job.dueDate,
      priority: extra.priority || job.priority, status: 'OPEN', auto: !!extra.auto, createdBy: tx.userId, createdAt: tx.now,
      updatedBy: '', updatedAt: '', releasedBy: '', releasedAt: '', releasedQty: 0, reason: '', changes: [], uses: [],
    };
    tx.put('reservations', id, row);
    return row;
  }
  function releaseRes(tx, r, reason) {
    const nr = Object.assign(clone(r), { status: 'RELEASED', releasedBy: tx.userId, releasedAt: tx.now, reason,
      releasedQty: remaining(r) });
    tx.put('reservations', r.id, nr);
    return nr;
  }
  function releaseJob(tx, job, reason) {
    const out = [];
    for (const r of tx.all('reservations', (x) => x.jobNo === job.jobNo && isOpenRes(x)).sort(byCreated)) {
      out.push({ id: r.id, code: r.code, wh: r.wh, qty: remaining(r) });
      releaseRes(tx, r, reason);
    }
    return out;
  }
  function newPickDoc(tx, job, lines, remark) {
    return {
      docNo: '', type: 'PD', date: tx.date, status: 'DRAFT', job: job.jobNo, department: '', ref: job.soNo,
      remark: remark || `จัดชุดตามใบจอง ${job.jobNo}`, lines, createdBy: tx.userId, createdAt: tx.now, postedBy: '',
      postedAt: '', cancelledBy: '', cancelledAt: '', cancelReason: '', override: null, expressStatus: '', expressNo: '',
      source: 'pick',
    };
  }

  // ---- jobs -----------------------------------------------------------------------------------------------
  define('job.create', {
    label: 'สร้างใบงาน', perm: 'job.manage',
    prepare(tx, p) {
      const soNo = util.normCode(p.soNo);
      if (!soNo) return tx.error('REQUIRED', 'ระบุเลขที่ SO (ใช้เลขตรงตัว ไม่จับคู่จากชื่อ)', { field: 'soNo' });
      let jobNo = util.normCode(p.jobNo);
      if (jobNo) {
        if (!/^[A-Z0-9][A-Z0-9._/-]*$/.test(jobNo) || jobNo.length > 40) {
          return tx.error('BAD_CODE', 'เลขที่ใบงานใช้ A-Z 0-9 . _ / - ไม่เกิน 40 ตัว', { field: 'jobNo' });
        }
        if (tx.get('jobs', jobNo)) return tx.error('DUPLICATE', `มีใบงาน ${jobNo} แล้ว`, { field: 'jobNo' });
      }
      const dueDate = parseDate(p.dueDate);
      if (!dueDate) return tx.error('BAD_DATE', 'วันต้องใช้/กำหนดเสร็จต้องเป็นวันที่จริงแบบ YYYY-MM-DD', { field: 'dueDate' });
      const priority = parsePriority(p.priority, 3);
      if (priority == null) return tx.error('BAD_VALUE', 'ลำดับความสำคัญต้องเป็นเลขเต็ม 1 (สูงสุด) ถึง 5', { field: 'priority' });
      const prodCode = util.trim(p.product);
      const hasLines = Array.isArray(p.lines) && p.lines.length > 0;
      if (prodCode && hasLines) return tx.error('BAD_INPUT', 'ระบุสินค้าที่ผลิต (ใช้ BOM) หรือรายการชิ้นส่วนเอง อย่างใดอย่างหนึ่ง', { field: 'lines' });
      if (!prodCode && !hasLines) return tx.error('REQUIRED', 'ระบุสินค้าที่ผลิต หรือรายการชิ้นส่วนที่งานต้องใช้', { field: 'product' });
      const qtyIn = p.qty == null || p.qty === '' ? (prodCode ? NaN : 1) : util.num(p.qty);
      if (!(qtyIn > 0)) return tx.error('BAD_QTY', 'จำนวนชุดต้องเป็นตัวเลขมากกว่า 0', { field: 'qty' });
      const qty = round(qtyIn);
      let product = '';
      let bomRev = '';
      const per = [];
      if (prodCode) {
        const it = tx.item(prodCode);
        if (!it) return tx.error('NOT_FOUND', `ไม่พบสินค้า ${prodCode} ในทะเบียน`, { field: 'product' });
        if (it.active === false) return tx.error('INACTIVE', `${it.id} ปิดใช้งานแล้ว`, { field: 'product' });
        product = it.id;
        const want = util.normCode(p.bomRev);
        const approved = txApprovedBom(tx, product);
        let bom = approved;
        if (want) {
          bom = tx.get('boms', product + '|' + want);
          if (!bom) return tx.error('NOT_FOUND', `ไม่พบ BOM ${product} ฉบับ ${want}`, { field: 'bomRev' });
          if (bom.status !== 'APPROVED') {
            return tx.error('BOM_NOT_APPROVED', `BOM ${product} ฉบับ ${want} ${bom.status === 'DRAFT' ? 'ยังเป็นร่าง' : 'เลิกใช้แล้ว'} – ใบงานใช้ได้เฉพาะฉบับที่อนุมัติ${approved ? ' (ตอนนี้คือฉบับ ' + approved.rev + ')' : ''}`, { field: 'bomRev' });
          }
        } else if (!bom) {
          return tx.error('NO_BOM', `${product} ยังไม่มี BOM ที่อนุมัติ – ให้วิศวกรรมอนุมัติก่อน หรือสร้างใบงานแบบระบุรายการชิ้นส่วนเอง`, { field: 'product' });
        }
        bomRev = bom.rev;
        for (const l of bom.lines || []) per.push({ code: l.code, per: round(l.qty), note: l.note || '' });
      } else {
        p.lines.forEach((l, i) => {
          const n = i + 1;
          const where = { line: n };
          const it = tx.item(l && l.code);
          if (!it) return tx.error('NOT_FOUND', `บรรทัด ${n}: ไม่พบรหัส ${(l && l.code) || '(ว่าง)'} ในทะเบียนสินค้า`, Object.assign({ field: 'code' }, where));
          if (it.active === false) return tx.error('INACTIVE', `บรรทัด ${n}: ${it.id} ปิดใช้งานแล้ว`, where);
          const q = util.num(l.qty);
          if (!(q > 0)) return tx.error('BAD_QTY', `บรรทัด ${n}: จำนวนต่อชุดต้องเป็นตัวเลขมากกว่า 0`, Object.assign({ field: 'qty' }, where));
          const f = RRS.unitFactor((t, k) => tx.get(t, k), it, l.unit);
          if (f == null) return tx.error('NO_UNIT', `บรรทัด ${n}: ${it.id} ไม่มีตัวคูณของหน่วย "${l.unit}" (หน่วยหลัก ${it.baseUnit})`, Object.assign({ field: 'unit' }, where));
          per.push({ code: it.id, per: round(q * f), note: util.trim(l.note) });
        });
        if (!tx.ok) return;
      }
      const merged = [];
      const seen = {};
      for (const x of per) {
        if (seen[x.code]) seen[x.code].per = round(seen[x.code].per + x.per);
        else merged.push((seen[x.code] = Object.assign({}, x)));
      }
      const lines = merged.map((x, i) => ({ line: i + 1, code: x.code, per: x.per, required: round(x.per * qty), issued: 0,
        toMake: 0, finished: 0, received: 0, note: x.note }));
      if (product) {
        lines.unshift({ line: 0, code: product, per: 0, required: 0, issued: 0, toMake: qty, finished: 0, received: 0,
          note: 'สินค้าที่ผลิตของงานนี้', output: true });
      }
      const dup = tx.all('jobs', (j) => j.soNo === soNo && OPEN_JOB[j.status] && j.product === product && !!product);
      if (dup.length) tx.warn(`SO ${soNo} มีใบงานของ ${product} เปิดอยู่แล้ว: ${dup.map((j) => j.jobNo).join(', ')}`);
      jobNo = jobNo || tx.nextNo('JB');
      const row = {
        jobNo, soNo, product, bomRev, qty, dueDate, priority, status: 'OPEN', remark: util.trim(p.remark), lines,
        createdBy: tx.userId, createdAt: tx.now, updatedBy: '', updatedAt: '', doneBy: '', doneAt: '', deliveredBy: '',
        deliveredAt: '', cancelledBy: '', cancelledAt: '', cancelReason: '', forced: null, log: [],
      };
      addLog(row, tx, 'create', product ? `${product} ฉบับ ${bomRev} × ${qty}` : `${lines.length} รายการ × ${qty}`);
      tx.put('jobs', jobNo, row);
      tx.result.jobNo = jobNo;
      tx.result.lines = lines.length;
      tx.summary = `สร้างใบงาน ${jobNo} (SO ${soNo}${product ? ' ' + product + ' ฉบับ ' + bomRev : ''} × ${qty})`;
    },
  });

  define('job.update', {
    label: 'แก้ใบงาน (วันต้องใช้/ลำดับ/หมายเหตุ)', perm: 'job.manage',
    prepare(tx, p) {
      const job = getJob(tx, p.jobNo);
      if (!job) return;
      if (job.status === 'CANCELLED' || job.status === 'DELIVERED') {
        return tx.error('JOB_CLOSED', `ใบงาน ${job.jobNo} ${JOB_STATUS[job.status]} – แก้ไม่ได้`);
      }
      const old = { dueDate: job.dueDate, priority: job.priority };
      const changes = [];
      if (p.dueDate != null && p.dueDate !== '') {
        const d = parseDate(p.dueDate);
        if (!d) return tx.error('BAD_DATE', 'วันต้องใช้ต้องเป็นวันที่จริงแบบ YYYY-MM-DD', { field: 'dueDate' });
        if (d !== job.dueDate) changes.push(`วันต้องใช้ ${job.dueDate} → ${d}`);
        job.dueDate = d;
      }
      if (p.priority != null && p.priority !== '') {
        const pr = parsePriority(p.priority, null);
        if (pr == null) return tx.error('BAD_VALUE', 'ลำดับความสำคัญต้องเป็นเลขเต็ม 1 (สูงสุด) ถึง 5', { field: 'priority' });
        if (pr !== job.priority) changes.push(`ลำดับ ${job.priority} → ${pr}`);
        job.priority = pr;
      }
      if (p.remark != null) {
        const rm = util.trim(p.remark);
        if (rm !== job.remark) changes.push('หมายเหตุ');
        job.remark = rm;
      }
      if (!changes.length) return tx.error('NOTHING', 'ไม่มีอะไรเปลี่ยน');
      // open reservations that took the job's date/priority follow the job
      for (const r of tx.all('reservations', (x) => x.jobNo === job.jobNo && isOpenRes(x))) {
        const nr = clone(r);
        let ch = false;
        if (nr.needDate === old.dueDate && job.dueDate !== old.dueDate) { nr.needDate = job.dueDate; ch = true; }
        if (nr.priority === old.priority && job.priority !== old.priority) { nr.priority = job.priority; ch = true; }
        if (ch) tx.put('reservations', nr.id, Object.assign(nr, { updatedBy: tx.userId, updatedAt: tx.now }));
      }
      touch(job, tx);
      addLog(job, tx, 'update', changes.join(', '));
      tx.put('jobs', job.jobNo, job);
      tx.summary = `แก้ใบงาน ${job.jobNo}: ${changes.join(', ')}`;
    },
  });

  define('job.setMake', {
    label: 'ตั้งจำนวนที่ผลิตเอง', perm: 'job.manage',
    prepare(tx, p) {
      const job = getJob(tx, p.jobNo);
      if (!job) return;
      if (!needOpen(tx, job, 'ตั้งจำนวนผลิต')) return;
      const n = util.num(p.line);
      const jl = job.lines.find((l) => l.line === n);
      if (!jl) return tx.error('NOT_FOUND', `ใบงาน ${job.jobNo} ไม่มีบรรทัด ${p.line}`, { field: 'line' });
      const toMake = util.num(p.toMake);
      if (isNaN(toMake) || toMake < 0) return tx.error('BAD_QTY', 'จำนวนที่ผลิตเองต้องเป็นตัวเลขไม่ติดลบ', { field: 'toMake' });
      const cap = jl.output ? job.qty : jl.required;
      if (round(toMake) > cap) {
        return tx.error('OVER_NEED', `บรรทัด ${jl.line} ${jl.code}: ผลิตเองได้ไม่เกิน ${cap} (${jl.output ? 'จำนวนชุดของงาน' : 'จำนวนที่งานต้องใช้'})`, { field: 'toMake' });
      }
      if (round(toMake) < jl.finished) {
        return tx.error('BELOW_FINISHED', `บรรทัด ${jl.line} ${jl.code}: ผลิตเสร็จแล้ว ${jl.finished} – ตั้งต่ำกว่านี้ไม่ได้`, { field: 'toMake' });
      }
      const before = jl.toMake;
      jl.toMake = round(toMake);
      touch(job, tx);
      addLog(job, tx, 'setMake', `บรรทัด ${jl.line} ${jl.code}: ${before} → ${jl.toMake}`);
      tx.put('jobs', job.jobNo, job);
      tx.summary = `ใบงาน ${job.jobNo} บรรทัด ${jl.line} ${jl.code} ผลิตเอง ${jl.toMake}`;
    },
  });

  define('job.record', {
    label: 'บันทึกผลิตเสร็จ', perm: 'production.record',
    prepare(tx, p) {
      const job = getJob(tx, p.jobNo);
      if (!job) return;
      if (!needOpen(tx, job, 'บันทึกผลิต')) return;
      const n = util.num(p.line);
      const jl = job.lines.find((l) => l.line === n);
      if (!jl) return tx.error('NOT_FOUND', `ใบงาน ${job.jobNo} ไม่มีบรรทัด ${p.line}`, { field: 'line' });
      if (!(jl.toMake > 0)) return tx.error('NOT_MADE', `บรรทัด ${jl.line} ${jl.code} ไม่ได้ตั้งให้ผลิตเอง – ให้วางแผนตั้งจำนวนผลิตก่อน`, { field: 'line' });
      const qty = util.num(p.qty);
      if (isNaN(qty) || qty === 0) return tx.error('BAD_QTY', 'จำนวนผลิตต้องเป็นตัวเลขไม่เป็น 0 (ติดลบ = แก้ยอดที่บันทึกเกิน)', { field: 'qty' });
      const next = round(jl.finished + qty);
      const remark = util.trim(p.remark || p.reason);
      if (qty > 0 && next > jl.toMake) {
        return tx.error('OVER_MAKE', `บรรทัด ${jl.line} ${jl.code}: ผลิตเสร็จรวมได้ไม่เกิน ${jl.toMake} (บันทึกแล้ว ${jl.finished})`, { field: 'qty' });
      }
      if (qty < 0) {
        if (!remark) return tx.error('REQUIRED', 'แก้ยอดผลิตลดลงต้องระบุเหตุผล', { field: 'remark' });
        if (next < jl.received) {
          return tx.error('BELOW_RECEIVED', `บรรทัด ${jl.line} ${jl.code}: รับเข้าคลังแล้ว ${jl.received} – ยอดผลิตเสร็จต่ำกว่านี้ไม่ได้ (ยกเลิกใบรับ FR ก่อน)`, { field: 'qty' });
        }
      }
      jl.finished = next;
      if (job.status === 'OPEN') job.status = 'IN_PROGRESS';
      addLog(job, tx, 'record', `บรรทัด ${jl.line} ${jl.code} ${qty > 0 ? '+' : ''}${round(qty)} = ${next}${remark ? ' (' + remark + ')' : ''}`);
      tx.put('jobs', job.jobNo, job);
      tx.result.finished = next;
      tx.summary = `ใบงาน ${job.jobNo} ${jl.code} ผลิตเสร็จ ${qty > 0 ? '+' : ''}${round(qty)} รวม ${next}/${jl.toMake}`;
    },
  });

  define('job.status', {
    label: 'ปิดงาน (ผลิตเสร็จ/ส่งมอบ)', perm: 'job.manage',
    prepare(tx, p) {
      const job = getJob(tx, p.jobNo);
      if (!job) return;
      const status = String(p.status || '').toUpperCase();
      if (status !== 'DONE' && status !== 'DELIVERED') {
        return tx.error('BAD_VALUE', 'สถานะต้องเป็น DONE (ผลิตเสร็จ) หรือ DELIVERED (ส่งมอบแล้ว) – ยกเลิกงานใช้คำสั่งยกเลิกใบงาน', { field: 'status' });
      }
      if (status === 'DONE' && !OPEN_JOB[job.status]) return tx.error('BAD_STATE', `ใบงาน ${job.jobNo} ${JOB_STATUS[job.status]} – ปิดเป็นผลิตเสร็จไม่ได้`);
      if (status === 'DELIVERED' && !(OPEN_JOB[job.status] || job.status === 'DONE')) {
        return tx.error('BAD_STATE', `ใบงาน ${job.jobNo} ${JOB_STATUS[job.status]} – บันทึกส่งมอบไม่ได้`);
      }
      const notIssued = job.lines.filter((l) => !l.output && l.issued < l.required).map((l) => `${l.code} ${l.issued}/${l.required}`);
      if (notIssued.length) tx.warn(`ปิดงานทั้งที่ยังเบิกไม่ครบ: ${notIssued.join(', ')}`);
      const released = releaseJob(tx, job, status === 'DONE' ? 'ปิดงาน: ผลิตเสร็จ' : 'ปิดงาน: ส่งมอบแล้ว');
      job.status = status;
      if (status === 'DONE') { job.doneBy = tx.userId; job.doneAt = tx.now; } else { job.deliveredBy = tx.userId; job.deliveredAt = tx.now; }
      addLog(job, tx, 'status', `${JOB_STATUS[status]}${released.length ? ' ปล่อยของจอง ' + released.length + ' ใบ' : ''}`);
      tx.put('jobs', job.jobNo, job);
      tx.result.released = released;
      tx.summary = `ใบงาน ${job.jobNo} ${JOB_STATUS[status]}`;
    },
  });

  define('job.cancel', {
    label: 'ยกเลิกใบงาน', perm: 'job.manage',
    prepare(tx, p) {
      const job = getJob(tx, p.jobNo);
      if (!job) return;
      if (job.status === 'CANCELLED') return tx.error('ALREADY_CANCELLED', `ใบงาน ${job.jobNo} ยกเลิกไปแล้ว`);
      if (job.status === 'DELIVERED') return tx.error('BAD_STATE', `ใบงาน ${job.jobNo} ส่งมอบแล้ว – ยกเลิกไม่ได้`);
      const reason = util.trim(p.reason);
      if (!reason) return tx.error('REQUIRED', 'ระบุเหตุผลการยกเลิกงาน', { field: 'reason' });
      const outstanding = job.lines.filter((l) => !l.output && l.issued > 0).map((l) => ({ line: l.line, code: l.code, issued: l.issued }));
      if (outstanding.length) {
        const list = outstanding.map((o) => `${o.code} ${o.issued}`).join(', ');
        if (!yes(p.force)) {
          return tx.error('ISSUED_NOT_RETURNED', `ใบงาน ${job.jobNo} ยังมีของที่เบิกไปและยังไม่คืน: ${list} – คืนของเหลือ (RT) ก่อน หรือยกเลิกแบบบังคับพร้อมเหตุผล`);
        }
        if (reason.length < 5) return tx.error('REQUIRED', 'ยกเลิกแบบบังคับต้องระบุเหตุผลให้ชัดเจน', { field: 'reason' });
        if (!tx.different(job.createdBy, 'ผู้ยกเลิกแบบบังคับ (งานมีของเบิกค้าง)')) return;
        job.forced = { by: tx.userId, at: tx.now, reason, outstanding };
      }
      const released = releaseJob(tx, job, 'ยกเลิกงาน: ' + reason);
      job.status = 'CANCELLED';
      job.cancelledBy = tx.userId;
      job.cancelledAt = tx.now;
      job.cancelReason = reason;
      addLog(job, tx, 'cancel', `${reason}${job.forced ? ' (บังคับ)' : ''}${released.length ? ' ปล่อยของจอง ' + released.length + ' ใบ' : ''}`);
      tx.put('jobs', job.jobNo, job);
      tx.result.released = released;
      tx.summary = `ยกเลิกใบงาน ${job.jobNo}${job.forced ? ' (บังคับ)' : ''} คืนยอดจอง ${released.length} ใบ`;
    },
  });

  // ---- reservations ----------------------------------------------------------------------------------------
  define('reserve.create', {
    label: 'จองของให้งาน', perm: 'reserve.manage',
    prepare(tx, p) {
      const job = getJob(tx, p.jobNo);
      if (!job) return;
      if (!needOpen(tx, job, 'จอง')) return;
      const it = tx.item(p.code);
      if (!it) return tx.error('NOT_FOUND', `ไม่พบรหัส ${p.code || '(ว่าง)'} ในทะเบียนสินค้า`, { field: 'code' });
      const jl = compLine(job, it.id);
      if (!jl || !(jl.required > 0)) return tx.error('NOT_IN_JOB', `${it.id} ไม่อยู่ในรายการที่ใบงาน ${job.jobNo} ต้องใช้`, { field: 'code' });
      const wh = checkWh(tx, p.wh, 'reserve.manage', 'wh');
      if (!wh) return;
      const q = util.num(p.qty);
      if (!(q > 0)) return tx.error('BAD_QTY', 'จำนวนจองต้องเป็นตัวเลขมากกว่า 0', { field: 'qty' });
      const f = RRS.unitFactor((t, k) => tx.get(t, k), it, p.unit);
      if (f == null) return tx.error('NO_UNIT', `${it.id} ไม่มีตัวคูณของหน่วย "${p.unit}" (หน่วยหลัก ${it.baseUnit})`, { field: 'unit' });
      const want = round(q * f);
      let needDate = job.dueDate;
      if (p.needDate != null && p.needDate !== '') {
        needDate = parseDate(p.needDate);
        if (!needDate) return tx.error('BAD_DATE', 'วันต้องใช้ต้องเป็นวันที่จริงแบบ YYYY-MM-DD', { field: 'needDate' });
      }
      const priority = parsePriority(p.priority, job.priority);
      if (priority == null) return tx.error('BAD_VALUE', 'ลำดับความสำคัญต้องเป็นเลขเต็ม 1 (สูงสุด) ถึง 5', { field: 'priority' });
      const partial = yes(p.allowPartial);
      const need = lineNeed(tx, job, jl);
      if (need <= 0) return tx.error('OVER_NEED', `${it.id} ของใบงาน ${job.jobNo} จอง/เบิกครบแล้ว (ต้องใช้ ${jl.required} เบิกแล้ว ${jl.issued})`, { field: 'qty' });
      let qty = want;
      if (qty > need) {
        if (!partial) return tx.error('OVER_NEED', `จองเกินความต้องการ: ใบงาน ${job.jobNo} ยังต้องการ ${it.id} อีก ${need} ${it.baseUnit} (ขอ ${want})`, { field: 'qty' });
        qty = need;
      }
      const free = freeAt(tx, it.id, wh);
      if (qty > free) {
        if (!partial || free <= 0) {
          return tx.error(free <= 0 ? 'NO_FREE' : 'OVER_FREE', `${it.id} คลัง ${wh} พร้อมเบิก (หักที่จองให้งานอื่นแล้ว) ${Math.max(0, free)} ${it.baseUnit} – ขอจอง ${qty}${free > 0 ? ' (เลือก "จองเท่าที่มี" เพื่อจองบางส่วน)' : ''}`, { field: 'qty' });
        }
        qty = free;
      }
      const r = newReservation(tx, job, jl, wh, qty, { requested: want, needDate, priority });
      Object.assign(tx.result, { id: r.id, qty: r.qty, requested: want, partial: r.qty < want, short: round(want - r.qty) });
      tx.summary = `จอง ${r.id} ${it.id} ${r.qty} ${it.baseUnit} คลัง ${wh} ให้ ${job.jobNo}${r.qty < want ? ' (บางส่วน จากที่ขอ ' + want + ')' : ''}`;
    },
  });

  define('reserve.change', {
    label: 'เปลี่ยนการจัดสรรของจอง', perm: 'reserve.manage',
    prepare(tx, p) {
      const r0 = tx.get('reservations', util.trim(p.id));
      if (!r0) return tx.error('NOT_FOUND', `ไม่พบใบจอง ${p.id || '(ว่าง)'}`, { field: 'id' });
      if (!isOpenRes(r0)) return tx.error('BAD_STATE', `${r0.id} ${RES_STATUS[r0.status]} – เปลี่ยนไม่ได้`);
      const job = tx.get('jobs', r0.jobNo);
      if (!job || !OPEN_JOB[job.status]) return tx.error('JOB_CLOSED', `ใบงาน ${r0.jobNo} ปิดแล้ว – เปลี่ยนการจองไม่ได้`);
      if (!tx.can('reserve.manage', r0.wh)) return tx.need('reserve.manage', r0.wh, { field: 'wh' });
      const it = tx.get('items', r0.code) || { id: r0.code, baseUnit: '' };
      let qty = r0.qty;
      if (p.qty != null && p.qty !== '') {
        qty = util.num(p.qty);
        if (isNaN(qty) || qty <= 0) return tx.error('BAD_QTY', 'จำนวนจองต้องมากกว่า 0 (ถ้าไม่ต้องการแล้วให้ปล่อยการจอง)', { field: 'qty' });
        qty = round(qty);
      }
      if (qty < r0.issued) return tx.error('BELOW_ISSUED', `${r0.id} เบิกไปแล้ว ${r0.issued} – ลดยอดจองต่ำกว่านี้ไม่ได้`, { field: 'qty' });
      let wh = r0.wh;
      if (p.wh != null && util.trim(p.wh) !== '') {
        wh = checkWh(tx, p.wh, 'reserve.manage', 'wh');
        if (!wh) return;
      }
      if (wh !== r0.wh && r0.issued > 0) {
        return tx.error('PARTLY_ISSUED', `${r0.id} เบิกจากคลัง ${r0.wh} ไปแล้ว ${r0.issued} – ย้ายคลังไม่ได้ ให้ปล่อยส่วนที่เหลือแล้วจองใหม่`, { field: 'wh' });
      }
      let needDate = r0.needDate;
      if (p.needDate != null && p.needDate !== '') {
        needDate = parseDate(p.needDate);
        if (!needDate) return tx.error('BAD_DATE', 'วันต้องใช้ต้องเป็นวันที่จริงแบบ YYYY-MM-DD', { field: 'needDate' });
      }
      const priority = parsePriority(p.priority, r0.priority);
      if (priority == null) return tx.error('BAD_VALUE', 'ลำดับความสำคัญต้องเป็นเลขเต็ม 1 (สูงสุด) ถึง 5', { field: 'priority' });
      if (qty === r0.qty && wh === r0.wh && needDate === r0.needDate && priority === r0.priority) return tx.error('NOTHING', 'ไม่มีอะไรเปลี่ยน');
      const oldRem = remaining(r0);
      const newRem = round(qty - r0.issued);
      if (wh !== r0.wh || newRem > oldRem) {
        const free = freeAt(tx, r0.code, wh, r0.id);
        if (newRem > free) {
          return tx.error(free <= 0 ? 'NO_FREE' : 'OVER_FREE', `${r0.code} คลัง ${wh} พร้อมเบิก (หักที่จองให้งานอื่นแล้ว) ${Math.max(0, free)} ${it.baseUnit} – ต้องการถือไว้ ${newRem}`, { field: 'qty' });
        }
      }
      if (newRem > oldRem) {
        const jl = compLine(job, r0.code);
        const need = jl ? lineNeed(tx, job, jl, r0.id) : 0;
        if (newRem > need) return tx.error('OVER_NEED', `จองเกินความต้องการ: ใบงาน ${job.jobNo} ยังต้องการ ${r0.code} อีก ${need} ${it.baseUnit}`, { field: 'qty' });
      }
      const nr = clone(r0);
      nr.changes = (nr.changes || []).concat([{ at: tx.now, by: tx.userId, fromQty: r0.qty, toQty: qty, fromWh: r0.wh, toWh: wh,
        reason: util.trim(p.reason) }]);
      Object.assign(nr, { qty, wh, needDate, priority, updatedBy: tx.userId, updatedAt: tx.now });
      nr.status = resStatus(nr);
      tx.put('reservations', nr.id, nr);
      Object.assign(tx.result, { id: nr.id, qty, wh, status: nr.status });
      tx.summary = `เปลี่ยนจอง ${nr.id} ${r0.code}: ${r0.qty}@${r0.wh} → ${qty}@${wh}`;
    },
  });

  define('reserve.release', {
    label: 'ปล่อยการจอง', perm: 'reserve.manage',
    prepare(tx, p) {
      const r = tx.get('reservations', util.trim(p.id));
      if (!r) return tx.error('NOT_FOUND', `ไม่พบใบจอง ${p.id || '(ว่าง)'}`, { field: 'id' });
      if (!isOpenRes(r)) return tx.error('BAD_STATE', `${r.id} ${RES_STATUS[r.status]} – ปล่อยซ้ำไม่ได้`);
      if (!tx.can('reserve.manage', r.wh)) return tx.need('reserve.manage', r.wh, { field: 'wh' });
      const reason = util.trim(p.reason);
      if (!reason) return tx.error('REQUIRED', 'ระบุเหตุผลการปล่อยการจอง', { field: 'reason' });
      const left = remaining(r);
      releaseRes(tx, r, reason);
      Object.assign(tx.result, { id: r.id, released: left });
      tx.summary = `ปล่อยจอง ${r.id} ${r.code} ${left} คลัง ${r.wh} (${r.jobNo})`;
    },
  });

  define('reserve.auto', {
    label: 'จองอัตโนมัติจากของพร้อมเบิก', perm: 'reserve.manage',
    prepare(tx, p) {
      let jobs;
      if (p.jobNo) {
        const j = getJob(tx, p.jobNo);
        if (!j) return;
        if (!needOpen(tx, j, 'จอง')) return;
        jobs = [j];
      } else {
        jobs = tx.all('jobs', (j) => OPEN_JOB[j.status]).sort(jobOrder);
      }
      const whs = tx.all('warehouses', (w) => w.active !== false && w.code !== TRANSIT && tx.can('reserve.manage', w.code))
        .map((w) => w.code).sort();
      const created = [];
      const short = [];
      for (const job of jobs) {
        for (const jl of job.lines) {
          if (jl.output) continue;
          // pieces still to be made in-house for this line are not taken from stock now
          let need = pos0(jl.required - jl.issued - jobReserved(tx, job.jobNo, jl.code) - Math.max(0, jl.toMake - jl.received));
          if (need <= 0) continue;
          for (const wh of whs) {
            if (need <= 0) break;
            const free = freeAt(tx, jl.code, wh);
            if (free <= 0) continue;
            const q = Math.min(need, free);
            const r = newReservation(tx, job, jl, wh, q, { auto: true });
            created.push({ id: r.id, jobNo: job.jobNo, code: jl.code, wh, qty: r.qty });
            need = round(need - q);
          }
          if (need > 0) short.push({ jobNo: job.jobNo, line: jl.line, code: jl.code, short: need });
        }
      }
      if (!created.length) {
        return tx.error('NOTHING', short.length ? `ไม่มีของพร้อมเบิกให้จองเพิ่ม – ยังขาด ${short.map((s) => `${s.jobNo} ${s.code} ${s.short}`).join(', ')}` : 'ทุกบรรทัดจอง/เบิกครบแล้ว');
      }
      Object.assign(tx.result, { created, short });
      tx.summary = `จองอัตโนมัติ ${created.length} ใบ${p.jobNo ? ' ให้ ' + jobs[0].jobNo : ''}${short.length ? ' ยังขาด ' + short.length + ' รายการ' : ''}`;
    },
  });

  // ---- picking against reservations ----------------------------------------------------------------------
  define('pick.post', {
    label: 'บันทึกหยิบตามใบจัดชุด', perm: 'pick.post',
    prepare(tx, p) {
      const job = getJob(tx, p.jobNo);
      if (!job) return;
      if (!needOpen(tx, job, 'หยิบ/เบิก')) return;
      if (job.product && job.bomRev) {
        const appr = txApprovedBom(tx, job.product);
        if (!appr || appr.rev !== job.bomRev) {
          return tx.error('BOM_CHANGED', `BOM เปลี่ยนฉบับ: ใบงาน ${job.jobNo} ใช้ ${job.product} ฉบับ ${job.bomRev} แต่ฉบับที่อนุมัติตอนนี้คือ ${appr ? appr.rev : '(ไม่มี)'} – ให้วางแผนตรวจใบงานก่อนหยิบ`);
        }
      }
      if (!Array.isArray(p.lines) || !p.lines.length) return tx.error('NO_LINES', 'ใบหยิบยังไม่มีบรรทัด');
      const used = {};
      const lines = [];
      p.lines.forEach((l, i) => {
        const n = i + 1;
        const where = { line: n };
        const r = tx.get('reservations', util.trim(l && l.reservationId));
        if (!r) return tx.error('NOT_FOUND', `บรรทัด ${n}: ไม่พบใบจอง ${(l && l.reservationId) || '(ว่าง)'}`, Object.assign({ field: 'reservationId' }, where));
        if (r.jobNo !== job.jobNo) return tx.error('WRONG_JOB', `บรรทัด ${n}: ใบจอง ${r.id} เป็นของใบงาน ${r.jobNo} ไม่ใช่ ${job.jobNo}`, where);
        if (!isOpenRes(r)) return tx.error('BAD_STATE', `บรรทัด ${n}: ใบจอง ${r.id} ${RES_STATUS[r.status]} – หยิบไม่ได้`, where);
        const it = tx.get('items', r.code) || tx.item(r.code);
        if (!it) return tx.error('NOT_FOUND', `บรรทัด ${n}: ไม่พบสินค้า ${r.code}`, where);
        const sc = util.trim(l.scannedCode);
        if (sc) {
          const got = tx.item(sc);
          if (!got || got.id !== it.id) {
            const model = got && got.model && it.model && got.model !== it.model ? ` รุ่น ${got.model} ไม่ใช่ ${it.model}` : '';
            return tx.error('WRONG_ITEM', `บรรทัด ${n}: สแกนได้ ${sc}${got ? ' = ' + got.id + ' ' + got.name : ' (ไม่พบในทะเบียน)'}${model} แต่ใบจองคือ ${it.id} ${it.name}`, Object.assign({ field: 'scannedCode' }, where));
          }
        }
        const ss = util.normCode(l.scannedSide);
        if (ss && ss !== (it.side || '')) {
          return tx.error('WRONG_SIDE', `บรรทัด ${n}: ข้างไม่ตรง – สแกนข้าง ${ss} แต่ ${it.id} เป็น${it.side ? 'ข้าง ' + it.side : 'ชิ้นที่ไม่มีข้าง'}`, Object.assign({ field: 'scannedSide' }, where));
        }
        const wh = util.normCode(l.wh) || r.wh;
        if (wh !== r.wh) return tx.error('WRONG_WH', `บรรทัด ${n}: ใบจอง ${r.id} จองไว้ที่คลัง ${r.wh} ไม่ใช่ ${wh}`, Object.assign({ field: 'wh' }, where));
        if (!tx.can('pick.post', wh)) return tx.need('pick.post', wh, Object.assign({ field: 'wh' }, where));
        const q = util.num(l.qty);
        if (!(q > 0)) return tx.error('BAD_QTY', `บรรทัด ${n}: จำนวนหยิบต้องเป็นตัวเลขมากกว่า 0`, Object.assign({ field: 'qty' }, where));
        const f = RRS.unitFactor((t, k) => tx.get(t, k), it, l.unit);
        if (f == null) return tx.error('NO_UNIT', `บรรทัด ${n}: ${it.id} ไม่มีตัวคูณของหน่วย "${l.unit}"`, Object.assign({ field: 'unit' }, where));
        const base = round(q * f);
        used[r.id] = round((used[r.id] || 0) + base);
        if (used[r.id] > remaining(r)) {
          return tx.error('OVER_PICK', `บรรทัด ${n}: หยิบเกินยอดจอง – ใบจอง ${r.id} เหลือ ${remaining(r)} ${it.baseUnit} (หยิบรวม ${used[r.id]})`, Object.assign({ field: 'qty' }, where));
        }
        lines.push({ code: it.id, qty: base, unit: it.baseUnit, wh, bin: util.normCode(l.bin), lot: util.trim(l.lot),
          reservationId: r.id, remark: util.trim(l.remark) });
      });
      if (!tx.ok) return;
      const row = inv.post(tx, newPickDoc(tx, job, lines, util.trim(p.remark)));
      if (!row) return;
      tx.result.docNo = row.docNo;
      tx.summary = `หยิบตามใบจัดชุด ${job.jobNo} → ${row.docNo} ${lines.length} บรรทัด`;
    },
  });

  // ---- stock kept for other jobs (inventory checks every outgoing AVAILABLE line with this) ---------------
  inv.reservedElsewhere(function reservedForOthers(tx, code, wh, doc, line) {
    if (EXEMPT_TYPES[doc && doc.type]) return 0;
    if (doc && doc.type === 'TR') {
      // reservations are per warehouse: moving stock between bins of the same warehouse keeps it for its jobs
      const same = (doc.lines || []).filter((l) => {
        const it = tx.item(l.code);
        return it && it.id === code && util.normCode(l.wh) === wh;
      });
      if (same.length && same.every((l) => util.normCode(l.toWh) === wh)) return 0;
    }
    const jn = jobOf(doc, line);
    const own = jn && tx.get('jobs', jn) ? jn : '';
    const rid = (line && line.reservationId) || '';
    let s = 0;
    for (const r of tx.all('reservations', (x) => x.code === code && x.wh === wh && isOpenRes(x))) {
      if (own && r.jobNo === own) continue;
      if (rid && r.id === rid) continue;
      s += remaining(r);
    }
    return round(s);
  });

  // ---- document hooks --------------------------------------------------------------------------------------
  RRS.hooks.on('doc.lineCheck', function planningLineCheck(tx, doc, line) {
    const n = line.line;
    const where = { line: n };
    if (doc.job && line.jobNo && jobKey(doc.job) !== jobKey(line.jobNo)) {
      return tx.error('JOB_MISMATCH', `บรรทัด ${n}: งานของบรรทัด (${line.jobNo}) ไม่ตรงกับงานของเอกสาร (${doc.job})`, where);
    }
    const jn = jobOf(doc, line);
    if (line.reservationId) {
      const r = tx.get('reservations', line.reservationId);
      if (!r) return tx.error('NOT_FOUND', `บรรทัด ${n}: ไม่พบใบจอง ${line.reservationId}`, Object.assign({ field: 'reservationId' }, where));
      if (!CONSUME_TYPES[doc.type]) return tx.error('BAD_INPUT', `บรรทัด ${n}: ใบจองใช้ได้กับใบเบิก/ส่งมอบเท่านั้น`, where);
      if (r.jobNo !== jn) return tx.error('WRONG_JOB', `บรรทัด ${n}: ใบจอง ${r.id} เป็นของใบงาน ${r.jobNo}${jn ? ' ไม่ใช่ ' + jn : ' – ระบุงานในเอกสาร'}`, where);
      if (r.code !== line.code) return tx.error('WRONG_ITEM', `บรรทัด ${n}: ใบจอง ${r.id} เป็นของ ${r.code} ไม่ใช่ ${line.code}`, where);
      if (r.wh !== line.wh) return tx.error('WRONG_WH', `บรรทัด ${n}: ใบจอง ${r.id} จองไว้ที่คลัง ${r.wh} ไม่ใช่ ${line.wh}`, where);
      if (!isOpenRes(r)) return tx.error('BAD_STATE', `บรรทัด ${n}: ใบจอง ${r.id} ${RES_STATUS[r.status]}`, where);
    }
    if (!jn) return;
    const job = tx.get('jobs', jn);
    if (!job) return; // free-text job of an older document: not linked
    if (ISSUE_TYPES[doc.type]) {
      if (!OPEN_JOB[job.status]) return tx.error('JOB_CLOSED', `บรรทัด ${n}: ใบงาน ${jn} ${JOB_STATUS[job.status]} – เบิกเข้างานไม่ได้`, where);
      if (job.product && line.code === job.product) return tx.error('OWN_PRODUCT', `บรรทัด ${n}: ${line.code} เป็นสินค้าที่ใบงาน ${jn} ผลิตเอง – เบิกเข้างานตัวเองไม่ได้`, where);
    } else if (doc.type === 'FR') {
      const jl = madeLine(job, line.code);
      if (!jl || !(jl.toMake > 0)) return tx.error('NOT_MADE', `บรรทัด ${n}: ใบงาน ${jn} ไม่ได้ผลิต ${line.code}`, where);
      const left = pos0(jl.finished - jl.received);
      if (line.base > left) {
        return tx.error('FR_OVER', `บรรทัด ${n}: ใบงาน ${jn} ${line.code} ผลิตเสร็จ ${jl.finished} รับแล้ว ${jl.received} – รับได้อีก ${left} (บันทึกผลิตเสร็จก่อนรับเข้า)`, Object.assign({ field: 'qty' }, where));
      }
    } else if (doc.type === 'RT') {
      const jl = compLine(job, line.code);
      const issued = jl ? jl.issued : 0;
      if (line.base > issued) {
        return tx.error('RT_OVER', `บรรทัด ${n}: ใบงาน ${jn} เบิก ${line.code} ไป ${issued} – คืนเกินกว่าที่เบิกไม่ได้`, Object.assign({ field: 'qty' }, where));
      }
    }
  });

  RRS.hooks.on('doc.check', function planningDocCheck(tx, doc, lines) {
    if (doc.type !== 'FR' && doc.type !== 'RT') return;
    const groups = {};
    for (const ln of lines) {
      const jn = jobOf(doc, ln);
      const job = jn && tx.get('jobs', jn);
      if (!job) continue;
      const k = jn + '|' + ln.code;
      (groups[k] || (groups[k] = { job, code: ln.code, sum: 0, lines: [] })).sum += ln.base;
      groups[k].lines.push(ln.line);
    }
    for (const k in groups) {
      const g = groups[k];
      if (g.lines.length < 2) continue;
      const sum = round(g.sum);
      if (doc.type === 'FR') {
        const jl = madeLine(g.job, g.code);
        const left = jl ? pos0(jl.finished - jl.received) : 0;
        if (sum > left) tx.error('FR_OVER', `บรรทัด ${g.lines.join(', ')}: ใบงาน ${g.job.jobNo} ${g.code} รับรวม ${sum} เกินที่ผลิตเสร็จรอรับ ${left}`, { line: g.lines[0] });
      } else {
        const jl = compLine(g.job, g.code);
        const issued = jl ? jl.issued : 0;
        if (sum > issued) tx.error('RT_OVER', `บรรทัด ${g.lines.join(', ')}: ใบงาน ${g.job.jobNo} ${g.code} คืนรวม ${sum} เกินที่เบิกไป ${issued}`, { line: g.lines[0] });
      }
    }
  });

  /** Take `ln.base` from the job's reservations (line's reservation first, then oldest of code + wh). */
  function consume(tx, jn, ln, doc) {
    let q = round(ln.base);
    const use = [];
    const take = (r) => {
      const t = Math.min(q, remaining(r));
      if (!(t > 0)) return;
      const nr = clone(r);
      nr.issued = round(nr.issued + t);
      nr.uses = (nr.uses || []).concat([{ docNo: doc.docNo, docType: doc.type, line: ln.line, qty: round(t), at: tx.now, by: tx.userId }]);
      nr.status = resStatus(nr);
      tx.put('reservations', nr.id, nr);
      use.push({ id: nr.id, qty: round(t) });
      q = round(q - t);
    };
    if (ln.reservationId) {
      const r = tx.get('reservations', ln.reservationId);
      if (r && r.jobNo === jn && r.code === ln.code && r.wh === ln.wh) take(r);
    }
    if (q > 0) {
      const rs = tx.all('reservations', (x) => x.jobNo === jn && x.code === ln.code && x.wh === ln.wh && isOpenRes(x)
        && x.id !== ln.reservationId).sort(byCreated);
      for (const r of rs) {
        if (q <= 0) break;
        take(r);
      }
    }
    return use;
  }

  RRS.hooks.on('doc.posted', function planningPosted(tx, doc, lines) {
    const t = doc.type;
    if (!CONSUME_TYPES[t] && t !== 'FR' && t !== 'RT') return;
    const jobs = {};
    const used = [];
    for (const ln of lines) {
      const jn = jobOf(doc, ln);
      if (!jn) continue;
      if (!jobs[jn]) {
        const j = tx.get('jobs', jn);
        if (!j) continue;
        jobs[jn] = clone(j);
      }
      const job = jobs[jn];
      if (CONSUME_TYPES[t]) {
        for (const u of consume(tx, jn, ln, doc)) used.push(u);
        let jl = compLine(job, ln.code);
        if (!jl && !ISSUE_TYPES[t]) continue;
        if (!jl) {
          jl = { line: Math.max.apply(null, job.lines.map((l) => l.line).concat([0])) + 1, code: ln.code, per: 0, required: 0,
            issued: 0, toMake: 0, finished: 0, received: 0, note: 'เบิกนอกแผน', extra: true };
          job.lines.push(jl);
        }
        jl.issued = round(jl.issued + ln.base);
        if (job.status === 'OPEN' && ISSUE_TYPES[t]) job.status = 'IN_PROGRESS';
      } else if (t === 'RT') {
        const jl = compLine(job, ln.code);
        if (jl) jl.issued = round(jl.issued - ln.base);
      } else {
        const jl = madeLine(job, ln.code);
        if (jl) jl.received = round(jl.received + ln.base);
      }
    }
    for (const jn in jobs) tx.put('jobs', jn, jobs[jn]);
    if (used.length) tx.result.reservationsUsed = used;
  });

  RRS.hooks.on('doc.cancelled', function planningCancelled(tx, doc, lines) {
    const t = doc.type;
    if (!CONSUME_TYPES[t] && t !== 'FR' && t !== 'RT') return;
    const jobs = {};
    const jobFor = (jn) => {
      if (!jobs[jn]) {
        const j = tx.get('jobs', jn);
        if (!j) return null;
        jobs[jn] = clone(j);
      }
      return jobs[jn];
    };
    if (CONSUME_TYPES[t]) {
      // give back what this document took from reservations (net of its uses), history kept as a negative use
      for (const r of tx.all('reservations', (x) => (x.uses || []).some((u) => u.docNo === doc.docNo && u.docType === doc.type))) {
        const net = round((r.uses || []).filter((u) => u.docNo === doc.docNo && u.docType === doc.type).reduce((s, u) => s + u.qty, 0));
        if (!(net > 0)) continue;
        const nr = clone(r);
        nr.issued = round(nr.issued - net);
        nr.uses = nr.uses.concat([{ docNo: doc.docNo, docType: doc.type, line: '', qty: -net, at: tx.now, by: tx.userId, reversal: true }]);
        const job = tx.get('jobs', r.jobNo);
        if (nr.status !== 'RELEASED' && !(job && OPEN_JOB[job.status])) {
          // the job is closed: do not lock stock for it again
          Object.assign(nr, { status: 'RELEASED', releasedBy: tx.userId, releasedAt: tx.now, releasedQty: 0,
            reason: `ยกเลิก ${doc.docNo} หลังปิดงาน` });
        } else {
          nr.status = resStatus(nr);
        }
        tx.put('reservations', nr.id, nr);
      }
    }
    for (const ln of lines) {
      const jn = jobOf(doc, ln);
      if (!jn) continue;
      const job = jobFor(jn);
      if (!job) continue;
      if (CONSUME_TYPES[t]) {
        const jl = compLine(job, ln.code);
        if (!jl) continue;
        const next = round(jl.issued - ln.base);
        if (next < 0) {
          tx.error('RETURNED', `ยกเลิก ${doc.docNo} ไม่ได้: ใบงาน ${jn} ${ln.code} คืนของ (RT) ไปแล้ว – ยกเลิกใบคืนก่อน`, { line: ln.line });
          continue;
        }
        jl.issued = next;
      } else if (t === 'RT') {
        const jl = compLine(job, ln.code);
        if (jl) jl.issued = round(jl.issued + ln.base);
      } else {
        const jl = madeLine(job, ln.code);
        if (!jl) continue;
        jl.received = pos0(jl.received - ln.base);
      }
    }
    for (const jn in jobs) tx.put('jobs', jn, jobs[jn]);
  });

  // ---- read helpers (pure functions of a state) ----------------------------------------------------------
  const P = (RRS.planning = RRS.planning || {});
  Object.assign(P, { JOB_STATUS, RES_STATUS, READY, SIX_LABELS, ISSUE_TYPES, CONSUME_TYPES, EXEMPT_TYPES, remaining,
    isOpen: isOpenRes });

  const rows = (state, t, f) => RRS.q.rows(state, t, f);

  P.approvedBom = function approvedBom(state, product) {
    return rows(state, 'boms', (b) => b.product === product && b.status === 'APPROVED')[0] || null;
  };

  /** Free AVAILABLE stock of one code in one warehouse (negative = more reserved than is there). */
  P.free = function free(state, code, wh) {
    let res = 0;
    for (const r of rows(state, 'reservations', (x) => x.code === code && x.wh === wh && isOpenRes(x))) res += remaining(r);
    return round(RRS.q.qty(state, { code, wh, status: STATUS.AVAILABLE }) - res);
  };

  function emptyRow(items, code) {
    const it = items[code] || {};
    return { code, name: it.name || '', baseUnit: it.baseUnit || '', onHand: 0, available: 0, qcHold: 0, transit: 0,
      reserved: 0, free: 0, overReserved: 0, wip: 0, waitingReceipt: 0, incoming: 0, lateIncoming: 0, nextIncomingDate: '',
      demand: 0, short: 0, flags: [] };
  }
  /** Per-code aggregates over the whole state (or one warehouse / one code). */
  function aggregate(state, opts) {
    const codeF = opts.code || '';
    const whF = opts.wh || '';
    const today = opts.today || '';
    const items = state.tables.items || {};
    const out = {};
    const row = (code) => out[code] || (out[code] = Object.assign(emptyRow(items, code), { _wh: {} }));
    const whRow = (r, wh) => r._wh[wh] || (r._wh[wh] = { available: 0, reserved: 0 });
    for (const b of rows(state, 'balances')) {
      if (codeF && b.code !== codeF) continue;
      if (b.wh === TRANSIT) {
        if (!whF) row(b.code).transit = round(row(b.code).transit + b.qty);
        continue;
      }
      if (whF && b.wh !== whF) continue;
      const r = row(b.code);
      r.onHand = round(r.onHand + b.qty);
      if (b.status === STATUS.AVAILABLE) {
        r.available = round(r.available + b.qty);
        const w = whRow(r, b.wh);
        w.available = round(w.available + b.qty);
      } else if (HOLD.indexOf(b.status) >= 0) {
        r.qcHold = round(r.qcHold + b.qty);
      }
    }
    for (const rs of rows(state, 'reservations', isOpenRes)) {
      if (codeF && rs.code !== codeF) continue;
      if (whF && rs.wh !== whF) continue;
      const rem = remaining(rs);
      if (!rem) continue;
      const r = row(rs.code);
      r.reserved = round(r.reserved + rem);
      const w = whRow(r, rs.wh);
      w.reserved = round(w.reserved + rem);
    }
    for (const j of rows(state, 'jobs', (x) => OPEN_JOB[x.status])) {
      for (const l of j.lines || []) {
        if (codeF && l.code !== codeF) continue;
        const wip = pos0(l.toMake - l.finished);
        const wait = pos0(l.finished - l.received);
        const dem = l.output ? 0 : pos0(l.required - l.issued);
        if (!wip && !wait && !dem) continue;
        const r = row(l.code);
        r.wip = round(r.wip + wip);
        r.waitingReceipt = round(r.waitingReceipt + wait);
        r.demand = round(r.demand + dem);
      }
    }
    for (const po of rows(state, 'pos', (x) => x.status === 'ISSUED' || x.status === 'PARTIAL')) {
      for (const l of po.lines || []) {
        if (codeF && l.code !== codeF) continue;
        if (whF && l.wh && l.wh !== whF) continue;
        const base = l.base != null ? Number(l.base) : Number(l.qty || 0) * Number(l.factor || 1);
        const out2 = pos0(base - (l.received || 0) - (l.cancelled || 0));
        if (!out2) continue;
        const r = row(l.code);
        r.incoming = round(r.incoming + out2);
        const due = String(l.dueDate || po.dueDate || '').slice(0, 10);
        if (due && (!r.nextIncomingDate || due < r.nextIncomingDate)) r.nextIncomingDate = due;
        if (due && today && due < today) r.lateIncoming = round(r.lateIncoming + out2);
      }
    }
    for (const code in out) {
      const r = out[code];
      for (const wh in r._wh) {
        const w = r._wh[wh];
        const f = round(w.available - w.reserved);
        if (f >= 0) r.free = round(r.free + f);
        else r.overReserved = round(r.overReserved - f);
      }
      delete r._wh;
      r.short = pos0(r.demand - r.reserved - Math.max(0, r.free));
      if (r.overReserved > 0) r.flags.push(`จองเกินของพร้อมใช้ ${r.overReserved}`);
      if (r.short > 0) r.flags.push(`ขาด ${r.short}`);
      if (r.lateIncoming > 0) r.flags.push(`ของเข้าช้ากว่ากำหนด ${r.lateIncoming}`);
    }
    return out;
  }

  /**
   * The six stock boxes per item: onHand (all statuses, no TRANSIT), available (AVAILABLE), qcHold (QC_HOLD + QUARANTINE
   * + REWORK), reserved (open reservations), free (available − reserved, per warehouse, never below 0 – the excess is
   * overReserved + a flag), wip (open jobs toMake − finished), incoming (outstanding ISSUED/PARTIAL PO lines) with
   * nextIncomingDate, demand (open job lines required − issued), short = max(0, demand − reserved − free).
   * opts: {code?, wh?, today (YYYY-MM-DD, for late PO lines), all? (every active item, also when all zero)}.
   * wip and demand belong to no warehouse: they are shown in full also with a warehouse filter.
   */
  P.six = function six(state, opts) {
    opts = opts || {};
    let code = '';
    if (opts.code) {
      const it = RRS.q.item(state, opts.code);
      if (!it) return [];
      code = it.id;
    }
    const agg = aggregate(state, { code, wh: util.normCode(opts.wh), today: opts.today });
    const items = state.tables.items || {};
    if (code && !agg[code]) agg[code] = emptyRow(items, code);
    if (opts.all && !code) {
      for (const id in items) if (items[id].active !== false && !agg[id]) agg[id] = emptyRow(items, id);
    }
    return Object.values(agg).sort((a, b) => a.code.localeCompare(b.code));
  };

  /** Open jobs of a state, highest priority first, then due date. */
  P.jobs = function jobs(state, f) {
    f = f || {};
    return rows(state, 'jobs', (j) => (f.status ? j.status === f.status : f.open ? OPEN_JOB[j.status] : true)
      && (!f.soNo || j.soNo === util.normCode(f.soNo))).sort(jobOrder);
  };
  /** Reservations filtered by {jobNo, code, wh, open}. Oldest first. */
  P.reservations = function reservations(state, f) {
    f = f || {};
    return rows(state, 'reservations', (r) => (!f.jobNo || r.jobNo === jobKey(f.jobNo)) && (!f.code || r.code === f.code)
      && (!f.wh || r.wh === f.wh) && (!f.open || isOpenRes(r))).sort(byCreated);
  };

  /**
   * What each line of a job still lacks. Per component line: required, issued, reservedRemaining (open reservations of
   * this job), unreserved, freeNow (free stock of the code, all warehouses), allocated (part of freeNow left for this job
   * after open jobs with a higher priority / earlier due date), toReserve, missing (= unreserved − allocated), wip
   * (six(): all open jobs, toMake − finished), waitingReceipt, qcHold, incoming, nextIncomingDate, makeLeft (this line's
   * own toMake − finished), inProduction (this line's own toMake − received + what other open jobs make of the code as
   * their product; pieces other jobs make for their own lines are theirs) and status พร้อม / รอตรวจ / ระหว่างผลิต / ขาด
   * (statusCode READY / QC / WIP / SHORT). Returns null for an unknown job.
   */
  P.readiness = function readiness(state, jobNo, opts) {
    opts = opts || {};
    const job = RRS.q.get(state, 'jobs', jobKey(jobNo));
    if (!job) return null;
    const agg = aggregate(state, { today: opts.today });
    const items = state.tables.items || {};
    const open = rows(state, 'reservations', isOpenRes);
    const resOf = (jn, code) => round(open.filter((r) => r.jobNo === jn && r.code === code).reduce((s, r) => s + remaining(r), 0));
    const openJobs = rows(state, 'jobs', (j) => OPEN_JOB[j.status]).sort(jobOrder);
    const allocFor = (code) => {
      let left = Math.max(0, (agg[code] || {}).free || 0);
      for (const j of openJobs) {
        const jl = compLine(j, code);
        if (!jl) continue;
        const un = pos0(jl.required - jl.issued - resOf(j.jobNo, code));
        const a = Math.min(un, left);
        if (j.jobNo === job.jobNo) return a;
        left = round(left - a);
      }
      return 0;
    };
    const otherOutput = (code) => round(openJobs.reduce((sum, j) => (j.jobNo === job.jobNo ? sum : sum + (j.lines || [])
      .filter((l) => l.output && l.code === code).reduce((t, l) => t + pos0(l.toMake - l.received), 0)), 0));
    const lines = [];
    for (const jl of job.lines || []) {
      if (jl.output) continue;
      const a = agg[jl.code] || {};
      const reservedRemaining = resOf(job.jobNo, jl.code);
      const needLeft = pos0(jl.required - jl.issued);
      const unreserved = pos0(needLeft - reservedRemaining);
      const freeNow = Math.max(0, a.free || 0);
      const allocated = OPEN_JOB[job.status] ? Math.min(unreserved, allocFor(jl.code)) : 0;
      const missing = round(unreserved - allocated);
      const qcHold = a.qcHold || 0;
      const making = round(pos0(jl.toMake - jl.received) + otherOutput(jl.code));
      let statusCode = 'SHORT';
      if (missing <= 0) statusCode = 'READY';
      else if (missing <= qcHold) statusCode = 'QC';
      else if (making > 0 && missing <= qcHold + making) statusCode = 'WIP';
      lines.push({
        line: jl.line, code: jl.code, name: (items[jl.code] || {}).name || '', baseUnit: (items[jl.code] || {}).baseUnit || '',
        required: jl.required, issued: jl.issued, reservedRemaining, unreserved, freeNow, allocated, toReserve: allocated,
        missing, wip: a.wip || 0, waitingReceipt: a.waitingReceipt || 0, qcHold, incoming: a.incoming || 0,
        nextIncomingDate: a.nextIncomingDate || '', makeLeft: pos0(jl.toMake - jl.finished), inProduction: making,
        extra: !!jl.extra, statusCode, status: READY[statusCode],
      });
    }
    const out = (job.lines || []).find((l) => l.output);
    const appr = job.product ? P.approvedBom(state, job.product) : null;
    return {
      jobNo: job.jobNo, soNo: job.soNo, product: job.product, bomRev: job.bomRev,
      bomOk: !job.product || !job.bomRev || (!!appr && appr.rev === job.bomRev), approvedRev: appr ? appr.rev : '',
      status: job.status, statusLabel: JOB_STATUS[job.status], dueDate: job.dueDate, priority: job.priority, lines,
      output: out ? { code: out.code, toMake: out.toMake, finished: out.finished, received: out.received,
        wip: pos0(out.toMake - out.finished), waitingReceipt: pos0(out.finished - out.received) } : null,
      ready: lines.every((l) => l.statusCode === 'READY'),
      missing: lines.filter((l) => l.missing > 0).map((l) => ({ code: l.code, name: l.name, missing: l.missing, status: l.status })),
    };
  };

  /**
   * Pick list of a job: its reservations with something left, each with the bins of that warehouse holding
   * AVAILABLE stock (FIFO by last receipt) and a suggestion of what to take from where.
   */
  P.pickList = function pickList(state, jobNo) {
    const jn = jobKey(jobNo);
    const job = RRS.q.get(state, 'jobs', jn);
    if (!job) return [];
    const items = state.tables.items || {};
    return rows(state, 'reservations', (r) => r.jobNo === jn && remaining(r) > 0)
      .sort((a, b) => String(a.needDate).localeCompare(String(b.needDate)) || a.code.localeCompare(b.code) || a.id.localeCompare(b.id))
      .map((r) => {
        const it = items[r.code] || {};
        const bins = rows(state, 'balances', (b) => b.code === r.code && b.wh === r.wh && b.status === STATUS.AVAILABLE && b.qty > 0)
          .sort((a, b) => String(a.lastIn || '').localeCompare(String(b.lastIn || '')) || a.bin.localeCompare(b.bin) || a.lot.localeCompare(b.lot))
          .map((b) => ({ bin: b.bin, lot: b.lot, qty: b.qty, lastIn: b.lastIn || '' }));
        let left = remaining(r);
        const suggest = [];
        for (const b of bins) {
          if (left <= 0) break;
          const t = Math.min(left, b.qty);
          suggest.push({ bin: b.bin, lot: b.lot, qty: round(t) });
          left = round(left - t);
        }
        return {
          reservationId: r.id, jobNo: jn, soNo: job.soNo, code: r.code, name: it.name || '', baseUnit: it.baseUnit || '',
          side: it.side || '', model: it.model || '', drawingRev: it.drawingRev || '', wh: r.wh, qty: r.qty, issued: r.issued,
          remaining: remaining(r), needDate: r.needDate, priority: r.priority, status: r.status, bins, suggest, notInBins: left,
        };
      });
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
