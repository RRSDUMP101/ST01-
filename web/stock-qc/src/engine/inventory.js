/*
 * Phase 1 – receipts, issues, adjustments and transfers by item + warehouse + bin (+ quality status + lot).
 *
 * Rules (acceptance criteria of Phase 1):
 *  - a document is checked as a whole before any balance changes; one bad line and nothing is saved
 *  - a request sent twice changes stock once (request id, see core.prepare)
 *  - stock cannot go below zero; an exception needs a second person with approval rights and a reason
 *  - an issue takes stock only from the warehouse/bin it names
 *  - a transfer moves stock out of the source into "in transit", then into the destination when received
 *  - cancelling writes reversing movements that point at the originals; history is never deleted
 *
 * Other modules extend posting through hooks:
 *   'doc.lineCheck' (tx, doc, line)   more checks per resolved line (lots, PO links, count freeze …)
 *   'doc.check'     (tx, doc, lines)  checks over the whole document
 *   'doc.posted'    (tx, doc, lines)  side effects in the same commit (PO received, reservations used …)
 *   'doc.cancelled' (tx, doc, lines)  undo those side effects
 *   'transfer.receiveLine' (tx, doc, line, info) a transfer line arriving: refuse with tx.error, or set info.status
 * RRS.inventory.post(tx, doc, {perm}) checks the warehouses with that permission (e.g. count.approve, ncr.disposition).
 * and RRS.inventory.reservedElsewhere(fn): fn(tx, code, wh, doc, line) -> qty kept for other jobs.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { util, schema, commands, STATUS, STATUS_LABEL, TRANSIT } = RRS;
  const define = commands.define;

  schema.define('documents', {
    label: 'เอกสารรับ–จ่าย–โอน', phase: 1, key: 'docNo',
    fields: [['docNo', 'text', 'เลขที่ในระบบ'], ['type', 'text', 'ประเภท'], ['date', 'date', 'วันที่เอกสาร'],
      ['status', 'enum', 'สถานะ', 'DRAFT/WAIT_APPROVAL/POSTED/IN_TRANSIT/RECEIVED/CANCELLED'], ['job', 'text', 'งาน/SO'],
      ['department', 'text', 'แผนก'], ['ref', 'text', 'เอกสารอ้างอิง'], ['remark', 'text', 'หมายเหตุ'],
      ['lines', 'json', 'บรรทัด {code, qty, unit, factor, base, wh, bin, toWh, toBin, lot, status, …}'],
      ['createdBy', 'text', 'ผู้สร้าง'], ['postedBy', 'text', 'ผู้บันทึก'], ['postedAt', 'datetime', 'บันทึกเมื่อ'],
      ['cancelledBy', 'text', 'ผู้ยกเลิก'], ['cancelReason', 'text', 'เหตุผลยกเลิก'],
      ['override', 'json', 'ข้อยกเว้นยอดติดลบ {requestedBy, reason, approvedBy, at}'],
      ['expressStatus', 'enum', 'สถานะคีย์ Express', 'WAIT/KEYED/N/A'], ['expressNo', 'text', 'เลขที่ Express']],
  });

  /** dir: -1 out, +1 in, 0 adjust (+/-), 'T' transfer. express: the same type exists in Express. */
  const DOC_TYPES = {
    PD: { name: 'จ่ายวัตถุดิบ/ชิ้นส่วนเพื่อผลิต', dir: -1, express: true },
    OU: { name: 'จ่ายสินค้าใช้ภายใน', dir: -1, express: true },
    FR: { name: 'รับสินค้าสำเร็จรูปจากการผลิต', dir: 1, express: true },
    RR: { name: 'รับสินค้า (ซื้อ)', dir: 1, express: true },
    AJ: { name: 'ปรับปรุงยอด', dir: 0, express: true, perm: 'doc.postAdjust' },
    RT: { name: 'รับคืนของเหลือจากงาน', dir: 1, express: false },
    TR: { name: 'โอนย้ายคลัง/ช่องเก็บ', dir: 'T', express: false },
  };
  const DOC_STATUS = { DRAFT: 'ร่าง', WAIT_APPROVAL: 'รออนุมัติข้อยกเว้น', POSTED: 'บันทึกแล้ว', IN_TRANSIT: 'ระหว่างโอน',
    RECEIVED: 'รับโอนครบ', CANCELLED: 'ยกเลิก' };
  const reservedFns = [];

  const inv = {
    DOC_TYPES, DOC_STATUS,
    /** Add a document type (RV, SC, DL … from other modules). */
    defineType(code, def) {
      DOC_TYPES[code] = Object.assign({ express: false }, def);
    },
    reservedElsewhere(fn) {
      reservedFns.push(fn);
    },
  };
  RRS.inventory = inv;

  function typeDef(type) {
    return DOC_TYPES[type] || null;
  }
  /** Types people may create by hand (QS and types with manual:false are written by their module only). */
  function manualType(type) {
    const td = DOC_TYPES[type];
    return !!td && td.manual !== false && td.dir !== 'S';
  }
  inv.manualType = manualType;
  function isOut(td, line) {
    return td.dir === -1 || td.dir === 'T' || (td.dir === 0 && line.base < 0);
  }

  /** Status a receipt goes into: items that must be inspected wait for QC. */
  inv.inboundStatus = function inboundStatus(tx, doc, line, item) {
    const td = typeDef(doc.type);
    if (td && td.inStatus) return td.inStatus(tx, doc, line, item);
    if (doc.type === 'RR' && item.qcIncoming) return STATUS.QC_HOLD;
    if (doc.type === 'FR' && item.qcFinal) return STATUS.QC_HOLD;
    if (doc.type === 'AJ' && line.status && STATUS[line.status]) return line.status;
    return STATUS.AVAILABLE;
  };

  function locText(l) {
    return `${l.wh}${l.bin ? '/' + l.bin : ''}`;
  }

  /** Check one line and turn it into the stored form (base-unit quantity, resolved item code …). */
  function resolveLine(tx, doc, raw, i, opts) {
    const td = typeDef(doc.type);
    const n = i + 1;
    const where = { line: n };
    const it = tx.item(raw.code);
    if (!it) return tx.error('NOT_FOUND', `บรรทัด ${n}: ไม่พบรหัส ${raw.code || '(ว่าง)'} ในทะเบียนสินค้า`, Object.assign({ field: 'code' }, where)) && null;
    if (it.active === false) return tx.error('INACTIVE', `บรรทัด ${n}: ${it.id} ปิดใช้งานแล้ว`, where) && null;
    const unit = util.trim(raw.unit) || it.baseUnit;
    const factor = RRS.unitFactor((t, k) => tx.get(t, k), it, unit);
    if (factor == null) return tx.error('NO_UNIT', `บรรทัด ${n}: ${it.id} ไม่มีตัวคูณของหน่วย "${unit}" (หน่วยหลัก ${it.baseUnit})`, Object.assign({ field: 'unit' }, where)) && null;
    const qty = util.num(raw.qty);
    if (isNaN(qty)) return tx.error('BAD_QTY', `บรรทัด ${n}: จำนวนไม่ใช่ตัวเลข`, Object.assign({ field: 'qty' }, where)) && null;
    if (td.dir === 0 ? qty === 0 : qty <= 0) return tx.error('BAD_QTY', `บรรทัด ${n}: จำนวนต้อง${td.dir === 0 ? 'ไม่เป็น 0' : 'มากกว่า 0'}`, Object.assign({ field: 'qty' }, where)) && null;
    const base = util.round(qty * factor);
    const line = {
      line: n, code: it.id, name: it.name, qty: util.round(qty), unit, factor, base, baseUnit: it.baseUnit,
      wh: util.normCode(raw.wh), bin: util.normCode(raw.bin), toWh: util.normCode(raw.toWh), toBin: util.normCode(raw.toBin),
      lot: util.trim(raw.lot), status: raw.status && STATUS[raw.status] ? raw.status : '',
      unitCost: isNaN(util.num(raw.unitCost)) ? it.unitCost || 0 : util.num(raw.unitCost), remark: util.trim(raw.remark),
      reservationId: raw.reservationId || '', poNo: raw.poNo || '', poLine: raw.poLine || '', jobNo: raw.jobNo || '',
      replace: raw.replace === true || raw.replace === 'true',
    };
    if (!checkLocation(tx, line.wh, line.bin, n, 'wh', (opts && opts.perm) || td.perm || 'doc.post')) return null;
    if (td.dir === 'T') {
      if (!line.toWh) return tx.error('REQUIRED', `บรรทัด ${n}: ระบุคลังปลายทาง`, Object.assign({ field: 'toWh' }, where)) && null;
      if (!checkLocation(tx, line.toWh, line.toBin, n, 'toWh', (opts && opts.perm) || 'transfer.receive')) return null;
      if (line.toWh === line.wh && line.toBin === line.bin) return tx.error('SAME_PLACE', `บรรทัด ${n}: ต้นทางกับปลายทางเป็นที่เดียวกัน`, where) && null;
    }
    const out = isOut(td, line);
    if (out) {
      line.status = line.status || STATUS.AVAILABLE;
      const allowed = td.outStatuses || [STATUS.AVAILABLE];
      if (allowed.indexOf(line.status) < 0) {
        return tx.error('BAD_STATUS', `บรรทัด ${n}: ของสถานะ "${STATUS_LABEL[line.status]}" ใช้กับ ${doc.type} ไม่ได้ – ต้องผ่าน QC/อนุมัติก่อน`, where) && null;
      }
    } else {
      line.status = inv.inboundStatus(tx, doc, line, it);
    }
    if (it.trackLot && it.trackLot !== 'none') {
      if (!line.lot) return tx.error('LOT_REQUIRED', `บรรทัด ${n}: ${it.id} ต้องระบุ${RRS.master.TRACK[it.trackLot]}`, Object.assign({ field: 'lot' }, where)) && null;
      if (it.trackLot === 'serial' && Math.abs(base) !== 1) {
        return tx.error('SERIAL_QTY', `บรรทัด ${n}: สินค้าติดตาม Serial บันทึกได้ครั้งละ 1 หน่วยต่อบรรทัด`, where) && null;
      }
      if (/[|\u0000-\u001f]/.test(line.lot)) return tx.error('BAD_LOT', `บรรทัด ${n}: เลขล็อตห้ามมี | หรืออักขระควบคุม`, Object.assign({ field: 'lot' }, where)) && null;
    } else if (line.lot) {
      return tx.error('LOT_NOT_TRACKED', `บรรทัด ${n}: ${it.id} ไม่ได้ตั้งให้ติดตามล็อต – ลบล็อตออก หรือแก้ทะเบียนสินค้า`, Object.assign({ field: 'lot' }, where)) && null;
    }
    line.item = it;
    RRS.hooks.run('doc.lineCheck', tx, doc, line);
    return line;
  }

  function checkLocation(tx, whCode, binCode, n, field, perm) {
    const where = { line: n, field };
    if (!whCode) return tx.error('REQUIRED', `บรรทัด ${n}: ระบุคลัง`, where);
    if (whCode === TRANSIT) return tx.error('RESERVED', `บรรทัด ${n}: ${TRANSIT} ใช้ภายในระบบ ทำรายการตรงไม่ได้`, where);
    const wh = tx.get('warehouses', whCode);
    if (!wh) return tx.error('NOT_FOUND', `บรรทัด ${n}: ไม่พบคลัง ${whCode}`, where);
    if (wh.active === false) return tx.error('INACTIVE', `บรรทัด ${n}: คลัง ${whCode} ปิดใช้งาน`, where);
    if (!tx.can(perm, whCode)) return tx.need(perm, whCode, where);
    if (binCode) {
      const b = tx.get('bins', whCode + '|' + binCode);
      if (!b) return tx.error('NOT_FOUND', `บรรทัด ${n}: ไม่พบช่องเก็บ ${binCode} ในคลัง ${whCode}`, where);
      if (b.active === false) return tx.error('INACTIVE', `บรรทัด ${n}: ช่องเก็บ ${binCode} ปิดใช้งาน`, where);
    } else if (wh.requireBin) {
      return tx.error('BIN_REQUIRED', `บรรทัด ${n}: คลัง ${whCode} ต้องระบุช่องเก็บ`, where);
    }
    return true;
  }

  /** Reserved for other jobs in this warehouse (Phase 2 registers the function). */
  function reservedOthers(tx, code, wh, doc, line) {
    let s = 0;
    for (const fn of reservedFns) s += fn(tx, code, wh, doc, line) || 0;
    return util.round(s);
  }

  /**
   * Check stock for every outgoing line, per exact location and per warehouse (stock kept for other jobs is
   * not free). Returns the shortages [{line, need, have}] (also as errors unless allowNegative).
   */
  function checkAvailability(tx, doc, lines, allowNegative) {
    const short = [];
    const td = typeDef(doc.type);
    const byLoc = {};
    const byWh = {};
    for (const ln of lines) {
      if (!isOut(td, ln)) continue;
      const loc = { code: ln.code, wh: ln.wh, bin: ln.bin, status: ln.status, lot: ln.lot };
      const k = RRS.balanceKey(loc);
      (byLoc[k] || (byLoc[k] = { loc, need: 0, lines: [] })).need += Math.abs(ln.base);
      byLoc[k].lines.push(ln);
      if (ln.status === STATUS.AVAILABLE) {
        const wk = ln.code + '|' + ln.wh + '|' + (ln.jobNo || doc.job || '') + '|' + (ln.reservationId || '');
        (byWh[wk] || (byWh[wk] = { code: ln.code, wh: ln.wh, need: 0, lines: [] })).need += Math.abs(ln.base);
        byWh[wk].lines.push(ln);
      }
    }
    for (const k in byLoc) {
      const g = byLoc[k];
      const have = tx.balanceAt(g.loc).qty;
      if (util.round(g.need) > have) {
        short.push({ lines: g.lines.map((l) => l.line), code: g.loc.code, need: util.round(g.need), have, where: locText(g.loc) });
        if (!allowNegative) {
          tx.error('NOT_ENOUGH', `บรรทัด ${g.lines.map((l) => l.line).join(', ')}: ${g.loc.code} ที่ ${locText(g.loc)}${g.loc.lot ? ' ล็อต ' + g.loc.lot : ''}${g.loc.status !== STATUS.AVAILABLE ? ' (' + STATUS_LABEL[g.loc.status] + ')' : ''} มี ${have} ${g.lines[0].baseUnit} ต้องการ ${util.round(g.need)}`, { line: g.lines[0].line });
        }
      }
    }
    for (const k in byWh) {
      const g = byWh[k];
      const avail = tx.qty({ code: g.code, wh: g.wh, status: STATUS.AVAILABLE });
      const kept = reservedOthers(tx, g.code, g.wh, doc, g.lines[0]);
      const free = util.round(avail - kept);
      if (kept > 0 && util.round(g.need) > free) {
        short.push({ lines: g.lines.map((l) => l.line), code: g.code, need: util.round(g.need), have: free, where: g.wh, reserved: kept });
        if (!allowNegative) {
          tx.error('RESERVED', `บรรทัด ${g.lines.map((l) => l.line).join(', ')}: ${g.code} คลัง ${g.wh} ใช้ได้ ${avail} แต่จองให้งานอื่น ${kept} – เหลือให้เบิก ${Math.max(0, free)}`, { line: g.lines[0].line });
        }
      }
    }
    return short;
  }

  function newDocRow(tx, p, type) {
    return {
      docNo: '', type, date: util.trim(p.date).slice(0, 10) || tx.date, status: 'DRAFT', job: util.trim(p.job),
      department: util.trim(p.department), ref: util.trim(p.ref), remark: util.trim(p.remark), lines: [],
      createdBy: tx.userId, createdAt: tx.now, postedBy: '', postedAt: '', cancelledBy: '', cancelledAt: '', cancelReason: '',
      override: null, expressStatus: '', expressNo: '', source: util.trim(p.source),
      supplier: util.trim(p.supplier), supplierDoc: util.trim(p.supplierDoc),
    };
  }
  inv.newDocRow = newDocRow;
  inv.draftLines = draftLines;
  function draftLines(p) {
    return (p.lines || []).map((l) => ({
      code: util.trim(l.code), qty: l.qty, unit: util.trim(l.unit), wh: util.normCode(l.wh), bin: util.normCode(l.bin),
      toWh: util.normCode(l.toWh), toBin: util.normCode(l.toBin), lot: util.trim(l.lot), status: l.status || '',
      unitCost: l.unitCost == null ? '' : l.unitCost, remark: util.trim(l.remark), reservationId: l.reservationId || '',
      poNo: l.poNo || '', poLine: l.poLine || '', jobNo: l.jobNo || '', replace: l.replace === true || l.replace === 'true',
    }));
  }

  /**
   * Check and post a document inside the current command. `d` is a document row (draft or new). Returns the
   * posted row, or null with errors on tx. opts.allowNegative: an approved exception.
   */
  inv.post = function post(tx, d, opts) {
    opts = opts || {};
    const td = typeDef(d.type);
    if (!td) return tx.error('BAD_TYPE', `ไม่รู้จักประเภทเอกสาร ${d.type}`) && null;
    if (['DRAFT', 'WAIT_APPROVAL'].indexOf(d.status) < 0) return tx.error('BAD_STATE', `${d.docNo} ${DOC_STATUS[d.status]} – บันทึกซ้ำไม่ได้`) && null;
    if (!d.lines || !d.lines.length) return tx.error('NO_LINES', 'เอกสารยังไม่มีบรรทัด') && null;
    if (td.needsJob && !d.job) return tx.error('REQUIRED', `${d.type} ต้องระบุงาน/SO`, { field: 'job' }) && null;
    const errorsBefore = tx.errors.length;
    const lines = d.lines.map((raw, i) => resolveLine(tx, d, raw, i, opts));
    if (tx.errors.length > errorsBefore) return null;
    RRS.hooks.run('doc.check', tx, d, lines);
    if (tx.errors.length > errorsBefore) return null;
    const short = checkAvailability(tx, d, lines, opts.allowNegative);
    if (tx.errors.length > errorsBefore) return null;
    const docNo = d.docNo || tx.nextNo(d.type, d.date);
    const mv = (ln) => ({ docType: d.type, docNo, line: ln.line, job: d.job || ln.jobNo, remark: ln.remark, date: d.date });
    for (const ln of lines) {
      const loc = { code: ln.code, wh: ln.wh, bin: ln.bin, status: ln.status, lot: ln.lot };
      if (td.dir === 'T') {
        tx.move(loc, -ln.base, mv(ln), opts);
        tx.move({ code: ln.code, wh: TRANSIT, bin: docNo, status: ln.status, lot: ln.lot }, ln.base, mv(ln));
        ln.received = 0;
      } else if (td.dir === -1) {
        tx.move(loc, -ln.base, mv(ln), opts);
      } else {
        tx.move(loc, ln.base, mv(ln), opts); // +1 receipt, 0 adjustment (base carries the sign)
      }
    }
    if (tx.errors.length > errorsBefore) return null;
    const stored = lines.map((ln) => {
      const s = Object.assign({}, ln);
      delete s.item;
      return s;
    });
    const row = Object.assign({}, d, {
      docNo, lines: stored, status: td.dir === 'T' ? 'IN_TRANSIT' : 'POSTED', postedBy: tx.userId, postedAt: tx.now,
      expressStatus: td.express ? 'WAIT' : 'N/A',
    });
    if (opts.allowNegative && short.length) {
      row.override = Object.assign({}, d.override || {}, { approvedBy: tx.userId, at: tx.now, shortages: short });
    }
    tx.put('documents', docNo, row);
    RRS.hooks.run('doc.posted', tx, row, lines);
    if (tx.errors.length > errorsBefore) return null;
    tx.result.docNo = docNo;
    return row;
  };

  // ---- commands ------------------------------------------------------------------------------------------
  define('doc.saveDraft', {
    label: 'บันทึกร่างเอกสาร', perm: 'doc.draft',
    prepare(tx, p) {
      const type = String(p.type || '').toUpperCase();
      if (!typeDef(type)) return tx.error('BAD_TYPE', `ไม่รู้จักประเภทเอกสาร ${p.type}`);
      if (!manualType(type)) return tx.error('BAD_TYPE', `${type} สร้างโดยระบบเท่านั้น ทำเป็นเอกสารเองไม่ได้`);
      let row;
      if (p.docNo) {
        row = tx.get('documents', p.docNo);
        if (!row) return tx.error('NOT_FOUND', `ไม่พบเอกสาร ${p.docNo}`);
        if (row.status !== 'DRAFT') return tx.error('BAD_STATE', `${p.docNo} ไม่ใช่ร่าง – แก้ไม่ได้`);
        if (row.type !== type) return tx.error('BAD_TYPE', 'เปลี่ยนประเภทของร่างไม่ได้');
        row = Object.assign({}, row, { date: util.trim(p.date).slice(0, 10) || row.date, job: util.trim(p.job), department: util.trim(p.department),
          ref: util.trim(p.ref), remark: util.trim(p.remark) });
      } else {
        row = newDocRow(tx, p, type);
        row.docNo = tx.nextNo(type, row.date);
      }
      row.lines = draftLines(p);
      const td0 = typeDef(type);
      for (let i = 0; i < row.lines.length; i++) {
        const ln = row.lines[i];
        for (const wh of [ln.wh, ln.toWh]) {
          if (wh && !tx.can('doc.draft', wh) && !tx.can(td0.perm || 'doc.post', wh)) return tx.need('doc.draft', wh, { line: i + 1 });
        }
      }
      tx.put('documents', row.docNo, row);
      tx.result.docNo = row.docNo;
      tx.summary = `ร่าง ${row.docNo}`;
    },
  });
  define('doc.deleteDraft', {
    label: 'ลบร่างเอกสาร', perm: 'doc.draft',
    prepare(tx, p) {
      const row = tx.get('documents', p.docNo);
      if (!row) return tx.error('NOT_FOUND', `ไม่พบเอกสาร ${p.docNo}`);
      if (row.status !== 'DRAFT') return tx.error('BAD_STATE', 'ลบได้เฉพาะร่าง – เอกสารที่บันทึกแล้วใช้ ยกเลิก');
      tx.del('documents', row.docNo);
      tx.summary = `ลบร่าง ${row.docNo}`;
    },
  });
  /** Post a saved draft ({docNo}) or a new document in one step ({type, lines, …}). */
  define('doc.post', {
    label: 'บันทึกเอกสาร (เปลี่ยนยอด)',
    perm(tx, p) {
      const type = p.docNo ? (tx.get('documents', p.docNo) || {}).type : String(p.type || '').toUpperCase();
      const td = typeDef(type);
      return (td && td.perm) || 'doc.post';
    },
    prepare(tx, p) {
      let d;
      if (p.docNo) {
        d = tx.get('documents', p.docNo);
        if (!d) return tx.error('NOT_FOUND', `ไม่พบเอกสาร ${p.docNo}`);
        if (d.status === 'WAIT_APPROVAL') return tx.error('BAD_STATE', `${d.docNo} รออนุมัติข้อยกเว้น – ให้ผู้มีสิทธิ์อนุมัติ`);
      } else {
        const type = String(p.type || '').toUpperCase();
        if (!typeDef(type)) return tx.error('BAD_TYPE', `ไม่รู้จักประเภทเอกสาร ${p.type}`);
        if (!manualType(type)) return tx.error('BAD_TYPE', `${type} สร้างโดยระบบเท่านั้น ทำเป็นเอกสารเองไม่ได้`);
        d = newDocRow(tx, p, type);
        d.lines = draftLines(p);
      }
      const row = inv.post(tx, d);
      if (row) tx.summary = `บันทึก ${row.docNo} ${DOC_TYPES[row.type].name} ${row.lines.length} บรรทัด`;
    },
  });
  define('doc.requestOverride', {
    label: 'ขออนุมัติยอดติดลบ', perm: 'doc.post',
    prepare(tx, p) {
      if (tx.settings().policies.negativeStock !== 'approve') {
        return tx.error('POLICY', 'นโยบายตอนนี้ห้ามยอดติดลบทุกกรณี (ค-7) – แก้ที่ค่าตั้งระบบโดยผู้มีสิทธิ์');
      }
      const d = tx.get('documents', p.docNo);
      if (!d) return tx.error('NOT_FOUND', `ไม่พบเอกสาร ${p.docNo}`);
      if (d.status !== 'DRAFT') return tx.error('BAD_STATE', 'ขออนุมัติได้เฉพาะร่าง');
      const reason = util.trim(p.reason);
      if (reason.length < 5) return tx.error('REQUIRED', 'ระบุเหตุผลให้ชัดเจน', { field: 'reason' });
      tx.put('documents', d.docNo, Object.assign({}, d, { status: 'WAIT_APPROVAL', override: { requestedBy: tx.userId, reason, requestedAt: tx.now } }));
      tx.summary = `ขออนุมัติข้อยกเว้น ${d.docNo}`;
    },
  });
  define('doc.approveOverride', {
    label: 'อนุมัติข้อยกเว้นและบันทึก', perm: 'stock.overrideApprove',
    prepare(tx, p) {
      const d = tx.get('documents', p.docNo);
      if (!d) return tx.error('NOT_FOUND', `ไม่พบเอกสาร ${p.docNo}`);
      if (d.status !== 'WAIT_APPROVAL') return tx.error('BAD_STATE', 'เอกสารนี้ไม่ได้รออนุมัติ');
      if (!tx.different(d.override && d.override.requestedBy, 'ผู้อนุมัติ')) return;
      if (!tx.different(d.createdBy, 'ผู้อนุมัติ')) return;
      const row = inv.post(tx, d, { allowNegative: true });
      if (row) tx.summary = `อนุมัติข้อยกเว้นและบันทึก ${row.docNo}`;
    },
  });
  define('doc.rejectOverride', {
    label: 'ไม่อนุมัติข้อยกเว้น', perm: 'stock.overrideApprove',
    prepare(tx, p) {
      const d = tx.get('documents', p.docNo);
      if (!d || d.status !== 'WAIT_APPROVAL') return tx.error('BAD_STATE', 'เอกสารนี้ไม่ได้รออนุมัติ');
      tx.put('documents', d.docNo, Object.assign({}, d, { status: 'DRAFT', override: Object.assign({}, d.override, { rejectedBy: tx.userId, rejectedAt: tx.now, rejectReason: util.trim(p.reason) }) }));
      tx.summary = `ไม่อนุมัติข้อยกเว้น ${d.docNo}`;
    },
  });

  define('doc.cancel', {
    label: 'ยกเลิกเอกสาร', perm: 'doc.cancel',
    prepare(tx, p) {
      const d = tx.get('documents', p.docNo);
      if (!d) return tx.error('NOT_FOUND', `ไม่พบเอกสาร ${p.docNo}`);
      if (d.status === 'CANCELLED') return tx.error('ALREADY_CANCELLED', `${d.docNo} ยกเลิกไปแล้ว – ไม่กลับยอดซ้ำ`);
      if (d.status === 'DRAFT' || d.status === 'WAIT_APPROVAL') return tx.error('BAD_STATE', 'ร่างให้ลบ ไม่ต้องยกเลิก');
      if (d.status === 'RECEIVED' || (d.type === 'TR' && d.lines.some((l) => l.received > 0))) {
        return tx.error('BAD_STATE', 'ใบโอนที่รับปลายทางแล้วยกเลิกไม่ได้ – ทำใบโอนกลับแทน');
      }
      const reason = util.trim(p.reason);
      if (!reason) return tx.error('REQUIRED', 'ระบุเหตุผลการยกเลิก', { field: 'reason' });
      const moves = tx.all('movements', (m) => m.docNo === d.docNo && m.docType === d.type && !m.reversalOf);
      const reversed = new Set(tx.all('movements', (m) => m.reversalOf).map((m) => m.reversalOf));
      for (const m of moves.sort((a, b) => (a.seq - b.seq) || (b.qty - a.qty))) {
        if (reversed.has(m.id)) continue;
        tx.move({ code: m.code, wh: m.wh, bin: m.bin, status: m.status, lot: m.lot }, -m.qty,
          { docType: d.type, docNo: d.docNo, line: m.line, job: m.job, reversalOf: m.id, remark: 'ยกเลิก: ' + reason, date: tx.date });
      }
      if (!tx.ok) {
        tx.errors.unshift(RRS.core.err('CANNOT_REVERSE', `ยกเลิก ${d.docNo} ไม่ได้: ของที่รับไปถูกใช้/ย้ายแล้ว ยอดไม่พอให้กลับรายการ`));
        return;
      }
      const row = Object.assign({}, d, { status: 'CANCELLED', cancelledBy: tx.userId, cancelledAt: tx.now, cancelReason: reason });
      tx.put('documents', d.docNo, row);
      RRS.hooks.run('doc.cancelled', tx, row, d.lines);
      tx.summary = `ยกเลิก ${d.docNo}`;
    },
  });

  define('transfer.receive', {
    label: 'รับโอนปลายทาง', perm: 'transfer.receive',
    prepare(tx, p) {
      const d = tx.get('documents', p.docNo);
      if (!d || d.type !== 'TR') return tx.error('NOT_FOUND', `ไม่พบใบโอน ${p.docNo}`);
      if (d.status !== 'IN_TRANSIT') return tx.error('BAD_STATE', `${d.docNo} ${DOC_STATUS[d.status]}`);
      const want = {};
      for (const r of p.lines || []) want[r.line] = r;
      const lines = d.lines.map((l) => Object.assign({}, l));
      let any = false;
      for (const l of lines) {
        const left = util.round(l.base - (l.received || 0));
        const r = p.lines ? want[l.line] : { qty: left };
        if (!r || left <= 0) continue;
        const qty = r.qty == null || r.qty === '' ? left : util.num(r.qty);
        if (isNaN(qty) || qty <= 0) { tx.error('BAD_QTY', `บรรทัด ${l.line}: จำนวนรับไม่ถูกต้อง`, { line: l.line }); continue; }
        if (qty > left) { tx.error('TOO_MUCH', `บรรทัด ${l.line}: รับได้ไม่เกิน ${left} ${l.baseUnit}`, { line: l.line }); continue; }
        const toBin = r.toBin != null ? util.normCode(r.toBin) : l.toBin;
        if (!checkLocation(tx, l.toWh, toBin, l.line, 'toBin', 'transfer.receive')) continue;
        // modules may refuse the receipt (count freeze) or change the status it lands in (a lot quarantined in transit)
        const info = { qty, toWh: l.toWh, toBin, status: l.status, remark: 'รับโอน' };
        const before = tx.errors.length;
        RRS.hooks.run('transfer.receiveLine', tx, d, l, info);
        if (tx.errors.length > before) continue;
        const mv = { docType: 'TR', docNo: d.docNo, line: l.line, job: d.job, remark: info.remark, date: tx.date };
        tx.move({ code: l.code, wh: TRANSIT, bin: d.docNo, status: l.status, lot: l.lot }, -qty, mv);
        tx.move({ code: l.code, wh: l.toWh, bin: toBin, status: info.status && STATUS[info.status] ? info.status : l.status, lot: l.lot }, qty, mv);
        l.received = util.round((l.received || 0) + qty);
        l.receivedBin = toBin;
        any = true;
      }
      if (!tx.ok) return;
      if (!any) return tx.error('NOTHING', 'ไม่มีบรรทัดที่ต้องรับ');
      const done = lines.every((l) => util.round(l.base - (l.received || 0)) <= 0);
      tx.put('documents', d.docNo, Object.assign({}, d, { lines, status: done ? 'RECEIVED' : 'IN_TRANSIT', receivedBy: tx.userId, receivedAt: tx.now }));
      tx.summary = `รับโอน ${d.docNo}${done ? ' ครบ' : ' บางส่วน'}`;
    },
  });

  define('doc.markExpress', {
    label: 'บันทึกเลขที่ Express', perm: 'doc.markExpress',
    prepare(tx, p) {
      const d = tx.get('documents', p.docNo);
      if (!d) return tx.error('NOT_FOUND', `ไม่พบเอกสาร ${p.docNo}`);
      if (d.expressStatus === 'N/A') return tx.error('BAD_STATE', `${d.type} ยังไม่มีประเภทเอกสารคู่กันใน Express (ค-11)`);
      if (d.status === 'DRAFT') return tx.error('BAD_STATE', 'บันทึกเอกสารก่อนคีย์ Express');
      const no = util.trim(p.expressNo);
      tx.put('documents', d.docNo, Object.assign({}, d, { expressNo: no, expressStatus: no ? 'KEYED' : 'WAIT', expressBy: tx.userId, expressAt: tx.now }));
      tx.summary = `${d.docNo} ${no ? 'คีย์ Express แล้ว ' + no : 'กลับเป็นรอคีย์'}`;
    },
  });

  // ---- read helpers for screens --------------------------------------------------------------------------
  /** Balances of an item (or every item) grouped per location. */
  inv.locations = function locations(state, filter) {
    return RRS.q.rows(state, 'balances', (b) => (!filter || ((!filter.code || b.code === filter.code)
      && (!filter.wh || b.wh === filter.wh) && (!filter.status || b.status === filter.status)))).sort((a, b) =>
      (a.code + a.wh + a.bin + a.status + a.lot).localeCompare(b.code + b.wh + b.bin + b.status + b.lot));
  };
  /** Per item: quantity by status over all warehouses (or one). */
  inv.summary = function summary(state, wh) {
    const out = {};
    for (const b of RRS.q.rows(state, 'balances')) {
      if (wh && b.wh !== wh) continue;
      const r = out[b.code] || (out[b.code] = { code: b.code, AVAILABLE: 0, QC_HOLD: 0, QUARANTINE: 0, REWORK: 0, transit: 0, total: 0 });
      if (b.wh === TRANSIT) r.transit = util.round(r.transit + b.qty);
      else r[b.status] = util.round(r[b.status] + b.qty);
      r.total = util.round(r.total + b.qty);
    }
    return out;
  };
  /** Movements of a document, an item, or a location – newest first. */
  inv.history = function history(state, f) {
    return RRS.q.rows(state, 'movements', (m) => (!f.docNo || m.docNo === f.docNo) && (!f.code || m.code === f.code)
      && (!f.wh || m.wh === f.wh) && (!f.lot || m.lot === f.lot) && (!f.job || m.job === f.job))
      .sort((a, b) => b.seq - a.seq || Number(b.id.split('.')[1]) - Number(a.id.split('.')[1]));
  };
  /** Stock is the sum of its history: for every location, balance = Σ movements (integrity check). */
  inv.verifyBalances = function verifyBalances(state) {
    const sums = {};
    for (const m of RRS.q.rows(state, 'movements')) {
      const k = RRS.balanceKey(m);
      sums[k] = util.round((sums[k] || 0) + m.qty);
    }
    const bad = [];
    const bal = state.tables.balances || {};
    const keys = new Set(Object.keys(sums).concat(Object.keys(bal)));
    for (const k of keys) {
      const a = util.round(sums[k] || 0);
      const b = bal[k] ? bal[k].qty : 0;
      if (a !== b) bad.push({ key: k, history: a, balance: b });
    }
    return bad;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
