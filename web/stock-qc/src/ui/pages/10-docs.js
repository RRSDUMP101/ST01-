/*
 * Phase 1 – documents: PD OU FR RR AJ RT TR (and RV SC DL from later phases). Draft → check → post as a whole;
 * cancel with a reason (reversing movements); exception for negative stock (request → another person approves);
 * Express number after keying; transfers are received on the "รับโอน" tab.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const inv = RRS.inventory;

  const LINE_COLS = (ctx, type) => {
    const td = inv.DOC_TYPES[type] || {};
    const cols = [
      { key: 'code', label: 'รหัสสินค้า', list: 'dl-items', w: '17%' },
      { key: 'qty', label: td.dir === 0 ? 'จำนวน (+เพิ่ม / −ลด)' : 'จำนวน', type: 'number', w: '9%' },
      { key: 'unit', label: 'หน่วย (ว่าง = หน่วยหลัก)', w: '9%' },
      { key: 'wh', label: td.dir === 'T' ? 'จากคลัง' : 'คลัง', options: h.whOptions(ctx.state), w: '10%' },
      { key: 'bin', label: td.dir === 'T' ? 'จากช่อง' : 'ช่องเก็บ', list: 'dl-bins', w: '10%' },
    ];
    if (td.dir === 'T') cols.push({ key: 'toWh', label: 'ไปคลัง', options: h.whOptions(ctx.state), w: '10%' }, { key: 'toBin', label: 'ไปช่อง', list: 'dl-bins', w: '10%' });
    cols.push({ key: 'lot', label: 'ล็อต/Heat', w: '10%' });
    if (td.dir === -1 || td.dir === 'T' || (td.outStatuses && td.outStatuses.length > 1)) {
      cols.push({ key: 'status', label: 'สถานะของ', options: (td.outStatuses || ['AVAILABLE']).map((s) => [s, RRS.STATUS_LABEL[s]]), blank: 'ใช้ได้', w: '9%' });
    }
    cols.push({ key: 'remark', label: 'หมายเหตุ' });
    return cols;
  };

  function docTitle(d) {
    const td = inv.DOC_TYPES[d.type] || {};
    return `${d.docNo} · ${d.type} ${td.name || ''}`;
  }

  function editor(ctx, d) {
    const v = ctx.view;
    const lines = v.lines || d.lines;
    const hd = v.header || d;
    const td = inv.DOC_TYPES[d.type] || {};
    const defWh = (ctx.state.tables.settings && ctx.state.tables.settings.main && ctx.state.tables.settings.main.express.defaultWarehouse) || '';
    return h.form({
      name: 'draft', submit: 'บันทึกร่าง', extra: [
        h.btn('ตรวจก่อนบันทึก', { act: 'check', tone: 'ghost' }),
        ctx.can(td.perm || 'doc.post') ? h.btn('บันทึก (เปลี่ยนยอด)', { act: 'post', tone: 'primary' }) : '',
        h.btn('ลบร่าง', { act: 'deleteDraft', tone: 'quiet' }),
      ],
      body: [
        h.field({ name: 'date', label: 'วันที่เอกสาร', type: 'date', value: hd.date }),
        h.field({ name: 'job', label: 'งาน / SO', value: hd.job, hint: td.needsJob ? 'จำเป็นสำหรับเอกสารนี้' : 'ใส่เพื่อผูกกับงานผลิต/การจอง' }),
        h.field({ name: 'ref', label: 'เอกสารอ้างอิง', value: hd.ref, placeholder: 'เช่น PO, ใบส่งของ' }),
        h.field({ name: 'department', label: 'แผนก', value: hd.department }),
        h.field({ name: 'remark', label: 'หมายเหตุ', value: hd.remark, wide: true }),
        t`<div class="wide">${h.lineEditor({ name: 'lines', cols: LINE_COLS(ctx, d.type), lines: lines.length ? lines : [{ wh: defWh }] })}</div>`,
        v.checked ? t`<div class="wide">${v.checked.ok ? h.note('ตรวจแล้ว: บันทึกได้ทุกบรรทัด', 'ok') : h.note(t`บันทึกไม่ได้ – ยังไม่มีอะไรเปลี่ยน${h.errors(v.checked)}`, 'bad')}</div>` : '',
      ],
    });
  }

  function view(ctx, d) {
    const td = inv.DOC_TYPES[d.type] || {};
    const moves = inv.history(ctx.state, { docNo: d.docNo });
    const acts = [];
    if (d.status === 'DRAFT') { /* editor */ }
    if (d.status === 'WAIT_APPROVAL' && ctx.can('stock.overrideApprove')) {
      acts.push(h.btn('อนุมัติข้อยกเว้นและบันทึก', { act: 'approve', tone: 'primary' }), h.btn('ไม่อนุมัติ', { act: 'reject', tone: 'ghost' }));
    }
    if ((d.status === 'POSTED' || d.status === 'IN_TRANSIT') && ctx.can('doc.cancel')) acts.push(h.btn('ยกเลิกเอกสาร', { act: 'cancel', tone: 'danger' }));
    if (d.status === 'IN_TRANSIT' && ctx.can('transfer.receive')) acts.push(h.btn('รับโอน', { act: 'receive', tone: 'primary' }));
    if (d.expressStatus && d.expressStatus !== 'N/A' && d.status !== 'DRAFT' && ctx.can('doc.markExpress')) acts.push(h.btn(d.expressStatus === 'KEYED' ? 'แก้เลขที่ Express' : 'บันทึกเลขที่ Express', { act: 'express', tone: 'ghost' }));
    return t`${h.dl([
      ['ประเภท', `${d.type} ${td.name || ''}`], ['สถานะ', h.docStatus(d.status)], ['วันที่', h.fmt.date(d.date)], ['งาน / SO', d.job],
      ['อ้างอิง', d.ref], ['ผู้สร้าง', ctx.userName(d.createdBy)], ['ผู้บันทึก', d.postedBy ? `${ctx.userName(d.postedBy)} · ${h.fmt.dt(d.postedAt)}` : ''],
      ['Express', d.expressStatus === 'N/A' ? 'ยังไม่มีเอกสารคู่ใน Express (ค-11)' : d.expressStatus === 'KEYED' ? `คีย์แล้ว ${d.expressNo}` : d.expressStatus === 'WAIT' ? 'รอคีย์' : ''],
      d.override ? ['ข้อยกเว้นยอดติดลบ', `ขอโดย ${ctx.userName(d.override.requestedBy)}: ${d.override.reason}${d.override.approvedBy ? ` · อนุมัติโดย ${ctx.userName(d.override.approvedBy)}` : ''}${d.override.rejectedBy ? ` · ไม่อนุมัติโดย ${ctx.userName(d.override.rejectedBy)}` : ''}`] : null,
      d.status === 'CANCELLED' ? ['ยกเลิก', `${ctx.userName(d.cancelledBy)} · ${h.fmt.dt(d.cancelledAt)} · ${d.cancelReason}`] : null,
      d.remark ? ['หมายเหตุ', d.remark] : null,
    ])}
    ${acts.length ? t`<div class="form-actions">${acts}</div>` : ''}
    ${h.table({ rows: d.lines, dense: true, cols: [
      { label: '#', key: 'line' }, { label: 'รหัส', render: (l) => h.code(l.code) }, { label: 'รายการ', get: (l) => l.name || (ctx.item(l.code) || {}).name },
      { label: 'จำนวน', render: (l) => t`${h.qty(l.qty, l.unit)}${l.factor && l.factor !== 1 ? t` <span class="muted">(= ${h.fmt.num(l.base)} ${l.baseUnit})</span>` : ''}` },
      { label: 'ตำแหน่ง', get: (l) => `${l.wh || ''}${l.bin ? '/' + l.bin : ''}${l.toWh ? ` → ${l.toWh}${l.toBin ? '/' + l.toBin : ''}` : ''}` },
      { label: 'ล็อต', key: 'lot' }, { label: 'สถานะของ', render: (l) => (l.status ? h.statusBadge(l.status) : '') },
      d.type === 'TR' ? { label: 'รับแล้ว', num: true, get: (l) => l.received || 0 } : { label: 'หมายเหตุ', key: 'remark' },
    ] })}
    ${moves.length ? h.section('การเคลื่อนไหวของเอกสารนี้', h.table({ rows: moves, dense: true, cols: [
      { label: 'เวลา', get: (m) => h.fmt.dt(m.at) }, { label: 'รหัส', render: (m) => h.code(m.code) }, { label: 'ตำแหน่ง', get: (m) => `${m.wh}${m.bin ? '/' + m.bin : ''}` },
      { label: 'สถานะ', render: (m) => h.statusBadge(m.status) }, { label: 'ล็อต', key: 'lot' }, { label: 'จำนวน', num: true, key: 'qty' },
      { label: 'คงเหลือที่ตำแหน่ง', num: true, key: 'balanceAfter' }, { label: 'หมายเหตุ', get: (m) => (m.reversalOf ? 'กลับรายการ ' + m.reversalOf : m.remark) }] })) : ''}`;
  }

  RRS.ui.page({
    id: 'docs', title: 'เอกสารรับ–จ่าย–โอน', phase: 1, order: 10,
    sub: 'ตรวจทั้งเอกสารก่อนเปลี่ยนยอด บรรทัดผิดบรรทัดเดียวไม่บันทึกทั้งใบ · ยกเลิกเป็นรายการกลับ ไม่ลบประวัติ',
    badge: (ctx) => RRS.q.rows(ctx.state, 'documents', (d) => d.status === 'WAIT_APPROVAL').length || '',
    render(ctx) {
      const v = ctx.view;
      const tab = v.tab || 'all';
      const docs = RRS.q.rows(ctx.state, 'documents').sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || b.docNo.localeCompare(a.docNo));
      const counts = { draft: 0, wait: 0, transit: 0, express: 0 };
      for (const d of docs) {
        if (d.status === 'DRAFT') counts.draft++;
        if (d.status === 'WAIT_APPROVAL') counts.wait++;
        if (d.status === 'IN_TRANSIT') counts.transit++;
        if (d.expressStatus === 'WAIT' && d.status !== 'CANCELLED') counts.express++;
      }
      const q = (v.q || '').toLowerCase();
      const shown = docs.filter((d) => (tab === 'all' || (tab === 'draft' && d.status === 'DRAFT') || (tab === 'wait' && d.status === 'WAIT_APPROVAL')
        || (tab === 'transit' && d.status === 'IN_TRANSIT') || (tab === 'express' && d.expressStatus === 'WAIT' && d.status !== 'CANCELLED'))
        && (!v.type || d.type === v.type)
        && (!q || [d.docNo, d.job, d.ref, d.remark, d.expressNo].concat(d.lines.map((l) => l.code)).some((x) => String(x || '').toLowerCase().indexOf(q) >= 0)));
      const sel = v.sel && RRS.q.get(ctx.state, 'documents', v.sel);
      const canDraft = ctx.can('doc.draft') || ctx.can('doc.post');
      const types = Object.entries(inv.DOC_TYPES).filter(([k, d]) => d.dir !== 'S');
      const newMenu = canDraft ? t`<div class="tb-r">${h.field({ name: 'newType', label: 'สร้างเอกสารใหม่', type: 'select', options: types.map(([k, d]) => [k, `${k} – ${d.name}`]), blank: '— เลือกประเภท —', id: 'docs-new' })}</div>` : '';
      const list = h.table({ rows: shown.slice(0, 300), rowAct: 'pick', rowArg: (d) => d.docNo, rowCls: (d) => (d.docNo === v.sel ? 'sel' : ''),
        empty: 'ไม่มีเอกสาร', emptyText: canDraft ? 'เลือกประเภทที่ สร้างเอกสารใหม่' : '',
        cols: [{ label: 'เลขที่', render: (d) => h.code(d.docNo) }, { label: 'ประเภท', key: 'type' }, { label: 'วันที่', get: (d) => h.fmt.date(d.date) },
          { label: 'งาน/SO', key: 'job' }, { label: 'บรรทัด', num: true, get: (d) => d.lines.length }, { label: 'สถานะ', render: (d) => h.docStatus(d.status) },
          { label: 'Express', render: (d) => (d.expressStatus === 'WAIT' && d.status !== 'CANCELLED' ? h.badge('รอคีย์', 'warn') : d.expressStatus === 'KEYED' ? h.badge(d.expressNo, 'ok') : '') }] });
      let detail = h.empty('เลือกเอกสาร', 'หรือสร้างเอกสารใหม่จากเมนูด้านบน');
      if (sel) detail = h.section(docTitle(sel), sel.status === 'DRAFT' ? (ctx.can('doc.draft') || ctx.can('doc.post') ? editor(ctx, sel) : view(ctx, sel)) : view(ctx, sel), {
        sub: sel.status === 'DRAFT' ? 'ร่างยังไม่เปลี่ยนยอด – กด ตรวจก่อนบันทึก แล้ว บันทึก' : '' });
      return t`${h.tabs([{ id: 'all', label: 'ทั้งหมด' }, { id: 'draft', label: 'ร่าง', count: counts.draft }, { id: 'wait', label: 'รออนุมัติ', count: counts.wait },
        { id: 'transit', label: 'ระหว่างโอน', count: counts.transit }, { id: 'express', label: 'รอคีย์ Express', count: counts.express }], tab)}
        ${h.toolbar([h.field({ name: 'q', label: 'ค้นหา', value: v.q, placeholder: 'เลขที่ งาน รหัสสินค้า…', id: 'docs-q' }),
          h.field({ name: 'type', label: 'ประเภท', type: 'select', value: v.type, options: types.map(([k, d]) => [k, `${k} ${d.name}`]), blank: 'ทุกประเภท', id: 'docs-type' })], newMenu)}
        <div class="split"><div>${list}</div><div>${detail}</div></div>`;
    },
    after(ctx, root0) {
      const q = root0.querySelector('#docs-q');
      if (q) q.addEventListener('change', () => ctx.set({ q: q.value }));
      const ty = root0.querySelector('#docs-type');
      if (ty) ty.addEventListener('change', () => ctx.set({ type: ty.value }));
      const nw = root0.querySelector('#docs-new');
      if (nw) nw.addEventListener('change', async () => {
        const type = nw.value;
        if (!type) return;
        const defWh = ((ctx.state.tables.settings || {}).main || RRS.defaultSettings()).express.defaultWarehouse;
        const r = await ctx.exec('doc.saveDraft', { type, lines: [] }, { done: `สร้างร่าง ${type} แล้ว` });
        if (r.ok) ctx.set({ sel: r.result.docNo, lines: [{ wh: RRS.q.get(ctx.state, 'warehouses', defWh) ? defWh : '' }], checked: null, tab: 'all' });
      });
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg }),
      pick: (ctx, el) => ctx.set({ sel: el.dataset.arg, lines: null, checked: null, header: null }),
      addLine(ctx) {
        const form = root.document.querySelector('form[data-form="draft"]');
        const vals = h.parseForm(form);
        const lines = vals.lines || [];
        const last = lines[lines.length - 1] || {};
        lines.push({ wh: last.wh || '', bin: '', toWh: last.toWh || '' });
        ctx.set({ lines, checked: null, header: vals });
      },
      removeLine(ctx, el) {
        const form = root.document.querySelector('form[data-form="draft"]');
        const lines = (h.parseForm(form).lines || []).filter((_, i) => i !== Number(el.dataset.arg));
        ctx.set({ lines: lines.length ? lines : [{}], checked: null, header: h.parseForm(form) });
      },
      async check(ctx) {
        const form = root.document.querySelector('form[data-form="draft"]');
        const vals = h.parseForm(form);
        const d = RRS.q.get(ctx.state, 'documents', ctx.view.sel);
        const r = ctx.check('doc.post', Object.assign({}, vals, { type: d.type, lines: h.cleanLines(vals.lines, 'code') }));
        ctx.set({ lines: vals.lines, header: vals, checked: r.ok ? { ok: true } : r });
      },
      async post(ctx) {
        const form = root.document.querySelector('form[data-form="draft"]');
        const vals = h.parseForm(form);
        const d = RRS.q.get(ctx.state, 'documents', ctx.view.sel);
        const saved = await ctx.exec('doc.saveDraft', Object.assign({}, vals, { docNo: d.docNo, type: d.type, lines: h.cleanLines(vals.lines, 'code') }), { quiet: true });
        if (!saved.ok) return ctx.set({ checked: saved, lines: vals.lines });
        const ok = await ctx.confirm({ title: `บันทึก ${d.docNo}`, message: 'ยอดคงเหลือจะเปลี่ยนทันที ทั้งเอกสารหรือไม่เปลี่ยนเลย', ok: 'บันทึก' });
        if (!ok) return;
        const r = await ctx.exec('doc.post', { docNo: d.docNo }, { quiet: true });
        if (r.ok) {
          ctx.toast(`บันทึก ${r.result.docNo} แล้ว`, 'ok');
          ctx.set({ lines: null, checked: null });
          return;
        }
        const short = r.errors.some((e) => e.code === 'NOT_ENOUGH' || e.code === 'RESERVED');
        const policy = ((ctx.state.tables.settings || {}).main || {}).policies || {};
        ctx.set({ checked: r, lines: null });
        if (short && policy.negativeStock === 'approve') {
          const req = await ctx.dialog({ title: 'ยอดไม่พอ – ขออนุมัติข้อยกเว้น', submit: 'ส่งขออนุมัติ',
            message: 'นโยบายอนุญาตให้ขอยกเว้นได้ ผู้อนุมัติต้องเป็นคนละคนกับผู้ขอ', body: h.field({ name: 'reason', label: 'เหตุผล', required: true, wide: true }),
            onSubmit: (vv) => ctx.exec('doc.requestOverride', { docNo: d.docNo, reason: vv.reason }, { quiet: true, done: 'ส่งขออนุมัติแล้ว' }) });
          if (req && req.ok) ctx.set({ checked: null });
        }
      },
      async deleteDraft(ctx) {
        const d = RRS.q.get(ctx.state, 'documents', ctx.view.sel);
        if (!(await ctx.confirm({ title: `ลบร่าง ${d.docNo}`, message: 'ร่างนี้จะหายไป (ยังไม่เคยเปลี่ยนยอด)', ok: 'ลบร่าง', danger: true }))) return;
        const r = await ctx.exec('doc.deleteDraft', { docNo: d.docNo }, { done: 'ลบร่างแล้ว' });
        if (r.ok) ctx.set({ sel: null, lines: null });
      },
      async cancel(ctx) {
        const d = RRS.q.get(ctx.state, 'documents', ctx.view.sel);
        await ctx.dialog({ title: `ยกเลิก ${d.docNo}`, submit: 'ยกเลิกเอกสาร', danger: true,
          message: 'ระบบสร้างรายการกลับทุกบรรทัด ประวัติเดิมยังอยู่ ถ้าของถูกใช้ไปแล้วจะยกเลิกไม่ได้',
          body: h.field({ name: 'reason', label: 'เหตุผล', required: true, wide: true }),
          onSubmit: (vv) => ctx.exec('doc.cancel', { docNo: d.docNo, reason: vv.reason }, { quiet: true, done: 'ยกเลิกแล้ว' }) });
      },
      async approve(ctx) {
        const d = RRS.q.get(ctx.state, 'documents', ctx.view.sel);
        if (!(await ctx.confirm({ title: 'อนุมัติข้อยกเว้น', message: `${d.docNo}: ${d.override.reason} – ยอดอาจติดลบหลังบันทึก`, ok: 'อนุมัติและบันทึก' }))) return;
        await ctx.exec('doc.approveOverride', { docNo: d.docNo }, { done: 'อนุมัติและบันทึกแล้ว' });
      },
      async reject(ctx) {
        const d = RRS.q.get(ctx.state, 'documents', ctx.view.sel);
        await ctx.dialog({ title: 'ไม่อนุมัติข้อยกเว้น', submit: 'ไม่อนุมัติ', body: h.field({ name: 'reason', label: 'เหตุผล', wide: true }),
          onSubmit: (vv) => ctx.exec('doc.rejectOverride', { docNo: d.docNo, reason: vv.reason }, { quiet: true, done: 'ส่งกลับเป็นร่างแล้ว' }) });
      },
      async receive(ctx) {
        const d = RRS.q.get(ctx.state, 'documents', ctx.view.sel);
        const left = d.lines.filter((l) => l.base - (l.received || 0) > 0);
        await ctx.dialog({ title: `รับโอน ${d.docNo}`, submit: 'รับเข้า', wide: true,
          body: t`<div class="wide">${h.table({ rows: left, dense: true, cols: [
            { label: '#', key: 'line' }, { label: 'รหัส', render: (l) => h.code(l.code) }, { label: 'ไป', get: (l) => l.toWh },
            { label: 'ค้างรับ', num: true, get: (l) => l.base - (l.received || 0) },
            { label: 'รับครั้งนี้', render: (l, i) => t`<input type="hidden" name="lines[${i}][line]" value="${l.line}"><input name="lines[${i}][qty]" type="number" step="any" value="${l.base - (l.received || 0)}" aria-label="จำนวนรับ">` },
            { label: 'ช่องเก็บปลายทาง', render: (l, i) => t`<input name="lines[${i}][toBin]" list="dl-bins" value="${l.toBin}" aria-label="ช่องเก็บ">` }] })}</div>`,
          onSubmit: (vv) => ctx.exec('transfer.receive', { docNo: d.docNo, lines: (vv.lines || []).map((l) => ({ line: Number(l.line), qty: l.qty, toBin: l.toBin })) }, { quiet: true, done: 'รับโอนแล้ว' }) });
      },
      async express(ctx) {
        const d = RRS.q.get(ctx.state, 'documents', ctx.view.sel);
        await ctx.dialog({ title: `เลขที่ Express ของ ${d.docNo}`, submit: 'บันทึก',
          body: h.field({ name: 'expressNo', label: 'เลขที่ที่ Express ออกให้ (ว่าง = กลับเป็นรอคีย์)', value: d.expressNo, wide: true }),
          onSubmit: (vv) => ctx.exec('doc.markExpress', { docNo: d.docNo, expressNo: vv.expressNo }, { quiet: true, done: 'บันทึกเลขที่ Express แล้ว' }) });
      },
    },
    forms: {
      async draft(ctx, vals) {
        const d = RRS.q.get(ctx.state, 'documents', ctx.view.sel);
        const r = await ctx.exec('doc.saveDraft', Object.assign({}, vals, { docNo: d.docNo, type: d.type, lines: h.cleanLines(vals.lines, 'code') }), { done: 'บันทึกร่างแล้ว' });
        if (r.ok) ctx.set({ lines: null, checked: null, header: null });
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
