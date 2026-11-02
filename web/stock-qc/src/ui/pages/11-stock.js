/*
 * Phase 1 – ยอดคงเหลือ. Two views of the same balances:
 *   ตามสินค้า   per item: ใช้ได้ / รอตรวจ / กักกัน / รอแก้ไข / ระหว่างโอน / รวม, Min/Max with a badge when below Min
 *   ตามตำแหน่ง  per balance row: warehouse / bin / status / lot / qty / last receipt
 * A row opens the item: its locations and its last movements (links to the documents page). Store users start an
 * issue (PD/OU) or a transfer (TR) draft from one location; the draft is checked and posted on the documents page.
 * Only stock in status ใช้ได้ can be issued or moved (unless a document type lists more statuses).
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const inv = RRS.inventory;
  const { util, TRANSIT, STATUS_LABEL } = RRS;

  const HOLD = ['QC_HOLD', 'QUARANTINE', 'REWORK'];
  const STEP = 300;
  const ISSUE_TYPES = ['PD', 'OU'];
  const ZERO = { AVAILABLE: 0, QC_HOLD: 0, QUARANTINE: 0, REWORK: 0, transit: 0, total: 0 };
  const dash = t`<span class="muted">–</span>`;
  const n0 = (v) => (v ? h.fmt.num(v) : dash);
  const low = (s) => String(s == null ? '' : s).toLowerCase();
  const docView = (docNo) => ({ sel: docNo, lines: null, checked: null, header: null });
  // document numbers as code chips: they never break at the hyphen
  const docLink = (docNo) => (docNo ? h.link(h.code(docNo), 'docs', docView(docNo)) : dash);
  const histView = (code) => ({ code, docNo: '', wh: '', lot: '', job: '', from: '', to: '', type: '', more: 0 });
  const locText = (b) => (b.wh === TRANSIT ? `ระหว่างโอน (${b.bin})` : `${b.wh}${b.bin ? '/' + b.bin : ''}`);

  /** Can a document type take stock of this status? (ใช้ได้ only, unless the type lists more statuses) */
  function outOk(type, status) {
    const td = inv.DOC_TYPES[type];
    return !!td && (td.outStatuses || ['AVAILABLE']).indexOf(status) >= 0;
  }
  /** Quantity still on the way to `wh` per item (open transfers). */
  function incoming(state, wh) {
    const out = {};
    for (const d of RRS.q.rows(state, 'documents', (x) => x.status === 'IN_TRANSIT')) {
      for (const l of d.lines || []) {
        if (wh && l.toWh !== wh) continue;
        const left = util.round((l.base || 0) - (l.received || 0));
        if (left > 0) out[l.code] = util.round((out[l.code] || 0) + left);
      }
    }
    return out;
  }
  /** Destination warehouse of a balance held in transit (its bin is the transfer number). */
  function transitDest(state, b) {
    const d = RRS.q.get(state, 'documents', b.bin);
    if (!d) return '';
    const lines = d.lines || [];
    const l = lines.find((x) => x.code === b.code && (x.lot || '') === (b.lot || '') && (x.status || 'AVAILABLE') === b.status
      && util.round((x.base || 0) - (x.received || 0)) > 0) || lines.find((x) => x.code === b.code);
    return l ? l.toWh : '';
  }

  function itemRows(ctx) {
    const v = ctx.view;
    const all = inv.summary(ctx.state);
    const scoped = v.wh ? inv.summary(ctx.state, v.wh) : all;
    const inc = v.wh ? incoming(ctx.state, v.wh) : null;
    const items = ctx.state.tables.items || {};
    const codes = new Set(Object.keys(items).concat(Object.keys(scoped), inc ? Object.keys(inc) : []));
    const q = low(v.q).trim();
    const out = [];
    for (const code of codes) {
      const it = items[code] || null;
      const s = scoped[code] || ZERO;
      const a = all[code] || ZERO;
      const r = { code, it, AVAILABLE: s.AVAILABLE, QC_HOLD: s.QC_HOLD, QUARANTINE: s.QUARANTINE, REWORK: s.REWORK,
        transit: inc ? inc[code] || 0 : s.transit, total: s.total };
      r.usable = util.round(a.AVAILABLE + a.transit);
      r.min = it ? Number(it.minQty) || 0 : 0;
      r.max = it ? Number(it.maxQty) || 0 : 0;
      r.below = !!it && it.active !== false && r.min > 0 && r.usable < r.min;
      r.over = r.max > 0 && r.usable > r.max;
      const has = !!(r.AVAILABLE || r.QC_HOLD || r.QUARANTINE || r.REWORK || r.transit);
      if (!has && it && it.active === false) continue;
      if (!has && !v.zero && !(r.below && !v.wh)) continue;
      if (v.status === 'TRANSIT' ? !r.transit : v.status && !r[v.status]) continue;
      if (v.group && (!it || it.group !== v.group)) continue;
      if (v.low && !r.below) continue;
      if (q && ![code, it && it.name, it && it.expressCode, it && it.countCode, it && it.group, it && it.model].some((x) => low(x).indexOf(q) >= 0)) continue;
      out.push(r);
    }
    return out.sort((x, y) => x.code.localeCompare(y.code));
  }

  function locRows(ctx) {
    const v = ctx.view;
    const q = low(v.q).trim();
    const items = ctx.state.tables.items || {};
    return inv.locations(ctx.state).filter((b) => {
      if (b.wh === TRANSIT) {
        if (v.status && v.status !== 'TRANSIT') return false;
        if (v.wh && transitDest(ctx.state, b) !== v.wh) return false;
      } else {
        if (v.status && b.status !== v.status) return false;
        if (v.wh && b.wh !== v.wh) return false;
      }
      const it = items[b.code];
      if (v.group && (!it || it.group !== v.group)) return false;
      if (q && ![b.code, b.bin, b.lot, it && it.name, it && it.expressCode, it && it.countCode].some((x) => low(x).indexOf(q) >= 0)) return false;
      return true;
    });
  }

  function kpis(ctx) {
    const all = inv.summary(ctx.state);
    const items = ctx.state.tables.items || {};
    let withStock = 0, below = 0, held = 0;
    for (const code of new Set(Object.keys(items).concat(Object.keys(all)))) {
      const s = all[code] || ZERO;
      const it = items[code];
      if (s.total) withStock++;
      if (it && it.active !== false && Number(it.minQty) > 0 && util.round(s.AVAILABLE + s.transit) < Number(it.minQty)) below++;
      if (HOLD.some((k) => s[k])) held++;
    }
    const transitDocs = RRS.q.rows(ctx.state, 'documents', (d) => d.status === 'IN_TRANSIT').length;
    return h.kpis([
      h.kpi('สินค้าที่มียอด', h.fmt.num(withStock), 'รายการ (ทุกคลัง)'),
      h.kpi('ต่ำกว่า Min', h.fmt.num(below), below ? 'ใช้ได้ + ระหว่างโอน น้อยกว่า Min' : 'ไม่มีรายการต่ำกว่า Min', below ? 'bad' : 'ok'),
      h.kpi('มีของที่เบิกไม่ได้', h.fmt.num(held), 'รอตรวจ / กักกัน / รอแก้ไข', held ? 'warn' : ''),
      h.kpi('ใบโอนที่ยังรับไม่ครบ', h.fmt.num(transitDocs), 'ของอยู่ระหว่างโอน', transitDocs ? 'info' : ''),
    ]);
  }

  function itemTable(ctx, rows, limit) {
    const v = ctx.view;
    return h.table({
      id: 'stk-list', rows: rows.slice(0, limit), rowAct: 'pick', rowArg: (r) => r.code, rowCls: (r) => (r.code === v.sel ? 'sel' : ''),
      empty: 'ไม่พบสินค้าตามตัวกรอง', emptyText: 'ลองล้างตัวกรอง หรือติ๊ก แสดงสินค้าที่ไม่มียอด',
      cols: [
        { label: 'รหัส', render: (r) => h.code(r.code) },
        { label: 'ชื่อสินค้า', render: (r) => (r.it ? t`${r.it.name}${r.it.group ? t`<br><small class="muted">${r.it.group}</small>` : ''}` : t`<span class="muted">ไม่พบในทะเบียนสินค้า</span>`) },
        { label: 'ใช้ได้', num: true, render: (r) => (r.AVAILABLE ? t`<b>${h.fmt.num(r.AVAILABLE)}</b>` : dash) },
        { label: 'รอตรวจ', num: true, render: (r) => n0(r.QC_HOLD) },
        { label: 'กักกัน', num: true, render: (r) => n0(r.QUARANTINE) },
        { label: 'รอแก้ไข', num: true, render: (r) => n0(r.REWORK) },
        { label: v.wh ? 'กำลังโอนเข้า' : 'ระหว่างโอน', num: true, render: (r) => n0(r.transit) },
        { label: 'รวม', num: true, render: (r) => n0(r.total) },
        { label: 'หน่วย', get: (r) => (r.it ? r.it.baseUnit : '') },
        { label: 'Min / Max', num: true, render: (r) => (r.min || r.max ? `${r.min ? h.fmt.num(r.min) : '–'} / ${r.max ? h.fmt.num(r.max) : '–'}` : dash) },
        { label: 'สถานะ', render: (r) => (r.below ? h.badge('ต่ำกว่า Min', 'bad') : r.over ? h.badge('เกิน Max', 'info') : '') },
      ],
    });
  }

  function locTable(ctx, rows, limit) {
    const v = ctx.view;
    const items = ctx.state.tables.items || {};
    return h.table({
      id: 'stk-list', rows: rows.slice(0, limit), rowAct: 'pick', rowArg: (b) => b.code, rowCls: (b) => (b.code === v.sel ? 'sel' : ''),
      empty: 'ไม่พบยอดตามตัวกรอง', emptyText: 'ลองล้างตัวกรอง หรือเลือกคลัง/สถานะอื่น',
      cols: [
        { label: 'คลัง', render: (b) => (b.wh === TRANSIT ? h.badge('ระหว่างโอน', 'info') : h.code(b.wh)) },
        { label: 'ช่องเก็บ', render: (b) => {
          if (b.wh !== TRANSIT) return b.bin ? h.code(b.bin) : dash;
          const dest = transitDest(ctx.state, b);
          return t`${docLink(b.bin)}${dest ? t` <span class="muted">→ ${dest}</span>` : ''}`;
        } },
        { label: 'รหัส', render: (b) => h.code(b.code) },
        { label: 'ชื่อสินค้า', get: (b) => (items[b.code] || {}).name || '' },
        { label: 'สถานะ', render: (b) => h.statusBadge(b.status) },
        { label: 'ล็อต', render: (b) => b.lot || dash },
        { label: 'จำนวน', num: true, render: (b) => h.qty(b.qty, (items[b.code] || {}).baseUnit) },
        { label: 'รับเข้าล่าสุด', get: (b) => (b.lastIn ? h.fmt.dt(b.lastIn) : '') },
      ],
    });
  }

  function detail(ctx, code) {
    const it = RRS.q.get(ctx.state, 'items', code);
    const s = inv.summary(ctx.state)[code] || ZERO;
    const unit = it ? it.baseUnit : '';
    const locs = inv.locations(ctx.state, { code });
    const moves = inv.history(ctx.state, { code });
    const canDraft = ctx.can('doc.draft');
    const held = HOLD.filter((k) => s[k]);
    const facts = h.dl([
      ['ใช้ได้ (ทุกคลัง)', h.qty(s.AVAILABLE, unit)],
      ['รอตรวจ / กักกัน / รอแก้ไข', t`${h.fmt.num(s.QC_HOLD)} / ${h.fmt.num(s.QUARANTINE)} / ${h.fmt.num(s.REWORK)} <span class="unit">${unit}</span>`],
      ['ระหว่างโอน', h.qty(s.transit, unit)],
      ['Min / Max', it && (Number(it.minQty) || Number(it.maxQty)) ? `${Number(it.minQty) ? h.fmt.num(it.minQty) : '–'} / ${Number(it.maxQty) ? h.fmt.num(it.maxQty) : '–'} ${unit}` : 'ไม่ได้ตั้ง'],
      ['กลุ่ม', it && it.group],
      ['ติดตามล็อต', it ? RRS.master.TRACK[it.trackLot] || it.trackLot : ''],
    ]);
    const locCols = [
      { label: 'ตำแหน่ง', render: (b) => (b.wh === TRANSIT ? t`${h.badge('ระหว่างโอน', 'info')} ${docLink(b.bin)}` : h.code(locText(b))) },
      { label: 'สถานะ', render: (b) => h.statusBadge(b.status) },
      { label: 'ล็อต', render: (b) => b.lot || dash },
      { label: 'จำนวน', num: true, render: (b) => h.qty(b.qty, unit) },
    ];
    if (canDraft) {
      locCols.push({ label: '', render: (b) => {
        if (b.wh === TRANSIT) return t`<small class="muted">รับปลายทางที่หน้าเอกสาร</small>`;
        const key = RRS.balanceKey(b);
        // a person limited to some warehouses cannot start a document in another one
        const whOk = ctx.can('doc.draft', b.wh);
        const why = !whOk ? `คุณไม่มีสิทธิ์ทำเอกสารคลัง ${b.wh}` : `ของสถานะ "${STATUS_LABEL[b.status] || b.status}" เบิกหรือโอนไม่ได้ จนกว่า QC จะปล่อยเป็น ใช้ได้`;
        const canIssue = whOk && ISSUE_TYPES.some((k) => outOk(k, b.status));
        const canMove = whOk && outOk('TR', b.status);
        return t`<span class="form-actions">${h.btn('เบิก', { act: 'issue', arg: key, small: true, disabled: !canIssue || b.qty <= 0, title: canIssue ? 'สร้างร่างใบเบิกจากตำแหน่งนี้' : why })}${h.btn('โอนย้าย', { act: 'move', arg: key, small: true, disabled: !canMove || b.qty <= 0, title: canMove ? 'สร้างร่างใบโอนจากตำแหน่งนี้' : why })}</span>`;
      } });
    }
    const locTbl = h.table({ rows: locs, dense: true, cols: locCols, empty: 'ไม่มียอดคงเหลือ', emptyText: 'สินค้านี้ยังไม่มีของในคลังใด' });
    const moveTbl = h.table({ rows: moves.slice(0, 12), dense: true, empty: 'ยังไม่มีการเคลื่อนไหว', emptyText: 'รายการจะขึ้นเมื่อบันทึกเอกสารของสินค้านี้',
      cols: [
        { label: 'วันที่', get: (m) => h.fmt.date(m.date) },
        { label: 'เอกสาร', render: (m) => t`${!m.docNo || String(m.docNo).indexOf(m.docType) !== 0 ? t`<span class="muted">${m.docType}</span> ` : ''}${docLink(m.docNo)}` },
        { label: 'ตำแหน่ง', get: (m) => locText(m) },
        { label: 'สถานะ', render: (m) => h.statusBadge(m.status) },
        { label: 'ล็อต', render: (m) => m.lot || dash },
        { label: 'จำนวน', num: true, render: (m) => t`${m.qty > 0 ? '+' : ''}${h.fmt.num(m.qty)}${m.reversalOf ? t` ${h.badge('กลับรายการ', 'warn')}` : ''}` },
        { label: 'คงเหลือ', num: true, render: (m) => h.fmt.num(m.balanceAfter) },
        { label: 'ผู้ทำ', get: (m) => ctx.userName(m.by) },
      ] });
    const heldNote = held.length ? h.note(t`มีของสถานะ ${held.map((k) => STATUS_LABEL[k]).join(' / ')} – เบิกหรือโอนไม่ได้จนกว่า QC จะตรวจปล่อยเป็น "ใช้ได้" (ปุ่มของแถวนั้นจึงกดไม่ได้)`, 'warn') : '';
    const head = t`${h.code(code)} ${it ? it.name : 'ไม่พบในทะเบียนสินค้า'}`;
    return h.section(head, t`${facts}${heldNote}
      <h3>ยอดตามตำแหน่ง</h3>${locTbl}
      ${canDraft && locs.some((b) => b.wh !== TRANSIT) ? t`<p class="hint">เบิก / โอนย้าย สร้างร่างเอกสาร 1 บรรทัดจากตำแหน่งนั้น ยังไม่ตัดยอด – ${postWho(ctx)}</p>` : ''}
      <h3>เคลื่อนไหวล่าสุด</h3>${moveTbl}
      ${moves.length > 12 ? t`<p class="hint">แสดง 12 รายการล่าสุดจาก ${h.fmt.num(moves.length)} – ${h.link('ดูประวัติทั้งหมด', 'history', histView(code))}</p>` : ''}`,
    { id: 'stk-detail', actions: t`${h.link('ดูประวัติทั้งหมด', 'history', histView(code))}${h.btn('ปิด', { act: 'close', tone: 'quiet', small: true })}` });
  }

  function groups(ctx) {
    const set = new Set();
    for (const it of RRS.q.rows(ctx.state, 'items')) if (util.trim(it.group)) set.add(util.trim(it.group));
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'th'));
  }

  function csvText(rows) {
    const cell = (x) => {
      let s = x == null ? '' : String(x);
      if (typeof x === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  function balanceOf(ctx, key) {
    return (ctx.state.tables.balances || {})[key] || null;
  }
  function sourceBox(ctx, b) {
    const it = ctx.item(b.code) || {};
    return t`<div class="wide">${h.dl([['สินค้า', t`${h.code(b.code)} ${it.name || ''}`], ['จากตำแหน่ง', locText(b)],
      ['สถานะ', h.statusBadge(b.status)], b.lot ? ['ล็อต', b.lot] : null, ['มีที่ตำแหน่งนี้', h.qty(b.qty, it.baseUnit)]])}</div>`;
  }
  function qtyError(b, vals, unit) {
    const qty = util.num(vals.qty);
    if (isNaN(qty) || qty <= 0) return { ok: false, errors: [{ message: 'ใส่จำนวนเป็นตัวเลขมากกว่า 0' }] };
    if (qty > b.qty) return { ok: false, errors: [{ message: `ที่ ${locText(b)} มี ${h.fmt.num(b.qty)} ${unit} – ใส่ไม่เกินนี้ หรือเบิกจากตำแหน่งอื่นเพิ่ม` }] };
    return null;
  }
  /** Who turns the draft into a stock change: the person (store) or someone else (planner, production …). */
  function postWho(ctx) {
    if (ctx.can('doc.post')) return 'ไปตรวจและกด บันทึก (เปลี่ยนยอด) ที่หน้าเอกสาร';
    const roles = RRS.auth.rolesFor('doc.post').filter((r) => r !== 'admin').map((r) => RRS.auth.ROLES[r] || r).join(' / ');
    return `คุณสร้างร่างได้ แต่ตัดยอดไม่ได้ – แจ้ง${roles}ให้ตรวจและกด บันทึก ที่หน้าเอกสาร`;
  }
  function openDraft(ctx, r) {
    const docNo = r && r.result && r.result.docNo;
    if (!docNo) return;
    ctx.toast(`สร้างร่าง ${docNo} แล้ว – ${ctx.can('doc.post') ? 'ตรวจแล้วกด บันทึก (เปลี่ยนยอด)' : postWho(ctx)}`, 'ok');
    ctx.go('docs', Object.assign(docView(docNo), { tab: 'all', q: '', type: '' }));
  }

  RRS.ui.page({
    id: 'stock', title: 'ยอดคงเหลือ', phase: 1, order: 20,
    sub: 'ยอดตามสินค้าและตามตำแหน่ง (คลัง / ช่องเก็บ / สถานะ / ล็อต) · คลิกแถวเพื่อดูตำแหน่งและเคลื่อนไหวล่าสุดของสินค้านั้น',
    render(ctx) {
      const v = ctx.view;
      const tab = v.tab === 'loc' ? 'loc' : 'item';
      const limit = v.limit || STEP;
      const hasStock = Object.keys(ctx.state.tables.balances || {}).length > 0;
      const hasItems = RRS.q.rows(ctx.state, 'items').length > 0;
      const canOpen = ctx.can('doc.postAdjust');
      const canDocs = ctx.can('doc.draft') || ctx.can('doc.post');
      const starters = t`<div class="form-actions">${canOpen ? h.link('ย้ายยอดตั้งต้นจากไฟล์', 'opening') : ''}${canDocs ? h.link('สร้างเอกสารรับเข้า', 'docs') : ''}</div>`;
      if (!hasStock && !hasItems) {
        return h.empty('ยังไม่มียอดคงเหลือ', 'เพิ่มสินค้าในทะเบียนสินค้าก่อน แล้วยอดจะขึ้นที่นี่เมื่อย้ายยอดตั้งต้น หรือบันทึกรับเข้า (RR รับซื้อ, FR รับจากผลิต, RT รับคืน)',
          t`<div class="form-actions">${h.link('ไปทะเบียนสินค้า', 'items')}${canOpen ? h.link('ย้ายยอดตั้งต้น', 'opening') : ''}</div>`);
      }
      const rows = tab === 'item' ? itemRows(ctx) : locRows(ctx);
      const grp = groups(ctx);
      const filtered = v.q || v.wh || v.status || v.group || v.low || v.zero;
      const statusOpts = Object.keys(STATUS_LABEL).map((k) => [k, STATUS_LABEL[k]]).concat([['TRANSIT', 'ระหว่างโอน']]);
      const left = [
        h.field({ name: 'q', label: 'ค้นหา', value: v.q, placeholder: tab === 'item' ? 'รหัส ชื่อ รหัส Express กลุ่ม…' : 'รหัส ชื่อ ช่องเก็บ ล็อต…', id: 'stk-q' }),
        h.field({ name: 'wh', label: 'คลัง', type: 'select', value: v.wh, options: h.whOptions(ctx.state), blank: 'ทุกคลัง', id: 'stk-wh' }),
        h.field({ name: 'status', label: 'สถานะ', type: 'select', value: v.status, options: statusOpts, blank: 'ทุกสถานะ', id: 'stk-status' }),
        grp.length ? h.field({ name: 'group', label: 'กลุ่ม', type: 'select', value: v.group, options: grp, blank: 'ทุกกลุ่ม', id: 'stk-group' }) : '',
        tab === 'item' ? h.field({ name: 'low', label: 'เฉพาะต่ำกว่า Min', type: 'checkbox', value: v.low, id: 'stk-low' }) : '',
        tab === 'item' ? h.field({ name: 'zero', label: 'แสดงสินค้าที่ไม่มียอด', type: 'checkbox', value: v.zero, id: 'stk-zero' }) : '',
      ];
      const right = [filtered ? h.btn('ล้างตัวกรอง', { act: 'clear', tone: 'ghost' }) : '', rows.length ? h.btn('ดาวน์โหลด CSV', { act: 'csv', tone: 'ghost' }) : ''];
      const list = !hasStock && tab === 'loc'
        ? h.empty('ยังไม่มียอดคงเหลือ', 'ยอดตามตำแหน่งจะขึ้นเมื่อย้ายยอดตั้งต้น หรือบันทึกรับเข้า (RR รับซื้อ, FR รับจากผลิต, RT รับคืน)', starters)
        : !hasStock && !rows.length
          ? h.empty('ยังไม่มียอดคงเหลือ', 'ยอดจะขึ้นเมื่อย้ายยอดตั้งต้น หรือบันทึกรับเข้า (RR รับซื้อ, FR รับจากผลิต, RT รับคืน) · ติ๊ก แสดงสินค้าที่ไม่มียอด เพื่อดูทุกรายการ', starters)
          : tab === 'item' ? itemTable(ctx, rows, limit) : locTable(ctx, rows, limit);
      const more = rows.length > limit
        ? t`<p class="hint">แสดง ${h.fmt.num(limit)} จาก ${h.fmt.num(rows.length)} แถว ${h.btn(`แสดงเพิ่มอีก ${h.fmt.num(Math.min(STEP, rows.length - limit))} แถว`, { act: 'more', tone: 'ghost', small: true })}</p>`
        : rows.length ? t`<p class="hint">${h.fmt.num(rows.length)} ${tab === 'item' ? 'รายการ' : 'ตำแหน่ง'}</p>` : '';
      const legend = tab === 'item'
        ? (v.wh ? `รวม = ยอดในคลัง ${v.wh} ทุกสถานะ · กำลังโอนเข้า = ของที่ส่งมาคลังนี้แต่ยังไม่รับ (ยังไม่นับในรวม) · Min/Max เทียบกับ ใช้ได้ + ระหว่างโอน รวมทุกคลัง`
          : 'รวม = ใช้ได้ + รอตรวจ + กักกัน + รอแก้ไข + ระหว่างโอน · Min/Max เทียบกับ ใช้ได้ + ระหว่างโอน รวมทุกคลัง (ของรอตรวจ/กักกัน/รอแก้ไข ไม่นับ)')
        : 'หนึ่งแถว = สินค้า + คลัง + ช่องเก็บ + สถานะ + ล็อต · จำนวนเป็นหน่วยหลัก';
      const sel = v.sel && (RRS.q.get(ctx.state, 'items', v.sel) || (inv.summary(ctx.state)[v.sel] ? v.sel : null)) ? v.sel : null;
      // the list is wide (11 columns): it keeps the full width; the chosen item opens above it
      return t`${kpis(ctx)}
        ${h.note('เบิกและโอนได้เฉพาะของสถานะ "ใช้ได้" · ของ รอตรวจ / กักกัน / รอแก้ไข ยังอยู่ในคลังและนับในยอดรวม แต่เบิกหรือโอนไม่ได้ จนกว่า QC จะตรวจปล่อย', 'info')}
        ${h.tabs([{ id: 'item', label: 'ตามสินค้า' }, { id: 'loc', label: 'ตามตำแหน่ง' }], tab)}
        ${h.toolbar(left, right)}
        ${sel ? detail(ctx, sel) : ''}
        <div>${list}${more}<p class="hint">${legend}${rows.length && !sel ? ' · คลิกแถวเพื่อดูยอดแยกตามตำแหน่ง เคลื่อนไหวล่าสุด และสร้างร่างใบเบิก/ใบโอน' : ''}</p></div>`;
    },
    after(ctx, root0) {
      const v = ctx.view;
      const q = root0.querySelector('#stk-q');
      if (q) {
        q.addEventListener('input', () => {
          v.q = q.value;
          clearTimeout(v._t);
          v._t = setTimeout(() => ctx.set({ limit: STEP, _focus: 'stk-q' }), 250);
        });
      }
      for (const [id, key] of [['stk-wh', 'wh'], ['stk-status', 'status'], ['stk-group', 'group']]) {
        const el = root0.querySelector('#' + id);
        if (el) el.addEventListener('change', () => ctx.set({ [key]: el.value, limit: STEP }));
      }
      for (const [id, key] of [['stk-low', 'low'], ['stk-zero', 'zero']]) {
        const el = root0.querySelector('#' + id);
        if (el) el.addEventListener('change', () => ctx.set({ [key]: el.checked, limit: STEP }));
      }
      if (v._focus) {
        const el = root0.querySelector('#' + v._focus);
        v._focus = null;
        if (el) {
          el.focus();
          if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length);
        }
      }
      // long lists scroll inside their own box (the header row stays on top)
      const box = root0.querySelector('#stk-list');
      if (box) box.style.maxHeight = '70vh';
      if (v._scroll) {
        v._scroll = false;
        const d = root0.querySelector('#stk-detail');
        if (d) {
          d.style.scrollMarginTop = '72px'; // below the sticky top bar
          setTimeout(() => d.scrollIntoView({ block: 'start' }), 0);
        }
      }
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg, limit: STEP }),
      pick: (ctx, el) => ctx.set({ sel: el.dataset.arg, _scroll: true }),
      close: (ctx) => ctx.set({ sel: null }),
      more: (ctx) => ctx.set({ limit: (ctx.view.limit || STEP) + STEP }),
      clear: (ctx) => ctx.set({ q: '', wh: '', status: '', group: '', low: false, zero: false, limit: STEP }),
      async csv(ctx) {
        const v = ctx.view;
        const items = ctx.state.tables.items || {};
        let out;
        if (v.tab === 'loc') {
          out = [['คลัง', 'ช่องเก็บ', 'รหัสสินค้า', 'ชื่อสินค้า', 'สถานะ', 'ล็อต', 'จำนวน', 'หน่วย', 'รับเข้าล่าสุด']].concat(locRows(ctx).map((b) => {
            const it = items[b.code] || {};
            return [b.wh === TRANSIT ? 'ระหว่างโอน' : b.wh, b.bin, b.code, it.name || '', STATUS_LABEL[b.status] || b.status, b.lot, b.qty, it.baseUnit || '', b.lastIn ? h.fmt.dt(b.lastIn) : ''];
          }));
        } else {
          out = [['รหัสสินค้า', 'ชื่อสินค้า', 'กลุ่ม', 'ใช้ได้', 'รอตรวจ', 'กักกัน', 'รอแก้ไข', v.wh ? 'กำลังโอนเข้า' : 'ระหว่างโอน', 'รวม', 'หน่วย', 'Min', 'Max', 'สถานะ']].concat(itemRows(ctx).map((r) => [
            r.code, r.it ? r.it.name : '', r.it ? r.it.group : '', r.AVAILABLE, r.QC_HOLD, r.QUARANTINE, r.REWORK, r.transit, r.total,
            r.it ? r.it.baseUnit : '', r.min, r.max, r.below ? 'ต่ำกว่า Min' : r.over ? 'เกิน Max' : '']));
        }
        await ctx.download(`stock-${v.tab === 'loc' ? 'by-location' : 'by-item'}${v.wh ? '-' + v.wh : ''}-${ctx.today}.csv`, csvText(out));
      },
      async issue(ctx, el) {
        const b = balanceOf(ctx, el.dataset.arg);
        if (!b) return ctx.toast('ตำแหน่งนี้ไม่มียอดแล้ว – อาจมีคนเบิกหรือโอนไปก่อน', 'warn');
        if (!ctx.can('doc.draft', b.wh)) return ctx.toast(`คุณไม่มีสิทธิ์ทำเอกสารคลัง ${b.wh}`, 'warn');
        const it = ctx.item(b.code) || {};
        const types = ISSUE_TYPES.filter((k) => outOk(k, b.status));
        if (!types.length) return ctx.toast(`ของสถานะ ${STATUS_LABEL[b.status]} เบิกไม่ได้ – ต้องให้ QC ตรวจปล่อยก่อน`, 'warn');
        const r = await ctx.dialog({
          title: `สร้างร่างใบเบิก ${b.code}`, submit: 'สร้างร่างแล้วไปหน้าเอกสาร',
          body: t`${sourceBox(ctx, b)}
            ${h.field({ name: 'type', label: 'ประเภทใบเบิก', type: 'select', value: types[0], options: types.map((k) => [k, `${k} – ${inv.DOC_TYPES[k].name}`]), blank: false, required: true })}
            ${h.field({ name: 'qty', label: `จำนวนที่เบิก (${it.baseUnit || 'หน่วยหลัก'})`, type: 'number', required: true, hint: `ไม่เกิน ${h.fmt.num(b.qty)}` })}
            ${h.field({ name: 'job', label: 'งาน / SO', hint: 'ใส่เมื่อเบิกให้งานผลิต' })}
            ${h.field({ name: 'remark', label: 'หมายเหตุ', wide: true })}
            <p class="hint wide">ร่างยังไม่ตัดยอด – ${postWho(ctx)} · ระหว่างนั้นคนอื่นยังเบิกของนี้ได้</p>`,
          onSubmit: (vals) => {
            const bad = qtyError(b, vals, it.baseUnit || '');
            if (bad) return bad;
            const td = inv.DOC_TYPES[vals.type];
            if (!td || types.indexOf(vals.type) < 0) return { ok: false, errors: [{ message: 'เลือกประเภทใบเบิก' }] };
            if (td.needsJob && !util.trim(vals.job)) return { ok: false, errors: [{ message: `${vals.type} ต้องระบุงาน / SO` }] };
            return ctx.exec('doc.saveDraft', { type: vals.type, job: vals.job, remark: vals.remark,
              lines: [{ code: b.code, qty: util.num(vals.qty), unit: '', wh: b.wh, bin: b.bin, lot: b.lot, status: b.status }] }, { quiet: true });
          },
        });
        if (r && r.ok) openDraft(ctx, r);
      },
      async move(ctx, el) {
        const b = balanceOf(ctx, el.dataset.arg);
        if (!b) return ctx.toast('ตำแหน่งนี้ไม่มียอดแล้ว – อาจมีคนเบิกหรือโอนไปก่อน', 'warn');
        if (!ctx.can('doc.draft', b.wh)) return ctx.toast(`คุณไม่มีสิทธิ์ทำเอกสารคลัง ${b.wh}`, 'warn');
        const it = ctx.item(b.code) || {};
        if (!outOk('TR', b.status)) return ctx.toast(`ของสถานะ ${STATUS_LABEL[b.status]} โอนไม่ได้ – ต้องให้ QC ตรวจปล่อยก่อน`, 'warn');
        const r = await ctx.dialog({
          title: `สร้างร่างใบโอน ${b.code}`, submit: 'สร้างร่างแล้วไปหน้าเอกสาร',
          body: t`${sourceBox(ctx, b)}
            ${h.field({ name: 'toWh', label: 'ไปคลัง', type: 'select', options: h.whOptions(ctx.state), value: b.wh, required: true })}
            ${h.field({ name: 'toBin', label: 'ไปช่องเก็บ', list: 'dl-bins', placeholder: 'เลือกหรือพิมพ์รหัสช่องเก็บ' })}
            ${h.field({ name: 'qty', label: `จำนวนที่โอน (${it.baseUnit || 'หน่วยหลัก'})`, type: 'number', required: true, hint: `ไม่เกิน ${h.fmt.num(b.qty)}` })}
            ${h.field({ name: 'remark', label: 'หมายเหตุ', wide: true })}
            <p class="hint wide">ร่างยังไม่ย้ายของ – ${postWho(ctx)} · หลังบันทึก ของจะอยู่ "ระหว่างโอน" จนปลายทางกดรับโอน</p>`,
          onSubmit: (vals) => {
            const bad = qtyError(b, vals, it.baseUnit || '');
            if (bad) return bad;
            const toWh = util.normCode(vals.toWh);
            const toBin = util.normCode(vals.toBin);
            const whRow = toWh && RRS.q.get(ctx.state, 'warehouses', toWh);
            if (!whRow) return { ok: false, errors: [{ message: 'เลือกคลังปลายทาง' }] };
            if (toBin && !RRS.q.get(ctx.state, 'bins', toWh + '|' + toBin)) return { ok: false, errors: [{ message: `ไม่พบช่องเก็บ ${toBin} ในคลัง ${toWh} – เลือกจากรายการ หรือเพิ่มช่องเก็บในข้อมูลหลักก่อน` }] };
            if (!toBin && whRow.requireBin) return { ok: false, errors: [{ message: `คลัง ${toWh} ต้องระบุช่องเก็บปลายทาง` }] };
            if (toWh === b.wh && toBin === (b.bin || '')) return { ok: false, errors: [{ message: 'ปลายทางเป็นที่เดียวกับต้นทาง – เลือกคลังหรือช่องเก็บอื่น' }] };
            return ctx.exec('doc.saveDraft', { type: 'TR', remark: vals.remark,
              lines: [{ code: b.code, qty: util.num(vals.qty), unit: '', wh: b.wh, bin: b.bin, toWh, toBin, lot: b.lot, status: b.status }] }, { quiet: true });
          },
        });
        if (r && r.ok) openDraft(ctx, r);
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
