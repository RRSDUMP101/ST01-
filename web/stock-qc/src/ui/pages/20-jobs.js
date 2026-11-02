/*
 * Phase 2 – งาน/SO และการจอง (RRS.planning, and RRS.sales for jobs that came from Sales Office).
 *   list      jobs with filters (status / priority / source / late / search), readiness % per open job, CSV
 *   create    from a product with an APPROVED BOM × sets (job.create {product, qty}) or own lines ({lines})
 *   detail    lines (required, issued, to make, finished, received, reserved remaining, free now) with ตั้งผลิตเอง
 *             (job.setMake) and บันทึกผลิตเสร็จ (job.record); reservations (reserve.create / change / release / auto);
 *             close as DONE / DELIVERED (job.status), cancel with a reason (job.cancel releases the reservations)
 *   sales     workspace Domestic/Export, SO number and IDs, the SO lines as received (read-only), จับคู่กับ BOM
 *             (sales.mapJob – the planner picks the product and confirms the sets, never matched by name) and the
 *             release blockers (RRS.sales.statusFor + what Sales Office sent).
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const P = RRS.planning;
  if (!P) return; // the planning module is not part of this build
  const { h } = RRS.ui;
  const { t } = h;
  const U = RRS.util;

  const STEP = 200;
  const OPEN = { OPEN: true, IN_PROGRESS: true };
  const JOB_TONE = { OPEN: 'info', IN_PROGRESS: 'accent', DONE: 'ok', DELIVERED: 'muted', CANCELLED: 'bad' };
  const RES_TONE = { OPEN: 'info', PARTIAL: 'warn', FILLED: 'ok', RELEASED: 'muted' };
  const READY_TONE = { READY: 'ok', QC: 'warn', WIP: 'info', SHORT: 'bad' };
  const PRIO = [[1, '1 · ด่วนที่สุด'], [2, '2 · ด่วน'], [3, '3 · ปกติ'], [4, '4 · รอได้'], [5, '5 · ไม่เร่ง']];
  const WS_SHORT = { domestic: 'Domestic', export: 'Export' };
  const dash = t`<span class="muted">–</span>`;
  const n0 = (v) => (v ? h.fmt.num(v) : dash);
  const low = (s) => String(s == null ? '' : s).toLowerCase();
  const jobBadge = (s) => h.badge(P.JOB_STATUS[s] || s, JOB_TONE[s]);
  const resBadge = (s) => h.badge(P.RES_STATUS[s] || s, RES_TONE[s]);
  const prioText = (p) => (PRIO.find((x) => x[0] === Number(p)) || [p, String(p || '–')])[1];
  const docView = (docNo) => ({ sel: docNo, lines: null, checked: null, header: null, tab: 'all', q: '', type: '' });
  const isSales = (j) => !!j && j.source === 'sales';
  const LOG_LABEL = { create: 'สร้างใบงาน', update: 'แก้ใบงาน', setMake: 'ตั้งผลิตเอง', record: 'บันทึกผลิตเสร็จ', status: 'ปิดงาน', cancel: 'ยกเลิกใบงาน',
    'sales.create': 'รับจาก Sales Office', 'sales.update': 'ปรับตาม Sales Office', 'sales.map': 'จับคู่กับ BOM' };
  const comp = (j) => (j.lines || []).filter((l) => !l.output);

  // ---- reads (cached per state version: readiness walks the whole state) ------------------------------------------
  let cache = { key: '', map: {} };
  function readyOf(ctx, jobNo) {
    const key = `${ctx.state.seq}|${ctx.state.head}|${ctx.today}`;
    if (cache.key !== key) cache = { key, map: {} };
    if (!(jobNo in cache.map)) cache.map[jobNo] = P.readiness(ctx.state, jobNo, { today: ctx.today });
    return cache.map[jobNo];
  }
  /** Average over the job's lines of the part that is issued, reserved or free to reserve now (null = nothing planned yet). */
  function pctOf(rd) {
    if (!rd) return null;
    // every line counts the same (units differ: 500 bolts must not hide 2 missing sheets)
    let n = 0;
    let sum = 0;
    for (const l of rd.lines) {
      if (!(l.required > 0)) continue;
      n++;
      sum += (l.required - Math.min(l.required, Math.max(0, l.missing))) / l.required;
    }
    return n > 0 ? sum / n : null;
  }
  function approvedBoms(ctx) {
    return RRS.q.rows(ctx.state, 'boms', (b) => b.status === 'APPROVED')
      .filter((b) => { const it = ctx.item(b.product); return it && it.active !== false; })
      .sort((a, b) => a.product.localeCompare(b.product));
  }
  function bomOptions(ctx) {
    return approvedBoms(ctx).map((b) => [b.product, `${b.product} · ${(ctx.item(b.product) || {}).name || ''} · ฉบับ ${b.rev}`]);
  }
  /** Per warehouse for one code: ใช้ได้, จองให้งานอื่น, งานนี้จองแล้ว, พร้อมเบิก. */
  function whFree(ctx, code, jobNo) {
    const out = {};
    const at = (wh) => out[wh] || (out[wh] = { wh, available: 0, other: 0, own: 0, free: 0 });
    for (const b of RRS.q.rows(ctx.state, 'balances', (x) => x.code === code && x.status === RRS.STATUS.AVAILABLE && x.wh !== RRS.TRANSIT)) {
      const w = at(b.wh);
      w.available = U.round(w.available + b.qty);
    }
    for (const r of P.reservations(ctx.state, { code, open: true })) {
      const w = at(r.wh);
      if (r.jobNo === jobNo) w.own = U.round(w.own + P.remaining(r));
      else w.other = U.round(w.other + P.remaining(r));
    }
    return Object.values(out).map((w) => Object.assign(w, { free: U.round(w.available - w.other - w.own) })).sort((a, b) => a.wh.localeCompare(b.wh));
  }

  // ---- Sales Office -----------------------------------------------------------------------------------------------
  function salesBlockers(ctx, job) {
    const S = RRS.sales;
    if (S && typeof S.statusFor === 'function') {
      try {
        const st = S.statusFor(ctx.state, job.jobNo, 0, { now: ctx.now });
        if (st) return st.blockers || [];
      } catch (e) { /* fall through to what Sales Office sent */ }
    }
    return ((job.salesRelease || {}).blockers || []).slice();
  }
  function salesSection(ctx, job) {
    const rel = job.salesRelease || {};
    const ws = job.workspace;
    const wsLabel = (RRS.sales && RRS.sales.WORKSPACES && RRS.sales.WORKSPACES[ws]) || ws || '–';
    const items = job.salesItems || [];
    const blockers = salesBlockers(ctx, job);
    const started = comp(job).some((l) => l.issued > 0 || l.finished > 0 || l.received > 0);
    const hasRes = P.reservations(ctx.state, { jobNo: job.jobNo, open: true }).length > 0;
    const canMap = ctx.can('job.manage') && !!RRS.sales && !job.cancelled && OPEN[job.status] && !started && !hasRes;
    const why = !ctx.can('job.manage') ? 'ฝ่ายวางแผนเป็นผู้จับคู่กับ BOM' : job.cancelled ? 'SO ถูกยกเลิกแล้ว' : !OPEN[job.status] ? 'ใบงานปิดแล้ว'
      : started ? 'งานเริ่มเบิก/ผลิตแล้ว – เปลี่ยน BOM ไม่ได้' : hasRes ? 'ใบงานนี้มีของจองอยู่ – ปล่อยการจองก่อนจับคู่ใหม่' : '';
    const facts = h.dl([
      ['พื้นที่ขาย', h.badge(wsLabel, ws === 'export' ? 'accent' : 'info')],
      ['เลขที่ SO', job.orderNumber || job.soNo],
      ['รหัส SO ใน Sales Office', job.orderId ? h.code(job.orderId) : ''],
      ['รหัสงานผลิตใน Sales Office', job.productionJobId ? h.code(job.productionJobId) : ''],
      ['รหัสลูกค้า', job.customerId ? h.code(job.customerId) : ''],
      ['รหัสดีล', job.dealId ? h.code(job.dealId) : ''],
      ['รุ่นรถตาม SO', job.vehicle],
      ['วันกำหนดตาม SO (ตามที่ได้รับ)', job.salesDue],
      ['ฉบับคำสั่งล่าสุด', job.salesVersion ? `ฉบับ ${job.salesVersion}${job.salesReceivedAt ? ' · รับ ' + h.fmt.dt(job.salesReceivedAt) : ''}` : ''],
      ['ผูกกับ BOM', job.product ? `${job.product} ฉบับ ${job.bomRev} × ${h.fmt.num(job.qty)} ชุด${job.mappedBy ? ' · โดย ' + ctx.userName(job.mappedBy) + ' ' + h.fmt.dt(job.mappedAt) : ''}` : 'ยังไม่ผูก'],
    ]);
    const soTable = h.table({
      rows: items, dense: true, scroll: true, empty: 'Sales Office ไม่ได้ส่งรายการ SO มา', emptyText: '',
      cols: [
        { label: 'รหัสบรรทัด', render: (x) => h.code(x.lineId) },
        { label: 'รายละเอียดตาม SO', key: 'description' },
        { label: 'จำนวน (ตามที่ได้รับ)', key: 'qty', cls: 'nowrap' },
        { label: 'หน่วย', key: 'unit' },
        { label: 'รหัสสินค้าใน Sales Office', render: (x) => (x.productId ? h.code(x.productId) : dash) },
      ],
    });
    const fromSo = (rel.blockers || []);
    const release = t`<p>${rel.allowed ? h.badge('Sales Office อนุญาตเริ่มผลิตแล้ว', 'ok') : h.badge('Sales Office ยังไม่อนุญาตเริ่มผลิต', 'warn')}
      ${rel.bomRevision ? t` <span class="hint">BOM ฉบับตาม Sales Office: ${rel.bomRevision}</span>` : ''}${rel.drawingRevision ? t` <span class="hint">· แบบฉบับ ${rel.drawingRevision}</span>` : ''}</p>
      ${fromSo.length ? t`<p class="hint">เงื่อนไขที่ Sales Office แจ้งมา:</p><ul class="errs">${fromSo.map((b) => t`<li>${b}</li>`)}</ul>` : ''}`;
    const block = blockers.length
      ? h.note(t`<b>ยังเริ่มผลิตไม่ได้ – สิ่งที่ระบบสต็อกจะรายงานกลับ Sales Office:</b><ul class="errs">${blockers.map((b) => t`<li>${b}</li>`)}</ul>`, 'warn')
      : h.note('ไม่มีเงื่อนไขค้าง – ผูก BOM ฉบับที่อนุมัติแล้ว และจองของครบทุกรายการ', 'ok');
    return h.section('ข้อมูลจาก Sales Office', t`${!canMap && why && RRS.sales ? t`<p class="hint" id="jb-map-why">จับคู่กับ BOM ไม่ได้ตอนนี้: ${why}</p>` : ''}${facts}
      ${job.cancelled ? h.note('Sales Office ยกเลิก SO นี้แล้ว – ของที่จองถูกปล่อยคืน ของที่เบิกไปแล้วให้คืนเข้าคลัง (RT) ที่หน้า ใบจัดชุด', 'bad') : ''}
      ${job.salesChanged ? h.note('รายการใน SO เปลี่ยนหลังผูก BOM – ตรวจรายการด้านล่างแล้วจับคู่กับ BOM ใหม่', 'warn') : ''}
      <h3>รายการ SO ตามที่ได้รับ</h3>${soTable}
      <p class="hint">อ่านอย่างเดียว · ระบบไม่แปลงรายการ SO เป็นรายการเบิกจากชื่อหรือจำนวนในข้อความ – ฝ่ายวางแผนเลือกสินค้าที่มี BOM อนุมัติ และยืนยันจำนวนชุดเอง</p>
      ${release}${block}`, {
      id: 'jb-sales', sub: 'ข้อมูลตามที่ Sales Office ส่งมา (รหัสเท่านั้น ไม่เก็บชื่อลูกค้า) · Domestic และ Export แยกกันเสมอ',
      actions: RRS.sales ? h.btn(job.product ? 'จับคู่กับ BOM ใหม่' : 'จับคู่กับ BOM', { act: 'mapBom', tone: job.product ? 'ghost' : 'primary', disabled: !canMap, title: why || null }) : '',
    });
  }

  // ---- list --------------------------------------------------------------------------------------------------------
  function filtered(ctx) {
    const v = ctx.view;
    const q = low(v.q).trim();
    const st = v.st || 'open';
    const list = P.jobs(ctx.state).filter((j) => {
      if (st === 'open' ? !OPEN[j.status] : st !== 'all' && j.status !== st) return false;
      if (v.pr && Number(j.priority) !== Number(v.pr)) return false;
      if (v.src === 'sales' && !isSales(j)) return false;
      if (v.src === 'own' && isSales(j)) return false;
      if (v.src === 'domestic' || v.src === 'export') { if (!isSales(j) || j.workspace !== v.src) return false; }
      if (v.late && !(OPEN[j.status] && j.dueDate && j.dueDate < ctx.today)) return false;
      if (q && ![j.jobNo, j.soNo, j.product, j.orderNumber, j.remark, (ctx.item(j.product) || {}).name].some((x) => low(x).indexOf(q) >= 0)) return false;
      return true;
    });
    // open work first, then the rest in the engine's order (priority, due date, created)
    return list.filter((j) => OPEN[j.status]).concat(list.filter((j) => !OPEN[j.status]));
  }
  function productCell(ctx, j) {
    if (j.product) {
      const it = ctx.item(j.product) || {};
      return t`${h.code(j.product)} <small class="muted">ฉบับ ${j.bomRev || '–'}</small>${it.name ? t`<br><small class="muted">${it.name}</small>` : ''}`;
    }
    if (isSales(j)) return h.badge('ยังไม่ผูก BOM', 'warn');
    return t`<span class="muted">ระบุรายการเอง (${comp(j).length} รายการ)</span>`;
  }
  function readyCell(ctx, j) {
    if (!OPEN[j.status]) return dash;
    const rd = readyOf(ctx, j.jobNo);
    const pct = pctOf(rd);
    if (pct == null) return isSales(j) && !j.product ? t`<small class="muted">รอผูก BOM</small>` : dash;
    const short = rd.lines.filter((l) => l.missing > 0).length;
    return t`${h.meter(pct, h.fmt.pct(pct, 0))}${rd.ready ? h.badge('พร้อม', 'ok') : h.badge(`ขาด ${short} รายการ`, 'bad')}`;
  }
  function listTable(ctx, rows, limit) {
    const v = ctx.view;
    return h.table({
      id: 'jb-list', scroll: true, rows: rows.slice(0, limit), rowAct: 'pick', rowArg: (j) => j.jobNo,
      rowCls: (j) => (j.jobNo === v.sel ? 'sel' : OPEN[j.status] ? '' : 'muted'),
      empty: 'ไม่พบใบงานตามตัวกรอง', emptyText: 'ลองล้างตัวกรอง หรือเลือกสถานะ ทั้งหมด',
      cols: [
        { label: 'เลขที่ใบงาน', render: (j) => t`${h.code(j.jobNo)}${isSales(j) ? t`<br>${h.badge('Sales Office · ' + (WS_SHORT[j.workspace] || j.workspace || ''), j.workspace === 'export' ? 'accent' : 'info')}` : ''}` },
        { label: 'SO', render: (j) => (j.soNo ? h.code(j.soNo) : dash) },
        { label: 'สินค้า / ฉบับ BOM', render: (j) => productCell(ctx, j) },
        { label: 'ชุด', num: true, render: (j) => n0(j.qty) },
        { label: 'กำหนด', render: (j) => (j.dueDate ? t`<span class="nowrap">${h.fmt.date(j.dueDate)}</span>${OPEN[j.status] && j.dueDate < ctx.today ? t`<br>${h.badge('เลยกำหนด', 'bad')}` : ''}` : dash) },
        { label: 'ลำดับ', num: true, render: (j) => (j.priority ? h.badge(String(j.priority), Number(j.priority) <= 2 ? 'warn' : 'muted') : dash) },
        { label: 'สถานะ', render: (j) => jobBadge(j.status) },
        { label: 'ความพร้อม', w: '150px', render: (j) => readyCell(ctx, j) },
      ],
    });
  }
  function kpis(ctx) {
    const open = P.jobs(ctx.state, { open: true });
    let ready = 0;
    let short = 0;
    let late = 0;
    for (const j of open) {
      const rd = readyOf(ctx, j.jobNo);
      if (pctOf(rd) != null) { if (rd.ready) ready++; else short++; }
      if (j.dueDate && j.dueDate < ctx.today) late++;
    }
    const unmapped = open.filter((j) => isSales(j) && !j.product).length;
    return h.kpis([
      h.kpi('งานที่ยังไม่ปิด', h.fmt.num(open.length), 'เปิด + กำลังทำ', 'info'),
      h.kpi('พร้อมผลิต', h.fmt.num(ready), 'เบิก/จอง/พร้อมเบิกครบทุกรายการ', ready ? 'ok' : ''),
      h.kpi('ขาดของ', h.fmt.num(short), short ? 'ดูว่าขาดอะไรที่ ความพร้อมรายใบงาน' : 'ไม่มีงานที่ขาดของ', short ? 'bad' : 'ok'),
      h.kpi('เลยกำหนด', h.fmt.num(late), 'วันต้องใช้ผ่านมาแล้ว', late ? 'warn' : ''),
      unmapped ? h.kpi('SO รอผูก BOM', h.fmt.num(unmapped), 'งานจาก Sales Office', 'warn') : '',
    ]);
  }

  // ---- detail ------------------------------------------------------------------------------------------------------
  function linesTable(ctx, job, rd) {
    const open = !!OPEN[job.status];
    const canRes = ctx.can('reserve.manage');
    const canJob = ctx.can('job.manage');
    const canRec = ctx.can('production.record');
    const canFr = ctx.can('doc.draft');
    const byLine = {};
    for (const l of (rd && rd.lines) || []) byLine[l.line] = l;
    const rows = (job.lines || []).slice().sort((a, b) => a.line - b.line);
    return h.table({
      id: 'jb-lines', rows, dense: true, scroll: true,
      empty: isSales(job) ? 'ยังไม่มีรายการ – จับคู่กับ BOM ก่อน' : 'ใบงานนี้ไม่มีรายการ', emptyText: isSales(job) ? 'รายการเบิกมาจาก BOM ที่อนุมัติ × จำนวนชุดที่ยืนยัน' : '',
      rowCls: (l) => (l.output ? 'row-warn' : ''),
      cols: [
        { label: '#', key: 'line' },
        { label: 'รายการ', render: (l) => { const it = ctx.item(l.code) || {}; return t`${h.code(l.code)}${l.output ? t` ${h.badge('สินค้าที่ผลิต', 'accent')}` : ''}${l.extra ? t` ${h.badge('เบิกนอกแผน', 'warn')}` : ''}${it.name ? t`<br><small class="muted">${it.name}</small>` : ''}`; } },
        // the actions sit right after the item, so a phone shows them without scrolling sideways
        { label: 'ทำรายการ', render: (l) => {
          const r = byLine[l.line];
          const need = r ? U.round(r.required - r.issued - r.reservedRemaining) : 0;
          const b = [];
          if (open && canRes && !l.output && need > 0) b.push(h.btn('จอง', { act: 'reserve', arg: l.line, small: true, tone: 'primary', title: `ยังต้องจองอีก ${need}` }));
          if (open && canJob && !(l.output && isSales(job) && !job.product)) b.push(h.btn('ตั้งผลิตเอง', { act: 'setMake', arg: l.line, small: true, tone: 'ghost' }));
          if (open && canRec && l.toMake > 0) b.push(h.btn('บันทึกผลิตเสร็จ', { act: 'record', arg: l.line, small: true, tone: 'ghost' }));
          if (canFr && l.finished > l.received) b.push(h.btn('รับเข้าคลัง (FR)', { act: 'fr', arg: l.line, small: true, tone: 'quiet' }));
          return b.length ? t`<span class="form-actions">${b}</span>` : dash;
        } },
        { label: 'ต่อชุด', num: true, render: (l) => (l.output ? dash : n0(l.per)) },
        { label: 'ต้องใช้', num: true, render: (l) => (l.output ? dash : t`<b>${h.fmt.num(l.required)}</b>`) },
        { label: 'เบิกแล้ว', num: true, render: (l) => (l.output ? dash : n0(l.issued)) },
        { label: 'ผลิตเอง', num: true, render: (l) => n0(l.toMake) },
        { label: 'ผลิตเสร็จ', num: true, render: (l) => n0(l.finished) },
        { label: 'รับเข้าแล้ว', num: true, render: (l) => n0(l.received) },
        { label: 'จองคงเหลือ', num: true, render: (l) => (l.output ? dash : n0((byLine[l.line] || {}).reservedRemaining)) },
        { label: 'พร้อมเบิกตอนนี้', num: true, render: (l) => (l.output ? dash : n0((byLine[l.line] || {}).freeNow)) },
        { label: 'สถานะ', render: (l) => { const r = byLine[l.line]; return !open || !r ? '' : t`${h.badge(r.status, READY_TONE[r.statusCode])}${r.missing > 0 ? t`<br><small class="muted">ขาด ${h.fmt.num(r.missing)}</small>` : ''}`; } },
      ],
    });
  }
  function resTable(ctx, job) {
    const v = ctx.view;
    const all = P.reservations(ctx.state, { jobNo: job.jobNo });
    const open = all.filter((r) => P.isOpen(r));
    const rows = v.resAll ? all : open;
    const jobOpen = !!OPEN[job.status];
    const tbl = h.table({
      id: 'jb-res', rows, dense: true, scroll: true,
      empty: all.length ? 'ไม่มีของที่ยังจองค้าง' : 'ยังไม่ได้จองของให้งานนี้',
      emptyText: all.length ? 'ใบจองที่เบิกครบหรือปล่อยแล้วกด แสดงทั้งหมด' : (ctx.can('reserve.manage') && jobOpen ? 'กด จอง ที่บรรทัดที่ต้องใช้ หรือ จองอัตโนมัติ' : 'ฝ่ายวางแผน/หัวหน้าสโตร์เป็นผู้จองของให้งาน'),
      rowCls: (r) => (P.isOpen(r) ? '' : 'muted'),
      cols: [
        { label: 'ใบจอง', render: (r) => t`${h.code(r.id)}${r.auto ? t` ${h.badge('อัตโนมัติ', 'muted')}` : ''}` },
        { label: 'รายการ', render: (r) => t`${h.code(r.code)}<br><small class="muted">${(ctx.item(r.code) || {}).name || ''}</small>` },
        { label: 'คลัง', render: (r) => h.code(r.wh) },
        { label: 'จอง', num: true, render: (r) => t`${h.fmt.num(r.qty)}${r.requested && r.requested !== r.qty ? t`<br><small class="muted">ขอ ${h.fmt.num(r.requested)}</small>` : ''}` },
        { label: 'เบิกแล้ว', num: true, render: (r) => n0(r.issued) },
        { label: 'คงเหลือ', num: true, render: (r) => (P.isOpen(r) ? t`<b>${h.fmt.num(P.remaining(r))}</b>` : dash) },
        { label: 'วันต้องใช้', get: (r) => (r.needDate ? h.fmt.date(r.needDate) : '') },
        { label: 'ลำดับ', num: true, key: 'priority' },
        { label: 'สถานะ', render: (r) => t`${resBadge(r.status)}${r.status === 'RELEASED' ? t`<br><small class="muted">${ctx.userName(r.releasedBy)} · ${r.reason}</small>` : ''}` },
        { label: '', render: (r) => (P.isOpen(r) && jobOpen && ctx.can('reserve.manage', r.wh)
          ? t`<span class="form-actions">${h.btn('เปลี่ยน', { act: 'resChange', arg: r.id, small: true, tone: 'ghost' })}${h.btn('ปล่อย', { act: 'resRelease', arg: r.id, small: true, tone: 'quiet' })}</span>` : '') },
      ],
    });
    const toggle = all.length !== open.length ? h.btn(v.resAll ? 'ซ่อนใบจองที่เบิกครบ/ปล่อยแล้ว' : `แสดงทั้งหมด (${all.length - open.length} ใบเบิกครบ/ปล่อยแล้ว)`, { act: 'resAll', tone: 'quiet', small: true }) : '';
    return t`<div id="jb-resv">${tbl}${toggle ? t`<p class="hint">${toggle}</p>` : ''}</div>`;
  }
  const FREE_NOTE = 'พร้อมเบิก = ของสถานะ "ใช้ได้" − ที่จองให้งานอื่น − ที่งานนี้จองไว้แล้ว · งานนี้ใช้ได้ = จองคงเหลือของงานนี้ + พร้อมเบิก · ของรอตรวจ/กักกัน/รอแก้ไข ของที่กำลังผลิต และของที่สั่งซื้อแต่ยังไม่เข้า ไม่นับเป็นพร้อมเบิก จึงจองไม่ได้';

  function detail(ctx, job) {
    const v = ctx.view;
    const rd = readyOf(ctx, job.jobNo);
    const open = !!OPEN[job.status];
    const canJob = ctx.can('job.manage');
    const canRes = ctx.can('reserve.manage');
    const it = job.product ? ctx.item(job.product) || {} : null;
    const outstanding = comp(job).filter((l) => l.issued > 0);
    const facts = h.dl([
      ['เลขที่ SO', job.soNo ? h.code(job.soNo) : ''],
      ['สินค้าที่ผลิต', job.product ? t`${h.code(job.product)} ${it.name || ''} · BOM ฉบับ ${job.bomRev}` : isSales(job) ? 'ยังไม่ผูก BOM' : 'ระบุรายการชิ้นส่วนเอง'],
      ['จำนวนชุด', job.qty ? h.fmt.num(job.qty) : ''],
      ['วันต้องใช้ / กำหนดเสร็จ', job.dueDate ? t`${h.fmt.date(job.dueDate)}${open && job.dueDate < ctx.today ? t` ${h.badge('เลยกำหนด', 'bad')}` : ''}` : ''],
      ['ลำดับความสำคัญ', prioText(job.priority)],
      ['สถานะ', jobBadge(job.status)],
      ['สร้างโดย', `${ctx.userName(job.createdBy)} · ${h.fmt.dt(job.createdAt)}`],
      job.doneAt ? ['ผลิตเสร็จ', `${ctx.userName(job.doneBy)} · ${h.fmt.dt(job.doneAt)}`] : null,
      job.deliveredAt ? ['ส่งมอบ', `${ctx.userName(job.deliveredBy)} · ${h.fmt.dt(job.deliveredAt)}`] : null,
      job.status === 'CANCELLED' ? ['ยกเลิก', `${ctx.userName(job.cancelledBy)} · ${h.fmt.dt(job.cancelledAt)} · ${job.cancelReason}`] : null,
      job.forced ? ['ยกเลิกแบบบังคับ', `มีของเบิกค้าง ${job.forced.outstanding.map((o) => `${o.code} ${o.issued}`).join(', ')}`] : null,
      job.remark ? ['หมายเหตุ', job.remark] : null,
    ]);
    const notes = [];
    if (rd && !rd.bomOk) notes.push(h.note(`BOM ของ ${job.product} เปลี่ยนเป็นฉบับ ${rd.approvedRev || '(ไม่มีฉบับที่อนุมัติ)'} แล้ว แต่ใบงานนี้ใช้ฉบับ ${job.bomRev} – หยิบของไม่ได้จนกว่าจะตรวจใบงาน${isSales(job) ? ' (จับคู่กับ BOM ใหม่)' : ' (ยกเลิกแล้วสร้างใบงานใหม่ตามฉบับที่อนุมัติ)'}`, 'bad'));
    if (!open) notes.push(h.note(`ใบงาน${P.JOB_STATUS[job.status]} – จองหรือเบิกเข้างานนี้เพิ่มไม่ได้${outstanding.length && job.status !== 'DELIVERED' ? ' · ของที่เบิกไปแล้วคืนเข้าคลังได้ที่หน้า ใบจัดชุดและหยิบของ' : ''}`, job.status === 'CANCELLED' ? 'bad' : 'info'));
    if (v.autoNote && v.autoNote.jobNo === job.jobNo) notes.push(autoNote(v.autoNote));
    const acts = [];
    if (canJob && job.status !== 'CANCELLED' && job.status !== 'DELIVERED') acts.push(h.btn('แก้วันต้องใช้ / ลำดับ', { act: 'edit', tone: 'ghost' }));
    if (canRes && open && comp(job).length) acts.push(h.btn('จองอัตโนมัติให้งานนี้', { act: 'auto', arg: job.jobNo, tone: 'ghost', title: 'จองจากของพร้อมเบิกทุกคลังที่คุณมีสิทธิ์ ให้ทุกบรรทัดที่ยังไม่ได้จอง' }));
    if (canJob && open) acts.push(h.btn('ปิดงาน: ผลิตเสร็จ', { act: 'done', tone: 'ghost' }));
    if (canJob && (open || job.status === 'DONE')) acts.push(h.btn('บันทึกส่งมอบแล้ว', { act: 'delivered', tone: 'ghost' }));
    if (canJob && job.status !== 'CANCELLED' && job.status !== 'DELIVERED') acts.push(h.btn('ยกเลิกใบงาน', { act: 'cancel', tone: 'danger' }));
    const log = (job.log || []).slice().reverse();
    const head = t`${h.code(job.jobNo)} ${job.soNo ? `SO ${job.soNo}` : ''} ${jobBadge(job.status)}`;
    return h.section(head, t`${facts}${notes}
      ${acts.length ? t`<div class="form-actions">${acts}</div>` : ''}
      ${isSales(job) ? salesSection(ctx, job) : ''}
      <h3>รายการที่งานนี้ต้องใช้</h3>
      ${linesTable(ctx, job, rd)}
      <p class="hint">ต้องใช้ = ต่อชุด × จำนวนชุด · ผลิตเอง = ส่วนที่ตั้งให้ผลิตในโรงงาน (ไม่จองจากสต็อก) · บรรทัดสินค้าที่ผลิตใช้รับเข้าคลังด้วยใบ FR ตามใบงาน</p>
      <h3>การจองของงานนี้</h3>
      ${h.note(FREE_NOTE, 'info')}
      ${resTable(ctx, job)}
      <h3>ประวัติใบงาน</h3>
      ${h.table({ rows: v.logAll ? log : log.slice(0, 5), dense: true, empty: 'ยังไม่มีประวัติ', emptyText: '',
        cols: [{ label: 'เวลา', get: (x) => h.fmt.dt(x.at) }, { label: 'ผู้ทำ', get: (x) => ctx.userName(x.by) }, { label: 'รายการ', get: (x) => LOG_LABEL[x.action] || x.action }, { label: 'รายละเอียด', key: 'detail' }] })}
      ${log.length > 5 ? t`<p class="hint">${h.btn(v.logAll ? 'แสดง 5 รายการล่าสุด' : `แสดงทั้งหมด ${log.length} รายการ`, { act: 'logAll', tone: 'quiet', small: true })}</p>` : ''}`,
    { id: 'jb-detail', actions: t`${h.link('ใบจัดชุดและหยิบของ', 'picking', { job: job.jobNo, vals: null, errs: null })} ${open ? h.link('ความพร้อมผลิต', 'readiness', { tab: 'jobs', job: job.jobNo }) : ''} ${h.btn('ปิด', { act: 'close', tone: 'quiet', small: true })}` });
  }
  function autoNote(a) {
    return h.note(t`จองอัตโนมัติ ${a.created.length} ใบ${a.created.length ? t`: ${a.created.map((c) => `${c.code} ${h.fmt.num(c.qty)} @${c.wh}`).join(', ')}` : ''}
      ${a.short.length ? t`<br>ยังขาด (ไม่มีของพร้อมเบิกพอ): ${a.short.map((s) => `${s.jobNo} ${s.code} ${h.fmt.num(s.short)}`).join(', ')}` : ''}`, a.short.length ? 'warn' : 'ok');
  }

  // ---- create ------------------------------------------------------------------------------------------------------
  const MANUAL_COLS = [
    { key: 'code', label: 'รหัสชิ้นส่วน', list: 'dl-items', w: '34%' },
    { key: 'qty', label: 'จำนวนต่อชุด', type: 'number', w: '16%' },
    { key: 'unit', label: 'หน่วย (ว่าง = หน่วยหลัก)', w: '18%' },
    { key: 'note', label: 'หมายเหตุ' },
  ];
  function createForm(ctx) {
    const d = ctx.view.draft || {};
    const boms = bomOptions(ctx);
    const mode = d.mode || (boms.length ? 'bom' : 'manual');
    let body;
    if (mode === 'bom') {
      const bom = d.product ? P.approvedBom(ctx.state, d.product) : null;
      const sets = U.num(d.qty);
      const prev = bom ? h.table({ rows: bom.lines, dense: true, scroll: true,
        cols: [
          { label: 'รหัส', render: (l) => h.code(l.code) },
          { label: 'รายการ', get: (l) => (ctx.item(l.code) || {}).name || '' },
          { label: 'ต่อชุด', num: true, key: 'qty' },
          { label: 'ต้องใช้', num: true, render: (l) => (sets > 0 ? t`<b>${h.fmt.num(U.round(l.qty * sets))}</b>` : dash) },
          { label: 'พร้อมเบิกตอนนี้', num: true, render: (l) => n0((P.six(ctx.state, { code: l.code, today: ctx.today })[0] || {}).free) },
          { label: 'หน่วย', get: (l) => (ctx.item(l.code) || {}).baseUnit || l.unit },
        ] }) : '';
      body = [
        boms.length ? h.field({ name: 'product', label: 'สินค้าที่ผลิต (มี BOM อนุมัติแล้ว)', type: 'select', value: d.product, options: boms, required: true, act: 'draft', id: 'jb-n-prod', wide: true })
          : t`<div class="wide">${h.note(t`ยังไม่มีสินค้าที่ BOM อนุมัติแล้ว – ให้วิศวกรรมอนุมัติ BOM ที่หน้า ${h.link('BOM / ฉบับแบบ', 'boms')} หรือเลือก ระบุรายการชิ้นส่วนเอง`, 'warn')}</div>`,
        h.field({ name: 'qty', label: 'จำนวนชุด', type: 'number', value: d.qty, required: true, act: 'draft', live: true, id: 'jb-n-qty' }),
        bom ? t`<div class="wide"><p class="hint">BOM ${bom.product} ฉบับ ${bom.rev} (อนุมัติ ${h.fmt.dt(bom.approvedAt)}) × ${sets > 0 ? h.fmt.num(sets) : '?'} ชุด</p>${prev}</div>` : '',
      ];
    } else {
      body = [
        h.field({ name: 'qty', label: 'จำนวนชุด', type: 'number', value: d.qty == null || d.qty === '' ? 1 : d.qty, required: true, id: 'jb-n-qty', hint: 'ต้องใช้ = จำนวนต่อชุด × จำนวนชุด' }),
        t`<div class="wide">${h.lineEditor({ name: 'lines', cols: MANUAL_COLS, lines: d.lines })}</div>`,
      ];
    }
    const errs = ctx.view.createErrs || [];
    return h.form({
      name: 'create', submit: 'สร้างใบงาน', cancel: 'close',
      body: [
        errs.length ? t`<div class="wide" id="jb-n-errs">${h.note(t`<b>ยังสร้างใบงานไม่ได้ – ยังไม่มีอะไรบันทึก</b><ul class="errs">${errs.map((e) => t`<li>${e}</li>`)}</ul>`, 'bad')}</div>` : '',
        h.field({ name: 'soNo', label: 'เลขที่ SO', value: d.soNo, required: true, id: 'jb-n-so', hint: 'ใช้เลข SO ตรงตัว ระบบไม่จับคู่จากชื่อลูกค้า' }),
        h.field({ name: 'jobNo', label: 'เลขที่ใบงาน', value: d.jobNo, id: 'jb-n-no', hint: 'เว้นว่าง = ระบบออกเลข JB… ให้' }),
        h.field({ name: 'dueDate', label: 'วันต้องใช้ / กำหนดเสร็จ', type: 'date', value: d.dueDate, required: true, id: 'jb-n-due' }),
        h.field({ name: 'priority', label: 'ลำดับความสำคัญ', type: 'select', value: d.priority || 3, options: PRIO, blank: false, id: 'jb-n-prio', hint: 'จองอัตโนมัติให้งานลำดับ 1 ก่อน' }),
        h.field({ name: 'mode', label: 'รายการที่งานต้องใช้มาจาก', type: 'radio', value: mode, act: 'draft', wide: true,
          options: [['bom', 'สินค้าที่มี BOM อนุมัติแล้ว × จำนวนชุด'], ['manual', 'ระบุรายการชิ้นส่วนเอง']] }),
        body,
        h.field({ name: 'remark', label: 'หมายเหตุ', value: d.remark, wide: true, id: 'jb-n-remark' }),
      ],
    });
  }
  function draftFromForm() {
    const form = root.document.querySelector('form[data-form="create"]');
    return form ? h.parseForm(form) : {};
  }

  // ---- page ---------------------------------------------------------------------------------------------------------
  RRS.ui.page({
    id: 'jobs', title: 'งาน/SO และการจอง', phase: 2, order: 10,
    sub: 'ใบงานต่อ SO: สร้างจาก BOM ที่อนุมัติ × จำนวนชุด จองของจากยอดพร้อมเบิก บันทึกผลิต และปิด/ยกเลิกงาน · ของรอตรวจ ของกำลังผลิต และของที่ยังไม่เข้าไม่ถูกนับเป็นของพร้อมเบิก',
    badge: (ctx) => P.jobs(ctx.state, { open: true }).filter((j) => isSales(j) && !j.product).length || '',
    render(ctx) {
      const v = ctx.view;
      const canJob = ctx.can('job.manage');
      const canRes = ctx.can('reserve.manage');
      const all = RRS.q.rows(ctx.state, 'jobs');
      if (v.sel === '__new' && canJob) return h.section('สร้างใบงาน', createForm(ctx), { sub: 'ใบงาน 1 ใบ = งานผลิตของ SO 1 ใบ · สร้างแล้วจองของให้งานได้ทันที', id: 'jb-new' });
      if (!all.length) {
        return h.empty('ยังไม่มีใบงาน', canJob
          ? 'ใบงานคืองานผลิตของ SO หนึ่งใบ: เลือกสินค้าที่มี BOM อนุมัติแล้ว × จำนวนชุด (หรือระบุรายการชิ้นส่วนเอง) แล้วจองของให้งาน ระบบกันไม่ให้สองงานจองของชิ้นเดียวกัน'
          : 'ฝ่ายวางแผนเป็นผู้สร้างใบงาน – เมื่อมีใบงาน รายการงาน การจอง และความพร้อมผลิตจะขึ้นที่นี่ (งานจาก Sales Office จะขึ้นเองเมื่อเปิดตัวเชื่อม)',
        canJob ? h.btn('+ สร้างใบงานแรก', { act: 'new', tone: 'primary' }) : '');
      }
      const rows = filtered(ctx);
      const limit = v.limit || STEP;
      const sel = v.sel && v.sel !== '__new' ? RRS.q.get(ctx.state, 'jobs', v.sel) : null;
      const hasSales = all.some(isSales);
      const filters = [
        h.field({ name: 'q', label: 'ค้นหา', value: v.q, placeholder: 'เลขที่ใบงาน SO สินค้า…', act: 'filter', live: true, id: 'jb-q' }),
        h.field({ name: 'st', label: 'สถานะ', type: 'select', value: v.st || 'open', blank: false, act: 'filter', id: 'jb-st',
          options: [['open', 'ยังไม่ปิด (เปิด + กำลังทำ)'], ['all', 'ทั้งหมด']].concat(Object.keys(P.JOB_STATUS).map((k) => [k, P.JOB_STATUS[k]])) }),
        h.field({ name: 'pr', label: 'ลำดับความสำคัญ', type: 'select', value: v.pr, options: PRIO, blank: 'ทุกลำดับ', act: 'filter', id: 'jb-pr' }),
        hasSales ? h.field({ name: 'src', label: 'ที่มา', type: 'select', value: v.src, blank: 'ทุกที่มา', act: 'filter', id: 'jb-src',
          options: [['sales', 'Sales Office (ทั้งหมด)'], ['domestic', 'Sales Office · Domestic'], ['export', 'Sales Office · Export'], ['own', 'สร้างในระบบสต็อก']] }) : '',
        h.field({ name: 'late', label: 'เฉพาะที่เลยกำหนด', type: 'checkbox', value: v.late, act: 'filter', id: 'jb-late' }),
      ];
      const anyOpen = all.some((j) => OPEN[j.status]);
      const filteredOn = v.q || (v.st && v.st !== 'open') || v.pr || v.src || v.late;
      const right = [
        filteredOn ? h.btn('ล้างตัวกรอง', { act: 'clear', tone: 'ghost' }) : '',
        rows.length ? h.btn('ดาวน์โหลด CSV', { act: 'csv', tone: 'ghost' }) : '',
        canRes && anyOpen ? h.btn('จองอัตโนมัติทุกงาน', { act: 'auto', arg: '', tone: 'ghost', title: 'เรียงตามลำดับความสำคัญแล้ววันต้องใช้' }) : '',
        canJob ? h.btn('+ สร้างใบงาน', { act: 'new', tone: 'primary' }) : '',
      ];
      const more = rows.length > limit
        ? t`<p class="hint">แสดง ${h.fmt.num(limit)} จาก ${h.fmt.num(rows.length)} ใบงาน ${h.btn(`แสดงเพิ่มอีก ${h.fmt.num(Math.min(STEP, rows.length - limit))} ใบ`, { act: 'more', tone: 'ghost', small: true })}</p>`
        : t`<p class="hint">${h.fmt.num(rows.length)} ใบงาน · ความพร้อม = เฉลี่ยทุกรายการของงาน: ส่วนที่เบิกแล้ว + จองไว้ + พร้อมเบิกที่จองเพิ่มได้ทันที เทียบกับที่ต้องใช้ (ของรอตรวจ/กำลังผลิต/ยังไม่เข้า ไม่นับ)</p>`;
      const allNote = v.autoNote && !v.autoNote.jobNo ? autoNote(v.autoNote) : '';
      return t`${kpis(ctx)}${allNote}
        ${h.toolbar(filters, right)}
        ${sel ? detail(ctx, sel) : ''}
        <div>${listTable(ctx, rows, limit)}${more}</div>`;
    },
    after(ctx, root0) {
      const v = ctx.view;
      if (v._scroll) {
        v._scroll = false;
        const d = root0.querySelector('#jb-detail');
        if (d) setTimeout(() => d.scrollIntoView({ block: 'start' }), 0);
      }
    },
    actions: {
      pick: (ctx, el) => ctx.set({ sel: el.dataset.arg, _scroll: true, autoNote: null, resAll: false, logAll: false }),
      close: (ctx) => ctx.set({ sel: null, draft: null, createErrs: null }),
      new: (ctx) => ctx.set({ sel: '__new', draft: null, createErrs: null }),
      more: (ctx) => ctx.set({ limit: (ctx.view.limit || STEP) + STEP }),
      resAll: (ctx) => ctx.set({ resAll: !ctx.view.resAll }),
      logAll: (ctx) => ctx.set({ logAll: !ctx.view.logAll }),
      clear: (ctx) => ctx.set({ q: '', st: 'open', pr: '', src: '', late: false, limit: STEP }),
      filter(ctx, el) {
        ctx.set({ [el.name]: el.type === 'checkbox' ? el.checked : el.value, limit: STEP });
      },
      draft: (ctx) => ctx.set({ draft: draftFromForm() }),
      addLine(ctx) {
        const d = draftFromForm();
        d.lines = (d.lines || []).concat([{}]);
        ctx.set({ draft: d });
      },
      removeLine(ctx, el) {
        const d = draftFromForm();
        d.lines = (d.lines || []).filter((_, i) => i !== Number(el.dataset.arg));
        ctx.set({ draft: d });
      },
      async csv(ctx) {
        const out = [['เลขที่ใบงาน', 'SO', 'ที่มา', 'พื้นที่ขาย', 'สินค้า', 'ฉบับ BOM', 'จำนวนชุด', 'วันต้องใช้', 'ลำดับ', 'สถานะ', 'ความพร้อม %', 'รายการที่ขาด']];
        for (const j of filtered(ctx)) {
          const rd = OPEN[j.status] ? readyOf(ctx, j.jobNo) : null;
          const pct = pctOf(rd);
          out.push([j.jobNo, j.soNo, isSales(j) ? 'Sales Office' : 'ระบบสต็อก', isSales(j) ? WS_SHORT[j.workspace] || j.workspace : '', j.product, j.bomRev,
            j.qty, j.dueDate, j.priority, P.JOB_STATUS[j.status] || j.status, pct == null ? '' : Math.round(pct * 100),
            rd ? rd.missing.map((m) => `${m.code} ${m.missing}`).join('; ') : '']);
        }
        await ctx.download(`jobs-${ctx.today}.csv`, h.csv(out));
      },
      async edit(ctx) {
        const job = RRS.q.get(ctx.state, 'jobs', ctx.view.sel);
        if (!job) return;
        await ctx.dialog({ title: `แก้ใบงาน ${job.jobNo}`, submit: 'บันทึก',
          message: 'ใบจองที่ใช้วันต้องใช้/ลำดับของงานเดิมจะเปลี่ยนตามไปด้วย',
          body: t`${h.field({ name: 'dueDate', label: 'วันต้องใช้ / กำหนดเสร็จ', type: 'date', value: job.dueDate })}
            ${h.field({ name: 'priority', label: 'ลำดับความสำคัญ', type: 'select', value: job.priority, options: PRIO, blank: false })}
            ${h.field({ name: 'remark', label: 'หมายเหตุ', value: job.remark, wide: true })}`,
          onSubmit: (vv) => ctx.exec('job.update', { jobNo: job.jobNo, dueDate: vv.dueDate, priority: vv.priority, remark: vv.remark }, { quiet: true, done: 'บันทึกการแก้ใบงานแล้ว' }) });
      },
      async reserve(ctx, el) {
        const job = RRS.q.get(ctx.state, 'jobs', ctx.view.sel);
        const jl = job && (job.lines || []).find((l) => l.line === Number(el.dataset.arg));
        if (!jl) return;
        const it = ctx.item(jl.code) || { baseUnit: '' };
        const rd = (readyOf(ctx, job.jobNo).lines || []).find((l) => l.line === jl.line) || {};
        const need = Math.max(0, U.round(jl.required - jl.issued - (rd.reservedRemaining || 0)));
        const whs = whFree(ctx, jl.code, job.jobNo);
        const mine = whs.filter((w) => ctx.can('reserve.manage', w.wh));
        const best = mine.slice().sort((a, b) => b.free - a.free)[0];
        const whOpts = h.whOptions(ctx.state).filter(([c]) => ctx.can('reserve.manage', c)).map(([c, l]) => {
          const w = whs.find((x) => x.wh === c);
          return [c, `${l} – พร้อมเบิก ${h.fmt.num(w ? Math.max(0, w.free) : 0)} ${it.baseUnit}`];
        });
        // why nothing can be reserved: no free stock anywhere, or only in warehouses this person may not reserve from
        const elsewhere = whs.filter((w) => w.free > 0 && !ctx.can('reserve.manage', w.wh));
        let why = '';
        if (need <= 0) why = h.note('บรรทัดนี้จอง/เบิกครบแล้ว – ไม่ต้องจองเพิ่ม', 'info');
        else if (!whs.some((w) => w.free > 0)) why = h.note('ตอนนี้ไม่มีของพร้อมเบิกให้จองในคลังใดเลย – ส่วนนี้ขึ้นเป็น ขาด ที่หน้าความพร้อมผลิต (ดูของรอตรวจ กำลังผลิต และจะเข้า ได้ที่หน้า สต็อก 6 ช่อง)', 'warn');
        else if (!mine.some((w) => w.free > 0) && elsewhere.length) {
          why = h.note(`มีของพร้อมเบิกที่คลัง ${elsewhere.map((w) => `${w.wh} (${h.fmt.num(w.free)})`).join(', ')} แต่คุณจองได้เฉพาะคลัง ${whOpts.map(([c]) => c).join(', ') || '–'} – ให้ผู้มีสิทธิ์ของคลังนั้นจอง หรือโอนของมาคลังของคุณก่อน`, 'warn');
        }
        const freeTbl = h.table({ rows: whs, dense: true, empty: 'ไม่มีของสถานะใช้ได้ในคลังใดเลย', emptyText: 'จองไม่ได้ตอนนี้ – ดูของรอตรวจ/กำลังผลิต/จะเข้าได้ที่หน้า สต็อก 6 ช่อง',
          cols: [{ label: 'คลัง', render: (w) => h.code(w.wh) }, { label: 'ใช้ได้', num: true, key: 'available' }, { label: 'จองให้งานอื่น', num: true, key: 'other' },
            { label: 'งานนี้จองแล้ว', num: true, key: 'own' }, { label: 'พร้อมเบิก', num: true, render: (w) => t`<b>${h.fmt.num(Math.max(0, w.free))}</b>` }] });
        const r = await ctx.dialog({
          title: `จองของให้ ${job.jobNo}: ${jl.code}`, submit: 'จอง', wide: true,
          body: t`<div class="wide">${h.dl([['รายการ', t`${h.code(jl.code)} ${it.name || ''}`], ['ต้องใช้', h.qty(jl.required, it.baseUnit)], ['เบิกแล้ว', h.qty(jl.issued, it.baseUnit)],
            ['งานนี้จองไว้แล้ว', h.qty(rd.reservedRemaining || 0, it.baseUnit)], ['ยังต้องจอง', t`<b>${h.qty(need, it.baseUnit)}</b>`]])}</div>
            ${jl.toMake > 0 ? t`<p class="hint wide">ตั้งให้ผลิตเอง ${h.fmt.num(jl.toMake)} – ส่วนนี้ไม่ต้องจองจากสต็อก (จองอัตโนมัติเว้นให้)</p>` : ''}
            <div class="wide">${freeTbl}<p class="hint">พร้อมเบิก = ใช้ได้ − จองให้งานอื่น − งานนี้จองแล้ว · ของรอตรวจ/กักกัน กำลังผลิต และของที่ยังไม่เข้า จองไม่ได้</p>${why}</div>
            ${h.field({ name: 'wh', label: 'จองจากคลัง', type: 'select', value: best ? best.wh : '', options: whOpts, required: true })}
            ${h.field({ name: 'qty', label: `จำนวนจอง (${it.baseUnit || 'หน่วยหลัก'})`, type: 'number', value: best ? Math.min(need, Math.max(0, best.free)) || '' : '', required: true, hint: `ไม่เกิน ${h.fmt.num(need)} ที่ยังต้องจอง` })}
            ${h.field({ name: 'needDate', label: 'วันต้องใช้', type: 'date', value: job.dueDate })}
            ${h.field({ name: 'priority', label: 'ลำดับความสำคัญ', type: 'select', value: job.priority, options: PRIO, blank: false })}
            ${h.field({ name: 'allowPartial', label: 'ถ้ามีไม่พอ จองเท่าที่มี', type: 'checkbox', wide: true, hint: 'ส่วนที่จองไม่ได้ยังขึ้นเป็น ขาด ที่หน้าความพร้อมผลิต' })}`,
          onSubmit: (vv) => ctx.exec('reserve.create', { jobNo: job.jobNo, code: jl.code, wh: vv.wh, qty: vv.qty, needDate: vv.needDate, priority: vv.priority, allowPartial: !!vv.allowPartial },
            { quiet: true, done: (x) => (x.result.partial ? `จอง ${x.result.id} ได้ ${h.fmt.num(x.result.qty)} จากที่ขอ ${h.fmt.num(x.result.requested)} – ยังขาด ${h.fmt.num(x.result.short)}` : `จอง ${x.result.id} ${h.fmt.num(x.result.qty)} ${it.baseUnit} แล้ว`) }),
        });
        return r;
      },
      async resChange(ctx, el) {
        const r = RRS.q.get(ctx.state, 'reservations', el.dataset.arg);
        if (!r) return;
        const it = ctx.item(r.code) || { baseUnit: '' };
        const whs = whFree(ctx, r.code, r.jobNo);
        const whOpts = h.whOptions(ctx.state).filter(([c]) => ctx.can('reserve.manage', c)).map(([c, l]) => {
          const w = whs.find((x) => x.wh === c);
          return [c, `${l} – พร้อมเบิก ${h.fmt.num(w ? Math.max(0, w.free) : 0)}`];
        });
        await ctx.dialog({ title: `เปลี่ยนการจอง ${r.id}`, submit: 'บันทึกการเปลี่ยน',
          body: t`<div class="wide">${h.dl([['รายการ', t`${h.code(r.code)} ${it.name || ''}`], ['ใบงาน', r.jobNo], ['จองอยู่', h.qty(r.qty, it.baseUnit)], ['เบิกแล้ว', h.qty(r.issued, it.baseUnit)], ['คงเหลือ', h.qty(P.remaining(r), it.baseUnit)]])}</div>
            ${h.field({ name: 'qty', label: `จำนวนจองใหม่ (รวมที่เบิกแล้ว, ${it.baseUnit})`, type: 'number', value: r.qty, required: true, hint: `ไม่ต่ำกว่าที่เบิกแล้ว ${h.fmt.num(r.issued)} · ลดยอด = ปล่อยส่วนต่างคืน` })}
            ${h.field({ name: 'wh', label: 'คลัง', type: 'select', value: r.wh, options: whOpts, blank: false, disabled: r.issued > 0, hint: r.issued > 0 ? 'เบิกจากคลังนี้ไปแล้ว – ย้ายคลังไม่ได้ ให้ปล่อยส่วนที่เหลือแล้วจองใหม่' : 'ย้ายคลังได้ถ้าคลังใหม่มีพร้อมเบิกพอ' })}
            ${h.field({ name: 'needDate', label: 'วันต้องใช้', type: 'date', value: r.needDate })}
            ${h.field({ name: 'priority', label: 'ลำดับความสำคัญ', type: 'select', value: r.priority, options: PRIO, blank: false })}
            ${h.field({ name: 'reason', label: 'เหตุผล (เก็บในประวัติใบจอง)', wide: true })}`,
          onSubmit: (vv) => ctx.exec('reserve.change', { id: r.id, qty: vv.qty, wh: vv.wh, needDate: vv.needDate, priority: vv.priority, reason: vv.reason }, { quiet: true, done: `เปลี่ยนการจอง ${r.id} แล้ว` }) });
      },
      async resRelease(ctx, el) {
        const r = RRS.q.get(ctx.state, 'reservations', el.dataset.arg);
        if (!r) return;
        const it = ctx.item(r.code) || { baseUnit: '' };
        await ctx.dialog({ title: `ปล่อยการจอง ${r.id}`, submit: 'ปล่อยการจอง', danger: true,
          message: `${r.code} ${h.fmt.num(P.remaining(r))} ${it.baseUnit} ที่คลัง ${r.wh} จะกลับเป็นของพร้อมเบิก งานอื่นจองได้ทันที · ใบจองยังเก็บไว้ในประวัติพร้อมผู้ปล่อยและเหตุผล`,
          body: h.field({ name: 'reason', label: 'เหตุผลที่ปล่อย', required: true, wide: true }),
          onSubmit: (vv) => ctx.exec('reserve.release', { id: r.id, reason: vv.reason }, { quiet: true, done: (x) => `ปล่อย ${r.id} แล้ว – คืน ${h.fmt.num(x.result.released)} ${it.baseUnit} เป็นของพร้อมเบิก` }) });
      },
      async auto(ctx, el) {
        const jobNo = el.dataset.arg || '';
        const ok = await ctx.confirm({ title: jobNo ? `จองอัตโนมัติให้ ${jobNo}` : 'จองอัตโนมัติทุกงานที่ยังไม่ปิด', ok: 'จองอัตโนมัติ',
          message: `ระบบจองจากของพร้อมเบิก (ใช้ได้ − จองให้งานอื่น) ในทุกคลังที่คุณมีสิทธิ์ เรียงคลังตามรหัส ให้ทุกบรรทัดที่ยังไม่ได้จอง${jobNo ? '' : ' โดยให้งานลำดับความสำคัญสูงและวันต้องใช้เร็วกว่าได้ก่อน'} · ไม่จองส่วนที่ตั้งให้ผลิตเอง · ถ้าของไม่พอจะแจ้งว่ายังขาดอะไร` });
        if (!ok) return;
        const r = await ctx.exec('reserve.auto', jobNo ? { jobNo } : {}, { done: (x) => `จองอัตโนมัติ ${x.result.created.length} ใบแล้ว` });
        if (r.ok) ctx.set({ autoNote: { jobNo, created: r.result.created || [], short: r.result.short || [] } });
      },
      async setMake(ctx, el) {
        const job = RRS.q.get(ctx.state, 'jobs', ctx.view.sel);
        const jl = job && (job.lines || []).find((l) => l.line === Number(el.dataset.arg));
        if (!jl) return;
        const it = ctx.item(jl.code) || { baseUnit: '' };
        const cap = jl.output ? job.qty : jl.required;
        await ctx.dialog({ title: `ตั้งจำนวนที่ผลิตเอง: ${jl.code}`, submit: 'บันทึก',
          message: jl.output ? 'จำนวนสินค้าที่งานนี้ผลิต (รับเข้าคลังด้วยใบ FR ตามใบงานได้ไม่เกินที่บันทึกผลิตเสร็จ)'
            : 'ส่วนที่ผลิตเองในโรงงานไม่ต้องจองจากสต็อก – จองอัตโนมัติเว้นให้ และหน้าความพร้อมนับเป็น กำลังผลิต (ไม่นับเป็นของพร้อมเบิก)',
          body: h.field({ name: 'toMake', label: `จำนวนที่ผลิตเอง (${it.baseUnit})`, type: 'number', value: jl.toMake, required: true, wide: true,
            hint: `0 ถึง ${h.fmt.num(cap)}${jl.finished ? ` · ผลิตเสร็จแล้ว ${h.fmt.num(jl.finished)} (ตั้งต่ำกว่านี้ไม่ได้)` : ''}` }),
          onSubmit: (vv) => ctx.exec('job.setMake', { jobNo: job.jobNo, line: jl.line, toMake: vv.toMake }, { quiet: true, done: `ตั้งผลิตเอง ${jl.code} ${h.fmt.num(U.num(vv.toMake))} แล้ว` }) });
      },
      async record(ctx, el) {
        const job = RRS.q.get(ctx.state, 'jobs', ctx.view.sel);
        const jl = job && (job.lines || []).find((l) => l.line === Number(el.dataset.arg));
        if (!jl) return;
        const it = ctx.item(jl.code) || { baseUnit: '' };
        const left = U.round(jl.toMake - jl.finished);
        await ctx.dialog({ title: `บันทึกผลิตเสร็จ: ${jl.code}`, submit: 'บันทึกผลิตเสร็จ',
          body: t`<div class="wide">${h.dl([['ใบงาน', job.jobNo], ['ตั้งผลิต', h.qty(jl.toMake, it.baseUnit)], ['ผลิตเสร็จแล้ว', h.qty(jl.finished, it.baseUnit)], ['ยังเหลือ', h.qty(left, it.baseUnit)]])}</div>
            ${h.field({ name: 'qty', label: `เสร็จเพิ่มครั้งนี้ (${it.baseUnit})`, type: 'number', value: left > 0 ? left : '', required: true, hint: 'ใส่ติดลบเพื่อแก้ยอดที่บันทึกเกิน (ต้องมีเหตุผล)' })}
            ${h.field({ name: 'remark', label: 'หมายเหตุ / เหตุผล' })}
            <p class="hint wide">บันทึกผลิตเสร็จยังไม่เข้าคลัง – สโตร์รับเข้าด้วยใบ FR ตามใบงาน${it.qcFinal ? ' (สินค้านี้ต้องตรวจเมื่อผลิตเสร็จ จะเข้าเป็น รอตรวจ)' : ''}</p>`,
          onSubmit: (vv) => ctx.exec('job.record', { jobNo: job.jobNo, line: jl.line, qty: vv.qty, remark: vv.remark }, { quiet: true, done: (x) => `บันทึกผลิตเสร็จ ${jl.code} รวม ${h.fmt.num(x.result.finished)}/${h.fmt.num(jl.toMake)}` }) });
      },
      async fr(ctx, el) {
        const job = RRS.q.get(ctx.state, 'jobs', ctx.view.sel);
        const jl = job && (job.lines || []).find((l) => l.line === Number(el.dataset.arg));
        if (!jl) return;
        const it = ctx.item(jl.code) || { baseUnit: '' };
        const left = U.round(jl.finished - jl.received);
        const whOpts = h.whOptions(ctx.state).filter(([c]) => ctx.can('doc.draft', c) || ctx.can('doc.post', c));
        const r = await ctx.dialog({ title: `สร้างร่างรับเข้าคลัง (FR): ${jl.code}`, submit: 'สร้างร่างแล้วไปหน้าเอกสาร',
          body: t`${h.field({ name: 'wh', label: 'เข้าคลัง', type: 'select', options: whOpts, required: true })}
            ${h.field({ name: 'bin', label: 'ช่องเก็บ', list: 'dl-bins' })}
            ${h.field({ name: 'qty', label: `จำนวนรับเข้า (${it.baseUnit})`, type: 'number', value: left, required: true, hint: `ผลิตเสร็จรอรับ ${h.fmt.num(left)} – รับเกินนี้ไม่ได้` })}
            ${h.field({ name: 'lot', label: 'ล็อต / Serial' })}
            <p class="hint wide">ร่างยังไม่เข้ายอด – สโตร์ตรวจและกด บันทึก ที่หน้าเอกสาร${it.qcFinal ? ' · สินค้านี้ต้องตรวจเมื่อผลิตเสร็จ: รับเข้าแล้วเป็น รอตรวจ จนกว่า QC ปล่อย (ยังเบิกหรือส่งมอบไม่ได้)' : ''}</p>`,
          onSubmit: (vv) => {
            const errors = [];
            const q = U.num(vv.qty);
            if (!vv.wh) errors.push({ message: 'เลือกคลังที่รับเข้า' });
            if (!(q > 0)) errors.push({ message: 'ใส่จำนวนรับเข้าเป็นตัวเลขมากกว่า 0' });
            else if (U.round(q) > left) errors.push({ message: `รับเข้าได้ไม่เกิน ${h.fmt.num(left)} ${it.baseUnit} (ผลิตเสร็จ ${h.fmt.num(jl.finished)} รับเข้าแล้ว ${h.fmt.num(jl.received)}) – บันทึกผลิตเสร็จเพิ่มก่อน` });
            if (errors.length) return { ok: false, errors };
            return ctx.exec('doc.saveDraft', { type: 'FR', job: job.jobNo, ref: job.soNo, lines: [{ code: jl.code, qty: vv.qty, wh: vv.wh, bin: vv.bin, lot: vv.lot }] }, { quiet: true });
          } });
        if (r && r.ok && r.result && r.result.docNo) {
          ctx.toast(`สร้างร่าง ${r.result.docNo} แล้ว`, 'ok');
          ctx.go('docs', docView(r.result.docNo));
        }
      },
      async done(ctx) {
        const job = RRS.q.get(ctx.state, 'jobs', ctx.view.sel);
        if (!job) return;
        const open = P.reservations(ctx.state, { jobNo: job.jobNo, open: true });
        const notIssued = comp(job).filter((l) => l.issued < l.required).map((l) => `${l.code} ${h.fmt.num(l.issued)}/${h.fmt.num(l.required)}`);
        const ok = await ctx.confirm({ title: `ปิดงาน ${job.jobNo}: ผลิตเสร็จ`, ok: 'ปิดงาน',
          message: `ใบงานจะเป็น ผลิตเสร็จ · เบิกเข้างานนี้เพิ่มไม่ได้ (คืนของเหลือได้)${open.length ? ` · ของที่จองค้าง ${open.length} ใบจะถูกปล่อยคืนเป็นของพร้อมเบิก` : ''}${notIssued.length ? ` · ยังเบิกไม่ครบ: ${notIssued.join(', ')}` : ''}` });
        if (!ok) return;
        await ctx.exec('job.status', { jobNo: job.jobNo, status: 'DONE' }, { done: (x) => `ปิดงาน ${job.jobNo} เป็นผลิตเสร็จแล้ว${x.result.released && x.result.released.length ? ` – ปล่อยของจอง ${x.result.released.length} ใบ` : ''}` });
      },
      async delivered(ctx) {
        const job = RRS.q.get(ctx.state, 'jobs', ctx.view.sel);
        if (!job) return;
        const open = P.reservations(ctx.state, { jobNo: job.jobNo, open: true });
        const ok = await ctx.confirm({ title: `บันทึกส่งมอบ ${job.jobNo}`, ok: 'บันทึกส่งมอบแล้ว',
          message: `ใบงานจะเป็น ส่งมอบแล้ว และแก้หรือยกเลิกไม่ได้อีก${open.length ? ` · ของที่จองค้าง ${open.length} ใบจะถูกปล่อยคืน` : ''}` });
        if (!ok) return;
        await ctx.exec('job.status', { jobNo: job.jobNo, status: 'DELIVERED' }, { done: `บันทึกส่งมอบ ${job.jobNo} แล้ว` });
      },
      async cancel(ctx) {
        const job = RRS.q.get(ctx.state, 'jobs', ctx.view.sel);
        if (!job) return;
        const open = P.reservations(ctx.state, { jobNo: job.jobNo, open: true });
        const outstanding = comp(job).filter((l) => l.issued > 0);
        const resText = open.length ? `ของที่จองไว้ ${open.length} ใบ (${open.map((r) => `${r.code} ${h.fmt.num(P.remaining(r))} @${r.wh}`).join(', ')}) จะถูกปล่อยคืนให้งานอื่นจองได้ทันที` : 'งานนี้ไม่มีของจองค้าง';
        await ctx.dialog({ title: `ยกเลิกใบงาน ${job.jobNo}`, submit: 'ยกเลิกใบงาน', danger: true,
          message: `ใบงานจะเป็น ยกเลิก · ${resText} · ประวัติใบงานและใบจองยังอยู่`,
          body: t`${outstanding.length ? t`<div class="wide">${h.note(t`ยังมีของที่เบิกไปและยังไม่คืน: ${outstanding.map((l) => `${l.code} ${h.fmt.num(l.issued)}`).join(', ')} – คืนของเหลือ (RT) ที่หน้า ${h.link('ใบจัดชุดและหยิบของ', 'picking', { job: job.jobNo })} ก่อน หรือยกเลิกแบบบังคับ (ต้องเป็นคนละคนกับผู้สร้างใบงาน และระบุเหตุผลชัดเจน)`, 'warn')}</div>
              ${h.field({ name: 'force', label: 'ยกเลิกแบบบังคับทั้งที่มีของเบิกค้าง', type: 'checkbox', wide: true })}` : ''}
            ${h.field({ name: 'reason', label: 'เหตุผลการยกเลิก', type: 'textarea', rows: 2, required: true, wide: true })}`,
          onSubmit: (vv) => ctx.exec('job.cancel', { jobNo: job.jobNo, reason: vv.reason, force: !!vv.force }, { quiet: true,
            done: (x) => `ยกเลิก ${job.jobNo} แล้ว – ปล่อยของจอง ${(x.result.released || []).length} ใบคืนเป็นของพร้อมเบิก` }) });
      },
      async mapBom(ctx) {
        const job = RRS.q.get(ctx.state, 'jobs', ctx.view.sel);
        if (!job || !RRS.sales) return;
        const boms = bomOptions(ctx);
        if (!boms.length) return ctx.toast('ยังไม่มีสินค้าที่ BOM อนุมัติแล้ว – ให้วิศวกรรมอนุมัติ BOM ก่อน แล้วจึงจับคู่', 'warn');
        const items = job.salesItems || [];
        const hasRes = P.reservations(ctx.state, { jobNo: job.jobNo, open: true }).length;
        await ctx.dialog({ title: `จับคู่ ${job.jobNo} กับ BOM`, submit: 'จับคู่และสร้างรายการ', wide: true,
          message: 'เลือกสินค้าที่มี BOM อนุมัติแล้ว และยืนยันจำนวนชุดจากรายการ SO ด้านล่าง – ระบบไม่เดาจากชื่อหรือข้อความใน SO รายการที่ต้องใช้ = BOM × จำนวนชุด',
          body: t`<div class="wide">${h.table({ rows: items, dense: true, scroll: true, empty: 'ไม่มีรายการ SO', emptyText: '',
              cols: [{ label: 'รหัสบรรทัด', render: (x) => h.code(x.lineId) }, { label: 'รายละเอียดตาม SO', key: 'description' }, { label: 'จำนวน', key: 'qty' }, { label: 'หน่วย', key: 'unit' }, { label: 'รหัสสินค้าใน Sales Office', key: 'productId' }] })}</div>
            ${hasRes ? t`<div class="wide">${h.note('ใบงานนี้มีของจองอยู่ – ปล่อยการจองก่อนจับคู่ใหม่ (ระบบจะไม่ยอมจับคู่)', 'warn')}</div>` : ''}
            ${h.field({ name: 'product', label: 'สินค้าที่ผลิต (มี BOM อนุมัติแล้ว)', type: 'select', value: job.product, options: boms, required: true, wide: true })}
            ${h.field({ name: 'qty', label: 'จำนวนชุดที่จะผลิต (ยืนยันเอง)', type: 'number', value: job.product ? job.qty : '', required: true })}`,
          onSubmit: (vv) => ctx.exec('sales.mapJob', { jobKey: job.jobNo, product: vv.product, qty: vv.qty }, { quiet: true,
            done: (x) => `จับคู่ ${job.jobNo} กับ ${x.result.product} ฉบับ ${x.result.bomRev} × ${h.fmt.num(x.result.qty)} ชุดแล้ว` }) });
      },
    },
    forms: {
      async create(ctx, vals) {
        const base = { soNo: vals.soNo, jobNo: vals.jobNo, dueDate: vals.dueDate, priority: vals.priority, remark: vals.remark, qty: vals.qty };
        const mode = vals.mode || 'bom';
        const payload = mode === 'manual'
          ? Object.assign(base, { lines: h.cleanLines(vals.lines, 'code').map((l) => ({ code: l.code, qty: l.qty, unit: l.unit, note: l.note })) })
          : Object.assign(base, { product: vals.product });
        // everything that is missing at once, in the form (the engine stops at the first problem)
        const miss = [];
        if (!U.trim(vals.soNo)) miss.push('ใส่เลขที่ SO');
        if (!U.trim(vals.dueDate)) miss.push('เลือกวันต้องใช้ / กำหนดเสร็จ');
        if (mode === 'bom' && !vals.product) miss.push('เลือกสินค้าที่ผลิต (ต้องมี BOM ที่อนุมัติแล้ว)');
        if ((mode === 'bom' || U.trim(vals.qty) !== '') && !(U.num(vals.qty) > 0)) miss.push('ใส่จำนวนชุดเป็นตัวเลขมากกว่า 0');
        if (mode === 'manual' && !payload.lines.length) miss.push('ใส่รายการชิ้นส่วนอย่างน้อย 1 บรรทัด (รหัส + จำนวนต่อชุด)');
        if (miss.length) return ctx.set({ draft: vals, createErrs: miss });
        const r = await ctx.exec('job.create', payload, { quiet: true, done: (x) => `สร้างใบงาน ${x.result.jobNo} แล้ว (${x.result.lines} บรรทัด)` });
        if (!r.ok) return ctx.set({ draft: vals, createErrs: (r.errors || []).map((e) => e.message) });
        ctx.set({ sel: r.result.jobNo, draft: null, createErrs: null, st: 'open', _scroll: true });
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
