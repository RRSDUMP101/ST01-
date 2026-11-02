/*
 * Phase 4 – ขอซื้อ สั่งซื้อ และรับของ (src/engine/purchasing.js). Four tabs:
 *   ขอซื้อ (PR)     pr.create (draft / submit, lines: code, qty in the base unit, need date, warehouse, supplier, reason),
 *                   pr.approve / pr.reject by someone other than the requester (separation of duties), pr.cancel
 *   สั่งซื้อ (PO)    po.create from approved PRs (lines pulled and rounded to buy units, MOQ and pack, then editable) or by
 *                   hand; po.issue, po.setDue, po.cancelLine, po.cancel, po.close (purchasing lead), po.allowOverReceive
 *   รับของตาม PO    po.receive: per line qty in the buy unit, warehouse, bin, lot/heat and the material certificate number
 *                   (lot.update after the receipt); items needing incoming QC land in รอตรวจ
 *   คืนผู้ขาย       po.return from a stock location, with or without a replacement (replacement reopens the PO line)
 * Every check is the engine's; the screen checks first (ctx.check) and shows the engine's Thai errors.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const U = RRS.util;
  const inv = RRS.inventory;
  const P = () => RRS.purchasing || null;

  const LIMIT = 200;
  const dash = t`<span class="muted">–</span>`;
  const low = (s) => String(s == null ? '' : s).toLowerCase();
  const has = (v) => v != null && v !== '';
  const OPEN = { ISSUED: true, PARTIAL: true };
  const ORDERABLE = { APPROVED: true, CONVERTED: true };
  const PR_TONE = { DRAFT: 'muted', SUBMITTED: 'warn', APPROVED: 'ok', REJECTED: 'bad', CONVERTED: 'info', CANCELLED: 'muted' };
  const PO_TONE = { DRAFT: 'muted', ISSUED: 'info', PARTIAL: 'warn', RECEIVED: 'ok', CLOSED: 'muted', CANCELLED: 'bad' };
  const PR_ACT = { create: 'สร้าง', update: 'แก้ไข', submit: 'ส่งขออนุมัติ', approve: 'อนุมัติ', reject: 'ไม่อนุมัติ', cancel: 'ยกเลิก',
    cancelRest: 'ยกเลิกส่วนที่ยังไม่ออก PO', convert: 'ออกใบสั่งซื้อ' };
  const PO_ACT = { create: 'สร้างร่าง', issue: 'ออกใบสั่งซื้อ (ส่งผู้ขาย)', due: 'เลื่อนกำหนดเข้า', cancelLine: 'ยกเลิกยอดค้าง', cancel: 'ยกเลิกทั้งใบ',
    close: 'ปิดยอดค้าง', allowOver: 'อนุมัติรับเกิน', receive: 'รับของ', receiveUndo: 'ยกเลิกใบรับ', return: 'คืนผู้ขาย', returnUndo: 'ยกเลิกใบคืน' };
  const RV_STATUSES = (inv.DOC_TYPES.RV && inv.DOC_TYPES.RV.outStatuses) || ['AVAILABLE', 'QUARANTINE', 'REWORK'];

  const prBadge = (s) => h.badge((P().PR_STATUS || {})[s] || s, PR_TONE[s]);
  const poBadge = (s) => h.badge((P().PO_STATUS || {})[s] || s, PO_TONE[s]);
  const out = (l) => P().lineOutstanding(l);
  const kept = (l) => Math.max(0, U.round((l.received || 0) + (l.replaced || 0) - (l.returned || 0)));
  const toBuy = (base, l) => U.round(base / (l.factor || 1), 4);
  const n = (v) => h.fmt.num(v);
  const docView = (docNo) => ({ sel: docNo, lines: null, checked: null, header: null, tab: 'all', q: '', type: '' });
  const docLink = (docNo) => h.link(h.code(docNo), 'docs', docView(docNo));
  const prView0 = (prNo) => ({ tab: 'pr', pr: prNo, prLines: null, prHead: null, prChecked: null, _scroll: true });
  const prLink = (prNo) => h.link(h.code(prNo), 'purchasing', prView0(prNo));
  const poLink = (poNo) => h.link(h.code(poNo), 'purchasing', { tab: 'po', po: poNo, _scroll: true });
  const whoCan = (perm) => RRS.auth.rolesFor(perm).filter((r) => r !== 'admin').map((r) => RRS.auth.ROLES[r] || r).join(' / ');
  const formOf = (name) => root.document.querySelector(`#main form[data-form="${name}"]`);
  const late = (ctx, po, l) => (OPEN[po.status] && l.dueDate && l.dueDate < ctx.today && out(l) > 0
    ? h.badge(`เลยกำหนด ${U.daysBetween(l.dueDate, ctx.today)} วัน`, 'bad') : '');
  const fail = (msg) => ({ ok: false, errors: [{ message: msg }] });
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
  const lotRef = (code, lot) => (RRS.ui.pages.lots ? h.link(lot, 'lots', { tab: 'list', sel: code + '|' + lot, _scroll: true }) : lot);

  function settings(state) {
    const d = RRS.defaultSettings();
    const s = RRS.q.get(state, 'settings', 'main') || {};
    return Object.assign({}, d, s, { policies: Object.assign({}, d.policies, s.policies), express: Object.assign({}, d.express, s.express) });
  }
  function defWh(ctx) {
    const w = settings(ctx.state).express.defaultWarehouse;
    const whs = RRS.q.rows(ctx.state, 'warehouses', (x) => x.active !== false);
    if (w && whs.some((x) => x.code === w)) return w;
    return whs.length === 1 ? whs[0].code : '';
  }
  function supOptions(state) {
    return RRS.q.rows(state, 'suppliers', (s) => s.active !== false).sort((a, b) => a.id.localeCompare(b.id)).map((s) => [s.id, `${s.id} · ${s.name}`]);
  }
  const supName = (state, id) => ((state.tables.suppliers || {})[id] || {}).name || '';
  const itemOf = (ctx, code) => (ctx.state.tables.items || {})[code] || {};

  /** Editable lines (like h.lineEditor) that also take date inputs, read-only cells and hidden fields. */
  function lineEditor(o) {
    const vis = o.cols.filter((c) => c.type !== 'hidden');
    const hid = o.cols.filter((c) => c.type === 'hidden');
    const list = o.lines && o.lines.length ? o.lines : [{}];
    const rows = list.map((ln, i) => t`<tr>${vis.map((c, ci) => {
      const nm = `${o.name}[${i}][${c.key}]`;
      const val = ln[c.key] == null ? '' : ln[c.key];
      let input;
      if (c.options) {
        input = t`<select name="${nm}" aria-label="${c.label}"><option value="">${c.blank || '–'}</option>${c.options.map(([ov, ol]) => t`<option value="${ov}"${h.safe(String(ov) === String(val) ? ' selected' : '')}>${ol}</option>`)}</select>`;
      } else {
        const type = c.type === 'number' ? 'number' : c.type === 'date' ? 'date' : 'text';
        input = t`<input name="${nm}" aria-label="${c.label}" type="${type}" value="${val}"${h.safe(type === 'number' ? ' step="any" inputmode="decimal"' : '')}${h.safe(h.attr('list', c.list))}${h.safe(h.attr('placeholder', c.placeholder))}${h.safe(c.readonly ? ' readonly tabindex="-1"' : '')}>`;
      }
      const hidden = ci === 0 ? hid.map((c2) => t`<input type="hidden" name="${o.name}[${i}][${c2.key}]" value="${ln[c2.key] == null ? '' : ln[c2.key]}">`) : '';
      return t`<td${h.safe(c.w ? ` style="width:${h.esc(c.w)}"` : '')}>${hidden}${input}</td>`;
    })}<td class="le-x">${h.btn('×', { act: o.removeAct, arg: i, tone: 'quiet', small: true, title: 'ลบบรรทัด' })}</td></tr>`);
    return t`<div class="tbl-wrap le"${h.safe(h.attr('id', o.id))}><table class="tbl dense"><thead><tr>${vis.map((c) => t`<th>${c.label}</th>`)}<th></th></tr></thead><tbody>${rows}</tbody></table></div><div class="le-add">${h.btn('+ เพิ่มบรรทัด', { act: o.addAct, tone: 'ghost', small: true })}</div>`;
  }
  /** Result of a check / failed save: the engine's errors, or OK with its warnings. */
  function checkNote(r, okText) {
    if (!r) return '';
    if (r.ok) {
      const ws = r.warnings || [];
      return t`${okText ? h.note(okText, 'ok') : ''}${ws.length ? h.note(t`ข้อควรรู้ก่อนบันทึก:<ul>${ws.map((w) => t`<li>${w}</li>`)}</ul>`, 'warn') : ''}`;
    }
    return h.note(t`บันทึกไม่ได้ – ยังไม่มีอะไรเปลี่ยน${h.errors(r)}`, 'bad');
  }
  function logTable(ctx, log, labels) {
    const rows = (log || []).slice().reverse().slice(0, 40);
    if (!rows.length) return '';
    return h.section('ประวัติ', h.table({ rows, dense: true, cols: [
      { label: 'เวลา', get: (e) => h.fmt.dt(e.at) },
      { label: 'ผู้ทำ', get: (e) => ctx.userName(e.by) },
      { label: 'รายการ', get: (e) => labels[e.action] || e.action },
      { label: 'รายละเอียด', render: (e) => {
        const parts = [];
        if (has(e.line)) parts.push(`บรรทัด ${e.line}`);
        if (has(e.qty)) parts.push(`${n(e.qty)} (หน่วยหลัก)`);
        if (e.from || e.to) parts.push(`${h.fmt.date(e.from)} → ${h.fmt.date(e.to)}`);
        if (e.poNo) parts.push(e.poNo);
        if (e.prNos && e.prNos.length) parts.push('จาก ' + e.prNos.join(', '));
        if (e.replace) parts.push(`ขอของทดแทน ${n(e.replace)}`);
        if (e.overUse) parts.push(`ใช้สิทธิ์รับเกิน ${n(e.overUse)}`);
        if (e.reason) parts.push(e.reason);
        if (e.remark) parts.push(e.remark);
        return t`${e.docNo ? t`${docLink(e.docNo)} ` : ''}${parts.join(' · ')}`;
      } },
    ] }), { sub: 'ทุกขั้นตอนเก็บผู้ทำและเวลา ไม่มีการลบ' });
  }

  // ======================================================================================================
  // ขอซื้อ (PR)
  // ======================================================================================================
  function prCols(ctx) {
    return [
      { key: 'code', label: 'รหัสสินค้า', list: 'dl-items', w: '18%', placeholder: 'พิมพ์หรือเลือก' },
      { key: 'qty', label: 'จำนวน (หน่วยหลัก)', type: 'number', w: '11%' },
      { key: 'needDate', label: 'วันต้องใช้', type: 'date', w: '14%' },
      { key: 'wh', label: 'เข้าคลัง', options: h.whOptions(ctx.state), w: '13%' },
      { key: 'supplier', label: 'ผู้ขาย (ถ้ารู้)', options: supOptions(ctx.state), blank: 'ไม่ระบุ', w: '15%' },
      { key: 'reason', label: 'เหตุผล / ใช้กับงาน' },
    ];
  }
  const prLineIn = (l) => ({ code: l.code, qty: l.qty, needDate: l.needDate, wh: l.wh, supplier: l.supplier, reason: l.reason });
  function prPayload(vals, prNo, draft) {
    return { prNo: prNo || '', draft: !!draft, date: vals.date, remark: vals.remark, lines: h.cleanLines(vals.lines, 'code').map(prLineIn) };
  }
  function sodNote() {
    return h.note(`ผู้ขออนุมัติใบของตัวเองไม่ได้ (แยกหน้าที่) – หลังส่ง ${whoCan('pr.approve')} คนอื่นเป็นผู้อนุมัติหรือไม่อนุมัติ`, 'info');
  }
  function prEditor(ctx, pr) {
    const v = ctx.view;
    const lines = v.prLines || (pr ? pr.lines.map(prLineIn) : [{ wh: defWh(ctx) }]);
    const hd = v.prHead || (pr ? { date: pr.date, remark: pr.remark } : { date: ctx.today });
    return h.form({
      name: 'prSave', submit: 'ส่งขออนุมัติ',
      extra: [h.btn('บันทึกร่าง', { act: 'prDraft', tone: 'ghost' }), h.btn('ตรวจก่อนส่ง', { act: 'prCheck', tone: 'ghost' }),
        pr ? h.btn('ยกเลิกร่างนี้', { act: 'prCancel', tone: 'quiet' }) : h.btn('ปิด', { act: 'prClose', tone: 'quiet' })],
      body: [
        h.field({ name: 'date', label: 'วันที่ขอ', type: 'date', value: hd.date, id: 'pr-date' }),
        h.field({ name: 'remark', label: 'หมายเหตุ', value: hd.remark, id: 'pr-remark', placeholder: 'เช่น ของใช้กับงาน SO…' }),
        t`<div class="wide">${lineEditor({ name: 'lines', cols: prCols(ctx), lines, addAct: 'prAdd', removeAct: 'prRemove', id: 'pr-lines' })}</div>`,
        t`<p class="hint wide">จำนวนเป็นหน่วยหลักของสินค้า (ชื่อและหน่วยขึ้นในรายการรหัส) · วันต้องใช้ = วันที่ของต้องถึงโรงงาน · ไม่รู้ผู้ขายเว้นไว้ได้ จัดซื้อเลือกตอนออกใบสั่งซื้อ</p>`,
        t`<div class="wide">${sodNote()}</div>`,
        v.prChecked ? t`<div class="wide">${checkNote(v.prChecked, 'ตรวจแล้ว: ส่งขออนุมัติได้ทุกบรรทัด')}</div>` : '',
      ],
    });
  }
  function prView(ctx, pr) {
    const me = ctx.user ? ctx.user.id : '';
    const o = P().prOpen(ctx.state, pr.prNo);
    const anyOpen = o.lines.some((l) => l.open > 0);
    const mine = pr.requestedBy === me;
    const acts = [];
    const notes = [];
    if (pr.status === 'SUBMITTED') {
      if (ctx.can('pr.approve')) {
        if (mine) {
          notes.push(h.note(`คุณเป็นผู้ขอใบนี้ – อนุมัติหรือไม่อนุมัติเองไม่ได้ (แยกหน้าที่) ให้ ${whoCan('pr.approve')} คนอื่นพิจารณา`, 'warn'));
          acts.push(h.btn('อนุมัติ', { disabled: true, title: 'ผู้ขออนุมัติใบของตัวเองไม่ได้' }), h.btn('ไม่อนุมัติ', { disabled: true, title: 'ผู้ขอพิจารณาใบของตัวเองไม่ได้' }));
        } else {
          acts.push(h.btn('อนุมัติ', { act: 'prApprove', tone: 'primary' }), h.btn('ไม่อนุมัติ', { act: 'prReject', tone: 'ghost' }));
        }
      } else {
        notes.push(h.note(`รออนุมัติจาก ${whoCan('pr.approve')} (ต้องเป็นคนละคนกับผู้ขอ)`, 'info'));
      }
    }
    if (ORDERABLE[pr.status] && !pr.restCancelled && anyOpen) {
      if (ctx.can('po.manage')) acts.push(h.btn('ออกใบสั่งซื้อจากใบนี้', { act: 'prToPo', tone: 'primary' }));
      else notes.push(h.note(`อนุมัติแล้ว – รอ${whoCan('po.manage')}ออกใบสั่งซื้อ`, 'ok'));
    }
    const canCancel = ctx.can('pr.approve') || (mine && ctx.can('pr.create'));
    if (canCancel && ['DRAFT', 'SUBMITTED', 'APPROVED'].indexOf(pr.status) >= 0) acts.push(h.btn('ยกเลิกใบขอซื้อ', { act: 'prCancel', tone: 'danger' }));
    if (canCancel && pr.status === 'CONVERTED' && !pr.restCancelled && anyOpen) acts.push(h.btn('ยกเลิกส่วนที่ยังไม่ออก PO', { act: 'prCancel', tone: 'ghost' }));
    if (pr.status === 'DRAFT' && !mine) notes.push(h.note(`ร่างของ ${ctx.userName(pr.requestedBy)} – ผู้ขอเท่านั้นที่แก้หรือส่งขออนุมัติได้`, 'info'));
    const tbl = h.table({ rows: o.lines, dense: true, cols: [
      { label: '#', key: 'line' },
      { label: 'สินค้า', render: (l) => t`${h.code(l.code)} ${itemOf(ctx, l.code).name || l.name || ''}` },
      { label: 'จำนวน', num: true, render: (l) => h.qty(l.qty, l.baseUnit || itemOf(ctx, l.code).baseUnit) },
      { label: 'ต้องใช้', get: (l) => h.fmt.date(l.needDate) },
      { label: 'คลัง', render: (l) => h.code(l.wh) },
      { label: 'ผู้ขาย', render: (l) => (l.supplier ? h.code(l.supplier) : dash) },
      { label: 'ออก PO แล้ว', num: true, render: (l) => (l.ordered ? n(l.ordered) : dash) },
      { label: 'ค้างออก PO', num: true, render: (l) => (l.open ? t`<b>${n(l.open)}</b>` : dash) },
      { label: 'เหตุผล', render: (l) => l.reason || dash },
    ] });
    return t`${h.dl([
      ['สถานะ', prBadge(pr.status)], ['วันที่', h.fmt.date(pr.date)], ['ผู้ขอ', `${ctx.userName(pr.requestedBy)} · ${h.fmt.dt(pr.requestedAt)}`],
      pr.submittedBy ? ['ส่งขออนุมัติ', `${ctx.userName(pr.submittedBy)} · ${h.fmt.dt(pr.submittedAt)}`] : null,
      pr.approvedBy ? ['อนุมัติโดย', `${ctx.userName(pr.approvedBy)} · ${h.fmt.dt(pr.approvedAt)}`] : null,
      pr.rejectedBy ? ['ไม่อนุมัติโดย', `${ctx.userName(pr.rejectedBy)} · ${h.fmt.dt(pr.rejectedAt)} · ${pr.rejectReason}`] : null,
      pr.cancelledBy ? ['ยกเลิกโดย', `${ctx.userName(pr.cancelledBy)} · ${h.fmt.dt(pr.cancelledAt)} · ${pr.cancelReason}`] : null,
      pr.restCancelled ? ['ยกเลิกส่วนที่เหลือ', `${ctx.userName(pr.restCancelled.by)} · ${h.fmt.dt(pr.restCancelled.at)} · ${pr.restCancelled.reason}`] : null,
      (pr.poNos || []).length ? ['ใบสั่งซื้อ', t`${(pr.poNos || []).map((x) => t`${poLink(x)} `)}`] : null,
      pr.source ? ['ที่มา', pr.source] : null, pr.remark ? ['หมายเหตุ', pr.remark] : null,
    ])}${notes}${acts.length ? t`<div class="form-actions">${acts}</div>` : ''}${tbl}${logTable(ctx, pr.log, PR_ACT)}`;
  }
  function prTab(ctx) {
    const v = ctx.view;
    const me = ctx.user ? ctx.user.id : '';
    const canCreate = ctx.can('pr.create');
    const canApprove = ctx.can('pr.approve');
    const all = P().prs(ctx.state);
    if (!all.length && v.pr !== '__new') {
      return t`${sodNote()}${h.empty('ยังไม่มีใบขอซื้อ', canCreate
        ? 'กด + สร้างใบขอซื้อ แล้วใส่รหัส จำนวน วันต้องใช้ และคลัง หรือเลือกรายการที่ต้องสั่งจากหน้า แผนเติมสต็อก ระบบสร้างใบขอซื้อให้'
        : `ผู้ขอซื้อ (${whoCan('pr.create')}) เป็นผู้สร้าง – ใบที่ส่งมาจะขึ้นที่นี่`,
      t`<div class="form-actions">${canCreate ? h.btn('+ สร้างใบขอซื้อ', { act: 'newPr', tone: 'primary' }) : ''}${h.link('ไปแผนเติมสต็อก', 'replenish')}</div>`)}`;
    }
    const items = ctx.state.tables.items || {};
    const q = low(v.prQ).trim();
    const rows = all.filter((pr) => (!v.prSt || pr.status === v.prSt) && (!q || [pr.prNo, pr.remark, pr.source, ctx.userName(pr.requestedBy)]
      .concat(pr.lines.map((l) => l.code), pr.lines.map((l) => (items[l.code] || {}).name)).some((x) => low(x).indexOf(q) >= 0)))
      .sort((a, b) => {
        const wa = a.status === 'SUBMITTED' && canApprove && a.requestedBy !== me ? 0 : 1;
        const wb = b.status === 'SUBMITTED' && canApprove && b.requestedBy !== me ? 0 : 1;
        return wa - wb || b.prNo.localeCompare(a.prNo);
      });
    const limit = v.prLimit || LIMIT;
    const list = h.table({
      id: 'pr-list', scroll: true, rows: rows.slice(0, limit), rowAct: 'pickPr', rowArg: (pr) => pr.prNo, rowCls: (pr) => (pr.prNo === v.pr ? 'sel' : ''),
      empty: 'ไม่พบใบขอซื้อตามตัวกรอง', emptyText: 'ลองเลือกทุกสถานะ หรือคำค้นอื่น',
      cols: [
        { label: 'เลขที่', render: (pr) => h.code(pr.prNo) },
        { label: 'วันที่', get: (pr) => h.fmt.date(pr.date) },
        { label: 'ผู้ขอ', get: (pr) => ctx.userName(pr.requestedBy) },
        { label: 'รายการ', render: (pr) => t`${h.code(pr.lines[0] ? pr.lines[0].code : '')}${pr.lines.length > 1 ? t` <small class="muted">+${pr.lines.length - 1}</small>` : ''}` },
        { label: 'ต้องใช้', get: (pr) => h.fmt.date(pr.lines.map((l) => l.needDate).filter(Boolean).sort()[0] || '') },
        { label: 'สถานะ', render: (pr) => prBadge(pr.status) },
      ],
    });
    const more = rows.length > limit ? t`<p class="hint">แสดง ${n(limit)} จาก ${n(rows.length)} ใบ ${h.btn('แสดงเพิ่ม', { act: 'more', arg: 'prLimit', tone: 'ghost', small: true })}</p>` : t`<p class="hint">${n(rows.length)} ใบ</p>`;
    const sel = v.pr && v.pr !== '__new' ? RRS.q.get(ctx.state, 'prs', v.pr) : null;
    let detail = h.empty('เลือกใบขอซื้อจากรายการ', 'ดูบรรทัด ผู้ขอ ผู้อนุมัติ ใบสั่งซื้อที่ออกแล้ว และประวัติ');
    if (v.pr === '__new' && canCreate) detail = h.section('สร้างใบขอซื้อ', prEditor(ctx, null), { id: 'p4-detail', sub: 'ส่งขออนุมัติทันที หรือบันทึกร่างไว้แก้ต่อ' });
    else if (sel) {
      const edit = sel.status === 'DRAFT' && sel.requestedBy === me && canCreate;
      detail = h.section(t`${h.code(sel.prNo)} ใบขอซื้อ ${prBadge(sel.status)}`, edit ? t`${prEditor(ctx, sel)}${logTable(ctx, sel.log, PR_ACT)}` : prView(ctx, sel), {
        id: 'p4-detail', sub: edit ? 'ร่างของคุณ – แก้แล้วกด ส่งขออนุมัติ หรือ บันทึกร่าง' : '' });
    }
    const st = [['DRAFT', 'ร่าง'], ['SUBMITTED', 'รออนุมัติ'], ['APPROVED', 'อนุมัติแล้ว'], ['CONVERTED', 'ออก PO แล้ว'], ['REJECTED', 'ไม่อนุมัติ'], ['CANCELLED', 'ยกเลิก']];
    return t`${h.toolbar([
      h.field({ name: 'prQ', label: 'ค้นหา', value: v.prQ, placeholder: 'เลขที่ รหัสสินค้า ผู้ขอ…', id: 'pr-q', act: 'prQ', live: true }),
      h.field({ name: 'prSt', label: 'สถานะ', type: 'select', value: v.prSt, options: st, blank: 'ทุกสถานะ', id: 'pr-st', act: 'prSt' }),
    ], canCreate ? h.btn('+ สร้างใบขอซื้อ', { act: 'newPr', tone: 'primary' }) : '')}
      <div class="split"><div>${list}${more}</div><div>${detail}</div></div>`;
  }

  // ======================================================================================================
  // สั่งซื้อ (PO)
  // ======================================================================================================
  function poCols(ctx) {
    return [
      { key: 'code', label: 'รหัสสินค้า', list: 'dl-items', w: '16%', placeholder: 'พิมพ์หรือเลือก' },
      { key: 'qty', label: 'จำนวน (หน่วยซื้อ)', type: 'number', w: '9%' },
      { key: 'unit', label: 'หน่วยซื้อ', placeholder: 'ตามที่ตั้งไว้', w: '9%' },
      { key: 'price', label: 'ราคา/หน่วย', type: 'number', placeholder: 'ตามที่ตั้งไว้', w: '10%' },
      { key: 'dueDate', label: 'กำหนดเข้า', type: 'date', w: '13%' },
      { key: 'wh', label: 'เข้าคลัง', options: h.whOptions(ctx.state), w: '11%' },
      { key: 'prNo', label: 'ใบขอซื้อ', readonly: true, w: '11%' },
      { key: 'prLine', type: 'hidden' },
      { key: 'remark', label: 'หมายเหตุ' },
    ];
  }
  function orderablePrs(ctx) {
    return P().prs(ctx.state).filter((pr) => ORDERABLE[pr.status] && !pr.restCancelled)
      .map((pr) => P().prOpen(ctx.state, pr.prNo)).filter((pr) => pr && pr.lines.some((l) => l.open > 0));
  }
  /** PO lines from the open part of approved PRs: buy unit, qty rounded up to whole buy units / MOQ / pack, price set with the supplier. */
  function pullLines(ctx, prNos, supId, poDate) {
    const lines = [];
    const notes = [];
    for (const prNo of prNos || []) {
      const pr = P().prOpen(ctx.state, prNo);
      if (!pr) continue;
      for (const l of pr.lines) {
        if (!(l.open > 0)) continue;
        if (l.supplier && l.supplier !== supId) {
          notes.push(`${prNo} บรรทัด ${l.line} ${l.code} ไม่ได้ดึง – ใบขอซื้อระบุผู้ขาย ${l.supplier} (เลือกผู้ขายนั้นเพื่อออกอีกใบ)`);
          continue;
        }
        const link = RRS.q.get(ctx.state, 'item_suppliers', l.code + '|' + supId);
        const ok = !!link && link.active !== false;
        const it = itemOf(ctx, l.code);
        const qty = P().roundBuy(l.open, ok ? link.factor : 1, ok ? link.moq || 0 : 0, ok ? link.pack || 0 : 0);
        let due = l.needDate || '';
        if (due && poDate && due < poDate) {
          notes.push(`${l.code}: วันต้องใช้ ${h.fmt.date(due)} ผ่านไปแล้ว – ตั้งกำหนดเข้าเป็นวันที่ใบสั่งซื้อ แก้ตามวันที่ผู้ขายยืนยัน`);
          due = poDate;
        }
        if (!ok) notes.push(`${l.code} ยังไม่ได้ตั้งราคา/หน่วยซื้อกับผู้ขาย ${supId} – ใช้หน่วยหลัก ${it.baseUnit || ''} และต้องใส่ราคาเอง`);
        else if (!has(link.price)) notes.push(`${l.code} ยังไม่มีราคากับผู้ขาย ${supId} – ใส่ราคาต่อ${link.buyUnit} (ระบบไม่เดาราคา)`);
        else if (U.round(qty * link.factor) > l.open) notes.push(`${l.code}: ขอ ${n(l.open)} ${it.baseUnit || ''} ปัดเป็น ${n(qty)} ${link.buyUnit} (= ${n(U.round(qty * link.factor))} ${it.baseUnit || ''}) ตามหน่วยซื้อ${link.moq ? ' / ขั้นต่ำ ' + n(link.moq) : ''}${link.pack ? ' / แพ็กละ ' + n(link.pack) : ''}`);
        lines.push({ code: l.code, qty, unit: ok ? link.buyUnit : it.baseUnit || '', price: ok && has(link.price) ? link.price : '', dueDate: due, wh: l.wh, prNo, prLine: l.line, remark: '' });
      }
    }
    return { lines, notes };
  }
  function poPayload(vals) {
    const lines = h.cleanLines(vals.lines, 'code').map((l) => ({ code: l.code, qty: l.qty, unit: l.unit, price: l.price, dueDate: l.dueDate, wh: l.wh,
      prNo: l.prNo || '', prLine: l.prLine || '', remark: l.remark }));
    const prNos = [];
    for (const l of lines) if (l.prNo && prNos.indexOf(l.prNo) < 0) prNos.push(l.prNo);
    return { supplier: vals.supplier, date: vals.date, remark: vals.remark, prNos, lines };
  }
  const poHead = (vals) => ({ supplier: vals.supplier, date: vals.date, remark: vals.remark });
  /** The PO row a check would store (the commit's effect), else the result lines. */
  function checkedPo(r) {
    const e = r && r.commit && (r.commit.effects || []).find((x) => x.t === 'pos');
    return e ? e.v : null;
  }
  function poPreview(ctx, r) {
    if (!r) return '';
    if (!r.ok) return checkNote(r);
    const po = checkedPo(r);
    const lines = po ? po.lines : (r.result.lines || []);
    const tbl = h.table({ rows: lines, dense: true, cols: [
      { label: '#', key: 'line' },
      { label: 'สินค้า', render: (l) => t`${h.code(l.code)} ${itemOf(ctx, l.code).name || ''}` },
      { label: 'สั่ง', num: true, render: (l) => t`${h.qty(l.qty, l.unit)}${l.factor && l.factor !== 1 ? t` <span class="muted">(= ${n(l.base)} ${l.baseUnit || itemOf(ctx, l.code).baseUnit})</span>` : ''}` },
      { label: 'ราคา/หน่วย', num: true, render: (l) => (has(l.price) ? h.fmt.money(l.price) : dash) },
      { label: 'มูลค่า', num: true, render: (l) => (has(l.amount) ? h.fmt.money(l.amount) : dash) },
      { label: 'กำหนดเข้า', get: (l) => h.fmt.date(l.dueDate) },
      { label: 'ใบขอซื้อ', render: (l) => (l.prNo ? h.code(`${l.prNo}/${l.prLine}`) : dash) },
    ] });
    return t`${checkNote(r, `ตรวจแล้ว: สร้างร่างได้${po ? ` · มูลค่ารวม ${h.fmt.money(po.total)} บาท` : ''}`)}${tbl}`;
  }
  function poEditor(ctx) {
    const v = ctx.view;
    const sups = supOptions(ctx.state);
    if (!sups.length) {
      return h.empty('ยังไม่มีผู้ขายที่ใช้งาน', 'เพิ่มผู้ขาย และตั้งราคา/หน่วยซื้อที่หน้า ผู้ขายและเงื่อนไขซื้อ ก่อนออกใบสั่งซื้อ',
        t`<div class="form-actions">${h.link('ไปหน้าผู้ขาย', 'suppliers')}${h.btn('ปิด', { act: 'poClose', tone: 'quiet', small: true })}</div>`);
    }
    const mode = v.poMode === 'hand' ? 'hand' : 'pr';
    const hd = v.poHead || { date: ctx.today, supplier: '' };
    const prs = orderablePrs(ctx);
    const lines = v.poLines || [{ wh: defWh(ctx) }];
    const body = [
      h.field({ name: 'supplier', label: 'ผู้ขาย', type: 'select', value: hd.supplier, options: sups, required: true, blank: '— เลือกผู้ขาย —', id: 'po-sup', act: 'poSupChange' }),
      h.field({ name: 'date', label: 'วันที่ใบสั่งซื้อ', type: 'date', value: hd.date, id: 'po-date' }),
      h.field({ name: 'remark', label: 'หมายเหตุ', value: hd.remark, id: 'po-remark' }),
      h.field({ name: 'mode', label: 'รายการมาจาก', type: 'radio', value: mode, options: [['pr', 'ใบขอซื้อที่อนุมัติแล้ว'], ['hand', 'พิมพ์รายการเอง']], act: 'poMode', wide: true }),
    ];
    if (mode === 'pr') {
      body.push(prs.length ? t`<div class="wide">${h.field({ name: 'prNos', label: 'เลือกใบขอซื้อที่จะออกใบสั่งซื้อ', type: 'multiselect', value: v.poPrs || [],
        options: prs.map((pr) => [pr.prNo, `${pr.prNo} · ${pr.lines.filter((l) => l.open > 0).map((l) => l.code).join(', ')} · ${ctx.userName(pr.requestedBy)}`]) })}
        <div class="form-actions">${h.btn('ดึงบรรทัดจากใบขอซื้อที่เลือก', { act: 'poPull', tone: 'ghost', small: true })}<small class="hint">ระบบปัดเป็นหน่วยซื้อเต็ม ขั้นต่ำ MOQ และทวีคูณแพ็กของผู้ขายนี้ แล้วแก้ได้ก่อนสร้าง</small></div></div>`
        : t`<div class="wide">${h.note('ยังไม่มีใบขอซื้อที่อนุมัติแล้วรอออกใบสั่งซื้อ – เลือก พิมพ์รายการเอง หรือรอใบขอซื้อที่อนุมัติ', 'info')}</div>`);
    }
    if (v.poNotes && v.poNotes.length) body.push(t`<div class="wide">${h.note(t`จากใบขอซื้อ:<ul>${v.poNotes.map((x) => t`<li>${x}</li>`)}</ul>`, 'warn')}</div>`);
    body.push(t`<div class="wide">${lineEditor({ name: 'lines', cols: poCols(ctx), lines, addAct: 'poAdd', removeAct: 'poRemove', id: 'po-lines' })}</div>`);
    body.push(t`<p class="hint wide">จำนวนเป็นหน่วยซื้อ · หน่วยซื้อและราคาที่เว้นว่างใช้ค่าที่ตั้งไว้กับผู้ขายนี้ (ถ้ายังไม่ได้ตั้งราคา ต้องใส่เอง – ระบบไม่เดาราคา) · กำหนดเข้าว่าง = วันต้องใช้ของใบขอซื้อ</p>`);
    if (v.poChecked) body.push(t`<div class="wide">${poPreview(ctx, v.poChecked)}</div>`);
    return h.form({ name: 'poSave', submit: 'สร้างร่างใบสั่งซื้อ', body,
      extra: [h.btn('ตรวจก่อนสร้าง', { act: 'poCheck', tone: 'ghost' }), h.btn('ปิด', { act: 'poClose', tone: 'quiet' })] });
  }
  function poDocs(state, poNo) {
    return RRS.q.rows(state, 'documents', (d) => (d.type === 'RR' || d.type === 'RV') && d.status !== 'DRAFT'
      && (d.ref === poNo || d.source === 'po:' + poNo || (d.lines || []).some((l) => l.poNo === poNo)))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  function docsTable(ctx, docs) {
    return h.table({ rows: docs, dense: true, empty: 'ยังไม่มีการรับหรือคืนของ', emptyText: 'ใบรับ (RR) และใบคืนผู้ขาย (RV) ของใบสั่งซื้อนี้จะขึ้นที่นี่', cols: [
      { label: 'เอกสาร', render: (d) => docLink(d.docNo) },
      { label: 'ประเภท', get: (d) => (d.type === 'RR' ? 'รับของ' : 'คืนผู้ขาย') },
      { label: 'วันที่', get: (d) => h.fmt.date(d.date) },
      { label: 'รายการ', render: (d) => t`${d.lines.map((l) => t`${h.code(l.code)} ${n(Math.abs(l.base != null ? l.base : l.qty))}${l.status && l.status !== 'AVAILABLE' ? t` ${h.statusBadge(l.status)}` : ''}${l.lot ? t` <small class="muted">${l.lot}</small>` : ''}<br>`)}` },
      { label: 'สถานะ', render: (d) => h.docStatus(d.status) },
      { label: 'ผู้บันทึก', get: (d) => ctx.userName(d.postedBy || d.createdBy) },
    ] });
  }
  function poView(ctx, po) {
    const canM = ctx.can('po.manage');
    const open = OPEN[po.status];
    const editable = open || po.status === 'DRAFT';
    const docs = poDocs(ctx.state, po.poNo);
    const anyReceipt = po.lines.some((l) => (l.received || 0) > 0 || (l.returned || 0) > 0);
    const anyKept = po.lines.some((l) => kept(l) > 0);
    const acts = [];
    const notes = [];
    if (po.status === 'DRAFT') {
      notes.push(h.note('ร่าง: ผู้ขายยังไม่ได้รับ และสโตร์ยังรับของตามใบนี้ไม่ได้ – ตรวจแล้วกด ออกใบสั่งซื้อ · ร่างแก้บรรทัดไม่ได้ ถ้าผิดให้ยกเลิกยอดของบรรทัดนั้นหรือยกเลิกใบแล้วสร้างใหม่', 'info'));
      if (canM) acts.push(h.btn('ออกใบสั่งซื้อ (ส่งผู้ขายแล้ว)', { act: 'poIssue', tone: 'primary' }), h.btn('ยกเลิกใบสั่งซื้อ', { act: 'poCancel', tone: 'danger' }));
    }
    if (open && ctx.can('po.receive')) acts.push(h.btn('รับของตามใบนี้', { act: 'toRecv', tone: 'primary' }));
    if (po.status === 'ISSUED' && canM && !anyReceipt) acts.push(h.btn('ยกเลิกใบสั่งซื้อ', { act: 'poCancel', tone: 'danger' }));
    if (open && ctx.can('po.close')) acts.push(h.btn('ปิดยอดค้าง', { act: 'poCloseOut', tone: 'ghost' }));
    if (anyKept && po.status !== 'DRAFT' && po.status !== 'CANCELLED' && ctx.can('po.receive')) acts.push(h.btn('คืนผู้ขาย', { act: 'toRv', tone: 'ghost' }));
    acts.push(h.btn('ดาวน์โหลด CSV', { act: 'poCsv', tone: 'ghost' }));
    if (open && !ctx.can('po.close')) notes.push(t`<p class="hint">ปิดยอดค้าง (ผู้ขายส่งไม่ครบและไม่ส่งอีก) ทำได้โดย ${whoCan('po.close')}</p>`);
    const lineActs = (l) => {
      const b = [];
      if (editable && canM && out(l) > 0) b.push(h.btn('เลื่อนกำหนดเข้า', { act: 'poDue', arg: l.line, tone: 'quiet', small: true }), h.btn('ยกเลิกยอดค้าง', { act: 'poCancelLine', arg: l.line, tone: 'quiet', small: true }));
      if (open && ctx.can('po.overReceive')) b.push(h.btn('อนุมัติรับเกิน', { act: 'poOver', arg: l.line, tone: 'quiet', small: true }));
      return b.length ? t`<span class="form-actions">${b}</span>` : '';
    };
    const tbl = h.table({ id: 'po-lines-view', rows: po.lines, dense: true, rowCls: (l) => (late(ctx, po, l) ? 'row-warn' : ''), cols: [
      { label: '#', key: 'line' },
      { label: 'สินค้า', render: (l) => t`${h.code(l.code)} ${itemOf(ctx, l.code).name || l.name || ''}${l.remark ? t`<br><small class="muted">${l.remark}</small>` : ''}` },
      { label: 'สั่ง', num: true, render: (l) => t`${h.qty(l.qty, l.unit)}${l.factor !== 1 ? t`<br><small class="muted">= ${n(l.base)} ${l.baseUnit}</small>` : ''}` },
      { label: 'ราคา/หน่วย', num: true, get: (l) => h.fmt.money(l.price) },
      { label: 'มูลค่า', num: true, get: (l) => h.fmt.money(l.amount) },
      { label: 'กำหนดเข้า', render: (l) => t`${h.fmt.date(l.dueDate)}${l.originalDue && l.originalDue !== l.dueDate ? t`<br><small class="muted">เดิม ${h.fmt.date(l.originalDue)}</small>` : ''} ${late(ctx, po, l)}` },
      { label: 'รับแล้ว', num: true, render: (l) => t`${n(l.received || 0)}${l.returned ? t`<br><small class="muted">คืน ${n(l.returned)}${l.replaced ? ` (ขอทดแทน ${n(l.replaced)})` : ''}</small>` : ''}${l.overAllowed ? t`<br><small class="muted">อนุมัติรับเกินได้อีก ${n(l.overAllowed)}</small>` : ''}` },
      { label: 'ยกเลิก', num: true, render: (l) => (l.cancelled ? n(l.cancelled) : dash) },
      { label: 'ค้างรับ', num: true, render: (l) => (out(l) > 0 ? t`<b>${n(toBuy(out(l), l))}</b> ${l.unit}${l.factor !== 1 ? t`<br><small class="muted">= ${n(out(l))} ${l.baseUnit}</small>` : ''}` : dash) },
      { label: 'ใบขอซื้อ', render: (l) => (l.prNo ? prLink(l.prNo) : dash) },
      { label: '', render: lineActs },
    ] });
    return t`${h.dl([
      ['ผู้ขาย', t`${h.code(po.supplier)} ${po.supplierName || supName(ctx.state, po.supplier)}`], ['สถานะ', poBadge(po.status)], ['วันที่', h.fmt.date(po.date)],
      ['มูลค่ารวม', `${h.fmt.money(po.total)} บาท`], ['ผู้สร้าง', `${ctx.userName(po.createdBy)} · ${h.fmt.dt(po.createdAt)}`],
      po.issuedBy ? ['ออกใบสั่งซื้อ', `${ctx.userName(po.issuedBy)} · ${h.fmt.dt(po.issuedAt)}`] : null,
      (po.prNos || []).length ? ['จากใบขอซื้อ', t`${po.prNos.map((x) => t`${prLink(x)} `)}`] : null,
      po.cancelledBy ? ['ยกเลิก', `${ctx.userName(po.cancelledBy)} · ${h.fmt.dt(po.cancelledAt)} · ${po.cancelReason}`] : null,
      po.closedBy ? ['ปิดยอดค้าง', `${ctx.userName(po.closedBy)} · ${h.fmt.dt(po.closedAt)} · ${po.closeReason}`] : null,
      po.remark ? ['หมายเหตุ', po.remark] : null,
    ])}${notes}<div class="form-actions">${acts}</div>${tbl}
      <p class="hint">ค้างรับ = สั่ง − รับแล้ว − ยกเลิก (หน่วยหลัก) · คืนแบบขอของทดแทนทำให้ยอดกลับเป็นค้างรับ</p>
      ${h.section('ใบรับและใบคืนของใบสั่งซื้อนี้', docsTable(ctx, docs))}${logTable(ctx, po.log, PO_ACT)}`;
  }
  function poTab(ctx) {
    const v = ctx.view;
    const canM = ctx.can('po.manage');
    const all = P().pos(ctx.state);
    if (!all.length && v.po !== '__new') {
      return h.empty('ยังไม่มีใบสั่งซื้อ', canM
        ? 'กด + สร้างใบสั่งซื้อ เลือกผู้ขาย แล้วดึงรายการจากใบขอซื้อที่อนุมัติแล้ว หรือพิมพ์รายการเอง'
        : `ฝ่ายจัดซื้อ (${whoCan('po.manage')}) เป็นผู้ออกใบสั่งซื้อ – ใบที่ออกแล้วจะขึ้นที่นี่ และสโตร์รับของได้ที่แท็บ รับของตาม PO`,
      canM ? h.btn('+ สร้างใบสั่งซื้อ', { act: 'newPo', tone: 'primary' }) : '');
    }
    const items = ctx.state.tables.items || {};
    const q = low(v.poQ).trim();
    const rows = all.filter((po) => (!v.poSt || (v.poSt === 'LATE' ? OPEN[po.status] && po.lines.some((l) => late(ctx, po, l)) : po.status === v.poSt))
      && (!v.poSupF || po.supplier === v.poSupF)
      && (!q || [po.poNo, po.supplier, po.supplierName, po.remark].concat(po.lines.map((l) => l.code), po.lines.map((l) => (items[l.code] || {}).name), po.prNos || [])
        .some((x) => low(x).indexOf(q) >= 0)));
    const limit = v.poLimit || LIMIT;
    const nextDue = (po) => po.lines.filter((l) => out(l) > 0 && l.dueDate).map((l) => l.dueDate).sort()[0] || '';
    const list = h.table({
      id: 'po-list', scroll: true, rows: rows.slice(0, limit), rowAct: 'pickPo', rowArg: (po) => po.poNo, rowCls: (po) => (po.poNo === v.po ? 'sel' : ''),
      empty: 'ไม่พบใบสั่งซื้อตามตัวกรอง', emptyText: 'ลองเลือกทุกสถานะ ทุกผู้ขาย หรือคำค้นอื่น',
      cols: [
        { label: 'เลขที่', render: (po) => h.code(po.poNo) },
        { label: 'ผู้ขาย', render: (po) => t`${h.code(po.supplier)}<br><small class="muted">${po.supplierName || ''}</small>` },
        { label: 'วันที่', get: (po) => h.fmt.date(po.date) },
        { label: 'กำหนดเข้าถัดไป', render: (po) => (OPEN[po.status] || po.status === 'DRAFT' ? t`${h.fmt.date(nextDue(po))}${po.lines.some((l) => late(ctx, po, l)) ? t` ${h.badge('เลยกำหนด', 'bad')}` : ''}` : dash) },
        { label: 'มูลค่า', num: true, get: (po) => h.fmt.money(po.total) },
        { label: 'สถานะ', render: (po) => poBadge(po.status) },
      ],
    });
    const more = rows.length > limit ? t`<p class="hint">แสดง ${n(limit)} จาก ${n(rows.length)} ใบ ${h.btn('แสดงเพิ่ม', { act: 'more', arg: 'poLimit', tone: 'ghost', small: true })}</p>` : t`<p class="hint">${n(rows.length)} ใบ</p>`;
    const sel = v.po && v.po !== '__new' ? RRS.q.get(ctx.state, 'pos', v.po) : null;
    let detail = h.empty('เลือกใบสั่งซื้อจากรายการ', 'ดูบรรทัด ยอดค้างรับ กำหนดเข้า ใบรับ/ใบคืน และประวัติ');
    if (v.po === '__new' && canM) detail = h.section('สร้างใบสั่งซื้อ', poEditor(ctx), { id: 'p4-detail', sub: 'ได้เป็นร่างก่อน ตรวจแล้วจึงกด ออกใบสั่งซื้อ' });
    else if (sel) detail = h.section(t`${h.code(sel.poNo)} ใบสั่งซื้อ ${poBadge(sel.status)}`, poView(ctx, sel), { id: 'p4-detail' });
    const st = Object.keys(P().PO_STATUS).map((k) => [k, P().PO_STATUS[k]]).concat([['LATE', 'มีบรรทัดเลยกำหนด']]);
    const supF = RRS.q.rows(ctx.state, 'suppliers').sort((a, b) => a.id.localeCompare(b.id)).map((s) => [s.id, `${s.id} · ${s.name}`]);
    return t`${h.toolbar([
      h.field({ name: 'poQ', label: 'ค้นหา', value: v.poQ, placeholder: 'เลขที่ รหัสสินค้า ผู้ขาย PR…', id: 'po-q', act: 'poQ', live: true }),
      h.field({ name: 'poSt', label: 'สถานะ', type: 'select', value: v.poSt, options: st, blank: 'ทุกสถานะ', id: 'po-st', act: 'poSt' }),
      h.field({ name: 'poSupF', label: 'ผู้ขาย', type: 'select', value: v.poSupF, options: supF, blank: 'ทุกผู้ขาย', id: 'po-supf', act: 'poSupF' }),
    ], canM ? h.btn('+ สร้างใบสั่งซื้อ', { act: 'newPo', tone: 'primary' }) : '')}
      <div class="split"><div>${list}${more}</div><div>${detail}</div></div>`;
  }

  // ======================================================================================================
  // รับของตาม PO
  // ======================================================================================================
  function policyNote(ctx) {
    const pct = Number(settings(ctx.state).policies.overReceivePct) || 0;
    return h.note(t`ใส่จำนวนเป็นหน่วยซื้อของใบสั่งซื้อ ระบบแปลงเป็นหน่วยหลักให้ · สินค้าที่ต้องตรวจรับเข้าเป็น <b>รอตรวจ</b> ยังเบิก จอง หรือใช้ไม่ได้จนกว่า QC ตรวจและปล่อยผ่าน ·
      รับเกินยอดค้าง${pct ? ` (เผื่อได้ ${pct}%)` : ''}ต้องให้${whoCan('po.overReceive')}อนุมัติรับเกินก่อน · รับไม่ครบได้ ยอดที่เหลือยังค้างรับ`, 'info');
  }
  function poPicker(ctx, rows, act, sel, id) {
    const nextDue = (po) => po.lines.filter((l) => out(l) > 0 && l.dueDate).map((l) => l.dueDate).sort()[0] || '';
    return h.table({
      id, scroll: true, rows, rowAct: act, rowArg: (po) => po.poNo, rowCls: (po) => (po.poNo === sel ? 'sel' : ''),
      empty: 'ไม่พบใบสั่งซื้อตามตัวกรอง', emptyText: 'ลองคำค้นอื่น หรือเลือกทุกผู้ขาย',
      cols: [
        { label: 'ใบสั่งซื้อ', render: (po) => h.code(po.poNo) },
        { label: 'ผู้ขาย', render: (po) => t`${h.code(po.supplier)}<br><small class="muted">${po.supplierName || ''}</small>` },
        { label: 'รายการ', render: (po) => t`${po.lines.filter((l) => (act === 'pickRecv' ? out(l) > 0 : kept(l) > 0)).map((l) => t`${h.code(l.code)} `)}` },
        { label: act === 'pickRecv' ? 'กำหนดเข้า' : 'สถานะ', render: (po) => (act === 'pickRecv' ? t`${h.fmt.date(nextDue(po))}${po.lines.some((l) => late(ctx, po, l)) ? t` ${h.badge('เลยกำหนด', 'bad')}` : ''}` : poBadge(po.status)) },
      ],
    });
  }
  function filterPos(ctx, list, q, sup) {
    const items = ctx.state.tables.items || {};
    q = low(q).trim();
    return list.filter((po) => (!sup || po.supplier === sup) && (!q || [po.poNo, po.supplier, po.supplierName]
      .concat(po.lines.map((l) => l.code), po.lines.map((l) => (items[l.code] || {}).name)).some((x) => low(x).indexOf(q) >= 0)));
  }
  function recvForm(ctx, po) {
    const v = ctx.view;
    const prev = v.rVals && v.rVals.poNo === po.poNo ? v.rVals : null;
    const lines = po.lines.filter((l) => out(l) > 0);
    const TRACK = RRS.master.TRACK;
    const cards = lines.map((l, i) => {
      const it = itemOf(ctx, l.code);
      const pv = (prev && prev.lines && prev.lines[i]) || {};
      const tracked = it.trackLot && it.trackLot !== 'none';
      const o = out(l);
      return t`<div class="step">
        <span class="step-n">บรรทัด ${l.line}${l.prNo ? ` · ${l.prNo}` : ''}</span>
        <b>${h.code(l.code)} ${it.name || l.name || ''}</b>
        <span>ค้างรับ ${h.qty(toBuy(o, l), l.unit)}${l.factor !== 1 ? t` <span class="muted">(= ${n(o)} ${l.baseUnit})</span>` : ''} · กำหนด ${h.fmt.date(l.dueDate)} ${late(ctx, po, l)}</span>
        <span class="form-actions">${it.qcIncoming ? h.badge('ต้องตรวจรับ → เข้าเป็น รอตรวจ', 'warn') : h.badge('เข้าเป็น ใช้ได้', 'ok')}${tracked ? h.badge(`ต้องระบุ ${TRACK[it.trackLot]}`, 'accent') : ''}${it.certRequired ? h.badge('ต้องมีใบรับรองวัสดุ', 'accent') : ''}${l.overAllowed ? h.badge(`อนุมัติรับเกินได้อีก ${n(toBuy(l.overAllowed, l))} ${l.unit}`, 'info') : ''}</span>
        <input type="hidden" name="lines[${i}][line]" value="${l.line}">
        <div class="fgrid">
          ${h.field({ name: `lines[${i}][qty]`, label: `รับครั้งนี้ (${l.unit})`, type: 'number', value: pv.qty, id: `rcv-qty-${l.line}`, placeholder: 'ว่าง = ไม่รับบรรทัดนี้' })}
          ${h.field({ name: `lines[${i}][wh]`, label: 'เข้าคลัง', type: 'select', value: pv.wh || l.wh, options: h.whOptions(ctx.state), blank: false, id: `rcv-wh-${l.line}` })}
          ${h.field({ name: `lines[${i}][bin]`, label: 'ช่องเก็บ', list: 'dl-bins', value: pv.bin, id: `rcv-bin-${l.line}`, placeholder: 'เลือกหรือพิมพ์' })}
          ${tracked ? h.field({ name: `lines[${i}][lot]`, label: TRACK[it.trackLot], value: pv.lot, required: true, id: `rcv-lot-${l.line}`, hint: 'ตามป้าย/ใบรับรองที่มากับของ' }) : ''}
          ${it.certRequired ? h.field({ name: `lines[${i}][cert]`, label: 'เลขที่ใบรับรองวัสดุ', value: pv.cert, id: `rcv-cert-${l.line}`, hint: 'QC ปล่อยผ่านไม่ได้จนกว่าจะมีใบรับรองที่ตรวจแล้ว' }) : ''}
          ${it.certRequired ? h.field({ name: `certfile${i}`, label: 'รูปใบรับรอง (ถ้ามี)', type: 'file', accept: 'image/*,application/pdf', id: `rcv-file-${l.line}` }) : ''}
        </div></div>`;
    });
    const ch = v.rChecked && v.rChecked.poNo === po.poNo ? v.rChecked : null;
    return h.form({ name: 'recv', submit: 'ตรวจและรับเข้า', extra: [h.btn('ใส่ตามยอดค้างทุกบรรทัด', { act: 'recvFill', tone: 'ghost' })], body: [
      t`<input type="hidden" name="poNo" value="${po.poNo}">`,
      h.field({ name: 'date', label: 'วันที่รับ', type: 'date', value: prev ? prev.date : ctx.today, id: 'rcv-date' }),
      h.field({ name: 'supplierDoc', label: 'เลขที่ใบส่งของ/ใบกำกับของผู้ขาย', value: prev ? prev.supplierDoc : '', id: 'rcv-sdoc' }),
      h.field({ name: 'remark', label: 'หมายเหตุ', value: prev ? prev.remark : '', id: 'rcv-remark' }),
      t`<div class="wide steps">${cards}</div>`,
      t`<p class="hint wide">บรรทัดที่เว้นจำนวนไว้จะไม่รับครั้งนี้ (ยังค้างรับตามเดิม) · กด ตรวจและรับเข้า แล้วระบบให้ดูสรุปก่อนบันทึก</p>`,
      ch ? t`<div class="wide" id="rcv-check">${checkNote(ch, '')}</div>` : '',
    ] });
  }
  function doneNote(ctx, d) {
    if (!d) return '';
    const doc = RRS.q.get(ctx.state, 'documents', d.docNo);
    const hold = doc ? doc.lines.filter((l) => l.status === 'QC_HOLD') : [];
    const quar = doc ? doc.lines.filter((l) => l.status === 'QUARANTINE') : [];
    const po = RRS.q.get(ctx.state, 'pos', d.poNo);
    const qcPage = ['inspections', 'qc', 'inspect'].find((x) => RRS.ui.pages[x]);
    return t`<div class="wide" id="p4-done">${h.note(t`${d.kind === 'RV' ? 'คืนผู้ขายแล้ว' : 'รับเข้าแล้ว'} ${docLink(d.docNo)} · ${d.poNo} ${po ? (P().PO_STATUS[po.status] || po.status) : ''}`, 'ok')}
      ${hold.length ? h.note(t`${hold.map((l) => l.code).join(', ')} เข้าเป็น "รอตรวจ" – ยังเบิก จอง หรือใช้ไม่ได้ จนกว่า QC ตรวจและปล่อยผ่าน${qcPage ? t` · ${h.link('ไปหน้าตรวจคุณภาพ', qcPage)}` : ''}`, 'warn') : ''}
      ${quar.length ? h.note(`${quar.map((l) => l.code + ' ' + (l.lot || '')).join(', ')} เป็นล็อตที่ถูกกักกัน – รับเข้าเป็นสถานะกักกัน`, 'bad') : ''}
      ${(d.certs || []).map((c) => (c.ok ? h.note(t`บันทึกใบรับรอง ${c.no} ของ ${c.code} ${lotRef(c.code, c.lot)} แล้ว – รอ QC ตรวจใบรับรอง (คนละคนกับผู้บันทึก)`, 'ok') : h.note(t`ใบรับรอง ${c.no} ของ ${c.code} ${lotRef(c.code, c.lot)} ยังไม่ได้บันทึก: ${c.msg}`, 'bad')))}
      ${(d.noCert || []).length ? h.note(t`ยังไม่มีเลขใบรับรองของ ${d.noCert.join(', ')} – บันทึกที่หน้า ${RRS.ui.pages.lots ? h.link('ล็อต/Heat', 'lots', { tab: 'list' }) : 'ล็อต/Heat'} ก่อน QC ปล่อยผ่าน`, 'warn') : ''}</div>`;
  }
  function recvTab(ctx) {
    const v = ctx.view;
    const all = P().pos(ctx.state, { open: true });
    const canRecv = ctx.can('po.receive');
    if (!all.length) {
      return t`${policyNote(ctx)}${v.rDone ? doneNote(ctx, v.rDone) : ''}${h.empty('ไม่มีใบสั่งซื้อที่รอรับของ', 'ใบสั่งซื้อที่ออกให้ผู้ขายแล้วและยังรับไม่ครบจะขึ้นที่นี่ – ร่างใบสั่งซื้อต้องกด ออกใบสั่งซื้อ ก่อน', h.btn('ไปแท็บสั่งซื้อ', { act: 'tab', arg: 'po', tone: 'ghost', small: true }))}`;
    }
    const rows = filterPos(ctx, all, v.rQ, v.rSup);
    const sel = v.rpo && RRS.q.get(ctx.state, 'pos', v.rpo);
    let detail = h.empty('เลือกใบสั่งซื้อที่ของมาถึง', 'ระบบแสดงบรรทัดที่ยังค้างรับให้กรอกจำนวน ช่องเก็บ และล็อต/Heat');
    if (sel && OPEN[sel.status]) {
      detail = h.section(t`รับของตาม ${h.code(sel.poNo)} · ${sel.supplierName || sel.supplier}`, canRecv ? recvForm(ctx, sel)
        : t`${h.note(`รับของได้เฉพาะ ${whoCan('po.receive')} – คุณดูยอดค้างรับได้`, 'info')}${poView(ctx, sel)}`, { id: 'p4-detail' });
    } else if (sel) {
      detail = h.section(t`${h.code(sel.poNo)} ${poBadge(sel.status)}`, t`${h.note('ใบสั่งซื้อนี้ไม่มียอดค้างรับแล้ว', 'info')}${docsTable(ctx, poDocs(ctx.state, sel.poNo))}`, { id: 'p4-detail' });
    }
    return t`${policyNote(ctx)}${v.rDone ? doneNote(ctx, v.rDone) : ''}${h.toolbar([
      h.field({ name: 'rQ', label: 'ค้นหา', value: v.rQ, placeholder: 'เลขที่ PO รหัสสินค้า ผู้ขาย…', id: 'rcv-q', act: 'rQ', live: true }),
      h.field({ name: 'rSup', label: 'ผู้ขาย', type: 'select', value: v.rSup, options: supOptionsAll(ctx.state), blank: 'ทุกผู้ขาย', id: 'rcv-sup', act: 'rSup' }),
    ], '')}<div class="split"><div>${poPicker(ctx, rows, 'pickRecv', v.rpo, 'rcv-list')}<p class="hint">${n(rows.length)} ใบรอรับของ</p></div><div>${detail}</div></div>`;
  }
  const supOptionsAll = (state) => RRS.q.rows(state, 'suppliers').sort((a, b) => a.id.localeCompare(b.id)).map((s) => [s.id, `${s.id} · ${s.name}`]);

  // ======================================================================================================
  // คืนผู้ขาย
  // ======================================================================================================
  function locLabel(ctx, b) {
    const it = itemOf(ctx, b.code);
    return `${b.wh}${b.bin ? '/' + b.bin : ''} · ${RRS.STATUS_LABEL[b.status] || b.status}${b.lot ? ' · ' + b.lot : ''} · มี ${n(b.qty)} ${it.baseUnit || ''}`;
  }
  function rvForm(ctx, po) {
    const v = ctx.view;
    const prev = v.vVals && v.vVals.poNo === po.poNo ? v.vVals : null;
    const lines = po.lines.filter((l) => kept(l) > 0);
    const cards = lines.map((l, i) => {
      const it = itemOf(ctx, l.code);
      const pv = (prev && prev.lines && prev.lines[i]) || {};
      const locs = inv.locations(ctx.state, { code: l.code }).filter((b) => b.wh !== RRS.TRANSIT && b.qty > 0 && RV_STATUSES.indexOf(b.status) >= 0);
      const k = kept(l);
      const holdQty = inv.locations(ctx.state, { code: l.code, status: 'QC_HOLD' }).reduce((s, b) => s + b.qty, 0);
      return t`<div class="step">
        <span class="step-n">บรรทัด ${l.line}</span>
        <b>${h.code(l.code)} ${it.name || l.name || ''}</b>
        <span>รับจากใบนี้ไว้ ${h.qty(toBuy(k, l), l.unit)}${l.factor !== 1 ? t` <span class="muted">(= ${n(k)} ${l.baseUnit})</span>` : ''}${l.returned ? t` · คืนไปแล้ว ${n(l.returned)} ${l.baseUnit}` : ''}</span>
        <input type="hidden" name="lines[${i}][line]" value="${l.line}">
        ${locs.length ? t`<div class="fgrid">
          ${h.field({ name: `lines[${i}][from]`, label: 'เอาของออกจาก', type: 'select', value: pv.from, options: locs.map((b) => [RRS.balanceKey(b), locLabel(ctx, b)]), blank: '— เลือกตำแหน่ง —', id: `rv-from-${l.line}`, wide: true })}
          ${h.field({ name: `lines[${i}][qty]`, label: `จำนวนคืน (${l.unit})`, type: 'number', value: pv.qty, id: `rv-qty-${l.line}`, placeholder: 'ว่าง = ไม่คืนบรรทัดนี้' })}
          ${h.field({ name: `lines[${i}][replace]`, label: 'ผู้ขายจะส่งของใหม่ให้ไหม', type: 'radio', value: pv.replace, options: [['1', 'ขอของทดแทน (ยอดกลับเป็นค้างรับ)'], ['0', 'ไม่ขอ – ลดหนี้/คืนเงิน']], wide: true })}
        </div>` : h.note(`ไม่มีของ ${l.code} สถานะ ใช้ได้/กักกัน/รอแก้ไข ให้คืน${holdQty ? ` (มีของรอตรวจ ${n(holdQty)} – ให้ QC ตรวจ/ตัดสินก่อน)` : ''}`, 'info')}
      </div>`;
    });
    const ch = v.vChecked && v.vChecked.poNo === po.poNo ? v.vChecked : null;
    return h.form({ name: 'rv', submit: 'ตรวจและคืนผู้ขาย', danger: true, body: [
      t`<input type="hidden" name="poNo" value="${po.poNo}">`,
      h.field({ name: 'reason', label: 'เหตุผลที่คืน', value: prev ? prev.reason : '', required: true, wide: true, id: 'rv-reason', placeholder: 'เช่น ขนาดไม่ตรงแบบ ผิวเป็นสนิม' }),
      h.field({ name: 'supplierDoc', label: 'เลขที่ใบรับคืน/ใบลดหนี้ของผู้ขาย', value: prev ? prev.supplierDoc : '', id: 'rv-sdoc' }),
      t`<div class="wide steps">${cards}</div>`,
      ch ? t`<div class="wide" id="rv-check">${checkNote(ch, '')}</div>` : '',
    ] });
  }
  function rvTab(ctx) {
    const v = ctx.view;
    const canRecv = ctx.can('po.receive');
    const note = h.note(t`คืนผู้ขายตัดของออกจากคลังทันที (ใบคืนสินค้าผู้ขาย RV) · <b>ขอของทดแทน</b>: ยอดที่คืนกลับเป็นค้างรับในใบสั่งซื้อ รอผู้ขายส่งใหม่ ·
      <b>ไม่ขอ</b>: ลดหนี้/คืนเงิน ยอดค้างรับไม่เปลี่ยน · คืนได้ไม่เกินที่รับจากใบสั่งซื้อนั้น · ของกักกันที่มี NCR รอตัดสินต้องคืนผ่าน NCR`, 'info');
    const all = P().pos(ctx.state).filter((po) => po.status !== 'DRAFT' && po.status !== 'CANCELLED' && po.lines.some((l) => kept(l) > 0));
    if (!all.length) {
      return t`${note}${v.vDone ? doneNote(ctx, v.vDone) : ''}${h.empty('ยังไม่มีของที่รับจากใบสั่งซื้อให้คืน', 'เมื่อรับของตามใบสั่งซื้อแล้ว ใบนั้นจะขึ้นที่นี่ให้เลือกคืนผู้ขาย')}`;
    }
    const rows = filterPos(ctx, all, v.vQ, v.vSup);
    const sel = v.vpo && RRS.q.get(ctx.state, 'pos', v.vpo);
    let detail = h.empty('เลือกใบสั่งซื้อของของที่จะคืน', 'ระบบแสดงบรรทัดที่รับไว้ และตำแหน่งที่มีของให้เลือก');
    if (sel && all.some((po) => po.poNo === sel.poNo)) {
      detail = h.section(t`คืนผู้ขายตาม ${h.code(sel.poNo)} · ${sel.supplierName || sel.supplier}`, canRecv ? rvForm(ctx, sel)
        : h.note(`คืนผู้ขายได้เฉพาะ ${whoCan('po.receive')}`, 'info'), { id: 'p4-detail' });
    }
    return t`${note}${v.vDone ? doneNote(ctx, v.vDone) : ''}${h.toolbar([
      h.field({ name: 'vQ', label: 'ค้นหา', value: v.vQ, placeholder: 'เลขที่ PO รหัสสินค้า ผู้ขาย…', id: 'rv-q', act: 'vQ', live: true }),
      h.field({ name: 'vSup', label: 'ผู้ขาย', type: 'select', value: v.vSup, options: supOptionsAll(ctx.state), blank: 'ทุกผู้ขาย', id: 'rv-sup', act: 'vSup' }),
    ], '')}<div class="split"><div>${poPicker(ctx, rows, 'pickRv', v.vpo, 'rv-list')}<p class="hint">${n(rows.length)} ใบ</p></div><div>${detail}</div></div>`;
  }

  // ======================================================================================================
  // page
  // ======================================================================================================
  function defaultTab(ctx) {
    const me = ctx.user ? ctx.user.id : '';
    if (ctx.can('pr.approve') && RRS.q.rows(ctx.state, 'prs', (p) => p.status === 'SUBMITTED' && p.requestedBy !== me).length) return 'pr';
    if (ctx.can('po.manage')) return 'po';
    if (ctx.can('po.receive') && RRS.q.rows(ctx.state, 'pos', (p) => OPEN[p.status]).length) return 'recv';
    return 'pr';
  }
  function pendingFor(ctx) {
    if (!P() || !ctx.can('pr.approve')) return 0;
    const me = ctx.user ? ctx.user.id : '';
    return RRS.q.rows(ctx.state, 'prs', (p) => p.status === 'SUBMITTED' && p.requestedBy !== me).length;
  }
  const curPo = (ctx) => RRS.q.get(ctx.state, 'pos', ctx.view.po);
  const curPr = (ctx) => RRS.q.get(ctx.state, 'prs', ctx.view.pr);
  function lineOf(po, arg) {
    return po && po.lines.find((l) => l.line === Number(arg));
  }

  RRS.ui.page({
    id: 'purchasing', title: 'ขอซื้อ สั่งซื้อ และรับของ', phase: 4, order: 30,
    sub: 'ใบขอซื้อ (PR) → อนุมัติโดยคนละคนกับผู้ขอ → ใบสั่งซื้อ (PO) → รับของตาม PO → คืนผู้ขาย · ไม่มีการลบ ยกเลิกแล้วประวัติยังอยู่',
    badge: (ctx) => pendingFor(ctx) || '',
    render(ctx) {
      if (!P()) return h.empty('ส่วนจัดซื้อยังไม่เปิดใช้', 'ระบบนี้ยังไม่ได้โหลดส่วนจัดซื้อ (Phase 4)');
      const v = ctx.view;
      if (['pr', 'po', 'recv', 'rv'].indexOf(v.tab) < 0) v.tab = defaultTab(ctx);
      const nSub = RRS.q.rows(ctx.state, 'prs', (p) => p.status === 'SUBMITTED').length;
      const nDraft = RRS.q.rows(ctx.state, 'pos', (p) => p.status === 'DRAFT').length;
      const nOpen = RRS.q.rows(ctx.state, 'pos', (p) => OPEN[p.status]).length;
      const body = v.tab === 'po' ? poTab(ctx) : v.tab === 'recv' ? recvTab(ctx) : v.tab === 'rv' ? rvTab(ctx) : prTab(ctx);
      return t`${h.tabs([{ id: 'pr', label: 'ขอซื้อ (PR)', count: nSub || null }, { id: 'po', label: 'สั่งซื้อ (PO)', count: nDraft || null },
        { id: 'recv', label: 'รับของตาม PO', count: nOpen || null }, { id: 'rv', label: 'คืนผู้ขาย' }], v.tab)}${body}`;
    },
    after(ctx, root0) {
      const v = ctx.view;
      if (v._scroll) {
        v._scroll = false;
        const d = root0.querySelector('#p4-detail');
        if (d && root.matchMedia && root.matchMedia('(max-width: 980px)').matches) setTimeout(() => d.scrollIntoView({ block: 'start' }), 0);
      }
    },
    actions: {
      tab: (ctx, el) => set(ctx, { tab: el.dataset.arg, _scroll: false }),
      more: (ctx, el) => set(ctx, { [el.dataset.arg]: (ctx.view[el.dataset.arg] || LIMIT) + LIMIT }),
      // ---- PR
      prQ: live('prQ'),
      prSt: (ctx, el) => set(ctx, { prSt: el.value }),
      pickPr: (ctx, el) => set(ctx, { pr: el.dataset.arg, prLines: null, prHead: null, prChecked: null, _scroll: true }),
      newPr: (ctx) => set(ctx, { tab: 'pr', pr: '__new', prLines: null, prHead: null, prChecked: null, _scroll: true }),
      prClose: (ctx) => set(ctx, { pr: null, prLines: null, prHead: null, prChecked: null }),
      prAdd(ctx) {
        const vals = h.parseForm(formOf('prSave'));
        const lines = vals.lines || [];
        const last = lines[lines.length - 1] || {};
        lines.push({ wh: last.wh || defWh(ctx), needDate: last.needDate || '', supplier: last.supplier || '' });
        set(ctx, { prLines: lines, prHead: vals, prChecked: null });
      },
      prRemove(ctx, el) {
        const vals = h.parseForm(formOf('prSave'));
        const lines = (vals.lines || []).filter((_, i) => i !== Number(el.dataset.arg));
        set(ctx, { prLines: lines.length ? lines : [{ wh: defWh(ctx) }], prHead: vals, prChecked: null });
      },
      async prCheck(ctx) {
        const vals = h.parseForm(formOf('prSave'));
        const pr = curPr(ctx);
        const r = await ctx.check('pr.create', prPayload(vals, pr && pr.prNo, false));
        set(ctx, { prLines: vals.lines, prHead: vals, prChecked: r });
      },
      async prDraft(ctx) {
        const vals = h.parseForm(formOf('prSave'));
        const pr = curPr(ctx);
        const r = await ctx.exec('pr.create', prPayload(vals, pr && pr.prNo, true), { quiet: true, done: (x) => `บันทึกร่าง ${x.result.prNo} แล้ว – ยังไม่ได้ส่งขออนุมัติ` });
        if (!r.ok) return set(ctx, { prLines: vals.lines, prHead: vals, prChecked: r });
        set(ctx, { pr: r.result.prNo, prLines: null, prHead: null, prChecked: null });
      },
      async prApprove(ctx) {
        const pr = curPr(ctx);
        if (!pr) return;
        await ctx.dialog({ title: `อนุมัติใบขอซื้อ ${pr.prNo}`, submit: 'อนุมัติ',
          message: `ผู้ขอ ${ctx.userName(pr.requestedBy)} · ${pr.lines.length} บรรทัด – หลังอนุมัติ ฝ่ายจัดซื้อออกใบสั่งซื้อได้`,
          body: h.field({ name: 'remark', label: 'หมายเหตุการอนุมัติ (ถ้ามี)', wide: true }),
          onSubmit: (vv) => ctx.exec('pr.approve', { prNo: pr.prNo, remark: vv.remark }, { quiet: true, done: `อนุมัติ ${pr.prNo} แล้ว` }) });
      },
      async prReject(ctx) {
        const pr = curPr(ctx);
        if (!pr) return;
        await ctx.dialog({ title: `ไม่อนุมัติใบขอซื้อ ${pr.prNo}`, submit: 'ไม่อนุมัติ', danger: true,
          message: 'ผู้ขอจะเห็นเหตุผล และต้องสร้างใบขอซื้อใหม่ถ้ายังต้องการ',
          body: h.field({ name: 'reason', label: 'เหตุผลที่ไม่อนุมัติ', required: true, wide: true }),
          onSubmit: (vv) => ctx.exec('pr.reject', { prNo: pr.prNo, reason: vv.reason }, { quiet: true, done: `ไม่อนุมัติ ${pr.prNo} แล้ว` }) });
      },
      async prCancel(ctx) {
        const pr = curPr(ctx);
        if (!pr) return;
        const rest = pr.status === 'CONVERTED';
        const r = await ctx.dialog({ title: rest ? `ยกเลิกส่วนที่ยังไม่ออก PO ของ ${pr.prNo}` : `ยกเลิกใบขอซื้อ ${pr.prNo}`, submit: rest ? 'ยกเลิกส่วนที่เหลือ' : 'ยกเลิกใบขอซื้อ', danger: true,
          message: rest ? 'ใบสั่งซื้อที่ออกไปแล้วไม่เปลี่ยน – เฉพาะจำนวนที่ยังไม่ได้ออก PO จะไม่ถูกสั่ง' : 'ใบนี้จะไม่ถูกนำไปออกใบสั่งซื้อ ประวัติยังอยู่',
          body: h.field({ name: 'reason', label: 'เหตุผล', required: true, wide: true }),
          onSubmit: (vv) => ctx.exec('pr.cancel', { prNo: pr.prNo, reason: vv.reason }, { quiet: true, done: 'ยกเลิกแล้ว' }) });
        if (r && r.ok) set(ctx, { prLines: null, prHead: null, prChecked: null });
      },
      prToPo(ctx) {
        const pr = P().prOpen(ctx.state, ctx.view.pr);
        if (!pr) return;
        const first = pr.lines.find((l) => l.open > 0);
        if (!first) return ctx.toast('ใบนี้ออกใบสั่งซื้อครบแล้ว', 'info');
        let sup = first.supplier;
        if (!sup) {
          const pref = P().preferredSupplier(ctx.state, first.code);
          sup = pref ? pref.supplier : '';
        }
        const so = sup ? RRS.q.get(ctx.state, 'suppliers', sup) : null;
        if (!so || so.active === false) sup = '';
        const pulled = sup ? pullLines(ctx, [pr.prNo], sup, ctx.today) : { lines: null, notes: [] };
        set(ctx, { tab: 'po', po: '__new', poMode: 'pr', poPrs: [pr.prNo], poHead: { supplier: sup, date: ctx.today, remark: '' },
          poLines: pulled.lines && pulled.lines.length ? pulled.lines : null, poNotes: sup ? pulled.notes : ['เลือกผู้ขายแล้วกด ดึงบรรทัดจากใบขอซื้อที่เลือก'],
          poPulled: !!sup, poChecked: null, _scroll: true });
      },
      // ---- PO
      poQ: live('poQ'),
      poSt: (ctx, el) => set(ctx, { poSt: el.value }),
      poSupF: (ctx, el) => set(ctx, { poSupF: el.value }),
      pickPo: (ctx, el) => set(ctx, { po: el.dataset.arg, _scroll: true }),
      newPo: (ctx) => set(ctx, { tab: 'po', po: '__new', poMode: 'pr', poPrs: [], poHead: null, poLines: null, poNotes: null, poPulled: false, poChecked: null, _scroll: true }),
      poClose: (ctx) => set(ctx, { po: null, poHead: null, poLines: null, poNotes: null, poChecked: null }),
      poAdd(ctx) {
        const vals = h.parseForm(formOf('poSave'));
        const lines = vals.lines || [];
        const last = lines[lines.length - 1] || {};
        lines.push({ wh: last.wh || defWh(ctx), dueDate: last.dueDate || '' });
        set(ctx, { poLines: lines, poHead: poHead(vals), poPrs: vals.prNos, poChecked: null });
      },
      poRemove(ctx, el) {
        const vals = h.parseForm(formOf('poSave'));
        const lines = (vals.lines || []).filter((_, i) => i !== Number(el.dataset.arg));
        set(ctx, { poLines: lines.length ? lines : [{ wh: defWh(ctx) }], poHead: poHead(vals), poPrs: vals.prNos, poChecked: null });
      },
      poMode(ctx, el) {
        const vals = h.parseForm(formOf('poSave'));
        set(ctx, { poMode: el.value, poHead: poHead(vals), poLines: vals.lines, poPrs: vals.prNos, poChecked: null });
      },
      poSupChange(ctx) {
        const vals = h.parseForm(formOf('poSave'));
        const v = ctx.view;
        if (v.poMode !== 'hand' && v.poPulled && vals.supplier && (vals.prNos || []).length) {
          const p = pullLines(ctx, vals.prNos, vals.supplier, vals.date || ctx.today);
          return set(ctx, { poHead: poHead(vals), poPrs: vals.prNos, poLines: p.lines.length ? p.lines : null, poNotes: p.notes, poChecked: null });
        }
        set(ctx, { poHead: poHead(vals), poLines: vals.lines, poPrs: vals.prNos, poChecked: null });
      },
      poPull(ctx) {
        const vals = h.parseForm(formOf('poSave'));
        if (!vals.supplier) return ctx.toast('เลือกผู้ขายก่อน แล้วกด ดึงบรรทัด อีกครั้ง', 'bad');
        if (!(vals.prNos || []).length) return ctx.toast('ติ๊กเลือกใบขอซื้ออย่างน้อย 1 ใบ', 'bad');
        const p = pullLines(ctx, vals.prNos, vals.supplier, vals.date || ctx.today);
        if (!p.lines.length) p.notes.unshift('ใบขอซื้อที่เลือกไม่มีบรรทัดค้างออก PO สำหรับผู้ขายนี้');
        set(ctx, { poHead: poHead(vals), poPrs: vals.prNos, poLines: p.lines.length ? p.lines : null, poNotes: p.notes, poPulled: true, poChecked: null });
      },
      async poCheck(ctx) {
        const vals = h.parseForm(formOf('poSave'));
        const r = await ctx.check('po.create', poPayload(vals));
        set(ctx, { poHead: poHead(vals), poLines: vals.lines, poPrs: vals.prNos, poChecked: r });
      },
      async poIssue(ctx) {
        const po = curPo(ctx);
        if (!po) return;
        const ok = await ctx.confirm({ title: `ออกใบสั่งซื้อ ${po.poNo}`, ok: 'ออกใบสั่งซื้อ',
          message: `บันทึกว่าส่งใบสั่งซื้อให้ ${po.supplierName || po.supplier} แล้ว – สโตร์รับของตามใบนี้ได้ทันที · ระบบไม่ได้ส่งอีเมลหรือข้อความให้ผู้ขาย ให้ส่งเอกสารตามช่องทางปกติ (ดาวน์โหลด CSV ได้)` });
        if (!ok) return;
        await ctx.exec('po.issue', { poNo: po.poNo }, { done: `ออกใบสั่งซื้อ ${po.poNo} แล้ว` });
      },
      async poCancel(ctx) {
        const po = curPo(ctx);
        if (!po) return;
        await ctx.dialog({ title: `ยกเลิกใบสั่งซื้อ ${po.poNo}`, submit: 'ยกเลิกใบสั่งซื้อ', danger: true,
          message: `ยอดค้างทุกบรรทัดถูกยกเลิก ใบขอซื้อที่อ้างกลับมาออกใบสั่งซื้อใหม่ได้ · ประวัติยังอยู่${po.status === 'ISSUED' ? ' · ถ้าส่งให้ผู้ขายไปแล้ว ให้แจ้งผู้ขายด้วย' : ''}`,
          body: h.field({ name: 'reason', label: 'เหตุผล', required: true, wide: true }),
          onSubmit: (vv) => ctx.exec('po.cancel', { poNo: po.poNo, reason: vv.reason }, { quiet: true, done: `ยกเลิก ${po.poNo} แล้ว` }) });
      },
      async poCloseOut(ctx) {
        const po = curPo(ctx);
        if (!po) return;
        const left = po.lines.filter((l) => out(l) > 0);
        await ctx.dialog({ title: `ปิดยอดค้าง ${po.poNo}`, submit: 'ปิดยอดค้าง', danger: true,
          message: 'ใช้เมื่อผู้ขายส่งไม่ครบและจะไม่ส่งอีก – ยอดที่ยังค้างถูกยกเลิก ใบสั่งซื้อเป็น ปิดยอดค้าง และรับของตามใบนี้อีกไม่ได้',
          body: t`<div class="wide">${h.table({ rows: left, dense: true, empty: 'ไม่มียอดค้าง', cols: [
            { label: '#', key: 'line' }, { label: 'สินค้า', render: (l) => h.code(l.code) },
            { label: 'ยอดที่จะถูกปิด', num: true, render: (l) => t`${h.qty(toBuy(out(l), l), l.unit)}` }] })}</div>
            ${h.field({ name: 'reason', label: 'เหตุผล', required: true, wide: true, placeholder: 'เช่น ผู้ขายแจ้งของหมด' })}`,
          onSubmit: (vv) => ctx.exec('po.close', { poNo: po.poNo, reason: vv.reason }, { quiet: true, done: `ปิดยอดค้าง ${po.poNo} แล้ว` }) });
      },
      async poDue(ctx, el) {
        const po = curPo(ctx);
        const l = lineOf(po, el.dataset.arg);
        if (!l) return;
        await ctx.dialog({ title: `เลื่อนกำหนดเข้า ${po.poNo} บรรทัด ${l.line}`, submit: 'บันทึกกำหนดเข้าใหม่',
          message: `${l.code} ค้างรับ ${n(toBuy(out(l), l))} ${l.unit} · กำหนดเดิม ${h.fmt.date(l.dueDate)} – แผนเติมสต็อกใช้กำหนดใหม่นี้`,
          body: t`${h.field({ name: 'dueDate', label: 'กำหนดเข้าใหม่ (ตามที่ผู้ขายยืนยัน)', type: 'date', value: l.dueDate, required: true })}
            ${h.field({ name: 'reason', label: 'เหตุผล', required: true, placeholder: 'เช่น ผู้ขายแจ้งของเข้าช้า' })}`,
          onSubmit: (vv) => ctx.exec('po.setDue', { poNo: po.poNo, line: l.line, dueDate: vv.dueDate, reason: vv.reason }, { quiet: true, done: 'บันทึกกำหนดเข้าใหม่แล้ว' }) });
      },
      async poCancelLine(ctx, el) {
        const po = curPo(ctx);
        const l = lineOf(po, el.dataset.arg);
        if (!l) return;
        await ctx.dialog({ title: `ยกเลิกยอดค้าง ${po.poNo} บรรทัด ${l.line}`, submit: 'ยกเลิกยอดค้าง', danger: true,
          message: `${l.code} ค้างรับ ${n(toBuy(out(l), l))} ${l.unit} – ยอดที่ยกเลิกจะไม่รอรับแล้ว และใบขอซื้อที่อ้างกลับมาออกใบสั่งซื้อใหม่ได้`,
          body: t`${h.field({ name: 'qty', label: `จำนวนที่ยกเลิก (${l.unit})`, type: 'number', hint: `ว่าง = ยกเลิกยอดค้างทั้งหมด ${n(toBuy(out(l), l))} ${l.unit}` })}
            ${h.field({ name: 'reason', label: 'เหตุผล', required: true })}`,
          onSubmit: (vv) => ctx.exec('po.cancelLine', { poNo: po.poNo, line: l.line, qty: vv.qty, reason: vv.reason }, { quiet: true, done: 'ยกเลิกยอดค้างแล้ว' }) });
      },
      async poOver(ctx, el) {
        const po = curPo(ctx);
        const l = lineOf(po, el.dataset.arg);
        if (!l) return;
        await ctx.dialog({ title: `อนุมัติรับเกิน ${po.poNo} บรรทัด ${l.line}`, submit: 'อนุมัติรับเกิน',
          message: `${l.code} ค้างรับ ${n(toBuy(out(l), l))} ${l.unit} – สโตร์รับเกินยอดค้างได้อีกตามจำนวนที่อนุมัติ (ใช้แล้วหมดไป) · ราคาและใบสั่งซื้อไม่เปลี่ยน`,
          body: t`${h.field({ name: 'qty', label: `รับเกินได้อีก (${l.unit})`, type: 'number', required: true })}
            ${h.field({ name: 'reason', label: 'เหตุผล', required: true, placeholder: 'เช่น ผู้ขายส่งเต็มมัด' })}`,
          onSubmit: (vv) => ctx.exec('po.allowOverReceive', { poNo: po.poNo, line: l.line, qty: vv.qty, reason: vv.reason }, { quiet: true, done: 'อนุมัติรับเกินแล้ว' }) });
      },
      async poCsv(ctx) {
        const po = curPo(ctx);
        if (!po) return;
        const rows = [['ใบสั่งซื้อ', po.poNo, 'ผู้ขาย', po.supplier, po.supplierName || '', 'วันที่', po.date, 'สถานะ', P().PO_STATUS[po.status] || po.status],
          ['บรรทัด', 'รหัสสินค้า', 'ชื่อสินค้า', 'จำนวน', 'หน่วยซื้อ', 'ราคาต่อหน่วย', 'มูลค่า', 'กำหนดเข้า', 'เข้าคลัง', 'รับแล้ว (หน่วยหลัก)', 'ค้างรับ (หน่วยหลัก)', 'หน่วยหลัก', 'ใบขอซื้อ']]
          .concat(po.lines.map((l) => [l.line, l.code, itemOf(ctx, l.code).name || l.name || '', l.qty, l.unit, l.price, l.amount, l.dueDate, l.wh, l.received || 0, out(l), l.baseUnit, l.prNo || '']))
          .concat([['', '', '', '', '', 'รวม', po.total]]);
        await ctx.download(`${po.poNo}.csv`, h.csv(rows));
      },
      toRecv: (ctx) => set(ctx, { tab: 'recv', rpo: ctx.view.po, rVals: null, rChecked: null, rDone: null, _scroll: true }),
      toRv: (ctx) => set(ctx, { tab: 'rv', vpo: ctx.view.po, vVals: null, vChecked: null, vDone: null, _scroll: true }),
      // ---- receive
      rQ: live('rQ'),
      rSup: (ctx, el) => set(ctx, { rSup: el.value }),
      pickRecv: (ctx, el) => set(ctx, { rpo: el.dataset.arg, rVals: null, rChecked: null, rDone: el.dataset.arg === ctx.view.rpo ? ctx.view.rDone : null, _scroll: true }),
      recvFill(ctx) {
        const vals = h.parseForm(formOf('recv'));
        const po = RRS.q.get(ctx.state, 'pos', vals.poNo);
        if (!po) return;
        const open = po.lines.filter((l) => out(l) > 0);
        (vals.lines || []).forEach((l, i) => {
          if (open[i]) l.qty = String(toBuy(out(open[i]), open[i]));
        });
        set(ctx, { rVals: Object.assign({ poNo: po.poNo }, vals), rChecked: null });
      },
      // ---- return
      vQ: live('vQ'),
      vSup: (ctx, el) => set(ctx, { vSup: el.value }),
      pickRv: (ctx, el) => set(ctx, { vpo: el.dataset.arg, vVals: null, vChecked: null, vDone: el.dataset.arg === ctx.view.vpo ? ctx.view.vDone : null, _scroll: true }),
    },
    forms: {
      async prSave(ctx, vals) {
        const pr = curPr(ctx);
        const r = await ctx.exec('pr.create', prPayload(vals, pr && pr.prNo, false), { quiet: true,
          done: (x) => `ส่ง ${x.result.prNo} ขออนุมัติแล้ว – รอ${whoCan('pr.approve')} (คนละคนกับผู้ขอ)` });
        if (!r.ok) return set(ctx, { prLines: vals.lines, prHead: vals, prChecked: r });
        set(ctx, { pr: r.result.prNo, prLines: null, prHead: null, prChecked: null });
      },
      async poSave(ctx, vals) {
        const r = await ctx.exec('po.create', poPayload(vals), { quiet: true, done: (x) => `สร้างร่าง ${x.result.poNo} แล้ว – ตรวจแล้วกด ออกใบสั่งซื้อ` });
        if (!r.ok) return set(ctx, { poHead: poHead(vals), poLines: vals.lines, poPrs: vals.prNos, poChecked: r });
        set(ctx, { po: r.result.poNo, poHead: null, poLines: null, poPrs: null, poNotes: null, poPulled: false, poChecked: null });
      },
      async recv(ctx, vals, form) {
        const po = RRS.q.get(ctx.state, 'pos', vals.poNo);
        if (!po) return;
        const keep = Object.assign({ poNo: po.poNo }, vals);
        const picked = (vals.lines || []).map((l, i) => Object.assign({ i }, l)).filter((l) => U.trim(l.qty) !== '');
        if (!picked.length) return set(ctx, { rVals: keep, rChecked: Object.assign({ poNo: po.poNo }, fail('ยังไม่ได้ใส่จำนวน – ใส่จำนวนที่รับในบรรทัดที่ของมาถึง (บรรทัดที่ไม่ได้รับเว้นว่างไว้)')) });
        const payload = { poNo: po.poNo, date: vals.date, supplierDoc: vals.supplierDoc, remark: vals.remark,
          lines: picked.map((l) => ({ line: Number(l.line), qty: l.qty, wh: l.wh, bin: l.bin, lot: l.lot || '' })) };
        const chk = await ctx.check('po.receive', payload);
        if (!chk.ok) return set(ctx, { rVals: keep, rChecked: Object.assign({ poNo: po.poNo }, chk) });
        const rows = picked.map((l) => {
          const pl = lineOf(po, l.line);
          const it = itemOf(ctx, pl.code);
          return { i: l.i, code: pl.code, it, pl, qty: U.num(l.qty), base: U.round(U.num(l.qty) * pl.factor), wh: U.normCode(l.wh) || pl.wh, bin: U.normCode(l.bin), lot: U.trim(l.lot), cert: U.trim(l.cert) };
        });
        const noCert = rows.filter((x) => x.it.certRequired && !x.cert);
        const ok = await ctx.confirm({ title: `รับของตาม ${po.poNo}`, ok: 'บันทึกรับเข้า',
          message: 'ยอดเข้าคลังทันทีเมื่อกดบันทึก (ใบรับสินค้า RR) – บันทึกทั้งใบ หรือไม่เข้าเลย',
          body: t`<div class="wide">${h.table({ rows, dense: true, cols: [
            { label: 'สินค้า', render: (x) => t`${h.code(x.code)} ${x.it.name || ''}` },
            { label: 'รับ', num: true, render: (x) => t`${h.qty(x.qty, x.pl.unit)}${x.pl.factor !== 1 ? t`<br><small class="muted">= ${n(x.base)} ${x.pl.baseUnit}</small>` : ''}` },
            { label: 'เข้า', get: (x) => `${x.wh}${x.bin ? '/' + x.bin : ''}` },
            { label: 'ล็อต', render: (x) => x.lot || dash },
            { label: 'สถานะเมื่อเข้า', render: (x) => (x.it.qcIncoming ? h.statusBadge('QC_HOLD') : h.statusBadge('AVAILABLE')) },
          ] })}</div>
          ${rows.some((x) => x.it.qcIncoming) ? t`<p class="wide hint">ของสถานะ รอตรวจ ยังเบิก/จอง/ใช้ไม่ได้ จนกว่า QC ตรวจและปล่อยผ่าน</p>` : ''}
          ${noCert.length ? t`<div class="wide">${h.note(`ยังไม่มีเลขใบรับรองของ ${noCert.map((x) => x.code).join(', ')} – รับได้ แต่ QC ปล่อยผ่านไม่ได้จนกว่าจะบันทึกใบรับรอง`, 'warn')}</div>` : ''}
          ${(chk.warnings || []).length ? t`<div class="wide">${h.note(t`<ul>${chk.warnings.map((w) => t`<li>${w}</li>`)}</ul>`, 'warn')}</div>` : ''}` });
        if (!ok) return set(ctx, { rVals: keep, rChecked: null });
        const r = await ctx.exec('po.receive', payload, { quiet: true, done: (x) => `รับเข้าแล้ว ${x.result.docNo}` });
        if (!r.ok) return set(ctx, { rVals: keep, rChecked: Object.assign({ poNo: po.poNo }, r) });
        const docNo = r.result.docNo;
        const certs = [];
        for (const x of rows) {
          if (!x.it.certRequired || !x.cert || !x.lot) continue;
          if (!RRS.commands.defs['lot.update']) { certs.push({ code: x.code, lot: x.lot, no: x.cert, ok: false, msg: 'ระบบยังไม่ได้เปิดส่วนล็อต/ใบรับรอง – แจ้ง QC บันทึกเลขนี้' }); continue; }
          if (!ctx.can('lot.manage', x.wh)) { certs.push({ code: x.code, lot: x.lot, no: x.cert, ok: false, msg: `คุณไม่มีสิทธิ์${RRS.auth.PERM_LABELS['lot.manage'] || 'จัดการล็อต'} – แจ้ง QC บันทึกเลขนี้` }); continue; }
          let file;
          const f = form && form.querySelector(`input[name="certfile${x.i}"]`);
          if (f && f.files && f.files[0]) {
            try {
              const up = await ctx.uploadFile(f.files[0]);
              file = up && up.url;
            } catch (e) {
              ctx.toast(`แนบรูปใบรับรองไม่สำเร็จ (${(e && e.message) || e}) – บันทึกเฉพาะเลขที่`, 'warn');
            }
          }
          const cr = await ctx.exec('lot.update', { code: x.code, lot: x.lot, cert: Object.assign({ no: x.cert }, file ? { file } : {}) },
            { quiet: true, requestId: `${docNo}:cert:${x.code}:${x.lot}` });
          const same = !cr.ok && (cr.errors || []).every((e) => e.code === 'NO_CHANGE');
          certs.push({ code: x.code, lot: x.lot, no: x.cert, ok: cr.ok || same, msg: cr.ok || same ? '' : (cr.errors || []).map((e) => e.message).join(' / ') });
        }
        set(ctx, { rVals: null, rChecked: null, rDone: { kind: 'RR', docNo, poNo: po.poNo, certs, noCert: noCert.map((x) => `${x.code}${x.lot ? ' ' + x.lot : ''}`) } });
      },
      async rv(ctx, vals) {
        const po = RRS.q.get(ctx.state, 'pos', vals.poNo);
        if (!po) return;
        const keep = Object.assign({ poNo: po.poNo }, vals);
        const bad = (msg) => set(ctx, { vVals: keep, vChecked: Object.assign({ poNo: po.poNo }, fail(msg)) });
        const picked = (vals.lines || []).filter((l) => l && U.trim(l.qty) !== '');
        if (!picked.length) return bad('ยังไม่ได้ใส่จำนวนคืน – ใส่จำนวนในบรรทัดที่จะคืน');
        const bal = ctx.state.tables.balances || {};
        const errs = [];
        const lines = picked.map((l) => {
          const pl = lineOf(po, l.line);
          const b = bal[l.from];
          if (!b) errs.push({ message: `บรรทัด ${l.line}: เลือกตำแหน่งที่เอาของออก` });
          if (l.replace !== '1' && l.replace !== '0') errs.push({ message: `บรรทัด ${l.line}: เลือกว่าขอของทดแทนหรือไม่` });
          return { line: Number(l.line), qty: l.qty, wh: b ? b.wh : '', bin: b ? b.bin : '', lot: b ? b.lot : '', status: b ? b.status : '', replace: l.replace === '1', pl, b };
        });
        if (errs.length) return set(ctx, { vVals: keep, vChecked: { poNo: po.poNo, ok: false, errors: errs } });
        const payload = { poNo: po.poNo, reason: vals.reason, supplierDoc: vals.supplierDoc,
          lines: lines.map((l) => ({ line: l.line, qty: l.qty, wh: l.wh, bin: l.bin, lot: l.lot, status: l.status, replace: l.replace })) };
        const chk = await ctx.check('po.return', payload);
        if (!chk.ok) return set(ctx, { vVals: keep, vChecked: Object.assign({ poNo: po.poNo }, chk) });
        const ok = await ctx.confirm({ title: `คืนผู้ขาย ${po.supplierName || po.supplier}`, ok: 'บันทึกคืนผู้ขาย', danger: true,
          message: `ของออกจากคลังทันที (ใบคืนสินค้าผู้ขาย RV) · เหตุผล: ${U.trim(vals.reason)}`,
          body: t`<div class="wide">${h.table({ rows: lines, dense: true, cols: [
            { label: 'สินค้า', render: (l) => h.code(l.pl.code) },
            { label: 'คืน', num: true, render: (l) => t`${h.qty(U.num(l.qty), l.pl.unit)}${l.pl.factor !== 1 ? t`<br><small class="muted">= ${n(U.round(U.num(l.qty) * l.pl.factor))} ${l.pl.baseUnit}</small>` : ''}` },
            { label: 'จาก', get: (l) => `${l.wh}${l.bin ? '/' + l.bin : ''}${l.lot ? ' · ' + l.lot : ''}` },
            { label: 'สถานะของ', render: (l) => h.statusBadge(l.status) },
            { label: 'ผู้ขายส่งใหม่', get: (l) => (l.replace ? 'ขอของทดแทน – ยอดกลับเป็นค้างรับ' : 'ไม่ขอ – ลดหนี้/คืนเงิน') },
          ] })}</div>` });
        if (!ok) return set(ctx, { vVals: keep, vChecked: null });
        const r = await ctx.exec('po.return', payload, { quiet: true, done: (x) => `คืนผู้ขายแล้ว ${x.result.docNo}` });
        if (!r.ok) return set(ctx, { vVals: keep, vChecked: Object.assign({ poNo: po.poNo }, r) });
        set(ctx, { vVals: null, vChecked: null, vDone: { kind: 'RV', docNo: r.result.docNo, poNo: po.poNo } });
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
