/*
 * Phase 0 – master data and ground rules: settings, users/roles, warehouses, bins (ช่องเก็บ), items with codes and
 * units, BOM / drawing revisions, the business decisions (ค-1 … ค-11) and baseline KPIs.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { util, schema, commands, auth } = RRS;
  const define = commands.define;


  schema.define('settings', {
    label: 'ค่าตั้งระบบและนโยบาย', phase: 0, key: 'id',
    fields: [['id', 'text', 'main'], ['company', 'text', 'ชื่อบริษัท'], ['pilot', 'json', 'ขอบเขตทดลอง (กลุ่ม/คลัง)'],
      ['ownership', 'json', 'ระบบเจ้าของข้อมูลแต่ละชนิด'], ['cutoffAt', 'datetime', 'เวลาตัดยอดตั้งต้น'],
      ['policies', 'json', 'นโยบาย (ติดลบ, แยกหน้าที่, รับเกิน, นับซ้ำ …)'], ['express', 'json', 'ค่า Express']],
  });
  schema.define('users', {
    label: 'ผู้ใช้และบทบาท', phase: 0, key: 'id',
    fields: [['id', 'text', 'รหัสผู้ใช้'], ['name', 'text', 'ชื่อ'], ['roles', 'list', 'บทบาท'],
      ['warehouses', 'list', 'คลังที่ทำรายการได้ (ว่าง = ทุกคลัง)'], ['active', 'bool', 'ใช้งาน'],
      ['accountId', 'text', 'บัญชีเข้าระบบที่ผูกไว้']],
  });
  schema.define('warehouses', {
    label: 'คลัง', phase: 0, key: 'code',
    fields: [['code', 'text', 'รหัสคลัง'], ['name', 'text', 'ชื่อคลัง'], ['expressCode', 'text', 'รหัสคลังใน Express'],
      ['requireBin', 'bool', 'ต้องระบุช่องเก็บ'], ['active', 'bool', 'ใช้งาน']],
  });
  schema.define('bins', {
    label: 'ช่องเก็บ', phase: 0, key: ['wh', 'code'],
    fields: [['wh', 'text', 'คลัง'], ['code', 'text', 'ช่องเก็บ เช่น P-POST-04'], ['name', 'text', 'คำอธิบาย'],
      ['active', 'bool', 'ใช้งาน']],
  });
  schema.define('items', {
    label: 'ทะเบียนสินค้า', phase: 0, key: 'id',
    fields: [['id', 'text', 'รหัสสินค้า (หลัก)'], ['name', 'text', 'ชื่อสินค้า'], ['type', 'enum', 'ประเภท', 'RM/PART/SUB/FG/BUY/CONS'],
      ['group', 'text', 'กลุ่ม/กลุ่มประกอบ'], ['baseUnit', 'text', 'หน่วยหลัก'], ['expressCode', 'text', 'รหัส Express'],
      ['countCode', 'text', 'รหัสนับสต็อก'], ['model', 'text', 'รุ่นรถ/รุ่นกระบะ'], ['side', 'enum', 'ข้าง', 'L/R/ว่าง'],
      ['drawingNo', 'text', 'เลขที่แบบ'], ['drawingRev', 'text', 'ฉบับแบบที่อนุมัติ'],
      ['trackLot', 'enum', 'ติดตาม', 'none/lot/heat/serial'], ['certRequired', 'bool', 'ต้องมีใบรับรองวัสดุ'],
      ['qcIncoming', 'bool', 'ต้องตรวจรับ'], ['qcFinal', 'bool', 'ต้องตรวจเมื่อผลิตเสร็จ'],
      ['material', 'text', 'วัสดุ'], ['thickness', 'number', 'ความหนา (มม.)'], ['width', 'number', 'กว้าง (มม.)'],
      ['length', 'number', 'ยาว (มม.)'], ['minQty', 'number', 'Min'], ['maxQty', 'number', 'Max'],
      ['unitCost', 'number', 'ราคาต่อหน่วย (อ้างอิง)'], ['active', 'bool', 'ใช้งาน'], ['remark', 'text', 'หมายเหตุ']],
  });
  schema.define('item_units', {
    label: 'หน่วยและตัวคูณ', phase: 0, key: ['code', 'unit'],
    fields: [['code', 'text', 'รหัสสินค้า'], ['unit', 'text', 'หน่วย'], ['factor', 'number', 'เท่ากับกี่หน่วยหลัก']],
  });
  schema.define('boms', {
    label: 'BOM / ฉบับแบบ', phase: 0, key: ['product', 'rev'],
    fields: [['product', 'text', 'รหัสสินค้าที่ผลิต'], ['rev', 'text', 'ฉบับ'], ['drawingNo', 'text', 'เลขที่แบบ'],
      ['status', 'enum', 'สถานะ', 'DRAFT/APPROVED/OBSOLETE'], ['lines', 'json', 'รายการชิ้นส่วน {code, qty, unit}'],
      ['approvedBy', 'text', 'ผู้อนุมัติ'], ['approvedAt', 'datetime', 'อนุมัติเมื่อ']],
  });
  schema.define('decisions', {
    label: 'คำถาม/ข้อตกลง Phase 0', phase: 0, key: 'id',
    fields: [['id', 'text', 'ข้อ'], ['answer', 'text', 'ข้อสรุป'], ['decidedBy', 'text', 'ผู้ตัดสิน (ชื่อ/ตำแหน่ง)'],
      ['decidedOn', 'date', 'วันที่ตัดสิน'], ['status', 'enum', 'สถานะ', 'open/decided'], ['recordedBy', 'text', 'ผู้บันทึก']],
  });
  schema.define('kpis', {
    label: 'ตัวชี้วัดค่าตั้งต้น', phase: 0, key: 'id',
    fields: [['id', 'text', 'ตัวชี้วัด'], ['label', 'text', 'ชื่อ'], ['unit', 'text', 'หน่วย'], ['baseline', 'number', 'ค่าก่อนเริ่ม'],
      ['target', 'number', 'เป้าหมาย'], ['measuredOn', 'date', 'วันที่วัด'], ['note', 'text', 'วิธีวัด/หมายเหตุ']],
  });

  const ITEM_TYPES = { RM: 'วัตถุดิบ', PART: 'ชิ้นส่วนผลิต', SUB: 'ชุดประกอบย่อย', FG: 'สินค้าสำเร็จรูป', BUY: 'ชิ้นส่วนซื้อสำเร็จ',
    CONS: 'วัสดุสิ้นเปลือง' };
  const TRACK = { none: 'ไม่ติดตาม', lot: 'ล็อต', heat: 'Heat no.', serial: 'Serial' };

  /** Business questions to settle in Phase 0 (from the Phase 0 audit, docs/PHASE0_STOCK_QC_AUDIT.md §5). */
  const QUESTIONS = [
    { id: 'Q01', no: 'ค-1', title: 'ยอดจำนวนของกลุ่มทดลอง ระบบไหนเป็นเจ้าของ (RRS หรือ Express) และต้นทุน/เอกสารบัญชีเป็นของใคร',
      why: 'ถ้าไม่ตกลง การนำเข้า Express จะทับยอดที่บันทึกในระบบนี้', proposal: 'RRS เป็นเจ้าของจำนวนตามคลัง/ช่องเก็บ, Express เป็นเจ้าของต้นทุนและเอกสารบัญชี, ไฟล์ Express ใช้กระทบยอด ไม่เขียนทับ',
      who: 'บัญชี + สโตร์ + เจ้าของโครงการ' },
    { id: 'Q02', no: 'ค-2', title: 'มีผู้ใช้กี่คน/กี่เครื่องบันทึกพร้อมกัน ต้องทำงาน offline ไหม',
      why: 'ตัดสินวิธีเก็บข้อมูลกลางและการล็อกการบันทึก', proposal: 'เว็บบน Cloudflare ผู้ใช้ 10–20 คน บันทึกผ่านบริการกลางที่เรียงคำสั่งทีละรายการ แล้วเก็บลง Google Sheet',
      who: 'IT + สโตร์' },
    { id: 'Q03', no: 'ค-3', title: 'รายชื่อคลังและช่องเก็บของกลุ่มทดลอง และคลังใน Express ตรงกับคลังจริงใด',
      why: 'เป็นกุญแจของยอดคงเหลือ', proposal: 'ช่องเก็บอยู่ภายใต้คลัง; จับคู่รหัสคลัง Express ทีละคลังในหน้า คลัง', who: 'สโตร์ + บัญชี' },
    { id: 'Q04', no: 'ค-4', title: 'หน่วยหลักต่อรหัส และตัวคูณ แผ่น–กิโลกรัม–ชิ้น (ผน/สน/ชน)', why: 'ต้องตรวจหน่วยตอนบันทึก',
      proposal: 'เก็บยอดเป็นหน่วยหลักหน่วยเดียว หน่วยอื่นต้องมีตัวคูณ ไม่มี = บันทึกไม่ได้', who: 'สโตร์ + วิศวกรรม + บัญชี' },
    { id: 'Q05', no: 'ค-5', title: 'ยอดตั้งต้นมาจากไหน ตัดยอด ณ วันเวลาใด เอกสารที่ยังไม่คีย์ Express จัดการอย่างไร',
      why: 'วิธีย้ายข้อมูลและกระทบยอดครั้งแรก', proposal: 'นับจริงกลุ่มทดลอง ณ เวลาตัดยอด แล้วบันทึกเป็นใบปรับยอดยอดตั้งต้น', who: 'สโตร์ + บัญชี' },
    { id: 'Q06', no: 'ค-6', title: 'ใครมีสิทธิ์รับ/เบิก/ปรับยอด/โอน/ยกเลิก/อนุมัติข้อยกเว้น', why: 'ทุกเอกสารต้องมีผู้ทำ เวลา เหตุผล',
      proposal: 'ตั้งในหน้า ผู้ใช้และสิทธิ์ ตามบทบาท', who: 'เจ้าของโครงการ + หัวหน้าสโตร์' },
    { id: 'Q07', no: 'ค-7', title: 'ยอมให้ยอดติดลบได้ไหม กรณีใด ใครอนุมัติ', why: 'ค่าเริ่มต้นคือบล็อก',
      proposal: 'บล็อกเสมอ ข้อยกเว้นต้องมีผู้อนุมัติ (หัวหน้าสโตร์/บัญชี) + เหตุผลบันทึกในเอกสาร', who: 'บัญชี + หัวหน้าสโตร์' },
    { id: 'Q08', no: 'ค-8', title: 'กลุ่มชิ้นส่วน + คลังที่ใช้ทดลอง ตัวชี้วัดฐาน ผู้ตรวจรับ และแผนกู้คืน', why: 'เริ่มเล็กก่อนขยาย',
      proposal: 'หนึ่งกลุ่มประกอบในคลังเดียว', who: 'เจ้าของโครงการ' },
    { id: 'Q09', no: 'ค-9', title: 'รหัสเดียวกันอยู่หลายไฟล์และยอดไม่ตรงกัน ให้ยึดแหล่งใด', why: 'ระบบเดิมเลือกแหล่งแรกแบบเงียบ',
      proposal: 'รายงานรหัสที่ขัดกันให้สโตร์เลือก ไม่เลือกอัตโนมัติ', who: 'สโตร์' },
    { id: 'Q10', no: 'ค-10', title: 'งานรับ SO จาก Sale Office (branch bridge) จะเชื่อมกับระบบนี้อย่างไร', why: 'การจองราย SO ต้องใช้เลข SO เดียวกัน',
      proposal: 'ใช้เลข SO/ใบงานตรงตัว ไม่จับคู่จากชื่อ', who: 'เจ้าของโครงการ + ผู้พัฒนา' },
    { id: 'Q11', no: 'ค-11', title: 'เอกสารโอนคลัง/คืนของ/คืนผู้ขาย/ส่งมอบ ใน Express ใช้ประเภทใด', why: 'เพื่อออกร่างคีย์ Express ให้ตรง',
      proposal: 'ใช้เลขที่ภายในไปก่อนจนบัญชียืนยัน', who: 'บัญชี' },
  ];
  const KPI_DEFAULTS = [
    { id: 'count_accuracy', label: 'ความแม่นยำการนับ', unit: '%' },
    { id: 'issue_lead', label: 'เวลารับ–เบิกเฉลี่ย', unit: 'นาที' },
    { id: 'shortage', label: 'จำนวนครั้งของขาดต่อเดือน', unit: 'ครั้ง' },
    { id: 'qc_wait', label: 'เวลารอ QC เฉลี่ย', unit: 'ชั่วโมง' },
    { id: 'fpy', label: 'อัตราผ่าน QC ครั้งแรก', unit: '%' },
    { id: 'repeat_ncr', label: 'ปัญหาซ้ำต่อเดือน', unit: 'ครั้ง' },
  ];

  const bool = (v, d) => (v == null || v === '' ? d : v === true || v === 'true' || v === 1 || v === '1' || v === 'Y' || v === 'ใช่');
  const numOr = (v, d) => {
    const n = util.num(v);
    return isNaN(n) ? d : n;
  };

  // ---- bootstrap / settings / users ---------------------------------------------------------------------
  define('system.bootstrap', {
    label: 'เริ่มระบบ', bootstrap: true,
    prepare(tx, p) {
      if (tx.all('users').length) return tx.error('ALREADY_STARTED', 'ระบบมีผู้ใช้แล้ว');
      const id = util.normCode(p.userId || 'ADMIN');
      const name = util.trim(p.name);
      if (!name) return tx.error('REQUIRED', 'กรอกชื่อผู้ดูแลระบบ', { field: 'name' });
      tx.put('settings', 'main', Object.assign(RRS.defaultSettings(), { id: 'main', company: util.trim(p.company) }));
      tx.put('users', id, { id, name, roles: ['admin'], warehouses: [], active: true, accountId: p.accountId || '' });
      for (const k of KPI_DEFAULTS) tx.put('kpis', k.id, Object.assign({ baseline: null, target: null, measuredOn: '', note: '' }, k));
      for (const qn of QUESTIONS) tx.put('decisions', qn.id, { id: qn.id, answer: '', decidedBy: '', decidedOn: '', status: 'open', recordedBy: '' });
      tx.summary = `เริ่มระบบ ผู้ดูแล ${name}`;
      tx.result.userId = id;
    },
  });

  define('settings.update', {
    label: 'แก้ค่าตั้งระบบ', perm: 'settings.edit',
    prepare(tx, p) {
      const cur = tx.settings();
      const next = util.clone(cur);
      const patch = p.patch || {};
      for (const k of ['company', 'cutoffAt']) if (k in patch) next[k] = util.trim(patch[k]);
      for (const k of ['pilot', 'ownership', 'policies', 'express']) {
        if (patch[k] && typeof patch[k] === 'object') next[k] = Object.assign({}, cur[k] || {}, patch[k]);
      }
      const pol = next.policies;
      if (['block', 'approve'].indexOf(pol.negativeStock) < 0) return tx.error('BAD_VALUE', 'นโยบายติดลบต้องเป็น block หรือ approve', { field: 'negativeStock' });
      if (['timestamp', 'freeze'].indexOf(pol.countMode) < 0) return tx.error('BAD_VALUE', 'วิธีตรวจนับต้องเป็น timestamp หรือ freeze', { field: 'countMode' });
      for (const k of ['overReceivePct', 'recountPct', 'recountQty', 'nonMovingDays']) {
        const n = util.num(pol[k]);
        if (isNaN(n) || n < 0) return tx.error('BAD_VALUE', `ค่า ${k} ต้องเป็นตัวเลขไม่ติดลบ`, { field: k });
        pol[k] = n;
      }
      next.id = 'main';
      tx.put('settings', 'main', next);
      tx.summary = 'แก้ค่าตั้งระบบ';
    },
  });

  /** Codes are joined with '|' into row keys, so they may not contain '|' or control characters. */
  const BAD_CODE = /[|\u0000-\u001f\u007f]/;
  function codeOk(tx, code, what, where) {
    if (BAD_CODE.test(code)) return tx.error('BAD_CODE', `${what} "${code}" มีอักขระที่ใช้ไม่ได้ (| หรืออักขระควบคุม)`, where);
    return true;
  }
  /** payload.create === true: adding a new record – refuse when the key exists instead of overwriting it. */
  function createOnly(tx, p, table, key, label, where) {
    if (p.create === true && tx.get(table, key)) return tx.error('DUPLICATE', `${label} ${key} มีอยู่แล้ว – เปิดรายการเดิมเพื่อแก้ไขแทน`, where);
    return true;
  }
  RRS.master_codeOk = codeOk;

  define('user.upsert', {
    label: 'บันทึกผู้ใช้', perm: 'users.manage',
    prepare(tx, p) {
      const id = util.normCode(p.id);
      if (!id) return tx.error('REQUIRED', 'กรอกรหัสผู้ใช้', { field: 'id' });
      if (/\s/.test(id) || !codeOk(tx, id, 'รหัสผู้ใช้', { field: 'id' })) return tx.error('BAD_CODE', 'รหัสผู้ใช้ห้ามมีช่องว่างหรือ |', { field: 'id' });
      if (!createOnly(tx, p, 'users', id, 'ผู้ใช้', { field: 'id' })) return;
      const name = util.trim(p.name);
      if (!name) return tx.error('REQUIRED', 'กรอกชื่อ', { field: 'name' });
      const roles = (p.roles || []).filter((r) => auth.ROLES[r]);
      if (!roles.length) return tx.error('REQUIRED', 'เลือกอย่างน้อย 1 บทบาท', { field: 'roles' });
      const whs = (p.warehouses || []).map(util.normCode).filter(Boolean);
      for (const w of whs) if (!tx.get('warehouses', w)) return tx.error('NOT_FOUND', `ไม่พบคลัง ${w}`, { field: 'warehouses' });
      const active = bool(p.active, true);
      const prev = tx.get('users', id);
      if (prev && prev.roles.indexOf('admin') >= 0 && (roles.indexOf('admin') < 0 || !active)) {
        const admins = tx.all('users', (u) => u.active !== false && u.roles.indexOf('admin') >= 0 && u.id !== id);
        if (!admins.length) return tx.error('LAST_ADMIN', 'ต้องมีผู้ดูแลระบบที่ใช้งานอย่างน้อย 1 คน');
      }
      const accountId = util.trim(p.accountId);
      if (accountId && util.badKey(accountId)) return tx.error('BAD_KEY', `ชื่อบัญชี "${accountId}" ใช้ไม่ได้`, { field: 'accountId' });
      if (accountId) {
        const other = tx.all('users', (u) => u.accountId === accountId && u.id !== id)[0];
        if (other) return tx.error('DUPLICATE', `บัญชีนี้ผูกกับผู้ใช้ ${other.name} แล้ว`, { field: 'accountId' });
      }
      tx.put('users', id, { id, name, roles, warehouses: whs, active, accountId });
      if (accountId && tx.get('access_requests', accountId)) {
        tx.put('access_requests', accountId, Object.assign({}, tx.get('access_requests', accountId), { status: 'DONE', userId: id }));
      }
      tx.summary = `${prev ? 'แก้' : 'เพิ่ม'}ผู้ใช้ ${name}`;
    },
  });

  schema.define('access_requests', {
    label: 'คำขอใช้งาน', phase: 0, key: 'accountId',
    fields: [['accountId', 'text', 'บัญชีที่ขอ'], ['name', 'text', 'ชื่อที่แจ้ง'], ['note', 'text', 'ตำแหน่ง/หน้าที่'],
      ['at', 'datetime', 'ขอเมื่อ'], ['status', 'enum', 'สถานะ', 'OPEN/DONE']],
  });
  /** Someone signed in but not in the user list asks for access (the admin then adds them in user.upsert). */
  define('user.requestAccess', {
    label: 'ขอใช้งานระบบ', public: true,
    prepare(tx, p) {
      const accountId = util.trim(tx.ctx.via);
      if (!accountId) return tx.error('NO_ACCOUNT', 'ต้องเข้าสู่ระบบก่อนขอใช้งาน');
      if (tx.all('users', (u) => u.accountId === accountId).length) return tx.error('ALREADY_USER', 'บัญชีนี้มีสิทธิ์ใช้งานแล้ว');
      const name = util.trim(p.name);
      if (!name) return tx.error('REQUIRED', 'กรอกชื่อ', { field: 'name' });
      tx.put('access_requests', accountId, { accountId, name: name.slice(0, 60), note: util.trim(p.note).slice(0, 120), at: tx.now, status: 'OPEN' });
      tx.summary = `${name} ขอใช้งานระบบ`;
    },
  });

  // ---- warehouses / bins ---------------------------------------------------------------------------------
  function upsertWarehouse(tx, p, where) {
    const code = util.normCode(p.code);
    if (!code) return tx.error('REQUIRED', 'กรอกรหัสคลัง', Object.assign({ field: 'code' }, where));
    if (code === RRS.TRANSIT) return tx.error('RESERVED', `${RRS.TRANSIT} สงวนไว้สำหรับของระหว่างโอน`, Object.assign({ field: 'code' }, where));
    if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) return tx.error('BAD_CODE', 'รหัสคลังใช้ A-Z 0-9 - _', Object.assign({ field: 'code' }, where));
    if (!createOnly(tx, p, 'warehouses', code, 'คลัง', Object.assign({ field: 'code' }, where))) return null;
    const name = util.trim(p.name) || code;
    const active = bool(p.active, true);
    const prev = tx.get('warehouses', code);
    if (prev && prev.active !== false && !active && tx.qty({ wh: code }) !== 0) {
      return tx.error('HAS_STOCK', `คลัง ${code} ยังมียอดคงเหลือ – ปิดใช้งานไม่ได้`, where);
    }
    tx.put('warehouses', code, { code, name, expressCode: util.trim(p.expressCode), requireBin: bool(p.requireBin, false), active });
    return code;
  }
  function upsertBin(tx, p, where) {
    const wh = util.normCode(p.wh);
    const code = util.normCode(p.code);
    if (!tx.get('warehouses', wh)) return tx.error('NOT_FOUND', `ไม่พบคลัง ${wh}`, Object.assign({ field: 'wh' }, where));
    if (!code) return tx.error('REQUIRED', 'กรอกรหัสช่องเก็บ', Object.assign({ field: 'code' }, where));
    if (/\s/.test(code) || BAD_CODE.test(code)) return tx.error('BAD_CODE', `รหัสช่องเก็บ "${code}" ห้ามมีช่องว่างหรือ |`, Object.assign({ field: 'code' }, where));
    if (!createOnly(tx, p, 'bins', wh + '|' + code, 'ช่องเก็บ', Object.assign({ field: 'code' }, where))) return null;
    const active = bool(p.active, true);
    const prev = tx.get('bins', wh + '|' + code);
    if (prev && prev.active !== false && !active && tx.qty({ wh, bin: code }) !== 0) {
      return tx.error('HAS_STOCK', `ช่อง ${code} ยังมียอดคงเหลือ – ปิดใช้งานไม่ได้`, where);
    }
    tx.putRow('bins', { wh, code, name: util.trim(p.name), active });
    return code;
  }
  define('warehouse.upsert', {
    label: 'บันทึกคลัง', perm: 'master.edit',
    prepare(tx, p) {
      const code = upsertWarehouse(tx, p);
      if (code) tx.summary = `บันทึกคลัง ${code}`;
    },
  });
  define('bin.upsert', {
    label: 'บันทึกช่องเก็บ', perm: 'master.edit',
    prepare(tx, p) {
      const code = upsertBin(tx, p);
      if (code) tx.summary = `บันทึกช่องเก็บ ${util.normCode(p.wh)}/${code}`;
    },
  });

  // ---- items ---------------------------------------------------------------------------------------------
  /** Codes that would be read as the same code (spaces, dashes and case ignored) by another item. */
  function codeClash(tx, id, codes) {
    const keys = codes.map(util.ckey).filter(Boolean);
    for (const it of tx.all('items')) {
      if (it.id === id) continue;
      const theirs = [it.id, it.expressCode, it.countCode].map(util.ckey).filter(Boolean);
      const hit = keys.find((k) => theirs.indexOf(k) >= 0);
      if (hit) return it;
    }
    return null;
  }
  function upsertItem(tx, p, where) {
    const id = util.normCode(p.id || p.code);
    if (!id) return tx.error('REQUIRED', 'กรอกรหัสสินค้า', Object.assign({ field: 'code' }, where));
    if (!codeOk(tx, id, 'รหัสสินค้า', Object.assign({ field: 'code' }, where))) return null;
    if (!createOnly(tx, p, 'items', id, 'สินค้า', Object.assign({ field: 'code' }, where))) return null;
    const name = util.trim(p.name);
    if (!name) return tx.error('REQUIRED', `กรอกชื่อสินค้า ${id}`, Object.assign({ field: 'name' }, where));
    const prev = tx.get('items', id);
    const baseUnit = util.trim(p.baseUnit || (prev && prev.baseUnit));
    if (!baseUnit) return tx.error('REQUIRED', `กรอกหน่วยหลักของ ${id}`, Object.assign({ field: 'baseUnit' }, where));
    if (prev && prev.baseUnit !== baseUnit && tx.qty({ code: id }) !== 0) {
      return tx.error('HAS_STOCK', `${id} มียอดคงเหลือ – เปลี่ยนหน่วยหลักไม่ได้ (ปรับยอดเป็น 0 ก่อน)`, Object.assign({ field: 'baseUnit' }, where));
    }
    const type = p.type || (prev && prev.type) || 'RM';
    if (!ITEM_TYPES[type]) return tx.error('BAD_VALUE', `ประเภทสินค้าไม่ถูกต้อง: ${type}`, Object.assign({ field: 'type' }, where));
    const trackLot = p.trackLot || (prev && prev.trackLot) || 'none';
    if (!TRACK[trackLot]) return tx.error('BAD_VALUE', `วิธีติดตามไม่ถูกต้อง: ${trackLot}`, Object.assign({ field: 'trackLot' }, where));
    if (prev && prev.trackLot !== trackLot && tx.qty({ code: id }) !== 0) {
      return tx.error('HAS_STOCK', `${id} มียอดคงเหลือ – เปลี่ยนวิธีติดตามล็อตไม่ได้`, Object.assign({ field: 'trackLot' }, where));
    }
    const side = util.normCode(p.side);
    if (['', 'L', 'R'].indexOf(side) < 0) return tx.error('BAD_VALUE', 'ข้างต้องเป็น L, R หรือว่าง', Object.assign({ field: 'side' }, where));
    const expressCode = util.normCode(p.expressCode);
    const countCode = util.normCode(p.countCode);
    const clash = codeClash(tx, id, [id, expressCode, countCode]);
    if (clash) {
      return tx.error('CODE_CLASH', `รหัส ${id}${expressCode ? '/' + expressCode : ''}${countCode ? '/' + countCode : ''} ซ้ำหรืออ่านได้เหมือนรหัสของ ${clash.id} ${clash.name} – ตรวจรหัสก่อน (ระบบไม่จับคู่ให้เอง)`, Object.assign({ field: 'code' }, where));
    }
    const minQty = numOr(p.minQty, prev ? prev.minQty : 0);
    const maxQty = numOr(p.maxQty, prev ? prev.maxQty : 0);
    if (minQty < 0 || maxQty < 0 || (maxQty && minQty > maxQty)) return tx.error('BAD_VALUE', `Min/Max ของ ${id} ไม่ถูกต้อง`, Object.assign({ field: 'minQty' }, where));
    const row = {
      id, code: id, name, type, group: util.trim(p.group), category: util.trim(p.category), baseUnit, expressCode, countCode,
      model: util.trim(p.model), side, drawingNo: util.trim(p.drawingNo), drawingRev: util.trim(p.drawingRev), trackLot,
      certRequired: bool(p.certRequired, false), qcIncoming: bool(p.qcIncoming, false), qcFinal: bool(p.qcFinal, false),
      material: util.trim(p.material), thickness: numOr(p.thickness, 0), width: numOr(p.width, 0), length: numOr(p.length, 0),
      minQty, maxQty, unitCost: numOr(p.unitCost, prev ? prev.unitCost : 0), active: bool(p.active, true), remark: util.trim(p.remark),
      updatedAt: tx.now, updatedBy: tx.userId,
    };
    tx.put('items', id, row);
    return id;
  }
  define('item.upsert', {
    label: 'บันทึกสินค้า', perm: 'master.edit',
    prepare(tx, p) {
      const id = upsertItem(tx, p);
      if (id) tx.summary = `บันทึกสินค้า ${id}`;
    },
  });
  define('item.unit', {
    label: 'ตั้งหน่วยและตัวคูณ', perm: 'master.edit',
    prepare(tx, p) {
      const it = tx.item(p.code);
      if (!it) return tx.error('NOT_FOUND', `ไม่พบสินค้า ${p.code}`, { field: 'code' });
      const unit = util.trim(p.unit);
      if (!unit) return tx.error('REQUIRED', 'กรอกหน่วย', { field: 'unit' });
      if (unit === it.baseUnit) return tx.error('BAD_VALUE', 'หน่วยหลักมีตัวคูณ 1 อยู่แล้ว', { field: 'unit' });
      const k = it.id + '|' + unit;
      if (p.remove) {
        tx.del('item_units', k);
        tx.summary = `ลบหน่วย ${unit} ของ ${it.id}`;
        return;
      }
      const factor = util.num(p.factor);
      if (!(factor > 0)) return tx.error('BAD_VALUE', 'ตัวคูณต้องมากกว่า 0', { field: 'factor' });
      tx.put('item_units', k, { code: it.id, unit, factor });
      tx.summary = `${it.id}: 1 ${unit} = ${factor} ${it.baseUnit}`;
    },
  });

  /** Factor of `unit` to the base unit of item (1 for the base unit, null when unknown). */
  RRS.unitFactor = function unitFactor(getter, item, unit) {
    const u = util.trim(unit);
    if (!u || u === item.baseUnit) return 1;
    const row = getter('item_units', item.id + '|' + u);
    return row ? row.factor : null;
  };

  // ---- BOM / drawing revisions ---------------------------------------------------------------------------
  define('bom.upsert', {
    label: 'บันทึก BOM', perm: 'master.edit',
    prepare(tx, p) {
      const prod = tx.item(p.product);
      if (!prod) return tx.error('NOT_FOUND', `ไม่พบสินค้า ${p.product}`, { field: 'product' });
      const rev = util.normCode(p.rev);
      if (!rev) return tx.error('REQUIRED', 'กรอกฉบับ (rev)', { field: 'rev' });
      if (/\s/.test(rev) || !codeOk(tx, rev, 'ฉบับ', { field: 'rev' })) return tx.error('BAD_CODE', 'ฉบับห้ามมีช่องว่างหรือ |', { field: 'rev' });
      const k = prod.id + '|' + rev;
      if (!createOnly(tx, p, 'boms', k, 'BOM ฉบับ', { field: 'rev' })) return;
      const prev = tx.get('boms', k);
      if (prev && prev.status !== 'DRAFT') return tx.error('LOCKED', `BOM ${prod.id} ฉบับ ${rev} อนุมัติแล้ว – สร้างฉบับใหม่แทนการแก้`);
      const lines = [];
      (p.lines || []).forEach((ln, i) => {
        const it = tx.item(ln.code);
        if (!it) return tx.error('NOT_FOUND', `บรรทัด ${i + 1}: ไม่พบสินค้า ${ln.code}`, { line: i + 1 });
        if (it.id === prod.id) return tx.error('BAD_VALUE', `บรรทัด ${i + 1}: ใช้ตัวเองใน BOM ไม่ได้`, { line: i + 1 });
        const qty = util.num(ln.qty);
        if (!(qty > 0)) return tx.error('BAD_VALUE', `บรรทัด ${i + 1}: จำนวนต้องมากกว่า 0`, { line: i + 1 });
        const f = RRS.unitFactor((t, kk) => tx.get(t, kk), it, ln.unit);
        if (f == null) return tx.error('NO_UNIT', `บรรทัด ${i + 1}: ${it.id} ไม่มีตัวคูณของหน่วย ${ln.unit}`, { line: i + 1 });
        lines.push({ code: it.id, qty: util.round(qty * f), unit: it.baseUnit, note: util.trim(ln.note) });
      });
      if (!lines.length && tx.ok) tx.error('REQUIRED', 'BOM ต้องมีอย่างน้อย 1 บรรทัด');
      if (!tx.ok) return;
      tx.put('boms', k, { product: prod.id, rev, drawingNo: util.trim(p.drawingNo) || prod.drawingNo, status: 'DRAFT', lines,
        approvedBy: '', approvedAt: '' });
      tx.summary = `บันทึก BOM ${prod.id} ฉบับ ${rev}`;
    },
  });
  define('bom.approve', {
    label: 'อนุมัติ BOM', perm: 'bom.approve',
    prepare(tx, p) {
      const prod = tx.item(p.product);
      const rev = util.normCode(p.rev);
      const b = prod && tx.get('boms', prod.id + '|' + rev);
      if (!b) return tx.error('NOT_FOUND', 'ไม่พบ BOM');
      if (b.status !== 'DRAFT') return tx.error('BAD_STATE', 'BOM นี้อนุมัติหรือเลิกใช้แล้ว');
      for (const o of tx.all('boms', (x) => x.product === b.product && x.status === 'APPROVED')) {
        tx.putRow('boms', Object.assign({}, o, { status: 'OBSOLETE' }));
      }
      tx.putRow('boms', Object.assign({}, b, { status: 'APPROVED', approvedBy: tx.userId, approvedAt: tx.now }));
      tx.put('items', prod.id, Object.assign({}, prod, { drawingRev: rev, drawingNo: b.drawingNo || prod.drawingNo, updatedAt: tx.now, updatedBy: tx.userId }));
      tx.summary = `อนุมัติ BOM ${prod.id} ฉบับ ${rev}`;
    },
  });

  // ---- Phase 0 decisions and baseline KPIs ----------------------------------------------------------------
  define('decision.record', {
    label: 'บันทึกข้อตกลง', perm: 'decision.record',
    prepare(tx, p) {
      const qn = QUESTIONS.find((x) => x.id === p.id);
      if (!qn) return tx.error('NOT_FOUND', 'ไม่พบคำถาม');
      const answer = util.trim(p.answer);
      const decidedBy = util.trim(p.decidedBy);
      if (answer && !decidedBy) return tx.error('REQUIRED', 'ระบุผู้ตัดสิน (ชื่อ/ตำแหน่ง)', { field: 'decidedBy' });
      tx.put('decisions', qn.id, { id: qn.id, answer, decidedBy, decidedOn: util.trim(p.decidedOn) || tx.date,
        status: answer ? 'decided' : 'open', recordedBy: tx.userId });
      tx.summary = `${qn.no}: ${answer ? 'บันทึกข้อสรุป' : 'เปิดคำถามอีกครั้ง'}`;
    },
  });
  define('kpi.record', {
    label: 'บันทึกตัวชี้วัด', perm: 'kpi.record',
    prepare(tx, p) {
      const id = util.trim(p.id);
      const prev = tx.get('kpis', id) || KPI_DEFAULTS.find((k) => k.id === id);
      if ('label' in p && !util.trim(p.label)) return tx.error('REQUIRED', 'ชื่อตัวชี้วัดว่างไม่ได้', { field: 'label' });
      const label = util.trim(p.label) || (prev && prev.label);
      if (!id || !label) return tx.error('REQUIRED', 'กรอกชื่อตัวชี้วัด');
      const baseline = p.baseline === '' || p.baseline == null ? null : util.num(p.baseline);
      const target = p.target === '' || p.target == null ? null : util.num(p.target);
      if ((baseline !== null && isNaN(baseline)) || (target !== null && isNaN(target))) return tx.error('BAD_VALUE', 'ค่าต้องเป็นตัวเลข');
      tx.put('kpis', id, { id, label, unit: util.trim(p.unit) || (prev && prev.unit) || '', baseline, target,
        measuredOn: util.trim(p.measuredOn), note: util.trim(p.note) });
      tx.summary = `ตัวชี้วัด ${label}`;
    },
  });

  // ---- bulk import (all rows or nothing) ------------------------------------------------------------------
  define('master.import', {
    label: 'นำเข้าข้อมูลหลัก', perm: 'master.edit',
    prepare(tx, p) {
      let n = 0;
      (p.warehouses || []).forEach((r, i) => { if (upsertWarehouse(tx, r, { table: 'warehouses', row: i + 1 })) n++; });
      (p.bins || []).forEach((r, i) => { if (upsertBin(tx, r, { table: 'bins', row: i + 1 })) n++; });
      (p.items || []).forEach((r, i) => { if (upsertItem(tx, r, { table: 'items', row: i + 1 })) n++; });
      (p.units || []).forEach((r, i) => {
        const it = tx.item(r.code);
        const f = util.num(r.factor);
        if (!it) return tx.error('NOT_FOUND', `แถว ${i + 1}: ไม่พบสินค้า ${r.code}`, { table: 'units', row: i + 1 });
        if (!(f > 0) || !util.trim(r.unit)) return tx.error('BAD_VALUE', `แถว ${i + 1}: หน่วย/ตัวคูณไม่ถูกต้อง`, { table: 'units', row: i + 1 });
        tx.put('item_units', it.id + '|' + util.trim(r.unit), { code: it.id, unit: util.trim(r.unit), factor: f });
        n++;
      });
      tx.summary = `นำเข้าข้อมูลหลัก ${n} แถว`;
      tx.result.rows = n;
    },
  });

  RRS.master = { ITEM_TYPES, TRACK, QUESTIONS, KPI_DEFAULTS, upsertItem, upsertWarehouse, upsertBin };
})(typeof globalThis !== 'undefined' ? globalThis : this);
