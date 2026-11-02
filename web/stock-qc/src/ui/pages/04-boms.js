/*
 * Phase 0 – BOM per product and revision. Drafts are edited with a line editor (bom.upsert); engineering approves
 * (bom.approve): the approved revision is locked, the previously approved one becomes obsolete, and the item's
 * approved drawing revision is set to it.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const U = RRS.util;

  const ST = { DRAFT: ['ร่าง – รออนุมัติ', 'warn'], APPROVED: ['อนุมัติแล้ว (ใช้อยู่)', 'ok'], OBSOLETE: ['เลิกใช้', 'muted'] };
  const stBadge = (s) => h.badge((ST[s] || [s])[0], (ST[s] || [])[1] || 'muted');
  const keyOf = (b) => `${b.product}|${b.rev}`;
  const LINE_COLS = [
    { key: 'code', label: 'รหัสชิ้นส่วน', list: 'dl-items', w: '30%' },
    { key: 'qty', label: 'จำนวนต่อสินค้า 1 หน่วย', type: 'number', w: '16%' },
    { key: 'unit', label: 'หน่วย (ว่าง = หน่วยหลัก)', w: '16%' },
    { key: 'note', label: 'หมายเหตุ' },
  ];

  /** Next free revision after the newest one: A→B, 3→4, otherwise "<rev>.1". */
  function nextRev(state, product) {
    const revs = RRS.q.rows(state, 'boms', (b) => b.product === product).map((b) => b.rev);
    if (!revs.length) return 'A';
    const last = revs.sort((a, b) => (a.length - b.length) || a.localeCompare(b)).pop();
    let cand;
    if (/^\d+$/.test(last)) cand = String(Number(last) + 1);
    else if (/^[A-Z]+$/.test(last)) {
      const chars = last.split('');
      let i = chars.length - 1;
      while (i >= 0 && chars[i] === 'Z') { chars[i] = 'A'; i--; }
      if (i < 0) chars.unshift('A'); else chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      cand = chars.join('');
    } else cand = last + '.1';
    while (revs.indexOf(cand) >= 0) cand += '.1';
    return cand;
  }

  function editor(ctx, b) {
    const v = ctx.view;
    const hd = v.header || b || {};
    const lines = v.lines || (b ? b.lines : null) || [{}];
    const isNew = !b;
    const prod = hd.product ? ctx.item(hd.product) : null;
    return h.form({
      name: 'bom', submit: isNew ? 'บันทึกเป็นร่าง' : 'บันทึกร่าง', cancel: isNew ? 'close' : null,
      extra: [
        h.btn('ตรวจก่อนบันทึก', { act: 'check', tone: 'ghost' }),
        !isNew && ctx.can('bom.approve') ? h.btn('อนุมัติฉบับนี้', { act: 'approve', tone: 'primary', title: 'ฉบับที่อนุมัติก่อนหน้าจะเป็นเลิกใช้ และทะเบียนสินค้าจะใช้ฉบับนี้' }) : '',
        !isNew ? t`<span class="hint">อนุมัติแล้วแก้ไม่ได้ ฉบับที่ใช้อยู่จะเป็น เลิกใช้ และทะเบียนสินค้าตั้งฉบับแบบเป็นฉบับนี้</span>` : '',
      ],
      body: [
        h.field({ name: 'product', label: 'สินค้าที่ผลิต (รหัส)', value: hd.product, required: true, readonly: !isNew, list: isNew ? 'dl-items' : null,
          hint: prod ? `${prod.name} · หน่วยหลัก ${prod.baseUnit}` : 'เลือกจากทะเบียนสินค้า เช่น สินค้าสำเร็จรูปหรือชุดประกอบย่อย' }),
        h.field({ name: 'rev', label: 'ฉบับ (rev)', value: hd.rev, required: true, readonly: !isNew, hint: isNew ? 'เช่น A, B, 01 – ซ้ำกับฉบับที่มีอยู่ไม่ได้' : 'ฉบับแก้ไม่ได้ – สร้างฉบับใหม่แทน' }),
        h.field({ name: 'drawingNo', label: 'เลขที่แบบ', value: hd.drawingNo || (prod && prod.drawingNo) }),
        t`<div class="wide">${h.lineEditor({ name: 'lines', cols: LINE_COLS, lines })}<p class="hint">จำนวนคือที่ใช้ต่อสินค้า 1 ${prod ? prod.baseUnit : 'หน่วย'} · ใส่หน่วยอื่นได้ถ้าตั้งตัวคูณไว้ ระบบเก็บเป็นหน่วยหลักของชิ้นส่วน</p></div>`,
        v.checked ? t`<div class="wide">${v.checked.ok ? h.note('ตรวจแล้ว: บันทึกได้ทุกบรรทัด', 'ok') : h.note(t`ยังบันทึกไม่ได้ – แก้ตามนี้${h.errors(v.checked)}`, 'bad')}</div>` : '',
      ],
    });
  }

  function viewBom(ctx, b) {
    return t`${h.dl([['สินค้า', `${b.product} ${(ctx.item(b.product) || {}).name || ''}`], ['ฉบับ', b.rev], ['เลขที่แบบ', b.drawingNo], ['สถานะ', stBadge(b.status)],
      ['อนุมัติโดย', b.approvedBy ? `${ctx.userName(b.approvedBy)} · ${h.fmt.dt(b.approvedAt)}` : '']])}
      ${h.table({ rows: b.lines, dense: true, empty: 'ไม่มีบรรทัด', cols: [
        { label: '#', get: (l, i) => i + 1 }, { label: 'รหัส', render: (l) => h.code(l.code) }, { label: 'รายการ', get: (l) => (ctx.item(l.code) || {}).name || '' },
        { label: 'จำนวนต่อ 1 หน่วย', render: (l) => h.qty(l.qty, l.unit) }, { label: 'หมายเหตุ', key: 'note' }] })}`;
  }

  const REV_RE = /^[A-Z0-9\u0E00-\u0E7F][A-Z0-9\u0E00-\u0E7F._-]*$/;

  /**
   * Form values -> payload for bom.upsert, plus problems the engine cannot see: a line with a quantity but no code
   * (it would be dropped), an odd revision, or – for a new BOM – a product + revision that already exists (bom.upsert
   * would overwrite that draft). `map` turns the engine's line numbers (empty rows removed) back into the rows shown.
   */
  function prepare(ctx, vals) {
    const map = [];
    const lines = [];
    const errors = [];
    (vals.lines || []).forEach((l, i) => {
      const has = (k) => U.trim(l && l[k]) !== '';
      if (has('code')) {
        map.push(i + 1);
        lines.push(l);
      } else if (has('qty') || has('unit') || has('note')) errors.push({ message: `บรรทัด ${i + 1}: ใส่รหัสชิ้นส่วน (มีจำนวน/หน่วย/หมายเหตุ แต่ยังไม่มีรหัส) หรือกด × ลบบรรทัดนี้` });
    });
    const rev = U.normCode(vals.rev);
    if (rev && !REV_RE.test(rev)) errors.push({ message: `ฉบับ "${rev}" ใช้ได้เฉพาะตัวอักษร ตัวเลข และ . _ - เช่น A, B, 01` });
    if (ctx.view.sel === '__new' && rev) {
      const prod = ctx.item(vals.product);
      const prev = prod && RRS.q.get(ctx.state, 'boms', `${prod.id}|${rev}`);
      if (prev) errors.push({ message: `${prod.id} ฉบับ ${rev} มีอยู่แล้ว (${(ST[prev.status] || [prev.status])[0]}) – ใช้ฉบับ ${nextRev(ctx.state, prod.id)} หรือเลือกฉบับนั้นจากรายการเพื่อแก้` });
    }
    return { errors, map, payload: { product: vals.product, rev: vals.rev, drawingNo: vals.drawingNo, lines } };
  }
  const renumber = (r, map) => (r && r.errors ? Object.assign({}, r, { errors: r.errors.map((e) => (e.line && map[e.line - 1]
    ? Object.assign({}, e, { message: String(e.message).replace(/^บรรทัด \d+/, `บรรทัด ${map[e.line - 1]}`) }) : e)) }) : r);
  const keepForm = (ctx, vals) => ({ lines: vals.lines, header: Object.assign({}, ctx.view.header, vals, { lines: undefined }) });
  const bomForm = () => root.document.querySelector('form[data-form="bom"]');

  RRS.ui.page({
    id: 'boms', title: 'BOM และฉบับแบบ', phase: 0, order: 30,
    sub: 'ชิ้นส่วนที่ใช้ต่อสินค้า 1 หน่วยตามฉบับแบบ · ใช้จองและเบิกให้งานผลิต · ฉบับที่อนุมัติแล้วแก้ไม่ได้ ต้องสร้างฉบับใหม่',
    badge: (ctx) => (ctx.can('bom.approve') ? RRS.q.rows(ctx.state, 'boms', (b) => b.status === 'DRAFT').length || '' : ''),
    render(ctx) {
      const v = ctx.view;
      const canEdit = ctx.can('master.edit');
      const q = (v.q || '').toLowerCase();
      const items = RRS.q.rows(ctx.state, 'items');
      const all = RRS.q.rows(ctx.state, 'boms');
      const ORDER = { APPROVED: 0, DRAFT: 1, OBSOLETE: 2 };
      const rows = all.filter((b) => (!v.st || b.status === v.st) && (!q || [b.product, b.rev, b.drawingNo, (ctx.item(b.product) || {}).name]
        .concat(b.lines.map((l) => l.code)).some((x) => String(x || '').toLowerCase().indexOf(q) >= 0)))
        .sort((a, b) => a.product.localeCompare(b.product) || (ORDER[a.status] - ORDER[b.status]) || b.rev.localeCompare(a.rev));
      const list = h.table({ rows, rowAct: 'pick', rowArg: keyOf, rowCls: (b) => (keyOf(b) === v.sel ? 'sel' : b.status === 'OBSOLETE' ? 'muted' : ''),
        empty: all.length ? 'ไม่พบ BOM ตามที่ค้น' : 'ยังไม่มี BOM',
        emptyText: all.length ? 'ลองคำค้นหรือสถานะอื่น' : !items.length ? 'เพิ่มสินค้าที่ผลิตและชิ้นส่วนในทะเบียนสินค้าก่อน แล้วกลับมาสร้าง BOM'
          : canEdit ? 'กด + สร้าง BOM เลือกสินค้าที่ผลิต แล้วใส่ชิ้นส่วนที่ใช้' : 'หัวหน้าสโตร์/วิศวกรรมเป็นผู้สร้าง BOM',
        cols: [
          { label: 'สินค้า', render: (b) => h.code(b.product) },
          { label: 'ชื่อ', get: (b) => (ctx.item(b.product) || {}).name || '' },
          { label: 'ฉบับ', render: (b) => h.code(b.rev) },
          { label: 'สถานะ', render: (b) => stBadge(b.status) },
          { label: 'บรรทัด', num: true, get: (b) => b.lines.length },
          { label: 'อนุมัติ', get: (b) => (b.approvedBy ? `${ctx.userName(b.approvedBy)} ${h.fmt.date(U.bkkDate(b.approvedAt))}` : '') },
        ] });

      let detail = h.empty('เลือก BOM จากรายการ', canEdit ? 'หรือกด + สร้าง BOM' : 'ดูชิ้นส่วนและฉบับที่อนุมัติ');
      if (!items.length) detail = h.empty('ยังไม่มีสินค้าในทะเบียน', 'BOM ต้องมีทั้งสินค้าที่ผลิตและชิ้นส่วนในทะเบียนก่อน', h.link('ไปที่ทะเบียนสินค้า', 'items'));
      const sel = v.sel && v.sel !== '__new' ? RRS.q.get(ctx.state, 'boms', v.sel) : null;
      if (v.sel === '__new' && canEdit) {
        detail = h.section(v.header && v.header.copyOf ? `ฉบับใหม่จาก ${v.header.copyOf}` : 'สร้าง BOM', editor(ctx, null), { sub: 'บันทึกเป็นร่างก่อน วิศวกรรมตรวจแล้วจึงอนุมัติ' });
      } else if (sel) {
        const prod = ctx.item(sel.product) || {};
        const others = all.filter((b) => b.product === sel.product).sort((a, b) => b.rev.localeCompare(a.rev));
        const approvedNow = others.find((b) => b.status === 'APPROVED');
        const body = sel.status === 'DRAFT' && canEdit ? editor(ctx, sel) : viewBom(ctx, sel);
        const acts = [];
        if (sel.status === 'DRAFT' && !canEdit && ctx.can('bom.approve')) acts.push(h.btn('อนุมัติฉบับนี้', { act: 'approve', tone: 'primary' }));
        if (canEdit) acts.push(h.btn('สร้างฉบับใหม่จากฉบับนี้', { act: 'copy', tone: 'ghost', small: true }));
        detail = t`${h.section(t`${h.code(sel.product)} ฉบับ ${sel.rev}`, body, {
          sub: t`${prod.name || ''} · ${stBadge(sel.status)} · ทะเบียนสินค้าใช้ฉบับแบบ ${prod.drawingRev || 'ยังไม่ตั้ง'}${approvedNow && approvedNow !== sel ? ` · ฉบับที่ใช้อยู่ ${approvedNow.rev}` : ''}`,
          actions: acts })}
          ${others.length > 1 ? h.section('ทุกฉบับของสินค้านี้', h.table({ rows: others, dense: true, rowAct: 'pick', rowArg: keyOf, rowCls: (b) => (keyOf(b) === v.sel ? 'sel' : ''),
            cols: [{ label: 'ฉบับ', render: (b) => h.code(b.rev) }, { label: 'สถานะ', render: (b) => stBadge(b.status) }, { label: 'บรรทัด', num: true, get: (b) => b.lines.length },
              { label: 'อนุมัติ', get: (b) => (b.approvedBy ? `${ctx.userName(b.approvedBy)} · ${h.fmt.dt(b.approvedAt)}` : '') }] })) : ''}`;
      }
      if (!all.length && v.sel !== '__new') {
        if (!items.length) return h.empty('ยังไม่มี BOM และยังไม่มีสินค้าในทะเบียน', 'BOM ต้องมีทั้งสินค้าที่ผลิตและชิ้นส่วนในทะเบียนสินค้าก่อน – เพิ่มสินค้าแล้วกลับมาสร้าง BOM', h.link('ไปที่ทะเบียนสินค้า', 'items'));
        return h.empty('ยังไม่มี BOM', canEdit ? 'BOM บอกว่าสินค้า 1 หน่วยใช้ชิ้นส่วนอะไรเท่าไร ตามฉบับแบบ – สร้างเป็นร่าง แล้ววิศวกรรมอนุมัติ ระบบใช้ฉบับที่อนุมัติในการจองและเบิกให้งานผลิต'
          : 'หัวหน้าสโตร์/วิศวกรรมเป็นผู้สร้าง BOM – เมื่อมีแล้วรายการทุกฉบับจะขึ้นที่นี่', canEdit ? h.btn('+ สร้าง BOM แรก', { act: 'new', tone: 'primary' }) : '');
      }
      const stOpts = Object.keys(ST).map((k) => [k, ST[k][0]]);
      return t`${h.toolbar([
        h.field({ name: 'q', label: 'ค้นหา', value: v.q, placeholder: 'รหัสสินค้า ฉบับ รหัสชิ้นส่วน…', id: 'bom-q' }),
        h.field({ name: 'st', label: 'สถานะ', type: 'select', value: v.st, options: stOpts, blank: 'ทุกสถานะ', id: 'bom-st' }),
      ], canEdit && items.length ? h.btn('+ สร้าง BOM', { act: 'new', tone: 'primary' }) : '')}
        <div class="split"><div>${list}<p class="hint">${rows.length} ฉบับ · อนุมัติแล้ว ${all.filter((b) => b.status === 'APPROVED').length} · ร่าง ${all.filter((b) => b.status === 'DRAFT').length}</p></div><div>${detail}</div></div>`;
    },
    after(ctx, root0) {
      const q = root0.querySelector('#bom-q');
      if (q) {
        q.addEventListener('input', () => { ctx.view.q = q.value; clearTimeout(ctx.view._t); ctx.view._t = setTimeout(() => ctx.set({ _refocus: true }), 250); });
        if (ctx.view._refocus) { ctx.view._refocus = false; q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      }
      const st = root0.querySelector('#bom-st');
      if (st) st.addEventListener('change', () => ctx.set({ st: st.value }));
    },
    actions: {
      pick: (ctx, el) => ctx.set({ sel: el.dataset.arg, lines: null, header: null, checked: null }),
      new: (ctx) => ctx.set({ sel: '__new', lines: null, header: null, checked: null }),
      close: (ctx) => ctx.set({ sel: null, lines: null, header: null, checked: null }),
      copy(ctx) {
        const b = RRS.q.get(ctx.state, 'boms', ctx.view.sel);
        if (!b) return;
        ctx.set({ sel: '__new', header: { product: b.product, rev: nextRev(ctx.state, b.product), drawingNo: b.drawingNo, copyOf: `${b.product} ฉบับ ${b.rev}` },
          lines: b.lines.map((l) => ({ code: l.code, qty: l.qty, unit: l.unit, note: l.note })), checked: null });
      },
      addLine(ctx) {
        const vals = h.parseForm(bomForm());
        const lines = vals.lines || [];
        lines.push({});
        ctx.set({ lines, header: Object.assign({}, ctx.view.header, vals, { lines: undefined }), checked: null });
      },
      removeLine(ctx, el) {
        const vals = h.parseForm(bomForm());
        const lines = (vals.lines || []).filter((_, i) => i !== Number(el.dataset.arg));
        ctx.set({ lines: lines.length ? lines : [{}], header: Object.assign({}, ctx.view.header, vals, { lines: undefined }), checked: null });
      },
      check(ctx) {
        const vals = h.parseForm(bomForm());
        const p = prepare(ctx, vals);
        const r = p.errors.length ? { ok: false, errors: p.errors } : renumber(ctx.check('bom.upsert', p.payload), p.map);
        ctx.set(Object.assign(keepForm(ctx, vals), { checked: r.ok ? { ok: true } : r }));
      },
      async approve(ctx) {
        const b = RRS.q.get(ctx.state, 'boms', ctx.view.sel);
        if (!b || b.status !== 'DRAFT') return;
        const form = bomForm();
        let p = null;
        let vals = null;
        if (form) {
          // approve what is on screen: check it first, save only after the person confirms
          vals = h.parseForm(form);
          p = prepare(ctx, vals);
          const c = p.errors.length ? { ok: false, errors: p.errors } : renumber(ctx.check('bom.upsert', p.payload), p.map);
          if (!c.ok) return ctx.set(Object.assign(keepForm(ctx, vals), { checked: c }));
        }
        const n = p ? p.payload.lines.length : b.lines.length;
        const prod = ctx.item(b.product) || {};
        const cur = RRS.q.rows(ctx.state, 'boms', (x) => x.product === b.product && x.status === 'APPROVED');
        const ok = await ctx.confirm({ title: `อนุมัติ BOM ${b.product} ฉบับ ${b.rev}`, ok: 'อนุมัติ',
          body: t`<ul class="wide">
            <li>ฉบับ ${b.rev} (${n} บรรทัด ตามที่แสดงอยู่) จะแก้ไม่ได้อีก – ต้องการเปลี่ยนให้สร้างฉบับใหม่</li>
            <li>${cur.length ? `ฉบับที่ใช้อยู่ (${cur.map((x) => x.rev).join(', ')}) จะเป็น เลิกใช้` : 'ยังไม่มีฉบับที่อนุมัติก่อนหน้า'}</li>
            <li>ทะเบียนสินค้า ${b.product} ${prod.name || ''} จะตั้งฉบับแบบที่อนุมัติ จาก ${prod.drawingRev || '(ว่าง)'} เป็น ${b.rev}</li></ul>` });
        if (!ok) return;
        if (p) {
          const saved = await ctx.exec('bom.upsert', p.payload, { quiet: true });
          if (!saved.ok) return ctx.set(Object.assign(keepForm(ctx, vals), { checked: renumber(saved, p.map) }));
        }
        const r = await ctx.exec('bom.approve', { product: b.product, rev: b.rev }, { done: `อนุมัติ ${b.product} ฉบับ ${b.rev} แล้ว` });
        if (r.ok) ctx.set({ lines: null, header: null, checked: null });
      },
    },
    forms: {
      async bom(ctx, vals) {
        const p = prepare(ctx, vals);
        if (p.errors.length) return ctx.set(Object.assign(keepForm(ctx, vals), { checked: { ok: false, errors: p.errors } }));
        const r = await ctx.exec('bom.upsert', p.payload, { quiet: true, done: 'บันทึกร่าง BOM แล้ว' });
        if (r.ok) {
          const prod = ctx.item(vals.product);
          ctx.set({ sel: `${prod ? prod.id : U.normCode(vals.product)}|${U.normCode(vals.rev)}`, lines: null, header: null, checked: null });
        } else ctx.set(Object.assign(keepForm(ctx, vals), { checked: renumber(r, p.map) }));
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
