/*
 * Phase 4 – เติมสต็อกและจัดซื้อครบวงจร (P1).
 *
 * Tables: suppliers (ผู้ขาย), item_suppliers (สินค้า–ผู้ขาย: ราคา หน่วยซื้อ MOQ แพ็ก Lead time), reorder_rules
 * (เงื่อนไขเติมสต็อกรายสินค้า/คลัง), prs (ใบขอซื้อ), pos (ใบสั่งซื้อ) – shapes in ENGINE_CONTRACT.md, extra fields below.
 *
 * Rules (plan file 01, Phase 4):
 *  - PR (DRAFT → SUBMITTED → APPROVED/REJECTED) → PO (DRAFT → ISSUED → PARTIAL → RECEIVED, or CLOSED/CANCELLED).
 *    PR quantities are in the base unit; PO quantities are in the buy unit (item_suppliers.buyUnit, else an item unit,
 *    else the base unit) and every PO line keeps factor + base. An unknown unit is an error, never a guess. A PO line
 *    needs a price (given, or the item–supplier price of that buy unit) and a due date (given, or the PR need date).
 *  - The same person may not approve or reject their own PR (tx.different). Every step keeps who/when in the row
 *    and in `log`. Nothing is deleted: cancelling cancels the outstanding part (cancelled qty) and keeps the lines.
 *  - outstanding = base − received − cancelled (never below 0). A PR line is "ordered" by Σ (base − cancelled) of the
 *    PO lines that point at it, so a cancelled PO gives the quantity back to its PR (the PR can be ordered again).
 *  - Receiving: RR lines may carry poNo + poLine (doc.post or po.receive). The PO must be ISSUED/PARTIAL, the item must
 *    be the PO line's item, and more than outstanding × (1 + overReceivePct/100) + an approved over-receipt
 *    (po.allowOverReceive) needs perm po.overReceive (else OVER_RECEIVE). Posting adds base to received, cancelling
 *    the RR takes it back (same commit as the stock movements). Items with qcIncoming land in QC_HOLD (inventory) and
 *    are never counted as available here.
 *  - Return to vendor: document type RV (dir −1, AVAILABLE/QUARANTINE/REWORK). A line with poNo/poLine adds to the PO
 *    line's returned (at most what the PO delivered and was not returned yet). po.return lines with replace:true also
 *    reopen that quantity as outstanding (received −= qty, replaced += qty). Cancelling the RV undoes it.
 *  - Suggestion (RRS.purchasing.suggest): per active item (per warehouse when asked) – AVAILABLE − open reservations
 *    + stock in transit + PO outstanding due within the lead time (late lines only when policies.lateIsUncertain is
 *    false) − open job demand not covered by reservations = projected. projected ≤ Min → Max − projected, less what is
 *    already asked for in open PRs / draft POs, rounded up to whole buy units, at least MOQ, a multiple of the pack.
 *    Every number has a Thai reason. QC_HOLD / QUARANTINE / REWORK stock is shown but never counted.
 * Read helpers are pure functions of a state; they take an explicit `today` (YYYY-MM-DD).
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { util, schema, commands, STATUS, TRANSIT } = RRS;
  const define = commands.define;
  const inv = RRS.inventory;

  const round = util.round;
  const pos0 = (n) => Math.max(0, round(n));
  const clone = util.clone;
  const EPS = 1e-9;
  const Z = 1.65; // service factor of the usage-based Min (≈ 95 %)
  const DEFAULT_LEAD = 7;
  const DEFAULT_COVER = 14;
  const DEFAULT_USAGE_DAYS = 90;
  const USAGE_TYPES = ['PD', 'OU'];

  RRS.auth.definePerm('reorder.manage', ['purchasing', 'purchasing_lead', 'store_lead', 'planner'], 'ตั้งเงื่อนไขเติมสต็อก');

  inv.defineType('RV', { name: 'คืนสินค้าผู้ขาย', dir: -1, express: false,
    outStatuses: [STATUS.AVAILABLE, STATUS.QUARANTINE, STATUS.REWORK] });

  // ---------------------------------------------------------------------------------------------------------
  // tables (data dictionary / Google Sheet tabs)
  // ---------------------------------------------------------------------------------------------------------
  schema.define('suppliers', {
    label: 'ผู้ขาย', phase: 4, key: 'id',
    fields: [['id', 'text', 'รหัสผู้ขาย'], ['name', 'text', 'ชื่อผู้ขาย'], ['taxId', 'text', 'เลขประจำตัวผู้เสียภาษี (13 หลัก)'],
      ['contact', 'text', 'ผู้ติดต่อ'], ['phone', 'text', 'โทรศัพท์'], ['leadDays', 'number', 'Lead time ของผู้ขาย (วัน)'],
      ['active', 'bool', 'ใช้งาน'], ['updatedBy', 'text', 'ผู้แก้ล่าสุด'], ['updatedAt', 'datetime', 'แก้ล่าสุดเมื่อ']],
  });
  schema.define('item_suppliers', {
    label: 'สินค้า–ผู้ขาย (ราคา หน่วยซื้อ MOQ แพ็ก)', phase: 4, key: ['code', 'supplier'],
    note: 'MOQ และแพ็กเป็นหน่วยซื้อ; ผู้ขายหลัก (preferred) ได้รายเดียวต่อสินค้า',
    fields: [['code', 'text', 'รหัสสินค้า'], ['supplier', 'text', 'รหัสผู้ขาย'], ['price', 'number', 'ราคาต่อหน่วยซื้อ (ว่าง = ยังไม่ทราบ)'],
      ['buyUnit', 'text', 'หน่วยซื้อ'], ['factor', 'number', '1 หน่วยซื้อ = กี่หน่วยหลัก'], ['moq', 'number', 'สั่งขั้นต่ำ (หน่วยซื้อ)'],
      ['pack', 'number', 'จำนวนต่อแพ็ก – สั่งเป็นทวีคูณ (หน่วยซื้อ)'], ['leadDays', 'number', 'Lead time สินค้านี้ (วัน)'],
      ['preferred', 'bool', 'ผู้ขายหลัก'], ['active', 'bool', 'ใช้งาน'], ['updatedBy', 'text', 'ผู้แก้ล่าสุด'],
      ['updatedAt', 'datetime', 'แก้ล่าสุดเมื่อ']],
  });
  schema.define('reorder_rules', {
    label: 'เงื่อนไขเติมสต็อก (สินค้า/คลัง)', phase: 4, key: ['code', 'wh'],
    note: 'คลังว่าง = ทั้งบริษัท; ช่องว่าง = ใช้ค่าจากทะเบียนสินค้า/ผู้ขาย/สถิติยอดใช้',
    fields: [['code', 'text', 'รหัสสินค้า'], ['wh', 'text', 'คลัง (ว่าง = ทุกคลัง)'], ['min', 'number', 'Min (หน่วยหลัก)'],
      ['max', 'number', 'Max (หน่วยหลัก)'], ['leadDays', 'number', 'Lead time (วัน)'], ['supplier', 'text', 'ผู้ขายที่ใช้เติม'],
      ['coverDays', 'number', 'จำนวนวันที่ Max ครอบคลุมเหนือ Min (ค่าเริ่มต้น 14)'],
      ['usageDays', 'number', 'ช่วงวันที่ใช้คิดสถิติยอดใช้ (ค่าเริ่มต้น 90)'], ['active', 'bool', 'เปิดการแนะนำสั่งซื้อ'],
      ['updatedBy', 'text', 'ผู้แก้ล่าสุด'], ['updatedAt', 'datetime', 'แก้ล่าสุดเมื่อ']],
  });
  schema.define('prs', {
    label: 'ใบขอซื้อ (PR)', phase: 4, key: 'prNo',
    note: 'จำนวนเป็นหน่วยหลัก; ผู้ขออนุมัติใบของตัวเองไม่ได้',
    fields: [['prNo', 'text', 'เลขที่ใบขอซื้อ'], ['date', 'date', 'วันที่'],
      ['status', 'enum', 'สถานะ', 'DRAFT/SUBMITTED/APPROVED/REJECTED/CONVERTED/CANCELLED'],
      ['lines', 'json', 'บรรทัด {line, code, qty (หน่วยหลัก), needDate, wh, supplier, reason}'], ['remark', 'text', 'หมายเหตุ'],
      ['requestedBy', 'text', 'ผู้ขอ'], ['requestedAt', 'datetime', 'ขอเมื่อ'], ['submittedBy', 'text', 'ผู้ส่งขออนุมัติ'],
      ['submittedAt', 'datetime', 'ส่งขออนุมัติเมื่อ'], ['approvedBy', 'text', 'ผู้อนุมัติ'], ['approvedAt', 'datetime', 'อนุมัติเมื่อ'],
      ['rejectedBy', 'text', 'ผู้ไม่อนุมัติ'], ['rejectedAt', 'datetime', 'ไม่อนุมัติเมื่อ'], ['rejectReason', 'text', 'เหตุผลไม่อนุมัติ'],
      ['cancelledBy', 'text', 'ผู้ยกเลิก'], ['cancelledAt', 'datetime', 'ยกเลิกเมื่อ'], ['cancelReason', 'text', 'เหตุผลยกเลิก'],
      ['restCancelled', 'json', 'ยกเลิกส่วนที่ยังไม่ออก PO {by, at, reason}'], ['poNos', 'list', 'ใบสั่งซื้อที่ออกจากใบนี้'],
      ['convertedBy', 'text', 'ผู้ออก PO ครั้งแรก'], ['convertedAt', 'datetime', 'ออก PO ครั้งแรกเมื่อ'], ['source', 'text', 'ที่มา (เช่น แนะนำสั่งซื้อ)'],
      ['log', 'json', 'ประวัติ {at, by, action, …}']],
  });
  schema.define('pos', {
    label: 'ใบสั่งซื้อ (PO)', phase: 4, key: 'poNo',
    note: 'ค้างรับ = base − received − cancelled; ราคาเป็นต่อหน่วยซื้อ',
    fields: [['poNo', 'text', 'เลขที่ใบสั่งซื้อ'], ['supplier', 'text', 'รหัสผู้ขาย'], ['supplierName', 'text', 'ชื่อผู้ขาย'],
      ['date', 'date', 'วันที่'], ['status', 'enum', 'สถานะ', 'DRAFT/ISSUED/PARTIAL/RECEIVED/CLOSED/CANCELLED'],
      ['lines', 'json', 'บรรทัด {line, code, qty (หน่วยซื้อ), unit, factor, base (หน่วยหลัก), price, amount, dueDate (กำหนดเข้าจริง), originalDue, wh, received, returned, replaced, cancelled, overAllowed, overApprovals, prNo, prLine}'],
      ['remark', 'text', 'หมายเหตุ'], ['prNos', 'list', 'ใบขอซื้อที่อ้าง'], ['total', 'number', 'มูลค่ารวม'],
      ['createdBy', 'text', 'ผู้สร้าง'], ['createdAt', 'datetime', 'สร้างเมื่อ'], ['issuedBy', 'text', 'ผู้ออก/ส่งผู้ขาย'],
      ['issuedAt', 'datetime', 'ส่งผู้ขายเมื่อ'], ['cancelledBy', 'text', 'ผู้ยกเลิก'], ['cancelledAt', 'datetime', 'ยกเลิกเมื่อ'],
      ['cancelReason', 'text', 'เหตุผลยกเลิก'], ['closedBy', 'text', 'ผู้ปิดยอดค้าง'], ['closedAt', 'datetime', 'ปิดเมื่อ'],
      ['closeReason', 'text', 'เหตุผลปิดยอดค้าง'], ['log', 'json', 'ประวัติ {at, by, action, line, qty, docNo, reason, …}']],
  });

  const PR_STATUS = { DRAFT: 'ร่าง', SUBMITTED: 'รออนุมัติ', APPROVED: 'อนุมัติแล้ว', REJECTED: 'ไม่อนุมัติ',
    CONVERTED: 'ออก PO แล้ว', CANCELLED: 'ยกเลิก' };
  const PO_STATUS = { DRAFT: 'ร่าง', ISSUED: 'ส่งผู้ขายแล้ว', PARTIAL: 'รับบางส่วน', RECEIVED: 'รับครบ',
    CLOSED: 'ปิดยอดค้าง', CANCELLED: 'ยกเลิก' };
  const OPEN_PO = { ISSUED: true, PARTIAL: true };
  const PENDING_PR = { SUBMITTED: true, APPROVED: true, CONVERTED: true };
  const ORDERABLE_PR = { APPROVED: true, CONVERTED: true };
  const OPEN_JOB = { OPEN: true, IN_PROGRESS: true };
  const PO_DOC = { RR: true, RV: true };

  // ---------------------------------------------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------------------------------------------
  const yes = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'Y' || v === 'ใช่';
  const boolOr = (v, d) => (v == null || v === '' ? d : yes(v));
  /** undefined = not given, null = cleared, NaN = not a number, number otherwise. */
  function numIn(v) {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    return util.num(v);
  }
  function parseDate(v) {
    const s = util.trim(v).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const t = Date.parse(s);
    if (!isFinite(t) || new Date(t).toISOString().slice(0, 10) !== s) return null;
    return s;
  }
  const at = (n) => (n ? `บรรทัด ${n}: ` : '');
  const w = (n, field) => Object.assign(n ? { line: n } : {}, field ? { field } : {});
  function lineOut(l) {
    return pos0((l.base || 0) - (l.received || 0) - (l.cancelled || 0));
  }
  function addLog(row, tx, action, detail) {
    row.log = (row.log || []).concat([Object.assign({ at: tx.now, by: tx.userId, action }, detail || {})]);
  }
  function poStatusOf(po) {
    const lines = po.lines || [];
    if (po.status === 'DRAFT') return lines.every((l) => lineOut(l) <= 0) ? 'CANCELLED' : 'DRAFT';
    if (po.status === 'CLOSED' || po.status === 'CANCELLED') return po.status;
    let out = 0;
    let got = 0;
    for (const l of lines) {
      out += lineOut(l);
      got += (l.received || 0) + (l.replaced || 0);
    }
    if (round(out) <= 0) return got > 0 ? 'RECEIVED' : 'CANCELLED';
    return got > 0 ? 'PARTIAL' : 'ISSUED';
  }
  /** Whole buy units, at least MOQ, a multiple of the pack (all in buy units). */
  function roundBuy(baseNeed, factor, moq, pack) {
    let q = Math.ceil(round(baseNeed / (factor || 1), 6));
    if (!(q > 0)) return 0;
    if (moq > 0 && q < moq) q = Math.ceil(round(moq, 6));
    if (pack > 0) q = Math.ceil(round(q / pack, 6)) * pack;
    return round(q);
  }
  /** Σ (base − cancelled) of every PO line pointing at a PR line, over PO rows. */
  function orderedOf(poRows, prNo, prLine) {
    let s = 0;
    for (const po of poRows) {
      for (const l of po.lines || []) {
        if (l.prNo === prNo && Number(l.prLine) === Number(prLine)) s += (l.base || 0) - (l.cancelled || 0);
      }
    }
    return round(s);
  }
  function prLineOpen(pr, prl, poRows) {
    if (!pr || pr.restCancelled || !PENDING_PR[pr.status]) return 0;
    return pos0(prl.qty - orderedOf(poRows, pr.prNo, prl.line));
  }
  function getter(tx) {
    return (t, k) => tx.get(t, k);
  }

  // ---- reads inside a command --------------------------------------------------------------------------------
  function checkWh(tx, raw, perm, n, field) {
    const wh = util.normCode(raw);
    const where = w(n, field || 'wh');
    if (!wh) return tx.error('REQUIRED', `${at(n)}ระบุคลัง`, where) && null;
    if (wh === TRANSIT) return tx.error('RESERVED', `${at(n)}${TRANSIT} ใช้ภายในระบบ`, where) && null;
    const row = tx.get('warehouses', wh);
    if (!row) return tx.error('NOT_FOUND', `${at(n)}ไม่พบคลัง ${wh}`, where) && null;
    if (row.active === false) return tx.error('INACTIVE', `${at(n)}คลัง ${wh} ปิดใช้งาน`, where) && null;
    if (perm && !tx.can(perm, wh)) return tx.need(perm, wh, where) && null;
    return wh;
  }
  function getSupplier(tx, raw, n, needActive) {
    const id = util.normCode(raw);
    if (!id) return tx.error('REQUIRED', `${at(n)}ระบุผู้ขาย`, w(n, 'supplier')) && null;
    const s = tx.get('suppliers', id);
    if (!s) return tx.error('NOT_FOUND', `${at(n)}ไม่พบผู้ขาย ${id}`, w(n, 'supplier')) && null;
    if (needActive && s.active === false) return tx.error('INACTIVE', `${at(n)}ผู้ขาย ${id} ปิดใช้งาน`, w(n, 'supplier')) && null;
    return s;
  }
  function getItem(tx, raw, n) {
    const it = tx.item(raw);
    if (!it) return tx.error('NOT_FOUND', `${at(n)}ไม่พบรหัส ${util.trim(raw) || '(ว่าง)'} ในทะเบียนสินค้า`, w(n, 'code')) && null;
    if (it.active === false) return tx.error('INACTIVE', `${at(n)}${it.id} ปิดใช้งานแล้ว`, w(n, 'code')) && null;
    return it;
  }
  function getPo(tx, poNo) {
    const k = util.normCode(poNo);
    if (!k) return tx.error('REQUIRED', 'ระบุเลขที่ใบสั่งซื้อ', { field: 'poNo' }) && null;
    const po = tx.get('pos', k);
    if (!po) return tx.error('NOT_FOUND', `ไม่พบใบสั่งซื้อ ${k}`, { field: 'poNo' }) && null;
    return clone(po);
  }
  function getPr(tx, prNo) {
    const k = util.normCode(prNo);
    if (!k) return tx.error('REQUIRED', 'ระบุเลขที่ใบขอซื้อ', { field: 'prNo' }) && null;
    const pr = tx.get('prs', k);
    if (!pr) return tx.error('NOT_FOUND', `ไม่พบใบขอซื้อ ${k}`, { field: 'prNo' }) && null;
    return clone(pr);
  }
  function poLineOf(tx, po, raw, n) {
    const ln = Number(raw);
    const pl = (po.lines || []).find((l) => l.line === ln);
    if (!pl) return tx.error('NOT_FOUND', `${at(n)}ใบสั่งซื้อ ${po.poNo} ไม่มีบรรทัด ${raw == null || raw === '' ? '(ว่าง)' : raw}`, w(n, 'line')) && null;
    return pl;
  }
  function needReason(tx, p, min) {
    const reason = util.trim(p.reason);
    if (reason.length < (min || 3)) return tx.error('REQUIRED', 'ระบุเหตุผลให้ชัดเจน', { field: 'reason' }) && null;
    return reason.slice(0, 300);
  }
  function needDays(tx, v, field, n) {
    if (v == null) return true;
    if (isNaN(v) || v < 0 || !Number.isInteger(v)) return tx.error('BAD_VALUE', `${at(n)}${field} ต้องเป็นจำนวนวันเต็ม 0 ขึ้นไป`, w(n, field));
    return true;
  }
  function itemSupplierOf(tx, code, supplier) {
    const is = tx.get('item_suppliers', code + '|' + supplier);
    return is && is.active !== false ? is : null;
  }

  // ---------------------------------------------------------------------------------------------------------
  // suppliers / item–supplier terms / reorder rules
  // ---------------------------------------------------------------------------------------------------------
  define('supplier.upsert', {
    label: 'บันทึกผู้ขาย', perm: 'supplier.manage',
    prepare(tx, p) {
      const id = util.normCode(p.id);
      if (!id) return tx.error('REQUIRED', 'กรอกรหัสผู้ขาย', { field: 'id' });
      if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(id) || id.length > 30) return tx.error('BAD_CODE', 'รหัสผู้ขายใช้ A-Z 0-9 . _ - ไม่เกิน 30 ตัว', { field: 'id' });
      const prev = tx.get('suppliers', id);
      const keep = (k, d) => (p[k] === undefined ? (prev ? prev[k] : d) : p[k]);
      const name = util.trim(keep('name', ''));
      if (!name) return tx.error('REQUIRED', 'กรอกชื่อผู้ขาย', { field: 'name' });
      const taxIn = keep('taxId', '');
      const taxId = String(taxIn == null ? '' : taxIn).replace(/[\s-]/g, '');
      if (taxId && !/^\d{13}$/.test(taxId)) return tx.error('BAD_VALUE', 'เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก', { field: 'taxId' });
      let leadDays = numIn(p.leadDays);
      if (leadDays === undefined) leadDays = prev ? prev.leadDays : null;
      if (!needDays(tx, leadDays, 'leadDays')) return;
      const active = boolOr(p.active, prev ? prev.active !== false : true);
      if (prev && prev.active !== false && !active) {
        const open = tx.all('pos', (po) => po.supplier === id && (OPEN_PO[po.status] || po.status === 'DRAFT'));
        if (open.length) tx.warn(`ผู้ขาย ${id} ยังมีใบสั่งซื้อค้าง ${open.map((x) => x.poNo).join(', ')} – รับของได้ตามปกติ แต่ออก PO ใหม่ไม่ได้`);
      }
      tx.put('suppliers', id, { id, name: name.slice(0, 120), taxId, contact: util.trim(keep('contact', '')).slice(0, 120),
        phone: util.trim(keep('phone', '')).slice(0, 60), leadDays, active, updatedBy: tx.userId, updatedAt: tx.now });
      tx.summary = `${prev ? 'แก้' : 'เพิ่ม'}ผู้ขาย ${id} ${name}`;
      tx.result.id = id;
    },
  });

  define('itemSupplier.upsert', {
    label: 'ตั้งราคา/หน่วยซื้อของสินค้ากับผู้ขาย', perm: 'supplier.manage',
    prepare(tx, p) {
      const it = getItem(tx, p.code);
      if (!it) return;
      const sup = getSupplier(tx, p.supplier);
      if (!sup) return;
      const key = it.id + '|' + sup.id;
      const prev = tx.get('item_suppliers', key);
      const keep = (k, d) => (p[k] === undefined ? (prev ? prev[k] : d) : p[k]);
      const buyUnit = util.trim(keep('buyUnit', '')) || it.baseUnit;
      const known = RRS.unitFactor(getter(tx), it, buyUnit);
      let fIn = numIn(p.factor);
      if (fIn === undefined) fIn = prev && prev.buyUnit === buyUnit ? prev.factor : null;
      let factor;
      if (fIn == null) {
        if (known == null) return tx.error('NO_UNIT', `${it.id} ไม่มีตัวคูณของหน่วย "${buyUnit}" – ระบุตัวคูณ (1 ${buyUnit} = ? ${it.baseUnit})`, { field: 'factor' });
        factor = known;
      } else {
        if (!(fIn > 0)) return tx.error('BAD_VALUE', 'ตัวคูณหน่วยซื้อต้องมากกว่า 0', { field: 'factor' });
        if (known != null && Math.abs(known - fIn) > EPS) {
          return tx.error('UNIT_CONFLICT', `หน่วย ${buyUnit} ของ ${it.id} ตั้งไว้แล้ว 1 ${buyUnit} = ${known} ${it.baseUnit} ไม่ตรงกับ ${fIn} – แก้ที่ทะเบียนหน่วยก่อน (ระบบไม่เลือกให้)`, { field: 'factor' });
        }
        factor = round(fIn);
      }
      const nums = {};
      for (const k of ['price', 'moq', 'pack', 'leadDays']) {
        let v = numIn(p[k]);
        if (v === undefined) v = prev ? prev[k] : null;
        if (v != null && (isNaN(v) || v < 0)) return tx.error('BAD_VALUE', `ค่า ${k} ต้องเป็นตัวเลขไม่ติดลบ`, { field: k });
        nums[k] = v == null ? null : round(v, 6);
      }
      if (!needDays(tx, nums.leadDays, 'leadDays')) return;
      const active = boolOr(p.active, prev ? prev.active !== false : true);
      const preferred = boolOr(p.preferred, prev ? !!prev.preferred : false);
      if (preferred && (!active || sup.active === false)) return tx.error('BAD_VALUE', 'ผู้ขายหลักต้องเป็นรายการที่ใช้งานอยู่', { field: 'preferred' });
      if (preferred) {
        for (const o of tx.all('item_suppliers', (x) => x.code === it.id && x.supplier !== sup.id && x.preferred)) {
          tx.putRow('item_suppliers', Object.assign({}, o, { preferred: false, updatedBy: tx.userId, updatedAt: tx.now }));
          tx.warn(`${it.id}: เปลี่ยนผู้ขายหลักจาก ${o.supplier} เป็น ${sup.id}`);
        }
      }
      tx.putRow('item_suppliers', { code: it.id, supplier: sup.id, price: nums.price, buyUnit, factor, moq: nums.moq || 0,
        pack: nums.pack || 0, leadDays: nums.leadDays, preferred, active, updatedBy: tx.userId, updatedAt: tx.now });
      tx.summary = `${it.id} กับผู้ขาย ${sup.id}: ${nums.price == null ? 'ยังไม่มีราคา' : nums.price + '/' + buyUnit} (1 ${buyUnit} = ${factor} ${it.baseUnit})${preferred ? ' ผู้ขายหลัก' : ''}`;
    },
  });

  define('reorder.set', {
    label: 'ตั้งเงื่อนไขเติมสต็อก', perm: 'reorder.manage',
    prepare(tx, p) {
      const it = getItem(tx, p.code);
      if (!it) return;
      let wh = '';
      if (util.trim(p.wh)) {
        wh = checkWh(tx, p.wh, 'reorder.manage');
        if (!wh) return;
      }
      const key = it.id + '|' + wh;
      const prev = tx.get('reorder_rules', key);
      const v = {};
      for (const k of ['min', 'max', 'leadDays', 'coverDays', 'usageDays']) {
        let x = numIn(p[k]);
        if (x === undefined) x = prev ? prev[k] : null;
        if (x != null && (isNaN(x) || x < 0)) return tx.error('BAD_VALUE', `ค่า ${k} ต้องเป็นตัวเลขไม่ติดลบ`, { field: k });
        v[k] = x == null ? null : round(x);
      }
      if (v.min != null && v.max != null && v.min > v.max) return tx.error('BAD_VALUE', 'Min ต้องไม่มากกว่า Max', { field: 'min' });
      for (const k of ['leadDays', 'coverDays']) if (!needDays(tx, v[k], k)) return;
      if (v.usageDays != null && !(Number.isInteger(v.usageDays) && v.usageDays >= 1)) return tx.error('BAD_VALUE', 'usageDays ต้องเป็นจำนวนวันเต็ม 1 ขึ้นไป', { field: 'usageDays' });
      let supplier = p.supplier === undefined ? (prev ? prev.supplier : '') : util.normCode(p.supplier);
      if (supplier) {
        const sup = getSupplier(tx, supplier, 0, true);
        if (!sup) return;
        if (!itemSupplierOf(tx, it.id, sup.id)) tx.warn(`ยังไม่ได้ตั้งราคา/หน่วยซื้อของ ${it.id} กับผู้ขาย ${sup.id}`);
        supplier = sup.id;
      }
      const active = boolOr(p.active, prev ? prev.active !== false : true);
      tx.putRow('reorder_rules', { code: it.id, wh, min: v.min, max: v.max, leadDays: v.leadDays, supplier: supplier || '',
        coverDays: v.coverDays, usageDays: v.usageDays, active, updatedBy: tx.userId, updatedAt: tx.now });
      tx.summary = `เงื่อนไขเติมสต็อก ${it.id}${wh ? ' คลัง ' + wh : ' ทุกคลัง'}${active ? '' : ' (ปิดการแนะนำ)'}`;
    },
  });

  // ---------------------------------------------------------------------------------------------------------
  // purchase requests
  // ---------------------------------------------------------------------------------------------------------
  function readPrLines(tx, p, draft) {
    if (p.lines != null && !Array.isArray(p.lines)) return tx.error('BAD_INPUT', 'lines ต้องเป็นรายการ', { field: 'lines' }) && null;
    const raws = p.lines || [];
    if (!raws.length) return tx.error('REQUIRED', 'ใบขอซื้อต้องมีอย่างน้อย 1 บรรทัด', { field: 'lines' }) && null;
    const lines = [];
    raws.forEach((raw, i) => {
      const n = i + 1;
      raw = raw || {};
      const it = getItem(tx, raw.code, n);
      if (!it) return;
      const qty = util.num(raw.qty);
      if (!(qty > 0)) return tx.error('BAD_QTY', `${at(n)}จำนวนต้องเป็นตัวเลขมากกว่า 0 (หน่วยหลัก ${it.baseUnit})`, w(n, 'qty'));
      let needDate = '';
      if (util.trim(raw.needDate)) {
        needDate = parseDate(raw.needDate);
        if (!needDate) return tx.error('BAD_DATE', `${at(n)}วันต้องใช้ต้องเป็นวันที่จริงแบบ YYYY-MM-DD`, w(n, 'needDate'));
      } else if (!draft) {
        return tx.error('REQUIRED', `${at(n)}ระบุวันต้องใช้`, w(n, 'needDate'));
      }
      const wh = checkWh(tx, raw.wh, 'pr.create', n);
      if (!wh) return;
      let supplier = '';
      if (util.trim(raw.supplier)) {
        const s = getSupplier(tx, raw.supplier, n, true);
        if (!s) return;
        supplier = s.id;
      }
      lines.push({ line: n, code: it.id, name: it.name, baseUnit: it.baseUnit, qty: round(qty), needDate, wh, supplier,
        reason: util.trim(raw.reason).slice(0, 500) });
    });
    return tx.ok ? lines : null;
  }

  define('pr.create', {
    label: 'สร้างใบขอซื้อ', perm: 'pr.create',
    prepare(tx, p) {
      const draft = yes(p.draft);
      let date = tx.date;
      if (util.trim(p.date)) {
        date = parseDate(p.date);
        if (!date) return tx.error('BAD_DATE', 'วันที่ต้องเป็นวันที่จริงแบบ YYYY-MM-DD', { field: 'date' });
      }
      let prev = null;
      if (util.trim(p.prNo)) {
        prev = getPr(tx, p.prNo);
        if (!prev) return;
        if (prev.status !== 'DRAFT') return tx.error('BAD_STATE', `${prev.prNo} ${PR_STATUS[prev.status]} – แก้ได้เฉพาะร่าง`);
        if (prev.requestedBy !== tx.userId) return tx.error('NOT_OWNER', `ร่าง ${prev.prNo} เป็นของ ${prev.requestedBy} – ผู้ขอเท่านั้นที่แก้ได้`);
      }
      const lines = readPrLines(tx, p, draft);
      if (!lines) return;
      const prNo = prev ? prev.prNo : tx.nextNo('PR', date);
      const row = Object.assign(prev || {
        prNo, requestedBy: tx.userId, requestedAt: tx.now, approvedBy: '', approvedAt: '', rejectedBy: '', rejectedAt: '',
        rejectReason: '', cancelledBy: '', cancelledAt: '', cancelReason: '', restCancelled: null, poNos: [],
        convertedBy: '', convertedAt: '', log: [],
      }, { date, status: draft ? 'DRAFT' : 'SUBMITTED', lines, remark: util.trim(p.remark).slice(0, 500),
        submittedBy: draft ? '' : tx.userId, submittedAt: draft ? '' : tx.now, source: util.trim(p.source || (prev && prev.source)) });
      addLog(row, tx, prev ? 'update' : 'create', { status: row.status, lines: lines.length });
      tx.put('prs', prNo, row);
      tx.result.prNo = prNo;
      tx.result.status = row.status;
      tx.summary = `${prev ? 'แก้' : 'สร้าง'}ใบขอซื้อ ${prNo} ${lines.length} บรรทัด (${PR_STATUS[row.status]})`;
    },
  });

  define('pr.submit', {
    label: 'ส่งใบขอซื้อขออนุมัติ', perm: 'pr.create',
    prepare(tx, p) {
      const pr = getPr(tx, p.prNo);
      if (!pr) return;
      if (pr.status !== 'DRAFT') return tx.error('BAD_STATE', `${pr.prNo} ${PR_STATUS[pr.status]} – ส่งได้เฉพาะร่าง`);
      for (const l of pr.lines) {
        if (!l.needDate) tx.error('REQUIRED', `บรรทัด ${l.line}: ระบุวันต้องใช้ก่อนส่งอนุมัติ`, { line: l.line, field: 'needDate' });
        const it = tx.get('items', l.code);
        if (!it || it.active === false) tx.error('INACTIVE', `บรรทัด ${l.line}: ${l.code} ปิดใช้งานแล้ว`, { line: l.line });
      }
      if (!tx.ok) return;
      Object.assign(pr, { status: 'SUBMITTED', submittedBy: tx.userId, submittedAt: tx.now });
      addLog(pr, tx, 'submit');
      tx.put('prs', pr.prNo, pr);
      tx.summary = `ส่งใบขอซื้อ ${pr.prNo} ขออนุมัติ`;
    },
  });

  define('pr.approve', {
    label: 'อนุมัติใบขอซื้อ', perm: 'pr.approve',
    prepare(tx, p) {
      const pr = getPr(tx, p.prNo);
      if (!pr) return;
      if (pr.status !== 'SUBMITTED') return tx.error('BAD_STATE', `${pr.prNo} ${PR_STATUS[pr.status]} – อนุมัติได้เฉพาะใบที่รออนุมัติ`);
      if (!tx.different(pr.requestedBy, 'ผู้อนุมัติใบขอซื้อ')) return;
      Object.assign(pr, { status: 'APPROVED', approvedBy: tx.userId, approvedAt: tx.now });
      addLog(pr, tx, 'approve', { remark: util.trim(p.remark).slice(0, 300) });
      tx.put('prs', pr.prNo, pr);
      tx.summary = `อนุมัติใบขอซื้อ ${pr.prNo}`;
    },
  });

  define('pr.reject', {
    label: 'ไม่อนุมัติใบขอซื้อ', perm: 'pr.approve',
    prepare(tx, p) {
      const pr = getPr(tx, p.prNo);
      if (!pr) return;
      if (pr.status !== 'SUBMITTED') return tx.error('BAD_STATE', `${pr.prNo} ${PR_STATUS[pr.status]} – ไม่อนุมัติได้เฉพาะใบที่รออนุมัติ`);
      const reason = needReason(tx, p);
      if (!reason) return;
      if (!tx.different(pr.requestedBy, 'ผู้พิจารณาใบขอซื้อ')) return;
      Object.assign(pr, { status: 'REJECTED', rejectedBy: tx.userId, rejectedAt: tx.now, rejectReason: reason });
      addLog(pr, tx, 'reject', { reason });
      tx.put('prs', pr.prNo, pr);
      tx.summary = `ไม่อนุมัติใบขอซื้อ ${pr.prNo}: ${reason}`;
    },
  });

  define('pr.cancel', {
    label: 'ยกเลิกใบขอซื้อ',
    perm(tx) {
      return tx.can('pr.approve') ? 'pr.approve' : 'pr.create';
    },
    prepare(tx, p) {
      const pr = getPr(tx, p.prNo);
      if (!pr) return;
      if (!tx.can('pr.approve') && pr.requestedBy !== tx.userId) return tx.error('NOT_OWNER', `${pr.prNo} เป็นของ ${pr.requestedBy} – ยกเลิกได้โดยผู้ขอหรือผู้อนุมัติ`);
      const reason = needReason(tx, p);
      if (!reason) return;
      if (pr.status === 'CONVERTED') {
        if (pr.restCancelled) return tx.error('BAD_STATE', `${pr.prNo} ยกเลิกส่วนที่เหลือไปแล้ว`);
        pr.restCancelled = { by: tx.userId, at: tx.now, reason };
        addLog(pr, tx, 'cancelRest', { reason });
        tx.put('prs', pr.prNo, pr);
        tx.summary = `ยกเลิกส่วนที่ยังไม่ออก PO ของ ${pr.prNo}`;
        return;
      }
      if (['DRAFT', 'SUBMITTED', 'APPROVED'].indexOf(pr.status) < 0) return tx.error('BAD_STATE', `${pr.prNo} ${PR_STATUS[pr.status]} – ยกเลิกไม่ได้`);
      Object.assign(pr, { status: 'CANCELLED', cancelledBy: tx.userId, cancelledAt: tx.now, cancelReason: reason });
      addLog(pr, tx, 'cancel', { reason });
      tx.put('prs', pr.prNo, pr);
      tx.summary = `ยกเลิกใบขอซื้อ ${pr.prNo}`;
    },
  });

  // ---------------------------------------------------------------------------------------------------------
  // purchase orders
  // ---------------------------------------------------------------------------------------------------------
  function orderablePr(tx, prNo, n) {
    const pr = tx.get('prs', prNo);
    if (!pr) return tx.error('NOT_FOUND', `${at(n)}ไม่พบใบขอซื้อ ${prNo}`, w(n, 'prNo')) && null;
    if (!ORDERABLE_PR[pr.status]) return tx.error('PR_NOT_APPROVED', `${at(n)}ใบขอซื้อ ${prNo} ${PR_STATUS[pr.status]} – ออก PO ได้เมื่ออนุมัติแล้ว`, w(n, 'prNo')) && null;
    if (pr.restCancelled) return tx.error('PR_DONE', `${at(n)}ใบขอซื้อ ${prNo} ยกเลิกส่วนที่เหลือแล้ว`, w(n, 'prNo')) && null;
    return pr;
  }
  /** Open qty of a PR line inside this command: PRs ordered by stored POs and by lines built so far. */
  function openInTx(tx, pr, prl, used) {
    return round(prLineOpen(pr, prl, tx.all('pos')) - (used[pr.prNo + '|' + prl.line] || 0));
  }
  function buyTerms(tx, it, supId) {
    const is = itemSupplierOf(tx, it.id, supId);
    return is ? { is, unit: is.buyUnit, factor: is.factor, moq: is.moq || 0, pack: is.pack || 0 }
      : { is: null, unit: it.baseUnit, factor: 1, moq: 0, pack: 0 };
  }

  /** PO lines from the open lines of the listed PRs (qty rounded to buy units, MOQ and pack). */
  function linesFromPrs(tx, prs, sup) {
    const out = [];
    const used = {};
    for (const prNo of Object.keys(prs)) {
      const pr = prs[prNo];
      for (const prl of pr.lines) {
        const open = openInTx(tx, pr, prl, used);
        if (open <= 0) continue;
        if (prl.supplier && prl.supplier !== sup.id) {
          tx.warn(`${prNo} บรรทัด ${prl.line}: ขอซื้อจากผู้ขาย ${prl.supplier} – ไม่รวมในใบสั่งซื้อของ ${sup.id}`);
          continue;
        }
        const it = tx.get('items', prl.code);
        if (!it) continue;
        const t = buyTerms(tx, it, sup.id);
        const q = roundBuy(open, t.factor, t.moq, t.pack);
        used[prNo + '|' + prl.line] = round((used[prNo + '|' + prl.line] || 0) + open);
        out.push({ code: it.id, qty: q, unit: t.unit, dueDate: prl.needDate, wh: prl.wh, prNo, prLine: prl.line, fromPr: true });
      }
    }
    return out;
  }

  function buildPoLine(tx, raw, i, ctx) {
    const n = i + 1;
    raw = raw || {};
    const it = getItem(tx, raw.code, n);
    if (!it) return null;
    const sup = ctx.sup;
    // PR link: explicit prNo (+ prLine), or the first open line of the same item in the listed PRs
    let pr = null;
    let prl = null;
    const prNo = util.normCode(raw.prNo);
    const wantWh = util.normCode(raw.wh);
    const fits = (x) => x.code === it.id && (!wantWh || x.wh === wantWh);
    if (prNo) {
      pr = ctx.prs[prNo] || orderablePr(tx, prNo, n);
      if (!pr) return null;
      ctx.prs[prNo] = pr;
      if (raw.prLine != null && raw.prLine !== '') {
        prl = pr.lines.find((x) => x.line === Number(raw.prLine));
        if (!prl) return tx.error('NOT_FOUND', `${at(n)}ใบขอซื้อ ${prNo} ไม่มีบรรทัด ${raw.prLine}`, w(n, 'prLine')) && null;
        if (prl.code !== it.id) return tx.error('WRONG_ITEM', `${at(n)}ใบขอซื้อ ${prNo} บรรทัด ${prl.line} เป็นของ ${prl.code} ไม่ใช่ ${it.id}`, w(n, 'code')) && null;
      } else {
        prl = pr.lines.find((x) => fits(x) && openInTx(tx, pr, x, ctx.used) > 0) || pr.lines.find(fits) || null;
        if (!prl) return tx.error('WRONG_ITEM', `${at(n)}ใบขอซื้อ ${prNo} ไม่มี ${it.id}${wantWh ? ' คลัง ' + wantWh : ''}`, w(n, 'code')) && null;
      }
    } else {
      for (const k of ctx.listed) {
        const x = ctx.prs[k].lines.find((y) => fits(y) && openInTx(tx, ctx.prs[k], y, ctx.used) > 0);
        if (x) {
          pr = ctx.prs[k];
          prl = x;
          break;
        }
      }
    }
    let open = null;
    if (prl) {
      open = openInTx(tx, pr, prl, ctx.used);
      if (open <= 0) return tx.error('PR_DONE', `${at(n)}ใบขอซื้อ ${pr.prNo} บรรทัด ${prl.line} ออก PO ครบแล้ว`, w(n, 'prNo')) && null;
    }
    const t = buyTerms(tx, it, sup.id);
    const unit = util.trim(raw.unit) || t.unit;
    const factor = t.is && unit === t.is.buyUnit ? t.is.factor : RRS.unitFactor(getter(tx), it, unit);
    if (factor == null) return tx.error('NO_UNIT', `${at(n)}${it.id} ไม่มีตัวคูณของหน่วย "${unit}" (หน่วยหลัก ${it.baseUnit}) – ตั้งหน่วยซื้อกับผู้ขายหรือทะเบียนหน่วยก่อน`, w(n, 'unit')) && null;
    const qty = util.num(raw.qty);
    if (!(qty > 0)) return tx.error('BAD_QTY', `${at(n)}จำนวนต้องเป็นตัวเลขมากกว่า 0 (${unit})`, w(n, 'qty')) && null;
    let price = numIn(raw.price);
    if (price == null) price = t.is && unit === t.is.buyUnit && t.is.price != null ? t.is.price : null;
    if (price == null) return tx.error('PRICE_REQUIRED', `${at(n)}${it.id} ยังไม่มีราคาต่อ${unit}กับผู้ขาย ${sup.id} – ระบุราคา (ระบบไม่เดาราคา)`, w(n, 'price')) && null;
    if (isNaN(price) || price < 0) return tx.error('BAD_VALUE', `${at(n)}ราคาต้องเป็นตัวเลขไม่ติดลบ`, w(n, 'price')) && null;
    let dueDate = '';
    if (util.trim(raw.dueDate)) {
      dueDate = parseDate(raw.dueDate);
      if (!dueDate) return tx.error('BAD_DATE', `${at(n)}วันกำหนดรับต้องเป็นวันที่จริงแบบ YYYY-MM-DD`, w(n, 'dueDate')) && null;
    } else if (prl && prl.needDate) {
      dueDate = prl.needDate;
    } else {
      return tx.error('REQUIRED', `${at(n)}ระบุวันกำหนดรับ`, w(n, 'dueDate')) && null;
    }
    if (dueDate < ctx.date) return tx.error('BAD_DATE', `${at(n)}วันกำหนดรับ ${dueDate} อยู่ก่อนวันที่ใบสั่งซื้อ ${ctx.date}`, w(n, 'dueDate')) && null;
    const wh = checkWh(tx, wantWh || (prl && prl.wh), 'po.manage', n);
    if (!wh) return null;
    const base = round(qty * factor);
    if (!t.is) tx.warn(`${at(n)}ยังไม่ได้ตั้ง ${it.id} กับผู้ขาย ${sup.id} (ราคา/หน่วยซื้อ/Lead time)`);
    else if (unit === t.is.buyUnit) {
      if (t.moq > 0 && qty < t.moq - EPS) tx.warn(`${at(n)}${it.id} สั่ง ${qty} ${unit} น้อยกว่าขั้นต่ำ (MOQ) ${t.moq} ${unit}`);
      if (t.pack > 0 && Math.abs(qty / t.pack - Math.round(qty / t.pack)) > 1e-6) tx.warn(`${at(n)}${it.id} สั่ง ${qty} ${unit} ไม่เต็มแพ็ก (แพ็กละ ${t.pack} ${unit})`);
    }
    if (prl) {
      if (base > open + EPS) tx.warn(`${at(n)}สั่ง ${base} ${it.baseUnit} มากกว่าที่ขอซื้อค้าง ${open} (${pr.prNo} บรรทัด ${prl.line}) – ปัดตามหน่วยซื้อ/MOQ/แพ็ก`);
      if (prl.supplier && prl.supplier !== sup.id) tx.warn(`${at(n)}${pr.prNo} ขอซื้อจากผู้ขาย ${prl.supplier} แต่ออก PO ให้ ${sup.id}`);
      const k = pr.prNo + '|' + prl.line;
      ctx.used[k] = round((ctx.used[k] || 0) + base);
    }
    return {
      line: n, code: it.id, name: it.name, baseUnit: it.baseUnit, qty: round(qty), unit, factor, base, price: round(price, 6),
      amount: round(qty * price, 2), dueDate, originalDue: dueDate, wh, received: 0, returned: 0, replaced: 0, cancelled: 0,
      overAllowed: 0, overApprovals: [], prNo: prl ? pr.prNo : '', prLine: prl ? prl.line : '', remark: util.trim(raw.remark).slice(0, 300),
    };
  }

  define('po.create', {
    label: 'สร้างใบสั่งซื้อ', perm: 'po.manage',
    prepare(tx, p) {
      const sup = getSupplier(tx, p.supplier, 0, true);
      if (!sup) return;
      let date = tx.date;
      if (util.trim(p.date)) {
        date = parseDate(p.date);
        if (!date) return tx.error('BAD_DATE', 'วันที่ต้องเป็นวันที่จริงแบบ YYYY-MM-DD', { field: 'date' });
      }
      if (p.lines != null && !Array.isArray(p.lines)) return tx.error('BAD_INPUT', 'lines ต้องเป็นรายการ', { field: 'lines' });
      if (p.prNos != null && !Array.isArray(p.prNos)) return tx.error('BAD_INPUT', 'prNos ต้องเป็นรายการ', { field: 'prNos' });
      const listed = [];
      const prs = {};
      for (const x of p.prNos || []) {
        const k = util.normCode(x);
        if (!k || prs[k]) continue;
        const pr = orderablePr(tx, k);
        if (!pr) return;
        prs[k] = pr;
        listed.push(k);
      }
      let raws = p.lines || [];
      if (!raws.length) {
        if (!listed.length) return tx.error('REQUIRED', 'ใบสั่งซื้อต้องมีอย่างน้อย 1 บรรทัด หรือระบุใบขอซื้อที่อนุมัติแล้ว', { field: 'lines' });
        raws = linesFromPrs(tx, prs, sup);
        if (!raws.length) return tx.error('NOTHING', 'ใบขอซื้อที่เลือกไม่มีบรรทัดค้างออก PO สำหรับผู้ขายนี้', { field: 'prNos' });
      }
      const ctx = { sup, date, prs, listed, used: {} };
      const lines = [];
      raws.forEach((raw, i) => {
        const l = buildPoLine(tx, raw, i, ctx);
        if (l) lines.push(l);
      });
      if (!tx.ok) return;
      const poNo = tx.nextNo('PO', date);
      const linked = [];
      for (const l of lines) if (l.prNo && linked.indexOf(l.prNo) < 0) linked.push(l.prNo);
      for (const k of listed) if (linked.indexOf(k) < 0) tx.warn(`ใบขอซื้อ ${k} ไม่มีบรรทัดที่ตรงกับใบสั่งซื้อนี้`);
      for (const k of linked) {
        const pr = clone(tx.get('prs', k));
        pr.poNos = (pr.poNos || []).concat(pr.poNos && pr.poNos.indexOf(poNo) >= 0 ? [] : [poNo]);
        if (pr.status !== 'CONVERTED') Object.assign(pr, { status: 'CONVERTED', convertedBy: tx.userId, convertedAt: tx.now });
        addLog(pr, tx, 'convert', { poNo });
        tx.put('prs', k, pr);
      }
      const row = {
        poNo, supplier: sup.id, supplierName: sup.name, date, status: 'DRAFT', lines, remark: util.trim(p.remark).slice(0, 500),
        prNos: linked, total: round(lines.reduce((s, l) => s + l.amount, 0), 2), createdBy: tx.userId, createdAt: tx.now,
        issuedBy: '', issuedAt: '', cancelledBy: '', cancelledAt: '', cancelReason: '', closedBy: '', closedAt: '', closeReason: '',
        log: [],
      };
      addLog(row, tx, 'create', { lines: lines.length, prNos: linked });
      tx.put('pos', poNo, row);
      tx.result.poNo = poNo;
      tx.result.lines = lines.map((l) => ({ line: l.line, code: l.code, qty: l.qty, unit: l.unit, base: l.base, prNo: l.prNo }));
      tx.summary = `สร้างใบสั่งซื้อ ${poNo} ผู้ขาย ${sup.id} ${lines.length} บรรทัด${linked.length ? ' จาก ' + linked.join(', ') : ''}`;
    },
  });

  function savePo(tx, po, before, reason) {
    const next = poStatusOf(po);
    if (next === 'CANCELLED' && before !== 'CANCELLED') {
      Object.assign(po, { cancelledBy: tx.userId, cancelledAt: tx.now, cancelReason: po.cancelReason || reason || '' });
    }
    po.status = next;
    tx.put('pos', po.poNo, po);
    return po;
  }

  define('po.issue', {
    label: 'ออกใบสั่งซื้อให้ผู้ขาย', perm: 'po.manage',
    prepare(tx, p) {
      const po = getPo(tx, p.poNo);
      if (!po) return;
      if (po.status !== 'DRAFT') return tx.error('BAD_STATE', `${po.poNo} ${PO_STATUS[po.status]} – ออกได้เฉพาะร่าง`);
      const sup = tx.get('suppliers', po.supplier);
      if (!sup || sup.active === false) return tx.error('INACTIVE', `ผู้ขาย ${po.supplier} ปิดใช้งาน – ออกใบสั่งซื้อไม่ได้`);
      if (!po.lines.some((l) => lineOut(l) > 0)) return tx.error('NOTHING', `${po.poNo} ไม่มีบรรทัดที่ต้องสั่ง`);
      Object.assign(po, { status: 'ISSUED', issuedBy: tx.userId, issuedAt: tx.now });
      addLog(po, tx, 'issue');
      tx.put('pos', po.poNo, po);
      tx.summary = `ออกใบสั่งซื้อ ${po.poNo} ให้ ${po.supplier}`;
    },
  });

  define('po.setDue', {
    label: 'แก้กำหนดเข้าจริงของใบสั่งซื้อ', perm: 'po.manage',
    prepare(tx, p) {
      const po = getPo(tx, p.poNo);
      if (!po) return;
      if (po.status !== 'DRAFT' && !OPEN_PO[po.status]) return tx.error('BAD_STATE', `${po.poNo} ${PO_STATUS[po.status]} – ไม่มีของค้างรับ`);
      const pl = poLineOf(tx, po, p.line);
      if (!pl) return;
      if (lineOut(pl) <= 0) return tx.error('NOTHING', `บรรทัด ${pl.line} ไม่มีของค้างรับ`);
      const due = parseDate(p.dueDate);
      if (!due) return tx.error('BAD_DATE', 'กำหนดเข้าต้องเป็นวันที่จริงแบบ YYYY-MM-DD', { field: 'dueDate' });
      if (due < po.date) return tx.error('BAD_DATE', `กำหนดเข้า ${due} อยู่ก่อนวันที่ใบสั่งซื้อ ${po.date}`, { field: 'dueDate' });
      const reason = needReason(tx, p);
      if (!reason) return;
      const from = pl.dueDate;
      pl.dueDate = due;
      addLog(po, tx, 'due', { line: pl.line, from, to: due, reason });
      tx.put('pos', po.poNo, po);
      tx.summary = `${po.poNo} บรรทัด ${pl.line} กำหนดเข้า ${from} → ${due}`;
    },
  });

  define('po.cancelLine', {
    label: 'ยกเลิกยอดค้างของบรรทัดใบสั่งซื้อ', perm: 'po.manage',
    prepare(tx, p) {
      const po = getPo(tx, p.poNo);
      if (!po) return;
      if (po.status !== 'DRAFT' && !OPEN_PO[po.status]) return tx.error('BAD_STATE', `${po.poNo} ${PO_STATUS[po.status]} – ไม่มียอดค้างให้ยกเลิก`);
      const pl = poLineOf(tx, po, p.line);
      if (!pl) return;
      const out = lineOut(pl);
      if (out <= 0) return tx.error('NOTHING', `บรรทัด ${pl.line} ไม่มียอดค้าง`);
      let base = out;
      if (p.qty != null && p.qty !== '') {
        const q = util.num(p.qty);
        if (!(q > 0)) return tx.error('BAD_QTY', `จำนวนที่ยกเลิกต้องเป็นตัวเลขมากกว่า 0 (${pl.unit})`, { field: 'qty' });
        base = round(q * pl.factor);
        if (base > out + EPS) return tx.error('TOO_MUCH', `บรรทัด ${pl.line} ค้างรับ ${round(out / pl.factor, 4)} ${pl.unit} (${out} ${pl.baseUnit}) – ยกเลิกเกินไม่ได้`, { field: 'qty' });
      }
      const reason = needReason(tx, p);
      if (!reason) return;
      const before = po.status;
      pl.cancelled = round((pl.cancelled || 0) + base);
      addLog(po, tx, 'cancelLine', { line: pl.line, qty: base, reason });
      savePo(tx, po, before, reason);
      tx.result.status = po.status;
      tx.summary = `${po.poNo} บรรทัด ${pl.line} ยกเลิกยอดค้าง ${base} ${pl.baseUnit}`;
    },
  });

  define('po.cancel', {
    label: 'ยกเลิกใบสั่งซื้อ', perm: 'po.manage',
    prepare(tx, p) {
      const po = getPo(tx, p.poNo);
      if (!po) return;
      if (po.status === 'CANCELLED') return tx.error('ALREADY_CANCELLED', `${po.poNo} ยกเลิกไปแล้ว`);
      if (po.status !== 'DRAFT' && po.status !== 'ISSUED') return tx.error('BAD_STATE', `${po.poNo} ${PO_STATUS[po.status]} – ยกเลิกทั้งใบได้เฉพาะใบที่ยังไม่รับของ`);
      if (po.lines.some((l) => (l.received || 0) > 0 || (l.returned || 0) > 0)) {
        return tx.error('HAS_RECEIPTS', `${po.poNo} รับของแล้ว – ใช้ ยกเลิกยอดค้างรายบรรทัด หรือ ปิดยอดค้าง แทน`);
      }
      const reason = needReason(tx, p);
      if (!reason) return;
      for (const l of po.lines) l.cancelled = round((l.cancelled || 0) + lineOut(l));
      Object.assign(po, { status: 'CANCELLED', cancelledBy: tx.userId, cancelledAt: tx.now, cancelReason: reason });
      addLog(po, tx, 'cancel', { reason });
      tx.put('pos', po.poNo, po);
      tx.summary = `ยกเลิกใบสั่งซื้อ ${po.poNo}: ${reason}`;
    },
  });

  define('po.close', {
    label: 'ปิดยอดค้างใบสั่งซื้อ', perm: 'po.close',
    prepare(tx, p) {
      const po = getPo(tx, p.poNo);
      if (!po) return;
      if (!OPEN_PO[po.status] && po.status !== 'RECEIVED') return tx.error('BAD_STATE', `${po.poNo} ${PO_STATUS[po.status]} – ปิดยอดค้างได้เมื่อส่งผู้ขายแล้ว`);
      const reason = needReason(tx, p);
      if (!reason) return;
      const closed = [];
      for (const l of po.lines) {
        const out = lineOut(l);
        if (out > 0) {
          l.cancelled = round((l.cancelled || 0) + out);
          closed.push({ line: l.line, qty: out });
        }
      }
      Object.assign(po, { status: 'CLOSED', closedBy: tx.userId, closedAt: tx.now, closeReason: reason });
      addLog(po, tx, 'close', { reason, lines: closed });
      tx.put('pos', po.poNo, po);
      tx.result.closed = closed;
      tx.summary = `ปิดยอดค้าง ${po.poNo}${closed.length ? ' ' + closed.map((c) => 'บรรทัด ' + c.line + ' ' + c.qty).join(', ') : ''}`;
    },
  });

  define('po.allowOverReceive', {
    label: 'อนุมัติรับเกินใบสั่งซื้อ', perm: 'po.overReceive',
    prepare(tx, p) {
      const po = getPo(tx, p.poNo);
      if (!po) return;
      if (!OPEN_PO[po.status]) return tx.error('BAD_STATE', `${po.poNo} ${PO_STATUS[po.status]} – อนุมัติรับเกินได้เมื่อยังรับไม่ครบ`);
      const pl = poLineOf(tx, po, p.line);
      if (!pl) return;
      const q = util.num(p.qty);
      if (!(q > 0)) return tx.error('BAD_QTY', `จำนวนที่อนุมัติรับเกินต้องเป็นตัวเลขมากกว่า 0 (${pl.unit})`, { field: 'qty' });
      const reason = needReason(tx, p);
      if (!reason) return;
      const base = round(q * pl.factor);
      pl.overAllowed = round((pl.overAllowed || 0) + base);
      pl.overApprovals = (pl.overApprovals || []).concat([{ qty: base, by: tx.userId, at: tx.now, reason }]);
      addLog(po, tx, 'allowOver', { line: pl.line, qty: base, reason });
      tx.put('pos', po.poNo, po);
      tx.summary = `${po.poNo} บรรทัด ${pl.line} อนุมัติรับเกิน ${base} ${pl.baseUnit}`;
    },
  });

  function newDoc(tx, type, po, p, lines, remark) {
    return {
      docNo: '', type, date: tx.date, status: 'DRAFT', job: '', department: '', ref: po.poNo, remark, lines,
      createdBy: tx.userId, createdAt: tx.now, postedBy: '', postedAt: '', cancelledBy: '', cancelledAt: '', cancelReason: '',
      override: null, expressStatus: '', expressNo: '', source: 'po:' + po.poNo, supplier: po.supplier,
      supplierDoc: util.trim(p.supplierDoc).slice(0, 60),
    };
  }
  /** Document lines (base unit) from PO line references [{line, qty (buy unit), wh?, bin, lot?, status?}]. */
  function docLinesFromPo(tx, po, p, verb) {
    if (!Array.isArray(p.lines) || !p.lines.length) return tx.error('REQUIRED', `ระบุบรรทัดที่${verb}`, { field: 'lines' }) && null;
    const out = [];
    p.lines.forEach((r, i) => {
      const n = i + 1;
      r = r || {};
      const pl = poLineOf(tx, po, r.line, n);
      if (!pl) return;
      const q = util.num(r.qty);
      if (!(q > 0)) return tx.error('BAD_QTY', `${at(n)}จำนวน${verb}ต้องเป็นตัวเลขมากกว่า 0 (${pl.unit})`, w(n, 'qty'));
      const base = round(q * pl.factor);
      out.push({ code: pl.code, qty: base, unit: '', wh: util.normCode(r.wh) || pl.wh, bin: util.normCode(r.bin), lot: util.trim(r.lot),
        status: r.status || '', poNo: po.poNo, poLine: pl.line, replace: yes(r.replace),
        remark: `PO ${po.poNo} บรรทัด ${pl.line}: ${round(q)} ${pl.unit}${pl.factor !== 1 ? ' (' + base + ' ' + pl.baseUnit + ')' : ''}` });
    });
    return tx.ok ? out : null;
  }

  define('po.receive', {
    label: 'รับสินค้าตามใบสั่งซื้อ', perm: 'po.receive',
    prepare(tx, p) {
      const po = getPo(tx, p.poNo);
      if (!po) return;
      if (!OPEN_PO[po.status]) return tx.error('BAD_STATE', `${po.poNo} ${PO_STATUS[po.status]} – รับได้เมื่อส่งผู้ขายแล้วและยังรับไม่ครบ`);
      const lines = docLinesFromPo(tx, po, p, 'รับ');
      if (!lines) return;
      for (const l of lines) delete l.replace;
      const d = newDoc(tx, 'RR', po, p, lines, util.trim(p.remark).slice(0, 300) || `รับตาม ${po.poNo} ${po.supplierName || po.supplier}`);
      if (util.trim(p.date)) {
        const dd = parseDate(p.date);
        if (!dd) return tx.error('BAD_DATE', 'วันที่รับต้องเป็นวันที่จริงแบบ YYYY-MM-DD', { field: 'date' });
        d.date = dd;
      }
      const row = inv.post(tx, d);
      if (!row) return;
      const after = tx.get('pos', po.poNo);
      tx.result.docNo = row.docNo;
      tx.result.poStatus = after.status;
      tx.summary = `รับตาม ${po.poNo} → ${row.docNo} ${row.lines.length} บรรทัด (${PO_STATUS[after.status]})`;
    },
  });

  define('po.return', {
    label: 'คืนสินค้าผู้ขายตามใบสั่งซื้อ', perm: 'po.receive',
    prepare(tx, p) {
      const po = getPo(tx, p.poNo);
      if (!po) return;
      if (po.status === 'DRAFT' || po.status === 'CANCELLED') return tx.error('BAD_STATE', `${po.poNo} ${PO_STATUS[po.status]} – ไม่มีของที่รับจากใบนี้`);
      const reason = needReason(tx, p);
      if (!reason) return;
      const lines = docLinesFromPo(tx, po, p, 'คืน');
      if (!lines) return;
      const replaceLines = [];
      lines.forEach((l, i) => {
        if (l.replace) replaceLines.push(i + 1);
        delete l.replace;
      });
      const d = newDoc(tx, 'RV', po, p, lines, `คืนผู้ขาย ${po.supplier}: ${reason}`);
      d.replaceLines = replaceLines;
      const row = inv.post(tx, d);
      if (!row) return;
      const after = tx.get('pos', po.poNo);
      tx.result.docNo = row.docNo;
      tx.result.poStatus = after.status;
      tx.summary = `คืนผู้ขายตาม ${po.poNo} → ${row.docNo}${replaceLines.length ? ' (ขอของทดแทน)' : ''}`;
    },
  });

  // ---------------------------------------------------------------------------------------------------------
  // document hooks: RR / RV lines that point at a PO line
  // ---------------------------------------------------------------------------------------------------------
  function overCheck(tx, pl, sum) {
    const pct = Number((tx.settings().policies || {}).overReceivePct) || 0;
    const out = lineOut(pl);
    const tol = round(out * (1 + pct / 100));
    const allowed = round(pl.overAllowed || 0);
    if (sum <= tol + EPS) return { ok: true, overUse: 0, byPerm: 0, out, tol, allowed, pct };
    const excess = round(sum - tol);
    if (excess <= allowed + EPS) return { ok: true, overUse: excess, byPerm: 0, out, tol, allowed, pct };
    if (tx.can('po.overReceive')) return { ok: true, overUse: allowed, byPerm: round(excess - allowed), out, tol, allowed, pct };
    return { ok: false, out, tol, allowed, pct, limit: round(tol + allowed) };
  }
  /** Lines of a document grouped per PO line: [{poNo, poLine, sum, replace, lines}] */
  function poGroups(doc, lines) {
    const rep = {};
    for (const n of doc.replaceLines || []) rep[Number(n)] = true;
    const g = {};
    const order = [];
    for (const ln of lines || []) {
      if (!ln || !ln.poNo) continue;
      const k = ln.poNo + '|' + ln.poLine;
      if (!g[k]) {
        g[k] = { poNo: ln.poNo, poLine: Number(ln.poLine), sum: 0, replace: 0, lines: [], baseUnit: ln.baseUnit || '' };
        order.push(k);
      }
      const q = Math.abs(ln.base || 0);
      g[k].sum = round(g[k].sum + q);
      if (rep[ln.line]) g[k].replace = round(g[k].replace + q);
      g[k].lines.push(ln.line);
    }
    return order.map((k) => g[k]);
  }

  RRS.hooks.on('doc.lineCheck', function purchasingLineCheck(tx, doc, line) {
    if (!line.poNo && !line.poLine) return;
    const n = line.line;
    if (!PO_DOC[doc.type]) {
      tx.warn(`บรรทัด ${n}: ${doc.type} ไม่ผูกกับใบสั่งซื้อ – ไม่เปลี่ยนยอดค้างรับ`);
      return;
    }
    const poNo = util.normCode(line.poNo);
    if (!poNo) return tx.error('REQUIRED', `บรรทัด ${n}: ระบุเลขที่ใบสั่งซื้อของบรรทัด PO ${line.poLine}`, w(n, 'poNo'));
    const po = tx.get('pos', poNo);
    if (!po) return tx.error('NOT_FOUND', `บรรทัด ${n}: ไม่พบใบสั่งซื้อ ${poNo}`, w(n, 'poNo'));
    if (line.poLine == null || line.poLine === '') return tx.error('REQUIRED', `บรรทัด ${n}: ระบุบรรทัดของใบสั่งซื้อ ${poNo}`, w(n, 'poLine'));
    const pl = poLineOf(tx, po, line.poLine, n);
    if (!pl) return;
    if (pl.code !== line.code) return tx.error('WRONG_ITEM', `บรรทัด ${n}: ${poNo} บรรทัด ${pl.line} เป็นของ ${pl.code} ไม่ใช่ ${line.code}`, w(n, 'code'));
    if (doc.type === 'RR') {
      if (!OPEN_PO[po.status]) return tx.error('BAD_STATE', `บรรทัด ${n}: ใบสั่งซื้อ ${poNo} ${PO_STATUS[po.status]} – รับได้เมื่อส่งผู้ขายแล้วและยังรับไม่ครบ`, w(n, 'poNo'));
      if (!tx.can('po.receive', line.wh)) return tx.need('po.receive', line.wh, w(n));
      if (pl.wh && line.wh !== pl.wh) tx.warn(`บรรทัด ${n}: ${poNo} บรรทัด ${pl.line} สั่งเข้าคลัง ${pl.wh} แต่รับเข้าคลัง ${line.wh}`);
    } else if (po.status === 'DRAFT' || po.status === 'CANCELLED') {
      return tx.error('BAD_STATE', `บรรทัด ${n}: ใบสั่งซื้อ ${poNo} ${PO_STATUS[po.status]} – ไม่มีของที่รับจากใบนี้`, w(n, 'poNo'));
    }
    line.poNo = poNo;
    line.poLine = pl.line;
  });

  RRS.hooks.on('doc.check', function purchasingDocCheck(tx, doc, lines) {
    if (!PO_DOC[doc.type]) return;
    for (const g of poGroups(doc, lines)) {
      const po = tx.get('pos', g.poNo);
      const pl = po && po.lines.find((l) => l.line === g.poLine);
      if (!pl) continue;
      const where = { line: g.lines[0], field: 'qty' };
      const ls = g.lines.join(', ');
      if (doc.type === 'RR') {
        const r = overCheck(tx, pl, g.sum);
        if (!r.ok) {
          tx.error('OVER_RECEIVE', `บรรทัด ${ls}: ${pl.code} ${g.poNo} บรรทัด ${pl.line} ค้างรับ ${r.out} ${pl.baseUnit} รับได้ไม่เกิน ${r.limit} (เผื่อรับเกิน ${r.pct}%${r.allowed ? ' + อนุมัติรับเกิน ' + r.allowed : ''}) แต่รับ ${g.sum} – ให้หัวหน้าจัดซื้ออนุมัติรับเกินก่อน`, where);
        }
      } else {
        const kept = pos0((pl.received || 0) + (pl.replaced || 0) - (pl.returned || 0));
        if (g.sum > kept + EPS) {
          tx.error('RETURN_OVER', `บรรทัด ${ls}: ${g.poNo} บรรทัด ${pl.line} รับ ${pl.code} ไว้ ${kept} ${pl.baseUnit} – คืนผู้ขายเกินกว่าที่รับจากใบนี้ไม่ได้`, where);
        }
        if (g.replace > 0 && (po.status === 'CLOSED' || po.status === 'CANCELLED')) {
          tx.error('BAD_STATE', `บรรทัด ${ls}: ${g.poNo} ${PO_STATUS[po.status]} – คืนแบบขอของทดแทนไม่ได้ (คืนแบบลดหนี้ได้)`, where);
        }
      }
    }
  });

  RRS.hooks.on('doc.posted', function purchasingPosted(tx, doc, lines) {
    if (!PO_DOC[doc.type]) return;
    const groups = poGroups(doc, lines);
    if (!groups.length) return;
    const cache = {};
    const before = {};
    for (const g of groups) {
      if (!cache[g.poNo]) {
        cache[g.poNo] = clone(tx.get('pos', g.poNo));
        before[g.poNo] = cache[g.poNo].status;
      }
      const po = cache[g.poNo];
      const pl = po.lines.find((l) => l.line === g.poLine);
      if (!pl) continue;
      if (doc.type === 'RR') {
        const r = overCheck(tx, pl, g.sum);
        pl.received = round((pl.received || 0) + g.sum);
        pl.overAllowed = round((pl.overAllowed || 0) - (r.overUse || 0));
        addLog(po, tx, 'receive', { docNo: doc.docNo, docType: doc.type, line: pl.line, docLines: g.lines, qty: g.sum,
          overUse: r.overUse || 0, overByPerm: r.byPerm || 0 });
      } else {
        pl.returned = round((pl.returned || 0) + g.sum);
        if (g.replace > 0) {
          pl.replaced = round((pl.replaced || 0) + g.replace);
          pl.received = round((pl.received || 0) - g.replace);
        }
        addLog(po, tx, 'return', { docNo: doc.docNo, docType: doc.type, line: pl.line, docLines: g.lines, qty: g.sum, replace: g.replace });
      }
    }
    const st = {};
    for (const k in cache) st[k] = savePo(tx, cache[k], before[k]).status;
    tx.result.poStatus = Object.keys(st).length === 1 ? st[Object.keys(st)[0]] : st;
  });

  RRS.hooks.on('doc.cancelled', function purchasingCancelled(tx, doc, lines) {
    if (!PO_DOC[doc.type]) return;
    const groups = poGroups(doc, lines);
    if (!groups.length) return;
    const cache = {};
    const before = {};
    for (const g of groups) {
      if (!cache[g.poNo]) {
        const cur = tx.get('pos', g.poNo);
        if (!cur) continue;
        cache[g.poNo] = clone(cur);
        before[g.poNo] = cur.status;
      }
      const po = cache[g.poNo];
      const pl = po.lines.find((l) => l.line === g.poLine);
      if (!pl) continue;
      if (doc.type === 'RR') {
        const entry = (po.log || []).filter((e) => e.action === 'receive' && e.docNo === doc.docNo && e.line === pl.line).pop();
        const received = round((pl.received || 0) - g.sum);
        if (received < -EPS || round(received + (pl.replaced || 0) - (pl.returned || 0)) < -EPS) {
          tx.error('RETURNED', `ยกเลิก ${doc.docNo} ไม่ได้: ${po.poNo} บรรทัด ${pl.line} มีการคืนผู้ขาย (RV) หลังรับ – ยกเลิกใบคืนก่อน`, { line: g.lines[0] });
          continue;
        }
        pl.received = received;
        pl.overAllowed = round((pl.overAllowed || 0) + ((entry && entry.overUse) || 0));
        let reopened = 0;
        if (po.status === 'CLOSED') {
          reopened = lineOut(pl);
          if (reopened > 0) pl.cancelled = round((pl.cancelled || 0) + reopened);
        }
        addLog(po, tx, 'receiveUndo', { docNo: doc.docNo, docType: doc.type, line: pl.line, qty: g.sum,
          closedAgain: reopened, reason: doc.cancelReason || '' });
      } else {
        pl.returned = round((pl.returned || 0) - g.sum);
        if (g.replace > 0) {
          pl.replaced = round((pl.replaced || 0) - g.replace);
          pl.received = round((pl.received || 0) + g.replace);
        }
        addLog(po, tx, 'returnUndo', { docNo: doc.docNo, docType: doc.type, line: pl.line, qty: g.sum, replace: g.replace,
          reason: doc.cancelReason || '' });
      }
    }
    for (const k in cache) savePo(tx, cache[k], before[k]);
  });

  // ---------------------------------------------------------------------------------------------------------
  // read helpers (pure functions of a state)
  // ---------------------------------------------------------------------------------------------------------
  const P = (RRS.purchasing = RRS.purchasing || {});
  Object.assign(P, { PR_STATUS, PO_STATUS, Z, DEFAULT_LEAD, DEFAULT_COVER, DEFAULT_USAGE_DAYS, lineOutstanding: lineOut,
    statusOf: poStatusOf, roundBuy });

  const rows = (state, t, f) => RRS.q.rows(state, t, f);
  function needToday(opts) {
    const t = parseDate(opts && opts.today);
    if (!t) throw new Error('RRS.purchasing: ต้องระบุ today แบบ YYYY-MM-DD');
    return t;
  }
  const fmt = (n) => String(round(n, 4));
  function codeFilter(state, code) {
    if (!code) return '';
    const it = RRS.q.item(state, code);
    return it ? it.id : null;
  }

  /** Open PO lines with something outstanding. opts {today, code?, supplier?, wh?, includeDraft?} – soonest first. */
  P.outstanding = function outstanding(state, opts) {
    opts = opts || {};
    const today = needToday(opts);
    const code = codeFilter(state, opts.code);
    if (code === null) return [];
    const sup = util.normCode(opts.supplier);
    const wh = util.normCode(opts.wh);
    const items = state.tables.items || {};
    const out = [];
    for (const po of rows(state, 'pos', (x) => OPEN_PO[x.status] || (opts.includeDraft && x.status === 'DRAFT'))) {
      if (sup && po.supplier !== sup) continue;
      for (const l of po.lines || []) {
        if (code && l.code !== code) continue;
        if (wh && l.wh !== wh) continue;
        const o = lineOut(l);
        if (!(o > 0)) continue;
        const late = !!l.dueDate && l.dueDate < today && po.status !== 'DRAFT';
        out.push({
          poNo: po.poNo, line: l.line, status: po.status, statusLabel: PO_STATUS[po.status], supplier: po.supplier,
          supplierName: po.supplierName || '', code: l.code, name: (items[l.code] || {}).name || l.name || '',
          baseUnit: l.baseUnit || (items[l.code] || {}).baseUnit || '', wh: l.wh, unit: l.unit, factor: l.factor, qty: l.qty,
          base: l.base, received: l.received || 0, returned: l.returned || 0, cancelled: l.cancelled || 0, outstanding: o,
          outstandingBuy: round(o / (l.factor || 1), 4), price: l.price, dueDate: l.dueDate, originalDue: l.originalDue || l.dueDate,
          late, daysLate: late ? util.daysBetween(l.dueDate, today) : 0, prNo: l.prNo || '', prLine: l.prLine || '',
        });
      }
    }
    return out.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)) || a.poNo.localeCompare(b.poNo) || a.line - b.line);
  };

  /** Movements that count as usage, per item: PD/OU (opts.types), cancelled documents left out on both sides. */
  function usageIndex(state, types) {
    const ms = rows(state, 'movements');
    const reversed = new Set();
    for (const m of ms) if (m.reversalOf) reversed.add(m.reversalOf);
    const by = {};
    for (const m of ms) {
      if (m.reversalOf || reversed.has(m.id)) continue;
      if (types.indexOf(m.docType) < 0 || m.wh === TRANSIT) continue;
      (by[m.code] || (by[m.code] = [])).push(m);
    }
    return by;
  }
  function usageOf(list, today, days, wh) {
    const from = util.addDays(today, 1 - days);
    const daily = {};
    let total = 0;
    for (const m of list || []) {
      if (wh && m.wh !== wh) continue;
      const d = String(m.date || '').slice(0, 10);
      if (d < from || d > today) continue;
      const q = -Number(m.qty || 0);
      daily[d] = (daily[d] || 0) + q;
      total += q;
    }
    const avg = total / days;
    const keys = Object.keys(daily);
    let ss = (days - keys.length) * avg * avg;
    for (const k of keys) ss += (daily[k] - avg) * (daily[k] - avg);
    const sd = Math.sqrt(Math.max(0, ss) / days);
    return { avgDay: round(avg, 4), sd: round(sd, 4), days, total: round(total), from, to: today,
      activeDays: keys.filter((k) => round(daily[k]) !== 0).length };
  }
  function daysOpt(v, d) {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? n : d;
  }
  /**
   * Daily usage of an item over the last `days` days up to and including today (issues PD/OU, cancelled documents
   * excluded). opts {today, days (default 90), wh?, types?} → {avgDay, sd (population), days, total, from, to, activeDays}.
   */
  P.usage = function usage(state, code, opts) {
    opts = opts || {};
    const today = needToday(opts);
    const days = daysOpt(opts.days, DEFAULT_USAGE_DAYS);
    const id = codeFilter(state, code);
    const types = opts.types || USAGE_TYPES;
    const list = id ? usageIndex(state, types)[id] : [];
    return Object.assign({ code: id || '' }, usageOf(list, today, days, util.normCode(opts.wh)));
  };

  /** Supplier terms used for an item: rule supplier, else the preferred one, else the only active one. */
  function supplierFor(state, code, ruleSupplier) {
    const links = rows(state, 'item_suppliers', (x) => x.code === code && x.active !== false);
    const sups = state.tables.suppliers || {};
    const ok = (l) => l && (sups[l.supplier] || {}).active !== false;
    if (ruleSupplier) {
      const l = links.find((x) => x.supplier === ruleSupplier);
      return { link: ok(l) ? l : null, supplier: ruleSupplier, from: 'เงื่อนไขเติมสต็อก' };
    }
    const pref = links.find((x) => x.preferred && ok(x));
    if (pref) return { link: pref, supplier: pref.supplier, from: 'ผู้ขายหลัก' };
    const act = links.filter(ok);
    if (act.length === 1) return { link: act[0], supplier: act[0].supplier, from: 'ผู้ขายรายเดียวที่ตั้งไว้' };
    return { link: null, supplier: '', from: act.length ? `มีผู้ขาย ${act.length} รายแต่ยังไม่เลือกผู้ขายหลัก` : 'ยังไม่ได้ตั้งผู้ขาย' };
  }
  P.preferredSupplier = function preferredSupplier(state, code) {
    const id = codeFilter(state, code);
    if (!id) return null;
    const s = supplierFor(state, id, '');
    return s.link ? Object.assign({}, s.link, { from: s.from }) : null;
  };

  /** Everything suggest() needs, indexed by item once. */
  function buildIndex(state, today, wh) {
    const idx = { bal: {}, res: {}, jobRes: {}, demand: {}, demandTotal: {}, po: {}, draft: {}, pr: {}, transit: {} };
    const get = (o, k, d) => o[k] || (o[k] = d());
    const docs = state.tables.documents || {};
    for (const b of rows(state, 'balances')) {
      if (b.wh === TRANSIT) {
        if (b.status !== STATUS.AVAILABLE) continue;
        if (wh) {
          const d = docs[b.bin];
          const dl = d && (d.lines || []).find((l) => l.code === b.code);
          if (!dl || dl.toWh !== wh) continue;
        }
        idx.transit[b.code] = round((idx.transit[b.code] || 0) + b.qty);
        continue;
      }
      if (wh && b.wh !== wh) continue;
      const r = get(idx.bal, b.code, () => ({ available: 0, qcHold: 0, quarantine: 0 }));
      if (b.status === STATUS.AVAILABLE) r.available = round(r.available + b.qty);
      else if (b.status === STATUS.QC_HOLD) r.qcHold = round(r.qcHold + b.qty);
      else r.quarantine = round(r.quarantine + b.qty);
    }
    for (const r of rows(state, 'reservations', (x) => x.status === 'OPEN' || x.status === 'PARTIAL')) {
      const rem = pos0((r.qty || 0) - (r.issued || 0));
      if (!rem) continue;
      const jk = r.jobNo + '|' + r.code;
      idx.jobRes[jk] = round((idx.jobRes[jk] || 0) + rem);
      if (wh && r.wh !== wh) continue;
      idx.res[r.code] = round((idx.res[r.code] || 0) + rem);
    }
    for (const j of rows(state, 'jobs', (x) => OPEN_JOB[x.status])) {
      const per = {};
      for (const l of j.lines || []) {
        if (l.output) continue;
        per[l.code] = round((per[l.code] || 0) + pos0((l.required || 0) - (l.issued || 0)));
      }
      for (const code in per) {
        if (!per[code]) continue;
        idx.demandTotal[code] = round((idx.demandTotal[code] || 0) + per[code]);
        const un = pos0(per[code] - (idx.jobRes[j.jobNo + '|' + code] || 0));
        if (un) idx.demand[code] = round((idx.demand[code] || 0) + un);
      }
    }
    const poRows = rows(state, 'pos');
    for (const po of poRows) {
      const open = OPEN_PO[po.status];
      if (!open && po.status !== 'DRAFT') continue;
      for (const l of po.lines || []) {
        if (wh && l.wh !== wh) continue;
        const o = lineOut(l);
        if (!(o > 0)) continue;
        const e = { poNo: po.poNo, line: l.line, supplier: po.supplier, qty: o, dueDate: l.dueDate || '' };
        get(open ? idx.po : idx.draft, l.code, () => []).push(e);
      }
    }
    for (const pr of rows(state, 'prs', (x) => PENDING_PR[x.status] && !x.restCancelled)) {
      for (const l of pr.lines || []) {
        if (wh && l.wh !== wh) continue;
        const o = prLineOpen(pr, l, poRows);
        if (!(o > 0)) continue;
        get(idx.pr, l.code, () => []).push({ prNo: pr.prNo, line: l.line, status: pr.status, qty: o, needDate: l.needDate });
      }
    }
    return idx;
  }

  /**
   * Purchase suggestion, one row per active item (per warehouse when opts.wh is given). opts {today, wh?, code?,
   * onlyOrder?}. Row: {code, name, baseUnit, wh, available, qcHold, quarantine, transit, reserved, free, incomingSure,
   * incomingLate, lateCounted, incomingLater, demand (not covered by reservations), demandTotal, projected, min, max,
   * minMaxFrom, leadDays, leadFrom, supplier, supplierName, buyUnit, factor, moq, pack, price, usage, need, pendingPr,
   * draftPo, orderQty (base), orderBuyQty, amount, needDate, status ORDER/COVERED/OK/OFF, poLines, prLines, reasons[]}.
   */
  P.suggest = function suggest(state, opts) {
    opts = opts || {};
    const today = needToday(opts);
    const wh = util.normCode(opts.wh);
    const only = codeFilter(state, opts.code);
    if (only === null) return [];
    const settings = RRS.q.get(state, 'settings', 'main') || RRS.defaultSettings();
    const countLate = (settings.policies || {}).lateIsUncertain === false;
    const items = state.tables.items || {};
    const sups = state.tables.suppliers || {};
    const rules = state.tables.reorder_rules || {};
    const idx = buildIndex(state, today, wh);
    const useIdx = usageIndex(state, USAGE_TYPES);
    const out = [];
    for (const code of Object.keys(items).sort()) {
      const it = items[code];
      if (it.active === false || (only && code !== only)) continue;
      const unit = it.baseUnit || '';
      const u = (n) => `${fmt(n)} ${unit}`;
      const reasons = [];
      const rule = (wh && rules[code + '|' + wh]) || rules[code + '|'] || null;
      const ruleWhere = rule ? (rule.wh ? `คลัง ${rule.wh}` : 'ทุกคลัง') : '';
      // supplier and lead time
      const sf = supplierFor(state, code, rule && rule.supplier);
      const link = sf.link;
      const sup = sf.supplier ? sups[sf.supplier] || null : null;
      let leadDays = DEFAULT_LEAD;
      let leadFrom = 'ค่าเริ่มต้น 7 วัน';
      if (rule && rule.leadDays != null) {
        leadDays = rule.leadDays;
        leadFrom = `เงื่อนไขเติมสต็อก${ruleWhere}`;
      } else if (link && link.leadDays != null) {
        leadDays = link.leadDays;
        leadFrom = `Lead time ของ ${code} กับผู้ขาย ${sf.supplier}`;
      } else if (sup && sup.leadDays != null && sup.leadDays !== '') {
        leadDays = Number(sup.leadDays);
        leadFrom = `Lead time ของผู้ขาย ${sf.supplier}`;
      }
      const horizon = util.addDays(today, leadDays);
      const buyUnit = link ? link.buyUnit : unit;
      const factor = link ? link.factor : 1;
      const moq = link ? link.moq || 0 : 0;
      const pack = link ? link.pack || 0 : 0;
      reasons.push(sf.supplier ? `ผู้ขาย ${sf.supplier}${sup ? ' ' + sup.name : ''} (${sf.from})${link ? '' : ' – ยังไม่ได้ตั้งหน่วยซื้อ/ราคา ใช้หน่วยหลัก'}`
        : `${sf.from} – ใช้หน่วยหลัก ไม่มี MOQ/แพ็ก`);
      reasons.push(`Lead time ${leadDays} วัน (${leadFrom}) → ของที่สั่งวันนี้เข้าประมาณ ${horizon}`);
      // stock
      const b = idx.bal[code] || { available: 0, qcHold: 0, quarantine: 0 };
      const reserved = idx.res[code] || 0;
      const transit = idx.transit[code] || 0;
      const free = round(b.available - reserved);
      reasons.push(`พร้อมใช้ ${u(b.available)} (เฉพาะสถานะใช้ได้${wh ? ' คลัง ' + wh : ' ทุกคลัง'})`);
      if (b.qcHold > 0) reasons.push(`รอตรวจ ${u(b.qcHold)} – ยังไม่นับเป็นของพร้อมเบิก`);
      if (b.quarantine > 0) reasons.push(`กักกัน/รอแก้ไข ${u(b.quarantine)} – ไม่นับ`);
      if (reserved > 0) reasons.push(`จองให้งานแล้ว ${u(reserved)} → เหลือใช้ได้ ${u(free)}${free < 0 ? ' (จองเกินของที่มี)' : ''}`);
      if (transit > 0) reasons.push(`ระหว่างโอน${wh ? 'เข้าคลัง ' + wh : 'ภายใน'} ${u(transit)} – นับรวม`);
      // incoming
      let sure = 0;
      let late = 0;
      let later = 0;
      const poLines = [];
      for (const e of idx.po[code] || []) {
        let kind = 'later';
        if (!e.dueDate) kind = 'later';
        else if (e.dueDate < today) kind = 'late';
        else if (e.dueDate <= horizon) kind = 'sure';
        if (kind === 'sure') sure = round(sure + e.qty);
        else if (kind === 'late') late = round(late + e.qty);
        else later = round(later + e.qty);
        poLines.push(Object.assign({ kind, counted: kind === 'sure' || (kind === 'late' && countLate) }, e));
      }
      const list = (k) => poLines.filter((e) => e.kind === k).map((e) => `${e.poNo}/${e.line} ${fmt(e.qty)} กำหนด ${e.dueDate || '-'}`).join(', ');
      if (sure > 0) reasons.push(`ค้างรับจาก PO ที่เข้าทันภายใน ${leadDays} วัน ${u(sure)}: ${list('sure')}`);
      if (late > 0) reasons.push(`PO เลยกำหนด ${u(late)}: ${list('late')} – ${countLate ? 'นับรวม (นโยบาย: ของล่าช้ายังนับ)' : 'ไม่นับ (นโยบาย: ของล่าช้าไม่แน่นอน)'}`);
      if (later > 0) reasons.push(`PO ที่เข้าหลังรอบเติม ${u(later)}: ${list('later')} – ไม่นับ (เข้าไม่ทัน)`);
      // demand
      const demand = idx.demand[code] || 0;
      const demandTotal = idx.demandTotal[code] || 0;
      if (demandTotal > 0) reasons.push(`ใบงานเปิดยังต้องใช้ ${u(demandTotal)}${demandTotal > demand ? ` จองแล้วบางส่วน เหลือที่ยังไม่จอง ${u(demand)}` : ''}${wh ? ' (ใบงานไม่ระบุคลัง นับเต็มจำนวน)' : ''}`);
      const projected = round(free + transit + sure + (countLate ? late : 0) - demand);
      reasons.push(`คาดการณ์คงเหลือ = ใช้ได้ ${fmt(free)}${transit ? ' + ระหว่างโอน ' + fmt(transit) : ''} + ค้างรับที่เข้าทัน ${fmt(sure)}${countLate && late ? ' + PO เลยกำหนด ' + fmt(late) : ''} − ความต้องการที่ยังไม่จอง ${fmt(demand)} = ${u(projected)}`);
      // min / max
      const usageDays = (rule && rule.usageDays) || DEFAULT_USAGE_DAYS;
      const coverDays = rule && rule.coverDays != null ? rule.coverDays : DEFAULT_COVER;
      const us = usageOf(useIdx[code], today, usageDays, wh);
      let min;
      let max;
      let minMaxFrom;
      if (rule && (rule.min != null || rule.max != null)) {
        min = rule.min != null ? rule.min : 0;
        max = rule.max != null ? rule.max : min;
        minMaxFrom = `เงื่อนไขเติมสต็อก${ruleWhere}`;
      } else if ((it.minQty || 0) > 0 || (it.maxQty || 0) > 0) {
        min = it.minQty || 0;
        max = it.maxQty || min;
        minMaxFrom = 'ทะเบียนสินค้า';
      } else if (us.total > 0) {
        min = Math.ceil(round(us.avgDay * leadDays + Z * us.sd * Math.sqrt(leadDays), 6));
        max = Math.ceil(round(min + us.avgDay * coverDays, 6));
        minMaxFrom = `สถิติยอดใช้ ${usageDays} วัน (เฉลี่ย ${fmt(us.avgDay)}/วัน, SD ${fmt(us.sd)}): Min = ⌈${fmt(us.avgDay)}×${leadDays} + ${Z}×${fmt(us.sd)}×√${leadDays}⌉, Max = Min + ${fmt(us.avgDay)}×${coverDays}`;
      } else {
        min = 0;
        max = 0;
        minMaxFrom = 'ไม่มีประวัติการใช้และไม่ได้ตั้ง Min/Max';
      }
      max = Math.max(max, min);
      reasons.push(`Min ${fmt(min)} / Max ${fmt(max)} (${minMaxFrom})`);
      // order quantity
      const pendingPrLines = idx.pr[code] || [];
      const draftLines = idx.draft[code] || [];
      const pendingPr = round(pendingPrLines.reduce((s, e) => s + e.qty, 0));
      const draftPo = round(draftLines.reduce((s, e) => s + e.qty, 0));
      let need = 0;
      let orderBuyQty = 0;
      let orderQty = 0;
      let status = 'OK';
      const off = rule && rule.active === false;
      if (off) {
        status = 'OFF';
        reasons.push(`ปิดการแนะนำสั่งซื้อ (เงื่อนไขเติมสต็อก${ruleWhere})`);
      } else if (projected <= min) {
        need = pos0(max - projected);
        if (need > 0) {
          reasons.push(`คาดการณ์ ${fmt(projected)} ≤ Min ${fmt(min)} → ต้องเติม = Max ${fmt(max)} − ${fmt(projected)} = ${u(need)}`);
          const left = round(need - pendingPr - draftPo);
          if (pendingPr > 0 || draftPo > 0) {
            reasons.push(`หักที่ขอซื้อ/สั่งไว้แล้วแต่ยังไม่ออก PO ${fmt(pendingPr + draftPo)}${pendingPr ? ' (PR ' + pendingPrLines.map((e) => e.prNo + '/' + e.line + ' ' + fmt(e.qty)).join(', ') + ')' : ''}${draftPo ? ' (PO ร่าง ' + draftLines.map((e) => e.poNo + '/' + e.line + ' ' + fmt(e.qty)).join(', ') + ')' : ''} → เหลือ ${u(Math.max(0, left))}`);
          }
          if (left > 0) {
            orderBuyQty = roundBuy(left, factor, moq, pack);
            orderQty = round(orderBuyQty * factor);
            status = 'ORDER';
            reasons.push(`สั่ง ${fmt(orderBuyQty)} ${buyUnit}${factor !== 1 ? ` × ${fmt(factor)} = ${u(orderQty)}` : ''} (ปัดขึ้นเป็นหน่วยซื้อเต็ม${moq ? `, ขั้นต่ำ ${fmt(moq)} ${buyUnit}` : ''}${pack ? `, แพ็กละ ${fmt(pack)} ${buyUnit}` : ''})`);
          } else {
            status = 'COVERED';
            reasons.push('ใบขอซื้อ/PO ร่างที่มีอยู่ครอบคลุมแล้ว – ไม่ต้องสร้างใหม่ (ให้ออก PO จากใบขอซื้อเดิม)');
          }
        } else {
          reasons.push(`คาดการณ์ ${fmt(projected)} ไม่ต่ำกว่า Max ${fmt(max)} – ยังไม่ต้องสั่ง`);
        }
      } else {
        reasons.push(`คาดการณ์ ${fmt(projected)} สูงกว่า Min ${fmt(min)} – ยังไม่ต้องสั่ง`);
      }
      const price = link && link.price != null ? link.price : null;
      const row = {
        code, name: it.name || '', type: it.type || '', baseUnit: unit, wh: wh || '', available: b.available, qcHold: b.qcHold,
        quarantine: b.quarantine, transit, reserved, free, incomingSure: sure, incomingLate: late, lateCounted: countLate,
        incomingLater: later, demand, demandTotal, projected, min, max, minMaxFrom, leadDays, leadFrom,
        supplier: sf.supplier, supplierName: sup ? sup.name : '', supplierFrom: sf.from, buyUnit, factor, moq, pack, price,
        usage: { avgDay: us.avgDay, sd: us.sd, days: us.days, total: us.total }, need, pendingPr, draftPo, orderQty,
        orderBuyQty, amount: price != null ? round(orderBuyQty * price, 2) : null, needDate: horizon, status, poLines,
        prLines: pendingPrLines, reasons,
      };
      if (!opts.onlyOrder || orderQty > 0) out.push(row);
    }
    return out;
  };

  /** PR lines (pr.create payload) from the suggestion rows that need an order. */
  P.draftPrLines = function draftPrLines(state, opts) {
    opts = opts || {};
    const wh = util.normCode(opts.wh) || util.normCode(opts.defaultWh);
    return P.suggest(state, Object.assign({}, opts, { onlyOrder: true })).map((r) => ({
      code: r.code, qty: r.orderQty, needDate: r.needDate, wh: r.wh || wh, supplier: r.supplier,
      reason: `แนะนำสั่งซื้อ ${opts.today}: คาดการณ์ ${fmt(r.projected)} ≤ Min ${fmt(r.min)} → ${fmt(r.orderBuyQty)} ${r.buyUnit}`,
    }));
  };

  /** PR with the open (not yet ordered) qty of every line. */
  P.prOpen = function prOpen(state, prNo) {
    const pr = RRS.q.get(state, 'prs', util.normCode(prNo));
    if (!pr) return null;
    const poRows = rows(state, 'pos');
    return Object.assign({}, pr, { statusLabel: PR_STATUS[pr.status], lines: (pr.lines || []).map((l) => Object.assign({}, l, {
      ordered: orderedOf(poRows, pr.prNo, l.line), open: prLineOpen(pr, l, poRows) })) });
  };
  P.prs = function prs(state, f) {
    f = f || {};
    return rows(state, 'prs', (r) => (!f.status || r.status === f.status) && (!f.requestedBy || r.requestedBy === f.requestedBy))
      .sort((a, b) => String(b.prNo).localeCompare(String(a.prNo)));
  };
  P.pos = function pos(state, f) {
    f = f || {};
    const sup = util.normCode(f.supplier);
    return rows(state, 'pos', (r) => (!f.status || r.status === f.status) && (!sup || r.supplier === sup)
      && (!f.open || OPEN_PO[r.status])).sort((a, b) => String(b.poNo).localeCompare(String(a.poNo)));
  };
  P.itemSuppliers = function itemSuppliers(state, code) {
    const id = codeFilter(state, code);
    if (!id) return [];
    return rows(state, 'item_suppliers', (x) => x.code === id).sort((a, b) => (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0)
      || a.supplier.localeCompare(b.supplier));
  };

  /**
   * Late PO lines (dueDate < today, still outstanding) with the open jobs and reservations needing that item.
   * opts {today, atRisk?}: atRisk also lists lines not late yet that are due after a job's due date.
   * Row: {poNo, line, supplier, code, dueDate, daysLate, outstanding, late, jobs:[{jobNo, soNo, dueDate, priority, need,
   * reserved, uncovered, affected}], reservations:[{id, jobNo, wh, remaining, needDate, priority}], message}.
   */
  P.affectedJobs = function affectedJobs(state, opts) {
    opts = opts || {};
    const today = needToday(opts);
    const jobs = rows(state, 'jobs', (j) => OPEN_JOB[j.status]);
    const open = rows(state, 'reservations', (r) => (r.status === 'OPEN' || r.status === 'PARTIAL') && pos0((r.qty || 0) - (r.issued || 0)) > 0);
    const resOf = (jobNo, code) => round(open.filter((r) => r.jobNo === jobNo && r.code === code).reduce((s, r) => s + pos0(r.qty - (r.issued || 0)), 0));
    const out = [];
    for (const l of P.outstanding(state, { today })) {
      const js = [];
      for (const j of jobs) {
        let need = 0;
        for (const jl of j.lines || []) if (!jl.output && jl.code === l.code) need += pos0((jl.required || 0) - (jl.issued || 0));
        need = round(need);
        if (!(need > 0)) continue;
        if (!l.late && !(opts.atRisk && j.dueDate && j.dueDate < l.dueDate)) continue;
        const reserved = resOf(j.jobNo, l.code);
        const uncovered = pos0(need - reserved);
        js.push({ jobNo: j.jobNo, soNo: j.soNo || '', dueDate: j.dueDate || '', priority: j.priority, need, reserved, uncovered,
          affected: uncovered > 0 });
      }
      const rs = l.late ? open.filter((r) => r.code === l.code).map((r) => ({ id: r.id, jobNo: r.jobNo, wh: r.wh,
        remaining: pos0(r.qty - (r.issued || 0)), needDate: r.needDate || '', priority: r.priority })) : [];
      if (!js.length && !rs.length) continue;
      js.sort((a, b) => (a.priority - b.priority) || String(a.dueDate).localeCompare(String(b.dueDate)) || a.jobNo.localeCompare(b.jobNo));
      const hit = js.filter((j) => j.affected);
      out.push(Object.assign({}, l, {
        jobs: js, reservations: rs,
        message: `${l.poNo}/${l.line} ${l.code} ค้าง ${fmt(l.outstanding)} ${l.baseUnit} ${l.late ? `เลยกำหนด ${l.daysLate} วัน (กำหนด ${l.dueDate})` : `กำหนด ${l.dueDate} หลังวันต้องใช้ของงาน`}${hit.length ? ` – กระทบใบงาน ${hit.map((j) => j.jobNo + ' (ต้องใช้ ' + j.dueDate + ', ขาด ' + fmt(j.uncovered) + ')').join(', ')}` : ''}`,
      }));
    }
    return out.sort((a, b) => (b.daysLate - a.daysLate) || String(a.dueDate).localeCompare(String(b.dueDate)) || a.poNo.localeCompare(b.poNo));
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
