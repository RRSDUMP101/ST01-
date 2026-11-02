/*
 * Sample data (ข้อมูลตัวอย่าง) for the demo mode, training and screen tests.
 *
 *   await RRS.fixture.load(ledger, {now?, onProgress?})  ->  {commits, steps, ms, jobs, today, concurrent?}
 *
 * Everything is made ONLY through ledger.execute({kind, payload, requestId}, {user, now}) with the real commands of every
 * module that is loaded, so the sample follows every rule of the engine (permissions, separation of duties, stock never
 * below zero, QC before use …). A command that fails stops the load with its Thai errors – nothing is guessed or forced.
 *
 * It is clearly sample data: company "ข้อมูลตัวอย่าง", every item / supplier code starts with DEMO-, the users are role
 * names (ids DEMO_STORE …, one per role; the first administrator keeps the id ADMIN like a fresh system), no customer
 * names (SO numbers SO-DEMO-001 …, Sales Office ids DEMO-…), notes say "ตัวอย่าง". It is loaded only into an EMPTY store
 * (never on top of team or server data).
 *
 * The story is spread over the last 14 days (each command gets its own time, Bangkok working hours), so ages, late PO
 * lines and "today" views look like a running factory:
 *   day −14  settings + pilot scope, users, warehouses 01/02/03 + bins, 25 items, units, BOM of the dump body (approved),
 *            QC plans, decisions ค-1/ค-2 (examples), baseline KPIs, opening balances (one AJ), suppliers + terms
 *   day −13  PO for bolts/locks (due day −4, never delivered → late)
 *   day −11  two jobs: SO-DEMO-001 fully reserved, SO-DEMO-002 short (plates, cylinder, PTO, locks)
 *   day −10  PR → approved → PO for plates;  day −9 PO for hydraulics
 *   day −7   pick (PD) of the plates for SO-DEMO-001, offcuts recorded / one used
 *   day −6   part of the plate PO received in two heats (QC_HOLD) + mill certificates
 *   day −5   heat 1 PASS → released; heat 2 FAIL → NCR → decided REWORK
 *   day −4   production record + FR of a side panel into QC_HOLD
 *   day −3   transfer 01 → 02 still in transit
 *   day −2   Express file with a few differences (one explained, two waiting), documents keyed in Express
 *   day −1   count session with differences waiting for approval, UAT examples, training, a pilot issue,
 *            a Sales Office job (not mapped yet), daily balance check
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  if (!RRS || !RRS.Ledger || !RRS.commands) return;
  const { util } = RRS;

  const COMPANY = 'ข้อมูลตัวอย่าง';
  const PREFIX = 'DEMO-';
  const NOTE = 'ข้อมูลตัวอย่าง – ไม่ใช่ยอดหรือเอกสารจริง';

  /** One user per role (ids DEMO_…); the administrator keeps the id ADMIN. */
  const USERS = [
    { id: 'DEMO_MGR', name: 'ผู้บริหาร (ตัวอย่าง)', roles: ['manager'] },
    { id: 'DEMO_STORE', name: 'สโตร์ (ตัวอย่าง)', roles: ['store'] },
    { id: 'DEMO_LEAD', name: 'หัวหน้าสโตร์ (ตัวอย่าง)', roles: ['store_lead'] },
    { id: 'DEMO_PLAN', name: 'วางแผนผลิต (ตัวอย่าง)', roles: ['planner'] },
    { id: 'DEMO_PROD', name: 'ฝ่ายผลิต (ตัวอย่าง)', roles: ['production'] },
    { id: 'DEMO_ENG', name: 'วิศวกรรม (ตัวอย่าง)', roles: ['engineering'] },
    { id: 'DEMO_PUR', name: 'จัดซื้อ (ตัวอย่าง)', roles: ['purchasing'] },
    { id: 'DEMO_PURLEAD', name: 'หัวหน้าจัดซื้อ (ตัวอย่าง)', roles: ['purchasing_lead'] },
    { id: 'DEMO_ACC', name: 'บัญชี (ตัวอย่าง)', roles: ['accounting'] },
    { id: 'DEMO_QC', name: 'QC (ตัวอย่าง)', roles: ['qc'] },
    { id: 'DEMO_QCLEAD', name: 'หัวหน้า QC (ตัวอย่าง)', roles: ['qc_lead'] },
    { id: 'DEMO_VIEW', name: 'ดูอย่างเดียว (ตัวอย่าง)', roles: ['viewer'] },
  ];
  const ADMIN = { id: 'ADMIN', name: 'ผู้ดูแลระบบ (ตัวอย่าง)' };

  const WAREHOUSES = [
    { code: '01', name: 'คลังวัตถุดิบ', expressCode: '01', requireBin: true },
    { code: '02', name: 'คลังชิ้นส่วนรอประกอบ', expressCode: '02', requireBin: true },
    { code: '03', name: 'คลังสินค้าสำเร็จรูป', expressCode: '03', requireBin: false },
  ];
  const BINS = [
    ['01', 'RM-A1', 'ชั้นเหล็กแผ่น A ชั้น 1'], ['01', 'RM-A2', 'ชั้นเหล็กแผ่น A ชั้น 2'], ['01', 'RM-B1', 'ชั้นเหล็กรูปพรรณ B'],
    ['01', 'RM-C1', 'ชั้นวัสดุสิ้นเปลือง C'], ['01', 'RM-RCV', 'จุดรับของรอตรวจ'], ['01', 'RM-OFF', 'ชั้นเศษเหล็กใช้ซ้ำ'],
    ['02', 'WIP-L1', 'ชั้นชิ้นส่วนข้างซ้าย'], ['02', 'WIP-R1', 'ชั้นชิ้นส่วนข้างขวา'], ['02', 'WIP-H1', 'ชั้นอุปกรณ์และชิ้นส่วนซื้อ'],
    ['02', 'WIP-C1', 'ชั้นวัสดุสิ้นเปลืองหน้างาน'],
  ].map(([wh, code, name]) => ({ wh, code, name }));

  const MODEL = 'DEMO-D6';
  const GROUP = 'กระบะดั๊มพ์ 6 ล้อ (ตัวอย่าง)';
  const plate = (code, name, thickness, width, length, cost, extra) => Object.assign({ code, name, type: 'RM', group: 'เหล็กแผ่น',
    baseUnit: 'แผ่น', trackLot: 'heat', certRequired: true, qcIncoming: true, material: 'SS400', thickness, width, length, unitCost: cost }, extra);
  const part = (code, name, side, dwg, rev, cost, extra) => Object.assign({ code, name, type: 'PART', group: GROUP, baseUnit: 'ชิ้น',
    model: MODEL, side, drawingNo: dwg, drawingRev: rev, unitCost: cost }, extra);
  const ITEMS = [
    plate('DEMO-PL30', 'เหล็กแผ่น SS400 หนา 3.0 มม. 4×8 ฟุต', 3, 1219, 2438, 2850, { expressCode: 'E-RM-1030', minQty: 10, maxQty: 30 }),
    plate('DEMO-PL45', 'เหล็กแผ่น SS400 หนา 4.5 มม. 5×10 ฟุต', 4.5, 1524, 3048, 6200, { expressCode: 'E-RM-1045', minQty: 4, maxQty: 12 }),
    plate('DEMO-PL60', 'เหล็กแผ่น SS400 หนา 6.0 มม. 5×10 ฟุต', 6, 1524, 3048, 8300, { expressCode: 'E-RM-1060' }),
    plate('DEMO-PL80', 'เหล็กแผ่น SS400 หนา 8.0 มม. 5×20 ฟุต', 8, 1524, 6096, 21900, { expressCode: 'E-RM-1080' }),
    { code: 'DEMO-CH100', name: 'เหล็กรางน้ำ (C) 100×50×5 มม. ยาว 6 ม.', type: 'RM', group: 'เหล็กรูปพรรณ', baseUnit: 'กก.',
      material: 'SS400', unitCost: 32, expressCode: 'E-RM-1100', minQty: 224, maxQty: 1120 },
    { code: 'DEMO-SHS50', name: 'เหล็กกล่อง 50×50×2.3 มม. ยาว 6 ม.', type: 'RM', group: 'เหล็กรูปพรรณ', baseUnit: 'เส้น',
      material: 'SS400', unitCost: 420, expressCode: 'E-RM-1150' },
    part('DEMO-SP-L', 'แผงข้างกระบะ ซ้าย (ตัด/พับ)', 'L', 'DEMO-DWG-111', 'B', 5200, { qcFinal: true }),
    part('DEMO-SP-R', 'แผงข้างกระบะ ขวา (ตัด/พับ)', 'R', 'DEMO-DWG-112', 'B', 5200, { qcFinal: true }),
    part('DEMO-TG', 'ฝาท้ายกระบะ', '', 'DEMO-DWG-113', 'A', 4100, { qcFinal: true }),
    part('DEMO-FL', 'พื้นกระบะ', '', 'DEMO-DWG-114', 'A', 9800, { qcFinal: true }),
    part('DEMO-FP', 'แผงหน้ากระบะ', '', 'DEMO-DWG-115', 'A', 3600, { qcFinal: true }),
    part('DEMO-CM-L', 'คานรองกระบะ ซ้าย', 'L', 'DEMO-DWG-121', 'A', 2900),
    part('DEMO-CM-R', 'คานรองกระบะ ขวา', 'R', 'DEMO-DWG-122', 'A', 2900),
    { code: 'DEMO-HG', name: 'บานพับฝาท้าย', type: 'BUY', group: 'อุปกรณ์กระบะ', baseUnit: 'ตัว', unitCost: 85, minQty: 20, maxQty: 60 },
    { code: 'DEMO-LOCK', name: 'ตัวล็อกฝาท้าย', type: 'BUY', group: 'อุปกรณ์กระบะ', baseUnit: 'ชุด', unitCost: 650 },
    { code: 'DEMO-CYL', name: 'กระบอกไฮดรอลิกยกกระบะ', type: 'BUY', group: 'ชุดไฮดรอลิก', baseUnit: 'ชุด', trackLot: 'serial', unitCost: 18500 },
    { code: 'DEMO-PTO', name: 'ชุดปั๊มไฮดรอลิก (PTO)', type: 'BUY', group: 'ชุดไฮดรอลิก', baseUnit: 'ชุด', unitCost: 12500 },
    { code: 'DEMO-LAMP', name: 'ไฟท้าย LED', type: 'BUY', group: 'อุปกรณ์กระบะ', baseUnit: 'ดวง', unitCost: 380, minQty: 6, maxQty: 20 },
    { code: 'DEMO-BLT-M16', name: 'สลักเกลียว M16×50 เกรด 8.8', type: 'BUY', group: 'อุปกรณ์ยึด', baseUnit: 'ตัว', unitCost: 6, minQty: 200, maxQty: 600 },
    { code: 'DEMO-NUT-M16', name: 'น็อต M16', type: 'BUY', group: 'อุปกรณ์ยึด', baseUnit: 'ตัว', unitCost: 3, minQty: 200, maxQty: 600 },
    { code: 'DEMO-WIRE', name: 'ลวดเชื่อม MIG 1.2 มม.', type: 'CONS', group: 'วัสดุสิ้นเปลือง', baseUnit: 'กก.', unitCost: 65, expressCode: 'E-CS-3001', minQty: 30, maxQty: 90 },
    { code: 'DEMO-PAINT-P', name: 'สีรองพื้นกันสนิม', type: 'CONS', group: 'วัสดุสิ้นเปลือง', baseUnit: 'ลิตร', unitCost: 120, minQty: 18, maxQty: 72 },
    { code: 'DEMO-PAINT-B', name: 'สีดำเงาทับหน้า', type: 'CONS', group: 'วัสดุสิ้นเปลือง', baseUnit: 'ลิตร', unitCost: 150 },
    { code: 'DEMO-DISC', name: 'ใบเจียร 4 นิ้ว', type: 'CONS', group: 'วัสดุสิ้นเปลือง', baseUnit: 'ใบ', unitCost: 18, minQty: 20, maxQty: 100 },
    { code: 'DEMO-DB6', name: 'กระบะดั๊มพ์ 6 ล้อ รุ่นตัวอย่าง', type: 'FG', group: GROUP, baseUnit: 'ชุด', model: MODEL,
      drawingNo: 'DEMO-DWG-100', qcFinal: true, unitCost: 185000 },
  ].map((it) => Object.assign({ remark: NOTE }, it));
  const UNITS = [
    ['DEMO-PL30', 'มัด', 10], ['DEMO-CH100', 'เส้น', 56], ['DEMO-HG', 'คู่', 2], ['DEMO-BLT-M16', 'กล่อง', 100],
    ['DEMO-NUT-M16', 'กล่อง', 100], ['DEMO-WIRE', 'ม้วน', 15], ['DEMO-PAINT-P', 'ถัง', 18], ['DEMO-PAINT-B', 'ถัง', 18],
    ['DEMO-DISC', 'กล่อง', 25],
  ].map(([code, unit, factor]) => ({ code, unit, factor }));

  /** BOM of the dump body, per 1 set (rev A). Plates and channel are cut in house into the parts made by the job. */
  const BOM = [
    ['DEMO-PL30', 2], ['DEMO-PL45', 2], ['DEMO-CH100', 2, 'เส้น'], ['DEMO-SP-L', 1], ['DEMO-SP-R', 1], ['DEMO-TG', 1],
    ['DEMO-FL', 1], ['DEMO-FP', 1], ['DEMO-CM-L', 1], ['DEMO-CM-R', 1], ['DEMO-HG', 4], ['DEMO-LOCK', 2], ['DEMO-CYL', 1],
    ['DEMO-PTO', 1], ['DEMO-LAMP', 2], ['DEMO-BLT-M16', 24], ['DEMO-NUT-M16', 24], ['DEMO-WIRE', 8], ['DEMO-PAINT-P', 6],
    ['DEMO-PAINT-B', 4],
  ].map(([code, qty, unit]) => (unit ? { code, qty, unit } : { code, qty }));
  /** Parts made in house per job (code -> sets made in house; SP-R of the first job comes from stock). */
  const MAKE = [
    { job: 0, make: { 'DEMO-SP-L': 1, 'DEMO-TG': 1, 'DEMO-FL': 1, 'DEMO-FP': 1, 'DEMO-CM-L': 1, 'DEMO-CM-R': 1 } },
    { job: 1, make: { 'DEMO-SP-L': 2, 'DEMO-SP-R': 1, 'DEMO-TG': 2, 'DEMO-FL': 2, 'DEMO-FP': 2, 'DEMO-CM-L': 2, 'DEMO-CM-R': 2 } },
  ];

  const OPENING = [
    ['DEMO-PL30', 12, '01', 'RM-A1', 'HT-DEMO-2401'], ['DEMO-PL45', 4, '01', 'RM-A2', 'HT-DEMO-2402'],
    ['DEMO-PL60', 5, '01', 'RM-A2', 'HT-DEMO-2403'], ['DEMO-PL80', 2, '01', 'RM-B1', 'HT-DEMO-2404'],
    ['DEMO-CH100', 10, '01', 'RM-B1', '', 'เส้น'], ['DEMO-SHS50', 40, '01', 'RM-B1'],
    ['DEMO-WIRE', 3, '01', 'RM-C1', '', 'ม้วน'], ['DEMO-PAINT-P', 2, '01', 'RM-C1', '', 'ถัง'],
    ['DEMO-PAINT-B', 1, '01', 'RM-C1', '', 'ถัง'], ['DEMO-DISC', 2, '01', 'RM-C1', '', 'กล่อง'],
    ['DEMO-SP-R', 2, '02', 'WIP-R1'], ['DEMO-HG', 15, '02', 'WIP-H1', '', 'คู่'], ['DEMO-LOCK', 4, '02', 'WIP-H1'],
    ['DEMO-CYL', 1, '02', 'WIP-H1', 'CYL-DEMO-0001'], ['DEMO-CYL', 1, '02', 'WIP-H1', 'CYL-DEMO-0002'],
    ['DEMO-PTO', 1, '02', 'WIP-H1'], ['DEMO-LAMP', 10, '02', 'WIP-H1'], ['DEMO-BLT-M16', 3, '02', 'WIP-H1', '', 'กล่อง'],
    ['DEMO-NUT-M16', 250, '02', 'WIP-H1'], ['DEMO-DB6', 1, '03', ''],
  ].map(([code, qty, wh, bin, lot, unit]) => Object.assign({ code, qty, wh, bin, lot: lot || '', remark: 'ยอดตั้งต้นตัวอย่าง' }, unit ? { unit } : {}));

  const SUPPLIERS = [
    { id: 'DEMO-SUP-STEEL', name: 'ผู้ขายเหล็กแผ่น (ตัวอย่าง)', contact: 'ฝ่ายขาย (ตัวอย่าง)', leadDays: 7 },
    { id: 'DEMO-SUP-HYD', name: 'ผู้ขายชุดไฮดรอลิก (ตัวอย่าง)', contact: 'ฝ่ายขาย (ตัวอย่าง)', leadDays: 21 },
    { id: 'DEMO-SUP-HW', name: 'ผู้ขายอุปกรณ์ยึดและอุปกรณ์กระบะ (ตัวอย่าง)', contact: 'ฝ่ายขาย (ตัวอย่าง)', leadDays: 3 },
  ];
  const TERMS = [
    ['DEMO-PL30', 'DEMO-SUP-STEEL', 2850, 'แผ่น', 5, 0, 7], ['DEMO-PL45', 'DEMO-SUP-STEEL', 6200, 'แผ่น', 2, 0, 7],
    ['DEMO-PL60', 'DEMO-SUP-STEEL', 8300, 'แผ่น', 2, 0, 7], ['DEMO-PL80', 'DEMO-SUP-STEEL', 21900, 'แผ่น', 1, 0, 10],
    ['DEMO-CH100', 'DEMO-SUP-STEEL', 1790, 'เส้น', 5, 0, 7], ['DEMO-CYL', 'DEMO-SUP-HYD', 18500, 'ชุด', 1, 0, 21],
    ['DEMO-PTO', 'DEMO-SUP-HYD', 12500, 'ชุด', 1, 0, 21], ['DEMO-BLT-M16', 'DEMO-SUP-HW', 450, 'กล่อง', 1, 0, 3],
    ['DEMO-NUT-M16', 'DEMO-SUP-HW', 280, 'กล่อง', 1, 0, 3], ['DEMO-HG', 'DEMO-SUP-HW', 85, 'ตัว', 20, 10, 5],
    ['DEMO-LOCK', 'DEMO-SUP-HW', 650, 'ชุด', 2, 0, 5], ['DEMO-LAMP', 'DEMO-SUP-HW', 380, 'ดวง', 4, 0, 5],
  ].map(([code, supplier, price, buyUnit, moq, pack, leadDays]) => ({ code, supplier, price, buyUnit, moq, pack, leadDays, preferred: true }));

  const PLATE_PLAN = [
    { name: 'ความหนา', kind: 'measure', nominal: 3, min: 2.85, max: 3.15, unit: 'มม.', method: 'ไมโครมิเตอร์ 3 จุด' },
    { name: 'ความยาวแผ่น', kind: 'measure', nominal: 2438, min: 2435, max: 2445, unit: 'มม.', method: 'ตลับเมตร' },
    { name: 'ผิว/สนิม', kind: 'check', method: 'ดูด้วยตาทั้งสองด้าน' },
    { name: 'เลข Heat ตรงใบรับรอง', kind: 'check', method: 'เทียบเลขตอกบนแผ่นกับใบรับรองวัสดุ' },
  ];
  const PANEL_PLAN = [
    { name: 'ความยาว', kind: 'measure', nominal: 4200, min: 4197, max: 4203, unit: 'มม.', method: 'ตลับเมตร' },
    { name: 'ความสูง', kind: 'measure', nominal: 600, min: 598, max: 602, unit: 'มม.', method: 'ตลับเมตร' },
    { name: 'มุมพับ', kind: 'measure', nominal: 90, min: 89, max: 91, unit: 'องศา', method: 'ฉากวัดมุม' },
    { name: 'รอยเชื่อม', kind: 'check', method: 'ดูด้วยตา ไม่มีรูพรุน/รอยแตก' },
  ];
  const BODY_PLAN = [
    { name: 'ความกว้างภายในกระบะ', kind: 'measure', nominal: 2300, min: 2295, max: 2305, unit: 'มม.', method: 'ตลับเมตร' },
    { name: 'ระบบยกทำงาน', kind: 'check', method: 'ยกสุด–ลงสุด 3 รอบ ไม่รั่ว' },
    { name: 'สี/ผิว', kind: 'check', method: 'ดูด้วยตา' },
  ];

  // ---------------------------------------------------------------------------------------------------------
  // the time line: Bangkok working hours over the last days, every command a little later than the one before
  // ---------------------------------------------------------------------------------------------------------
  function timeline(nowIso) {
    const nowMs = Date.parse(nowIso);
    const today = util.bkkDate(nowIso);
    let cursor = 0;
    return {
      today,
      day: (n) => util.addDays(today, n),
      /** Move to day n (≤ −1) at hh:mm Bangkok time (never backwards). */
      at(n, hhmm) {
        const t = Date.parse(`${util.addDays(today, n)}T${hhmm}:00+07:00`);
        if (t > cursor) cursor = t;
      },
      iso: (n, hhmm) => new Date(Date.parse(`${util.addDays(today, n)}T${hhmm}:00+07:00`)).toISOString(),
      /** Time of the next command (90 seconds after the previous one, always before the real time). */
      tick() {
        const t = Math.min(cursor, nowMs - 60e3);
        cursor = Math.max(cursor, t) + 90e3;
        return new Date(t).toISOString();
      },
    };
  }

  const pad = (n) => String(n).padStart(3, '0');
  const FIRST_REQUEST = 'demo-001-system.bootstrap'; // request id of the first command of the sample
  const has = (kind) => !!RRS.commands.defs[kind];
  const errText = (r) => (r.errors || []).map((e) => e.message).join(' / ') || 'ไม่ทราบสาเหตุ';
  const rowsOf = (state, t, f) => RRS.q.rows(state, t, f);

  /**
   * Builds the sample in an EMPTY store through `ledger`. opts: {now (ISO, default the real time), onProgress({step, kind,
   * label})}. Throws an Error with the Thai messages of the first command that is refused (and what to do next), or when
   * someone else writes to the store while the sample is built, or when the store holds other data. When another tab /
   * ledger has built or is building the same sample (the store already holds its first request, or a command comes back
   * as a duplicate request), this one stops quietly with `concurrent: true` and writes nothing – the other tab's commits
   * reach it through the store, so the sample is never built twice or half-mixed.
   */
  async function load(ledger, opts) {
    opts = opts || {};
    const started = Date.now();
    await ledger.catchUp();
    const T = timeline(opts.now || new Date().toISOString());
    if (ledger.state.seq !== 0) {
      // this very sample is already there (another tab found the store empty a moment earlier and is building it)
      if ((ledger.state.requests || {})[FIRST_REQUEST]) {
        return { commits: ledger.state.seq, steps: 0, ms: Date.now() - started, jobs: [], today: T.today, concurrent: true };
      }
      throw new Error(`ใส่ข้อมูลตัวอย่างได้เฉพาะที่เก็บข้อมูลที่ยังว่าง – ที่นี่มีข้อมูลแล้ว ${ledger.state.seq} รายการ (ไม่เขียนทับข้อมูลเดิม)`);
    }
    const day = T.day;
    let n = 0;
    let written = 0; // commits this load wrote (the store must hold exactly these while the sample is built)
    const OTHER = {}; // thrown when another tab / ledger is building the same sample at the same moment
    const HOW = 'ข้อมูลตัวอย่างหยุดอยู่ที่ขั้นก่อนหน้า (ไม่ครบชุด) – กด เริ่มข้อมูลตัวอย่างใหม่ เพื่อสร้างใหม่ ถ้ายังไม่ได้ให้แจ้งผู้ดูแลระบบพร้อมข้อความนี้';
    /** Run one command as `user` at the next time of the timeline; skipped (null) when its module is not loaded. */
    async function run(user, kind, payload, extraCtx) {
      if (!has(kind)) return null;
      n += 1;
      const label = RRS.commands.defs[kind].label || kind;
      const ctx = Object.assign({ user, now: T.tick() }, extraCtx || {});
      const r = await ledger.execute({ kind, payload, requestId: `demo-${pad(n)}-${kind}` }, ctx);
      // the same request id was saved already: another tab started the same sample a moment earlier – let it finish
      // (its commits reach this tab through the store) instead of building a second, half-matching story
      if (r.ok && r.duplicate) throw OTHER;
      if (!r.ok) throw new Error(`สร้างข้อมูลตัวอย่างไม่สำเร็จ ขั้นที่ ${n} (${label}): ${errText(r)} – ${HOW}`);
      written += 1;
      if (ledger.state.seq !== written) {
        throw new Error(`สร้างข้อมูลตัวอย่างไม่สำเร็จ ขั้นที่ ${n} (${label}): มีการบันทึกจากหน้าต่างหรือผู้ใช้อื่นระหว่างสร้างข้อมูลตัวอย่าง – ${HOW}`);
      }
      if (opts.onProgress) {
        try { opts.onProgress({ step: n, kind, label }); } catch (e) { /* progress display only */ }
      }
      return r;
    }
    const st = () => ledger.state;
    const res = (r, k) => (r && r.result ? r.result[k] : '');
    const jobLine = (jobNo, code) => {
      const j = RRS.q.get(st(), 'jobs', jobNo);
      const l = j && (j.lines || []).find((x) => x.code === code && !x.output);
      return l ? l.line : null;
    };
    const poLine = (poNo, code) => {
      const po = RRS.q.get(st(), 'pos', poNo);
      const l = po && (po.lines || []).find((x) => x.code === code);
      return l ? l.line : null;
    };
    try {
      return await build();
    } catch (e) {
      if (e !== OTHER) throw e;
      await ledger.catchUp();
      return { commits: ledger.state.seq, steps: n - 1, ms: Date.now() - started, jobs: [], today: T.today, concurrent: true };
    }

    async function build() {
      // ---- day −14: ground rules, master data, opening balances --------------------------------------------
      T.at(-14, '08:00');
      await run('', 'system.bootstrap', { name: ADMIN.name, userId: ADMIN.id, company: COMPANY });
      for (const u of USERS) await run(ADMIN.id, 'user.upsert', Object.assign({ create: true, warehouses: [] }, u));
      await run('DEMO_MGR', 'settings.update', { patch: {
        company: COMPANY,
        cutoffAt: T.iso(-14, '07:30'),
        pilot: { groups: [GROUP], warehouses: WAREHOUSES.map((w) => w.code), note: 'ขอบเขตตัวอย่าง: กระบะดั๊มพ์ 6 ล้อ ทั้งสามคลัง – ' + NOTE },
        express: { defaultWarehouse: '01' },
      } });
      T.at(-14, '08:30');
      await run(ADMIN.id, 'master.import', { warehouses: WAREHOUSES.map((w) => Object.assign({ create: true }, w)), bins: BINS,
        items: ITEMS, units: UNITS });
      await run('DEMO_ENG', 'bom.upsert', { product: 'DEMO-DB6', rev: 'A', drawingNo: 'DEMO-DWG-100', lines: BOM });
      await run('DEMO_ENG', 'bom.approve', { product: 'DEMO-DB6', rev: 'A' });
      const plans = {};
      for (const [code, stage, rev, ref, chars] of [
        ['DEMO-PL30', 'INCOMING', '', 'DEMO-WI-QC-01 ตรวจรับเหล็กแผ่น (ตัวอย่าง)', PLATE_PLAN],
        ['DEMO-SP-L', 'FINAL', 'B', 'DEMO-DWG-111 ฉบับ B (ตัวอย่าง)', PANEL_PLAN],
        ['DEMO-DB6', 'FINAL', 'A', 'DEMO-DWG-100 ฉบับ A (ตัวอย่าง)', BODY_PLAN],
      ]) {
        const p = await run('DEMO_ENG', 'qc.plan.save', { code, stage, drawingRev: rev, sourceRef: ref, sampling: 'ตรวจทุกชิ้น', chars });
        if (p) {
          plans[code] = res(p, 'id');
          await run('DEMO_QCLEAD', 'qc.plan.approve', { id: plans[code] });
        }
      }
      T.at(-14, '09:30');
      await run('DEMO_MGR', 'decision.record', { id: 'Q01', decidedBy: 'ตัวอย่าง – เจ้าของโครงการ + บัญชี + สโตร์', decidedOn: day(-14),
        answer: 'ตัวอย่าง: RRS เป็นเจ้าของจำนวนตามคลัง/ช่องเก็บ, Express เป็นเจ้าของต้นทุนและเอกสารบัญชี, ไฟล์ Express ใช้กระทบยอด ไม่เขียนทับ' });
      await run('DEMO_MGR', 'decision.record', { id: 'Q02', decidedBy: 'ตัวอย่าง – IT + สโตร์', decidedOn: day(-14),
        answer: 'ตัวอย่าง: ผู้ใช้ 10–20 คน บันทึกพร้อมกันผ่านบริการกลางทีละรายการ ไม่ต้องทำงาน offline' });
      await run('DEMO_MGR', 'kpi.record', { id: 'count_accuracy', baseline: 82, target: 95, measuredOn: day(-14), note: 'ค่าตัวอย่าง – ไม่ใช่ค่าที่วัดจริง' });
      await run('DEMO_MGR', 'kpi.record', { id: 'qc_wait', baseline: 36, target: 12, measuredOn: day(-14), note: 'ค่าตัวอย่าง – ไม่ใช่ค่าที่วัดจริง' });
      T.at(-14, '10:00');
      const aj = await run('DEMO_LEAD', 'doc.post', { type: 'AJ', ref: 'นับตั้งต้น (ตัวอย่าง)', remark: 'ยอดตั้งต้นตัวอย่าง ณ เวลาตัดยอด – ' + NOTE,
        lines: OPENING });
      await run('DEMO_STORE', 'lot.update', { code: 'DEMO-PL30', lot: 'HT-DEMO-2401', cert: { no: 'MTC-DEMO-2401', file: '' }, note: 'ใบรับรองตัวอย่าง' });
      await run('DEMO_QC', 'lot.verifyCert', { code: 'DEMO-PL30', lot: 'HT-DEMO-2401' });
      T.at(-14, '13:00');
      for (const s of SUPPLIERS) await run('DEMO_PUR', 'supplier.upsert', Object.assign({ create: true }, s));
      for (const t of TERMS) await run('DEMO_PUR', 'itemSupplier.upsert', t);
      await run('DEMO_PUR', 'reorder.set', { code: 'DEMO-BLT-M16', wh: '02', min: 200, max: 600, supplier: 'DEMO-SUP-HW' });

      // ---- day −13: bolts and locks ordered, never delivered (late) ----------------------------------------
      T.at(-13, '09:10');
      const poHw = await run('DEMO_PUR', 'po.create', { supplier: 'DEMO-SUP-HW', remark: 'ตัวอย่าง: เติมอุปกรณ์ยึดและตัวล็อก',
        lines: [{ code: 'DEMO-LOCK', qty: 4, dueDate: day(-4), wh: '02' }, { code: 'DEMO-BLT-M16', qty: 2, dueDate: day(-4), wh: '02' }] });
      if (poHw) await run('DEMO_PUR', 'po.issue', { poNo: res(poHw, 'poNo') });

      // ---- day −11: two jobs, one fully reserved, one short ------------------------------------------------
      T.at(-11, '08:40');
      const jobs = [];
      for (const [soNo, qty, due, priority] of [['SO-DEMO-001', 1, day(5), 2], ['SO-DEMO-002', 2, day(12), 3]]) {
        const j = await run('DEMO_PLAN', 'job.create', { soNo, product: 'DEMO-DB6', qty, dueDate: due, priority, remark: 'ใบงานตัวอย่าง' });
        if (j) jobs.push(res(j, 'jobNo'));
      }
      for (const m of MAKE) {
        const jobNo = jobs[m.job];
        if (!jobNo) continue;
        for (const code of Object.keys(m.make)) {
          const line = jobLine(jobNo, code);
          if (line != null) await run('DEMO_PLAN', 'job.setMake', { jobNo, line, toMake: m.make[code] });
        }
      }
      for (const jobNo of jobs) await run('DEMO_PLAN', 'reserve.auto', { jobNo });

      // ---- day −10 / −9: purchase request → approval → PO; hydraulics for the short job -------------------
      T.at(-10, '09:00');
      const pr = await run('DEMO_PLAN', 'pr.create', { remark: 'ตัวอย่าง: เหล็กแผ่นสำหรับใบงาน SO-DEMO-002 และเติม Min', lines: [
        { code: 'DEMO-PL45', qty: 4, needDate: day(3), wh: '01', supplier: 'DEMO-SUP-STEEL', reason: 'ใบงาน SO-DEMO-002 ยังขาดเหล็กแผ่น 4.5 มม.' },
        { code: 'DEMO-PL30', qty: 10, needDate: day(3), wh: '01', supplier: 'DEMO-SUP-STEEL', reason: 'ต่ำกว่า Min หลังจองให้ใบงาน' }] });
      let poSteel = null;
      if (pr) {
        T.at(-10, '11:00');
        await run('DEMO_PURLEAD', 'pr.approve', { prNo: res(pr, 'prNo'), remark: 'อนุมัติ (ตัวอย่าง)' });
        T.at(-10, '13:30');
        poSteel = await run('DEMO_PUR', 'po.create', { supplier: 'DEMO-SUP-STEEL', prNos: [res(pr, 'prNo')], remark: 'ตัวอย่าง' });
        if (poSteel) await run('DEMO_PUR', 'po.issue', { poNo: res(poSteel, 'poNo') });
      }
      T.at(-9, '10:00');
      const poHyd = await run('DEMO_PUR', 'po.create', { supplier: 'DEMO-SUP-HYD', remark: 'ตัวอย่าง: ชุดไฮดรอลิกสำหรับใบงาน SO-DEMO-002',
        lines: [{ code: 'DEMO-CYL', qty: 2, dueDate: day(10), wh: '02' }, { code: 'DEMO-PTO', qty: 2, dueDate: day(10), wh: '02' }] });
      if (poHyd) await run('DEMO_PUR', 'po.issue', { poNo: res(poHyd, 'poNo') });

      // ---- day −7: pick the plates for the first job, record the offcuts -----------------------------------
      T.at(-7, '08:20');
      let pdNo = '';
      if (jobs[0] && RRS.planning && has('pick.post')) {
        const lines = [];
        for (const p of RRS.planning.pickList(st(), jobs[0])) {
          if (['DEMO-PL30', 'DEMO-PL45', 'DEMO-CH100'].indexOf(p.code) < 0) continue;
          for (const s of p.suggest) lines.push({ reservationId: p.reservationId, qty: s.qty, wh: p.wh, bin: s.bin, lot: s.lot, scannedCode: p.code });
        }
        if (lines.length) {
          const pd = await run('DEMO_STORE', 'pick.post', { jobNo: jobs[0], lines, remark: 'ตัวอย่าง: จ่ายเหล็กแผ่นและเหล็กรางน้ำไปตัด/พับ' });
          pdNo = res(pd, 'docNo');
        }
      }
      T.at(-7, '15:30');
      const made = `${jobs[0] || 'SO-DEMO-001'}${pdNo ? ' (' + pdNo + ')' : ''}`;
      await run('DEMO_PROD', 'offcut.add', { code: 'DEMO-PL30', width: 600, length: 1200, wh: '01', bin: 'RM-OFF', sourceLot: 'HT-DEMO-2401',
        createdFrom: `เศษจากตัดแผงข้าง ${made}`, remark: 'ตัวอย่าง' });
      await run('DEMO_PROD', 'offcut.add', { code: 'DEMO-PL45', width: 450, length: 1800, wh: '01', bin: 'RM-OFF', sourceLot: 'HT-DEMO-2402',
        createdFrom: `เศษจากตัดพื้นกระบะ ${made}`, remark: 'ตัวอย่าง' });
      const oc = await run('DEMO_PROD', 'offcut.add', { code: 'DEMO-PL30', width: 900, length: 1100, wh: '01', bin: 'RM-OFF',
        sourceLot: 'HT-DEMO-2401', createdFrom: `เศษจากตัดฝาท้าย ${made}`, remark: 'ตัวอย่าง' });
      if (oc) {
        await run('DEMO_PROD', 'offcut.use', { id: res(oc, 'id'), usedFor: 'ตัวอย่าง: แผ่นปิดมุมฝาท้าย SO-DEMO-001',
          remaining: [{ width: 300, length: 900, bin: 'RM-OFF', remark: 'เศษเหลือหลังตัด' }] });
      }

      // ---- day −6: part of the plate PO arrives in two heats (waits for QC) + mill certificates -------------
      T.at(-6, '09:15');
      let rrNo = '';
      if (poSteel) {
        const poNo = res(poSteel, 'poNo');
        const line = poLine(poNo, 'DEMO-PL30');
        const rr = await run('DEMO_STORE', 'po.receive', { poNo, supplierDoc: 'DN-DEMO-0001', remark: 'ตัวอย่าง: ผู้ขายส่งก่อนบางส่วน', lines: [
          { line, qty: 4, bin: 'RM-RCV', lot: 'HT-DEMO-2410' }, { line, qty: 2, bin: 'RM-RCV', lot: 'HT-DEMO-2411' }] });
        rrNo = res(rr, 'docNo');
        T.at(-6, '10:00');
        await run('DEMO_STORE', 'lot.update', { code: 'DEMO-PL30', lot: 'HT-DEMO-2410', cert: { no: 'MTC-DEMO-2410', file: '' }, note: 'ใบรับรองตัวอย่าง' });
        await run('DEMO_STORE', 'lot.update', { code: 'DEMO-PL30', lot: 'HT-DEMO-2411', cert: { no: 'MTC-DEMO-2411', file: '' }, note: 'ใบรับรองตัวอย่าง' });
        await run('DEMO_QC', 'lot.verifyCert', { code: 'DEMO-PL30', lot: 'HT-DEMO-2410' });
      }

      // ---- day −5: incoming inspection – one PASS released, one FAIL → NCR decided REWORK ------------------
      T.at(-5, '09:00');
      if (rrNo && plans['DEMO-PL30']) {
        const insp = (lot, qty, surface, note) => run('DEMO_QC', 'qc.inspect', { stage: 'INCOMING', code: 'DEMO-PL30', wh: '01', bin: 'RM-RCV',
          lot, qty, planId: plans['DEMO-PL30'], sourceDoc: rrNo, note, results: [
            { char: 'ความหนา', value: 3.02 }, { char: 'ความยาวแผ่น', value: 2439 }, { char: 'ผิว/สนิม', value: surface },
            { char: 'เลข Heat ตรงใบรับรอง', value: 'ผ่าน' }] });
        const pass = await insp('HT-DEMO-2410', 4, 'ผ่าน', 'ตัวอย่าง: ผ่านทุกหัวข้อ');
        if (pass) await run('DEMO_QCLEAD', 'qc.release', { id: res(pass, 'id') });
        T.at(-5, '10:30');
        const fail = await insp('HT-DEMO-2411', 2, 'ไม่ผ่าน', 'ตัวอย่าง: สนิมผิวด้านล่างทั้งสองแผ่น');
        if (fail && res(fail, 'ncrNo')) {
          await run('DEMO_QCLEAD', 'ncr.disposition', { ncrNo: res(fail, 'ncrNo'), disposition: 'REWORK',
            reason: 'ตัวอย่าง: ขัดสนิมผิว ทารองพื้นกันสนิม แล้วส่งตรวจซ้ำ' });
        }
      }

      // ---- day −4: a side panel finished and received into QC_HOLD ----------------------------------------
      T.at(-4, '14:00');
      if (jobs[0]) {
        const line = jobLine(jobs[0], 'DEMO-SP-L');
        if (line != null) await run('DEMO_PROD', 'job.record', { jobNo: jobs[0], line, qty: 1, remark: 'ตัวอย่าง: ตัด/พับ/เชื่อมเสร็จ' });
        T.at(-4, '15:30');
        await run('DEMO_STORE', 'doc.post', { type: 'FR', job: jobs[0], remark: 'ตัวอย่าง: รับแผงข้างซ้ายจากการผลิต (รอ QC ก่อนประกอบ)',
          lines: [{ code: 'DEMO-SP-L', qty: 1, wh: '02', bin: 'WIP-L1' }] });
      }

      // ---- day −3: welding wire on its way to the shop floor (transfer still in transit) --------------------
      T.at(-3, '10:00');
      const tr = await run('DEMO_STORE', 'doc.post', { type: 'TR', remark: 'ตัวอย่าง: ส่งลวดเชื่อมไปชั้นหน้างาน (ยังไม่รับปลายทาง)',
        lines: [{ code: 'DEMO-WIRE', qty: 1, unit: 'ม้วน', wh: '01', bin: 'RM-C1', toWh: '02', toBin: 'WIP-C1' }] });
      const trNo = res(tr, 'docNo');

      // ---- day −2: Express stock file of warehouse 01 with a few differences ------------------------------
      T.at(-2, '09:30');
      if (has('express.import') && RRS.reconcile && RRS.reconcile.rrsQtyAt) {
        const snapshotAt = T.iso(-3, '17:00');
        const rows = [];
        for (const it of ITEMS) {
          const q = RRS.reconcile.rrsQtyAt(st(), it.code, '01', snapshotAt);
          if (!q) continue;
          let qty = q;
          if (it.code === 'DEMO-CH100') qty = util.round(q + 56); // one bar more in Express – waiting for an answer
          if (it.code === 'DEMO-WIRE') qty = util.round(q + 15); // the transfer is not keyed in Express (ค-11)
          rows.push({ row: rows.length + 2, code: it.expressCode || it.code, wh: '01', qty, unit: it.baseUnit });
        }
        rows.push({ row: rows.length + 2, code: 'E-9999', wh: '01', qty: 3, unit: 'ชิ้น' }); // not in the item register
        const csv = ['รหัสสินค้า,คลัง,จำนวน,หน่วย'].concat(rows.map((r) => [r.code, r.wh, r.qty, r.unit].join(','))).join('\n');
        const imp = await run('DEMO_LEAD', 'express.import', { fileName: 'DEMO-Express-คลัง01.csv', fileHash: util.sha256(csv), snapshotAt,
          source: 'Express (ไฟล์ตัวอย่าง)', rows });
        if (imp && trNo) {
          await run('DEMO_ACC', 'express.resolve', { batchId: res(imp, 'batchId'), lines: [{ code: 'DEMO-WIRE', wh: '01', action: 'explain',
            reason: `ตัวอย่าง: ${trNo} โอนลวดเชื่อมไปคลัง 02 – ใบโอนยังไม่มีประเภทเอกสารใน Express (ค-11)` }] });
        }
      }
      T.at(-2, '11:00');
      if (aj) await run('DEMO_ACC', 'doc.markExpress', { docNo: res(aj, 'docNo'), expressNo: 'DEMO-EXP-AJ-0001' });
      if (pdNo) await run('DEMO_ACC', 'doc.markExpress', { docNo: pdNo, expressNo: 'DEMO-EXP-PD-0001' });

      // ---- day −1: count with differences waiting for approval, UAT examples, Sales Office job, daily check --
      T.at(-1, '08:30');
      const ct = await run('DEMO_LEAD', 'count.create', { wh: '01', bins: ['RM-C1'], note: 'ตัวอย่าง: นับวัสดุสิ้นเปลืองประจำสัปดาห์' });
      if (ct) {
        const id = res(ct, 'id');
        const counted = [['DEMO-PAINT-P', 30], ['DEMO-DISC', 47], ['DEMO-PAINT-B', 18], ['DEMO-WIRE', 30]]
          .map(([code, c]) => ({ code, bin: 'RM-C1', counted: c }));
        await run('DEMO_STORE', 'count.enter', { id, lines: counted });
        T.at(-1, '09:30');
        // big differences need a second count by another person (the store lead counts again and finds the same)
        await run('DEMO_LEAD', 'count.enter', { id, lines: counted.filter((l) => l.code === 'DEMO-PAINT-P' || l.code === 'DEMO-DISC') });
        await run('DEMO_STORE', 'count.submit', { id });
      }
      T.at(-1, '13:00');
      for (const [id, status, evidence, note] of [
        ['P1-1', 'PASS', 'ตัวอย่าง: ทดสอบในหน้า ทดสอบรับงาน (เบิกจากคลัง 02 ไม่กระทบคลัง 01)', NOTE],
        ['P1-2', 'NOT_RUN', '', 'ตัวอย่าง: รอทดสอบเบิกชิ้นสุดท้ายจากสองเครื่องพร้อมกัน'],
        ['P2-1', 'FAIL', 'ตัวอย่าง: ทดสอบจอง SO-DEMO-001/002', 'ตัวอย่างผลไม่ผ่าน: ผู้ทดสอบเข้าใจหน้าจอผิด ต้องทดสอบใหม่ – ' + NOTE],
        ['P3-3', 'NOT_RUN', '', 'ตัวอย่าง: รอรอบนับจริงของคลัง 02'],
      ]) await run('DEMO_LEAD', 'uat.record', { id, status, evidence, note });
      await run('DEMO_LEAD', 'training.record', { userId: 'DEMO_STORE', role: 'store', topic: 'ตัวอย่าง: รับ–เบิก–โอน และการสแกนหยิบตามใบจัดชุด',
        trainedOn: day(-1), note: NOTE });
      await run('DEMO_STORE', 'pilot.issue', { severity: 'MINOR', area: 'คลังวัตถุดิบ', description: 'ตัวอย่าง: ป้ายช่องเก็บ RM-A2 ซีด สแกนไม่ติด', ref: 'RM-A2' });
      if (has('sales.syncJob') && RRS.sales) {
        // a production job as the Sales Office connector would send it (ids only, no customer name) – not mapped to a BOM yet
        const payload = { orderNumber: 'SO-DEMO-003', customerId: 'DEMO-CUST-01', dealId: 'DEMO-DEAL-01', vehicle: 'รถบรรทุก 6 ล้อ (ตัวอย่าง)',
          due: day(20), cancelled: false,
          items: [{ lineId: 'DEMO-L1', description: 'กระบะดั๊มพ์ 6 ล้อ ตามแบบมาตรฐาน (ตัวอย่าง)', qty: '1', unit: 'ชุด', productId: 'DEMO-PRD-DB6' }],
          release: { allowed: false, blockers: ['ตัวอย่าง: รอยืนยันแบบกับลูกค้า'], drawingRevision: null, bomRevision: null, bomFingerprint: null } };
        await run(ADMIN.id, 'sales.syncJob', { schemaVersion: 1, type: 'upsert_draft', workspace: 'domestic', commandId: 'DEMO-CMD-0001',
          orderId: 'DEMO-ORD-0003', productionJobId: 'DEMO-PJ-0003', version: 1, payloadHash: util.sha256(JSON.stringify(payload)), payload },
        { via: 'sales-bridge:domestic' });
      }
      T.at(-1, '17:00');
      await run('DEMO_LEAD', 'daily.check', { note: 'ตัวอย่าง: ตรวจยอดประจำวันก่อนปิดงาน' });

      await ledger.catchUp();
      return { commits: ledger.state.seq, steps: n, ms: Date.now() - started, jobs, today: T.today };
    }
  }

  /** Is this code / id part of the sample (DEMO- / DEMO_ / SO-DEMO-)? */
  function isSample(code) {
    const c = util.normCode(code);
    return c.indexOf(PREFIX) === 0 || c.indexOf('DEMO_') === 0 || c.indexOf('SO-DEMO-') === 0;
  }
  /** Does a state look like this sample (company name + DEMO items)? Screens use it to label the data. */
  function isSampleState(state) {
    const s = state && RRS.q.get(state, 'settings', 'main');
    return !!s && s.company === COMPANY && rowsOf(state, 'items', (i) => isSample(i.id)).length > 0;
  }

  RRS.fixture = { load, isSample, isSampleState, COMPANY, PREFIX, NOTE, USERS, ADMIN, WAREHOUSES, ITEMS: ITEMS.map((i) => i.code) };
})(typeof globalThis !== 'undefined' ? globalThis : this);
