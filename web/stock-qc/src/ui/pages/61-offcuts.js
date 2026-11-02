/*
 * Phase 6 – เศษเหล็กใช้ซ้ำ (engine: RRS.reports offcuts / suggestOffcuts, commands offcut.add / use / scrap / undo).
 *   ทะเบียนเศษ      register an offcut from a plate item (material and thickness come from the plate's master data,
 *                   size in mm, warehouse/bin, source heat/lot when the plate is lot-tracked); list with filters
 *                   (status, warehouse, material, thickness, search); a row opens the offcut with its id as a large
 *                   label (class .tag) to write on the piece, its history, and: use it for a job (record the leftover
 *                   pieces – each gets a new id), scrap it with a reason, or undo a use/scrap entered by mistake.
 *   หาเศษที่ใช้ได้  material / thickness / size needed → RRS.reports.suggestOffcuts: offcuts that fit (rotation
 *                   allowed), smallest first with the waste %, offcuts of a quarantined lot left out, and new plates
 *                   in stock as the fallback.
 * The register never changes stock balances (the plate was issued already) – it traces re-usable pieces.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const U = RRS.util;
  const R = () => RRS.reports || null;

  const STEP = 300;
  const TAG_LIMIT = 60;
  const dash = t`<span class="muted">–</span>`;
  const low = (s) => String(s == null ? '' : s).toLowerCase();
  const STATUS_TONE = { AVAILABLE: 'ok', USED: 'info', SCRAPPED: 'muted', VOID: 'muted' };
  const ACTION = { ADD: 'บันทึกเศษ', USE: 'ใช้ตัดงาน', SCRAP: 'ทิ้ง', VOID: 'ยกเลิก', UNDO_USE: 'ยกเลิกการใช้', UNDO_SCRAP: 'ยกเลิกการทิ้ง' };
  const statusLabel = (s) => ((R() && R().OFFCUT_STATUS) || {})[s] || s;
  const statusBadge = (s) => h.badge(statusLabel(s), STATUS_TONE[s] || 'muted');
  const loc = (o) => `${o.wh}${o.bin ? '/' + o.bin : ''}`;
  const size = (o) => `${h.fmt.num(o.width)} × ${h.fmt.num(o.length)}`;
  const m2 = (mm2) => h.fmt.num((Number(mm2) || 0) / 1e6, 3);
  const thk = (v) => (v ? `${h.fmt.num(v)} มม.` : '');
  const whoCan = () => RRS.auth.rolesFor('offcut.manage').filter((r) => r !== 'admin').map((r) => RRS.auth.ROLES[r] || r).join(' / ');
  /** The id as a large label: the tag box with the big monospace number inside (existing classes only). */
  const bigTag = (id) => t`<span class="tag"><span class="kpi-v mono">${id}</span></span>`;

  function offcut(state, id) {
    return id ? RRS.q.get(state, 'offcuts', id) : null;
  }
  /** Plate items: material or thickness in the register (else raw materials), active. */
  function plates(state) {
    const items = RRS.q.rows(state, 'items', (i) => i.active !== false);
    let list = items.filter((i) => U.trim(i.material) || Number(i.thickness) > 0);
    if (!list.length) list = items.filter((i) => i.type === 'RM');
    return list.sort((a, b) => a.id.localeCompare(b.id));
  }
  function materials(state) {
    const set = new Set();
    for (const o of RRS.q.rows(state, 'offcuts')) if (U.trim(o.material)) set.add(U.trim(o.material));
    for (const i of RRS.q.rows(state, 'items')) if (U.trim(i.material)) set.add(U.trim(i.material));
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'th'));
  }
  /** Lots / heats known for a plate (lots table, else balances and movements), quarantined ones apart. */
  function lotsOf(state, code) {
    const ok = new Set();
    const held = new Set();
    for (const l of RRS.q.rows(state, 'lots', (x) => x.code === code)) (l.status === 'QUARANTINED' ? held : ok).add(l.lot);
    for (const b of RRS.q.rows(state, 'balances', (x) => x.code === code && x.lot)) if (!held.has(b.lot)) ok.add(b.lot);
    for (const m of RRS.q.rows(state, 'movements', (x) => x.code === code && x.lot)) if (!held.has(m.lot)) ok.add(m.lot);
    return { ok: Array.from(ok).sort(), held: Array.from(held).sort() };
  }
  const whsFor = (ctx) => h.whOptions(ctx.state).filter(([c]) => ctx.can('offcut.manage', c));

  // ---- register form ------------------------------------------------------------------------------------------------
  function regForm(ctx) {
    const v = ctx.view;
    const reg = v.reg || {};
    const list = plates(ctx.state);
    const parent = reg.parent ? offcut(ctx.state, reg.parent) : null;
    const it = reg.code ? RRS.q.get(ctx.state, 'items', reg.code) : null;
    const whs = whsFor(ctx);
    const wh = reg.wh || (whs.length === 1 ? whs[0][0] : '');
    const tracked = it && it.trackLot && it.trackLot !== 'none';
    const lots = it ? lotsOf(ctx.state, it.id) : { ok: [], held: [] };
    const track = it && RRS.master && RRS.master.TRACK ? RRS.master.TRACK[it.trackLot] || 'ล็อต' : 'ล็อต';
    const itMat = it ? U.trim(it.material) : '';
    const itThk = it ? Number(it.thickness) || 0 : 0;
    if (!list.length && !parent) {
      return h.empty('ยังไม่มีแผ่นเหล็กในทะเบียนสินค้า', 'เศษต้องบันทึกจากรหัสแผ่นต้นทาง – ใส่ วัสดุ และ ความหนา ให้รหัสแผ่นในทะเบียนสินค้าก่อน',
        t`<div class="form-actions">${RRS.ui.pages.items ? h.link('ไปทะเบียนสินค้า', 'items') : ''}${h.btn('ปิด', { act: 'cancelReg', tone: 'ghost' })}</div>`);
    }
    return h.form({
      name: 'reg', submit: 'บันทึกเศษและออกรหัส', cancel: 'cancelReg',
      body: [
        parent ? t`<div class="wide">${h.note(t`ชิ้นที่เหลือจากเศษ ${h.code(parent.id)} (${statusLabel(parent.status)} · ${size(parent)} มม.) – วัสดุ ความหนา และล็อตตามเศษต้นทาง ขนาดต้องไม่ใหญ่กว่าเศษต้นทาง`, 'info')}</div>`
          : '',
        parent ? t`${h.field({ name: 'code', type: 'hidden', value: parent.code })}${h.field({ name: 'parent', type: 'hidden', value: parent.id })}${h.field({ name: 'codeShow', label: 'แผ่นต้นทาง', value: parent.code, readonly: true, id: 'oc-reg-code-ro' })}`
          : h.field({ name: 'code', label: 'แผ่นต้นทาง (รหัสสินค้า)', type: 'select', value: reg.code, required: true, id: 'oc-reg-code', act: 'regRefresh',
            options: list.map((i) => [i.id, `${i.id} · ${i.name}${i.thickness ? ' · หนา ' + i.thickness : ''}`]), blank: '— เลือกแผ่น —', wide: true }),
        h.field({ name: 'material', label: 'วัสดุ', value: parent ? parent.material : itMat || reg.material, readonly: !!(parent || itMat), required: true, id: 'oc-reg-mat', list: 'oc-mats',
          hint: parent ? 'ตามเศษต้นทาง' : itMat ? 'ตามทะเบียนของแผ่นต้นทาง' : 'แผ่นนี้ไม่มีวัสดุในทะเบียน – พิมพ์ให้ตรงกับใบรับรอง' }),
        h.field({ name: 'thickness', label: 'ความหนา (มม.)', type: 'number', value: parent ? parent.thickness : itThk || reg.thickness, readonly: !!(parent || itThk), required: true, id: 'oc-reg-thk',
          hint: parent ? 'ตามเศษต้นทาง' : itThk ? 'ตามทะเบียนของแผ่นต้นทาง' : '' }),
        h.field({ name: 'width', label: 'กว้าง (มม.)', type: 'number', value: reg.width, required: true, id: 'oc-reg-w',
          hint: parent ? `เศษต้นทาง ${size(parent)} มม.` : it && it.width ? `แผ่นเต็ม ${h.fmt.num(it.width)} × ${h.fmt.num(it.length)} มม.` : '' }),
        h.field({ name: 'length', label: 'ยาว (มม.)', type: 'number', value: reg.length, required: true, id: 'oc-reg-l' }),
        h.field({ name: 'wh', label: 'เก็บที่คลัง', type: 'select', value: wh, options: whs, required: true, id: 'oc-reg-wh', act: 'regRefresh' }),
        h.field({ name: 'bin', label: 'ช่องเก็บ / แร็คเศษ', type: 'select', value: reg.bin, options: wh ? h.binOptions(ctx.state, wh) : [], blank: wh ? 'ไม่ระบุช่อง' : 'เลือกคลังก่อน', id: 'oc-reg-bin' }),
        parent ? h.field({ name: 'sourceLot', label: 'ล็อต/Heat (ตามเศษต้นทาง)', value: parent.sourceLot || '', readonly: true, id: 'oc-reg-lot', hint: parent.sourceLot ? '' : 'ไม่ติดตามล็อต' })
        : tracked ? h.field({ name: 'sourceLot', label: `${track} ของแผ่นต้นทาง`, value: reg.sourceLot, required: true, id: 'oc-reg-lot', list: 'oc-lots',
          hint: lots.held.length ? `ล็อตที่ถูกกักกันบันทึกเป็นเศษพร้อมใช้ไม่ได้: ${lots.held.join(', ')}` : 'อ่านจากป้าย/ตัวเลขที่ตอกบนแผ่น' })
          : h.field({ name: 'sourceLot', type: 'hidden', value: '' }),
        h.field({ name: 'createdFrom', label: 'ที่มา (งาน / ใบตัด / เอกสาร)', value: reg.createdFrom, id: 'oc-reg-from', placeholder: parent ? `เว้นว่าง = เศษเหลือหลังตัด ${parent.id}` : 'เช่น ตัดงาน JOB-0012' }),
        h.field({ name: 'remark', label: 'หมายเหตุ', value: reg.remark, id: 'oc-reg-remark', wide: true }),
        t`<datalist id="oc-lots">${lots.ok.map((l) => t`<option value="${l}"></option>`)}</datalist><datalist id="oc-mats">${materials(ctx.state).map((m) => t`<option value="${m}"></option>`)}</datalist>`,
        t`<p class="hint wide">ระบบออกรหัส OC-… ให้ทันทีหลังบันทึก – เขียนหรือติดรหัสนั้นบนชิ้นเศษ · ทะเบียนนี้ไม่เปลี่ยนยอดสต็อก (แผ่นต้นทางเบิกไปแล้ว)</p>`,
      ],
    });
  }

  // ---- list ------------------------------------------------------------------------------------------------------------
  function listRows(ctx) {
    const v = ctx.view;
    const st = v.st || 'AVAILABLE';
    const r = R().offcuts(ctx.state, { status: st, wh: v.wh || '' });
    const q = low(v.q).trim();
    const mat = low(v.mat).trim();
    const tk = U.num(v.thk);
    return r.rows.filter((o) => (!mat || low(o.material) === mat) && (isNaN(tk) || !v.thk || Math.abs((Number(o.thickness) || 0) - tk) < 1e-6)
      && (!q || [o.id, o.code, o.sourceLot, o.material, o.usedFor, o.createdFrom, o.bin].some((x) => low(x).indexOf(q) >= 0)));
  }
  function listTable(ctx, rows) {
    const v = ctx.view;
    const limit = v.limit || STEP;
    const tbl = h.table({
      id: 'oc-list', scroll: true, rows: rows.slice(0, limit), rowAct: 'pick', rowArg: (o) => o.id, rowCls: (o) => (o.id === v.sel ? 'sel' : ''),
      empty: 'ไม่พบเศษตามตัวกรอง', emptyText: 'ลองเลือกสถานะ "ทุกสถานะ" หรือล้างตัวกรอง',
      cols: [
        { label: 'รหัสเศษ (QR)', render: (o) => h.code(o.id) },
        { label: 'แผ่นต้นทาง', render: (o) => h.code(o.code) },
        { label: 'วัสดุ', key: 'material' },
        { label: 'หนา (มม.)', num: true, key: 'thickness' },
        { label: 'กว้าง × ยาว (มม.)', cls: 'nowrap', get: (o) => size(o) },
        { label: 'ที่เก็บ', render: (o) => h.code(loc(o)) },
        { label: 'ล็อต/Heat', get: (o) => o.sourceLot || '' },
        { label: 'สถานะ', render: (o) => statusBadge(o.status) },
        { label: 'ใช้กับ / ที่มา', get: (o) => o.usedFor || o.createdFrom || '' },
      ],
    });
    const more = rows.length > limit
      ? t`<p class="hint">แสดง ${h.fmt.num(limit)} จาก ${h.fmt.num(rows.length)} ชิ้น ${h.btn(`แสดงเพิ่มอีก ${h.fmt.num(Math.min(STEP, rows.length - limit))} ชิ้น`, { act: 'more', tone: 'ghost', small: true })}</p>`
      : rows.length ? t`<p class="hint">${h.fmt.num(rows.length)} ชิ้น · คลิกแถวเพื่อดูป้าย ประวัติ และใช้ตัด/ทิ้ง</p>` : '';
    return t`${tbl}${more}`;
  }
  function tagsGrid(rows) {
    const shown = rows.slice(0, TAG_LIMIT);
    return t`<div class="steps">${shown.map((o) => t`<div class="step"><span class="step-n">เศษเหล็กใช้ซ้ำ · ${statusLabel(o.status)}</span><span>${bigTag(o.id)}</span>
      <span>${o.material} หนา ${thk(o.thickness)}</span><span class="hint">${size(o)} มม. · ${loc(o)}${o.sourceLot ? ' · ' + o.sourceLot : ''}</span></div>`)}</div>
      ${rows.length > TAG_LIMIT ? t`<p class="hint">แสดงป้าย ${TAG_LIMIT} จาก ${h.fmt.num(rows.length)} ชิ้น – ดาวน์โหลด CSV เพื่อพิมพ์ทั้งหมด</p>` : ''}`;
  }

  // ---- detail ------------------------------------------------------------------------------------------------------------
  function detail(ctx, o) {
    const it = RRS.q.get(ctx.state, 'items', o.code);
    const canHere = ctx.can('offcut.manage', o.wh);
    const pick = (id) => (id ? h.btn(id, { act: 'pick', arg: id, tone: 'quiet', small: true }) : dash);
    const acts = [];
    if (canHere && o.status === 'AVAILABLE') {
      acts.push(h.btn('ใช้ตัดงาน', { act: 'use', arg: o.id, tone: 'primary', id: 'oc-use-btn' }), h.btn('ทิ้งเศษนี้', { act: 'scrap', arg: o.id, tone: 'danger', id: 'oc-scrap-btn' }));
    }
    if (canHere && o.status === 'USED') acts.push(h.btn('+ บันทึกชิ้นที่เหลือเพิ่ม', { act: 'regChild', arg: o.id, tone: 'ghost', id: 'oc-child-btn' }));
    if (canHere && (o.status === 'USED' || o.status === 'SCRAPPED')) {
      acts.push(h.btn(o.status === 'USED' ? 'ยกเลิกการใช้ (บันทึกผิด)' : 'ยกเลิกการทิ้ง (บันทึกผิด)', { act: 'undo', arg: o.id, tone: 'ghost', id: 'oc-undo-btn' }));
    }
    const label = t`<div class="steps"><div class="step"><span class="step-n">ป้ายเศษเหล็ก · เขียนหรือติดบนชิ้น</span><span>${bigTag(o.id)}</span>
      <span>${o.material} หนา ${thk(o.thickness)} · ${size(o)} มม.</span><span class="hint">ที่เก็บ ${loc(o)}${o.sourceLot ? ' · ล็อต/Heat ' + o.sourceLot : ''} · จาก ${o.code}</span></div></div>`;
    const lotLink = o.sourceLot && RRS.ui.pages.lots ? h.link(o.sourceLot, 'lots', { tab: 'list', sel: o.code + '|' + o.sourceLot, _scroll: true }) : o.sourceLot;
    const facts = h.dl([
      ['สถานะ', statusBadge(o.status)],
      ['แผ่นต้นทาง', t`${h.code(o.code)} ${it ? it.name : ''}`],
      ['วัสดุ / ความหนา', `${o.material} · ${thk(o.thickness)}`],
      ['กว้าง × ยาว', `${size(o)} มม. (${m2(o.area || o.width * o.length)} ตร.ม.)`],
      ['ที่เก็บ', h.code(loc(o))],
      ['ล็อต/Heat ต้นทาง', lotLink || 'ไม่ติดตามล็อต'],
      ['บันทึกโดย', `${ctx.userName(o.createdBy)} · ${h.fmt.dt(o.createdAt)}`],
      o.createdFrom ? ['ที่มา', o.createdFrom] : null,
      o.parent ? ['ตัดมาจากเศษ', pick(o.parent)] : null,
      o.status === 'USED' ? ['ใช้กับ', `${o.usedFor} · ${ctx.userName(o.usedBy)} · ${h.fmt.dt(o.usedAt)}`] : null,
      o.children && o.children.length ? ['เศษที่เหลือหลังตัด', h.join(o.children.map(pick), ' ')] : null,
      o.status === 'SCRAPPED' ? ['ทิ้งเพราะ', `${o.scrapReason} · ${ctx.userName(o.scrappedBy)} · ${h.fmt.dt(o.scrappedAt)}`] : null,
      o.status === 'VOID' ? ['ยกเลิกเพราะ', `${o.voidReason} · ${ctx.userName(o.voidedBy)} · ${h.fmt.dt(o.voidedAt)}`] : null,
      o.remark ? ['หมายเหตุ', o.remark] : null,
    ]);
    const hist = (o.history || []).slice().reverse();
    const histTbl = h.table({ dense: true, rows: hist, empty: 'ยังไม่มีประวัติ', cols: [
      { label: 'เวลา', get: (x) => h.fmt.dt(x.at) }, { label: 'ผู้ทำ', get: (x) => ctx.userName(x.by) },
      { label: 'รายการ', get: (x) => ACTION[x.action] || x.action }, { label: 'รายละเอียด', get: (x) => x.detail || '' }] });
    const why = !ctx.can('offcut.manage') ? `ใช้ตัด/ทิ้งเศษได้เฉพาะ ${whoCan()}` : !canHere ? `คุณไม่มีสิทธิ์จัดการเศษในคลัง ${o.wh}` : '';
    return h.section(t`เศษ ${h.code(o.id)}`, t`${label}${facts}${acts.length ? t`<div class="form-actions">${acts}</div>` : why && o.status === 'AVAILABLE' ? h.note(why, 'info') : ''}<h3>ประวัติ</h3>${histTbl}`,
      { id: 'oc-detail', actions: h.btn('ปิด', { act: 'close', tone: 'quiet', small: true }) });
  }

  // ---- use dialog --------------------------------------------------------------------------------------------------------
  function useBody(ctx, o, usedFor, pieces) {
    return t`<div class="wide">${h.dl([['เศษ', h.code(o.id)], ['วัสดุ', `${o.material} หนา ${thk(o.thickness)}`], ['ขนาด', `${size(o)} มม.`], ['ที่เก็บ', loc(o)]])}</div>
      ${h.field({ name: 'usedFor', label: 'ใช้กับงาน / แบบ', value: usedFor, required: true, wide: true, id: 'oc-use-for', placeholder: 'เช่น JOB-0012 แผ่นพื้น / แบบ D-123' })}
      <div class="wide"><p class="fld-l">เศษที่เหลือหลังตัด (ชิ้นที่ยังใช้ได้ – ไม่มีให้เว้นว่าง)</p>${h.lineEditor({ name: 'pieces', lines: pieces, addAct: 'pieceAdd', removeAct: 'pieceDel',
        cols: [{ key: 'width', label: 'กว้าง (มม.)', type: 'number' }, { key: 'length', label: 'ยาว (มม.)', type: 'number' },
          { key: 'bin', label: 'ช่องเก็บ', options: h.binOptions(ctx.state, o.wh), blank: o.bin ? `เดิม (${o.bin})` : 'ไม่ระบุ' }, { key: 'remark', label: 'หมายเหตุ' }] })}</div>
      <p class="hint wide">ชิ้นที่เหลือแต่ละชิ้นได้รหัส OC-… ใหม่ทันที (เก็บในคลัง ${o.wh} เดียวกัน) · ขนาดต้องไม่ใหญ่กว่าเศษนี้ และพื้นที่รวมต้องน้อยกว่าเดิม</p>`;
  }
  let useTarget = null; // the offcut of the open "use" dialog (its piece lines are re-drawn in place)
  function dlgForm() {
    return root.document.querySelector('#dlg form[data-dlg-form]');
  }

  RRS.ui.page({
    id: 'offcuts', title: 'เศษเหล็กใช้ซ้ำ', phase: 6, order: 20,
    sub: 'บันทึกชิ้นเหล็กที่เหลือจากการตัดพร้อมรหัสป้าย ขนาด วัสดุ ความหนา ที่เก็บ และ Heat ต้นทาง · ก่อนตัดแผ่นใหม่ ให้หาเศษที่ใช้ได้ก่อน',
    badge: (ctx) => RRS.q.rows(ctx.state, 'offcuts', (o) => o.status === 'AVAILABLE').length || '',
    render(ctx) {
      if (!R() || typeof R().offcuts !== 'function') return h.empty('ยังเปิดทะเบียนเศษไม่ได้', 'หน้านี้ต้องใช้โมดูลรายงาน (reports) ซึ่งยังไม่ได้โหลด – โหลดหน้าใหม่ หรือแจ้งผู้ดูแลระบบ');
      const v = ctx.view;
      const tab = v.tab === 'find' ? 'find' : 'list';
      const can = ctx.can('offcut.manage');
      const all = RRS.q.rows(ctx.state, 'offcuts');
      const avail = all.filter((o) => o.status === 'AVAILABLE');
      const k = h.kpis([
        h.kpi('เศษพร้อมใช้', h.fmt.num(avail.length), 'ชิ้น', avail.length ? 'ok' : ''),
        h.kpi('พื้นที่พร้อมใช้', m2(U.sum(avail, (o) => o.area || o.width * o.length)), 'ตร.ม. รวม'),
        h.kpi('ใช้ตัดแล้ว', h.fmt.num(all.filter((o) => o.status === 'USED').length), 'ชิ้น', 'info'),
        h.kpi('ทิ้งแล้ว', h.fmt.num(all.filter((o) => o.status === 'SCRAPPED').length), 'ชิ้น'),
      ]);
      const tabs = h.tabs([{ id: 'list', label: 'ทะเบียนเศษ', count: avail.length }, { id: 'find', label: 'หาเศษที่ใช้ได้' }], tab);
      const regBtn = can ? h.btn('+ บันทึกเศษ', { act: 'newReg', tone: 'primary', id: 'oc-new' }) : '';
      const reg = v.adding && can ? h.section('บันทึกเศษเหล็ก', regForm(ctx), { id: 'oc-reg', sub: 'วัดขนาดชิ้นที่ยังใช้ได้ (มม.) แล้วเลือกที่เก็บ' }) : '';
      const sel = offcut(ctx.state, v.sel);
      if (tab === 'find') return t`${k}${tabs}${reg}${findView(ctx)}${sel ? detail(ctx, sel) : ''}`;

      if (!all.length) {
        return t`${k}${tabs}${reg || h.empty('ยังไม่มีเศษเหล็กในทะเบียน', can
          ? 'เมื่อตัดแผ่นแล้วมีชิ้นที่ยังใช้ได้ ให้กด บันทึกเศษ วัดขนาด เลือกที่เก็บ แล้วเขียนรหัส OC-… ที่ระบบออกให้บนชิ้น – ครั้งต่อไปก่อนตัดแผ่นใหม่ ใช้แท็บ หาเศษที่ใช้ได้'
          : `ทะเบียนนี้เก็บชิ้นเหล็กที่เหลือจากการตัดซึ่งยังใช้ได้ – ${whoCan()} เป็นผู้บันทึก เมื่อมีแล้วรายการจะขึ้นที่นี่`, can ? h.btn('+ บันทึกเศษชิ้นแรก', { act: 'newReg', tone: 'primary', id: 'oc-new' }) : '')}`;
      }
      const rows = listRows(ctx);
      const mats = materials(ctx.state);
      const filtered = (v.st && v.st !== 'AVAILABLE') || v.wh || v.mat || v.thk || v.q;
      const left = [
        h.field({ name: 'q', label: 'ค้นหา', value: v.q, placeholder: 'รหัส OC แผ่น Heat งาน…', id: 'oc-q', act: 'filter', live: true }),
        h.field({ name: 'st', label: 'สถานะ', type: 'select', value: v.st || 'AVAILABLE', blank: false, id: 'oc-st', act: 'filter',
          options: Object.keys(R().OFFCUT_STATUS).map((s) => [s, R().OFFCUT_STATUS[s]]).concat([['ALL', 'ทุกสถานะ']]) }),
        h.field({ name: 'wh', label: 'คลัง', type: 'select', value: v.wh, options: h.whOptions(ctx.state), blank: 'ทุกคลัง', id: 'oc-wh', act: 'filter' }),
        mats.length ? h.field({ name: 'mat', label: 'วัสดุ', type: 'select', value: v.mat, options: mats, blank: 'ทุกวัสดุ', id: 'oc-mat', act: 'filter' }) : '',
        h.field({ name: 'thk', label: 'ความหนา (มม.)', type: 'number', value: v.thk, id: 'oc-thk', act: 'filter', live: true }),
      ];
      const right = [filtered ? h.btn('ล้างตัวกรอง', { act: 'clear', tone: 'ghost' }) : '',
        rows.length ? h.btn(v.tags ? 'ดูเป็นตาราง' : 'ดูเป็นป้าย', { act: 'tags', tone: 'ghost', id: 'oc-tags' }) : '',
        rows.length ? h.btn('ดาวน์โหลด CSV', { act: 'csv', tone: 'ghost' }) : '', v.adding ? '' : regBtn];
      return t`${k}${tabs}${reg}${h.toolbar(left, right)}${sel ? detail(ctx, sel) : ''}${v.tags ? tagsGrid(rows) : listTable(ctx, rows)}`;
    },
    after(ctx, root0) {
      const v = ctx.view;
      if (v._scroll) {
        const el = root0.querySelector('#' + v._scroll);
        v._scroll = null;
        if (el) setTimeout(() => el.scrollIntoView({ block: 'start' }), 0);
      }
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg, limit: STEP }),
      more: (ctx) => ctx.set({ limit: (ctx.view.limit || STEP) + STEP }),
      pick: (ctx, el) => ctx.set({ sel: el.dataset.arg, _scroll: 'oc-detail' }),
      close: (ctx) => ctx.set({ sel: null }),
      tags: (ctx) => ctx.set({ tags: !ctx.view.tags }),
      filter(ctx, el) {
        const patch = { limit: STEP };
        patch[el.name] = el.type === 'checkbox' ? el.checked : el.value;
        ctx.set(patch);
      },
      clear: (ctx) => ctx.set({ st: 'AVAILABLE', wh: '', mat: '', thk: '', q: '', limit: STEP }),
      newReg: (ctx) => ctx.set({ adding: true, reg: { wh: ctx.view.wh || '' }, _scroll: 'oc-reg' }),
      regChild(ctx, el) {
        const o = offcut(ctx.state, el.dataset.arg);
        if (!o || o.status !== 'USED') return ctx.toast('บันทึกชิ้นที่เหลือได้เฉพาะจากเศษที่ใช้ตัดแล้ว', 'warn');
        ctx.set({ adding: true, tab: 'list', reg: { code: o.code, parent: o.id, wh: o.wh, bin: o.bin }, _scroll: 'oc-reg' });
      },
      cancelReg: (ctx) => ctx.set({ adding: false, reg: null }),
      regRefresh(ctx, el) {
        const form = el.closest('form');
        const vals = h.parseForm(form);
        if (el.name === 'code') {
          // a new plate: material / thickness / lot come from that plate
          const it = RRS.q.get(ctx.state, 'items', vals.code);
          vals.material = it && U.trim(it.material) ? it.material : '';
          vals.thickness = it && Number(it.thickness) ? it.thickness : '';
          vals.sourceLot = '';
        }
        if (el.name === 'wh') vals.bin = '';
        ctx.set({ reg: vals });
      },
      async csv(ctx) {
        const rows = listRows(ctx);
        const out = [['รหัสเศษ (QR)', 'แผ่นต้นทาง', 'วัสดุ', 'หนา (มม.)', 'กว้าง (มม.)', 'ยาว (มม.)', 'พื้นที่ (ตร.ม.)', 'คลัง', 'ช่องเก็บ', 'ล็อต/Heat', 'สถานะ',
          'ตัดมาจาก', 'ที่มา', 'ใช้กับ', 'บันทึกโดย', 'บันทึกเมื่อ']].concat(rows.map((o) => [o.id, o.code, o.material, o.thickness, o.width, o.length,
          U.round((Number(o.area) || o.width * o.length) / 1e6, 4), o.wh, o.bin, o.sourceLot, statusLabel(o.status), o.parent, o.createdFrom, o.usedFor,
          ctx.userName(o.createdBy), h.fmt.dt(o.createdAt)]));
        await ctx.download(`offcuts-${ctx.view.st || 'AVAILABLE'}-${ctx.today}.csv`, h.csv(out));
      },
      async use(ctx, el) {
        const o = offcut(ctx.state, el.dataset.arg);
        if (!o) return ctx.toast('ไม่พบเศษนี้แล้ว – อาจถูกใช้หรือทิ้งไปก่อน', 'warn');
        if (o.status !== 'AVAILABLE') return ctx.toast(`เศษ ${o.id} ${statusLabel(o.status)} – ใช้ซ้ำไม่ได้`, 'warn');
        // prefill the job only when the piece was picked from the finder (not from an older search)
        const fromFind = ctx.view.tab === 'find' && !!el.closest('#oc-fit');
        const usedFor = (fromFind && ctx.view.find && (ctx.view.find.usedFor || ctx.view.find.job)) || '';
        useTarget = o.id;
        const r = await ctx.dialog({
          title: `ใช้เศษ ${o.id} ตัดงาน`, submit: 'บันทึกการใช้', wide: true,
          body: useBody(ctx, o, usedFor, [{}]),
          onSubmit: (vals) => ctx.exec('offcut.use', { id: o.id, usedFor: vals.usedFor,
            remaining: h.cleanLines(vals.pieces).map((p) => ({ width: p.width, length: p.length, bin: p.bin, remark: p.remark })) }, { quiet: true }),
        });
        useTarget = null;
        if (r && r.ok) {
          const kids = (r.result && r.result.children) || [];
          ctx.toast(kids.length ? `ใช้เศษ ${o.id} แล้ว – เขียนรหัสใหม่บนชิ้นที่เหลือ: ${kids.join(', ')}` : `ใช้เศษ ${o.id} แล้ว`, 'ok');
          ctx.set({ sel: kids.length === 1 ? kids[0] : o.id, _scroll: 'oc-detail' });
        }
      },
      pieceAdd(ctx) {
        const form = dlgForm();
        const o = offcut(ctx.state, useTarget);
        if (!form || !o) return;
        const vals = h.parseForm(form);
        const pieces = (vals.pieces || []).concat([{ bin: ((vals.pieces || []).slice(-1)[0] || {}).bin || '' }]);
        ctx.dialogBody(useBody(ctx, o, vals.usedFor, pieces));
      },
      pieceDel(ctx, el) {
        const form = dlgForm();
        const o = offcut(ctx.state, useTarget);
        if (!form || !o) return;
        const vals = h.parseForm(form);
        const pieces = (vals.pieces || []).filter((_, i) => i !== Number(el.dataset.arg));
        ctx.dialogBody(useBody(ctx, o, vals.usedFor, pieces.length ? pieces : [{}]));
      },
      async scrap(ctx, el) {
        const o = offcut(ctx.state, el.dataset.arg);
        if (!o) return;
        await ctx.dialog({
          title: `ทิ้งเศษ ${o.id}`, submit: 'ทิ้งเศษ', danger: true,
          message: `${o.material} หนา ${thk(o.thickness)} · ${size(o)} มม. ที่ ${loc(o)} – เศษจะไม่ถูกแนะนำให้ใช้อีก (ยกเลิกได้ถ้าบันทึกผิด)`,
          body: h.field({ name: 'reason', label: 'เหตุผลที่ทิ้ง', required: true, wide: true, id: 'oc-scrap-reason', placeholder: 'เช่น เล็กเกินใช้ / เป็นสนิม / ขอบเสียหาย' }),
          onSubmit: (vals) => ctx.exec('offcut.scrap', { id: o.id, reason: vals.reason }, { quiet: true, done: `ทิ้งเศษ ${o.id} แล้ว` }),
        });
      },
      async undo(ctx, el) {
        const o = offcut(ctx.state, el.dataset.arg);
        if (!o) return;
        const msg = o.status === 'USED'
          ? `เศษ ${o.id} กลับเป็นพร้อมใช้${o.children && o.children.length ? ` และเศษที่เหลือจากการตัดครั้งนั้น (${o.children.join(', ')}) ถูกยกเลิก – ทำได้เมื่อชิ้นเหล่านั้นยังไม่ถูกใช้หรือทิ้ง` : ''} · ประวัติเดิมยังอยู่`
          : `เศษ ${o.id} กลับเป็นพร้อมใช้ · ประวัติการทิ้งยังอยู่`;
        await ctx.dialog({
          title: o.status === 'USED' ? `ยกเลิกการใช้เศษ ${o.id}` : `ยกเลิกการทิ้งเศษ ${o.id}`, submit: 'ยกเลิกรายการ', message: msg,
          body: h.field({ name: 'reason', label: 'เหตุผลการยกเลิก', required: true, wide: true, id: 'oc-undo-reason', placeholder: 'เช่น เลือกเศษผิดชิ้น' }),
          onSubmit: (vals) => ctx.exec('offcut.undo', { id: o.id, reason: vals.reason }, { quiet: true, done: `ยกเลิกรายการของเศษ ${o.id} แล้ว` }),
        });
      },
      findClear: (ctx) => ctx.set({ find: null }),
    },
    forms: {
      async reg(ctx, vals) {
        if (!U.trim(vals.code)) {
          ctx.set({ reg: vals });
          return ctx.toast('เลือกแผ่นต้นทาง (รหัสสินค้าของแผ่นที่ตัด) ก่อนบันทึก', 'bad');
        }
        const r = await ctx.exec('offcut.add', { code: vals.code, material: vals.material, thickness: vals.thickness, width: vals.width, length: vals.length,
          wh: vals.wh, bin: vals.bin, sourceLot: vals.sourceLot, parent: vals.parent || '', createdFrom: vals.createdFrom, remark: vals.remark },
        { done: (res) => `บันทึกเศษ ${res.result.id} แล้ว – เขียนรหัสนี้บนชิ้นเศษ` });
        if (r.ok) ctx.set({ adding: false, reg: null, sel: r.result.id, tab: 'list', st: 'AVAILABLE', _scroll: 'oc-detail' });
        else ctx.set({ reg: vals });
      },
      find(ctx, vals) {
        ctx.set({ find: vals, sel: null }); // a piece opened earlier is not part of this search
      },
    },
  });

  // ---- find ----------------------------------------------------------------------------------------------------------------
  function findView(ctx) {
    const f = ctx.view.find || {};
    const can = ctx.can('offcut.manage');
    const list = plates(ctx.state);
    const jobs = RRS.q.rows(ctx.state, 'jobs', (j) => j.status === 'OPEN' || j.status === 'IN_PROGRESS').sort((a, b) => String(a.jobNo).localeCompare(String(b.jobNo)));
    const form = h.form({
      name: 'find', submit: 'หาเศษที่ใช้ได้', extra: ctx.view.find ? h.btn('ล้าง', { act: 'findClear', tone: 'ghost' }) : '',
      body: [
        h.field({ name: 'material', label: 'วัสดุ', value: f.material, id: 'oc-f-mat', list: 'oc-f-mats', placeholder: 'เช่น SS400' }),
        h.field({ name: 'thickness', label: 'ความหนา (มม.)', type: 'number', value: f.thickness, id: 'oc-f-thk' }),
        h.field({ name: 'width', label: 'ต้องการกว้าง (มม.)', type: 'number', value: f.width, required: true, id: 'oc-f-w' }),
        h.field({ name: 'length', label: 'ต้องการยาว (มม.)', type: 'number', value: f.length, required: true, id: 'oc-f-l' }),
        h.field({ name: 'code', label: 'หรือเลือกแผ่นที่จะใช้ (ใช้วัสดุและความหนาของแผ่น)', type: 'select', value: f.code, id: 'oc-f-code',
          options: list.map((i) => [i.id, `${i.id} · ${i.name}`]), blank: 'ไม่เลือก – ใช้วัสดุ/ความหนาที่กรอก' }),
        h.field({ name: 'wh', label: 'เฉพาะคลัง', type: 'select', value: f.wh, options: h.whOptions(ctx.state), blank: 'ทุกคลัง', id: 'oc-f-wh' }),
        jobs.length ? h.field({ name: 'job', label: 'ใบงานที่จะใช้ (ไม่บังคับ)', type: 'select', value: f.job, id: 'oc-f-job', options: jobs.map((j) => [j.jobNo, `${j.jobNo}${j.product ? ' · ' + j.product : ''}`]),
          blank: 'ไม่ระบุ', hint: 'แผ่นที่จองให้ใบงานนี้นับเป็นแผ่นว่างของงานนี้' }) : '',
        h.field({ name: 'usedFor', label: 'จะใช้กับงาน/แบบ (ไม่บังคับ)', value: f.usedFor, id: 'oc-f-for', hint: 'ใส่ไว้ แล้วตอนกด ใช้เศษนี้ ระบบเติมให้ (ว่าง = เลขใบงาน)' }),
        t`<datalist id="oc-f-mats">${materials(ctx.state).map((m) => t`<option value="${m}"></option>`)}</datalist>`,
      ],
    });
    let result = h.empty('กรอกขนาดชิ้นที่ต้องตัด', 'ระบบหาเศษพร้อมใช้ที่วัสดุ (กลุ่มที่ใช้แทนกันได้) และความหนาตรงกัน ขนาดพอ (หมุน 90° ได้) เรียงจากชิ้นเล็กสุดที่พอดี เพื่อให้เหลือเศษทิ้งน้อยที่สุด');
    if (ctx.view.find) {
      // a chosen plate gives material and thickness (as its label says); typed values only fill what the plate lacks
      const plate = f.code ? RRS.q.get(ctx.state, 'items', f.code) : null;
      const pMat = plate ? U.trim(plate.material) : '';
      const pThk = plate ? Number(plate.thickness) || 0 : 0;
      const q = { material: pMat ? '' : f.material, thickness: pThk ? '' : f.thickness, width: f.width, length: f.length, wh: f.wh || '', code: f.code || '', job: f.job || '' };
      const usedNote = plate && (pMat || pThk) ? ` · วัสดุ ${pMat || U.trim(f.material)} หนา ${h.fmt.num(pThk || U.num(f.thickness))} มม. ตามแผ่น ${plate.id}` : '';
      const r = R().suggestOffcuts(ctx.state, q);
      if (r.problems.length) {
        result = h.note(t`ยังหาไม่ได้ – ${h.errors({ errors: r.problems.map((p) => ({ message: p })) })}`, 'warn');
      } else {
        const tbl = h.table({ id: 'oc-fit', dense: true, scroll: true, rows: r.rows, empty: 'ไม่มีเศษที่ขนาดพอ', emptyText: 'ใช้แผ่นใหม่ตามรายการด้านล่าง',
          cols: [
            { label: 'ลำดับ', num: true, get: (x, i) => i + 1 },
            { label: 'รหัสเศษ (QR)', render: (x) => h.btn(x.id, { act: 'pick', arg: x.id, tone: 'quiet', small: true }) },
            // the action next to the id: on a phone it is on screen without scrolling the table sideways
            { label: '', render: (x) => (can && ctx.can('offcut.manage', x.wh) ? h.btn('ใช้เศษนี้', { act: 'use', arg: x.id, tone: 'primary', small: true }) : '') },
            { label: 'กว้าง × ยาว (มม.)', cls: 'nowrap', get: (x) => size(x) },
            { label: 'เศษทิ้ง (%)', num: true, render: (x) => t`<b>${h.fmt.num(x.wastePct, 1)}</b>` },
            { label: 'หมุน', render: (x) => (x.rotated ? h.badge('หมุน 90°', 'info') : dash) },
            { label: 'ที่เก็บ', render: (x) => h.code(loc(x)) }, { label: 'ล็อต/Heat', get: (x) => x.sourceLot || '' },
            { label: 'วัสดุ', key: 'material' }, { label: 'หนา', num: true, key: 'thickness' },
          ] });
        const platesTbl = r.plates.length ? h.section('แผ่นใหม่ที่มีในคลัง (ใช้เมื่อไม่มีเศษที่พอ)', h.table({ dense: true, rows: r.plates, cols: [
          { label: 'รหัส', render: (x) => h.code(x.code) }, { label: 'ชื่อ', key: 'name' }, { label: 'พร้อมใช้', num: true, render: (x) => h.qty(x.available, x.unit) },
          { label: 'จองให้งานอื่น', num: true, render: (x) => (x.reserved ? h.fmt.num(x.reserved) : dash) },
          { label: 'ว่างให้ใช้', num: true, render: (x) => (x.free != null ? (x.free > 0 ? t`<b>${h.fmt.num(x.free)}</b>` : h.badge('ไม่ว่าง', 'warn')) : dash) },
          { label: 'ขนาดแผ่น (มม.)', get: (x) => (x.width && x.length ? `${h.fmt.num(x.width)} × ${h.fmt.num(x.length)}` : 'ไม่ระบุในทะเบียน') },
          { label: 'เศษทิ้ง (%)', num: true, render: (x) => (x.wastePct == null ? dash : h.fmt.num(x.wastePct, 1)) }] })) : '';
        result = t`${h.note(r.advice, r.rows.length ? 'ok' : 'warn')}
          ${r.blocked.length ? h.note(`ไม่แนะนำเพราะล็อตต้นทางถูกกักกัน: ${r.blocked.map((b) => `${b.id} (${b.reason})`).join(', ')}`, 'bad') : ''}
          ${h.section(`เศษที่ใช้ได้ ${h.fmt.num(r.rows.length)} ชิ้น`, tbl, { sub: `ต้องการ ${h.fmt.num(U.num(f.width))} × ${h.fmt.num(U.num(f.length))} มม.${usedNote} · เรียงจากชิ้นเล็กสุดที่พอ · เศษทิ้ง = พื้นที่ที่เหลือหลังตัด ÷ พื้นที่ชิ้นเศษ` })}
          ${platesTbl}`;
      }
    }
    return t`${h.section('ชิ้นที่ต้องตัด', form, { sub: 'กรอกวัสดุและความหนา หรือเลือกแผ่นที่จะใช้ แล้วใส่ขนาดที่ต้องการ (มม.)' })}${result}`;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
