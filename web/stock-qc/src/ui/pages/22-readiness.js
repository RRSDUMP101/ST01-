/*
 * Phase 2 – สต็อก 6 ช่อง และความพร้อมผลิต.
 *   สต็อก 6 ช่อง  RRS.planning.six: มีจริง, รอตรวจ/กักกัน, จองแล้ว, พร้อมเบิก, กำลังผลิต, จะเข้า + วันเข้า, ต้องใช้, ขาด –
 *                 with a legend: stock still to be made, still in QC or still on a PO is never counted as ready.
 *                 A row opens where the item is: per warehouse, the jobs that need it, what holds it in QC, POs, WIP.
 *   ความพร้อมรายงาน RRS.planning.readiness per open job: what each line still lacks and where it could come from.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const P = RRS.planning;
  if (!P) return; // the planning module is not part of this build
  const { h } = RRS.ui;
  const { t } = h;
  const U = RRS.util;

  const STEP = 300;
  const HOLD = ['QC_HOLD', 'QUARANTINE', 'REWORK'];
  const READY_TONE = { READY: 'ok', QC: 'warn', WIP: 'info', SHORT: 'bad' };
  const JOB_TONE = { OPEN: 'info', IN_PROGRESS: 'accent', DONE: 'ok', DELIVERED: 'muted', CANCELLED: 'bad' };
  const dash = t`<span class="muted">–</span>`;
  const n0 = (v) => (v ? h.fmt.num(v) : dash);
  const low = (s) => String(s == null ? '' : s).toLowerCase();
  const jobBadge = (s) => h.badge(P.JOB_STATUS[s] || s, JOB_TONE[s]);

  let cache = { key: '', map: {} };
  function readyOf(ctx, jobNo) {
    const key = `${ctx.state.seq}|${ctx.state.head}|${ctx.today}`;
    if (cache.key !== key) cache = { key, map: {} };
    if (!(jobNo in cache.map)) cache.map[jobNo] = P.readiness(ctx.state, jobNo, { today: ctx.today });
    return cache.map[jobNo];
  }
  function pctOf(rd) {
    if (!rd) return null;
    let req = 0;
    let miss = 0;
    for (const l of rd.lines) {
      if (!(l.required > 0)) continue;
      req += l.required;
      miss += Math.min(l.required, l.missing);
    }
    return req > 0 ? (req - miss) / req : null;
  }
  /** Where the missing part of a job line could come from (nothing here is ready to issue). */
  function whereText(l) {
    if (!(l.missing > 0)) return '';
    const parts = [];
    if (l.qcHold > 0) parts.push(`รอตรวจ/กักกัน ${h.fmt.num(l.qcHold)} (ต้องให้ QC ปล่อยก่อน)`);
    if (l.inProduction > 0) parts.push(`กำลังผลิต ${h.fmt.num(l.inProduction)}`);
    if (l.incoming > 0) parts.push(`จะเข้าจาก PO ${h.fmt.num(l.incoming)}${l.nextIncomingDate ? ' ครั้งแรก ' + h.fmt.date(l.nextIncomingDate) : ''}`);
    return parts.length ? parts.join(' · ') : 'ไม่มีที่ไหนเลย – ต้องขอซื้อหรือตั้งผลิตเพิ่ม';
  }

  // ---- six boxes -------------------------------------------------------------------------------------------------
  function sixRows(ctx) {
    const v = ctx.view;
    const q = low(v.q).trim();
    const items = ctx.state.tables.items || {};
    return P.six(ctx.state, { wh: v.wh || '', today: ctx.today, all: !!v.all }).filter((r) => {
      if (v.short && !(r.short > 0)) return false;
      if (v.flag && !r.flags.length) return false;
      const it = items[r.code] || {};
      if (q && ![r.code, r.name, it.expressCode, it.countCode, it.group, it.model].some((x) => low(x).indexOf(q) >= 0)) return false;
      return true;
    });
  }
  function sixTable(ctx, rows, limit) {
    const v = ctx.view;
    return h.table({
      id: 'rd-six', scroll: true, dense: true, rows: rows.slice(0, limit), rowAct: 'pickCode', rowArg: (r) => r.code,
      rowCls: (r) => (r.code === v.sel ? 'sel' : r.short > 0 ? 'row-bad' : ''),
      empty: 'ไม่พบรายการตามตัวกรอง', emptyText: 'ลองล้างตัวกรอง หรือติ๊ก แสดงทุกสินค้า',
      cols: [
        { label: 'รหัส', render: (r) => t`${h.code(r.code)}${r.name ? t`<br><small class="muted">${r.name}</small>` : ''}` },
        { label: 'มีจริง', num: true, render: (r) => n0(r.onHand) },
        { label: 'รอตรวจ/กักกัน', num: true, render: (r) => n0(r.qcHold) },
        { label: 'จองแล้ว', num: true, render: (r) => n0(r.reserved) },
        { label: 'พร้อมเบิก', num: true, render: (r) => (r.free ? t`<b>${h.fmt.num(r.free)}</b>` : dash) },
        { label: 'กำลังผลิต', num: true, render: (r) => t`${n0(r.wip)}${r.waitingReceipt ? t`<br><small class="muted">รอรับเข้า ${h.fmt.num(r.waitingReceipt)}</small>` : ''}` },
        { label: 'จะเข้า', num: true, render: (r) => t`${n0(r.incoming)}${r.nextIncomingDate ? t`<br><small class="muted">${h.fmt.date(r.nextIncomingDate)}</small>` : ''}${r.lateIncoming ? t`<br>${h.badge('ช้า ' + h.fmt.num(r.lateIncoming), 'warn')}` : ''}` },
        { label: 'ต้องใช้', num: true, render: (r) => n0(r.demand) },
        { label: 'ขาด', num: true, render: (r) => (r.short > 0 ? h.badge(h.fmt.num(r.short), 'bad') : dash) },
        { label: 'หน่วย', get: (r) => r.baseUnit },
        { label: 'หมายเหตุ', render: (r) => (r.overReserved > 0 ? h.badge(`จองเกินของที่มี ${h.fmt.num(r.overReserved)}`, 'warn') : '') },
      ],
    });
  }
  const LEGEND = [
    ['มีจริง', 'ของในคลังทุกสถานะ (ไม่รวมของระหว่างโอน)'],
    ['รอตรวจ/กักกัน', 'รอตรวจ + กักกัน + รอแก้ไข – อยู่ในคลังแต่เบิกไม่ได้จนกว่า QC จะปล่อย'],
    ['จองแล้ว', 'ที่จองให้งานไว้และยังไม่ได้เบิก'],
    ['พร้อมเบิก', 'ของสถานะ ใช้ได้ − ที่จองให้งานแล้ว (คิดรายคลัง) – จองหรือเบิกได้ทันที'],
    ['กำลังผลิต', 'ใบงานที่ยังไม่ปิด: ตั้งผลิต − ผลิตเสร็จ (รอรับเข้า = ผลิตเสร็จแล้วแต่ยังไม่รับเข้าคลัง)'],
    ['จะเข้า', 'PO ที่ออกแล้วยังรับไม่ครบ พร้อมวันที่จะเข้าเร็วที่สุด'],
    ['ต้องใช้', 'ใบงานที่ยังไม่ปิด: ต้องใช้ − เบิกแล้ว'],
    ['ขาด', 'ต้องใช้ − จองแล้ว − พร้อมเบิก (ไม่ต่ำกว่า 0)'],
  ];
  function legend() {
    return t`${h.note(t`<b>ของที่จะผลิตภายหลัง (กำลังผลิต) ของที่ยังรอตรวจ/กักกัน และของที่ยังไม่เข้า (จะเข้า) ไม่นับเป็นของพร้อมเบิกเด็ดขาด</b> – พร้อมเบิกนับเฉพาะของสถานะ ใช้ได้ ที่อยู่ในคลังแล้วและยังไม่ถูกจอง`, 'warn')}
      <details><summary class="hint">ความหมายของแต่ละช่อง</summary>${h.dl(LEGEND.map(([k, x]) => [k, x]))}</details>`;
  }
  function sixKpis(ctx) {
    const all = P.six(ctx.state, { today: ctx.today });
    const c = (f) => all.filter(f).length;
    const short = c((r) => r.short > 0);
    const over = c((r) => r.overReserved > 0);
    const late = c((r) => r.lateIncoming > 0);
    const held = c((r) => r.qcHold > 0);
    return h.kpis([
      h.kpi('รายการที่ขาด', h.fmt.num(short), short ? 'ต้องใช้มากกว่าที่จอง + พร้อมเบิก' : 'ไม่มีรายการที่ขาด', short ? 'bad' : 'ok'),
      h.kpi('มีของรอตรวจ/กักกัน', h.fmt.num(held), 'รายการ – ยังเบิกไม่ได้', held ? 'warn' : ''),
      h.kpi('ของเข้าช้ากว่ากำหนด', h.fmt.num(late), 'PO เลยวันส่งแล้วยังรับไม่ครบ', late ? 'warn' : ''),
      h.kpi('จองเกินของที่มี', h.fmt.num(over), over ? 'ปรับยอดลดหลังจองแล้ว – ตรวจการจอง' : 'ไม่มี', over ? 'bad' : ''),
    ]);
  }
  /** Everything about one code: warehouses, jobs that need it, QC holds, POs and work in progress. */
  function codeDetail(ctx, code) {
    const it = ctx.item(code) || {};
    const unit = it.baseUnit || '';
    const whs = {};
    const at = (wh) => whs[wh] || (whs[wh] = { wh, available: 0, hold: 0, reserved: 0 });
    for (const b of RRS.q.rows(ctx.state, 'balances', (x) => x.code === code && x.wh !== RRS.TRANSIT)) {
      if (b.status === 'AVAILABLE') at(b.wh).available = U.round(at(b.wh).available + b.qty);
      else if (HOLD.indexOf(b.status) >= 0) at(b.wh).hold = U.round(at(b.wh).hold + b.qty);
    }
    for (const r of P.reservations(ctx.state, { code, open: true })) at(r.wh).reserved = U.round(at(r.wh).reserved + P.remaining(r));
    const whRows = Object.values(whs).sort((a, b) => a.wh.localeCompare(b.wh));
    const need = [];
    const make = [];
    for (const j of P.jobs(ctx.state, { open: true })) {
      for (const l of j.lines || []) {
        if (l.code !== code) continue;
        if (!l.output && l.required - l.issued > 0) {
          const rl = (readyOf(ctx, j.jobNo).lines || []).find((x) => x.line === l.line) || {};
          need.push({ j, l, rl });
        }
        if (l.toMake - l.finished > 0 || l.finished - l.received > 0) make.push({ j, l });
      }
    }
    const holds = RRS.q.rows(ctx.state, 'balances', (b) => b.code === code && HOLD.indexOf(b.status) >= 0 && b.qty > 0 && b.wh !== RRS.TRANSIT);
    const pos = [];
    for (const po of RRS.q.rows(ctx.state, 'pos', (x) => x.status === 'ISSUED' || x.status === 'PARTIAL')) {
      for (const l of po.lines || []) {
        if (l.code !== code) continue;
        const base = l.base != null ? Number(l.base) : Number(l.qty || 0) * Number(l.factor || 1);
        const out = U.round(base - (l.received || 0) - (l.cancelled || 0));
        if (out > 0) pos.push({ po, l, out, due: String(l.dueDate || po.dueDate || '').slice(0, 10) });
      }
    }
    const sub = (title, body) => t`<h3>${title}</h3>${body}`;
    return h.section(t`${h.code(code)} ${it.name || ''}`, t`
      ${sub('ตามคลัง', h.table({ rows: whRows, dense: true, empty: 'ไม่มีของในคลังใด', emptyText: '',
        cols: [{ label: 'คลัง', render: (w) => h.code(w.wh) }, { label: 'ใช้ได้', num: true, key: 'available' }, { label: 'รอตรวจ/กักกัน', num: true, key: 'hold' },
          { label: 'จองแล้ว', num: true, key: 'reserved' }, { label: 'พร้อมเบิก', num: true, render: (w) => t`<b>${h.fmt.num(Math.max(0, U.round(w.available - w.reserved)))}</b>` }] }))}
      ${sub('งานที่ยังต้องใช้', h.table({ rows: need, dense: true, scroll: true, empty: 'ไม่มีงานที่ยังไม่ปิดต้องใช้รายการนี้', emptyText: '',
        cols: [{ label: 'ใบงาน', render: (x) => h.link(h.code(x.j.jobNo), 'readiness', { tab: 'jobs', job: x.j.jobNo }) }, { label: 'SO', get: (x) => x.j.soNo },
          { label: 'กำหนด', get: (x) => (x.j.dueDate ? h.fmt.date(x.j.dueDate) : '') }, { label: 'ลำดับ', num: true, get: (x) => x.j.priority },
          { label: 'ยังต้องเบิก', num: true, get: (x) => U.round(x.l.required - x.l.issued) }, { label: 'จองไว้', num: true, get: (x) => x.rl.reservedRemaining || 0 },
          { label: 'ขาด', num: true, render: (x) => (x.rl.missing > 0 ? h.badge(h.fmt.num(x.rl.missing), 'bad') : dash) },
          { label: 'สถานะ', render: (x) => (x.rl.status ? h.badge(x.rl.status, READY_TONE[x.rl.statusCode]) : '') }] }))}
      ${sub('รอตรวจ / กักกัน อยู่ที่', h.table({ rows: holds, dense: true, empty: 'ไม่มีของรอตรวจหรือกักกัน', emptyText: '',
        cols: [{ label: 'ตำแหน่ง', render: (b) => h.code(`${b.wh}${b.bin ? '/' + b.bin : ''}`) }, { label: 'สถานะ', render: (b) => h.statusBadge(b.status) },
          { label: 'ล็อต', get: (b) => b.lot }, { label: 'จำนวน', num: true, render: (b) => h.qty(b.qty, unit) }] }))}
      ${sub('กำลังผลิต', h.table({ rows: make, dense: true, empty: 'ไม่มีใบงานที่ตั้งผลิตรายการนี้', emptyText: '',
        cols: [{ label: 'ใบงาน', render: (x) => h.code(x.j.jobNo) }, { label: 'ตั้งผลิต', num: true, get: (x) => x.l.toMake }, { label: 'ผลิตเสร็จ', num: true, get: (x) => x.l.finished },
          { label: 'รับเข้าแล้ว', num: true, get: (x) => x.l.received }, { label: 'ยังผลิตอยู่', num: true, get: (x) => Math.max(0, U.round(x.l.toMake - x.l.finished)) }] }))}
      ${sub('จะเข้าจาก PO', h.table({ rows: pos, dense: true, empty: 'ไม่มี PO ที่ค้างรับ', emptyText: '',
        cols: [{ label: 'PO', render: (x) => h.code(x.po.poNo) }, { label: 'ผู้ขาย', get: (x) => x.po.supplier }, { label: 'คลัง', get: (x) => x.l.wh },
          { label: 'กำหนดส่ง', render: (x) => (x.due ? t`${h.fmt.date(x.due)}${x.due < ctx.today ? t` ${h.badge('เลยกำหนด', 'warn')}` : ''}` : dash) }, { label: 'ค้างรับ', num: true, render: (x) => h.qty(x.out, unit) }] }))}`,
    { id: 'rd-detail', actions: t`${h.link('ดูยอดคงเหลือ', 'stock', { sel: code })} ${h.btn('ปิด', { act: 'close', tone: 'quiet', small: true })}` });
  }
  function sixTab(ctx) {
    const v = ctx.view;
    const hasAny = RRS.q.rows(ctx.state, 'items').length > 0;
    if (!hasAny) {
      return h.empty('ยังไม่มีสินค้า', 'เพิ่มสินค้าในทะเบียนสินค้าก่อน – สต็อก 6 ช่องจะขึ้นเมื่อมีของในคลัง ใบงานที่ต้องใช้ หรือ PO ที่จะเข้า', h.link('ไปทะเบียนสินค้า', 'items'));
    }
    const rows = sixRows(ctx);
    const limit = v.limit || STEP;
    const filteredOn = v.q || v.wh || v.short || v.all || v.flag;
    const left = [
      h.field({ name: 'q', label: 'ค้นหา', value: v.q, placeholder: 'รหัส ชื่อ รหัส Express กลุ่ม…', act: 'filter', live: true, id: 'rd-q' }),
      h.field({ name: 'wh', label: 'คลัง', type: 'select', value: v.wh, options: h.whOptions(ctx.state), blank: 'ทุกคลัง', act: 'filter', id: 'rd-wh' }),
      h.field({ name: 'short', label: 'เฉพาะที่ขาด', type: 'checkbox', value: v.short, act: 'filter', id: 'rd-short' }),
      h.field({ name: 'all', label: 'แสดงทุกสินค้า (รวมที่เป็น 0)', type: 'checkbox', value: v.all, act: 'filter', id: 'rd-all' }),
    ];
    const right = [filteredOn ? h.btn('ล้างตัวกรอง', { act: 'clear', tone: 'ghost' }) : '', rows.length ? h.btn('ดาวน์โหลด CSV', { act: 'csv', tone: 'ghost' }) : ''];
    const sel = v.sel && RRS.q.get(ctx.state, 'items', v.sel) ? v.sel : null;
    const none = !rows.length && !filteredOn;
    const list = none
      ? h.empty('ยังไม่มีของ งาน หรือ PO ที่เกี่ยวข้อง', 'แถวจะขึ้นเมื่อมีของในคลัง ใบงานที่ต้องใช้ หรือ PO ที่จะเข้า – ติ๊ก แสดงทุกสินค้า เพื่อดูทุกรายการที่เป็น 0',
        t`<div class="form-actions">${h.link('สร้างใบงาน', 'jobs')}${h.link('ย้ายยอดตั้งต้น / รับเข้า', 'stock')}</div>`)
      : sixTable(ctx, rows, limit);
    const more = rows.length > limit
      ? t`<p class="hint">แสดง ${h.fmt.num(limit)} จาก ${h.fmt.num(rows.length)} รายการ ${h.btn(`แสดงเพิ่มอีก ${h.fmt.num(Math.min(STEP, rows.length - limit))} รายการ`, { act: 'more', tone: 'ghost', small: true })}</p>`
      : rows.length ? t`<p class="hint">${h.fmt.num(rows.length)} รายการ · คลิกแถวเพื่อดูว่าของอยู่ที่ไหน งานไหนต้องใช้ และจะเข้าเมื่อไร</p>` : '';
    return t`${sixKpis(ctx)}${legend()}
      ${h.toolbar(left, right)}
      ${v.wh ? h.note(`กรองคลัง ${v.wh}: มีจริง รอตรวจ จองแล้ว พร้อมเบิก และจะเข้า เป็นของคลังนี้ · กำลังผลิตและต้องใช้ไม่ผูกกับคลัง จึงแสดงเต็มจำนวน`, 'info') : ''}
      ${sel ? codeDetail(ctx, sel) : ''}
      <div>${list}${more}</div>`;
  }

  // ---- per-job readiness ---------------------------------------------------------------------------------------------
  function jobDetail(ctx, job) {
    const rd = readyOf(ctx, job.jobNo);
    if (!rd) return '';
    const canRes = ctx.can('reserve.manage');
    const open = job.status === 'OPEN' || job.status === 'IN_PROGRESS';
    const canAlloc = rd.lines.some((l) => l.allocated > 0);
    const it = job.product ? ctx.item(job.product) || {} : null;
    const head = t`${h.code(job.jobNo)} ${job.soNo ? 'SO ' + job.soNo : ''} ${rd.lines.length ? (rd.ready ? h.badge('พร้อมผลิต', 'ok') : h.badge(`ขาด ${rd.missing.length} รายการ`, 'bad')) : ''}`;
    const facts = h.dl([
      ['สินค้าที่ผลิต', job.product ? `${job.product} ${it.name || ''} · BOM ฉบับ ${job.bomRev}` : job.source === 'sales' ? 'ยังไม่ผูก BOM' : 'ระบุรายการเอง'],
      ['จำนวนชุด', job.qty ? h.fmt.num(job.qty) : ''], ['วันต้องใช้', job.dueDate ? h.fmt.date(job.dueDate) : ''], ['ลำดับความสำคัญ', job.priority], ['สถานะ', jobBadge(job.status)],
      rd.output ? ['สินค้าที่ผลิต: เสร็จ / รับเข้า', `${h.fmt.num(rd.output.finished)} / ${h.fmt.num(rd.output.received)} จาก ${h.fmt.num(rd.output.toMake)}`] : null,
    ]);
    if (!rd.lines.length) {
      return h.section(head, t`${facts}${h.empty(job.source === 'sales' ? 'ยังไม่ได้จับคู่กับ BOM' : 'ใบงานนี้ไม่มีรายการ', job.source === 'sales' ? 'ความพร้อมจะขึ้นเมื่อฝ่ายวางแผนจับคู่ SO กับสินค้าที่มี BOM อนุมัติที่หน้า งาน/SO และการจอง' : '', h.link('ไปที่ใบงาน', 'jobs', { sel: job.jobNo }))}`, { id: 'rd-job' });
    }
    const tbl = h.table({
      id: 'rd-lines', rows: rd.lines, dense: true, scroll: true, rowCls: (l) => (l.missing > 0 ? 'row-bad' : ''),
      cols: [
        { label: 'รายการ', render: (l) => t`${h.code(l.code)}${l.extra ? t` ${h.badge('เบิกนอกแผน', 'warn')}` : ''}${l.name ? t`<br><small class="muted">${l.name}</small>` : ''}` },
        { label: 'ต้องใช้', num: true, render: (l) => h.fmt.num(l.required) },
        { label: 'เบิกแล้ว', num: true, render: (l) => n0(l.issued) },
        { label: 'จองไว้', num: true, render: (l) => n0(l.reservedRemaining) },
        { label: 'ยังไม่จอง', num: true, render: (l) => n0(l.unreserved) },
        { label: 'พร้อมเบิกตอนนี้', num: true, render: (l) => n0(l.freeNow) },
        { label: 'จัดให้งานนี้ได้', num: true, render: (l) => n0(l.allocated) },
        { label: 'ขาด', num: true, render: (l) => (l.missing > 0 ? h.badge(h.fmt.num(l.missing), 'bad') : dash) },
        { label: 'ส่วนที่ขาดอยู่ที่', render: (l) => (l.missing > 0 ? t`<small>${whereText(l)}</small>` : '') },
        { label: 'สถานะ', render: (l) => h.badge(l.status, READY_TONE[l.statusCode]) },
      ],
    });
    const missing = rd.lines.filter((l) => l.missing > 0);
    return h.section(head, t`${facts}
      ${!rd.bomOk ? h.note(`BOM ของ ${job.product} เปลี่ยนเป็นฉบับ ${rd.approvedRev || '(ไม่มีฉบับที่อนุมัติ)'} แล้ว แต่ใบงานใช้ฉบับ ${job.bomRev} – หยิบของไม่ได้จนกว่าจะตรวจใบงาน`, 'bad') : ''}
      ${missing.length ? h.note(t`<b>ยังขาด:</b><ul class="errs">${missing.map((l) => t`<li>${l.code} ${l.name} ขาด ${h.fmt.num(l.missing)} ${l.baseUnit} – ${whereText(l)}</li>`)}</ul>`, 'bad') : h.note('ทุกรายการพร้อม: เบิกแล้ว จองไว้ หรือมีของพร้อมเบิกที่จัดให้งานนี้ได้ครบ', 'ok')}
      ${tbl}
      <p class="hint">จัดให้งานนี้ได้ = ของพร้อมเบิกที่ยังไม่จอง แบ่งให้งานลำดับความสำคัญสูงกว่า/วันต้องใช้เร็วกว่าก่อน ที่เหลือจึงเป็นของงานนี้ – ยังไม่ได้กันไว้จนกว่าจะจอง · รอตรวจ กำลังผลิต และจะเข้า ไม่นับเป็นพร้อม</p>
      <div class="form-actions">${canRes && open && canAlloc ? h.btn('จองส่วนที่จัดให้ได้ (จองอัตโนมัติ)', { act: 'auto', arg: job.jobNo, tone: 'primary' }) : ''}${h.link('ไปที่ใบงานและการจอง', 'jobs', { sel: job.jobNo })} ${h.link('ใบจัดชุด', 'picking', { job: job.jobNo })}</div>`,
    { id: 'rd-job', actions: h.btn('ปิด', { act: 'closeJob', tone: 'quiet', small: true }) });
  }
  function jobsTab(ctx) {
    const v = ctx.view;
    const open = P.jobs(ctx.state, { open: true });
    if (!open.length) {
      return h.empty('ไม่มีใบงานที่ยังไม่ปิด', 'ความพร้อมผลิตจะขึ้นเมื่อมีใบงาน – ระบบบอกว่าแต่ละงานขาดอะไร และส่วนที่ขาดรอตรวจ กำลังผลิต หรือจะเข้าเมื่อไร', h.link('ไปหน้า งาน/SO และการจอง', 'jobs'));
    }
    const sel = v.job ? RRS.q.get(ctx.state, 'jobs', U.normCode(v.job)) : null;
    const tbl = h.table({
      id: 'rd-jobs', rows: open, scroll: true, rowAct: 'pickJob', rowArg: (j) => j.jobNo, rowCls: (j) => (sel && j.jobNo === sel.jobNo ? 'sel' : ''),
      cols: [
        { label: 'ใบงาน', render: (j) => h.code(j.jobNo) },
        { label: 'SO', get: (j) => j.soNo },
        { label: 'สินค้า', render: (j) => (j.product ? h.code(j.product) : j.source === 'sales' ? h.badge('ยังไม่ผูก BOM', 'warn') : t`<span class="muted">ระบุรายการเอง</span>`) },
        { label: 'กำหนด', render: (j) => (j.dueDate ? t`${h.fmt.date(j.dueDate)}${j.dueDate < ctx.today ? t` ${h.badge('เลยกำหนด', 'bad')}` : ''}` : dash) },
        { label: 'ลำดับ', num: true, key: 'priority' },
        { label: 'ความพร้อม', w: '150px', render: (j) => { const pct = pctOf(readyOf(ctx, j.jobNo)); return pct == null ? dash : h.meter(pct, h.fmt.pct(pct, 0)); } },
        { label: 'ขาด', render: (j) => {
          const rd = readyOf(ctx, j.jobNo);
          if (!rd || !rd.lines.length) return '';
          if (rd.ready) return h.badge('พร้อม', 'ok');
          return t`<small>${rd.missing.slice(0, 3).map((m) => `${m.code} ${h.fmt.num(m.missing)}`).join(' · ')}${rd.missing.length > 3 ? ` และอีก ${rd.missing.length - 3}` : ''}</small>`;
        } },
      ],
    });
    return t`${h.note('เรียงตามลำดับความสำคัญแล้ววันต้องใช้ – ของพร้อมเบิกที่ยังไม่จองถูกแบ่งให้งานด้านบนก่อน คลิกงานเพื่อดูว่าขาดอะไร และส่วนที่ขาดอยู่ที่ไหน', 'info')}
      ${sel ? jobDetail(ctx, sel) : ''}${tbl}`;
  }

  RRS.ui.page({
    id: 'readiness', title: 'สต็อก 6 ช่อง และความพร้อมผลิต', phase: 2, order: 30,
    sub: 'มีจริง · รอตรวจ/กักกัน · จองแล้ว · พร้อมเบิก · กำลังผลิต · จะเข้า เทียบกับที่งานต้องใช้ – และงานไหนพร้อมผลิต งานไหนขาดอะไร',
    render(ctx) {
      const v = ctx.view;
      const tab = v.tab === 'jobs' ? 'jobs' : 'six';
      const openJobs = P.jobs(ctx.state, { open: true }).length;
      return t`${h.tabs([{ id: 'six', label: 'สต็อก 6 ช่อง' }, { id: 'jobs', label: 'ความพร้อมรายงาน', count: openJobs }], tab)}
        ${tab === 'six' ? sixTab(ctx) : jobsTab(ctx)}`;
    },
    after(ctx, root0) {
      const v = ctx.view;
      if (v._scroll) {
        v._scroll = false;
        const d = root0.querySelector(v.tab === 'jobs' ? '#rd-job' : '#rd-detail');
        if (d) setTimeout(() => d.scrollIntoView({ block: 'start' }), 0);
      }
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg }),
      pickCode: (ctx, el) => ctx.set({ sel: el.dataset.arg, _scroll: true }),
      pickJob: (ctx, el) => ctx.set({ job: el.dataset.arg, _scroll: true }),
      close: (ctx) => ctx.set({ sel: null }),
      closeJob: (ctx) => ctx.set({ job: null }),
      more: (ctx) => ctx.set({ limit: (ctx.view.limit || STEP) + STEP }),
      clear: (ctx) => ctx.set({ q: '', wh: '', short: false, all: false, flag: false, limit: STEP }),
      filter(ctx, el) {
        ctx.set({ [el.name]: el.type === 'checkbox' ? el.checked : el.value, limit: STEP });
      },
      async auto(ctx, el) {
        const jobNo = el.dataset.arg;
        const ok = await ctx.confirm({ title: `จองอัตโนมัติให้ ${jobNo}`, ok: 'จองอัตโนมัติ',
          message: 'จองของพร้อมเบิก (ใช้ได้ − จองให้งานอื่น) ในทุกคลังที่คุณมีสิทธิ์ ให้ทุกบรรทัดที่ยังไม่ได้จอง · ไม่จองส่วนที่ตั้งให้ผลิตเอง' });
        if (!ok) return;
        await ctx.exec('reserve.auto', { jobNo }, { done: (x) => `จองอัตโนมัติ ${x.result.created.length} ใบแล้ว${x.result.short.length ? ` – ยังขาด ${x.result.short.map((s) => `${s.code} ${h.fmt.num(s.short)}`).join(', ')}` : ''}` });
      },
      async csv(ctx) {
        const v = ctx.view;
        const out = [['รหัสสินค้า', 'ชื่อสินค้า', 'หน่วย', 'มีจริง', 'รอตรวจ/กักกัน', 'จองแล้ว', 'พร้อมเบิก', 'กำลังผลิต', 'รอรับเข้า', 'จะเข้า', 'วันเข้าเร็วสุด', 'จะเข้าช้ากว่ากำหนด', 'ต้องใช้', 'ขาด', 'จองเกินของที่มี']];
        for (const r of sixRows(ctx)) {
          out.push([r.code, r.name, r.baseUnit, r.onHand, r.qcHold, r.reserved, r.free, r.wip, r.waitingReceipt, r.incoming, r.nextIncomingDate, r.lateIncoming, r.demand, r.short, r.overReserved]);
        }
        await ctx.download(`stock-6-boxes${v.wh ? '-' + v.wh : ''}-${ctx.today}.csv`, h.csv(out));
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
