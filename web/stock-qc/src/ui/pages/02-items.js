/* Phase 0 – item register: codes (main / Express / stock count), units with factors, tracking and QC flags. */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const M = RRS.master;

  const ALIASES = {
    code: ['รหัสสินค้า', 'รหัส', 'code', 'item code'], name: ['ชื่อสินค้า', 'ชื่อ', 'name', 'รายละเอียด'],
    baseUnit: ['หน่วยหลัก', 'หน่วย', 'unit'], type: ['ประเภท', 'type'], group: ['กลุ่ม', 'กลุ่มประกอบ', 'group'],
    expressCode: ['รหัสexpress', 'express code', 'express'], countCode: ['รหัสนับสต็อก', 'รหัสนับสต๊อค', 'count code'],
    model: ['รุ่น', 'รุ่นรถ', 'model'], side: ['ข้าง', 'side'], drawingNo: ['เลขที่แบบ', 'drawing'], drawingRev: ['ฉบับแบบ', 'rev'],
    trackLot: ['ติดตาม', 'track'], material: ['วัสดุ', 'material'], thickness: ['ความหนา', 'thickness'],
    width: ['กว้าง', 'width'], length: ['ยาว', 'length'], minQty: ['min'], maxQty: ['max'], unitCost: ['ราคาต่อหน่วย', 'cost'],
    qcIncoming: ['ตรวจรับ', 'qc incoming'], qcFinal: ['ตรวจเมื่อผลิตเสร็จ', 'qc final'], certRequired: ['ใบรับรอง', 'cert'],
  };
  const TEMPLATE = 'รหัสสินค้า,ชื่อสินค้า,หน่วยหลัก,ประเภท,กลุ่ม,รหัส Express,รหัสนับสต็อก,ติดตาม,ตรวจรับ,ตรวจเมื่อผลิตเสร็จ,Min,Max\n' +
    'DEMO-A-001,ตัวอย่าง ฝาข้าง ซ้าย,ชิ้น,PART,ฝาข้าง,,01-0001,none,,1,2,6';

  function itemForm(ctx, it) {
    const v = it || { type: 'PART', trackLot: 'none', active: true };
    const lock = !!it;
    return h.form({
      name: 'save', submit: it ? 'บันทึกการแก้ไข' : 'เพิ่มสินค้า', cancel: 'close',
      body: [
        h.field({ name: 'code', label: 'รหัสสินค้า (หลัก)', value: v.id, required: true, readonly: lock, hint: lock ? 'รหัสหลักแก้ไม่ได้ – ถ้าผิดให้ปิดใช้งานแล้วเพิ่มใหม่' : 'ระบบไม่ยอมให้รหัสที่อ่านแล้วซ้ำกับรหัสอื่น' }),
        h.field({ name: 'name', label: 'ชื่อสินค้า', value: v.name, required: true, wide: true }),
        h.field({ name: 'type', label: 'ประเภท', type: 'select', value: v.type, options: Object.entries(M.ITEM_TYPES), blank: false }),
        h.field({ name: 'baseUnit', label: 'หน่วยหลัก (เก็บยอด)', value: v.baseUnit, required: true }),
        h.field({ name: 'group', label: 'กลุ่ม / กลุ่มประกอบ', value: v.group }),
        h.field({ name: 'expressCode', label: 'รหัส Express', value: v.expressCode }),
        h.field({ name: 'countCode', label: 'รหัสนับสต็อก', value: v.countCode }),
        h.field({ name: 'model', label: 'รุ่นรถ/รุ่นกระบะ', value: v.model }),
        h.field({ name: 'side', label: 'ข้าง', type: 'select', value: v.side, options: [['L', 'ซ้าย (L)'], ['R', 'ขวา (R)']], blank: 'ไม่มีข้าง' }),
        h.field({ name: 'drawingNo', label: 'เลขที่แบบ', value: v.drawingNo }),
        h.field({ name: 'drawingRev', label: 'ฉบับแบบที่อนุมัติ', value: v.drawingRev, hint: 'อนุมัติ BOM แล้วระบบตั้งให้' }),
        h.field({ name: 'trackLot', label: 'ติดตามล็อต', type: 'select', value: v.trackLot, options: Object.entries(M.TRACK), blank: false }),
        h.field({ name: 'material', label: 'วัสดุ', value: v.material }),
        h.field({ name: 'thickness', label: 'ความหนา (มม.)', type: 'number', value: v.thickness || '' }),
        h.field({ name: 'width', label: 'กว้าง (มม.)', type: 'number', value: v.width || '' }),
        h.field({ name: 'length', label: 'ยาว (มม.)', type: 'number', value: v.length || '' }),
        h.field({ name: 'minQty', label: 'Min', type: 'number', value: v.minQty || '' }),
        h.field({ name: 'maxQty', label: 'Max', type: 'number', value: v.maxQty || '' }),
        h.field({ name: 'unitCost', label: 'ราคาต่อหน่วย (อ้างอิง)', type: 'number', value: v.unitCost || '', hint: 'มูลค่าจริงยึดบัญชี/Express' }),
        h.field({ name: 'qcIncoming', label: 'ต้องตรวจรับ (เข้ายอดรอตรวจ)', type: 'checkbox', value: v.qcIncoming }),
        h.field({ name: 'qcFinal', label: 'ต้องตรวจเมื่อผลิตเสร็จ', type: 'checkbox', value: v.qcFinal }),
        h.field({ name: 'certRequired', label: 'ต้องมีใบรับรองวัสดุ', type: 'checkbox', value: v.certRequired }),
        h.field({ name: 'active', label: 'ใช้งาน', type: 'checkbox', value: v.active !== false }),
        h.field({ name: 'remark', label: 'หมายเหตุ', value: v.remark, wide: true }),
      ],
    });
  }

  RRS.ui.page({
    id: 'items', title: 'ทะเบียนสินค้า', phase: 0, order: 20,
    sub: 'รหัสหลัก รหัส Express รหัสนับสต็อก หน่วยและตัวคูณ รุ่น/ข้าง ฉบับแบบ การติดตามล็อต และการตรวจ QC ของแต่ละรายการ',
    render(ctx) {
      const v = ctx.view;
      const q = (v.q || '').toLowerCase();
      const sum = RRS.inventory.summary(ctx.state);
      const rows = RRS.q.rows(ctx.state, 'items')
        .filter((i) => (!v.type || i.type === v.type) && (v.inactive || i.active !== false)
          && (!q || [i.id, i.name, i.expressCode, i.countCode, i.group, i.model].some((x) => String(x || '').toLowerCase().indexOf(q) >= 0)))
        .sort((a, b) => a.id.localeCompare(b.id));
      const canEdit = ctx.can('master.edit');
      const sel = v.sel === '__new' ? null : v.sel && RRS.q.get(ctx.state, 'items', v.sel);
      const list = h.table({
        rows, rowAct: 'pick', rowArg: (r) => r.id, rowCls: (r) => (r.id === v.sel ? 'sel' : r.active === false ? 'muted' : ''),
        empty: 'ยังไม่มีสินค้า', emptyText: canEdit ? 'กด เพิ่มสินค้า หรือ นำเข้าจากไฟล์ CSV' : 'ผู้มีสิทธิ์แก้ข้อมูลหลักเป็นผู้เพิ่มรายการ',
        cols: [
          { label: 'รหัส', render: (r) => h.code(r.id) },
          { label: 'ชื่อสินค้า', key: 'name' },
          { label: 'ประเภท', get: (r) => M.ITEM_TYPES[r.type] || r.type },
          { label: 'หน่วย', key: 'baseUnit' },
          { label: 'Express / นับสต็อก', render: (r) => t`${r.expressCode ? h.code(r.expressCode) : ''} ${r.countCode ? h.code(r.countCode) : ''}` },
          { label: 'ควบคุม', render: (r) => t`${r.trackLot !== 'none' ? h.badge(M.TRACK[r.trackLot], 'accent') : ''} ${r.qcIncoming ? h.badge('ตรวจรับ', 'warn') : ''} ${r.qcFinal ? h.badge('ตรวจผลิต', 'warn') : ''} ${r.side ? h.badge(r.side, 'muted') : ''}` },
          { label: 'คงเหลือรวม', num: true, get: (r) => (sum[r.id] ? sum[r.id].total : 0) },
        ],
      });
      let detail = '';
      if (v.sel === '__new') detail = h.section('เพิ่มสินค้า', itemForm(ctx, null));
      else if (sel) {
        const units = RRS.q.rows(ctx.state, 'item_units', (u) => u.code === sel.id);
        const locs = RRS.inventory.locations(ctx.state, { code: sel.id });
        detail = t`${h.section(t`${h.code(sel.id)} ${sel.name}`, canEdit ? itemForm(ctx, sel) : h.dl([
          ['ประเภท', M.ITEM_TYPES[sel.type]], ['หน่วยหลัก', sel.baseUnit], ['รหัส Express', sel.expressCode], ['รหัสนับสต็อก', sel.countCode],
          ['รุ่น/ข้าง', [sel.model, sel.side].filter(Boolean).join(' · ')], ['แบบ/ฉบับ', [sel.drawingNo, sel.drawingRev].filter(Boolean).join(' rev ')],
          ['ติดตาม', M.TRACK[sel.trackLot]], ['Min / Max', `${sel.minQty || 0} / ${sel.maxQty || 0}`]]))}
          ${h.section('หน่วยและตัวคูณ', t`${h.table({ rows: units, empty: 'ใช้หน่วยหลักอย่างเดียว', emptyText: `1 ${sel.baseUnit} = 1 ${sel.baseUnit}`,
            cols: [{ label: 'หน่วย', key: 'unit' }, { label: 'เท่ากับ', render: (u) => h.qty(u.factor, sel.baseUnit) },
              { label: '', render: (u) => (canEdit ? h.btn('ลบ', { act: 'delUnit', arg: u.unit, tone: 'quiet', small: true }) : '') }] })}
            ${canEdit ? h.form({ name: 'unit', submit: 'เพิ่มหน่วย', body: [h.field({ name: 'unit', label: 'หน่วย เช่น โหล, กก., ผน', required: true }),
              h.field({ name: 'factor', label: `1 หน่วยนี้ = กี่ ${sel.baseUnit}`, type: 'number', required: true })] }) : ''}`)}
          ${h.section('ยอดตามตำแหน่ง', h.table({ rows: locs, empty: 'ไม่มียอด', dense: true,
            cols: [{ label: 'คลัง', key: 'wh' }, { label: 'ช่องเก็บ', key: 'bin' }, { label: 'สถานะ', render: (b) => h.statusBadge(b.status) },
              { label: 'ล็อต', key: 'lot' }, { label: 'จำนวน', num: true, key: 'qty' }] }), { actions: h.link('ดูประวัติ', 'history', { code: sel.id }) })}`;
      }
      return t`${h.toolbar([
        h.field({ name: 'q', label: 'ค้นหา', value: v.q, placeholder: 'รหัส ชื่อ รหัส Express กลุ่ม…', id: 'items-q' }),
        h.field({ name: 'type', label: 'ประเภท', type: 'select', value: v.type, options: Object.entries(M.ITEM_TYPES), blank: 'ทุกประเภท', id: 'items-type' }),
        h.field({ name: 'inactive', label: 'แสดงที่ปิดใช้งาน', type: 'checkbox', value: v.inactive, id: 'items-inactive' }),
      ], canEdit ? [h.btn('นำเข้า CSV', { act: 'import', tone: 'ghost' }), h.btn('+ เพิ่มสินค้า', { act: 'new', tone: 'primary' })] : '')}
        <div class="split"><div>${list}<p class="hint">${rows.length} รายการ</p></div><div>${detail || h.empty('เลือกสินค้าจากรายการ', 'ดู/แก้ข้อมูล หน่วย และยอดตามตำแหน่ง')}</div></div>`;
    },
    after(ctx, root0) {
      // filters apply as you type
      const q = root0.querySelector('#items-q');
      if (q) q.addEventListener('input', () => { ctx.view.q = q.value; clearTimeout(ctx.view._t); ctx.view._t = setTimeout(() => ctx.set({}), 250); });
      for (const id of ['items-type', 'items-inactive']) {
        const el = root0.querySelector('#' + id);
        if (el) el.addEventListener('change', () => ctx.set(id === 'items-type' ? { type: el.value } : { inactive: el.checked }));
      }
      if (q && ctx.view.q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    },
    actions: {
      pick: (ctx, el) => ctx.set({ sel: el.dataset.arg }),
      new: (ctx) => ctx.set({ sel: '__new' }),
      close: (ctx) => ctx.set({ sel: null }),
      async delUnit(ctx, el) {
        await ctx.exec('item.unit', { code: ctx.view.sel, unit: el.dataset.arg, remove: true }, { done: 'ลบหน่วยแล้ว' });
      },
      async import(ctx) {
        const pasted = await ctx.dialog({
          title: 'นำเข้าสินค้าจากไฟล์', submit: 'ตรวจและนำเข้า', wide: true,
          body: t`<p class="hint wide">วางข้อมูลจาก Excel/CSV (แถวแรกเป็นหัวตาราง) หรือเลือกไฟล์ ระบบนำเข้าทั้งหมดหรือไม่นำเข้าเลยถ้ามีแถวผิด</p>
            ${h.field({ name: 'file', label: 'ไฟล์ (.csv .xlsx)', type: 'file', accept: '.csv,.txt,.tsv,.xlsx,.xls', wide: true, id: 'imp-file' })}
            ${h.field({ name: 'text', label: 'หรือวางข้อมูล (ตัวอย่างหัวตารางด้านล่าง)', type: 'textarea', rows: 8, wide: true, placeholder: TEMPLATE, id: 'imp-text' })}`,
          async onSubmit(values, form) {
            let rows;
            const f = form.querySelector('#imp-file').files[0];
            if (f) rows = (await h.readTable(f)).rows;
            else rows = h.parseCsv(values.text);
            if (rows.length < 2) return { ok: false, errors: [{ message: 'ไม่พบแถวข้อมูล' }] };
            const map = h.mapHeader(rows[0], ALIASES);
            if (map.code == null || map.name == null) return { ok: false, errors: [{ message: 'ต้องมีคอลัมน์ รหัสสินค้า และ ชื่อสินค้า' }] };
            const items = rows.slice(1).map((r) => {
              const o = {};
              for (const k in map) o[k] = r[map[k]];
              for (const b of ['qcIncoming', 'qcFinal', 'certRequired']) if (o[b] != null) o[b] = ['1', 'y', 'yes', 'ใช่', 'true', '✓'].indexOf(String(o[b]).trim().toLowerCase()) >= 0;
              return o;
            });
            return ctx.exec('master.import', { items }, { quiet: true, done: (r) => `นำเข้า ${r.result.rows} รายการแล้ว` });
          },
        });
        if (pasted && pasted.ok) ctx.toast(`นำเข้า ${pasted.result.rows} รายการแล้ว`, 'ok');
      },
    },
    forms: {
      async save(ctx, v) {
        const r = await ctx.exec('item.upsert', v, { done: 'บันทึกสินค้าแล้ว' });
        if (r.ok) ctx.set({ sel: RRS.util.normCode(v.code) });
      },
      async unit(ctx, v) {
        await ctx.exec('item.unit', { code: ctx.view.sel, unit: v.unit, factor: v.factor }, { done: 'เพิ่มหน่วยแล้ว' });
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
