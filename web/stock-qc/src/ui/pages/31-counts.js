/*
 * Phase 3 – ตรวจนับ (engine: RRS.reconcile, commands count.create / enter / submit / approve / cancel).
 *   เปิดรอบนับ   a warehouse (+ bins; none = the whole warehouse) and how stock may move meanwhile: timestamp (work goes on,
 *               the difference is taken at the moment each line is counted) or freeze (no document may touch the place)
 *   กรอกผลนับ    phone first: code / bin / lot / counted, one line at a time. Counters count blind – the system quantity
 *               is never shown to anyone who counted in the session. Lines over the recount limit (RECOUNT) or with
 *               counts that disagree (DUPLICATE) say who must recount (anybody but the people who counted it).
 *   ส่งผลนับ     count.submit once no line waits for a recount
 *   อนุมัติ       RRS.reconcile.countView: differences, flags RECOUNT / DUPLICATE / MOVED_DURING_COUNT / HELD_STOCK, a reason
 *               per difference and an acknowledgement for moved / held lines → count.approve posts ONE AJ (link to docs)
 *   ยกเลิก       count.cancel with a reason (OPEN / SUBMITTED)
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  if (!RRS || !RRS.ui || !RRS.reconcile) return; // engine module not in this build: no screen
  const { h } = RRS.ui;
  const { t } = h;
  const { util } = RRS;
  const rec = RRS.reconcile;

  const STATUS_TONE = { OPEN: 'info', SUBMITTED: 'warn', APPROVED: 'ok', CANCELLED: 'muted' };
  const FLAG_SHORT = { RECOUNT: 'ต้องนับซ้ำ', DUPLICATE: 'ผลนับไม่ตรงกัน', RECOUNTED: 'ยืนยันด้วยการนับซ้ำ', MOVED_DURING_COUNT: 'เคลื่อนไหวหลังนับ',
    HELD_STOCK: 'มีของรอตรวจ/กักกันที่ตำแหน่งนี้' };
  const FLAG_TONE = { RECOUNT: 'bad', DUPLICATE: 'bad', RECOUNTED: 'ok', MOVED_DURING_COUNT: 'warn', HELD_STOCK: 'warn' };
  const MODE_SHORT = { timestamp: 'นับระหว่างทำงาน', freeze: 'หยุดเคลื่อนไหว' };
  const TABS = [['open', 'กำลังนับ', ['OPEN']], ['submitted', 'รออนุมัติ', ['SUBMITTED']], ['done', 'เสร็จ/ยกเลิก', ['APPROVED', 'CANCELLED']], ['all', 'ทั้งหมด', null]];
  const STEP = 300;
  const dash = t`<span class="muted">–</span>`;
  const docView = (docNo) => ({ sel: docNo, lines: null, checked: null, header: null, tab: 'all', q: '', type: '' });
  const docLink = (no) => (no ? h.link(h.code(no), 'docs', docView(no)) : dash);
  const signed = (n) => (n == null ? '' : `${n > 0 ? '+' : ''}${h.fmt.num(n)}`);
  const roleNames = (perm) => RRS.auth.rolesFor(perm).filter((r) => r !== 'admin').map((r) => RRS.auth.ROLES[r] || r).join(' / ');
  const isPending = (l) => (l.flags || []).some((f) => f === 'RECOUNT' || f === 'DUPLICATE');
  const pendingN = (s) => (s.lines || []).filter(isPending).length;

  function settingsOf(state) {
    const d = RRS.defaultSettings();
    const s = RRS.q.get(state, 'settings', 'main') || {};
    return Object.assign({}, d, s, { policies: Object.assign({}, d.policies, s.policies) });
  }
  /** Everyone who counted a line of the session (first counts and recounts). */
  function countersOf(s) {
    const out = [];
    for (const l of s.lines || []) {
      for (const by of [l.countedBy].concat((l.recounts || []).map((r) => r.by))) if (by && out.indexOf(by) < 0) out.push(by);
    }
    return out;
  }
  const lineCounters = (l) => Array.from(new Set([l.countedBy].concat((l.recounts || []).map((r) => r.by)).filter(Boolean)));
  /**
   * Blind counting: the system quantity (and other people's counts of a line still waiting for a recount) is shown to
   * approvers who did not count here, and to everyone once approved. While a session is open – or was cancelled, which
   * usually means it will be counted again – nobody who may still count in that warehouse sees it: a store lead holds both
   * count.enter and count.approve and is often the one who recounts.
   */
  function seesSystem(ctx, s) {
    if (s.status === 'APPROVED') return true;
    const me = ctx.user ? ctx.user.id : '';
    if (!ctx.can('count.approve', s.wh) || countersOf(s).indexOf(me) >= 0) return false;
    if ((s.status === 'OPEN' || s.status === 'CANCELLED') && ctx.can('count.enter', s.wh)) return false;
    return true;
  }
  const names = (ctx, ids) => ids.map((id) => ctx.userName(id)).join(', ');
  const place = (l) => t`${l.bin ? h.code(l.bin) : t`<span class="muted">ไม่ระบุช่อง</span>`}${l.lot ? t`<br><small>ล็อต ${l.lot}</small>` : ''}`;
  const flagBadges = (flags) => t`${(flags || []).map((f) => t`${h.badge(FLAG_SHORT[f] || f, FLAG_TONE[f] || 'muted')} `)}`;

  // ---- open a session ----------------------------------------------------------------------------------------------
  function createSection(ctx) {
    const v = ctx.view;
    const d = v.cdraft || {};
    const whs = h.whOptions(ctx.state).filter(([code]) => ctx.can('count.create', code));
    if (!whs.length) {
      return h.section('เปิดรอบนับ', h.empty('ยังไม่มีคลังที่คุณเปิดรอบนับได้', RRS.q.rows(ctx.state, 'warehouses').length
        ? 'สิทธิ์เปิดรอบนับของคุณจำกัดเฉพาะบางคลัง – ให้ผู้ดูแลระบบตรวจสิทธิ์ที่หน้า ผู้ใช้และสิทธิ์'
        : 'เพิ่มคลังและช่องเก็บที่หน้า คลังและช่องเก็บ ก่อน', h.link('ไปหน้าคลังและช่องเก็บ', 'warehouses')),
      { actions: h.btn('ปิด', { act: 'closeNew', tone: 'quiet', small: true }) });
    }
    const wh = d.wh || (whs.length === 1 ? whs[0][0] : '');
    const bins = wh ? RRS.q.rows(ctx.state, 'bins', (b) => b.wh === wh && b.active !== false).sort((a, b) => a.code.localeCompare(b.code)) : [];
    const pol = settingsOf(ctx.state).policies;
    const mode = d.mode || pol.countMode || 'timestamp';
    const live = wh ? RRS.q.rows(ctx.state, 'count_sessions', (s) => s.wh === wh && (s.status === 'OPEN' || s.status === 'SUBMITTED')) : [];
    const help = t`<div class="wide">
      ${h.note(t`<b>${rec.COUNT_MODE.timestamp}</b> – รับ–จ่ายได้ตามปกติระหว่างนับ ระบบจำยอดในระบบ ณ เวลาที่กรอกแต่ละบรรทัด ใบปรับยอดลงเฉพาะผลต่าง ณ เวลานั้น รายการที่เกิดหลังนับยังอยู่ครบ (ผู้อนุมัติต้องรับทราบ) · เหมาะกับนับย่อยระหว่างวัน`, 'info')}
      ${h.note(t`<b>${rec.COUNT_MODE.freeze}</b> – ตั้งแต่เปิดรอบจนอนุมัติหรือยกเลิก ห้ามบันทึกเอกสารหรือรับโอนเข้า–ออกช่องที่นับ (ระบบปฏิเสธเอง) · เหมาะกับนับประจำปีหรือพื้นที่ที่ยอดเพี้ยนมาก แจ้งทีมก่อนเปิดรอบ`, 'warn')}</div>`;
    const body = [
      h.field({ name: 'wh', label: 'คลังที่นับ', type: 'select', options: whs, value: wh, required: true, act: 'cwh', id: 'ct-wh', blank: '— เลือกคลัง —' }),
      wh ? (bins.length
        ? h.field({ name: 'bins', label: 'ช่องเก็บที่นับ (ไม่เลือก = ทั้งคลัง)', type: 'multiselect', options: bins.map((b) => [b.code, b.name ? `${b.code} · ${b.name}` : b.code]), value: d.bins || [], wide: true, id: 'ct-bins' })
        : t`<p class="hint wide">คลังนี้ไม่มีช่องเก็บ – นับทั้งคลัง</p>`) : t`<p class="hint wide">เลือกคลังก่อน แล้วเลือกช่องเก็บที่จะนับ</p>`,
      h.field({ name: 'mode', label: 'ระหว่างนับ', type: 'radio', options: [['timestamp', rec.COUNT_MODE.timestamp], ['freeze', rec.COUNT_MODE.freeze]], value: mode, wide: true, id: 'ct-mode' }),
      help,
      h.field({ name: 'note', label: 'หมายเหตุ', value: d.note, wide: true, placeholder: 'เช่น นับประจำเดือน ชั้น A', id: 'ct-note' }),
      live.length ? t`<div class="wide">${h.note(`คลัง ${wh} มีรอบนับที่ยังไม่จบ: ${live.map((s) => `${s.id} (${s.bins.length ? s.bins.join(', ') : 'ทั้งคลัง'} · ${rec.COUNT_STATUS[s.status]})`).join(', ')} – พื้นที่ซ้อนกันเปิดรอบใหม่ไม่ได้ (จะปรับยอดซ้ำ)`, 'warn')}</div>` : '',
    ];
    return h.section('เปิดรอบนับ', h.form({ name: 'create', submit: 'เปิดรอบนับ', cancel: 'closeNew', body }), {
      id: 'ct-new', sub: `นับเฉพาะของสถานะ "ใช้ได้" ตามตำแหน่งจริง · ผลต่างปรับด้วยใบ AJ ใบเดียวเมื่ออนุมัติ · ผลนับต่างจากระบบเกิน ${h.fmt.num(pol.recountPct)}% หรือ ${h.fmt.num(pol.recountQty)} หน่วย ต้องให้อีกคนนับซ้ำ` });
  }

  // ---- count entry (phone first) -------------------------------------------------------------------------------------
  function entrySection(ctx, s, cv) {
    const v = ctx.view;
    const d = v.edraft && v.edraft._id === s.id ? v.edraft : {};
    const w = RRS.q.get(ctx.state, 'warehouses', s.wh) || {};
    const binsAll = s.bins.length ? s.bins.slice().sort() : RRS.q.rows(ctx.state, 'bins', (b) => b.wh === s.wh && b.active !== false).map((b) => b.code).sort();
    const it = d.code ? RRS.q.item(ctx.state, d.code) : null;
    const tracked = !!(it && it.trackLot && it.trackLot !== 'none');
    const units = it ? RRS.q.rows(ctx.state, 'item_units', (u) => u.code === it.id) : [];
    const bin = d.bin != null && d.bin !== '' ? d.bin : binsAll.length === 1 ? binsAll[0] : v.ebin || '';
    const hint = d.code ? (it ? `${it.id} · ${it.name} · หน่วยหลัก ${it.baseUnit}${tracked ? ` · ต้องใส่${RRS.master.TRACK[it.trackLot] || 'ล็อต'}` : ''}` : 'ไม่พบรหัสนี้ในทะเบียนสินค้า – ตรวจรหัสบนป้าย (ใช้รหัสหลัก รหัส Express หรือรหัสนับสต็อกได้)')
      : 'สแกนหรือพิมพ์รหัสหลัก / รหัส Express / รหัสนับสต็อก';
    const body = [
      h.field({ name: 'code', label: 'รหัสสินค้า', value: d.code, required: true, list: 'dl-items', act: 'ecode', live: true, id: 'ce-code', hint, wide: true, placeholder: 'สแกนหรือพิมพ์รหัส' }),
      binsAll.length ? h.field({ name: 'bin', label: 'ช่องเก็บ', type: 'select', options: binsAll, value: bin, id: 'ce-bin', required: !!(w.requireBin || s.bins.length),
        blank: w.requireBin || s.bins.length ? '— เลือกช่องเก็บ —' : 'ไม่ระบุช่องเก็บ' }) : '',
      tracked || d.lot ? h.field({ name: 'lot', label: tracked ? `${RRS.master.TRACK[it.trackLot] || 'ล็อต'} (ตามป้าย)` : 'ล็อต / Heat', value: d.lot, required: tracked, id: 'ce-lot',
        hint: tracked ? 'แต่ละล็อตนับแยกบรรทัด' : 'สินค้านี้ไม่ติดตามล็อต – ลบออก' }) : '',
      h.field({ name: 'counted', label: `นับได้${it ? ` (${d.unit || it.baseUnit})` : ''}`, type: 'number', value: d.counted, required: true, id: 'ce-qty', hint: 'ไม่มีของเลย ใส่ 0' }),
      // changing the unit re-renders (same handler as the code) so the label of the quantity names the unit counted in
      units.length ? h.field({ name: 'unit', label: 'หน่วยที่นับ', type: 'select', value: d.unit || '', blank: `${it.baseUnit} (หน่วยหลัก)`, options: units.map((u) => [u.unit, `${u.unit} (= ${h.fmt.num(u.factor)} ${it.baseUnit})`]), act: 'ecode', id: 'ce-unit' }) : '',
    ];
    const last = v.lastEntry && v.lastEntry.id === s.id ? h.note(v.lastEntry.msg, v.lastEntry.tone) : '';
    return h.section('กรอกผลนับ', t`${last}<div class="count-entry">${h.form({ name: 'enter', submit: 'บันทึกบรรทัดนี้', body,
      extra: d.code || d.lot || d.counted ? h.btn('ล้างช่อง', { act: 'eclear', tone: 'ghost' }) : '' })}</div>`, {
      id: 'ct-entry', sub: 'นับของจริงทีละบรรทัด (สินค้า + ช่องเก็บ + ล็อต) แล้วกดบันทึก · ระบบไม่แสดงยอดในระบบให้ผู้นับเห็น · นับเฉพาะของที่ใช้ได้ ของที่ติดป้ายรอตรวจ/กักกันไม่ต้องนับรวม' });
  }

  /** Lines waiting for a recount: who counted them and who may recount. */
  function recountSection(ctx, s, cv) {
    const pend = cv.lines.filter((l) => l.pending);
    if (!pend.length) return '';
    const me = ctx.user ? ctx.user.id : '';
    const canEnter = s.status === 'OPEN' && ctx.can('count.enter', s.wh);
    // examples of who may recount: store staff first (they are on the floor), then store leads, administrators last
    const rank = (u) => (u.roles.indexOf('store') >= 0 ? 0 : u.roles.indexOf('store_lead') >= 0 ? 1 : 2);
    const others = (l) => RRS.q.rows(ctx.state, 'users', (u) => u.active !== false && RRS.auth.can(u, 'count.enter', s.wh) && l.counters.indexOf(u.id) < 0)
      .sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name), 'th')).map((u) => u.name);
    // the recount button sits under the item (first column): on a phone it is in view without scrolling the table sideways
    const btn = (l) => {
      if (!canEnter) return '';
      const mine = lineCounters(l).indexOf(me) >= 0;
      return t`<br>${h.btn(mine ? 'คุณนับแล้ว' : 'นับซ้ำ', { act: 'recount', arg: l.key, small: true, tone: mine ? 'ghost' : '', disabled: mine,
        title: mine ? 'คุณนับบรรทัดนี้แล้ว – การนับซ้ำต้องเป็นคนอื่น' : 'กรอกผลนับซ้ำของบรรทัดนี้' })}`;
    };
    return h.section(`รอนับซ้ำ (${pend.length})`, h.table({ rows: pend, dense: true, scroll: true, id: 'ct-recount', cols: [
      { label: 'สินค้า', render: (l) => t`${h.code(l.code)} <small>${l.name}</small>${btn(l)}` },
      { label: 'ตำแหน่ง', render: place },
      { label: 'ทำไม', render: (l) => t`${flagBadges(l.flags.filter((f) => f === 'RECOUNT' || f === 'DUPLICATE'))}<br><small class="muted">${l.flags.indexOf('DUPLICATE') >= 0 ? rec.FLAG.DUPLICATE : rec.FLAG.RECOUNT}</small>` },
      { label: 'นับแล้วโดย', get: (l) => names(ctx, lineCounters(l)) },
      { label: 'ต้องนับซ้ำโดย', w: '220px', render: (l) => {
        const o = others(l);
        return t`<b>คนอื่นที่ไม่ใช่ ${names(ctx, lineCounters(l))}</b>${o.length ? t`<br><small class="muted">เช่น ${o.slice(0, 4).join(', ')}${o.length > 4 ? ' …' : ''}</small>` : t`<br><small class="muted">ยังไม่มีผู้นับคนอื่นที่มีสิทธิ์คลัง ${s.wh}</small>`}`;
      } },
    ] }), { sub: 'ผลนับต่างจากระบบเกินเกณฑ์ หรือผู้นับสองคนได้ผลไม่ตรงกัน – ต้องให้คนที่ยังไม่ได้นับบรรทัดนั้นนับซ้ำก่อนส่งผลนับ' });
  }

  /** Counted lines; the system quantity and difference only for people allowed to see them (blind counting). */
  function linesTable(ctx, s, cv, sees, id) {
    const v = ctx.view;
    const limit = v.limit || STEP;
    const cols = [
      { label: 'สินค้า', render: (l) => t`${h.code(l.code)} <small>${l.name}</small>` },
      { label: 'ตำแหน่ง', render: place },
      { label: 'นับได้', num: true, render: (l) => (l.final ? h.qty(l.final.counted, l.unit) : sees ? t`${h.fmt.num(l.counted)}${(l.recounts || []).map((r) => t` / ${h.fmt.num(r.counted)}`)} <span class="unit">${l.unit}</span>` : t`<span class="muted">รอนับซ้ำ</span>`) },
    ];
    if (sees) {
      cols.push({ label: 'ระบบ ณ เวลานับ', num: true, render: (l) => (l.final ? h.fmt.num(l.final.system) : h.fmt.num(l.system)) });
      cols.push({ label: 'ผลต่าง', num: true, render: (l) => (l.adjust ? t`<b>${signed(l.adjust)}</b>` : l.final ? '0' : dash) });
    }
    cols.push(
      { label: 'นับโดย', render: (l) => t`${names(ctx, lineCounters(l))}<br><small class="muted">${h.fmt.dt((l.final && l.final.at) || l.countedAt)}</small>` },
      { label: 'สถานะ', render: (l) => (l.flags && l.flags.length ? flagBadges(l.flags) : h.badge('ใช้ผลนี้', 'ok')) },
    );
    if (s.status === 'APPROVED') cols.push({ label: 'เหตุผล', render: (l) => (l.reason ? t`${l.reason}<br><small class="muted">${ctx.userName(l.reasonBy)}</small>` : dash) });
    const tbl = h.table({ rows: cv.lines.slice(0, limit), cols, dense: true, scroll: true, id, empty: 'ยังไม่มีผลนับ',
      emptyText: s.status === 'OPEN' ? 'บรรทัดที่กรอกจะขึ้นที่นี่ – เริ่มจากช่องกรอกผลนับด้านบน' : 'รอบนี้ไม่มีบรรทัดที่นับ' });
    const more = cv.lines.length > limit ? t`<p class="hint">แสดง ${h.fmt.num(limit)} จาก ${h.fmt.num(cv.lines.length)} บรรทัด ${h.btn('แสดงเพิ่ม', { act: 'more', tone: 'ghost', small: true })}</p>` : '';
    return t`${tbl}${more}`;
  }

  function uncountedSection(ctx, s, cv, sees) {
    if (!cv.uncounted.length || s.status === 'APPROVED' || s.status === 'CANCELLED') return '';
    const items = ctx.state.tables.items || {};
    const cols = [
      { label: 'สินค้า', render: (u) => t`${h.code(u.code)} <small>${(items[u.code] || {}).name || ''}</small>` },
      { label: 'ตำแหน่ง', render: place },
    ];
    if (sees) cols.push({ label: 'ยอดในระบบ', num: true, render: (u) => h.qty(u.qty, (items[u.code] || {}).baseUnit) });
    return h.section(`ตำแหน่งที่มีของในระบบแต่ยังไม่ได้นับ (${cv.uncounted.length})`, h.table({ rows: cv.uncounted.slice(0, STEP), cols, dense: true, scroll: true, id: 'ct-uncounted' }),
      { sub: 'ใช้เป็นรายการตรวจว่านับครบ – ตำแหน่งที่ไม่ได้นับจะไม่ถูกปรับยอด ถ้าไปดูแล้วไม่มีของ ให้กรอกนับได้ 0' });
  }

  // ---- approval ------------------------------------------------------------------------------------------------------------
  function approvalSection(ctx, s, cv) {
    const v = ctx.view;
    const me = ctx.user ? ctx.user.id : '';
    const sod = settingsOf(ctx.state).policies.sod !== false;
    const counters = countersOf(s);
    if (!ctx.can('count.approve', s.wh)) {
      return h.section('รออนุมัติ', t`${h.note(`ส่งผลนับแล้วโดย ${ctx.userName(s.submittedBy)} เมื่อ ${h.fmt.dt(s.submittedAt)} – รอ${roleNames('count.approve')}ที่ไม่ได้นับรอบนี้อนุมัติ`, 'info')}${linesTable(ctx, s, cv, false, 'ct-lines')}`);
    }
    if (sod && me && (counters.indexOf(me) >= 0 || s.submittedBy === me)) {
      return h.section('รออนุมัติ', t`${h.note(`คุณ${counters.indexOf(me) >= 0 ? 'นับ' : 'ส่งผลนับ'}ในรอบนี้ – อนุมัติเองไม่ได้ (แยกหน้าที่) ให้${roleNames('count.approve')}คนอื่นที่ไม่ได้นับรอบนี้อนุมัติ`, 'warn')}${linesTable(ctx, s, cv, false, 'ct-lines')}`);
    }
    const tot = cv.totals;
    const reasons = v.reasons && v.reasons._id === s.id ? v.reasons : {};
    const kp = h.kpis([
      h.kpi('บรรทัดที่นับ', h.fmt.num(tot.lines), `ผู้นับ ${names(ctx, counters)}`),
      h.kpi('ต้องปรับยอด', h.fmt.num(tot.adjustLines), tot.adjustLines ? `เพิ่ม ${signed(tot.plus)} · ลด ${h.fmt.num(tot.minus)}` : 'ไม่มีผลต่าง', tot.adjustLines ? 'warn' : 'ok'),
      h.kpi('เคลื่อนไหวหลังนับ', h.fmt.num(tot.moved), tot.moved ? 'ต้องรับทราบก่อนอนุมัติ' : 'ไม่มี', tot.moved ? 'warn' : ''),
      h.kpi('มีของรอตรวจ/กักกันที่ตำแหน่ง', h.fmt.num(tot.held), tot.held ? 'ตรวจว่าไม่ได้นับรวม' : 'ไม่มี', tot.held ? 'warn' : ''),
      h.kpi('ไม่ได้นับ', h.fmt.num(tot.uncounted), tot.uncounted ? 'ตำแหน่งที่มียอดแต่ไม่ได้นับ – ไม่ถูกปรับ' : 'นับครบทุกตำแหน่งที่มียอด', tot.uncounted ? 'info' : ''),
    ]);
    let i = -1;
    const rows = cv.lines.map((l) => {
      if (l.adjust) i++;
      return Object.assign({}, l, { _i: l.adjust ? i : -1 });
    });
    const tbl = h.table({ rows, dense: true, scroll: true, id: 'ct-approve', rowCls: (l) => (l.adjust ? 'row-warn' : ''), cols: [
      { label: 'สินค้า', render: (l) => t`${h.code(l.code)} <small>${l.name}</small>` },
      { label: 'ตำแหน่ง', render: place },
      { label: 'ระบบ ณ เวลานับ', num: true, render: (l) => h.fmt.num(l.final ? l.final.system : l.system) },
      { label: 'นับได้', num: true, render: (l) => h.fmt.num(l.final ? l.final.counted : l.counted) },
      { label: 'ปรับยอด', num: true, render: (l) => (l.adjust ? t`<b>${signed(l.adjust)}</b> <span class="unit">${l.unit}</span>` : '0') },
      { label: 'ตอนนี้ในระบบ', num: true, render: (l) => t`${h.fmt.num(l.currentSystem)}${l.moved ? t`<br><small>หลังนับ ${signed(l.movedQty)}</small>` : ''}` },
      { label: 'ตรวจ', render: (l) => t`${l.flags.length ? flagBadges(l.flags) : ''}${l.moved ? t`<br><small class="muted">เคลื่อนไหวหลังนับ ${l.movedCount} รายการ – ไม่ถูกปรับทับ</small>` : ''}${l.held ? t`<br><small class="muted">ที่ตำแหน่งนี้มีของรอตรวจ/กักกัน ${h.fmt.num(l.heldQty)}</small>` : ''}<br><small class="muted">นับโดย ${names(ctx, lineCounters(l))}</small>` },
    ],
    // the reason of a difference in a full-width row under its line: on a phone it is in view without scrolling the
    // table sideways (the width limit keeps it inside the screen while the table itself is wider)
    detail: (l) => (l.adjust
      ? t`<div class="fld" style="max-width:min(100%, calc(100vw - 72px))"><label class="fld-l" for="ct-r-${l._i}">เหตุผลของผลต่าง ${l.code}${l.bin ? ' ช่อง ' + l.bin : ''}${l.lot ? ' ล็อต ' + l.lot : ''} (${signed(l.adjust)} ${l.unit}) <b class="req">*</b></label>
        <input type="hidden" name="r[${l._i}][key]" value="${l.key}"><input name="r[${l._i}][reason]" id="ct-r-${l._i}" value="${reasons[l.key] || ''}" placeholder="เช่น เบิกแล้วไม่ได้บันทึก / ของเสียทิ้งแล้วไม่ได้ตัดยอด"></div>`
      : null) });
    const ackParts = [];
    if (tot.moved) ackParts.push(`${tot.moved} บรรทัดมีรายการเคลื่อนไหวหลังนับ – ระบบปรับเฉพาะผลต่าง ณ เวลานับ ยอดที่เคลื่อนไหวหลังนับคงไว้`);
    if (tot.held) ackParts.push(`${tot.held} บรรทัดนับได้มากกว่าระบบ ขณะที่ตำแหน่งเดียวกันมีของรอตรวจ/กักกัน/รอแก้ไข – ตรวจแล้วว่าไม่ได้นับของเหล่านั้นรวม`);
    const ack = cv.needsAck ? h.field({ name: 'ack', label: `รับทราบ: ${ackParts.join(' · ')}`, type: 'checkbox', value: v.ack, wide: true, id: 'ct-ack' }) : '';
    const err = v.apErr && v.apErr.id === s.id ? h.note(t`อนุมัติไม่ได้ – ยังไม่มีอะไรเปลี่ยน${h.errors({ errors: v.apErr.errors })}`, 'bad') : '';
    const submit = tot.adjustLines ? `อนุมัติและสร้างใบปรับยอด AJ (${tot.adjustLines} บรรทัด)` : 'อนุมัติ (ไม่มีผลต่าง ไม่สร้างใบปรับยอด)';
    return h.section('ตรวจและอนุมัติผลนับ', t`${kp}${err}
      ${h.form({ name: 'approve', submit, body: [t`<div class="wide">${tbl}</div>`, ack,
        t`<p class="hint wide">ทุกบรรทัดที่ต้องปรับยอดต้องมีเหตุผล · ใบปรับยอดลงคลัง ${s.wh} ใบเดียวทั้งรอบ · ผู้อนุมัติต้องไม่ใช่ผู้นับหรือผู้ส่งผลนับรอบนี้</p>`] })}`,
    { id: 'ct-approval', sub: `ส่งผลนับโดย ${ctx.userName(s.submittedBy)} เมื่อ ${h.fmt.dt(s.submittedAt)}` });
  }

  // ---- session detail ------------------------------------------------------------------------------------------------------
  function detail(ctx, s) {
    const cv = rec.countView(ctx.state, s.id);
    const live = s.status === 'OPEN' || s.status === 'SUBMITTED';
    const sees = seesSystem(ctx, s);
    const acts = [];
    if (cv.lines.length) acts.push(h.btn('ดาวน์โหลด CSV', { act: 'csv', tone: 'ghost', small: true }));
    if (live && (ctx.can('count.create', s.wh) || ctx.can('count.approve', s.wh))) acts.push(h.btn('ยกเลิกรอบนับ', { act: 'cancel', tone: 'ghost', small: true, id: 'ct-cancel' }));
    acts.push(h.btn('ปิด', { act: 'unpick', tone: 'quiet', small: true }));
    const notes = [];
    if (s.mode === 'freeze' && live) notes.push(h.note(t`<b>หยุดเคลื่อนไหว</b>: ระหว่างนี้บันทึกเอกสารหรือรับโอนเข้า–ออก ${s.wh}${s.bins.length ? ' ช่อง ' + s.bins.join(', ') : ' (ทั้งคลัง)'} ไม่ได้ จนกว่าจะอนุมัติหรือยกเลิกรอบนับ`, 'warn'));
    if (s.mode === 'timestamp' && live) notes.push(h.note('นับระหว่างทำงาน: ระบบจำยอด ณ เวลาที่กรอกแต่ละบรรทัด รายการรับ–จ่ายหลังนับไม่ถูกปรับทับ (ผู้อนุมัติจะเห็นและต้องรับทราบ)', 'info'));
    if (s.status === 'OPEN' && !sees) notes.push(h.note('นับแบบไม่เห็นยอดในระบบ – ผลต่างจะแสดงให้ผู้อนุมัติที่ไม่ได้นับรอบนี้ หลังส่งผลนับ', 'info'));
    if (s.status === 'APPROVED') {
      notes.push(h.note(t`อนุมัติแล้วโดย ${ctx.userName(s.approvedBy)} เมื่อ ${h.fmt.dt(s.approvedAt)} – ${s.docNo ? t`สร้างใบปรับยอด ${docLink(s.docNo)} ${cv.aj.length} บรรทัด (ยอดคงเหลือเปลี่ยนแล้ว)` : 'ไม่มีผลต่าง ไม่ต้องปรับยอด'}`, 'ok'));
      if (s.ack) notes.push(h.note(`ผู้อนุมัติรับทราบ: เคลื่อนไหวหลังนับ ${(s.ack.lines || []).length} บรรทัด · มีของรอตรวจ/กักกันที่ตำแหน่ง ${(s.ack.held || []).length} บรรทัด`, 'info'));
      if (s.docCancelled) notes.push(h.note(`ใบปรับยอด ${s.docCancelled.docNo} ถูกยกเลิกโดย ${ctx.userName(s.docCancelled.by)} เมื่อ ${h.fmt.dt(s.docCancelled.at)}${s.docCancelled.reason ? ': ' + s.docCancelled.reason : ''} – ผลนับรอบนี้ไม่มีผลกับยอดแล้ว`, 'warn'));
    }
    if (s.status === 'CANCELLED') notes.push(h.note(`ยกเลิกโดย ${ctx.userName(s.cancelledBy)} เมื่อ ${h.fmt.dt(s.cancelledAt)}: ${s.cancelReason} – ไม่มีการปรับยอด`, 'info'));
    const facts = h.dl([
      ['คลัง', t`${h.code(s.wh)} ${ctx.whName(s.wh)}`], ['พื้นที่ที่นับ', s.bins.length ? s.bins.join(', ') : 'ทั้งคลัง'],
      ['ระหว่างนับ', rec.COUNT_MODE[s.mode] || s.mode], ['เปิดโดย', `${ctx.userName(s.createdBy)} · ${h.fmt.dt(s.createdAt)}`],
      s.submittedBy ? ['ส่งผลนับโดย', `${ctx.userName(s.submittedBy)} · ${h.fmt.dt(s.submittedAt)}`] : null,
      s.approvedBy ? ['อนุมัติโดย', `${ctx.userName(s.approvedBy)} · ${h.fmt.dt(s.approvedAt)}`] : null,
      s.docNo ? ['ใบปรับยอด', docLink(s.docNo)] : null, s.note ? ['หมายเหตุ', s.note] : null,
    ]);
    const head = h.section(t`รอบนับ ${h.code(s.id)} · คลัง ${s.wh} ${h.badge(rec.COUNT_STATUS[s.status] || s.status, STATUS_TONE[s.status])}`, t`${facts}${notes}`, { id: 'ct-detail', actions: acts });
    if (s.status === 'OPEN') {
      const canEnter = ctx.can('count.enter', s.wh);
      const tot = cv.totals;
      const why = !cv.lines.length ? 'ยังไม่มีผลนับ' : tot.pending ? `ยังมี ${tot.pending} บรรทัดรอนับซ้ำโดยคนอื่น` : '';
      const submit = canEnter ? t`<div class="form-actions">${h.btn('ส่งผลนับให้อนุมัติ', { act: 'submit', tone: 'primary', id: 'ct-submit', disabled: !cv.canSubmit, title: why || 'ส่งให้ผู้อนุมัติตรวจผลต่าง' })}
        <small class="hint">${why ? why + ' – ส่งไม่ได้' : `ส่งแล้วกรอกเพิ่มไม่ได้ · ผู้อนุมัติ: ${roleNames('count.approve')} ที่ไม่ได้นับรอบนี้`}</small></div>` : '';
      return t`${head}
        ${canEnter ? entrySection(ctx, s, cv) : h.note(`คุณดูได้อย่างเดียว – ผู้กรอกผลนับคือ ${roleNames('count.enter')}${ctx.can('count.enter') ? ' (สิทธิ์ของคุณไม่รวมคลัง ' + s.wh + ')' : ''}`, 'info')}
        ${recountSection(ctx, s, cv)}
        ${h.section(`ผลนับที่กรอกแล้ว (${cv.lines.length})`, t`${linesTable(ctx, s, cv, sees, 'ct-lines')}${submit}`)}
        ${uncountedSection(ctx, s, cv, sees)}`;
    }
    if (s.status === 'SUBMITTED') return t`${head}${approvalSection(ctx, s, cv)}${uncountedSection(ctx, s, cv, sees)}`;
    return t`${head}${h.section(`ผลนับ (${cv.lines.length})`, linesTable(ctx, s, cv, sees, 'ct-lines'))}`;
  }

  function sessionList(ctx, list, tab, total) {
    const v = ctx.view;
    return h.table({ rows: list, rowAct: 'pick', rowArg: (s) => s.id, rowCls: (s) => (s.id === v.sel ? 'sel' : s.status === 'CANCELLED' ? 'muted' : ''), scroll: true, id: 'ct-list',
      empty: !total ? 'ยังไม่มีรอบตรวจนับ' : tab === 'open' ? 'ไม่มีรอบที่กำลังนับ' : tab === 'submitted' ? 'ไม่มีรอบรออนุมัติ' : 'ไม่มีรอบนับในกลุ่มนี้',
      emptyText: !total ? 'รอบที่เปิดแล้วจะขึ้นที่นี่ให้ผู้นับเลือกและกรอกผลนับ' : tab === 'open' ? 'รอบที่เปิดแล้วจะขึ้นที่นี่ให้ผู้นับเลือก' : 'เลือกแท็บอื่นเพื่อดูรอบที่เหลือ',
      cols: [
        { label: 'รอบ', render: (s) => h.code(s.id) },
        { label: 'คลัง', render: (s) => t`${h.code(s.wh)} <small class="muted">${ctx.whName(s.wh)}</small>` },
        { label: 'พื้นที่', get: (s) => (s.bins.length ? s.bins.join(', ') : 'ทั้งคลัง') },
        { label: 'ระหว่างนับ', render: (s) => h.badge(MODE_SHORT[s.mode] || s.mode, s.mode === 'freeze' ? 'warn' : 'muted') },
        { label: 'สถานะ', render: (s) => h.badge(rec.COUNT_STATUS[s.status] || s.status, STATUS_TONE[s.status]) },
        { label: 'บรรทัด', num: true, get: (s) => (s.lines || []).length },
        { label: 'รอนับซ้ำ', num: true, render: (s) => (pendingN(s) ? h.badge(h.fmt.num(pendingN(s)), 'bad') : dash) },
        { label: 'เปิดโดย', render: (s) => t`${ctx.userName(s.createdBy)}<br><small class="muted">${h.fmt.dt(s.createdAt)}</small>` },
        { label: 'ใบปรับยอด', render: (s) => (s.docNo ? docLink(s.docNo) : dash) },
      ] });
  }

  RRS.ui.page({
    id: 'counts', title: 'ตรวจนับ', phase: 3, order: 20,
    sub: 'เปิดรอบนับต่อคลัง/ช่องเก็บ กรอกผลนับจากมือถือทีละบรรทัด นับซ้ำเมื่อต่างเกินเกณฑ์ แล้วอนุมัติปรับยอดด้วยใบ AJ ใบเดียว',
    badge: (ctx) => RRS.q.rows(ctx.state, 'count_sessions', (s) => s.status === 'OPEN' || s.status === 'SUBMITTED').length || '',
    render(ctx) {
      const v = ctx.view;
      const all = RRS.q.rows(ctx.state, 'count_sessions').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id));
      const canCreate = ctx.can('count.create');
      const by = (st) => all.filter((s) => !st || st.indexOf(s.status) >= 0);
      const counts = {};
      for (const [k, , st] of TABS) counts[k] = by(st).length;
      const tab = v.tab || (counts.open ? 'open' : counts.submitted ? 'submitted' : 'all');
      const freezes = all.filter((s) => s.mode === 'freeze' && (s.status === 'OPEN' || s.status === 'SUBMITTED'));
      const sel = v.sel && RRS.q.get(ctx.state, 'count_sessions', v.sel);
      const ro = !canCreate && !ctx.can('count.enter') && !ctx.can('count.approve')
        ? h.note(`คุณดูได้อย่างเดียว – เปิดรอบนับ: ${roleNames('count.create')} · กรอกผลนับ: ${roleNames('count.enter')} · อนุมัติ: ${roleNames('count.approve')}`, 'info') : '';
      const create = v.newOpen && canCreate ? createSection(ctx) : '';
      if (!all.length && !create) {
        return t`${ro}${h.empty('ยังไม่มีรอบตรวจนับ', canCreate
          ? 'เปิดรอบนับต่อคลัง (เลือกช่องเก็บได้) แล้วให้สโตร์กรอกผลนับทีละบรรทัดจากมือถือ ผลต่างจะปรับด้วยใบ AJ ใบเดียวเมื่อผู้อนุมัติที่ไม่ได้นับอนุมัติ'
          : `เมื่อ${roleNames('count.create')}เปิดรอบนับ รอบนั้นจะขึ้นที่นี่ให้ผู้นับเลือกและกรอกผลนับ`,
        canCreate ? h.btn('+ เปิดรอบนับแรก', { act: 'newOpen', tone: 'primary' }) : '')}`;
      }
      const kp = h.kpis([
        h.kpi('กำลังนับ', h.fmt.num(counts.open), 'รอบที่เปิดให้กรอกผลนับ', counts.open ? 'info' : ''),
        h.kpi('รออนุมัติ', h.fmt.num(counts.submitted), 'ส่งผลนับแล้ว', counts.submitted ? 'warn' : ''),
        h.kpi('หยุดเคลื่อนไหวอยู่', h.fmt.num(freezes.length), freezes.length ? freezes.map((s) => `${s.wh}${s.bins.length ? '/' + s.bins.join(',') : ''}`).join(' · ') : 'ไม่มีพื้นที่ที่หยุด', freezes.length ? 'warn' : ''),
        h.kpi('อนุมัติแล้ว', h.fmt.num(all.filter((s) => s.status === 'APPROVED').length), 'รอบ'),
      ]);
      const shown = by((TABS.find((x) => x[0] === tab) || TABS[3])[2]);
      const list = h.section('รอบนับ', t`${h.tabs(TABS.map(([k, l]) => ({ id: k, label: l, count: counts[k] })), tab)}${sessionList(ctx, shown, tab, all.length)}`, {
        sub: 'คลิกแถวเพื่อกรอกผลนับ ส่งผล หรืออนุมัติ', actions: canCreate && !v.newOpen ? h.btn('+ เปิดรอบนับ', { act: 'newOpen', tone: 'primary', small: true }) : '' });
      return t`${ro}${kp}${create}${sel ? detail(ctx, sel) : ''}${list}`;
    },
    after(ctx, root0) {
      const v = ctx.view;
      if (v._focus) {
        const id = v._focus;
        v._focus = null;
        // after the shell has put the focus back where it was (it does that once this hook returns): a quantity
        // entered with Enter on the phone keyboard must still move the cursor to the code for the next scan
        setTimeout(() => {
          const el = root0.querySelector('#' + id);
          if (el && el.isConnected) el.focus({ preventScroll: true });
        }, 0);
      }
      if (v._scrollTo) {
        const target = root0.querySelector('#' + v._scrollTo);
        v._scrollTo = null;
        if (target) setTimeout(() => target.scrollIntoView({ block: 'start' }), 0);
      }
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg }),
      pick(ctx, el) {
        // a counter on the phone goes straight to the entry form (the session facts are above it)
        const s = RRS.q.get(ctx.state, 'count_sessions', el.dataset.arg);
        const toEntry = s && s.status === 'OPEN' && ctx.can('count.enter', s.wh);
        ctx.set({ sel: el.dataset.arg, limit: STEP, lastEntry: null, apErr: null, ack: false, _scrollTo: toEntry ? 'ct-entry' : 'ct-detail' });
      },
      unpick: (ctx) => ctx.set({ sel: null }),
      more: (ctx) => ctx.set({ limit: (ctx.view.limit || STEP) + STEP }),
      newOpen: (ctx) => ctx.set({ newOpen: true, cdraft: null, _scrollTo: 'ct-new' }),
      closeNew: (ctx) => ctx.set({ newOpen: false, cdraft: null }),
      cwh(ctx, el) {
        const vals = el.form ? h.parseForm(el.form) : {};
        ctx.set({ cdraft: { wh: el.value, bins: [], mode: vals.mode, note: vals.note } });
      },
      ecode(ctx, el) {
        // a scanner types the code and presses Enter at once: the form may be gone (saved) before this runs
        if (!el.isConnected || !el.form) return;
        const vals = h.parseForm(el.form);
        ctx.set({ edraft: Object.assign(vals, { _id: ctx.view.sel }) });
      },
      eclear(ctx) {
        const d = ctx.view.edraft || {};
        ctx.set({ edraft: { _id: ctx.view.sel, bin: d.bin }, _focus: 'ce-code' });
      },
      recount(ctx, el) {
        const s = RRS.q.get(ctx.state, 'count_sessions', ctx.view.sel);
        const l = s && (s.lines || []).find((x) => x.key === el.dataset.arg);
        if (!l) return;
        ctx.set({ edraft: { _id: s.id, code: l.code, bin: l.bin, lot: l.lot }, lastEntry: { id: s.id, tone: 'info', msg: `นับซ้ำ ${l.code}${l.bin ? ' ช่อง ' + l.bin : ''}${l.lot ? ' ล็อต ' + l.lot : ''} – นับของจริงแล้วกรอกจำนวน (ไม่ต้องดูผลของคนก่อน)` },
          _focus: 'ce-qty', _scrollTo: 'ct-entry' });
      },
      async submit(ctx) {
        const s = RRS.q.get(ctx.state, 'count_sessions', ctx.view.sel);
        if (!s) return;
        const cv = rec.countView(ctx.state, s.id);
        if (!cv.canSubmit) return ctx.toast(cv.totals.pending ? `ยังมี ${cv.totals.pending} บรรทัดรอนับซ้ำโดยคนอื่น – ส่งไม่ได้` : 'ยังไม่มีผลนับ – กรอกผลนับก่อน', 'bad');
        const ok = await ctx.confirm({ title: `ส่งผลนับ ${s.id}`, ok: 'ส่งผลนับ',
          message: `ส่งผลนับ ${cv.lines.length} บรรทัดให้ผู้อนุมัติ (${roleNames('count.approve')} ที่ไม่ได้นับรอบนี้) – หลังส่งกรอกผลนับเพิ่มไม่ได้${cv.totals.uncounted ? ` · มี ${cv.totals.uncounted} ตำแหน่งที่มีของในระบบแต่ไม่ได้นับ จะไม่ถูกปรับยอด` : ''}` });
        if (!ok) return;
        await ctx.exec('count.submit', { id: s.id }, { done: `ส่งผลนับ ${s.id} แล้ว – รออนุมัติ` });
      },
      async cancel(ctx) {
        const s = RRS.q.get(ctx.state, 'count_sessions', ctx.view.sel);
        if (!s) return;
        await ctx.dialog({ title: `ยกเลิกรอบนับ ${s.id}`, submit: 'ยกเลิกรอบนับ', danger: true,
          message: `ผลนับที่กรอกแล้วจะไม่ถูกใช้ ไม่มีการปรับยอด${s.mode === 'freeze' ? ' และพื้นที่ที่หยุดไว้จะรับ–จ่ายได้อีกครั้ง' : ''} · ประวัติรอบนี้ยังอยู่`,
          body: h.field({ name: 'reason', label: 'เหตุผลที่ยกเลิก', required: true, wide: true, id: 'ct-cancel-reason', placeholder: 'เช่น เปิดรอบผิดคลัง / นับไม่ทันต้องนับใหม่' }),
          onSubmit: (vals) => (util.trim(vals.reason)
            ? ctx.exec('count.cancel', { id: s.id, reason: vals.reason }, { quiet: true, done: `ยกเลิกรอบนับ ${s.id} แล้ว` })
            : { ok: false, errors: [{ message: 'ใส่เหตุผลที่ยกเลิกรอบนับ' }] }) });
      },
      async csv(ctx) {
        const s = RRS.q.get(ctx.state, 'count_sessions', ctx.view.sel);
        if (!s) return;
        const cv = rec.countView(ctx.state, s.id);
        const sees = seesSystem(ctx, s);
        const head = ['รหัสสินค้า', 'ชื่อสินค้า', 'คลัง', 'ช่องเก็บ', 'ล็อต', 'นับได้', 'หน่วย'].concat(sees ? ['ระบบ ณ เวลานับ', 'ผลต่าง'] : [], ['ผู้นับ', 'เวลานับ', 'สถานะ', 'เหตุผล']);
        const out = [['รอบนับ', s.id, 'คลัง', s.wh, 'สถานะ', rec.COUNT_STATUS[s.status] || s.status, 'ใบปรับยอด', s.docNo || ''], head];
        for (const l of cv.lines) {
          const counted = l.final ? l.final.counted : sees ? l.counted : '';
          out.push([l.code, l.name, s.wh, l.bin, l.lot, counted, l.unit].concat(sees ? [l.final ? l.final.system : l.system, l.adjust || 0] : [],
            [names(ctx, lineCounters(l)), h.fmt.dt((l.final && l.final.at) || l.countedAt), (l.flags || []).map((f) => FLAG_SHORT[f] || f).join(' / '), l.reason || '']));
        }
        await ctx.download(`count-${s.id}-${ctx.today}.csv`, h.csv(out));
      },
    },
    forms: {
      async create(ctx, vals) {
        const wh = util.normCode(vals.wh);
        if (!wh) return ctx.toast('เลือกคลังที่จะนับ', 'bad');
        if (vals.mode !== 'timestamp' && vals.mode !== 'freeze') return ctx.toast('เลือกว่าระหว่างนับจะให้รับ–จ่ายต่อได้ หรือหยุดเคลื่อนไหว', 'bad');
        const r = await ctx.exec('count.create', { wh, bins: vals.bins || [], mode: vals.mode, note: vals.note }, { quiet: true });
        if (!r.ok) {
          ctx.set({ cdraft: { wh, bins: vals.bins || [], mode: vals.mode, note: vals.note } });
          return ctx.toast(r.errors[0] ? r.errors[0].message : 'เปิดรอบนับไม่สำเร็จ', 'bad');
        }
        const id = r.result && r.result.id;
        ctx.toast(`เปิดรอบนับ ${id} แล้ว – ${vals.mode === 'freeze' ? 'พื้นที่นี้หยุดรับ–จ่ายจนกว่าจะอนุมัติหรือยกเลิก' : 'ให้ผู้นับเลือกรอบนี้แล้วกรอกผลนับ'}`, 'ok');
        ctx.set({ newOpen: false, cdraft: null, sel: id, tab: 'open', lastEntry: null, _scrollTo: 'ct-detail' });
      },
      async enter(ctx, vals) {
        const s = RRS.q.get(ctx.state, 'count_sessions', ctx.view.sel);
        if (!s) return;
        const draft = Object.assign({}, vals, { _id: s.id });
        const code = util.trim(vals.code);
        const n = util.num(vals.counted);
        if (!code) {
          ctx.set({ edraft: draft, _focus: 'ce-code' });
          return ctx.toast('ใส่รหัสสินค้าที่นับ', 'bad');
        }
        if (isNaN(n) || n < 0) {
          ctx.set({ edraft: draft, _focus: 'ce-qty' });
          return ctx.toast('ใส่จำนวนที่นับได้เป็นตัวเลขตั้งแต่ 0 (ไม่มีของเลย ใส่ 0)', 'bad');
        }
        const w = RRS.q.get(ctx.state, 'warehouses', s.wh) || {};
        const hasBins = s.bins.length || RRS.q.rows(ctx.state, 'bins', (b) => b.wh === s.wh && b.active !== false).length;
        if (!vals.bin && hasBins && (w.requireBin || s.bins.length)) {
          ctx.set({ edraft: draft, _focus: 'ce-bin' });
          return ctx.toast(`เลือกช่องเก็บที่นับ${s.bins.length ? ` (รอบนี้นับช่อง ${s.bins.join(', ')})` : ` – คลัง ${s.wh} ต้องระบุช่องเก็บ`}`, 'bad');
        }
        const line = { code, bin: vals.bin || '', lot: util.trim(vals.lot), counted: n, unit: vals.unit || '' };
        const r = await ctx.exec('count.enter', { id: s.id, lines: [line] }, { quiet: true });
        const it = RRS.q.item(ctx.state, code);
        const where = `${line.bin ? ' ช่อง ' + line.bin : ''}${line.lot ? ' ล็อต ' + line.lot : ''}`;
        if (!r.ok) {
          const e = r.errors[0] || {};
          let msg = e.message ? e.message.replace(/^บรรทัด 1: /, '') : 'บันทึกไม่สำเร็จ';
          if (e.code === 'SAME_PERSON') msg += ' – ถ้ากรอกผิด ให้คนอื่นนับบรรทัดนี้ซ้ำ ระบบใช้ผลที่สองคนนับได้ตรงกัน';
          // put the cursor where the problem is (a scanned code with Enter may arrive before the lot field is shown)
          const focus = { code: 'ce-code', bin: 'ce-bin', lot: 'ce-lot', counted: 'ce-qty', unit: 'ce-unit' }[e.field] || 'ce-code';
          ctx.set({ edraft: draft, lastEntry: { id: s.id, tone: 'bad', msg: `บันทึกไม่ได้: ${msg}` }, _focus: focus });
          return ctx.toast(msg, 'bad');
        }
        const flags = (r.result && r.result.lines && r.result.lines[0] && r.result.lines[0].flags) || [];
        const name = it ? it.id : code;
        const qtyText = `${h.fmt.num(n)} ${line.unit || (it ? it.baseUnit : '')}`;
        let last;
        if (flags.indexOf('RECOUNT') >= 0) last = { tone: 'warn', msg: `บันทึก ${name}${where} = ${qtyText} แล้ว – ต่างจากระบบเกินเกณฑ์ ต้องให้คนอื่น (ไม่ใช่คุณ) นับซ้ำ` };
        else if (flags.indexOf('DUPLICATE') >= 0) last = { tone: 'warn', msg: `บันทึก ${name}${where} = ${qtyText} แล้ว – ผลไม่ตรงกับการนับครั้งก่อน ต้องให้อีกคนนับซ้ำ` };
        else if (flags.indexOf('RECOUNTED') >= 0) last = { tone: 'ok', msg: `บันทึกนับซ้ำ ${name}${where} = ${qtyText} แล้ว – ตรงกับการนับก่อนหน้า ใช้ผลนี้` };
        else last = { tone: 'ok', msg: `บันทึก ${name}${where} = ${qtyText} แล้ว – นับบรรทัดต่อไปได้เลย` };
        ctx.toast(last.msg, last.tone === 'ok' ? 'ok' : 'warn');
        ctx.set({ edraft: { _id: s.id, bin: line.bin }, ebin: line.bin, lastEntry: Object.assign({ id: s.id }, last), _focus: 'ce-code' });
      },
      async approve(ctx, vals) {
        const s = RRS.q.get(ctx.state, 'count_sessions', ctx.view.sel);
        if (!s) return;
        const cv = rec.countView(ctx.state, s.id);
        const reasons = { _id: s.id };
        for (const x of vals.r || []) if (x && x.key) reasons[x.key] = util.trim(x.reason);
        const send = {};
        for (const l of cv.lines) if (l.adjust && reasons[l.key]) send[l.key] = reasons[l.key];
        const missing = cv.lines.filter((l) => l.adjust && !send[l.key]);
        if (missing.length) {
          ctx.set({ reasons, ack: !!vals.ack, apErr: { id: s.id, errors: missing.slice(0, 10).map((l) => ({ message: `${l.code}${l.bin ? ' ช่อง ' + l.bin : ''}${l.lot ? ' ล็อต ' + l.lot : ''}: ผลต่าง ${signed(l.adjust)} – ใส่เหตุผล` })) } });
          return ctx.toast(`ใส่เหตุผลของผลต่างให้ครบ – ยังขาด ${missing.length} บรรทัด`, 'bad');
        }
        if (cv.needsAck && !vals.ack) {
          ctx.set({ reasons, ack: false, apErr: null });
          return ctx.toast('ติ๊ก รับทราบ รายการที่เคลื่อนไหวหลังนับ/ของรอตรวจ ก่อนอนุมัติ', 'bad');
        }
        const tot = cv.totals;
        const ok = await ctx.confirm({ title: `อนุมัติผลนับ ${s.id}`, ok: tot.adjustLines ? 'อนุมัติและปรับยอด' : 'อนุมัติ',
          message: tot.adjustLines
            ? `สร้างใบปรับยอด AJ 1 ใบ ${tot.adjustLines} บรรทัด (เพิ่ม ${signed(tot.plus)} / ลด ${h.fmt.num(tot.minus)}) ที่คลัง ${s.wh} – ยอดคงเหลือเปลี่ยนทันที`
            : 'ไม่มีผลต่าง – ปิดรอบนับนี้โดยไม่ปรับยอด' });
        if (!ok) {
          ctx.view.reasons = reasons;
          ctx.view.ack = !!vals.ack;
          return;
        }
        const r = await ctx.exec('count.approve', { id: s.id, reasons: send, ack: vals.ack === true }, { quiet: true });
        if (!r.ok) {
          ctx.set({ reasons, ack: !!vals.ack, apErr: { id: s.id, errors: r.errors.slice(0, 10) } });
          return ctx.toast(r.errors[0] ? r.errors[0].message : 'อนุมัติไม่สำเร็จ', 'bad');
        }
        const docNo = r.result && r.result.docNo;
        ctx.toast(docNo ? `อนุมัติผลนับ ${s.id} แล้ว – สร้างใบปรับยอด ${docNo}` : `อนุมัติผลนับ ${s.id} แล้ว – ไม่มีผลต่าง`, 'ok');
        ctx.set({ reasons: null, ack: false, apErr: null, _scrollTo: 'ct-detail' });
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
