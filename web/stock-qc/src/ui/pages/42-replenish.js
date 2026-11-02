/*
 * Phase 4 – แผนเติมสต็อก (src/engine/purchasing.js). RRS.purchasing.suggest per item (or per warehouse) with every
 * number and the engine's Thai reasons: available, รอตรวจ (not counted), reserved, in transit, incoming that arrives in
 * time vs late PO lines, job demand, projected, Min/Max and where they come from, MOQ/pack rounding. Filters ต้องสั่ง /
 * ใกล้ Min / ทั้งหมด and warehouse. Pick rows → preview → one PR (pr.create). Late PO lines with the jobs they hold up
 * (RRS.purchasing.affectedJobs).
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const U = RRS.util;
  const P = () => RRS.purchasing || null;

  const STEP = 300;
  const dash = t`<span class="muted">–</span>`;
  const low = (s) => String(s == null ? '' : s).toLowerCase();
  const n = (v) => h.fmt.num(v);
  const n0 = (v) => (v ? n(v) : dash);
  const STATUS = { ORDER: ['ต้องสั่ง', 'bad'], COVERED: ['ขอซื้อไว้แล้ว', 'info'], OK: ['พอ', 'ok'], OFF: ['ปิดการแนะนำ', 'muted'] };
  /** COVERED by stock waiting for QC only (nothing requested) is not "ขอซื้อไว้แล้ว". */
  const statusLabel = (r) => (r.status === 'COVERED' && !(r.pendingPr + r.draftPo > 0) ? 'รอผล QC' : (STATUS[r.status] || [r.status])[0]);
  const statusBadge = (r) => h.badge(statusLabel(r), (STATUS[r.status] || [])[1] || 'muted');
  /**
   * Number boxes the browser could not read (e.g. "5-"): the form gets an empty value for them. One Thai error per box.
   */
  function badNumbers(form) {
    const out = [];
    for (const el of form ? form.querySelectorAll('input[type="number"]') : []) {
      if (!el.validity || !el.validity.badInput) continue;
      out.push({ code: 'NOT_A_NUMBER', message: `ช่อง "${el.getAttribute('aria-label') || el.name}" อ่านเป็นตัวเลขไม่ได้ – พิมพ์เฉพาะตัวเลข เช่น 12 หรือ 12.5 (ยังไม่ได้บันทึก)` });
    }
    return out;
  }
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
  /** Not ordering yet but close: at/below Min and already requested, or within a quarter of the Min–Max band above Min. */
  const isNear = (r) => r.status === 'COVERED' || (r.status === 'OK' && r.min > 0 && r.projected <= r.min + Math.max(1, (r.max - r.min) * 0.25));

  // suggest() reads every item, balance, reservation, job and PO: keep the last few results per state + warehouse
  const cache = [];
  function suggest(ctx, wh) {
    const key = `${ctx.state.seq}|${ctx.state.head}|${wh || ''}|${ctx.today}`;
    const hit = cache.find((c) => c.key === key);
    if (hit) return hit.rows;
    let rows;
    try {
      rows = P().suggest(ctx.state, { today: ctx.today, wh: wh || '' });
    } catch (e) {
      if (root.console) root.console.error(e);
      rows = [];
    }
    cache.unshift({ key, rows });
    if (cache.length > 4) cache.length = 4;
    return rows;
  }
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
  const prLink = (prNo) => h.link(h.code(prNo), 'purchasing', { tab: 'pr', pr: prNo, prLines: null, prHead: null, prChecked: null, _scroll: true });
  const poLink = (poNo, line) => h.link(h.code(line ? `${poNo}/${line}` : poNo), 'purchasing', { tab: 'po', po: poNo, _scroll: true });
  const prReason = (ctx, r) => `แนะนำสั่งซื้อ ${ctx.today}: คาดการณ์ ${U.round(r.projected, 4)} ≤ Min ${U.round(r.min, 4)} → ${U.round(r.orderBuyQty, 4)} ${r.buyUnit}`;

  function filtered(ctx) {
    const v = ctx.view;
    const all = suggest(ctx, v.wh);
    const q = low(v.q).trim();
    const f = v.f || 'order';
    const byQ = all.filter((r) => !q || [r.code, r.name, r.supplier, r.supplierName].some((x) => low(x).indexOf(q) >= 0));
    const rows = byQ.filter((r) => (f === 'order' ? r.status === 'ORDER' : f === 'near' ? isNear(r) : true));
    return { all, byQ, rows, f };
  }

  function kpis(ctx, all, late) {
    const order = all.filter((r) => r.status === 'ORDER');
    const money = order.reduce((s, r) => s + (r.amount || 0), 0);
    const noPrice = order.filter((r) => r.amount == null).length;
    const near = all.filter(isNear).length;
    const hold = all.filter((r) => r.qcHold > 0).length;
    const hit = late.reduce((s, l) => s + l.jobs.filter((j) => j.affected).length, 0);
    return h.kpis([
      h.kpi('ต้องสั่ง', n(order.length), order.length ? `มูลค่าประมาณ ${h.fmt.money(money)} บาท${noPrice ? ` · ${noPrice} รายการยังไม่มีราคา` : ''}` : 'ยังไม่มีรายการต่ำกว่า Min', order.length ? 'bad' : 'ok'),
      h.kpi('ใกล้ Min', n(near), 'ยังไม่ต้องสั่ง หรือขอซื้อไว้แล้ว', near ? 'warn' : ''),
      h.kpi('มีของรอตรวจ', n(hold), 'ไม่นับเป็นของพร้อมใช้จนกว่า QC ปล่อย', hold ? 'info' : ''),
      h.kpi('PO เลยกำหนด', n(late.length), hit ? `กระทบใบงาน ${n(hit)} รายการ` : late.length ? 'บรรทัดที่ยังรับไม่ครบ – ไม่มีใบงานขาดของ' : 'ไม่มีบรรทัดที่เลยกำหนด', late.length ? 'bad' : 'ok'),
    ]);
  }

  function reasonsOf(r) {
    return t`<div class="wide"><ol>${r.reasons.map((x) => t`<li>${x}</li>`)}</ol>
      ${r.prLines && r.prLines.length ? t`<p class="hint">ใบขอซื้อที่ยังไม่ออก PO: ${r.prLines.map((e) => t`${prLink(e.prNo)} บรรทัด ${e.line} ${n(e.qty)} ${r.baseUnit} · `)}</p>` : ''}
      ${r.poLines && r.poLines.length ? t`<p class="hint">ใบสั่งซื้อที่ค้างรับ: ${r.poLines.map((e) => t`${poLink(e.poNo, e.line)} ${n(e.qty)} ${r.baseUnit} กำหนด ${h.fmt.date(e.dueDate)}${e.counted ? '' : ' (ไม่นับ)'} · `)}</p>` : ''}</div>`;
  }

  function planTable(ctx, rows, limit) {
    const v = ctx.view;
    const canPr = ctx.can('pr.create');
    const picked = v.picked || {};
    const open = v.open || {};
    const cols = [];
    if (canPr) {
      cols.push({ label: 'เลือก', render: (r) => (r.status === 'ORDER'
        ? t`<input type="checkbox" data-act="pick" data-arg="${r.code}" aria-label="เลือก ${r.code}"${h.safe(picked[r.code] ? ' checked' : '')}>` : '') });
    }
    cols.push(
      { label: 'สินค้า', render: (r) => t`${h.code(r.code)} ${r.name}<br><small class="muted">หน่วย ${r.baseUnit} · ${r.supplier ? `ผู้ขาย ${r.supplier}` : 'ยังไม่มีผู้ขาย'}</small>` },
      { label: 'พร้อมใช้', num: true, render: (r) => n0(r.available) },
      { label: 'รอตรวจ/กักกัน (ไม่นับ)', num: true, render: (r) => (r.qcHold || r.quarantine ? t`<span class="muted">${n(r.qcHold + r.quarantine)}</span>` : dash) },
      { label: 'จองแล้ว', num: true, render: (r) => (r.reserved ? `−${n(r.reserved)}` : dash) },
      { label: 'ระหว่างโอน', num: true, render: (r) => (r.transit ? `+${n(r.transit)}` : dash) },
      { label: 'ค้างรับเข้าทัน', num: true, render: (r) => (r.incomingSure ? `+${n(r.incomingSure)}` : dash) },
      { label: 'PO เลยกำหนด', num: true, render: (r) => (r.incomingLate ? t`${r.lateCounted ? '+' : ''}${n(r.incomingLate)}<br><small class="muted">${r.lateCounted ? 'นับ' : 'ไม่นับ'}</small>` : dash) },
      { label: 'งานที่ยังไม่จอง', num: true, render: (r) => (r.demand ? `−${n(r.demand)}` : dash) },
      { label: 'คาดการณ์', num: true, render: (r) => t`<b>${n(r.projected)}</b>` },
      { label: 'Min / Max', num: true, render: (r) => (r.min || r.max ? `${n(r.min)} / ${n(r.max)}` : dash) },
      { label: 'ต้องเติม', num: true, render: (r) => n0(r.need) },
      { label: 'ขอ/สั่งไว้แล้ว', num: true, render: (r) => n0(U.round(r.pendingPr + r.draftPo)) },
      { label: 'แนะนำสั่ง', num: true, render: (r) => (r.orderQty ? t`<b>${n(r.orderBuyQty)} ${r.buyUnit}</b>${r.factor !== 1 ? t`<br><small class="muted">= ${n(r.orderQty)} ${r.baseUnit}</small>` : ''}${r.amount != null ? t`<br><small class="muted">≈ ${h.fmt.money(r.amount)} บาท</small>` : t`<br><small class="muted">ยังไม่มีราคา</small>`}` : dash) },
      { label: 'สถานะ', render: (r) => statusBadge(r) },
      { label: '', render: (r) => h.btn(open[r.code] || v.allWhy ? 'ซ่อนเหตุผล' : 'ดูเหตุผล', { act: 'why', arg: r.code, tone: 'quiet', small: true }) },
    );
    return h.table({
      id: 'rp-list', scroll: true, dense: true, rows: rows.slice(0, limit), cols,
      rowCls: (r) => (picked[r.code] ? 'sel' : r.status === 'ORDER' ? 'row-warn' : ''),
      detail: (r) => (open[r.code] || v.allWhy ? reasonsOf(r) : null),
    });
  }

  /**
   * Every late PO line (RRS.purchasing.outstanding) with the jobs and reservations waiting for it
   * (RRS.purchasing.affectedJobs, which leaves out lines no job needs – those are still late and must be chased).
   * atRisk also lists lines not late yet that arrive after a job needs them.
   */
  function lateRows(ctx, atRisk) {
    const key = `${ctx.state.seq}|${ctx.state.head}|${ctx.today}|${atRisk ? 1 : 0}`;
    const hit = lateCache.find((c) => c.key === key);
    if (hit) return hit.rows;
    let aj = [];
    let late = [];
    try {
      aj = P().affectedJobs(ctx.state, { today: ctx.today, atRisk: !!atRisk });
      late = P().outstanding(ctx.state, { today: ctx.today }).filter((l) => l.late);
    } catch (e) {
      if (root.console) root.console.error(e);
    }
    const seen = {};
    for (const r of aj) seen[r.poNo + '|' + r.line] = true;
    const rows = aj.concat(late.filter((l) => !seen[l.poNo + '|' + l.line]).map((l) => Object.assign({}, l, { jobs: [], reservations: [] })))
      .sort((a, b) => (b.daysLate - a.daysLate) || String(a.dueDate).localeCompare(String(b.dueDate)) || a.poNo.localeCompare(b.poNo) || a.line - b.line);
    lateCache.unshift({ key, rows });
    if (lateCache.length > 4) lateCache.length = 4;
    return rows;
  }
  const lateCache = [];
  /** What a job waiting for the late goods is short of: its need less its own reservation, then free stock by priority. */
  function jobBadge(j) {
    if (j.affected) return h.badge(`ขาด ${n(j.short)}`, 'bad');
    if (j.uncovered > 0) return h.badge(`ของในคลังพอ (${n(j.fromStock)})`, 'ok');
    return h.badge('จองครบ', 'ok');
  }

  function lateSection(ctx) {
    const v = ctx.view;
    const rows = lateRows(ctx, v.atRisk);
    const counted = settings(ctx.state).policies.lateIsUncertain === false;
    const jobsPage = ['jobs', 'job', 'production'].find((x) => RRS.ui.pages[x]);
    const jobRef = (jobNo) => (jobsPage ? h.link(h.code(jobNo), jobsPage, { sel: jobNo, _scroll: true }) : h.code(jobNo));
    const tbl = h.table({
      id: 'rp-late-tbl', scroll: true, dense: true, rows,
      empty: v.atRisk ? 'ไม่มี PO ที่เลยกำหนดหรือเข้าหลังวันต้องใช้ของงาน' : 'ไม่มีบรรทัด PO ที่เลยกำหนด',
      emptyText: 'เมื่อใบสั่งซื้อเลยกำหนดเข้าแล้วยังรับไม่ครบ จะขึ้นที่นี่พร้อมใบงานและการจองที่รอของนั้น – ฝ่ายจัดซื้อตามของหรือเลื่อนกำหนดเข้าได้ที่หน้า ขอซื้อ สั่งซื้อ และรับของ',
      rowCls: (l) => (l.jobs.some((j) => j.affected) ? 'row-bad' : ''),
      cols: [
        { label: 'PO / บรรทัด', render: (l) => poLink(l.poNo, l.line) },
        { label: 'ผู้ขาย', render: (l) => t`${h.code(l.supplier)}<br><small class="muted">${l.supplierName}</small>` },
        { label: 'สินค้า', render: (l) => t`${h.code(l.code)} ${l.name}` },
        { label: 'กำหนดเข้า', render: (l) => t`${h.fmt.date(l.dueDate)}${l.originalDue && l.originalDue !== l.dueDate ? t`<br><small class="muted">เดิม ${h.fmt.date(l.originalDue)}</small>` : ''}<br>${l.late ? h.badge(`เลย ${l.daysLate} วัน`, 'bad') : h.badge('เข้าหลังวันต้องใช้ของงาน', 'warn')}` },
        { label: 'ค้างรับ', num: true, render: (l) => h.qty(l.outstanding, l.baseUnit) },
        { label: 'ใบงานที่ต้องใช้ของนี้', render: (l) => (l.jobs.length
          ? t`${l.jobs.map((j) => t`<div>${jobRef(j.jobNo)} ต้องใช้ ${h.fmt.date(j.dueDate)} · ต้องการ ${n(j.need)} จองแล้ว ${n(j.reserved)} ${jobBadge(j)}</div>`)}`
          : t`<span class="muted">ไม่มีใบงานที่รอของนี้</span>`) },
        { label: 'การจองที่รอของ', render: (l) => (l.reservations.length ? t`${l.reservations.map((r) => t`<div>${h.code(r.jobNo)} คลัง ${r.wh} คงจอง ${n(r.remaining)}${r.needDate ? ` · ต้องใช้ ${h.fmt.date(r.needDate)}` : ''}</div>`)}` : dash) },
      ],
    });
    return h.section('PO เลยกำหนดและงานที่กระทบ', t`<div id="rp-late">${tbl}</div>`, {
      id: 'rp-late-sec',
      sub: `บรรทัดใบสั่งซื้อที่เลยวันกำหนดเข้าแล้วยังรับไม่ครบ กับใบงานที่ยังต้องใช้ของนั้น · แผนเติมสต็อก${counted ? 'ยังนับ' : 'ไม่นับ'}ของจาก PO ที่เลยกำหนดเป็นของที่จะเข้า (นโยบาย)`,
      actions: h.field({ name: 'atRisk', label: 'รวม PO ที่ยังไม่เลยกำหนดแต่เข้าหลังวันต้องใช้ของงาน', type: 'checkbox', value: v.atRisk, act: 'atRisk', id: 'rp-atrisk' }),
    });
  }

  function keepScroll() {
    const box = root.document.querySelector('#rp-list');
    return box ? box.scrollTop : 0;
  }

  RRS.ui.page({
    id: 'replenish', title: 'แผนเติมสต็อก', phase: 4, order: 20,
    sub: 'ระบบคำนวณว่าสินค้าไหนต้องสั่ง เท่าไร และเพราะอะไร จากยอดพร้อมใช้ การจอง ของที่กำลังเข้า ความต้องการของใบงาน และ Min/Max – เลือกรายการแล้วสร้างใบขอซื้อได้ทันที',
    badge: (ctx) => {
      if (!P() || !(ctx.can('pr.create') || ctx.can('po.manage'))) return '';
      return suggest(ctx, '').filter((r) => r.status === 'ORDER').length || '';
    },
    render(ctx) {
      if (!P()) return h.empty('ส่วนจัดซื้อยังไม่เปิดใช้', 'ระบบนี้ยังไม่ได้โหลดส่วนจัดซื้อ (Phase 4)');
      const v = ctx.view;
      const items = RRS.q.rows(ctx.state, 'items', (i) => i.active !== false);
      if (!items.length) {
        return h.empty('ยังไม่มีสินค้า', 'แผนเติมสต็อกคำนวณจากสินค้าในทะเบียน – เพิ่มสินค้าและตั้ง Min/Max ก่อน แล้วรายการที่ต้องสั่งจะขึ้นที่นี่', h.link('ไปทะเบียนสินค้า', 'items'));
      }
      const canPr = ctx.can('pr.create');
      const { all, byQ, rows, f } = filtered(ctx);
      const late = lateRows(ctx, false);
      const limit = v.limit || STEP;
      const picked = v.picked || {};
      const pickedRows = all.filter((r) => picked[r.code] && r.status === 'ORDER');
      const counted = settings(ctx.state).policies.lateIsUncertain === false;
      const explain = h.note(t`คาดการณ์คงเหลือ = พร้อมใช้ − จองให้งานแล้ว + ระหว่างโอน + ค้างรับจาก PO ที่เข้าทันภายใน Lead time${counted ? ' + PO เลยกำหนด' : ''} − ความต้องการของใบงานที่ยังไม่จอง ·
        ของรอตรวจ/กักกันไม่นับ · PO เลยกำหนด${counted ? 'นับ' : 'ไม่นับ'} (นโยบาย) · คาดการณ์ ≤ Min → แนะนำเติมถึง Max หักที่ขอซื้อ/สั่งไว้แล้ว ปัดเป็นหน่วยซื้อเต็ม ไม่น้อยกว่า MOQ และเป็นทวีคูณของแพ็ก ·
        ตัวเลขเป็นหน่วยหลัก ยกเว้น แนะนำสั่ง (หน่วยซื้อ)`, 'info');
      const counts = { order: byQ.filter((r) => r.status === 'ORDER').length, near: byQ.filter(isNear).length, all: byQ.length };
      const tabs = h.tabs([{ id: 'order', label: 'ต้องสั่ง', count: counts.order }, { id: 'near', label: 'ใกล้ Min', count: counts.near }, { id: 'all', label: 'ทั้งหมด', count: counts.all }], f, 'f');
      const left = [
        h.field({ name: 'q', label: 'ค้นหา', value: v.q, placeholder: 'รหัส ชื่อ ผู้ขาย…', id: 'rp-q', act: 'q', live: true }),
        h.field({ name: 'wh', label: 'คลัง', type: 'select', value: v.wh, options: h.whOptions(ctx.state), blank: 'ทุกคลัง (ภาพรวม)', id: 'rp-wh', act: 'wh' }),
        h.field({ name: 'allWhy', label: 'แสดงเหตุผลทุกแถว', type: 'checkbox', value: v.allWhy, id: 'rp-allwhy', act: 'allWhy' }),
      ];
      const right = [
        canPr && counts.order ? h.btn('เลือกทุกรายการที่ต้องสั่ง', { act: 'pickAll', tone: 'ghost' }) : '',
        canPr && pickedRows.length ? h.btn('ล้างที่เลือก', { act: 'pickNone', tone: 'quiet' }) : '',
        canPr ? h.btn(`สร้างใบขอซื้อจากที่เลือก (${pickedRows.length})`, { act: 'makePr', tone: 'primary', disabled: !pickedRows.length, id: 'rp-make',
          title: pickedRows.length ? 'ดูตัวอย่างก่อนสร้าง' : 'ติ๊กเลือกรายการที่ต้องสั่งก่อน' }) : '',
        rows.length ? h.btn('ดาวน์โหลด CSV', { act: 'csv', tone: 'ghost' }) : '',
      ];
      let list;
      if (!rows.length) {
        list = f === 'order'
          ? h.empty('ยังไม่มีรายการที่ต้องสั่ง', 'รายการจะขึ้นเมื่อคาดการณ์คงเหลือต่ำกว่าหรือเท่ากับ Min – ตั้ง Min/Max ที่ทะเบียนสินค้าหรือเงื่อนไขเติมสต็อก และตั้งผู้ขาย/หน่วยซื้อที่หน้าผู้ขาย (ไม่มี Min/Max ระบบใช้สถิติยอดเบิก)',
            t`<div class="form-actions">${h.link('ตั้งเงื่อนไขเติมสต็อก', 'suppliers', { tab: 'rules' })}${h.link('ดูทั้งหมด', 'replenish', { f: 'all' })}</div>`)
          : f === 'near' ? h.empty('ไม่มีรายการใกล้ Min', 'รายการที่คาดการณ์ใกล้ Min หรือขอซื้อไว้แล้วจะขึ้นที่นี่')
            : h.empty('ไม่พบสินค้าตามคำค้น', 'ลองคำค้นอื่น หรือเลือกทุกคลัง');
      } else list = planTable(ctx, rows, limit);
      const more = rows.length > limit
        ? t`<p class="hint">แสดง ${n(limit)} จาก ${n(rows.length)} รายการ ${h.btn(`แสดงเพิ่มอีก ${n(Math.min(STEP, rows.length - limit))}`, { act: 'more', tone: 'ghost', small: true })}</p>`
        : rows.length ? t`<p class="hint">${n(rows.length)} รายการ${canPr ? ' · ติ๊กรายการที่ต้องสั่งแล้วกด สร้างใบขอซื้อจากที่เลือก' : ` · สร้างใบขอซื้อได้เฉพาะ ${whoCan('pr.create')}`}</p>` : '';
      const made = !v.made ? '' : v.made.status === 'DRAFT'
        ? h.note(t`บันทึกร่างใบขอซื้อ ${prLink(v.made.prNo)} แล้ว – ร่างยังไม่นับเป็น "ขอซื้อไว้แล้ว" จนกว่าจะส่งขออนุมัติที่หน้าขอซื้อ`, 'warn')
        : h.note(t`สร้างใบขอซื้อ ${prLink(v.made.prNo)} และส่งขออนุมัติแล้ว · รายการเหล่านี้ขึ้นเป็น "ขอซื้อไว้แล้ว" ในแท็บ ใกล้ Min`, 'ok');
      return t`${kpis(ctx, all, late)}${explain}${made}${tabs}${h.toolbar(left, right)}<div>${list}${more}</div>${lateSection(ctx)}`;
    },
    after(ctx, root0) {
      const v = ctx.view;
      if (v._st != null) {
        const box = root0.querySelector('#rp-list');
        if (box) box.scrollTop = v._st;
        v._st = null;
      }
    },
    actions: {
      f: (ctx, el) => set(ctx, { f: el.dataset.arg, limit: STEP }),
      q: live('q', { limit: STEP }),
      wh: (ctx, el) => set(ctx, { wh: el.value, picked: {}, limit: STEP, made: null }),
      allWhy: (ctx, el) => set(ctx, { allWhy: el.checked, _st: keepScroll() }),
      atRisk: (ctx, el) => set(ctx, { atRisk: el.checked }),
      more: (ctx) => set(ctx, { limit: (ctx.view.limit || STEP) + STEP, _st: keepScroll() }),
      why(ctx, el) {
        const open = Object.assign({}, ctx.view.open || {});
        if (ctx.view.allWhy) return set(ctx, { allWhy: false, open: {}, _st: keepScroll() });
        open[el.dataset.arg] = !open[el.dataset.arg];
        set(ctx, { open, _st: keepScroll() });
      },
      pick(ctx, el) {
        const picked = Object.assign({}, ctx.view.picked || {});
        if (el.checked) picked[el.dataset.arg] = true;
        else delete picked[el.dataset.arg];
        set(ctx, { picked, _st: keepScroll() });
      },
      pickAll(ctx) {
        const picked = {};
        for (const r of filtered(ctx).byQ) if (r.status === 'ORDER') picked[r.code] = true;
        set(ctx, { picked, _st: keepScroll() });
      },
      pickNone: (ctx) => set(ctx, { picked: {}, _st: keepScroll() }),
      async csv(ctx) {
        const { rows } = filtered(ctx);
        const v = ctx.view;
        const head = ['รหัสสินค้า', 'ชื่อสินค้า', 'หน่วยหลัก', 'คลัง', 'พร้อมใช้', 'รอตรวจ', 'กักกัน/รอแก้ไข', 'จองแล้ว', 'ระหว่างโอน', 'ค้างรับเข้าทัน', 'PO เลยกำหนด',
          'นับ PO เลยกำหนด', 'งานที่ยังไม่จอง', 'คาดการณ์', 'Min', 'Max', 'ที่มา Min/Max', 'Lead time (วัน)', 'ผู้ขาย', 'ต้องเติม', 'ขอ/สั่งไว้แล้ว',
          'แนะนำสั่ง (หน่วยซื้อ)', 'หน่วยซื้อ', 'แนะนำสั่ง (หน่วยหลัก)', 'มูลค่าประมาณ', 'สถานะ', 'เหตุผล'];
        const out = [head].concat(rows.map((r) => [r.code, r.name, r.baseUnit, r.wh || 'ทุกคลัง', r.available, r.qcHold, r.quarantine, r.reserved, r.transit,
          r.incomingSure, r.incomingLate, r.lateCounted ? 'นับ' : 'ไม่นับ', r.demand, r.projected, r.min, r.max, r.minMaxFrom, r.leadDays, r.supplier,
          r.need, U.round(r.pendingPr + r.draftPo), r.orderBuyQty, r.buyUnit, r.orderQty, r.amount == null ? '' : r.amount, statusLabel(r),
          r.reasons.join(' | ')]));
        await ctx.download(`แผนเติมสต็อก-${v.wh || 'ทุกคลัง'}-${ctx.today}.csv`, h.csv(out));
      },
      async makePr(ctx) {
        const v = ctx.view;
        const picked = v.picked || {};
        const rows = suggest(ctx, v.wh).filter((r) => picked[r.code] && r.status === 'ORDER');
        if (!rows.length) return ctx.toast('ติ๊กเลือกรายการที่ต้องสั่งก่อน', 'bad');
        const dw = defWh(ctx);
        const whOpts = h.whOptions(ctx.state);
        const money = rows.reduce((s, r) => s + (r.amount || 0), 0);
        const body = t`<div class="wide">${h.table({ rows, dense: true, cols: [
          { label: 'สินค้า', render: (r, i) => t`<input type="hidden" name="lines[${i}][code]" value="${r.code}"><input type="hidden" name="lines[${i}][supplier]" value="${r.supplier}"><input type="hidden" name="lines[${i}][reason]" value="${prReason(ctx, r)}">${h.code(r.code)} ${r.name}<br><small class="muted">คาดการณ์ ${n(r.projected)} · Min ${n(r.min)} / Max ${n(r.max)}</small>` },
          { label: `จำนวนขอซื้อ (หน่วยหลัก)`, render: (r, i) => t`<input name="lines[${i}][qty]" type="number" step="any" inputmode="decimal" value="${r.orderQty}" aria-label="จำนวน ${r.code}"><br><small class="muted">${r.baseUnit} · แนะนำ ${n(r.orderBuyQty)} ${r.buyUnit}</small>` },
          { label: 'วันต้องใช้', render: (r, i) => t`<input name="lines[${i}][needDate]" type="date" value="${r.needDate}" aria-label="วันต้องใช้ ${r.code}">` },
          { label: 'เข้าคลัง', render: (r, i) => t`<select name="lines[${i}][wh]" aria-label="คลัง ${r.code}"><option value="">— เลือก —</option>${whOpts.map(([c, l]) => t`<option value="${c}"${h.safe(c === (r.wh || dw) ? ' selected' : '')}>${l}</option>`)}</select>` },
          { label: 'ผู้ขาย', render: (r) => (r.supplier ? h.code(r.supplier) : h.badge('ยังไม่มี', 'warn')) },
          { label: 'มูลค่าประมาณ', num: true, render: (r) => (r.amount != null ? h.fmt.money(r.amount) : h.badge('ยังไม่มีราคา', 'warn')) },
        ] })}</div>
          <p class="wide hint">รวมประมาณ ${h.fmt.money(money)} บาท (เฉพาะรายการที่มีราคา) · วันต้องใช้ตั้งตาม Lead time แก้ได้ · ใบขอซื้อเก็บจำนวนเป็นหน่วยหลัก ฝ่ายจัดซื้อแปลงเป็นหน่วยซื้อตอนออกใบสั่งซื้อ</p>
          ${h.field({ name: 'remark', label: 'หมายเหตุ', value: `จากแผนเติมสต็อก ${h.fmt.date(ctx.today)}${v.wh ? ' คลัง ' + v.wh : ''}`, wide: true })}
          ${h.field({ name: 'mode', label: 'เมื่อกดสร้าง', type: 'radio', value: 'submit', options: [['submit', 'ส่งขออนุมัติทันที'], ['draft', 'บันทึกเป็นร่าง (แก้ต่อที่หน้าขอซื้อ)']], wide: true })}
          <p class="wide hint">ผู้ขออนุมัติใบของตัวเองไม่ได้ – ${whoCan('pr.approve')} คนอื่นเป็นผู้อนุมัติ</p>`;
        const r = await ctx.dialog({ title: `สร้างใบขอซื้อจาก ${rows.length} รายการ`, submit: 'สร้างใบขอซื้อ', wide: true, body,
          onSubmit: (vals, form) => {
            const bad = badNumbers(form);
            if (bad.length) return { ok: false, errors: bad };
            return ctx.exec('pr.create', { draft: vals.mode === 'draft', remark: vals.remark, source: 'แผนเติมสต็อก',
              lines: (vals.lines || []).map((l) => ({ code: l.code, qty: l.qty, needDate: l.needDate, wh: l.wh, supplier: l.supplier, reason: l.reason })) },
            { quiet: true, done: (x) => `สร้างใบขอซื้อ ${x.result.prNo} แล้ว` });
          } });
        if (r && r.ok) set(ctx, { picked: {}, made: { prNo: r.result.prNo, status: r.result.status } });
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
