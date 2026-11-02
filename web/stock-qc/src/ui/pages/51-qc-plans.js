/*
 * Phase 5 – แผนการตรวจ QC (RRS.quality: qc.plan.save, qc.plan.approve, plans, planFor). A plan belongs to one item and
 * one stage (ตรวจรับ / ระหว่างผลิต / ก่อนส่งมอบ), names the approved drawing or work instruction it comes from and the
 * drawing revision it is bound to, and lists the characteristics (name, measure/check, nominal, min, max, unit, method).
 * Drafts are edited by engineering / QC lead and approved by another person; approval needs the item's approved
 * drawing revision and makes the previous approved plan of the same item + stage obsolete (replaced by the new one).
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const { util } = RRS;
  const Q = RRS.quality;
  const K = RRS.ui.qcKit;
  if (!Q || !K) {
    RRS.ui.page({ id: 'qc-plans', title: 'แผนการตรวจ QC', phase: 5, order: 20,
      render: () => h.empty('ยังไม่ได้เปิดใช้โมดูลคุณภาพ', 'หน้านี้ใช้ได้เมื่อระบบโหลดโมดูล Phase 5 (quality) แล้ว') });
    return;
  }

  const KIND_OPTS = Object.entries(Q.CHAR_KIND);
  const STAGE_OPTS = Object.entries(Q.STAGES).map(([k, v]) => [k, v]);
  const STATUS_TONE = { DRAFT: 'warn', APPROVED: 'ok', OBSOLETE: 'muted' };
  const CHAR_COLS = [
    { key: 'name', label: 'หัวข้อตรวจ', w: '20%', placeholder: 'เช่น ความหนา' },
    { key: 'kind', label: 'ชนิด', options: KIND_OPTS, blank: '–', w: '13%' },
    { key: 'nominal', label: 'ค่าระบุ', type: 'number', w: '9%' },
    { key: 'min', label: 'ต่ำสุดที่ยอมรับ', type: 'number', w: '10%' },
    { key: 'max', label: 'สูงสุดที่ยอมรับ', type: 'number', w: '10%' },
    { key: 'unit', label: 'หน่วย', w: '8%', placeholder: 'มม.' },
    { key: 'method', label: 'วิธี/เครื่องมือ', placeholder: 'เช่น เวอร์เนียร์' },
  ];
  const RULES = 'เกณฑ์ตรวจต้องมาจากแบบหรือวิธีปฏิบัติ (WI) ที่อนุมัติแล้ว และผูกกับฉบับแบบที่อนุมัติของสินค้า · ผู้อนุมัติแผนต้องไม่ใช่ผู้จัดทำหรือผู้แก้ล่าสุด · ' +
    'อนุมัติแผนใหม่แล้ว แผนเดิมของสินค้าและขั้นตอนเดียวกันเลิกใช้อัตโนมัติ · บันทึกผลตรวจได้เฉพาะแผนที่อนุมัติและตรงกับฉบับแบบปัจจุบัน';

  const fmtN = (n) => (n == null || n === '' ? '' : h.fmt.num(n));
  function rangeText(c) {
    if (c.kind !== 'measure') return 'ผ่าน / ไม่ผ่าน';
    if (c.min != null && c.max != null) return `${fmtN(c.min)} – ${fmtN(c.max)}`;
    return c.min != null ? `≥ ${fmtN(c.min)}` : `≤ ${fmtN(c.max)}`;
  }
  const planBadge = (p) => h.badge(Q.PLAN_STATUS[p.status] || p.status, STATUS_TONE[p.status]);
  const itemRev = (ctx, code) => {
    const it = ctx.item(code);
    return it ? util.trim(it.drawingRev) : '';
  };
  const revMatches = (ctx, p) => util.normCode(itemRev(ctx, p.code)) === util.normCode(p.drawingRev);
  const revText = (r) => (util.trim(r) ? r : '(ไม่ระบุ)');

  /** Items set to be inspected (ตรวจรับ / ตรวจเมื่อผลิตเสร็จ) without a usable approved plan for that stage. */
  function missingPlans(ctx) {
    const out = [];
    for (const it of RRS.q.rows(ctx.state, 'items', (i) => i.active !== false && (i.qcIncoming || i.qcFinal))) {
      for (const [flag, stage] of [['qcIncoming', 'INCOMING'], ['qcFinal', 'FINAL']]) {
        if (!it[flag]) continue;
        const p = Q.planFor(ctx.state, it.id, stage);
        if (p && !p.stale) continue;
        const draft = RRS.q.rows(ctx.state, 'qc_plans', (x) => x.code === it.id && x.stage === stage && x.status === 'DRAFT')[0] || null;
        out.push({ it, stage, plan: p, draft });
      }
    }
    return out.sort((a, b) => a.it.id.localeCompare(b.it.id) || a.stage.localeCompare(b.stage));
  }

  function planRows(ctx) {
    const v = ctx.view;
    const q = util.ckey(v.q);
    const tab = v.tab || 'all';
    return Q.plans(ctx.state).filter((p) => (tab === 'all' || p.status === tab) && (!v.stage || p.stage === v.stage)
      && (!q || [p.id, p.code, (ctx.item(p.code) || {}).name, p.sourceRef, p.drawingRev].some((x) => util.ckey(x).indexOf(q) >= 0)))
      .sort((a, b) => (a.status === 'OBSOLETE') - (b.status === 'OBSOLETE') || b.id.localeCompare(a.id));
  }

  function listTable(ctx, rows) {
    const v = ctx.view;
    return h.table({
      id: 'plans-list', scroll: true, rows, rowAct: 'pick', rowArg: (p) => p.id, rowCls: (p) => (p.id === v.sel ? 'sel' : p.status === 'OBSOLETE' ? 'muted' : ''),
      empty: 'ไม่พบแผนตามตัวกรอง', emptyText: 'ลองเปลี่ยนแท็บหรือล้างคำค้น',
      cols: [
        { label: 'เลขที่', render: (p) => h.code(p.id) },
        { label: 'สินค้า', render: (p) => t`${h.code(p.code)}<br><small class="muted">${(ctx.item(p.code) || {}).name || ''}</small>` },
        { label: 'ขั้นตอน', get: (p) => Q.STAGES[p.stage] || p.stage },
        { label: 'ฉบับแบบ', render: (p) => t`${revText(p.drawingRev)}${p.status !== 'OBSOLETE' && !revMatches(ctx, p) ? t`<br>${h.badge(`แบบปัจจุบัน ${revText(itemRev(ctx, p.code))}`, 'bad')}` : ''}` },
        { label: 'อ้างอิงแบบ/WI', key: 'sourceRef' },
        { label: 'หัวข้อ', num: true, get: (p) => (p.chars || []).length },
        { label: 'สถานะ', render: (p) => t`${planBadge(p)}${p.replacedBy ? t`<br><small class="muted">แทนด้วย ${p.replacedBy}</small>` : ''}` },
        { label: 'จัดทำ / อนุมัติ', render: (p) => t`${ctx.userName(p.createdBy)}${p.approvedBy ? t`<br><small class="muted">อนุมัติ ${ctx.userName(p.approvedBy)}</small>` : ''}` },
      ],
    });
  }

  function charsTable(chars) {
    return h.table({ rows: chars || [], dense: true, empty: 'ยังไม่มีหัวข้อตรวจ', cols: [
      { label: '#', key: 'id' }, { label: 'หัวข้อตรวจ', key: 'name' }, { label: 'ชนิด', get: (c) => Q.CHAR_KIND[c.kind] || c.kind },
      { label: 'ค่าระบุ', num: true, get: (c) => (c.kind === 'measure' ? fmtN(c.nominal) : '') }, { label: 'เกณฑ์ยอมรับ', get: rangeText },
      { label: 'หน่วย', key: 'unit' }, { label: 'วิธี/เครื่องมือ', key: 'method' }] });
  }

  function detail(ctx, p) {
    const it = ctx.item(p.code);
    const cur = itemRev(ctx, p.code);
    const match = revMatches(ctx, p);
    const acts = [];
    let why = '';
    if (p.status === 'DRAFT') {
      if (ctx.can('qc.plan')) acts.push(h.btn('แก้ร่าง', { act: 'editPlan', tone: 'ghost', id: 'plan-edit-btn' }));
      if (ctx.can('qc.planApprove')) {
        const chk = ctx.check('qc.plan.approve', { id: p.id });
        acts.push(h.btn('อนุมัติแผน', { act: 'approve', tone: 'primary', disabled: !chk.ok, id: 'plan-approve-btn',
          title: chk.ok ? 'อนุมัติให้ใช้ตรวจได้' : chk.errors[0].message }));
        // the revision mismatch is explained by the note above; other reasons (same person …) come from the engine
        const rest = chk.ok ? [] : chk.errors.filter((x) => x.code !== 'REV_MISMATCH');
        if (rest.length) why = h.note(t`อนุมัติไม่ได้ตอนนี้:${h.errors({ errors: rest })}`, 'warn');
      } else {
        why = t`<p class="hint">รออนุมัติโดยวิศวกรรม/หัวหน้า QC ที่ไม่ใช่ผู้จัดทำ</p>`;
      }
    }
    if (p.status !== 'OBSOLETE' && ctx.can('qc.planApprove')) {
      acts.push(h.btn(p.status === 'DRAFT' ? 'ทิ้งร่างนี้' : 'เลิกใช้แผน (ไม่มีแผนแทน)', { act: 'obsoletePlan', tone: 'ghost', id: 'plan-obsolete-btn' }));
    }
    if (p.status !== 'DRAFT' && ctx.can('qc.plan')) {
      acts.push(h.btn('สร้างฉบับใหม่จากแผนนี้', { act: 'copyPlan', tone: p.status === 'APPROVED' && !match ? 'primary' : 'ghost', id: 'plan-copy-btn' }));
    }
    const used = RRS.q.rows(ctx.state, 'inspections', (i) => i.planId === p.id).length;
    const notes = [];
    if (p.status === 'DRAFT' && !match) {
      notes.push(h.note(`แผนอ้างแบบฉบับ "${revText(p.drawingRev)}" แต่ฉบับแบบที่อนุมัติของ ${p.code} คือ "${revText(cur)}" – แก้ร่างให้ตรงฉบับแบบที่อนุมัติก่อน จึงอนุมัติได้ (ป้องกันการตรวจตามแบบเก่า)`, 'warn'));
    }
    if (p.status === 'APPROVED' && !match) {
      notes.push(h.note(`ฉบับแบบของ ${p.code} เปลี่ยนเป็น "${revText(cur)}" แล้ว – แผนนี้ใช้บันทึกผลตรวจไม่ได้ กด สร้างฉบับใหม่จากแผนนี้ ปรับเกณฑ์ตามแบบใหม่ แล้วให้อีกคนอนุมัติ (แผนนี้จะเลิกใช้อัตโนมัติ)`, 'bad'));
    }
    if (p.status === 'APPROVED' && match) notes.push(h.note(`แผนที่ใช้อยู่ของ ${p.code} ขั้นตอน${Q.STAGES[p.stage]} – ผลตรวจใหม่ใช้แผนนี้`, 'ok'));
    return h.section(t`${h.code(p.id)} ${Q.STAGES[p.stage] || p.stage} · ${p.code}`, t`${notes}
      ${h.dl([
        ['สินค้า', t`${h.code(p.code)} ${it ? it.name : 'ไม่พบในทะเบียนสินค้า'}`], ['ขั้นตอน', Q.STAGES[p.stage]], ['สถานะ', planBadge(p)],
        ['เลขที่แบบ', p.drawingNo || (it && it.drawingNo)], ['ฉบับแบบที่ใช้เป็นเกณฑ์', revText(p.drawingRev)], ['ฉบับแบบที่อนุมัติของสินค้า', revText(cur)],
        ['อ้างอิงแบบ/WI', p.sourceRef], ['วิธีสุ่มตรวจ', p.sampling],
        ['จัดทำ', K.who(ctx, p.createdBy, p.createdAt)], ['แก้ล่าสุด', K.who(ctx, p.updatedBy, p.updatedAt)],
        ['อนุมัติ', K.who(ctx, p.approvedBy, p.approvedAt)],
        p.status === 'OBSOLETE' ? ['เลิกใช้', t`${K.who(ctx, p.obsoletedBy, p.obsoletedAt)}${p.replacedBy ? t` · แทนด้วย ${K.planLink(p.replacedBy)}` : ''}${p.obsoleteReason ? t` · ${p.obsoleteReason}` : ''}`] : null,
        ['ใช้ตรวจแล้ว', `${h.fmt.num(used)} ครั้ง`],
      ])}
      <h3>หัวข้อตรวจ</h3>${charsTable(p.chars)}
      ${why}${acts.length ? t`<div class="form-actions">${acts}</div>` : ''}
      <h3>ประวัติของแผน</h3>${K.histTable(ctx, p.history)}`, {
      id: 'plan-detail', actions: h.btn('ปิด', { act: 'close', tone: 'quiet', small: true }),
    });
  }

  function editor(ctx) {
    const v = ctx.view;
    const e = v.edit || {};
    const it = e.code ? ctx.item(e.code) : null;
    const locked = !!e.id;
    const chars = e.chars && e.chars.length ? e.chars : [{ kind: 'measure' }];
    const rev = util.trim(e.drawingRev);
    const curRev = it ? util.trim(it.drawingRev) : '';
    const revNote = it && util.normCode(rev) !== util.normCode(curRev)
      ? h.note(`ฉบับแบบที่ใส่ ("${revText(rev)}") ไม่ตรงกับฉบับแบบที่อนุมัติของ ${it.id} ("${revText(curRev)}") – บันทึกร่างได้ แต่อนุมัติไม่ได้จนกว่าจะตรงกัน`, 'warn') : '';
    const existing = it && e.stage ? Q.planFor(ctx.state, it.id, e.stage) : null;
    const body = [
      locked ? t`<input type="hidden" name="code" value="${e.code}">${h.field({ name: '_code', label: 'สินค้า', value: e.code, readonly: true, id: 'plan-code-ro', hint: 'สินค้าและขั้นตอนของร่างแก้ไม่ได้ – สร้างแผนใหม่แทน' })}`
        : h.field({ name: 'code', label: 'สินค้า', value: e.code, list: 'dl-items', required: true, act: 'editField', live: true, id: 'plan-code', placeholder: 'รหัสสินค้า',
          hint: e.code ? (it ? it.name : 'ไม่พบรหัสนี้ในทะเบียนสินค้า') : 'พิมพ์หรือเลือกรหัสสินค้า' }),
      locked ? t`<input type="hidden" name="stage" value="${e.stage}">${h.field({ name: '_stage', label: 'ขั้นตอน', value: Q.STAGES[e.stage], readonly: true, id: 'plan-stage-ro' })}`
        : h.field({ name: 'stage', label: 'ขั้นตอน', type: 'select', value: e.stage, options: STAGE_OPTS, required: true, act: 'editField', id: 'plan-stage' }),
      h.field({ name: 'drawingRev', label: 'ฉบับแบบที่ใช้เป็นเกณฑ์', value: e.drawingRev, act: 'editField', live: true, id: 'plan-rev',
        hint: it ? `ฉบับแบบที่อนุมัติของ ${it.id}: ${revText(curRev)}` : 'ต้องตรงกับฉบับแบบที่อนุมัติของสินค้า' }),
      h.field({ name: 'sourceRef', label: 'อ้างอิงแบบ/วิธีปฏิบัติที่อนุมัติ', value: e.sourceRef, required: true, id: 'plan-src', placeholder: 'เช่น DWG-1234 rev B, WI-QC-05',
        hint: 'ที่มาของเกณฑ์ – ห้ามตั้งเกณฑ์เองโดยไม่มีเอกสารอ้างอิง' }),
      h.field({ name: 'sampling', label: 'วิธีสุ่มตรวจ', value: e.sampling, id: 'plan-sampling', placeholder: 'เช่น 100% หรือ สุ่ม 2 ชิ้นต่อล็อต' }),
      revNote ? t`<div class="wide">${revNote}</div>` : '',
      existing && !locked ? t`<p class="hint wide">${existing.code} ขั้นตอน${Q.STAGES[existing.stage]} มีแผนที่ใช้อยู่แล้ว (${existing.id}) – เมื่อแผนนี้ได้รับอนุมัติ ${existing.id} จะเลิกใช้</p>` : '',
      t`<div class="wide"><p class="fld-l">หัวข้อตรวจ (วัดค่า: ใส่ค่าต่ำสุดหรือสูงสุดที่ยอมรับอย่างน้อยหนึ่งค่า · ตรวจผ่าน/ไม่ผ่าน: ไม่ต้องใส่ค่า)</p>${h.lineEditor({ name: 'chars', cols: CHAR_COLS, lines: chars, addAct: 'addChar', removeAct: 'delChar' })}</div>`,
      v.editErr ? t`<div class="wide">${h.note(t`บันทึกไม่ได้ – ยังไม่มีอะไรเปลี่ยน${h.errors(v.editErr)}`, 'bad')}</div>` : '',
    ];
    return h.section(locked ? `แก้ร่างแผน ${e.id}` : e.from ? `สร้างฉบับใหม่จาก ${e.from}` : 'สร้างแผนตรวจใหม่',
      h.form({ name: 'plan', submit: 'บันทึกร่างแผน', cancel: 'closeEdit', body }), { id: 'plan-edit', sub: 'บันทึกเป็นร่างก่อน แล้วให้อีกคน (วิศวกรรม/หัวหน้า QC) อนุมัติ จึงใช้ตรวจได้' });
  }

  /** Lines of the characteristics editor without the rows the person left empty (the kind select alone does not count). */
  function charLines(lines) {
    return (lines || []).filter((c) => c && ['name', 'nominal', 'min', 'max', 'unit', 'method'].some((k) => util.trim(c[k]) !== ''));
  }
  function formValues() {
    const form = root.document.querySelector('form[data-form="plan"]');
    return form ? h.parseForm(form) : {};
  }
  function keepEdit(ctx, vals, patch) {
    return Object.assign({}, ctx.view.edit || {}, vals, { chars: vals.chars || (ctx.view.edit || {}).chars }, patch || {});
  }

  RRS.ui.page({
    id: 'qc-plans', title: 'แผนการตรวจ QC', phase: 5, order: 20,
    sub: 'เกณฑ์ตรวจของแต่ละสินค้าและขั้นตอน (ตรวจรับ / ระหว่างผลิต / ก่อนส่งมอบ) จากแบบหรือ WI ที่อนุมัติ ผูกกับฉบับแบบ และอนุมัติโดยอีกคน',
    badge: (ctx) => RRS.q.rows(ctx.state, 'qc_plans', (p) => p.status === 'DRAFT').length || '',
    render(ctx) {
      const v = ctx.view;
      const tab = v.tab || 'all';
      const all = Q.plans(ctx.state);
      const canPlan = ctx.can('qc.plan');
      const count = (s) => all.filter((p) => p.status === s).length;
      const missing = missingPlans(ctx);
      const staleN = all.filter((p) => p.status === 'APPROVED' && !revMatches(ctx, p)).length;
      const sel = v.sel ? RRS.q.get(ctx.state, 'qc_plans', v.sel) : null;
      const kp = h.kpis([
        h.kpi('แผนที่ใช้อยู่', h.fmt.num(count('APPROVED') - staleN), 'อนุมัติและตรงฉบับแบบ', 'ok'),
        h.kpi('ร่างรออนุมัติ', h.fmt.num(count('DRAFT')), 'ผู้อนุมัติต้องไม่ใช่ผู้จัดทำ', count('DRAFT') ? 'warn' : ''),
        h.kpi('แบบเปลี่ยน ต้องทำแผนใหม่', h.fmt.num(staleN), 'แผนอนุมัติแล้วแต่ฉบับแบบไม่ตรง', staleN ? 'bad' : ''),
        h.kpi('สินค้าต้องตรวจแต่ยังไม่มีแผน', h.fmt.num(missing.length), 'ตั้งตรวจรับ/ตรวจผลิตเสร็จไว้', missing.length ? 'warn' : ''),
      ]);
      const top = t`${h.note(RULES, 'info')}${kp}`;
      const edit = v.edit && canPlan ? editor(ctx) : '';
      const detailBox = sel ? detail(ctx, sel) : '';
      const newBtn = canPlan ? h.btn('+ สร้างแผนตรวจ', { act: 'newPlan', tone: 'primary', id: 'plan-new-btn' }) : '';
      if (tab === 'missing' || (!all.length && !v.edit)) {
        const missTbl = h.table({ rows: missing, dense: true, scroll: true,
          empty: all.length ? 'สินค้าที่ต้องตรวจมีแผนครบแล้ว' : 'ยังไม่มีแผนตรวจ',
          emptyText: all.length ? '' : canPlan ? 'กด + สร้างแผนตรวจ: เลือกสินค้าและขั้นตอน ใส่ฉบับแบบ เอกสารอ้างอิง และหัวข้อตรวจ แล้วให้อีกคนอนุมัติ'
            : 'วิศวกรรมหรือหัวหน้า QC เป็นผู้ทำแผนตรวจ – สินค้าที่ตั้งให้ตรวจรับหรือตรวจเมื่อผลิตเสร็จจะขึ้นที่นี่',
          cols: [
            { label: 'สินค้า', render: (m) => t`${h.code(m.it.id)} ${m.it.name}` }, { label: 'ขั้นตอน', get: (m) => Q.STAGES[m.stage] },
            { label: 'ฉบับแบบที่อนุมัติ', get: (m) => revText(m.it.drawingRev) },
            { label: 'ตอนนี้', render: (m) => (m.draft ? t`มีร่าง ${K.planLink(m.draft.id)}` : m.plan ? t`${K.planLink(m.plan.id)} ${h.badge('แบบเปลี่ยนแล้ว', 'bad')}` : h.badge('ยังไม่มีแผน', 'warn')) },
            { label: '', render: (m) => (canPlan && !m.draft ? h.btn('สร้างแผน', { act: 'newFor', arg: m.it.id + '|' + m.stage, small: true }) : '') },
          ] });
        const tabs = all.length ? planTabs(all, missing, tab) : '';
        return t`${top}${tabs}${h.toolbar('', newBtn)}${edit}${detailBox}
          ${h.section('สินค้าที่ต้องตรวจแต่ยังไม่มีแผนที่ใช้ได้', missTbl, { sub: 'สินค้าที่ตั้ง "ต้องตรวจรับ" หรือ "ต้องตรวจเมื่อผลิตเสร็จ" ในทะเบียนสินค้า – บันทึกผลตรวจไม่ได้จนกว่าจะมีแผนที่อนุมัติ' })}`;
      }
      const rows = planRows(ctx);
      return t`${top}${planTabs(all, missing, tab)}
        ${h.toolbar([
          h.field({ name: 'q', label: 'ค้นหา', value: v.q, placeholder: 'เลขที่แผน รหัสสินค้า เอกสารอ้างอิง…', id: 'plans-q', act: 'filter', live: true }),
          h.field({ name: 'stage', label: 'ขั้นตอน', type: 'select', value: v.stage, options: STAGE_OPTS, blank: 'ทุกขั้นตอน', id: 'plans-stage', act: 'filter' }),
        ], newBtn)}
        ${edit}${detailBox}<div>${listTable(ctx, rows)}<p class="hint">${h.fmt.num(rows.length)} แผน · คลิกแถวเพื่อดูหัวข้อตรวจ อนุมัติ หรือสร้างฉบับใหม่</p></div>`;
    },
    after(ctx, root0) {
      K.scrollTo(ctx, root0, ctx.view.edit ? 'plan-edit' : 'plan-detail');
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg }),
      pick: (ctx, el) => ctx.set({ sel: el.dataset.arg, _scroll: true }),
      close: (ctx) => ctx.set({ sel: null }),
      filter(ctx, el) {
        const patch = {};
        patch[el.name] = el.value;
        ctx.set(patch);
      },
      newPlan: (ctx) => ctx.set({ edit: { stage: 'INCOMING', chars: [{ kind: 'measure' }] }, editErr: null, sel: null, _scroll: true }),
      newFor(ctx, el) {
        const [code, stage] = String(el.dataset.arg).split('|');
        ctx.set({ edit: { code, stage, drawingRev: itemRev(ctx, code), chars: [{ kind: 'measure' }] }, editErr: null, sel: null, _scroll: true });
      },
      closeEdit: (ctx) => ctx.set({ edit: null, editErr: null }),
      editField(ctx) {
        const vals = formValues();
        const prev = ctx.view.edit || {};
        const next = keepEdit(ctx, vals);
        // a new item: take its approved drawing revision unless the person already typed another one
        if (util.trim(vals.code) && vals.code !== prev.code) {
          const it = ctx.item(vals.code);
          const typed = util.trim(vals.drawingRev);
          if (it && (!typed || typed === itemRev(ctx, prev.code))) next.drawingRev = util.trim(it.drawingRev);
        }
        ctx.set({ edit: next });
      },
      addChar(ctx) {
        const vals = formValues();
        const lines = (vals.chars || []).concat([{ kind: 'measure' }]);
        ctx.set({ edit: keepEdit(ctx, vals, { chars: lines }) });
      },
      delChar(ctx, el) {
        const vals = formValues();
        const lines = (vals.chars || []).filter((_, i) => i !== Number(el.dataset.arg));
        ctx.set({ edit: keepEdit(ctx, vals, { chars: lines.length ? lines : [{ kind: 'measure' }] }) });
      },
      editPlan(ctx) {
        const p = RRS.q.get(ctx.state, 'qc_plans', ctx.view.sel);
        if (!p) return;
        ctx.set({ edit: { id: p.id, code: p.code, stage: p.stage, drawingRev: p.drawingRev, sourceRef: p.sourceRef, sampling: p.sampling,
          chars: p.chars.map((c) => ({ name: c.name, kind: c.kind, nominal: c.nominal == null ? '' : c.nominal, min: c.min == null ? '' : c.min,
            max: c.max == null ? '' : c.max, unit: c.unit, method: c.method })) }, editErr: null, _scroll: true });
      },
      copyPlan(ctx) {
        const p = RRS.q.get(ctx.state, 'qc_plans', ctx.view.sel);
        if (!p) return;
        ctx.set({ edit: { from: p.id, code: p.code, stage: p.stage, drawingRev: itemRev(ctx, p.code), sourceRef: p.sourceRef, sampling: p.sampling,
          chars: p.chars.map((c) => ({ name: c.name, kind: c.kind, nominal: c.nominal == null ? '' : c.nominal, min: c.min == null ? '' : c.min,
            max: c.max == null ? '' : c.max, unit: c.unit, method: c.method })) }, editErr: null, sel: null, _scroll: true });
      },
      async approve(ctx) {
        const p = RRS.q.get(ctx.state, 'qc_plans', ctx.view.sel);
        if (!p) return;
        const old = RRS.q.rows(ctx.state, 'qc_plans', (x) => x.code === p.code && x.stage === p.stage && x.status === 'APPROVED' && x.id !== p.id);
        const ok = await ctx.confirm({
          title: `อนุมัติแผน ${p.id}`, ok: 'อนุมัติแผนนี้',
          message: `${p.code} ขั้นตอน${Q.STAGES[p.stage]} ตามแบบฉบับ ${revText(p.drawingRev)} อ้างอิง ${p.sourceRef} – ${p.chars.length} หัวข้อ จะใช้บันทึกผลตรวจได้ทันที`,
          body: old.length ? t`<div class="wide">${h.note(t`แผนที่ใช้อยู่ ${old.map((o) => o.id).join(', ')} จะเลิกใช้ และถูกแทนด้วย ${p.id} (ประวัติยังอยู่)`, 'warn')}</div>` : '',
        });
        if (!ok) return;
        const r = await ctx.exec('qc.plan.approve', { id: p.id }, { done: (x) => `อนุมัติ ${p.id} แล้ว${x.result.obsoleted && x.result.obsoleted.length ? ' – เลิกใช้ ' + x.result.obsoleted.join(', ') : ''}` });
        if (r.ok) ctx.set({});
      },
      async obsoletePlan(ctx) {
        const p = RRS.q.get(ctx.state, 'qc_plans', ctx.view.sel);
        if (!p) return;
        const draft = p.status === 'DRAFT';
        await ctx.dialog({
          title: draft ? `ทิ้งร่าง ${p.id}` : `เลิกใช้แผน ${p.id}`, submit: draft ? 'ทิ้งร่างนี้' : 'เลิกใช้แผนนี้', danger: true,
          message: draft ? 'ร่างนี้จะอนุมัติไม่ได้อีก (ประวัติยังอยู่)'
            : `${p.code} จะไม่มีแผน${Q.STAGES[p.stage]}ที่ใช้ได้ – บันทึกผลตรวจขั้นนี้ไม่ได้จนกว่าจะอนุมัติแผนใหม่ ผลผ่านที่รอปล่อยอยู่ยังปล่อยได้ตามเดิม`,
          body: h.field({ name: 'reason', label: 'เหตุผล', type: 'textarea', required: true, wide: true, id: 'plan-obsolete-reason' }),
          onSubmit: (vals) => ctx.exec('qc.plan.obsolete', { id: p.id, reason: vals.reason }, { quiet: true, done: () => `${p.id} เลิกใช้แล้ว` }),
        });
      },
    },
    forms: {
      async plan(ctx, vals) {
        const e = ctx.view.edit || {};
        const chars = charLines(vals.chars).map((c) => ({ name: c.name, kind: c.kind || 'measure', nominal: c.nominal, min: c.min, max: c.max, unit: c.unit, method: c.method }));
        const payload = { code: vals.code, stage: vals.stage, drawingRev: vals.drawingRev, sourceRef: vals.sourceRef, sampling: vals.sampling, chars };
        if (e.id) payload.id = e.id;
        const r = await ctx.exec('qc.plan.save', payload, { quiet: true, done: (x) => `บันทึกร่างแผน ${x.result.id} แล้ว – ให้อีกคนอนุมัติ` });
        if (r.ok) ctx.set({ edit: null, editErr: null, sel: r.result.id, tab: ctx.view.tab === 'missing' ? 'all' : ctx.view.tab, _scroll: true });
        else ctx.set({ edit: keepEdit(ctx, vals), editErr: r });
      },
    },
  });

  function planTabs(all, missing, tab) {
    const n = (s) => all.filter((p) => p.status === s).length;
    return h.tabs([{ id: 'all', label: 'ทั้งหมด', count: all.length }, { id: 'APPROVED', label: 'ใช้อยู่', count: n('APPROVED') },
      { id: 'DRAFT', label: 'ร่าง/รออนุมัติ', count: n('DRAFT') }, { id: 'OBSOLETE', label: 'เลิกใช้', count: n('OBSOLETE') },
      { id: 'missing', label: 'ยังไม่มีแผน', count: missing.length }], tab);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
