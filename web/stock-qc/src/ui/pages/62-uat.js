/*
 * Phase 6 – ทดสอบรับงาน (UAT) (engine: RRS.reports.UAT_CRITERIA / uatSummary, command uat.record).
 * Every acceptance criterion of Phase 0–6 grouped by phase with its latest recorded result (PASS / FAIL / NOT_RUN,
 * evidence, note – the tester and the date come from the system) and the progress of each phase (h.meter). Earlier
 * results stay in the history of the criterion. Extra criteria can be added with their own id.
 * "รันทดสอบอัตโนมัติ" runs RRS.selftest.run() (when that module is loaded) and shows each automatic result beside its
 * criterion – clearly labelled as automatic checks on test data, never recorded as the people's acceptance.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const U = RRS.util;
  const R = () => RRS.reports || null;

  const dash = t`<span class="muted">–</span>`;
  const low = (s) => String(s == null ? '' : s).toLowerCase();
  const TONE = { PASS: 'ok', FAIL: 'bad', NOT_RUN: 'warn' };
  const statusBadge = (s) => h.badge((R().UAT_STATUS || {})[s] || s, TONE[s] || 'muted');
  const PHASES = [0, 1, 2, 3, 4, 5, 6];

  // ---- automatic checks (RRS.selftest) – kept in this tab only, never written as UAT results ------------------------------
  const auto = { running: false, at: '', ms: 0, byId: {}, extra: [], error: '', total: 0, pass: 0, fail: 0 };
  /** Whatever RRS.selftest.run() returns -> [{id, ok (true/false/null = not run), name, message}]. */
  function normalize(out) {
    let list = [];
    if (Array.isArray(out)) list = out;
    else if (out && typeof out === 'object') {
      for (const k of ['results', 'checks', 'criteria', 'rows', 'tests', 'items']) {
        if (Array.isArray(out[k])) {
          list = out[k];
          break;
        }
      }
      if (!list.length) {
        list = Object.keys(out).filter((k) => out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]))
          .map((k) => Object.assign({ id: k }, out[k]));
      }
    }
    const crit = R().UAT_CRITERIA;
    return list.filter((x) => x && typeof x === 'object').map((x) => {
      let id = U.trim(x.id || x.uat || x.criterionId || x.key || x.code || '').toUpperCase();
      if (!/^P\d+-\d+$/.test(id)) {
        const text = U.trim(x.criterion || x.name || x.title || '');
        const c = crit.find((y) => y.criterion === text);
        if (c) id = c.id;
      }
      const st = String(x.status || x.result || '').toUpperCase();
      const skipped = x.skipped === true || st === 'SKIP' || st === 'SKIPPED' || st === 'NOT_RUN';
      let ok = x.ok;
      if (ok == null) ok = x.pass != null ? x.pass : x.passed != null ? x.passed : st ? /^(PASS|PASSED|OK)$/.test(st) : null;
      const problems = Array.isArray(x.problems) ? x.problems : Array.isArray(x.errors) ? x.errors.map((e) => (e && e.message) || e) : [];
      return { id, ok: skipped || ok == null ? null : !!ok, name: U.trim(x.name || x.title || x.label || x.criterion || ''),
        message: U.trim(x.message || x.detail || x.error || x.note || problems.join(' · ') || '') };
    });
  }
  function collect(list) {
    const byId = {};
    const extra = [];
    const known = new Set(R().UAT_CRITERIA.map((c) => c.id));
    for (const x of list) {
      if (!known.has(x.id)) {
        extra.push(x);
        continue;
      }
      const a = byId[x.id] || (byId[x.id] = { ok: true, n: 0, notRun: 0, parts: [] });
      a.n += 1;
      if (x.ok === null) a.notRun += 1;
      else if (!x.ok) a.ok = false;
      if (x.name || x.message) a.parts.push([x.ok === null ? 'ไม่ได้รัน' : x.ok ? 'ผ่าน' : 'ไม่ผ่าน', x.name, x.message].filter(Boolean).join(': '));
    }
    for (const id in byId) if (byId[id].notRun === byId[id].n) byId[id].ok = null;
    return { byId, extra };
  }
  const autoBadge = (a) => (!a ? dash : a.ok === null ? h.badge('อัตโนมัติ: ไม่ได้รัน', 'muted') : a.ok ? h.badge('อัตโนมัติ: ผ่าน', 'ok') : h.badge('อัตโนมัติ: ไม่ผ่าน', 'bad'));

  function summary(ctx) {
    return R().uatSummary(ctx.state);
  }
  function filtered(ctx, rows) {
    const v = ctx.view;
    const q = low(v.q).trim();
    return rows.filter((r) => (v.phase === '' || v.phase == null || String(r.phase) === String(v.phase)) && (!v.st || r.status === v.st)
      && (!v.auto || (v.auto === 'fail' ? auto.byId[r.id] && auto.byId[r.id].ok === false : v.auto === 'none' ? !auto.byId[r.id] : true))
      && (!q || [r.id, r.criterion, r.evidence, r.note, ctx.userName(r.tester)].some((x) => low(x).indexOf(q) >= 0)));
  }

  function phaseSection(ctx, ph, rows, all, can) {
    const p = all.byPhase[ph] || { title: R().PHASE_TITLE[ph] || '', total: 0, PASS: 0, FAIL: 0, NOT_RUN: 0 };
    const frac = p.total ? p.PASS / p.total : 0;
    const meter = h.meter(frac, `ผ่าน ${p.PASS} จาก ${p.total} เกณฑ์${p.FAIL ? ` · ไม่ผ่าน ${p.FAIL}` : ''}${p.NOT_RUN ? ` · ยังไม่ทดสอบ ${p.NOT_RUN}` : ''}`);
    const hasAuto = Object.keys(auto.byId).length > 0;
    const cols = [
      { label: 'รหัส', render: (r) => t`${h.code(r.id)}${r.custom ? t`<br><small class="muted">เกณฑ์เพิ่ม</small>` : ''}` },
      { label: 'เกณฑ์ผ่าน', key: 'criterion' },
      { label: 'ผลรับงาน', render: (r) => t`${statusBadge(r.status)}${r.retests ? t`<br>${h.btn(`ผลก่อนหน้า ${r.retests}`, { act: 'history', arg: r.id, tone: 'quiet', small: true })}` : ''}` },
      { label: 'ผู้ทดสอบ / วันที่', render: (r) => (r.tester ? t`${ctx.userName(r.tester)}<br><small class="muted">${h.fmt.date(r.testedOn)}</small>` : dash) },
      { label: 'หลักฐาน / สิ่งที่พบ', render: (r) => (r.evidence || r.note ? t`${r.evidence}${r.evidence && r.note ? t`<br>` : ''}${r.note ? t`<small class="muted">${r.note}</small>` : ''}` : dash) },
    ];
    if (hasAuto) cols.push({ label: 'ตรวจอัตโนมัติ (ข้อมูลทดสอบ)', render: (r) => t`${autoBadge(auto.byId[r.id])}${auto.byId[r.id] && auto.byId[r.id].parts.length ? t`<br><small class="muted">${auto.byId[r.id].parts.slice(0, 3).join(' | ')}</small>` : ''}` });
    if (can) cols.push({ label: '', render: (r) => h.btn('บันทึกผล', { act: 'record', arg: r.id, tone: r.status === 'PASS' ? 'ghost' : 'primary', small: true }) });
    const tbl = h.table({ dense: true, rows, cols, rowCls: (r) => (r.status === 'FAIL' ? 'row-bad' : ''), empty: 'ไม่มีเกณฑ์ตามตัวกรอง' });
    return h.section(`Phase ${ph} · ${p.title}`, t`${meter}${tbl}`, { id: `uat-ph-${ph}` });
  }

  function recordBody(ctx, row, a) {
    const user = ctx.user;
    return t`<div class="wide">${h.dl([['เกณฑ์', t`${h.code(row.id)} ${row.criterion}`], ['ผลล่าสุด', statusBadge(row.status)],
      ['ผู้ทดสอบ', `${user ? user.name : '–'} (ระบบบันทึกให้)`], ['วันที่ทดสอบ', `${h.fmt.date(ctx.today)} (ระบบบันทึกให้)`]])}</div>
      ${a ? t`<div class="wide">${h.note(t`ผลตรวจอัตโนมัติบนข้อมูลทดสอบ: ${autoBadge(a)} – ใช้ประกอบได้ แต่ผลรับงานต้องมาจากการลองกับงานจริงของผู้ทดสอบ`, 'info')}</div>` : ''}
      ${h.field({ name: 'status', label: 'ผลการทดสอบ', type: 'radio', value: row.status === 'NOT_RUN' ? '' : row.status, wide: true, id: 'uat-status',
        options: [['PASS', 'ผ่าน'], ['FAIL', 'ไม่ผ่าน'], ['NOT_RUN', 'ยังไม่ทดสอบ (ล้างผลเดิม)']] })}
      ${h.field({ name: 'evidence', label: 'หลักฐาน', value: '', wide: true, id: 'uat-evidence', placeholder: 'เช่น เลขเอกสาร PD6911-0003, ชื่อไฟล์ภาพ, รอบนับ CT-00002',
        hint: 'ผลผ่านต้องมีหลักฐานที่คนอื่นเปิดดูซ้ำได้' })}
      ${h.field({ name: 'note', label: 'สิ่งที่พบ / หมายเหตุ', type: 'textarea', rows: 3, value: '', wide: true, id: 'uat-note', hint: 'ผลไม่ผ่านต้องบอกสิ่งที่พบ เพื่อให้แก้และทดสอบซ้ำ' })}
      <p class="hint wide">ผลเดิมไม่หาย – เก็บไว้ในประวัติของเกณฑ์นี้</p>`;
  }

  RRS.ui.page({
    id: 'uat', title: 'ทดสอบรับงาน (UAT)', phase: 6, order: 30,
    sub: 'เกณฑ์ผ่านของทุก Phase ตามแผน · ผู้ทดสอบลองกับงานจริงแล้วบันทึกผลพร้อมหลักฐาน · ผู้ทดสอบและวันที่มาจากระบบ แก้ไม่ได้',
    badge: (ctx) => (R() && ctx.can('uat.record') ? R().uatSummary(ctx.state).totals.fail || '' : ''),
    render(ctx) {
      if (!R() || typeof R().uatSummary !== 'function') return h.empty('ยังเปิดหน้าทดสอบรับงานไม่ได้', 'หน้านี้ต้องใช้โมดูลรายงาน (reports) ซึ่งยังไม่ได้โหลด – โหลดหน้าใหม่ หรือแจ้งผู้ดูแลระบบ');
      const v = ctx.view;
      const can = ctx.can('uat.record');
      const all = summary(ctx);
      const T = all.totals;
      const rows = filtered(ctx, all.rows);
      const k = h.kpis([
        h.kpi('เกณฑ์ทั้งหมด', h.fmt.num(T.total), `${PHASES.length} Phase`),
        h.kpi('ผ่าน', h.fmt.num(T.pass), T.total ? `${Math.round((T.pass / T.total) * 100)}% ของเกณฑ์` : '', T.pass ? 'ok' : ''),
        h.kpi('ไม่ผ่าน', h.fmt.num(T.fail), T.fail ? 'ต้องแก้แล้วทดสอบซ้ำ' : 'ไม่มี', T.fail ? 'bad' : 'ok'),
        h.kpi('ยังไม่ทดสอบ', h.fmt.num(T.notRun), 'เกณฑ์', T.notRun ? 'warn' : 'ok'),
      ]);
      const overall = h.meter(T.total ? T.pass / T.total : 0, `ผ่านรวม ${T.pass} จาก ${T.total} เกณฑ์`);
      // automatic checks
      const hasSelftest = !!(RRS.selftest && typeof RRS.selftest.run === 'function');
      let autoBox;
      if (!hasSelftest) {
        autoBox = h.note('ชุดตรวจอัตโนมัติยังไม่ได้ติดตั้งในหน้านี้ – บันทึกผลจากการทดสอบจริงได้ตามปกติ', 'info');
      } else if (auto.running) {
        autoBox = t`<div class="loading"><div class="spin" aria-hidden="true"></div><p>กำลังรันทดสอบอัตโนมัติบนข้อมูลทดสอบ…</p></div>`;
      } else if (auto.error) {
        autoBox = h.note(`รันทดสอบอัตโนมัติไม่สำเร็จ: ${auto.error} – ลองอีกครั้ง ถ้ายังไม่ได้ให้แจ้งผู้ดูแลระบบ (ผลรับงานไม่ได้รับผลกระทบ)`, 'bad');
      } else if (auto.at) {
        autoBox = h.note(t`รันเมื่อ ${h.fmt.dt(auto.at)}${auto.ms ? ` (${h.fmt.num(auto.ms / 1000, 1)} วินาที)` : ''}: ผ่าน ${auto.pass} · ไม่ผ่าน ${auto.fail} จาก ${auto.total} รายการ – ดูผลในคอลัมน์ ตรวจอัตโนมัติ ของแต่ละเกณฑ์`, auto.fail ? 'warn' : 'ok');
      } else {
        autoBox = t`<p class="hint">ยังไม่ได้รันในหน้านี้</p>`;
      }
      const extra = auto.extra.length ? h.table({ dense: true, rows: auto.extra, cols: [{ label: 'รายการตรวจ', get: (x) => x.id || x.name || '–' },
        { label: 'ผล', render: (x) => autoBadge(x) }, { label: 'รายละเอียด', get: (x) => [x.name, x.message].filter(Boolean).join(': ') }] }) : '';
      const autoSec = h.section('ตรวจอัตโนมัติ (ไม่ใช่ผลรับงาน)', t`${h.note('เป็นการตรวจอัตโนมัติบนข้อมูลทดสอบ เพื่อดูว่ากติกาของระบบยังทำงานถูก – ไม่ใช่การยอมรับของผู้ใช้ และไม่ถูกบันทึกเป็นผล UAT · ผลรับงานต้องให้ผู้ทดสอบลองกับงานจริงแล้วกด บันทึกผล', 'warn')}${autoBox}${extra}`,
        { id: 'uat-auto', actions: h.btn(auto.running ? 'กำลังรัน…' : 'รันทดสอบอัตโนมัติ', { act: 'runAuto', tone: 'ghost', id: 'uat-run', disabled: !hasSelftest || auto.running,
          title: hasSelftest ? 'รันชุดตรวจอัตโนมัติ' : 'ชุดตรวจอัตโนมัติยังไม่ได้ติดตั้ง' }) });
      const phaseOpts = PHASES.map((p) => [String(p), `Phase ${p} · ${R().PHASE_TITLE[p]}`]);
      const isFiltered = (v.phase !== '' && v.phase != null) || v.st || v.q || v.auto;
      const left = [
        h.field({ name: 'q', label: 'ค้นหา', value: v.q, placeholder: 'รหัส ข้อความเกณฑ์ หลักฐาน ผู้ทดสอบ…', id: 'uat-q', act: 'filter', live: true }),
        h.field({ name: 'phase', label: 'Phase', type: 'select', value: v.phase, options: phaseOpts, blank: 'ทุก Phase', id: 'uat-phase', act: 'filter' }),
        h.field({ name: 'st', label: 'ผล', type: 'select', value: v.st, options: Object.entries(R().UAT_STATUS), blank: 'ทุกผล', id: 'uat-st', act: 'filter' }),
        Object.keys(auto.byId).length ? h.field({ name: 'auto', label: 'ตรวจอัตโนมัติ', type: 'select', value: v.auto, options: [['fail', 'อัตโนมัติไม่ผ่าน'], ['none', 'ไม่มีผลอัตโนมัติ']], blank: 'ทั้งหมด', id: 'uat-auto-f', act: 'filter' }) : '',
      ];
      const right = [isFiltered ? h.btn('ล้างตัวกรอง', { act: 'clear', tone: 'ghost' }) : '', h.btn('ดาวน์โหลด CSV', { act: 'csv', tone: 'ghost' }),
        can ? h.btn('+ เพิ่มเกณฑ์', { act: 'addCriterion', tone: 'ghost', id: 'uat-add' }) : ''];
      const phases = Array.from(new Set(rows.map((r) => r.phase))).sort((a, b) => a - b);
      const sections = phases.length ? phases.map((ph) => phaseSection(ctx, ph, rows.filter((r) => r.phase === ph), all, can))
        : h.empty('ไม่พบเกณฑ์ตามตัวกรอง', 'ลองล้างตัวกรอง');
      const who = can ? '' : h.note(`บันทึกผลได้เฉพาะผู้ทดสอบที่มีสิทธิ์ ${RRS.auth.PERM_LABELS['uat.record'] || 'uat.record'} – คุณดูผลได้อย่างเดียว`, 'info');
      const none = T.pass + T.fail === 0 ? h.note('ยังไม่มีผลทดสอบที่บันทึก – เริ่มจาก Phase 0 ลองทำตามเกณฑ์แต่ละข้อกับงานจริง แล้วกด บันทึกผล พร้อมหลักฐาน', 'info') : '';
      return t`${k}${overall}${who}${none}${autoSec}${h.toolbar(left, right)}${sections}`;
    },
    actions: {
      filter(ctx, el) {
        const patch = {};
        patch[el.name] = el.type === 'checkbox' ? el.checked : el.value;
        ctx.set(patch);
      },
      clear: (ctx) => ctx.set({ phase: '', st: '', q: '', auto: '' }),
      async runAuto(ctx) {
        if (!RRS.selftest || typeof RRS.selftest.run !== 'function' || auto.running) return;
        auto.running = true;
        auto.error = '';
        ctx.set({});
        await new Promise((res) => setTimeout(res, 30)); // let the "running" state paint first
        const t0 = Date.now();
        try {
          const out = await RRS.selftest.run();
          const list = normalize(out);
          const c = collect(list);
          auto.byId = c.byId;
          auto.extra = c.extra;
          auto.total = list.length;
          auto.pass = list.filter((x) => x.ok === true).length;
          auto.fail = list.filter((x) => x.ok === false).length;
          auto.at = new Date().toISOString();
          auto.ms = Date.now() - t0;
          if (!list.length) auto.error = 'ชุดตรวจไม่ส่งผลกลับมา';
        } catch (e) {
          if (root.console) root.console.error(e);
          auto.error = (e && e.message) || String(e);
        }
        auto.running = false;
        ctx.set({});
        if (!auto.error) ctx.toast(`ตรวจอัตโนมัติเสร็จ: ผ่าน ${auto.pass} ไม่ผ่าน ${auto.fail} (ข้อมูลทดสอบ – ไม่ใช่ผลรับงาน)`, auto.fail ? 'warn' : 'ok');
      },
      async record(ctx, el) {
        const row = summary(ctx).rows.find((r) => r.id === el.dataset.arg);
        if (!row) return;
        await ctx.dialog({
          title: `บันทึกผล ${row.id}`, submit: 'บันทึกผล', wide: true,
          body: recordBody(ctx, row, auto.byId[row.id]),
          onSubmit(vals) {
            if (!vals.status) return { ok: false, errors: [{ message: 'เลือกผลการทดสอบ: ผ่าน / ไม่ผ่าน / ยังไม่ทดสอบ' }] };
            return ctx.exec('uat.record', { id: row.id, status: vals.status, evidence: vals.evidence, note: vals.note },
              { quiet: true, done: `บันทึกผล ${row.id}: ${R().UAT_STATUS[vals.status]}` });
          },
        });
      },
      async history(ctx, el) {
        const rec = RRS.q.get(ctx.state, 'uat', el.dataset.arg);
        if (!rec) return;
        const list = [{ status: rec.status, tester: rec.tester, testedOn: rec.testedOn, evidence: rec.evidence, note: rec.note, at: rec.at, now: true }]
          .concat((rec.history || []).slice().reverse());
        await ctx.dialog({
          title: `ประวัติผลทดสอบ ${rec.id}`, submit: 'ปิด', wide: true,
          body: t`<p class="wide">${rec.criterion}</p><div class="wide">${h.table({ dense: true, rows: list, cols: [
            { label: 'ผล', render: (x) => t`${statusBadge(x.status)}${x.now ? t` <small class="muted">ล่าสุด</small>` : ''}` },
            { label: 'ผู้ทดสอบ', get: (x) => ctx.userName(x.tester) }, { label: 'วันที่', get: (x) => h.fmt.date(x.testedOn) },
            { label: 'หลักฐาน', get: (x) => x.evidence || '' }, { label: 'หมายเหตุ', get: (x) => x.note || '' }] })}</div>`,
        });
      },
      async addCriterion(ctx) {
        await ctx.dialog({
          title: 'เพิ่มเกณฑ์ทดสอบ', submit: 'บันทึกเกณฑ์และผล', wide: true,
          message: 'ใช้เมื่อทีมตกลงเกณฑ์เพิ่มจากแผน เช่น กรณีพิเศษของโรงงาน · รหัสต้องไม่ซ้ำกับเกณฑ์ที่มี',
          body: t`${h.field({ name: 'id', label: 'รหัสเกณฑ์', required: true, id: 'uat-new-id', placeholder: 'เช่น P2-X1', hint: 'ใช้ A-Z 0-9 - _ .' })}
            ${h.field({ name: 'phase', label: 'Phase', type: 'select', required: true, id: 'uat-new-phase', options: PHASES.map((p) => [String(p), `Phase ${p} · ${R().PHASE_TITLE[p]}`]) })}
            ${h.field({ name: 'criterion', label: 'เกณฑ์ผ่าน', required: true, wide: true, id: 'uat-new-text', placeholder: 'เขียนสิ่งที่ต้องเห็นเมื่อผ่าน' })}
            ${h.field({ name: 'status', label: 'ผลตอนนี้', type: 'radio', value: 'NOT_RUN', wide: true, options: [['NOT_RUN', 'ยังไม่ทดสอบ'], ['PASS', 'ผ่าน'], ['FAIL', 'ไม่ผ่าน']] })}
            ${h.field({ name: 'evidence', label: 'หลักฐาน (ถ้าผ่าน)', wide: true })}
            ${h.field({ name: 'note', label: 'สิ่งที่พบ / หมายเหตุ', wide: true })}`,
          onSubmit(vals) {
            const id = U.normCode(vals.id);
            if (id && summary(ctx).rows.some((r) => r.id === id)) return { ok: false, errors: [{ message: `มีเกณฑ์ ${id} แล้ว – กด บันทึกผล ที่แถวนั้นแทน หรือใช้รหัสอื่น` }] };
            if (vals.phase === '') return { ok: false, errors: [{ message: 'เลือก Phase ของเกณฑ์' }] };
            return ctx.exec('uat.record', { id, phase: Number(vals.phase), criterion: vals.criterion, status: vals.status || 'NOT_RUN', evidence: vals.evidence, note: vals.note },
              { quiet: true, done: `เพิ่มเกณฑ์ ${id} แล้ว` });
          },
        });
      },
      async csv(ctx) {
        const rows = filtered(ctx, summary(ctx).rows);
        const hasAuto = Object.keys(auto.byId).length > 0;
        const head = ['รหัส', 'Phase', 'เกณฑ์ผ่าน', 'ผลรับงาน', 'ผู้ทดสอบ', 'วันที่ทดสอบ', 'หลักฐาน', 'หมายเหตุ', 'จำนวนผลก่อนหน้า', 'ชุดทดสอบอัตโนมัติ']
          .concat(hasAuto ? ['ตรวจอัตโนมัติ (ข้อมูลทดสอบ – ไม่ใช่ผลรับงาน)'] : []);
        const out = [head].concat(rows.map((r) => {
          const a = auto.byId[r.id];
          return [r.id, r.phase, r.criterion, R().UAT_STATUS[r.status], r.tester ? ctx.userName(r.tester) : '', r.testedOn ? h.fmt.date(r.testedOn) : '', r.evidence, r.note,
            r.retests, r.auto].concat(hasAuto ? [!a ? '' : a.ok === null ? 'ไม่ได้รัน' : a.ok ? 'ผ่าน' : 'ไม่ผ่าน'] : []);
        }));
        await ctx.download(`uat-${ctx.today}.csv`, h.csv(out));
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
