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
  const auto = { running: false, at: '', ms: 0, byId: {}, extra: [], error: '', total: 0, pass: 0, fail: 0, notRun: 0, done: 0, of: 0 };
  /**
   * RRS.selftest.run() -> [{id, phase, criterion, pass, detail, manual, checks, ms}] (other shapes are read too) ->
   * [{id, ok (true / false / null = not run), name, message, manual}]. A scenario that checked nothing (module missing,
   * no automatic test yet) counts as not run, not as a failure.
   */
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
      const nothing = x.checks === 0 && !ok; // nothing was checked: not run
      const problems = Array.isArray(x.problems) ? x.problems : Array.isArray(x.errors) ? x.errors.map((e) => (e && e.message) || e) : [];
      return { id, ok: skipped || nothing || ok == null ? null : !!ok, name: U.trim(x.name || x.title || x.label || ''), manual: !!x.manual,
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
      const a = byId[x.id] || (byId[x.id] = { ok: true, n: 0, notRun: 0, parts: [], manual: false });
      a.n += 1;
      if (x.manual) a.manual = true;
      if (x.ok === null) a.notRun += 1;
      else if (!x.ok) a.ok = false;
      if (x.name || x.message) a.parts.push([x.name, x.message].filter(Boolean).join(': '));
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
    // the record button sits under the result (2nd column) so it is on screen at phone width without side-scrolling
    const cols = [
      { label: 'เกณฑ์ผ่าน', w: '38%', render: (r) => t`${h.code(r.id)}${r.custom ? t` <small class="muted">เกณฑ์เพิ่ม</small>` : ''}<br>${r.criterion}` },
      { label: 'ผลรับงาน', render: (r) => t`${statusBadge(r.status)}${can ? t`<br>${h.btn('บันทึกผล', { act: 'record', arg: r.id, tone: r.status === 'PASS' ? 'ghost' : 'primary', small: true })}` : ''}${r.retests ? t`<br>${h.btn(`ผลก่อนหน้า ${r.retests}`, { act: 'history', arg: r.id, tone: 'quiet', small: true })}` : ''}` },
      // tester, date, evidence and what was found in one column: the criterion text keeps its width on a phone
      { label: 'ผู้ทดสอบ / หลักฐาน', render: (r) => (r.tester || r.evidence || r.note
        ? t`${r.tester ? t`${ctx.userName(r.tester)} <small class="muted">${h.fmt.date(r.testedOn)}</small>` : ''}${r.evidence ? t`<br>${r.evidence}` : ''}${r.note ? t`<br><small class="muted">${r.note}</small>` : ''}`
        : dash) },
    ];
    if (hasAuto) {
      cols.push({ label: 'ตรวจอัตโนมัติ (ข้อมูลทดสอบ)', render: (r) => {
        const a = auto.byId[r.id];
        return t`${autoBadge(a)}${a && a.manual ? t` ${h.badge('ต้องให้คนยอมรับ', 'muted')}` : ''}${a && a.parts.length ? t`<br><small class="muted">${a.parts.slice(0, 3).join(' | ')}</small>` : ''}`;
      } });
    }
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

  // ---- sign-off (uat.signoff): store / QC / accounting accept the balances and procedures (criterion P6-2) -------------
  // one person per area (the engine refuses one person accepting for two areas); the latest entry of an area counts.
  const AREAS = () => R().SIGNOFF_AREAS || {};
  const REQUIRED = () => R().REQUIRED_SIGNOFFS || ['store', 'qc', 'accounting'];
  const DECISION = { ACCEPT: ['ยอมรับ', 'ok'], REJECT: ['ไม่ยอมรับ', 'bad'] };
  const decisionBadge = (d) => (DECISION[d] ? h.badge(DECISION[d][0], DECISION[d][1]) : h.badge('ยังไม่ลงนาม', 'warn'));
  const areaRoles = (a) => a.roles.map((r) => RRS.auth.ROLES[r] || r).join(' / ');
  function signoffs(state) {
    return RRS.q.rows(state, 'uat_signoffs').sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(b.id).localeCompare(String(a.id)));
  }
  function latestOf(state) {
    const out = {};
    for (const s of signoffs(state)) if (!out[s.area]) out[s.area] = s;
    return out;
  }
  /** The role of the current user that may sign for this area (null: cannot). */
  function signRole(ctx, area) {
    const a = AREAS()[area];
    const roles = (ctx.user && ctx.user.roles) || [];
    return a && ctx.can('uat.signoff') ? a.roles.find((r) => roles.indexOf(r) >= 0) || null : null;
  }
  function signoffState(state) {
    const latest = latestOf(state);
    const req = REQUIRED();
    const accepted = req.filter((a) => latest[a] && latest[a].decision === 'ACCEPT');
    const signers = accepted.map((a) => latest[a].by);
    return { latest, req, accepted, distinct: new Set(signers).size === signers.length };
  }
  function signoffView(ctx, all) {
    const S = signoffState(ctx.state);
    const areas = AREAS();
    const chk = R().dailyCheck(ctx.state);
    const me = ctx.user ? ctx.user.id : '';
    const missing = S.req.filter((a) => S.accepted.indexOf(a) < 0).map((a) => (areas[a] || {}).label || a);
    const head = !missing.length && S.distinct
      ? h.note(t`<b>สโตร์ QC และบัญชียอมรับครบแล้ว</b> – ใช้เป็นหลักฐานของเกณฑ์ P6-2 (บันทึกผลที่แท็บ เกณฑ์ทดสอบ)`, 'ok')
      : h.note(t`<b>ยอมรับแล้ว ${S.accepted.length} จาก ${S.req.length} ฝ่าย</b>${missing.length ? ` – ยังไม่ยอมรับ: ${missing.join(', ')}` : ''}${S.distinct ? '' : ' · คนเดียวลงนามหลายฝ่าย ต้องให้คนของฝ่ายนั้นลงนามใหม่'}`, 'warn');
    const integrity = chk.ok
      ? h.note('ตรวจยอดประจำวันตอนนี้: ผ่าน – ลงนามยอมรับได้', 'ok')
      : h.note(t`ตรวจยอดประจำวันตอนนี้: พบปัญหา ${h.fmt.num(chk.problems.length)} ข้อ – ยังยอมรับยอดไม่ได้จนกว่าจะแก้ (ลงนามไม่ยอมรับพร้อมเหตุผลได้)${RRS.ui.pages.reports ? t` · ${h.link('ดูผลตรวจยอด', 'reports', { tab: 'dailyCheck' })}` : ''}`, 'bad');
    const rows = Object.keys(areas).map((area) => ({ area, a: areas[area], s: S.latest[area] || null, required: S.req.indexOf(area) >= 0 }));
    const tbl = h.table({ id: 'uat-sign', rows, rowCls: (x) => (x.s && x.s.decision === 'REJECT' ? 'row-bad' : ''), cols: [
      { label: 'ฝ่าย', render: (x) => t`<b>${x.a.label}</b> ${x.required ? '' : h.badge('ไม่บังคับ', 'muted')}<br><small class="muted">ผู้ลงนาม: ${areaRoles(x.a)}</small>` },
      { label: 'ผลล่าสุด', render: (x) => {
        const role = signRole(ctx, x.area);
        const other = role && Object.keys(S.latest).find((o) => o !== x.area && S.latest[o].decision === 'ACCEPT' && S.latest[o].by === me);
        return t`${decisionBadge(x.s && x.s.decision)}${role ? t`<br>${h.btn(x.s ? 'ลงนามใหม่' : 'ลงนาม', { act: 'sign', arg: x.area, tone: x.s && x.s.decision === 'ACCEPT' ? 'ghost' : 'primary', small: true })}` : ''}${other ? t`<br><small class="muted">คุณยอมรับฝ่าย${areas[other].label}แล้ว – ยอมรับฝ่ายนี้ต้องเป็นคนอื่น</small>` : ''}`;
      } },
      { label: 'ผู้ลงนาม / เมื่อ', render: (x) => (x.s ? t`${ctx.userName(x.s.by)}<br><small class="muted">${h.fmt.dt(x.s.at)}</small>` : dash) },
      { label: 'ตอนลงนาม', render: (x) => (x.s ? t`ข้อมูลถึงลำดับ ${h.fmt.num(x.s.seq)}${x.s.uat ? t`<br><small class="muted">UAT ผ่าน ${h.fmt.num(x.s.uat.pass)} จาก ${h.fmt.num(x.s.uat.total)}</small>` : ''}` : dash) },
      { label: 'ความเห็น / เงื่อนไข', render: (x) => (x.s && x.s.note ? x.s.note : dash) },
    ] });
    const log = signoffs(ctx.state);
    const logTbl = h.table({ dense: true, scroll: true, rows: log, id: 'uat-sign-log', empty: 'ยังไม่มีการลงนาม',
      emptyText: 'เมื่อทดสอบกับงานจริงจนพอใจแล้ว หัวหน้าสโตร์ หัวหน้า QC และบัญชี กด ลงนาม ที่ฝ่ายของตัวเอง',
      rowCls: (x) => (x.decision === 'REJECT' ? 'row-bad' : ''), cols: [
        { label: 'รหัส', render: (x) => h.code(x.id) }, { label: 'ฝ่าย', get: (x) => (areas[x.area] || {}).label || x.area },
        { label: 'ผล', render: (x) => decisionBadge(x.decision) }, { label: 'ผู้ลงนาม', get: (x) => ctx.userName(x.by) },
        { label: 'เมื่อ', get: (x) => h.fmt.dt(x.at) }, { label: 'ข้อมูลถึงลำดับ', num: true, key: 'seq' },
        { label: 'UAT ผ่าน', get: (x) => (x.uat ? `${x.uat.pass}/${x.uat.total}` : '') }, { label: 'ความเห็น', get: (x) => x.note || '' }] });
    const canAny = Object.keys(areas).some((a) => signRole(ctx, a));
    const who = canAny ? '' : h.note(`ลงนามได้เฉพาะผู้มีบทบาทของฝ่ายนั้น: ${Object.keys(areas).map((a) => `${areas[a].label} = ${areaRoles(areas[a])}`).join(' · ')} – คุณดูผลได้อย่างเดียว`, 'info');
    const T = all.totals;
    return t`${head}${integrity}${who}
      ${h.section('การยอมรับยอดและขั้นตอนของแต่ละฝ่าย', tbl, { sub: `ผล UAT ตอนนี้: ผ่าน ${T.pass} · ไม่ผ่าน ${T.fail} · ยังไม่ทดสอบ ${T.notRun} จาก ${T.total} เกณฑ์ – ระบบเก็บตัวเลขนี้ไว้กับการลงนาม` })}
      ${h.section('ประวัติการลงนาม', logTbl, { sub: 'ไม่ลบ – ลงนามใหม่ได้ ผลล่าสุดของฝ่ายใช้ตัดสิน' })}`;
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
      const hasSignoff = !!(RRS.commands.defs['uat.signoff'] && R().SIGNOFF_AREAS);
      const tab = hasSignoff && v.tab === 'signoff' ? 'signoff' : 'criteria';
      const S = hasSignoff ? signoffState(ctx.state) : null;
      const tabs = hasSignoff ? h.tabs([{ id: 'criteria', label: 'เกณฑ์ทดสอบ', count: T.total },
        { id: 'signoff', label: 'ลงนามยอมรับของฝ่าย', count: `${S.accepted.length}/${S.req.length}` }], tab) : '';
      if (tab === 'signoff') return t`${k}${overall}${tabs}${signoffView(ctx, all)}`;
      // automatic checks
      const hasSelftest = !!(RRS.selftest && typeof RRS.selftest.run === 'function');
      let autoBox;
      if (!hasSelftest) {
        autoBox = h.note('ชุดตรวจอัตโนมัติยังไม่ได้ติดตั้งในหน้านี้ – บันทึกผลจากการทดสอบจริงได้ตามปกติ', 'info');
      } else if (auto.running) {
        autoBox = t`${h.meter(auto.of ? auto.done / auto.of : 0, auto.of ? `กำลังตรวจ ${auto.done} จาก ${auto.of} เกณฑ์ บนข้อมูลทดสอบแยกต่างหาก (ไม่แตะข้อมูลในหน้านี้)…` : 'กำลังเตรียมข้อมูลทดสอบ…')}`;
      } else if (auto.error) {
        autoBox = h.note(`รันทดสอบอัตโนมัติไม่สำเร็จ: ${auto.error} – ลองอีกครั้ง ถ้ายังไม่ได้ให้แจ้งผู้ดูแลระบบ (ผลรับงานไม่ได้รับผลกระทบ)`, 'bad');
      } else if (auto.at) {
        autoBox = h.note(t`รันเมื่อ ${h.fmt.dt(auto.at)}${auto.ms ? ` (${h.fmt.num(auto.ms / 1000, 1)} วินาที)` : ''}: ผ่าน ${auto.pass} · ไม่ผ่าน ${auto.fail}${auto.notRun ? ` · ไม่ได้รัน ${auto.notRun}` : ''} จาก ${auto.total} รายการ – ดูผลในคอลัมน์ ตรวจอัตโนมัติ ของแต่ละเกณฑ์`, auto.fail ? 'warn' : 'ok');
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
      return t`${k}${overall}${tabs}${who}${none}${autoSec}${h.toolbar(left, right)}${sections}`;
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg }),
      async sign(ctx, el) {
        const area = el.dataset.arg;
        const a = AREAS()[area];
        if (!a || !ctx.user) return;
        if (!signRole(ctx, area)) return ctx.toast(`ลงนามฝ่าย${a.label}ได้เฉพาะ ${areaRoles(a)}`, 'warn');
        const chk = R().dailyCheck(ctx.state);
        const T = summary(ctx).totals;
        await ctx.dialog({
          title: `ลงนามฝ่าย${a.label}`, submit: 'บันทึกการลงนาม', wide: true,
          body: t`<div class="wide">${h.dl([['ฝ่าย', a.label], ['ผู้ลงนาม', `${ctx.user.name} (ระบบบันทึกให้)`], ['เวลา', 'ระบบบันทึกให้'],
            ['ผล UAT ตอนนี้', `ผ่าน ${T.pass} · ไม่ผ่าน ${T.fail} · ยังไม่ทดสอบ ${T.notRun} จาก ${T.total}`],
            ['ตรวจยอดประจำวัน', chk.ok ? h.badge('ผ่าน', 'ok') : h.badge(`พบปัญหา ${chk.problems.length} ข้อ`, 'bad')]])}</div>
            ${chk.ok ? '' : t`<div class="wide">${h.note('ตอนนี้ตรวจยอดไม่ผ่าน – ระบบจะไม่รับการยอมรับ ลงนามไม่ยอมรับพร้อมเหตุผลได้', 'bad')}</div>`}
            ${h.field({ name: 'decision', label: 'ผลการลงนาม', type: 'radio', wide: true, id: 'sg-decision',
              options: [['ACCEPT', 'ยอมรับยอดและขั้นตอน'], ['REJECT', 'ไม่ยอมรับ']] })}
            ${h.field({ name: 'note', label: 'ความเห็น / เงื่อนไข', type: 'textarea', rows: 3, wide: true, id: 'sg-note',
              placeholder: 'เช่น ยอดคลัง A/B ตรงกับนับจริงวันที่ … / ยังไม่ยอมรับเพราะ …', hint: 'ไม่ยอมรับต้องบอกเหตุผล เพื่อให้แก้แล้วลงนามใหม่' })}
            <p class="hint wide">ระบบเก็บลำดับข้อมูลและผล UAT ตอนนี้ไว้กับการลงนาม · คนเดียวยอมรับแทนหลายฝ่ายไม่ได้ · ลงนามใหม่ได้ ผลล่าสุดของฝ่ายใช้ตัดสิน</p>`,
          onSubmit(vals) {
            if (!vals.decision) return { ok: false, errors: [{ message: 'เลือกผล: ยอมรับยอดและขั้นตอน หรือ ไม่ยอมรับ' }] };
            return ctx.exec('uat.signoff', { area, decision: vals.decision, note: vals.note },
              { quiet: true, done: `ฝ่าย${a.label}${vals.decision === 'ACCEPT' ? 'ยอมรับ' : 'ไม่ยอมรับ'}แล้ว` });
          },
        });
      },
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
        auto.done = 0;
        auto.of = 0;
        ctx.set({});
        await new Promise((res) => setTimeout(res, 30)); // let the "running" state paint first
        const t0 = Date.now();
        try {
          let last = 0;
          const out = await RRS.selftest.run({ onProgress(p) {
            auto.done = Number(p && p.done) || 0;
            auto.of = Number(p && p.total) || 0;
            const now = Date.now();
            if (now - last > 250 || auto.done === auto.of) { // repaint the progress, not on every criterion
              last = now;
              if (RRS.app && RRS.app.page === 'uat' && !root.document.querySelector('#dlg:not([hidden])')) ctx.set({});
            }
          } });
          const list = normalize(out);
          const c = collect(list);
          auto.byId = c.byId;
          auto.extra = c.extra;
          auto.total = list.length;
          auto.pass = list.filter((x) => x.ok === true).length;
          auto.fail = list.filter((x) => x.ok === false).length;
          auto.notRun = list.filter((x) => x.ok === null).length;
          auto.at = new Date().toISOString();
          auto.ms = Date.now() - t0;
          if (!list.length) auto.error = 'ชุดตรวจไม่ส่งผลกลับมา';
        } catch (e) {
          if (root.console) root.console.error(e);
          auto.error = (e && e.message) || String(e);
        }
        auto.running = false;
        if (RRS.app && RRS.app.page === 'uat') ctx.set({});
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
            if (!id) return { ok: false, errors: [{ message: 'ใส่รหัสเกณฑ์ เช่น P2-X1' }] };
            if (summary(ctx).rows.some((r) => r.id === id)) return { ok: false, errors: [{ message: `มีเกณฑ์ ${id} แล้ว – กด บันทึกผล ที่แถวนั้นแทน หรือใช้รหัสอื่น` }] };
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
