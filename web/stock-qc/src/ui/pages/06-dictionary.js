/*
 * Phase 0 – data dictionary: every RRS.schema table grouped by phase (Thai label, key, fields). Each table is one
 * tab of the Google Sheet when the Cloudflare + Google Sheet server is connected. Downloads: the sheet layout
 * (header row per tab, as CSV or one JSON {tab: [headers]}) and the current rows of one table as CSV.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;

  const TYPE_LABEL = { text: 'ข้อความ', number: 'ตัวเลข', date: 'วันที่', datetime: 'วันเวลา', bool: 'ใช่/ไม่ใช่', enum: 'ตัวเลือก',
    json: 'JSON (ข้อมูลซ้อน)', list: 'รายการ (JSON)' };
  const phaseKey = (p) => (p === '' || p == null ? 'other' : String(p));
  const phaseName = (k) => {
    if (k === 'other') return 'อื่น ๆ';
    const p = (RRS.ui.PHASES || []).find((x) => String(x.n) === k);
    return p ? p.label : `Phase ${k}`;
  };

  function tables() {
    return Object.values(RRS.schema.tables).sort((a, b) => {
      const pa = phaseKey(a.phase), pb = phaseKey(b.phase);
      return (pa === 'other' ? 99 : Number(pa)) - (pb === 'other' ? 99 : Number(pb)) || a.name.localeCompare(b.name);
    });
  }
  const headers = (tb) => tb.fields.map((f) => f.name);

  /** One CSV cell: JSON for objects/lists, quoted when needed, and text that a sheet would run as a formula kept as text. */
  function cell(v) {
    if (v == null) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (typeof v === 'string' && (/^[=+@\t\r]/.test(s) || /^-[^\d.]/.test(s))) s = "'" + s;
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  const csv = (rows) => '\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

  /** Sign-in account ids are shown only to people who manage users (the users screen hides them the same way). */
  const PRIVATE = ['accountId', 'via'];
  /** Current rows of a table as CSV: schema fields first, then any extra keys found in the rows (nothing is dropped). */
  function dataCsv(state, tb, showPrivate) {
    const rows = Object.keys(state.tables[tb.name] || {}).sort().map((k) => state.tables[tb.name][k]);
    const cols = headers(tb);
    const extra = new Set();
    for (const r of rows) for (const k in r) if (cols.indexOf(k) < 0) extra.add(k);
    const all = cols.concat(Array.from(extra).sort());
    const val = (r, c) => (!showPrivate && PRIVATE.indexOf(c) >= 0 && r[c] ? '(ซ่อน)' : r[c]);
    return { text: csv([all].concat(rows.map((r) => all.map((c) => val(r, c))))), n: rows.length };
  }

  function tableBlock(ctx, tb, q) {
    const n = Object.keys(ctx.state.tables[tb.name] || {}).length;
    const fields = q ? tb.fields.filter((f) => [f.name, f.label, f.note].some((x) => String(x || '').toLowerCase().indexOf(q) >= 0)) : tb.fields;
    const show = q && fields.length === 0 ? tb.fields : fields;
    return h.section(tb.label, t`${tb.note ? h.note(tb.note, 'info') : ''}${h.table({ rows: show, dense: true, cols: [
      { label: 'ชื่อคอลัมน์ (หัวแท็บ)', render: (f) => t`${h.code(f.name)}${tb.key.indexOf(f.name) >= 0 ? t` ${h.badge('คีย์', 'accent')}` : ''}` },
      { label: 'ชนิด', get: (f) => `${TYPE_LABEL[f.type] || f.type}` },
      { label: 'ความหมาย', key: 'label' },
      { label: 'หมายเหตุ / ค่าที่ใช้ได้', key: 'note' },
    ] })}`, {
      sub: t`แท็บ ${h.code(tb.name)} · คีย์ ${tb.key.join(' + ')} · ${tb.fields.length} คอลัมน์ · ข้อมูลตอนนี้ ${h.fmt.num(n)} แถว`,
      actions: [h.btn('หัวตาราง CSV', { act: 'headerCsv', arg: tb.name, tone: 'ghost', small: true }),
        h.btn('ข้อมูล CSV', { act: 'dataCsv', arg: tb.name, tone: 'ghost', small: true, disabled: !n, title: n ? null : 'ตารางนี้ยังไม่มีข้อมูล' })],
    });
  }

  RRS.ui.page({
    id: 'dictionary', title: 'พจนานุกรมข้อมูล / Google Sheet', phase: 0, order: 50,
    sub: 'ทุกตารางที่ระบบเก็บ ความหมายของแต่ละคอลัมน์ และหัวตารางของแต่ละแท็บใน Google Sheet',
    render(ctx) {
      const v = ctx.view;
      const all = tables();
      const keys = [];
      for (const tb of all) if (keys.indexOf(phaseKey(tb.phase)) < 0) keys.push(phaseKey(tb.phase));
      const tab = keys.indexOf(v.tab) >= 0 ? v.tab : keys[0];
      const q = (v.q || '').trim().toLowerCase();
      const match = (tb) => !q || [tb.name, tb.label, tb.note].concat(tb.fields.map((f) => `${f.name} ${f.label} ${f.note}`)).some((x) => String(x || '').toLowerCase().indexOf(q) >= 0);
      const shown = all.filter((tb) => (q ? match(tb) : phaseKey(tb.phase) === tab));
      const filled = all.filter((tb) => Object.keys(ctx.state.tables[tb.name] || {}).length);
      const modeLabel = { demo: 'ข้อมูลตัวอย่างในเบราว์เซอร์นี้', team: 'ฐานข้อมูลทีมของหน้านี้', server: 'เซิร์ฟเวอร์ Cloudflare + Google Sheet' }[ctx.mode] || '';
      const intro = h.note(t`เมื่อเชื่อมต่อเซิร์ฟเวอร์ Cloudflare + Google Sheet แต่ละตารางด้านล่างจะเป็น <b>1 แท็บ</b> ใน Google Sheet (ไฟล์อยู่ใน Google Drive):
        ชื่อแท็บ = ชื่อตาราง · แถวแรก = ชื่อคอลัมน์ · คอลัมน์ชนิด JSON/รายการเก็บเป็นข้อความ JSON ในช่องเดียว · ทุกการบันทึกเพิ่มแถวในแท็บ audit พร้อมลายนิ้วมือ
        ${modeLabel ? t`<br>ตอนนี้ข้อมูลเก็บที่: <b>${modeLabel}</b>` : ''}`, 'info');
      const dataOpts = all.map((tb) => [tb.name, `${tb.name} – ${tb.label} (${Object.keys(ctx.state.tables[tb.name] || {}).length} แถว)`]);
      const tools = h.toolbar([
        h.field({ name: 'q', label: 'ค้นหาคอลัมน์/ตาราง', value: v.q, placeholder: 'เช่น ล็อต, docNo, คลัง', id: 'dict-q' }),
        h.field({ name: 'dataTable', label: 'ดาวน์โหลดข้อมูลของตาราง', type: 'select', value: v.dataTable, options: dataOpts, blank: '— เลือกตาราง —', id: 'dict-data' }),
      ], [h.btn('ดาวน์โหลดข้อมูล (CSV)', { act: 'dataCsv', arg: '', tone: 'ghost', disabled: !v.dataTable }),
        h.btn('โครงสร้างทุกแท็บ (JSON)', { act: 'layoutJson', tone: 'primary' })]);
      const kp = h.kpis([h.kpi('ตาราง (แท็บ)', String(all.length), `${keys.length} กลุ่ม`), h.kpi('คอลัมน์ทั้งหมด', h.fmt.num(all.reduce((s, tb) => s + tb.fields.length, 0))),
        h.kpi('ตารางที่มีข้อมูล', String(filled.length), `ข้อมูลล่าสุดลำดับที่ ${ctx.state.seq}`)]);
      const tabList = keys.map((k) => ({ id: k, label: k === 'other' ? 'อื่น ๆ' : `Phase ${k}`, count: all.filter((tb) => phaseKey(tb.phase) === k).length }));
      const body = shown.length ? t`${shown.map((tb) => tableBlock(ctx, tb, q))}` : h.empty('ไม่พบตารางหรือคอลัมน์ที่ค้น', 'ลองคำอื่น เช่น ชื่อคอลัมน์ภาษาอังกฤษ หรือความหมายภาษาไทย');
      return t`${intro}${kp}${tools}${q ? h.note(`ผลค้น "${v.q}": ${shown.length} ตาราง จากทุก Phase`, 'info') : t`${h.tabs(tabList, tab)}<p class="hint">${phaseName(tab)}</p>`}${body}`;
    },
    after(ctx, root0) {
      const q = root0.querySelector('#dict-q');
      if (q) {
        q.addEventListener('input', () => { ctx.view.q = q.value; clearTimeout(ctx.view._t); ctx.view._t = setTimeout(() => ctx.set({ _refocus: true }), 300); });
        if (ctx.view._refocus) { ctx.view._refocus = false; q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      }
      const d = root0.querySelector('#dict-data');
      if (d) d.addEventListener('change', () => ctx.set({ dataTable: d.value }));
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg }),
      async layoutJson(ctx) {
        const out = {};
        for (const tb of tables()) out[tb.name] = headers(tb);
        await ctx.download('google-sheet-layout.json', JSON.stringify(out, null, 2) + '\n');
      },
      async headerCsv(ctx, el) {
        const tb = RRS.schema.tables[el.dataset.arg];
        if (tb) await ctx.download(`${tb.name}-header.csv`, csv([headers(tb)]));
      },
      async dataCsv(ctx, el) {
        const name = el.dataset.arg || ctx.view.dataTable;
        const tb = RRS.schema.tables[name];
        if (!tb) return ctx.toast('เลือกตารางที่จะดาวน์โหลดก่อน', 'warn');
        const r = dataCsv(ctx.state, tb, ctx.can('users.manage'));
        if (!r.n) return ctx.toast(`ตาราง ${tb.label} ยังไม่มีข้อมูล`, 'info');
        await ctx.download(`${tb.name}-${ctx.today}.csv`, r.text);
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
