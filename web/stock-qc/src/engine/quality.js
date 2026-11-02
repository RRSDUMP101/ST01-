/*
 * Phase 5 – ล็อต คุณภาพ และการกักกัน เชื่อม RRS QC (P1).
 *
 * Tables: lots, qc_plans, inspections, ncrs (shapes in ENGINE_CONTRACT.md; extra fields are listed in the schema).
 *
 * Rules (plan file 01, Phase 5 + the QC proposal):
 *  - items say what is tracked (trackLot lot/heat/serial, certRequired); a receipt (RR/FR/RT/AJ+) of a tracked item
 *    creates the lot row (supplier/PO from the line or its PO, first document, time). trace() follows a lot from the
 *    receipt to the issues, the jobs, their FR outputs and DL deliveries; traceJob() goes back from a job to its lots.
 *  - the quality status of a balance (รอตรวจ / ใช้ได้ / กักกัน / รอแก้ไข) is separate from where the stock is. Only
 *    AVAILABLE is free to reserve or issue. Every status change is a QS document (เปลี่ยนสถานะคุณภาพ) with a pair of
 *    movements (− old status, + new status, same code/warehouse/bin/lot), so the history shows each change. QS is
 *    written by this module only: doc.post refuses it and doc.cancel cannot reverse it.
 *  - lot.quarantine moves every AVAILABLE / QC_HOLD balance of a lot to QUARANTINE and blocks every outgoing line of
 *    that lot (PD, OU, TR, DL, AJ− … – everything except SC ตัดทิ้ง and RV คืนผู้ขาย); a new receipt of that lot lands
 *    in QUARANTINE. lot.release sends the stock back to QC_HOLD – it must be inspected again, never straight to use.
 *  - QC: an inspection plan per item + stage (ตรวจรับ / ระหว่างผลิต / ก่อนส่งมอบ) comes from an approved drawing or work
 *    instruction (sourceRef) and is bound to the item's approved drawing revision. Results, photos and the inspector
 *    are stored; PASS waits for a release by another person with qc.release; FAIL opens an NCR and quarantines the qty.
 *    "ผลิตเสร็จ" is not "ผ่าน QC": FR of a qcFinal item lands in QC_HOLD and DL takes AVAILABLE stock only.
 *  - a re-inspection points at the earlier FAIL (or its NCR) of the same item + lot and keeps its drawing revision,
 *    unless the item's revision changed since (then revChanged and the current approved plan).
 *  - NCR decisions: REWORK (→ รอแก้ไข, then re-inspect), RETURN (RV from QUARANTINE), SCRAP (SC from QUARANTINE),
 *    USE_AS_IS (ncr.useAsIs + conditions, not the inspector). Who/when/why and the document number are stored.
 *    ncr.open raises an NCR for stock already quarantined (e.g. a whole lot) so it can be returned or scrapped.
 *    Stock of an open NCR cannot leave QUARANTINE any other way (lot.release leaves it, direct SC/RV are refused);
 *    cancelling the SC/RV of a decision puts the NCR back to รอตัดสิน (history kept).
 *  - status changes respect other modules' line checks (a count freeze refuses them), except lot.quarantine: the lot
 *    is blocked at once and a frozen bin keeps its balance until the count is approved (warning, quarantine again).
 *  - separation of duties: plan maker ≠ approver, cert entered by ≠ verified by, receipt poster ≠ inspector ≠
 *    releaser, quarantined by ≠ released by. Every row keeps a history list; nothing is deleted.
 * Every check is per warehouse (tx.need(perm, wh)). A failing command changes nothing.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { util, schema, commands, STATUS, STATUS_LABEL, TRANSIT } = RRS;
  const define = commands.define;
  const inv = RRS.inventory;
  const round = util.round;
  const clone = util.clone;
  const { AVAILABLE, QC_HOLD, QUARANTINE, REWORK } = STATUS;

  // ---------------------------------------------------------------------------------------------------------
  // tables
  // ---------------------------------------------------------------------------------------------------------
  schema.define('lots', {
    label: 'ล็อต / Heat / Serial และใบรับรองวัสดุ', phase: 5, key: ['code', 'lot'],
    note: 'สร้างอัตโนมัติเมื่อรับเข้า (RR/FR/RT/AJ+); สถานะล็อตแยกจากสถานะคุณภาพของยอดแต่ละตำแหน่ง',
    fields: [['code', 'text', 'รหัสสินค้า'], ['lot', 'text', 'ล็อต / Heat no. / Serial'], ['kind', 'enum', 'ชนิด', 'lot/heat/serial'],
      ['supplier', 'text', 'ผู้ขาย'], ['poNo', 'text', 'เลขที่ PO'], ['poLine', 'number', 'บรรทัดของ PO'],
      ['docNo', 'text', 'เอกสารรับเข้าครั้งแรก'],
      ['docType', 'text', 'ประเภทเอกสารรับเข้า'], ['receivedAt', 'datetime', 'รับเข้าเมื่อ'],
      ['cert', 'json', 'ใบรับรองวัสดุ {no, file, enteredBy, enteredAt, verified, verifiedBy, verifiedAt}'],
      ['status', 'enum', 'สถานะล็อต', 'ACTIVE/QUARANTINED'], ['note', 'text', 'หมายเหตุ'],
      ['quarantinedBy', 'text', 'ผู้กักกัน'], ['quarantinedAt', 'datetime', 'กักกันเมื่อ'], ['quarantineReason', 'text', 'เหตุผลกักกัน'],
      ['quarantineDocNo', 'text', 'เอกสาร QS ที่กักกัน'], ['releasedBy', 'text', 'ผู้ปลดกักกัน'], ['releasedAt', 'datetime', 'ปลดกักกันเมื่อ'],
      ['releaseReason', 'text', 'เหตุผลปลดกักกัน'], ['releaseDocNo', 'text', 'เอกสาร QS ที่ปลดกักกัน'],
      ['createdBy', 'text', 'ผู้สร้าง'], ['createdAt', 'datetime', 'สร้างเมื่อ'],
      ['history', 'json', 'ประวัติการเปลี่ยนแปลง {at, by, action, detail}']],
  });
  schema.define('qc_plans', {
    label: 'แผนตรวจ QC / เกณฑ์ตรวจ', phase: 5, key: 'id',
    note: 'เกณฑ์ต้องมาจากแบบหรือวิธีปฏิบัติที่อนุมัติ (sourceRef) และผูกกับฉบับแบบที่อนุมัติของสินค้า; แก้ได้เฉพาะร่าง',
    fields: [['id', 'text', 'เลขที่แผน (QP-00001)'], ['code', 'text', 'รหัสสินค้า'],
      ['stage', 'enum', 'ขั้นตอน', 'INCOMING/IN_PROCESS/FINAL'], ['drawingNo', 'text', 'เลขที่แบบ'],
      ['drawingRev', 'text', 'ฉบับแบบที่ใช้เป็นเกณฑ์'], ['sourceRef', 'text', 'อ้างอิงแบบ/วิธีปฏิบัติ (WI)'],
      ['sampling', 'text', 'วิธีสุ่มตรวจ'],
      ['chars', 'json', 'หัวข้อตรวจ {id, name, kind measure/check, nominal, min, max, unit, method}'],
      ['status', 'enum', 'สถานะ', 'DRAFT/APPROVED/OBSOLETE'], ['createdBy', 'text', 'ผู้จัดทำ'], ['createdAt', 'datetime', 'จัดทำเมื่อ'],
      ['updatedBy', 'text', 'ผู้แก้ล่าสุด'], ['updatedAt', 'datetime', 'แก้ล่าสุดเมื่อ'], ['approvedBy', 'text', 'ผู้อนุมัติ'],
      ['approvedAt', 'datetime', 'อนุมัติเมื่อ'], ['obsoletedBy', 'text', 'ผู้ทำให้เลิกใช้'], ['obsoletedAt', 'datetime', 'เลิกใช้เมื่อ'],
      ['replacedBy', 'text', 'แทนด้วยแผน'], ['history', 'json', 'ประวัติการเปลี่ยนแปลง {at, by, action, detail}']],
  });
  schema.define('inspections', {
    label: 'ผลตรวจ QC', phase: 5, key: 'id',
    note: 'ผลผ่านต้องปล่อยโดยผู้อนุมัติที่ไม่ใช่ผู้ตรวจ; ผลไม่ผ่านเปิด NCR และกักกันจำนวนนั้น',
    fields: [['id', 'text', 'เลขที่ผลตรวจ (IN-00001)'], ['stage', 'enum', 'ขั้นตอน', 'INCOMING/IN_PROCESS/FINAL'],
      ['code', 'text', 'รหัสสินค้า'], ['wh', 'text', 'คลัง'], ['bin', 'text', 'ช่องเก็บ'], ['lot', 'text', 'ล็อต'],
      ['qty', 'number', 'จำนวนที่ตรวจ (หน่วยหลัก)'], ['fromStatus', 'enum', 'สถานะก่อนตรวจ', 'QC_HOLD/REWORK'],
      ['sourceDoc', 'text', 'เอกสารต้นทาง'], ['jobNo', 'text', 'ใบงาน'], ['planId', 'text', 'แผนตรวจ'],
      ['planRev', 'text', 'ฉบับแบบที่ใช้ตรวจ'], ['sourceRef', 'text', 'อ้างอิงแบบ/WI ของแผน'],
      ['results', 'json', 'ผลแต่ละหัวข้อ {char, name, kind, value, ok, min, max, unit}'], ['photos', 'json', 'รูปหลักฐาน {name, url}'],
      ['inspector', 'text', 'ผู้ตรวจ'], ['at', 'datetime', 'ตรวจเมื่อ'], ['result', 'enum', 'ผล', 'PASS/FAIL'],
      ['reinspectionOf', 'text', 'ตรวจซ้ำของผลตรวจ'], ['reinspectionNcr', 'text', 'ตรวจซ้ำตาม NCR'],
      ['revChanged', 'bool', 'ฉบับแบบเปลี่ยนจากผลเดิม'], ['ncrNo', 'text', 'NCR ที่เปิด'], ['qsDocNo', 'text', 'เอกสาร QS ที่กักกัน'],
      ['status', 'enum', 'สถานะ', 'OPEN/RELEASED/NCR/VOID'], ['releasedQty', 'number', 'ปล่อยแล้ว'],
      ['releasedBy', 'text', 'ผู้อนุมัติปล่อยผ่าน'], ['releasedAt', 'datetime', 'ปล่อยเมื่อ'],
      ['releases', 'json', 'การปล่อยแต่ละครั้ง {qty, by, at, docNo}'], ['voidedBy', 'text', 'ผู้ทำให้ผลเป็นโมฆะ'],
      ['voidedAt', 'datetime', 'เป็นโมฆะเมื่อ'], ['voidReason', 'text', 'เหตุที่ต้องตรวจใหม่'], ['note', 'text', 'หมายเหตุ']],
  });
  schema.define('ncrs', {
    label: 'รายการไม่เป็นไปตามข้อกำหนด (NCR)', phase: 5, key: 'ncrNo',
    note: 'การตัดสินต้องมีสิทธิ์ เหตุผล ผู้ตัดสินและเวลา; ยอมรับแบบมีเงื่อนไขต้องมีสิทธิ์ ncr.useAsIs และไม่ใช่ผู้ตรวจ',
    fields: [['ncrNo', 'text', 'เลขที่ NCR'], ['code', 'text', 'รหัสสินค้า'], ['wh', 'text', 'คลัง'], ['bin', 'text', 'ช่องเก็บ'],
      ['lot', 'text', 'ล็อต'], ['qty', 'number', 'จำนวน (หน่วยหลัก)'], ['stage', 'text', 'ขั้นตอนที่พบ'],
      ['inspectionId', 'text', 'ผลตรวจที่พบ'], ['jobNo', 'text', 'ใบงาน'], ['stockHeld', 'bool', 'มีของกักกันในคลัง'],
      ['defect', 'text', 'ข้อบกพร่อง'], ['description', 'text', 'รายละเอียด'],
      ['status', 'enum', 'สถานะ', 'OPEN/DISPOSITIONED/CLOSED'],
      ['disposition', 'enum', 'การตัดสิน', 'REWORK/RETURN/SCRAP/USE_AS_IS'], ['dispositionBy', 'text', 'ผู้ตัดสิน'],
      ['dispositionAt', 'datetime', 'ตัดสินเมื่อ'], ['reason', 'text', 'เหตุผล'], ['conditions', 'text', 'เงื่อนไขการยอมรับ'],
      ['docNo', 'text', 'เอกสารที่เกิดจากการตัดสิน'], ['docType', 'text', 'ประเภทเอกสาร'],
      ['reinspections', 'json', 'ผลตรวจซ้ำ {id, result, at, by}'], ['createdBy', 'text', 'ผู้เปิด'], ['createdAt', 'datetime', 'เปิดเมื่อ'],
      ['closedBy', 'text', 'ผู้ปิด'], ['closedAt', 'datetime', 'ปิดเมื่อ'], ['closeNote', 'text', 'บันทึกปิด'],
      ['history', 'json', 'ประวัติ {at, by, action, detail}']],
  });

  // ---------------------------------------------------------------------------------------------------------
  // document types
  // ---------------------------------------------------------------------------------------------------------
  inv.defineType('SC', { name: 'ตัดทิ้ง/ของเสีย', dir: -1, express: false, outStatuses: [AVAILABLE, QUARANTINE, REWORK] });
  inv.defineType('DL', { name: 'ส่งมอบลูกค้า', dir: -1, express: false });
  inv.defineType('QS', { name: 'เปลี่ยนสถานะคุณภาพ', dir: 'S', express: false });
  // RV belongs to purchasing (Phase 4); keep returns to the supplier possible when that module is not loaded
  if (!inv.DOC_TYPES.RV) {
    inv.defineType('RV', { name: 'คืนสินค้าผู้ขาย', dir: -1, express: false, outStatuses: [AVAILABLE, QUARANTINE, REWORK] });
  }

  const STAGES = { INCOMING: 'ตรวจรับ', IN_PROCESS: 'ระหว่างผลิต', FINAL: 'ก่อนส่งมอบ' };
  /** Stages that inspect stock in a warehouse (IN_PROCESS inspects a job's work without stock). */
  const STOCK_STAGES = { INCOMING: true, FINAL: true };
  const PLAN_STATUS = { DRAFT: 'ร่าง', APPROVED: 'อนุมัติแล้ว', OBSOLETE: 'เลิกใช้' };
  const INSP_STATUS = { OPEN: 'ผ่าน – รออนุมัติปล่อย', RELEASED: 'ปล่อยผ่านแล้ว', NCR: 'ไม่ผ่าน (เปิด NCR)', VOID: 'เป็นโมฆะ – ต้องตรวจใหม่' };
  const NCR_STATUS = { OPEN: 'รอตัดสิน', DISPOSITIONED: 'ตัดสินแล้ว', CLOSED: 'ปิดแล้ว' };
  const DISPOSITIONS = { REWORK: 'แก้ไขงาน', RETURN: 'คืนผู้ขาย', SCRAP: 'ตัดทิ้ง', USE_AS_IS: 'ยอมรับแบบมีเงื่อนไข' };
  const LOT_STATUS = { ACTIVE: 'ใช้งาน', QUARANTINED: 'กักกัน' };
  const CHAR_KIND = { measure: 'วัดค่า', check: 'ตรวจผ่าน/ไม่ผ่าน' };
  /** Outgoing types that may still take stock of a quarantined lot. */
  const LOT_EXIT_TYPES = { SC: true, RV: true };
  const HOLD = [QC_HOLD, QUARANTINE, REWORK];
  const MAX_PHOTOS = 20;
  const MAX_URL = 2000;

  /** >0 while this module posts SC/RV for an NCR decision (prepare is synchronous). */
  let ncrPosting = 0;

  // ---------------------------------------------------------------------------------------------------------
  // small helpers (work on a Tx or on a reader made from a state: {get, all, settings})
  // ---------------------------------------------------------------------------------------------------------
  const lotKey = (code, lot) => code + '|' + (lot || '');
  const jobKey = (v) => util.normCode(v);
  const tracked = (it) => !!it && !!it.trackLot && it.trackLot !== 'none';
  const trackName = (it) => (RRS.master && RRS.master.TRACK && RRS.master.TRACK[it.trackLot]) || 'ล็อต';
  const typeDef = (t) => inv.DOC_TYPES[t] || null;
  const isOutLine = (td, l) => !!td && (td.dir === -1 || td.dir === 'T' || (td.dir === 0 && l.base < 0));
  const isInLine = (td, l) => !!td && (td.dir === 1 || (td.dir === 0 && l.base > 0));
  const absQ = (l) => Math.abs(Number(l.base != null ? l.base : l.qty) || 0);
  const posted = (d) => d && d.status !== 'DRAFT' && d.status !== 'WAIT_APPROVAL';
  function locText(l) {
    return `${l.wh}${l.bin ? '/' + l.bin : ''}${l.lot ? ' ล็อต ' + l.lot : ''}`;
  }
  function hist(row, tx, action, detail) {
    row.history = (row.history || []).concat([{ at: tx.now, by: tx.userId, action, detail: detail || '' }]);
    return row;
  }
  function emptyCert() {
    return { no: '', file: '', enteredBy: '', enteredAt: '', verified: false, verifiedBy: '', verifiedAt: '' };
  }
  function readerOf(state) {
    return {
      get: (t, k) => RRS.q.get(state, t, k),
      all: (t, f) => RRS.q.rows(state, t, f),
      settings: () => RRS.q.get(state, 'settings', 'main') || RRS.defaultSettings(),
      item: (c) => RRS.q.item(state, c),
    };
  }
  function sodOn(r) {
    const pol = (r.settings() || {}).policies || {};
    return pol.sod !== false;
  }
  const sameLoc = (a, b) => a.code === b.code && a.wh === b.wh && (a.bin || '') === (b.bin || '') && (a.lot || '') === (b.lot || '');
  /** Quantity at a QUARANTINE location that belongs to OPEN NCRs (waiting for a decision). */
  function heldByNcr(r, loc) {
    return round(util.sum(r.all('ncrs', (n) => n.status === 'OPEN' && n.stockHeld && sameLoc(n, loc)), (n) => n.qty));
  }
  /** Quantity at a location + status already inspected PASS and waiting for release. */
  function pendingRelease(r, loc, status) {
    return round(util.sum(r.all('inspections', (i) => i.status === 'OPEN' && STOCK_STAGES[i.stage] && i.fromStatus === status
      && sameLoc(i, loc)), (i) => i.qty - (i.releasedQty || 0)));
  }
  function getItem(tx, code, field) {
    const it = tx.item(code);
    if (!it) tx.error('NOT_FOUND', `ไม่พบรหัส ${util.trim(code) || '(ว่าง)'} ในทะเบียนสินค้า`, { field: field || 'code' });
    return it;
  }
  function checkWh(tx, wh, bin, perm) {
    if (!wh) return tx.error('REQUIRED', 'ระบุคลัง', { field: 'wh' });
    if (wh === TRANSIT) return tx.error('RESERVED', `${TRANSIT} ใช้ภายในระบบ ทำรายการตรงไม่ได้`, { field: 'wh' });
    if (!tx.get('warehouses', wh)) return tx.error('NOT_FOUND', `ไม่พบคลัง ${wh}`, { field: 'wh' });
    if (bin && !tx.get('bins', wh + '|' + bin)) return tx.error('NOT_FOUND', `ไม่พบช่องเก็บ ${bin} ในคลัง ${wh}`, { field: 'bin' });
    return tx.need(perm, wh, { field: 'wh' });
  }
  function needReason(tx, v, what) {
    const s = util.trim(v);
    if (s.length < 3) {
      tx.error('REQUIRED', `ระบุ${what || 'เหตุผล'}ให้ชัดเจน`, { field: 'reason' });
      return '';
    }
    return s.slice(0, 500);
  }
  /** Item + lot text of a lot command (the item must be tracked). */
  function lotInput(tx, p) {
    const it = getItem(tx, p.code);
    if (!it) return null;
    if (!tracked(it)) return tx.error('LOT_NOT_TRACKED', `${it.id} ไม่ได้ตั้งให้ติดตามล็อต/Heat/Serial`, { field: 'code' }) && null;
    const lot = util.trim(p.lot);
    if (!lot) return tx.error('REQUIRED', `ระบุ${trackName(it)}`, { field: 'lot' }) && null;
    return { it, lot };
  }
  function newLot(tx, it, lot, src) {
    return {
      code: it.id, lot, kind: it.trackLot, supplier: src.supplier || '', poNo: src.poNo || '', poLine: src.poLine || '',
      docNo: src.docNo || '',
      docType: src.docType || '', receivedAt: src.receivedAt || tx.now, cert: emptyCert(), status: 'ACTIVE', note: '',
      quarantinedBy: '', quarantinedAt: '', quarantineReason: '', quarantineDocNo: '', releasedBy: '', releasedAt: '',
      releaseReason: '', releaseDocNo: '', createdBy: tx.userId, createdAt: tx.now, history: [],
    };
  }
  /** The lot row (a copy to change), created from the stock history when it predates this module; null = never received. */
  function ensureLot(tx, it, lot) {
    const row = tx.get('lots', lotKey(it.id, lot));
    if (row) return clone(row);
    const mvs = tx.all('movements', (m) => m.code === it.id && m.lot === lot)
      .sort((a, b) => a.seq - b.seq || String(a.id).localeCompare(String(b.id)));
    if (!mvs.length) return null;
    const first = mvs.find((m) => m.qty > 0) || mvs[0];
    return hist(newLot(tx, it, lot, { docNo: first.docNo, docType: first.docType, receivedAt: first.at }), tx, 'CREATE',
      `สร้างจากประวัติเคลื่อนไหว ${first.docNo}`);
  }

  /**
   * Write one QS document: for every line − qty in `from` and + qty in `to` at the same code/wh/bin/lot.
   * spec: {lines:[{code, wh, bin, lot, qty, from, to, remark}], reason, ref, job, source}. Returns the row or null.
   */
  function writeQS(tx, spec) {
    const before = tx.errors.length;
    const docNo = tx.nextNo('QS', tx.date);
    const doc = {
      docNo, type: 'QS', date: tx.date, status: 'DRAFT', job: spec.job || '', department: 'QC', ref: spec.ref || '',
      remark: spec.reason || '', lines: [], createdBy: tx.userId, createdAt: tx.now, postedBy: '', postedAt: '',
      cancelledBy: '', cancelledAt: '', cancelReason: '', override: null, expressStatus: 'N/A', expressNo: '', source: spec.source || '',
    };
    spec.lines.forEach((l, i) => {
      const it = tx.item(l.code);
      const q = round(l.qty);
      const ln = {
        line: i + 1, code: it.id, name: it.name, qty: q, unit: it.baseUnit, factor: 1, base: q, baseUnit: it.baseUnit,
        wh: l.wh, bin: l.bin || '', toWh: '', toBin: '', lot: l.lot || '', status: l.to, fromStatus: l.from, toStatus: l.to,
        unitCost: it.unitCost || 0, remark: l.remark || spec.reason || '', reservationId: '', poNo: '', poLine: '',
        jobNo: spec.job || '', item: it,
      };
      // other modules' line checks (e.g. a count freeze of this bin) apply to a status change too
      RRS.hooks.run('doc.lineCheck', tx, doc, ln);
      const mv = { docType: 'QS', docNo, line: ln.line, job: doc.job, date: doc.date,
        remark: `${STATUS_LABEL[l.from]} → ${STATUS_LABEL[l.to]}${ln.remark ? ': ' + ln.remark : ''}` };
      const loc = { code: it.id, wh: ln.wh, bin: ln.bin, lot: ln.lot };
      tx.move(Object.assign({ status: l.from }, loc), -q, mv);
      tx.move(Object.assign({ status: l.to }, loc), q, mv);
      delete ln.item;
      doc.lines.push(ln);
    });
    if (tx.errors.length > before) return null;
    const row = Object.assign(doc, { status: 'POSTED', postedBy: tx.userId, postedAt: tx.now });
    tx.put('documents', docNo, row);
    return row;
  }

  /**
   * Post an SC/RV document for an NCR decision. The person who holds ncr.disposition in that warehouse authorizes
   * the stock lines (the type's own posting right is not asked again – the decision is the authorization).
   */
  function postForNcr(tx, doc) {
    const td = typeDef(doc.type);
    const docPerm = (td && td.perm) || 'doc.post';
    const had = Object.prototype.hasOwnProperty.call(tx, 'can');
    const prev = tx.can;
    tx.can = function (perm, wh) {
      return prev.call(this, perm === docPerm ? 'ncr.disposition' : perm, wh);
    };
    ncrPosting += 1;
    try {
      return inv.post(tx, doc);
    } finally {
      ncrPosting -= 1;
      if (had) tx.can = prev;
      else delete tx.can;
    }
  }

  /**
   * PO link of a return to the supplier: the lot's PO line when the purchasing module knows it (it then counts the
   * return on the PO line); without the purchasing module the PO number is kept as a reference only.
   */
  function poRef(tx, lot) {
    const none = { poNo: '', poLine: '' };
    if (!lot || !lot.poNo) return none;
    if (!RRS.schema.tables.pos) return { poNo: lot.poNo, poLine: lot.poLine || '' };
    const hasLine = lot.poLine !== '' && lot.poLine != null;
    return hasLine && tx.get('pos', lot.poNo) ? { poNo: lot.poNo, poLine: lot.poLine } : none;
  }

  /** Reasons why an inspection cannot be released by userId now ([] = can release). Shared with releaseCheck(). */
  function releaseBlockers(r, insp, userId) {
    const out = [];
    const add = (code, message) => out.push({ code, message });
    if (!insp) return [{ code: 'NOT_FOUND', message: 'ไม่พบผลตรวจ' }];
    if (insp.status === 'RELEASED') add('ALREADY_RELEASED', `${insp.id} ปล่อยผ่านไปแล้ว – ปล่อยซ้ำไม่ได้`);
    else if (insp.status === 'VOID') add('BAD_STATE', `${insp.id} เป็นโมฆะ (${insp.voidReason || 'ต้องตรวจใหม่'}) – ตรวจใหม่ก่อน`);
    else if (insp.result !== 'PASS') add('NOT_PASS', `${insp.id} ผลตรวจไม่ผ่าน – ปล่อยไม่ได้ (ตัดสินผ่าน NCR ${insp.ncrNo || ''})`);
    else if (insp.status !== 'OPEN') add('BAD_STATE', `${insp.id} ${INSP_STATUS[insp.status] || insp.status}`);
    if (out.length) return out;
    if (sodOn(r) && insp.inspector && insp.inspector === userId) {
      add('SAME_PERSON', 'ผู้อนุมัติปล่อยผ่าน ต้องเป็นคนละคนกับผู้ตรวจ (แยกหน้าที่)');
    }
    const src = insp.sourceDoc ? r.get('documents', insp.sourceDoc) : null;
    if (sodOn(r) && src && src.postedBy && src.postedBy === userId) {
      add('SAME_PERSON', `ผู้อนุมัติปล่อยผ่าน ต้องเป็นคนละคนกับผู้บันทึกเอกสาร ${src.docNo} (แยกหน้าที่)`);
    }
    if (STOCK_STAGES[insp.stage]) {
      const it = r.get('items', insp.code);
      const lot = insp.lot ? r.get('lots', lotKey(insp.code, insp.lot)) : null;
      if (it && it.certRequired) {
        if (!tracked(it) || !insp.lot) add('CERT_MISSING', `${it.id} ต้องมีใบรับรองวัสดุ แต่ไม่ได้ติดตามล็อต – ตั้งการติดตามล็อตก่อน`);
        else if (!lot || !lot.cert || !lot.cert.no) add('CERT_MISSING', `${it.id} ล็อต ${insp.lot} ยังไม่มีใบรับรองวัสดุ – บันทึกใบรับรองก่อนปล่อยผ่าน`);
        else if (!lot.cert.verified) add('CERT_NOT_VERIFIED', `${it.id} ล็อต ${insp.lot} ใบรับรอง ${lot.cert.no} ยังไม่ได้ตรวจสอบ – ให้ QC ตรวจใบรับรองก่อน`);
      }
      if (lot && lot.status === 'QUARANTINED') add('LOT_QUARANTINED', `${insp.code} ล็อต ${insp.lot} ถูกกักกัน – ปลดกักกันและตรวจใหม่ก่อน`);
    }
    return out;
  }

  /** Mark OPEN inspections void (their stock left the status they inspected). */
  function voidInspections(tx, filter, reason) {
    const ids = [];
    for (const i of tx.all('inspections', (x) => x.status === 'OPEN' && filter(x))) {
      tx.put('inspections', i.id, Object.assign({}, i, { status: 'VOID', voidedBy: tx.userId, voidedAt: tx.now, voidReason: reason }));
      ids.push(i.id);
    }
    return ids;
  }

  // ---------------------------------------------------------------------------------------------------------
  // lots and material certificates
  // ---------------------------------------------------------------------------------------------------------
  define('lot.update', {
    label: 'บันทึกข้อมูลล็อต/ใบรับรองวัสดุ', perm: 'lot.manage',
    prepare(tx, p) {
      const li = lotInput(tx, p);
      if (!li) return;
      const { it, lot } = li;
      const row = ensureLot(tx, it, lot);
      if (!row) return tx.error('NOT_FOUND', `ยังไม่มีการรับ ${it.id} ${trackName(it)} ${lot} – บันทึกรับเข้าก่อน`, { field: 'lot' });
      const changes = [];
      if (p.cert != null) {
        if (typeof p.cert !== 'object') return tx.error('BAD_VALUE', 'ข้อมูลใบรับรองไม่ถูกต้อง', { field: 'cert' });
        const no = util.trim(p.cert.no).slice(0, 80);
        if (!no) return tx.error('REQUIRED', 'ระบุเลขที่ใบรับรองวัสดุ', { field: 'cert.no' });
        const cur = row.cert || emptyCert();
        const file = p.cert.file !== undefined ? util.trim(p.cert.file).slice(0, MAX_URL) : (no === cur.no ? cur.file : '');
        if (no !== cur.no || file !== cur.file) {
          changes.push(cur.no
            ? `ใบรับรอง ${cur.no}${cur.verified ? ` (ตรวจแล้วโดย ${cur.verifiedBy})` : ''} → ${no} – ต้องตรวจใหม่`
            : `บันทึกใบรับรอง ${no}`);
          row.cert = { no, file, enteredBy: tx.userId, enteredAt: tx.now, verified: false, verifiedBy: '', verifiedAt: '' };
        }
      }
      if (p.note !== undefined) {
        const note = util.trim(p.note).slice(0, 500);
        if (note !== row.note) {
          changes.push(`หมายเหตุ: ${note || '(ลบ)'}`);
          row.note = note;
        }
      }
      if (!changes.length) return tx.error('NO_CHANGE', 'ไม่มีข้อมูลที่เปลี่ยน');
      hist(row, tx, 'UPDATE', changes.join('; '));
      tx.putRow('lots', row);
      tx.summary = `${it.id} ${trackName(it)} ${lot}: ${changes.join('; ')}`;
    },
  });

  define('lot.verifyCert', {
    label: 'ตรวจสอบใบรับรองวัสดุ', perm: 'qc.inspect',
    prepare(tx, p) {
      const li = lotInput(tx, p);
      if (!li) return;
      const { it, lot } = li;
      const row = tx.get('lots', lotKey(it.id, lot));
      if (!row) return tx.error('NOT_FOUND', `ไม่พบ ${it.id} ${trackName(it)} ${lot}`, { field: 'lot' });
      const cert = row.cert || emptyCert();
      if (!cert.no) return tx.error('NO_CERT', `${it.id} ${lot} ยังไม่มีใบรับรองวัสดุให้ตรวจ`);
      if (cert.verified) return tx.error('ALREADY_VERIFIED', `ใบรับรอง ${cert.no} ตรวจแล้วโดย ${cert.verifiedBy}`);
      if (!tx.different(cert.enteredBy, 'ผู้ตรวจสอบใบรับรอง')) return;
      const next = hist(Object.assign(clone(row), { cert: Object.assign({}, cert, { verified: true, verifiedBy: tx.userId, verifiedAt: tx.now }) }),
        tx, 'VERIFY_CERT', `ตรวจใบรับรอง ${cert.no}`);
      tx.putRow('lots', next);
      tx.summary = `ตรวจใบรับรอง ${cert.no} ของ ${it.id} ${lot}`;
    },
  });

  define('lot.quarantine', {
    label: 'กักกันล็อต', perm: 'qc.quarantine',
    prepare(tx, p) {
      const li = lotInput(tx, p);
      if (!li) return;
      const { it, lot } = li;
      const reason = needReason(tx, p.reason, 'เหตุผลการกักกัน');
      if (!reason) return;
      const row = ensureLot(tx, it, lot);
      if (!row) return tx.error('NOT_FOUND', `ยังไม่มีการรับ ${it.id} ${trackName(it)} ${lot}`, { field: 'lot' });
      const all = tx.all('balances', (b) => b.code === it.id && b.lot === lot && b.wh !== TRANSIT && b.qty > 0
        && (b.status === AVAILABLE || b.status === QC_HOLD)).sort((a, b) => RRS.balanceKey(a).localeCompare(RRS.balanceKey(b)));
      // a bin under a count freeze keeps its balance until the count is approved – the lot is blocked anyway
      const frozenBy = (b) => (RRS.reconcile && RRS.reconcile.frozenBy ? RRS.reconcile.frozenBy(tx.state, b.wh, b.bin) : '');
      const skipped = all.filter((b) => frozenBy(b)).map((b) => Object.assign({ count: frozenBy(b) }, b));
      const bals = all.filter((b) => !frozenBy(b));
      const again = row.status === 'QUARANTINED';
      if (again && !bals.length) {
        return skipped.length
          ? tx.error('COUNT_FREEZE', `${it.id} ${lot} ที่ ${skipped.map(locText).join(', ')} อยู่ระหว่างตรวจนับ – สั่งกักกันซ้ำหลังอนุมัติรอบนับ`)
          : tx.error('ALREADY', `${it.id} ${lot} ถูกกักกันอยู่แล้ว`);
      }
      for (const w of Array.from(new Set(bals.map((b) => b.wh)))) if (!tx.need('qc.quarantine', w)) return;
      let qs = null;
      if (bals.length) {
        qs = writeQS(tx, { reason: `กักกันล็อต: ${reason}`, ref: `${it.id} ${lot}`, source: 'lot:' + lotKey(it.id, lot),
          lines: bals.map((b) => ({ code: it.id, wh: b.wh, bin: b.bin, lot, qty: b.qty, from: b.status, to: QUARANTINE })) });
        if (!qs) return;
      }
      const voided = voidInspections(tx, (i) => i.code === it.id && i.lot === lot && STOCK_STAGES[i.stage] && i.fromStatus === QC_HOLD,
        `กักกันล็อต ${lot}: ${reason}`);
      const moved = round(util.sum(bals, (b) => b.qty));
      if (!again) {
        Object.assign(row, { status: 'QUARANTINED', quarantinedBy: tx.userId, quarantinedAt: tx.now, quarantineReason: reason,
          quarantineDocNo: qs ? qs.docNo : '' });
      }
      hist(row, tx, again ? 'QUARANTINE_SWEEP' : 'QUARANTINE', `${reason}; ย้ายเข้ากักกัน ${moved} ${it.baseUnit}${qs ? ' (' + qs.docNo + ')' : ''}`);
      tx.putRow('lots', row);
      const transit = tx.qty({ code: it.id, wh: TRANSIT, lot });
      if (transit > 0) tx.warn(`มี ${it.id} ล็อต ${lot} ระหว่างโอน ${transit} ${it.baseUnit} – รับปลายทางแล้วสั่งกักกันซ้ำ (ระหว่างนี้เบิกล็อตนี้ไม่ได้)`);
      for (const b of skipped) {
        tx.warn(`${locText(b)} อยู่ระหว่างตรวจนับ ${b.count} – ยอด ${b.qty} ${it.baseUnit} ยังไม่ย้ายเป็นกักกัน (เบิกล็อตนี้ไม่ได้แล้ว) สั่งกักกันซ้ำหลังอนุมัติรอบนับ`);
      }
      tx.result = { docNo: qs ? qs.docNo : '', moved, voided, inTransit: transit, skipped: skipped.map((b) => ({ wh: b.wh, bin: b.bin, qty: b.qty, count: b.count })) };
      tx.summary = `กักกัน ${it.id} ${trackName(it)} ${lot} ${moved} ${it.baseUnit}${qs ? ' ' + qs.docNo : ''}`;
    },
  });

  define('lot.release', {
    label: 'ปลดกักกันล็อต (กลับไปรอตรวจ)', perm: 'qc.release',
    prepare(tx, p) {
      const li = lotInput(tx, p);
      if (!li) return;
      const { it, lot } = li;
      const reason = needReason(tx, p.reason, 'เหตุผลการปลดกักกัน');
      if (!reason) return;
      const cur = tx.get('lots', lotKey(it.id, lot));
      if (!cur) return tx.error('NOT_FOUND', `ไม่พบ ${it.id} ${trackName(it)} ${lot}`, { field: 'lot' });
      if (cur.status !== 'QUARANTINED') return tx.error('NOT_QUARANTINED', `${it.id} ${lot} ไม่ได้ถูกกักกัน`);
      if (!tx.different(cur.quarantinedBy, 'ผู้ปลดกักกันล็อต')) return;
      const lines = [];
      for (const b of tx.all('balances', (x) => x.code === it.id && x.lot === lot && x.wh !== TRANSIT && x.status === QUARANTINE && x.qty > 0)
        .sort((a, c) => RRS.balanceKey(a).localeCompare(RRS.balanceKey(c)))) {
        const free = round(b.qty - heldByNcr(tx, b)); // stock of an open NCR waits for its decision
        if (free > 0) lines.push({ code: it.id, wh: b.wh, bin: b.bin, lot, qty: free, from: QUARANTINE, to: QC_HOLD });
      }
      for (const w of Array.from(new Set(lines.map((l) => l.wh)))) if (!tx.need('qc.release', w)) return;
      let qs = null;
      if (lines.length) {
        qs = writeQS(tx, { reason: `ปลดกักกันล็อต (กลับไปรอตรวจ): ${reason}`, ref: `${it.id} ${lot}`, source: 'lot:' + lotKey(it.id, lot), lines });
        if (!qs) return;
      }
      const moved = round(util.sum(lines, (l) => l.qty));
      const row = hist(Object.assign(clone(cur), { status: 'ACTIVE', releasedBy: tx.userId, releasedAt: tx.now, releaseReason: reason,
        releaseDocNo: qs ? qs.docNo : '' }), tx, 'RELEASE', `${reason}; กลับไปรอตรวจ ${moved} ${it.baseUnit}${qs ? ' (' + qs.docNo + ')' : ''}`);
      tx.putRow('lots', row);
      tx.result = { docNo: qs ? qs.docNo : '', moved };
      tx.summary = `ปลดกักกัน ${it.id} ${lot} → รอตรวจ ${moved} ${it.baseUnit}`;
    },
  });

  // ---------------------------------------------------------------------------------------------------------
  // inspection plans
  // ---------------------------------------------------------------------------------------------------------
  function numOrNull(v) {
    if (v == null || (typeof v === 'string' && !v.trim())) return null;
    return util.num(v);
  }
  function parseChars(tx, raw) {
    const list = Array.isArray(raw) ? raw : [];
    if (!list.length) return tx.error('REQUIRED', 'แผนตรวจต้องมีหัวข้อตรวจอย่างน้อย 1 ข้อ', { field: 'chars' }) && null;
    const out = [];
    const seen = {};
    list.forEach((c, i) => {
      const n = i + 1;
      const where = { field: 'chars', row: n };
      const name = util.trim(c && c.name).slice(0, 120);
      if (!name) return tx.error('REQUIRED', `หัวข้อ ${n}: ระบุชื่อหัวข้อตรวจ`, where);
      const k = util.ckey(name);
      if (seen[k]) return tx.error('DUPLICATE', `หัวข้อ ${n}: "${name}" ซ้ำกับหัวข้อ ${seen[k]}`, where);
      seen[k] = n;
      const kind = (c && c.kind) || 'measure';
      if (!CHAR_KIND[kind]) return tx.error('BAD_VALUE', `หัวข้อ ${n}: ชนิดต้องเป็น measure (วัดค่า) หรือ check (ผ่าน/ไม่ผ่าน)`, where);
      const ch = { id: 'C' + n, name, kind, nominal: null, min: null, max: null, unit: util.trim(c.unit).slice(0, 20),
        method: util.trim(c.method).slice(0, 200) };
      if (kind === 'measure') {
        const nominal = numOrNull(c.nominal);
        const min = numOrNull(c.min);
        const max = numOrNull(c.max);
        if ([nominal, min, max].some((x) => x !== null && isNaN(x))) return tx.error('BAD_VALUE', `หัวข้อ ${n}: ค่าเกณฑ์ต้องเป็นตัวเลข`, where);
        if (min === null && max === null) return tx.error('REQUIRED', `หัวข้อ ${n}: ระบุค่าต่ำสุดหรือสูงสุดที่ยอมรับ`, where);
        if (min !== null && max !== null && min > max) return tx.error('BAD_VALUE', `หัวข้อ ${n}: ค่าต่ำสุดมากกว่าค่าสูงสุด`, where);
        Object.assign(ch, { nominal, min, max });
      }
      out.push(ch);
    });
    return tx.ok ? out : null;
  }

  define('qc.plan.save', {
    label: 'บันทึกแผนตรวจ QC', perm: 'qc.plan',
    prepare(tx, p) {
      const it = getItem(tx, p.code);
      if (!it) return;
      const stage = String(p.stage || '').toUpperCase();
      if (!STAGES[stage]) return tx.error('BAD_VALUE', 'ขั้นตอนต้องเป็น INCOMING (ตรวจรับ), IN_PROCESS (ระหว่างผลิต) หรือ FINAL (ก่อนส่งมอบ)', { field: 'stage' });
      const sourceRef = util.trim(p.sourceRef).slice(0, 200);
      if (!sourceRef) return tx.error('REQUIRED', 'ระบุเลขที่แบบหรือวิธีปฏิบัติ (WI) ที่อนุมัติซึ่งเป็นที่มาของเกณฑ์', { field: 'sourceRef' });
      const chars = parseChars(tx, p.chars);
      if (!chars) return;
      let prev = null;
      if (p.id) {
        prev = tx.get('qc_plans', util.normCode(p.id));
        if (!prev) return tx.error('NOT_FOUND', `ไม่พบแผนตรวจ ${p.id}`, { field: 'id' });
        if (prev.status !== 'DRAFT') return tx.error('LOCKED', `แผน ${prev.id} ${PLAN_STATUS[prev.status]} – แก้ไม่ได้ สร้างแผนใหม่แทน`);
        if (prev.code !== it.id || prev.stage !== stage) return tx.error('BAD_VALUE', 'เปลี่ยนสินค้าหรือขั้นตอนของแผนไม่ได้ – สร้างแผนใหม่');
      }
      const id = prev ? prev.id : tx.nextId('QP');
      const row = {
        id, code: it.id, stage, drawingNo: it.drawingNo || '', drawingRev: util.trim(p.drawingRev).slice(0, 20), sourceRef,
        sampling: util.trim(p.sampling).slice(0, 200), chars, status: 'DRAFT',
        createdBy: prev ? prev.createdBy : tx.userId, createdAt: prev ? prev.createdAt : tx.now, updatedBy: tx.userId, updatedAt: tx.now,
        approvedBy: '', approvedAt: '', obsoletedBy: '', obsoletedAt: '', replacedBy: '', history: prev ? prev.history : [],
      };
      hist(row, tx, prev ? 'EDIT' : 'CREATE', `${STAGES[stage]} แบบฉบับ ${row.drawingRev || '-'} อ้างอิง ${sourceRef} ${chars.length} หัวข้อ`);
      tx.put('qc_plans', id, row);
      tx.result.id = id;
      tx.summary = `${prev ? 'แก้' : 'สร้าง'}แผนตรวจ ${id} ${it.id} ${STAGES[stage]}`;
    },
  });

  define('qc.plan.approve', {
    label: 'อนุมัติแผนตรวจ QC', perm: 'qc.planApprove',
    prepare(tx, p) {
      const plan = tx.get('qc_plans', util.normCode(p.id));
      if (!plan) return tx.error('NOT_FOUND', `ไม่พบแผนตรวจ ${p.id || ''}`, { field: 'id' });
      if (plan.status !== 'DRAFT') return tx.error('BAD_STATE', `แผน ${plan.id} ${PLAN_STATUS[plan.status]}`);
      if (!tx.different(plan.createdBy, 'ผู้อนุมัติแผนตรวจ')) return;
      if (!tx.different(plan.updatedBy, 'ผู้อนุมัติแผนตรวจ')) return;
      const it = tx.item(plan.code);
      if (!it) return tx.error('NOT_FOUND', `ไม่พบสินค้า ${plan.code}`);
      if (util.normCode(it.drawingRev) !== util.normCode(plan.drawingRev)) {
        return tx.error('REV_MISMATCH', `แผนอ้างแบบฉบับ "${plan.drawingRev || '-'}" แต่ฉบับแบบที่อนุมัติของ ${it.id} คือ "${it.drawingRev || '-'}" – แก้แผนให้ตรงฉบับแบบที่อนุมัติ`);
      }
      const old = tx.all('qc_plans', (x) => x.code === plan.code && x.stage === plan.stage && x.status === 'APPROVED' && x.id !== plan.id);
      for (const o of old) {
        tx.put('qc_plans', o.id, hist(Object.assign(clone(o), { status: 'OBSOLETE', obsoletedBy: tx.userId, obsoletedAt: tx.now, replacedBy: plan.id }),
          tx, 'OBSOLETE', `แทนด้วยแผน ${plan.id}`));
      }
      tx.put('qc_plans', plan.id, hist(Object.assign(clone(plan), { status: 'APPROVED', approvedBy: tx.userId, approvedAt: tx.now }),
        tx, 'APPROVE', `อนุมัติ ผูกแบบฉบับ ${plan.drawingRev || '-'}`));
      tx.result = { id: plan.id, obsoleted: old.map((o) => o.id) };
      tx.summary = `อนุมัติแผนตรวจ ${plan.id} ${plan.code} ${STAGES[plan.stage]}${old.length ? ' (เลิกใช้ ' + old.map((o) => o.id).join(', ') + ')' : ''}`;
    },
  });

  // ---------------------------------------------------------------------------------------------------------
  // inspection, release
  // ---------------------------------------------------------------------------------------------------------
  function findChar(plan, ref) {
    const s = util.trim(ref);
    if (!s) return null;
    return plan.chars.find((c) => c.id === s.toUpperCase()) || plan.chars.find((c) => c.name === s)
      || plan.chars.find((c) => util.ckey(c.name) === util.ckey(s)) || null;
  }
  function isPassValue(v) {
    if (v === true) return true;
    if (typeof v !== 'string') return false;
    return /^(ผ่าน|ok|pass)$/i.test(util.trim(v));
  }
  function rangeText(c) {
    if (c.min !== null && c.max !== null) return `${c.min}–${c.max}`;
    return c.min !== null ? `≥ ${c.min}` : `≤ ${c.max}`;
  }

  define('qc.inspect', {
    label: 'บันทึกผลตรวจ QC', perm: 'qc.inspect',
    prepare(tx, p) {
      const stage = String(p.stage || '').toUpperCase();
      if (!STAGES[stage]) return tx.error('BAD_VALUE', 'ขั้นตอนตรวจต้องเป็น INCOMING (ตรวจรับ), IN_PROCESS (ระหว่างผลิต) หรือ FINAL (ก่อนส่งมอบ)', { field: 'stage' });
      const stock = !!STOCK_STAGES[stage];
      const it = getItem(tx, p.code);
      if (!it) return;
      const qty = util.num(p.qty);
      if (isNaN(qty) || qty <= 0) return tx.error('BAD_QTY', 'จำนวนที่ตรวจต้องเป็นตัวเลขมากกว่า 0', { field: 'qty' });
      const lot = util.trim(p.lot);
      if (lot && !tracked(it)) return tx.error('LOT_NOT_TRACKED', `${it.id} ไม่ได้ตั้งให้ติดตามล็อต – ลบล็อตออก`, { field: 'lot' });
      if (stock && tracked(it) && !lot) return tx.error('LOT_REQUIRED', `${it.id} ต้องระบุ${trackName(it)}`, { field: 'lot' });
      const wh = util.normCode(p.wh);
      const bin = util.normCode(p.bin);
      let fromStatus = '';
      if (stock) {
        if (!checkWh(tx, wh, bin, 'qc.inspect')) return;
        fromStatus = p.fromStatus ? String(p.fromStatus).toUpperCase() : QC_HOLD;
        if (fromStatus !== QC_HOLD && fromStatus !== REWORK) {
          return tx.error('BAD_STATUS', 'ตรวจได้เฉพาะของสถานะรอตรวจ (QC_HOLD) หรือรอแก้ไข (REWORK)', { field: 'fromStatus' });
        }
      } else if (wh && !checkWh(tx, wh, bin, 'qc.inspect')) {
        return;
      }
      // source document and job
      let jobNo = util.trim(p.jobNo);
      let sourceDoc = '';
      if (util.trim(p.sourceDoc)) {
        const d = tx.get('documents', util.normCode(p.sourceDoc));
        if (!d) return tx.error('NOT_FOUND', `ไม่พบเอกสาร ${p.sourceDoc}`, { field: 'sourceDoc' });
        if (!posted(d) || d.status === 'CANCELLED') return tx.error('BAD_STATE', `เอกสาร ${d.docNo} ยังไม่ได้บันทึกหรือถูกยกเลิก`, { field: 'sourceDoc' });
        const ln = (d.lines || []).find((l) => l.code === it.id && (!lot || l.lot === lot));
        if (!ln) return tx.error('NOT_IN_DOC', `เอกสาร ${d.docNo} ไม่มี ${it.id}${lot ? ' ล็อต ' + lot : ''}`, { field: 'sourceDoc' });
        const djob = d.job || ln.jobNo || '';
        if (jobNo && djob && jobKey(jobNo) !== jobKey(djob)) return tx.error('JOB_MISMATCH', `เอกสาร ${d.docNo} เป็นของงาน ${djob} ไม่ใช่ ${jobNo}`, { field: 'jobNo' });
        jobNo = jobNo || djob;
        if (!tx.different(d.postedBy, 'ผู้ตรวจ')) return;
        sourceDoc = d.docNo;
      }
      if (stage === 'IN_PROCESS' && !jobNo) return tx.error('REQUIRED', 'การตรวจระหว่างผลิตต้องระบุใบงาน', { field: 'jobNo' });
      // the approved plan of this item + stage, bound to the item's approved drawing revision
      const plan = tx.get('qc_plans', util.normCode(p.planId));
      if (!plan) return tx.error('NOT_FOUND', `ไม่พบแผนตรวจ ${p.planId || '(ว่าง)'}`, { field: 'planId' });
      if (plan.code !== it.id || plan.stage !== stage) {
        return tx.error('PLAN_MISMATCH', `แผน ${plan.id} เป็นของ ${plan.code} ${STAGES[plan.stage]} ไม่ใช่ ${it.id} ${STAGES[stage]}`, { field: 'planId' });
      }
      if (plan.status !== 'APPROVED') return tx.error('PLAN_NOT_APPROVED', `แผน ${plan.id} ${PLAN_STATUS[plan.status]} – ใช้ได้เฉพาะแผนที่อนุมัติ`, { field: 'planId' });
      if (util.normCode(plan.drawingRev) !== util.normCode(it.drawingRev)) {
        return tx.error('PLAN_REV_STALE', `แผน ${plan.id} อ้างแบบฉบับ "${plan.drawingRev || '-'}" แต่ฉบับแบบที่อนุมัติปัจจุบันของ ${it.id} คือ "${it.drawingRev || '-'}" – อนุมัติแผนตรวจฉบับใหม่ก่อน`, { field: 'planId' });
      }
      // re-inspection: points at the earlier FAIL (or its NCR) of the same item + lot
      let orig = null;
      let viaNcr = null;
      let revChanged = false;
      if (util.trim(p.reinspectionOf)) {
        const ref = util.normCode(p.reinspectionOf);
        orig = tx.get('inspections', ref);
        if (!orig) {
          viaNcr = tx.get('ncrs', ref);
          if (viaNcr && viaNcr.inspectionId) orig = tx.get('inspections', viaNcr.inspectionId);
        }
        if (!orig && !viaNcr) return tx.error('NOT_FOUND', `ไม่พบผลตรวจหรือ NCR ${p.reinspectionOf} ที่ใช้ได้กับการตรวจซ้ำ`, { field: 'reinspectionOf' });
        if (orig && orig.result !== 'FAIL') return tx.error('NOT_FAIL', `${orig.id} ผลตรวจผ่าน – ตรวจซ้ำต้องอ้างผลตรวจที่ไม่ผ่าน`, { field: 'reinspectionOf' });
        const ref0 = orig || viaNcr;
        if (ref0.code !== it.id || (ref0.lot || '') !== lot || (orig && orig.stage !== stage)) {
          return tx.error('REINSPECT_MISMATCH', `${orig ? orig.id : viaNcr.ncrNo} เป็นของ ${ref0.code}${ref0.lot ? ' ล็อต ' + ref0.lot : ''}${orig ? ' ' + STAGES[orig.stage] : ''} – ตรวจซ้ำต้องเป็นสินค้า ล็อต และขั้นตอนเดียวกัน`, { field: 'reinspectionOf' });
        }
        if (!viaNcr && orig.ncrNo) viaNcr = tx.get('ncrs', orig.ncrNo);
        if (viaNcr && viaNcr.status === 'CLOSED') return tx.error('BAD_STATE', `NCR ${viaNcr.ncrNo} ปิดแล้ว`, { field: 'reinspectionOf' });
        if (orig && util.normCode(orig.planRev) !== util.normCode(plan.drawingRev)) {
          if (util.normCode(it.drawingRev) === util.normCode(orig.planRev)) {
            return tx.error('REV_MISMATCH', `ตรวจซ้ำต้องใช้แบบฉบับเดิม "${orig.planRev || '-'}"`, { field: 'planId' });
          }
          revChanged = true; // the drawing changed since: the current approved plan is used, and flagged
        }
      } else if (fromStatus === REWORK) {
        return tx.error('REINSPECTION_REQUIRED', 'ของรอแก้ไขต้องตรวจซ้ำโดยอ้างผลตรวจไม่ผ่านหรือ NCR เดิม', { field: 'reinspectionOf' });
      }
      // the quantity must be there (and not already inspected and waiting for release)
      if (stock) {
        const loc = { code: it.id, wh, bin, status: fromStatus, lot };
        const have = tx.balanceAt(loc).qty;
        const pending = pendingRelease(tx, loc, fromStatus);
        const free = round(have - pending);
        if (round(qty) > free) {
          return tx.error('NOT_ENOUGH', `${it.id} ที่ ${locText(loc)} สถานะ${STATUS_LABEL[fromStatus]} มี ${have} ${it.baseUnit}${pending ? ` (ตรวจผ่านรอปล่อย ${pending})` : ''} – ตรวจได้ไม่เกิน ${Math.max(0, free)}`, { field: 'qty' });
        }
      }
      // results against the plan's characteristics
      const given = {};
      (Array.isArray(p.results) ? p.results : []).forEach((r, i) => {
        const c = findChar(plan, r && r.char);
        if (!c) return tx.error('UNKNOWN_CHAR', `ผลข้อ ${i + 1}: ไม่พบหัวข้อ "${(r && r.char) || ''}" ในแผน ${plan.id}`, { field: 'results', row: i + 1 });
        if (given[c.id]) return tx.error('DUPLICATE', `หัวข้อ ${c.name} บันทึกซ้ำ`, { field: 'results', row: i + 1 });
        given[c.id] = r;
      });
      if (!tx.ok) return;
      const results = [];
      for (const c of plan.chars) {
        const v = given[c.id] ? given[c.id].value : undefined;
        if (v == null || (typeof v === 'string' && !util.trim(v))) {
          tx.error('MISSING_RESULT', `ยังไม่บันทึกผลหัวข้อ ${c.id} ${c.name}`, { field: 'results' });
          continue;
        }
        if (c.kind === 'measure') {
          const n = util.num(v);
          if (isNaN(n)) {
            tx.error('BAD_VALUE', `ผลหัวข้อ ${c.name} ต้องเป็นตัวเลข`, { field: 'results' });
            continue;
          }
          const val = round(n);
          const ok = (c.min === null || val >= c.min) && (c.max === null || val <= c.max);
          results.push({ char: c.id, name: c.name, kind: c.kind, value: val, ok, nominal: c.nominal, min: c.min, max: c.max, unit: c.unit });
        } else {
          results.push({ char: c.id, name: c.name, kind: c.kind, value: typeof v === 'boolean' ? v : util.trim(v).slice(0, 60), ok: isPassValue(v), unit: '' });
        }
      }
      if (!tx.ok) return;
      // evidence photos (links to files stored elsewhere – never the picture itself)
      const photos = [];
      const rawPhotos = p.photos == null ? [] : p.photos;
      if (!Array.isArray(rawPhotos)) return tx.error('BAD_VALUE', 'รูปหลักฐานต้องเป็นรายการ {name, url}', { field: 'photos' });
      if (rawPhotos.length > MAX_PHOTOS) return tx.error('TOO_MANY', `แนบรูปได้ไม่เกิน ${MAX_PHOTOS} รูปต่อผลตรวจ`, { field: 'photos' });
      for (const ph of rawPhotos) {
        const url = util.trim(ph && ph.url);
        const name = util.trim(ph && ph.name).slice(0, 120);
        if (!url && !name) return tx.error('BAD_VALUE', 'รูปหลักฐานต้องมีชื่อหรือลิงก์', { field: 'photos' });
        if (url.length > MAX_URL || /^data:/i.test(url)) return tx.error('BAD_VALUE', 'แนบเป็นลิงก์ของรูปที่อัปโหลดแล้วเท่านั้น (ไม่ฝังรูปในข้อมูล)', { field: 'photos' });
        photos.push({ name, url });
      }
      const result = results.every((r) => r.ok) ? 'PASS' : 'FAIL';
      const id = tx.nextId('IN');
      const row = {
        id, stage, code: it.id, wh, bin, lot, qty: round(qty), fromStatus, sourceDoc, jobNo, planId: plan.id, planRev: plan.drawingRev,
        sourceRef: plan.sourceRef, results, photos, inspector: tx.userId, at: tx.now, result, reinspectionOf: orig ? orig.id : '',
        reinspectionNcr: viaNcr ? viaNcr.ncrNo : '', revChanged, ncrNo: '', qsDocNo: '', status: result === 'PASS' ? 'OPEN' : 'NCR',
        releasedQty: 0, releasedBy: '', releasedAt: '', releases: [], voidedBy: '', voidedAt: '', voidReason: '',
        note: util.trim(p.note).slice(0, 500),
      };
      if (result === 'FAIL') {
        const failed = results.filter((r) => !r.ok);
        const defect = failed.map((r) => (r.kind === 'measure' ? `${r.name} = ${r.value}${r.unit ? ' ' + r.unit : ''} (เกณฑ์ ${rangeText(r)})` : `${r.name}: ${r.value}`)).join('; ');
        const ncrNo = tx.nextNo('NCR', tx.date);
        let qs = null;
        if (stock) {
          qs = writeQS(tx, { reason: `ตรวจไม่ผ่าน ${id} → ${ncrNo}`, ref: id, job: jobNo, source: 'inspection:' + id,
            lines: [{ code: it.id, wh, bin, lot, qty: row.qty, from: fromStatus, to: QUARANTINE }] });
          if (!qs) return;
        }
        row.ncrNo = ncrNo;
        row.qsDocNo = qs ? qs.docNo : '';
        const ncr = {
          ncrNo, code: it.id, wh, bin, lot, qty: row.qty, stage, inspectionId: id, jobNo, stockHeld: stock, defect: defect.slice(0, 500),
          description: row.note, status: 'OPEN', disposition: '', dispositionBy: '', dispositionAt: '', reason: '', conditions: '',
          docNo: '', docType: '', reinspections: [], createdBy: tx.userId, createdAt: tx.now, closedBy: '', closedAt: '', closeNote: '', history: [],
        };
        hist(ncr, tx, 'OPEN', `จากผลตรวจ ${id}${qs ? '; กักกัน ' + row.qty + ' ' + it.baseUnit + ' (' + qs.docNo + ')' : ''}`);
        tx.put('ncrs', ncrNo, ncr);
        if (!photos.length) tx.warn('ผลไม่ผ่านแต่ไม่มีรูปหลักฐาน – แนบรูปเพิ่มในการตรวจซ้ำได้');
        tx.result.ncrNo = ncrNo;
        tx.result.docNo = row.qsDocNo;
      }
      if (viaNcr) {
        const n = tx.get('ncrs', viaNcr.ncrNo);
        tx.put('ncrs', n.ncrNo, hist(Object.assign(clone(n), { reinspections: (n.reinspections || []).concat([{ id, result, at: tx.now, by: tx.userId }]) }),
          tx, 'REINSPECT', `ตรวจซ้ำ ${id}: ${result === 'PASS' ? 'ผ่าน' : 'ไม่ผ่าน'}${revChanged ? ' (แบบเปลี่ยนเป็นฉบับ ' + plan.drawingRev + ')' : ''}`));
      }
      if (revChanged) tx.warn(`ฉบับแบบเปลี่ยนจาก "${orig.planRev || '-'}" เป็น "${plan.drawingRev || '-'}" – ตรวจตามแผน ${plan.id} ฉบับปัจจุบัน`);
      tx.put('inspections', id, row);
      tx.result.id = id;
      tx.result.result = result;
      tx.summary = `ตรวจ${STAGES[stage]} ${id} ${it.id}${lot ? ' ล็อต ' + lot : ''} ${row.qty} ${it.baseUnit}: ${result === 'PASS' ? 'ผ่าน รออนุมัติปล่อย' : 'ไม่ผ่าน → ' + row.ncrNo}`;
    },
  });

  define('qc.release', {
    label: 'อนุมัติปล่อยผ่าน QC', perm: 'qc.release',
    prepare(tx, p) {
      const insp = tx.get('inspections', util.normCode(p.id));
      if (!insp) return tx.error('NOT_FOUND', `ไม่พบผลตรวจ ${p.id || ''}`, { field: 'id' });
      const blockers = releaseBlockers(tx, insp, tx.userId);
      if (blockers.length) {
        for (const b of blockers) tx.error(b.code, b.message);
        return;
      }
      const it = tx.item(insp.code);
      const left = round(insp.qty - (insp.releasedQty || 0));
      let qty = left;
      if (p.qty != null && p.qty !== '') {
        qty = util.num(p.qty);
        if (isNaN(qty) || qty <= 0) return tx.error('BAD_QTY', 'จำนวนที่ปล่อยต้องเป็นตัวเลขมากกว่า 0', { field: 'qty' });
        if (round(qty) > left) return tx.error('TOO_MUCH', `ปล่อยได้ไม่เกิน ${left} ${it.baseUnit}`, { field: 'qty' });
        qty = round(qty);
      }
      let qs = null;
      if (STOCK_STAGES[insp.stage]) {
        if (!tx.need('qc.release', insp.wh, { field: 'id' })) return;
        qs = writeQS(tx, { reason: `ผ่าน QC ${insp.id} (แผน ${insp.planId} แบบฉบับ ${insp.planRev || '-'})`, ref: insp.id, job: insp.jobNo,
          source: 'inspection:' + insp.id, lines: [{ code: insp.code, wh: insp.wh, bin: insp.bin, lot: insp.lot, qty, from: insp.fromStatus, to: AVAILABLE }] });
        if (!qs) return;
      }
      const releasedQty = round((insp.releasedQty || 0) + qty);
      const done = releasedQty >= insp.qty;
      tx.put('inspections', insp.id, Object.assign(clone(insp), {
        releasedQty, status: done ? 'RELEASED' : 'OPEN', releasedBy: tx.userId, releasedAt: tx.now,
        releases: (insp.releases || []).concat([{ qty, by: tx.userId, at: tx.now, docNo: qs ? qs.docNo : '' }]),
      }));
      tx.result = { id: insp.id, docNo: qs ? qs.docNo : '', qty, done };
      tx.summary = `ปล่อยผ่าน QC ${insp.id} ${insp.code}${insp.lot ? ' ล็อต ' + insp.lot : ''} ${qty} ${it.baseUnit}${qs ? ' → ใช้ได้ (' + qs.docNo + ')' : ''}`;
    },
  });

  // ---------------------------------------------------------------------------------------------------------
  // NCR
  // ---------------------------------------------------------------------------------------------------------
  /** Open an NCR for stock already in QUARANTINE (e.g. a quarantined lot) without a failed inspection. */
  define('ncr.open', {
    label: 'เปิด NCR ของที่กักกัน', perm: 'qc.inspect',
    prepare(tx, p) {
      const it = getItem(tx, p.code);
      if (!it) return;
      const lot = util.trim(p.lot);
      if (lot && !tracked(it)) return tx.error('LOT_NOT_TRACKED', `${it.id} ไม่ได้ตั้งให้ติดตามล็อต`, { field: 'lot' });
      if (tracked(it) && !lot) return tx.error('LOT_REQUIRED', `${it.id} ต้องระบุ${trackName(it)}`, { field: 'lot' });
      const wh = util.normCode(p.wh);
      const bin = util.normCode(p.bin);
      if (!checkWh(tx, wh, bin, 'qc.inspect')) return;
      const qty = util.num(p.qty);
      if (isNaN(qty) || qty <= 0) return tx.error('BAD_QTY', 'จำนวนต้องเป็นตัวเลขมากกว่า 0', { field: 'qty' });
      const defect = util.trim(p.defect).slice(0, 500);
      if (!defect) return tx.error('REQUIRED', 'ระบุข้อบกพร่อง', { field: 'defect' });
      const loc = { code: it.id, wh, bin, lot };
      const have = tx.balanceAt(Object.assign({ status: QUARANTINE }, loc)).qty;
      const held = heldByNcr(tx, loc);
      if (round(qty) > round(have - held)) {
        return tx.error('NOT_ENOUGH', `${it.id} ที่ ${locText(loc)} กักกันอยู่ ${have} ${it.baseUnit}${held ? ` (อยู่ใน NCR อื่น ${held})` : ''} – เปิด NCR ได้ไม่เกิน ${Math.max(0, round(have - held))}`, { field: 'qty' });
      }
      const ncrNo = tx.nextNo('NCR', tx.date);
      const ncr = {
        ncrNo, code: it.id, wh, bin, lot, qty: round(qty), stage: '', inspectionId: '', jobNo: util.trim(p.jobNo), stockHeld: true,
        defect, description: util.trim(p.description).slice(0, 500), status: 'OPEN', disposition: '', dispositionBy: '', dispositionAt: '',
        reason: '', conditions: '', docNo: '', docType: '', reinspections: [], createdBy: tx.userId, createdAt: tx.now,
        closedBy: '', closedAt: '', closeNote: '', history: [],
      };
      tx.put('ncrs', ncrNo, hist(ncr, tx, 'OPEN', `ของกักกัน ${locText(loc)} ${ncr.qty} ${it.baseUnit}: ${defect}`));
      tx.result.ncrNo = ncrNo;
      tx.summary = `เปิด ${ncrNo} ${it.id}${lot ? ' ล็อต ' + lot : ''} ${ncr.qty} ${it.baseUnit}`;
    },
  });

  define('ncr.disposition', {
    label: 'ตัดสิน NCR',
    perm: (tx, p) => (String((p && p.disposition) || '').toUpperCase() === 'USE_AS_IS' ? 'ncr.useAsIs' : 'ncr.disposition'),
    prepare(tx, p) {
      if (!tx.need('ncr.disposition')) return;
      const ncr = tx.get('ncrs', util.normCode(p.ncrNo));
      if (!ncr) return tx.error('NOT_FOUND', `ไม่พบ NCR ${p.ncrNo || ''}`, { field: 'ncrNo' });
      if (ncr.status !== 'OPEN') return tx.error('BAD_STATE', `${ncr.ncrNo} ${NCR_STATUS[ncr.status]}${ncr.disposition ? ' (' + DISPOSITIONS[ncr.disposition] + ')' : ''}`);
      const disp = String(p.disposition || '').toUpperCase();
      if (!DISPOSITIONS[disp]) return tx.error('BAD_VALUE', 'การตัดสินต้องเป็น REWORK, RETURN, SCRAP หรือ USE_AS_IS', { field: 'disposition' });
      const reason = needReason(tx, p.reason, 'เหตุผลการตัดสิน');
      if (!reason) return;
      const insp = ncr.inspectionId ? tx.get('inspections', ncr.inspectionId) : null;
      let conditions = '';
      if (disp === 'USE_AS_IS') {
        conditions = util.trim(p.conditions).slice(0, 500);
        if (conditions.length < 3) return tx.error('REQUIRED', 'ยอมรับแบบมีเงื่อนไขต้องระบุเงื่อนไข', { field: 'conditions' });
        if (insp && !tx.different(insp.inspector, 'ผู้อนุมัติยอมรับแบบมีเงื่อนไข')) return;
        if (!tx.different(ncr.createdBy, 'ผู้อนุมัติยอมรับแบบมีเงื่อนไข')) return;
      }
      const it = tx.item(ncr.code);
      const lot = ncr.lot ? tx.get('lots', lotKey(ncr.code, ncr.lot)) : null;
      let doc = null;
      if (ncr.stockHeld) {
        if (!tx.need('ncr.disposition', ncr.wh, { field: 'ncrNo' })) return;
        const loc = { code: ncr.code, wh: ncr.wh, bin: ncr.bin, lot: ncr.lot, qty: ncr.qty };
        const note = `${ncr.ncrNo} ${DISPOSITIONS[disp]}: ${reason}`;
        if (disp === 'REWORK') {
          doc = writeQS(tx, { reason: note, ref: ncr.ncrNo, job: ncr.jobNo, source: 'ncr:' + ncr.ncrNo,
            lines: [Object.assign({ from: QUARANTINE, to: REWORK }, loc)] });
        } else if (disp === 'USE_AS_IS') {
          if (lot && lot.status === 'QUARANTINED') return tx.error('LOT_QUARANTINED', `${ncr.code} ล็อต ${ncr.lot} ถูกกักกันทั้งล็อต – ปลดกักกันล็อตก่อน`);
          if (it.certRequired && (!lot || !lot.cert || !lot.cert.verified)) {
            return tx.error('CERT_NOT_VERIFIED', `${ncr.code}${ncr.lot ? ' ล็อต ' + ncr.lot : ''} ต้องมีใบรับรองวัสดุที่ตรวจแล้วก่อนนำไปใช้`);
          }
          doc = writeQS(tx, { reason: `${note}; เงื่อนไข: ${conditions}`, ref: ncr.ncrNo, job: ncr.jobNo, source: 'ncr:' + ncr.ncrNo,
            lines: [Object.assign({ from: QUARANTINE, to: AVAILABLE, remark: `ยอมรับแบบมีเงื่อนไข ${ncr.ncrNo}: ${conditions}` }, loc)] });
        } else {
          const type = disp === 'RETURN' ? 'RV' : 'SC';
          const d = {
            docNo: '', type, date: tx.date, status: 'DRAFT', job: ncr.jobNo || '', department: 'QC', ref: ncr.ncrNo, remark: note,
            lines: [Object.assign({ code: ncr.code, qty: ncr.qty, unit: it.baseUnit, wh: ncr.wh, bin: ncr.bin, toWh: '', toBin: '', lot: ncr.lot,
              status: QUARANTINE, unitCost: '', remark: note, reservationId: '', jobNo: '' }, disp === 'RETURN' ? poRef(tx, lot) : { poNo: '', poLine: '' })],
            createdBy: tx.userId, createdAt: tx.now, postedBy: '', postedAt: '', cancelledBy: '', cancelledAt: '', cancelReason: '',
            override: null, expressStatus: '', expressNo: '', source: 'ncr:' + ncr.ncrNo, supplier: (lot && lot.supplier) || '',
          };
          doc = postForNcr(tx, d);
        }
        if (!doc) return;
      } else if (disp === 'RETURN') {
        return tx.error('NO_STOCK', `${ncr.ncrNo} ไม่มีของในคลัง (พบระหว่างผลิต) – คืนผู้ขายไม่ได้`, { field: 'disposition' });
      }
      const next = Object.assign(clone(ncr), { status: 'DISPOSITIONED', disposition: disp, dispositionBy: tx.userId, dispositionAt: tx.now,
        reason, conditions, docNo: doc ? doc.docNo : '', docType: doc ? doc.type : '' });
      tx.put('ncrs', ncr.ncrNo, hist(next, tx, 'DISPOSITION', `${DISPOSITIONS[disp]}: ${reason}${conditions ? '; เงื่อนไข: ' + conditions : ''}${doc ? ' (' + doc.docNo + ')' : ''}`));
      tx.result = { ncrNo: ncr.ncrNo, docNo: doc ? doc.docNo : '', docType: doc ? doc.type : '' };
      tx.summary = `ตัดสิน ${ncr.ncrNo} ${DISPOSITIONS[disp]}${doc ? ' ' + doc.docNo : ''}`;
    },
  });

  define('ncr.close', {
    label: 'ปิด NCR', perm: 'ncr.disposition',
    prepare(tx, p) {
      const ncr = tx.get('ncrs', util.normCode(p.ncrNo));
      if (!ncr) return tx.error('NOT_FOUND', `ไม่พบ NCR ${p.ncrNo || ''}`, { field: 'ncrNo' });
      if (ncr.status === 'CLOSED') return tx.error('BAD_STATE', `${ncr.ncrNo} ปิดแล้ว`);
      if (ncr.status !== 'DISPOSITIONED') return tx.error('NOT_DISPOSITIONED', `${ncr.ncrNo} ยังไม่ได้ตัดสิน – ตัดสินก่อนปิด`);
      if (ncr.disposition === 'REWORK' && !(ncr.reinspections || []).length) {
        return tx.error('REINSPECTION_PENDING', `${ncr.ncrNo} แก้ไขงานแล้วต้องตรวจซ้ำก่อนปิด`);
      }
      const note = util.trim(p.note).slice(0, 500);
      tx.put('ncrs', ncr.ncrNo, hist(Object.assign(clone(ncr), { status: 'CLOSED', closedBy: tx.userId, closedAt: tx.now, closeNote: note }),
        tx, 'CLOSE', note));
      tx.summary = `ปิด ${ncr.ncrNo}`;
    },
  });

  // ---------------------------------------------------------------------------------------------------------
  // hooks into document posting
  // ---------------------------------------------------------------------------------------------------------
  RRS.hooks.on('doc.lineCheck', function qualityLineCheck(tx, doc, line) {
    if (doc.type === 'QS') return;
    const td = typeDef(doc.type);
    const out = isOutLine(td, line);
    const lot = line.lot ? tx.get('lots', lotKey(line.code, line.lot)) : null;
    const quarantined = !!lot && lot.status === 'QUARANTINED';
    const n = line.line;
    if (out) {
      if (quarantined && !LOT_EXIT_TYPES[doc.type]) {
        return tx.error('LOT_QUARANTINED', `บรรทัด ${n}: ${line.code} ${line.lot} ถูกกักกัน (${lot.quarantineReason}) – เบิก/โอน/ส่งมอบไม่ได้ ยกเว้นตัดทิ้งหรือคืนผู้ขาย`, { line: n, field: 'lot' });
      }
      if (!ncrPosting && (line.status === QUARANTINE || line.status === REWORK)) {
        if (doc.type === 'SC' && !tx.can('ncr.disposition', line.wh)) {
          return tx.error('NCR_REQUIRED', `บรรทัด ${n}: ตัดทิ้งของ${STATUS_LABEL[line.status]}ต้องตัดสินผ่าน NCR (หรือผู้มีสิทธิ์ตัดสิน NCR คลัง ${line.wh})`, { line: n });
        }
        if (line.status === QUARANTINE) {
          const held = heldByNcr(tx, line);
          const have = tx.balanceAt(line).qty;
          if (held > 0 && absQ(line) > round(have - held)) {
            return tx.error('NCR_HELD', `บรรทัด ${n}: ${line.code} ที่ ${locText(line)} มีของรอตัดสิน NCR ${held} – ใช้ได้ ${Math.max(0, round(have - held))} ตัดสินผ่าน NCR แทน`, { line: n });
          }
        }
      }
    } else if (quarantined && (line.status === AVAILABLE || line.status === QC_HOLD)) {
      line.status = QUARANTINE; // a new receipt of a quarantined lot is quarantined too
      tx.warn(`บรรทัด ${n}: ${line.code} ${line.lot} ถูกกักกัน – รับเข้าเป็นสถานะกักกัน`);
    }
  });

  RRS.hooks.on('doc.check', function qualityDocCheck(tx, doc, lines) {
    if (doc.type === 'QS') {
      return tx.error('QS_MANUAL', 'เอกสารเปลี่ยนสถานะคุณภาพ (QS) ระบบสร้างจากคำสั่ง QC เท่านั้น – บันทึกเองไม่ได้');
    }
    if (doc.type === 'SC' && !util.trim(doc.remark) && !lines.every((l) => util.trim(l.remark))) {
      tx.error('REQUIRED', 'ใบตัดทิ้งต้องระบุเหตุผล (หมายเหตุ)', { field: 'remark' });
    }
  });

  RRS.hooks.on('doc.posted', function qualityPosted(tx, doc, lines) {
    const td = typeDef(doc.type);
    const rows = {};
    for (const ln of lines) {
      if (!ln.lot || !isInLine(td, ln)) continue;
      const it = ln.item || tx.item(ln.code);
      if (!tracked(it)) continue;
      const k = lotKey(it.id, ln.lot);
      let row = rows[k] || (tx.get('lots', k) ? clone(tx.get('lots', k)) : null);
      const po = ln.poNo ? tx.get('pos', ln.poNo) : null;
      const supplier = ln.supplier || doc.supplier || (po && po.supplier) || '';
      if (!row) {
        row = newLot(tx, it, ln.lot, { supplier, poNo: ln.poNo || '', poLine: ln.poLine || '', docNo: doc.docNo, docType: doc.type,
          receivedAt: tx.now });
      } else {
        if (!row.supplier && supplier) row.supplier = supplier;
        if (!row.poNo && ln.poNo) Object.assign(row, { poNo: ln.poNo, poLine: ln.poLine || '' });
      }
      hist(row, tx, 'RECEIVE', `${doc.type} ${doc.docNo} บรรทัด ${ln.line} ${absQ(ln)} ${it.baseUnit} ${STATUS_LABEL[ln.status] || ''}`);
      rows[k] = row;
    }
    for (const k in rows) tx.put('lots', k, rows[k]);
  });

  RRS.hooks.on('doc.cancelled', function qualityCancelled(tx, doc, lines) {
    if (doc.type === 'QS') {
      return tx.error('QS_NO_CANCEL', `${doc.docNo} เป็นการเปลี่ยนสถานะคุณภาพ – ยกเลิกตรงไม่ได้ ใช้คำสั่ง QC (กักกัน/ตรวจซ้ำ) แทน`);
    }
    // an SC/RV posted for an NCR decision: the stock is back in QUARANTINE, the NCR waits for a decision again
    for (const n of tx.all('ncrs', (x) => x.docNo === doc.docNo && x.docType === doc.type && x.status === 'DISPOSITIONED')) {
      const next = Object.assign(clone(n), { status: 'OPEN', disposition: '', dispositionBy: '', dispositionAt: '', reason: '',
        conditions: '', docNo: '', docType: '' });
      tx.put('ncrs', n.ncrNo, hist(next, tx, 'UNDO', `ยกเลิก ${doc.docNo} (${DISPOSITIONS[n.disposition]} โดย ${n.dispositionBy} เมื่อ ${n.dispositionAt}): ${doc.cancelReason || ''}`));
    }
    if (doc.type === 'SC' || doc.type === 'RV') {
      for (const n of tx.all('ncrs', (x) => x.docNo === doc.docNo && x.docType === doc.type && x.status === 'CLOSED')) {
        return tx.error('NCR_CLOSED', `${doc.docNo} เป็นผลการตัดสิน ${n.ncrNo} ที่ปิดแล้ว – ยกเลิกไม่ได้`);
      }
    }
    // receipts: note it on the lot and void inspections of that receipt still waiting for release
    const td = typeDef(doc.type);
    const touched = {};
    for (const ln of lines || []) {
      if (!ln.lot || !isInLine(td, ln)) continue;
      const k = lotKey(ln.code, ln.lot);
      const row = touched[k] || (tx.get('lots', k) ? clone(tx.get('lots', k)) : null);
      if (!row) continue;
      touched[k] = hist(row, tx, 'RECEIPT_CANCELLED', `ยกเลิก ${doc.type} ${doc.docNo}: ${doc.cancelReason || ''}`);
    }
    for (const k in touched) tx.put('lots', k, touched[k]);
    voidInspections(tx, (i) => i.sourceDoc === doc.docNo, `ยกเลิกเอกสาร ${doc.docNo}`);
  });

  // ---------------------------------------------------------------------------------------------------------
  // read helpers for screens (pure functions of a state)
  // ---------------------------------------------------------------------------------------------------------
  const Q = { STAGES, PLAN_STATUS, INSP_STATUS, NCR_STATUS, DISPOSITIONS, LOT_STATUS, CHAR_KIND, LOT_EXIT_TYPES };

  function docEntry(d, lines) {
    const ln0 = lines[0] || {};
    return {
      docNo: d.docNo, type: d.type, typeName: (typeDef(d.type) || {}).name || d.type, date: d.date, status: d.status,
      cancelled: d.status === 'CANCELLED', job: jobKey(d.job || ln0.jobNo), ref: d.ref || '', remark: d.remark || '',
      supplier: d.supplier || '', poNo: ln0.poNo || '', postedBy: d.postedBy || '', postedAt: d.postedAt || '',
      qty: round(util.sum(lines, absQ)), wh: ln0.wh || '', bin: ln0.bin || '',
      lines: lines.map((l) => ({ line: l.line, code: l.code, lot: l.lot || '', qty: absQ(l), unit: l.baseUnit || l.unit || '', wh: l.wh,
        bin: l.bin || '', toWh: l.toWh || '', toBin: l.toBin || '', status: l.status || '', fromStatus: l.fromStatus || '',
        toStatus: l.toStatus || '', jobNo: l.jobNo || '', poNo: l.poNo || '' })),
    };
  }
  const byDate = (a, b) => String(a.postedAt || a.date).localeCompare(String(b.postedAt || b.date)) || String(a.docNo).localeCompare(String(b.docNo));
  function postedDocs(state) {
    return RRS.q.rows(state, 'documents', posted);
  }
  function jobDocs(state, types, jobs) {
    const out = [];
    for (const d of postedDocs(state)) {
      if (!types[d.type]) continue;
      const ls = (d.lines || []).filter((l) => jobs[jobKey(d.job || l.jobNo)]);
      if (ls.length) out.push(docEntry(d, ls));
    }
    return out.sort(byDate);
  }

  /** Lot rows whose lot (or item code) contains the text – spaces, dashes and case ignored. */
  Q.findLots = function findLots(state, text) {
    const k = util.ckey(text);
    if (!k) return [];
    return RRS.q.rows(state, 'lots', (l) => util.ckey(l.lot).indexOf(k) >= 0 || util.ckey(l.code) === k)
      .sort((a, b) => (a.code + '|' + a.lot).localeCompare(b.code + '|' + b.lot));
  };
  Q.lotOf = (state, code, lot) => {
    const it = RRS.q.item(state, code);
    return RRS.q.get(state, 'lots', lotKey(it ? it.id : util.normCode(code), util.trim(lot)));
  };
  Q.isLotQuarantined = (state, code, lot) => {
    const row = Q.lotOf(state, code, lot);
    return !!row && row.status === 'QUARANTINED';
  };

  /**
   * Follow a lot (code optional – a heat number may be searched alone): the receipts, the documents that took it out
   * (with their job), the jobs, their FR outputs and DL deliveries, transfers, status changes, inspections and NCRs.
   */
  Q.trace = function trace(state, f) {
    f = f || {};
    const lot = util.trim(f.lot);
    const it = f.code ? RRS.q.item(state, f.code) : null;
    const code = it ? it.id : (f.code ? util.normCode(f.code) : '');
    const match = (l) => !!lot && (l.lot || '') === lot && (!code || l.code === code);
    const receipts = [];
    const issues = [];
    const transfers = [];
    const statusChanges = [];
    for (const d of postedDocs(state)) {
      const ls = (d.lines || []).filter(match);
      if (!ls.length) continue;
      const td = typeDef(d.type);
      if (!td) continue;
      if (td.dir === 'S') { statusChanges.push(docEntry(d, ls)); continue; }
      if (td.dir === 'T') { transfers.push(docEntry(d, ls)); continue; }
      const ins = ls.filter((l) => isInLine(td, l));
      const outs = ls.filter((l) => isOutLine(td, l));
      if (ins.length) receipts.push(docEntry(d, ins));
      if (outs.length) issues.push(docEntry(d, outs));
    }
    [receipts, issues, transfers, statusChanges].forEach((a) => a.sort(byDate));
    const jobSet = {};
    const jobs = [];
    for (const e of issues) {
      if (e.cancelled) continue;
      for (const l of e.lines) {
        const j = jobKey(e.job || l.jobNo);
        if (j && !jobSet[j]) { jobSet[j] = true; jobs.push(j); }
      }
    }
    const producedBy = [];
    for (const e of receipts) if (!e.cancelled && e.type === 'FR' && e.job && producedBy.indexOf(e.job) < 0) producedBy.push(e.job);
    const outputs = jobDocs(state, { FR: true }, jobSet);
    const deliveries = jobDocs(state, { DL: true }, jobSet);
    for (const e of issues) if (e.type === 'DL' && !deliveries.some((x) => x.docNo === e.docNo)) deliveries.push(e);
    const lots = RRS.q.rows(state, 'lots', (l) => l.lot === lot && (!code || l.code === code));
    const inspections = RRS.q.rows(state, 'inspections', match).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const ncrs = RRS.q.rows(state, 'ncrs', match).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const balances = RRS.q.rows(state, 'balances', match);
    return { query: { code, lot }, lot: lots[0] || null, lots, receipts, issues, transfers, statusChanges, jobs, producedBy, outputs,
      deliveries: deliveries.sort(byDate), inspections, ncrs, balances };
  };

  /** Back from a job: the lots its PD/OU took (net of RT), and for each the receipts with supplier, PO and cert. */
  Q.traceJob = function traceJob(state, jobNo) {
    const jn = jobKey(jobNo);
    const groups = {};
    const order = [];
    for (const d of postedDocs(state)) {
      if (d.status === 'CANCELLED' || ['PD', 'OU', 'RT'].indexOf(d.type) < 0) continue;
      for (const l of d.lines || []) {
        if (!l.lot || jobKey(d.job || l.jobNo) !== jn) continue;
        const k = lotKey(l.code, l.lot);
        if (!groups[k]) { groups[k] = { code: l.code, name: l.name || '', lot: l.lot, unit: l.baseUnit || '', issued: 0, returned: 0, docs: [] }; order.push(k); }
        const g = groups[k];
        if (d.type === 'RT') g.returned = round(g.returned + absQ(l));
        else g.issued = round(g.issued + absQ(l));
        if (g.docs.indexOf(d.docNo) < 0) g.docs.push(d.docNo);
      }
    }
    const lots = order.map((k) => {
      const g = groups[k];
      const row = RRS.q.get(state, 'lots', k);
      const tr = Q.trace(state, { code: g.code, lot: g.lot });
      const receipts = tr.receipts.filter((e) => !e.cancelled && e.type !== 'RT').map((e) => {
        const po = e.poNo ? RRS.q.get(state, 'pos', e.poNo) : null;
        return { docNo: e.docNo, type: e.type, date: e.date, qty: e.qty, poNo: e.poNo || (row && row.poNo) || '',
          supplier: e.supplier || (po && po.supplier) || (row && row.supplier) || '' };
      });
      return Object.assign(g, { qty: round(g.issued - g.returned), lotRow: row || null, supplier: (row && row.supplier) || '',
        poNo: (row && row.poNo) || '', cert: (row && row.cert) || null, lotStatus: (row && row.status) || '', receipts,
        inspections: tr.inspections });
    });
    const one = {};
    one[jn] = true;
    return {
      jobNo: jn, lots, outputs: jobDocs(state, { FR: true }, one), deliveries: jobDocs(state, { DL: true }, one),
      inspections: RRS.q.rows(state, 'inspections', (i) => jobKey(i.jobNo) === jn).sort((a, b) => String(a.at).localeCompare(String(b.at))),
      ncrs: RRS.q.rows(state, 'ncrs', (n) => jobKey(n.jobNo) === jn),
    };
  };

  /**
   * Work list of QC: balances in QC_HOLD / QUARANTINE / REWORK (age in days since lastIn, against `today`
   * 'YYYY-MM-DD'), with the open inspections and NCRs at the same place.
   */
  Q.qcQueue = function qcQueue(state, today) {
    const r = readerOf(state);
    const openInsp = r.all('inspections', (i) => i.status === 'OPEN');
    const openNcr = r.all('ncrs', (n) => n.status === 'OPEN' || n.status === 'DISPOSITIONED');
    const balances = r.all('balances', (b) => HOLD.indexOf(b.status) >= 0 && b.wh !== TRANSIT && b.qty > 0).map((b) => {
      const it = r.get('items', b.code) || {};
      const lot = b.lot ? r.get('lots', lotKey(b.code, b.lot)) : null;
      const inspections = openInsp.filter((i) => STOCK_STAGES[i.stage] && i.fromStatus === b.status && sameLoc(i, b));
      const ncrs = openNcr.filter((n) => n.stockHeld && sameLoc(n, b));
      const pending = round(util.sum(inspections, (i) => i.qty - (i.releasedQty || 0)));
      const held = b.status === QUARANTINE ? heldByNcr(r, b) : 0;
      const lastDay = b.lastIn ? util.bkkDate(b.lastIn) : '';
      return {
        code: b.code, name: it.name || '', unit: it.baseUnit || '', wh: b.wh, bin: b.bin, lot: b.lot, status: b.status,
        statusLabel: STATUS_LABEL[b.status], qty: b.qty, lastIn: b.lastIn || '', ageDays: today && lastDay ? util.daysBetween(lastDay, today) : null,
        lotStatus: lot ? lot.status : '', certRequired: !!it.certRequired, certNo: (lot && lot.cert && lot.cert.no) || '',
        certVerified: !!(lot && lot.cert && lot.cert.verified), inspections, ncrs, waitingRelease: pending, ncrHeld: held,
        toInspect: b.status === QUARANTINE ? 0 : Math.max(0, round(b.qty - pending)),
      };
    }).sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0) || (a.code + a.wh + a.bin + a.lot).localeCompare(b.code + b.wh + b.bin + b.lot));
    const totals = { QC_HOLD: 0, QUARANTINE: 0, REWORK: 0 };
    for (const b of balances) totals[b.status] = round(totals[b.status] + b.qty);
    return {
      balances, totals,
      inspections: openInsp.sort((a, b) => String(a.at).localeCompare(String(b.at))),
      ncrs: openNcr.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
    };
  };

  /** The APPROVED plan of an item + stage (null when none); stale = bound to another revision than the item's. */
  Q.planFor = function planFor(state, code, stage) {
    const it = RRS.q.item(state, code);
    const id = it ? it.id : util.normCode(code);
    const st = String(stage || '').toUpperCase();
    const ps = RRS.q.rows(state, 'qc_plans', (x) => x.code === id && x.stage === st && x.status === 'APPROVED')
      .sort((a, b) => String(b.approvedAt).localeCompare(String(a.approvedAt)));
    if (!ps.length) return null;
    return Object.assign({}, ps[0], { stale: !!it && util.normCode(it.drawingRev) !== util.normCode(ps[0].drawingRev) });
  };
  Q.plans = (state, code) => {
    const it = code ? RRS.q.item(state, code) : null;
    return RRS.q.rows(state, 'qc_plans', (x) => !code || x.code === (it ? it.id : util.normCode(code)))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  };
  /** Why userId cannot release inspection `id` now (Thai messages; [] = can release, permission aside). */
  Q.releaseCheck = function releaseCheck(state, id, userId) {
    return releaseBlockers(readerOf(state), RRS.q.get(state, 'inspections', util.normCode(id)), userId);
  };

  RRS.quality = Q;
})(typeof globalThis !== 'undefined' ? globalThis : this);
