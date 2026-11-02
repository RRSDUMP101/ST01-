/*
 * Phase 6 – รายงาน (engine: RRS.reports – pure read functions of the state). One tab per entry of RRS.reports.LIST:
 *   stockByLocation  ยอดตามคลัง/ช่องเก็บ/สถานะ/ล็อต with the reference value (and the note that value and costing follow
 *                    the agreement with accounting / Express)
 *   shortageExcess   available vs Min/Max and open-job demand        nonMoving   no movement for N days (filter)
 *   aging            age buckets 0-30 / 31-90 / 91-180 / >180         countAccuracy  approved counts within tolerance
 *   qcPending        stock in รอตรวจ/กักกัน/รอแก้ไข, open inspections and NCRs
 *   fpy / qcWait     first-pass yield per stage and code / hours from arriving in QC to the inspection
 *   repeatIssues     NCRs with the same code + defect                  kpiActuals  actual vs the Phase 0 baseline/target
 *   dailyCheck       the daily integrity check with a clear OK / problem summary; daily.check records it
 * Every table downloads as CSV (h.csv). Long tables scroll inside their own box and show 300 rows at a time.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const U = RRS.util;
  const R = () => RRS.reports || null;

  const STEP = 300;
  const dash = t`<span class="muted">–</span>`;
  const low = (s) => String(s == null ? '' : s).toLowerCase();
  const num = (v, d) => (v == null || v === '' || isNaN(Number(v)) ? dash : h.fmt.num(v, d));
  const money = (v) => (v == null || v === '' || isNaN(Number(v)) ? dash : h.fmt.money(v));
  const pctText = (v) => (v == null ? 'ยังวัดไม่ได้' : `${h.fmt.num(v, 1)}%`);
  const hoursText = (v) => (v == null ? 'ยังวัดไม่ได้' : `${h.fmt.num(v, 1)} ชม.`);
  const SHORT_TONE = { SHORT: 'bad', BELOW_MIN: 'warn', OVER_MAX: 'info', OK: 'ok' };
  const STAGES = { INCOMING: 'ตรวจรับ', IN_PROCESS: 'ระหว่างผลิต', FINAL: 'ก่อนส่งมอบ' };
  const NCR_STATUS = () => (RRS.quality && RRS.quality.NCR_STATUS) || { OPEN: 'รอตัดสิน', DISPOSITIONED: 'ตัดสินแล้ว', CLOSED: 'ปิดแล้ว' };
  const DISPOSITIONS = () => (RRS.quality && RRS.quality.DISPOSITIONS) || {};

  const docLink = (ctx, docNo) => {
    if (!docNo) return dash;
    return RRS.q.get(ctx.state, 'documents', docNo) ? h.link(h.code(docNo), 'docs', { sel: docNo, lines: null, checked: null, header: null }) : h.code(docNo);
  };
  const recLink = (page, id, view) => (id ? (RRS.ui.pages[page] ? h.link(h.code(id), page, view) : h.code(id)) : dash);
  const pageLink = (label, page, view) => (RRS.ui.pages[page] ? h.link(label, page, view) : '');
  const whCell = (r) => (r.wh === RRS.TRANSIT ? h.badge('ระหว่างโอน', 'info') : h.code(r.wh));
  const codeCell = (r) => h.code(r.code);

  // ---- running a report (pure, cached per state + options) -------------------------------------------------------
  const cache = [];
  function run(ctx, id, opts) {
    const key = `${ctx.state.seq}|${ctx.state.head}|${id}|${JSON.stringify(opts || {})}`;
    const hit = cache.find((c) => c.key === key);
    if (hit) return hit.r;
    let r;
    try {
      r = R()[id](ctx.state, opts || {});
    } catch (e) {
      if (root.console) root.console.error(e);
      r = { rows: [], cols: [], totals: {}, error: (e && e.message) || String(e) };
    }
    cache.unshift({ key, r });
    if (cache.length > 8) cache.length = 8;
    return r;
  }

  // ---- CSV ------------------------------------------------------------------------------------------------------------
  const cell = (v) => (v == null ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'ใช่' : 'ไม่ใช่') : v);
  /** Report columns + rows -> CSV text (h.csv). `fmt` maps a key to a function giving the cell text. */
  function csvOf(cols, rows, fmt) {
    fmt = fmt || {};
    return h.csv([cols.map((c) => c.label)].concat(rows.map((r) => cols.map((c) => cell(fmt[c.key] ? fmt[c.key](r) : r[c.key])))));
  }
  const dateFmt = { since: (r) => h.fmt.date(r.since), sinceDate: (r) => h.fmt.date(r.sinceDate), lastMoveDate: (r) => h.fmt.date(r.lastMoveDate),
    approvedDate: (r) => h.fmt.date(r.approvedDate), firstDate: (r) => h.fmt.date(r.firstDate), lastDate: (r) => h.fmt.date(r.lastDate),
    arrivedAt: (r) => h.fmt.dt(r.arrivedAt), inspectedAt: (r) => h.fmt.dt(r.inspectedAt), wh: (r) => (r.wh === RRS.TRANSIT ? 'ระหว่างโอน' : r.wh) };

  // ---- tables -------------------------------------------------------------------------------------------------------
  /**
   * Engine columns -> h.table columns: numbers right aligned, values as money, per-key renderers from `render`.
   * Rows beyond the view's limit wait for "แสดงเพิ่ม".
   */
  function grid(ctx, o) {
    const render = o.render || {};
    const cols = o.cols.map((c) => {
      if (render[c.key]) return { label: c.label, num: !!c.num, render: render[c.key] };
      if (c.key === 'value' || c.key === 'unitCost') return { label: c.label, num: true, render: (r) => money(r[c.key]) };
      if (c.num) return { label: c.label, num: true, render: (r) => num(r[c.key]) };
      return { label: c.label, render: (r) => (r[c.key] == null || r[c.key] === '' ? dash : Array.isArray(r[c.key]) ? r[c.key].join(', ') : r[c.key]) };
    });
    const limit = o.limit || STEP;
    const rows = o.rows || [];
    const tbl = h.table({ cols, rows: rows.slice(0, limit), scroll: true, dense: true, id: o.id, rowCls: o.rowCls,
      empty: o.empty || 'ไม่มีรายการ', emptyText: o.emptyText || '' });
    const more = rows.length > limit
      ? t`<p class="hint">แสดง ${h.fmt.num(limit)} จาก ${h.fmt.num(rows.length)} แถว ${h.btn(`แสดงเพิ่มอีก ${h.fmt.num(Math.min(STEP, rows.length - limit))} แถว`, { act: 'more', tone: 'ghost', small: true })}</p>`
      : rows.length ? t`<p class="hint">${h.fmt.num(rows.length)} แถว</p>` : '';
    return t`${tbl}${more}`;
  }
  const csvBtn = (part, label) => h.btn(label || 'ดาวน์โหลด CSV', { act: 'csv', arg: part || 'main', tone: 'ghost', small: true });

  // ---- filters --------------------------------------------------------------------------------------------------------
  function groupsOf(state) {
    const set = new Set();
    for (const it of RRS.q.rows(state, 'items')) if (U.trim(it.group)) set.add(U.trim(it.group));
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'th'));
  }
  const fid = (tab, name) => `rp-${tab}-${name}`;
  const FIELDS = {
    wh: (ctx, tab, f) => h.field({ name: 'wh', label: 'คลัง', type: 'select', value: f.wh, options: h.whOptions(ctx.state), blank: 'ทุกคลัง', id: fid(tab, 'wh'), act: 'filter' }),
    status: (ctx, tab, f) => h.field({ name: 'status', label: 'สถานะคุณภาพ', type: 'select', value: f.status, options: Object.entries(RRS.STATUS_LABEL), blank: 'ทุกสถานะ', id: fid(tab, 'status'), act: 'filter' }),
    group: (ctx, tab, f) => {
      const g = groupsOf(ctx.state);
      return g.length ? h.field({ name: 'group', label: 'กลุ่มสินค้า', type: 'select', value: f.group, options: g, blank: 'ทุกกลุ่ม', id: fid(tab, 'group'), act: 'filter' }) : '';
    },
    q: (ctx, tab, f) => h.field({ name: 'q', label: 'ค้นหา', value: f.q, placeholder: 'รหัส ชื่อ ล็อต ช่องเก็บ…', id: fid(tab, 'q'), act: 'filter', live: true }),
    from: (ctx, tab, f) => h.field({ name: 'from', label: 'ตั้งแต่วันที่', type: 'date', value: f.from, id: fid(tab, 'from'), act: 'filter' }),
    to: (ctx, tab, f) => h.field({ name: 'to', label: 'ถึงวันที่', type: 'date', value: f.to, id: fid(tab, 'to'), act: 'filter' }),
    stage: (ctx, tab, f) => h.field({ name: 'stage', label: 'ขั้นตอนตรวจ', type: 'select', value: f.stage, options: Object.entries(STAGES), blank: 'ทุกขั้นตอน', id: fid(tab, 'stage'), act: 'filter' }),
  };
  const fields = (ctx, tab, f, names) => names.map((n) => FIELDS[n](ctx, tab, f));
  const kpiTone = (n, tone) => (n ? tone : 'ok');

  // ---- the reports ----------------------------------------------------------------------------------------------------
  const REPORTS = {
    stockByLocation: {
      opts: (ctx, f) => ({ wh: f.wh || '', status: f.status || '', group: f.group || '', includeTransit: f.noTransit ? false : undefined }),
      filters: (ctx, tab, f) => fields(ctx, tab, f, ['q', 'wh', 'status', 'group']).concat([
        h.field({ name: 'noTransit', label: 'ไม่รวมของระหว่างโอน', type: 'checkbox', value: f.noTransit, id: fid(tab, 'noTransit'), act: 'filter' })]),
      rows: (ctx, r, f) => {
        const q = low(f.q).trim();
        return q ? r.rows.filter((x) => [x.code, x.name, x.lot, x.bin, x.wh].some((y) => low(y).indexOf(q) >= 0)) : r.rows;
      },
      body(ctx, r, f, rows) {
        if (!Object.keys(ctx.state.tables.balances || {}).length) {
          return h.empty('ยังไม่มียอดคงเหลือ', 'รายงานนี้แสดงจำนวนและมูลค่าอ้างอิงตามคลัง ช่องเก็บ สถานะคุณภาพ และล็อต – ยอดจะขึ้นเมื่อย้ายยอดตั้งต้น หรือบันทึกรับเข้า',
            t`<div class="form-actions">${pageLink('ย้ายยอดตั้งต้น', 'opening')}${pageLink('ไปหน้าเอกสารรับ–จ่าย', 'docs')}</div>`);
        }
        const value = U.round(U.sum(rows, (x) => x.value), 2);
        const neg = rows.filter((x) => x.qty < 0).length;
        const byWh = {};
        for (const x of rows) {
          const w = byWh[x.wh] || (byWh[x.wh] = { wh: x.wh, whName: x.whName, rows: 0, value: 0 });
          w.rows += 1;
          w.value = U.round(w.value + x.value, 2);
        }
        const whRows = Object.values(byWh).sort((a, b) => (a.wh === RRS.TRANSIT) - (b.wh === RRS.TRANSIT) || a.wh.localeCompare(b.wh));
        const noCost = rows.filter((x) => !x.unitCost && x.qty).length;
        return t`${h.kpis([h.kpi('แถวยอด', h.fmt.num(rows.length), 'สินค้า × ตำแหน่ง × สถานะ × ล็อต'),
          h.kpi('มูลค่าอ้างอิงรวม', h.fmt.money(value), 'บาท (ตามตัวกรอง)', 'info'),
          h.kpi('ยอดติดลบ', h.fmt.num(neg), neg ? 'ตรวจในแท็บ ตรวจยอดประจำวัน' : 'ไม่มี', neg ? 'bad' : 'ok'),
          h.kpi('ไม่มีราคาอ้างอิง', h.fmt.num(noCost), 'แถวที่มูลค่าเป็น 0 เพราะไม่ได้ใส่ราคาในทะเบียนสินค้า', noCost ? 'warn' : '')])}
          ${h.note(r.note, 'warn')}
          ${whRows.length > 1 ? h.table({ dense: true, rows: whRows, cols: [{ label: 'คลัง', render: whCell }, { label: 'ชื่อคลัง', key: 'whName' },
            { label: 'แถวยอด', num: true, key: 'rows' }, { label: 'มูลค่าอ้างอิง', num: true, render: (x) => money(x.value) }] }) : ''}
          ${grid(ctx, { cols: r.cols, rows, limit: ctx.view.limit, id: 'rp-list', empty: 'ไม่พบยอดตามตัวกรอง', emptyText: 'ลองล้างตัวกรอง หรือเลือกคลัง/สถานะอื่น',
            rowCls: (x) => (x.qty < 0 ? 'row-bad' : ''),
            render: { wh: whCell, code: codeCell, statusLabel: (x) => h.statusBadge(x.status), qty: (x) => num(x.qty) } })}`;
      },
      csv: (ctx, r, f, rows) => ({ name: `stock-by-location${f.wh ? '-' + f.wh : ''}`, text: csvOf(r.cols, rows, dateFmt) }),
    },

    shortageExcess: {
      opts: (ctx, f) => ({ wh: f.wh || '', group: f.group || '', onlyProblems: !f.all }),
      filters: (ctx, tab, f) => fields(ctx, tab, f, ['q', 'wh', 'group']).concat([
        h.field({ name: 'all', label: 'แสดงรายการที่พอด้วย', type: 'checkbox', value: f.all, id: fid(tab, 'all'), act: 'filter' })]),
      rows: (ctx, r, f) => {
        const q = low(f.q).trim();
        return q ? r.rows.filter((x) => [x.code, x.name, x.group].concat(x.jobs).some((y) => low(y).indexOf(q) >= 0)) : r.rows;
      },
      body(ctx, r, f, rows) {
        const T = r.totals;
        const noItems = !RRS.q.rows(ctx.state, 'items').length;
        return t`${h.kpis([h.kpi('ขาด', h.fmt.num(T.short), 'พร้อมใช้ไม่พอใบงานที่เปิด', kpiTone(T.short, 'bad')),
          h.kpi('ต่ำกว่า Min', h.fmt.num(T.belowMin), 'หลังหักของที่ใบงานต้องใช้', kpiTone(T.belowMin, 'warn')),
          h.kpi('เกิน Max', h.fmt.num(T.overMax), 'ของเกินระดับที่ตั้งไว้', T.overMax ? 'info' : ''),
          h.kpi('พอ', h.fmt.num(T.ok), f.all ? 'รายการที่ไม่มีปัญหา' : 'ติ๊ก แสดงรายการที่พอด้วย เพื่อดู')])}
          ${h.note(t`คงเหลือหลังใช้ = พร้อมใช้ − ต้องใช้ตามใบงานที่เปิด · ของรอตรวจและของที่ยังไม่มาไม่นับเป็นพร้อมใช้${r.note ? ' · ' + r.note : ''}${RRS.ui.pages.replenish ? t` · สั่งซื้อจาก ${h.link('แผนเติมสต็อก', 'replenish')}` : ''}`, 'info')}
          ${grid(ctx, { cols: r.cols, rows, limit: ctx.view.limit, id: 'rp-list',
            empty: noItems ? 'ยังไม่มีสินค้า' : 'ไม่มีรายการขาดหรือเกิน',
            emptyText: noItems ? 'เพิ่มสินค้าและตั้ง Min/Max ในทะเบียนสินค้า แล้วรายการที่ขาดหรือเกินจะขึ้นที่นี่' : 'ทุกรายการที่มี Min/Max หรือที่ใบงานต้องใช้ ยังพอ – ติ๊ก แสดงรายการที่พอด้วย เพื่อดูทั้งหมด',
            rowCls: (x) => (x.status === 'SHORT' ? 'row-bad' : x.status === 'BELOW_MIN' ? 'row-warn' : ''),
            render: { code: codeCell, statusLabel: (x) => h.badge(x.statusLabel, SHORT_TONE[x.status]), shortQty: (x) => (x.shortQty ? t`<b>${h.fmt.num(x.shortQty)}</b>` : dash) } })}`;
      },
      csv: (ctx, r, f, rows) => {
        const cols = r.cols.concat([{ key: 'jobs', label: 'ใบงานที่ต้องใช้' }]);
        return { name: `shortage-excess${f.wh ? '-' + f.wh : ''}`, text: csvOf(cols, rows) };
      },
    },

    nonMoving: {
      // a negative count would list everything as "idle -5 days" – it falls back to the policy's number of days (see warn)
      opts: (ctx, f) => ({ days: f.days === '' || f.days == null || !(Number(f.days) >= 0) ? undefined : f.days, wh: f.wh || '', group: f.group || '', today: ctx.today }),
      warn: (ctx, f, r) => (f.days !== '' && f.days != null && !(Number(f.days) >= 0) ? `จำนวนวันต้องเป็น 0 ขึ้นไป – แสดงตามค่าตั้งต้น ${h.fmt.num(r.days)} วัน` : ''),
      filters: (ctx, tab, f, r) => [h.field({ name: 'days', label: 'ไม่เคลื่อนไหวอย่างน้อย (วัน)', type: 'number', value: f.days, placeholder: String(r.days || 90),
        id: fid(tab, 'days'), act: 'filter', live: true })].concat(fields(ctx, tab, f, ['wh', 'group'])),
      body(ctx, r, f, rows) {
        const T = r.totals;
        return t`${h.kpis([h.kpi('รายการค้างนาน', h.fmt.num(T.items), `ไม่มีรับ/จ่าย/โอน/ปรับยอด ${h.fmt.num(r.days)} วันขึ้นไป`, T.items ? 'warn' : 'ok'),
          h.kpi('มูลค่าอ้างอิง', h.fmt.money(T.value), 'บาท', 'info'), h.kpi('นับถึงวันที่', h.fmt.date(r.today), 'วันนี้')])}
          ${h.note(`นับจากการเคลื่อนไหวครั้งล่าสุดของสินค้า (ไม่นับการเปลี่ยนสถานะ QC) · ${r.note}`, 'info')}
          ${grid(ctx, { cols: r.cols, rows, limit: ctx.view.limit, id: 'rp-list',
            empty: `ไม่มีของค้างนาน ${h.fmt.num(r.days)} วันขึ้นไป`, emptyText: 'ของที่มียอดแต่ไม่มีรับ/จ่าย/โอนตามจำนวนวันที่เลือกจะขึ้นที่นี่ – ลองลดจำนวนวัน',
            render: { code: codeCell, lastMoveDate: (x) => (x.lastMoveDate ? h.fmt.date(x.lastMoveDate) : dash), lastDocNo: (x) => docLink(ctx, x.lastDocNo) } })}`;
      },
      csv: (ctx, r, f, rows) => ({ name: `non-moving-${r.days}d`, text: csvOf(r.cols, rows, dateFmt) }),
    },

    aging: {
      opts: (ctx, f) => ({ wh: f.wh || '', status: f.status || '', today: ctx.today }),
      filters: (ctx, tab, f) => fields(ctx, tab, f, ['wh', 'status']).concat([h.field({ name: 'bucket', label: 'ช่วงอายุ', type: 'select', value: f.bucket,
        options: R().AGE_BUCKETS.map((b) => [b, `${b} วัน`]).concat([['ไม่ทราบ', 'ไม่ทราบวันรับเข้า']]), blank: 'ทุกช่วง', id: fid(tab, 'bucket'), act: 'filter' })]),
      rows: (ctx, r, f) => (f.bucket ? r.rows.filter((x) => x.bucket === f.bucket) : r.rows),
      body(ctx, r, f, rows) {
        const B = r.totals.buckets || {};
        const tone = { '0-30': 'ok', '31-90': '', '91-180': 'warn', '>180': 'bad', 'ไม่ทราบ': '' };
        const ks = R().AGE_BUCKETS.concat(['ไม่ทราบ']).filter((k) => k !== 'ไม่ทราบ' || (B[k] && B[k].rows));
        return t`${h.kpis(ks.map((k) => h.kpi(k === 'ไม่ทราบ' ? 'ไม่ทราบวันรับเข้า' : `อายุ ${k} วัน`, h.fmt.num((B[k] || {}).rows || 0),
          `มูลค่าอ้างอิง ${h.fmt.money((B[k] || {}).value || 0)}`, (B[k] || {}).rows ? tone[k] : '')))}
          ${h.note(`อายุนับจากวันรับเข้าของล็อต (ถ้ามี) หรือวันรับเข้าล่าสุดของตำแหน่งนั้น ถึง ${h.fmt.date(r.today)} · ${r.note}`, 'info')}
          ${grid(ctx, { cols: r.cols, rows, limit: ctx.view.limit, id: 'rp-list', empty: 'ไม่มีของคงเหลือตามตัวกรอง',
            emptyText: 'อายุสต็อกจะขึ้นเมื่อมียอดคงเหลือ – ลองล้างตัวกรอง',
            rowCls: (x) => (x.bucket === '>180' ? 'row-warn' : ''),
            render: { code: codeCell, wh: whCell, statusLabel: (x) => h.statusBadge(x.status), since: (x) => (x.since ? h.fmt.date(x.since) : dash) } })}`;
      },
      csv: (ctx, r, f, rows) => ({ name: 'stock-aging', text: csvOf(r.cols, rows, dateFmt) }),
    },

    countAccuracy: {
      opts: (ctx, f) => ({ wh: f.wh || '', from: f.from || '', to: f.to || '' }),
      filters: (ctx, tab, f) => fields(ctx, tab, f, ['wh', 'from', 'to']),
      body(ctx, r) {
        const T = r.totals;
        const counts = (v) => recLink('counts', v.id, { sel: v.id });
        if (!r.rows.length) {
          return t`${h.note(T.rule, 'info')}${h.empty('ยังไม่มีรอบนับที่อนุมัติในช่วงนี้', 'ความแม่นยำคิดจากรอบนับที่หัวหน้าสโตร์/บัญชีอนุมัติแล้ว: บรรทัดที่ต่างไม่เกินเกณฑ์ ÷ บรรทัดที่นับ',
            pageLink('ไปหน้าตรวจนับ', 'counts'))}`;
        }
        return t`${h.kpis([h.kpi('ความแม่นยำ', pctText(T.accuracy), `${h.fmt.num(T.within)} จาก ${h.fmt.num(T.lines)} บรรทัดอยู่ในเกณฑ์`, T.accuracy == null ? '' : T.accuracy >= 98 ? 'ok' : 'warn'),
          h.kpi('รอบนับที่อนุมัติ', h.fmt.num(T.sessions), 'ในช่วงที่เลือก'), h.kpi('ต่างเกินเกณฑ์', h.fmt.num(r.misses.length), 'บรรทัด', r.misses.length ? 'warn' : 'ok')])}
          ${h.note(T.rule, 'info')}
          ${h.section('รอบนับ', grid(ctx, { cols: r.cols, rows: r.rows, limit: ctx.view.limit, id: 'rp-list', render: { id: counts,
            approvedDate: (x) => h.fmt.date(x.approvedDate), approvedBy: (x) => ctx.userName(x.approvedBy), accuracy: (x) => (x.accuracy == null ? dash : `${h.fmt.num(x.accuracy, 1)}%`) } }),
            { actions: csvBtn('main') })}
          ${h.section('บรรทัดที่ต่างเกินเกณฑ์', grid(ctx, { cols: r.colsMisses, rows: r.misses, limit: STEP, empty: 'ไม่มีบรรทัดที่ต่างเกินเกณฑ์',
            render: { session: (x) => recLink('counts', x.session, { sel: x.session }), code: codeCell, diff: (x) => t`<b>${h.fmt.num(x.diff)}</b>` } }),
            { sub: 'ยอดต่างต้องมีคำอธิบายและผู้รับผิดชอบ (บันทึกที่หน้าตรวจนับ)', actions: r.misses.length ? csvBtn('misses') : '' })}`;
      },
      csv: (ctx, r, f, rows, part) => (part === 'misses' ? { name: 'count-misses', text: csvOf(r.colsMisses, r.misses) }
        : { name: 'count-accuracy', text: csvOf(r.cols, r.rows, Object.assign({ approvedBy: (x) => ctx.userName(x.approvedBy) }, dateFmt)) }),
      ownCsv: true,
    },

    qcPending: {
      opts: (ctx, f) => ({ wh: f.wh || '', today: ctx.today, now: ctx.now }),
      filters: (ctx, tab, f) => fields(ctx, tab, f, ['q', 'wh']),
      rows: (ctx, r, f) => {
        const q = low(f.q).trim();
        return q ? r.rows.filter((x) => [x.code, x.name, x.lot, x.bin].some((y) => low(y).indexOf(q) >= 0)) : r.rows;
      },
      body(ctx, r, f, rows) {
        const T = r.totals;
        const insp = (id) => recLink('inspections', id, { sel: id, _scroll: true });
        const ncr = (no) => recLink('ncrs', no, { sel: no, _scroll: true });
        const links = (list, fn) => (list && list.length ? h.join(list.map(fn), ' ') : dash);
        return t`${h.kpis([h.kpi('รอตรวจ', h.fmt.num(T.qcHold), 'ตำแหน่งที่มีของรอตรวจ', T.qcHold ? 'warn' : ''),
          h.kpi('กักกัน', h.fmt.num(T.quarantine), 'ตำแหน่งที่มีของกักกัน', T.quarantine ? 'bad' : ''),
          h.kpi('รอแก้ไข', h.fmt.num(T.rework), 'ตำแหน่งที่มีของรอแก้ไข', T.rework ? 'info' : ''),
          h.kpi('รอนานที่สุด', `${h.fmt.num(T.oldestDays)} วัน`, 'นับจากวันที่ของเข้าสถานะนั้น', T.oldestDays > 3 ? 'warn' : ''),
          h.kpi('ผลตรวจรอปล่อยผ่าน', h.fmt.num(T.openInspections), 'ผ่านแล้ว รอหัวหน้า QC', T.openInspections ? 'warn' : ''),
          h.kpi('NCR ที่ยังไม่ปิด', h.fmt.num(T.openNcrs), 'รอตัดสิน/รอปิด', T.openNcrs ? 'bad' : '')])}
          ${h.section('ของที่ยังเบิกไม่ได้เพราะรอ QC', grid(ctx, { cols: r.cols.concat([{ key: 'inspections', label: 'ผลตรวจ' }, { key: 'ncrs', label: 'NCR' }]),
            rows, limit: ctx.view.limit, id: 'rp-list', empty: 'ไม่มีของรอ QC', emptyText: 'ของรอตรวจ กักกัน หรือรอแก้ไข จะขึ้นที่นี่พร้อมจำนวนวันที่รอ',
            rowCls: (x) => (x.status === 'QUARANTINE' ? 'row-bad' : ''),
            render: { code: codeCell, wh: whCell, statusLabel: (x) => h.statusBadge(x.status), sinceDate: (x) => (x.sinceDate ? h.fmt.date(x.sinceDate) : dash),
              inspections: (x) => links(x.inspections, insp), ncrs: (x) => links(x.ncrs, ncr) } }),
          { actions: t`${pageLink('ไปคิวตรวจ', 'inspections', { tab: 'queue' })}${rows.length ? csvBtn('main') : ''}` })}
          ${h.section('ผลตรวจที่รอปล่อยผ่าน', grid(ctx, { cols: r.colsInspections, rows: r.inspections, limit: STEP, empty: 'ไม่มีผลตรวจรอปล่อยผ่าน',
            render: { id: (x) => insp(x.id), code: codeCell, inspector: (x) => ctx.userName(x.inspector) } }), { actions: r.inspections.length ? csvBtn('inspections') : '' })}
          ${h.section('NCR ที่ยังไม่ปิด', grid(ctx, { cols: r.colsNcrs, rows: r.ncrs, limit: STEP, empty: 'ไม่มี NCR ค้าง',
            render: { ncrNo: (x) => ncr(x.ncrNo), code: codeCell, status: (x) => h.badge(NCR_STATUS()[x.status] || x.status, x.status === 'OPEN' ? 'bad' : 'warn'),
              disposition: (x) => (x.disposition ? DISPOSITIONS()[x.disposition] || x.disposition : dash) } }), { actions: r.ncrs.length ? csvBtn('ncrs') : '' })}`;
      },
      csv: (ctx, r, f, rows, part) => {
        if (part === 'inspections') return { name: 'qc-open-inspections', text: csvOf(r.colsInspections, r.inspections, { inspector: (x) => ctx.userName(x.inspector) }) };
        if (part === 'ncrs') return { name: 'qc-open-ncrs', text: csvOf(r.colsNcrs, r.ncrs, { status: (x) => NCR_STATUS()[x.status] || x.status, disposition: (x) => DISPOSITIONS()[x.disposition] || x.disposition || '' }) };
        return { name: 'qc-pending', text: csvOf(r.cols.concat([{ key: 'inspections', label: 'ผลตรวจ' }, { key: 'ncrs', label: 'NCR' }]), rows, dateFmt) };
      },
      ownCsv: true,
    },

    fpy: {
      opts: (ctx, f) => ({ from: f.from || '', to: f.to || '', stage: f.stage || '' }),
      filters: (ctx, tab, f) => fields(ctx, tab, f, ['from', 'to', 'stage']),
      body(ctx, r) {
        const T = r.totals;
        const st = Object.keys(STAGES).filter((s) => T.byStage && T.byStage[s]).map((s) => h.kpi(`FPY ${STAGES[s]}`, pctText(T.byStage[s].fpy),
          `${h.fmt.num(T.byStage[s].pass)} จาก ${h.fmt.num(T.byStage[s].first)} ครั้ง`));
        return t`${h.kpis([h.kpi('ผ่าน QC ครั้งแรก (FPY)', pctText(T.fpy), `${h.fmt.num(T.pass)} จาก ${h.fmt.num(T.first)} ผลตรวจครั้งแรก`, T.fpy == null ? '' : T.fpy >= 95 ? 'ok' : 'warn')].concat(st,
          [h.kpi('เวลารอ QC เฉลี่ย', hoursText(T.qcWaitHours), `${h.fmt.num(T.qcWaitN || 0)} ผลตรวจ (ดูแท็บ เวลารอ QC)`)]))}
          ${h.note('นับเฉพาะการตรวจครั้งแรกของของชุดนั้น – การตรวจซ้ำหลังแก้ไขไม่นับเป็นผ่านครั้งแรก · ผลตรวจที่เป็นโมฆะไม่นับ', 'info')}
          ${grid(ctx, { cols: r.cols, rows: r.rows, limit: ctx.view.limit, id: 'rp-list', empty: 'ยังไม่มีผลตรวจครั้งแรกในช่วงนี้',
            emptyText: 'FPY จะขึ้นเมื่อ QC บันทึกผลตรวจที่หน้า ตรวจ QC และปล่อยผ่าน',
            render: { code: codeCell, fpy: (x) => (x.fpy == null ? dash : t`<b>${h.fmt.num(x.fpy, 1)}%</b>`) } })}`;
      },
      csv: (ctx, r) => ({ name: 'qc-fpy', text: csvOf(r.cols, r.rows) }),
    },

    qcWait: {
      opts: (ctx, f) => ({ from: f.from || '', to: f.to || '', stage: f.stage || '' }),
      filters: (ctx, tab, f) => fields(ctx, tab, f, ['from', 'to', 'stage']),
      body(ctx, r) {
        const T = r.totals;
        return t`${h.kpis([h.kpi('รอ QC เฉลี่ย', hoursText(T.avgHours), `${h.fmt.num(T.n)} ผลตรวจ`, 'info'),
          h.kpi('รอนานที่สุด', hoursText(T.maxHours), 'ตั้งแต่ของเข้ารอตรวจถึงบันทึกผล'),
          h.kpi('หาเวลาเข้ารอตรวจไม่พบ', h.fmt.num(T.unmatched), T.unmatched ? 'ไม่นับในค่าเฉลี่ย' : 'ครบทุกผลตรวจ', T.unmatched ? 'warn' : '')])}
          ${h.note('เวลารอ = จากเวลาที่ของเข้ายอด รอตรวจ (รายการรับเข้า) ถึงเวลาบันทึกผลตรวจ · นับเฉพาะผลตรวจของที่รอตรวจ', 'info')}
          ${grid(ctx, { cols: r.cols, rows: r.rows, limit: ctx.view.limit, id: 'rp-list', empty: 'ยังไม่มีผลตรวจในช่วงนี้',
            emptyText: 'เวลารอ QC จะขึ้นเมื่อมีของรับเข้ารอตรวจและ QC บันทึกผลแล้ว',
            render: { id: (x) => recLink('inspections', x.id, { sel: x.id, _scroll: true }), code: codeCell, docNo: (x) => docLink(ctx, x.docNo),
              arrivedAt: (x) => h.fmt.dt(x.arrivedAt), inspectedAt: (x) => h.fmt.dt(x.inspectedAt), hours: (x) => num(x.hours, 1) } })}`;
      },
      csv: (ctx, r) => ({ name: 'qc-wait', text: csvOf(r.cols, r.rows, dateFmt) }),
    },

    repeatIssues: {
      opts: (ctx, f) => ({ from: f.from || '', to: f.to || '', minCount: Number(f.minCount) >= 2 ? Number(f.minCount) : 2 }),
      warn: (ctx, f) => (f.minCount !== '' && f.minCount != null && !(Number(f.minCount) >= 2) ? 'นับว่าเป็นปัญหาซ้ำได้ตั้งแต่ 2 ครั้งขึ้นไป – แสดงตาม 2 ครั้ง' : ''),
      filters: (ctx, tab, f) => fields(ctx, tab, f, ['from', 'to']).concat([
        h.field({ name: 'minCount', label: 'นับว่าซ้ำเมื่อพบ (ครั้ง)', type: 'number', value: f.minCount, placeholder: '2', id: fid(tab, 'minCount'), act: 'filter', live: true }),
        h.field({ name: 'onlyRepeat', label: 'เฉพาะปัญหาซ้ำ', type: 'checkbox', value: f.onlyRepeat, id: fid(tab, 'onlyRepeat'), act: 'filter' })]),
      rows: (ctx, r, f) => (f.onlyRepeat ? r.rows.filter((x) => x.repeat) : r.rows),
      body(ctx, r, f, rows) {
        const T = r.totals;
        const cols = r.cols.concat([{ key: 'ncrNos', label: 'เลขที่ NCR' }]);
        return t`${h.kpis([h.kpi('ปัญหาซ้ำ', h.fmt.num(T.repeats), `รหัส + ข้อบกพร่องเดียวกัน ${h.fmt.num(T.minCount)} ครั้งขึ้นไป`, T.repeats ? 'bad' : 'ok'),
          h.kpi('NCR ของปัญหาซ้ำ', h.fmt.num(T.repeatNcrs), 'ใบ'), h.kpi('กลุ่มปัญหาทั้งหมด', h.fmt.num(T.groups), 'รหัส + ข้อบกพร่อง')])}
          ${grid(ctx, { cols, rows, limit: ctx.view.limit, id: 'rp-list', empty: 'ยังไม่มี NCR ในช่วงนี้',
            emptyText: 'NCR ที่รหัสเดียวกันและข้อบกพร่องเดียวกันเกิดซ้ำจะขึ้นที่นี่ เพื่อหาสาเหตุร่วม',
            rowCls: (x) => (x.repeat ? 'row-warn' : ''),
            render: { code: codeCell, repeatLabel: (x) => (x.repeat ? h.badge('ซ้ำ', 'bad') : dash), firstDate: (x) => h.fmt.date(x.firstDate), lastDate: (x) => h.fmt.date(x.lastDate),
              ncrNos: (x) => h.join(x.ncrNos.map((no) => recLink('ncrs', no, { sel: no, _scroll: true })), ' ') } })}`;
      },
      csv: (ctx, r, f, rows) => ({ name: 'repeat-issues', text: csvOf(r.cols.concat([{ key: 'ncrNos', label: 'เลขที่ NCR' }]), rows, dateFmt) }),
    },

    kpiActuals: {
      opts: (ctx, f) => ({ from: f.from || '', to: f.to || '', today: ctx.today }),
      filters: (ctx, tab, f) => fields(ctx, tab, f, ['from', 'to']),
      body(ctx, r) {
        const T = r.totals;
        const P = r.period || {};
        const tone = (x) => (x.met === true ? 'ok' : x.met === false ? 'bad' : 'muted');
        return t`${h.kpis([h.kpi('ถึงเป้า', h.fmt.num(T.met), 'ตัวชี้วัด', T.met ? 'ok' : ''), h.kpi('ยังไม่ถึงเป้า', h.fmt.num(T.notMet), 'ตัวชี้วัด', T.notMet ? 'bad' : 'ok'),
          h.kpi('วัดได้แล้ว', h.fmt.num(T.measured), `จาก ${h.fmt.num(r.rows.length)} ตัว`), h.kpi('ยังไม่ตั้งเป้า', h.fmt.num(T.noTarget), 'ตั้งได้ที่ Phase 0', T.noTarget ? 'warn' : '')])}
          ${h.note(t`ช่วงที่วัด ${h.fmt.date(P.from)} – ${h.fmt.date(P.to)} (ค่าเริ่มต้น = เดือนนี้) · ค่าก่อนเริ่มและเป้าหมายมาจากที่ตกลงใน Phase 0${RRS.ui.pages.setup ? t` · แก้ได้ที่ ${h.link('ตัวชี้วัดตั้งต้น', 'setup', { tab: 'kpis' })}` : ''}`, 'info')}
          ${grid(ctx, { cols: r.cols, rows: r.rows, limit: STEP, id: 'rp-list', empty: 'ยังไม่มีตัวชี้วัด', emptyText: 'เพิ่มตัวชี้วัดและเป้าหมายที่หน้า ขอบเขต นโยบาย และข้อตกลง',
            render: { metLabel: (x) => h.badge(x.metLabel, tone(x)), source: (x) => t`<small class="muted">${x.source}</small>` } })}`;
      },
      csv: (ctx, r) => ({ name: 'kpi-actuals', text: csvOf(r.cols, r.rows) }),
    },

    dailyCheck: {
      opts: () => ({}),
      filters: () => [],
      body(ctx, r) {
        const can = ctx.can('uat.record');
        const fail = r.checks.filter((c) => !c.ok);
        const summary = r.ok
          ? h.note(t`<b>ผ่านทุกหัวข้อ</b> – ยอดคงเหลือตรงกับประวัติ ไม่มียอดติดลบที่ไม่ได้อนุมัติ ไม่มีของกักกัน/รอตรวจหลุดออกนอกขั้นตอน QC ทุกการเปลี่ยนยอดมีเอกสารรองรับ ไม่มีเอกสารตัดยอดซ้ำ (ข้อมูลถึงลำดับ ${h.fmt.num(r.seq)})`, 'ok')
          : h.note(t`<b>พบปัญหา ${h.fmt.num(r.problems.length)} ข้อ ใน ${h.fmt.num(fail.length)} หัวข้อ</b> – แจ้งหัวหน้าสโตร์และบัญชี แก้ด้วยเอกสารแก้ไข (ไม่ลบประวัติ) แล้วตรวจใหม่ · บันทึกเป็นปัญหาร้ายแรงของการทดลอง${h.errors({ errors: r.problems.slice(0, 20).map((p) => ({ message: p })) })}${r.problems.length > 20 ? t`<p>… และอีก ${h.fmt.num(r.problems.length - 20)} ข้อ (ดาวน์โหลด CSV)</p>` : ''}`, 'bad');
        const checks = h.table({ dense: true, rows: r.checks, rowCls: (c) => (c.ok ? '' : 'row-bad'), cols: [
          { label: 'หัวข้อตรวจ', key: 'label' }, { label: 'ผล', render: (c) => h.badge(c.okLabel, c.ok ? 'ok' : 'bad') }, { label: 'จำนวนที่พบ', num: true, key: 'count' }] });
        const parts = [];
        if (r.balanceDiffs.length) parts.push(h.section('ยอดคงเหลือไม่ตรงกับผลรวมประวัติ', h.table({ dense: true, scroll: true, rows: r.balanceDiffs.slice(0, STEP),
          cols: [{ label: 'ตำแหน่ง (รหัส|คลัง|ช่อง|สถานะ|ล็อต)', render: (x) => h.code(x.key) }, { label: 'ผลรวมประวัติ', num: true, key: 'history' }, { label: 'ยอดคงเหลือ', num: true, key: 'balance' }] })));
        if (r.negatives.length) parts.push(h.section('ยอดติดลบ', h.table({ dense: true, scroll: true, rows: r.negatives.slice(0, STEP), rowCls: (x) => (x.approved ? '' : 'row-bad'),
          cols: [{ label: 'รหัส', render: codeCell }, { label: 'ตำแหน่ง', get: (x) => `${x.wh}${x.bin ? '/' + x.bin : ''}` }, { label: 'สถานะ', render: (x) => h.statusBadge(x.status) },
            { label: 'ล็อต', get: (x) => x.lot }, { label: 'จำนวน', num: true, key: 'qty' },
            { label: 'อนุมัติข้อยกเว้น', render: (x) => (x.approved ? h.join(x.docs.map((d) => t`${docLink(ctx, d.docNo)} ${ctx.userName(d.approvedBy)}`), ' · ') : h.badge('ไม่มีเอกสารอนุมัติ', 'bad')) }] })));
        if (r.quarantineLeaks.length) parts.push(h.section('ของกักกัน/รอตรวจที่ถูกนำออกนอกขั้นตอน QC', h.table({ dense: true, scroll: true, rows: r.quarantineLeaks.slice(0, STEP),
          cols: [{ label: 'เวลา', get: (x) => h.fmt.dt(x.at) }, { label: 'เอกสาร', render: (x) => docLink(ctx, x.docNo) }, { label: 'รหัส', render: codeCell },
            { label: 'ตำแหน่ง', get: (x) => `${x.wh}${x.bin ? '/' + x.bin : ''}` }, { label: 'สถานะ', render: (x) => h.statusBadge(x.status) }, { label: 'ล็อต', get: (x) => x.lot },
            { label: 'จำนวน', num: true, key: 'qty' }, { label: 'ผู้ทำ', get: (x) => ctx.userName(x.by) }] })));
        const lotLink = (x) => (RRS.ui.pages.lots ? h.link(x.lot, 'lots', { tab: 'list', sel: x.code + '|' + x.lot, _scroll: true }) : x.lot);
        const leaks = r.lotQuarantineLeaks || [];
        const waiting = r.lotQuarantineWaiting || [];
        const orphans = r.orphanMoves || [];
        if (leaks.length) parts.push(h.section('ล็อตที่ถูกกักกันแต่ยังมีของสถานะอื่น', h.table({ dense: true, scroll: true, rows: leaks.slice(0, STEP), rowCls: () => 'row-bad',
          cols: [{ label: 'รหัส', render: codeCell }, { label: 'ล็อต/Heat', render: lotLink }, { label: 'ตำแหน่ง', get: (x) => `${x.wh}${x.bin ? '/' + x.bin : ''}` },
            { label: 'สถานะ', render: (x) => h.statusBadge(x.status) }, { label: 'จำนวน', num: true, key: 'qty' }] }),
        { sub: 'ของล็อตที่กักกันต้องอยู่ในสถานะกักกันทั้งหมด – ให้ QC สั่งกักกันซ้ำที่หน้าล็อต' }));
        if (waiting.length) parts.push(h.section('ล็อตกักกันที่รอเข้าสถานะกักกัน (ไม่นับเป็นปัญหา)', h.table({ dense: true, scroll: true, rows: waiting.slice(0, STEP),
          cols: [{ label: 'รหัส', render: codeCell }, { label: 'ล็อต/Heat', render: lotLink }, { label: 'ตำแหน่ง', render: whCell }, { label: 'ช่อง/ใบโอน', get: (x) => x.bin },
            { label: 'จำนวน', num: true, key: 'qty' }, { label: 'เหตุผล', key: 'why' }] })));
        if (orphans.length) parts.push(h.section('การเปลี่ยนยอดที่ไม่มีเอกสารบันทึกแล้วรองรับ', h.table({ dense: true, scroll: true, rows: orphans.slice(0, STEP), rowCls: () => 'row-bad',
          cols: [{ label: 'รายการ', render: (x) => h.code(x.id) }, { label: 'เอกสาร', render: (x) => (x.docNo ? docLink(ctx, x.docNo) : dash) }, { label: 'ประเภท', get: (x) => x.docType || '' },
            { label: 'รหัส', render: codeCell }, { label: 'ตำแหน่ง', get: (x) => `${x.wh}${x.bin ? '/' + x.bin : ''}` }, { label: 'จำนวน', num: true, key: 'qty' },
            { label: 'ผู้ทำ', get: (x) => ctx.userName(x.by) }, { label: 'ปัญหา', key: 'why' }] })));
        if (r.doublePosted.length) parts.push(h.section('เอกสารที่ตัดยอดซ้ำ', h.table({ dense: true, rows: r.doublePosted,
          cols: [{ label: 'เอกสาร', render: (x) => docLink(ctx, x.docNo) }, { label: 'ประเภท', key: 'docType' }, { label: 'รายละเอียด', key: 'detail' }] })));
        if (r.cancelNotReversed.length) parts.push(h.section('เอกสารยกเลิกแล้วแต่ยังไม่กลับยอด', h.table({ dense: true, rows: r.cancelNotReversed,
          cols: [{ label: 'เอกสาร', render: (x) => docLink(ctx, x.docNo) }, { label: 'ประเภท', key: 'type' }, { label: 'รายการที่ยังไม่กลับ', num: true, get: (x) => x.movements.length }] })));
        const log = RRS.q.rows(ctx.state, 'daily_checks').sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(b.id).localeCompare(String(a.id)));
        const logTbl = h.table({ dense: true, scroll: true, rows: log.slice(0, 60), empty: 'ยังไม่เคยบันทึกผลตรวจประจำวัน',
          emptyText: can ? 'กด บันทึกผลตรวจวันนี้ ทุกวันระหว่างทดลองใช้งาน เพื่อเก็บหลักฐานว่ายอดถูกต้อง' : 'ผู้ทดสอบระบบบันทึกผลทุกวันระหว่างทดลองใช้งาน',
          rowCls: (x) => (x.ok ? '' : 'row-bad'),
          cols: [{ label: 'รหัส', render: (x) => h.code(x.id) }, { label: 'วันที่', get: (x) => h.fmt.date(x.date) }, { label: 'ผู้ตรวจ', get: (x) => ctx.userName(x.by) },
            { label: 'ข้อมูลถึงลำดับ', num: true, key: 'seq' }, { label: 'ผล', render: (x) => h.badge(x.ok ? 'ผ่าน' : `พบปัญหา ${(x.problems || []).length} ข้อ`, x.ok ? 'ok' : 'bad') },
            { label: 'หมายเหตุ', get: (x) => x.note || '' }] });
        const today = log.find((x) => x.date === ctx.today);
        return t`${summary}
          ${h.section('หัวข้อที่ตรวจ', checks, { sub: 'ระบบคำนวณจากข้อมูลจริงทุกครั้งที่เปิดหน้านี้ – ไม่มีใครแก้ผลได้',
            actions: t`${can ? h.btn(today ? 'บันทึกผลตรวจอีกครั้ง' : 'บันทึกผลตรวจวันนี้', { act: 'recordCheck', tone: today ? 'ghost' : 'primary', id: 'rp-record-check' }) : ''}${csvBtn('main')}` })}
          ${parts}
          ${h.section('ผลตรวจที่บันทึกไว้', logTbl, { sub: today ? `วันนี้บันทึกแล้ว (${today.id})` : 'วันนี้ยังไม่ได้บันทึก' })}`;
      },
      csv: (ctx, r) => ({ name: 'daily-check', text: h.csv([['หัวข้อตรวจ', 'ผล', 'จำนวนที่พบ']].concat(r.checks.map((c) => [c.label, c.okLabel, c.count]),
        [[]], [['ปัญหาที่พบ']], r.problems.length ? r.problems.map((p) => [p]) : [['ไม่พบปัญหา']], [[]], [['ข้อมูลถึงลำดับ', r.seq], ['ลายนิ้วมือล่าสุด', r.head]])) }),
      ownCsv: true,
    },
  };

  function tabsOf() {
    return (R() && R().LIST ? R().LIST : []).filter((x) => REPORTS[x.id] && typeof R()[x.id] === 'function');
  }

  RRS.ui.page({
    id: 'reports', title: 'รายงาน', phase: 6, order: 10,
    sub: 'อ่านจากยอดและประวัติในระบบโดยตรง (ไม่เปลี่ยนข้อมูล) · ดาวน์โหลดทุกรายงานเป็น CSV เปิดใน Excel ได้ · มูลค่าเป็นค่าอ้างอิง ไม่ใช่มูลค่าทางบัญชี',
    render(ctx) {
      const list = tabsOf();
      if (!list.length) return h.empty('ยังเปิดรายงานไม่ได้', 'หน้านี้ต้องใช้โมดูลรายงาน (reports) ซึ่งยังไม่ได้โหลด – โหลดหน้าใหม่ หรือแจ้งผู้ดูแลระบบ');
      const v = ctx.view;
      const tab = list.some((x) => x.id === v.tab) ? v.tab : list[0].id;
      const def = REPORTS[tab];
      const f = (v.f || {})[tab] || {};
      const r = run(ctx, tab, def.opts(ctx, f));
      const rows = def.rows ? def.rows(ctx, r, f) : r.rows || [];
      const filters = def.filters(ctx, tab, f, r);
      const filtered = Object.keys(f).some((k) => f[k] !== '' && f[k] != null && f[k] !== false);
      const right = [filtered ? h.btn('ล้างตัวกรอง', { act: 'clear', tone: 'ghost' }) : '', !def.ownCsv && rows.length ? h.btn('ดาวน์โหลด CSV', { act: 'csv', arg: 'main', tone: 'ghost' }) : ''];
      const tabs = h.tabs(list.map((x) => ({ id: x.id, label: x.label })), tab);
      const body = r.error ? h.note(`คำนวณรายงานไม่สำเร็จ: ${r.error} – โหลดหน้าใหม่ ถ้ายังพบให้แจ้งผู้ดูแลระบบ`, 'bad') : def.body(ctx, r, f, rows);
      const warns = [f.from && f.to && f.from > f.to ? `วันที่ "ตั้งแต่" (${h.fmt.date(f.from)}) อยู่หลังวันที่ "ถึง" (${h.fmt.date(f.to)}) – ช่วงนี้จึงไม่มีรายการ แก้วันที่ให้ถูก` : '',
        def.warn && !r.error ? def.warn(ctx, f, r) : ''].filter(Boolean);
      return t`${tabs}${filters.length || right.some(Boolean) ? h.toolbar(filters, right) : ''}${warns.map((w) => h.note(w, 'warn'))}${body}`;
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg, limit: STEP }),
      more: (ctx) => ctx.set({ limit: (ctx.view.limit || STEP) + STEP }),
      filter(ctx, el) {
        const list = tabsOf();
        const tab = list.some((x) => x.id === ctx.view.tab) ? ctx.view.tab : list[0].id;
        const all = Object.assign({}, ctx.view.f);
        const f = Object.assign({}, all[tab]);
        f[el.name] = el.type === 'checkbox' ? el.checked : el.value;
        all[tab] = f;
        ctx.set({ f: all, limit: STEP });
      },
      clear(ctx) {
        const tab = ctx.view.tab || (tabsOf()[0] || {}).id;
        const all = Object.assign({}, ctx.view.f);
        all[tab] = {};
        ctx.set({ f: all, limit: STEP });
      },
      async csv(ctx, el) {
        const list = tabsOf();
        const tab = list.some((x) => x.id === ctx.view.tab) ? ctx.view.tab : list[0].id;
        const def = REPORTS[tab];
        const f = (ctx.view.f || {})[tab] || {};
        const r = run(ctx, tab, def.opts(ctx, f));
        const rows = def.rows ? def.rows(ctx, r, f) : r.rows || [];
        const out = def.csv(ctx, r, f, rows, el.dataset.arg || 'main');
        await ctx.download(`${out.name}-${ctx.today}.csv`, out.text);
      },
      async recordCheck(ctx) {
        const r = run(ctx, 'dailyCheck', {});
        await ctx.dialog({
          title: 'บันทึกผลตรวจยอดประจำวัน', submit: 'บันทึกผลตรวจ',
          body: t`<div class="wide">${r.ok ? h.note('ผลตอนนี้: ผ่านทุกหัวข้อ', 'ok') : h.note(`ผลตอนนี้: พบปัญหา ${r.problems.length} ข้อ – บันทึกไว้เป็นหลักฐาน แล้วแจ้งหัวหน้าสโตร์และบัญชี`, 'bad')}</div>
            <p class="hint wide">ระบบคำนวณผลใหม่ตอนบันทึก (ไม่ใช้ผลบนหน้าจอ) · ผู้ตรวจและเวลามาจากระบบ</p>
            ${h.field({ name: 'note', label: 'หมายเหตุ (ถ้ามี)', type: 'textarea', rows: 2, wide: true, placeholder: 'เช่น ตรวจหลังปิดงานวันนี้ / แจ้งหัวหน้าสโตร์แล้ว', id: 'rp-check-note' })}`,
          onSubmit: (vals) => ctx.exec('daily.check', { note: vals.note }, { quiet: true,
            done: (res) => (res.result && res.result.ok ? `บันทึกผลตรวจ ${res.result.id}: ผ่าน` : `บันทึกผลตรวจ ${res.result.id}: พบปัญหา ${(res.result.problems || []).length} ข้อ`) }),
        });
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
