/*
 * In-browser acceptance self-test (ทดสอบเกณฑ์ตรวจรับอัตโนมัติ).
 *
 *   const results = await RRS.selftest.run({ onProgress })
 *     -> [{id, phase, criterion, pass, detail, manual, checks, ms}]   (ids / text = RRS.reports.UAT_CRITERIA)
 *   onProgress({done, total, id, criterion, pass})  after every criterion
 *
 * Every criterion of Phase 0–6 runs its scenario (ported from tests/phase1–6.test.mjs) in a FRESH in-memory world:
 * a new RRS.MemoryStore + one RRS.Ledger per person, its own users (STORE1 … VIEW), warehouses A/B and test items. The
 * data on screen (demo, team or server) is never read or written. A scenario passes when every check holds; `detail`
 * says what was shown (pass) or what went wrong (fail) in Thai. `manual: true` marks criteria whose final word is a
 * person's acceptance (store/QC/accounting sign-off, KPI targets …): the test proves the mechanism works, the real
 * acceptance is still recorded in the UAT page.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  if (!RRS || !RRS.Ledger || !RRS.MemoryStore) return;
  const { util } = RRS;

  const START = '2026-11-02T01:00:00.000Z'; // 08:00 Bangkok
  const TODAY = '2026-11-02';
  const day = (n) => util.addDays(TODAY, n);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const qty = (s, f) => RRS.q.qty(s, f);
  const codeOf = (r) => (r && r.ok ? 'OK' : ((r && r.errors && r.errors[0]) || {}).code || '?');
  const msgs = (r) => ((r && r.errors) || []).map((e) => e.message).join(' / ');
  const has = (arr, re) => (arr || []).some((x) => re.test(x));

  /** Same ids and text as RRS.reports.UAT_CRITERIA (used when reports.js is not loaded). */
  const CRITERIA_TEXT = {
    0: ['ผู้เกี่ยวข้องยอมรับรหัส/หน่วย/คลังของชุดทดลอง', 'ระบุแหล่งยอดหลักได้ทุกประเภท', 'กู้ข้อมูลสำรองได้'],
    1: ['สินค้ารหัสเดียวในคลัง A และ B ตัดยอดเฉพาะคลังที่เลือก', 'สองคนเบิกของชิ้นสุดท้ายพร้อมกันสำเร็จได้เพียงคนเดียว',
      'ส่งคำขอเดิมซ้ำไม่ตัดซ้ำ', 'เอกสารมีบรรทัดผิดไม่เปลี่ยนยอด', 'โอนและยกเลิกแล้วผลรวมตรงกับประวัติ'],
    2: ['สอง SO ไม่จองเกินยอดพร้อมใช้', 'ยกเลิกงานคืนยอดจองถูกต้อง', 'เบิกบางส่วนแล้วเหลือยอดจองถูกต้อง',
      'ของรอตรวจและของคาดว่าจะเข้าไม่ถูกเบิกเป็นของพร้อมใช้'],
    3: ['นำเข้าไฟล์เดิมซ้ำไม่เปลี่ยนยอดซ้ำ', 'ไฟล์เก่าไม่ทับรายการใหม่โดยอัตโนมัติ', 'นับในคลัง B สร้าง AJ ที่คลัง B',
      'มีการเบิกระหว่างนับกับอนุมัติแล้วระบบคำนวณ/บล็อกตามกติกาที่ตกลง', 'ยอดต่างมีคำอธิบายและผู้รับผิดชอบ'],
    4: ['รับ PO บางส่วนแล้วยอดค้างรับถูกต้อง', 'ระบบไม่แนะนำซื้อซ้ำโดยไม่หักของค้างรับที่เข้าได้ทัน', 'ปริมาณสั่งสอดคล้อง MOQ/แพ็ก',
      'ยกเลิก PO แล้วคำนวณแผนใหม่', 'ของรอตรวจยังไม่เพิ่มยอดพร้อมเบิก'],
    5: ['ค้น Heat/Lot แล้วพบใบรับและงานที่ใช้', 'กักล็อตแล้วทุกช่องทางเบิกถูกบล็อก', 'ผู้ไม่มีสิทธิ์ปล่อยผ่านไม่ได้',
      'ตรวจซ้ำผูกผลเดิมและฉบับแบบถูกต้อง', 'ผลิตเสร็จยังไม่เท่ากับผ่าน QC', 'คืน/ตัดทิ้งกระทบจำนวนและประวัติถูกต้อง'],
    6: ['ไม่มีข้อผิดพลาดรุนแรงที่ทำให้ยอดคลาดเคลื่อน ตัดซ้ำ หรือปล่อยของกักกัน', 'สโตร์/QC/บัญชียอมรับยอดและขั้นตอน', 'กู้ข้อมูลได้',
      'ตัวชี้วัดตรงตามเป้าหมายที่ตกลงใน Phase 0', 'มีผู้รับผิดชอบและแผนย้อนกลับก่อนขยาย'],
  };
  function criteria() {
    if (RRS.reports && Array.isArray(RRS.reports.UAT_CRITERIA) && RRS.reports.UAT_CRITERIA.length) {
      return RRS.reports.UAT_CRITERIA.map((c) => ({ id: c.id, phase: c.phase, criterion: c.criterion }));
    }
    const out = [];
    for (const ph of Object.keys(CRITERIA_TEXT)) {
      CRITERIA_TEXT[ph].forEach((text, i) => out.push({ id: `P${ph}-${i + 1}`, phase: Number(ph), criterion: text }));
    }
    return out;
  }
  /** Criteria where a person gives the final acceptance – the test checks the mechanism only. */
  const MANUAL = { 'P0-1': true, 'P6-2': true, 'P6-4': true, 'P6-5': true };
  const MODULE_NAME = { planning: 'ใบงานและการจอง (planning.js)', reconcile: 'Express และตรวจนับ (reconcile.js)',
    purchasing: 'จัดซื้อ (purchasing.js)', quality: 'QC ล็อต NCR (quality.js)', reports: 'รายงานและขยายผล (reports.js)' };
  const loaded = (m) => !!RRS[m];

  // ---------------------------------------------------------------------------------------------------------
  // a fresh world: one MemoryStore, a ledger per person (like separate phones), the same users as tests/helpers.mjs
  // ---------------------------------------------------------------------------------------------------------
  function makeClock(start) {
    let t = Date.parse(start);
    const clock = () => {
      t += 60e3;
      return new Date(t).toISOString();
    };
    clock.peek = () => new Date(t).toISOString();
    return clock;
  }
  const USERS = {
    STORE1: ['store'], STORE2: ['store'], LEAD: ['store_lead'], ACC: ['accounting'], PLAN: ['planner'], PUR: ['purchasing'],
    PURLEAD: ['purchasing_lead'], QC1: ['qc'], QCLEAD: ['qc_lead'], ENG: ['engineering'], PROD: ['production'],
    MGR: ['manager'], VIEW: ['viewer'],
  };
  async function world() {
    const store = new RRS.MemoryStore();
    const clock = makeClock(START);
    const ledgers = {};
    const ledgerFor = (u) => ledgers[u] || (ledgers[u] = new RRS.Ledger(store, { holder: 'selftest-' + u, clock, sleep: () => Promise.resolve() }));
    const exec = (u, kind, payload, requestId) => ledgerFor(u).execute({ kind, payload, requestId }, { user: u });
    const ok = async (u, kind, payload, requestId) => {
      const r = await exec(u, kind, payload, requestId);
      if (!r.ok) throw new Error(`เตรียมข้อมูลไม่สำเร็จ – ${kind} โดย ${u}: ${msgs(r)}`);
      return r;
    };
    const state = async (u) => {
      const l = ledgerFor(u || 'ADMIN');
      await l.catchUp();
      return l.state;
    };
    const w = { store, clock, exec, ok, state, ledgerFor };
    await ok('ADMIN', 'system.bootstrap', { name: 'ผู้ดูแล', userId: 'ADMIN' });
    for (const id of Object.keys(USERS)) await ok('ADMIN', 'user.upsert', { id, name: id, roles: USERS[id] });
    await ok('ADMIN', 'master.import', {
      warehouses: [{ code: 'A', name: 'คลัง A' }, { code: 'B', name: 'คลัง B' }],
      bins: [{ wh: 'A', code: 'A-01' }, { wh: 'A', code: 'A-02' }, { wh: 'B', code: 'B-01' }],
      items: [
        { code: 'TST-001', name: 'ชิ้นทดสอบ 1', baseUnit: 'ชิ้น', type: 'PART' },
        { code: 'TST-002', name: 'ชิ้นทดสอบ 2', baseUnit: 'ชิ้น', type: 'PART' },
        { code: 'TST-PLATE', name: 'แผ่นทดสอบ 3 มม.', baseUnit: 'แผ่น', type: 'RM', trackLot: 'heat', certRequired: true, qcIncoming: true },
        { code: 'TST-FG', name: 'กระบะทดสอบ', baseUnit: 'ชุด', type: 'FG', qcFinal: true },
      ],
      units: [{ code: 'TST-001', unit: 'โหล', factor: 12 }],
    });
    return w;
  }
  const stockIn = (w, code, wh, bin, n, extra) =>
    w.ok('LEAD', 'doc.post', { type: 'AJ', remark: 'ยอดตั้งต้นทดสอบ', lines: [Object.assign({ code, qty: n, wh, bin }, extra || {})] });

  // ---------------------------------------------------------------------------------------------------------
  // checks (plain, with Thai details – no node:assert)
  // ---------------------------------------------------------------------------------------------------------
  const show = (v) => {
    const s = typeof v === 'string' ? `"${v}"` : JSON.stringify(v);
    return s === undefined ? 'ไม่มีค่า' : s.length > 120 ? s.slice(0, 117) + '…' : s;
  };
  function checker() {
    const fails = [];
    let n = 0;
    return {
      fails,
      get n() { return n; },
      eq(actual, expected, label) {
        n += 1;
        if (util.stable(actual) === util.stable(expected)) return true;
        fails.push(`${label}: ได้ ${show(actual)} ควรเป็น ${show(expected)}`);
        return false;
      },
      ok(cond, label, got) {
        n += 1;
        if (cond) return true;
        fails.push(got === undefined ? label : `${label} (ได้ ${show(got)})`);
        return false;
      },
      /** The command result r refused with `want` ('OK' = succeeded). */
      code(r, want, label) {
        n += 1;
        const got = codeOf(r);
        const wants = [].concat(want);
        if (wants.indexOf(got) >= 0) return true;
        fails.push(`${label}: ได้ผล ${got}${r && !r.ok ? ' (' + msgs(r).slice(0, 120) + ')' : ''} ควรเป็น ${wants.join(' หรือ ')}`);
        return false;
      },
    };
  }

  // ---------------------------------------------------------------------------------------------------------
  // shared setups (same as the phase tests)
  // ---------------------------------------------------------------------------------------------------------
  /** Phase 2: TST-FG rev A = TST-001 × 2 + TST-002 × 1, approved. */
  async function plant() {
    const w = await world();
    await w.ok('ENG', 'bom.upsert', { product: 'TST-FG', rev: 'A', lines: [{ code: 'TST-001', qty: 2 }, { code: 'TST-002', qty: 1 }] });
    await w.ok('ENG', 'bom.approve', { product: 'TST-FG', rev: 'A' });
    return w;
  }
  const jobOf = async (w, payload) => (await w.ok('PLAN', 'job.create', Object.assign({ dueDate: '2026-11-20' }, payload))).result.jobNo;
  const reserveOf = async (w, jobNo, code, wh, n, extra) =>
    (await w.ok('PLAN', 'reserve.create', Object.assign({ jobNo, code, wh, qty: n }, extra || {}))).result.id;
  const sixOf = (s, code) => RRS.planning.six(s, { code, today: TODAY })[0];
  const resOf = (s, id) => s.tables.reservations[id];
  const jobRow = (s, no) => s.tables.jobs[no];
  const jobLine = (s, no, code) => jobRow(s, no).lines.find((l) => l.code === code && !l.output);

  /** Phase 3: Express warehouse 01 = RRS warehouse A. */
  async function expressWorld(ownership) {
    const w = await world();
    await w.ok('LEAD', 'warehouse.upsert', { code: 'A', name: 'คลัง A', expressCode: '01' });
    if (ownership) await w.ok('ADMIN', 'settings.update', { patch: { ownership: { qty: ownership } } });
    return w;
  }
  const fileOf = (fileName, snapshotAt, rows) => ({ fileName, snapshotAt, rows,
    fileHash: util.sha256(fileName + '\n' + snapshotAt + '\n' + JSON.stringify(rows)) });
  const adjust = (code, wh, bin, reason) => ({ code, wh, bin, action: 'adjust', reason: reason || 'ยึดยอด Express ตามข้อตกลง ค-1' });

  /** Phase 4: SUP-A sells BUY-BOLT (ตัว, Min 100 / Max 300) in boxes of 50, MOQ 2, pack 2. */
  async function buyWorld() {
    const w = await world();
    await w.ok('PUR', 'supplier.upsert', { id: 'SUP-A', name: 'ผู้ขายทดสอบ เอ', leadDays: 10 });
    await w.ok('PUR', 'supplier.upsert', { id: 'SUP-B', name: 'ผู้ขายทดสอบ บี', leadDays: 5 });
    await w.ok('LEAD', 'item.upsert', { code: 'BUY-BOLT', name: 'สกรูทดสอบ M10', baseUnit: 'ตัว', type: 'BUY', minQty: 100, maxQty: 300 });
    await w.ok('PUR', 'itemSupplier.upsert', { code: 'BUY-BOLT', supplier: 'SUP-A', price: 120, buyUnit: 'กล่อง', factor: 50, moq: 2, pack: 2, leadDays: 7, preferred: true });
    return w;
  }
  const suggestRow = (s, code, extra) => RRS.purchasing.suggest(s, Object.assign({ today: TODAY }, extra || {})).find((r) => r.code === code);
  async function issuedPo(w, lines, supplier) {
    const r = await w.ok('PUR', 'po.create', { supplier: supplier || 'SUP-A', lines });
    await w.ok('PUR', 'po.issue', { poNo: r.result.poNo });
    return r.result.poNo;
  }
  const bolt = (n, dueDate) => ({ code: 'BUY-BOLT', qty: n, dueDate: dueDate || day(5), wh: 'A' });

  /** Phase 5 helpers. */
  const PLATE_CHARS = [
    { name: 'ความหนา', kind: 'measure', nominal: 3, min: 2.8, max: 3.2, unit: 'มม.', method: 'ไมโครมิเตอร์' },
    { name: 'ผิว', kind: 'check', method: 'ดูด้วยตา' },
  ];
  const plateOk = [{ char: 'ความหนา', value: 3.01 }, { char: 'ผิว', value: 'ผ่าน' }];
  const plateBad = [{ char: 'ความหนา', value: 2.5 }, { char: 'ผิว', value: 'ผ่าน' }];
  const FG_CHARS = [{ name: 'ความกว้างรวม', kind: 'measure', nominal: 1500, min: 1490, max: 1510, unit: 'มม.' }, { name: 'สี/ผิว', kind: 'check' }];
  const fgOk = [{ char: 'C1', value: 1500 }, { char: 'สี/ผิว', value: 'OK' }];
  const fgBad = [{ char: 'C1', value: 1520 }, { char: 'สี/ผิว', value: 'OK' }];
  const PHOTO = [{ name: 'หน้างาน', url: 'https://files.example.invalid/qc/p1.jpg' }];
  async function approvedPlan(w, code, stage, chars, extra) {
    const r = await w.ok('ENG', 'qc.plan.save', Object.assign({ code, stage, drawingRev: '', sourceRef: 'WI-QC-01', sampling: '100%', chars }, extra || {}));
    await w.ok('QCLEAD', 'qc.plan.approve', { id: r.result.id });
    return r.result.id;
  }
  const receivePlate = async (w, lot, n) =>
    (await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: n, wh: 'A', bin: 'A-01', lot }] })).result.docNo;
  async function certVerified(w, lot) {
    await w.ok('STORE1', 'lot.update', { code: 'TST-PLATE', lot, cert: { no: 'MTC-' + lot, file: 'https://files.example.invalid/cert.pdf' } });
    await w.ok('QC1', 'lot.verifyCert', { code: 'TST-PLATE', lot });
  }
  const inspectPlate = (w, planId, lot, n, results, extra, user) => w.exec(user || 'QC1', 'qc.inspect', Object.assign({ stage: 'INCOMING',
    code: 'TST-PLATE', wh: 'A', bin: 'A-01', lot, qty: n, planId, results, photos: PHOTO }, extra || {}));
  async function platesReady(w, planId, lot, n) {
    const rr = await receivePlate(w, lot, n);
    await certVerified(w, lot);
    const i = await inspectPlate(w, planId, lot, n, plateOk, { sourceDoc: rr });
    if (!i.ok) throw new Error('เตรียมแผ่นที่ผ่าน QC ไม่สำเร็จ: ' + msgs(i));
    await w.ok('QCLEAD', 'qc.release', { id: i.result.id });
    return rr;
  }

  // ---------------------------------------------------------------------------------------------------------
  // scenarios, one per criterion id (each returns a Thai summary of what it showed)
  // ---------------------------------------------------------------------------------------------------------
  const S = {};

  // ---- Phase 0 ----------------------------------------------------------------------------------------------
  S['P0-1'] = async (c) => {
    const w = await world();
    c.code(await w.exec('LEAD', 'item.upsert', { code: 'tst 001', name: 'ซ้ำ', baseUnit: 'ชิ้น' }), 'CODE_CLASH', 'รหัสที่อ่านเหมือนรหัสเดิม (tst 001)');
    await w.ok('LEAD', 'item.upsert', { code: 'TST-003', name: 'สาม', baseUnit: 'ชิ้น', expressCode: 'EXP-3', countCode: '01-0003' });
    let s = await w.state();
    c.eq((RRS.q.item(s, 'exp-3') || {}).id, 'TST-003', 'ค้นด้วยรหัส Express');
    c.eq((RRS.q.item(s, '01 0003') || {}).id, 'TST-003', 'ค้นด้วยรหัสนับสต็อก');
    c.code(await w.exec('LEAD', 'item.upsert', { code: 'TST-004', name: 'สี่', baseUnit: 'ชิ้น', expressCode: 'TST003' }), 'CODE_CLASH', 'รหัส Express ซ้ำกับรหัสสินค้าอื่น');
    c.code(await w.exec('LEAD', 'item.upsert', { create: true, code: 'TST-001', name: 'ทับ', baseUnit: 'ชิ้น' }), 'DUPLICATE', 'เพิ่มรหัสที่มีอยู่แล้ว (ไม่เขียนทับ)');
    const n0 = Object.keys(s.tables.items).length;
    const bad = await w.exec('LEAD', 'master.import', { items: [{ code: 'NEW-1', name: 'ใหม่', baseUnit: 'ชิ้น' }, { code: 'NEW-2', name: '', baseUnit: 'ชิ้น' }] });
    c.ok(!bad.ok && bad.errors[0].row === 2, 'นำเข้าข้อมูลหลักที่มีแถวผิด ต้องถูกปฏิเสธทั้งชุดพร้อมบอกแถว 2', bad.errors);
    s = await w.state();
    c.eq(Object.keys(s.tables.items).length, n0, 'จำนวนสินค้าหลังนำเข้าที่ถูกปฏิเสธ');
    await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-001', qty: 2, unit: 'โหล', wh: 'A', bin: 'A-01' }] });
    s = await w.state();
    c.eq(qty(s, { code: 'TST-001' }), 24, 'รับ 2 โหล เก็บเป็นหน่วยหลัก (ชิ้น)');
    c.code(await w.exec('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 1, unit: 'กก.', wh: 'A', bin: 'A-01' }] }), 'NO_UNIT', 'หน่วยที่ไม่มีตัวคูณ');
    c.code(await w.exec('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 1, wh: 'Z' }] }), 'NOT_FOUND', 'คลังที่ไม่มีในระบบ');
    c.code(await w.exec('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'NOPE' }] }), 'NOT_FOUND', 'ช่องเก็บที่ไม่มีในคลัง');
    c.code(await w.exec('LEAD', 'bin.upsert', { wh: 'A', code: 'A 03' }), 'BAD_CODE', 'รหัสช่องเก็บมีช่องว่าง');
    return 'ระบบปฏิเสธรหัสซ้ำ/อ่านเหมือนกัน หน่วยที่ไม่มีตัวคูณ และคลัง/ช่องที่ไม่มี; 2 โหล = 24 ชิ้น';
  };
  S['P0-2'] = async (c) => {
    const w = await world();
    let s = await w.state();
    const own = (s.tables.settings.main || {}).ownership || {};
    c.ok(['qty', 'cost', 'accountingDocs', 'qc'].every((k) => !!own[k]), 'ค่าตั้งระบบต้องระบุเจ้าของข้อมูลครบ (จำนวน ต้นทุน เอกสารบัญชี QC)', own);
    c.code(await w.exec('STORE1', 'settings.update', { patch: { ownership: { qty: 'Express' } } }), 'NO_PERMISSION', 'สโตร์เปลี่ยนเจ้าของข้อมูลเอง');
    if (loaded('reconcile')) {
      await w.ok('LEAD', 'warehouse.upsert', { code: 'A', name: 'คลัง A', expressCode: '01' });
      await stockIn(w, 'TST-001', 'A', 'A-01', 10);
      const b = (await w.ok('LEAD', 'express.import', fileOf('own.xlsx', w.clock.peek(), [{ code: 'TST-001', wh: '01', qty: 12 }]))).result.batchId;
      c.code(await w.exec('ACC', 'express.resolve', { batchId: b, lines: [adjust('TST-001', 'A', 'A-01')] }), 'OWNERSHIP', 'ปรับยอดตาม Express ขณะที่ RRS เป็นเจ้าของจำนวน');
      await w.ok('MGR', 'settings.update', { patch: { ownership: { qty: 'Express' } } });
      s = await w.state();
      c.eq([s.tables.settings.main.ownership.qty, s.tables.settings.main.ownership.cost], ['Express', own.cost], 'เจ้าของจำนวนเปลี่ยน ส่วนอื่นคงเดิม');
      await w.ok('ACC', 'express.resolve', { batchId: b, lines: [adjust('TST-001', 'A', 'A-01')] });
      s = await w.state();
      c.eq(qty(s, { code: 'TST-001' }), 12, 'เมื่อ Express เป็นเจ้าของจำนวน ปรับยอดตามไฟล์ได้');
    }
    return `เจ้าของข้อมูลตั้งต้น: จำนวน ${own.qty}, ต้นทุน ${own.cost}, เอกสารบัญชี ${own.accountingDocs}, QC ${own.qc} – ระบบทำตามที่ตั้ง`;
  };
  S['P0-3'] = async (c) => {
    const w = await world();
    await stockIn(w, 'TST-001', 'A', 'A-01', 10);
    const tr = await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 3, wh: 'A', bin: 'A-01', toWh: 'B' }] });
    await w.ok('STORE2', 'transfer.receive', { docNo: tr.result.docNo, lines: [{ line: 1, qty: 1 }] });
    const live = clone(await w.state());
    const commits = clone(w.store.commits);
    // restore = a new store holding the backup, read by a new ledger (as a restart on another machine)
    const copy = new RRS.MemoryStore();
    copy.commits = clone(commits);
    const back = new RRS.Ledger(copy, { holder: 'selftest-restore', sleep: () => Promise.resolve() });
    await back.catchUp();
    c.eq([back.state.seq, back.state.head], [live.seq, live.head], 'กู้แล้วได้ลำดับและลายนิ้วมือเท่าระบบจริง');
    c.eq(util.stable(back.state.tables.balances), util.stable(live.tables.balances), 'ยอดคงเหลือที่กู้ได้');
    c.eq(RRS.inventory.verifyBalances(back.state), [], 'ยอดที่กู้ได้ตรงกับผลรวมประวัติ');
    const forged = clone(commits);
    const eff = forged[forged.length - 1].effects.find((e) => e.v && typeof e.v.qty === 'number');
    if (eff) eff.v.qty += 1;
    c.ok(!RRS.core.verifyCommit(forged[forged.length - 1]), 'commit ที่ถูกแก้ต้องตรวจพบ (ลายนิ้วมือไม่ตรง)');
    if (loaded('reports') && RRS.reports.verifyBackup) {
      const v = RRS.reports.verifyBackup(JSON.stringify({ commits }), { compare: live });
      c.ok(v.ok, 'ตรวจไฟล์สำรองกับระบบจริงต้องผ่าน', v.problems);
      c.ok(!RRS.reports.verifyBackup(forged).ok, 'ไฟล์สำรองที่ถูกแก้ต้องไม่ผ่าน');
      c.ok(!RRS.reports.verifyBackup(commits.filter((x, i) => i !== 3)).ok, 'ไฟล์สำรองที่ขาดช่วงต้องไม่ผ่าน');
    }
    return `กู้ ${commits.length} commit ได้ยอดเท่าระบบจริง และจับไฟล์ที่ถูกแก้/ขาดช่วงได้`;
  };

  // ---- Phase 1 ----------------------------------------------------------------------------------------------
  S['P1-1'] = async (c) => {
    const w = await world();
    await stockIn(w, 'TST-001', 'A', 'A-01', 10);
    await stockIn(w, 'TST-001', 'B', 'B-01', 10);
    await w.ok('STORE1', 'doc.post', { type: 'PD', job: 'SO-1', lines: [{ code: 'TST-001', qty: 3, wh: 'B', bin: 'B-01' }] });
    const s = await w.state();
    c.eq(qty(s, { code: 'TST-001', wh: 'A' }), 10, 'ยอดคลัง A หลังเบิกจากคลัง B');
    c.eq(qty(s, { code: 'TST-001', wh: 'B' }), 7, 'ยอดคลัง B หลังเบิก 3');
    const mv = RRS.inventory.history(s, { code: 'TST-001' })[0] || {};
    c.eq([mv.wh, mv.bin, mv.by], ['B', 'B-01', 'STORE1'], 'รายการเคลื่อนไหวล่าสุด (คลัง/ช่อง/ผู้ทำ)');
    return 'เบิก 3 ชิ้นจากคลัง B: คลัง A ยังเป็น 10 คลัง B เหลือ 7';
  };
  S['P1-2'] = async (c) => {
    const w = await world();
    await stockIn(w, 'TST-002', 'A', 'A-01', 1);
    w.store.delay = 3; // both requests in flight together, through two ledgers on one store
    const [a, b] = await Promise.all([
      w.exec('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-002', qty: 1, wh: 'A', bin: 'A-01' }] }, 'req-a'),
      w.exec('STORE2', 'doc.post', { type: 'PD', lines: [{ code: 'TST-002', qty: 1, wh: 'A', bin: 'A-01' }] }, 'req-b'),
    ]);
    w.store.delay = 0;
    c.eq([a.ok, b.ok].filter(Boolean).length, 1, 'จำนวนคนที่เบิกสำเร็จ');
    const loser = a.ok ? b : a;
    c.code(loser, 'NOT_ENOUGH', 'คนที่สอง');
    const s = await w.state();
    c.eq(qty(s, { code: 'TST-002' }), 0, 'ยอดหลังเบิกพร้อมกัน');
    return `สองคนเบิกชิ้นสุดท้ายพร้อมกัน: สำเร็จ 1 คน อีกคนได้ข้อความ "${msgs(loser).slice(0, 80)}"`;
  };
  S['P1-3'] = async (c) => {
    const w = await world();
    await stockIn(w, 'TST-001', 'A', 'A-01', 5);
    const cmd = { type: 'PD', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] };
    const r1 = await w.exec('STORE1', 'doc.post', cmd, 'phone-123');
    const r2 = await w.exec('STORE1', 'doc.post', cmd, 'phone-123');
    c.eq([r1.ok, !!r2.duplicate], [true, true], 'ส่งครั้งแรกสำเร็จ ครั้งที่สองเป็นคำขอซ้ำ');
    const fresh = new RRS.Ledger(w.store, { holder: 'selftest-restart', sleep: () => Promise.resolve() });
    const r3 = await fresh.execute({ kind: 'doc.post', payload: cmd, requestId: 'phone-123' }, { user: 'STORE1' });
    c.ok(!!r3.duplicate, 'เปิดโปรแกรมใหม่แล้วส่งซ้ำ ยังรู้ว่าเป็นคำขอเดิม', codeOf(r3));
    c.eq(qty(fresh.state, { code: 'TST-001' }), 4, 'ยอดหลังส่งซ้ำ 3 ครั้ง');
    c.code(await w.exec('STORE1', 'doc.post', Object.assign({}, cmd, { remark: 'อื่น' }), 'phone-123'), 'REQUEST_REUSED', 'ใช้รหัสคำขอเดิมกับข้อมูลอื่น');
    return 'ส่งคำขอเดิม 3 ครั้ง (รวมหลังเปิดโปรแกรมใหม่) ตัดยอดครั้งเดียว: 5 → 4';
  };
  S['P1-4'] = async (c) => {
    const w = await world();
    await stockIn(w, 'TST-001', 'A', 'A-01', 5);
    const seq = (await w.state()).seq;
    const bads = [
      ['รหัสที่ไม่มี', { code: 'NO-SUCH', qty: 1, wh: 'A', bin: 'A-01' }],
      ['หน่วยที่ไม่มีตัวคูณ', { code: 'TST-001', qty: 1, unit: 'กก.', wh: 'A', bin: 'A-01' }],
      ['จำนวนไม่ใช่ตัวเลข', { code: 'TST-001', qty: 'abc', wh: 'A', bin: 'A-01' }],
      ['คลังที่ไม่มี', { code: 'TST-001', qty: 1, wh: 'Z' }],
      ['ช่องเก็บที่ไม่มี', { code: 'TST-001', qty: 1, wh: 'A', bin: 'NOPE' }],
    ];
    for (const [what, bad] of bads) {
      const r = await w.exec('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 2, wh: 'A', bin: 'A-01' }, bad] });
      c.ok(!r.ok && r.errors[0].line === 2, `บรรทัด 2 ${what}: ต้องถูกปฏิเสธและชี้บรรทัด 2`, r.ok ? 'บันทึกได้' : r.errors[0]);
    }
    const s = await w.state();
    c.eq(s.seq, seq, 'ไม่มีอะไรถูกบันทึก');
    c.eq(qty(s, { code: 'TST-001' }), 5, 'ยอดหลังเอกสารผิด 5 ใบ');
    return 'เอกสาร 5 ใบที่มีบรรทัดผิดหนึ่งบรรทัด ถูกปฏิเสธทั้งใบ ยอดคงเดิม 5';
  };
  S['P1-5'] = async (c) => {
    const w = await world();
    await stockIn(w, 'TST-001', 'A', 'A-01', 10);
    const tr = (await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01', toWh: 'B', toBin: 'B-01' }] })).result.docNo;
    let s = await w.state();
    c.eq([qty(s, { code: 'TST-001', wh: 'A' }), qty(s, { code: 'TST-001', wh: RRS.TRANSIT }), qty(s, { code: 'TST-001', wh: 'B' })], [6, 4, 0], 'ยอด A / ระหว่างโอน / B หลังส่งโอน');
    await w.ok('STORE2', 'transfer.receive', { docNo: tr, lines: [{ line: 1, qty: 1 }] });
    await w.ok('STORE2', 'transfer.receive', { docNo: tr });
    s = await w.state();
    c.eq([s.tables.documents[tr].status, qty(s, { code: 'TST-001', wh: 'B', bin: 'B-01' }), qty(s, { code: 'TST-001', wh: RRS.TRANSIT })], ['RECEIVED', 4, 0], 'รับโอนครบ');
    c.ok(!(await w.exec('LEAD', 'doc.cancel', { docNo: tr, reason: 'ทดสอบ' })).ok, 'ใบโอนที่รับแล้วต้องยกเลิกไม่ได้');
    const tr2 = (await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01', toWh: 'B' }] })).result.docNo;
    c.code(await w.exec('LEAD', 'doc.cancel', { docNo: tr2 }), 'REQUIRED', 'ยกเลิกโดยไม่ระบุเหตุผล');
    await w.ok('LEAD', 'doc.cancel', { docNo: tr2, reason: 'โอนผิดคลัง' });
    c.code(await w.exec('LEAD', 'doc.cancel', { docNo: tr2, reason: 'ซ้ำ' }), 'ALREADY_CANCELLED', 'ยกเลิกซ้ำ');
    s = await w.state();
    c.eq([qty(s, { code: 'TST-001', wh: 'A' }), qty(s, { code: 'TST-001', wh: RRS.TRANSIT })], [6, 0], 'ยอดกลับคืนครั้งเดียวหลังยกเลิกใบโอน');
    const hist = RRS.inventory.history(s, { docNo: tr2 });
    c.eq([hist.length, hist.filter((m) => m.reversalOf).length], [4, 2], 'ประวัติของใบโอนที่ยกเลิก (รายการเดิม + รายการกลับ)');
    c.eq(RRS.inventory.verifyBalances(s), [], 'ยอดทุกตำแหน่งเท่ากับผลรวมประวัติ');
    return 'โอน A→B ผ่านระหว่างโอน รับครบ; ยกเลิกใบโอนระหว่างทางยอดกลับครั้งเดียว; ยอด = ผลรวมประวัติ';
  };

  // ---- Phase 2 ----------------------------------------------------------------------------------------------
  S['P2-1'] = async (c) => {
    const w = await plant();
    await stockIn(w, 'TST-001', 'A', 'A-01', 10);
    const j1 = await jobOf(w, { soNo: 'SO-001', product: 'TST-FG', qty: 4 });
    const j2 = await jobOf(w, { soNo: 'SO-002', product: 'TST-FG', qty: 4 });
    const r1 = await reserveOf(w, j1, 'TST-001', 'A', 7);
    c.code(await w.exec('PLAN', 'reserve.create', { jobNo: j2, code: 'TST-001', wh: 'A', qty: 5 }), 'OVER_FREE', 'SO ที่สองจองเกินของพร้อมเบิก');
    const part = await w.ok('PLAN', 'reserve.create', { jobNo: j2, code: 'TST-001', wh: 'A', qty: 5, allowPartial: true });
    c.eq([part.result.qty, part.result.short], [3, 2], 'จองเท่าที่มี (ได้/ขาด)');
    c.code(await w.exec('LEAD', 'reserve.create', { jobNo: j2, code: 'TST-001', wh: 'A', qty: 1, allowPartial: true }), 'NO_FREE', 'จองเพิ่มเมื่อไม่เหลือของ');
    let s = await w.state();
    const row = sixOf(s, 'TST-001');
    c.eq([row.available, row.reserved, row.free, row.demand, row.short], [10, 10, 0, 16, 6], 'สต็อก 6 ช่อง (ใช้ได้/จอง/พร้อมเบิก/ต้องใช้/ขาด)');
    c.code(await w.exec('STORE1', 'doc.post', { type: 'OU', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] }), 'RESERVED', 'เบิกของที่จองไว้โดยไม่มีงาน');
    c.code(await w.exec('STORE1', 'doc.post', { type: 'PD', job: j2, lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01' }] }), 'RESERVED', 'SO ที่สองเบิกเกินยอดจองของตัวเอง');
    await w.ok('STORE1', 'doc.post', { type: 'PD', job: j2, lines: [{ code: 'TST-001', qty: 3, wh: 'A', bin: 'A-01' }] });
    s = await w.state();
    c.eq([resOf(s, part.result.id).status, RRS.planning.remaining(resOf(s, r1))], ['FILLED', 7], 'ใบจองหลังเบิกตามยอดจอง');
    // the same at the same moment: two planners reserve together through two ledgers
    const x = await plant();
    await stockIn(x, 'TST-002', 'A', 'A-01', 10);
    const k1 = await jobOf(x, { soNo: 'SO-101', lines: [{ code: 'TST-002', qty: 8 }] });
    const k2 = await jobOf(x, { soNo: 'SO-102', lines: [{ code: 'TST-002', qty: 8 }] });
    x.store.delay = 3;
    const [a, b] = await Promise.all([
      x.exec('PLAN', 'reserve.create', { jobNo: k1, code: 'TST-002', wh: 'A', qty: 6 }, 'rq-a'),
      x.exec('LEAD', 'reserve.create', { jobNo: k2, code: 'TST-002', wh: 'A', qty: 6 }, 'rq-b'),
    ]);
    x.store.delay = 0;
    c.eq([a.ok, b.ok].filter(Boolean).length, 1, 'จองพร้อมกันสองคน สำเร็จได้คนเดียว');
    c.code(a.ok ? b : a, 'OVER_FREE', 'คนที่จองทีหลัง');
    const xs = await x.state();
    c.eq([sixOf(xs, 'TST-002').reserved, sixOf(xs, 'TST-002').free], [6, 4], 'ยอดจอง/พร้อมเบิกหลังจองพร้อมกัน');
    return 'ของ 10 ชิ้น: SO แรกจอง 7 SO ที่สองได้แค่ 3 (ขาด 2); จองพร้อมกันสองคนรวมไม่เกินของที่มี';
  };
  S['P2-2'] = async (c) => {
    const w = await plant();
    await stockIn(w, 'TST-001', 'A', 'A-01', 10);
    const j1 = await jobOf(w, { soNo: 'SO-201', product: 'TST-FG', qty: 3 });
    const j2 = await jobOf(w, { soNo: 'SO-202', product: 'TST-FG', qty: 4 });
    const r1 = await reserveOf(w, j1, 'TST-001', 'A', 6);
    const r2 = await reserveOf(w, j2, 'TST-001', 'A', 4);
    c.code(await w.exec('PLAN', 'job.cancel', { jobNo: j1 }), 'REQUIRED', 'ยกเลิกงานโดยไม่มีเหตุผล');
    const cc = await w.ok('PLAN', 'job.cancel', { jobNo: j1, reason: 'ลูกค้ายกเลิก SO' });
    c.eq(cc.result.released.map((x) => [x.id, x.qty]), [[r1, 6]], 'ใบจองที่ปล่อยคืน');
    let s = await w.state();
    const rel = resOf(s, r1);
    c.eq([rel.status, rel.releasedBy, rel.releasedQty, !!rel.releasedAt], ['RELEASED', 'PLAN', 6, true], 'ใบจองที่ปล่อยเก็บผู้ปล่อย/เวลา/จำนวน');
    c.ok(/ลูกค้ายกเลิก SO/.test(rel.reason), 'เหตุผลการปล่อยอยู่ในใบจอง', rel.reason);
    c.eq([resOf(s, r2).status, RRS.planning.remaining(resOf(s, r2))], ['OPEN', 4], 'ใบจองของงานอื่นไม่เปลี่ยน');
    c.eq([jobRow(s, j1).status, jobRow(s, j1).cancelledBy], ['CANCELLED', 'PLAN'], 'ใบงานที่ยกเลิก');
    const row = sixOf(s, 'TST-001');
    c.eq([row.reserved, row.free, row.demand], [4, 6, 8], 'ยอดจอง/พร้อมเบิก/ต้องใช้ หลังยกเลิกงาน');
    await reserveOf(w, j2, 'TST-001', 'A', 4);
    s = await w.state();
    c.eq(sixOf(s, 'TST-001').free, 2, 'ของที่คืนจองให้งานอื่นได้');
    c.code(await w.exec('PLAN', 'job.cancel', { jobNo: j1, reason: 'ซ้ำ' }), 'ALREADY_CANCELLED', 'ยกเลิกงานซ้ำ');
    c.code(await w.exec('PLAN', 'reserve.create', { jobNo: j1, code: 'TST-001', wh: 'A', qty: 1 }), 'JOB_CLOSED', 'จองให้งานที่ยกเลิกแล้ว');
    c.code(await w.exec('STORE1', 'doc.post', { type: 'PD', job: j1, lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] }), 'JOB_CLOSED', 'เบิกเข้างานที่ยกเลิกแล้ว');
    return 'ยกเลิกงานแล้วยอดจอง 6 คืนเป็นของพร้อมเบิก (เก็บผู้ปล่อย เวลา เหตุผล) งานอื่นจองต่อได้';
  };
  S['P2-3'] = async (c) => {
    const w = await plant();
    await stockIn(w, 'TST-001', 'A', 'A-01', 10);
    const j1 = await jobOf(w, { soNo: 'SO-301', product: 'TST-FG', qty: 3 });
    const id = await reserveOf(w, j1, 'TST-001', 'A', 6);
    const line = { reservationId: id, qty: 4, wh: 'A', bin: 'A-01', scannedCode: 'TST-001' };
    const p1 = await w.exec('STORE1', 'pick.post', { jobNo: j1, lines: [line] }, 'scan-1');
    c.code(p1, 'OK', 'หยิบบางส่วน 4 จาก 6');
    const again = await w.exec('STORE1', 'pick.post', { jobNo: j1, lines: [line] }, 'scan-1');
    c.ok(!!again.duplicate, 'สแกนซ้ำ (คำขอเดิม) ไม่ตัดซ้ำ', codeOf(again));
    let s = await w.state();
    const r = resOf(s, id);
    c.eq([r.issued, r.status, RRS.planning.remaining(r), (r.uses || []).length], [4, 'PARTIAL', 2, 1], 'ใบจองหลังหยิบบางส่วน (เบิกแล้ว/สถานะ/คงเหลือ/การใช้)');
    c.eq([jobLine(s, j1, 'TST-001').issued, jobRow(s, j1).status, qty(s, { code: 'TST-001' })], [4, 'IN_PROGRESS', 6], 'ใบงานและยอดหลังหยิบ');
    const pl = RRS.planning.pickList(s, j1);
    c.eq([pl.length, pl[0] && pl[0].remaining], [1, 2], 'ใบจัดชุดเหลือหยิบ');
    const row = sixOf(s, 'TST-001');
    c.eq([row.reserved, row.free, row.demand, row.short], [2, 4, 2, 0], 'สต็อก 6 ช่องหลังหยิบบางส่วน');
    c.code(await w.exec('STORE1', 'pick.post', { jobNo: j1, lines: [{ reservationId: id, qty: 3, wh: 'A', bin: 'A-01' }] }), 'OVER_PICK', 'หยิบเกินยอดจองที่เหลือ');
    await w.ok('STORE1', 'pick.post', { jobNo: j1, lines: [{ reservationId: id, qty: 2, wh: 'A', bin: 'A-01' }] });
    s = await w.state();
    c.eq([resOf(s, id).status, RRS.planning.pickList(s, j1).length, qty(s, { code: 'TST-001' })], ['FILLED', 0, 4], 'หยิบครบ');
    c.eq(RRS.inventory.verifyBalances(s), [], 'ยอดทุกตำแหน่งเท่ากับผลรวมประวัติ');
    return 'จอง 6 หยิบ 4: ใบจองเหลือ 2 (เบิกบางส่วน) หยิบเกินถูกปฏิเสธ หยิบอีก 2 แล้วครบ';
  };
  S['P2-4'] = async (c) => {
    const w = await plant();
    const jA = await jobOf(w, { soNo: 'SO-401', product: 'TST-FG', qty: 2 });
    const jB = await jobOf(w, { soNo: 'SO-402', lines: [{ code: 'TST-FG', qty: 1 }] });
    let s = await w.state();
    let fg = sixOf(s, 'TST-FG');
    c.eq([fg.wip, fg.available, fg.free, fg.demand], [2, 0, 0, 1], 'ของกำลังผลิตไม่ใช่ของพร้อมเบิก');
    c.code(await w.exec('PLAN', 'reserve.create', { jobNo: jB, code: 'TST-FG', wh: 'A', qty: 1 }), 'NO_FREE', 'จองของที่ยังผลิตไม่เสร็จ');
    await w.ok('PROD', 'job.record', { jobNo: jA, line: 0, qty: 1 });
    await w.ok('STORE1', 'doc.post', { type: 'FR', job: jA, lines: [{ code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-01' }] });
    s = await w.state();
    c.eq([qty(s, { code: 'TST-FG', status: 'QC_HOLD' }), qty(s, { code: 'TST-FG', status: 'AVAILABLE' })], [1, 0], 'รับสินค้าที่ต้องตรวจเข้าสถานะรอตรวจ');
    fg = sixOf(s, 'TST-FG');
    c.eq([fg.onHand, fg.qcHold, fg.available, fg.free, fg.short], [1, 1, 0, 0, 1], 'ของรอตรวจไม่นับเป็นของพร้อมเบิก');
    c.code(await w.exec('PLAN', 'reserve.create', { jobNo: jB, code: 'TST-FG', wh: 'A', qty: 1 }), 'NO_FREE', 'จองของรอตรวจ');
    c.code(await w.exec('PLAN', 'reserve.auto', { jobNo: jB }), 'NOTHING', 'จองอัตโนมัติไม่หยิบของรอตรวจ');
    c.code(await w.exec('STORE1', 'doc.post', { type: 'PD', job: jB, lines: [{ code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-01' }] }), 'NOT_ENOUGH', 'เบิกของรอตรวจเป็นของใช้ได้');
    c.code(await w.exec('STORE1', 'doc.post', { type: 'PD', job: jB, lines: [{ code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-01', status: 'QC_HOLD' }] }), 'BAD_STATUS', 'เบิกโดยระบุสถานะรอตรวจ');
    c.eq((RRS.planning.readiness(s, jB).lines[0] || {}).status, 'รอตรวจ', 'ความพร้อมของงานแสดงว่ารอตรวจ');
    // a PO still to arrive shows as incoming with its date – never as free stock
    const s2 = clone(s);
    s2.tables.pos = {
      'PO6911-0001': { poNo: 'PO6911-0001', status: 'ISSUED', lines: [{ line: 1, code: 'TST-002', qty: 5, unit: 'ชิ้น', factor: 1, base: 5, dueDate: '2026-11-10', wh: 'A', received: 1, returned: 0, cancelled: 0 }] },
    };
    const inc = RRS.planning.six(s2, { code: 'TST-002', today: '2026-11-12' })[0];
    c.eq([inc.incoming, inc.nextIncomingDate, inc.available, inc.free], [4, '2026-11-10', 0, 0], 'ของคาดว่าจะเข้า (PO ค้างรับ) ไม่เป็นของพร้อมเบิก');
    const tryReserve = RRS.core.prepare(s2, { kind: 'reserve.create', payload: { jobNo: jA, code: 'TST-002', wh: 'A', qty: 1 } },
      { now: '2026-11-12T03:00:00.000Z', user: 'PLAN' });
    c.code(tryReserve, 'NO_FREE', 'จองของที่ยังไม่เข้า');
    return 'ของกำลังผลิต ของรอตรวจ และของค้างรับตาม PO ถูกแสดงแยก จองหรือเบิกเป็นของพร้อมใช้ไม่ได้';
  };

  // ---- Phase 3 ----------------------------------------------------------------------------------------------
  S['P3-1'] = async (c) => {
    const w = await expressWorld('Express');
    await stockIn(w, 'TST-001', 'A', 'A-01', 10);
    const file = fileOf('stock-01.xlsx', w.clock.peek(), [{ code: 'TST-001', wh: '01', qty: 12 }]);
    let s = await w.state();
    const balances = util.stable(s.tables.balances);
    const imp = await w.ok('LEAD', 'express.import', file);
    s = await w.state();
    c.eq(util.stable(s.tables.balances), balances, 'นำเข้าไฟล์ต้องไม่เปลี่ยนยอด');
    await w.ok('ACC', 'express.resolve', { batchId: imp.result.batchId, lines: [adjust('TST-001', 'A', 'A-01')] });
    s = await w.state();
    c.eq(qty(s, { code: 'TST-001' }), 12, 'ยอดหลังปรับตาม Express');
    const seq = s.seq;
    c.code(await w.exec('LEAD', 'express.import', file), 'DUPLICATE_FILE', 'นำเข้าไฟล์เดิมซ้ำ');
    c.code(await w.exec('ACC', 'express.import', Object.assign({}, file, { fileName: 'สำเนา.xlsx', fileHash: file.fileHash.toUpperCase() })), 'DUPLICATE_FILE', 'ไฟล์เดิมเปลี่ยนชื่อ');
    c.code(await w.exec('ACC', 'express.resolve', { batchId: imp.result.batchId, lines: [adjust('TST-001', 'A', 'A-01')] }), 'ALREADY_ADJUSTED', 'ปรับยอดแถวเดิมซ้ำ');
    s = await w.state();
    c.eq([s.seq, qty(s, { code: 'TST-001' })], [seq, 12], 'ไม่มีอะไรเปลี่ยนหลังนำเข้า/ปรับซ้ำ');
    c.eq(RRS.inventory.verifyBalances(s), [], 'ยอดทุกตำแหน่งเท่ากับผลรวมประวัติ');
    return 'ไฟล์เดิม (แม้เปลี่ยนชื่อ) นำเข้าซ้ำไม่ได้ ปรับแถวเดิมซ้ำไม่ได้ ยอดเป็น 12 ครั้งเดียว';
  };
  S['P3-2'] = async (c) => {
    const w = await expressWorld('Express');
    const t0 = w.clock.peek();
    await stockIn(w, 'TST-001', 'A', 'A-01', 10);
    const t1 = w.clock.peek();
    await w.ok('STORE1', 'doc.post', { type: 'PD', job: 'SO-9', lines: [{ code: 'TST-001', qty: 3, wh: 'A', bin: 'A-01' }] });
    const b1 = (await w.ok('LEAD', 'express.import', fileOf('t1.xlsx', t1, [{ code: 'TST-001', wh: '01', qty: 12 }]))).result.batchId;
    let s = await w.state();
    const row = RRS.reconcile.reconcile(s, b1).rows.find((r) => r.code === 'TST-001') || {};
    c.eq([row.express, row.rrsAtSnapshot, row.rrsNow, row.diff, row.status], [12, 10, 7, 2, 'DIFF'], 'ผลต่าง ณ เวลาของไฟล์');
    await w.ok('ACC', 'express.resolve', { batchId: b1, lines: [adjust('TST-001', 'A', 'A-01')] });
    s = await w.state();
    c.eq(qty(s, { code: 'TST-001', wh: 'A' }), 9, 'ปรับเฉพาะผลต่าง ณ เวลาไฟล์ (เบิกหลังไฟล์ยังอยู่)');
    await w.ok('ACC', 'express.close', { batchId: b1 });
    const imp0 = await w.ok('LEAD', 'express.import', fileOf('t0.xlsx', t0, [{ code: 'TST-001', wh: '01', qty: 5 }, { code: 'TST-002', wh: '01', qty: 4 }]));
    c.ok(imp0.result.olderThanLatest === true && has(imp0.warnings, /เก่ากว่า/), 'ไฟล์ที่เก่ากว่ารอบที่ปิดแล้วต้องถูกเตือน', imp0.warnings);
    const b0 = imp0.result.batchId;
    s = await w.state();
    const seq = s.seq;
    c.code(await w.exec('ACC', 'express.resolve', { batchId: b0, lines: [adjust('TST-002', 'A', 'A-01')] }), 'OLD_SNAPSHOT', 'ปรับยอดจากไฟล์เก่าโดยไม่ยืนยัน');
    c.code(await w.exec('ACC', 'express.resolve', { batchId: b0, confirmOld: true, lines: [adjust('TST-001', 'A', 'A-01')] }), 'STALE_ROW', 'ปรับรายการที่ถูกปรับใหม่กว่าไฟล์แล้ว');
    s = await w.state();
    c.eq([s.seq, qty(s, { code: 'TST-001' })], [seq, 9], 'ไฟล์เก่าไม่เปลี่ยนอะไรโดยอัตโนมัติ');
    await w.ok('ACC', 'express.resolve', { batchId: b0, confirmOld: true, lines: [
      adjust('TST-002', 'A', 'A-01', 'ตรวจแล้ว ไฟล์เก่ายังถูกสำหรับรหัสนี้'),
      { code: 'TST-001', wh: 'A', action: 'explain', reason: 'ไฟล์เก่า ยอดปรับแล้วในรอบก่อน' }] });
    s = await w.state();
    c.eq([qty(s, { code: 'TST-002', wh: 'A' }), qty(s, { code: 'TST-001', wh: 'A' })], [4, 9], 'ยืนยันแล้วปรับเฉพาะรายการที่ยืนยัน');
    const used = s.tables.express_batches[b0].resolutions.find((x) => x.code === 'TST-002') || {};
    c.eq([used.action, used.confirmOld, used.by], ['adjust', true, 'ACC'], 'การใช้ไฟล์เก่าถูกบันทึกพร้อมผู้ยืนยัน');
    return 'ไฟล์ที่เก่ากว่ารอบปิด: ปรับไม่ได้จนกว่าจะยืนยัน และรายการที่ถูกปรับหลังเวลาไฟล์ปรับซ้ำไม่ได้';
  };
  S['P3-3'] = async (c) => {
    const w = await world();
    await stockIn(w, 'TST-001', 'A', 'A-01', 10);
    await stockIn(w, 'TST-001', 'B', 'B-01', 10);
    await stockIn(w, 'TST-PLATE', 'B', 'B-01', 5, { lot: 'H1' });
    const ct = (await w.ok('LEAD', 'count.create', { wh: 'B' })).result.id;
    await w.ok('STORE1', 'count.enter', { id: ct, lines: [
      { code: 'TST-001', bin: 'B-01', counted: 9 }, { code: 'TST-PLATE', bin: 'B-01', lot: 'H1', counted: 5 },
      { code: 'TST-PLATE', bin: 'B-01', lot: 'H2', counted: 1 }] });
    await w.ok('STORE1', 'count.submit', { id: ct });
    const r = await w.ok('ACC', 'count.approve', { id: ct, reasons: {
      'TST-001|B-01|': 'ของเสียหายทิ้งไปแล้วไม่ได้ตัดยอด', 'TST-PLATE|B-01|H2': 'พบแผ่นล็อต H2 ที่ยังไม่ได้รับเข้า' } });
    const s = await w.state();
    const doc = s.tables.documents[r.result.docNo] || {};
    c.eq([doc.type, doc.source, doc.status], ['AJ', 'count:' + ct, 'POSTED'], 'ใบปรับยอดจากการนับ');
    c.eq((doc.lines || []).map((l) => [l.code, l.wh, l.bin, l.lot, l.base]), [['TST-001', 'B', 'B-01', '', -1], ['TST-PLATE', 'B', 'B-01', 'H2', 1]], 'บรรทัดใบปรับยอด');
    c.eq([qty(s, { code: 'TST-001', wh: 'A' }), qty(s, { code: 'TST-001', wh: 'B' }), qty(s, { code: 'TST-PLATE', wh: 'B', lot: 'H2' })], [10, 9, 1], 'ยอดหลังอนุมัติผลนับ');
    c.ok(RRS.inventory.history(s, { docNo: r.result.docNo }).every((m) => m.wh === 'B'), 'ทุกรายการเคลื่อนไหวของใบปรับยอดอยู่ที่คลัง B');
    c.eq([s.tables.count_sessions[ct].status, s.tables.count_sessions[ct].docNo], ['APPROVED', r.result.docNo], 'รอบนับอนุมัติแล้วอ้างใบปรับยอด');
    return `นับคลัง B แล้วอนุมัติ: ${r.result.docNo} ปรับเฉพาะคลัง B (−1 และ +1) คลัง A ไม่เปลี่ยน`;
  };
  S['P3-4'] = async (c) => {
    // timestamp: an issue between counting and approval is kept; only the difference at count time is adjusted
    const w = await world();
    await stockIn(w, 'TST-001', 'A', 'A-01', 10);
    const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
    let s = await w.state();
    c.eq(s.tables.count_sessions[ct].mode, 'timestamp', 'วิธีคุมเริ่มต้น');
    await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 8 }] });
    await w.ok('STORE2', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 8 }] });
    await w.ok('STORE1', 'count.submit', { id: ct });
    await w.ok('STORE1', 'doc.post', { type: 'PD', job: 'SO-1', lines: [{ code: 'TST-001', qty: 3, wh: 'A', bin: 'A-01' }] });
    s = await w.state();
    const view = RRS.reconcile.countView(s, ct);
    c.eq([view.lines[0].moved, view.lines[0].adjust, view.needsAck], [true, -2, true], 'รอบนับเห็นการเคลื่อนไหวหลังนับ');
    const reasons = { 'TST-001|A-01|': 'เบิกไม่ได้ลงเอกสาร 2 ชิ้น' };
    c.code(await w.exec('LEAD', 'count.approve', { id: ct, reasons }), 'MOVED_DURING_COUNT', 'อนุมัติโดยไม่รับทราบการเคลื่อนไหวหลังนับ');
    await w.ok('LEAD', 'count.approve', { id: ct, reasons, ack: true });
    s = await w.state();
    c.eq(qty(s, { code: 'TST-001', wh: 'A', bin: 'A-01' }), 5, 'timestamp: ยอด 7 − ผลต่าง ณ เวลานับ 2 = 5');
    // freeze: documents in the counted bins are blocked until approval
    const f = await world();
    await stockIn(f, 'TST-001', 'A', 'A-01', 10);
    await stockIn(f, 'TST-001', 'A', 'A-02', 5);
    const before = await f.ok('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] });
    await f.ok('ADMIN', 'settings.update', { patch: { policies: { countMode: 'freeze' } } });
    const fz = (await f.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
    const pd = (bin) => ({ type: 'PD', job: 'SO-2', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin }] });
    c.code(await f.exec('STORE1', 'doc.post', pd('A-01')), 'COUNT_FREEZE', 'freeze: เบิกจากช่องที่กำลังนับ');
    c.code(await f.exec('LEAD', 'doc.cancel', { docNo: before.result.docNo, reason: 'ทดสอบยกเลิกระหว่างหยุดนับ' }), 'COUNT_FREEZE', 'freeze: ยกเลิกเอกสารของช่องที่กำลังนับ');
    c.code(await f.exec('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-02', toWh: 'A', toBin: 'A-01' }] }), 'COUNT_FREEZE', 'freeze: โอนเข้าช่องที่กำลังนับ');
    c.code(await f.exec('STORE1', 'doc.post', pd('A-02')), 'OK', 'freeze: ช่องอื่นของคลังยังเบิกได้');
    await f.ok('STORE1', 'count.enter', { id: fz, lines: [{ code: 'TST-001', bin: 'A-01', counted: 8 }] });
    await f.ok('STORE1', 'count.submit', { id: fz });
    c.code(await f.exec('STORE1', 'doc.post', pd('A-01')), 'COUNT_FREEZE', 'freeze: ระหว่างรออนุมัติยังหยุดอยู่');
    await f.ok('LEAD', 'count.approve', { id: fz, reasons: { 'TST-001|A-01|': 'นับจริงได้ 8' } });
    const fs = await f.state();
    c.eq(qty(fs, { code: 'TST-001', wh: 'A', bin: 'A-01' }), 8, 'freeze: ยอดหลังอนุมัติ');
    c.code(await f.exec('STORE1', 'doc.post', pd('A-01')), 'OK', 'freeze: อนุมัติแล้วเบิกได้');
    c.eq(RRS.inventory.verifyBalances(await f.state()), [], 'ยอดทุกตำแหน่งเท่ากับผลรวมประวัติ');
    return 'timestamp: เบิกหลังนับต้องรับทราบ แล้วปรับเฉพาะผลต่าง ณ เวลานับ (7 → 5); freeze: ช่องที่นับหยุดรับ–จ่ายจนอนุมัติ';
  };
  S['P3-5'] = async (c) => {
    const w = await world();
    await stockIn(w, 'TST-001', 'A', 'A-01', 10);
    await stockIn(w, 'TST-002', 'A', 'A-01', 4);
    const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
    await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 9 }, { code: 'TST-002', bin: 'A-01', counted: 4 }] });
    await w.ok('STORE1', 'count.submit', { id: ct });
    c.code(await w.exec('LEAD', 'count.approve', { id: ct }), 'REASON_REQUIRED', 'อนุมัติยอดต่างโดยไม่มีเหตุผล');
    c.code(await w.exec('LEAD', 'count.approve', { id: ct, reasons: { 'TST-001|A-01|': '   ' } }), 'REASON_REQUIRED', 'เหตุผลว่าง');
    const r = await w.ok('LEAD', 'count.approve', { id: ct, reasons: { 'TST-001|A-01|': { reason: 'เบิกให้งาน SO-7 แล้วไม่ได้ลงเอกสาร', responsible: 'STORE2' } } });
    const s = await w.state();
    const sess = s.tables.count_sessions[ct];
    const l1 = sess.lines.find((l) => l.code === 'TST-001') || {};
    c.eq([l1.reason, l1.responsible, l1.reasonBy, !!l1.reasonAt, l1.countedBy, l1.adjust], ['เบิกให้งาน SO-7 แล้วไม่ได้ลงเอกสาร', 'STORE2', 'LEAD', true, 'STORE1', -1], 'บรรทัดยอดต่างเก็บเหตุผล ผู้รับผิดชอบ ผู้นับ ผู้อนุมัติ');
    const aj = s.tables.documents[r.result.docNo] || { lines: [] };
    c.eq([aj.lines.length, (aj.lines[0] || {}).remark], [1, 'เบิกให้งาน SO-7 แล้วไม่ได้ลงเอกสาร'], 'ใบปรับยอดมีเฉพาะบรรทัดที่ต่างพร้อมเหตุผล');
    // Express differences: every decision needs a reason and keeps who/when; a batch with open differences cannot close
    const x = await expressWorld();
    await stockIn(x, 'TST-001', 'A', 'A-01', 10);
    const b = (await x.ok('LEAD', 'express.import', fileOf('e.xlsx', x.clock.peek(), [{ code: 'TST-001', wh: '01', qty: 7 }]))).result.batchId;
    c.code(await x.exec('ACC', 'express.resolve', { batchId: b, lines: [{ code: 'TST-001', wh: 'A', action: 'explain', reason: '' }] }), 'REASON_REQUIRED', 'อธิบายผลต่าง Express โดยไม่มีเหตุผล');
    c.code(await x.exec('ACC', 'express.close', { batchId: b }), 'UNRESOLVED', 'ปิดรอบที่ยังมีผลต่างไม่ได้อธิบาย');
    await x.ok('ACC', 'express.resolve', { batchId: b, lines: [{ code: 'TST-001', wh: 'A', action: 'explain', reason: 'PD ยังไม่ได้คีย์ใน Express' }] });
    const xs = await x.state();
    const res = xs.tables.express_batches[b].resolutions[0] || {};
    c.eq([res.action, res.by, !!res.at, res.express, res.rrsAtSnapshot], ['explain', 'ACC', true, 7, 10], 'คำอธิบายผลต่าง Express เก็บผู้ตัดสินและเวลา');
    c.code(await x.exec('ACC', 'express.close', { batchId: b }), 'OK', 'ปิดรอบเมื่ออธิบายครบ');
    return 'ยอดต่างจากการนับและจาก Express อนุมัติ/ปิดรอบไม่ได้ถ้าไม่มีเหตุผล และเก็บผู้รับผิดชอบ ผู้ตัดสิน เวลา';
  };

  // ---- Phase 4 ----------------------------------------------------------------------------------------------
  S['P4-1'] = async (c) => {
    const w = await buyWorld();
    const P = RRS.purchasing;
    const poNo = await issuedPo(w, [bolt(6)]);
    let s = await w.state();
    let po = s.tables.pos[poNo];
    c.eq([po.status, po.lines[0].unit, po.lines[0].factor, po.lines[0].base], ['ISSUED', 'กล่อง', 50, 300], 'ใบสั่งซื้อ 6 กล่อง = 300 ตัว');
    const r1 = await w.ok('STORE1', 'po.receive', { poNo, lines: [{ line: 1, qty: 2, bin: 'A-01' }], supplierDoc: 'DN-778' });
    s = await w.state();
    po = s.tables.pos[poNo];
    c.eq([po.lines[0].received, P.lineOutstanding(po.lines[0]), po.status], [100, 200, 'PARTIAL'], 'รับ 2 กล่อง: รับแล้ว/ค้างรับ/สถานะ');
    const rr = s.tables.documents[r1.result.docNo] || { lines: [{}] };
    c.eq([rr.type, rr.ref, rr.lines[0].poNo, rr.lines[0].base], ['RR', poNo, poNo, 100], 'ใบรับอ้าง PO');
    let out = P.outstanding(s, { today: TODAY });
    c.eq([out.length, out[0] && out[0].outstanding, out[0] && out[0].outstandingBuy], [1, 200, 4], 'รายการค้างรับ');
    const r2 = await w.ok('STORE2', 'doc.post', { type: 'RR', lines: [{ code: 'BUY-BOLT', qty: 50, wh: 'A', bin: 'A-01', poNo, poLine: 1 }] });
    await w.ok('STORE1', 'po.receive', { poNo, lines: [{ line: 1, qty: 3, bin: 'A-02' }] });
    s = await w.state();
    c.eq([s.tables.pos[poNo].status, P.outstanding(s, { today: TODAY }).length], ['RECEIVED', 0], 'รับครบไม่มียอดค้าง');
    await w.ok('LEAD', 'doc.cancel', { docNo: r2.result.docNo, reason: 'คีย์ซ้ำ' });
    s = await w.state();
    po = s.tables.pos[poNo];
    c.eq([po.lines[0].received, po.status, (P.outstanding(s, { today: TODAY })[0] || {}).outstanding], [250, 'PARTIAL', 50], 'ยกเลิกใบรับแล้วยอดค้างรับกลับ');
    await w.ok('PURLEAD', 'po.close', { poNo, reason: 'ผู้ขายแจ้งของหมด' });
    s = await w.state();
    po = s.tables.pos[poNo];
    c.eq([po.status, po.lines[0].cancelled, P.lineOutstanding(po.lines[0])], ['CLOSED', 50, 0], 'ปิดยอดค้าง');
    c.code(await w.exec('STORE1', 'po.receive', { poNo, lines: [{ line: 1, qty: 1, bin: 'A-01' }] }), 'BAD_STATE', 'รับของจาก PO ที่ปิดแล้ว');
    c.eq(RRS.inventory.verifyBalances(s), [], 'ยอดทุกตำแหน่งเท่ากับผลรวมประวัติ');
    return 'PO 300 ตัว: รับ 100 ค้าง 200 → รับครบ → ยกเลิกใบรับ 50 ค้าง 50 → ปิดยอดค้าง';
  };
  S['P4-2'] = async (c) => {
    const w = await buyWorld();
    await stockIn(w, 'BUY-BOLT', 'A', 'A-01', 60);
    let s = await w.state();
    let r = suggestRow(s, 'BUY-BOLT');
    c.eq([r.available, r.projected, r.orderQty, r.orderBuyQty, r.status], [60, 60, 300, 6, 'ORDER'], 'คำแนะนำเมื่อยังไม่มี PO');
    const poNo = await issuedPo(w, [bolt(6, day(20))]);
    s = await w.state();
    r = suggestRow(s, 'BUY-BOLT');
    c.eq([r.incomingSure, r.incomingLater, r.orderQty], [0, 300, 300], 'PO ที่เข้าไม่ทัน Lead time ไม่ถูกหัก');
    c.ok(has(r.reasons, /เข้าไม่ทัน/), 'เหตุผลบอกว่าเข้าไม่ทัน', r.reasons);
    await w.ok('PUR', 'po.setDue', { poNo, line: 1, dueDate: day(3), reason: 'ผู้ขายยืนยันส่งเร็วขึ้น' });
    s = await w.state();
    r = suggestRow(s, 'BUY-BOLT');
    c.eq([r.incomingSure, r.projected, r.orderQty, r.status], [300, 360, 0, 'OK'], 'PO ที่เข้าทันถูกหัก ไม่แนะนำซื้อซ้ำ');
    r = suggestRow(s, 'BUY-BOLT', { today: day(10) });
    c.eq([r.incomingLate, r.incomingSure, r.orderQty], [300, 0, 300], 'PO ที่เลยกำหนดไม่นับว่าแน่นอน (นโยบาย)');
    // a PR made from the suggestion and not ordered yet is deducted too
    const x = await buyWorld();
    await stockIn(x, 'BUY-BOLT', 'A', 'A-01', 60);
    const lines = RRS.purchasing.draftPrLines(await x.state(), { today: TODAY, wh: 'A', code: 'BUY-BOLT' });
    await x.ok('STORE1', 'pr.create', { lines, source: 'แนะนำสั่งซื้อ' });
    r = suggestRow(await x.state(), 'BUY-BOLT');
    c.eq([r.pendingPr, r.orderQty, r.status], [300, 0, 'COVERED'], 'ใบขอซื้อที่ยังไม่ออก PO ถูกหัก');
    return 'PO ที่เข้าทัน Lead time และใบขอซื้อค้าง ถูกหักก่อนแนะนำ; PO ที่เข้าไม่ทัน/ล่าช้าไม่ถูกนับว่าแน่นอน';
  };
  S['P4-3'] = async (c) => {
    const w = await buyWorld();
    await w.ok('LEAD', 'item.upsert', { code: 'BUY-NUT', name: 'น็อตทดสอบ', baseUnit: 'ตัว', type: 'BUY', minQty: 10, maxQty: 20 });
    await w.ok('PUR', 'itemSupplier.upsert', { code: 'BUY-NUT', supplier: 'SUP-B', price: 30, buyUnit: 'กล่อง', factor: 12, moq: 3, pack: 2, preferred: true });
    await stockIn(w, 'BUY-NUT', 'A', 'A-01', 5);
    let r = suggestRow(await w.state(), 'BUY-NUT');
    c.eq([r.need, r.orderBuyQty, r.orderQty], [15, 4, 48], 'ต้องการ 15 → 2 กล่อง → ขั้นต่ำ 3 → แพ็กละ 2 = 4 กล่อง (48 ตัว)');
    c.ok(r.orderBuyQty >= 3 && r.orderBuyQty % 2 === 0 && r.orderQty === r.orderBuyQty * 12, 'จำนวนสั่งไม่ต่ำกว่า MOQ และเป็นทวีคูณของแพ็ก', r.orderBuyQty);
    await w.ok('PUR', 'itemSupplier.upsert', { code: 'BUY-NUT', supplier: 'SUP-B', pack: 0 });
    r = suggestRow(await w.state(), 'BUY-NUT');
    c.eq([r.orderBuyQty, r.orderQty], [3, 36], 'ไม่มีแพ็ก: สั่งตาม MOQ');
    const P = RRS.purchasing;
    c.eq([P.roundBuy(13, 12, 3, 2), P.roundBuy(0, 12, 3, 2), P.roundBuy(2.5, 1, 0, 0)], [4, 0, 3], 'การปัดจำนวนสั่ง');
    await w.ok('PUR', 'itemSupplier.upsert', { code: 'BUY-NUT', supplier: 'SUP-B', moq: 3, pack: 2 });
    const pr = await w.ok('STORE1', 'pr.create', { lines: [{ code: 'BUY-NUT', qty: 15, needDate: day(10), wh: 'A', supplier: 'SUP-B', reason: 'Min' }] });
    await w.ok('PURLEAD', 'pr.approve', { prNo: pr.result.prNo });
    const po = await w.ok('PUR', 'po.create', { supplier: 'SUP-B', prNos: [pr.result.prNo] });
    const pl = (await w.state()).tables.pos[po.result.poNo].lines[0];
    c.eq([pl.qty, pl.unit, pl.base], [4, 'กล่อง', 48], 'PO จากใบขอซื้อปัดแบบเดียวกัน');
    c.ok(has(po.warnings, /มากกว่าที่ขอซื้อค้าง/), 'แจ้งว่าสั่งมากกว่าที่ขอเพราะปัดตามแพ็ก', po.warnings);
    const small = await w.ok('PUR', 'po.create', { supplier: 'SUP-B', lines: [{ code: 'BUY-NUT', qty: 1, dueDate: day(5), wh: 'A' }] });
    c.ok(has(small.warnings, /MOQ/), 'สั่งต่ำกว่า MOQ ต้องเตือน', small.warnings);
    return 'ต้องการ 15 ตัว แนะนำ 4 กล่อง (MOQ 3 แพ็ก 2) = 48 ตัว; PO จากใบขอซื้อปัดเหมือนกันและแจ้งเหตุผล';
  };
  S['P4-4'] = async (c) => {
    const w = await buyWorld();
    await stockIn(w, 'BUY-BOLT', 'A', 'A-01', 60);
    const poNo = await issuedPo(w, [bolt(6, day(3))]);
    c.eq(suggestRow(await w.state(), 'BUY-BOLT').orderQty, 0, 'มี PO ค้างรับแล้วไม่แนะนำซื้อ');
    c.code(await w.exec('PUR', 'po.cancel', { poNo }), 'REQUIRED', 'ยกเลิก PO โดยไม่มีเหตุผล');
    await w.ok('PUR', 'po.cancel', { poNo, reason: 'ผู้ขายยกเลิกการผลิต' });
    let s = await w.state();
    const po = s.tables.pos[poNo];
    c.eq([po.status, po.lines[0].cancelled, po.cancelledBy], ['CANCELLED', 300, 'PUR'], 'PO ที่ยกเลิก');
    const r = suggestRow(s, 'BUY-BOLT');
    c.eq([r.incomingSure, r.projected, r.orderQty, r.status], [0, 60, 300, 'ORDER'], 'คำนวณแผนใหม่หลังยกเลิก PO');
    c.code(await w.exec('PUR', 'po.cancel', { poNo, reason: 'ซ้ำ' }), 'ALREADY_CANCELLED', 'ยกเลิก PO ซ้ำ');
    // a PR comes back as open when its PO is cancelled
    const x = await buyWorld();
    await stockIn(x, 'BUY-BOLT', 'A', 'A-01', 60);
    const pr = await x.ok('STORE1', 'pr.create', { lines: [{ code: 'BUY-BOLT', qty: 240, needDate: day(6), wh: 'A', reason: 'ต่ำกว่า Min' }] });
    await x.ok('PURLEAD', 'pr.approve', { prNo: pr.result.prNo });
    const first = await x.ok('PUR', 'po.create', { supplier: 'SUP-A', prNos: [pr.result.prNo] });
    await x.ok('PUR', 'po.issue', { poNo: first.result.poNo });
    await x.ok('PUR', 'po.cancel', { poNo: first.result.poNo, reason: 'ผู้ขายส่งไม่ได้' });
    s = await x.state();
    c.eq(RRS.purchasing.prOpen(s, pr.result.prNo).lines[0].open, 240, 'ใบขอซื้อกลับมาค้างออก PO');
    c.code(await x.exec('PUR', 'po.create', { supplier: 'SUP-A', prNos: [pr.result.prNo] }), 'OK', 'ออก PO ใหม่จากใบขอซื้อเดิม');
    return 'ยกเลิก PO แล้วของค้างรับหายจากแผน แนะนำสั่ง 300 อีกครั้ง และใบขอซื้อกลับมาออก PO ใหม่ได้';
  };
  S['P4-5'] = async (c) => {
    const w = await buyWorld();
    await w.ok('PUR', 'itemSupplier.upsert', { code: 'TST-PLATE', supplier: 'SUP-A', price: 2500, preferred: true });
    await w.ok('PUR', 'reorder.set', { code: 'TST-PLATE', min: 10, max: 20 });
    const poNo = await issuedPo(w, [{ code: 'TST-PLATE', qty: 20, dueDate: day(5), wh: 'A' }]);
    c.code(await w.exec('STORE1', 'po.receive', { poNo, lines: [{ line: 1, qty: 20, bin: 'A-02' }] }), 'LOT_REQUIRED', 'รับแผ่นโดยไม่ระบุ Heat');
    await w.ok('STORE1', 'po.receive', { poNo, lines: [{ line: 1, qty: 20, bin: 'A-02', lot: 'H-001' }] });
    const s = await w.state();
    c.eq([qty(s, { code: 'TST-PLATE', status: 'QC_HOLD' }), qty(s, { code: 'TST-PLATE', status: 'AVAILABLE' })], [20, 0], 'รับแล้วเข้ารอตรวจ');
    const r = suggestRow(s, 'TST-PLATE');
    c.eq([r.available, r.qcHold, r.free, r.projected], [0, 20, 0, 0], 'ของรอตรวจไม่เพิ่มยอดใช้ได้/พร้อมเบิก');
    c.eq([r.qcCovered, r.orderQty, r.status], [20, 0, 'COVERED'], 'ไม่ซื้อซ้ำเพราะของอยู่ระหว่างตรวจ');
    c.code(await w.exec('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-PLATE', qty: 1, wh: 'A', bin: 'A-02', lot: 'H-001' }] }), 'NOT_ENOUGH', 'เบิกของรอตรวจ');
    return 'รับแผ่น 20 แผ่นเข้ารอตรวจ: ยอดพร้อมเบิกยังเป็น 0 เบิกไม่ได้ และไม่ถูกแนะนำซื้อซ้ำ';
  };

  // ---- Phase 5 ----------------------------------------------------------------------------------------------
  const HAS_PO = () => !!RRS.schema.tables.pos;
  S['P5-1'] = async (c) => {
    const Q = RRS.quality;
    const w = await world();
    const platePlan = await approvedPlan(w, 'TST-PLATE', 'INCOMING', PLATE_CHARS);
    const fgPlan = await approvedPlan(w, 'TST-FG', 'FINAL', FG_CHARS);
    const rr = await platesReady(w, platePlan, 'HT-7788', 10);
    await receivePlate(w, 'HT-9999', 2);
    const pd1 = (await w.ok('STORE1', 'doc.post', { type: 'PD', job: 'JOB-01', lines: [{ code: 'TST-PLATE', qty: 4, wh: 'A', bin: 'A-01', lot: 'HT-7788' }] })).result.docNo;
    const pd2 = (await w.ok('STORE1', 'doc.post', { type: 'PD', job: 'JOB-02', lines: [{ code: 'TST-PLATE', qty: 3, wh: 'A', bin: 'A-01', lot: 'HT-7788' }] })).result.docNo;
    const rt = (await w.ok('STORE1', 'doc.post', { type: 'RT', job: 'JOB-01', lines: [{ code: 'TST-PLATE', qty: 1, wh: 'A', bin: 'A-01', lot: 'HT-7788' }] })).result.docNo;
    const fr = (await w.ok('LEAD', 'doc.post', { type: 'FR', job: 'JOB-01', lines: [{ code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-01' }] })).result.docNo;
    const fi = await w.ok('QC1', 'qc.inspect', { stage: 'FINAL', code: 'TST-FG', wh: 'A', bin: 'A-01', qty: 1, sourceDoc: fr, planId: fgPlan, results: fgOk, photos: PHOTO });
    await w.ok('QCLEAD', 'qc.release', { id: fi.result.id });
    const dl = (await w.ok('STORE1', 'doc.post', { type: 'DL', job: 'JOB-01', lines: [{ code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-01' }] })).result.docNo;
    const s = await w.state();
    c.eq(Q.findLots(s, 'ht 7788').map((l) => l.code + ' ' + l.lot), ['TST-PLATE HT-7788'], 'ค้นด้วยเลข Heat (ไม่สนช่องว่าง/ขีด/ตัวพิมพ์)');
    const t = Q.trace(s, { lot: 'HT-7788' });
    c.eq([t.lot.code, t.lot.kind, t.lot.docNo, t.lot.cert.verified], ['TST-PLATE', 'heat', rr, true], 'ข้อมูลล็อต (ใบรับแรก ใบรับรอง)');
    c.eq(t.receipts.map((e) => e.docNo), [rr, rt], 'ใบรับของ Heat นี้');
    c.eq(t.issues.map((e) => [e.docNo, e.job, e.qty]), [[pd1, 'JOB-01', 4], [pd2, 'JOB-02', 3]], 'ใบเบิกและงานที่ใช้');
    c.eq(t.jobs, ['JOB-01', 'JOB-02'], 'งานที่ใช้ Heat นี้');
    c.eq([t.outputs.map((e) => e.docNo), t.deliveries.map((e) => e.docNo)], [[fr], [dl]], 'ผลผลิตและการส่งมอบของงาน');
    c.ok(JSON.stringify(t).indexOf('HT-9999') < 0, 'ไม่ปน Heat อื่น');
    const j = Q.traceJob(s, 'job-01');
    const l0 = j.lots[0] || {};
    c.eq([j.lots.length, l0.lot, l0.issued, l0.returned, l0.qty], [1, 'HT-7788', 4, 1, 3], 'ย้อนจากงานไปหาล็อตที่ใช้');
    c.eq((l0.receipts || []).map((x) => x.docNo), [rr], 'ล็อตของงานอ้างใบรับ');
    return `ค้น HT-7788 พบใบรับ ${rr} ใบเบิก ${pd1}, ${pd2} งาน JOB-01/JOB-02 และการส่งมอบ ${dl}`;
  };
  S['P5-2'] = async (c) => {
    const w = await world();
    const plan = await approvedPlan(w, 'TST-PLATE', 'INCOMING', PLATE_CHARS);
    await stockIn(w, 'TST-PLATE', 'A', 'A-01', 10, { lot: 'H1', status: 'AVAILABLE' });
    await stockIn(w, 'TST-PLATE', 'B', 'B-01', 5, { lot: 'H1', status: 'AVAILABLE' });
    const rr = (await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 4, wh: 'A', bin: 'A-02', lot: 'H1' }] })).result.docNo;
    const open = await w.ok('QC1', 'qc.inspect', { stage: 'INCOMING', code: 'TST-PLATE', wh: 'A', bin: 'A-02', lot: 'H1', qty: 4, planId: plan, results: plateOk, sourceDoc: rr });
    await stockIn(w, 'TST-PLATE', 'A', 'A-01', 3, { lot: 'H2', status: 'AVAILABLE' });
    const q = await w.ok('QC1', 'lot.quarantine', { code: 'TST-PLATE', lot: 'H1', reason: 'ใบรับรองไม่ตรงกับ heat ที่ตอกบนแผ่น' });
    let s = await w.state();
    c.eq([q.result.moved, qty(s, { code: 'TST-PLATE', lot: 'H1', status: 'QUARANTINE' }), qty(s, { code: 'TST-PLATE', lot: 'H2', status: 'AVAILABLE' })], [19, 19, 3], 'กักล็อต H1 ทุกคลัง (H2 ยังใช้ได้)');
    c.eq([s.tables.lots['TST-PLATE|H1'].status, s.tables.inspections[open.result.id].status], ['QUARANTINED', 'VOID'], 'ล็อตถูกกัก และผลผ่านที่รอปล่อยเป็นโมฆะ');
    const seq = s.seq;
    const line = (extra) => Object.assign({ code: 'TST-PLATE', qty: 1, wh: 'A', bin: 'A-01', lot: 'H1' }, extra || {});
    for (const [user, type, l] of [['STORE1', 'PD', line()], ['STORE1', 'OU', line()], ['STORE1', 'DL', line()],
      ['STORE1', 'TR', line({ toWh: 'B', toBin: 'B-01' })], ['LEAD', 'AJ', line({ qty: -1 })], ['STORE1', 'PD', line({ wh: 'B', bin: 'B-01' })]]) {
      c.code(await w.exec(user, 'doc.post', { type, job: 'JOB-X', lines: [l] }), 'LOT_QUARANTINED', `ช่องทาง ${type}${l.wh === 'B' ? ' คลัง B' : ''}`);
    }
    c.ok(!(await w.exec('STORE1', 'doc.post', { type: 'PD', lines: [line({ status: 'QUARANTINE' })] })).ok, 'เบิกโดยระบุสถานะกักกันต้องไม่ได้');
    const draft = await w.ok('STORE1', 'doc.saveDraft', { type: 'PD', job: 'JOB-X', lines: [line()] });
    c.code(await w.exec('STORE1', 'doc.post', { docNo: draft.result.docNo }), 'LOT_QUARANTINED', 'ช่องทาง ร่าง → บันทึก');
    c.code(await inspectPlate(w, plan, 'H1', 1, plateOk, { fromStatus: 'QUARANTINE' }), 'BAD_STATUS', 'ตรวจของกักกันเพื่อปล่อย');
    c.code(await w.exec('QCLEAD', 'qc.release', { id: open.result.id }), 'BAD_STATE', 'ปล่อยผลตรวจที่เป็นโมฆะ');
    c.code(await w.exec('LEAD', 'doc.post', { type: 'SC', remark: 'เสีย', lines: [line({ status: 'QUARANTINE' })] }), 'NCR_REQUIRED', 'ตัดทิ้งของกักกันโดยไม่ผ่าน NCR');
    s = await w.state();
    c.eq([s.seq, qty(s, { code: 'TST-PLATE', lot: 'H1', status: 'QUARANTINE' })], [seq + 1, 19], 'ไม่มีของออกจากกักกัน (บันทึกได้เฉพาะร่าง)');
    const again = await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 2, wh: 'B', bin: 'B-01', lot: 'H1' }] });
    s = await w.state();
    c.ok(has(again.warnings, /กักกัน/) && qty(s, { code: 'TST-PLATE', lot: 'H1', status: 'QUARANTINE' }) === 21, 'รับล็อตที่ถูกกักเพิ่ม เข้าเป็นกักกันทันที', again.warnings);
    return 'กักล็อต H1: เบิก/จ่าย/ส่งมอบ/โอน/ปรับลด/ร่าง/ตรวจปล่อย/ตัดทิ้งตรงถูกบล็อกทุกทาง ของรับใหม่เข้ากักกัน';
  };
  S['P5-3'] = async (c) => {
    const w = await world();
    const plan = await approvedPlan(w, 'TST-PLATE', 'INCOMING', PLATE_CHARS);
    const rr = await receivePlate(w, 'L-REL', 6);
    const i = await w.ok('QC1', 'qc.inspect', { stage: 'INCOMING', code: 'TST-PLATE', wh: 'A', bin: 'A-01', lot: 'L-REL', qty: 6, planId: plan, results: plateOk, sourceDoc: rr });
    const id = i.result.id;
    let s = await w.state();
    c.eq([i.result.result, s.tables.inspections[id].status], ['PASS', 'OPEN'], 'ผลผ่านยังรออนุมัติปล่อย');
    for (const u of ['QC1', 'STORE1', 'LEAD', 'ENG', 'PROD', 'VIEW', 'GHOST']) {
      c.code(await w.exec(u, 'qc.release', { id }), ['NO_PERMISSION', 'NO_USER'], `${u} ปล่อยผ่าน`);
    }
    c.code(await w.exec('QCLEAD', 'qc.release', { id }), 'CERT_MISSING', 'ปล่อยผ่านก่อนมีใบรับรองวัสดุ');
    await w.ok('STORE1', 'lot.update', { code: 'TST-PLATE', lot: 'L-REL', cert: { no: 'MTC-1' } });
    c.code(await w.exec('QCLEAD', 'qc.release', { id }), 'CERT_NOT_VERIFIED', 'ปล่อยผ่านก่อน QC ตรวจใบรับรอง');
    c.code(await w.exec('STORE1', 'lot.verifyCert', { code: 'TST-PLATE', lot: 'L-REL' }), 'NO_PERMISSION', 'สโตร์ตรวจใบรับรองเอง');
    await w.ok('QC1', 'lot.verifyCert', { code: 'TST-PLATE', lot: 'L-REL' });
    await w.ok('ADMIN', 'user.upsert', { id: 'QCB', name: 'หัวหน้า QC คลัง B', roles: ['qc_lead'], warehouses: ['B'] });
    c.code(await w.exec('QCB', 'qc.release', { id }), 'NO_PERMISSION', 'หัวหน้า QC ที่มีสิทธิ์เฉพาะคลัง B ปล่อยของคลัง A');
    c.code(await w.exec('LEAD', 'doc.post', { type: 'QS', lines: [{ code: 'TST-PLATE', qty: 6, wh: 'A', bin: 'A-01', lot: 'L-REL' }] }), ['BAD_TYPE', 'QS_MANUAL'], 'เปลี่ยนสถานะคุณภาพด้วยเอกสารเอง');
    s = await w.state();
    c.eq([qty(s, { code: 'TST-PLATE', status: 'QC_HOLD' }), s.tables.inspections[id].status], [6, 'OPEN'], 'ของยังรอตรวจ');
    c.eq((RRS.quality.releaseCheck(s, id, 'QC1')[0] || {}).code, 'SAME_PERSON', 'ผู้ตรวจปล่อยผลของตัวเอง');
    await w.ok('QCLEAD', 'qc.release', { id });
    s = await w.state();
    c.eq([qty(s, { code: 'TST-PLATE', status: 'AVAILABLE' }), s.tables.inspections[id].releasedBy], [6, 'QCLEAD'], 'หัวหน้า QC ปล่อยผ่านแล้วของใช้ได้');
    c.code(await w.exec('QCLEAD', 'qc.release', { id }), 'ALREADY_RELEASED', 'ปล่อยซ้ำ');
    await receivePlate(w, 'L-BAD', 2);
    const bad = await inspectPlate(w, plan, 'L-BAD', 2, plateBad);
    c.code(await w.exec('QCLEAD', 'qc.release', { id: bad.result.id }), 'NOT_PASS', 'ปล่อยผลที่ไม่ผ่าน');
    return 'ผู้ตรวจ สโตร์ วิศวกรรม ผลิต ผู้ดู และหัวหน้า QC ต่างคลังปล่อยไม่ได้; หัวหน้า QC ปล่อยได้เมื่อใบรับรองตรวจแล้ว';
  };
  S['P5-4'] = async (c) => {
    const Q = RRS.quality;
    const w = await world();
    await w.ok('ENG', 'item.upsert', { code: 'QC-BRK', name: 'ขายึดทดสอบ', baseUnit: 'ชิ้น', type: 'PART', trackLot: 'lot', qcIncoming: true, drawingNo: 'DWG-100', drawingRev: 'A' });
    const chars = [{ name: 'ความยาว', kind: 'measure', nominal: 100, min: 99.5, max: 100.5, unit: 'มม.' }, { name: 'รูเจาะ', kind: 'check' }];
    const planA = await approvedPlan(w, 'QC-BRK', 'INCOMING', chars, { drawingRev: 'A', sourceRef: 'DWG-100 rev A' });
    const insp = (lot, n, value, extra) => w.exec('QC1', 'qc.inspect', Object.assign({ stage: 'INCOMING', code: 'QC-BRK', wh: 'A', bin: 'A-01', lot, qty: n,
      planId: planA, results: [{ char: 'ความยาว', value }, { char: 'รูเจาะ', value: true }], photos: PHOTO }, extra || {}));
    await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'QC-BRK', qty: 5, wh: 'A', bin: 'A-01', lot: 'L1' }] });
    const f = await insp('L1', 5, 101);
    const ncrNo = f.result.ncrNo;
    let s = await w.state();
    c.eq([f.result.result, s.tables.inspections[f.result.id].planRev, s.tables.ncrs[ncrNo].status], ['FAIL', 'A', 'OPEN'], 'ผลไม่ผ่านเปิด NCR');
    await w.ok('QCLEAD', 'ncr.disposition', { ncrNo, disposition: 'REWORK', reason: 'เจียความยาวให้ได้ตามแบบ' });
    c.code(await w.exec('QCLEAD', 'ncr.close', { ncrNo }), 'REINSPECTION_PENDING', 'ปิด NCR แก้ไขงานก่อนตรวจซ้ำ');
    c.code(await insp('L1', 5, 100.1, { fromStatus: 'REWORK' }), 'REINSPECTION_REQUIRED', 'ตรวจของรอแก้ไขโดยไม่อ้างผลเดิม');
    await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'QC-BRK', qty: 2, wh: 'A', bin: 'A-01', lot: 'L9' }] });
    const pass9 = await insp('L9', 2, 100);
    c.code(await insp('L1', 5, 100.1, { fromStatus: 'REWORK', reinspectionOf: pass9.result.id }), 'NOT_FAIL', 'ตรวจซ้ำอ้างผลที่ผ่าน');
    c.code(await insp('L9', 2, 100.1, { fromStatus: 'REWORK', reinspectionOf: f.result.id }), 'REINSPECT_MISMATCH', 'ตรวจซ้ำคนละล็อตกับผลเดิม');
    const re = await insp('L1', 5, 100.1, { fromStatus: 'REWORK', reinspectionOf: ncrNo });
    s = await w.state();
    const r1 = s.tables.inspections[re.result.id] || {};
    c.eq([re.result.result, r1.reinspectionOf, r1.reinspectionNcr, r1.planRev, r1.revChanged], ['PASS', f.result.id, ncrNo, 'A', false], 'ตรวจซ้ำผูกผลเดิม NCR และฉบับแบบเดิม');
    await w.ok('QCLEAD', 'qc.release', { id: re.result.id });
    await w.ok('QCLEAD', 'ncr.close', { ncrNo, note: 'แก้แล้วผ่าน' });
    // the drawing changes to rev B while lot L2 waits for its re-inspection
    await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'QC-BRK', qty: 3, wh: 'A', bin: 'A-01', lot: 'L2' }] });
    const f2 = await insp('L2', 3, 98);
    await w.ok('QCLEAD', 'ncr.disposition', { ncrNo: f2.result.ncrNo, disposition: 'REWORK', reason: 'เชื่อมต่อความยาว' });
    await w.ok('ENG', 'bom.upsert', { product: 'QC-BRK', rev: 'B', lines: [{ code: 'TST-PLATE', qty: 1 }] });
    await w.ok('ENG', 'bom.approve', { product: 'QC-BRK', rev: 'B' });
    s = await w.state();
    c.eq([s.tables.items['QC-BRK'].drawingRev, Q.planFor(s, 'QC-BRK', 'INCOMING').stale], ['B', true], 'แบบเปลี่ยนฉบับ แผนเดิมล้าสมัย');
    c.code(await insp('L2', 3, 100, { fromStatus: 'REWORK', reinspectionOf: f2.result.id }), 'PLAN_REV_STALE', 'ตรวจซ้ำด้วยแผนของแบบฉบับเก่า');
    const planB = (await w.ok('ENG', 'qc.plan.save', { code: 'QC-BRK', stage: 'INCOMING', drawingRev: 'B', sourceRef: 'DWG-100 rev B',
      chars: [{ name: 'ความยาว', kind: 'measure', nominal: 98, min: 97.5, max: 98.5, unit: 'มม.' }, { name: 'รูเจาะ', kind: 'check' }] })).result.id;
    c.code(await w.exec('ENG', 'qc.plan.approve', { id: planB }), 'SAME_PERSON', 'ผู้ทำแผนอนุมัติแผนของตัวเอง');
    await w.ok('QCLEAD', 'qc.plan.approve', { id: planB });
    const re2 = await w.exec('QC1', 'qc.inspect', { stage: 'INCOMING', code: 'QC-BRK', wh: 'A', bin: 'A-01', lot: 'L2', qty: 3, fromStatus: 'REWORK',
      reinspectionOf: f2.result.id, planId: planB, results: [{ char: 'C1', value: 98 }, { char: 'C2', value: 'OK' }] });
    c.code(re2, 'OK', 'ตรวจซ้ำด้วยแผนฉบับใหม่');
    s = await w.state();
    const r2 = (re2.ok && s.tables.inspections[re2.result.id]) || {};
    c.eq([r2.result, r2.reinspectionOf, r2.planRev, r2.revChanged], ['PASS', f2.result.id, 'B', true], 'ตรวจซ้ำหลังแบบเปลี่ยน: ผูกผลเดิมและบันทึกว่าแบบเปลี่ยน');
    c.eq(s.tables.inspections[f2.result.id].planRev, 'A', 'ผลเดิมยังเก็บฉบับแบบเดิม');
    return 'ตรวจซ้ำต้องอ้างผลไม่ผ่าน/NCR ของสินค้าและล็อตเดียวกัน ใช้แบบฉบับเดิม หรือบันทึกว่าแบบเปลี่ยนเมื่อใช้ฉบับใหม่';
  };
  S['P5-5'] = async (c) => {
    const w = await world();
    const finalPlan = await approvedPlan(w, 'TST-FG', 'FINAL', FG_CHARS);
    const fr = (await w.ok('LEAD', 'doc.post', { type: 'FR', job: 'JOB-9', lines: [{ code: 'TST-FG', qty: 2, wh: 'A', bin: 'A-01' }] })).result.docNo;
    let s = await w.state();
    c.eq([qty(s, { code: 'TST-FG', status: 'QC_HOLD' }), qty(s, { code: 'TST-FG', status: 'AVAILABLE' })], [2, 0], 'ผลิตเสร็จเข้ารอตรวจ');
    const dl = (extra) => w.exec('STORE1', 'doc.post', { type: 'DL', job: 'JOB-9', lines: [Object.assign({ code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-01' }, extra || {})] });
    c.code(await dl(), 'NOT_ENOUGH', 'ส่งมอบของที่ยังไม่ผ่าน QC');
    c.code(await dl({ status: 'QC_HOLD' }), 'BAD_STATUS', 'ส่งมอบโดยระบุสถานะรอตรวจ');
    const i = await w.ok('QC1', 'qc.inspect', { stage: 'FINAL', code: 'TST-FG', wh: 'A', bin: 'A-01', qty: 2, sourceDoc: fr, planId: finalPlan, results: fgOk, photos: PHOTO });
    s = await w.state();
    c.eq([s.tables.inspections[i.result.id].jobNo, s.tables.inspections[i.result.id].status], ['JOB-9', 'OPEN'], 'ผลตรวจผ่านผูกงานและรออนุมัติปล่อย');
    c.code(await dl(), 'NOT_ENOUGH', 'ส่งมอบของที่ตรวจผ่านแต่ยังไม่ปล่อย');
    const r1 = await w.ok('QCLEAD', 'qc.release', { id: i.result.id, qty: 1 });
    c.eq(r1.result.done, false, 'ปล่อยบางส่วน');
    c.code(await dl(), 'OK', 'ส่งมอบชิ้นที่ปล่อยแล้ว');
    c.code(await dl(), 'NOT_ENOUGH', 'ส่งมอบเกินที่ปล่อย');
    const fr2 = (await w.ok('LEAD', 'doc.post', { type: 'FR', job: 'JOB-9', lines: [{ code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-01' }] })).result.docNo;
    const bad = await w.ok('QC1', 'qc.inspect', { stage: 'FINAL', code: 'TST-FG', wh: 'A', bin: 'A-01', qty: 1, sourceDoc: fr2, planId: finalPlan, results: fgBad, photos: PHOTO });
    s = await w.state();
    c.ok(!!bad.result.ncrNo && qty(s, { code: 'TST-FG', status: 'QUARANTINE' }) === 1, 'ผลไม่ผ่านก่อนส่งมอบเข้ากักกันพร้อม NCR', bad.result);
    c.eq(RRS.inventory.verifyBalances(s), [], 'ยอดทุกตำแหน่งเท่ากับผลรวมประวัติ');
    return 'ผลิตเสร็จ 2 ชุดเข้ารอตรวจ: ส่งมอบไม่ได้จนตรวจผ่านและหัวหน้า QC ปล่อย ส่งได้เท่าที่ปล่อย ไม่ผ่านเข้ากักกัน';
  };
  S['P5-6'] = async (c) => {
    const Q = RRS.quality;
    const w = await world();
    const plan = await approvedPlan(w, 'TST-PLATE', 'INCOMING', PLATE_CHARS);
    const rr = await receivePlate(w, 'H5', 10);
    await certVerified(w, 'H5');
    const a = await inspectPlate(w, plan, 'H5', 3, plateBad, { sourceDoc: rr });
    const b = await inspectPlate(w, plan, 'H5', 2, [{ char: 'ความหนา', value: 3 }, { char: 'ผิว', value: 'ไม่ผ่าน' }], { sourceDoc: rr });
    const p = await inspectPlate(w, plan, 'H5', 5, plateOk, { sourceDoc: rr });
    c.eq([codeOf(a) === 'OK' && a.result.result, codeOf(b) === 'OK' && b.result.result, codeOf(p) === 'OK' && p.result.result], ['FAIL', 'FAIL', 'PASS'], 'ผลตรวจสามชุด');
    await w.ok('QCLEAD', 'qc.release', { id: p.result.id });
    const ret = await w.ok('QCLEAD', 'ncr.disposition', { ncrNo: a.result.ncrNo, disposition: 'RETURN', reason: 'ความหนาต่ำกว่าเกณฑ์ ผู้ขายรับคืน' });
    const scr = await w.ok('ENG', 'ncr.disposition', { ncrNo: b.result.ncrNo, disposition: 'SCRAP', reason: 'ผิวเป็นสนิมลึก ใช้ไม่ได้' });
    const s = await w.state();
    c.eq([ret.result.docType, scr.result.docType], ['RV', 'SC'], 'คืนผู้ขายเป็น RV ตัดทิ้งเป็น SC');
    const rv = s.tables.documents[ret.result.docNo] || { lines: [{}] };
    c.eq([rv.status, rv.ref, rv.lines[0].status, rv.lines[0].base, rv.lines[0].lot], ['POSTED', a.result.ncrNo, 'QUARANTINE', 3, 'H5'], 'ใบคืนผู้ขายตัดจากของกักกัน');
    c.eq([qty(s, { code: 'TST-PLATE', status: 'QUARANTINE' }), qty(s, { code: 'TST-PLATE', status: 'AVAILABLE' }), qty(s, { code: 'TST-PLATE' })], [0, 5, 5], 'ยอดหลังคืน/ตัดทิ้ง');
    c.eq(RRS.inventory.history(s, { docNo: rv.docNo }).map((m) => [m.qty, m.status, m.by]), [[-3, 'QUARANTINE', 'QCLEAD']], 'ประวัติใบคืนผู้ขาย');
    const na = s.tables.ncrs[a.result.ncrNo];
    c.eq([na.status, na.disposition, na.dispositionBy, na.docNo], ['DISPOSITIONED', 'RETURN', 'QCLEAD', rv.docNo], 'NCR เก็บการตัดสิน ผู้ตัดสิน และเอกสาร');
    const t = Q.trace(s, { code: 'TST-PLATE', lot: 'H5' });
    c.eq(t.issues.map((e) => e.type).sort(), ['RV', 'SC'], 'สอบกลับ Heat เห็นการคืนและตัดทิ้ง');
    c.eq(util.round(RRS.inventory.history(s, { code: 'TST-PLATE', lot: 'H5' }).reduce((x, m) => x + m.qty, 0)), 5, 'ผลรวมประวัติของ Heat = ยอดคงเหลือ');
    c.eq(RRS.inventory.verifyBalances(s), [], 'ยอดทุกตำแหน่งเท่ากับผลรวมประวัติ');
    return 'รับ 10 ไม่ผ่าน 5: คืนผู้ขาย 3 (RV) ตัดทิ้ง 2 (SC) จากของกักกัน เหลือใช้ได้ 5 ประวัติครบ';
  };

  // ---- Phase 6 ----------------------------------------------------------------------------------------------
  S['P6-1'] = async (c) => {
    const R = RRS.reports;
    const w = await world();
    await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 5, wh: 'A', bin: 'A-01', lot: 'H1' }] });
    await stockIn(w, 'TST-001', 'A', 'A-01', 20);
    await stockIn(w, 'TST-002', 'A', 'A-02', 3, { status: 'QUARANTINE' });
    const pd = { type: 'PD', lines: [{ code: 'TST-001', qty: 5, wh: 'A', bin: 'A-01' }] };
    await w.ok('STORE1', 'doc.post', pd, 'phone-pd-1');
    c.ok(!!(await w.exec('STORE1', 'doc.post', pd, 'phone-pd-1')).duplicate, 'เบิกซ้ำด้วยคำขอเดิมไม่ตัดซ้ำ');
    await w.ok('LEAD', 'doc.post', { type: 'FR', lines: [{ code: 'TST-FG', qty: 2, wh: 'A', bin: 'A-02' }] });
    await w.ok('STORE1', 'doc.post', { type: 'RT', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] });
    const tr = await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01', toWh: 'B', toBin: 'B-01' }] });
    await w.ok('STORE2', 'transfer.receive', { docNo: tr.result.docNo });
    const ou = await w.ok('STORE1', 'doc.post', { type: 'OU', lines: [{ code: 'TST-001', qty: 1, wh: 'B', bin: 'B-01' }] });
    await w.ok('LEAD', 'doc.cancel', { docNo: ou.result.docNo, reason: 'ทดสอบยกเลิก' });
    c.code(await w.exec('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-PLATE', qty: 1, wh: 'A', bin: 'A-01', lot: 'H1', status: 'QC_HOLD' }] }), 'BAD_STATUS', 'เบิกของรอตรวจ');
    const s = clone(await w.state());
    c.eq([qty(s, { code: 'TST-001', wh: 'A' }), qty(s, { code: 'TST-001', wh: 'B' })], [12, 4], 'ยอดหลังรับ–เบิก–คืน–โอน–ยกเลิก');
    const chk = R.dailyCheck(s);
    c.eq([chk.ok, chk.problems, chk.quarantineLeaks, chk.doublePosted], [true, [], [], []], 'ตรวจยอดประจำวันของข้อมูลจริง');
    // the same check catches the serious errors when the data is damaged on purpose
    const m = RRS.inventory.history(s, { code: 'TST-001', wh: 'A' }).find((x) => x.docType === 'PD');
    const k = RRS.balanceKey(m);
    const s1 = clone(s);
    s1.tables.balances[k].qty += 1;
    c.ok(!R.dailyCheck(s1).ok, 'ยอดคลาดเคลื่อนจากประวัติต้องถูกจับได้');
    const s2 = clone(s);
    s2.tables.movements['999.1'] = Object.assign({}, m, { id: '999.1', seq: 999 });
    s2.tables.balances[k].qty += m.qty;
    const c2 = R.dailyCheck(s2);
    c.ok(!c2.ok && c2.doublePosted.length > 0, 'เอกสารที่ตัดยอดซ้ำต้องถูกจับได้', c2.problems);
    const qk = RRS.balanceKey({ code: 'TST-002', wh: 'A', bin: 'A-02', status: 'QUARANTINE', lot: '' });
    const s3 = clone(s);
    s3.tables.movements['998.1'] = { id: '998.1', seq: 998, at: '2026-11-02T05:00:00.000Z', date: TODAY, docType: 'PD', docNo: 'PD-FAKE', line: 1,
      code: 'TST-002', wh: 'A', bin: 'A-02', status: 'QUARANTINE', lot: '', qty: -1, balanceAfter: 2, job: '', by: 'STORE1', reversalOf: '', remark: '' };
    s3.tables.balances[qk].qty = 2;
    const c3 = R.dailyCheck(s3);
    c.ok(!c3.ok && c3.quarantineLeaks.length === 1 && c3.quarantineLeaks[0].docNo === 'PD-FAKE', 'ของกักกันที่ถูกเบิกออกนอกทาง QS/SC/RV ต้องถูกจับได้', c3.problems);
    return 'ทดลองครบวงจรแล้วตรวจยอดประจำวันผ่าน; ข้อมูลที่ยอดคลาด ตัดซ้ำ หรือปล่อยของกักกัน ถูกจับได้ทุกกรณี';
  };
  S['P6-2'] = async (c) => {
    const R = RRS.reports;
    const w = await world();
    await w.ok('LEAD', 'item.upsert', { code: 'TST-001', name: 'ชิ้นทดสอบ 1', baseUnit: 'ชิ้น', type: 'PART', unitCost: 25 });
    await stockIn(w, 'TST-001', 'A', 'A-01', 10);
    await stockIn(w, 'TST-001', 'B', 'B-01', 4);
    const s = await w.state();
    const rep = R.stockByLocation(s);
    const sum = RRS.inventory.summary(s);
    c.ok(Object.keys(sum).every((code) => rep.totals.qtyByCode[code] === sum[code].total), 'ยอดในรายงานตรงกับยอดในระบบทุกรหัส', rep.totals.qtyByCode);
    c.eq(rep.totals.value, 350, 'มูลค่าอ้างอิงในรายงาน (14 × 25)');
    c.code(await w.exec('STORE1', 'uat.signoff', { area: 'store', decision: 'ACCEPT' }), 'NO_PERMISSION', 'สโตร์ (ไม่ใช่หัวหน้า) ลงนามแทนฝ่าย');
    c.code(await w.exec('QCLEAD', 'uat.signoff', { area: 'store', decision: 'ACCEPT' }), 'NOT_AREA_ROLE', 'หัวหน้า QC ลงนามแทนสโตร์');
    c.code(await w.exec('ACC', 'uat.signoff', { area: 'accounting', decision: 'REJECT' }), 'REQUIRED', 'ไม่ยอมรับโดยไม่บอกเหตุผล');
    await w.ok('LEAD', 'uat.signoff', { area: 'store', decision: 'ACCEPT', note: 'ยอดคลัง A/B ตรงกับนับจริง' });
    await w.ok('QCLEAD', 'uat.signoff', { area: 'qc', decision: 'ACCEPT' });
    const ro = { id: 'X', owner: 'LEAD', team: [], rollbackPlan: '' };
    let sg = R.rolloutReadiness(await w.state(), { rollout: ro }).checks.find((x) => x.id === 'signoff');
    c.ok(sg && !sg.ok && /บัญชี/.test(sg.detail), 'ยังขาดการยอมรับของบัญชี', sg && sg.detail);
    const acc = await w.ok('ACC', 'uat.signoff', { area: 'accounting', decision: 'ACCEPT', note: 'ยอดตรงกับ Express ณ วันตัดยอด' });
    const s2 = await w.state();
    const row = s2.tables.uat_signoffs[acc.result.id];
    c.eq([row.by, row.role, !!row.at], ['ACC', 'accounting', true], 'การลงนามเก็บผู้ลงนาม บทบาท และเวลา');
    sg = R.rolloutReadiness(s2, { rollout: ro }).checks.find((x) => x.id === 'signoff');
    c.ok(sg && sg.ok, 'ครบสามฝ่ายแล้วผ่านเงื่อนไขการยอมรับ', sg && sg.detail);
    const w2 = await world();
    await w2.ok('ADMIN', 'user.upsert', { id: 'DUAL', name: 'สองบทบาท', roles: ['store_lead', 'accounting'] });
    await w2.ok('DUAL', 'uat.signoff', { area: 'store', decision: 'ACCEPT' });
    c.code(await w2.exec('DUAL', 'uat.signoff', { area: 'accounting', decision: 'ACCEPT' }), 'SAME_PERSON', 'คนเดียวลงนามแทนสองฝ่าย');
    return 'ลงนามได้เฉพาะหัวหน้าฝ่ายตามบทบาท คนละคนต่อฝ่าย และยอดในรายงานตรงกับระบบ – การยอมรับจริงบันทึกในหน้า UAT';
  };
  S['P6-3'] = async (c) => {
    const R = RRS.reports;
    const w = await world();
    await stockIn(w, 'TST-001', 'A', 'A-01', 10);
    const tr = await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 3, wh: 'A', bin: 'A-01', toWh: 'B' }] });
    await w.ok('STORE2', 'transfer.receive', { docNo: tr.result.docNo, lines: [{ line: 1, qty: 1 }] });
    const live = clone(await w.state());
    const v = R.verifyBackup(JSON.stringify({ commits: w.store.commits }), { compare: live, keepState: true });
    c.eq([v.ok, v.problems, v.commits, v.head, v.fingerprint], [true, [], live.seq, live.head, R.fingerprint(live)], 'เล่นซ้ำไฟล์สำรองได้ข้อมูลเท่าระบบจริง');
    c.eq(util.stable(v.state && v.state.tables.balances), util.stable(live.tables.balances), 'ยอดคงเหลือที่กู้ได้');
    c.code(await w.exec('STORE1', 'backup.recordTest', { commits: v.commits, head: v.head, result: 'OK' }), 'NO_PERMISSION', 'สโตร์บันทึกผลกู้ข้อมูล');
    const bt = await w.ok('ACC', 'backup.recordTest', { commits: v.commits, head: v.head, result: 'OK', fingerprint: v.fingerprint, note: 'กู้ลงเครื่องทดสอบ' });
    let s = await w.state();
    const row = s.tables.backup_tests[bt.result.id];
    c.eq([row.by, row.result, row.commits], ['ACC', 'OK', live.seq], 'ผลทดสอบกู้คืนเก็บผู้ทดสอบ ผล และจำนวน commit');
    const seq = s.seq;
    c.code(await w.exec('ACC', 'backup.recordTest', { commits: s.seq, head: 'a'.repeat(64), result: 'OK' }), 'HEAD_MISMATCH', 'ไฟล์สำรองคนละประวัติ');
    c.code(await w.exec('ACC', 'backup.recordTest', { commits: s.seq + 5, head: s.head, result: 'OK' }), 'HEAD_MISMATCH', 'ไฟล์สำรองมากกว่าระบบ');
    s = await w.state();
    c.eq(s.seq, seq, 'ผลที่ไม่ตรงระบบไม่ถูกบันทึก');
    const forged = clone(w.store.commits);
    forged.splice(2, 1);
    c.ok(!R.verifyBackup(forged).ok, 'ไฟล์สำรองขาดช่วงต้องไม่ผ่าน');
    return `เล่นซ้ำ ${v.commits} commit ได้ข้อมูลเท่าระบบจริง บันทึกผลพร้อมผู้ทดสอบ และไฟล์ที่ไม่ตรงถูกปฏิเสธ`;
  };
  S['P6-4'] = async (c) => {
    const R = RRS.reports;
    const w = await world();
    await w.ok('LEAD', 'item.upsert', { code: 'TST-003', name: 'ชิ้นทดสอบ 3', baseUnit: 'ชิ้น', type: 'PART' });
    for (const k of [['count_accuracy', 85, 95], ['qc_wait', 48, 24], ['fpy', 80, 90], ['repeat_ncr', 5, 1], ['shortage', 10, 2]]) {
      await w.ok('MGR', 'kpi.record', { id: k[0], baseline: k[1], target: k[2], measuredOn: '2026-10-31', note: 'ค่าตั้งต้นก่อนทดลอง' });
    }
    c.code(await w.exec('STORE1', 'kpi.record', { id: 'fpy', baseline: 1, target: 2 }), 'NO_PERMISSION', 'สโตร์แก้เป้าหมายตัวชี้วัด');
    const r1 = await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 2, wh: 'A', bin: 'A-01', lot: 'H1' }] });
    const r2 = await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 2, wh: 'A', bin: 'A-01', lot: 'H2' }] });
    const s = clone(await w.state());
    const at1 = RRS.inventory.history(s, { docNo: r1.result.docNo })[0].at;
    const at2 = RRS.inventory.history(s, { docNo: r2.result.docNo })[0].at;
    const plus = (iso, hours) => new Date(Date.parse(iso) + hours * 3600e3).toISOString();
    s.tables.inspections = {
      'IN-00001': { id: 'IN-00001', stage: 'INCOMING', code: 'TST-PLATE', wh: 'A', bin: 'A-01', lot: 'H1', fromStatus: 'QC_HOLD', sourceDoc: r1.result.docNo, at: plus(at1, 10), result: 'PASS', status: 'RELEASED', reinspectionOf: '' },
      'IN-00002': { id: 'IN-00002', stage: 'INCOMING', code: 'TST-PLATE', wh: 'A', bin: 'A-01', lot: 'H2', fromStatus: 'QC_HOLD', sourceDoc: r2.result.docNo, at: plus(at2, 14), result: 'PASS', status: 'RELEASED', reinspectionOf: '' },
    };
    const lines = [];
    for (let i = 0; i < 20; i++) lines.push({ code: 'TST-001', bin: `X${i}`, system: 10, counted: i === 0 ? 20 : 10, final: { counted: i === 0 ? 20 : 10, system: 10 } });
    s.tables.count_sessions = { 'CT-00001': { id: 'CT-00001', wh: 'A', status: 'APPROVED', approvedAt: '2026-11-10T03:00:00.000Z', approvedBy: 'LEAD', lines } };
    s.tables.ncrs = {
      'NCR-1': { ncrNo: 'NCR-1', code: 'TST-PLATE', defect: 'รอยร้าว', createdAt: '2026-11-03T03:00:00.000Z', status: 'CLOSED' },
      'NCR-2': { ncrNo: 'NCR-2', code: 'TST-PLATE', defect: 'รอยร้าว', createdAt: '2026-11-12T03:00:00.000Z', status: 'OPEN' },
    };
    s.tables.jobs = { J1: { jobNo: 'J1', status: 'OPEN', lines: [{ line: 1, code: 'TST-001', required: 5, issued: 0 }, { line: 2, code: 'TST-002', required: 1, issued: 0 },
      { line: 3, code: 'TST-003', required: 2, issued: 1 }] } };
    const k = R.kpiActuals(s, { today: '2026-11-20' });
    const get = (id) => k.rows.find((x) => x.id === id) || {};
    c.eq([get('count_accuracy').actual, get('count_accuracy').met], [95, true], 'ความแม่นยำการนับจากรอบนับที่อนุมัติ');
    c.eq([get('qc_wait').actual, get('qc_wait').met], [12, true], 'เวลารอ QC เฉลี่ย (ชั่วโมง)');
    c.eq([get('fpy').actual, get('repeat_ncr').actual], [100, 1], 'อัตราผ่านครั้งแรก และปัญหาซ้ำ');
    c.eq([get('shortage').actual, get('shortage').met, get('shortage').improved], [3, false, true], 'ของขาด: ดีขึ้นแต่ยังไม่ถึงเป้า');
    c.eq([get('issue_lead').actual, get('issue_lead').met], [null, null], 'ตัวชี้วัดที่ยังวัดไม่ได้ ไม่เดาค่า');
    c.eq([k.totals.met, k.totals.notMet], [4, 1], 'สรุปถึงเป้า/ไม่ถึงเป้า');
    return 'คำนวณค่าจริงของตัวชี้วัดเทียบค่าก่อนเริ่มและเป้าหมายได้ (ถึงเป้า 4 ไม่ถึง 1 วัดไม่ได้ไม่เดา) – การยอมรับเป้าจริงทำในหน้า UAT';
  };
  S['P6-5'] = async (c) => {
    const R = RRS.reports;
    const w = await world();
    await w.ok('LEAD', 'item.upsert', { code: 'TST-001', name: 'ชิ้นทดสอบ 1', baseUnit: 'ชิ้น', type: 'PART', group: 'กระบะ-01' });
    await stockIn(w, 'TST-001', 'A', 'A-01', 5);
    const plan = { title: 'ขยายกลุ่มกระบะ-01 ไปคลัง B', groups: ['กระบะ-01'], warehouses: ['b'], owner: 'LEAD', team: ['STORE1', 'QC1'],
      rollbackPlan: 'ปิดสวิตช์กลุ่มทดลอง กู้ข้อมูลจากสำรองล่าสุด แล้วคีย์เอกสารหลังตัดยอดซ้ำในระบบเดิม' };
    c.code(await w.exec('LEAD', 'rollout.propose', Object.assign({}, plan, { owner: '' })), 'REQUIRED', 'แผนขยายผลไม่มีผู้รับผิดชอบ');
    c.code(await w.exec('LEAD', 'rollout.propose', Object.assign({}, plan, { rollbackPlan: 'กู้คืน' })), 'REQUIRED', 'แผนย้อนกลับไม่ชัด');
    const id = (await w.ok('LEAD', 'rollout.propose', plan)).result.id;
    c.code(await w.exec('MGR', 'rollout.approve', { id }), 'NOT_READY', 'อนุมัติก่อนพร้อม');
    let s = await w.state();
    c.eq(R.rolloutReadiness(s, { id, today: TODAY }).checks.filter((x) => x.required && !x.ok).map((x) => x.id), ['backup', 'uat', 'signoff', 'training'], 'เงื่อนไขที่ยังขาด');
    const v = R.verifyBackup(w.store.commits, { compare: s });
    await w.ok('ACC', 'backup.recordTest', { commits: v.commits, head: v.head, result: 'OK', note: 'กู้ลงเครื่องสำรอง' });
    for (const cr of R.UAT_CRITERIA) await w.ok('QC1', 'uat.record', { id: cr.id, status: 'PASS', evidence: cr.auto || 'selftest' });
    await w.ok('LEAD', 'training.record', { userId: 'STORE1', role: 'store', topic: 'รับ–เบิก–โอน และกรณีผิดพลาด' });
    await w.ok('LEAD', 'training.record', { userId: 'QC1', role: 'qc', topic: 'ตรวจรับและกักกัน' });
    await w.ok('LEAD', 'uat.signoff', { area: 'store', decision: 'ACCEPT' });
    await w.ok('QCLEAD', 'uat.signoff', { area: 'qc', decision: 'ACCEPT' });
    await w.ok('ACC', 'uat.signoff', { area: 'accounting', decision: 'ACCEPT' });
    s = await w.state();
    const rd = R.rolloutReadiness(s, { id, today: TODAY });
    c.ok(rd.ok, 'ครบเงื่อนไขแล้วพร้อมขยาย', rd.problems);
    const own = await w.ok('MGR', 'rollout.propose', Object.assign({}, plan, { title: 'แผนของผู้บริหาร', groups: [], warehouses: ['B'] }));
    c.code(await w.exec('MGR', 'rollout.approve', { id: own.result.id }), 'SAME_PERSON', 'ผู้เสนออนุมัติแผนของตัวเอง');
    await w.ok('MGR', 'rollout.approve', { id });
    s = await w.state();
    c.eq([s.tables.rollouts[id].status, s.tables.rollouts[id].approvedBy, s.tables.settings.main.pilot.warehouses], ['APPROVED', 'MGR', ['B']], 'อนุมัติแล้วขอบเขตทดลองขยาย');
    c.code(await w.exec('MGR', 'rollout.rollback', { id }), 'REQUIRED', 'ย้อนกลับโดยไม่มีเหตุผล');
    await w.ok('MGR', 'rollout.rollback', { id, reason: 'พบยอดคลัง B ไม่ตรงหลังขยาย' });
    s = await w.state();
    c.eq([s.tables.rollouts[id].status, s.tables.rollouts[id].rolledBackBy], ['ROLLED_BACK', 'MGR'], 'ย้อนกลับตามแผนได้');
    return 'แผนขยายผลต้องมีผู้รับผิดชอบ แผนย้อนกลับ ผลกู้ข้อมูล UAT การยอมรับ และการอบรม ผู้อนุมัติต้องไม่ใช่ผู้เสนอ และย้อนกลับได้';
  };

  /** Modules each phase needs (core/master/inventory are always there). */
  const NEEDS = {
    'P0-2': [], 'P2-1': ['planning'], 'P2-2': ['planning'], 'P2-3': ['planning'], 'P2-4': ['planning'],
    'P3-1': ['reconcile'], 'P3-2': ['reconcile'], 'P3-3': ['reconcile'], 'P3-4': ['reconcile'], 'P3-5': ['reconcile'],
    'P4-1': ['purchasing'], 'P4-2': ['purchasing'], 'P4-3': ['purchasing'], 'P4-4': ['purchasing'], 'P4-5': ['purchasing'],
    'P5-1': ['quality'], 'P5-2': ['quality'], 'P5-3': ['quality'], 'P5-4': ['quality'], 'P5-5': ['quality'], 'P5-6': ['quality'],
    'P6-1': ['reports'], 'P6-2': ['reports'], 'P6-3': ['reports'], 'P6-4': ['reports'], 'P6-5': ['reports'],
  };

  /** Run one criterion. */
  async function runOne(cr) {
    const t0 = Date.now();
    const base = { id: cr.id, phase: cr.phase, criterion: cr.criterion, manual: !!MANUAL[cr.id] };
    const fn = S[cr.id];
    if (!fn) return Object.assign(base, { pass: false, detail: 'ยังไม่มีการทดสอบอัตโนมัติของเกณฑ์นี้ – ทดสอบด้วยคนแล้วบันทึกในหน้า UAT', checks: 0, ms: 0 });
    const missing = (NEEDS[cr.id] || []).filter((m) => !loaded(m));
    if (missing.length) {
      return Object.assign(base, { pass: false, detail: `ไม่ได้ทดสอบ: ระบบรุ่นนี้ไม่มีโมดูล ${missing.map((m) => MODULE_NAME[m] || m).join(', ')}`, checks: 0, ms: 0 });
    }
    const c = checker();
    let summary = '';
    try {
      summary = (await fn(c)) || '';
    } catch (e) {
      c.fails.push('หยุดกลางคัน: ' + ((e && e.message) || String(e)));
    }
    const pass = c.fails.length === 0 && c.n > 0;
    let detail;
    if (pass) detail = `${summary} (ตรวจ ${c.n} ข้อ)${base.manual ? ' – ระบบทำงานถูกต้อง การยอมรับจริงของผู้เกี่ยวข้องบันทึกในหน้า UAT' : ''}`;
    else detail = `ไม่ผ่าน ${c.fails.length} จาก ${c.n} ข้อ: ${c.fails.slice(0, 4).join(' · ')}${c.fails.length > 4 ? ' · …' : ''}`;
    return Object.assign(base, { pass, detail, checks: c.n, ms: Date.now() - t0 });
  }

  /**
   * Run every criterion (or opts.only: [ids]) one after another in fresh in-memory worlds. Never touches the data of
   * the page. opts.onProgress({done, total, id, criterion, pass, detail}).
   */
  async function run(opts) {
    opts = opts || {};
    let list = criteria();
    if (Array.isArray(opts.only) && opts.only.length) list = list.filter((c) => opts.only.indexOf(c.id) >= 0);
    const out = [];
    for (const cr of list) {
      const r = await runOne(cr);
      out.push(r);
      if (opts.onProgress) {
        try {
          opts.onProgress({ done: out.length, total: list.length, id: r.id, criterion: r.criterion, pass: r.pass, detail: r.detail });
        } catch (e) { /* progress display only */ }
      }
      // let the page breathe between criteria (keeps a progress bar moving)
      await new Promise((resolve) => (typeof setTimeout === 'function' ? setTimeout(resolve, 0) : resolve()));
    }
    return out;
  }
  /** {total, pass, fail} of a result list. */
  function summary(results) {
    const pass = (results || []).filter((r) => r.pass).length;
    return { total: (results || []).length, pass, fail: (results || []).length - pass };
  }

  RRS.selftest = { run, summary, criteria, ids: () => Object.keys(S) };
})(typeof globalThis !== 'undefined' ? globalThis : this);
