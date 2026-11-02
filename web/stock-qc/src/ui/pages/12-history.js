/*
 * Phase 1 – ประวัติเคลื่อนไหว (บัตรสินค้า): every movement, newest first, with the balance left at that location after
 * it. Filters: item code, document no, warehouse, lot, job, date from/to (document date), document type. Totals of
 * in/out for the filter, reversal markers (a cancel writes a reversing movement that points at the original), and a
 * CSV download of the filtered rows. History is never edited or deleted.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const inv = RRS.inventory;
  const { util, TRANSIT, STATUS_LABEL } = RRS;

  const STEP = 300;
  const FILTERS = ['code', 'docNo', 'wh', 'lot', 'job', 'from', 'to', 'type'];
  const dash = t`<span class="muted">–</span>`;
  const low = (s) => String(s == null ? '' : s).toLowerCase();
  const docView = (docNo) => ({ sel: docNo, lines: null, checked: null, header: null });
  const locText = (m) => (m.wh === TRANSIT ? `ระหว่างโอน (${m.bin})` : `${m.wh}${m.bin ? '/' + m.bin : ''}`);
  const typeName = (type) => (inv.DOC_TYPES[type] || {}).name || '';

  function filtered(ctx) {
    const v = ctx.view;
    const notes = [];
    const f = {};
    let codeLike = '';
    let item = null;
    const code = util.trim(v.code);
    if (code) {
      item = RRS.q.item(ctx.state, code);
      if (item) f.code = item.id;
      else {
        codeLike = util.ckey(code);
        notes.push({ text: `ไม่พบรหัส "${code}" ตรงตัวในทะเบียนสินค้า – แสดงทุกรหัสที่มี "${code}" อยู่ในรหัส`, tone: 'info' });
      }
    }
    if (v.wh) f.wh = v.wh;
    let from = v.from || '';
    let to = v.to || '';
    if (from && to && from > to) {
      const x = from;
      from = to;
      to = x;
      notes.push({ text: 'วันที่เริ่มอยู่หลังวันที่สิ้นสุด – แสดงช่วงที่สลับให้ถูกแล้ว', tone: 'warn' });
    }
    const like = (x, s) => !util.trim(s) || low(x).indexOf(low(util.trim(s))) >= 0;
    const rows = inv.history(ctx.state, f).filter((m) => (!codeLike || util.ckey(m.code).indexOf(codeLike) >= 0)
      && like(m.docNo, v.docNo) && like(m.lot, v.lot) && like(m.job, v.job)
      && (!v.type || m.docType === v.type) && (!from || m.date >= from) && (!to || m.date <= to));
    return { rows, notes, item };
  }

  // moves inside the stock: out of one place (or status) and into another – the total does not change
  const INTERNAL = { TR: 1, QS: 1 };
  function totals(ctx, rows) {
    let qin = 0, qout = 0, internal = 0;
    const units = new Set();
    const codes = new Set();
    for (const m of rows) {
      if (m.qty > 0) qin += m.qty;
      else qout -= m.qty;
      if (INTERNAL[m.docType]) internal++;
      codes.add(m.code);
    }
    for (const c of codes) units.add((RRS.q.get(ctx.state, 'items', c) || {}).baseUnit || '');
    return { qin: util.round(qin), qout: util.round(qout), net: util.round(qin - qout), codes: codes.size, internal,
      unit: units.size === 1 ? Array.from(units)[0] : '' };
  }

  /** Text of the original movement a reversal points at. */
  function origText(ctx, id) {
    const o = (ctx.state.tables.movements || {})[id];
    return o ? `${o.docNo || o.docType} บรรทัด ${o.line} วันที่ ${h.fmt.date(o.date)}` : id;
  }

  function csvText(rows) {
    const cell = (x) => {
      let s = x == null ? '' : String(x);
      if (typeof x === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  RRS.ui.page({
    id: 'history', title: 'ประวัติเคลื่อนไหว (บัตรสินค้า)', phase: 1, order: 30,
    sub: 'ทุกการรับ จ่าย โอน และปรับยอด เรียงล่าสุดก่อน พร้อมคงเหลือ ณ ตำแหน่งหลังแต่ละรายการ · ประวัติไม่มีการแก้หรือลบ การยกเลิกเป็นรายการกลับที่อ้างรายการเดิม',
    render(ctx) {
      const v = ctx.view;
      const moves = ctx.state.tables.movements || {};
      if (!Object.keys(moves).length) {
        return h.empty('ยังไม่มีการเคลื่อนไหว', 'ทุกครั้งที่บันทึกเอกสารรับ จ่าย โอน หรือปรับยอด รายการจะขึ้นที่นี่ พร้อมคงเหลือ ณ ตำแหน่งหลังรายการ',
          t`<div class="form-actions">${h.link('ไปหน้าเอกสารรับ–จ่าย–โอน', 'docs')}${ctx.can('doc.postAdjust') ? h.link('ย้ายยอดตั้งต้น', 'opening') : ''}</div>`);
      }
      const { rows, notes, item } = filtered(ctx);
      const sum = totals(ctx, rows);
      const limit = STEP * (1 + (v.more || 0));
      const reversed = new Set();
      for (const k in moves) if (moves[k].reversalOf) reversed.add(moves[k].reversalOf);
      const items = ctx.state.tables.items || {};
      const types = Array.from(new Set(Object.keys(inv.DOC_TYPES).concat(Object.values(moves).map((m) => m.docType).filter(Boolean)))).sort();
      const any = FILTERS.some((k) => v[k]);
      const toolbar = h.toolbar([
        h.field({ name: 'code', label: 'รหัสสินค้า', value: v.code, list: 'dl-items', placeholder: 'รหัสหลัก / Express / นับสต็อก', id: 'his-code' }),
        h.field({ name: 'docNo', label: 'เลขที่เอกสาร', value: v.docNo, placeholder: 'เช่น PD6911-0001', id: 'his-doc' }),
        h.field({ name: 'wh', label: 'คลัง', type: 'select', value: v.wh, options: h.whOptions(ctx.state).concat([[TRANSIT, 'ระหว่างโอน']]), blank: 'ทุกคลัง', id: 'his-wh' }),
        h.field({ name: 'lot', label: 'ล็อต / Heat', value: v.lot, id: 'his-lot' }),
        h.field({ name: 'job', label: 'งาน / SO', value: v.job, id: 'his-job' }),
        h.field({ name: 'from', label: 'ตั้งแต่วันที่เอกสาร', type: 'date', value: v.from, id: 'his-from' }),
        h.field({ name: 'to', label: 'ถึงวันที่เอกสาร', type: 'date', value: v.to, id: 'his-to' }),
        h.field({ name: 'type', label: 'ประเภทเอกสาร', type: 'select', value: v.type, options: types.map((k) => [k, `${k} ${typeName(k)}`.trim()]), blank: 'ทุกประเภท', id: 'his-type' }),
      ], [any ? h.btn('ล้างตัวกรอง', { act: 'clear', tone: 'ghost' }) : '', h.btn('ดาวน์โหลด CSV', { act: 'csv', tone: 'ghost', disabled: !rows.length, title: rows.length ? `${rows.length} แถวตามตัวกรอง` : 'ไม่มีแถวให้ดาวน์โหลด' })]);

      const card = item ? h.section(t`บัตรสินค้า ${h.code(item.id)} ${item.name}`, h.dl([
        ['หน่วยหลัก', item.baseUnit],
        [v.wh ? `คงเหลือตอนนี้ที่ ${v.wh === TRANSIT ? 'ระหว่างโอน' : v.wh}` : 'คงเหลือตอนนี้ (ทุกคลัง รวมระหว่างโอน)', h.qty(RRS.q.qty(ctx.state, { code: item.id, wh: v.wh || '' }), item.baseUnit)],
        ['ใช้ได้ตอนนี้', h.qty(RRS.q.qty(ctx.state, { code: item.id, wh: v.wh || '', status: 'AVAILABLE' }), item.baseUnit)],
        ['รหัส Express / นับสต็อก', [item.expressCode, item.countCode].filter(Boolean).join(' / ')],
      ]), { actions: h.link('ดูยอดตามตำแหน่ง', 'stock', { sel: item.id }) }) : '';

      const unit = sum.unit;
      const kp = h.kpis([
        h.kpi('รายการตามตัวกรอง', h.fmt.num(rows.length), sum.codes > 1 ? `${h.fmt.num(sum.codes)} สินค้า` : sum.codes === 1 ? '1 สินค้า' : ''),
        h.kpi('รวมรับเข้า', h.fmt.num(sum.qin), unit || (sum.codes > 1 ? 'หลายสินค้า – รวมข้ามหน่วย' : ''), 'ok'),
        h.kpi('รวมจ่ายออก', h.fmt.num(sum.qout), unit || (sum.codes > 1 ? 'หลายสินค้า – รวมข้ามหน่วย' : ''), 'warn'),
        h.kpi('สุทธิ (รับ − จ่าย)', `${sum.net > 0 ? '+' : ''}${h.fmt.num(sum.net)}`, unit, 'info'),
      ]);

      const cols = [
        { label: 'วันที่ (พ.ศ.)', render: (m) => t`${h.fmt.date(m.date)}<br><small class="muted">บันทึก ${util.bkkDate(m.at) === m.date ? h.fmt.dt(m.at).slice(-5) : h.fmt.dt(m.at)}</small>` },
        { label: 'เอกสาร', render: (m) => t`${!m.docNo || String(m.docNo).indexOf(m.docType) !== 0 ? t`<span class="muted">${m.docType}</span> ` : ''}${m.docNo ? h.link(h.code(m.docNo), 'docs', docView(m.docNo)) : ''}${m.line !== '' && m.line != null ? t` <small class="muted">#${m.line}</small>` : ''}<br><small class="muted">${typeName(m.docType)}</small>` },
        { label: 'สินค้า', render: (m) => t`${h.code(m.code)}<br><small class="muted">${(items[m.code] || {}).name || ''}</small>` },
        { label: 'ตำแหน่ง', render: (m) => (m.wh === TRANSIT ? t`${h.badge('ระหว่างโอน', 'info')} <small>${m.bin}</small>` : h.code(locText(m))) },
        { label: 'สถานะ', render: (m) => h.statusBadge(m.status) },
        { label: 'ล็อต', render: (m) => m.lot || dash },
        { label: 'รับ', num: true, render: (m) => (m.qty > 0 ? t`<b>${h.fmt.num(m.qty)}</b>` : dash), foot: h.fmt.num(sum.qin) },
        { label: 'จ่าย', num: true, render: (m) => (m.qty < 0 ? t`<b>${h.fmt.num(-m.qty)}</b>` : dash), foot: h.fmt.num(sum.qout) },
        { label: 'คงเหลือ ณ ตำแหน่ง', num: true, render: (m) => t`${h.fmt.num(m.balanceAfter)} <span class="unit">${(items[m.code] || {}).baseUnit || ''}</span>` },
        { label: 'งาน / SO', render: (m) => m.job || dash },
        { label: 'ผู้ทำ', get: (m) => ctx.userName(m.by) },
        { label: 'หมายเหตุ', render: (m) => t`${m.reversalOf ? t`${h.badge('กลับรายการ', 'warn')} <small>${origText(ctx, m.reversalOf)}</small><br>` : reversed.has(m.id) ? t`${h.badge('ถูกกลับรายการแล้ว', 'muted')}<br>` : ''}${m.remark || ''}` },
      ];
      cols[0].foot = t`รวม ${h.fmt.num(rows.length)} รายการ`;
      const table = rows.length
        ? h.table({ id: 'his-list', rows: rows.slice(0, limit), dense: true, cols, foot: cols.map((c) => c.foot || ''),
          rowCls: (m) => (m.reversalOf ? 'row-warn' : '') })
        : h.empty('ไม่พบรายการตามตัวกรอง', 'ลองขยายช่วงวันที่ หรือล้างตัวกรองบางช่อง', h.btn('ล้างตัวกรอง', { act: 'clear', tone: 'ghost' }));
      const more = rows.length > limit
        ? t`<p class="hint">แสดง ${h.fmt.num(limit)} จาก ${h.fmt.num(rows.length)} รายการ (ยอดรวมคิดจากทุกรายการตามตัวกรอง) ${h.btn(`แสดงเพิ่มอีก ${h.fmt.num(Math.min(STEP, rows.length - limit))} รายการ`, { act: 'more', tone: 'ghost', small: true })}</p>`
        : '';
      return t`${toolbar}
        ${notes.map((n) => h.note(n.text, n.tone))}
        ${card}
        ${kp}
        ${sum.internal && !v.type ? t`<p class="hint">รวมรับ/จ่ายนับการโอนย้ายและการเปลี่ยนสถานะคุณภาพ ${h.fmt.num(sum.internal)} รายการด้วย (ออกจากที่หนึ่ง เข้าอีกที่หนึ่ง สุทธิไม่เปลี่ยน) – เลือกประเภทเอกสารเพื่อดูเฉพาะรับหรือจ่ายจริง</p>` : ''}
        ${table}${more}
        <p class="hint">คงเหลือ ณ ตำแหน่ง = ยอดของสินค้านั้นที่ คลัง + ช่องเก็บ + สถานะ + ล็อต เดียวกัน หลังรายการนั้น (หน่วยหลัก) · วันที่ = วันที่ในเอกสาร ส่วนเวลาบันทึกคือเวลาที่กดบันทึกจริง · แถวสีเหลือง = รายการกลับจากการยกเลิกเอกสาร</p>`;
    },
    after(ctx, root0) {
      const v = ctx.view;
      for (const [id, key] of [['his-code', 'code'], ['his-doc', 'docNo'], ['his-lot', 'lot'], ['his-job', 'job']]) {
        const el = root0.querySelector('#' + id);
        if (!el) continue;
        el.addEventListener('input', () => {
          v[key] = el.value;
          clearTimeout(v._t);
          v._t = setTimeout(() => ctx.set({ more: 0, _focus: id }), 300);
        });
      }
      for (const [id, key] of [['his-wh', 'wh'], ['his-from', 'from'], ['his-to', 'to'], ['his-type', 'type']]) {
        const el = root0.querySelector('#' + id);
        if (el) el.addEventListener('change', () => ctx.set({ [key]: el.value, more: 0 }));
      }
      if (v._focus) {
        const el = root0.querySelector('#' + v._focus);
        v._focus = null;
        if (el) {
          el.focus();
          if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length);
        }
      }
      const box = root0.querySelector('#his-list');
      if (box) box.style.maxHeight = '75vh';
    },
    actions: {
      more: (ctx) => ctx.set({ more: (ctx.view.more || 0) + 1 }),
      clear(ctx) {
        const patch = { more: 0 };
        for (const k of FILTERS) patch[k] = '';
        ctx.set(patch);
      },
      async csv(ctx) {
        const { rows, item } = filtered(ctx);
        if (!rows.length) return ctx.toast('ไม่มีแถวตามตัวกรองให้ดาวน์โหลด', 'warn');
        const items = ctx.state.tables.items || {};
        const out = [['วันที่ (พ.ศ.)', 'เวลาบันทึก', 'ประเภทเอกสาร', 'เลขที่เอกสาร', 'บรรทัด', 'รหัสสินค้า', 'ชื่อสินค้า', 'คลัง', 'ช่องเก็บ',
          'สถานะ', 'ล็อต', 'รับ', 'จ่าย', 'คงเหลือ ณ ตำแหน่ง', 'หน่วย', 'งาน/SO', 'ผู้ทำ', 'กลับรายการของ', 'หมายเหตุ']];
        for (const m of rows) {
          const it = items[m.code] || {};
          out.push([h.fmt.date(m.date), h.fmt.dt(m.at), m.docType, m.docNo, m.line, m.code, it.name || '', m.wh === TRANSIT ? 'ระหว่างโอน' : m.wh, m.bin,
            STATUS_LABEL[m.status] || m.status, m.lot, m.qty > 0 ? m.qty : '', m.qty < 0 ? -m.qty : '', m.balanceAfter, it.baseUnit || '', m.job,
            ctx.userName(m.by), m.reversalOf ? origText(ctx, m.reversalOf) : '', m.remark]);
        }
        const name = `stock-history${item ? '-' + item.id : ''}${ctx.view.wh ? '-' + ctx.view.wh : ''}-${ctx.today}.csv`.replace(/[^\w.\-]+/g, '_');
        await ctx.download(name, csvText(out));
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
