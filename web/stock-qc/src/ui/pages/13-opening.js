/*
 * Phase 1 – ย้ายยอดตั้งต้น (the migration tool). A CSV/Excel of the physical count at the cut-off time
 * (รหัสสินค้า, คลัง, ช่องเก็บ, ล็อต, จำนวน, หน่วย [, สถานะ]) becomes ONE adjustment document (AJ):
 *   1 ตรวจไฟล์  every row is resolved against the master data (codes with RRS.q.item – never by name), unknown codes,
 *               warehouses, bins, units without a factor, duplicate rows and codes that read the same are flagged
 *   2 บันทึก    one AJ (remark 'ยอดตั้งต้น ณ <cut-off>', ref = file name), the whole file or nothing
 *   3 กระทบยอด  per item: quantity in the file vs the balance right after posting (from the document's own movements),
 *               then a reminder to record the restore test before going live
 * Needs doc.postAdjust (the engine checks it again, also per warehouse).
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const { util, STATUS, STATUS_LABEL, TRANSIT } = RRS;

  const ALIASES = {
    code: ['รหัสสินค้า', 'รหัส', 'code', 'item code', 'itemcode', 'รหัสสินค้า (หลัก)'],
    wh: ['คลัง', 'รหัสคลัง', 'warehouse', 'wh'],
    bin: ['ช่องเก็บ', 'ช่อง', 'bin', 'location', 'ตำแหน่ง', 'ตำแหน่งเก็บ'],
    lot: ['ล็อต', 'lot', 'ล็อต/heat', 'heat', 'heat no', 'serial', 'lot no'],
    qty: ['จำนวน', 'qty', 'quantity', 'ยอด', 'ยอดนับ', 'จำนวนนับ'],
    unit: ['หน่วย', 'unit', 'uom'],
    status: ['สถานะ', 'status', 'สถานะของ'],
  };
  const HEADER = ['รหัสสินค้า', 'คลัง', 'ช่องเก็บ', 'ล็อต', 'จำนวน', 'หน่วย'];
  const STATUS_IN = {};
  for (const k in STATUS) STATUS_IN[k] = k;
  for (const k in STATUS_LABEL) STATUS_IN[STATUS_LABEL[k]] = k;
  const LIMIT = 200000; // one commit must stay under ~200 KB of JSON (ENGINE_CONTRACT)
  const STEP = 400;
  const dash = t`<span class="muted">–</span>`;
  const docView = (docNo) => ({ sel: docNo, lines: null, checked: null, header: null });

  // ---- helpers --------------------------------------------------------------------------------------------
  /** The cut-off time from settings: {raw, date (YYYY-MM-DD for the AJ), text (พ.ศ.)} or null when not set. */
  function cutoff(state) {
    const raw = util.trim(((state.tables.settings || {}).main || {}).cutoffAt);
    if (!raw) return null;
    const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(raw) && isFinite(Date.parse(raw));
    if (zoned) return { raw, date: util.bkkDate(raw), text: util.beDateTime(raw) };
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(raw);
    if (m) return { raw, date: m[1], text: util.beDate(m[1]) + (m[2] ? ' ' + m[2] : '') };
    return { raw, date: '', text: raw, bad: true };
  }
  /** A page by id, else by title (other screens are written in parallel). */
  function pageId(ids, re) {
    const pages = RRS.ui.pages;
    for (const id of ids) if (pages[id]) return id;
    const p = Object.values(pages).find((pg) => re.test(pg.title || ''));
    return p ? p.id : null;
  }
  const goLink = (label, id, view) => (id ? h.link(label, id, view) : t`<b>${label}</b>`);
  const isOpening = (d) => d.type === 'AJ' && (String(d.source || '').indexOf('opening:') === 0 || /^ยอดตั้งต้น/.test(d.remark || ''));

  function csvText(rows) {
    const cell = (x) => {
      let s = x == null ? '' : String(x);
      if (typeof x === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  // ---- step 1: read and check ------------------------------------------------------------------------------
  function readRows(rows) {
    let hi = -1;
    let map = null;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const m = h.mapHeader(rows[i] || [], ALIASES);
      if (m.code != null && m.qty != null) {
        hi = i;
        map = m;
        break;
      }
    }
    if (hi < 0) return { fatal: [`ไม่พบหัวตาราง – แถวแรกต้องเป็นชื่อคอลัมน์ ${HEADER.join(', ')}`], data: [] };
    const fatal = [];
    if (map.wh == null) fatal.push('ไม่พบคอลัมน์ คลัง – ทุกแถวต้องระบุคลัง');
    const cell = (r, k) => (map[k] == null ? '' : util.trim(r[map[k]]));
    const data = [];
    rows.forEach((r, i) => {
      if (i <= hi || !r || !r.some((x) => util.trim(x) !== '')) return;
      data.push({ n: i + 1, raw: { code: cell(r, 'code'), wh: cell(r, 'wh'), bin: cell(r, 'bin'), lot: cell(r, 'lot'), qty: cell(r, 'qty'), unit: cell(r, 'unit'), status: cell(r, 'status') } });
    });
    if (!data.length && !fatal.length) fatal.push('ไม่พบแถวข้อมูลใต้หัวตาราง');
    if (data.length > 5000) fatal.push(`ไฟล์มี ${data.length} แถว – มากเกินกว่าจะเป็นใบเดียว แบ่งไฟล์ตามคลังหรือกลุ่มสินค้า`);
    return { fatal, data, hasStatus: map.status != null };
  }

  /** Check every row against the master data and current stock. Nothing is matched by name. */
  function check(ctx, src) {
    const state = ctx.state;
    const parsed = readRows(src.rows || []);
    const out = { fatal: parsed.fatal.slice(), warnFile: [], rows: [], counts: { all: 0, ok: 0, warn: 0, bad: 0, skip: 0 }, items: 0, post: [] };
    if (parsed.fatal.length && !parsed.data.length) return out;
    const keyIdx = {};
    for (const it of RRS.q.rows(state, 'items')) {
      for (const c of [it.id, it.expressCode, it.countCode]) {
        const k = util.ckey(c);
        if (k) (keyIdx[k] || (keyIdx[k] = new Set())).add(it.id);
      }
    }
    const fmtU = (n, u) => `${h.fmt.num(n)}${u ? ' ' + u : ''}`;
    for (const d of parsed.data) {
      const r = { n: d.n, raw: d.raw, errors: [], warns: [], item: null, wh: '', bin: '', lot: '', qty: 0, unit: '', factor: 1, base: 0, status: 'AVAILABLE', skip: false };
      // item: by its code / Express code / stock-count code only
      const rawCode = d.raw.code;
      const k = util.ckey(rawCode);
      if (!rawCode) r.errors.push('ไม่มีรหัสสินค้า');
      else {
        const it = RRS.q.item(state, rawCode);
        const exact = !!it && util.normCode(rawCode) === it.id;
        const cands = keyIdx[k] ? Array.from(keyIdx[k]) : [];
        if (!it) r.errors.push(`ไม่พบรหัส ${rawCode} ในทะเบียนสินค้า – เพิ่มสินค้าก่อน หรือแก้รหัสในไฟล์ (ระบบไม่จับคู่จากชื่อ)`);
        else if (!exact && cands.length > 1) r.errors.push(`รหัส ${rawCode} อ่านได้ตรงกับหลายรายการ (${cands.join(', ')}) – ใส่รหัสหลักให้ตรงตัว`);
        else {
          r.item = it;
          if (!exact) {
            const how = util.ckey(it.expressCode) === k ? 'รหัส Express' : util.ckey(it.countCode) === k ? 'รหัสนับสต็อก' : 'รหัสหลักที่เขียนต่างกัน (ช่องว่าง ขีด หรือตัวพิมพ์)';
            r.warns.push(`อ่านเป็น ${it.id} ${it.name} จาก${how} – ตรวจว่าใช่รายการนี้`);
          }
          if (it.active === false) r.errors.push(`${it.id} ปิดใช้งานแล้ว – เปิดใช้งานในทะเบียนสินค้าก่อน`);
        }
      }
      // warehouse / bin
      r.wh = util.normCode(d.raw.wh);
      const whRow = r.wh ? RRS.q.get(state, 'warehouses', r.wh) : null;
      if (!r.wh) r.errors.push('ไม่มีคลัง');
      else if (r.wh === TRANSIT) r.errors.push(`${TRANSIT} ใช้ภายในระบบสำหรับของระหว่างโอน – ใส่คลังจริง`);
      else if (!whRow) r.errors.push(`ไม่พบคลัง ${r.wh} – ตรวจรหัสคลัง หรือเพิ่มคลังในข้อมูลหลักก่อน`);
      else if (whRow.active === false) r.errors.push(`คลัง ${r.wh} ปิดใช้งาน`);
      else if (!ctx.can('doc.postAdjust', r.wh)) r.errors.push(`คุณไม่มีสิทธิ์ปรับยอดคลัง ${r.wh} – แยกแถวคลังนี้ออกจากไฟล์ ให้หัวหน้าสโตร์ที่ดูแลคลังนี้นำเข้า`);
      r.bin = util.normCode(d.raw.bin);
      if (whRow && r.wh !== TRANSIT) {
        if (r.bin) {
          const b = RRS.q.get(state, 'bins', r.wh + '|' + r.bin);
          if (!b) r.errors.push(`ไม่พบช่องเก็บ ${r.bin} ในคลัง ${r.wh} – เพิ่มช่องเก็บก่อน หรือแก้ในไฟล์`);
          else if (b.active === false) r.errors.push(`ช่องเก็บ ${r.bin} ปิดใช้งาน`);
        } else if (whRow.requireBin) r.errors.push(`คลัง ${r.wh} ต้องระบุช่องเก็บ`);
      }
      // lot
      r.lot = util.trim(d.raw.lot);
      if (r.item) {
        const track = r.item.trackLot || 'none';
        if (track !== 'none' && !r.lot) r.errors.push(`${r.item.id} ต้องระบุ${RRS.master.TRACK[track] || 'ล็อต'} (สินค้าติดตามล็อต)`);
        if (track === 'none' && r.lot) r.errors.push(`${r.item.id} ไม่ได้ตั้งให้ติดตามล็อต – ลบล็อตออก หรือแก้ทะเบียนสินค้า`);
      }
      // quantity / unit
      const qtyRaw = d.raw.qty;
      const qty = util.num(qtyRaw);
      if (qtyRaw === '') r.errors.push('ไม่ได้กรอกจำนวน (ถ้าไม่มีของ ใส่ 0)');
      else if (isNaN(qty)) r.errors.push(`จำนวน "${qtyRaw}" ไม่ใช่ตัวเลข`);
      else if (qty < 0) r.errors.push('จำนวนติดลบ – ยอดตั้งต้นต้องเป็นยอดนับจริง 0 ขึ้นไป');
      else {
        r.qty = util.round(qty);
        if (qty === 0) r.skip = true;
      }
      r.unit = util.trim(d.raw.unit);
      if (r.item) {
        const f = RRS.unitFactor((tb, kk) => RRS.q.get(state, tb, kk), r.item, r.unit);
        if (f == null) r.errors.push(`หน่วย "${r.unit}" ของ ${r.item.id} ยังไม่มีตัวคูณ (หน่วยหลัก ${r.item.baseUnit}) – เพิ่มตัวคูณในทะเบียนสินค้า หรือแปลงเป็นหน่วยหลักในไฟล์`);
        else {
          r.factor = f;
          r.base = util.round(r.qty * f);
        }
        // a serial number is one unit in one place
        if (r.item.trackLot === 'serial' && r.lot && !r.skip && r.qty > 0 && f != null && r.base !== 1) {
          r.errors.push(`${r.item.id} ติดตาม Serial – 1 แถวต่อ 1 Serial จำนวนต้องเป็น 1 ${r.item.baseUnit} (ในไฟล์ ${fmtU(r.base, r.item.baseUnit)}) แยกเป็นแถวละ Serial`);
        }
      }
      // quality status (optional column, empty = ใช้ได้)
      const st = d.raw.status;
      r.status = st ? STATUS_IN[st] || STATUS_IN[st.toUpperCase()] || '' : 'AVAILABLE';
      if (!r.status) r.errors.push(`สถานะ "${st}" ไม่รู้จัก – ใช้ ใช้ได้ / รอตรวจ / กักกัน / รอแก้ไข หรือเว้นว่าง`);
      // already in the system at the same place
      if (r.item && whRow && !r.errors.length && !r.skip) {
        const bal = (state.tables.balances || {})[RRS.balanceKey({ code: r.item.id, wh: r.wh, bin: r.bin, status: r.status, lot: r.lot })];
        const have = bal ? bal.qty : 0;
        if (have) r.warns.push(`ตำแหน่งนี้มียอดในระบบอยู่แล้ว ${fmtU(have, r.item.baseUnit)} – ยอดตั้งต้นจะบวกเพิ่ม (หลังบันทึก ${fmtU(have + r.base, r.item.baseUnit)}) ตรวจว่าไม่ได้นำเข้าซ้ำ`);
      }
      out.rows.push(r);
    }
    // duplicate rows (same item, warehouse, bin, lot, status) and codes written differently that read the same
    const byKey = {};
    const spell = {};
    for (const r of out.rows) {
      const ik = r.item ? r.item.id : 'raw:' + util.ckey(r.raw.code);
      const key = [ik, r.wh, r.bin, r.lot, r.status].join('|');
      (byKey[key] || (byKey[key] = [])).push(r);
      if (r.item) (spell[r.item.id] || (spell[r.item.id] = new Set())).add(util.normCode(r.raw.code));
    }
    for (const key in byKey) {
      const g = byKey[key];
      if (g.length < 2) continue;
      for (const r of g) r.errors.push(`ซ้ำกับแถว ${g.filter((x) => x !== r).map((x) => x.n).join(', ')} (สินค้า คลัง ช่องเก็บ ล็อตเดียวกัน) – รวมจำนวนเป็นแถวเดียว`);
    }
    for (const r of out.rows) {
      const s = r.item && spell[r.item.id];
      if (s && s.size > 1) r.warns.push(`ในไฟล์เขียนรหัสนี้ต่างกัน (${Array.from(s).join(', ')}) แต่อ่านเป็น ${r.item.id} รายการเดียวกัน`);
    }
    // the same serial number twice in the file, or already in stock
    const serials = {};
    for (const r of out.rows) {
      if (!r.item || r.item.trackLot !== 'serial' || !r.lot || r.skip) continue;
      (serials[r.item.id + '|' + r.lot] || (serials[r.item.id + '|' + r.lot] = [])).push(r);
    }
    for (const sk in serials) {
      const g = serials[sk];
      const r0 = g[0];
      if (g.length > 1) {
        for (const r of g) {
          const others = g.filter((x) => x !== r).map((x) => x.n).join(', ');
          if (!r.errors.some((e) => e.indexOf('ซ้ำกับแถว') === 0)) r.errors.push(`Serial ${r.lot} ของ ${r.item.id} อยู่ในแถว ${others} ด้วย – Serial เดียวอยู่ได้ที่เดียว`);
        }
      }
      // anywhere, also the same place (the opening adds on top: one serial would become two units)
      const where = RRS.q.rows(state, 'balances', (b) => b.code === r0.item.id && b.lot === r0.lot && b.qty > 0);
      if (where.length) {
        for (const r of g) r.errors.push(`Serial ${r.lot} ของ ${r.item.id} มีในระบบแล้วที่ ${where.map((b) => (b.wh === TRANSIT ? 'ระหว่างโอน' : b.wh + (b.bin ? '/' + b.bin : ''))).join(', ')} – ตรวจว่าไม่ได้นับซ้ำ`);
      }
    }
    // the same file posted before
    const docs = RRS.q.rows(state, 'documents', (d) => isOpening(d) && d.status !== 'CANCELLED' && d.status !== 'DRAFT');
    const same = docs.find((d) => d.source === 'opening:' + src.hash);
    if (same) out.fatal.push(`ไฟล์นี้ (เนื้อหาเดียวกันทุกตัวอักษร) บันทึกเป็น ${same.docNo} แล้วเมื่อ ${h.fmt.dt(same.postedAt)} – ไม่บันทึกซ้ำ ถ้าต้องการแก้ ให้ยกเลิกใบเดิมที่หน้าเอกสารก่อน`);
    const sameName = docs.find((d) => d.ref === src.name && d.source !== 'opening:' + src.hash);
    if (sameName) out.warnFile.push(`มีใบยอดตั้งต้น ${sameName.docNo} ที่อ้างอิงชื่อ "${src.name}" อยู่แล้ว (เนื้อหาต่างกัน) – ตรวจว่าไม่ได้นำเข้ายอดชุดเดียวกันซ้ำ`);
    // counts
    for (const r of out.rows) {
      out.counts.all++;
      if (r.errors.length) out.counts.bad++;
      else if (r.skip) out.counts.skip++;
      else if (r.warns.length) out.counts.warn++;
      else out.counts.ok++;
    }
    out.post = out.rows.filter((r) => !r.errors.length && !r.skip);
    out.items = new Set(out.post.map((r) => r.item.id)).size;
    if (!out.counts.bad && !out.post.length && !out.fatal.length) out.fatal.push('ไม่มีแถวที่จำนวนมากกว่า 0 – ไม่มียอดให้บันทึก');
    return out;
  }

  function rowState(r) {
    if (r.errors.length) return 'bad';
    if (r.skip) return 'skip';
    if (r.warns.length) return 'warn';
    return 'ok';
  }

  // ---- step 2: one AJ document -------------------------------------------------------------------------------
  function payloadOf(res, src, cut) {
    return {
      type: 'AJ', date: cut.date, ref: util.trim(src.name).slice(0, 120), remark: `ยอดตั้งต้น ณ ${cut.text}`, source: 'opening:' + src.hash,
      lines: res.post.map((r) => ({ code: r.item.id, qty: r.qty, unit: r.unit, wh: r.wh, bin: r.bin, lot: r.lot, status: r.status, remark: `แถว ${r.n} ในไฟล์` })),
    };
  }
  /** Dry run of the posting (same checks as the real one) and the size of the commit it would make. */
  let preCache = null;
  function preflight(ctx, payload) {
    const key = `${ctx.state.seq}|${ctx.user && ctx.user.id}|${util.sha256(util.stable(payload))}`;
    if (preCache && preCache.key === key) return preCache.r;
    const p = ctx.check('doc.post', payload);
    const r = { ok: !!p.ok, errors: p.errors || [], size: p.ok && p.commit ? JSON.stringify(p.commit).length : 0 };
    preCache = { key, r };
    return r;
  }

  // ---- step 3: reconciliation from the document's own movements -----------------------------------------------
  function recon(ctx, docNo) {
    const d = RRS.q.get(ctx.state, 'documents', docNo);
    if (!d) return null;
    const seqN = (m) => m.seq * 1e6 + Number(String(m.id).split('.')[1] || 0);
    const moves = RRS.q.rows(ctx.state, 'movements', (m) => m.docNo === docNo && m.docType === d.type && !m.reversalOf).sort((a, b) => seqN(a) - seqN(b));
    const locs = {};
    for (const m of moves) {
      const k = RRS.balanceKey(m);
      const l = locs[k] || (locs[k] = { code: m.code, before: util.round(m.balanceAfter - m.qty), after: 0, posted: 0 });
      l.after = m.balanceAfter;
      l.posted = util.round(l.posted + m.qty);
    }
    const per = {};
    const row = (code) => per[code] || (per[code] = { code, expected: 0, posted: 0, before: 0, after: 0, locs: 0 });
    for (const l of (d.lines || [])) row(l.code).expected = util.round(row(l.code).expected + (l.base || 0));
    for (const k in locs) {
      const l = locs[k];
      const r = row(l.code);
      r.posted = util.round(r.posted + l.posted);
      r.before = util.round(r.before + l.before);
      r.after = util.round(r.after + l.after);
      r.locs++;
    }
    const rows = Object.values(per).sort((a, b) => a.code.localeCompare(b.code));
    for (const r of rows) {
      r.diff = util.round(r.after - r.expected);
      r.result = r.posted !== r.expected ? 'bad' : r.before ? 'warn' : 'ok';
    }
    return { d, rows, lines: (d.lines || []).length, okAll: rows.every((r) => r.result === 'ok'), badN: rows.filter((r) => r.result === 'bad').length, warnN: rows.filter((r) => r.result === 'warn').length };
  }

  function reconView(ctx, docNo) {
    const rc = recon(ctx, docNo);
    if (!rc) return h.empty('ไม่พบเอกสาร ' + docNo, 'เอกสารอาจถูกลบไปแล้ว (ร่าง) – เลือกจากรายการใบยอดตั้งต้น');
    const d = rc.d;
    const items = ctx.state.tables.items || {};
    const backupId = pageId(['backup', 'backups', 'restore'], /สำรอง|กู้คืน/);
    const tests = RRS.q.rows(ctx.state, 'backup_tests', (b) => (b.at || '') >= (d.postedAt || '') && b.result === 'OK').sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const table = h.table({ id: 'op-recon', rows: rc.rows, dense: true,
      rowCls: (r) => (r.result === 'bad' ? 'row-bad' : r.result === 'warn' ? 'row-warn' : ''),
      cols: [
        { label: 'สินค้า', render: (r) => t`${h.code(r.code)}<br><small class="muted">${(items[r.code] || {}).name || ''}</small>` },
        { label: 'ตำแหน่ง', num: true, key: 'locs' },
        { label: 'ตามไฟล์', num: true, render: (r) => h.fmt.num(r.expected) },
        { label: 'ยอดเดิมก่อนบันทึก', num: true, render: (r) => (r.before ? h.fmt.num(r.before) : dash) },
        { label: 'หลังบันทึก', num: true, render: (r) => t`<b>${h.fmt.num(r.after)}</b>` },
        { label: 'ผลต่าง (หลัง − ไฟล์)', num: true, render: (r) => (r.diff ? `${r.diff > 0 ? '+' : ''}${h.fmt.num(r.diff)}` : '0') },
        { label: 'หน่วย', get: (r) => (items[r.code] || {}).baseUnit || '' },
        { label: 'ผล', render: (r) => (r.result === 'ok' ? h.badge('ตรง', 'ok') : r.result === 'warn' ? h.badge('มียอดเดิมอยู่ก่อน', 'warn') : h.badge('ไม่ตรง', 'bad')) },
      ] });
    const cancelled = d.status === 'CANCELLED';
    const verdict = cancelled ? '' : rc.badN
      ? h.note(`ยอดไม่ตรง ${rc.badN} รายการ – ห้ามเริ่มใช้งานจริง ยกเลิกใบ ${d.docNo} ที่หน้าเอกสาร (ระบบกลับรายการทุกบรรทัด) แล้วแจ้งผู้ดูแลระบบ`, 'bad')
      : rc.warnN
        ? h.note(`บันทึกครบตามไฟล์ แต่ ${rc.warnN} รายการมียอดในระบบอยู่ก่อนแล้ว ยอดหลังบันทึกจึงมากกว่าไฟล์ – ตรวจว่าไม่ได้นำเข้าซ้ำ ถ้าผิดให้ยกเลิกใบ ${d.docNo} แล้วนำเข้าใหม่`, 'warn')
        : h.note(`ยอดหลังบันทึกตรงกับไฟล์ทุกรายการ (${rc.rows.length} รายการ ${rc.lines} บรรทัด)`, 'ok');
    const restore = cancelled ? '' : tests.length
      ? h.note(t`บันทึกผลทดสอบกู้คืนหลังย้ายยอดแล้ว: ${h.fmt.dt(tests[0].at)} โดย ${ctx.userName(tests[0].by)}${tests[0].note ? ' · ' + tests[0].note : ''}`, 'ok')
      : h.note(t`<b>ขั้นสุดท้ายก่อนเริ่มใช้งานจริง: ทดสอบกู้คืน</b> – สำรองข้อมูลตอนนี้ กู้คืนลงที่ทดสอบ (ไม่ใช่ข้อมูลจริง) เปิดดูว่ายอดตรงกับตารางนี้ แล้วบันทึกผลที่หน้า ${goLink('สำรองและกู้คืน', backupId)} · ถ้ากู้คืนไม่ได้ ห้ามเริ่มใช้งานจริง`, 'warn');
    return t`${cancelled ? h.note(`ใบนี้ถูกยกเลิกแล้ว ${h.fmt.dt(d.cancelledAt)} โดย ${ctx.userName(d.cancelledBy)}: ${d.cancelReason} – ยอดตั้งต้นชุดนี้ถูกกลับรายการแล้ว ตัวเลขด้านล่างเป็นผล ณ ตอนบันทึก ถ้าจะใช้ยอดชุดนี้ ให้นำเข้าไฟล์ใหม่อีกครั้ง`, 'bad') : ''}
      ${h.dl([['เอกสาร', h.link(d.docNo, 'docs', docView(d.docNo))], ['สถานะ', h.docStatus(d.status)], ['ลงวันที่', h.fmt.date(d.date)],
        ['หมายเหตุในใบ', d.remark], ['อ้างอิง (ไฟล์)', d.ref], ['บันทึกโดย', d.postedBy ? `${ctx.userName(d.postedBy)} · ${h.fmt.dt(d.postedAt)}` : '']])}
      ${verdict}${table}
      <p class="hint">ตามไฟล์ = ผลรวมจำนวนในไฟล์ (แปลงเป็นหน่วยหลัก) · ยอดเดิม/หลังบันทึก = ยอดของตำแหน่งในไฟล์ ก่อนและหลังใบนี้ อ่านจากประวัติเคลื่อนไหวของใบนี้</p>
      ${restore}
      <div class="form-actions">${h.btn('ดาวน์โหลดรายงานกระทบยอด (CSV)', { act: 'reconCsv', arg: d.docNo, tone: 'ghost' })}${h.link('ดูยอดคงเหลือ', 'stock', { tab: 'item' })}${h.link('ดูประวัติของใบนี้', 'history', { code: '', docNo: d.docNo, wh: '', lot: '', job: '', from: '', to: '', type: '', more: 0 })}</div>`;
  }

  // ---- screen parts ---------------------------------------------------------------------------------------------
  function stepsBar(step) {
    const list = [
      ['1', 'ตรวจไฟล์', 'วางหรือเลือกไฟล์ ระบบตรวจรหัส คลัง ช่องเก็บ หน่วย และแถวซ้ำ ยังไม่เปลี่ยนยอด'],
      ['2', 'บันทึกเป็นใบ AJ ใบเดียว', 'ทั้งไฟล์หรือไม่บันทึกเลย – มีแถวผิดแถวเดียวก็บันทึกไม่ได้'],
      ['3', 'กระทบยอดและทดสอบกู้คืน', 'เทียบยอดในไฟล์กับยอดหลังบันทึก แล้วบันทึกผลทดสอบกู้คืน'],
    ];
    return t`<div class="steps">${list.map(([n, title, text]) => t`<div class="step"><span class="step-n">ขั้น ${n} ${Number(n) === step ? h.badge('ทำอยู่', 'accent') : Number(n) < step ? h.badge('เสร็จ', 'ok') : ''}</span><b>${title}</b><small>${text}</small></div>`)}</div>`;
  }

  const roleNames = (perm) => RRS.auth.rolesFor(perm).map((r) => RRS.auth.ROLES[r] || r).join(' หรือ ');

  function cutoffBox(ctx, cut, readOnly) {
    const sid = pageId(['setup', 'settings'], /ค่าตั้ง|นโยบาย/);
    const where = sid ? t`${h.link(RRS.ui.pages[sid].title, sid, sid === 'setup' ? { tab: 'scope' } : null)}${sid === 'setup' ? ' แท็บ ขอบเขตทดลอง' : ''}` : t`<b>ค่าตั้งระบบ</b>`;
    const who = roleNames('settings.edit');
    if (!cut) {
      return h.note(t`<b>ยังไม่ได้ตั้งเวลาตัดยอด</b> – ให้${who}ตั้งที่หน้า ${where} ก่อน${readOnly ? '' : ' (ตรวจไฟล์ได้ แต่บันทึกไม่ได้จนกว่าจะตั้ง)'}`, 'warn');
    }
    if (cut.bad) return h.note(t`เวลาตัดยอดในค่าตั้งระบบอ่านไม่ได้ ("${cut.raw}") – ให้${who}แก้เป็นวันที่และเวลาที่หน้า ${where}`, 'bad');
    return h.note(t`<b>เวลาตัดยอด ${cut.text}</b> (จากค่าตั้งระบบ) – ยอดในไฟล์ต้องเป็นยอดนับจริง ณ เวลานี้ ใบ AJ จะลงวันที่ ${h.fmt.date(cut.date)} พร้อมหมายเหตุ "ยอดตั้งต้น ณ ${cut.text}" · ของที่รับ–จ่ายหลังเวลานี้ให้บันทึกเป็นเอกสารตามปกติหลังย้ายยอด อย่ารวมในไฟล์`, 'info');
  }

  function inputStep(ctx) {
    const v = ctx.view;
    const items = RRS.q.rows(ctx.state, 'items').length;
    const whs = RRS.q.rows(ctx.state, 'warehouses').length;
    const missing = !items || !whs
      ? h.note(t`ยังไม่มี${!items ? 'ทะเบียนสินค้า' : ''}${!items && !whs ? 'และ' : ''}${!whs ? 'คลัง' : ''}ในระบบ – ทุกแถวต้องอ้างรหัสที่มีอยู่แล้ว เพิ่มที่หน้า ${goLink('ทะเบียนสินค้า', pageId(['items'], /ทะเบียนสินค้า/))}${!whs ? t` และ ${goLink('คลังและช่องเก็บ', pageId(['warehouses', 'locations'], /คลัง/))}` : ''} ก่อน`, 'warn')
      : '';
    return h.section('ขั้น 1 · วางหรือเลือกไฟล์ยอดนับ', t`${missing}
      <p class="hint">คอลัมน์: <b>${HEADER.join(', ')}</b> (แถวแรกเป็นหัวตาราง) · ช่องเก็บและล็อตเว้นว่างได้ถ้าไม่ใช้ · หน่วยว่าง = หน่วยหลัก · มีคอลัมน์ สถานะ ได้ (ไม่ใส่ = ใช้ได้) · ระบบหาสินค้าจากรหัสหลัก รหัส Express หรือรหัสนับสต็อกเท่านั้น ไม่จับคู่จากชื่อ</p>
      ${v.readErr ? h.note(v.readErr, 'bad') : ''}
      ${h.form({ name: 'read', submit: 'ตรวจข้อมูล', extra: h.btn('ดาวน์โหลดแบบฟอร์ม CSV', { act: 'template', tone: 'ghost' }), body: [
        h.field({ name: 'file', label: 'ไฟล์ยอดนับ (.csv .xlsx)', type: 'file', accept: '.csv,.txt,.tsv,.xlsx,.xls', wide: true, id: 'op-file' }),
        h.field({ name: 'text', label: 'หรือวางข้อมูลจาก Excel / CSV', type: 'textarea', rows: 8, wide: true, value: v.text, placeholder: `${HEADER.join(',')}\nDEMO-A-001,01,A-01,,12,ชิ้น`, id: 'op-text' }),
        h.field({ name: 'name', label: 'อ้างอิง (ไม่ใส่ = ชื่อไฟล์)', value: v.refName, placeholder: 'เช่น ใบนับคลัง 01 วันที่ 1 พ.ย.', wide: true, id: 'op-name' }),
      ] })}`);
  }

  /**
   * The check table: one record = a row with what the file says and what it reads as, then (when there is something
   * to say) a full-width row with the reasons – on a phone the reasons get the whole width instead of a thin column.
   */
  const ROW_CLS = { bad: 'row-bad', warn: 'row-warn', skip: 'muted', ok: '' };
  const ROW_BADGE = { bad: ['ต้องแก้', 'bad'], warn: ['ตรวจคำเตือน', 'warn'], skip: ['ข้าม (จำนวน 0)', 'muted'], ok: ['ผ่าน', 'ok'] };
  function checkTable(rows) {
    if (!rows.length) return h.empty('ไม่มีแถวในกลุ่มนี้', 'เลือกแท็บอื่นเพื่อดูแถวที่เหลือ');
    const body = rows.map((r) => {
      const st = rowState(r);
      const cls = ROW_CLS[st];
      const where = [r.wh || r.raw.wh, r.bin || r.raw.bin].filter(Boolean).join(' / ');
      const q = util.num(r.raw.qty);
      // the quantity exactly as written when it is not a usable number (letters, minus …)
      const qtyText = r.raw.qty === '' ? dash : isNaN(q) || q < 0 ? t`<b>${r.raw.qty}</b>` : h.fmt.num(q);
      const unit = r.raw.unit || (r.item ? r.item.baseUnit : '');
      const file = t`${r.raw.code ? h.code(r.raw.code) : t`<span class="muted">ไม่มีรหัส</span>`}<br><small>${where || 'ไม่มีคลัง'}${r.lot ? ` · ล็อต ${r.lot}` : ''}</small><br>${qtyText} <span class="unit">${unit}</span>${r.status && r.status !== 'AVAILABLE' ? t` ${h.statusBadge(r.status)}` : ''}`;
      const read = r.item ? t`${h.code(r.item.id)}<br><small class="muted">${r.item.name}</small>${r.factor !== 1 && !r.errors.length ? t`<br><small>= ${h.fmt.num(r.base)} ${r.item.baseUnit}</small>` : ''}` : dash;
      const msgs = r.errors.length || r.warns.length
        ? t`<tr class="${cls}"><td colspan="3"><ul class="errs">${r.errors.map((e) => t`<li>${e}</li>`)}${r.warns.map((w) => t`<li class="muted">${w}</li>`)}</ul></td></tr>` : '';
      return t`<tr class="${cls}" data-row="${r.n}"><td>${h.fmt.num(r.n)}<br>${h.badge(ROW_BADGE[st][0], ROW_BADGE[st][1])}</td><td>${file}</td><td>${read}</td></tr>${msgs}`;
    });
    return t`<div class="tbl-wrap" id="op-check"><table class="tbl dense"><thead><tr><th>แถว · ผล</th><th>ในไฟล์</th><th>อ่านเป็น</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function checkStep(ctx, cut, res, step) {
    const v = ctx.view;
    const src = v.src;
    const c = res.counts;
    const tab = v.ftab || (c.bad ? 'bad' : 'all');
    const shown = res.rows.filter((r) => tab === 'all' || rowState(r) === tab);
    const limit = STEP * (1 + (v.more || 0));
    const table = checkTable(shown.slice(0, limit));
    const more = shown.length > limit ? t`<p class="hint">แสดง ${h.fmt.num(limit)} จาก ${h.fmt.num(shown.length)} แถว ${h.btn('แสดงเพิ่ม', { act: 'more', tone: 'ghost', small: true })}</p>` : '';
    const kp = h.kpis([
      h.kpi('แถวในไฟล์', h.fmt.num(c.all), src.name),
      h.kpi('ผ่าน', h.fmt.num(c.ok), 'พร้อมบันทึก', 'ok'),
      h.kpi('คำเตือน', h.fmt.num(c.warn), 'บันทึกได้เมื่อยืนยันว่าตรวจแล้ว', c.warn ? 'warn' : ''),
      h.kpi('ต้องแก้', h.fmt.num(c.bad), c.bad ? 'แก้ในไฟล์แล้วตรวจใหม่' : 'ไม่มี', c.bad ? 'bad' : 'ok'),
      h.kpi('ข้าม (จำนวน 0)', h.fmt.num(c.skip), 'ไม่ใส่ในใบ AJ'),
    ]);
    const tabs = h.tabs([{ id: 'all', label: 'ทั้งหมด', count: c.all }, { id: 'bad', label: 'ต้องแก้', count: c.bad }, { id: 'warn', label: 'คำเตือน', count: c.warn },
      { id: 'skip', label: 'ข้าม', count: c.skip }, { id: 'ok', label: 'ผ่าน', count: c.ok }], tab, 'ftab');

    let action;
    const back = h.btn('แก้ไฟล์แล้วตรวจใหม่', { act: 'restart', tone: 'ghost' });
    const dl = c.all ? h.btn('ดาวน์โหลดผลตรวจ (CSV)', { act: 'checkCsv', tone: 'ghost' }) : '';
    if (res.fatal.length) {
      action = t`${h.note(t`บันทึกไม่ได้${h.errors({ errors: res.fatal.map((m) => ({ message: m })) })}`, 'bad')}<div class="form-actions">${back}${dl}</div>`;
    } else if (c.bad) {
      action = t`${h.note(`บันทึกไม่ได้ – มี ${h.fmt.num(c.bad)} แถวที่ต้องแก้ ระบบบันทึกทั้งไฟล์หรือไม่บันทึกเลย แก้ในไฟล์ (ดาวน์โหลดผลตรวจไปดูได้) แล้วตรวจใหม่`, 'bad')}<div class="form-actions">${back}${dl}</div>`;
    } else if (!cut || cut.bad) {
      action = t`${cutoffBox(ctx, cut)}<div class="form-actions">${back}${dl}</div>`;
    } else {
      const payload = payloadOf(res, src, cut);
      const pre = preflight(ctx, payload);
      const kb = Math.ceil(pre.size / 1024);
      const maxLines = pre.size ? Math.max(1, Math.floor(LIMIT / (pre.size / payload.lines.length))) : 0;
      const tooBig = pre.ok && pre.size > LIMIT;
      const needAck = c.warn > 0;
      const summary = h.dl([['จะสร้าง', 'ใบปรับปรุงยอด AJ 1 ใบ'], ['บรรทัด', `${h.fmt.num(payload.lines.length)} บรรทัด · ${h.fmt.num(res.items)} สินค้า`],
        ['ลงวันที่', h.fmt.date(cut.date)], ['หมายเหตุในใบ', payload.remark], ['อ้างอิง', payload.ref]]);
      // errors of a refused posting stay shown only while nothing else has changed (else the fresh dry run decides)
      const own = v.postErr && v.postErr.seq === ctx.state.seq && v.postErr.errors.length ? v.postErr.errors : null;
      const errs = own || (!pre.ok ? pre.errors : null);
      action = t`${summary}
        ${res.warnFile.map((w) => h.note(w, 'warn'))}
        ${errs ? h.note(t`ตรวจกับยอดในระบบแล้วบันทึกไม่ได้ – ยังไม่มีอะไรเปลี่ยน${h.errors({ errors: errs.slice(0, 12) })}${errs.length > 12 ? t`<p>และอีก ${errs.length - 12} ข้อ</p>` : ''}`, 'bad') : ''}
        ${tooBig ? h.note(`ไฟล์นี้ใหญ่เกินกว่าจะบันทึกเป็นใบเดียว (ประมาณ ${kb} KB เก็บได้ไม่เกิน ${Math.floor(LIMIT / 1024)} KB) – แบ่งไฟล์ตามคลังหรือกลุ่มสินค้า ครั้งละไม่เกินประมาณ ${h.fmt.num(maxLines)} แถว แล้วนำเข้าทีละไฟล์`, 'bad') : ''}
        ${needAck ? h.field({ name: 'ack', label: `ตรวจคำเตือน ${h.fmt.num(c.warn)} แถวแล้ว ยืนยันว่ารหัสและยอดถูกต้อง`, type: 'checkbox', value: v.ack, id: 'op-ack' }) : ''}
        <div class="form-actions">${h.btn('บันทึกยอดตั้งต้น (AJ 1 ใบ)', { act: 'post', tone: 'primary', id: 'op-post', disabled: !pre.ok || tooBig || (needAck && !v.ack) || !ctx.can('doc.postAdjust') })}${back}${dl}</div>`;
    }
    // the check table belongs to step 1 until the file passes; then the same screen is step 2 (post one AJ)
    return h.section(t`ขั้น ${step} · ผลตรวจ ${src.name}`, t`${kp}${tabs}${table}${more}${action}`, {
      sub: step === 2 ? 'ตรวจผ่าน – ยังไม่มีอะไรเปลี่ยนจนกว่าจะกด บันทึกยอดตั้งต้น' : 'ยังไม่มีอะไรเปลี่ยน – ตรวจทุกแถวกับทะเบียนสินค้า คลัง ช่องเก็บ หน่วย และยอดที่มีอยู่ แก้แถวที่ต้องแก้ในไฟล์แล้วตรวจใหม่' });
  }

  function historyList(ctx) {
    const v = ctx.view;
    const docs = RRS.q.rows(ctx.state, 'documents', (d) => isOpening(d) && d.status !== 'DRAFT').sort((a, b) => String(b.postedAt || '').localeCompare(String(a.postedAt || '')));
    const body = h.table({ rows: docs, dense: true, rowAct: 'pickDoc', rowArg: (d) => d.docNo, rowCls: (d) => (d.docNo === v.pick ? 'sel' : ''),
      empty: 'ยังไม่มีใบยอดตั้งต้น', emptyText: 'เมื่อบันทึกขั้น 2 แล้ว ใบ AJ จะขึ้นที่นี่ คลิกเพื่อดูการกระทบยอดย้อนหลัง',
      cols: [{ label: 'เลขที่', render: (d) => h.code(d.docNo) }, { label: 'ลงวันที่', get: (d) => h.fmt.date(d.date) }, { label: 'อ้างอิง', key: 'ref' },
        { label: 'บรรทัด', num: true, get: (d) => (d.lines || []).length }, { label: 'สถานะ', render: (d) => h.docStatus(d.status) },
        { label: 'บันทึกโดย', get: (d) => `${ctx.userName(d.postedBy)} · ${h.fmt.dt(d.postedAt)}` }] });
    const pick = v.pick && v.pick !== v.posted ? h.section(t`กระทบยอด ${v.pick}`, reconView(ctx, v.pick), { actions: h.btn('ปิด', { act: 'unpick', tone: 'quiet', small: true }) }) : '';
    return t`${h.section('ใบยอดตั้งต้นที่บันทึกแล้ว', body, { sub: 'ใบ AJ ที่สร้างจากหน้านี้ · ถ้ายอดผิด ให้ยกเลิกใบที่หน้าเอกสาร (ระบบกลับรายการทุกบรรทัด ประวัติยังอยู่) แล้วนำเข้าใหม่' })}${pick}`;
  }

  RRS.ui.page({
    id: 'opening', title: 'ย้ายยอดตั้งต้น', phase: 1, order: 40, perm: 'doc.postAdjust',
    sub: 'นำยอดนับจริง ณ เวลาตัดยอดเข้าระบบเป็นใบปรับปรุงยอด (AJ) ใบเดียว – ทั้งไฟล์หรือไม่บันทึกเลย แล้วกระทบยอดและทดสอบกู้คืนก่อนเริ่มใช้งานจริง',
    render(ctx) {
      const v = ctx.view;
      const cut = cutoff(ctx.state);
      const can = ctx.can('doc.postAdjust');
      if (!can) {
        return t`${h.note(`หน้านี้ใช้ได้เฉพาะผู้มีสิทธิ์บันทึกปรับปรุงยอด (${roleNames('doc.postAdjust')}) – ดูผลกระทบยอดของใบที่บันทึกแล้วได้ด้านล่าง`, 'warn')}
          ${cutoffBox(ctx, cut, true)}${historyList(ctx)}`;
      }
      const res = !v.posted && v.src ? check(ctx, v.src) : null;
      const ready = !!res && !res.fatal.length && !res.counts.bad;
      const step = v.posted ? 3 : ready ? 2 : 1;
      let body;
      if (step === 3) {
        body = h.section(t`ขั้น 3 · กระทบยอด ${v.posted}`, reconView(ctx, v.posted), {
          sub: 'เทียบยอดในไฟล์กับยอดหลังบันทึก รายสินค้า', actions: h.btn('ย้ายยอดชุดใหม่', { act: 'restart', tone: 'ghost', small: true }) });
      } else if (res) body = checkStep(ctx, cut, res, step);
      else body = inputStep(ctx);
      return t`${stepsBar(step)}${step !== 2 ? cutoffBox(ctx, cut) : ''}${body}${historyList(ctx)}`;
    },
    after(ctx, root0) {
      const ack = root0.querySelector('#op-ack');
      if (ack) ack.addEventListener('change', () => ctx.set({ ack: ack.checked }));
      for (const id of ['op-check', 'op-recon']) {
        const box = root0.querySelector('#' + id);
        if (box) box.style.maxHeight = '70vh';
      }
    },
    forms: {
      async read(ctx, values, form) {
        const fileEl = form.querySelector('input[type=file]');
        const f = fileEl && fileEl.files && fileEl.files[0];
        const refName = util.trim(values.name);
        let src;
        try {
          if (f) {
            const tb = await h.readTable(f);
            src = { name: refName || tb.name, hash: tb.hash, rows: tb.rows };
          } else {
            const text = String(values.text || '');
            if (!text.trim()) return ctx.set({ readErr: 'ยังไม่มีข้อมูล – เลือกไฟล์ หรือวางข้อมูลจาก Excel ในช่องด้านบน', text: '', refName });
            src = { name: refName || `ข้อมูลที่วาง ${h.fmt.date(ctx.today)}`, hash: util.sha256(text.replace(/\r\n/g, '\n').trim()), rows: h.parseCsv(text) };
          }
        } catch (e) {
          return ctx.set({ readErr: 'อ่านไฟล์ไม่ได้: ' + ((e && e.message) || e), text: values.text, refName });
        }
        ctx.set({ src, text: values.text, refName, readErr: '', ack: false, postErr: null, ftab: null, more: 0, posted: null });
      },
    },
    actions: {
      ftab: (ctx, el) => ctx.set({ ftab: el.dataset.arg, more: 0 }),
      more: (ctx) => ctx.set({ more: (ctx.view.more || 0) + 1 }),
      restart: (ctx) => ctx.set({ src: null, posted: null, ack: false, postErr: null, ftab: null, more: 0 }),
      pickDoc: (ctx, el) => ctx.set({ pick: el.dataset.arg }),
      unpick: (ctx) => ctx.set({ pick: null }),
      async template(ctx) {
        const it = RRS.q.rows(ctx.state, 'items', (i) => i.active !== false).sort((a, b) => a.id.localeCompare(b.id))[0];
        const wh = RRS.q.rows(ctx.state, 'warehouses', (w) => w.active !== false).sort((a, b) => a.code.localeCompare(b.code))[0];
        const bin = wh ? RRS.q.rows(ctx.state, 'bins', (b) => b.wh === wh.code && b.active !== false)[0] : null;
        const example = [it ? it.id : 'DEMO-A-001', wh ? wh.code : '01', bin ? bin.code : '', '', '', it ? it.baseUnit : 'ชิ้น'];
        await ctx.download('opening-balance-template.csv', csvText([HEADER, example]));
      },
      async checkCsv(ctx) {
        const res = check(ctx, ctx.view.src);
        const out = [['แถว', 'รหัสในไฟล์', 'อ่านเป็น', 'ชื่อสินค้า', 'คลัง', 'ช่องเก็บ', 'ล็อต', 'จำนวน', 'หน่วย', 'จำนวนหน่วยหลัก', 'สถานะของ', 'ผลตรวจ', 'รายละเอียด']];
        for (const r of res.rows) {
          const st = rowState(r);
          out.push([r.n, r.raw.code, r.item ? r.item.id : '', r.item ? r.item.name : '', r.wh || r.raw.wh, r.bin || r.raw.bin, r.lot, r.raw.qty, r.unit, r.item && !r.errors.length ? r.base : '',
            STATUS_LABEL[r.status] || r.raw.status, { bad: 'ต้องแก้', warn: 'คำเตือน', skip: 'ข้าม', ok: 'ผ่าน' }[st], r.errors.concat(r.warns).join(' | ')]);
        }
        await ctx.download(`opening-check-${ctx.today}.csv`, csvText(out));
      },
      async reconCsv(ctx, el) {
        const rc = recon(ctx, el.dataset.arg);
        if (!rc) return;
        const items = ctx.state.tables.items || {};
        const out = [['เอกสาร', rc.d.docNo, 'ลงวันที่', h.fmt.date(rc.d.date), 'หมายเหตุ', rc.d.remark],
          ['รหัสสินค้า', 'ชื่อสินค้า', 'ตำแหน่ง', 'ตามไฟล์', 'ยอดเดิมก่อนบันทึก', 'หลังบันทึก', 'ผลต่าง (หลัง − ไฟล์)', 'หน่วย', 'ผล']];
        for (const r of rc.rows) {
          out.push([r.code, (items[r.code] || {}).name || '', r.locs, r.expected, r.before, r.after, r.diff, (items[r.code] || {}).baseUnit || '',
            r.result === 'ok' ? 'ตรง' : r.result === 'warn' ? 'มียอดเดิมอยู่ก่อน' : 'ไม่ตรง']);
        }
        await ctx.download(`opening-reconcile-${rc.d.docNo}.csv`, csvText(out));
      },
      async post(ctx) {
        const v = ctx.view;
        if (!v.src) return;
        const cut = cutoff(ctx.state);
        if (!cut || cut.bad) return ctx.toast('ตั้งเวลาตัดยอดที่ค่าตั้งระบบก่อน', 'warn');
        const res = check(ctx, v.src);
        if (res.fatal.length) return ctx.toast(res.fatal[0], 'bad');
        if (res.counts.bad) return ctx.toast(`ยังมี ${res.counts.bad} แถวที่ต้องแก้ – บันทึกไม่ได้`, 'bad');
        if (res.counts.warn && !v.ack) return ctx.toast('ติ๊ก ตรวจคำเตือนแล้ว ก่อนบันทึก', 'warn');
        const payload = payloadOf(res, v.src, cut);
        const pre = preflight(ctx, payload);
        if (!pre.ok) return ctx.set({ postErr: { seq: ctx.state.seq, errors: pre.errors } });
        if (pre.size > LIMIT) return ctx.toast('ไฟล์ใหญ่เกินกว่าจะบันทึกเป็นใบเดียว – แบ่งไฟล์แล้วนำเข้าทีละไฟล์', 'bad');
        const ok = await ctx.confirm({ title: 'บันทึกยอดตั้งต้น',
          message: `สร้างใบปรับปรุงยอด AJ 1 ใบ ${payload.lines.length} บรรทัด (${res.items} สินค้า) ลงวันที่ ${h.fmt.date(cut.date)} – ยอดคงเหลือเปลี่ยนทันที ทั้งใบหรือไม่เปลี่ยนเลย`,
          ok: 'บันทึกยอดตั้งต้น' });
        if (!ok) return;
        // The same content carries the same request id, so a second click / resend never posts twice. Each cancelled
        // posting of this content starts a new id: after a cancel the same file can be posted again on purpose.
        const live = () => RRS.q.rows(ctx.state, 'documents', (d) => d.source === payload.source && d.status !== 'CANCELLED' && d.status !== 'DRAFT')[0];
        const gen = RRS.q.rows(ctx.state, 'documents', (d) => d.source === payload.source && d.status === 'CANCELLED').length;
        const requestId = 'opening-' + util.sha256(util.stable(payload) + '#' + gen).slice(0, 40);
        const r = await ctx.exec('doc.post', payload, { quiet: true, requestId });
        if (!r.ok) return ctx.set({ postErr: { seq: ctx.state.seq, errors: r.errors } });
        const doc = (r.result && r.result.docNo && RRS.q.get(ctx.state, 'documents', r.result.docNo)) || live();
        if (!doc) {
          return ctx.set({ postErr: { seq: ctx.state.seq, errors: [{ message: 'ระบบรับคำสั่งนี้ไปแล้วก่อนหน้า แต่ไม่พบใบยอดตั้งต้นที่ยังใช้อยู่ – โหลดหน้าใหม่แล้วตรวจไฟล์อีกครั้ง' }] } });
        }
        if (!r.duplicate) ctx.toast(`บันทึกยอดตั้งต้น ${doc.docNo} แล้ว – ตรวจการกระทบยอดด้านล่าง`, 'ok');
        ctx.set({ posted: doc.docNo, pick: null, postErr: null, ack: false });
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
