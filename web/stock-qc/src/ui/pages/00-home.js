/*
 * Home – dashboard for the person signed in: key numbers, the work waiting for this user's roles, and how far each
 * phase (0–6) has come. Tables of modules that are not loaded yet (jobs, pos, count_sessions, uat …) read as empty.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;

  const rows = (state, name, f) => RRS.q.rows(state, name, f);
  /** A table is "there" when its module defined it or rows exist. */
  const has = (state, name) => !!(RRS.schema.tables[name] || state.tables[name]);

  /** First registered page among ids, else the first whose title matches re (other screens are written in parallel). */
  function findPage(ids, re) {
    const pages = RRS.ui.pages;
    for (const id of ids) if (pages[id]) return id;
    if (re) {
      const p = Object.values(pages).filter((x) => x.id !== 'home').sort((a, b) => a.order - b.order).find((x) => re.test(x.title || ''));
      if (p) return p.id;
    }
    return null;
  }
  const go = (label, page, view) => (page ? h.link(label, page, view) : t`${label} <span class="muted">(หน้าจอยังไม่เปิดใช้)</span>`);

  function settingsOf(state) {
    const d = RRS.defaultSettings();
    const s = RRS.q.get(state, 'settings', 'main') || {};
    return Object.assign({}, d, s, { pilot: Object.assign({}, d.pilot, s.pilot), policies: Object.assign({}, d.policies, s.policies) });
  }

  /** PO line still to come: ordered − received − cancelled (base unit). */
  const outstanding = (l) => RRS.util.round((Number(l.base != null ? l.base : l.qty) || 0) - (Number(l.received) || 0) - (Number(l.cancelled) || 0));
  function latePoLines(state, today) {
    const out = [];
    for (const po of rows(state, 'pos', (p) => p.status === 'ISSUED' || p.status === 'PARTIAL')) {
      for (const l of po.lines || []) if (l.dueDate && l.dueDate < today && outstanding(l) > 0) out.push({ po, line: l });
    }
    return out;
  }

  function numbers(ctx) {
    const s = ctx.state;
    const docs = rows(s, 'documents');
    const bal = rows(s, 'balances', (b) => b.wh !== RRS.TRANSIT);
    const distinct = (list) => new Set(list.map((b) => b.code)).size;
    const hold = bal.filter((b) => b.status === 'QC_HOLD');
    const quar = bal.filter((b) => b.status === 'QUARANTINE');
    return {
      items: rows(s, 'items', (i) => i.active !== false).length,
      itemsOff: rows(s, 'items', (i) => i.active === false).length,
      locations: bal.length,
      whs: rows(s, 'warehouses', (w) => w.active !== false).length,
      bins: rows(s, 'bins', (b) => b.active !== false).length,
      express: docs.filter((d) => d.expressStatus === 'WAIT' && d.status !== 'CANCELLED' && d.status !== 'DRAFT').length,
      drafts: docs.filter((d) => d.status === 'DRAFT').length,
      wait: docs.filter((d) => d.status === 'WAIT_APPROVAL').length,
      transit: docs.filter((d) => d.status === 'IN_TRANSIT').length,
      holdItems: distinct(hold), holdLocs: hold.length, quarItems: distinct(quar), quarLocs: quar.length,
      jobs: rows(s, 'jobs', (j) => j.status === 'OPEN' || j.status === 'IN_PROGRESS').length,
      reservations: rows(s, 'reservations', (r) => r.status === 'OPEN' || r.status === 'PARTIAL').length,
      counts: rows(s, 'count_sessions', (c) => c.status === 'OPEN' || c.status === 'SUBMITTED').length,
      latePo: latePoLines(s, ctx.today).length,
      ncrs: rows(s, 'ncrs', (n) => n.status === 'OPEN').length,
      inspections: rows(s, 'inspections', (i) => i.status === 'OPEN').length,
    };
  }

  /** Work this user can act on, from their permissions. */
  function myWork(ctx) {
    const s = ctx.state;
    const me = ctx.user ? ctx.user.id : '';
    const can = ctx.can;
    const out = [];
    const add = (n, label, why, page, view, tone) => { if (n > 0) out.push({ n, label, why, page, view, tone: tone || 'warn' }); };
    const docs = rows(s, 'documents');
    const pDocs = 'docs';
    if (can('stock.overrideApprove')) {
      add(docs.filter((d) => d.status === 'WAIT_APPROVAL' && !(d.override && d.override.requestedBy === me)).length,
        'อนุมัติข้อยกเว้นยอดไม่พอ', 'เอกสารที่ขอบันทึกทั้งที่ยอดไม่พอ รอคนอนุมัติ (ผู้ขออนุมัติเองไม่ได้)', pDocs, { tab: 'wait' }, 'bad');
    }
    if (can('doc.markExpress')) {
      add(docs.filter((d) => d.expressStatus === 'WAIT' && d.status !== 'CANCELLED' && d.status !== 'DRAFT').length,
        'บันทึกเลขที่ Express', 'เอกสารที่บันทึกแล้วแต่ยังไม่ได้คีย์ใน Express', pDocs, { tab: 'express' });
    }
    if (can('transfer.receive')) {
      add(docs.filter((d) => d.status === 'IN_TRANSIT' && (d.lines || []).some((l) => can('transfer.receive', l.toWh))).length,
        'รับของที่โอนมา', 'ใบโอนที่ของออกจากต้นทางแล้ว รอรับเข้าปลายทาง', pDocs, { tab: 'transit' });
    }
    if (can('doc.draft') || can('doc.post')) {
      add(docs.filter((d) => d.status === 'DRAFT' && d.createdBy === me).length, 'ร่างเอกสารของคุณ',
        'ร่างยังไม่เปลี่ยนยอด – ตรวจแล้วบันทึก หรือลบร่างที่ไม่ใช้', pDocs, { tab: 'draft' }, 'info');
    }
    if (can('users.manage')) {
      add(rows(s, 'access_requests', (r) => r.status === 'OPEN').length, 'คำขอใช้งานระบบ', 'คนที่เข้าสู่ระบบแล้วแต่ยังไม่มีสิทธิ์', 'users', { tab: 'requests' });
    }
    if (can('decision.record')) {
      const decided = rows(s, 'decisions', (d) => d.status === 'decided').length;
      add(RRS.master.QUESTIONS.length - decided, 'ข้อตกลง Phase 0 ที่ยังไม่ตัดสิน', 'ค-1 … ค-11 ต้องมีข้อสรุปและผู้ตัดสินก่อนเริ่มใช้จริง', 'setup', { tab: 'decisions' }, 'info');
    }
    if (can('kpi.record')) {
      add(rows(s, 'kpis', (k) => k.baseline == null).length, 'ตัวชี้วัดที่ยังไม่มีค่าก่อนเริ่ม', 'วัดค่าตั้งต้นไว้เทียบผลหลังใช้ระบบ', 'setup', { tab: 'kpis' }, 'info');
    }
    if (can('settings.edit')) {
      const st = settingsOf(s);
      add(!(st.pilot.groups.length || st.pilot.warehouses.length) ? 1 : 0, 'กำหนดขอบเขตทดลอง', 'ยังไม่ได้เลือกกลุ่มชิ้นส่วน/คลังที่ใช้ทดลอง', 'setup', { tab: 'scope' }, 'info');
      add(!st.cutoffAt ? 1 : 0, 'กำหนดเวลาตัดยอดตั้งต้น', 'ใช้เป็นจุดเริ่มนับยอดและกระทบกับ Express', 'setup', { tab: 'scope' }, 'info');
    }
    if (can('master.edit')) {
      add(!rows(s, 'warehouses').length ? 1 : 0, 'เพิ่มคลังแรก', 'ยังไม่มีคลัง – บันทึกรับ–จ่ายไม่ได้จนกว่าจะมีคลัง', 'warehouses', null, 'info');
      add(!rows(s, 'items').length ? 1 : 0, 'เพิ่มสินค้าในทะเบียน', 'ยังไม่มีสินค้า – เพิ่มทีละรายการหรือนำเข้า CSV', 'items', null, 'info');
    }
    if (can('bom.approve')) {
      add(rows(s, 'boms', (b) => b.status === 'DRAFT').length, 'อนุมัติ BOM', 'BOM ร่างที่รอวิศวกรรมอนุมัติ', 'boms', { st: 'DRAFT' });
    }
    // later phases (their screens are found by id or title)
    const pJobs = findPage(['jobs', 'job'], /ใบงาน|งานผลิต/);
    if (can('job.manage') && has(s, 'jobs')) add(rows(s, 'jobs', (j) => j.status === 'OPEN').length, 'งานผลิตที่ยังไม่เริ่ม', 'ใบงานสถานะเปิด', pJobs, null, 'info');
    const pPick = findPage(['pick', 'picking', 'reservations', 'reserve'], /เบิก|จอง/);
    if (can('pick.post') && has(s, 'reservations')) {
      add(rows(s, 'reservations', (r) => (r.status === 'OPEN' || r.status === 'PARTIAL') && (Number(r.qty) || 0) - (Number(r.issued) || 0) > 0 && r.needDate && r.needDate <= ctx.today && can('pick.post', r.wh)).length,
        'จ่ายของตามการจองที่ถึงกำหนด', 'การจองที่ถึงวันต้องใช้แล้วแต่ยังจ่ายไม่ครบ', pPick);
    }
    const pCount = findPage(['counts', 'count', 'stocktake'], /นับ/);
    if (can('count.enter') && has(s, 'count_sessions')) {
      add(rows(s, 'count_sessions', (c) => c.status === 'OPEN' && can('count.enter', c.wh)).length, 'กรอกผลตรวจนับ', 'รอบนับที่เปิดอยู่', pCount);
    }
    if (can('count.approve') && has(s, 'count_sessions')) {
      add(rows(s, 'count_sessions', (c) => c.status === 'SUBMITTED' && c.createdBy !== me).length, 'อนุมัติผลตรวจนับ', 'ส่งผลนับแล้ว รออนุมัติปรับยอด', pCount);
    }
    const pExpress = findPage(['express', 'reconcile'], /Express/);
    if ((can('express.import') || can('express.reconcile')) && has(s, 'express_batches')) {
      add(rows(s, 'express_batches', (b) => b.status === 'REVIEW').length, 'กระทบยอดไฟล์ Express', 'ไฟล์ที่นำเข้าแล้วรอตรวจผลต่าง', pExpress);
    }
    const pPr = findPage(['prs', 'pr', 'purchase-requests'], /ขอซื้อ|PR/);
    if (can('pr.approve') && has(s, 'prs')) {
      add(rows(s, 'prs', (p) => p.status === 'SUBMITTED' && p.requestedBy !== me).length, 'อนุมัติใบขอซื้อ', 'ใบขอซื้อที่ส่งมารออนุมัติ', pPr);
    }
    const pPo = findPage(['pos', 'po', 'purchasing'], /สั่งซื้อ|PO/);
    if ((can('po.manage') || can('po.receive')) && has(s, 'pos')) {
      add(latePoLines(s, ctx.today).length, 'ตามของ PO ที่เลยกำหนดส่ง', 'บรรทัด PO ที่ถึงกำหนดแล้วยังรับไม่ครบ', pPo, null, 'bad');
    }
    const pQc = findPage(['inspections', 'qc', 'inspect'], /ตรวจรับ|ตรวจคุณภาพ|QC/);
    if (can('qc.inspect')) {
      const holdLocs = rows(s, 'balances', (b) => b.status === 'QC_HOLD' && b.wh !== RRS.TRANSIT).length;
      add(holdLocs, 'ตรวจของที่รอตรวจ', 'ของสถานะรอตรวจยังใช้/เบิกไม่ได้จนกว่าจะผ่าน QC', pQc);
    }
    if (can('qc.release') && has(s, 'inspections')) {
      add(rows(s, 'inspections', (i) => i.status === 'OPEN' && i.result === 'PASS' && i.inspector !== me).length, 'ปล่อยผ่านของที่ตรวจผ่าน', 'ผลตรวจผ่านแล้ว รอหัวหน้า QC ปล่อยให้ใช้ได้', pQc);
    }
    const pNcr = findPage(['ncrs', 'ncr'], /NCR|ของไม่ได้มาตรฐาน/);
    if (can('ncr.disposition') && has(s, 'ncrs')) add(rows(s, 'ncrs', (n) => n.status === 'OPEN').length, 'ตัดสินของไม่ได้มาตรฐาน (NCR)', 'NCR ที่ยังไม่ตัดสินว่าแก้/คืน/ทิ้ง/ใช้ตามสภาพ', pNcr, null, 'bad');
    const pPlan = findPage(['qc-plans', 'qcplans', 'qc_plans'], /แผนตรวจ/);
    if (can('qc.planApprove') && has(s, 'qc_plans')) add(rows(s, 'qc_plans', (p) => p.status === 'DRAFT' && p.createdBy !== me).length, 'อนุมัติแผนตรวจ', 'แผนตรวจร่างที่รออนุมัติ', pPlan);
    const pUat = findPage(['uat'], /UAT|ทดสอบรับ/);
    if (can('uat.record') && has(s, 'uat')) add(rows(s, 'uat', (u) => u.status !== 'PASS').length, 'ทดสอบเกณฑ์รับระบบ (UAT)', 'เกณฑ์ที่ยังไม่ผ่านหรือยังไม่ได้ทดสอบ', pUat, null, 'info');
    return out;
  }

  /** What each phase has, and its UAT score when criteria exist. */
  function phases(ctx) {
    const s = ctx.state;
    const n = (name, f) => rows(s, name, f).length;
    const tableOn = (name) => has(s, name);
    const uat = rows(s, 'uat');
    const decided = n('decisions', (d) => d.status === 'decided');
    const total = RRS.master.QUESTIONS.length;
    const facts = {
      0: [`ข้อตกลง ${decided}/${total}`, `คลัง ${n('warehouses')}`, `สินค้า ${n('items')}`, `ผู้ใช้ ${n('users', (u) => u.active !== false)}`],
      1: [`เอกสารบันทึกแล้ว ${n('documents', (d) => d.status !== 'DRAFT')}`, `รายการเคลื่อนไหว ${n('movements')}`],
      2: tableOn('jobs') || tableOn('reservations') ? [`ใบงาน ${n('jobs')}`, `การจอง ${n('reservations')}`] : [],
      3: tableOn('express_batches') || tableOn('count_sessions') ? [`ไฟล์ Express ${n('express_batches')}`, `รอบนับ ${n('count_sessions')}`] : [],
      4: tableOn('pos') || tableOn('suppliers') ? [`ผู้ขาย ${n('suppliers')}`, `PR ${n('prs')}`, `PO ${n('pos')}`] : [],
      5: tableOn('inspections') || tableOn('lots') ? [`แผนตรวจ ${n('qc_plans')}`, `ผลตรวจ ${n('inspections')}`, `NCR ${n('ncrs')}`, `ล็อต ${n('lots')}`] : [],
      6: tableOn('uat') || tableOn('backup_tests') ? [`เกณฑ์ UAT ${uat.length}`, `ทดสอบกู้คืน ${n('backup_tests')}`] : [],
    };
    const labels = RRS.ui.PHASES || [];
    const pages = Object.values(RRS.ui.pages);
    const out = [];
    for (let p = 0; p <= 6; p++) {
      const crit = uat.filter((u) => String(u.phase).replace(/\D/g, '') === String(p));
      const pass = crit.filter((u) => u.status === 'PASS').length;
      const fail = crit.filter((u) => u.status === 'FAIL').length;
      const lab = (labels.find((x) => x.n === p) || {}).label || `Phase ${p}`;
      const first = pages.filter((pg) => pg.phase === p).sort((a, b) => a.order - b.order)[0];
      let meter = null;
      let score = '';
      if (crit.length) {
        meter = pass / crit.length;
        score = `UAT ผ่าน ${pass}/${crit.length}${fail ? ` · ไม่ผ่าน ${fail}` : ''}`;
      } else if (p === 0) {
        meter = decided / total;
        score = `ตัดสินข้อตกลงแล้ว ${decided}/${total}`;
      } else score = 'ยังไม่มีเกณฑ์ UAT';
      out.push({ p, title: lab.split(' · ')[1] || lab, meter, score, fail, facts: facts[p], page: first ? first.id : null,
        on: !!first || facts[p].length > 0 });
    }
    return out;
  }

  function startSteps(ctx) {
    const s = ctx.state;
    const st = settingsOf(s);
    const decided = rows(s, 'decisions', (d) => d.status === 'decided').length;
    return [
      { done: !!(st.pilot.groups.length || st.pilot.warehouses.length), label: 'กำหนดขอบเขตทดลองและเวลาตัดยอด', page: 'setup', view: { tab: 'scope' } },
      { done: rows(s, 'warehouses').length > 0, label: 'เพิ่มคลังและช่องเก็บ', page: 'warehouses' },
      { done: rows(s, 'items').length > 0, label: 'เพิ่มสินค้า (ทีละรายการหรือนำเข้า CSV)', page: 'items' },
      { done: rows(s, 'users').length > 1, label: 'เพิ่มผู้ใช้และบทบาท', page: 'users' },
      { done: decided === RRS.master.QUESTIONS.length, label: `ตอบข้อตกลง ค-1 … ค-11 (${decided}/${RRS.master.QUESTIONS.length})`, page: 'setup', view: { tab: 'decisions' } },
    ];
  }

  RRS.ui.page({
    id: 'home', title: 'ภาพรวม', phase: 'home', order: 0,
    render(ctx) {
      const s = ctx.state;
      const u = ctx.user;
      const k = numbers(ctx);
      const tiles = [
        h.kpi('สินค้าที่ใช้งาน', h.fmt.num(k.items), k.itemsOff ? `ปิดใช้งาน ${h.fmt.num(k.itemsOff)}` : h.link('ทะเบียนสินค้า', 'items')),
        h.kpi('ตำแหน่งที่มีของ', h.fmt.num(k.locations), `${k.whs} คลัง · ${k.bins} ช่องเก็บ`),
        h.kpi('รอคีย์ Express', h.fmt.num(k.express), k.express ? h.link('ดูเอกสาร', 'docs', { tab: 'express' }) : 'ไม่มีค้าง', k.express ? 'warn' : 'ok'),
        h.kpi('ร่างเอกสาร', h.fmt.num(k.drafts), k.drafts ? h.link('ดูร่าง', 'docs', { tab: 'draft' }) : 'ยังไม่เปลี่ยนยอด'),
        h.kpi('ข้อยกเว้นรออนุมัติ', h.fmt.num(k.wait), k.wait ? h.link('ไปอนุมัติ', 'docs', { tab: 'wait' }) : 'ไม่มีค้าง', k.wait ? 'bad' : 'ok'),
        h.kpi('ของรอตรวจ', h.fmt.num(k.holdItems), k.holdItems ? `${k.holdLocs} ตำแหน่ง – ใช้ไม่ได้จนผ่าน QC` : 'รายการสินค้า', k.holdItems ? 'warn' : ''),
        h.kpi('ของกักกัน', h.fmt.num(k.quarItems), k.quarItems ? `${k.quarLocs} ตำแหน่ง` : 'รายการสินค้า', k.quarItems ? 'bad' : ''),
      ];
      if (k.transit) tiles.push(h.kpi('ระหว่างโอน', h.fmt.num(k.transit), h.link('รอรับโอน', 'docs', { tab: 'transit' }), 'info'));
      if (has(s, 'jobs')) tiles.push(h.kpi('งานผลิตเปิดอยู่', h.fmt.num(k.jobs), 'เปิด + กำลังผลิต', 'info'));
      if (has(s, 'reservations')) tiles.push(h.kpi('การจองค้างจ่าย', h.fmt.num(k.reservations), 'เปิด + จ่ายบางส่วน'));
      if (has(s, 'count_sessions')) tiles.push(h.kpi('รอบนับค้าง', h.fmt.num(k.counts), 'เปิด + รออนุมัติ', k.counts ? 'warn' : ''));
      if (has(s, 'pos')) tiles.push(h.kpi('บรรทัด PO เลยกำหนด', h.fmt.num(k.latePo), 'ยังรับไม่ครบ', k.latePo ? 'bad' : 'ok'));
      if (has(s, 'inspections')) tiles.push(h.kpi('ผลตรวจเปิดอยู่', h.fmt.num(k.inspections), 'รอปล่อยผ่าน/ออก NCR', k.inspections ? 'warn' : ''));
      if (has(s, 'ncrs')) tiles.push(h.kpi('NCR เปิดอยู่', h.fmt.num(k.ncrs), 'รอตัดสิน', k.ncrs ? 'bad' : ''));

      const steps = startSteps(ctx);
      const setupLeft = steps.filter((x) => !x.done).length;
      const start = setupLeft ? h.section('เริ่มต้นใช้งาน (Phase 0)', t`<div class="steps">${steps.map((st, i) => t`<div class="step"><span class="step-n">ขั้นที่ ${i + 1}</span>
        <span>${h.link(st.label, st.page, st.view)}</span>${st.done ? h.badge('เสร็จแล้ว', 'ok') : h.badge('ยังไม่ทำ', 'muted')}</div>`)}</div>`,
      { sub: 'ทำตามลำดับนี้ก่อนบันทึกรับ–จ่ายจริง – ระบบจะซ่อนกล่องนี้เมื่อครบทุกขั้น' }) : '';

      const work = myWork(ctx);
      const workTbl = work.length ? h.table({ rows: work, dense: true, cols: [
        { label: 'งาน', render: (w) => go(w.label, w.page, w.view) },
        { label: 'จำนวน', render: (w) => h.badge(h.fmt.num(w.n), w.tone) , cls: 'n' },
        { label: 'ทำไม', render: (w) => t`<span class="muted">${w.why}</span>` },
      ] }) : h.empty('ไม่มีงานค้างสำหรับบทบาทของคุณ', u ? 'เมื่อมีเอกสารรออนุมัติ ของรอตรวจ หรือคำขอที่บทบาทของคุณทำได้ จะขึ้นที่นี่' : 'เลือกผู้ใช้ที่ ทำรายการในชื่อ ด้านบนก่อน');

      const ph = phases(ctx);
      const strip = t`<div class="steps">${ph.map((x) => t`<div class="step">
        <span class="step-n">PHASE ${x.p}</span><h3>${x.page ? h.link(x.title, x.page) : x.title}</h3>
        ${x.meter != null ? t`<div class="bar-meter" role="img" aria-label="${x.score}"><span style="width:${h.safe(String(Math.round(x.meter * 100)))}%"></span></div>` : ''}
        <span>${x.fail ? h.badge(x.score, 'bad') : x.meter === 1 ? h.badge(x.score, 'ok') : x.score}</span>
        ${x.facts.length ? t`<span class="hint">${x.facts.join(' · ')}</span>` : t`<span class="hint">${x.on ? '' : 'โมดูลนี้ยังไม่เปิดใช้ในชุดนี้'}</span>`}</div>`)}</div>`;

      const recent = rows(s, 'audit').sort((a, b) => b.seq - a.seq).slice(0, 8);
      const recentTbl = h.table({ rows: recent, dense: true, empty: 'ยังไม่มีรายการ', emptyText: 'ทุกการบันทึกจะขึ้นที่นี่พร้อมผู้ทำและเวลา',
        cols: [{ label: 'เวลา', get: (a) => h.fmt.dt(a.at) }, { label: 'ผู้ทำ', get: (a) => (a.by ? ctx.userName(a.by) : 'ระบบ') }, { label: 'รายการ', key: 'summary' }] });

      const who = u ? t`<p class="hint">ทำรายการในชื่อ <b>${u.name}</b> · ${u.roles.map((r) => RRS.auth.ROLES[r] || r).join(', ')}${u.warehouses && u.warehouses.length ? ` · คลัง ${u.warehouses.join(', ')}` : ''}</p>`
        : h.note('ยังไม่ได้เลือกผู้ใช้ – ทุกปุ่มบันทึกจะใช้ไม่ได้จนกว่าจะเลือกหรือได้รับสิทธิ์', 'warn');
      return t`${who}${start}${h.kpis(tiles)}
        ${h.section('งานที่รอคุณ', workTbl, { sub: 'สร้างจากสิทธิ์ตามบทบาทของคุณ – กดชื่องานเพื่อไปทำต่อ' })}
        ${h.section('ความคืบหน้า Phase 0–6', strip, { sub: 'นับเกณฑ์ UAT ที่ผ่านเมื่อมีตาราง UAT ไม่เช่นนั้นแสดงสิ่งที่ตั้งไว้แล้ว' })}
        ${h.section('รายการล่าสุด', recentTbl, { actions: h.link('ดูบันทึกทั้งหมด', 'audit') })}`;
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
