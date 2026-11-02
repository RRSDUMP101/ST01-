/*
 * Phase 3 – reconcile with Express and controlled stock counts (plan file 01, P0/P1).
 *
 * Express files (the accounting program's stock report) are snapshots, never the live balance:
 *  - express.import stores the file as a batch and changes NO stock. The screen parses the file and sends the rows plus
 *    the SHA-256 of the file; a file seen before is refused (DUPLICATE_FILE). Exception: a batch that was DISCARDED may
 *    be imported again (express.discard is refused while the batch still has a live adjustment, so a discarded batch
 *    never changed stock) – this is how a file is re-read after fixing codes or warehouse mapping.
 *  - codes resolve only by item code / Express code / count code (tx.item), never by name; a row that does not resolve
 *    is kept with code '' and reported. Express warehouse -> RRS warehouse by warehouses.expressCode, else the same code,
 *    else settings.express.defaultWarehouse (each row records how: whBy).
 *  - the difference is taken AT THE SNAPSHOT: RRS qty at snapshot = qty now − movements recorded after the snapshot
 *    (stock in transit between two warehouses is in neither; a move between bins of one warehouse stays in it).
 *    An adjustment (only when settings.ownership.qty === 'Express') posts that difference, so everything recorded after
 *    the file was made is kept. A file older than the newest closed batch needs confirmOld:true; a row whose stock was
 *    re-based after the snapshot – by another count/Express AJ, or by an approved count made after it (also one
 *    without a difference) – cannot be adjusted from this file at all.
 *  - pendingDocs of a row: documents that were in RRS at the snapshot (by posting time) and are not keyed in Express.
 *
 * Counts are sessions per warehouse (+ bins; none = whole warehouse) in the place the stock really is:
 *  - count.enter stores the system qty at that location at entry time; a big difference needs a second count by a
 *    different person; two counts agree when they find the same difference from the system at their own time (stock
 *    may move between them); disagreeing counts stay DUPLICATE until a further count agrees with one of them
 *  - count.approve (a person who neither counted nor submitted the session) needs a reason for every difference and
 *    posts ONE AJ in the session's warehouse; movements after a line was counted are kept (timestamp rule) and must be
 *    acknowledged (ack), as must a line counted above the record where QC_HOLD/QUARANTINE/REWORK stock lies
 *  - mode 'freeze': while the session is OPEN or SUBMITTED no document line may touch its warehouse/bins and no
 *    transfer may be received into them (COUNT_FREEZE)
 *
 * Read helpers for screens: RRS.reconcile.{rrsQtyAt, reconcile, pendingExpress, countView, frozenBy}.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { util, schema, commands, STATUS, TRANSIT } = RRS;
  const define = commands.define;
  const inv = RRS.inventory;

  schema.define('express_batches', {
    label: 'รอบนำเข้ายอด Express', phase: 3, key: 'id',
    note: 'การนำเข้าไม่เปลี่ยนยอด ใช้กระทบยอด ณ เวลาของไฟล์; ไม่มีการลบ – รอบที่ใช้ไม่ได้เปลี่ยนสถานะเป็น DISCARDED',
    fields: [['id', 'text', 'รหัสรอบนำเข้า (EX-00001)'], ['source', 'text', 'แหล่งข้อมูล'], ['fileName', 'text', 'ชื่อไฟล์'],
      ['fileHash', 'text', 'ลายนิ้วมือไฟล์ SHA-256 (กันนำเข้าซ้ำ)'], ['snapshotAt', 'datetime', 'เวลาของข้อมูลในไฟล์'],
      ['importedBy', 'text', 'ผู้นำเข้า'], ['importedAt', 'datetime', 'นำเข้าเมื่อ'],
      ['status', 'enum', 'สถานะ', 'REVIEW/CLOSED/DISCARDED'],
      ['rows', 'json', 'แถวในไฟล์ {row, fileRow, rawCode, rawWh, code (ว่าง = ไม่รู้จักรหัส), wh, whBy expressCode/code/default, qty, unit, base (หน่วยหลัก)}'],
      ['unknownRows', 'number', 'จำนวนแถวที่ไม่รู้จักรหัส'],
      ['olderThanLatest', 'bool', 'เก่ากว่ารอบที่ปิดล่าสุด (ตอนนำเข้า)'],
      ['resolutions', 'json', 'การตัดสินผลต่างรายบรรทัด {key, code, wh, row, action adjust/explain, reason, bin, lot, express, rrsAtSnapshot, qty, pendingDocs (เอกสารที่ยังไม่คีย์ ณ เวลาไฟล์), confirmOld (ยืนยันใช้ไฟล์เก่า), docNo, by, at, cancelledBy, cancelledAt}'],
      ['closedBy', 'text', 'ผู้ปิดรอบ'], ['closedAt', 'datetime', 'ปิดรอบเมื่อ'], ['closeTotals', 'json', 'สรุปผลต่างตอนปิดรอบ'],
      ['discardedBy', 'text', 'ผู้ยกเลิกรอบ'], ['discardedAt', 'datetime', 'ยกเลิกรอบเมื่อ'], ['discardReason', 'text', 'เหตุผลยกเลิกรอบ']],
  });
  schema.define('count_sessions', {
    label: 'รอบตรวจนับสต็อก', phase: 3, key: 'id',
    note: 'นับยอดสถานะใช้ได้ (AVAILABLE) ตามคลัง/ช่องเก็บจริง; ผลต่างปรับด้วยใบ AJ ใบเดียวตอนอนุมัติ; ไม่มีการลบ',
    fields: [['id', 'text', 'รหัสรอบนับ (CT-00001)'], ['wh', 'text', 'คลัง'], ['bins', 'list', 'ช่องเก็บที่นับ (ว่าง = ทั้งคลัง)'],
      ['mode', 'enum', 'วิธีคุมการเคลื่อนไหว', 'timestamp = คิดผลต่าง ณ เวลานับ / freeze = หยุดเคลื่อนไหวพื้นที่ที่นับ'],
      ['status', 'enum', 'สถานะ', 'OPEN/SUBMITTED/APPROVED/CANCELLED'], ['note', 'text', 'หมายเหตุ'],
      ['lines', 'json', 'บรรทัดนับ {key code|bin|lot, code, bin, lot, status, system, counted, countedBy, countedAt, countedSeq (การนับครั้งแรก), recounts[{counted, system, by, at, seq}], final (ผลที่ยอมรับ), diff, adjust, movedQty, heldQty (ของรอตรวจ/กักกันที่ตำแหน่งเดียวกัน), reason, reasonBy, reasonAt, responsible, flags[]}'],
      ['createdBy', 'text', 'ผู้เปิดรอบนับ'], ['createdAt', 'datetime', 'เปิดรอบเมื่อ'],
      ['submittedBy', 'text', 'ผู้ส่งผลนับ'], ['submittedAt', 'datetime', 'ส่งผลนับเมื่อ'],
      ['approvedBy', 'text', 'ผู้อนุมัติผลนับ'], ['approvedAt', 'datetime', 'อนุมัติเมื่อ'], ['approvedSeq', 'number', 'ลำดับ commit ที่อนุมัติ'],
      ['ack', 'json', 'รับทราบก่อนอนุมัติ {by, at, lines[] (เคลื่อนไหวหลังนับ), held[] (นับเกินที่ตำแหน่งมีของรอตรวจ/กักกัน)}'], ['docNo', 'text', 'ใบปรับยอด AJ'],
      ['cancelledBy', 'text', 'ผู้ยกเลิก'], ['cancelledAt', 'datetime', 'ยกเลิกเมื่อ'], ['cancelReason', 'text', 'เหตุผลยกเลิก'],
      ['docCancelled', 'json', 'ใบ AJ ของรอบนี้ถูกยกเลิก {docNo, by, at, reason}']],
  });

  const BATCH_STATUS = { REVIEW: 'รอตรวจผลต่าง', CLOSED: 'ปิดรอบแล้ว', DISCARDED: 'ยกเลิกรอบ' };
  const ROW_STATUS = { MATCH: 'ตรงกัน', DIFF: 'ยอดต่าง', ONLY_EXPRESS: 'มีเฉพาะใน Express', ONLY_RRS: 'มีเฉพาะใน RRS',
    UNKNOWN_CODE: 'ไม่รู้จักรหัส' };
  const COUNT_STATUS = { OPEN: 'กำลังนับ', SUBMITTED: 'ส่งผลนับแล้ว รออนุมัติ', APPROVED: 'อนุมัติแล้ว', CANCELLED: 'ยกเลิก' };
  const COUNT_MODE = { timestamp: 'คิดผลต่าง ณ เวลานับ (เคลื่อนไหวต่อได้)', freeze: 'หยุดเคลื่อนไหวพื้นที่ที่นับชั่วคราว' };
  const FLAG = { RECOUNT: 'ต่างเกินเกณฑ์ – ต้องให้อีกคนนับซ้ำ', DUPLICATE: 'ผลนับต่างกันระหว่างผู้นับ – ต้องนับซ้ำ',
    RECOUNTED: 'ยืนยันด้วยการนับซ้ำ', MOVED_DURING_COUNT: 'มีรายการเคลื่อนไหวหลังนับ',
    HELD_STOCK: 'นับได้มากกว่าระบบ ขณะที่ตำแหน่งนี้มีของรอตรวจ/กักกัน/รอแก้ไข – ตรวจว่าไม่ได้นับรวม' };
  const POSTED = ['POSTED', 'IN_TRANSIT', 'RECEIVED'];
  const LIVE_COUNT = ['OPEN', 'SUBMITTED'];
  const MAX_ROW_BYTES = 180000; // one row must stay well inside one commit (< 200 KB JSON)
  const ISO_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

  const rec = {
    BATCH_STATUS, ROW_STATUS, COUNT_STATUS, COUNT_MODE, FLAG,
  };
  RRS.reconcile = rec;

  // ---- small helpers -------------------------------------------------------------------------------------
  const ms = (iso) => {
    const t = Date.parse(iso);
    return isFinite(t) ? t : NaN;
  };
  const bytes = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
  const lineKey = (code, bin, lot) => `${code}|${bin || ''}|${lot || ''}`;
  const locText = (wh, bin) => `${wh}${bin ? '/' + bin : ''}`;
  /** Rows of a table: the same code reads a state (screens) or a tx overlay (commands). */
  const stateReader = (state) => (t) => RRS.q.rows(state, t);
  const txReader = (tx) => (t) => tx.all(t);

  /** The tx handed to inventory.post: the approval permission (count.approve / express.reconcile in that warehouse)
   *  is the authority to post the approved AJ, so the one 'doc.postAdjust' check answers with it. Warehouse limits
   *  still apply; every other read/write goes to the real tx (same commit, same errors). */
  function delegate(tx, perm) {
    return new Proxy(tx, {
      get(t, prop) {
        if (prop === 'can') return (p, wh) => t.can(p, wh) || (p === 'doc.postAdjust' && t.can(perm, wh));
        const v = Reflect.get(t, prop, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
      set(t, prop, v) {
        t[prop] = v;
        return true;
      },
    });
  }

  /** A new AJ document row (the same shape inventory.js gives a new document). */
  function ajDoc(tx, f, lines) {
    return {
      docNo: '', type: 'AJ', date: tx.date, status: 'DRAFT', job: '', department: '', ref: f.ref, remark: f.remark,
      lines: lines.map((l) => ({ code: l.code, qty: l.qty, unit: '', wh: l.wh, bin: l.bin || '', toWh: '', toBin: '',
        lot: l.lot || '', status: STATUS.AVAILABLE, unitCost: '', remark: l.remark || '', reservationId: '', poNo: '',
        poLine: '', jobNo: '' })),
      createdBy: tx.userId, createdAt: tx.now, postedBy: '', postedAt: '', cancelledBy: '', cancelledAt: '', cancelReason: '',
      override: null, expressStatus: '', expressNo: '', source: f.source,
    };
  }

  /** Posts an AJ for an approval; maps inventory's line numbers back to the caller's lines. */
  function postAj(tx, perm, doc, lineNos) {
    const before = tx.errors.length;
    const row = inv.post(delegate(tx, perm), doc);
    for (let i = before; i < tx.errors.length; i++) {
      const e = tx.errors[i];
      if (e.line != null && lineNos[e.line - 1] != null) e.line = lineNos[e.line - 1];
    }
    return row;
  }

  function needWh(tx, perm, wh, where) {
    return tx.can(perm, wh) || tx.need(perm, wh, where);
  }

  // ---- RRS quantity at a moment ----------------------------------------------------------------------------
  /**
   * Warehouse of stock "in transit" (TRANSIT, bin = transfer docNo) for a code: a transfer between bins of ONE warehouse
   * never leaves that warehouse (Express has no bins), so its in-transit stock still counts there. A transfer between
   * two warehouses is in neither until received ('' = leave it out).
   */
  function transitHome(read) {
    const home = {};
    for (const d of read('documents')) {
      if (d.type !== 'TR') continue;
      const per = {};
      for (const l of d.lines || []) {
        const wh = l.wh && l.wh === l.toWh ? l.wh : '';
        per[l.code] = l.code in per && per[l.code] !== wh ? '' : wh;
      }
      for (const c in per) if (per[c]) home[d.docNo + '|' + c] = per[c];
    }
    return (r) => home[r.bin + '|' + r.code] || '';
  }

  /** Per code|wh (all quality statuses; in transit only inside one warehouse): qty now and the net of movements after `atMs`. */
  function qtyIndex(read, atMs) {
    const now = {};
    const after = {};
    const homeOf = transitHome(read);
    const whOf = (r) => (r.wh === TRANSIT ? homeOf(r) : r.wh);
    for (const b of read('balances')) {
      const wh = whOf(b);
      if (!wh) continue;
      const k = b.code + '|' + wh;
      now[k] = (now[k] || 0) + b.qty;
    }
    for (const m of read('movements')) {
      if (!(ms(m.at) > atMs)) continue;
      const wh = whOf(m);
      if (!wh) continue;
      const k = m.code + '|' + wh;
      after[k] = (after[k] || 0) + m.qty;
    }
    return {
      now: (k) => util.round(now[k] || 0),
      at: (k) => util.round((now[k] || 0) - (after[k] || 0)),
      keys: () => Array.from(new Set(Object.keys(now).concat(Object.keys(after)))),
    };
  }

  /**
   * RRS quantity of `code` in warehouse `wh` at `atIso`: today's balance over all statuses (stock in transit between two
   * warehouses is in neither; a move between bins of one warehouse stays in it) minus every movement recorded after
   * `atIso`. null when `atIso` is not a time (never today's quantity in disguise).
   */
  rec.rrsQtyAt = function rrsQtyAt(state, code, wh, atIso) {
    const at = ms(atIso);
    if (isNaN(at)) return null;
    const it = RRS.q.item(state, code);
    const id = it ? it.id : util.normCode(code);
    return qtyIndex(stateReader(state), at).at(id + '|' + util.normCode(wh));
  };

  // ---- Express reconciliation rows -------------------------------------------------------------------------
  /** Current decision for each row key: the last one, unless its adjustment was cancelled since. */
  function currentResolutions(batch) {
    const out = {};
    for (const r of batch.resolutions || []) out[r.key] = r;
    for (const k in out) if (out[k].cancelledAt) delete out[k];
    return out;
  }

  /** Is the batch older than the newest CLOSED batch (now, not only when it was imported)? */
  function olderLive(read, batch) {
    if (batch.olderThanLatest) return true;
    const t = ms(batch.snapshotAt);
    return read('express_batches').some((b) => b.id !== batch.id && b.status === 'CLOSED' && ms(b.snapshotAt) > t);
  }

  function buildReconcile(read, batch) {
    const snapMs = ms(batch.snapshotAt);
    const idx = qtyIndex(read, snapMs);
    const items = {};
    for (const it of read('items')) items[it.id] = it;
    const resolved = currentResolutions(batch);
    const exp = {};
    const covered = {};
    const unknown = [];
    for (const r of batch.rows || []) {
      covered[r.wh] = true; // the file speaks for this warehouse, also through rows with unknown codes
      if (!r.code) {
        unknown.push(r);
        continue;
      }
      const k = r.code + '|' + r.wh;
      const e = exp[k] || (exp[k] = { code: r.code, wh: r.wh, express: 0, rows: [], rawCodes: [] });
      e.express = util.round(e.express + r.base);
      e.rows.push(r.row);
      if (e.rawCodes.indexOf(r.rawCode) < 0) e.rawCodes.push(r.rawCode);
    }
    // Documents that explain a difference: in RRS at the snapshot (posted at or before it, not cancelled before it – the
    // quantity at the snapshot is taken by posting time, not by document date) and not keyed in Express (WAIT).
    // Stock re-based after the snapshot: another count/Express AJ posted after it, or an approved count whose accepted
    // count of the code in this warehouse was made after it (also a count without a difference verified the stock).
    const pend = {};
    const stale = {};
    const add = (map, k, no) => {
      (map[k] || (map[k] = [])).indexOf(no) < 0 && map[k].push(no);
    };
    const inRrsAtSnap = (d) => ms(d.postedAt) <= snapMs
      && (POSTED.indexOf(d.status) >= 0 || (d.status === 'CANCELLED' && ms(d.cancelledAt) > snapMs));
    // `source` comes from the caller of doc.post: an AJ counts as a count/Express adjustment only when its session or
    // batch really points at it (session.docNo / a batch decision's docNo)
    const sessionOf = {};
    for (const s of read('count_sessions')) if (s.docNo) sessionOf[s.docNo] = s.id;
    const batchOf = {};
    for (const x of read('express_batches')) for (const r of x.resolutions || []) if (r.docNo) batchOf[r.docNo] = x.id;
    for (const d of read('documents')) {
      const lines = d.lines || [];
      if (d.expressStatus === 'WAIT' && inRrsAtSnap(d)) {
        for (const l of lines) for (const w of [l.wh, l.toWh]) if (w) add(pend, l.code + '|' + w, d.docNo);
      }
      if (POSTED.indexOf(d.status) < 0 || !(ms(d.postedAt) > snapMs)) continue;
      const src = String(d.source || '');
      const linked = (sessionOf[d.docNo] && src === 'count:' + sessionOf[d.docNo])
        || (batchOf[d.docNo] && batchOf[d.docNo] !== batch.id && src === 'express:' + batchOf[d.docNo]);
      if (linked) for (const l of lines) if (l.wh) add(stale, l.code + '|' + l.wh, d.docNo);
    }
    for (const s of read('count_sessions')) {
      if (s.status !== 'APPROVED' || s.docCancelled) continue;
      for (const l of s.lines || []) {
        if (ms((l.final && l.final.at) || l.countedAt) > snapMs) add(stale, l.code + '|' + s.wh, s.id);
      }
    }
    const keys = Object.keys(exp);
    for (const k of idx.keys()) {
      if (exp[k]) continue;
      const wh = k.slice(k.indexOf('|') + 1);
      if (covered[wh] && idx.at(k) !== 0) keys.push(k);
    }
    const rows = keys.map((k) => {
      const e = exp[k];
      const code = e ? e.code : k.slice(0, k.indexOf('|'));
      const wh = e ? e.wh : k.slice(k.indexOf('|') + 1);
      const it = items[code] || {};
      const express = e ? e.express : 0;
      const at = idx.at(k);
      const diff = util.round(express - at);
      let status;
      if (!e) status = 'ONLY_RRS';
      else if (diff === 0) status = 'MATCH';
      else if (at === 0) status = 'ONLY_EXPRESS';
      else status = 'DIFF';
      const res = resolved[k] || null;
      return {
        key: k, code, name: it.name || '', unit: it.baseUnit || '', wh, rows: e ? e.rows : [], rawCodes: e ? e.rawCodes : [],
        express, rrsAtSnapshot: at, rrsNow: idx.now(k), diff, status, pendingDocs: (pend[k] || []).sort(),
        staleBy: (stale[k] || []).sort(), resolution: res, resolved: !!res,
      };
    }).sort((a, b) => (a.code + '|' + a.wh).localeCompare(b.code + '|' + b.wh));
    for (const r of unknown) {
      const k = 'row:' + r.row;
      const res = resolved[k] || null;
      rows.push({ key: k, code: '', name: '', unit: r.unit, wh: r.wh, rows: [r.row], rawCodes: [r.rawCode], express: r.qty,
        rrsAtSnapshot: null, rrsNow: null, diff: null, status: 'UNKNOWN_CODE', pendingDocs: [], staleBy: [], resolution: res,
        resolved: !!res });
    }
    const totals = { rows: rows.length, MATCH: 0, DIFF: 0, ONLY_EXPRESS: 0, ONLY_RRS: 0, UNKNOWN_CODE: 0, resolved: 0,
      unresolved: 0, express: 0, rrsAtSnapshot: 0, rrsNow: 0, diffAbs: 0, pendingDocs: 0 };
    const pendAll = new Set();
    for (const r of rows) {
      totals[r.status] += 1;
      if (r.status !== 'MATCH') totals[r.resolved ? 'resolved' : 'unresolved'] += 1;
      if (r.status === 'UNKNOWN_CODE') continue;
      totals.express = util.round(totals.express + r.express);
      totals.rrsAtSnapshot = util.round(totals.rrsAtSnapshot + r.rrsAtSnapshot);
      totals.rrsNow = util.round(totals.rrsNow + r.rrsNow);
      totals.diffAbs = util.round(totals.diffAbs + Math.abs(r.diff));
      for (const no of r.pendingDocs) pendAll.add(no);
    }
    totals.pendingDocs = pendAll.size;
    return { rows, totals, olderThanLatest: olderLive(read, batch) };
  }

  /**
   * Express vs RRS for one batch, taken at the batch's snapshot time:
   * {batch, olderThanLatest, rows:[{key, code, wh, express, rrsAtSnapshot, rrsNow, diff, status, pendingDocs, staleBy,
   *  resolution, resolved, …}], totals}. diff = express − rrsAtSnapshot (what an adjustment would post).
   */
  rec.reconcile = function reconcile(state, batchId) {
    const b = RRS.q.get(state, 'express_batches', batchId);
    if (!b) return null;
    const r = buildReconcile(stateReader(state), b);
    const meta = Object.assign({}, b);
    delete meta.rows;
    return { batch: meta, olderThanLatest: r.olderThanLatest, rows: r.rows, totals: r.totals };
  };

  /**
   * Posted documents waiting to be keyed in Express (WAIT, รอคีย์) vs keyed (KEYED), plus cancelled documents that were
   * already keyed (they must be reversed in Express too). `today` (YYYY-MM-DD, optional) gives the age in days.
   */
  rec.pendingExpress = function pendingExpress(state, today) {
    const view = (d) => ({
      docNo: d.docNo, type: d.type, typeName: (inv.DOC_TYPES[d.type] || {}).name || d.type, date: d.date, status: d.status,
      postedAt: d.postedAt, postedBy: d.postedBy, lines: (d.lines || []).length,
      codes: Array.from(new Set((d.lines || []).map((l) => l.code))), expressStatus: d.expressStatus, expressNo: d.expressNo || '',
      expressBy: d.expressBy || '', expressAt: d.expressAt || '', ageDays: today ? util.daysBetween(d.date, today) : null,
    });
    const order = (a, b) => (a.date + a.docNo).localeCompare(b.date + b.docNo);
    const docs = RRS.q.rows(state, 'documents');
    const wait = docs.filter((d) => POSTED.indexOf(d.status) >= 0 && d.expressStatus === 'WAIT').map(view).sort(order);
    const keyed = docs.filter((d) => POSTED.indexOf(d.status) >= 0 && d.expressStatus === 'KEYED').map(view).sort(order);
    const cancelledKeyed = docs.filter((d) => d.status === 'CANCELLED' && d.expressStatus === 'KEYED').map(view).sort(order);
    return { wait, keyed, cancelledKeyed,
      totals: { wait: wait.length, keyed: keyed.length, cancelledKeyed: cancelledKeyed.length,
        oldestWait: wait.length ? wait[0].date : '' } };
  };

  // ---- Express commands --------------------------------------------------------------------------------------
  function mapWarehouse(tx, raw, where) {
    const whs = tx.all('warehouses', (w) => w.code !== TRANSIT);
    const find = (code) => {
      const k = util.ckey(code);
      if (!k) return null;
      const byExp = whs.filter((w) => w.expressCode && util.ckey(w.expressCode) === k);
      if (byExp.length > 1) {
        tx.error('AMBIGUOUS_WH', `แถว ${where.row}: รหัสคลัง Express ${code} ผูกกับหลายคลัง (${byExp.map((w) => w.code).join(', ')}) – แก้หน้าคลังก่อน`, where);
        return false;
      }
      if (byExp.length) return { wh: byExp[0].code, by: 'expressCode' };
      const same = whs.find((w) => w.code === util.normCode(code));
      return same ? { wh: same.code, by: 'code' } : null;
    };
    const direct = find(raw);
    if (direct === false) return null;
    if (direct) return direct;
    const def = util.trim((tx.settings().express || {}).defaultWarehouse);
    const d = find(def);
    if (d === false) return null;
    if (d) return { wh: d.wh, by: 'default' };
    tx.error('NO_WAREHOUSE', `แถว ${where.row}: ไม่พบคลังของ "${util.trim(raw) || '(ว่าง)'}" และคลังเริ่มต้นของ Express (${def || 'ไม่ได้ตั้ง'}) ไม่ตรงกับคลังในระบบ – ตั้งรหัสคลัง Express ก่อน`, where);
    return null;
  }

  define('express.import', {
    label: 'นำเข้ายอด Express (ไม่เปลี่ยนยอด)', perm: 'express.import',
    prepare(tx, p) {
      const fileName = util.trim(p.fileName);
      if (!fileName) return tx.error('REQUIRED', 'ระบุชื่อไฟล์', { field: 'fileName' });
      const fileHash = util.trim(p.fileHash).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(fileHash)) return tx.error('BAD_HASH', 'ลายนิ้วมือไฟล์ต้องเป็น SHA-256 (ตัวอักษร 0-9 a-f 64 ตัว)', { field: 'fileHash' });
      const dup = tx.all('express_batches', (b) => b.fileHash === fileHash && b.status !== 'DISCARDED')[0];
      if (dup) return tx.error('DUPLICATE_FILE', `ไฟล์นี้นำเข้าแล้วเป็นรอบ ${dup.id} (${BATCH_STATUS[dup.status]}) เมื่อ ${util.beDateTime(dup.importedAt)} – ไม่นำเข้าซ้ำ`, { field: 'fileHash' });
      const snapRaw = util.trim(p.snapshotAt);
      if (!ISO_TZ.test(snapRaw) || isNaN(ms(snapRaw))) {
        return tx.error('BAD_TIME', 'ระบุวันเวลาของข้อมูลในไฟล์ พร้อมเขตเวลา เช่น 2026-11-01T17:00:00+07:00', { field: 'snapshotAt' });
      }
      const snapshotAt = new Date(ms(snapRaw)).toISOString();
      if (ms(snapshotAt) > ms(tx.now)) return tx.error('FUTURE_TIME', 'เวลาของข้อมูลอยู่หลังเวลาปัจจุบัน – ตรวจวันเวลาของไฟล์', { field: 'snapshotAt' });
      const raws = Array.isArray(p.rows) ? p.rows : [];
      if (!raws.length) return tx.error('NO_ROWS', 'ไฟล์ไม่มีแถวข้อมูล', { field: 'rows' });
      const rows = [];
      const unknown = [];
      const byDefault = [];
      raws.forEach((r, i) => {
        r = r || {};
        const n = i + 1; // row id inside the batch (unique); fileRow = the row number in the file when the screen sends it
        const fileRow = r.row != null && util.trim(r.row) ? util.trim(r.row) : '';
        const where = { row: n };
        const qty = util.num(r.qty);
        if (isNaN(qty)) return tx.error('BAD_QTY', `แถว ${n}: จำนวนไม่ใช่ตัวเลข`, Object.assign({ field: 'qty' }, where));
        const map = mapWarehouse(tx, r.wh, where);
        if (!map) return;
        const rawCode = util.trim(r.code);
        const it = tx.item(rawCode); // by code / Express code / count code only – never by name
        let unit = util.trim(r.unit);
        let base = qty;
        if (it) {
          unit = unit || it.baseUnit;
          const f = RRS.unitFactor((t, k) => tx.get(t, k), it, unit);
          if (f == null) return tx.error('NO_UNIT', `แถว ${n}: ${it.id} ไม่มีตัวคูณของหน่วย "${unit}" (หน่วยหลัก ${it.baseUnit}) – ตั้งหน่วยก่อนนำเข้า`, Object.assign({ field: 'unit' }, where));
          base = util.round(qty * f);
        } else {
          unknown.push({ row: n, rawCode });
        }
        if (map.by === 'default' && util.trim(r.wh)) byDefault.push({ row: n, rawWh: util.trim(r.wh), wh: map.wh });
        rows.push({ row: n, fileRow, rawCode, rawWh: util.trim(r.wh), code: it ? it.id : '', wh: map.wh, whBy: map.by,
          qty: util.round(qty), unit, base });
      });
      if (!tx.ok) return;
      const closed = tx.all('express_batches', (b) => b.status === 'CLOSED').map((b) => ms(b.snapshotAt));
      const latest = closed.length ? Math.max.apply(null, closed) : -Infinity;
      const olderThanLatest = ms(snapshotAt) < latest;
      const id = tx.nextId('EX');
      const batch = {
        id, source: util.trim(p.source) || 'Express', fileName, fileHash, snapshotAt, importedBy: tx.userId, importedAt: tx.now,
        status: 'REVIEW', rows, unknownRows: unknown.length, olderThanLatest, resolutions: [], closedBy: '', closedAt: '',
        closeTotals: null, discardedBy: '', discardedAt: '', discardReason: '',
      };
      if (bytes(batch) > MAX_ROW_BYTES) {
        return tx.error('TOO_LARGE', `ไฟล์มี ${rows.length} แถว ใหญ่เกินหนึ่งรอบนำเข้า – นำเข้าเฉพาะกลุ่มทดลอง หรือแยกไฟล์ตามคลัง`, { field: 'rows' });
      }
      tx.put('express_batches', id, batch);
      if (unknown.length) tx.warn(`${unknown.length} แถวไม่รู้จักรหัส (ระบบไม่จับคู่จากชื่อ) – แถว ${unknown.slice(0, 10).map((u) => u.row).join(', ')}${unknown.length > 10 ? ' …' : ''}`);
      if (byDefault.length) tx.warn(`${byDefault.length} แถวไม่พบคลัง Express ที่ระบุ จึงใช้คลังเริ่มต้น ${byDefault[0].wh} – ตรวจรหัสคลัง`);
      if (olderThanLatest) tx.warn('ไฟล์นี้เก่ากว่ารอบที่ปิดล่าสุด – ปรับยอดจากไฟล์นี้ต้องยืนยันเป็นพิเศษ');
      tx.result = { batchId: id, rows: rows.length, unknown, byDefault, olderThanLatest };
      tx.summary = `นำเข้ายอด Express ${fileName} ${rows.length} แถว เป็นรอบ ${id} (ยังไม่เปลี่ยนยอด)`;
    },
  });

  define('express.resolve', {
    label: 'ตัดสินผลต่าง Express (อธิบาย/ปรับยอด)', perm: 'express.reconcile',
    prepare(tx, p) {
      const b = tx.get('express_batches', util.normCode(p.batchId));
      if (!b) return tx.error('NOT_FOUND', `ไม่พบรอบนำเข้า ${p.batchId}`);
      if (b.status !== 'REVIEW') return tx.error('BAD_STATE', `รอบ ${b.id} ${BATCH_STATUS[b.status]} – แก้การตัดสินไม่ได้`);
      const lines = Array.isArray(p.lines) ? p.lines : [];
      if (!lines.length) return tx.error('NO_LINES', 'เลือกรายการที่จะตัดสินอย่างน้อย 1 รายการ');
      const read = txReader(tx);
      const r = buildReconcile(read, b);
      const byKey = {};
      for (const row of r.rows) byKey[row.key] = row;
      const settings = tx.settings();
      const seen = {};
      const entries = [];
      const adjusts = [];
      lines.forEach((raw, i) => {
        raw = raw || {};
        const n = i + 1;
        const where = { line: n };
        const action = String(raw.action || '').toLowerCase();
        if (action !== 'adjust' && action !== 'explain') return tx.error('BAD_VALUE', `บรรทัด ${n}: เลือก adjust (ปรับยอดตาม Express) หรือ explain (อธิบายผลต่าง)`, Object.assign({ field: 'action' }, where));
        const reason = util.trim(raw.reason);
        if (!reason) return tx.error('REASON_REQUIRED', `บรรทัด ${n}: ระบุเหตุผล/คำอธิบายผลต่าง`, Object.assign({ field: 'reason' }, where));
        let row;
        if (!util.trim(raw.code) && raw.row != null) {
          row = byKey['row:' + raw.row];
          if (!row) return tx.error('NOT_IN_BATCH', `บรรทัด ${n}: ไม่มีแถว ${raw.row} ที่ไม่รู้จักรหัสในรอบ ${b.id}`, where);
        } else {
          const it = tx.item(raw.code);
          if (!it) return tx.error('NOT_FOUND', `บรรทัด ${n}: ไม่พบรหัส ${raw.code || '(ว่าง)'} ในทะเบียนสินค้า`, Object.assign({ field: 'code' }, where));
          const wh = util.normCode(raw.wh);
          row = byKey[it.id + '|' + wh];
          if (!row) return tx.error('NOT_IN_BATCH', `บรรทัด ${n}: ${it.id} คลัง ${wh || '(ว่าง)'} ไม่อยู่ในผลกระทบยอดของรอบ ${b.id}`, where);
        }
        if (seen[row.key]) return tx.error('DUPLICATE_LINE', `บรรทัด ${n}: รายการซ้ำกับบรรทัด ${seen[row.key]}`, where);
        seen[row.key] = n;
        if (row.wh && !needWh(tx, 'express.reconcile', row.wh, where)) return;
        if (row.resolution && row.resolution.action === 'adjust') {
          return tx.error('ALREADY_ADJUSTED', `บรรทัด ${n}: ${row.code} คลัง ${row.wh} ปรับยอดไปแล้วใน ${row.resolution.docNo} – ยกเลิกใบนั้นก่อนถ้าจะตัดสินใหม่`, where);
        }
        if (action === 'adjust') {
          if (row.status === 'UNKNOWN_CODE') return tx.error('BAD_VALUE', `บรรทัด ${n}: แถวที่ไม่รู้จักรหัสปรับยอดไม่ได้ – แก้รหัสในทะเบียนแล้วนำเข้าใหม่`, where);
          if ((settings.ownership || {}).qty !== 'Express') {
            return tx.error('OWNERSHIP', `บรรทัด ${n}: ยอดจำนวนเป็นของระบบ RRS (ค-1) – ไฟล์ Express ใช้กระทบยอดเท่านั้น ให้อธิบายผลต่าง หรือเปิดรอบตรวจนับ`, where);
          }
          if (row.diff === 0) return tx.error('NOTHING', `บรรทัด ${n}: ${row.code} ไม่มีผลต่าง`, where);
          if (row.staleBy.length) {
            return tx.error('STALE_ROW', `บรรทัด ${n}: ${row.code} คลัง ${row.wh} ถูกตรวจนับ/ปรับยอดหลังเวลาของไฟล์แล้ว (${row.staleBy.join(', ')}) – ไฟล์นี้ล้าสมัยสำหรับรายการนี้ ใช้ไฟล์ใหม่กว่า`, where);
          }
          if (r.olderThanLatest && p.confirmOld !== true) {
            return tx.error('OLD_SNAPSHOT', `บรรทัด ${n}: ไฟล์ของรอบ ${b.id} เก่ากว่ารอบที่ปิดล่าสุด – ยืนยัน (confirmOld) ก่อนปรับยอดจากไฟล์เก่า`, where);
          }
          adjusts.push({ n, row, bin: util.normCode(raw.bin), lot: util.trim(raw.lot), reason });
        }
        entries.push({ key: row.key, code: row.code, wh: row.wh, row: row.status === 'UNKNOWN_CODE' ? row.rows[0] : '', status: row.status,
          action, reason, bin: action === 'adjust' ? util.normCode(raw.bin) : '', lot: action === 'adjust' ? util.trim(raw.lot) : '',
          express: row.express, rrsAtSnapshot: row.rrsAtSnapshot, rrsNow: row.rrsNow, qty: action === 'adjust' ? row.diff : 0,
          pendingDocs: row.pendingDocs.slice(), confirmOld: action === 'adjust' && r.olderThanLatest,
          docNo: '', by: tx.userId, at: tx.now, cancelledBy: '', cancelledAt: '' });
      });
      if (!tx.ok) return;
      for (const a of adjusts) {
        if (a.row.pendingDocs.length) {
          tx.warn(`${a.row.code} คลัง ${a.row.wh}: มีเอกสารที่ยังไม่คีย์ Express ณ เวลาของไฟล์ (${a.row.pendingDocs.join(', ')}) – ปรับตามไฟล์แล้ว ห้ามคีย์เอกสารเหล่านี้ซ้ำใน Express โดยไม่ตรวจ`);
        }
      }
      let docNo = '';
      if (adjusts.length) {
        if (!tx.different(b.importedBy, 'ผู้ปรับยอดตามไฟล์ Express (ผู้นำเข้าไฟล์ปรับเองไม่ได้)')) return;
        const doc = ajDoc(tx, { ref: b.id, source: 'express:' + b.id, remark: `ปรับยอดตาม Express รอบ ${b.id} (${b.fileName}) ณ ${util.beDateTime(b.snapshotAt)}` },
          adjusts.map((a) => ({ code: a.row.code, qty: a.row.diff, wh: a.row.wh, bin: a.bin, lot: a.lot, remark: a.reason })));
        const posted = postAj(tx, 'express.reconcile', doc, adjusts.map((a) => a.n));
        if (!posted) return;
        docNo = posted.docNo;
        // this AJ mirrors Express (Express owns the quantity) – it must not be keyed into Express again
        tx.put('documents', docNo, Object.assign({}, posted, { expressStatus: 'N/A', expressNote: `ปรับตาม Express รอบ ${b.id} – ไม่ต้องคีย์ซ้ำ` }));
        for (const e of entries) if (e.action === 'adjust') e.docNo = docNo;
      }
      const next = Object.assign({}, b, { resolutions: (b.resolutions || []).concat(entries) });
      if (bytes(next) > MAX_ROW_BYTES) return tx.error('TOO_LARGE', `รอบ ${b.id} มีการตัดสินมากเกินหนึ่งรายการบันทึก – ปิดรอบแล้วนำเข้าไฟล์ใหม่`);
      tx.put('express_batches', b.id, next);
      tx.result = { batchId: b.id, docNo, adjusted: adjusts.length, explained: entries.length - adjusts.length };
      tx.summary = `ตัดสินผลต่าง Express รอบ ${b.id}: ${entries.length} รายการ${docNo ? ' ปรับยอด ' + docNo : ''}`;
    },
  });

  define('express.close', {
    label: 'ปิดรอบกระทบยอด Express', perm: 'express.reconcile',
    prepare(tx, p) {
      const b = tx.get('express_batches', util.normCode(p.batchId));
      if (!b) return tx.error('NOT_FOUND', `ไม่พบรอบนำเข้า ${p.batchId}`);
      if (b.status !== 'REVIEW') return tx.error('BAD_STATE', `รอบ ${b.id} ${BATCH_STATUS[b.status]}`);
      const r = buildReconcile(txReader(tx), b);
      const open = r.rows.filter((x) => x.status !== 'MATCH' && !x.resolved);
      if (open.length) {
        return tx.error('UNRESOLVED', `ยังมี ${open.length} รายการที่ยอดต่างแต่ยังไม่ได้อธิบาย/ปรับยอด: ${open.slice(0, 10).map((x) => x.code ? x.code + '@' + x.wh : 'แถว ' + x.rows[0]).join(', ')}${open.length > 10 ? ' …' : ''}`);
      }
      tx.put('express_batches', b.id, Object.assign({}, b, { status: 'CLOSED', closedBy: tx.userId, closedAt: tx.now, closeTotals: r.totals }));
      tx.summary = `ปิดรอบกระทบยอด Express ${b.id}`;
    },
  });

  define('express.discard', {
    label: 'ยกเลิกรอบนำเข้า Express',
    perm: (tx) => (tx.can('express.import') ? 'express.import' : 'express.reconcile'),
    prepare(tx, p) {
      const b = tx.get('express_batches', util.normCode(p.batchId));
      if (!b) return tx.error('NOT_FOUND', `ไม่พบรอบนำเข้า ${p.batchId}`);
      if (b.status !== 'REVIEW') return tx.error('BAD_STATE', `รอบ ${b.id} ${BATCH_STATUS[b.status]} – ยกเลิกไม่ได้`);
      const reason = util.trim(p.reason);
      if (!reason) return tx.error('REQUIRED', 'ระบุเหตุผลการยกเลิกรอบ', { field: 'reason' });
      const live = Array.from(new Set((b.resolutions || []).filter((x) => x.action === 'adjust' && !x.cancelledAt).map((x) => x.docNo)));
      if (live.length) return tx.error('HAS_ADJUSTMENTS', `รอบ ${b.id} ปรับยอดไปแล้ว (${live.join(', ')}) – ยกเลิกใบปรับยอดก่อน`);
      tx.put('express_batches', b.id, Object.assign({}, b, { status: 'DISCARDED', discardedBy: tx.userId, discardedAt: tx.now, discardReason: reason }));
      tx.summary = `ยกเลิกรอบนำเข้า Express ${b.id}`;
    },
  });

  // ---- stock counts ------------------------------------------------------------------------------------------
  /** A count difference above this needs a second count by another person: max(recountQty, recountPct % of system). */
  function recountLimit(system, pol) {
    const q = util.num(pol.recountQty);
    const pct = util.num(pol.recountPct);
    return Math.max(isNaN(q) ? 0 : q, ((isNaN(pct) ? 0 : pct) / 100) * Math.abs(system));
  }
  rec.recountLimit = recountLimit;

  function entriesOf(l) {
    return [{ counted: l.counted, system: l.system, by: l.countedBy, at: l.countedAt, seq: l.countedSeq }].concat(l.recounts || []);
  }

  /** What one count says about the record: counted − system qty AT THAT COUNT'S TIME. Stock may move between a count and
   *  its recount (timestamp mode), so two counts agree when they find the same difference, not the same raw number. */
  const impliedDiff = (e) => util.round(e.counted - e.system);

  /**
   * Re-evaluates a line after an entry:
   *  one count            -> accepted, or RECOUNT when |counted − system| exceeds the limit
   *  two or more counts   -> accepted (RECOUNTED) when the latest finds the same difference as an earlier count by
   *                          another person, else DUPLICATE until a further count agrees with one of them
   */
  function evalLine(l, pol) {
    const all = entriesOf(l);
    const last = all[all.length - 1];
    let final = null;
    let flags;
    if (all.length === 1) {
      const over = Math.abs(impliedDiff(last)) > recountLimit(last.system, pol);
      flags = over ? ['RECOUNT'] : [];
      final = over ? null : last;
    } else if (all.slice(0, -1).some((e) => impliedDiff(e) === impliedDiff(last))) {
      flags = ['RECOUNTED'];
      final = last;
    } else {
      flags = ['DUPLICATE'];
    }
    l.final = final ? { counted: final.counted, system: final.system, by: final.by, at: final.at, seq: final.seq } : null;
    const ref = final || last;
    l.diff = util.round(ref.counted - ref.system);
    l.flags = flags;
    return l;
  }
  const isPending = (l) => (l.flags || []).some((f) => f === 'RECOUNT' || f === 'DUPLICATE');
  const countersOf = (s) => Array.from(new Set([].concat.apply([], (s.lines || []).map((l) => entriesOf(l).map((e) => e.by)))));
  const inScope = (s, wh, bin) => wh === s.wh && (!s.bins.length || s.bins.indexOf(bin || '') >= 0);

  /** Lines with the AJ quantity approval would post, movements after counting and what was not counted. */
  function buildCountView(read, s) {
    const upto = s.approvedSeq || Infinity; // movements of the approval itself are not "during the count"
    const moves = {};
    for (const m of read('movements')) {
      if (m.wh !== s.wh || m.status !== STATUS.AVAILABLE || m.seq >= upto) continue;
      const k = lineKey(m.code, m.bin, m.lot);
      (moves[k] || (moves[k] = [])).push(m);
    }
    const bal = {};
    const held = {}; // QC_HOLD / QUARANTINE / REWORK at the same code|bin|lot: kept apart, must not be counted as usable
    for (const b of read('balances')) {
      if (b.wh !== s.wh) continue;
      const k = lineKey(b.code, b.bin, b.lot);
      if (b.status === STATUS.AVAILABLE) bal[k] = b;
      else held[k] = util.round((held[k] || 0) + b.qty);
    }
    const items = {};
    for (const it of read('items')) items[it.id] = it;
    const lines = (s.lines || []).map((l) => {
      const after = (moves[l.key] || []).filter((m) => m.seq > l.countedSeq);
      const moved = after.length > 0;
      const flags = (l.flags || []).slice();
      if (moved && flags.indexOf('MOVED_DURING_COUNT') < 0) flags.push('MOVED_DURING_COUNT');
      const adjust = l.final ? util.round(l.final.counted - l.final.system) : null;
      const heldQty = s.status === 'APPROVED' && l.heldQty != null ? l.heldQty : held[l.key] || 0; // as seen at approval
      // found more than the record where tagged QC stock lies: probably counted twice – the approver must check
      if (s.status !== 'APPROVED' && adjust > 0 && heldQty > 0 && flags.indexOf('HELD_STOCK') < 0) flags.push('HELD_STOCK');
      return Object.assign({}, l, {
        name: (items[l.code] || {}).name || l.name || '', unit: (items[l.code] || {}).baseUnit || '',
        counters: entriesOf(l).map((e) => e.by), adjust: l.adjust != null && s.status === 'APPROVED' ? l.adjust : adjust,
        currentSystem: bal[l.key] ? util.round(bal[l.key].qty) : 0, heldQty, movedCount: after.length,
        movedQty: util.round(util.sum(after, (m) => m.qty)), moved, held: flags.indexOf('HELD_STOCK') >= 0, flags,
        pending: isPending(l), needsReason: !!adjust && !l.reason,
      });
    });
    const counted = {};
    for (const l of lines) counted[l.key] = true;
    const uncounted = Object.values(bal).filter((b) => b.qty !== 0 && inScope(s, b.wh, b.bin) && !counted[lineKey(b.code, b.bin, b.lot)])
      .map((b) => ({ key: lineKey(b.code, b.bin, b.lot), code: b.code, bin: b.bin, lot: b.lot, qty: util.round(b.qty) }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const aj = lines.filter((l) => l.adjust).map((l) => ({ key: l.key, code: l.code, wh: s.wh, bin: l.bin, lot: l.lot, qty: l.adjust }));
    const pending = lines.filter((l) => l.pending).length;
    const movedN = lines.filter((l) => l.moved).length;
    const heldN = lines.filter((l) => l.held).length;
    return {
      session: Object.assign({}, s, { lines: undefined }), lines, aj, uncounted,
      totals: { lines: lines.length, pending, moved: movedN, held: heldN, adjustLines: aj.length,
        plus: util.round(util.sum(aj.filter((a) => a.qty > 0), (a) => a.qty)),
        minus: util.round(util.sum(aj.filter((a) => a.qty < 0), (a) => a.qty)),
        needsReason: lines.filter((l) => l.needsReason).length, uncounted: uncounted.length },
      canSubmit: s.status === 'OPEN' && lines.length > 0 && pending === 0,
      canApprove: s.status === 'SUBMITTED' && pending === 0,
      needsAck: movedN > 0 || heldN > 0,
    };
  }

  /** Count session view for the screens (null when not found). */
  rec.countView = function countView(state, id) {
    const s = RRS.q.get(state, 'count_sessions', id);
    return s ? buildCountView(stateReader(state), s) : null;
  };

  /**
   * The freeze session holding a location still (OPEN/SUBMITTED, mode freeze), or null. There is no exemption by a
   * document's `source`: doc.post takes `source` from the caller, so it proves nothing. The approval's own AJ passes
   * because count.approve marks the session APPROVED (no longer live) in the same commit before it posts.
   */
  function freezeAt(sessions, wh, bin) {
    return sessions.find((s) => s.mode === 'freeze' && LIVE_COUNT.indexOf(s.status) >= 0 && inScope(s, wh, bin)) || null;
  }
  rec.frozenBy = function frozenBy(state, wh, bin) {
    const s = freezeAt(RRS.q.rows(state, 'count_sessions'), util.normCode(wh), util.normCode(bin));
    return s ? s.id : '';
  };

  function getSession(tx, id, states) {
    const s = tx.get('count_sessions', util.normCode(id));
    if (!s) return tx.error('NOT_FOUND', `ไม่พบรอบนับ ${id || ''}`) && null;
    if (states && states.indexOf(s.status) < 0) return tx.error('BAD_STATE', `รอบนับ ${s.id} ${COUNT_STATUS[s.status]}`) && null;
    return s;
  }

  define('count.create', {
    label: 'เปิดรอบตรวจนับ', perm: 'count.create',
    prepare(tx, p) {
      const wh = util.normCode(p.wh);
      const w = wh && wh !== TRANSIT ? tx.get('warehouses', wh) : null;
      if (!w) return tx.error('NOT_FOUND', `ไม่พบคลัง ${wh || '(ว่าง)'}`, { field: 'wh' });
      if (w.active === false) return tx.error('INACTIVE', `คลัง ${wh} ปิดใช้งาน`, { field: 'wh' });
      if (!needWh(tx, 'count.create', wh, { field: 'wh' })) return;
      const bins = [];
      for (const raw of Array.isArray(p.bins) ? p.bins : []) {
        const code = util.normCode(raw);
        if (!code || bins.indexOf(code) >= 0) continue;
        const bin = tx.get('bins', wh + '|' + code);
        if (!bin) return tx.error('NOT_FOUND', `ไม่พบช่องเก็บ ${code} ในคลัง ${wh}`, { field: 'bins' });
        if (bin.active === false) return tx.error('INACTIVE', `ช่องเก็บ ${code} ปิดใช้งาน`, { field: 'bins' });
        bins.push(code);
      }
      const mode = util.trim(p.mode) || (tx.settings().policies || {}).countMode || 'timestamp';
      if (!COUNT_MODE[mode]) return tx.error('BAD_VALUE', 'วิธีคุมการเคลื่อนไหวต้องเป็น timestamp หรือ freeze', { field: 'mode' });
      const clash = tx.all('count_sessions', (s) => s.wh === wh && LIVE_COUNT.indexOf(s.status) >= 0
        && (!s.bins.length || !bins.length || s.bins.some((b) => bins.indexOf(b) >= 0)))[0];
      if (clash) {
        return tx.error('OVERLAP', `พื้นที่นี้อยู่ในรอบนับ ${clash.id} (${COUNT_STATUS[clash.status]}) แล้ว – นับซ้อนกันจะปรับยอดซ้ำ ปิดหรือยกเลิกรอบเดิมก่อน`, { field: 'bins' });
      }
      const id = tx.nextId('CT');
      const s = { id, wh, bins, mode, status: 'OPEN', note: util.trim(p.note), lines: [], createdBy: tx.userId, createdAt: tx.now,
        submittedBy: '', submittedAt: '', approvedBy: '', approvedAt: '', approvedSeq: 0, ack: null, docNo: '',
        cancelledBy: '', cancelledAt: '', cancelReason: '', docCancelled: null };
      tx.put('count_sessions', id, s);
      const transit = tx.all('documents', (d) => d.type === 'TR' && d.status === 'IN_TRANSIT'
        && (d.lines || []).some((l) => l.toWh === wh && l.received < l.base)).map((d) => d.docNo);
      if (transit.length) {
        tx.warn(`มีใบโอนระหว่างทางเข้าคลัง ${wh}: ${transit.join(', ')} – ${mode === 'freeze'
          ? 'รับเข้าช่องที่นับไม่ได้จนกว่าจะอนุมัติหรือยกเลิกรอบนับ (รับเข้าช่องอื่นได้)'
          : 'รับโอนระหว่างนับจะถูกแจ้งเป็นการเคลื่อนไหวหลังนับ'}`);
      }
      tx.result.id = id;
      tx.summary = `เปิดรอบนับ ${id} คลัง ${wh}${bins.length ? ' ช่อง ' + bins.join(', ') : ' ทั้งคลัง'} (${mode})`;
    },
  });

  define('count.enter', {
    label: 'บันทึกผลนับ', perm: 'count.enter',
    prepare(tx, p) {
      const s = getSession(tx, p.id, ['OPEN']);
      if (!s) return;
      if (!needWh(tx, 'count.enter', s.wh)) return;
      const raws = Array.isArray(p.lines) ? p.lines : [];
      if (!raws.length) return tx.error('NO_LINES', 'ยังไม่มีบรรทัดผลนับ');
      const pol = tx.settings().policies || {};
      const wh = tx.get('warehouses', s.wh) || {};
      const lines = (s.lines || []).map((l) => util.clone(l));
      const index = {};
      lines.forEach((l) => { index[l.key] = l; });
      const inThis = {};
      const out = [];
      raws.forEach((raw, i) => {
        raw = raw || {};
        const n = i + 1;
        const where = { line: n };
        const it = tx.item(raw.code);
        if (!it) return tx.error('NOT_FOUND', `บรรทัด ${n}: ไม่พบรหัส ${raw.code || '(ว่าง)'} ในทะเบียนสินค้า`, Object.assign({ field: 'code' }, where));
        const bin = util.normCode(raw.bin);
        if (!inScope(s, s.wh, bin)) return tx.error('OUT_OF_SCOPE', `บรรทัด ${n}: ช่อง ${bin || '(ไม่ระบุ)'} ไม่อยู่ในรอบนับ ${s.id} (${s.bins.join(', ')})`, Object.assign({ field: 'bin' }, where));
        if (bin) {
          const b = tx.get('bins', s.wh + '|' + bin);
          if (!b) return tx.error('NOT_FOUND', `บรรทัด ${n}: ไม่พบช่องเก็บ ${bin} ในคลัง ${s.wh}`, Object.assign({ field: 'bin' }, where));
        } else if (wh.requireBin) {
          return tx.error('BIN_REQUIRED', `บรรทัด ${n}: คลัง ${s.wh} ต้องระบุช่องเก็บ`, Object.assign({ field: 'bin' }, where));
        }
        const lot = util.trim(raw.lot);
        if (it.trackLot && it.trackLot !== 'none') {
          if (!lot) return tx.error('LOT_REQUIRED', `บรรทัด ${n}: ${it.id} ต้องระบุ${RRS.master.TRACK[it.trackLot]}`, Object.assign({ field: 'lot' }, where));
        } else if (lot) {
          return tx.error('LOT_NOT_TRACKED', `บรรทัด ${n}: ${it.id} ไม่ได้ติดตามล็อต – ลบล็อตออก`, Object.assign({ field: 'lot' }, where));
        }
        const unit = util.trim(raw.unit) || it.baseUnit;
        const f = RRS.unitFactor((t, k) => tx.get(t, k), it, unit);
        if (f == null) return tx.error('NO_UNIT', `บรรทัด ${n}: ${it.id} ไม่มีตัวคูณของหน่วย "${unit}"`, Object.assign({ field: 'unit' }, where));
        const c = util.num(raw.counted);
        if (isNaN(c) || c < 0) return tx.error('BAD_QTY', `บรรทัด ${n}: จำนวนนับต้องเป็นตัวเลขตั้งแต่ 0`, Object.assign({ field: 'counted' }, where));
        const key = lineKey(it.id, bin, lot);
        if (inThis[key]) return tx.error('DUPLICATE_LINE', `บรรทัด ${n}: ซ้ำกับบรรทัด ${inThis[key]}`, where);
        inThis[key] = n;
        // The count is of usable stock (AVAILABLE) only: QC_HOLD / QUARANTINE / REWORK stock is tagged and kept apart,
        // so it is neither counted here nor adjusted by the count.
        const system = tx.balanceAt({ code: it.id, wh: s.wh, bin, status: STATUS.AVAILABLE, lot }).qty;
        const entry = { counted: util.round(c * f), system: util.round(system), by: tx.userId, at: tx.now, seq: tx.seq };
        let l = index[key];
        if (!l) {
          l = { key, code: it.id, name: it.name, bin, lot, status: STATUS.AVAILABLE, system: entry.system, counted: entry.counted,
            countedBy: entry.by, countedAt: entry.at, countedSeq: entry.seq, recounts: [], final: null, diff: 0, adjust: null,
            reason: '', reasonBy: '', reasonAt: '', responsible: '', flags: [] };
          lines.push(l);
          index[key] = l;
        } else {
          if (entriesOf(l).some((e) => e.by === tx.userId) && (tx.settings().policies || {}).sod !== false) {
            return tx.error('SAME_PERSON', `บรรทัด ${n}: คุณนับ ${it.id} ${locText(s.wh, bin)}${lot ? ' ล็อต ' + lot : ''} ไปแล้ว – การนับซ้ำต้องเป็นคนละคน`, where);
          }
          l.recounts = (l.recounts || []).concat([entry]);
        }
        evalLine(l, pol);
        out.push({ line: n, key, flags: l.flags.slice() }); // no system qty in the result: counters count blind
      });
      if (!tx.ok) return;
      const next = Object.assign({}, s, { lines });
      if (bytes(next) > MAX_ROW_BYTES) return tx.error('TOO_LARGE', `รอบนับ ${s.id} มีบรรทัดมากเกินหนึ่งรายการบันทึก – แบ่งรอบนับตามช่องเก็บ`);
      tx.put('count_sessions', s.id, next);
      tx.result = { id: s.id, lines: out, recount: out.filter((x) => x.flags.indexOf('RECOUNT') >= 0 || x.flags.indexOf('DUPLICATE') >= 0).map((x) => x.key) };
      tx.summary = `บันทึกผลนับ ${s.id} ${out.length} บรรทัด`;
    },
  });

  define('count.submit', {
    label: 'ส่งผลนับให้อนุมัติ', perm: 'count.enter',
    prepare(tx, p) {
      const s = getSession(tx, p.id, ['OPEN']);
      if (!s) return;
      if (!needWh(tx, 'count.enter', s.wh)) return;
      if (!(s.lines || []).length) return tx.error('NO_LINES', `รอบนับ ${s.id} ยังไม่มีผลนับ`);
      const pending = s.lines.filter(isPending);
      if (pending.length) {
        return tx.error('NEEDS_RECOUNT', `ยังมี ${pending.length} บรรทัดที่ต้องนับซ้ำโดยอีกคน: ${pending.slice(0, 10).map((l) => l.key).join(', ')}`);
      }
      tx.put('count_sessions', s.id, Object.assign({}, s, { status: 'SUBMITTED', submittedBy: tx.userId, submittedAt: tx.now }));
      const v = buildCountView(txReader(tx), s);
      if (v.uncounted.length) tx.warn(`มี ${v.uncounted.length} ตำแหน่งที่มียอดแต่ไม่ได้นับ – จะไม่ถูกปรับยอด`);
      tx.summary = `ส่งผลนับ ${s.id}`;
    },
  });

  define('count.approve', {
    label: 'อนุมัติผลนับและปรับยอด', perm: 'count.approve',
    prepare(tx, p) {
      const s = getSession(tx, p.id, ['SUBMITTED']);
      if (!s) return;
      if (!needWh(tx, 'count.approve', s.wh)) return;
      for (const c of countersOf(s)) if (!tx.different(c, 'ผู้อนุมัติผลนับ')) return; // the approver counted nothing here
      // ... and did not send it for approval (submitting is the request; nobody approves their own request)
      if (!tx.different(s.submittedBy, 'ผู้อนุมัติผลนับ (ผู้ส่งผลนับรอบนี้อนุมัติเองไม่ได้)')) return;
      const v = buildCountView(txReader(tx), s);
      if (v.totals.pending) return tx.error('NEEDS_RECOUNT', `ยังมี ${v.totals.pending} บรรทัดที่ต้องนับซ้ำ`);
      const reasons = p.reasons && typeof p.reasons === 'object' ? p.reasons : {};
      const keys = {};
      for (const l of v.lines) keys[l.key] = l;
      for (const k in reasons) if (!keys[k]) tx.error('BAD_KEY', `ไม่มีบรรทัด ${k} ในรอบนับ ${s.id}`, { field: 'reasons' });
      if (!tx.ok) return;
      const moved = [];
      const held = [];
      const lines = v.lines.map((l, i) => {
        const r = reasons[l.key];
        const reason = util.trim(r && typeof r === 'object' ? r.reason : r);
        const responsible = util.trim(r && typeof r === 'object' ? r.responsible : '');
        if (l.adjust && !reason) tx.error('REASON_REQUIRED', `${l.code} ${locText(s.wh, l.bin)}${l.lot ? ' ล็อต ' + l.lot : ''}: ยอดต่าง ${l.adjust} ต้องระบุเหตุผล`, { line: i + 1, field: l.key });
        if (l.moved) moved.push(l.key);
        if (l.held) held.push(l.key);
        const stored = Object.assign({}, s.lines[i], { adjust: l.adjust || 0, flags: l.flags, movedQty: l.movedQty, heldQty: l.heldQty });
        if (reason) Object.assign(stored, { reason, reasonBy: tx.userId, reasonAt: tx.now, responsible: responsible || tx.userId });
        return stored;
      });
      if (!tx.ok) return;
      if (moved.length && p.ack !== true) {
        return tx.error('MOVED_DURING_COUNT', `${moved.length} บรรทัดมีรายการเคลื่อนไหวหลังนับ (${moved.slice(0, 10).join(', ')}) – ระบบจะปรับเฉพาะผลต่าง ณ เวลานับ (ยอดที่เคลื่อนไหวหลังนับคงไว้) ตรวจแล้วยืนยันรับทราบ (ack)`);
      }
      if (held.length && p.ack !== true) {
        return tx.error('HELD_STOCK', `${held.length} บรรทัดนับได้มากกว่าระบบ ขณะที่ตำแหน่งเดียวกันมีของรอตรวจ/กักกัน/รอแก้ไข (${held.slice(0, 10).join(', ')}) – ตรวจว่าไม่ได้นับของเหล่านั้นรวมเป็นของใช้ได้ แล้วยืนยันรับทราบ (ack)`);
      }
      const approved = Object.assign({}, s, { status: 'APPROVED', lines, approvedBy: tx.userId, approvedAt: tx.now, approvedSeq: tx.seq,
        ack: moved.length || held.length ? { by: tx.userId, at: tx.now, lines: moved, held } : null });
      tx.put('count_sessions', s.id, approved); // approved first: the freeze no longer holds while its own AJ posts
      const adj = lines.map((l, i) => ({ l, i })).filter((x) => x.l.adjust);
      if (adj.length) {
        const doc = ajDoc(tx, { ref: s.id, source: 'count:' + s.id, remark: `ปรับยอดจากการตรวจนับ ${s.id} คลัง ${s.wh}` },
          adj.map((x) => ({ code: x.l.code, qty: x.l.adjust, wh: s.wh, bin: x.l.bin, lot: x.l.lot, remark: x.l.reason })));
        const posted = postAj(tx, 'count.approve', doc, adj.map((x) => x.i + 1));
        if (!posted) return;
        tx.put('count_sessions', s.id, Object.assign({}, approved, { docNo: posted.docNo }));
      }
      tx.result = { id: s.id, docNo: tx.result.docNo || '', adjusted: adj.length, moved, held };
      tx.summary = `อนุมัติผลนับ ${s.id}${adj.length ? ' ปรับยอด ' + tx.result.docNo + ' ' + adj.length + ' บรรทัด' : ' ไม่มีผลต่าง'}`;
    },
  });

  define('count.cancel', {
    label: 'ยกเลิกรอบนับ',
    perm: (tx) => (tx.can('count.create') ? 'count.create' : 'count.approve'),
    prepare(tx, p) {
      const s = getSession(tx, p.id);
      if (!s) return;
      if (s.status === 'APPROVED') return tx.error('BAD_STATE', `รอบนับ ${s.id} อนุมัติแล้ว – ยกเลิกใบปรับยอด ${s.docNo || ''} แทน`);
      if (LIVE_COUNT.indexOf(s.status) < 0) return tx.error('BAD_STATE', `รอบนับ ${s.id} ${COUNT_STATUS[s.status]}`);
      if (!(tx.can('count.create', s.wh) || tx.can('count.approve', s.wh))) return tx.need('count.create', s.wh);
      const reason = util.trim(p.reason);
      if (!reason) return tx.error('REQUIRED', 'ระบุเหตุผลการยกเลิกรอบนับ', { field: 'reason' });
      tx.put('count_sessions', s.id, Object.assign({}, s, { status: 'CANCELLED', cancelledBy: tx.userId, cancelledAt: tx.now, cancelReason: reason }));
      tx.summary = `ยกเลิกรอบนับ ${s.id}`;
    },
  });

  // ---- hooks into document posting ---------------------------------------------------------------------------
  /** COUNT_FREEZE naming the place that is frozen (wh/bin of the line that touches it). */
  function freezeError(tx, s, code, wh, bin, n, verb, extra) {
    tx.error('COUNT_FREEZE', `บรรทัด ${n}: ${code} ที่ ${locText(wh, bin)} อยู่ระหว่างตรวจนับ ${s.id} (หยุดเคลื่อนไหวชั่วคราว) – ${verb}ได้หลังอนุมัติหรือยกเลิกรอบนับ${extra || ''}`, { line: n });
  }
  const liveFreezes = (tx) => tx.all('count_sessions', (s) => s.mode === 'freeze' && LIVE_COUNT.indexOf(s.status) >= 0);

  // freeze: refuse any document line that touches a warehouse/bin under an OPEN or SUBMITTED freeze session
  RRS.hooks.on('doc.lineCheck', function (tx, doc, line) {
    const sessions = liveFreezes(tx);
    if (!sessions.length) return;
    const from = freezeAt(sessions, line.wh, line.bin);
    if (from) return freezeError(tx, from, line.code, line.wh, line.bin, line.line, 'บันทึก');
    const to = line.toWh ? freezeAt(sessions, line.toWh, line.toBin) : null;
    if (to) freezeError(tx, to, line.code, line.toWh, line.toBin, line.line, 'บันทึก');
  });

  // transfer.receive moves stock into the destination without the document line checks (doc.lineCheck), so a
  // transfer posted before the freeze could be received into a frozen bin. The receipt is refused here: after the
  // command has run, every movement it wrote outside TRANSIT is checked against the live freeze sessions (same commit,
  // so the error leaves nothing behind). Receiving into another, unfrozen bin (toBin) still works.
  const receive = commands.defs['transfer.receive'];
  if (receive && !receive.countFreeze) {
    const inner = receive.prepare;
    receive.prepare = function (tx, p) {
      const out = inner.call(this, tx, p);
      if (!tx.ok) return out;
      const sessions = liveFreezes(tx);
      if (!sessions.length) return out;
      for (const m of tx.all('movements', (x) => x.seq === tx.seq && x.wh !== TRANSIT)) {
        const s = freezeAt(sessions, m.wh, m.bin);
        if (s) return freezeError(tx, s, m.code, m.wh, m.bin, m.line, 'รับโอน', ' หรือรับเข้าช่องอื่นที่ไม่ได้นับ');
      }
      return out;
    };
    receive.countFreeze = true;
  }

  RRS.hooks.on('doc.cancelled', function (tx, doc, lines) {
    // cancelling writes reversing movements in the same places – also refused while those places are frozen
    const sessions = liveFreezes(tx);
    for (const l of sessions.length ? lines || [] : []) {
      const s = freezeAt(sessions, l.wh, l.bin);
      if (s) return freezeError(tx, s, l.code, l.wh, l.bin, l.line, 'ยกเลิกเอกสาร');
    }
    const src = String(doc.source || '');
    const info = { docNo: doc.docNo, by: tx.userId, at: tx.now, reason: doc.cancelReason || '' };
    if (src.indexOf('count:') === 0) {
      const s = tx.get('count_sessions', src.slice(6));
      if (s && s.docNo === doc.docNo) tx.put('count_sessions', s.id, Object.assign({}, s, { docCancelled: info }));
    } else if (src.indexOf('express:') === 0) {
      const b = tx.get('express_batches', src.slice(8));
      // only the batch's own AJ (a decision points at it) reopens its rows; a document merely claiming the source does not
      if (b && (b.resolutions || []).some((r) => r.docNo === doc.docNo && !r.cancelledAt)) {
        const resolutions = (b.resolutions || []).map((r) => (r.docNo === doc.docNo && !r.cancelledAt
          ? Object.assign({}, r, { cancelledBy: tx.userId, cancelledAt: tx.now, cancelReason: info.reason }) : r));
        tx.put('express_batches', b.id, Object.assign({}, b, { resolutions }));
      }
    }
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
