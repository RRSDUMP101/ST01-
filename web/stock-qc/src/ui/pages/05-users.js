/*
 * Phase 0 – users, roles and permissions: users table + editor (user.upsert), pending access requests (approve =
 * open the editor prefilled with the request), and a role × permission matrix built from RRS.auth.PERMS.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const A = RRS.auth;

  const GROUPS = ['ระบบ', 'ข้อมูลหลัก', 'รับ–จ่าย–โอน', 'ผลิตและจอง', 'Express และตรวจนับ', 'จัดซื้อ', 'คุณภาพ', 'รายงานและขยายผล', 'อื่น ๆ'];
  const PERM_INFO = {
    'settings.edit': ['แก้ขอบเขต นโยบาย และค่าตั้งระบบ', 'ระบบ'],
    'users.manage': ['เพิ่ม/แก้ผู้ใช้และบทบาท', 'ระบบ'],
    'decision.record': ['บันทึกข้อตกลง ค-1…ค-11', 'ระบบ'],
    'kpi.record': ['บันทึกตัวชี้วัด', 'ระบบ'],
    'backup.export': ['สำรองข้อมูล (ดาวน์โหลด)', 'ระบบ'],
    'backup.restore': ['กู้คืนข้อมูลจากไฟล์สำรอง', 'ระบบ'],
    'master.edit': ['แก้ข้อมูลหลัก (สินค้า คลัง ช่องเก็บ BOM)', 'ข้อมูลหลัก'],
    'bom.approve': ['อนุมัติ BOM/ฉบับแบบ', 'ข้อมูลหลัก'],
    'doc.draft': ['สร้างร่างเอกสารรับ–จ่าย', 'รับ–จ่าย–โอน'],
    'doc.post': ['บันทึกเอกสาร (เปลี่ยนยอด)', 'รับ–จ่าย–โอน'],
    'doc.postAdjust': ['บันทึกใบปรับยอด (AJ)', 'รับ–จ่าย–โอน'],
    'doc.cancel': ['ยกเลิกเอกสาร (รายการกลับ)', 'รับ–จ่าย–โอน'],
    'doc.markExpress': ['บันทึกเลขที่ Express', 'รับ–จ่าย–โอน'],
    'stock.overrideApprove': ['อนุมัติข้อยกเว้นยอดไม่พอ', 'รับ–จ่าย–โอน'],
    'transfer.receive': ['รับของที่โอนมา', 'รับ–จ่าย–โอน'],
    'job.manage': ['สร้าง/แก้ใบงานผลิต', 'ผลิตและจอง'],
    'production.record': ['บันทึกผลผลิต', 'ผลิตและจอง'],
    'reserve.manage': ['จอง/ปล่อยของให้งาน', 'ผลิตและจอง'],
    'pick.post': ['จ่ายของตามการจอง', 'ผลิตและจอง'],
    'express.import': ['นำเข้าไฟล์ Express', 'Express และตรวจนับ'],
    'express.reconcile': ['ปิดการกระทบยอด Express', 'Express และตรวจนับ'],
    'count.create': ['เปิดรอบตรวจนับ', 'Express และตรวจนับ'],
    'count.enter': ['กรอกผลนับ', 'Express และตรวจนับ'],
    'count.approve': ['อนุมัติผลนับ (ปรับยอด)', 'Express และตรวจนับ'],
    'supplier.manage': ['แก้ข้อมูลผู้ขาย', 'จัดซื้อ'],
    'pr.create': ['สร้างใบขอซื้อ (PR)', 'จัดซื้อ'],
    'pr.approve': ['อนุมัติใบขอซื้อ', 'จัดซื้อ'],
    'po.manage': ['ออก/แก้ใบสั่งซื้อ (PO)', 'จัดซื้อ'],
    'po.receive': ['รับของตาม PO', 'จัดซื้อ'],
    'po.overReceive': ['อนุมัติรับเกิน PO', 'จัดซื้อ'],
    'po.close': ['ปิด PO', 'จัดซื้อ'],
    'qc.plan': ['เขียนแผนตรวจ', 'คุณภาพ'],
    'qc.planApprove': ['อนุมัติแผนตรวจ', 'คุณภาพ'],
    'qc.inspect': ['บันทึกผลตรวจ', 'คุณภาพ'],
    'qc.release': ['ปล่อยผ่านของที่ตรวจแล้ว', 'คุณภาพ'],
    'qc.quarantine': ['กักกันของ', 'คุณภาพ'],
    'ncr.disposition': ['ตัดสิน NCR (แก้/คืน/ทิ้ง)', 'คุณภาพ'],
    'ncr.useAsIs': ['อนุมัติใช้ตามสภาพ', 'คุณภาพ'],
    'lot.manage': ['แก้ข้อมูลล็อต/ใบรับรอง', 'คุณภาพ'],
    'offcut.manage': ['บันทึกเศษแผ่น', 'รายงานและขยายผล'],
    'uat.record': ['บันทึกผลทดสอบรับระบบ (UAT)', 'รายงานและขยายผล'],
  };
  const permLabel = (p) => (PERM_INFO[p] ? PERM_INFO[p][0] : A.PERM_LABELS[p] || p);
  const permGroup = (p) => (PERM_INFO[p] ? PERM_INFO[p][1] : 'อื่น ๆ');
  function permList() {
    return Object.keys(A.PERMS).sort((a, b) => GROUPS.indexOf(permGroup(a)) - GROUPS.indexOf(permGroup(b)) || Object.keys(PERM_INFO).indexOf(a) - Object.keys(PERM_INFO).indexOf(b) || a.localeCompare(b));
  }
  const roleLabel = (r) => A.ROLES[r] || r;
  /** User ids: letters (A-Z, Thai), digits and . _ - @ – they show in every history row, so no spaces or symbols. */
  const ID_RE = /^[A-Z0-9\u0E00-\u0E7F][A-Z0-9\u0E00-\u0E7F._@-]*$/;
  /** Checkbox with its hint under the label (the kit field puts the hint beside it and squeezes the box). */
  const checkbox = (o) => t`<label class="fld fld-check${o.wide ? ' wide' : ''}"><span><input type="checkbox" name="${o.name}" value="1"${h.safe(o.value ? ' checked' : '')}></span><span>${o.label}${o.hint ? t`<br><small class="hint">${o.hint}</small>` : ''}</span></label>`;
  const roleBadges = (u) => t`${(u.roles || []).map((r) => h.badge(roleLabel(r), r === 'admin' ? 'accent' : 'info'))}`;

  function userForm(ctx, u, prefill) {
    const v = u || Object.assign({ active: true, roles: [], warehouses: [] }, prefill || {});
    const whs = h.whOptions(ctx.state);
    for (const w of v.warehouses || []) if (!whs.some(([c]) => c === w)) whs.push([w, `${w} (ไม่พบ/ปิดใช้งาน)`]);
    const myAccount = RRS.app && RRS.app.account;
    return h.form({
      name: 'saveUser', submit: u ? 'บันทึกการแก้ไข' : 'เพิ่มผู้ใช้', cancel: u ? null : 'close',
      body: [
        h.field({ name: 'id', label: 'รหัสผู้ใช้', value: v.id, required: true, readonly: !!u,
          hint: u ? 'รหัสผู้ใช้แก้ไม่ได้ (ใช้อ้างในประวัติทุกรายการ)' : 'ตัวอักษร/ตัวเลข เช่น STORE1, SOMCHAI – แก้ภายหลังไม่ได้' }),
        h.field({ name: 'name', label: 'ชื่อ-นามสกุล', value: v.name, required: true }),
        h.field({ name: 'roles', label: 'บทบาท (เลือกได้หลายบทบาท)', type: 'multiselect', options: Object.entries(A.ROLES), value: v.roles, wide: true,
          hint: 'สิทธิ์ของแต่ละบทบาทดูได้ที่แท็บ สิทธิ์ตามบทบาท · ผู้ดูแลระบบทำได้ทุกอย่าง' }),
        whs.length ? h.field({ name: 'warehouses', label: 'คลังที่ทำรายการได้', type: 'multiselect', options: whs, value: v.warehouses, wide: true,
          hint: 'ไม่เลือก = ทุกคลัง · ใช้กับการรับ–จ่าย–โอน และการนับ' }) : t`<p class="hint wide">ยังไม่มีคลัง – ผู้ใช้ทำรายการได้ทุกคลังจนกว่าจะจำกัด</p>`,
        h.field({ name: 'accountId', label: 'บัญชีเข้าระบบที่ผูก', value: v.accountId,
          hint: `ผูกเพื่อให้คนนี้เปิดข้อมูลทีมในชื่อของตัวเอง – ได้จากคำขอใช้งาน${myAccount ? ` · บัญชีที่เปิดหน้านี้อยู่: ${myAccount}` : ''}` }),
        checkbox({ name: 'active', label: 'ใช้งาน', value: v.active !== false, hint: 'ปิดแทนการลบ – ประวัติที่คนนี้ทำยังอยู่' }),
        prefill && prefill.note ? t`<p class="hint wide">ตำแหน่ง/หน้าที่ที่แจ้งในคำขอ: ${prefill.note}</p>` : '',
      ],
    });
  }

  function permsOf(u) {
    const by = {};
    for (const p of permList()) if (A.can(u, p)) (by[permGroup(p)] || (by[permGroup(p)] = [])).push(permLabel(p));
    const keys = GROUPS.filter((g) => by[g]);
    if (!keys.length) return h.empty('ไม่มีสิทธิ์บันทึก', u.active === false ? 'ผู้ใช้นี้ถูกปิดใช้งาน' : 'บทบาทนี้ดูข้อมูลได้อย่างเดียว');
    return h.dl(keys.map((g) => [g, by[g].join(' · ')]));
  }

  function matrix(ctx) {
    const v = ctx.view;
    const users = RRS.q.rows(ctx.state, 'users', (u) => u.active !== false);
    const used = new Set();
    for (const u of users) for (const r of u.roles || []) used.add(r);
    const roles = Object.keys(A.ROLES).filter((r) => !v.usedOnly || used.has(r));
    const perms = permList();
    const cols = [
      // the group name only on the first row of each group, so the rows read as blocks
      { label: 'หมวด', render: (p, i) => (i === 0 || permGroup(perms[i - 1]) !== permGroup(p) ? t`<b>${permGroup(p)}</b>` : '') },
      { label: 'สิทธิ์', render: (p) => t`${permLabel(p)}<br><span class="hint mono">${p}</span>` },
    ].concat(roles.map((r) => ({ label: roleLabel(r), render: (p) => (r === 'admin' || (A.PERMS[p] || []).indexOf(r) >= 0 ? h.badge('✓', r === 'admin' ? 'accent' : 'ok') : t`<span class="muted">–</span>`) })))
      .concat([{ label: 'ผู้ใช้ที่ทำได้ตอนนี้', render: (p) => {
        const names = users.filter((u) => A.can(u, p)).map((u) => u.name);
        return names.length ? names.join(', ') : t`<span class="muted">ยังไม่มีใคร</span>`;
      } }]);
    return t`${h.toolbar([h.field({ name: 'usedOnly', label: 'แสดงเฉพาะบทบาทที่มีผู้ใช้', type: 'checkbox', value: v.usedOnly, id: 'mx-used' })],
      t`<span class="hint">ผู้ดูแลระบบมีทุกสิทธิ์ · การแยกหน้าที่ยังใช้กับทุกคน (อนุมัติงานของตัวเองไม่ได้)</span>`)}
      ${h.table({ rows: perms, dense: true, cols })}`;
  }

  RRS.ui.page({
    id: 'users', title: 'ผู้ใช้และสิทธิ์', phase: 0, order: 40,
    sub: 'ทุกรายการบันทึกว่าใครทำ – ให้แต่ละคนมีผู้ใช้ของตัวเอง เลือกบทบาทตามหน้าที่ และจำกัดคลังได้',
    badge: (ctx) => (ctx.can('users.manage') ? RRS.q.rows(ctx.state, 'access_requests', (r) => r.status === 'OPEN').length || '' : ''),
    render(ctx) {
      const v = ctx.view;
      const tab = ['users', 'requests', 'matrix'].indexOf(v.tab) >= 0 ? v.tab : 'users';
      const canManage = ctx.can('users.manage');
      const allUsers = RRS.q.rows(ctx.state, 'users').sort((a, b) => a.id.localeCompare(b.id));
      const reqs = RRS.q.rows(ctx.state, 'access_requests').sort((a, b) => (a.status === 'OPEN' ? 0 : 1) - (b.status === 'OPEN' ? 0 : 1) || String(b.at).localeCompare(String(a.at)));
      const openReqs = reqs.filter((r) => r.status === 'OPEN');
      const tabs = h.tabs([{ id: 'users', label: 'ผู้ใช้', count: allUsers.filter((u) => u.active !== false).length },
        { id: 'requests', label: 'คำขอใช้งาน', count: openReqs.length }, { id: 'matrix', label: 'สิทธิ์ตามบทบาท' }], tab);
      const ro = canManage ? '' : h.note(`ดูอย่างเดียว – เพิ่ม/แก้ผู้ใช้ได้โดย: ${A.rolesFor('users.manage').map(roleLabel).join(', ')}`, 'info');

      if (tab === 'matrix') return t`${tabs}${h.section('ใครทำอะไรได้', matrix(ctx), { sub: 'แถว = สิ่งที่ทำได้ในระบบ · คอลัมน์ = บทบาท · ระบบตรวจสิทธิ์ซ้ำทุกครั้งที่บันทึก' })}`;

      if (tab === 'requests') {
        const tbl = h.table({ rows: reqs, empty: 'ไม่มีคำขอใช้งาน', emptyText: 'คนที่เปิดข้อมูลทีมแล้วยังไม่มีสิทธิ์ จะส่งคำขอมาที่นี่ ผู้ดูแลระบบกด เพิ่มเป็นผู้ใช้ เพื่อให้สิทธิ์',
          cols: [
            { label: 'ชื่อที่แจ้ง', key: 'name' }, { label: 'ตำแหน่ง/หน้าที่', key: 'note' }, { label: 'ขอเมื่อ', get: (r) => h.fmt.dt(r.at) },
            { label: 'บัญชี', render: (r) => t`<span class="mono hint">${String(r.accountId).slice(0, 14)}${String(r.accountId).length > 14 ? '…' : ''}</span>` },
            { label: 'สถานะ', render: (r) => (r.status === 'OPEN' ? h.badge('รอเพิ่มสิทธิ์', 'warn') : t`${h.badge('เพิ่มแล้ว', 'ok')} ${r.userId ? ctx.userName(r.userId) : ''}`) },
            { label: '', render: (r) => (r.status === 'OPEN' && canManage ? h.btn('เพิ่มเป็นผู้ใช้', { act: 'grant', arg: r.accountId, tone: 'primary', small: true }) : '') },
          ] });
        return t`${tabs}${ro}${h.section('คำขอใช้งานระบบ', tbl, { sub: 'เพิ่มเป็นผู้ใช้ = เปิดฟอร์มผู้ใช้ใหม่ที่ใส่ชื่อและบัญชีให้แล้ว เลือกบทบาทแล้วบันทึก' })}`;
      }

      const q = (v.q || '').toLowerCase();
      const shown = allUsers.filter((u) => (v.inactive || u.active !== false)
        && (!q || [u.id, u.name].concat((u.roles || []).map(roleLabel)).some((x) => String(x || '').toLowerCase().indexOf(q) >= 0)));
      const list = h.table({ rows: shown, rowAct: 'pick', rowArg: (u) => u.id, rowCls: (u) => (u.id === v.sel ? 'sel' : u.active === false ? 'muted' : ''),
        empty: 'ไม่พบผู้ใช้', emptyText: 'ลองคำค้นอื่น หรือติ๊ก แสดงที่ปิดใช้งาน',
        cols: [
          { label: 'รหัส', render: (u) => h.code(u.id) }, { label: 'ชื่อ', key: 'name' }, { label: 'บทบาท', render: roleBadges },
          { label: 'คลัง', get: (u) => (u.warehouses && u.warehouses.length ? u.warehouses.join(', ') : 'ทุกคลัง') },
          { label: 'บัญชีเข้าระบบ', render: (u) => (u.accountId ? h.badge('ผูกแล้ว', 'ok') : t`<span class="muted">ยังไม่ผูก</span>`) },
          { label: 'สถานะ', render: (u) => (u.active === false ? h.badge('ปิดใช้งาน', 'muted') : h.badge('ใช้งาน', 'ok')) },
        ] });
      let detail = h.empty('เลือกผู้ใช้จากรายการ', canManage ? 'หรือกด + เพิ่มผู้ใช้ เพื่อให้แต่ละคนทำรายการในชื่อของตัวเอง' : 'ดูบทบาทและสิ่งที่ทำได้ของแต่ละคน');
      const sel = v.sel && v.sel !== '__new' ? RRS.q.get(ctx.state, 'users', v.sel) : null;
      if (v.sel === '__new' && canManage) {
        detail = h.section(v.prefill ? `เพิ่มผู้ใช้จากคำขอของ ${v.prefill.name}` : 'เพิ่มผู้ใช้', userForm(ctx, null, v.prefill));
      } else if (sel) {
        detail = t`${h.section(t`${h.code(sel.id)} ${sel.name}`, canManage ? userForm(ctx, sel) : h.dl([['บทบาท', roleBadges(sel)],
          ['คลัง', sel.warehouses && sel.warehouses.length ? sel.warehouses.join(', ') : 'ทุกคลัง'], ['บัญชีเข้าระบบ', sel.accountId ? 'ผูกแล้ว' : 'ยังไม่ผูก'],
          ['สถานะ', sel.active === false ? 'ปิดใช้งาน' : 'ใช้งาน']]))}
          ${h.section('สิ่งที่ผู้ใช้นี้ทำได้', permsOf(sel), { sub: sel.warehouses && sel.warehouses.length ? `รับ–จ่าย–โอนและนับได้เฉพาะคลัง ${sel.warehouses.join(', ')}` : 'ทุกคลัง' })}`;
      }
      const demoHint = ctx.mode === 'demo' ? h.note('ข้อมูลตัวอย่าง: เลือกผู้ใช้ที่ ทำรายการในชื่อ (มุมขวาบน) เพื่อลองสิทธิ์ของแต่ละบทบาท', 'info') : '';
      return t`${tabs}${ro}${openReqs.length && canManage ? h.note(t`มีคำขอใช้งานรอ ${openReqs.length} รายการ – ${h.btn('ดูคำขอ', { act: 'tab', arg: 'requests', tone: 'quiet', small: true })}`, 'warn') : ''}${demoHint}
        ${h.toolbar([
          h.field({ name: 'q', label: 'ค้นหา', value: v.q, placeholder: 'รหัส ชื่อ บทบาท…', id: 'usr-q' }),
          h.field({ name: 'inactive', label: 'แสดงที่ปิดใช้งาน', type: 'checkbox', value: v.inactive, id: 'usr-off' }),
        ], canManage ? h.btn('+ เพิ่มผู้ใช้', { act: 'new', tone: 'primary' }) : '')}
        <div class="split"><div>${list}<p class="hint">${shown.length} คน</p></div><div>${detail}</div></div>`;
    },
    after(ctx, root0) {
      const q = root0.querySelector('#usr-q');
      if (q) {
        q.addEventListener('input', () => { ctx.view.q = q.value; clearTimeout(ctx.view._t); ctx.view._t = setTimeout(() => ctx.set({ _refocus: true }), 250); });
        if (ctx.view._refocus) { ctx.view._refocus = false; q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      }
      const off = root0.querySelector('#usr-off');
      if (off) off.addEventListener('change', () => ctx.set({ inactive: off.checked }));
      const mx = root0.querySelector('#mx-used');
      if (mx) mx.addEventListener('change', () => ctx.set({ usedOnly: mx.checked }));
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg }),
      pick: (ctx, el) => ctx.set({ sel: el.dataset.arg, prefill: null }),
      new: (ctx) => ctx.set({ sel: '__new', prefill: null }),
      close: (ctx) => ctx.set({ sel: null, prefill: null }),
      grant(ctx, el) {
        const r = RRS.q.get(ctx.state, 'access_requests', el.dataset.arg);
        if (!r) return;
        ctx.set({ tab: 'users', sel: '__new', prefill: { accountId: r.accountId, name: r.name, note: r.note } });
      },
    },
    forms: {
      async saveUser(ctx, vals) {
        const me = ctx.user;
        const id = RRS.util.normCode(vals.id);
        if (ctx.view.sel === '__new') {
          if (!id) return ctx.toast('กรอกรหัสผู้ใช้ เช่น STORE1 แล้วกด เพิ่มผู้ใช้ อีกครั้ง', 'bad');
          if (!ID_RE.test(id)) return ctx.toast(`รหัสผู้ใช้ "${id}" ใช้ได้เฉพาะตัวอักษร ตัวเลข และ . _ - @ (ไม่มีเว้นวรรค) เช่น STORE1, SOMCHAI`, 'bad');
          const prev = RRS.q.get(ctx.state, 'users', id);
          if (prev) return ctx.toast(`รหัสผู้ใช้ ${id} มีอยู่แล้ว (${prev.name}) – ใช้รหัสอื่น หรือเลือกคนนั้นจากรายการเพื่อแก้ไข ยังไม่ได้บันทึก`, 'bad');
        }
        if (me && id === me.id && (vals.roles || []).indexOf('admin') < 0 && me.roles.indexOf('admin') >= 0) {
          const ok = await ctx.confirm({ title: 'เอาบทบาทผู้ดูแลระบบออกจากตัวเอง', message: 'หลังบันทึก คุณจะเพิ่ม/แก้ผู้ใช้ไม่ได้อีก ต้องให้ผู้ดูแลระบบคนอื่นทำแทน', ok: 'บันทึก', danger: true });
          if (!ok) return;
        }
        const r = await ctx.exec('user.upsert', { id: vals.id, name: vals.name, roles: vals.roles || [], warehouses: vals.warehouses || [], active: vals.active, accountId: vals.accountId },
          { done: `บันทึกผู้ใช้ ${RRS.util.trim(vals.name)} แล้ว` });
        if (r.ok) ctx.set({ sel: id, prefill: null });
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
