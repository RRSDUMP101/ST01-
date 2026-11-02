/*
 * Phase 6 – ทดลองใช้และขยายผล (engine: RRS.reports – pilot.issue, pilot.resolveIssue, rollout.propose / approve / reject /
 * rollback, rolloutReadiness).
 *   ปัญหาจากการทดลอง   problems found while piloting, by severity; an open CRITICAL problem blocks every rollout, and
 *                      it is closed by someone other than the person who reported it
 *   แผนขยายผล         one group of items / warehouses at a time, with an owner, a team, a rollback plan and the phases whose
 *                      UAT must pass; the readiness checks (backup test, integrity, UAT, sign-offs, training …) come from
 *                      the engine and are shown before a manager – not the proposer – approves; an approved plan can be
 *                      rolled back, which removes only the scope it added to the pilot
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const U = RRS.util;
  const R = () => RRS.reports || null;

  const SEV_TONE = { CRITICAL: 'bad', MAJOR: 'warn', MINOR: 'muted' };
  const RO_TONE = { PROPOSED: 'warn', APPROVED: 'ok', REJECTED: 'muted', ROLLED_BACK: 'bad' };
  const sevBadge = (s) => h.badge(((R().SEVERITY || {})[s] || s).replace(/ \(.*\)$/, ''), SEV_TONE[s] || 'muted');
  const roBadge = (s) => h.badge((R().ROLLOUT_STATUS || {})[s] || s, RO_TONE[s] || 'muted');
  const me = (ctx) => (ctx.user ? ctx.user.id : '');
  const who = (ctx, id, at) => (id ? t`${ctx.userName(id)}${at ? t` <small class="muted">${h.fmt.dt(at)}</small>` : ''}` : '–');
  const byNewest = (a, b) => String(b.reportedAt || b.proposedAt || '').localeCompare(String(a.reportedAt || a.proposedAt || '')) || String(b.id).localeCompare(String(a.id));

  function settingsOf(state) {
    const d = RRS.defaultSettings();
    const s = RRS.q.get(state, 'settings', 'main') || {};
    return Object.assign({}, d, s, { pilot: Object.assign({}, d.pilot, s.pilot) });
  }
  /** Separation of duties is on unless the owner turned it off (policies.sod = false) – the engine applies the same rule. */
  const sodOn = (state) => (((RRS.q.get(state, 'settings', 'main') || {}).policies) || {}).sod !== false;
  const groupsOf = (state) => Array.from(new Set(RRS.q.rows(state, 'items', (i) => i.active !== false && U.trim(i.group)).map((i) => U.trim(i.group)))).sort();
  const scopeText = (r) => [].concat((r.groups || []).map((g) => 'กลุ่ม ' + g), (r.warehouses || []).map((w) => 'คลัง ' + w)).join(', ') || '–';

  // ---- pilot issues -------------------------------------------------------------------------------------------
  function issuesView(ctx) {
    const v = ctx.view;
    const all = RRS.q.rows(ctx.state, 'pilot_issues').sort(byNewest);
    const st = v.ist || 'OPEN';
    const rows = all.filter((x) => (st === 'all' || x.status === st) && (!v.isev || x.severity === v.isev));
    const can = ctx.can('uat.record');
    const crit = all.filter((x) => x.status === 'OPEN' && x.severity === 'CRITICAL').length;
    const k = h.kpis([
      h.kpi('ปัญหาร้ายแรงที่เปิดอยู่', h.fmt.num(crit), crit ? 'ขยายผลไม่ได้จนกว่าจะปิดครบ' : 'ไม่มี – ไม่บล็อกการขยายผล', crit ? 'bad' : 'ok'),
      h.kpi('เปิดอยู่ทั้งหมด', h.fmt.num(all.filter((x) => x.status === 'OPEN').length), 'ทุกระดับความรุนแรง'),
      h.kpi('ปิดแล้ว', h.fmt.num(all.filter((x) => x.status === 'RESOLVED').length), 'พร้อมวิธีแก้'),
    ]);
    const tbl = h.table({ id: 'pi-list', scroll: true, rows,
      empty: all.length ? 'ไม่พบปัญหาตามตัวกรอง' : 'ยังไม่มีปัญหาที่แจ้ง',
      emptyText: all.length ? 'ลองเปลี่ยนตัวกรอง' : 'ระหว่างทดลองใช้ ถ้าพบยอดผิด ขั้นตอนติดขัด หรือหน้าจอทำงานผิด ให้แจ้งที่นี่',
      cols: [
        { label: 'รหัส', render: (x) => h.code(x.id) },
        { label: 'ความรุนแรง', render: (x) => sevBadge(x.severity) },
        { label: 'ขั้นตอน/หน้าจอ', get: (x) => x.area || '–' },
        { label: 'รายละเอียด', render: (x) => t`${x.description}${x.ref ? t`<br><small class="muted">อ้างอิง ${x.ref}</small>` : ''}${x.resolution ? t`<br><small class="muted">แก้: ${x.resolution}</small>` : ''}` },
        { label: 'แจ้งโดย', render: (x) => who(ctx, x.reportedBy, x.reportedAt) },
        { label: 'สถานะ', render: (x) => (x.status === 'OPEN' ? h.badge('เปิดอยู่', 'warn') : t`${h.badge('ปิดแล้ว', 'ok')}<br><small class="muted">${ctx.userName(x.resolvedBy)}</small>`) },
        { label: '', render: (x) => {
          if (x.status !== 'OPEN' || !can) return '';
          if (x.severity === 'CRITICAL' && x.reportedBy === me(ctx) && sodOn(ctx.state)) return t`<small class="muted">ปัญหาร้ายแรง – ให้คนอื่นปิด</small>`;
          return h.btn('ปิดปัญหา', { act: 'resolve', arg: x.id, small: true });
        } },
      ] });
    const sevOpts = Object.keys(R().SEVERITY).map((s) => [s, R().SEVERITY[s]]);
    return t`${k}${h.toolbar([
      h.field({ name: 'ist', label: 'สถานะ', type: 'select', value: st, options: [['OPEN', 'เปิดอยู่'], ['RESOLVED', 'ปิดแล้ว'], ['all', 'ทั้งหมด']], id: 'pi-st', act: 'filter' }),
      h.field({ name: 'isev', label: 'ความรุนแรง', type: 'select', value: v.isev, options: sevOpts, blank: 'ทุกระดับ', id: 'pi-sev', act: 'filter' }),
    ], can ? h.btn('+ แจ้งปัญหา', { act: 'newIssue', tone: 'primary', id: 'pi-new' }) : '')}<div>${tbl}</div>`;
  }

  // ---- rollout plans ------------------------------------------------------------------------------------------
  function readiness(ctx, r) {
    return R().rolloutReadiness(ctx.state, { rollout: r, today: ctx.today });
  }
  function plansView(ctx) {
    const v = ctx.view;
    const all = RRS.q.rows(ctx.state, 'rollouts').sort(byNewest);
    const tbl = h.table({ id: 'ro-list', scroll: true, rows: all, rowAct: 'pick', rowArg: (r) => r.id, rowCls: (r) => (r.id === v.sel ? 'sel' : ''),
      empty: 'ยังไม่มีแผนขยายผล',
      emptyText: 'เมื่อทดลองกลุ่มแรกผ่านแล้ว เสนอขยายทีละกลุ่มสินค้า/คลัง พร้อมผู้รับผิดชอบและแผนย้อนกลับ',
      cols: [
        { label: 'รหัส', render: (r) => h.code(r.id) }, { label: 'ชื่อแผน', get: (r) => r.title },
        { label: 'ขอบเขต', get: (r) => scopeText(r) }, { label: 'ผู้รับผิดชอบ', get: (r) => ctx.userName(r.owner) },
        { label: 'สถานะ', render: (r) => roBadge(r.status) }, { label: 'เสนอโดย', render: (r) => who(ctx, r.proposedBy, r.proposedAt) },
      ] });
    const sel = v.sel ? RRS.q.get(ctx.state, 'rollouts', v.sel) : null;
    const add = ctx.can('rollout.propose') ? h.btn('+ เสนอแผนขยายผล', { act: 'newPlan', tone: 'primary', id: 'ro-new' }) : '';
    return t`${sel ? planDetail(ctx, sel) : ''}${h.section('แผนขยายผล', t`<div>${tbl}</div>`, { actions: add,
      sub: 'คลิกแถวเพื่อดูความพร้อม อนุมัติ ไม่อนุมัติ หรือย้อนกลับ' })}`;
  }
  function planDetail(ctx, r) {
    const ready = r.status === 'PROPOSED' ? readiness(ctx, r) : null;
    const acts = [];
    const notes = [];
    if (r.status === 'PROPOSED') {
      if (ctx.can('rollout.approve')) {
        // the engine decides: readiness, and the proposer only when separation of duties is on
        const chk = ctx.check('rollout.approve', { id: r.id });
        const self = !chk.ok && chk.errors.some((e) => e.code === 'SAME_PERSON');
        acts.push(h.btn('อนุมัติขยายผล', { act: 'approve', tone: 'primary', disabled: !chk.ok, id: 'ro-approve',
          title: chk.ok ? 'เพิ่มขอบเขตนี้เข้าการทดลอง' : self ? 'ผู้เสนออนุมัติเองไม่ได้' : (chk.errors[0] || {}).message || 'ยังไม่ผ่านเงื่อนไขที่จำเป็น' }));
        acts.push(h.btn('ไม่อนุมัติ', { act: 'reject', tone: 'ghost', id: 'ro-reject' }));
        if (self) notes.push(h.note('คุณเป็นผู้เสนอแผนนี้ – ต้องให้ผู้จัดการคนอื่นอนุมัติ (แยกหน้าที่)', 'info'));
      } else notes.push(h.note('รอผู้จัดการ (ที่ไม่ใช่ผู้เสนอ) อนุมัติ', 'info'));
      notes.push(ready.ok ? h.note('ผ่านเงื่อนไขที่จำเป็นครบ – อนุมัติได้', 'ok')
        : h.note(t`ยังขยายผลไม่ได้:${h.errors({ errors: ready.problems.map((p) => ({ message: p })) })}`, 'warn'));
    }
    if (r.status === 'APPROVED' && ctx.can('rollout.approve')) acts.push(h.btn('ย้อนกลับการขยายผล', { act: 'rollback', tone: 'danger', id: 'ro-rollback' }));
    // the snapshot kept at approval has ids only: labels and which checks are required come from the engine's list
    const meta = {};
    if (!ready) for (const c of readiness(ctx, r).checks) meta[c.id] = c;
    const checks = ready ? ready.checks : (r.readiness || []).map((c) => {
      const m = meta[c.id] || {};
      const required = m.required !== false;
      return { label: m.label || c.id, ok: c.ok, okLabel: c.ok ? 'ผ่าน' : required ? 'ไม่ผ่าน' : 'ควรแก้', detail: c.detail, required };
    });
    const added = r.added ? [].concat((r.added.groups || []).map((g) => 'กลุ่ม ' + g), (r.added.warehouses || []).map((w) => 'คลัง ' + w)).join(', ') : '';
    return h.section(t`${h.code(r.id)} ${r.title}`, t`${notes}
      ${h.dl([
        ['สถานะ', roBadge(r.status)], ['ขอบเขต', scopeText(r)], ['ผู้รับผิดชอบ', ctx.userName(r.owner)],
        ['ทีม', (r.team || []).map((u) => ctx.userName(u)).join(', ')], ['Phase ที่ต้องผ่าน UAT', (r.phases || []).join(', ')],
        ['แผนย้อนกลับ', r.rollbackPlan], ['เสนอ', who(ctx, r.proposedBy, r.proposedAt)],
        r.approvedBy ? ['อนุมัติ', t`${who(ctx, r.approvedBy, r.approvedAt)}${r.added ? t` · เพิ่มเข้าทดลอง: ${added || 'อยู่ในขอบเขตแล้ว'}` : ''}`] : null,
        r.rejectedBy ? ['ไม่อนุมัติ', t`${who(ctx, r.rejectedBy, r.rejectedAt)} · ${r.rejectReason}`] : null,
        r.rolledBackBy ? ['ย้อนกลับ', t`${who(ctx, r.rolledBackBy, r.rolledBackAt)} · ${r.rollbackReason}`] : null,
      ])}
      <h3>${ready ? 'ความพร้อม (ตรวจตอนนี้)' : 'ความพร้อมตอนอนุมัติ'}</h3>
      ${checks.length ? h.table({ dense: true, rows: checks, rowCls: (c) => (c.ok ? '' : c.required ? 'row-bad' : 'row-warn'), cols: [
        { label: 'เงื่อนไข', get: (c) => c.label }, { label: 'ผล', render: (c) => h.badge(c.okLabel, c.ok ? 'ok' : c.required ? 'bad' : 'warn') },
        { label: 'รายละเอียด', get: (c) => c.detail || '' }] }) : t`<p class="hint">ไม่มีข้อมูล</p>`}
      ${acts.length ? t`<div class="form-actions">${acts}</div>` : ''}`, {
      id: 'ro-detail', actions: h.btn('ปิด', { act: 'close', tone: 'quiet', small: true }) });
  }

  RRS.ui.page({
    id: 'rollout', title: 'ทดลองใช้และขยายผล', phase: 6, order: 35,
    sub: 'แจ้งและปิดปัญหาจากการทดลอง · เสนอขยายทีละกลุ่มสินค้า/คลัง · ระบบตรวจความพร้อม (สำรองข้อมูล UAT การยอมรับ การอบรม) ก่อนผู้จัดการอนุมัติ',
    badge: (ctx) => (R() ? RRS.q.rows(ctx.state, 'pilot_issues', (x) => x.status === 'OPEN' && x.severity === 'CRITICAL').length || '' : ''),
    render(ctx) {
      if (!R() || typeof R().rolloutReadiness !== 'function') return h.empty('ยังเปิดหน้านี้ไม่ได้', 'หน้านี้ต้องใช้โมดูลรายงาน (reports) ซึ่งยังไม่ได้โหลด');
      const v = ctx.view;
      const tab = v.tab === 'plans' ? 'plans' : 'issues';
      const st = settingsOf(ctx.state);
      const scope = [].concat((st.pilot.groups || []).map((g) => 'กลุ่ม ' + g), (st.pilot.warehouses || []).map((w) => 'คลัง ' + w));
      const scopeNote = h.note(scope.length ? t`ขอบเขตทดลองตอนนี้: <b>${scope.join(', ')}</b>` : 'ยังไม่ได้กำหนดขอบเขตทดลอง – กำหนดที่หน้า ตั้งค่า (แท็บขอบเขต) หรืออนุมัติแผนขยายผล', scope.length ? 'info' : 'warn');
      const openN = RRS.q.rows(ctx.state, 'pilot_issues', (x) => x.status === 'OPEN').length;
      const propN = RRS.q.rows(ctx.state, 'rollouts', (x) => x.status === 'PROPOSED').length;
      return t`${scopeNote}${h.tabs([{ id: 'issues', label: 'ปัญหาจากการทดลอง', count: openN || null }, { id: 'plans', label: 'แผนขยายผล', count: propN || null }], tab)}
        ${tab === 'plans' ? plansView(ctx) : issuesView(ctx)}`;
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg, sel: null }),
      filter: (ctx, el) => ctx.set({ [el.name]: el.value }),
      pick: (ctx, el) => ctx.set({ sel: el.dataset.arg }),
      close: (ctx) => ctx.set({ sel: null }),
      async newIssue(ctx) {
        await ctx.dialog({
          title: 'แจ้งปัญหาจากการทดลอง', submit: 'บันทึกปัญหา', wide: true,
          body: t`${h.field({ name: 'severity', label: 'ความรุนแรง', type: 'radio', value: 'MAJOR', wide: true, required: true, options: Object.keys(R().SEVERITY).map((s) => [s, R().SEVERITY[s]]) })}
            ${h.field({ name: 'area', label: 'ขั้นตอน/หน้าจอ', id: 'pi-area', placeholder: 'เช่น เบิกของตามใบงาน' })}
            ${h.field({ name: 'ref', label: 'เอกสารอ้างอิง', id: 'pi-ref', placeholder: 'เลขที่เอกสาร/ใบงาน (ถ้ามี)' })}
            ${h.field({ name: 'description', label: 'รายละเอียด', type: 'textarea', required: true, wide: true, id: 'pi-desc', placeholder: 'เกิดอะไร คาดว่าควรเป็นอย่างไร ทำซ้ำได้อย่างไร' })}`,
          onSubmit: (vals) => ctx.exec('pilot.issue', { severity: vals.severity, area: vals.area, ref: vals.ref, description: vals.description },
            { quiet: true, done: (r) => `บันทึกปัญหา ${r.result.id} แล้ว` }),
        });
      },
      async resolve(ctx, el) {
        const x = RRS.q.get(ctx.state, 'pilot_issues', el.dataset.arg);
        if (!x) return;
        await ctx.dialog({
          title: `ปิดปัญหา ${x.id}`, submit: 'ปิดปัญหา', message: x.description,
          body: h.field({ name: 'resolution', label: 'วิธีแก้ / ผลตรวจซ้ำ', type: 'textarea', required: true, wide: true, id: 'pi-res' }),
          onSubmit: (vals) => ctx.exec('pilot.resolveIssue', { id: x.id, resolution: vals.resolution }, { quiet: true, done: `ปิดปัญหา ${x.id} แล้ว` }),
        });
      },
      async newPlan(ctx) {
        const groups = groupsOf(ctx.state);
        const users = h.userOptions(ctx.state);
        const res = await ctx.dialog({
          title: 'เสนอแผนขยายผล', submit: 'เสนอแผน', wide: true,
          message: 'ขยายทีละกลุ่มสินค้าหรือคลัง · ผู้จัดการที่ไม่ใช่ผู้เสนอเป็นผู้อนุมัติ หลังผ่านเงื่อนไขความพร้อม',
          body: t`${h.field({ name: 'title', label: 'ชื่อแผน', wide: true, id: 'ro-title', placeholder: 'เช่น ขยายไปกลุ่มโครงหลังคา คลัง B' })}
            ${groups.length ? h.field({ name: 'groups', label: 'กลุ่มสินค้าที่ขยาย', type: 'multiselect', options: groups, wide: true, id: 'ro-groups' })
              : t`<p class="hint wide">ยังไม่มีกลุ่มสินค้าในทะเบียน – ขยายตามคลังได้</p>`}
            ${h.field({ name: 'warehouses', label: 'คลังที่ขยาย', type: 'multiselect', options: h.whOptions(ctx.state), wide: true, id: 'ro-whs' })}
            ${h.field({ name: 'owner', label: 'ผู้รับผิดชอบ', type: 'select', options: users, blank: 'เลือกผู้ใช้', required: true, id: 'ro-owner' })}
            ${h.field({ name: 'team', label: 'ผู้ใช้งานในขอบเขต (ทีม)', type: 'multiselect', options: users, wide: true, id: 'ro-team' })}
            ${h.field({ name: 'phases', label: 'Phase ที่ต้องผ่าน UAT', type: 'multiselect', options: [0, 1, 2, 3, 4, 5, 6].map((p) => [String(p), `Phase ${p}`]), value: ['0', '1', '2', '3', '4', '5', '6'], wide: true, id: 'ro-phases' })}
            ${h.field({ name: 'rollbackPlan', label: 'แผนย้อนกลับ', type: 'textarea', required: true, wide: true, id: 'ro-rollback-plan',
              placeholder: 'ปิดขอบเขตนี้ กู้ข้อมูลจากชุดสำรองล่าสุด เอกสารที่ต้องคีย์ซ้ำใน Express ผู้ตัดสินใจ' })}`,
          onSubmit: (vals) => ctx.exec('rollout.propose', { title: vals.title, groups: vals.groups || [], warehouses: vals.warehouses || [], owner: vals.owner,
            team: vals.team || [], phases: (vals.phases || []).map(Number), rollbackPlan: vals.rollbackPlan },
          { quiet: true, done: (r) => `เสนอแผน ${r.result.id} แล้ว – รอผู้จัดการอนุมัติ` }),
        });
        if (res && res.ok) ctx.set({ tab: 'plans', sel: (res.result && res.result.id) || null });
      },
      async approve(ctx) {
        const r = RRS.q.get(ctx.state, 'rollouts', ctx.view.sel);
        if (!r) return;
        const ok = await ctx.confirm({ title: `อนุมัติขยายผล ${r.id}`, ok: 'อนุมัติ',
          message: `${scopeText(r)} จะเข้าขอบเขตทดลอง – ทีมเริ่มใช้ระบบกับกลุ่มนี้ได้ ถ้ามีปัญหาย้อนกลับได้ตามแผนย้อนกลับ` });
        if (!ok) return;
        await ctx.exec('rollout.approve', { id: r.id }, { done: `อนุมัติขยายผล ${r.id} แล้ว` });
      },
      async reject(ctx) {
        const r = RRS.q.get(ctx.state, 'rollouts', ctx.view.sel);
        if (!r) return;
        await ctx.dialog({ title: `ไม่อนุมัติ ${r.id}`, submit: 'ไม่อนุมัติ', danger: true,
          body: h.field({ name: 'reason', label: 'เหตุผล', type: 'textarea', required: true, wide: true, id: 'ro-reject-reason' }),
          onSubmit: (vals) => ctx.exec('rollout.reject', { id: r.id, reason: vals.reason }, { quiet: true, done: `ไม่อนุมัติ ${r.id}` }) });
      },
      async rollback(ctx) {
        const r = RRS.q.get(ctx.state, 'rollouts', ctx.view.sel);
        if (!r) return;
        await ctx.dialog({ title: `ย้อนกลับการขยายผล ${r.id}`, submit: 'ย้อนกลับ', danger: true,
          message: 'ถอดเฉพาะขอบเขตที่แผนนี้เพิ่มออกจากการทดลอง (ขอบเขตเดิมและที่แผนอื่นดูแลยังอยู่) · ยอดและเอกสารที่บันทึกแล้วไม่ถูกลบ',
          body: h.field({ name: 'reason', label: 'เหตุผล', type: 'textarea', required: true, wide: true, id: 'ro-rollback-reason' }),
          onSubmit: (vals) => ctx.exec('rollout.rollback', { id: r.id, reason: vals.reason }, { quiet: true, done: `ย้อนกลับ ${r.id} แล้ว` }) });
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
