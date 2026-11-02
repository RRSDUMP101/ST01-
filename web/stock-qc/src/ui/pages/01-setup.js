/*
 * Phase 0 – scope, data ownership, policies, the business decisions ค-1 … ค-11 and the baseline KPIs.
 * Commands: settings.update {patch}, decision.record, kpi.record. People without the permission see a read-only view.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const M = RRS.master;

  function settingsOf(state) {
    const d = RRS.defaultSettings();
    const s = RRS.q.get(state, 'settings', 'main') || {};
    return Object.assign({}, d, s, {
      pilot: Object.assign({}, d.pilot, s.pilot), ownership: Object.assign({}, d.ownership, s.ownership),
      policies: Object.assign({}, d.policies, s.policies), express: Object.assign({}, d.express, s.express),
    });
  }
  const whoCan = (perm) => RRS.auth.rolesFor(perm).map((r) => RRS.auth.ROLES[r] || r).join(', ');
  const readOnly = (perm) => h.note(`ดูอย่างเดียว – แก้ได้โดย: ${whoCan(perm)}`, 'info');

  // cutoffAt is kept as an ISO time; the form shows Bangkok time (UTC+7, no daylight saving)
  const toInput = (iso) => {
    const ms = Date.parse(iso);
    return isFinite(ms) ? new Date(ms + 7 * 3600e3).toISOString().slice(0, 16) : '';
  };
  const fromInput = (v) => {
    if (!v) return '';
    const ms = Date.parse(`${v}:00+07:00`);
    return isFinite(ms) ? new Date(ms).toISOString() : '';
  };

  // ---- data ownership ----------------------------------------------------------------------------------------
  const OWNERSHIP = [
    { key: 'qty', label: 'ยอดจำนวนตามคลัง/ช่องเก็บ', choices: {
      RRS: 'ยอดที่บันทึกในระบบนี้เป็นยอดจริง ไฟล์ Express ใช้กระทบยอดเท่านั้น ไม่เขียนทับ ผลต่างต้องมีคนตรวจและปรับยอดด้วยเอกสาร',
      Express: 'ยอดใน Express เป็นยอดจริง ผลนับและผลต่างจากไฟล์ Express กลายเป็นใบปรับยอดในระบบนี้ให้ตรงกับ Express (การปรับยอดมาจาก Express)' } },
    { key: 'cost', label: 'ต้นทุนและมูลค่าสต็อก', choices: {
      RRS: 'ใช้ราคาต่อหน่วยในทะเบียนสินค้าคิดมูลค่าในรายงานของระบบนี้',
      Express: 'มูลค่าและต้นทุนยึด Express/บัญชี ราคาในระบบนี้เป็นราคาอ้างอิงเท่านั้น ไม่ใช้ปิดบัญชี' } },
    { key: 'accountingDocs', label: 'เอกสารทางบัญชี (รับ จ่าย ปรับยอด)', choices: {
      RRS: 'เอกสารในระบบนี้เป็นเอกสารหลัก ไม่ต้องคีย์ซ้ำใน Express',
      Express: 'ทุกเอกสารที่มีคู่ใน Express ต้องคีย์ใน Express แล้วบันทึกเลขที่กลับมา – จะขึ้นในรายการ รอคีย์ Express จนกว่าจะใส่เลขที่' } },
    { key: 'qc', label: 'ผลตรวจคุณภาพและสถานะของ', choices: {
      RRS: 'ผลตรวจ ปล่อยผ่าน และกักกัน บันทึกในระบบนี้ และเปลี่ยนสถานะของในคลังทันที (ของรอตรวจเบิกไม่ได้)',
      Express: 'ผลตรวจเก็บที่อื่น ระบบนี้บันทึกเพียงสถานะของตามที่แจ้งมา' } },
  ];

  // ---- policies ---------------------------------------------------------------------------------------------
  function policyForm(ctx, st) {
    const p = st.policies;
    const whs = h.whOptions(ctx.state);
    const dw = st.express.defaultWarehouse;
    if (dw && !whs.some(([c]) => c === dw)) whs.unshift([dw, `${dw} (ยังไม่มีคลังนี้ในระบบ)`]);
    return h.form({ name: 'policies', submit: 'บันทึกนโยบาย', body: [
      h.field({ name: 'negativeStock', label: 'เมื่อยอดไม่พอ', type: 'select', blank: false, value: p.negativeStock,
        options: [['block', 'บล็อก – บันทึกไม่ได้เลย'], ['approve', 'ขออนุมัติข้อยกเว้นได้']],
        hint: 'บล็อก: เอกสารที่ทำให้ยอดติดลบบันทึกไม่ได้ · ขออนุมัติ: ผู้ทำส่งขอพร้อมเหตุผล หัวหน้าสโตร์/บัญชีอีกคนอนุมัติ' }),
      h.field({ name: 'sod', label: 'แยกหน้าที่ – คนทำรายการอนุมัติงานของตัวเองไม่ได้', type: 'checkbox', value: p.sod !== false,
        hint: 'ใช้กับข้อยกเว้นยอดติดลบ ผลนับ ใบขอซื้อ การปล่อยผ่าน QC และ NCR' }),
      h.field({ name: 'overReceivePct', label: 'รับเกิน PO ได้ไม่เกิน (%)', type: 'number', value: p.overReceivePct,
        hint: 'รับเกินกว่านี้ต้องให้หัวหน้าจัดซื้ออนุมัติ · 0 = รับเกินไม่ได้' }),
      h.field({ name: 'recountPct', label: 'นับซ้ำเมื่อผลต่างเกิน (%)', type: 'number', value: p.recountPct,
        hint: 'ผลนับต่างจากยอดในระบบเกินกี่ % ต้องนับซ้ำก่อนอนุมัติ' }),
      h.field({ name: 'recountQty', label: 'หรือผลต่างเกิน (หน่วย)', type: 'number', value: p.recountQty,
        hint: 'ผลต่างเกินกี่หน่วยต้องนับซ้ำ แม้ % จะน้อย' }),
      h.field({ name: 'countMode', label: 'ระหว่างตรวจนับ', type: 'select', blank: false, value: p.countMode,
        options: [['timestamp', 'ทำรายการได้ตามปกติ (ปรับตามเวลานับ)'], ['freeze', 'หยุดรับ–จ่ายช่องที่กำลังนับ']],
        hint: 'ปรับตามเวลานับ: ระบบคิดผลต่างจากยอด ณ เวลาที่นับแต่ละบรรทัด · หยุด: ช่องที่นับรับ–จ่ายไม่ได้จนอนุมัติผลนับ' }),
      h.field({ name: 'lateIsUncertain', label: 'PO เลยกำหนดส่ง ไม่นับเป็นของเข้าแน่นอน', type: 'checkbox', value: p.lateIsUncertain !== false,
        hint: 'การวางแผนจะแยกของจาก PO ที่เลยกำหนดออกเป็น "ไม่แน่นอน"' }),
      h.field({ name: 'nonMovingDays', label: 'ของไม่เคลื่อนไหวเมื่อเกิน (วัน)', type: 'number', value: p.nonMovingDays,
        hint: 'ของที่ไม่มีรับ–จ่ายนานกว่านี้แสดงในรายงานของค้างนาน' }),
      h.field({ name: 'defaultWarehouse', label: 'คลังเริ่มต้นของเอกสารและไฟล์ Express', type: 'select', value: dw, options: whs, blank: '— ไม่ตั้ง —',
        hint: 'ใส่ให้อัตโนมัติในเอกสารใหม่ และใช้กับแถวในไฟล์ Express ที่ไม่ระบุคลัง' }),
    ] });
  }
  function policyView(ctx, st) {
    const p = st.policies;
    return h.dl([
      ['เมื่อยอดไม่พอ', p.negativeStock === 'approve' ? 'ขออนุมัติข้อยกเว้นได้ (อีกคนอนุมัติ)' : 'บล็อก – บันทึกไม่ได้'],
      ['แยกหน้าที่', p.sod !== false ? 'เปิด – อนุมัติงานตัวเองไม่ได้' : 'ปิด'],
      ['รับเกิน PO ได้', `${h.fmt.num(p.overReceivePct)}%`],
      ['นับซ้ำเมื่อต่างเกิน', `${h.fmt.num(p.recountPct)}% หรือ ${h.fmt.num(p.recountQty)} หน่วย`],
      ['ระหว่างตรวจนับ', p.countMode === 'freeze' ? 'หยุดรับ–จ่ายช่องที่นับ' : 'ทำรายการได้ (ปรับตามเวลานับ)'],
      ['PO เลยกำหนด', p.lateIsUncertain !== false ? 'ไม่นับเป็นของเข้าแน่นอน' : 'นับเป็นของเข้า'],
      ['ของไม่เคลื่อนไหว', `เกิน ${h.fmt.num(p.nonMovingDays)} วัน`],
      ['คลังเริ่มต้น', st.express.defaultWarehouse ? `${st.express.defaultWarehouse} ${ctx.whName(st.express.defaultWarehouse) !== st.express.defaultWarehouse ? ctx.whName(st.express.defaultWarehouse) : ''}` : ''],
    ]);
  }

  // ---- scope -------------------------------------------------------------------------------------------------
  function knownGroups(state, st) {
    const g = new Set(st.pilot.groups || []);
    for (const it of RRS.q.rows(state, 'items')) if (it.group) g.add(it.group);
    return Array.from(g).sort((a, b) => a.localeCompare(b, 'th'));
  }
  function scopeSummary(ctx, st) {
    const groups = st.pilot.groups || [];
    const whs = st.pilot.warehouses || [];
    const items = RRS.q.rows(ctx.state, 'items', (i) => i.active !== false && groups.indexOf(i.group) >= 0).length;
    return h.dl([
      ['บริษัท/หน่วยงาน', st.company],
      ['กลุ่มชิ้นส่วนที่ทดลอง', groups.length ? groups.join(', ') : 'ยังไม่เลือก'],
      ['สินค้าในกลุ่มทดลอง', groups.length ? `${h.fmt.num(items)} รายการ` : ''],
      ['คลังที่ทดลอง', whs.length ? whs.map((w) => `${w} ${ctx.whName(w) !== w ? ctx.whName(w) : ''}`.trim()).join(', ') : 'ยังไม่เลือก'],
      ['เวลาตัดยอดตั้งต้น', st.cutoffAt ? `${h.fmt.dt(st.cutoffAt)} (เวลาไทย)` : 'ยังไม่กำหนด'],
      ['หมายเหตุ', st.pilot.note],
    ]);
  }
  function scopeForm(ctx, st) {
    const whs = h.whOptions(ctx.state);
    for (const w of st.pilot.warehouses || []) if (!whs.some(([c]) => c === w)) whs.push([w, `${w} (ไม่พบในระบบ)`]);
    const groups = knownGroups(ctx.state, st);
    return h.form({ name: 'scope', submit: 'บันทึกขอบเขต', body: [
      h.field({ name: 'company', label: 'ชื่อบริษัท/หน่วยงาน', value: st.company }),
      h.field({ name: 'cutoffAt', label: 'เวลาตัดยอดตั้งต้น (เวลาไทย)', type: 'datetime', value: toInput(st.cutoffAt),
        hint: 'ยอดตั้งต้นของกลุ่มทดลองนับ ณ เวลานี้ แล้วบันทึกเป็นใบปรับยอด' }),
      whs.length ? h.field({ name: 'pilotWh', label: 'คลังที่ใช้ทดลอง', type: 'multiselect', options: whs, value: st.pilot.warehouses, wide: true })
        : t`<p class="hint wide">ยังไม่มีคลัง – เพิ่มในหน้า ${h.link('คลังและช่องเก็บ', 'warehouses')} ก่อน แล้วกลับมาเลือก</p>`,
      groups.length ? h.field({ name: 'pilotGroups', label: 'กลุ่มชิ้นส่วนที่ใช้ทดลอง (จากทะเบียนสินค้า)', type: 'multiselect', options: groups, value: st.pilot.groups, wide: true }) : '',
      h.field({ name: 'moreGroups', label: groups.length ? 'เพิ่มกลุ่มอื่น (คั่นด้วยจุลภาค)' : 'กลุ่มชิ้นส่วนที่ใช้ทดลอง (คั่นด้วยจุลภาค)', wide: true,
        placeholder: 'เช่น ฝาข้าง, พื้นกระบะ', hint: 'ชื่อกลุ่มต้องตรงกับช่อง กลุ่ม ในทะเบียนสินค้า' }),
      h.field({ name: 'note', label: 'หมายเหตุขอบเขต', type: 'textarea', value: st.pilot.note, wide: true,
        placeholder: 'เช่น ทดลองกลุ่มฝาข้างในคลังหลัก 1 เดือน ผู้ตรวจรับ … แผนกู้คืน …' }),
    ] });
  }

  // ---- ownership -------------------------------------------------------------------------------------------
  function ownershipBlock(ctx, st, canEdit) {
    const cards = OWNERSHIP.map((o) => {
      const cur = st.ownership[o.key] === 'Express' ? 'Express' : 'RRS';
      const choices = ['RRS', 'Express'].map((c) => (canEdit
        ? t`<label class="chk"><input type="radio" name="${o.key}" value="${c}"${h.safe(cur === c ? ' checked' : '')}> <span><b>${c === 'RRS' ? 'ระบบนี้ (RRS)' : 'Express'}</b> – ${o.choices[c]}</span></label>`
        : ''));
      return t`<div class="wide step"><h3>${o.label}</h3>
        ${canEdit ? t`<div class="radios">${choices}</div>` : t`<p>${h.badge(cur === 'RRS' ? 'ระบบนี้ (RRS)' : 'Express', 'accent')} ${o.choices[cur]}</p>`}</div>`;
    });
    const body = t`${cards}`;
    if (!canEdit) return t`<div class="fgrid">${body}</div>`;
    return h.form({ name: 'ownership', submit: 'บันทึกเจ้าของข้อมูล', body });
  }

  // ---- decisions -------------------------------------------------------------------------------------------
  function decisionsBlock(ctx) {
    const v = ctx.view;
    const recs = {};
    for (const d of RRS.q.rows(ctx.state, 'decisions')) recs[d.id] = d;
    const decided = M.QUESTIONS.filter((q) => recs[q.id] && recs[q.id].status === 'decided').length;
    const total = M.QUESTIONS.length;
    const canEdit = ctx.can('decision.record');
    const f = v.dq || 'all';
    const list = M.QUESTIONS.filter((q) => {
      const done = recs[q.id] && recs[q.id].status === 'decided';
      return f === 'all' || (f === 'open' && !done) || (f === 'decided' && done);
    });
    const cards = list.map((q) => {
      const r = recs[q.id] || {};
      const done = r.status === 'decided';
      return h.section(t`${q.no} ${q.title}`, t`
        ${h.dl([['ทำไมต้องตัดสิน', q.why], ['ข้อเสนอเริ่มต้น', q.proposal], ['ผู้ร่วมตัดสิน', q.who]])}
        ${done ? h.note(t`<b>ข้อสรุป:</b> ${r.answer}<br><span class="muted">ตัดสินโดย ${r.decidedBy} · ${h.fmt.date(r.decidedOn)}${r.recordedBy ? ` · บันทึกโดย ${ctx.userName(r.recordedBy)}` : ''}</span>`, 'ok')
          : h.note('ยังไม่มีข้อสรุป', 'warn')}`, {
        actions: t`${done ? h.badge('ตัดสินแล้ว', 'ok') : h.badge('รอตัดสิน', 'warn')}
          ${canEdit ? h.btn(done ? 'แก้ข้อสรุป' : 'บันทึกข้อสรุป', { act: 'decide', arg: q.id, tone: done ? 'ghost' : 'primary', small: true }) : ''}
          ${canEdit && done ? h.btn('เปิดคำถามอีกครั้ง', { act: 'reopen', arg: q.id, tone: 'quiet', small: true }) : ''}`,
      });
    });
    const pct = Math.round((decided / total) * 100);
    return t`${h.kpis([h.kpi('ตัดสินแล้ว', `${decided}/${total}`, `${pct}%`, decided === total ? 'ok' : 'info'), h.kpi('ยังไม่ตัดสิน', String(total - decided), 'ต้องมีข้อสรุปก่อนใช้จริง', total - decided ? 'warn' : 'ok')])}
      <div class="bar-meter" role="img" aria-label="ตัดสินแล้ว ${decided} จาก ${total}"><span style="width:${h.safe(String(pct))}%"></span></div>
      ${canEdit ? '' : readOnly('decision.record')}
      ${h.tabs([{ id: 'all', label: 'ทั้งหมด', count: total }, { id: 'open', label: 'ยังไม่ตัดสิน', count: total - decided }, { id: 'decided', label: 'ตัดสินแล้ว', count: decided }], f, 'dq')}
      ${list.length ? t`<div class="cols">${cards}</div>` : h.empty(f === 'open' ? 'ตัดสินครบทุกข้อแล้ว' : 'ยังไม่มีข้อที่ตัดสิน', f === 'open' ? 'แก้ข้อสรุปได้ที่แท็บ ตัดสินแล้ว' : 'กด บันทึกข้อสรุป ที่แต่ละข้อในแท็บ ยังไม่ตัดสิน')}`;
  }

  // ---- KPIs ---------------------------------------------------------------------------------------------------
  function kpiBlock(ctx) {
    const canEdit = ctx.can('kpi.record');
    const order = M.KPI_DEFAULTS.map((k) => k.id);
    const list = RRS.q.rows(ctx.state, 'kpis').sort((a, b) => {
      const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || String(a.label).localeCompare(String(b.label), 'th');
    });
    const val = (n, unit) => (n == null || n === '' ? t`<span class="muted">ยังไม่วัด</span>` : h.qty(n, unit));
    const tbl = h.table({ rows: list, empty: 'ยังไม่มีตัวชี้วัด', emptyText: canEdit ? 'กด + เพิ่มตัวชี้วัด เพื่อตั้งค่าก่อนเริ่มและเป้าหมาย' : 'ผู้มีสิทธิ์บันทึกตัวชี้วัดจะเพิ่มรายการ',
      cols: [
        { label: 'ตัวชี้วัด', key: 'label' },
        { label: 'ค่าก่อนเริ่ม', render: (k) => val(k.baseline, k.unit) },
        { label: 'เป้าหมาย', render: (k) => val(k.target, k.unit) },
        { label: 'วันที่วัด', get: (k) => (k.measuredOn ? h.fmt.date(k.measuredOn) : '–') },
        { label: 'วิธีวัด/หมายเหตุ', key: 'note' },
        { label: '', render: (k) => (canEdit ? h.btn('บันทึกค่า', { act: 'kpi', arg: k.id, tone: 'ghost', small: true }) : '') },
      ] });
    const missing = list.filter((k) => k.baseline == null).length;
    return t`${canEdit ? '' : readOnly('kpi.record')}
      ${missing ? h.note(`ยังไม่มีค่าก่อนเริ่ม ${missing} ตัว – วัดไว้ก่อนใช้ระบบ เพื่อเทียบผลหลังทดลอง`, 'warn') : list.length ? h.note('มีค่าก่อนเริ่มครบทุกตัวชี้วัดแล้ว', 'ok') : ''}
      ${tbl}${canEdit ? t`<div class="form-actions">${h.btn('+ เพิ่มตัวชี้วัด', { act: 'kpi', arg: '', tone: 'ghost' })}</div>` : ''}`;
  }

  const TABS = [
    { id: 'scope', label: 'ขอบเขตทดลอง' }, { id: 'owner', label: 'เจ้าของข้อมูล' }, { id: 'policy', label: 'นโยบาย' },
    { id: 'decisions', label: 'ข้อตกลง ค-1…ค-11' }, { id: 'kpis', label: 'ตัวชี้วัดตั้งต้น' },
  ];

  RRS.ui.page({
    id: 'setup', title: 'ขอบเขต นโยบาย และข้อตกลง', phase: 0, order: 10,
    sub: 'ตกลงสิ่งที่ระบบต้องรู้ก่อนเริ่ม: ทดลองกลุ่มไหน คลังไหน ใครเป็นเจ้าของยอด กติกาเมื่อยอดไม่พอ และคำถามที่ต้องตัดสิน',
    badge: (ctx) => (ctx.can('decision.record') ? M.QUESTIONS.length - RRS.q.rows(ctx.state, 'decisions', (d) => d.status === 'decided').length || '' : ''),
    render(ctx) {
      const v = ctx.view;
      const tab = TABS.some((x) => x.id === v.tab) ? v.tab : 'scope';
      const st = settingsOf(ctx.state);
      const canSet = ctx.can('settings.edit');
      const decided = RRS.q.rows(ctx.state, 'decisions', (d) => d.status === 'decided').length;
      const tabs = TABS.map((x) => (x.id === 'decisions' ? Object.assign({}, x, { count: `${decided}/${M.QUESTIONS.length}` }) : x));
      let body;
      if (tab === 'scope') {
        body = h.section('ขอบเขตทดลอง', canSet ? t`${scopeForm(ctx, st)}` : t`${readOnly('settings.edit')}${scopeSummary(ctx, st)}`,
          { sub: 'เริ่มเล็ก: กลุ่มชิ้นส่วนหนึ่งกลุ่มในคลังเดียว แล้วค่อยขยาย (ข้อตกลง ค-8)' });
        if (canSet) body = t`${body}${h.section('ที่บันทึกไว้ตอนนี้', scopeSummary(ctx, st))}`;
      } else if (tab === 'owner') {
        body = h.section('ระบบไหนเป็นเจ้าของข้อมูลแต่ละชนิด', t`${canSet ? '' : readOnly('settings.edit')}${ownershipBlock(ctx, st, canSet)}`,
          { sub: 'ตอบข้อตกลง ค-1 – ถ้าไม่ตกลงให้ชัด การนำเข้าไฟล์ Express อาจทับยอดที่บันทึกในระบบนี้' });
      } else if (tab === 'policy') {
        body = h.section('นโยบายการบันทึก', canSet ? policyForm(ctx, st) : t`${readOnly('settings.edit')}${policyView(ctx, st)}`,
          { sub: 'ระบบตรวจตามนโยบายนี้ทุกครั้งที่บันทึก – แก้แล้วมีผลกับรายการถัดไปทันที' });
      } else if (tab === 'decisions') {
        body = decisionsBlock(ctx);
      } else {
        body = h.section('ตัวชี้วัดค่าตั้งต้น', kpiBlock(ctx), { sub: 'วัดค่าก่อนเริ่มใช้ระบบและตั้งเป้าหมาย เพื่อดูว่าการทดลองได้ผลจริงหรือไม่' });
      }
      return t`${h.tabs(tabs, tab)}${body}`;
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg }),
      dq: (ctx, el) => ctx.set({ dq: el.dataset.arg }),
      async decide(ctx, el) {
        const q = M.QUESTIONS.find((x) => x.id === el.dataset.arg);
        if (!q) return;
        const r = RRS.q.get(ctx.state, 'decisions', q.id) || {};
        ctx.view.proposal = q.proposal;
        await ctx.dialog({ title: `${q.no} บันทึกข้อสรุป`, submit: 'บันทึกข้อสรุป', wide: true,
          body: t`<p class="wide">${q.title}</p>
            <p class="hint wide">ข้อเสนอเริ่มต้น: ${q.proposal} ${h.btn('ใช้ข้อเสนอนี้เป็นข้อสรุป', { act: 'useProposal', tone: 'quiet', small: true })}</p>
            ${h.field({ name: 'answer', label: 'ข้อสรุป', type: 'textarea', rows: 4, value: r.answer, wide: true, required: true, id: 'dec-answer' })}
            ${h.field({ name: 'decidedBy', label: 'ผู้ตัดสิน (ชื่อ/ตำแหน่ง)', value: r.decidedBy, required: true, placeholder: q.who })}
            ${h.field({ name: 'decidedOn', label: 'วันที่ตัดสิน', type: 'date', value: r.decidedOn || ctx.today })}`,
          onSubmit: (vv) => {
            if (!RRS.util.trim(vv.answer)) return { ok: false, errors: [{ message: 'กรอกข้อสรุป – ถ้าต้องการเปิดคำถามใหม่ ใช้ปุ่ม เปิดคำถามอีกครั้ง' }] };
            return ctx.exec('decision.record', { id: q.id, answer: vv.answer, decidedBy: vv.decidedBy, decidedOn: vv.decidedOn }, { quiet: true, done: `บันทึกข้อสรุป ${q.no} แล้ว` });
          } });
      },
      useProposal(ctx) {
        const ta = root.document.querySelector('#dec-answer');
        if (ta && ctx.view.proposal) {
          ta.value = ctx.view.proposal;
          ta.focus();
        }
      },
      async reopen(ctx, el) {
        const q = M.QUESTIONS.find((x) => x.id === el.dataset.arg);
        if (!q) return;
        const ok = await ctx.confirm({ title: `เปิด ${q.no} อีกครั้ง`, message: 'ข้อสรุปเดิมจะถูกล้าง และข้อนี้กลับเป็น รอตัดสิน (ประวัติยังอยู่ในบันทึกการทำรายการ)', ok: 'เปิดคำถามอีกครั้ง' });
        if (!ok) return;
        await ctx.exec('decision.record', { id: q.id, answer: '', decidedBy: '' }, { done: `${q.no} กลับเป็นรอตัดสินแล้ว` });
      },
      async kpi(ctx, el) {
        const id = el.dataset.arg;
        const k = id ? RRS.q.get(ctx.state, 'kpis', id) : null;
        const isNew = !k;
        const numVal = (n) => (n == null ? '' : n);
        await ctx.dialog({ title: isNew ? 'เพิ่มตัวชี้วัด' : `ตัวชี้วัด: ${k.label}`, submit: 'บันทึก',
          body: t`${h.field({ name: 'label', label: 'ชื่อตัวชี้วัด', value: k && k.label, required: true, wide: true })}
            ${h.field({ name: 'unit', label: 'หน่วย', value: k && k.unit, placeholder: '% ครั้ง นาที …' })}
            ${h.field({ name: 'measuredOn', label: 'วันที่วัด', type: 'date', value: (k && k.measuredOn) || ctx.today })}
            ${h.field({ name: 'baseline', label: 'ค่าก่อนเริ่ม', type: 'number', value: k && numVal(k.baseline), hint: 'ว่าง = ยังไม่ได้วัด' })}
            ${h.field({ name: 'target', label: 'เป้าหมาย', type: 'number', value: k && numVal(k.target) })}
            ${h.field({ name: 'note', label: 'วิธีวัด/หมายเหตุ', type: 'textarea', value: k && k.note, wide: true, placeholder: 'เช่น นับสุ่ม 50 รายการ เทียบยอดในระบบ' })}`,
          onSubmit: (vv) => {
            let kid = id;
            if (isNew) {
              const used = new Set(RRS.q.rows(ctx.state, 'kpis').map((x) => x.id));
              let n = used.size + 1;
              while (used.has(`kpi_${n}`)) n++;
              kid = `kpi_${n}`;
            }
            return ctx.exec('kpi.record', Object.assign({ id: kid }, vv), { quiet: true, done: 'บันทึกตัวชี้วัดแล้ว' });
          } });
      },
    },
    forms: {
      async scope(ctx, vals) {
        const st = settingsOf(ctx.state);
        const more = String(vals.moreGroups || '').split(/[,،\n]/).map((x) => RRS.util.trim(x)).filter(Boolean);
        const groups = Array.from(new Set((vals.pilotGroups || []).concat(more)));
        const patch = { company: vals.company, cutoffAt: fromInput(vals.cutoffAt),
          pilot: { groups, warehouses: vals.pilotWh || st.pilot.warehouses, note: RRS.util.trim(vals.note) } };
        if (vals.cutoffAt && !patch.cutoffAt) return ctx.toast('เวลาตัดยอดไม่ถูกต้อง – เลือกวันและเวลาใหม่', 'bad');
        await ctx.exec('settings.update', { patch }, { done: 'บันทึกขอบเขตทดลองแล้ว' });
      },
      async ownership(ctx, vals) {
        const ownership = {};
        for (const o of OWNERSHIP) if (vals[o.key]) ownership[o.key] = vals[o.key];
        await ctx.exec('settings.update', { patch: { ownership } }, { done: 'บันทึกเจ้าของข้อมูลแล้ว' });
      },
      async policies(ctx, vals) {
        const labels = { overReceivePct: 'รับเกิน PO ได้ไม่เกิน (%)', recountPct: 'นับซ้ำเมื่อผลต่างเกิน (%)', recountQty: 'ผลต่างเกิน (หน่วย)', nonMovingDays: 'ของไม่เคลื่อนไหวเมื่อเกิน (วัน)' };
        for (const k in labels) {
          const n = RRS.util.num(vals[k]);
          if (isNaN(n) || n < 0) return ctx.toast(`ช่อง "${labels[k]}" ต้องเป็นตัวเลข 0 ขึ้นไป – แก้แล้วกดบันทึกอีกครั้ง`, 'bad');
        }
        const policies = {
          negativeStock: vals.negativeStock, sod: !!vals.sod, overReceivePct: vals.overReceivePct, recountPct: vals.recountPct,
          recountQty: vals.recountQty, countMode: vals.countMode, lateIsUncertain: !!vals.lateIsUncertain, nonMovingDays: vals.nonMovingDays,
        };
        await ctx.exec('settings.update', { patch: { policies, express: { defaultWarehouse: vals.defaultWarehouse || '' } } }, { done: 'บันทึกนโยบายแล้ว' });
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
