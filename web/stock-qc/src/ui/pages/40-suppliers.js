/*
 * Phase 4 – ผู้ขายและเงื่อนไขซื้อ (src/engine/purchasing.js). Three tabs:
 *   ผู้ขาย              suppliers (supplier.upsert): code, name, tax id, contact, phone, usual lead time, active;
 *                        the items bought from the supplier and its open purchase orders
 *   ราคาและหน่วยซื้อ     per item: its suppliers with price, buy unit + factor, MOQ, pack, lead time, preferred
 *                        (itemSupplier.upsert) – the replenishment plan and new POs read these terms
 *   เงื่อนไขเติมสต็อก    reorder rules per item / warehouse (reorder.set): Min, Max, lead time, supplier, cover and
 *                        usage days; an empty field falls back to the item register, the supplier or the usage history
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const U = RRS.util;
  const P = () => RRS.purchasing || null;

  const LIMIT = 300;
  const dash = t`<span class="muted">–</span>`;
  const low = (s) => String(s == null ? '' : s).toLowerCase();
  const has = (v) => v != null && v !== '';
  const nOr = (v) => (has(v) ? h.fmt.num(v) : dash);
  const daysOr = (v) => (has(v) ? `${h.fmt.num(v)} วัน` : dash);
  const OPEN_PO = { DRAFT: true, ISSUED: true, PARTIAL: true };
  const PO_TONE = { DRAFT: 'muted', ISSUED: 'info', PARTIAL: 'warn', RECEIVED: 'ok', CLOSED: 'muted', CANCELLED: 'bad' };

  function suppliers(state) {
    return RRS.q.rows(state, 'suppliers').sort((a, b) => a.id.localeCompare(b.id));
  }
  function supOptions(state, keep) {
    return suppliers(state).filter((s) => s.active !== false || s.id === keep).map((s) => [s.id, `${s.id} · ${s.name}`]);
  }
  const supName = (state, id) => ((state.tables.suppliers || {})[id] || {}).name || '';
  const links = (state, f) => RRS.q.rows(state, 'item_suppliers', f);
  /** What the replenishment plan uses for one item now (supplier, lead time, Min/Max and where each comes from). */
  function planOf(ctx, code, wh) {
    try {
      return (P().suggest(ctx.state, { today: ctx.today, code, wh: wh || '' }) || [])[0] || null;
    } catch (e) {
      return null;
    }
  }
  const poLink = (poNo) => h.link(h.code(poNo), 'purchasing', { tab: 'po', po: poNo });
  /** Who can do something the current user cannot (for the read-only notes). */
  const whoCan = (perm) => RRS.auth.rolesFor(perm).filter((r) => r !== 'admin').map((r) => RRS.auth.ROLES[r] || r).join(' / ');
  /**
   * ctx.set that also keeps a search typed less than 250 ms ago: its live update has not run yet, and without this the
   * click would re-render the box empty and the late update would then wipe what the user typed into a form.
   */
  function set(ctx, patch) {
    const p = Object.assign({}, patch);
    for (const el of root.document.querySelectorAll('#main input[data-live][data-act]')) {
      const k = el.dataset.act;
      if (!(k in p) && (ctx.view[k] || '') !== el.value) p[k] = el.value;
    }
    ctx.set(p);
  }
  /** Live search box: re-render only when the text really changed (a click may already have kept it). */
  const live = (key, extra) => (ctx, el) => {
    if ((ctx.view[key] || '') === el.value) return;
    ctx.set(Object.assign({ [key]: el.value }, extra || {}));
  };

  // ---- ผู้ขาย ---------------------------------------------------------------------------------------------------
  function supForm(ctx, s) {
    const v = s || { active: true };
    return h.form({
      name: 'saveSup', submit: s ? 'บันทึกการแก้ไขผู้ขาย' : 'เพิ่มผู้ขาย', cancel: s ? null : 'close',
      body: [
        h.field({ name: 'id', label: 'รหัสผู้ขาย', value: v.id, required: true, readonly: !!s, id: 'sup-id',
          hint: s ? 'รหัสแก้ไม่ได้ – ถ้าผิดให้ปิดใช้งานแล้วเพิ่มใหม่' : 'ใช้ A-Z 0-9 . _ - ไม่เกิน 30 ตัว เช่น S-001 หรือรหัสผู้ขายใน Express' }),
        h.field({ name: 'name', label: 'ชื่อผู้ขาย', value: v.name, required: true, wide: true, id: 'sup-name' }),
        h.field({ name: 'taxId', label: 'เลขประจำตัวผู้เสียภาษี', value: v.taxId, hint: 'ตัวเลข 13 หลัก เว้นว่างได้', id: 'sup-tax' }),
        h.field({ name: 'contact', label: 'ผู้ติดต่อ', value: v.contact, id: 'sup-contact' }),
        h.field({ name: 'phone', label: 'โทรศัพท์', value: v.phone, id: 'sup-phone' }),
        h.field({ name: 'leadDays', label: 'Lead time ปกติ (วัน)', type: 'number', value: v.leadDays, id: 'sup-lead',
          hint: 'ใช้เมื่อสินค้าไม่ได้ตั้ง Lead time ของตัวเอง · ว่าง = 7 วัน' }),
        h.field({ name: 'active', label: 'ใช้งาน', type: 'checkbox', value: v.active !== false, id: 'sup-active',
          hint: 'ปิดแล้วออกใบสั่งซื้อใหม่ไม่ได้ แต่รับของจากใบเดิมได้' }),
      ],
    });
  }

  function supplierTab(ctx) {
    const v = ctx.view;
    const canEdit = ctx.can('supplier.manage');
    const all = suppliers(ctx.state);
    if (!all.length && v.sup !== '__new') {
      return h.empty('ยังไม่มีผู้ขาย', canEdit
        ? 'ผู้ขายคือบริษัทที่เราสั่งซื้อของ – เพิ่มผู้ขายรายแรก แล้วตั้งราคาและหน่วยซื้อของสินค้าที่แท็บ ราคาและหน่วยซื้อ (แผนเติมสต็อกและใบสั่งซื้อใช้ค่าเหล่านี้)'
        : `ฝ่ายจัดซื้อ (${whoCan('supplier.manage')}) เป็นผู้เพิ่มผู้ขาย – เมื่อเพิ่มแล้วรายชื่อผู้ขาย ราคา และหน่วยซื้อจะขึ้นที่นี่`,
      canEdit ? h.btn('+ เพิ่มผู้ขายรายแรก', { act: 'newSup', tone: 'primary' }) : '');
    }
    const q = low(v.sq).trim();
    const allLinks = links(ctx.state, (l) => l.active !== false);
    const pos = RRS.q.rows(ctx.state, 'pos', (p) => OPEN_PO[p.status]);
    const shown = all.filter((s) => (v.sOff || s.active !== false)
      && (!q || [s.id, s.name, s.contact, s.phone, s.taxId].some((x) => low(x).indexOf(q) >= 0)));
    const list = h.table({
      id: 'sup-list', scroll: true, rows: shown, rowAct: 'pickSup', rowArg: (s) => s.id,
      rowCls: (s) => (s.id === v.sup ? 'sel' : s.active === false ? 'muted' : ''),
      empty: 'ไม่พบผู้ขายตามที่ค้น', emptyText: 'ลองคำค้นอื่น หรือติ๊ก แสดงที่ปิดใช้งาน',
      cols: [
        { label: 'รหัส', render: (s) => h.code(s.id) },
        { label: 'ชื่อผู้ขาย', render: (s) => t`${s.name}${s.contact ? t`<br><small class="muted">${s.contact}${s.phone ? ' · ' + s.phone : ''}</small>` : s.phone ? t`<br><small class="muted">${s.phone}</small>` : ''}${s.active === false ? t` ${h.badge('ปิดใช้งาน', 'muted')}` : ''}` },
        { label: 'Lead time', render: (s) => daysOr(s.leadDays) },
        { label: 'สินค้า', num: true, get: (s) => allLinks.filter((l) => l.supplier === s.id).length },
        { label: 'PO ค้าง', num: true, render: (s) => { const n = pos.filter((p) => p.supplier === s.id).length; return n ? h.fmt.num(n) : dash; } },
      ],
    });
    let detail = h.empty('เลือกผู้ขายจากรายการ', 'ดู/แก้ข้อมูลผู้ขาย สินค้าที่ซื้อจากผู้ขายนี้ และใบสั่งซื้อที่ยังค้าง');
    const sel = v.sup && v.sup !== '__new' ? RRS.q.get(ctx.state, 'suppliers', v.sup) : null;
    if (v.sup === '__new' && canEdit) detail = h.section('เพิ่มผู้ขาย', supForm(ctx, null));
    else if (sel) {
      const its = links(ctx.state, (l) => l.supplier === sel.id).sort((a, b) => a.code.localeCompare(b.code));
      const items = ctx.state.tables.items || {};
      const myPos = RRS.q.rows(ctx.state, 'pos', (p) => p.supplier === sel.id && OPEN_PO[p.status]).sort((a, b) => b.poNo.localeCompare(a.poNo));
      const itTbl = h.table({
        rows: its, dense: true, rowAct: 'toItem', rowArg: (l) => l.code,
        empty: 'ยังไม่ได้ตั้งสินค้าของผู้ขายนี้', emptyText: canEdit ? 'กด + ตั้งราคาสินค้าของผู้ขายนี้ หรือเลือกสินค้าที่แท็บ ราคาและหน่วยซื้อ' : '',
        cols: [
          { label: 'สินค้า', render: (l) => t`${h.code(l.code)} ${(items[l.code] || {}).name || ''}${l.preferred ? t` ${h.badge('ผู้ขายหลัก', 'accent')}` : ''}${l.active === false ? t` ${h.badge('ปิดใช้งาน', 'muted')}` : ''}` },
          { label: 'ราคา / หน่วยซื้อ', num: true, render: (l) => (has(l.price) ? t`${h.fmt.money(l.price)} / ${l.buyUnit}` : h.badge('ยังไม่มีราคา', 'warn')) },
          { label: 'หน่วยซื้อ', render: (l) => t`1 ${l.buyUnit} = ${h.qty(l.factor, (items[l.code] || {}).baseUnit)}` },
          { label: 'Lead time', render: (l) => daysOr(l.leadDays) },
        ],
      });
      const poTbl = h.table({
        rows: myPos, dense: true, empty: 'ไม่มีใบสั่งซื้อค้าง', emptyText: 'ใบสั่งซื้อที่ยังรับไม่ครบของผู้ขายนี้จะขึ้นที่นี่',
        cols: [
          { label: 'เลขที่', render: (p) => poLink(p.poNo) },
          { label: 'วันที่', get: (p) => h.fmt.date(p.date) },
          { label: 'สถานะ', render: (p) => h.badge((P().PO_STATUS || {})[p.status] || p.status, PO_TONE[p.status]) },
          { label: 'มูลค่า', num: true, get: (p) => h.fmt.money(p.total) },
        ],
      });
      detail = t`${h.section(t`${h.code(sel.id)} ${sel.name}`, canEdit ? supForm(ctx, sel) : h.dl([
        ['เลขประจำตัวผู้เสียภาษี', sel.taxId], ['ผู้ติดต่อ', sel.contact], ['โทรศัพท์', sel.phone], ['Lead time ปกติ', has(sel.leadDays) ? `${sel.leadDays} วัน` : 'ไม่ได้ตั้ง (ใช้ 7 วัน)'],
        ['สถานะ', sel.active === false ? 'ปิดใช้งาน' : 'ใช้งาน'], ['แก้ล่าสุด', sel.updatedBy ? `${ctx.userName(sel.updatedBy)} · ${h.fmt.dt(sel.updatedAt)}` : '']]),
      { sub: canEdit && sel.updatedBy ? `แก้ล่าสุดโดย ${ctx.userName(sel.updatedBy)} · ${h.fmt.dt(sel.updatedAt)}` : '' })}
        ${h.section(`สินค้าที่ซื้อจากผู้ขายนี้ (${its.length})`, itTbl, { sub: its.length ? 'คลิกแถวเพื่อดู/แก้ราคาและหน่วยซื้อของสินค้านั้น' : '',
          actions: canEdit && sel.active !== false ? h.btn('+ ตั้งราคาสินค้าของผู้ขายนี้', { act: 'termForSup', arg: sel.id, tone: 'ghost', small: true }) : '' })}
        ${h.section(`ใบสั่งซื้อที่ยังค้าง (${myPos.length})`, poTbl)}`;
    }
    return t`${h.toolbar([
      h.field({ name: 'sq', label: 'ค้นหาผู้ขาย', value: v.sq, placeholder: 'รหัส ชื่อ ผู้ติดต่อ เบอร์…', id: 'sup-q', act: 'sq', live: true }),
      h.field({ name: 'sOff', label: 'แสดงที่ปิดใช้งาน', type: 'checkbox', value: v.sOff, id: 'sup-off', act: 'sOff' }),
    ], canEdit ? h.btn('+ เพิ่มผู้ขาย', { act: 'newSup', tone: 'primary' }) : '')}
      <div class="split"><div>${list}<p class="hint">${h.fmt.num(shown.length)} ผู้ขาย${canEdit ? '' : ` · เพิ่ม/แก้ผู้ขายได้เฉพาะ ${whoCan('supplier.manage')}`}</p></div><div>${detail}</div></div>`;
  }

  // ---- ราคาและหน่วยซื้อ (สินค้า–ผู้ขาย) -----------------------------------------------------------------------------
  function termFields(ctx, it, l, opts) {
    opts = opts || {};
    const unit = it ? it.baseUnit : 'หน่วยหลัก';
    return [
      opts.supplier ? h.field({ name: 'supplier', label: 'ผู้ขาย', type: 'select', value: opts.supplierValue, options: opts.supplier, required: true, blank: '— เลือกผู้ขาย —', id: opts.ids ? 'term-sup' : null }) : '',
      opts.code ? h.field({ name: 'code', label: 'รหัสสินค้า', list: 'dl-items', required: true, value: opts.codeValue, placeholder: 'พิมพ์หรือเลือกรหัส', id: opts.ids ? 'term-code' : null }) : '',
      h.field({ name: 'price', label: 'ราคาต่อหน่วยซื้อ (บาท)', type: 'number', value: l ? l.price : '', hint: 'ว่าง = ยังไม่ทราบราคา (ออก PO ต้องใส่ราคาเอง)', id: opts.ids ? 'term-price' : null }),
      h.field({ name: 'buyUnit', label: 'หน่วยซื้อ', value: l ? l.buyUnit : '', placeholder: unit, list: 'p4-units', hint: `ว่าง = ${unit}`, id: opts.ids ? 'term-unit' : null }),
      h.field({ name: 'factor', label: `1 หน่วยซื้อ = กี่ ${unit}`, type: 'number', value: l ? l.factor : '', id: opts.ids ? 'term-factor' : null,
        hint: 'ว่าง = ใช้ตัวคูณที่ตั้งไว้ในทะเบียนหน่วย (หน่วยหลัก = 1) · ระบบไม่เดาตัวคูณ' }),
      h.field({ name: 'moq', label: 'สั่งขั้นต่ำ MOQ (หน่วยซื้อ)', type: 'number', value: l && l.moq ? l.moq : '', id: opts.ids ? 'term-moq' : null }),
      h.field({ name: 'pack', label: 'แพ็กละ (หน่วยซื้อ) – สั่งเป็นทวีคูณ', type: 'number', value: l && l.pack ? l.pack : '', id: opts.ids ? 'term-pack' : null }),
      h.field({ name: 'leadDays', label: 'Lead time สินค้านี้ (วัน)', type: 'number', value: l ? l.leadDays : '', hint: 'ว่าง = ใช้ Lead time ของผู้ขาย', id: opts.ids ? 'term-lead' : null }),
      h.field({ name: 'preferred', label: 'ผู้ขายหลักของสินค้านี้', type: 'checkbox', value: l ? l.preferred : opts.firstLink, hint: 'แผนเติมสต็อกแนะนำสั่งจากผู้ขายหลัก (ได้รายเดียวต่อสินค้า)', id: opts.ids ? 'term-pref' : null }),
      l ? h.field({ name: 'active', label: 'ใช้งาน', type: 'checkbox', value: l.active !== false, hint: 'ปิดแล้วไม่ใช้ราคา/หน่วยนี้ตอนแนะนำและออก PO' }) : '',
    ];
  }
  function unitList(ctx, it) {
    const units = it ? [it.baseUnit].concat(RRS.q.rows(ctx.state, 'item_units', (u) => u.code === it.id).map((u) => u.unit)) : [];
    return t`<datalist id="p4-units">${units.map((u) => t`<option value="${u}"></option>`)}</datalist>`;
  }
  function termPayload(code, supplier, vals, keepActive) {
    const out = { code, supplier, price: vals.price, buyUnit: vals.buyUnit, factor: vals.factor, moq: vals.moq, pack: vals.pack,
      leadDays: vals.leadDays, preferred: !!vals.preferred };
    if (keepActive) out.active = vals.active !== false;
    return out;
  }

  function termRows(ctx) {
    const v = ctx.view;
    const byCode = {};
    for (const l of links(ctx.state)) (byCode[l.code] || (byCode[l.code] = [])).push(l);
    const sups = ctx.state.tables.suppliers || {};
    const q = low(v.tq).trim();
    const out = [];
    for (const it of RRS.q.rows(ctx.state, 'items', (i) => i.active !== false).sort((a, b) => a.id.localeCompare(b.id))) {
      const ls = (byCode[it.id] || []).filter((l) => l.active !== false && (sups[l.supplier] || {}).active !== false);
      if (v.tSup && !ls.some((l) => l.supplier === v.tSup)) continue;
      if (v.tNone && ls.length) continue;
      const pref = ls.find((l) => l.preferred) || (ls.length === 1 ? ls[0] : null);
      if (q && ![it.id, it.name, it.expressCode, it.group].concat(ls.map((l) => l.supplier), ls.map((l) => (sups[l.supplier] || {}).name)).some((x) => low(x).indexOf(q) >= 0)) continue;
      out.push({ it, ls, pref, prefSet: ls.some((l) => l.preferred) });
    }
    return out;
  }

  function itemTerms(ctx, it) {
    const canEdit = ctx.can('supplier.manage');
    const canRule = ctx.can('reorder.manage');
    const ls = P().itemSuppliers(ctx.state, it.id);
    const sups = ctx.state.tables.suppliers || {};
    const units = RRS.q.rows(ctx.state, 'item_units', (u) => u.code === it.id);
    const plan = planOf(ctx, it.id, '');
    const free = supOptions(ctx.state).filter(([id]) => !ls.some((l) => l.supplier === id));
    const tbl = h.table({
      rows: ls, dense: true, rowCls: (l) => (l.active === false ? 'muted' : ''),
      empty: 'ยังไม่มีผู้ขายของสินค้านี้', emptyText: canEdit ? 'เลือกผู้ขายแล้วกรอกราคาและหน่วยซื้อด้านล่าง' : `ฝ่ายจัดซื้อ (${whoCan('supplier.manage')}) เป็นผู้ตั้ง`,
      cols: [
        { label: 'ผู้ขาย', render: (l) => t`${h.code(l.supplier)} ${(sups[l.supplier] || {}).name || ''}${l.preferred ? t` ${h.badge('ผู้ขายหลัก', 'accent')}` : ''}${l.active === false ? t` ${h.badge('ปิดใช้งาน', 'muted')}` : ''}${(sups[l.supplier] || {}).active === false ? t` ${h.badge('ผู้ขายปิดใช้งาน', 'muted')}` : ''}` },
        { label: 'ราคา / หน่วยซื้อ', num: true, render: (l) => (has(l.price) ? t`${h.fmt.money(l.price)} / ${l.buyUnit}` : h.badge('ยังไม่มีราคา', 'warn')) },
        { label: 'หน่วยซื้อ', render: (l) => t`1 ${l.buyUnit} = ${h.qty(l.factor, it.baseUnit)}` },
        { label: 'MOQ', num: true, render: (l) => (l.moq ? `${h.fmt.num(l.moq)} ${l.buyUnit}` : dash) },
        { label: 'แพ็กละ', num: true, render: (l) => (l.pack ? `${h.fmt.num(l.pack)} ${l.buyUnit}` : dash) },
        { label: 'Lead time', render: (l) => (has(l.leadDays) ? `${h.fmt.num(l.leadDays)} วัน` : t`<span class="muted">ใช้ของผู้ขาย (${has((sups[l.supplier] || {}).leadDays) ? sups[l.supplier].leadDays + ' วัน' : '7 วัน'})</span>`) },
        { label: '', render: (l) => (canEdit ? t`<span class="form-actions">${h.btn('แก้', { act: 'editTerm', arg: l.supplier, tone: 'quiet', small: true })}${!l.preferred && l.active !== false && (sups[l.supplier] || {}).active !== false ? h.btn('ตั้งเป็นผู้ขายหลัก', { act: 'prefTerm', arg: l.supplier, tone: 'quiet', small: true }) : ''}</span>` : '') },
      ],
    });
    const add = !canEdit ? '' : !suppliers(ctx.state).length
      ? h.empty('ยังไม่มีผู้ขาย', 'เพิ่มผู้ขายที่แท็บ ผู้ขาย ก่อน แล้วกลับมาตั้งราคาและหน่วยซื้อ', h.btn('ไปแท็บผู้ขาย', { act: 'tab', arg: 'sup', tone: 'ghost', small: true }))
      : !free.length ? t`<p class="hint">ตั้งครบทุกผู้ขายที่ใช้งานแล้ว – กด แก้ ที่แถวเพื่อเปลี่ยนราคา/หน่วยซื้อ</p>`
        : t`<h3>เพิ่มผู้ขายของสินค้านี้</h3>${h.form({ name: 'addTerm', submit: 'บันทึกราคาและหน่วยซื้อ',
          body: termFields(ctx, it, null, { supplier: free, ids: true, firstLink: !ls.some((l) => l.active !== false) }) })}`;
    const rules = RRS.q.rows(ctx.state, 'reorder_rules', (r) => r.code === it.id).sort((a, b) => a.wh.localeCompare(b.wh));
    const ruleTbl = h.table({
      rows: rules, dense: true, rowAct: canRule ? 'editRule' : null, rowArg: (r) => r.code + '|' + r.wh,
      empty: 'ยังไม่ได้ตั้งเงื่อนไขเติมสต็อก', emptyText: 'ระบบใช้ Min/Max จากทะเบียนสินค้า หรือสถิติยอดใช้แทน',
      cols: ruleCols(ctx, false),
    });
    const facts = h.dl([
      ['หน่วยหลัก (เก็บยอด)', it.baseUnit],
      ['หน่วยอื่นที่ตั้งไว้', units.length ? units.map((u) => `1 ${u.unit} = ${h.fmt.num(u.factor)} ${it.baseUnit}`).join(' · ') : 'ไม่มี'],
      ['Min / Max ในทะเบียนสินค้า', Number(it.minQty) || Number(it.maxQty) ? `${h.fmt.num(it.minQty || 0)} / ${h.fmt.num(it.maxQty || 0)} ${it.baseUnit}` : 'ไม่ได้ตั้ง'],
      plan ? ['แผนเติมสต็อกใช้ผู้ขาย', plan.supplier ? `${plan.supplier} ${plan.supplierName || ''} (${plan.supplierFrom})` : plan.supplierFrom] : null,
      plan ? ['Lead time ที่ใช้', `${plan.leadDays} วัน (${plan.leadFrom})`] : null,
      plan ? ['Min / Max ที่ใช้', `${h.fmt.num(plan.min)} / ${h.fmt.num(plan.max)} ${it.baseUnit} (${plan.minMaxFrom})`] : null,
    ]);
    return t`${h.section(t`${h.code(it.id)} ${it.name}`, t`${facts}${unitList(ctx, it)}${tbl}${add}`, {
      id: 'term-detail', actions: h.btn('ปิด', { act: 'closeItem', tone: 'quiet', small: true }),
      sub: 'ราคาเป็นต่อหน่วยซื้อ · MOQ และแพ็กเป็นหน่วยซื้อ · แผนเติมสต็อกปัดจำนวนแนะนำเป็นหน่วยซื้อเต็ม ไม่น้อยกว่า MOQ และเป็นทวีคูณของแพ็ก' })}
      ${h.section('เงื่อนไขเติมสต็อกของสินค้านี้', ruleTbl, { actions: canRule ? h.btn('+ ตั้งเงื่อนไข', { act: 'newRule', arg: it.id, tone: 'ghost', small: true }) : '' })}`;
  }

  function termsTab(ctx) {
    const v = ctx.view;
    const itemsAll = RRS.q.rows(ctx.state, 'items', (i) => i.active !== false);
    if (!itemsAll.length) {
      return h.empty('ยังไม่มีสินค้า', 'ราคาและหน่วยซื้อตั้งรายสินค้า – เพิ่มสินค้าในทะเบียนสินค้าก่อน', h.link('ไปทะเบียนสินค้า', 'items'));
    }
    const rows = termRows(ctx);
    const limit = v.tLimit || LIMIT;
    const noneCount = termRows(Object.assign({}, ctx, { view: { tNone: true } })).length;
    const list = h.table({
      id: 'term-list', scroll: true, rows: rows.slice(0, limit), rowAct: 'pickItem', rowArg: (r) => r.it.id, rowCls: (r) => (r.it.id === v.item ? 'sel' : ''),
      empty: 'ไม่พบสินค้าตามตัวกรอง', emptyText: 'ลองคำค้นอื่น หรือล้างตัวกรองผู้ขาย',
      cols: [
        { label: 'รหัส', render: (r) => h.code(r.it.id) },
        { label: 'ชื่อสินค้า', render: (r) => t`${r.it.name}<br><small class="muted">หน่วยหลัก ${r.it.baseUnit}</small>` },
        { label: 'ผู้ขายหลัก', render: (r) => (r.pref ? t`${h.code(r.pref.supplier)}${r.prefSet ? '' : t` <small class="muted">(รายเดียว)</small>`}`
          : r.ls.length ? h.badge('ยังไม่เลือกผู้ขายหลัก', 'warn') : h.badge('ยังไม่มีผู้ขาย', 'warn')) },
        { label: 'ราคา / หน่วยซื้อ', num: true, render: (r) => (!r.pref ? dash : has(r.pref.price) ? t`${h.fmt.money(r.pref.price)} / ${r.pref.buyUnit}` : h.badge('ยังไม่มีราคา', 'warn')) },
        { label: 'ผู้ขาย', num: true, render: (r) => (r.ls.length ? h.fmt.num(r.ls.length) : dash) },
      ],
    });
    const more = rows.length > limit ? t`<p class="hint">แสดง ${h.fmt.num(limit)} จาก ${h.fmt.num(rows.length)} รายการ ${h.btn('แสดงเพิ่ม', { act: 'tMore', tone: 'ghost', small: true })}</p>`
      : t`<p class="hint">${h.fmt.num(rows.length)} รายการ · คลิกแถวเพื่อดู/ตั้งผู้ขาย ราคา หน่วยซื้อ</p>`;
    const sel = v.item && RRS.q.get(ctx.state, 'items', v.item);
    const detail = sel ? itemTerms(ctx, sel) : h.empty('เลือกสินค้าจากรายการ', 'ดูผู้ขายทุกรายของสินค้านั้น ราคา หน่วยซื้อ MOQ แพ็ก Lead time และเลือกผู้ขายหลัก');
    return t`${noneCount ? h.note(`มีสินค้า ${h.fmt.num(noneCount)} รายการที่ยังไม่มีผู้ขาย – แผนเติมสต็อกจะแนะนำเป็นหน่วยหลักโดยไม่มีราคา จนกว่าจะตั้งผู้ขาย`, 'warn') : ''}
      ${h.toolbar([
        h.field({ name: 'tq', label: 'ค้นหาสินค้า', value: v.tq, placeholder: 'รหัส ชื่อ ผู้ขาย…', id: 'term-q', act: 'tq', live: true }),
        h.field({ name: 'tSup', label: 'ผู้ขาย', type: 'select', value: v.tSup, options: supOptions(ctx.state), blank: 'ทุกผู้ขาย', id: 'term-supf', act: 'tSup' }),
        h.field({ name: 'tNone', label: 'เฉพาะที่ยังไม่มีผู้ขาย', type: 'checkbox', value: v.tNone, id: 'term-none', act: 'tNone' }),
      ], '')}
      <div class="split"><div>${list}${more}</div><div>${detail}</div></div>`;
  }

  // ---- เงื่อนไขเติมสต็อก ------------------------------------------------------------------------------------------
  function ruleCols(ctx, withItem) {
    const items = ctx.state.tables.items || {};
    const cols = [];
    if (withItem) cols.push({ label: 'สินค้า', render: (r) => t`${h.code(r.code)} ${(items[r.code] || {}).name || ''}` });
    cols.push(
      { label: 'คลัง', render: (r) => (r.wh ? h.code(r.wh) : t`<span class="muted">ทุกคลัง</span>`) },
      { label: 'Min / Max', num: true, render: (r) => (has(r.min) || has(r.max) ? `${has(r.min) ? h.fmt.num(r.min) : '–'} / ${has(r.max) ? h.fmt.num(r.max) : '–'} ${(items[r.code] || {}).baseUnit || ''}` : t`<span class="muted">ตามทะเบียน/สถิติ</span>`) },
      { label: 'Lead time', render: (r) => (has(r.leadDays) ? `${h.fmt.num(r.leadDays)} วัน` : t`<span class="muted">ตามผู้ขาย</span>`) },
      { label: 'ผู้ขาย', render: (r) => (r.supplier ? h.code(r.supplier) : t`<span class="muted">ผู้ขายหลัก</span>`) },
      { label: 'Max ครอบคลุม / สถิติ', render: (r) => `${has(r.coverDays) ? r.coverDays : P().DEFAULT_COVER} / ${has(r.usageDays) ? r.usageDays : P().DEFAULT_USAGE_DAYS} วัน` },
      { label: 'แนะนำสั่งซื้อ', render: (r) => (r.active === false ? h.badge('ปิด', 'muted') : h.badge('เปิด', 'ok')) },
    );
    return cols;
  }
  function rulesTab(ctx) {
    const v = ctx.view;
    const canRule = ctx.can('reorder.manage');
    const items = ctx.state.tables.items || {};
    const all = RRS.q.rows(ctx.state, 'reorder_rules');
    const q = low(v.rq).trim();
    const rows = all.filter((r) => (!v.rWh || (v.rWh === '__all' ? !r.wh : r.wh === v.rWh))
      && (!q || [r.code, (items[r.code] || {}).name, r.supplier].some((x) => low(x).indexOf(q) >= 0)))
      .sort((a, b) => a.code.localeCompare(b.code) || a.wh.localeCompare(b.wh));
    const explain = h.note(t`ช่องที่เว้นว่างใช้ค่าอื่นแทน: Min/Max จากทะเบียนสินค้า หรือสถิติยอดเบิก ${P().DEFAULT_USAGE_DAYS} วัน
      (Min = ใช้ต่อวัน × Lead time + ${P().Z} × SD × √Lead time · Max = Min + ใช้ต่อวัน × ${P().DEFAULT_COVER} วัน) · Lead time จากสินค้า–ผู้ขาย แล้วผู้ขาย แล้ว ${P().DEFAULT_LEAD} วัน ·
      เงื่อนไขของคลังใช้เมื่อดูแผนเติมสต็อกแยกคลังนั้น เงื่อนไข "ทุกคลัง" ใช้กับภาพรวม`, 'info');
    if (!all.length) {
      return t`${explain}${h.empty('ยังไม่ได้ตั้งเงื่อนไขเติมสต็อก', canRule
        ? 'ตั้งเมื่อต้องการ Min/Max, Lead time หรือผู้ขายต่างจากค่าปกติของสินค้า หรือปิดการแนะนำสั่งซื้อของบางรายการ'
        : `ผู้มีสิทธิ์ (${whoCan('reorder.manage')}) เป็นผู้ตั้ง – เงื่อนไขที่ตั้งแล้วจะขึ้นที่นี่`,
      canRule ? h.btn('+ ตั้งเงื่อนไขเติมสต็อก', { act: 'newRule', tone: 'primary' }) : '')}`;
    }
    const whOpts = [['__all', 'เฉพาะ "ทุกคลัง"']].concat(h.whOptions(ctx.state));
    const tbl = h.table({
      id: 'rule-list', scroll: true, rows, rowAct: canRule ? 'editRule' : null, rowArg: (r) => r.code + '|' + r.wh,
      rowCls: (r) => (r.active === false ? 'muted' : ''), empty: 'ไม่พบเงื่อนไขตามตัวกรอง', emptyText: 'ลองคำค้นอื่น หรือเลือกทุกคลัง',
      cols: ruleCols(ctx, true).concat([{ label: 'แก้ล่าสุด', render: (r) => t`<small class="muted">${ctx.userName(r.updatedBy)} · ${h.fmt.dt(r.updatedAt)}</small>` }]),
    });
    return t`${explain}${h.toolbar([
      h.field({ name: 'rq', label: 'ค้นหา', value: v.rq, placeholder: 'รหัส ชื่อ ผู้ขาย…', id: 'rule-q', act: 'rq', live: true }),
      h.field({ name: 'rWh', label: 'คลัง', type: 'select', value: v.rWh, options: whOpts, blank: 'ทุกเงื่อนไข', id: 'rule-wh', act: 'rWh' }),
    ], canRule ? h.btn('+ ตั้งเงื่อนไขเติมสต็อก', { act: 'newRule', tone: 'primary' }) : '')}
      ${tbl}<p class="hint">${h.fmt.num(rows.length)} เงื่อนไข${canRule ? ' · คลิกแถวเพื่อแก้' : ` · แก้ได้เฉพาะ ${whoCan('reorder.manage')}`}</p>`;
  }

  async function ruleDialog(ctx, rule, code) {
    const it = rule ? ctx.item(rule.code) : code ? ctx.item(code) : null;
    const plan = rule || it ? planOf(ctx, (rule || {}).code || it.id, rule ? rule.wh : '') : null;
    const r = rule || { active: true };
    const unit = it ? it.baseUnit : 'หน่วยหลัก';
    const now = plan ? t`<div class="wide">${h.note(t`ตอนนี้แผนเติมสต็อกใช้: Min ${h.fmt.num(plan.min)} / Max ${h.fmt.num(plan.max)} ${plan.baseUnit} (${plan.minMaxFrom}) · Lead time ${plan.leadDays} วัน (${plan.leadFrom})`, 'info')}</div>` : '';
    return ctx.dialog({
      title: rule ? `เงื่อนไขเติมสต็อก ${rule.code}${rule.wh ? ' คลัง ' + rule.wh : ' ทุกคลัง'}` : 'ตั้งเงื่อนไขเติมสต็อก', submit: 'บันทึกเงื่อนไข', wide: true,
      body: t`${now}
        ${rule || it ? t`<input type="hidden" name="code" value="${(rule || {}).code || it.id}">${h.field({ name: '_c', label: 'สินค้า', value: `${it ? it.id + ' ' + it.name : rule.code}`, readonly: true })}`
          : h.field({ name: 'code', label: 'รหัสสินค้า', list: 'dl-items', required: true, placeholder: 'พิมพ์หรือเลือกรหัส', id: 'rule-code' })}
        ${rule ? t`<input type="hidden" name="wh" value="${rule.wh}">${h.field({ name: '_w', label: 'คลัง', value: rule.wh ? `${rule.wh} · ${ctx.whName(rule.wh)}` : 'ทุกคลัง (ภาพรวมบริษัท)', readonly: true, hint: 'คลังแก้ไม่ได้ – ตั้งเงื่อนไขใหม่ของอีกคลังแทน' })}`
          : h.field({ name: 'wh', label: 'คลัง', type: 'select', options: h.whOptions(ctx.state), blank: 'ทุกคลัง (ภาพรวมบริษัท)', id: 'rule-wh-in' })}
        ${h.field({ name: 'min', label: `Min (${unit})`, type: 'number', value: r.min, hint: 'ว่าง = ใช้ทะเบียนสินค้า/สถิติ', id: 'rule-min' })}
        ${h.field({ name: 'max', label: `Max (${unit})`, type: 'number', value: r.max, hint: 'เติมขึ้นไปถึงค่านี้', id: 'rule-max' })}
        ${h.field({ name: 'leadDays', label: 'Lead time (วัน)', type: 'number', value: r.leadDays, hint: 'ว่าง = ใช้ของสินค้า–ผู้ขาย/ผู้ขาย', id: 'rule-lead' })}
        ${h.field({ name: 'supplier', label: 'ผู้ขายที่ใช้เติม', type: 'select', value: r.supplier, options: supOptions(ctx.state, r.supplier), blank: 'ผู้ขายหลักของสินค้า', id: 'rule-sup' })}
        ${h.field({ name: 'coverDays', label: 'Max ครอบคลุมเหนือ Min (วัน)', type: 'number', value: r.coverDays, hint: `ใช้เมื่อคิด Max จากสถิติ · ว่าง = ${P().DEFAULT_COVER}` })}
        ${h.field({ name: 'usageDays', label: 'ช่วงสถิติยอดใช้ (วัน)', type: 'number', value: r.usageDays, hint: `ว่าง = ${P().DEFAULT_USAGE_DAYS}` })}
        ${h.field({ name: 'active', label: 'เปิดการแนะนำสั่งซื้อ', type: 'checkbox', value: r.active !== false, hint: 'ปิด = แผนเติมสต็อกไม่แนะนำให้สั่งรายการนี้ (เช่น เลิกใช้/สั่งเฉพาะงาน)', wide: true, id: 'rule-active' })}`,
      onSubmit: (vals) => ctx.exec('reorder.set', { code: vals.code, wh: vals.wh || '', min: vals.min, max: vals.max, leadDays: vals.leadDays,
        supplier: vals.supplier || '', coverDays: vals.coverDays, usageDays: vals.usageDays, active: !!vals.active },
      { quiet: true, done: 'บันทึกเงื่อนไขเติมสต็อกแล้ว' }),
    });
  }

  RRS.ui.page({
    id: 'suppliers', title: 'ผู้ขายและเงื่อนไขซื้อ', phase: 4, order: 10,
    sub: 'ผู้ขาย ราคา หน่วยซื้อและตัวคูณ MOQ แพ็ก Lead time และเงื่อนไขเติมสต็อกของแต่ละสินค้า – แผนเติมสต็อกและใบสั่งซื้อใช้ค่าเหล่านี้ ระบบไม่เดาราคาหรือตัวคูณ',
    render(ctx) {
      if (!P()) return h.empty('ส่วนจัดซื้อยังไม่เปิดใช้', 'ระบบนี้ยังไม่ได้โหลดส่วนจัดซื้อ (Phase 4)');
      const v = ctx.view;
      const tab = ['sup', 'terms', 'rules'].indexOf(v.tab) >= 0 ? v.tab : 'sup';
      const nSup = RRS.q.rows(ctx.state, 'suppliers', (s) => s.active !== false).length;
      const nLink = RRS.q.rows(ctx.state, 'item_suppliers', (l) => l.active !== false).length;
      const nRule = RRS.q.rows(ctx.state, 'reorder_rules').length;
      const body = tab === 'terms' ? termsTab(ctx) : tab === 'rules' ? rulesTab(ctx) : supplierTab(ctx);
      return t`${h.tabs([{ id: 'sup', label: 'ผู้ขาย', count: nSup }, { id: 'terms', label: 'ราคาและหน่วยซื้อ', count: nLink }, { id: 'rules', label: 'เงื่อนไขเติมสต็อก', count: nRule }], tab)}${body}`;
    },
    after(ctx, root0) {
      const v = ctx.view;
      if (v._scroll) {
        v._scroll = false;
        const d = root0.querySelector('#term-detail');
        if (d && root.matchMedia && root.matchMedia('(max-width: 980px)').matches) setTimeout(() => d.scrollIntoView({ block: 'start' }), 0);
      }
    },
    actions: {
      tab: (ctx, el) => set(ctx, { tab: el.dataset.arg }),
      sq: live('sq'),
      sOff: (ctx, el) => set(ctx, { sOff: el.checked }),
      tq: live('tq', { tLimit: LIMIT }),
      tSup: (ctx, el) => set(ctx, { tSup: el.value, tLimit: LIMIT }),
      tNone: (ctx, el) => set(ctx, { tNone: el.checked, tLimit: LIMIT }),
      tMore: (ctx) => set(ctx, { tLimit: (ctx.view.tLimit || LIMIT) + LIMIT }),
      rq: live('rq'),
      rWh: (ctx, el) => set(ctx, { rWh: el.value }),
      pickSup: (ctx, el) => set(ctx, { sup: el.dataset.arg }),
      newSup: (ctx) => set(ctx, { tab: 'sup', sup: '__new' }),
      close: (ctx) => set(ctx, { sup: null }),
      pickItem: (ctx, el) => set(ctx, { item: el.dataset.arg, _scroll: true }),
      closeItem: (ctx) => set(ctx, { item: null }),
      toItem: (ctx, el) => set(ctx, { tab: 'terms', item: el.dataset.arg, tq: '', tSup: '', tNone: false, _scroll: true }),
      async termForSup(ctx, el) {
        const sup = RRS.q.get(ctx.state, 'suppliers', el.dataset.arg);
        if (!sup) return;
        const done = await ctx.dialog({
          title: `ตั้งราคาสินค้าของ ${sup.id} ${sup.name}`, submit: 'บันทึกราคาและหน่วยซื้อ', wide: true,
          body: t`${termFields(ctx, null, null, { code: true })}<p class="hint wide">หน่วยซื้อและตัวคูณต้องตรงกับที่ผู้ขายขายจริง เช่น กล่อง (1 กล่อง = 100 ตัว)</p>`,
          onSubmit: (vals) => ctx.exec('itemSupplier.upsert', termPayload(vals.code, sup.id, vals), { quiet: true, done: 'บันทึกราคาและหน่วยซื้อแล้ว' }),
        });
        if (done && done.ok) set(ctx, {});
      },
      async editTerm(ctx, el) {
        const it = ctx.item(ctx.view.item);
        const l = it && RRS.q.get(ctx.state, 'item_suppliers', it.id + '|' + el.dataset.arg);
        if (!l) return;
        await ctx.dialog({
          title: `${it.id} กับผู้ขาย ${l.supplier} ${supName(ctx.state, l.supplier)}`, submit: 'บันทึกการแก้ไข', wide: true,
          body: t`${unitList(ctx, it)}${termFields(ctx, it, l, {})}`,
          onSubmit: (vals) => ctx.exec('itemSupplier.upsert', termPayload(it.id, l.supplier, vals, true), { quiet: true, done: 'บันทึกราคาและหน่วยซื้อแล้ว' }),
        });
      },
      async prefTerm(ctx, el) {
        const it = ctx.item(ctx.view.item);
        if (!it) return;
        await ctx.exec('itemSupplier.upsert', { code: it.id, supplier: el.dataset.arg, preferred: true }, { done: `ตั้ง ${el.dataset.arg} เป็นผู้ขายหลักของ ${it.id} แล้ว` });
      },
      newRule: (ctx, el) => ruleDialog(ctx, null, el.dataset.arg || null),
      editRule(ctx, el) {
        const rule = RRS.q.get(ctx.state, 'reorder_rules', el.dataset.arg);
        if (rule) return ruleDialog(ctx, rule);
      },
    },
    forms: {
      async saveSup(ctx, vals) {
        const id = U.normCode(vals.id);
        const prev = id && RRS.q.get(ctx.state, 'suppliers', id);
        if (ctx.view.sup === '__new' && prev) {
          return ctx.toast(`ผู้ขาย ${id} มีอยู่แล้ว (${prev.name}) – เลือกจากรายการเพื่อแก้ไข หรือใช้รหัสอื่น ยังไม่ได้บันทึก`, 'bad');
        }
        const r = await ctx.exec('supplier.upsert', { id: vals.id, name: vals.name, taxId: vals.taxId, contact: vals.contact, phone: vals.phone,
          leadDays: vals.leadDays, active: !!vals.active }, { done: prev ? 'บันทึกการแก้ไขผู้ขายแล้ว' : `เพิ่มผู้ขาย ${id} แล้ว` });
        if (r.ok) set(ctx, { sup: r.result.id || id });
      },
      async addTerm(ctx, vals, form) {
        const it = ctx.item(ctx.view.item);
        if (!it) return;
        if (!vals.supplier) return ctx.toast('เลือกผู้ขายก่อนกด บันทึก', 'bad');
        const r = await ctx.exec('itemSupplier.upsert', termPayload(it.id, vals.supplier, vals), { done: `ตั้ง ${it.id} กับผู้ขาย ${vals.supplier} แล้ว` });
        if (r.ok && form) form.reset();
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
