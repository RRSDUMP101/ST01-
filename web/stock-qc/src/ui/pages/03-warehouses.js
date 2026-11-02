/*
 * Phase 0 – warehouses and bins (ช่องเก็บ). Warehouse editor (warehouse.upsert), bins of the selected warehouse
 * (bin.upsert, deactivate), bulk add by pasting "A-01 ชั้น 1" lines or CSV (master.import: all rows or none),
 * and the bin codes laid out as stock tags.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const U = RRS.util;

  const BIN_ALIASES = { wh: ['คลัง', 'รหัสคลัง', 'wh', 'warehouse'], code: ['ช่องเก็บ', 'รหัสช่อง', 'รหัสช่องเก็บ', 'bin', 'code', 'location'],
    name: ['คำอธิบาย', 'ชื่อ', 'รายละเอียด', 'name', 'description'] };

  /** Bin codes: letters (A-Z, Thai), digits and - _ . / – no spaces, so a pasted "A-01 ชั้น 1" splits cleanly. */
  const BIN_RE = /^[A-Z0-9\u0E00-\u0E7F][A-Z0-9\u0E00-\u0E7F._/-]*$/;
  const badBin = (code) => `รหัสช่องเก็บ "${code}" ใช้ได้เฉพาะตัวอักษร ตัวเลข และ - _ . / (ไม่มีเว้นวรรค) เช่น A-01, P-POST-04`;
  const LIMIT = 40; // bins and tags shown before "show all" (long lists stay usable on a phone)

  /** One CSV cell: quoted when needed; text a spreadsheet would run as a formula is kept as text. */
  function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+@\t\r]/.test(s) || /^-[^\d.]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /** Checkbox with its hint under the label (the kit field puts the hint beside it and squeezes the box). */
  const checkbox = (o) => t`<label class="fld fld-check${o.wide ? ' wide' : ''}"><span><input type="checkbox" name="${o.name}" value="1"${h.safe(o.value ? ' checked' : '')}></span><span>${o.label}${o.hint ? t`<br><small class="hint">${o.hint}</small>` : ''}</span></label>`;

  /**
   * Pasted text -> [{wh?, code, name, row}]. Lines "A-01 ชั้น 1" (code, a space, then the description) or CSV/TSV
   * (code,description or with a header row naming the columns). Rows without a code are kept (code '') so the
   * person is told about them instead of losing them silently.
   */
  function parseBins(text) {
    const src = String(text || '').replace(/^\ufeff/, '').trim();
    if (!src) return [];
    const first = src.split(/\r?\n/, 1)[0];
    const split = (cell) => /^\s*(\S*)\s*(.*)$/.exec(String(cell || ''));
    let out;
    if (/[,\t;]/.test(first)) {
      const rows = h.parseCsv(src);
      const map = h.mapHeader(rows[0] || [], BIN_ALIASES);
      if (map.code != null) {
        out = rows.slice(1).map((r, i) => ({ wh: map.wh != null ? r[map.wh] : '', code: r[map.code], name: map.name != null ? r[map.name] : '', row: i + 2 }));
      } else {
        out = rows.map((r, i) => {
          const m = split(r[0]); // "A-01 ชั้น 1,ฝั่งซ้าย" -> A-01 / ชั้น 1 ฝั่งซ้าย
          return { code: m[1], name: [m[2]].concat(r.slice(1)).filter((x) => U.trim(x)).join(' '), row: i + 1 };
        });
      }
    } else {
      out = src.split(/\r?\n/).map((l, i) => {
        if (!U.trim(l)) return null;
        const m = split(l);
        return { code: m[1], name: m[2], row: i + 1 };
      }).filter(Boolean);
    }
    return out.map((r) => ({ wh: U.normCode(r.wh), code: U.normCode(r.code), name: U.trim(r.name), row: r.row }));
  }

  function whForm(ctx, w) {
    const v = w || { requireBin: false, active: true };
    return h.form({
      name: 'saveWh', submit: w ? 'บันทึกการแก้ไขคลัง' : 'เพิ่มคลัง', cancel: w ? null : 'close',
      body: [
        h.field({ name: 'code', label: 'รหัสคลัง', value: v.code, required: true, readonly: !!w,
          hint: w ? 'รหัสคลังแก้ไม่ได้ – ถ้าผิดให้ปิดใช้งานแล้วเพิ่มใหม่' : 'ใช้ A-Z 0-9 - _ เช่น 01, MAIN, P-POST' }),
        h.field({ name: 'name', label: 'ชื่อคลัง', value: v.name, required: true }),
        h.field({ name: 'expressCode', label: 'รหัสคลังใน Express', value: v.expressCode, hint: 'ใช้จับคู่ไฟล์ Express กับคลังนี้ (ข้อตกลง ค-3)' }),
        checkbox({ name: 'requireBin', label: 'ต้องระบุช่องเก็บทุกครั้ง', value: v.requireBin,
          hint: 'เปิด: เอกสารที่ไม่ใส่ช่องเก็บของคลังนี้บันทึกไม่ได้' }),
        checkbox({ name: 'active', label: 'ใช้งาน', value: v.active !== false, hint: 'ปิดได้เมื่อไม่มียอดคงเหลือ' }),
      ],
    });
  }

  function stockIn(state, wh, bin) {
    const f = { wh };
    if (bin != null) f.bin = bin;
    return RRS.q.qty(state, f);
  }

  RRS.ui.page({
    id: 'warehouses', title: 'คลังและช่องเก็บ', phase: 0, order: 15,
    sub: 'ยอดคงเหลือเก็บตามคลัง + ช่องเก็บ · จับคู่รหัสคลังกับ Express · ช่องเก็บที่มีของปิดใช้งานไม่ได้',
    render(ctx) {
      const v = ctx.view;
      const q = (v.q || '').toLowerCase();
      const canEdit = ctx.can('master.edit');
      const all = RRS.q.rows(ctx.state, 'warehouses').sort((a, b) => a.code.localeCompare(b.code));
      const binsAll = RRS.q.rows(ctx.state, 'bins');
      const whs = all.filter((w) => (v.inactive || w.active !== false)
        && (!q || [w.code, w.name, w.expressCode].some((x) => String(x || '').toLowerCase().indexOf(q) >= 0)));
      const list = h.table({
        rows: whs, rowAct: 'pick', rowArg: (w) => w.code, rowCls: (w) => (w.code === v.sel ? 'sel' : w.active === false ? 'muted' : ''),
        empty: all.length ? 'ไม่พบคลังตามที่ค้น' : 'ยังไม่มีคลัง',
        emptyText: all.length ? 'ลองคำค้นอื่น หรือติ๊ก แสดงที่ปิดใช้งาน' : canEdit ? 'กด + เพิ่มคลัง เช่น 01 คลังหลัก แล้วเพิ่มช่องเก็บของคลังนั้น' : 'ผู้มีสิทธิ์แก้ข้อมูลหลัก (หัวหน้าสโตร์/วิศวกรรม) เป็นผู้เพิ่มคลัง',
        cols: [
          { label: 'รหัส', render: (w) => h.code(w.code) },
          { label: 'ชื่อคลัง', render: (w) => t`${w.name}${w.active === false ? t` ${h.badge('ปิดใช้งาน', 'muted')}` : ''}` },
          { label: 'Express', render: (w) => (w.expressCode ? h.code(w.expressCode) : t`<span class="muted">ยังไม่จับคู่</span>`) },
          { label: 'ช่องเก็บ', num: true, get: (w) => binsAll.filter((b) => b.wh === w.code && b.active !== false).length },
          { label: 'ต้องระบุช่อง', render: (w) => (w.requireBin ? h.badge('ต้องระบุ', 'accent') : t`<span class="muted">ไม่บังคับ</span>`) },
          { label: 'ยอดรวม (ทุกหน่วย)', num: true, get: (w) => stockIn(ctx.state, w.code) },
        ],
      });

      let detail = h.empty(all.length ? 'เลือกคลังจากรายการ' : 'เริ่มจากเพิ่มคลังแรก', all.length ? 'ดู/แก้ข้อมูลคลัง ช่องเก็บ และป้ายช่องเก็บ' : 'คลังคือที่เก็บของจริง เช่น คลังหลัก คลังวัตถุดิบ คลังสำเร็จรูป',
        canEdit && !all.length ? h.btn('+ เพิ่มคลัง', { act: 'new', tone: 'primary' }) : '');
      const sel = v.sel && v.sel !== '__new' ? RRS.q.get(ctx.state, 'warehouses', v.sel) : null;
      if (v.sel === '__new' && canEdit) detail = h.section('เพิ่มคลัง', whForm(ctx, null));
      else if (sel) {
        const bins = binsAll.filter((b) => b.wh === sel.code).sort((a, b) => a.code.localeCompare(b.code));
        const binsOn = bins.filter((b) => b.active !== false);
        const shownBins = v.binsOff ? bins : binsOn;
        const cut = !v.binsAll && shownBins.length > LIMIT;
        const binTbl = h.table({
          rows: cut ? shownBins.slice(0, LIMIT) : shownBins, dense: true, rowCls: (b) => (b.active === false ? 'muted' : ''),
          empty: 'ยังไม่มีช่องเก็บ', emptyText: canEdit ? 'เพิ่มทีละช่องด้านล่าง หรือกด วางหลายช่อง เพื่อวางรายการจาก Excel' : 'ผู้มีสิทธิ์แก้ข้อมูลหลักเป็นผู้เพิ่มช่องเก็บ',
          cols: [
            { label: 'ช่องเก็บ', render: (b) => t`${h.code(b.code)}${b.active === false ? t` ${h.badge('ปิดใช้งาน', 'muted')}` : ''}` },
            { label: 'คำอธิบาย', key: 'name' },
            { label: 'ยอดรวม', num: true, get: (b) => stockIn(ctx.state, sel.code, b.code) },
            { label: '', render: (b) => (canEdit ? t`${h.btn('แก้', { act: 'editBin', arg: b.code, tone: 'quiet', small: true })}${b.active === false
              ? h.btn('เปิดใช้งาน', { act: 'binOn', arg: b.code, tone: 'quiet', small: true })
              : h.btn('ปิดใช้งาน', { act: 'binOff', arg: b.code, tone: 'quiet', small: true, title: stockIn(ctx.state, sel.code, b.code) ? 'ช่องนี้ยังมีของ – ย้ายหรือปรับยอดเป็น 0 ก่อน' : null })}` : '') },
          ],
        });
        const addBin = canEdit ? h.form({ name: 'addBin', submit: 'เพิ่มช่องเก็บ', extra: h.btn('วางหลายช่อง', { act: 'bulk', tone: 'ghost' }), body: [
          h.field({ name: 'code', label: 'รหัสช่องเก็บ', required: true, placeholder: 'เช่น A-01, P-POST-04' }),
          h.field({ name: 'name', label: 'คำอธิบาย', placeholder: 'เช่น ชั้น 1 ฝั่งซ้าย' }),
        ] }) : '';
        const tagCut = !v.binsAll && binsOn.length > LIMIT;
        const tags = binsOn.length ? t`<div class="steps">${(tagCut ? binsOn.slice(0, LIMIT) : binsOn).map((b) => t`<div class="step"><span class="step-n">คลัง ${sel.code} · ${sel.name}</span><span><span class="tag">${b.code}</span></span>${b.name ? t`<span class="hint">${b.name}</span>` : ''}</div>`)}</div>`
          : h.empty('ยังไม่มีป้าย', 'ป้ายจะขึ้นเมื่อมีช่องเก็บที่ใช้งาน');
        const showAll = (n) => t`<p class="hint">แสดง ${LIMIT} จาก ${h.fmt.num(n)} ช่อง ${h.btn(`แสดงทั้งหมด ${h.fmt.num(n)} ช่อง`, { act: 'binsAll', tone: 'quiet', small: true })}</p>`;
        detail = t`${h.section(t`${h.code(sel.code)} ${sel.name}`, canEdit ? whForm(ctx, sel) : h.dl([
          ['รหัสคลังใน Express', sel.expressCode || 'ยังไม่จับคู่'], ['ต้องระบุช่องเก็บ', sel.requireBin ? 'ต้องระบุทุกครั้ง' : 'ไม่บังคับ'],
          ['สถานะ', sel.active === false ? 'ปิดใช้งาน' : 'ใช้งาน'], ['ยอดรวม', h.fmt.num(stockIn(ctx.state, sel.code))]]))}
          ${h.section(`ช่องเก็บ (${binsOn.length})`, t`${binTbl}${cut ? showAll(shownBins.length) : ''}${bins.length !== binsOn.length ? t`<p class="hint">${h.btn(v.binsOff ? 'ซ่อนช่องที่ปิดใช้งาน' : `แสดงช่องที่ปิดใช้งาน (${bins.length - binsOn.length})`, { act: 'toggleOff', tone: 'quiet', small: true })}</p>` : ''}${addBin}`,
            { sub: sel.requireBin ? 'คลังนี้ต้องระบุช่องเก็บในทุกเอกสาร' : 'ไม่ใส่ช่องเก็บได้ (ยอดจะอยู่ที่คลังโดยไม่ระบุช่อง)' })}
          ${h.section('ป้ายช่องเก็บ', t`${tags}${tagCut ? showAll(binsOn.length) : ''}`, { sub: 'รหัสช่องเก็บแบบป้ายติดชั้น ใช้ทำป้ายจริงหรือดาวน์โหลดรายการไปพิมพ์จากโปรแกรมอื่น',
            actions: binsOn.length ? h.btn('ดาวน์โหลดรายการป้าย (CSV)', { act: 'tagsCsv', tone: 'ghost', small: true }) : '' })}`;
      }
      if (!all.length && v.sel !== '__new') {
        return h.empty('ยังไม่มีคลัง', canEdit ? 'คลังคือที่เก็บของจริง เช่น 01 คลังหลัก, RM คลังวัตถุดิบ – เพิ่มคลังแรก แล้วเพิ่มช่องเก็บของคลังนั้น (ยอดคงเหลือเก็บตามคลัง + ช่องเก็บ)'
          : 'ผู้มีสิทธิ์แก้ข้อมูลหลัก (หัวหน้าสโตร์/วิศวกรรม) เป็นผู้เพิ่มคลัง – เมื่อเพิ่มแล้วรายการคลังและช่องเก็บจะขึ้นที่นี่',
        canEdit ? h.btn('+ เพิ่มคลังแรก', { act: 'new', tone: 'primary' }) : '');
      }
      return t`${h.toolbar([
        h.field({ name: 'q', label: 'ค้นหาคลัง', value: v.q, placeholder: 'รหัส ชื่อ รหัส Express…', id: 'wh-q' }),
        h.field({ name: 'inactive', label: 'แสดงที่ปิดใช้งาน', type: 'checkbox', value: v.inactive, id: 'wh-inactive' }),
      ], canEdit ? h.btn('+ เพิ่มคลัง', { act: 'new', tone: 'primary' }) : '')}
        <div class="split"><div>${list}<p class="hint">${whs.length} คลัง · ${binsAll.filter((b) => b.active !== false).length} ช่องเก็บที่ใช้งาน</p></div><div>${detail}</div></div>`;
    },
    after(ctx, root0) {
      const q = root0.querySelector('#wh-q');
      if (q) {
        q.addEventListener('input', () => { ctx.view.q = q.value; clearTimeout(ctx.view._t); ctx.view._t = setTimeout(() => ctx.set({ _refocus: true }), 250); });
        if (ctx.view._refocus) { ctx.view._refocus = false; q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      }
      const off = root0.querySelector('#wh-inactive');
      if (off) off.addEventListener('change', () => ctx.set({ inactive: off.checked }));
    },
    actions: {
      pick: (ctx, el) => ctx.set({ sel: el.dataset.arg, binsOff: false, binsAll: false }),
      binsAll: (ctx) => ctx.set({ binsAll: true }),
      new: (ctx) => ctx.set({ sel: '__new' }),
      close: (ctx) => ctx.set({ sel: null }),
      toggleOff: (ctx) => ctx.set({ binsOff: !ctx.view.binsOff }),
      async editBin(ctx, el) {
        const wh = ctx.view.sel;
        const b = RRS.q.get(ctx.state, 'bins', wh + '|' + el.dataset.arg);
        if (!b) return;
        await ctx.dialog({ title: `ช่องเก็บ ${wh}/${b.code}`, submit: 'บันทึก',
          body: t`${h.field({ name: 'code', label: 'รหัสช่องเก็บ', value: b.code, readonly: true, hint: 'รหัสแก้ไม่ได้ – ถ้าผิดให้ปิดใช้งานแล้วเพิ่มใหม่' })}
            ${h.field({ name: 'name', label: 'คำอธิบาย', value: b.name })}`,
          onSubmit: (vv) => ctx.exec('bin.upsert', { wh, code: b.code, name: vv.name, active: b.active !== false }, { quiet: true, done: 'บันทึกช่องเก็บแล้ว' }) });
      },
      async binOff(ctx, el) {
        const wh = ctx.view.sel;
        const b = RRS.q.get(ctx.state, 'bins', wh + '|' + el.dataset.arg);
        if (!b) return;
        const left = stockIn(ctx.state, wh, b.code);
        if (left) return ctx.toast(`ช่อง ${b.code} ยังมีของ ${h.fmt.num(left)} – โอนย้ายหรือปรับยอดเป็น 0 ก่อนปิดใช้งาน`, 'bad');
        const ok = await ctx.confirm({ title: `ปิดใช้งานช่อง ${b.code}`, message: 'ช่องนี้จะเลือกในเอกสารใหม่ไม่ได้ ประวัติเดิมยังอยู่ และเปิดใช้งานกลับได้', ok: 'ปิดใช้งาน' });
        if (!ok) return;
        await ctx.exec('bin.upsert', { wh, code: b.code, name: b.name, active: false }, { done: `ปิดใช้งานช่อง ${b.code} แล้ว` });
      },
      async binOn(ctx, el) {
        const wh = ctx.view.sel;
        const b = RRS.q.get(ctx.state, 'bins', wh + '|' + el.dataset.arg);
        if (b) await ctx.exec('bin.upsert', { wh, code: b.code, name: b.name, active: true }, { done: `เปิดใช้งานช่อง ${b.code} แล้ว` });
      },
      async bulk(ctx) {
        const wh = ctx.view.sel;
        await ctx.dialog({ title: `วางช่องเก็บหลายช่อง – คลัง ${wh}`, submit: 'ตรวจและเพิ่มทั้งหมด', wide: true,
          body: t`<p class="hint wide">หนึ่งบรรทัดต่อหนึ่งช่อง: รหัสช่อง เว้นวรรค แล้วคำอธิบาย หรือวางจาก Excel/CSV (คอลัมน์ ช่องเก็บ, คำอธิบาย) ·
            ระบบเพิ่มทั้งหมดหรือไม่เพิ่มเลยถ้ามีแถวผิด · ช่องที่มีอยู่แล้วจะแก้คำอธิบายตามที่วาง</p>
            ${h.field({ name: 'text', label: 'รายการช่องเก็บ', type: 'textarea', rows: 10, wide: true, placeholder: 'A-01 ชั้น 1\nA-02 ชั้น 2\nP-POST-04 เสาที่ 4', id: 'bulk-text' })}`,
          onSubmit: async (vv) => {
            const list = parseBins(vv.text);
            if (!list.length) return { ok: false, errors: [{ message: 'ยังไม่มีรายการ – วางรหัสช่องเก็บอย่างน้อย 1 บรรทัด' }] };
            const seen = {};
            const errs = [];
            for (const b of list) {
              if (!b.code) { errs.push({ message: `แถว ${b.row}: ไม่มีรหัสช่องเก็บ – ใส่รหัสหรือลบแถวนี้` }); continue; }
              if (!BIN_RE.test(b.code)) { errs.push({ message: `แถว ${b.row}: ${badBin(b.code)}` }); continue; }
              const k = (b.wh || wh) + '|' + b.code;
              if (seen[k]) errs.push({ message: `แถว ${b.row}: ${b.code} ซ้ำกับแถว ${seen[k]}` });
              else seen[k] = b.row;
            }
            if (errs.length) return { ok: false, errors: errs.slice(0, 12).concat(errs.length > 12 ? [{ message: `… และอีก ${errs.length - 12} แถว – ยังไม่ได้เพิ่มช่องใดเลย` }] : []) };
            const existing = list.filter((b) => RRS.q.get(ctx.state, 'bins', (b.wh || wh) + '|' + b.code)).length;
            const r = await ctx.exec('master.import', { bins: list.map((b) => ({ wh: b.wh || wh, code: b.code, name: b.name })) }, { quiet: true,
              done: `เพิ่มช่องเก็บ ${list.length - existing} ช่อง${existing ? ` · แก้คำอธิบาย ${existing} ช่อง` : ''}` });
            if (!r.ok) r.errors = r.errors.map((e) => Object.assign({}, e, { message: e.row ? `แถว ${list[e.row - 1] ? list[e.row - 1].row : e.row}: ${e.message}` : e.message }));
            return r;
          } });
      },
      async tagsCsv(ctx) {
        const wh = ctx.view.sel;
        const w = RRS.q.get(ctx.state, 'warehouses', wh);
        const cell = csvCell;
        const lines = ['คลัง,ชื่อคลัง,ช่องเก็บ,คำอธิบาย'].concat(RRS.q.rows(ctx.state, 'bins', (b) => b.wh === wh && b.active !== false)
          .sort((a, b) => a.code.localeCompare(b.code)).map((b) => [wh, w ? w.name : '', b.code, b.name || ''].map(cell).join(',')));
        await ctx.download(`ป้ายช่องเก็บ-${wh}.csv`, '\ufeff' + lines.join('\r\n') + '\r\n');
      },
    },
    forms: {
      async saveWh(ctx, vals) {
        const code = U.normCode(vals.code);
        const prev = code && RRS.q.get(ctx.state, 'warehouses', code);
        if (ctx.view.sel === '__new' && prev) {
          return ctx.toast(`คลัง ${code} มีอยู่แล้ว (${prev.name}) – เลือกคลังนั้นจากรายการเพื่อแก้ไข หรือใช้รหัสอื่น ยังไม่ได้บันทึก`, 'bad');
        }
        const r = await ctx.exec('warehouse.upsert', vals, { done: prev ? 'บันทึกการแก้ไขคลังแล้ว' : `เพิ่มคลัง ${code} แล้ว` });
        if (r.ok) ctx.set({ sel: U.normCode(vals.code) });
      },
      async addBin(ctx, vals, form) {
        const wh = ctx.view.sel;
        const code = U.normCode(vals.code);
        if (!code) return ctx.toast('กรอกรหัสช่องเก็บก่อนกด เพิ่มช่องเก็บ', 'bad');
        if (!BIN_RE.test(code)) return ctx.toast(badBin(code), 'bad');
        if (RRS.q.get(ctx.state, 'bins', wh + '|' + code)) return ctx.toast(`ช่อง ${code} มีอยู่แล้วในคลัง ${wh} – กด แก้ ที่แถวนั้นเพื่อเปลี่ยนคำอธิบาย`, 'bad');
        const r = await ctx.exec('bin.upsert', { wh, code, name: vals.name, active: true }, { done: `เพิ่มช่อง ${code} แล้ว` });
        if (r.ok && form) form.reset();
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
