/*
 * System – the audit log (one row per saved command, newest first) with filters, and an integrity check: every
 * commit's fingerprint (RRS.core.verifyCommit), the chain and sequence (1, 2, 3 … each pointing at the one before)
 * and that every stock balance equals the sum of its movements (RRS.inventory.verifyBalances).
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const U = RRS.util;

  const kindLabel = (k) => (RRS.commands.defs[k] && RRS.commands.defs[k].label) || k;
  const PAGE = 200;

  function filtered(ctx) {
    const v = ctx.view;
    const q = (v.q || '').trim().toLowerCase();
    return RRS.q.rows(ctx.state, 'audit').filter((a) => {
      if (v.by && (a.by || '') !== (v.by === '__system' ? '' : v.by)) return false;
      if (v.kind && a.kind !== v.kind) return false;
      const d = U.bkkDate(a.at);
      if (v.from && d < v.from) return false;
      if (v.to && d > v.to) return false;
      if (q && ![a.summary, a.kind, kindLabel(a.kind), String(a.seq), a.request].some((x) => String(x || '').toLowerCase().indexOf(q) >= 0)) return false;
      return true;
    }).sort((a, b) => b.seq - a.seq);
  }

  /** Where the commits can be read from in this mode (null in server mode – the server keeps them). */
  function commitSource() {
    const app = RRS.app;
    if (!app || app.mode === 'server' || !app.store || typeof app.store.load !== 'function') return null;
    return app.store;
  }

  async function verify(ctx) {
    const state = ctx.state;
    const problems = [];
    const facts = [];
    const store = commitSource();
    let commits = null;
    if (store) {
      commits = await store.load(0);
      let prev = RRS.core.GENESIS;
      commits.forEach((c, i) => {
        if (problems.length > 60) return;
        if (c.seq !== i + 1) problems.push(`ลำดับขาดช่วง: รายการที่ ${i + 1} ในที่เก็บเป็นลำดับ ${c.seq}`);
        if (!RRS.core.verifyCommit(c)) problems.push(`ลำดับ ${c.seq} (${c.summary || c.kind}): ลายนิ้วมือไม่ตรง – ข้อมูลถูกแก้หลังบันทึก`);
        if (c.prev !== prev) problems.push(`ลำดับ ${c.seq}: ไม่ได้ต่อจากรายการก่อนหน้า (สายลายนิ้วมือขาด)`);
        prev = c.hash;
      });
      facts.push(`ตรวจลายนิ้วมือ ${h.fmt.num(commits.length)} รายการ`);
      if (commits.length < state.seq) problems.push(`ที่เก็บมี ${commits.length} รายการ แต่หน้านี้โหลดไว้ ${state.seq} รายการ – มีรายการหายจากที่เก็บ`);
      else if (commits.length > state.seq) facts.push(`มีรายการใหม่จากผู้อื่น ${commits.length - state.seq} รายการที่หน้านี้ยังไม่แสดง`);
      const atHead = commits[state.seq - 1];
      if (state.seq && atHead && atHead.hash !== state.head) problems.push(`ลายนิ้วมือล่าสุดของหน้านี้ไม่ตรงกับที่เก็บที่ลำดับ ${state.seq} – โหลดหน้าใหม่`);
    } else {
      facts.push('ประวัติ commit อยู่ที่เซิร์ฟเวอร์ ซึ่งตรวจลายนิ้วมือทุกรายการทุกครั้งที่หน้านี้โหลดข้อมูล');
    }
    const auditN = RRS.q.rows(state, 'audit').length;
    if (auditN !== state.seq) problems.push(`บันทึกการทำรายการมี ${auditN} แถว แต่มีการบันทึก ${state.seq} ครั้ง`);
    const bad = RRS.inventory && RRS.inventory.verifyBalances ? RRS.inventory.verifyBalances(state) : [];
    for (const b of bad.slice(0, 40)) {
      const [code, wh, bin, status, lot] = b.key.split('|');
      problems.push(`ยอด ${code} ที่ ${wh}${bin ? '/' + bin : ''} (${RRS.STATUS_LABEL[status] || status}${lot ? ' ล็อต ' + lot : ''}): คงเหลือ ${b.balance} แต่ผลรวมประวัติ ${b.history}`);
    }
    if (bad.length > 40) problems.push(`… และยอดไม่ตรงอีก ${bad.length - 40} ตำแหน่ง`);
    facts.push(`ตรวจยอดคงเหลือ ${h.fmt.num(RRS.q.rows(state, 'balances').length)} ตำแหน่งกับประวัติ ${h.fmt.num(RRS.q.rows(state, 'movements').length)} รายการ`);
    return { at: new Date().toISOString(), ok: problems.length === 0, problems, facts, commits: commits ? commits.length : null };
  }

  function csvOf(rows, ctx) {
    const cell = (s) => {
      s = String(s == null ? '' : s);
      if (/^[=+@\t\r]/.test(s) || /^-[^\d.]/.test(s)) s = "'" + s; // a spreadsheet would run it as a formula
      return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['ลำดับ', 'เวลา (ไทย)', 'ผู้ทำ', 'รหัสผู้ทำ', 'คำสั่ง', 'ชื่อคำสั่ง', 'สรุป', 'รหัสคำขอ'];
    return '\ufeff' + [head].concat(rows.map((a) => [a.seq, h.fmt.dt(a.at), a.by ? ctx.userName(a.by) : 'ระบบ', a.by, a.kind, kindLabel(a.kind), a.summary, a.request]))
      .map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  RRS.ui.page({
    id: 'audit', title: 'บันทึกการทำรายการ', phase: 'sys', order: 90,
    sub: 'ทุกการบันทึกมีลำดับ เวลา ผู้ทำ และลายนิ้วมือที่ต่อกันเป็นสาย – แก้หรือลบย้อนหลังไม่ได้ ถ้าข้อมูลถูกแก้นอกระบบ การตรวจจะพบ',
    render(ctx) {
      const v = ctx.view;
      const all = RRS.q.rows(ctx.state, 'audit');
      const rows = filtered(ctx);
      const limit = v.limit || PAGE;
      const byIds = Array.from(new Set(all.map((a) => a.by || '')));
      const byOpts = byIds.map((id) => (id ? [id, `${ctx.userName(id)} (${id})`] : ['__system', 'ระบบ (ไม่มีผู้ใช้)'])).sort((a, b) => a[1].localeCompare(b[1], 'th'));
      const kinds = Array.from(new Set(all.map((a) => a.kind))).sort().map((k) => [k, `${kindLabel(k)} (${k})`]);
      const tbl = h.table({ rows: rows.slice(0, limit), dense: true, rowAct: 'pick', rowArg: (a) => a.seq, rowCls: (a) => (String(a.seq) === String(v.sel) ? 'sel' : ''),
        empty: all.length ? 'ไม่พบรายการตามตัวกรอง' : 'ยังไม่มีรายการ',
        emptyText: all.length ? 'ล้างตัวกรองหรือเลือกช่วงวันที่ใหม่' : 'ทุกการบันทึกในระบบ (เพิ่มคลัง สินค้า เอกสาร อนุมัติ …) จะขึ้นที่นี่พร้อมผู้ทำและเวลา',
        cols: [
          { label: 'ลำดับ', num: true, key: 'seq', digits: 0 },
          { label: 'เวลา', get: (a) => h.fmt.dt(a.at) },
          { label: 'ผู้ทำ', get: (a) => (a.by ? ctx.userName(a.by) : 'ระบบ') },
          { label: 'คำสั่ง', render: (a) => t`${kindLabel(a.kind)}<br><span class="hint mono">${a.kind}</span>` },
          { label: 'สรุป', key: 'summary' },
        ] });
      const more = rows.length > limit ? t`<div class="form-actions">${h.btn(`แสดงเพิ่ม (${h.fmt.num(rows.length - limit)} รายการ)`, { act: 'more', tone: 'ghost', small: true })}</div>` : '';

      const c = v.check;
      const checkBody = t`<p class="hint">ตรวจว่า (1) ทุกรายการยังมีลายนิ้วมือ (SHA-256) ตรงกับข้อมูล (2) ลำดับต่อเนื่อง 1, 2, 3 … และแต่ละรายการต่อจากรายการก่อนหน้า (3) ยอดคงเหลือทุกตำแหน่งเท่ากับผลรวมประวัติเคลื่อนไหว</p>
        ${c ? (c.ok ? h.note(t`<b>ข้อมูลถูกต้อง</b> – ${c.facts.join(' · ')} · ตรวจเมื่อ ${h.fmt.dt(c.at)}`, 'ok')
          : h.note(t`<b>พบปัญหา ${c.problems.length} ข้อ</b> – ${c.facts.join(' · ')} · ตรวจเมื่อ ${h.fmt.dt(c.at)}<ul class="errs">${c.problems.map((p) => t`<li>${p}</li>`)}</ul>แจ้งผู้ดูแลระบบ และอย่าลบหรือแก้ข้อมูลในที่เก็บเอง`, 'bad')) : ''}`;

      const tools = h.toolbar([
        h.field({ name: 'q', label: 'ค้นหา', value: v.q, placeholder: 'สรุป เลขที่เอกสาร ลำดับ…', id: 'aud-q' }),
        h.field({ name: 'by', label: 'ผู้ทำ', type: 'select', value: v.by, options: byOpts, blank: 'ทุกคน', id: 'aud-by' }),
        h.field({ name: 'kind', label: 'คำสั่ง', type: 'select', value: v.kind, options: kinds, blank: 'ทุกคำสั่ง', id: 'aud-kind' }),
        h.field({ name: 'from', label: 'ตั้งแต่วันที่', type: 'date', value: v.from, id: 'aud-from' }),
        h.field({ name: 'to', label: 'ถึงวันที่', type: 'date', value: v.to, id: 'aud-to' }),
      ], [v.q || v.by || v.kind || v.from || v.to ? h.btn('ล้างตัวกรอง', { act: 'clear', tone: 'quiet' }) : '',
        h.btn('ดาวน์โหลด CSV', { act: 'csv', tone: 'ghost', disabled: !rows.length })]);
      return t`${h.section('ตรวจลายนิ้วมือข้อมูล', checkBody, { actions: h.btn('ตรวจลายนิ้วมือข้อมูล', { act: 'verify', tone: 'primary' }) })}
        ${tools}<div>${tbl}<p class="hint">แสดง ${h.fmt.num(Math.min(limit, rows.length))} จาก ${h.fmt.num(rows.length)} รายการ${rows.length !== all.length ? ` (ทั้งหมด ${h.fmt.num(all.length)})` : ''} · กดที่แถวเพื่อดูรายละเอียดและข้อมูลที่เปลี่ยน</p>${more}</div>`;
    },
    after(ctx, root0) {
      const q = root0.querySelector('#aud-q');
      if (q) {
        q.addEventListener('input', () => { ctx.view.q = q.value; clearTimeout(ctx.view._t); ctx.view._t = setTimeout(() => ctx.set({ _refocus: true, limit: null }), 300); });
        if (ctx.view._refocus) { ctx.view._refocus = false; q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      }
      for (const [id, key] of [['aud-by', 'by'], ['aud-kind', 'kind'], ['aud-from', 'from'], ['aud-to', 'to']]) {
        const el = root0.querySelector('#' + id);
        if (el) el.addEventListener('change', () => ctx.set({ [key]: el.value, limit: null }));
      }
    },
    actions: {
      async pick(ctx, el) {
        const sel = RRS.q.get(ctx.state, 'audit', String(el.dataset.arg));
        if (!sel) return;
        ctx.set({ sel: sel.seq });
        const store = commitSource();
        let eff = null;
        if (store) {
          try {
            const list = await store.load(sel.seq - 1);
            const c = list.find((x) => x.seq === sel.seq);
            eff = c ? { rows: c.effects.filter((e) => e.t !== 'audit'), hash: c.hash, ok: RRS.core.verifyCommit(c) } : { error: 'ไม่พบรายการนี้ในที่เก็บ' };
          } catch (e) {
            eff = { error: `อ่านข้อมูลที่เปลี่ยนไม่ได้: ${(e && e.message) || e}` };
          }
        }
        const tableLabel = (tn) => (RRS.schema.tables[tn] ? RRS.schema.tables[tn].label : tn);
        const short = (x, n) => (String(x || '').length > n ? String(x).slice(0, n) + '…' : String(x || ''));
        await ctx.dialog({ title: `รายการลำดับ ${sel.seq}`, submit: 'ปิด', wide: true,
          body: t`<div class="wide fld">${h.dl([
            ['เวลา', h.fmt.dt(sel.at)], ['ผู้ทำ', sel.by ? `${ctx.userName(sel.by)} (${sel.by})` : 'ระบบ'], ['บัญชีที่ใช้', ctx.can('users.manage') ? short(sel.via, 18) : sel.via ? '(แสดงเฉพาะผู้ดูแลผู้ใช้)' : ''],
            ['คำสั่ง', `${kindLabel(sel.kind)} (${sel.kind})`], ['สรุป', sel.summary], ['รหัสคำขอ', short(sel.request, 18)],
          ])}</div>
          <div class="wide fld">${!eff ? h.note('ข้อมูลที่เปลี่ยนของแต่ละรายการเก็บอยู่ที่เซิร์ฟเวอร์', 'info') : eff.error ? h.note(eff.error, 'warn') : t`
            <h3>ข้อมูลที่รายการนี้เปลี่ยน (${eff.rows.length} แถว)</h3>
            ${h.table({ rows: eff.rows, dense: true, empty: 'ไม่มีข้อมูลที่เปลี่ยน', cols: [
              { label: 'ตาราง', get: (e) => tableLabel(e.t) }, { label: 'คีย์', render: (e) => h.code(short(e.k, 40)) },
              { label: 'การเปลี่ยน', render: (e) => (e.v === null ? h.badge('ลบแถว', 'bad') : h.badge('บันทึกแถว', 'info')) }] })}
            <p class="hint">ลายนิ้วมือ ${h.code(String(eff.hash).slice(0, 16))}… · ${eff.ok ? h.badge('ตรงกับข้อมูล', 'ok') : h.badge('ไม่ตรงกับข้อมูล – ถูกแก้หลังบันทึก', 'bad')}</p>`}</div>` });
      },
      more: (ctx) => ctx.set({ limit: (ctx.view.limit || PAGE) + PAGE }),
      clear: (ctx) => ctx.set({ q: '', by: '', kind: '', from: '', to: '', limit: null }),
      async verify(ctx) {
        ctx.toast('กำลังตรวจลายนิ้วมือ…', 'info');
        let r;
        try {
          r = await verify(ctx);
        } catch (e) {
          r = { at: new Date().toISOString(), ok: false, problems: [`อ่านข้อมูลจากที่เก็บไม่ได้: ${(e && e.message) || e}`], facts: [] };
        }
        ctx.set({ check: r });
        ctx.toast(r.ok ? 'ตรวจแล้ว ข้อมูลถูกต้อง' : `พบปัญหา ${r.problems.length} ข้อ`, r.ok ? 'ok' : 'bad');
      },
      async csv(ctx) {
        const rows = filtered(ctx);
        await ctx.download(`audit-${ctx.today}.csv`, csvOf(rows, ctx));
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
