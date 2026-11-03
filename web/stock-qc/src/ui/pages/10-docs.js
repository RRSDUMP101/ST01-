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

  function lineCards(ctx, type, lines) {
    const columns = LINE_COLS(ctx, type);
    return t`<div class="docs-lines">${lines.map((line, i) => {
      const item = ctx.item(line.code);
      const tracked = item && item.trackLot && item.trackLot !== 'none';
      const primary = new Set(['code', 'qty', 'wh', 'bin', 'toWh', 'toBin']);
      if (tracked || line.lot) primary.add('lot');
      const fields = (list) => list.map((col) => {
        const wh = RRS.q.get(ctx.state, 'warehouses', col.key === 'toBin' ? line.toWh : line.wh);
        const required = ['code', 'qty', 'wh', 'toWh'].includes(col.key) || (col.key === 'lot' && tracked)
          || (['bin', 'toBin'].includes(col.key) && wh && wh.requireBin);
        return h.field({ name: `lines[${i}][${col.key}]`, label: col.key === 'code' ? 'สินค้า' : col.label,
          type: col.options ? 'select' : col.type, options: col.options, blank: col.blank, list: col.list, value: line[col.key], required,
          act: col.key === 'code' ? 'lineItem' : undefined,
          placeholder: col.key === 'code' ? 'พิมพ์รหัสสินค้าเพื่อค้นหา' : undefined,
          hint: col.key === 'code' && item ? `${item.name} · หน่วยหลัก ${item.baseUnit}`
            : col.key === 'lot' && tracked ? 'สินค้านี้ต้องระบุล็อต / Heat / Serial' : undefined });
      });
      const extra = columns.filter((col) => !primary.has(col.key));
      const open = !!line.remark || !!line.unit || (line.status && line.status !== 'AVAILABLE');
      return t`<fieldset class="docs-line"><legend>รายการ ${i + 1}</legend><div class="docs-line-heading"><strong>${item ? item.name : 'เพิ่มสินค้าในรายการนี้'}</strong>
        ${h.btn(t`${icon('trash')} ลบรายการ`, { act: 'removeLine', arg: i, tone: 'quiet', small: true, title: `ลบรายการ ${i + 1}` })}</div>
        <div class="docs-line-fields">${fields(columns.filter((col) => primary.has(col.key)))}</div>
        ${extra.length ? t`<details class="docs-line-extra"${h.safe(h.attr('open', !!open))}><summary>ข้อมูลเพิ่มเติม · หน่วย ล็อต สถานะ หมายเหตุ</summary><div class="docs-line-fields">${fields(extra)}</div></details>` : ''}</fieldset>`;
    })}</div><div class="le-add">${h.btn('+ เพิ่มรายการสินค้า', { act: 'addLine', tone: 'ghost' })}</div>`;
  }

  function docTitle(d) {
    const td = inv.DOC_TYPES[d.type] || {};
    return `${d.docNo} · ${d.type} ${td.name || ''}`;
  }

  const TYPE_COPY = {
    RR: ['รับสินค้าเข้า', 'รับสินค้าที่ซื้อเข้าคลัง', 'download'],
    PD: ['เบิกเพื่อผลิต', 'จ่ายวัตถุดิบหรือชิ้นส่วนให้ใบงาน', 'factory'],
    FR: ['รับสินค้าผลิตเสร็จ', 'รับงานผลิตที่เสร็จแล้วเข้าคลัง', 'package'],
    TR: ['โอนย้ายสินค้า', 'ย้ายระหว่างคลังหรือช่องเก็บ', 'arrows'],
    OU: ['เบิกใช้ภายใน', 'จ่ายสินค้าให้แผนกใช้งาน', 'upload'],
    RT: ['รับคืนจากงาน', 'นำของเหลือจากงานกลับเข้าคลัง', 'download'],
    AJ: ['ปรับยอดสต็อก', 'เพิ่มหรือลดยอดพร้อมเหตุผล', 'settings'],
    RV: ['คืนสินค้าให้ผู้ขาย', 'ส่งสินค้าคืนตามรายการจัดซื้อ', 'cart'],
    SC: ['ตัดของเสีย', 'นำของเสียออกจากยอดคงเหลือ', 'trash'],
    DL: ['ส่งมอบสินค้า', 'จ่ายสินค้าสำหรับการส่งมอบ', 'upload'],
  };
  const typeCopy = (type) => TYPE_COPY[type] || [(inv.DOC_TYPES[type] || {}).name || type, 'สร้างเอกสารและตรวจทานก่อนบันทึก', 'file'];
  const icon = (name) => h.icon ? h.icon(name) : '';
  const manualTypes = () => Object.entries(inv.DOC_TYPES).filter(([type]) => inv.manualType(type));
  const canPost = (ctx, d) => ctx.can((inv.DOC_TYPES[d.type] || {}).perm || 'doc.post');
  const canStart = (ctx, type) => ctx.can('doc.draft') || canPost(ctx, { type });
  const currentDoc = (ctx) => (ctx.view.sel && RRS.q.get(ctx.state, 'documents', ctx.view.sel)) ||
    (ctx.view.newType && inv.manualType(ctx.view.newType) ? { type: ctx.view.newType, status: 'DRAFT', date: ctx.today, lines: [], docNo: '' } : null);
  const reviewKey = (d) => d.docNo || 'new:' + d.type;
  const isReview = (ctx, d) => ctx.view.step === 'review' && ctx.view.reviewFor === reviewKey(d) && !!ctx.view.reviewPayload;
  const reset = { sel: null, creating: false, createType: null, newType: null, lines: null, header: null, checked: null,
    step: 'items', reviewFor: null, reviewPayload: null, reviewLines: null, reviewSnapshot: null };
  function steps(step) {
    return t`<ol class="docs-steps" aria-label="ขั้นตอนทำเอกสาร">${['เลือกประเภท', 'เพิ่มรายการ', 'ตรวจทานและยืนยัน'].map((label, i) =>
      t`<li class="${i + 1 === step ? 'is-current' : i + 1 < step ? 'is-done' : ''}"${h.safe(h.attr('aria-current', i + 1 === step ? 'step' : null))}><span>${i + 1}</span>${label}</li>`)}</ol>`;
  }
  function typePicker(ctx) {
    return t`<div class="docs-workspace docs-focus">${h.btn(t`${icon('chevron-left')} กลับรายการเอกสาร`, { act: 'back', tone: 'quiet' })}
      ${steps(1)}${h.section('ต้องการทำรายการอะไร?', t`<div class="docs-type-grid">${manualTypes().filter(([type]) => canStart(ctx, type)).map(([type]) => {
        const [label, hint, symbol] = typeCopy(type);
        return t`<button type="button" class="docs-type-card" data-act="chooseType" data-arg="${type}"><span class="docs-type-icon">${icon(symbol)}</span><span class="docs-type-copy"><strong>${label}</strong><small>${hint}</small></span><span class="docs-type-code">${type}</span></button>`;
      })}</div>`, { sub: 'เลือกประเภทแล้วกรอกรายการ ระบบจะออกเลขที่เมื่อคุณบันทึกเท่านั้น' })}</div>`;
  }
  function payload(ctx, d, values) {
    const previous = ctx.view.lines || d.lines || [];
    const lines = (values.lines || []).map((line, i) => Object.assign({}, previous[i] || {}, line));
    // Ignore the untouched placeholder row, but retain incomplete rows with a quantity/name so validation can explain them.
    const cleaned = lines.filter((line) => ['code', 'qty', 'unit', 'lot', 'remark'].some((key) => RRS.util.trim(line[key]) !== ''));
    const out = { type: d.type, lines: cleaned };
    for (const name of ['date', 'job', 'ref', 'department', 'remark']) out[name] = values[name] == null ? d[name] || '' : values[name];
    for (const name of ['source', 'supplier', 'supplierDoc']) if (d[name]) out[name] = d[name];
    return out;
  }
  function formValues(ctx, supplied, form, validate = true) {
    form = form || root.document.querySelector('form[data-form="draft"]');
    const bad = form && h.badNumbers(form);
    if (bad) { ctx.toast(bad.errors.map((e) => e.message).join(' · '), 'bad'); return null; }
    if (validate && form && form.reportValidity && !form.reportValidity()) return null;
    return supplied || (form ? h.parseForm(form) : null);
  }
  function overrideAvailable(ctx, checked) {
    const policy = ((ctx.state.tables.settings || {}).main || {}).policies || {};
    return ctx.can('doc.draft') && ctx.can('doc.post') && policy.negativeStock === 'approve' && checked && !checked.ok
      && checked.errors && checked.errors.length > 0 && checked.errors.every((e) => e.code === 'NOT_ENOUGH' || e.code === 'RESERVED');
  }
  function reviewDraft(ctx, supplied, form) {
    const d = currentDoc(ctx);
    if (!d || d.status !== 'DRAFT' || !canStart(ctx, d.type)) return;
    const values = supplied || formValues(ctx) || (!ctx.can('doc.draft') && d.docNo ? d : null);
    if (!values) return;
    if (form && !formValues(ctx, values, form)) return;
    const p = payload(ctx, d, values);
    const check = canPost(ctx, d) ? ctx.check('doc.post', p) : ctx.check('doc.saveDraft', Object.assign({}, p, d.docNo ? { docNo: d.docNo } : {}));
    const proceed = check.ok || overrideAvailable(ctx, check);
    const resolved = check.ok && check.commit && check.commit.effects.find((e) => e.t === 'documents' && e.v && e.v.type === d.type);
    ctx.set({ lines: p.lines, header: p, checked: check.ok ? { ok: true } : check, step: proceed ? 'review' : 'items',
      reviewFor: proceed ? reviewKey(d) : null, reviewPayload: proceed ? p : null, reviewLines: resolved ? resolved.v.lines : null,
      reviewSnapshot: d.docNo ? RRS.util.stable(d) : null });
  }
  function currentReview(ctx, d) {
    if (!isReview(ctx, d)) return false;
    if (!d.docNo) return true;
    const state = RRS.app && RRS.app.ledger ? RRS.app.ledger.state : ctx.state;
    const latest = RRS.q.get(state, 'documents', d.docNo);
    if (!latest || RRS.util.stable(latest) !== ctx.view.reviewSnapshot) {
      ctx.toast('เอกสารนี้มีการเปลี่ยนแปลง กรุณาเปิดตรวจทานอีกครั้ง', 'warn');
      ctx.set({ step: 'items', reviewFor: null, reviewPayload: null, header: null, lines: null, checked: null });
      return false;
    }
    return true;
  }
  async function saveDraft(ctx) {
    const d = currentDoc(ctx);
    if (!d || d.status !== 'DRAFT' || !ctx.can('doc.draft') || ctx.view.saving) return;
    const reviewing = isReview(ctx, d);
    if (reviewing && !currentReview(ctx, d)) return;
    const values = reviewing ? ctx.view.reviewPayload : formValues(ctx, null, null, false);
    if (!values) return;
    const p = reviewing ? values : payload(ctx, d, values);
    ctx.view.saving = true;
    try {
      const r = await ctx.exec('doc.saveDraft', Object.assign({}, p, d.docNo ? { docNo: d.docNo } : {}), { quiet: true });
      if (r.ok) {
        ctx.toast(`บันทึกร่าง ${r.result.docNo} แล้ว ยังไม่เปลี่ยนยอดสต็อก`, 'ok');
        ctx.set(Object.assign({}, reset, { sel: r.result.docNo }));
      } else ctx.set({ checked: r, lines: p.lines, header: p, step: 'items' });
    } finally { ctx.view.saving = false; }
  }
  function review(ctx, d) {
    const v = ctx.view;
    const p = v.reviewPayload;
    const td = inv.DOC_TYPES[d.type] || {};
    const permission = canPost(ctx, d);
    const action = overrideAvailable(ctx, v.checked) ? h.btn('ขออนุมัติข้อยกเว้น', { act: 'requestOverride', tone: 'primary' })
      : permission ? h.btn('ยืนยันบันทึกเอกสาร', { act: 'post', tone: 'primary', disabled: !v.checked || !v.checked.ok })
        : h.btn('บันทึกร่าง', { act: 'saveDraft', tone: 'primary', disabled: !ctx.can('doc.draft') });
    return t`<div class="docs-review">${h.dl([
      ['ประเภท', typeCopy(d.type)[0]], ['เลขที่', d.docNo || 'ออกเลขที่เมื่อยืนยัน'], ['วันที่', h.fmt.date(p.date)],
      ['งาน / SO', p.job], ['เอกสารอ้างอิง', p.ref], ['แผนก', p.department], p.remark ? ['หมายเหตุ', p.remark] : null,
    ])}<div class="docs-summary">${h.badge(`${p.lines.length} รายการ`, 'info')}
      <span>${td.dir === 'T' ? 'ย้ายออกจากต้นทางไประหว่างโอน และรอผู้รับยืนยันปลายทาง' : td.dir === -1 ? 'จ่ายสินค้าออกจากคลังที่ระบุ' : td.dir === 0 ? 'ปรับยอดตามจำนวนเพิ่มหรือลดที่ระบุ' : 'รับสินค้าเข้าคลังที่ระบุ'}</span></div>
      ${h.table({ rows: v.reviewLines || p.lines, cols: [
        { label: 'สินค้า', render: (l) => t`${h.code(l.code)}<br><span class="muted">${(ctx.item(l.code) || {}).name || ''}</span>` },
        { label: 'จำนวน', render: (l) => t`${h.qty(l.qty, l.unit || (ctx.item(l.code) || {}).baseUnit)}${l.factor && l.factor !== 1 ? t`<br><small class="muted">= ${h.qty(l.base, l.baseUnit)}</small>` : ''}` },
        { label: td.dir === 'T' ? 'ต้นทาง → ปลายทาง' : 'คลัง / ช่องเก็บ', get: (l) => `${l.wh || ''}${l.bin ? ' / ' + l.bin : ''}${l.toWh ? ' → ' + l.toWh + (l.toBin ? ' / ' + l.toBin : '') : ''}` },
        { label: 'ล็อต / Heat', key: 'lot' }, { label: 'สถานะของ', render: (l) => l.status ? h.statusBadge(l.status) : '' }, { label: 'หมายเหตุ', key: 'remark' },
      ] })}
      ${!permission ? h.note('คุณบันทึกร่างได้ ให้ผู้มีสิทธิ์บันทึกเอกสารตรวจและยืนยันเปลี่ยนยอด', 'info')
        : v.checked && v.checked.ok ? h.note('ตรวจผ่านแล้ว ระบบจะตรวจยอดและสิทธิ์อีกครั้งเมื่อยืนยันบันทึก', 'ok') : h.note(h.errors(v.checked || {}), 'bad')}
      <div class="docs-footer form-actions">${h.btn('กลับไปแก้ไขรายการ', { act: 'editItems', tone: 'ghost' })}
        ${permission && ctx.can('doc.draft') ? h.btn('บันทึกร่างไว้ก่อน', { act: 'saveDraft', tone: 'ghost' }) : ''}${action}</div></div>`;
  }

  function editor(ctx, d) {
    const v = ctx.view;
    const lines = v.lines || d.lines;
    const hd = v.header || d;
    const td = inv.DOC_TYPES[d.type] || {};
    const defWh = (ctx.state.tables.settings && ctx.state.tables.settings.main && ctx.state.tables.settings.main.express.defaultWarehouse) || '';
    return h.form({
      name: 'draft', submit: 'ตรวจทานเอกสาร', extra: [
        ctx.can('doc.draft') ? h.btn('บันทึกร่างไว้ก่อน', { act: 'saveDraft', tone: 'ghost' }) : '',
        d.docNo && ctx.can('doc.draft') ? h.btn('ลบร่าง', { act: 'deleteDraft', tone: 'quiet' }) : '',
      ],
      body: [
        h.field({ name: 'date', label: 'วันที่เอกสาร', type: 'date', value: hd.date || ctx.today, required: true }),
        h.field({ name: 'job', label: 'งาน / SO', value: hd.job, hint: td.needsJob ? 'จำเป็นสำหรับเอกสารนี้' : 'ใส่เพื่อผูกกับงานผลิต/การจอง' }),
        h.field({ name: 'ref', label: 'เอกสารอ้างอิง', value: hd.ref, placeholder: 'เช่น PO, ใบส่งของ' }),
        h.field({ name: 'department', label: 'แผนก', value: hd.department }),
        h.field({ name: 'remark', label: 'หมายเหตุ', value: hd.remark, wide: true }),
        t`<div class="wide docs-topline"><div><h3>รายการสินค้า</h3><p class="hint">ใส่รหัสสินค้า จำนวน และตำแหน่งเก็บของแต่ละรายการ</p></div></div>`,
        t`<div class="wide">${lineCards(ctx, d.type, lines.length ? lines : [{ wh: defWh }])}</div>`,
        v.checked && !v.checked.ok ? t`<div class="wide" role="alert">${h.note(t`แก้ไขรายการเหล่านี้ก่อนตรวจทาน${h.errors(v.checked)}`, 'bad')}</div>` : '',
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
      // Homepage shortcuts choose a type locally; opening a shortcut must never create an empty document.
      if (v.createType) {
        const type = v.createType;
        Object.assign(v, reset, { creating: true });
        if (inv.manualType(type) && canStart(ctx, type)) Object.assign(v, { newType: type, creating: false });
      }
      const selected = currentDoc(ctx);
      if (selected) {
        const draft = selected.status === 'DRAFT';
        const reviewing = draft && isReview(ctx, selected);
        const canEdit = draft && (ctx.can('doc.draft') || (!selected.docNo && canPost(ctx, selected)));
        return t`<div class="docs-workspace docs-focus"><div class="docs-topline">${h.btn(t`${icon('chevron-left')} กลับรายการเอกสาร`, { act: 'back', tone: 'quiet' })}
          <span>${selected.docNo ? h.docStatus(selected.status) : h.badge('ยังไม่บันทึก', 'muted')}</span></div>
          ${draft ? steps(reviewing ? 3 : 2) : ''}
          ${h.section(selected.docNo ? docTitle(selected) : typeCopy(selected.type)[0],
            reviewing ? review(ctx, selected) : canEdit ? editor(ctx, selected) : t`${view(ctx, selected)}${draft && canPost(ctx, selected) ? t`<div class="docs-footer form-actions">${h.btn('ตรวจทานเอกสาร', { act: 'check', tone: 'primary' })}</div>` : ''}`,
            { sub: draft ? reviewing ? 'ตรวจรายการให้ครบ แล้วจึงยืนยันบันทึก' : 'กรอกรายการก่อนตรวจทาน ร่างยังไม่เปลี่ยนยอดสต็อก' : '' })}</div>`;
      }
      if (v.creating) return typePicker(ctx);
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
      const canDraft = manualTypes().some(([type]) => canStart(ctx, type));
      const types = Object.entries(inv.DOC_TYPES);
      const newMenu = canDraft ? h.btn(t`${icon('file')} สร้างเอกสารใหม่`, { act: 'newDoc', tone: 'primary', id: 'docs-new' }) : '';
      const list = h.table({ id: 'docs-list', rows: shown.slice(0, 300), rowAct: 'pick', rowArg: (d) => d.docNo,
        empty: 'ยังไม่มีเอกสารในรายการนี้', emptyText: canDraft ? 'กด “สร้างเอกสารใหม่” เพื่อเริ่มรับ เบิก หรือโอนสินค้า' : '',
        cols: [{ label: 'เลขที่', render: (d) => h.btn(d.docNo, { act: 'pick', arg: d.docNo, tone: 'quiet', small: true }) },
          { label: 'ประเภท', get: (d) => typeCopy(d.type)[0] }, { label: 'วันที่', get: (d) => h.fmt.date(d.date) },
          { label: 'งาน/SO', key: 'job' }, { label: 'บรรทัด', num: true, get: (d) => d.lines.length }, { label: 'สถานะ', render: (d) => h.docStatus(d.status) },
          { label: 'Express', render: (d) => (d.expressStatus === 'WAIT' && d.status !== 'CANCELLED' ? h.badge('รอคีย์', 'warn') : d.expressStatus === 'KEYED' ? h.badge(d.expressNo, 'ok') : '') }] });
      return t`<div class="docs-workspace">${h.tabs([{ id: 'all', label: 'ทั้งหมด' }, { id: 'draft', label: 'ร่าง', count: counts.draft }, { id: 'wait', label: 'รออนุมัติ', count: counts.wait },
        { id: 'transit', label: 'ระหว่างโอน', count: counts.transit }, { id: 'express', label: 'รอคีย์ Express', count: counts.express }], tab)}
        ${h.toolbar([h.field({ name: 'q', label: 'ค้นหา', value: v.q, placeholder: 'เลขที่ งาน รหัสสินค้า…', id: 'docs-q' }),
          h.field({ name: 'type', label: 'ประเภท', type: 'select', value: v.type, options: types.map(([k, d]) => [k, `${k} ${d.name}`]), blank: 'ทุกประเภท', id: 'docs-type' })], newMenu)}
        ${list}</div>`;
    },
    after(ctx, root0) {
      const q = root0.querySelector('#docs-q');
      if (q) q.addEventListener('change', () => ctx.set({ q: q.value }));
      const ty = root0.querySelector('#docs-type');
      if (ty) ty.addEventListener('change', () => ctx.set({ type: ty.value }));
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg }),
      newDoc: (ctx) => ctx.set(Object.assign({}, reset, { creating: true })),
      chooseType(ctx, el) {
        const type = el.dataset.arg;
        if (!inv.manualType(type) || !canStart(ctx, type)) return;
        ctx.set(Object.assign({}, reset, { newType: type }));
      },
      async back(ctx) {
        const d = currentDoc(ctx);
        const form = root.document.querySelector('form[data-form="draft"]');
        const values = d && d.status === 'DRAFT' ? (form ? h.parseForm(form) : ctx.view.reviewPayload || ctx.view.header) : null;
        if (values) {
          const p = payload(ctx, d, values);
          const dirty = (form && h.badNumbers(form)) || (!d.docNo ? p.lines.length || ['job', 'ref', 'department', 'remark'].some((key) => RRS.util.trim(p[key]))
            : RRS.util.stable(inv.draftLines(p)) !== RRS.util.stable(inv.draftLines(d))
              || ['date', 'job', 'ref', 'department', 'remark'].some((key) => String(p[key] || '') !== String(d[key] || '')));
          if (dirty && !(await ctx.confirm({ title: 'ออกจากเอกสารนี้?', message: 'รายการที่ยังไม่ได้บันทึกจะหายไป', ok: 'ออกจากเอกสาร' }))) return;
        }
        ctx.set(Object.assign({}, reset));
      },
      pick: (ctx, el) => ctx.set(Object.assign({}, reset, { sel: el.dataset.arg })),
      editItems: (ctx) => ctx.set({ step: 'items', reviewFor: null, reviewPayload: null, checked: null }),
      lineItem(ctx) {
        const d = currentDoc(ctx), vals = formValues(ctx, null, null, false);
        if (!d || !vals) return;
        const previous = ctx.view.lines || d.lines || [];
        const lines = (vals.lines || []).map((line, i) => Object.assign({}, previous[i] || {}, line));
        ctx.set({ lines, header: vals, checked: null });
      },
      addLine(ctx) {
        const d = currentDoc(ctx), vals = formValues(ctx, null, null, false);
        if (!d || !vals) return;
        const previous = ctx.view.lines || d.lines || [];
        const lines = (vals.lines || []).map((line, i) => Object.assign({}, previous[i] || {}, line));
        const last = lines[lines.length - 1] || {};
        lines.push({ wh: last.wh || '', bin: '', toWh: last.toWh || '' });
        ctx.set({ lines, checked: null, header: vals });
      },
      removeLine(ctx, el) {
        const d = currentDoc(ctx), vals = formValues(ctx, null, null, false);
        if (!d || !vals) return;
        const previous = ctx.view.lines || d.lines || [];
        const lines = (vals.lines || []).map((line, i) => Object.assign({}, previous[i] || {}, line)).filter((_, i) => i !== Number(el.dataset.arg));
        ctx.set({ lines: lines.length ? lines : [{}], checked: null, header: vals });
      },
      check: (ctx) => reviewDraft(ctx),
      saveDraft,
      async post(ctx) {
        const d = currentDoc(ctx), v = ctx.view;
        if (!d || d.status !== 'DRAFT' || !canPost(ctx, d) || v.posting || !currentReview(ctx, d)) return;
        const p = v.reviewPayload;
        const check = ctx.check('doc.post', d.docNo && !ctx.can('doc.draft') ? { docNo: d.docNo } : p);
        if (!check.ok) return ctx.set({ checked: check });
        v.posting = true;
        try {
          const ok = await ctx.confirm({ title: `ยืนยัน${typeCopy(d.type)[0]}`, message: `${p.lines.length} รายการ · ยอดสต็อกจะเปลี่ยนเมื่อบันทึกสำเร็จ ระบบตรวจครบทั้งเอกสารก่อนเปลี่ยนยอด`, ok: 'ยืนยันบันทึก' });
          if (!ok || !currentReview(ctx, d)) return;
          // Confirmation precedes all writes. A new document posts atomically without first creating an empty draft.
          if (d.docNo && ctx.can('doc.draft')) {
            const saved = await ctx.exec('doc.saveDraft', Object.assign({}, p, { docNo: d.docNo }), { quiet: true });
            if (!saved.ok) return ctx.set({ checked: saved, step: 'items', reviewFor: null, reviewPayload: null });
          }
          const r = await ctx.exec('doc.post', d.docNo ? { docNo: d.docNo } : p, { quiet: true });
          if (r.ok) {
            ctx.toast(`บันทึก ${r.result.docNo} แล้ว`, 'ok');
            ctx.set(Object.assign({}, reset, { sel: r.result.docNo }));
          } else {
            const current = d.docNo && RRS.q.get((RRS.app && RRS.app.ledger && RRS.app.ledger.state) || ctx.state, 'documents', d.docNo);
            ctx.set({ checked: r, reviewSnapshot: current ? RRS.util.stable(current) : null });
          }
        } finally { v.posting = false; }
      },
      async requestOverride(ctx) {
        const d = currentDoc(ctx), v = ctx.view;
        if (!d || v.posting || !currentReview(ctx, d) || !overrideAvailable(ctx, v.checked)) return;
        const p = v.reviewPayload;
        let docNo = d.docNo;
        const result = await ctx.dialog({ title: 'ขออนุมัติข้อยกเว้นยอดไม่พอ', submit: 'บันทึกร่างและส่งขออนุมัติ',
          message: 'ยังไม่เปลี่ยนยอดสต็อก ผู้อนุมัติต้องเป็นคนละคนกับผู้ขอและผู้สร้างเอกสาร',
          body: h.field({ name: 'reason', label: 'เหตุผลอย่างน้อย 5 ตัวอักษร', required: true, wide: true }),
          async onSubmit(values) {
            if (RRS.util.trim(values.reason).length < 5) return { ok: false, errors: [{ code: 'REQUIRED', message: 'ระบุเหตุผลอย่างน้อย 5 ตัวอักษร' }] };
            if (!currentReview(ctx, d)) return { ok: false, errors: [{ code: 'CHANGED', message: 'เอกสารเปลี่ยนแล้ว กรุณาเปิดตรวจทานอีกครั้ง' }] };
            const saved = await ctx.exec('doc.saveDraft', Object.assign({}, p, docNo ? { docNo } : {}), { quiet: true });
            if (!saved.ok) return saved;
            docNo = saved.result.docNo;
            const current = RRS.q.get((RRS.app && RRS.app.ledger && RRS.app.ledger.state) || ctx.state, 'documents', docNo);
            if (d.docNo && current) v.reviewSnapshot = RRS.util.stable(current);
            return ctx.exec('doc.requestOverride', { docNo, reason: values.reason }, { quiet: true, done: 'ส่งขออนุมัติแล้ว ยังไม่เปลี่ยนยอด' });
          } });
        if (result && result.ok) ctx.set(Object.assign({}, reset, { sel: docNo }));
        else if (docNo && !d.docNo) ctx.set(Object.assign({}, reset, { sel: docNo }));
      },
      async deleteDraft(ctx) {
        const d = currentDoc(ctx);
        if (!d || !d.docNo || !ctx.can('doc.draft')) return;
        if (!(await ctx.confirm({ title: `ลบร่าง ${d.docNo}`, message: 'ร่างนี้จะหายไป (ยังไม่เคยเปลี่ยนยอด)', ok: 'ลบร่าง', danger: true }))) return;
        const r = await ctx.exec('doc.deleteDraft', { docNo: d.docNo }, { done: 'ลบร่างแล้ว' });
        if (r.ok) ctx.set(Object.assign({}, reset));
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
      draft: (ctx, values, form) => reviewDraft(ctx, values, form),
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
