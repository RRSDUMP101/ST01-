/*
 * Phase 6 – pilot run, reports and rollout (ทดลองใช้งานจริง รายงาน และขยายผล).
 *
 * Plan (file 01, Phase 6):
 *  1. run the whole cycle (receive – inspect – store – reserve – issue – produce – re-inspect – return/deliver) in the
 *     pilot group, log problems and check the balances every day           -> pilot.issue, daily.check, dailyCheck()
 *  2. reports: stock by warehouse, shortage/excess, non-moving, stock age, count accuracy, work waiting for QC;
 *     value and costing follow the agreement with accounting / Express    -> RRS.reports.* (pure read functions)
 *  3. register of re-usable steel offcuts (size, material, thickness, QR location, source lot), suggest an offcut
 *     before a new plate, record what is left after cutting                -> offcut.add/use/scrap/undo, suggestOffcuts()
 *  4. training per role, an error manual, backup/restore test and a rollback plan before switching; expand one
 *     product group / warehouse at a time when the pilot passes            -> training.record, ERROR_GUIDE,
 *                                                                            verifyBackup(), backup.recordTest, rollout.*
 * Acceptance criteria: no serious error that drifts balances, cuts twice or releases quarantined stock; store/QC/
 * accounting accept the balances and procedures; data can be restored; KPIs meet the Phase 0 targets; an owner and a
 * rollback plan exist before expanding.
 *
 * Reads other modules' tables by name (jobs, reservations, count_sessions, lots, inspections, ncrs …) and treats a
 * missing table as empty. Every report: (state, opts) -> {rows, cols:[{key, label, num?}], totals, …}; opts.today
 * (YYYY-MM-DD) when time matters (default: the date of the last commit in the state).
 *
 * The offcut register does not change stock balances: the plate it came from was issued already; an offcut is a
 * traceable leftover piece with its QR id (OC-00001) and location.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { util, schema, commands, auth, STATUS, STATUS_LABEL, TRANSIT } = RRS;
  const define = commands.define;
  const round = util.round;
  const pos0 = (n) => (n > 0 ? round(n) : 0);
  const pct = (a, b) => (b > 0 ? round((a / b) * 100, 1) : null);
  const uniq = (arr) => Array.from(new Set(arr));

  // ---------------------------------------------------------------------------------------------------------
  // permissions added by this module (the rest come from core.js PERMS)
  // ---------------------------------------------------------------------------------------------------------
  auth.definePerm('uat.signoff', ['store_lead', 'qc_lead', 'accounting', 'manager'], 'ลงนามยอมรับยอดและขั้นตอน');
  auth.definePerm('rollout.propose', ['manager', 'store_lead', 'qc_lead', 'accounting'], 'เสนอขยายผลการใช้งาน');
  auth.definePerm('rollout.approve', ['manager'], 'อนุมัติขยายผล / สั่งย้อนกลับ');

  // ---------------------------------------------------------------------------------------------------------
  // tables
  // ---------------------------------------------------------------------------------------------------------
  const HIST = ['history', 'json', 'ประวัติ {at, by, action, detail}'];
  schema.define('offcuts', {
    label: 'ทะเบียนเศษเหล็กใช้ซ้ำ', phase: 6, key: 'id',
    note: 'รหัส OC-xxxxx คือข้อความใน QR ที่ติดชิ้นเศษ; ทะเบียนนี้ไม่เปลี่ยนยอดสต็อก (แผ่นต้นทางเบิกไปแล้ว); ไม่ลบ – ใช้แล้ว/ทิ้ง/ยกเลิก เปลี่ยนสถานะพร้อมผู้ทำและเวลา',
    fields: [['id', 'text', 'รหัสเศษ / ข้อความ QR (OC-00001)'], ['code', 'text', 'รหัสแผ่นต้นทาง'], ['material', 'text', 'วัสดุ'],
      ['family', 'text', 'กลุ่มวัสดุที่ใช้แทนกันได้'], ['thickness', 'number', 'ความหนา (มม.)'], ['width', 'number', 'กว้าง (มม.)'],
      ['length', 'number', 'ยาว (มม.)'], ['area', 'number', 'พื้นที่ (ตร.มม.)'], ['wh', 'text', 'คลัง'], ['bin', 'text', 'ช่องเก็บ'],
      ['sourceLot', 'text', 'ล็อต / Heat ต้นทาง'], ['status', 'enum', 'สถานะ', 'AVAILABLE/USED/SCRAPPED/VOID'],
      ['parent', 'text', 'ตัดมาจากเศษ'], ['children', 'list', 'เศษที่เหลือหลังตัด'], ['createdFrom', 'text', 'ที่มา (งาน/เอกสาร/ใบตัด)'],
      ['usedFor', 'text', 'ใช้กับงาน/แบบ'], ['remark', 'text', 'หมายเหตุ'], ['createdBy', 'text', 'ผู้บันทึก'],
      ['createdAt', 'datetime', 'บันทึกเมื่อ'], ['usedBy', 'text', 'ผู้ใช้ตัด'], ['usedAt', 'datetime', 'ใช้ตัดเมื่อ'],
      ['scrappedBy', 'text', 'ผู้ทิ้ง'], ['scrappedAt', 'datetime', 'ทิ้งเมื่อ'], ['scrapReason', 'text', 'เหตุผลทิ้ง'],
      ['voidedBy', 'text', 'ผู้ยกเลิก'], ['voidedAt', 'datetime', 'ยกเลิกเมื่อ'], ['voidReason', 'text', 'เหตุผลยกเลิก'],
      ['by', 'text', 'ผู้ทำรายการล่าสุด'], ['at', 'datetime', 'ทำรายการล่าสุดเมื่อ'], HIST],
  });
  schema.define('uat', {
    label: 'ผลทดสอบรับงาน (UAT)', phase: 6, key: 'id',
    note: 'รหัสเกณฑ์คงที่ เช่น P1-2 (RRS.reports.UAT_CRITERIA); บันทึกผลใหม่ เก็บผลเดิมไว้ใน history ไม่ลบ',
    fields: [['id', 'text', 'รหัสเกณฑ์'], ['phase', 'number', 'ระยะ (Phase)'], ['criterion', 'text', 'เกณฑ์ผ่าน'],
      ['status', 'enum', 'ผล', 'PASS/FAIL/NOT_RUN'], ['tester', 'text', 'ผู้ทดสอบ'], ['testedOn', 'date', 'วันที่ทดสอบ'],
      ['evidence', 'text', 'หลักฐาน (เลขเอกสาร/ไฟล์/ชื่อการทดสอบ)'], ['note', 'text', 'หมายเหตุ'], ['at', 'datetime', 'บันทึกเมื่อ'],
      ['history', 'json', 'ผลก่อนหน้า {status, tester, testedOn, evidence, note, at}']],
  });
  schema.define('backup_tests', {
    label: 'ผลทดสอบสำรอง/กู้คืนข้อมูล', phase: 6, key: 'id',
    note: 'หลักฐานว่ากู้ข้อมูลได้: เล่นซ้ำ commit จากไฟล์สำรองแล้วตรวจลายนิ้วมือ ลำดับ และยอดคงเหลือ (RRS.reports.verifyBackup)',
    fields: [['id', 'text', 'รหัส (BT-00001)'], ['at', 'datetime', 'บันทึกเมื่อ'], ['by', 'text', 'ผู้ทดสอบ'],
      ['commits', 'number', 'จำนวน commit ในไฟล์สำรอง'], ['head', 'text', 'ลายนิ้วมือ commit สุดท้าย'],
      ['result', 'enum', 'ผล', 'OK/FAIL'], ['fingerprint', 'text', 'ลายนิ้วมือข้อมูลที่กู้ได้'], ['problems', 'list', 'ปัญหาที่พบ'],
      ['note', 'text', 'หมายเหตุ (ไฟล์/ที่เก็บ/เครื่องที่กู้)']],
  });
  schema.define('uat_signoffs', {
    label: 'การยอมรับยอดและขั้นตอนของแต่ละฝ่าย', phase: 6, key: 'id',
    note: 'ฝ่ายละหนึ่งคนตามบทบาท (สโตร์ = หัวหน้าสโตร์, QC = หัวหน้า QC, บัญชี); คนเดียวลงนามแทนหลายฝ่ายไม่ได้; ไม่ลบ – ผลล่าสุดของฝ่ายใช้ตัดสิน',
    fields: [['id', 'text', 'รหัส (SG-00001)'], ['area', 'enum', 'ฝ่าย', 'store/qc/accounting/owner'], ['role', 'text', 'บทบาทผู้ลงนาม'],
      ['decision', 'enum', 'ผล', 'ACCEPT/REJECT'], ['note', 'text', 'ความเห็น/เงื่อนไข'], ['by', 'text', 'ผู้ลงนาม'],
      ['at', 'datetime', 'ลงนามเมื่อ'], ['seq', 'number', 'ลำดับข้อมูลที่ยอมรับ'], ['uat', 'json', 'สรุป UAT ตอนลงนาม {pass, fail, notRun, total}']],
  });
  schema.define('trainings', {
    label: 'บันทึกการอบรมตามบทบาท', phase: 6, key: 'id',
    fields: [['id', 'text', 'รหัส (TN-00001)'], ['userId', 'text', 'ผู้รับการอบรม'], ['role', 'text', 'บทบาทที่อบรม'],
      ['topic', 'text', 'หัวข้อ/คู่มือ'], ['trainedOn', 'date', 'วันที่อบรม'], ['trainer', 'text', 'ผู้อบรม'],
      ['note', 'text', 'หมายเหตุ'], ['at', 'datetime', 'บันทึกเมื่อ']],
  });
  schema.define('pilot_issues', {
    label: 'ปัญหาจากการทดลองใช้งาน', phase: 6, key: 'id',
    note: 'ปัญหาร้ายแรง (CRITICAL) ที่ยังเปิดอยู่ทำให้ขยายผลไม่ได้; ปิดปัญหาร้ายแรงต้องเป็นคนละคนกับผู้แจ้ง',
    fields: [['id', 'text', 'รหัส (PI-00001)'], ['severity', 'enum', 'ความรุนแรง', 'CRITICAL/MAJOR/MINOR'], ['area', 'text', 'ขั้นตอน/หน้าจอ'],
      ['description', 'text', 'รายละเอียด'], ['ref', 'text', 'เอกสารอ้างอิง'], ['status', 'enum', 'สถานะ', 'OPEN/RESOLVED'],
      ['reportedBy', 'text', 'ผู้แจ้ง'], ['reportedAt', 'datetime', 'แจ้งเมื่อ'], ['resolution', 'text', 'วิธีแก้'],
      ['resolvedBy', 'text', 'ผู้ปิด'], ['resolvedAt', 'datetime', 'ปิดเมื่อ']],
  });
  schema.define('daily_checks', {
    label: 'ผลตรวจยอดประจำวัน', phase: 6, key: 'id',
    note: 'ระบบคำนวณผลเอง (RRS.reports.dailyCheck) ผู้ใช้ส่งได้เฉพาะหมายเหตุ',
    fields: [['id', 'text', 'รหัส (DC-00001)'], ['date', 'date', 'วันที่ตรวจ'], ['by', 'text', 'ผู้ตรวจ'], ['at', 'datetime', 'ตรวจเมื่อ'],
      ['seq', 'number', 'ข้อมูลถึงลำดับ'], ['ok', 'bool', 'ผ่าน'], ['problems', 'list', 'ปัญหาที่พบ'],
      ['counts', 'json', 'สรุปจำนวนต่อหัวข้อ'], ['note', 'text', 'หมายเหตุ']],
  });
  schema.define('rollouts', {
    label: 'แผนขยายผลการใช้งาน', phase: 6, key: 'id',
    note: 'ขยายทีละกลุ่มสินค้า/คลัง: ต้องมีผู้รับผิดชอบ แผนย้อนกลับ ผลกู้ข้อมูล ผล UAT การยอมรับของสโตร์/QC/บัญชี และการอบรมก่อนอนุมัติ; ผู้อนุมัติต้องไม่ใช่ผู้เสนอ',
    fields: [['id', 'text', 'รหัส (RO-00001)'], ['title', 'text', 'ชื่อแผน'], ['groups', 'list', 'กลุ่มสินค้าที่ขยาย'],
      ['warehouses', 'list', 'คลังที่ขยาย'], ['owner', 'text', 'ผู้รับผิดชอบ'], ['team', 'list', 'ผู้ใช้งานในขอบเขต'],
      ['rollbackPlan', 'text', 'แผนย้อนกลับ'], ['phases', 'list', 'Phase ที่ต้องผ่าน UAT'],
      ['status', 'enum', 'สถานะ', 'PROPOSED/APPROVED/REJECTED/ROLLED_BACK'], ['proposedBy', 'text', 'ผู้เสนอ'],
      ['proposedAt', 'datetime', 'เสนอเมื่อ'], ['approvedBy', 'text', 'ผู้อนุมัติ'], ['approvedAt', 'datetime', 'อนุมัติเมื่อ'],
      ['readiness', 'json', 'ผลตรวจความพร้อมตอนอนุมัติ'], ['rejectedBy', 'text', 'ผู้ไม่อนุมัติ'], ['rejectedAt', 'datetime', 'ไม่อนุมัติเมื่อ'],
      ['rejectReason', 'text', 'เหตุผลไม่อนุมัติ'], ['rolledBackBy', 'text', 'ผู้สั่งย้อนกลับ'], ['rolledBackAt', 'datetime', 'ย้อนกลับเมื่อ'],
      ['rollbackReason', 'text', 'เหตุผลย้อนกลับ'], HIST],
  });

  // ---------------------------------------------------------------------------------------------------------
  // constants
  // ---------------------------------------------------------------------------------------------------------
  const OFFCUT_STATUS = { AVAILABLE: 'พร้อมใช้', USED: 'ใช้ตัดแล้ว', SCRAPPED: 'ทิ้งแล้ว', VOID: 'ยกเลิก (บันทึกผิด/ยกเลิกการตัด)' };
  const UAT_STATUS = { PASS: 'ผ่าน', FAIL: 'ไม่ผ่าน', NOT_RUN: 'ยังไม่ทดสอบ' };
  const SEVERITY = { CRITICAL: 'ร้ายแรง (ยอดผิด/ตัดซ้ำ/ปล่อยของกักกัน)', MAJOR: 'สำคัญ', MINOR: 'เล็กน้อย' };
  const ROLLOUT_STATUS = { PROPOSED: 'รออนุมัติ', APPROVED: 'อนุมัติแล้ว', REJECTED: 'ไม่อนุมัติ', ROLLED_BACK: 'ย้อนกลับแล้ว' };
  const SIGNOFF_AREAS = {
    store: { label: 'สโตร์', roles: ['store_lead'] },
    qc: { label: 'QC', roles: ['qc_lead'] },
    accounting: { label: 'บัญชี', roles: ['accounting'] },
    owner: { label: 'เจ้าของโครงการ', roles: ['manager'] },
  };
  /** Areas whose acceptance is required before a rollout (acceptance criterion P6-2). */
  const REQUIRED_SIGNOFFS = ['store', 'qc', 'accounting'];
  /** Roles that work with stock and need training (admin/viewer do not). */
  const TRAINED_ROLES = ['manager', 'store', 'store_lead', 'planner', 'production', 'engineering', 'purchasing',
    'purchasing_lead', 'accounting', 'qc', 'qc_lead'];
  const SHORT_STATUS = { SHORT: 'ขาด', BELOW_MIN: 'ต่ำกว่า Min', OVER_MAX: 'เกิน Max', OK: 'พอ' };
  const AGE_BUCKETS = ['0-30', '31-90', '91-180', '>180'];
  const STAGE_LABEL = { INCOMING: 'ตรวจรับ', IN_PROCESS: 'ระหว่างผลิต', FINAL: 'ก่อนส่งมอบ' };
  const STAGE_ORDER = { INCOMING: 1, IN_PROCESS: 2, FINAL: 3 };
  /** KPI direction: up = higher is better. */
  const KPI_BETTER = { count_accuracy: 'up', fpy: 'up', qc_wait: 'down', repeat_ncr: 'down', shortage: 'down', issue_lead: 'down' };
  const DEFAULT_BACKUP_DAYS = 30;
  const HEX64 = /^[0-9a-f]{64}$/;

  /** Acceptance criteria of Phase 0–6 (file 01) with stable ids – the UAT checklist. */
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
  const PHASE_TITLE = { 0: 'ข้อมูลหลักและกติกา', 1: 'รับ–จ่าย–โอนตามคลัง', 2: 'ใบงานและการจอง', 3: 'กระทบยอด Express และตรวจนับ',
    4: 'จัดซื้อและเติมสต็อก', 5: 'QC ล็อตและ NCR', 6: 'ทดลองใช้งานจริง รายงาน และขยายผล' };
  const UAT_CRITERIA = [];
  for (const ph of Object.keys(CRITERIA_TEXT)) {
    CRITERIA_TEXT[ph].forEach((text, i) => UAT_CRITERIA.push({ id: `P${ph}-${i + 1}`, phase: Number(ph), criterion: text,
      auto: `tests/phase${Number(ph) <= 1 ? 1 : ph}.test.mjs` }));
  }
  Object.freeze(UAT_CRITERIA);

  /** Error manual (คู่มือกรณีผิดพลาด): what the message means and what to do. */
  const ERROR_GUIDE = [
    ['NOT_ENOUGH', 'ของไม่พอ', 'ยอดที่ตำแหน่ง/ล็อต/สถานะนั้นน้อยกว่าที่ขอ', 'ตรวจคลัง/ช่องเก็บ/ล็อตที่เลือก ดูยอดในหน้า สต็อก; ถ้าของมีจริงแต่ยังไม่ลงระบบ ให้บันทึกรับก่อน หรือขอข้อยกเว้นยอดติดลบ', 'สโตร์'],
    ['NEGATIVE', 'ยอดจะติดลบ', 'รายการนี้ทำให้ยอดต่ำกว่าศูนย์', 'ห้ามติดลบ (ค-7) – ตรวจเอกสารก่อนหน้า หรือขออนุมัติข้อยกเว้นโดยหัวหน้าสโตร์/บัญชี', 'สโตร์ + หัวหน้าสโตร์'],
    ['RESERVED', 'ของถูกจองให้งานอื่น', 'ของใช้ได้มีพอแต่จองให้ใบงานอื่นแล้ว (หรือใช้รหัส/คลังที่สงวนไว้)', 'เบิกโดยอ้างใบงาน/ใบจองของตัวเอง หรือให้ฝ่ายวางแผนปรับการจอง', 'สโตร์ + วางแผน'],
    ['BAD_STATUS', 'ของยังไม่ผ่าน QC', 'ของรอตรวจ/กักกัน/รอแก้ไข เบิกหรือส่งมอบไม่ได้', 'ให้ QC ตรวจและหัวหน้า QC ปล่อยผ่านก่อน หรือดำเนินการตาม NCR', 'QC'],
    ['LOT_REQUIRED', 'ต้องระบุล็อต/Heat', 'สินค้านี้ตั้งให้ติดตามล็อต/Heat/Serial', 'อ่านเลขจากป้าย/ใบรับรองวัสดุแล้วกรอกให้ตรง', 'สโตร์'],
    ['BAD_LOT', 'เลขล็อตใช้ไม่ได้', 'เลขล็อต/Heat มีอักขระ | หรืออักขระควบคุม', 'พิมพ์เลขล็อตใหม่ตามป้าย/ใบรับรอง', 'สโตร์'],
    ['LOT_NOT_TRACKED', 'สินค้านี้ไม่ติดตามล็อต', 'กรอกล็อตให้สินค้าที่ไม่ได้ตั้งติดตาม', 'ลบล็อตออก หรือให้ผู้ดูแลข้อมูลหลักแก้ทะเบียนสินค้า', 'สโตร์'],
    ['SERIAL_QTY', 'Serial ทีละ 1', 'สินค้าติดตาม Serial บันทึกได้ครั้งละ 1 หน่วยต่อบรรทัด', 'แยกบรรทัดละ 1 หน่วย', 'สโตร์'],
    ['NO_UNIT', 'หน่วยไม่มีตัวคูณ', 'หน่วยที่กรอกไม่มีตัวคูณไปหน่วยหลัก', 'ใช้หน่วยหลัก หรือให้ผู้ดูแลข้อมูลหลักเพิ่มตัวคูณ (ค-4)', 'ข้อมูลหลัก'],
    ['BAD_QTY', 'จำนวนไม่ถูกต้อง', 'จำนวนไม่ใช่ตัวเลข เป็นศูนย์ หรือติดลบ', 'กรอกจำนวนใหม่ (ใบปรับยอด AJ ใช้ +/− ได้)', 'ผู้บันทึก'],
    ['TOO_MUCH', 'เกินจำนวนที่ทำได้', 'จำนวนเกินยอดคงค้างของเอกสาร/บรรทัด', 'ตรวจยอดค้างของเอกสารแล้วกรอกใหม่', 'ผู้บันทึก'],
    ['NOT_FOUND', 'ไม่พบข้อมูล', 'รหัสสินค้า/คลัง/ช่องเก็บ/เอกสารไม่มีในระบบ', 'ตรวจการสะกดรหัส; ระบบไม่จับคู่จากชื่อให้เอง – เพิ่มในข้อมูลหลักก่อนถ้าเป็นรหัสใหม่', 'ผู้บันทึก'],
    ['INACTIVE', 'ปิดใช้งานแล้ว', 'สินค้า/คลัง/ช่องเก็บถูกปิดใช้งาน', 'เลือกที่อื่น หรือให้ผู้ดูแลเปิดใช้งาน', 'ข้อมูลหลัก'],
    ['BIN_REQUIRED', 'ต้องระบุช่องเก็บ', 'คลังนี้ตั้งให้ต้องระบุช่องเก็บ', 'สแกน/เลือกช่องเก็บ', 'สโตร์'],
    ['SAME_PLACE', 'ต้นทางกับปลายทางเดียวกัน', 'ใบโอนไม่เปลี่ยนตำแหน่ง', 'เลือกคลัง/ช่องปลายทางใหม่', 'สโตร์'],
    ['NO_LINES', 'เอกสารไม่มีบรรทัด', 'ยังไม่ได้เพิ่มบรรทัด', 'เพิ่มบรรทัดก่อนบันทึก', 'ผู้บันทึก'],
    ['NOTHING', 'ไม่มีอะไรต้องทำ', 'ไม่มีบรรทัดค้างที่ต้องรับ/ทำ', 'ตรวจสถานะเอกสาร', 'ผู้บันทึก'],
    ['REQUIRED', 'ข้อมูลไม่ครบ', 'ช่องที่จำเป็นยังว่าง (เหตุผล ชื่อ คลัง …)', 'กรอกช่องที่ระบบชี้', 'ผู้บันทึก'],
    ['BAD_VALUE', 'ค่าไม่ถูกต้อง', 'ค่าที่กรอกอยู่นอกตัวเลือกหรือรูปแบบ', 'แก้ตามข้อความที่ระบบแจ้ง', 'ผู้บันทึก'],
    ['BAD_TYPE', 'ประเภทเอกสารไม่ถูกต้อง', 'ประเภทเอกสารที่ระบบไม่รู้จัก หรือเปลี่ยนประเภทของร่าง', 'เลือกประเภทจากรายการ', 'ผู้บันทึก'],
    ['BAD_CODE', 'รูปแบบรหัสไม่ถูกต้อง', 'รหัสใช้อักขระที่ไม่อนุญาต', 'ใช้ A-Z 0-9 - _', 'ข้อมูลหลัก'],
    ['BAD_STATE', 'สถานะไม่ให้ทำ', 'เอกสาร/รายการอยู่ในสถานะที่ทำคำสั่งนี้ไม่ได้ (เช่น บันทึกแล้ว ยกเลิกแล้ว)', 'เปิดดูสถานะล่าสุด; เอกสารที่บันทึกแล้วแก้ไม่ได้ ให้ยกเลิกแล้วทำใหม่', 'ผู้บันทึก'],
    ['ALREADY_CANCELLED', 'ยกเลิกไปแล้ว', 'เอกสารนี้ยกเลิกแล้ว ระบบไม่กลับยอดซ้ำ', 'ไม่ต้องทำซ้ำ – ตรวจประวัติเอกสาร', 'หัวหน้าสโตร์'],
    ['CANNOT_REVERSE', 'ยกเลิกไม่ได้', 'ของที่รับเข้าถูกใช้/ย้ายไปแล้ว ยอดไม่พอให้กลับรายการ', 'ทำเอกสารแก้ไขแทน (เช่น ใบคืน/ใบปรับยอด) พร้อมเหตุผล', 'หัวหน้าสโตร์'],
    ['HAS_STOCK', 'ยังมียอดคงเหลือ', 'เปลี่ยนหน่วย/การติดตามล็อต หรือปิดคลัง/ช่องที่ยังมีของไม่ได้', 'ย้าย/ปรับยอดเป็นศูนย์ก่อน', 'หัวหน้าสโตร์'],
    ['CODE_CLASH', 'รหัสซ้ำ/อ่านเหมือนกัน', 'รหัสหลัก/Express/นับสต็อก อ่านแล้วเหมือนรหัสของสินค้าอื่น', 'ตรวจรหัสกับทะเบียนเดิม ระบบไม่รวมรหัสให้เอง (ค-9)', 'ข้อมูลหลัก'],
    ['DUPLICATE', 'ข้อมูลซ้ำ', 'ค่านี้ผูกกับข้อมูลอื่นแล้ว', 'ตรวจว่ากรอกซ้ำหรือไม่', 'ผู้ดูแลระบบ'],
    ['LOCKED', 'ล็อกแล้ว', 'ข้อมูลที่อนุมัติแล้วแก้ไม่ได้ (เช่น BOM)', 'สร้างฉบับใหม่แทนการแก้', 'วิศวกรรม'],
    ['POLICY', 'ขัดนโยบาย', 'นโยบายที่ตกลงไว้ไม่อนุญาต (เช่น ห้ามติดลบ)', 'ทำตามนโยบาย หรือให้ผู้มีสิทธิ์แก้ค่าตั้งระบบพร้อมบันทึกข้อตกลง', 'เจ้าของโครงการ'],
    ['NO_PERMISSION', 'ไม่มีสิทธิ์', 'บทบาท/คลังของผู้ใช้ไม่มีสิทธิ์คำสั่งนี้', 'ให้ผู้มีสิทธิ์ทำ หรือขอผู้ดูแลระบบปรับบทบาท (ค-6)', 'ผู้ดูแลระบบ'],
    ['SAME_PERSON', 'ต้องเป็นคนละคน', 'ผู้ขอ/ผู้ทำ กับ ผู้อนุมัติ เป็นคนเดียวกัน (แยกหน้าที่)', 'ให้ผู้มีสิทธิ์อีกคนอนุมัติ', 'หัวหน้างาน'],
    ['REQUEST_REUSED', 'รหัสคำขอถูกใช้แล้ว', 'รหัสคำขอนี้เคยส่งพร้อมข้อมูลอื่น', 'กดบันทึกใหม่ (ระบบสร้างรหัสคำขอใหม่) – คำขอเดิมไม่ถูกตัดซ้ำ', 'ผู้บันทึก'],
    ['NO_USER', 'ไม่พบผู้ใช้', 'บัญชีที่เข้าระบบยังไม่ผูกกับผู้ใช้', 'ส่งคำขอใช้งาน แล้วให้ผู้ดูแลเพิ่มผู้ใช้', 'ผู้ดูแลระบบ'],
    ['USER_INACTIVE', 'ผู้ใช้ถูกปิด', 'ผู้ใช้นี้ถูกปิดการใช้งาน', 'ติดต่อผู้ดูแลระบบ', 'ผู้ดูแลระบบ'],
    ['NO_ACCOUNT', 'ยังไม่ได้เข้าสู่ระบบ', 'ขอใช้งานโดยยังไม่เข้าสู่ระบบ', 'เข้าสู่ระบบก่อน', 'ผู้ใช้'],
    ['ALREADY_USER', 'มีสิทธิ์แล้ว', 'บัญชีนี้ผูกกับผู้ใช้แล้ว', 'เข้าใช้งานได้เลย', 'ผู้ใช้'],
    ['ALREADY_STARTED', 'เริ่มระบบแล้ว', 'ระบบมีผู้ดูแลแล้ว', 'เข้าสู่ระบบด้วยผู้ใช้เดิม', 'ผู้ดูแลระบบ'],
    ['LAST_ADMIN', 'ผู้ดูแลคนสุดท้าย', 'ต้องมีผู้ดูแลระบบที่ใช้งานอย่างน้อย 1 คน', 'เพิ่มผู้ดูแลอีกคนก่อน', 'ผู้ดูแลระบบ'],
    ['UNKNOWN_COMMAND', 'ไม่รู้จักคำสั่ง', 'หน้าจอกับเซิร์ฟเวอร์คนละรุ่น', 'โหลดหน้าใหม่ ถ้ายังพบแจ้งผู้ดูแลระบบ', 'ผู้ดูแลระบบ'],
    ['NO_TIME', 'ไม่มีเวลาของคำสั่ง', 'คำสั่งไม่มีเวลา (ข้อผิดพลาดของระบบ)', 'แจ้งผู้ดูแลระบบ', 'ผู้ดูแลระบบ'],
    ['INTERNAL', 'ระบบทำคำสั่งไม่สำเร็จ', 'ข้อผิดพลาดภายใน ไม่มีข้อมูลใดถูกบันทึก', 'จดข้อความและเวลา แจ้งผู้ดูแลระบบ (บันทึกเป็นปัญหาการทดลอง)', 'ผู้ดูแลระบบ'],
    ['STORE', 'บันทึกไม่สำเร็จ', 'ที่เก็บข้อมูลกลางไม่ตอบรับ ไม่มีข้อมูลใดถูกบันทึก', 'ตรวจอินเทอร์เน็ตแล้วลองใหม่ (ระบบไม่ตัดซ้ำเพราะใช้รหัสคำขอเดิม)', 'ผู้ใช้'],
    ['BUSY', 'มีคนบันทึกพร้อมกัน', 'หลายคนบันทึกพร้อมกันจนลองครบจำนวนครั้ง', 'กดบันทึกอีกครั้ง', 'ผู้ใช้'],
    ['TOO_BIG', 'ขนาดเกินชิ้นต้นทาง', 'ขนาดเศษ/ชิ้นที่เหลือใหญ่กว่าแผ่นหรือเศษต้นทาง', 'วัดใหม่ (มม.) กว้าง × ยาว', 'สโตร์/ผลิต'],
    ['TOO_MUCH_AREA', 'พื้นที่เศษเหลือเกิน', 'พื้นที่เศษที่เหลือรวมกันไม่น้อยกว่าชิ้นเดิม', 'ตรวจขนาดชิ้นที่เหลือ', 'สโตร์/ผลิต'],
    ['LOT_UNKNOWN', 'ไม่พบล็อตต้นทาง', 'ล็อต/Heat นี้ไม่เคยมีในประวัติของรหัสนั้น', 'อ่านเลข Heat จากแผ่นต้นทางใหม่', 'สโตร์/ผลิต'],
    ['LOT_QUARANTINED', 'ล็อตถูกกักกัน', 'ล็อตต้นทางถูกกักกัน ใช้เศษจากล็อตนี้ไม่ได้', 'รอผล QC/NCR ของล็อต', 'QC'],
    ['NOT_AREA_ROLE', 'ไม่ใช่ผู้แทนฝ่าย', 'ผู้ลงนามไม่มีบทบาทของฝ่ายนั้น', 'ให้หัวหน้าฝ่ายตัวจริงลงนาม', 'เจ้าของโครงการ'],
    ['INTEGRITY', 'ตรวจยอดไม่ผ่าน', 'ยอดคงเหลือไม่ตรงประวัติ/มีของกักกันหลุด/เอกสารซ้ำ', 'ดูผลตรวจยอดประจำวัน แก้ปัญหาและบันทึกเป็นปัญหาร้ายแรงก่อน', 'หัวหน้าสโตร์ + บัญชี'],
    ['NOT_READY', 'ยังไม่พร้อมขยายผล', 'ยังขาดเงื่อนไขก่อนขยาย (ผู้รับผิดชอบ แผนย้อนกลับ ผลกู้ข้อมูล UAT การยอมรับ การอบรม)', 'ดูรายการความพร้อมของแผนขยายผล', 'เจ้าของโครงการ'],
    ['HEAD_MISMATCH', 'ไฟล์สำรองไม่ตรงระบบ', 'ลายนิ้วมือ commit สุดท้ายไม่ตรงกับระบบที่ลำดับเดียวกัน', 'สำรองใหม่แล้วทดสอบกู้อีกครั้ง', 'บัญชี/ผู้ดูแลระบบ'],
  ].map(([code, title, cause, action, who]) => ({ code, title, cause, action, who }));
  const GUIDE_BY_CODE = {};
  for (const g of ERROR_GUIDE) GUIDE_BY_CODE[g.code] = g;

  // ---------------------------------------------------------------------------------------------------------
  // small readers (missing tables are empty)
  // ---------------------------------------------------------------------------------------------------------
  const tablesOf = (state) => (state && state.tables) || {};
  const T = (state, t) => Object.values(tablesOf(state)[t] || {});
  const G = (state, t, k) => (tablesOf(state)[t] || {})[k] || null;
  const subN = (m) => Number(String(m.id).split('.')[1]) || 0;
  const dateOf = (iso) => (iso ? util.bkkDate(iso) : '');
  const inPeriod = (d, from, to) => !!d && (!from || d >= from) && (!to || d <= to);
  const C = (key, label, extra) => Object.assign({ key, label }, extra || {});
  const N = (key, label) => C(key, label, { num: true });
  const locText = (r) => `${r.wh}${r.bin ? '/' + r.bin : ''}`;

  function settingsOf(state) {
    const d = RRS.defaultSettings();
    const s = G(state, 'settings', 'main') || d;
    return Object.assign({}, d, s, { policies: Object.assign({}, d.policies, s.policies || {}),
      ownership: Object.assign({}, d.ownership, s.ownership || {}), pilot: Object.assign({}, d.pilot, s.pilot || {}) });
  }
  /** opts.today, else the Bangkok date of the last commit in the state (deterministic). */
  function todayOf(state, opts) {
    if (opts && opts.today) return String(opts.today).slice(0, 10);
    let last = '';
    for (const a of T(state, 'audit')) if (a.at > last) last = a.at;
    if (!last) for (const m of T(state, 'movements')) if (m.at > last) last = m.at;
    return last ? util.bkkDate(last) : '';
  }
  function monthStart(d) {
    return d ? d.slice(0, 8) + '01' : '';
  }
  function valueNote(state) {
    const own = settingsOf(state).ownership || {};
    return `มูลค่าเป็นค่าอ้างอิง = จำนวน × ราคาต่อหน่วยในทะเบียนสินค้า ไม่ใช่มูลค่าทางบัญชี – มูลค่าและวิธีคิดต้นทุนยึดตามข้อตกลงกับบัญชี/${own.cost || 'Express'} (ค-1)`;
  }
  function movesSorted(state) {
    return T(state, 'movements').slice().sort((a, b) => a.seq - b.seq || subN(a) - subN(b));
  }
  /** Per balance key: when the stock now there started (the last time the balance went from ≤ 0 to > 0). */
  function sinceMap(state) {
    const run = {};
    const since = {};
    for (const m of movesSorted(state)) {
      const k = RRS.balanceKey(m);
      const before = round(run[k] || 0);
      const after = round(before + m.qty);
      if (before <= 0 && after > 0) since[k] = m.at;
      if (after <= 0) delete since[k];
      run[k] = after;
    }
    return since;
  }
  function hoursBetween(a, b) {
    const x = Date.parse(a);
    const y = Date.parse(b);
    return isFinite(x) && isFinite(y) ? round((y - x) / 3600e3, 2) : null;
  }

  const reports = {
    OFFCUT_STATUS, UAT_STATUS, SEVERITY, ROLLOUT_STATUS, SIGNOFF_AREAS, REQUIRED_SIGNOFFS, SHORT_STATUS, AGE_BUCKETS,
    KPI_BETTER, UAT_CRITERIA, PHASE_TITLE, ERROR_GUIDE,
  };
  RRS.reports = reports;

  /** Help for an error code (falls back to a generic entry). */
  reports.errorHelp = function errorHelp(code) {
    return GUIDE_BY_CODE[code] || { code, title: 'ข้อผิดพลาด', cause: 'ระบบไม่บันทึกคำสั่งนี้ – ไม่มีข้อมูลใดเปลี่ยน',
      action: 'อ่านข้อความที่ระบบแจ้ง แก้ข้อมูลแล้วลองใหม่; ถ้าไม่เข้าใจให้บันทึกเป็นปัญหาการทดลอง', who: 'ผู้บันทึก' };
  };

  // ---------------------------------------------------------------------------------------------------------
  // reports (pure)
  // ---------------------------------------------------------------------------------------------------------
  /** Stock per warehouse / bin / quality status / lot with the reference value. opts: wh, code, status, group, includeTransit. */
  reports.stockByLocation = function stockByLocation(state, opts) {
    opts = opts || {};
    const items = tablesOf(state).items || {};
    const whs = tablesOf(state).warehouses || {};
    const rows = [];
    for (const b of T(state, 'balances')) {
      if (opts.wh && b.wh !== opts.wh) continue;
      if (opts.code && b.code !== opts.code) continue;
      if (opts.status && b.status !== opts.status) continue;
      if (b.wh === TRANSIT && opts.includeTransit === false) continue;
      const it = items[b.code] || {};
      if (opts.group && it.group !== opts.group) continue;
      const unitCost = Number(it.unitCost) || 0;
      rows.push({ code: b.code, name: it.name || '', unit: it.baseUnit || '', group: it.group || '', wh: b.wh,
        whName: b.wh === TRANSIT ? 'ระหว่างโอน' : (whs[b.wh] || {}).name || b.wh, bin: b.bin || '', status: b.status,
        statusLabel: STATUS_LABEL[b.status] || b.status, lot: b.lot || '', qty: round(b.qty), unitCost,
        value: round(b.qty * unitCost, 2) });
    }
    rows.sort((a, b) => (a.wh === TRANSIT) - (b.wh === TRANSIT) || a.wh.localeCompare(b.wh) || a.bin.localeCompare(b.bin)
      || a.code.localeCompare(b.code) || a.status.localeCompare(b.status) || a.lot.localeCompare(b.lot));
    const byWh = {};
    const byStatus = {};
    const qtyByCode = {};
    for (const r of rows) {
      byWh[r.wh] = round((byWh[r.wh] || 0) + r.value, 2);
      byStatus[r.status] = round((byStatus[r.status] || 0) + r.value, 2);
      qtyByCode[r.code] = round((qtyByCode[r.code] || 0) + r.qty);
    }
    return {
      rows, note: valueNote(state),
      cols: [C('wh', 'คลัง'), C('bin', 'ช่องเก็บ'), C('code', 'รหัสสินค้า'), C('name', 'ชื่อสินค้า'), C('statusLabel', 'สถานะคุณภาพ'),
        C('lot', 'ล็อต/Heat'), N('qty', 'จำนวน'), C('unit', 'หน่วย'), N('unitCost', 'ราคาอ้างอิง/หน่วย'), N('value', 'มูลค่าอ้างอิง')],
      totals: { rows: rows.length, value: round(util.sum(rows, (r) => r.value), 2), negative: rows.filter((r) => r.qty < 0).length,
        byWh, byStatus, qtyByCode },
    };
  };

  /**
   * Per item: available (AVAILABLE, real warehouses) vs Min/Max and the demand of open jobs (required − issued).
   * opts: wh (available/reserved of one warehouse; demand stays company-wide), code, group, onlyProblems.
   */
  reports.shortageExcess = function shortageExcess(state, opts) {
    opts = opts || {};
    const items = tablesOf(state).items || {};
    const avail = {};
    const qcHold = {};
    for (const b of T(state, 'balances')) {
      if (b.wh === TRANSIT || (opts.wh && b.wh !== opts.wh)) continue;
      if (b.status === STATUS.AVAILABLE) avail[b.code] = round((avail[b.code] || 0) + b.qty);
      else if (b.status === STATUS.QC_HOLD) qcHold[b.code] = round((qcHold[b.code] || 0) + b.qty);
    }
    const demand = {};
    const jobsOf = {};
    for (const j of T(state, 'jobs')) {
      if (j.status !== 'OPEN' && j.status !== 'IN_PROGRESS') continue;
      for (const l of j.lines || []) {
        if (l.output) continue;
        const d = pos0((Number(l.required) || 0) - (Number(l.issued) || 0));
        if (!d) continue;
        demand[l.code] = round((demand[l.code] || 0) + d);
        (jobsOf[l.code] || (jobsOf[l.code] = [])).push(j.jobNo);
      }
    }
    const reserved = {};
    for (const r of T(state, 'reservations')) {
      if (r.status !== 'OPEN' && r.status !== 'PARTIAL') continue;
      if (opts.wh && r.wh !== opts.wh) continue;
      reserved[r.code] = round((reserved[r.code] || 0) + pos0((Number(r.qty) || 0) - (Number(r.issued) || 0)));
    }
    const rows = [];
    for (const code of Object.keys(items).sort()) {
      const it = items[code];
      if (opts.code && code !== opts.code) continue;
      if (opts.group && it.group !== opts.group) continue;
      const a = avail[code] || 0;
      const d = demand[code] || 0;
      const min = Number(it.minQty) || 0;
      const max = Number(it.maxQty) || 0;
      if (it.active === false && !a && !d) continue;
      if (!a && !d && !min && !max && !qcHold[code] && !reserved[code]) continue;
      const projected = round(a - d);
      let status = 'OK';
      if (projected < 0) status = 'SHORT';
      else if (min > 0 && projected < min) status = 'BELOW_MIN';
      else if (max > 0 && projected > max) status = 'OVER_MAX';
      if (opts.onlyProblems && status === 'OK') continue;
      rows.push({ code, name: it.name || '', unit: it.baseUnit || '', group: it.group || '', available: a, qcHold: qcHold[code] || 0,
        reserved: reserved[code] || 0, demand: d, projected, minQty: min, maxQty: max, status, statusLabel: SHORT_STATUS[status],
        shortQty: pos0(-projected), belowMinQty: min > 0 ? pos0(min - Math.max(projected, 0)) : 0,
        excessQty: max > 0 ? pos0(projected - max) : 0, jobs: uniq(jobsOf[code] || []) });
    }
    const rank = { SHORT: 0, BELOW_MIN: 1, OVER_MAX: 2, OK: 3 };
    rows.sort((x, y) => rank[x.status] - rank[y.status] || x.code.localeCompare(y.code));
    const count = (s) => rows.filter((r) => r.status === s).length;
    return {
      rows,
      note: opts.wh ? 'ยอดพร้อมใช้และยอดจองเป็นของคลังที่เลือก แต่ความต้องการของใบงานเป็นยอดรวมทั้งบริษัท (ใบงานไม่ระบุคลัง)' : '',
      cols: [C('code', 'รหัสสินค้า'), C('name', 'ชื่อสินค้า'), N('available', 'พร้อมใช้'), N('qcHold', 'รอตรวจ'), N('reserved', 'จองแล้ว'),
        N('demand', 'ต้องใช้ตามใบงานที่เปิด'), N('projected', 'คงเหลือหลังใช้'), N('minQty', 'Min'), N('maxQty', 'Max'),
        C('statusLabel', 'สถานะ'), N('shortQty', 'ขาด'), N('excessQty', 'เกิน Max'), C('unit', 'หน่วย')],
      totals: { items: rows.length, short: count('SHORT'), belowMin: count('BELOW_MIN'), overMax: count('OVER_MAX'), ok: count('OK') },
    };
  };

  /** Items with stock and no movement (status changes QS excluded) for opts.days (default policies.nonMovingDays). */
  reports.nonMoving = function nonMoving(state, opts) {
    opts = opts || {};
    const today = todayOf(state, opts);
    const pol = settingsOf(state).policies;
    const nd = util.num(opts.days);
    const days = isNaN(nd) ? Number(pol.nonMovingDays) || 90 : nd;
    const items = tablesOf(state).items || {};
    const qty = {};
    for (const b of T(state, 'balances')) {
      if (opts.wh && b.wh !== opts.wh) continue;
      qty[b.code] = round((qty[b.code] || 0) + b.qty);
    }
    const last = {};
    for (const m of T(state, 'movements')) {
      if (m.docType === 'QS' || (opts.wh && m.wh !== opts.wh)) continue;
      const p = last[m.code];
      if (!p || m.at > p.at || (m.at === p.at && m.seq > p.seq)) last[m.code] = m;
    }
    const rows = [];
    for (const code of Object.keys(qty)) {
      if (!(qty[code] > 0)) continue;
      const it = items[code] || {};
      if (opts.group && it.group !== opts.group) continue;
      const lm = last[code];
      const lastDate = lm ? dateOf(lm.at) : '';
      const idle = lastDate && today ? util.daysBetween(lastDate, today) : null;
      if (idle != null && idle < days) continue;
      const unitCost = Number(it.unitCost) || 0;
      rows.push({ code, name: it.name || '', unit: it.baseUnit || '', group: it.group || '', qty: qty[code],
        value: round(qty[code] * unitCost, 2), lastMoveDate: lastDate, lastDocNo: lm ? lm.docNo : '', lastDocType: lm ? lm.docType : '',
        idleDays: idle });
    }
    rows.sort((a, b) => (b.idleDays == null ? 1e9 : b.idleDays) - (a.idleDays == null ? 1e9 : a.idleDays) || a.code.localeCompare(b.code));
    return {
      rows, days, today, note: valueNote(state),
      cols: [C('code', 'รหัสสินค้า'), C('name', 'ชื่อสินค้า'), N('qty', 'คงเหลือ'), C('unit', 'หน่วย'), C('lastMoveDate', 'เคลื่อนไหวล่าสุด'),
        C('lastDocNo', 'เอกสารล่าสุด'), N('idleDays', 'ไม่เคลื่อนไหว (วัน)'), N('value', 'มูลค่าอ้างอิง')],
      totals: { items: rows.length, value: round(util.sum(rows, (r) => r.value), 2), days },
    };
  };

  function bucketOf(days) {
    if (days == null) return 'ไม่ทราบ';
    if (days <= 30) return '0-30';
    if (days <= 90) return '31-90';
    if (days <= 180) return '91-180';
    return '>180';
  }
  /** Age of every balance: days since its last receipt (lots: lots.receivedAt when known). opts: wh, code, status. */
  reports.aging = function aging(state, opts) {
    opts = opts || {};
    const today = todayOf(state, opts);
    const items = tablesOf(state).items || {};
    const lots = tablesOf(state).lots || {};
    const rows = [];
    for (const b of T(state, 'balances')) {
      if (!(b.qty > 0)) continue;
      if (opts.wh && b.wh !== opts.wh) continue;
      if (opts.code && b.code !== opts.code) continue;
      if (opts.status && b.status !== opts.status) continue;
      const it = items[b.code] || {};
      const lot = b.lot ? lots[b.code + '|' + b.lot] : null;
      const sinceAt = (lot && lot.receivedAt) || b.lastIn || b.updatedAt || '';
      const since = dateOf(sinceAt);
      const days = since && today ? Math.max(0, util.daysBetween(since, today)) : null;
      const unitCost = Number(it.unitCost) || 0;
      rows.push({ code: b.code, name: it.name || '', unit: it.baseUnit || '', wh: b.wh, bin: b.bin || '', status: b.status,
        statusLabel: STATUS_LABEL[b.status] || b.status, lot: b.lot || '', qty: round(b.qty), since,
        sinceFrom: lot && lot.receivedAt ? 'lot' : 'lastIn', days, bucket: bucketOf(days), value: round(b.qty * unitCost, 2) });
    }
    rows.sort((a, b) => (b.days == null ? -1 : b.days) - (a.days == null ? -1 : a.days) || a.code.localeCompare(b.code));
    const buckets = {};
    for (const k of AGE_BUCKETS.concat(['ไม่ทราบ'])) buckets[k] = { rows: 0, value: 0 };
    for (const r of rows) {
      buckets[r.bucket].rows += 1;
      buckets[r.bucket].value = round(buckets[r.bucket].value + r.value, 2);
    }
    return {
      rows, today, note: valueNote(state),
      cols: [C('code', 'รหัสสินค้า'), C('name', 'ชื่อสินค้า'), C('wh', 'คลัง'), C('bin', 'ช่องเก็บ'), C('statusLabel', 'สถานะ'),
        C('lot', 'ล็อต/Heat'), N('qty', 'จำนวน'), C('unit', 'หน่วย'), C('since', 'รับเข้าเมื่อ'), N('days', 'อายุ (วัน)'),
        C('bucket', 'ช่วงอายุ (วัน)'), N('value', 'มูลค่าอ้างอิง')],
      totals: { rows: rows.length, buckets, value: round(util.sum(rows, (r) => r.value), 2) },
    };
  };

  /** Tolerance of a count line: max(recountQty, recountPct % of the system quantity). */
  function countLimit(system, pol) {
    const q = util.num(pol.recountQty);
    const p = util.num(pol.recountPct);
    return Math.max(isNaN(q) ? 0 : q, ((isNaN(p) ? 0 : p) / 100) * Math.abs(Number(system) || 0));
  }
  const isNum = (v) => v !== null && v !== undefined && v !== '' && !isNaN(util.num(v));
  /**
   * Count accuracy from APPROVED count sessions: lines within tolerance / lines counted (accepted result = final
   * when present). opts: from, to (approval date), wh.
   */
  reports.countAccuracy = function countAccuracy(state, opts) {
    opts = opts || {};
    const pol = settingsOf(state).policies;
    const rows = [];
    const misses = [];
    let all = 0;
    let within = 0;
    const sessions = T(state, 'count_sessions').filter((s) => s.status === 'APPROVED' && (!opts.wh || s.wh === opts.wh)
      && (!opts.from && !opts.to ? true : inPeriod(dateOf(s.approvedAt), opts.from, opts.to)))
      .sort((a, b) => String(a.approvedAt).localeCompare(String(b.approvedAt)) || String(a.id).localeCompare(String(b.id)));
    for (const s of sessions) {
      let n = 0;
      let ok = 0;
      for (const l of s.lines || []) {
        const f = l.final && isNum(l.final.counted) ? l.final : null;
        const counted = f ? util.num(f.counted) : util.num(l.counted);
        if (!f && !isNum(l.counted)) continue;
        const system = util.num(f ? f.system : l.system) || 0;
        const diff = round(counted - system);
        const limit = round(countLimit(system, pol));
        n += 1;
        if (Math.abs(diff) <= limit) ok += 1;
        else misses.push({ session: s.id, wh: s.wh, code: l.code, bin: l.bin || '', lot: l.lot || '', system, counted, diff, limit });
      }
      all += n;
      within += ok;
      rows.push({ id: s.id, wh: s.wh, approvedAt: s.approvedAt || '', approvedDate: dateOf(s.approvedAt), approvedBy: s.approvedBy || '',
        lines: n, within: ok, accuracy: pct(ok, n) });
    }
    return {
      rows, misses,
      cols: [C('id', 'รอบนับ'), C('wh', 'คลัง'), C('approvedDate', 'อนุมัติเมื่อ'), C('approvedBy', 'ผู้อนุมัติ'), N('lines', 'บรรทัดที่นับ'),
        N('within', 'อยู่ในเกณฑ์'), N('accuracy', 'ความแม่นยำ (%)')],
      colsMisses: [C('session', 'รอบนับ'), C('code', 'รหัสสินค้า'), C('bin', 'ช่องเก็บ'), C('lot', 'ล็อต'), N('system', 'ยอดระบบ'),
        N('counted', 'นับได้'), N('diff', 'ผลต่าง'), N('limit', 'เกณฑ์')],
      totals: { sessions: rows.length, lines: all, within, accuracy: pct(within, all),
        rule: `อยู่ในเกณฑ์เมื่อ |ผลต่าง| ≤ max(${pol.recountQty} หน่วย, ${pol.recountPct}% ของยอดระบบ)` },
    };
  };

  const OPEN_NCR = { OPEN: true, DISPOSITIONED: true };
  /** Stock waiting for QC (QC_HOLD / QUARANTINE / REWORK) with its age, plus open inspections and NCRs. opts: today, now, wh, code. */
  reports.qcPending = function qcPending(state, opts) {
    opts = opts || {};
    const today = todayOf(state, opts);
    const items = tablesOf(state).items || {};
    const since = sinceMap(state);
    const insp = T(state, 'inspections').filter((i) => i.status === 'OPEN' && (!opts.code || i.code === opts.code) && (!opts.wh || i.wh === opts.wh));
    const ncrs = T(state, 'ncrs').filter((n) => OPEN_NCR[n.status] && (!opts.code || n.code === opts.code) && (!opts.wh || n.wh === opts.wh));
    const match = (b, x) => x.code === b.code && (!x.wh || x.wh === b.wh) && (!x.lot || x.lot === b.lot) && (!x.bin || !b.bin || x.bin === b.bin);
    const rows = [];
    for (const b of T(state, 'balances')) {
      if (b.status === STATUS.AVAILABLE || !(b.qty > 0)) continue;
      if (opts.wh && b.wh !== opts.wh) continue;
      if (opts.code && b.code !== opts.code) continue;
      const it = items[b.code] || {};
      const sAt = since[RRS.balanceKey(b)] || b.lastIn || b.updatedAt || '';
      const sDate = dateOf(sAt);
      rows.push({ code: b.code, name: it.name || '', unit: it.baseUnit || '', wh: b.wh, bin: b.bin || '', lot: b.lot || '',
        status: b.status, statusLabel: STATUS_LABEL[b.status] || b.status, qty: round(b.qty), since: sAt, sinceDate: sDate,
        ageDays: sDate && today ? Math.max(0, util.daysBetween(sDate, today)) : null,
        ageHours: opts.now && sAt ? hoursBetween(sAt, opts.now) : null,
        inspections: insp.filter((i) => match(b, i)).map((i) => i.id), ncrs: ncrs.filter((n) => match(b, n)).map((n) => n.ncrNo) });
    }
    const rank = { QUARANTINE: 0, QC_HOLD: 1, REWORK: 2 };
    rows.sort((a, b) => (rank[a.status] - rank[b.status]) || ((b.ageDays || 0) - (a.ageDays || 0)) || a.code.localeCompare(b.code));
    const inspections = insp.map((i) => ({ id: i.id, stage: i.stage, stageLabel: STAGE_LABEL[i.stage] || i.stage, code: i.code, wh: i.wh || '',
      lot: i.lot || '', qty: i.qty, result: i.result, inspector: i.inspector, at: i.at,
      ageDays: today && i.at ? Math.max(0, util.daysBetween(dateOf(i.at), today)) : null }))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const ncrRows = ncrs.map((n) => ({ ncrNo: n.ncrNo, code: n.code, wh: n.wh || '', lot: n.lot || '', qty: n.qty, defect: n.defect || '',
      status: n.status, disposition: n.disposition || '', createdAt: n.createdAt || '',
      ageDays: today && n.createdAt ? Math.max(0, util.daysBetween(dateOf(n.createdAt), today)) : null }))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const qtyOf = (s) => rows.filter((r) => r.status === s).length;
    return {
      rows, inspections, ncrs: ncrRows, today,
      cols: [C('statusLabel', 'สถานะ'), C('code', 'รหัสสินค้า'), C('name', 'ชื่อสินค้า'), C('wh', 'คลัง'), C('bin', 'ช่องเก็บ'),
        C('lot', 'ล็อต/Heat'), N('qty', 'จำนวน'), C('unit', 'หน่วย'), C('sinceDate', 'เข้าสถานะนี้เมื่อ'), N('ageDays', 'รอมาแล้ว (วัน)')],
      colsInspections: [C('id', 'ผลตรวจ'), C('stageLabel', 'ขั้นตอน'), C('code', 'รหัสสินค้า'), C('lot', 'ล็อต'), N('qty', 'จำนวน'),
        C('result', 'ผล'), C('inspector', 'ผู้ตรวจ'), N('ageDays', 'รอปล่อย (วัน)')],
      colsNcrs: [C('ncrNo', 'NCR'), C('code', 'รหัสสินค้า'), C('lot', 'ล็อต'), N('qty', 'จำนวน'), C('defect', 'ข้อบกพร่อง'),
        C('status', 'สถานะ'), C('disposition', 'การตัดสิน'), N('ageDays', 'เปิดมาแล้ว (วัน)')],
      totals: { rows: rows.length, qcHold: qtyOf(STATUS.QC_HOLD), quarantine: qtyOf(STATUS.QUARANTINE), rework: qtyOf(STATUS.REWORK),
        oldestDays: rows.reduce((m, r) => Math.max(m, r.ageDays || 0), 0), openInspections: inspections.length, openNcrs: ncrRows.length },
    };
  };

  const isFirst = (i) => !i.reinspectionOf && !i.reinspectionNcr;
  function inspectionsIn(state, opts) {
    return T(state, 'inspections').filter((i) => i.status !== 'VOID' && (!opts.stage || i.stage === opts.stage)
      && (!opts.code || i.code === opts.code) && (!opts.from && !opts.to ? true : inPeriod(dateOf(i.at), opts.from, opts.to)));
  }

  /**
   * Average hours from stock arriving in QC_HOLD (the receipt movement) to its inspection. The arrival is the
   * movement of the inspection's source document when known, else the latest arrival of that code/warehouse/lot
   * before the inspection. opts: from, to.
   */
  reports.qcWait = function qcWait(state, opts) {
    opts = opts || {};
    const arrivals = T(state, 'movements').filter((m) => m.status === STATUS.QC_HOLD && m.qty > 0 && !m.reversalOf && m.docType !== 'QS');
    const rows = [];
    let unmatched = 0;
    for (const i of inspectionsIn(state, opts)) {
      if (i.fromStatus && i.fromStatus !== STATUS.QC_HOLD) continue;
      if (!i.fromStatus && !isFirst(i)) continue;
      if (!i.wh) continue;
      const fit = (m) => m.code === i.code && m.wh === i.wh && (!i.lot || m.lot === i.lot) && (!i.bin || m.bin === i.bin) && m.at <= i.at;
      let cand = arrivals.filter((m) => fit(m) && (!i.sourceDoc || m.docNo === i.sourceDoc));
      if (!cand.length && i.sourceDoc) cand = arrivals.filter(fit);
      if (!cand.length) {
        unmatched += 1;
        continue;
      }
      const m = cand.reduce((a, b) => (b.at > a.at || (b.at === a.at && b.seq > a.seq) ? b : a));
      rows.push({ id: i.id, stage: i.stage, stageLabel: STAGE_LABEL[i.stage] || i.stage, code: i.code, lot: i.lot || '', wh: i.wh,
        docNo: m.docNo, arrivedAt: m.at, inspectedAt: i.at, hours: hoursBetween(m.at, i.at) });
    }
    rows.sort((a, b) => String(a.inspectedAt).localeCompare(String(b.inspectedAt)));
    const hrs = rows.map((r) => r.hours).filter((h) => h != null);
    return {
      rows,
      cols: [C('id', 'ผลตรวจ'), C('stageLabel', 'ขั้นตอน'), C('code', 'รหัสสินค้า'), C('lot', 'ล็อต'), C('docNo', 'เอกสารรับ'),
        C('arrivedAt', 'เข้ารอตรวจเมื่อ'), C('inspectedAt', 'ตรวจเมื่อ'), N('hours', 'รอ (ชั่วโมง)')],
      totals: { n: hrs.length, avgHours: hrs.length ? round(util.sum(hrs) / hrs.length, 2) : null,
        maxHours: hrs.length ? Math.max.apply(null, hrs) : null, unmatched },
    };
  };

  /** First-pass yield: first inspections (not re-inspections) with PASS / all first inspections, per stage and code. */
  reports.fpy = function fpy(state, opts) {
    opts = opts || {};
    const items = tablesOf(state).items || {};
    const groups = {};
    const byStage = {};
    let first = 0;
    let pass = 0;
    for (const i of inspectionsIn(state, opts)) {
      if (!isFirst(i)) continue;
      const k = i.stage + '|' + i.code;
      const g = groups[k] || (groups[k] = { stage: i.stage, stageLabel: STAGE_LABEL[i.stage] || i.stage, code: i.code,
        name: (items[i.code] || {}).name || '', first: 0, pass: 0, fail: 0 });
      const s = byStage[i.stage] || (byStage[i.stage] = { first: 0, pass: 0 });
      g.first += 1;
      s.first += 1;
      first += 1;
      if (i.result === 'PASS') {
        g.pass += 1;
        s.pass += 1;
        pass += 1;
      } else g.fail += 1;
    }
    const rows = Object.values(groups).map((g) => Object.assign(g, { fpy: pct(g.pass, g.first) }))
      .sort((a, b) => (STAGE_ORDER[a.stage] || 9) - (STAGE_ORDER[b.stage] || 9) || a.code.localeCompare(b.code));
    for (const k in byStage) byStage[k].fpy = pct(byStage[k].pass, byStage[k].first);
    const w = reports.qcWait(state, opts).totals;
    return {
      rows,
      cols: [C('stageLabel', 'ขั้นตอน'), C('code', 'รหัสสินค้า'), C('name', 'ชื่อสินค้า'), N('first', 'ตรวจครั้งแรก'), N('pass', 'ผ่าน'),
        N('fail', 'ไม่ผ่าน'), N('fpy', 'ผ่านครั้งแรก (%)')],
      totals: { first, pass, fpy: pct(pass, first), byStage, qcWaitHours: w.avgHours, qcWaitN: w.n },
    };
  };

  const defectKey = (d) => util.trim(d).toUpperCase();
  /** NCRs grouped by code + defect within a period; a group with count ≥ opts.minCount (2) is a repeat. opts: from, to, code. */
  reports.repeatIssues = function repeatIssues(state, opts) {
    opts = opts || {};
    const minN = Number(opts.minCount) || 2;
    const items = tablesOf(state).items || {};
    const groups = {};
    for (const n of T(state, 'ncrs')) {
      if (opts.code && n.code !== opts.code) continue;
      if ((opts.from || opts.to) && !inPeriod(dateOf(n.createdAt), opts.from, opts.to)) continue;
      const k = n.code + '|' + defectKey(n.defect);
      const g = groups[k] || (groups[k] = { code: n.code, name: (items[n.code] || {}).name || '', defect: util.trim(n.defect) || '(ไม่ระบุ)',
        count: 0, ncrNos: [], firstAt: n.createdAt || '', lastAt: n.createdAt || '', open: 0 });
      g.count += 1;
      g.ncrNos.push(n.ncrNo);
      if (n.createdAt && (!g.firstAt || n.createdAt < g.firstAt)) g.firstAt = n.createdAt;
      if (n.createdAt && n.createdAt > g.lastAt) g.lastAt = n.createdAt;
      if (n.status !== 'CLOSED') g.open += 1;
    }
    const rows = Object.values(groups).map((g) => Object.assign(g, { repeat: g.count >= minN, repeatLabel: g.count >= minN ? 'ซ้ำ' : '',
      ncrNos: g.ncrNos.sort(), firstDate: dateOf(g.firstAt), lastDate: dateOf(g.lastAt) }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code) || a.defect.localeCompare(b.defect));
    const rep = rows.filter((r) => r.repeat);
    return {
      rows,
      cols: [C('code', 'รหัสสินค้า'), C('name', 'ชื่อสินค้า'), C('defect', 'ข้อบกพร่อง'), N('count', 'จำนวนครั้ง'),
        C('repeatLabel', 'ปัญหาซ้ำ'), C('firstDate', 'พบครั้งแรก'), C('lastDate', 'พบล่าสุด'), N('open', 'ยังไม่ปิด')],
      totals: { groups: rows.length, repeats: rep.length, repeatNcrs: util.sum(rep, (r) => r.count),
        occurrences: util.sum(rep, (r) => r.count - 1), minCount: minN },
    };
  };

  /**
   * KPI actuals for the period (default: the calendar month of opts.today) compared with the Phase 0 baseline and
   * target: count_accuracy %, qc_wait hours, fpy %, repeat_ncr (repeated problems), shortage (items short now).
   */
  reports.kpiActuals = function kpiActuals(state, opts) {
    opts = opts || {};
    const today = todayOf(state, opts);
    const from = opts.from || monthStart(today);
    const to = opts.to || today;
    const period = { from, to };
    const actual = {
      count_accuracy: reports.countAccuracy(state, period).totals.accuracy,
      qc_wait: reports.qcWait(state, period).totals.avgHours,
      fpy: reports.fpy(state, period).totals.fpy,
      repeat_ncr: reports.repeatIssues(state, period).totals.repeats,
      shortage: reports.shortageExcess(state).totals.short,
    };
    const source = {
      count_accuracy: 'รอบนับที่อนุมัติในช่วง: บรรทัดในเกณฑ์ / บรรทัดที่นับ',
      qc_wait: 'ชั่วโมงเฉลี่ยจากของเข้ารอตรวจถึงผลตรวจ',
      fpy: 'ผลตรวจครั้งแรกที่ผ่าน / ผลตรวจครั้งแรกทั้งหมด',
      repeat_ncr: 'กลุ่ม NCR รหัสเดียวกันข้อบกพร่องเดียวกันตั้งแต่ 2 ครั้งในช่วง',
      shortage: 'จำนวนรหัสที่ขาดตอนนี้ (พร้อมใช้ < ต้องใช้ตามใบงานที่เปิด)',
    };
    const kp = tablesOf(state).kpis || {};
    const defs = (RRS.master && RRS.master.KPI_DEFAULTS) || [];
    const ids = uniq(defs.map((d) => d.id).concat(Object.keys(kp)).concat(Object.keys(actual)));
    const rows = ids.map((id) => {
      const d = defs.find((x) => x.id === id) || {};
      const k = kp[id] || {};
      const baseline = k.baseline == null || k.baseline === '' ? null : Number(k.baseline);
      const target = k.target == null || k.target === '' ? null : Number(k.target);
      const a = Object.prototype.hasOwnProperty.call(actual, id) ? actual[id] : null;
      const better = KPI_BETTER[id] || 'up';
      const cmp = (x, y) => (better === 'up' ? x >= y : x <= y);
      const met = a == null || target == null ? null : cmp(a, target);
      const improved = a == null || baseline == null ? null : (a === baseline ? false : cmp(a, baseline));
      return { id, label: k.label || d.label || id, unit: k.unit || d.unit || '', baseline, target, actual: a, met, better,
        betterLabel: better === 'up' ? 'ยิ่งมากยิ่งดี' : 'ยิ่งน้อยยิ่งดี', improved, metLabel: met == null ? 'ยังวัดไม่ได้' : met ? 'ถึงเป้า' : 'ยังไม่ถึงเป้า',
        source: source[id] || 'ยังไม่มีวิธีวัดอัตโนมัติ – บันทึกค่าในหน้า ตัวชี้วัด' };
    });
    return {
      rows, period,
      cols: [C('label', 'ตัวชี้วัด'), C('unit', 'หน่วย'), N('baseline', 'ค่าก่อนเริ่ม'), N('target', 'เป้าหมาย'), N('actual', 'ค่าจริง'),
        C('metLabel', 'ผล'), C('betterLabel', 'ทิศทาง'), C('source', 'วิธีคำนวณ')],
      totals: { measured: rows.filter((r) => r.actual != null).length, met: rows.filter((r) => r.met === true).length,
        notMet: rows.filter((r) => r.met === false).length, noTarget: rows.filter((r) => r.target == null).length },
    };
  };

  /**
   * Daily integrity check (ตรวจยอดประจำวัน): balances = Σ history; negative balances only with an approved
   * exception; no QC_HOLD/QUARANTINE stock taken out except by QS/SC/RV (or by cancelling its own receipt); request
   * ids (unique by construction); no document posted twice; cancelled documents fully reversed.
   */
  reports.dailyCheck = function dailyCheck(state) {
    const problems = [];
    const balanceDiffs = RRS.inventory.verifyBalances(state);
    if (balanceDiffs.length) problems.push(`ยอดคงเหลือไม่ตรงกับผลรวมประวัติ ${balanceDiffs.length} ตำแหน่ง`);
    const docs = tablesOf(state).documents || {};
    const moves = T(state, 'movements');
    const byKey = {};
    const byId = {};
    const byDoc = {};
    const reversed = new Set();
    for (const m of moves) {
      byId[m.id] = m;
      (byKey[RRS.balanceKey(m)] || (byKey[RRS.balanceKey(m)] = [])).push(m);
      if (m.reversalOf) reversed.add(m.reversalOf);
      else if (m.docNo) (byDoc[m.docType + '|' + m.docNo] || (byDoc[m.docType + '|' + m.docNo] = [])).push(m);
    }
    // negative balances
    const negatives = [];
    for (const b of T(state, 'balances')) {
      if (!(b.qty < 0)) continue;
      const k = RRS.balanceKey(b);
      const approved = uniq((byKey[k] || []).map((m) => m.docNo)).map((n) => docs[n])
        .filter((d) => d && d.override && d.override.approvedBy)
        .map((d) => ({ docNo: d.docNo, type: d.type, requestedBy: d.override.requestedBy || '', approvedBy: d.override.approvedBy,
          reason: d.override.reason || '', at: d.override.at || '' }));
      negatives.push({ key: k, code: b.code, wh: b.wh, bin: b.bin || '', status: b.status, lot: b.lot || '', qty: round(b.qty),
        approved: approved.length > 0, docs: approved });
      if (!approved.length) problems.push(`${b.code} ที่ ${locText(b)} ติดลบ ${round(b.qty)} โดยไม่มีเอกสารอนุมัติข้อยกเว้น`);
    }
    // quarantined / waiting-for-QC stock that left outside the QC path
    const HELD = { QUARANTINE: true, QC_HOLD: true };
    const OUT_OK = { QS: true, SC: true, RV: true };
    const quarantineLeaks = [];
    for (const m of moves) {
      if (!(m.qty < 0) || !HELD[m.status] || OUT_OK[m.docType]) continue;
      if (m.reversalOf) {
        const o = byId[m.reversalOf];
        if (o && o.qty > 0 && RRS.balanceKey(o) === RRS.balanceKey(m)) continue; // cancelling its own receipt
      }
      quarantineLeaks.push({ id: m.id, seq: m.seq, at: m.at, docType: m.docType, docNo: m.docNo, code: m.code, wh: m.wh, bin: m.bin,
        lot: m.lot, status: m.status, qty: m.qty, by: m.by });
      problems.push(`${m.docType || '?'} ${m.docNo || ''} นำของ${STATUS_LABEL[m.status]} ${m.code} ออก ${round(-m.qty)} ที่ ${locText(m)} โดยไม่ผ่าน QC`);
    }
    // documents posted twice
    const doublePosted = [];
    for (const dk of Object.keys(byDoc)) {
      const list = byDoc[dk];
      const type = dk.slice(0, dk.indexOf('|'));
      const docNo = dk.slice(dk.indexOf('|') + 1);
      const td = RRS.inventory.DOC_TYPES[type];
      const posting = td && td.dir === 'T' ? list.filter((m) => m.wh !== TRANSIT && m.qty < 0) : list;
      const seqs = uniq(posting.map((m) => m.seq));
      let why = '';
      if (seqs.length > 1) why = `บันทึก ${seqs.length} ครั้ง (ลำดับ ${seqs.join(', ')})`;
      else if (td && (td.dir === -1 || td.dir === 0 || td.dir === 1)) {
        const perLine = {};
        for (const m of posting) perLine[m.line] = (perLine[m.line] || 0) + 1;
        const dup = Object.keys(perLine).filter((l) => perLine[l] > 1);
        if (dup.length) why = `บรรทัด ${dup.join(', ')} ตัดยอดมากกว่า 1 ครั้ง`;
      }
      if (why) {
        doublePosted.push({ docType: type, docNo, seqs, detail: why });
        problems.push(`เอกสาร ${docNo} ${why}`);
      }
    }
    // cancelled documents must be fully reversed
    const cancelNotReversed = [];
    for (const d of Object.values(docs)) {
      if (d.status !== 'CANCELLED') continue;
      const open = (byDoc[d.type + '|' + d.docNo] || []).filter((m) => !reversed.has(m.id));
      if (open.length) {
        cancelNotReversed.push({ docNo: d.docNo, type: d.type, movements: open.map((m) => m.id) });
        problems.push(`เอกสาร ${d.docNo} ยกเลิกแล้วแต่ยังไม่กลับยอด ${open.length} รายการ`);
      }
    }
    const requests = { count: Object.keys((state && state.requests) || {}).length, duplicates: 0 };
    const checks = [
      { id: 'balances', label: 'ยอดคงเหลือ = ผลรวมประวัติเคลื่อนไหว', ok: !balanceDiffs.length, count: balanceDiffs.length },
      { id: 'negative', label: 'ยอดติดลบต้องมีเอกสารอนุมัติข้อยกเว้น', ok: negatives.every((n) => n.approved), count: negatives.length },
      { id: 'quarantine', label: 'ของรอตรวจ/กักกันไม่ถูกนำออกนอกขั้นตอน QC', ok: !quarantineLeaks.length, count: quarantineLeaks.length },
      { id: 'requests', label: 'คำขอเดิมส่งซ้ำไม่ถูกบันทึกซ้ำ (จำนวนรหัสคำขอที่รู้จัก)', ok: true, count: requests.count },
      { id: 'double', label: 'ไม่มีเอกสารตัดยอดซ้ำ', ok: !doublePosted.length, count: doublePosted.length },
      { id: 'cancel', label: 'เอกสารที่ยกเลิกกลับยอดครบ', ok: !cancelNotReversed.length, count: cancelNotReversed.length },
    ];
    for (const c of checks) c.okLabel = c.ok ? 'ผ่าน' : 'ไม่ผ่าน';
    return { ok: problems.length === 0, seq: (state && state.seq) || 0, head: (state && state.head) || '', checks, problems, balanceDiffs,
      negatives, quarantineLeaks, requests, doublePosted, cancelNotReversed,
      cols: [C('label', 'หัวข้อตรวจ'), C('okLabel', 'ผล'), N('count', 'จำนวน')] };
  };

  /** UAT checklist with the latest result of every criterion (and custom rows). opts: phases. */
  reports.uatSummary = function uatSummary(state, opts) {
    opts = opts || {};
    const rec = tablesOf(state).uat || {};
    const phases = opts.phases ? opts.phases.map(Number) : null;
    const list = UAT_CRITERIA.map((c) => Object.assign({}, c));
    for (const id of Object.keys(rec)) if (!list.find((c) => c.id === id)) list.push({ id, phase: rec[id].phase, criterion: rec[id].criterion, auto: '', custom: true });
    const rows = list.filter((c) => !phases || phases.indexOf(Number(c.phase)) >= 0).map((c) => {
      const r = rec[c.id] || {};
      const status = r.status || 'NOT_RUN';
      return { id: c.id, phase: c.phase, criterion: c.criterion, auto: c.auto || '', custom: !!c.custom, status, statusLabel: UAT_STATUS[status],
        tester: r.tester || '', testedOn: r.testedOn || '', evidence: r.evidence || '', note: r.note || '', retests: (r.history || []).length };
    }).sort((a, b) => a.phase - b.phase || a.id.localeCompare(b.id, undefined, { numeric: true }));
    const byPhase = {};
    for (const r of rows) {
      const p = byPhase[r.phase] || (byPhase[r.phase] = { title: PHASE_TITLE[r.phase] || '', total: 0, PASS: 0, FAIL: 0, NOT_RUN: 0 });
      p.total += 1;
      p[r.status] += 1;
    }
    const cnt = (s) => rows.filter((r) => r.status === s).length;
    return {
      rows, byPhase,
      cols: [C('id', 'รหัส'), N('phase', 'ระยะ (Phase)'), C('criterion', 'เกณฑ์ผ่าน'), C('statusLabel', 'ผล'), C('tester', 'ผู้ทดสอบ'),
        C('testedOn', 'วันที่'), C('evidence', 'หลักฐาน'), C('auto', 'ทดสอบอัตโนมัติ')],
      totals: { total: rows.length, pass: cnt('PASS'), fail: cnt('FAIL'), notRun: cnt('NOT_RUN'), allPass: rows.length > 0 && cnt('PASS') === rows.length },
    };
  };

  // ---------------------------------------------------------------------------------------------------------
  // offcuts (เศษเหล็ก)
  // ---------------------------------------------------------------------------------------------------------
  /** Material family: policies.materialFamilies {material: family} when set, else the material itself. */
  function familyOf(policies, material) {
    const k = util.ckey(material);
    if (!k) return '';
    const map = (policies && policies.materialFamilies) || {};
    for (const m in map) if (util.ckey(m) === k) return util.ckey(map[m]) || k;
    return k;
  }
  /** Does a piece needW × needL fit in a w × l piece (rotation allowed)? */
  function fitOf(w, l, needW, needL) {
    if (w >= needW && l >= needL) return { fit: true, rotated: false };
    if (w >= needL && l >= needW) return { fit: true, rotated: true };
    return { fit: false, rotated: false };
  }
  const sameThk = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 1e-6;
  const lotQuarantined = (getter, code, lot) => {
    if (!lot) return false;
    const r = getter('lots', code + '|' + lot);
    return !!(r && r.status === 'QUARANTINED');
  };

  /**
   * Offcuts to use before a new plate: AVAILABLE, same material family and thickness, big enough (rotation allowed),
   * smallest area first, with waste %. Offcuts of a quarantined source lot are never offered (listed in `blocked`).
   * q: {material, thickness, width, length, wh?, code? (material/thickness from the item)}.
   */
  reports.suggestOffcuts = function suggestOffcuts(state, q) {
    q = q || {};
    const problems = [];
    const pol = settingsOf(state).policies;
    const it = q.code ? RRS.q.item(state, q.code) : null;
    if (q.code && !it) problems.push(`ไม่พบสินค้า ${q.code}`);
    const material = util.trim(q.material) || (it && it.material) || '';
    const thickness = isNum(q.thickness) ? util.num(q.thickness) : Number(it && it.thickness) || 0;
    const width = util.num(q.width);
    const length = util.num(q.length);
    if (!material) problems.push('ระบุวัสดุ');
    if (!(thickness > 0)) problems.push('ระบุความหนา (มม.) มากกว่า 0');
    if (!(width > 0) || !(length > 0)) problems.push('ระบุขนาดที่ต้องการ กว้าง × ยาว (มม.) มากกว่า 0');
    const cols = [C('id', 'รหัสเศษ (QR)'), C('material', 'วัสดุ'), N('thickness', 'หนา'), N('width', 'กว้าง'), N('length', 'ยาว'),
      C('wh', 'คลัง'), C('bin', 'ช่องเก็บ'), C('sourceLot', 'ล็อต/Heat'), C('rotatedLabel', 'หมุน'), N('wastePct', 'เศษทิ้ง (%)')];
    if (problems.length) return { rows: [], plates: [], blocked: [], cols, problems, advice: '', totals: { found: 0 } };
    const fam = familyOf(pol, material);
    const need = width * length;
    const get = (t, k) => G(state, t, k);
    const rows = [];
    const blocked = [];
    for (const o of T(state, 'offcuts')) {
      if (o.status !== 'AVAILABLE') continue;
      if (q.wh && o.wh !== q.wh) continue;
      if (familyOf(pol, o.material) !== fam || !sameThk(o.thickness, thickness)) continue;
      const f = fitOf(o.width, o.length, width, length);
      if (!f.fit) continue;
      if (lotQuarantined(get, o.code, o.sourceLot)) {
        blocked.push({ id: o.id, sourceLot: o.sourceLot, reason: `ล็อต ${o.sourceLot} ถูกกักกัน` });
        continue;
      }
      const area = round(o.width * o.length, 3);
      rows.push({ id: o.id, code: o.code, material: o.material, thickness: o.thickness, width: o.width, length: o.length, area,
        wh: o.wh, bin: o.bin || '', sourceLot: o.sourceLot || '', rotated: f.rotated, rotatedLabel: f.rotated ? 'หมุน 90°' : '',
        wastePct: round(((area - need) / area) * 100, 1) });
    }
    rows.sort((a, b) => a.area - b.area || a.id.localeCompare(b.id));
    // new plates of the same material family and thickness that are in stock (fallback)
    const plates = [];
    const free = {};
    for (const b of T(state, 'balances')) {
      if (b.status !== STATUS.AVAILABLE || b.wh === TRANSIT || (q.wh && b.wh !== q.wh) || lotQuarantined(get, b.code, b.lot)) continue;
      free[b.code] = (free[b.code] || 0) + b.qty;
    }
    for (const p of T(state, 'items')) {
      if (p.active === false || familyOf(pol, p.material) !== fam || !sameThk(p.thickness, thickness)) continue;
      const avail = free[p.id] || 0;
      if (!(avail > 0)) continue;
      const known = p.width > 0 && p.length > 0;
      const f = known ? fitOf(p.width, p.length, width, length) : { fit: true, rotated: false };
      if (!f.fit) continue;
      plates.push({ code: p.id, name: p.name, available: round(avail), unit: p.baseUnit, width: p.width || null, length: p.length || null,
        wastePct: known ? round(((p.width * p.length - need) / (p.width * p.length)) * 100, 1) : null });
    }
    plates.sort((a, b) => (a.wastePct == null ? 101 : a.wastePct) - (b.wastePct == null ? 101 : b.wastePct) || a.code.localeCompare(b.code));
    const advice = rows.length ? `ใช้เศษ ${rows[0].id} ก่อนแผ่นใหม่ (เศษทิ้ง ${rows[0].wastePct}%)`
      : plates.length ? `ไม่มีเศษที่ใช้ได้ – ใช้แผ่นใหม่ ${plates[0].code}` : 'ไม่มีเศษหรือแผ่นใหม่ที่ใช้ได้ในคลัง';
    return { rows, plates, blocked, cols, problems, advice, family: fam, totals: { found: rows.length, plates: plates.length, blocked: blocked.length } };
  };

  /** Offcut register for screens. opts: status (default AVAILABLE; 'ALL' for every row), wh, code. */
  reports.offcuts = function offcuts(state, opts) {
    opts = opts || {};
    const st = opts.status || 'AVAILABLE';
    const rows = T(state, 'offcuts').filter((o) => (st === 'ALL' || o.status === st) && (!opts.wh || o.wh === opts.wh) && (!opts.code || o.code === opts.code))
      .map((o) => Object.assign({}, o, { statusLabel: OFFCUT_STATUS[o.status] || o.status, size: `${o.width} × ${o.length}` }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return {
      rows,
      cols: [C('id', 'รหัสเศษ (QR)'), C('code', 'แผ่นต้นทาง'), C('material', 'วัสดุ'), N('thickness', 'หนา (มม.)'), C('size', 'กว้าง × ยาว (มม.)'),
        C('wh', 'คลัง'), C('bin', 'ช่องเก็บ'), C('sourceLot', 'ล็อต/Heat'), C('statusLabel', 'สถานะ'), C('parent', 'ตัดมาจาก'), C('usedFor', 'ใช้กับ')],
      totals: { rows: rows.length, area: round(util.sum(rows, (r) => r.area || 0), 1) },
    };
  };

  function hist(row, tx, action, detail) {
    row.history = (row.history || []).concat([{ at: tx.now, by: tx.userId, action, detail: detail || '' }]);
    row.by = tx.userId;
    row.at = tx.now;
    return row;
  }
  /** Warehouse/bin of an offcut: exists, active, not in transit, the user may work there. Returns {wh, bin} or null. */
  function checkLoc(tx, whRaw, binRaw, where) {
    const wh = util.normCode(whRaw);
    const bin = util.normCode(binRaw);
    if (!wh) { tx.error('REQUIRED', 'ระบุคลังที่เก็บเศษ', Object.assign({ field: 'wh' }, where)); return null; }
    if (wh === TRANSIT) { tx.error('RESERVED', `${TRANSIT} ใช้ภายในระบบ`, Object.assign({ field: 'wh' }, where)); return null; }
    const w = tx.get('warehouses', wh);
    if (!w) { tx.error('NOT_FOUND', `ไม่พบคลัง ${wh}`, Object.assign({ field: 'wh' }, where)); return null; }
    if (w.active === false) { tx.error('INACTIVE', `คลัง ${wh} ปิดใช้งาน`, Object.assign({ field: 'wh' }, where)); return null; }
    if (!tx.need('offcut.manage', wh, where)) return null;
    if (bin) {
      const b = tx.get('bins', wh + '|' + bin);
      if (!b) { tx.error('NOT_FOUND', `ไม่พบช่องเก็บ ${bin} ในคลัง ${wh}`, Object.assign({ field: 'bin' }, where)); return null; }
      if (b.active === false) { tx.error('INACTIVE', `ช่องเก็บ ${bin} ปิดใช้งาน`, Object.assign({ field: 'bin' }, where)); return null; }
    } else if (w.requireBin) {
      tx.error('BIN_REQUIRED', `คลัง ${wh} ต้องระบุช่องเก็บ`, Object.assign({ field: 'bin' }, where));
      return null;
    }
    return { wh, bin };
  }
  function dims(tx, w, l, where) {
    const width = util.num(w);
    const length = util.num(l);
    if (!(width > 0)) { tx.error('BAD_VALUE', `${where && where.line ? 'ชิ้นที่ ' + where.line + ': ' : ''}ความกว้างต้องเป็นตัวเลขมากกว่า 0 (มม.)`, Object.assign({ field: 'width' }, where)); return null; }
    if (!(length > 0)) { tx.error('BAD_VALUE', `${where && where.line ? 'ชิ้นที่ ' + where.line + ': ' : ''}ความยาวต้องเป็นตัวเลขมากกว่า 0 (มม.)`, Object.assign({ field: 'length' }, where)); return null; }
    return { width: round(width, 3), length: round(length, 3), area: round(width * length, 3) };
  }
  function getOffcut(tx, id) {
    const o = tx.get('offcuts', util.normCode(id));
    if (!o) tx.error('NOT_FOUND', `ไม่พบเศษ ${id || '(ว่าง)'} – สแกน QR ใหม่`, { field: 'id' });
    return o;
  }

  define('offcut.add', {
    label: 'บันทึกเศษเหล็กใช้ซ้ำ', perm: 'offcut.manage',
    prepare(tx, p) {
      const it = tx.item(p.code);
      if (!it) return tx.error('NOT_FOUND', `ไม่พบรหัสแผ่นต้นทาง ${p.code || '(ว่าง)'}`, { field: 'code' });
      if (it.active === false) return tx.error('INACTIVE', `${it.id} ปิดใช้งานแล้ว`, { field: 'code' });
      // material / thickness come from the plate's master data; a different value typed in is refused (never trusted)
      const itMat = util.trim(it.material);
      const material = util.trim(p.material) || itMat;
      if (!material) return tx.error('REQUIRED', `ระบุวัสดุ (ทะเบียน ${it.id} ไม่มีวัสดุ)`, { field: 'material' });
      if (itMat && util.ckey(material) !== util.ckey(itMat)) {
        return tx.error('BAD_VALUE', `วัสดุ ${material} ไม่ตรงกับแผ่นต้นทาง ${it.id} (${itMat})`, { field: 'material' });
      }
      if (p.thickness != null && p.thickness !== '' && !isNum(p.thickness)) return tx.error('BAD_VALUE', 'ความหนาต้องเป็นตัวเลข', { field: 'thickness' });
      const itThk = Number(it.thickness) || 0;
      const thickness = isNum(p.thickness) ? util.num(p.thickness) : itThk;
      if (!(thickness > 0)) return tx.error('REQUIRED', `ระบุความหนา (มม.) (ทะเบียน ${it.id} ไม่มีความหนา)`, { field: 'thickness' });
      if (itThk > 0 && !sameThk(thickness, itThk)) {
        return tx.error('BAD_VALUE', `ความหนา ${thickness} มม. ไม่ตรงกับแผ่นต้นทาง ${it.id} (${itThk} มม.)`, { field: 'thickness' });
      }
      const d = dims(tx, p.width, p.length);
      if (!d) return;
      if (it.width > 0 && it.length > 0 && !fitOf(it.width, it.length, d.width, d.length).fit) {
        return tx.error('TOO_BIG', `เศษ ${d.width} × ${d.length} มม. ใหญ่กว่าแผ่น ${it.id} (${it.width} × ${it.length} มม.)`, { field: 'width' });
      }
      const loc = checkLoc(tx, p.wh, p.bin);
      if (!loc) return;
      const sourceLot = util.trim(p.sourceLot);
      if (it.trackLot && it.trackLot !== 'none') {
        if (!sourceLot) return tx.error('LOT_REQUIRED', `${it.id} ติดตาม${RRS.master.TRACK[it.trackLot]} – ระบุล็อตต้นทางของเศษ`, { field: 'sourceLot' });
        if (/[|\u0000-\u001f]/.test(sourceLot)) return tx.error('BAD_LOT', 'เลขล็อตต้นทางห้ามมี | หรืออักขระควบคุม', { field: 'sourceLot' });
        if (!tx.get('lots', it.id + '|' + sourceLot) && !tx.all('movements', (m) => m.code === it.id && m.lot === sourceLot).length) {
          return tx.error('LOT_UNKNOWN', `ไม่พบ ${RRS.master.TRACK[it.trackLot]} ${sourceLot} ในประวัติของ ${it.id}`, { field: 'sourceLot' });
        }
        if (lotQuarantined((t, k) => tx.get(t, k), it.id, sourceLot)) {
          return tx.error('LOT_QUARANTINED', `ล็อต ${sourceLot} ของ ${it.id} ถูกกักกัน – บันทึกเศษเป็นของพร้อมใช้ไม่ได้`, { field: 'sourceLot' });
        }
      } else if (sourceLot) {
        return tx.error('LOT_NOT_TRACKED', `${it.id} ไม่ได้ตั้งให้ติดตามล็อต – ลบล็อตต้นทางออก`, { field: 'sourceLot' });
      }
      const id = tx.nextId('OC');
      const row = hist({ id, code: it.id, material, family: familyOf(tx.settings().policies, material), thickness, width: d.width,
        length: d.length, area: d.area, wh: loc.wh, bin: loc.bin, sourceLot, status: 'AVAILABLE', parent: util.normCode(p.parent) || '',
        children: [], createdFrom: util.trim(p.createdFrom), usedFor: '', remark: util.trim(p.remark), createdBy: tx.userId,
        createdAt: tx.now, usedBy: '', usedAt: '', scrappedBy: '', scrappedAt: '', scrapReason: '', voidedBy: '', voidedAt: '', voidReason: '' },
      tx, 'ADD', `${material} หนา ${thickness} ${d.width} × ${d.length} ที่ ${locText(loc)}`);
      if (row.parent && !tx.get('offcuts', row.parent)) return tx.error('NOT_FOUND', `ไม่พบเศษต้นทาง ${row.parent}`, { field: 'parent' });
      tx.put('offcuts', id, row);
      tx.result.id = id;
      tx.summary = `บันทึกเศษ ${id} ${it.id} ${d.width} × ${d.length} มม. ที่ ${locText(loc)}`;
    },
  });

  define('offcut.use', {
    label: 'ใช้เศษเหล็กตัดงาน', perm: 'offcut.manage',
    prepare(tx, p) {
      const o = getOffcut(tx, p.id);
      if (!o) return;
      if (o.status !== 'AVAILABLE') return tx.error('BAD_STATE', `เศษ ${o.id} ${OFFCUT_STATUS[o.status]} – ใช้ซ้ำไม่ได้`);
      if (!tx.need('offcut.manage', o.wh)) return;
      if (lotQuarantined((t, k) => tx.get(t, k), o.code, o.sourceLot)) {
        return tx.error('LOT_QUARANTINED', `ล็อต ${o.sourceLot} ของเศษ ${o.id} ถูกกักกัน – ห้ามใช้`, { field: 'id' });
      }
      const usedFor = util.trim(p.usedFor);
      if (!usedFor) return tx.error('REQUIRED', 'ระบุงาน/แบบที่ใช้เศษนี้', { field: 'usedFor' });
      if (p.remaining != null && !Array.isArray(p.remaining)) return tx.error('BAD_VALUE', 'เศษที่เหลือต้องเป็นรายการ', { field: 'remaining' });
      const pieces = [];
      (p.remaining || []).forEach((r, i) => {
        const where = { line: i + 1 };
        const d = dims(tx, r && r.width, r && r.length, where);
        if (!d) return;
        if (!fitOf(o.width, o.length, d.width, d.length).fit) {
          return tx.error('TOO_BIG', `ชิ้นที่ ${i + 1}: ${d.width} × ${d.length} มม. ใหญ่กว่าเศษ ${o.id} (${o.width} × ${o.length} มม.)`, where);
        }
        const loc = checkLoc(tx, o.wh, (r && r.bin) || o.bin, where);
        if (!loc) return;
        pieces.push(Object.assign(d, { bin: loc.bin, remark: util.trim(r && r.remark) }));
      });
      if (!tx.ok) return;
      const total = round(util.sum(pieces, (x) => x.area), 3);
      if (pieces.length && total >= o.area) {
        return tx.error('TOO_MUCH_AREA', `พื้นที่เศษที่เหลือรวม ${total} ตร.มม. ไม่น้อยกว่าเศษเดิม ${o.area} ตร.มม.`, { field: 'remaining' });
      }
      const children = pieces.map((x) => {
        const cid = tx.nextId('OC');
        tx.put('offcuts', cid, hist({ id: cid, code: o.code, material: o.material, family: o.family, thickness: o.thickness, width: x.width,
          length: x.length, area: x.area, wh: o.wh, bin: x.bin, sourceLot: o.sourceLot, status: 'AVAILABLE', parent: o.id, children: [],
          createdFrom: `ตัดจาก ${o.id} สำหรับ ${usedFor}`, usedFor: '', remark: x.remark, createdBy: tx.userId, createdAt: tx.now,
          usedBy: '', usedAt: '', scrappedBy: '', scrappedAt: '', scrapReason: '', voidedBy: '', voidedAt: '', voidReason: '' },
        tx, 'ADD', `เศษเหลือหลังตัด ${o.id}`));
        return cid;
      });
      tx.put('offcuts', o.id, hist(Object.assign({}, o, { status: 'USED', usedFor, usedBy: tx.userId, usedAt: tx.now, children }),
        tx, 'USE', `ใช้กับ ${usedFor}${children.length ? ' เหลือ ' + children.join(', ') : ''}`));
      tx.result = { id: o.id, children };
      tx.summary = `ใช้เศษ ${o.id} กับ ${usedFor}${children.length ? ' เหลือเศษ ' + children.join(', ') : ''}`;
    },
  });

  define('offcut.scrap', {
    label: 'ทิ้งเศษเหล็ก', perm: 'offcut.manage',
    prepare(tx, p) {
      const o = getOffcut(tx, p.id);
      if (!o) return;
      if (o.status !== 'AVAILABLE') return tx.error('BAD_STATE', `เศษ ${o.id} ${OFFCUT_STATUS[o.status]} – ทิ้งไม่ได้`);
      if (!tx.need('offcut.manage', o.wh)) return;
      const reason = util.trim(p.reason);
      if (!reason) return tx.error('REQUIRED', 'ระบุเหตุผลที่ทิ้ง', { field: 'reason' });
      tx.put('offcuts', o.id, hist(Object.assign({}, o, { status: 'SCRAPPED', scrappedBy: tx.userId, scrappedAt: tx.now, scrapReason: reason }),
        tx, 'SCRAP', reason));
      tx.summary = `ทิ้งเศษ ${o.id}: ${reason}`;
    },
  });

  /** Undo a cut (children must be unused; they become VOID) or a scrap – back to AVAILABLE, history kept. */
  define('offcut.undo', {
    label: 'ยกเลิกการใช้/การทิ้งเศษ', perm: 'offcut.manage',
    prepare(tx, p) {
      const o = getOffcut(tx, p.id);
      if (!o) return;
      if (!tx.need('offcut.manage', o.wh)) return;
      const reason = util.trim(p.reason);
      if (!reason) return tx.error('REQUIRED', 'ระบุเหตุผลการยกเลิก', { field: 'reason' });
      if (o.status === 'USED') {
        if (lotQuarantined((t, k) => tx.get(t, k), o.code, o.sourceLot)) {
          return tx.error('LOT_QUARANTINED', `ล็อต ${o.sourceLot} ถูกกักกัน – คืนเศษเป็นพร้อมใช้ไม่ได้`);
        }
        const kids = (o.children || []).map((c) => tx.get('offcuts', c));
        const busy = kids.filter((c) => !c || c.status !== 'AVAILABLE');
        if (busy.length) return tx.error('BAD_STATE', `เศษที่เหลือ ${busy.map((c) => (c ? c.id + ' ' + OFFCUT_STATUS[c.status] : '?')).join(', ')} – ยกเลิกการตัดไม่ได้ ให้ยกเลิกชิ้นนั้นก่อน`);
        for (const c of kids) {
          tx.put('offcuts', c.id, hist(Object.assign({}, c, { status: 'VOID', voidedBy: tx.userId, voidedAt: tx.now, voidReason: `ยกเลิกการตัด ${o.id}: ${reason}` }),
            tx, 'VOID', `ยกเลิกการตัด ${o.id}`));
        }
        tx.put('offcuts', o.id, hist(Object.assign({}, o, { status: 'AVAILABLE', usedFor: '', usedBy: '', usedAt: '', children: [] }),
          tx, 'UNDO_USE', `ยกเลิกการใช้กับ ${o.usedFor} (${o.usedBy} ${o.usedAt}): ${reason}`));
        tx.summary = `ยกเลิกการใช้เศษ ${o.id}`;
      } else if (o.status === 'SCRAPPED') {
        if (lotQuarantined((t, k) => tx.get(t, k), o.code, o.sourceLot)) {
          return tx.error('LOT_QUARANTINED', `ล็อต ${o.sourceLot} ถูกกักกัน – คืนเศษเป็นพร้อมใช้ไม่ได้`);
        }
        tx.put('offcuts', o.id, hist(Object.assign({}, o, { status: 'AVAILABLE', scrappedBy: '', scrappedAt: '', scrapReason: '' }),
          tx, 'UNDO_SCRAP', `ยกเลิกการทิ้ง (${o.scrappedBy} ${o.scrappedAt} ${o.scrapReason}): ${reason}`));
        tx.summary = `ยกเลิกการทิ้งเศษ ${o.id}`;
      } else {
        return tx.error('BAD_STATE', `เศษ ${o.id} ${OFFCUT_STATUS[o.status]} – ไม่มีอะไรให้ยกเลิก`);
      }
    },
  });

  // ---------------------------------------------------------------------------------------------------------
  // UAT, sign-off, training, pilot issues, daily check
  // ---------------------------------------------------------------------------------------------------------
  define('uat.record', {
    label: 'บันทึกผลทดสอบรับงาน (UAT)', perm: 'uat.record',
    prepare(tx, p) {
      const id = util.normCode(p.id);
      if (!id) return tx.error('REQUIRED', 'ระบุรหัสเกณฑ์ เช่น P1-2', { field: 'id' });
      if (!/^[A-Z0-9][A-Z0-9_.-]*$/.test(id)) return tx.error('BAD_CODE', 'รหัสเกณฑ์ใช้ A-Z 0-9 - _ .', { field: 'id' });
      const known = UAT_CRITERIA.find((c) => c.id === id);
      const prev = tx.get('uat', id);
      let phase;
      let criterion;
      if (known) {
        phase = known.phase;
        criterion = known.criterion;
      } else {
        phase = prev ? prev.phase : util.num(p.phase);
        criterion = (prev && prev.criterion) || util.trim(p.criterion);
        if (!(phase >= 0 && phase <= 6 && Math.floor(phase) === phase)) return tx.error('BAD_VALUE', 'Phase ต้องเป็น 0–6', { field: 'phase' });
        if (!criterion) return tx.error('REQUIRED', 'เกณฑ์ใหม่ต้องระบุข้อความเกณฑ์', { field: 'criterion' });
      }
      const status = String(p.status || '').toUpperCase();
      if (!UAT_STATUS[status]) return tx.error('BAD_VALUE', 'ผลต้องเป็น PASS, FAIL หรือ NOT_RUN', { field: 'status' });
      const evidence = util.trim(p.evidence);
      const note = util.trim(p.note);
      if (status === 'PASS' && evidence.length < 3) return tx.error('REQUIRED', 'ผลผ่านต้องมีหลักฐาน (เลขเอกสาร ไฟล์ หรือชื่อการทดสอบ)', { field: 'evidence' });
      if (status === 'FAIL' && !note && !evidence) return tx.error('REQUIRED', 'ผลไม่ผ่านต้องบอกสิ่งที่พบ', { field: 'note' });
      const history = prev ? (prev.history || []).concat([{ status: prev.status, tester: prev.tester, testedOn: prev.testedOn,
        evidence: prev.evidence, note: prev.note, at: prev.at }]) : [];
      tx.put('uat', id, { id, phase, criterion, status, tester: tx.userId, testedOn: tx.date, evidence, note, at: tx.now, history });
      tx.result.id = id;
      tx.summary = `UAT ${id}: ${UAT_STATUS[status]}`;
    },
  });

  define('uat.signoff', {
    label: 'ลงนามยอมรับยอดและขั้นตอน', perm: 'uat.signoff',
    prepare(tx, p) {
      const area = String(p.area || '').toLowerCase();
      const a = SIGNOFF_AREAS[area];
      if (!a) return tx.error('BAD_VALUE', `ฝ่ายต้องเป็น ${Object.keys(SIGNOFF_AREAS).join(', ')}`, { field: 'area' });
      const roles = (tx.user && tx.user.roles) || [];
      const role = a.roles.find((r) => roles.indexOf(r) >= 0);
      if (!role) return tx.error('NOT_AREA_ROLE', `ผู้ลงนามฝ่าย${a.label} ต้องมีบทบาท ${a.roles.map((r) => auth.ROLES[r]).join(', ')}`, { field: 'area' });
      const decision = String(p.decision || '').toUpperCase();
      if (decision !== 'ACCEPT' && decision !== 'REJECT') return tx.error('BAD_VALUE', 'ผลต้องเป็น ACCEPT หรือ REJECT', { field: 'decision' });
      const note = util.trim(p.note);
      if (decision === 'REJECT' && !note) return tx.error('REQUIRED', 'ไม่ยอมรับต้องระบุเหตุผล', { field: 'note' });
      if (decision === 'ACCEPT') {
        const chk = reports.dailyCheck(tx.state);
        if (!chk.ok) return tx.error('INTEGRITY', `ยอมรับยอดไม่ได้: ตรวจยอดไม่ผ่าน – ${chk.problems.slice(0, 3).join('; ')}`);
        // one person signs for one area only
        const latest = latestSignoffs(tx.all('uat_signoffs'));
        for (const other of Object.keys(latest)) {
          if (other === area || latest[other].decision !== 'ACCEPT') continue;
          if (!tx.different(latest[other].by, `ผู้ลงนามฝ่าย${a.label} (ลงนามฝ่าย${SIGNOFF_AREAS[other].label}แล้ว)`)) return;
        }
      }
      const u = reports.uatSummary(tx.state).totals;
      const id = tx.nextId('SG');
      tx.put('uat_signoffs', id, { id, area, role, decision, note, by: tx.userId, at: tx.now, seq: tx.state.seq,
        uat: { pass: u.pass, fail: u.fail, notRun: u.notRun, total: u.total } });
      tx.result.id = id;
      tx.summary = `ฝ่าย${a.label} ${decision === 'ACCEPT' ? 'ยอมรับ' : 'ไม่ยอมรับ'}ยอดและขั้นตอน`;
    },
  });
  function latestSignoffs(rows) {
    const out = {};
    for (const s of rows) {
      const p = out[s.area];
      if (!p || s.at > p.at || (s.at === p.at && s.id > p.id)) out[s.area] = s;
    }
    return out;
  }

  define('training.record', {
    label: 'บันทึกการอบรมตามบทบาท', perm: 'uat.record',
    prepare(tx, p) {
      const userId = util.normCode(p.userId);
      const u = userId && tx.get('users', userId);
      if (!u) return tx.error('NOT_FOUND', `ไม่พบผู้ใช้ ${p.userId || '(ว่าง)'}`, { field: 'userId' });
      if (!tx.different(userId, 'ผู้อบรม')) return;
      const role = util.trim(p.role);
      if ((u.roles || []).indexOf(role) < 0) return tx.error('BAD_VALUE', `${u.name} ไม่มีบทบาท ${auth.ROLES[role] || role || '(ว่าง)'}`, { field: 'role' });
      const topic = util.trim(p.topic);
      if (!topic) return tx.error('REQUIRED', 'ระบุหัวข้อ/คู่มือที่อบรม', { field: 'topic' });
      const trainedOn = util.trim(p.trainedOn).slice(0, 10) || tx.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trainedOn) || !isFinite(Date.parse(trainedOn))) return tx.error('BAD_VALUE', 'วันที่อบรมไม่ถูกต้อง (YYYY-MM-DD)', { field: 'trainedOn' });
      if (trainedOn > tx.date) return tx.error('BAD_VALUE', 'วันที่อบรมอยู่ในอนาคต', { field: 'trainedOn' });
      const id = tx.nextId('TN');
      tx.put('trainings', id, { id, userId, role, topic, trainedOn, trainer: tx.userId, note: util.trim(p.note), at: tx.now });
      tx.result.id = id;
      tx.summary = `อบรม ${u.name} บทบาท ${auth.ROLES[role] || role}: ${topic}`;
    },
  });

  define('pilot.issue', {
    label: 'บันทึกปัญหาจากการทดลอง', perm: 'uat.record',
    prepare(tx, p) {
      const severity = String(p.severity || '').toUpperCase();
      if (!SEVERITY[severity]) return tx.error('BAD_VALUE', 'ความรุนแรงต้องเป็น CRITICAL, MAJOR หรือ MINOR', { field: 'severity' });
      const description = util.trim(p.description);
      if (description.length < 5) return tx.error('REQUIRED', 'อธิบายปัญหาให้ชัดเจน', { field: 'description' });
      const id = tx.nextId('PI');
      tx.put('pilot_issues', id, { id, severity, area: util.trim(p.area), description, ref: util.trim(p.ref), status: 'OPEN',
        reportedBy: tx.userId, reportedAt: tx.now, resolution: '', resolvedBy: '', resolvedAt: '' });
      tx.result.id = id;
      tx.summary = `ปัญหาทดลอง ${id} (${severity})`;
    },
  });
  define('pilot.resolveIssue', {
    label: 'ปิดปัญหาจากการทดลอง', perm: 'uat.record',
    prepare(tx, p) {
      const it = tx.get('pilot_issues', util.normCode(p.id));
      if (!it) return tx.error('NOT_FOUND', `ไม่พบปัญหา ${p.id || '(ว่าง)'}`, { field: 'id' });
      if (it.status !== 'OPEN') return tx.error('BAD_STATE', `ปัญหา ${it.id} ปิดแล้ว`);
      const resolution = util.trim(p.resolution);
      if (resolution.length < 5) return tx.error('REQUIRED', 'อธิบายวิธีแก้/ผลตรวจซ้ำ', { field: 'resolution' });
      if (it.severity === 'CRITICAL' && !tx.different(it.reportedBy, 'ผู้ปิดปัญหาร้ายแรง')) return;
      tx.put('pilot_issues', it.id, Object.assign({}, it, { status: 'RESOLVED', resolution, resolvedBy: tx.userId, resolvedAt: tx.now }));
      tx.summary = `ปิดปัญหาทดลอง ${it.id}`;
    },
  });

  define('daily.check', {
    label: 'ตรวจยอดประจำวัน', perm: 'uat.record',
    prepare(tx, p) {
      const r = reports.dailyCheck(tx.state);
      const id = tx.nextId('DC');
      const counts = {};
      for (const c of r.checks) counts[c.id] = c.count;
      tx.put('daily_checks', id, { id, date: tx.date, by: tx.userId, at: tx.now, seq: tx.state.seq, ok: r.ok, problems: r.problems.slice(0, 50),
        counts, note: util.trim(p && p.note) });
      tx.result = { id, ok: r.ok, problems: r.problems };
      tx.summary = `ตรวจยอดประจำวัน ${r.ok ? 'ผ่าน' : 'พบปัญหา ' + r.problems.length + ' ข้อ'}`;
    },
  });

  // ---------------------------------------------------------------------------------------------------------
  // backup / restore test, Google Sheet export, data dictionary
  // ---------------------------------------------------------------------------------------------------------
  /** Fingerprint of the data (every table) – equal fingerprints = the same data. */
  reports.fingerprint = function fingerprint(state) {
    return util.sha256(util.stable(tablesOf(state)));
  };

  /**
   * Replay a backup (the commit list, or {commits}) from genesis into a fresh state: checks every hash, seq and prev
   * continuity, then balances = Σ history. opts.compare: a live state to compare with; opts.keepState: return it.
   */
  reports.verifyBackup = function verifyBackup(input, opts) {
    opts = opts || {};
    const problems = [];
    let list = input;
    if (typeof list === 'string') {
      try {
        list = JSON.parse(list);
      } catch (e) {
        list = null;
      }
    }
    if (list && !Array.isArray(list) && Array.isArray(list.commits)) list = list.commits;
    const state = RRS.core.createState();
    if (!Array.isArray(list)) {
      return { ok: false, commits: 0, head: state.head, problems: ['ไฟล์สำรองไม่มีรายการ commit (อ่านไม่ได้หรือผิดรูปแบบ)'], tables: {}, balanceDiffs: [] };
    }
    if (!list.length) problems.push('ไฟล์สำรองว่าง ไม่มี commit');
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c || typeof c !== 'object' || !Array.isArray(c.effects)) {
        problems.push(`รายการที่ ${i + 1} ไม่ใช่ commit`);
        break;
      }
      if (c.seq !== state.seq + 1) {
        problems.push(`commit ลำดับ ${c.seq} ไม่ต่อจากลำดับ ${state.seq} (ขาดช่วง ซ้ำ หรือสลับลำดับ)`);
        break;
      }
      if (c.prev !== state.head) {
        problems.push(`commit ลำดับ ${c.seq} ไม่ได้ต่อจาก commit ก่อนหน้า (คนละประวัติ)`);
        break;
      }
      if (!RRS.core.verifyCommit(c)) {
        problems.push(`commit ลำดับ ${c.seq} ลายนิ้วมือไม่ตรง – ข้อมูลถูกแก้ไข`);
        break;
      }
      try {
        RRS.core.reduce(state, c);
      } catch (e) {
        problems.push(`commit ลำดับ ${c.seq} ใช้ไม่ได้: ${e && e.message}`);
        break;
      }
    }
    const balanceDiffs = RRS.inventory.verifyBalances(state);
    if (balanceDiffs.length) problems.push(`ยอดคงเหลือที่กู้ได้ไม่ตรงกับผลรวมประวัติ ${balanceDiffs.length} ตำแหน่ง`);
    const fp = reports.fingerprint(state);
    if (opts.compare) {
      if (opts.compare.seq !== state.seq) problems.push(`กู้ได้ถึงลำดับ ${state.seq} แต่ระบบจริงอยู่ที่ ${opts.compare.seq}`);
      else if (opts.compare.head !== state.head) problems.push('ลายนิ้วมือ commit สุดท้ายไม่ตรงกับระบบจริง');
      else if (reports.fingerprint(opts.compare) !== fp) problems.push('ข้อมูลที่กู้ได้ไม่ตรงกับระบบจริง');
    }
    const tables = {};
    for (const t of Object.keys(state.tables).sort()) tables[t] = Object.keys(state.tables[t]).length;
    const out = { ok: problems.length === 0, commits: state.seq, head: state.head, fingerprint: fp, problems, tables, balanceDiffs };
    if (opts.keepState) out.state = state;
    return out;
  };

  define('backup.recordTest', {
    label: 'บันทึกผลทดสอบกู้ข้อมูล', perm: 'backup.export',
    prepare(tx, p) {
      const commits = util.num(p.commits);
      if (!(commits >= 0) || Math.floor(commits) !== commits) return tx.error('BAD_VALUE', 'จำนวน commit ต้องเป็นจำนวนเต็มไม่ติดลบ', { field: 'commits' });
      const head = String(p.head || '').toLowerCase();
      if (!HEX64.test(head)) return tx.error('BAD_VALUE', 'ลายนิ้วมือ commit สุดท้ายต้องเป็น SHA-256 (64 ตัวอักษร)', { field: 'head' });
      const result = String(p.result || '').toUpperCase();
      if (result !== 'OK' && result !== 'FAIL') return tx.error('BAD_VALUE', 'ผลต้องเป็น OK หรือ FAIL', { field: 'result' });
      const problems = Array.isArray(p.problems) ? p.problems.map(util.trim).filter(Boolean).slice(0, 20) : [];
      if (result === 'OK' && problems.length) return tx.error('BAD_VALUE', 'ผล OK แต่มีรายการปัญหา – ตรวจผลอีกครั้ง', { field: 'result' });
      const note = util.trim(p.note);
      if (result === 'FAIL' && !note && !problems.length) return tx.error('REQUIRED', 'ผลไม่ผ่านต้องระบุปัญหาที่พบ', { field: 'note' });
      if (commits > tx.state.seq) return tx.error('HEAD_MISMATCH', `ไฟล์สำรองมี ${commits} commit มากกว่าระบบ (${tx.state.seq}) – เป็นข้อมูลของระบบอื่น`, { field: 'commits' });
      if (commits === tx.state.seq && head !== tx.state.head) return tx.error('HEAD_MISMATCH', 'ลายนิ้วมือ commit สุดท้ายไม่ตรงกับระบบที่ลำดับเดียวกัน', { field: 'head' });
      if (commits < tx.state.seq) tx.warn(`ไฟล์สำรองถึงลำดับ ${commits} ระบบอยู่ที่ ${tx.state.seq} – ตรวจลายนิ้วมือย้อนหลังไม่ได้`);
      const fingerprint = String(p.fingerprint || '').toLowerCase();
      if (fingerprint && !HEX64.test(fingerprint)) return tx.error('BAD_VALUE', 'ลายนิ้วมือข้อมูลต้องเป็น SHA-256', { field: 'fingerprint' });
      const id = tx.nextId('BT');
      tx.put('backup_tests', id, { id, at: tx.now, by: tx.userId, commits, head, result, fingerprint, problems, note });
      tx.result.id = id;
      tx.summary = `ทดสอบกู้ข้อมูล ${result} (${commits} commit)`;
    },
  });

  const EXTRA_LABEL = 'ข้อมูลอื่นนอกพจนานุกรม (JSON)';
  function cellOf(v, type, safeText) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object' || type === 'json' || type === 'list') return JSON.stringify(v);
    if (typeof v === 'string' && safeText && (/^[=+@\t\r]/.test(v) || /^-[^\d.]/.test(v))) return "'" + v;
    return v;
  }
  const keyCmp = (a, b) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0);
  /**
   * Every schema table as a Google Sheet tab: {table: [header row (Thai labels), ...rows]}. JSON/list columns are
   * JSON text; fields a row has outside the dictionary go to the last column as JSON (nothing is dropped). Text that a
   * sheet would run as a formula is kept as text with a leading ' (opts.safeText = false to turn it off).
   * opts.header = 'name' puts the field names in the header row instead of the Thai labels.
   */
  reports.exportTables = function exportTables(state, opts) {
    opts = opts || {};
    const safeText = opts.safeText !== false;
    const out = {};
    for (const name of Object.keys(schema.tables)) {
      const tb = schema.tables[name];
      const names = tb.fields.map((f) => f.name);
      const header = (opts.header === 'name' ? names : tb.fields.map((f) => f.label || f.name)).concat([opts.header === 'name' ? '_extra' : EXTRA_LABEL]);
      const tbl = tablesOf(state)[name] || {};
      const rows = Object.keys(tbl).sort(keyCmp).map((k) => {
        const r = tbl[k] || {};
        const vals = tb.fields.map((f) => cellOf(r[f.name], f.type, safeText));
        const extra = {};
        for (const key of Object.keys(r)) if (names.indexOf(key) < 0 && r[key] !== undefined) extra[key] = r[key];
        vals.push(Object.keys(extra).length ? JSON.stringify(extra) : '');
        return vals;
      });
      out[name] = [header].concat(rows);
    }
    return out;
  };
  /** Data dictionary rows {table, label, phase, field, type, fieldLabel, note, key}. */
  reports.dataDictionary = function dataDictionary() {
    const rows = [];
    for (const name of Object.keys(schema.tables)) {
      const tb = schema.tables[name];
      for (const f of tb.fields) {
        rows.push({ table: name, label: tb.label, phase: tb.phase, field: f.name, type: f.type, fieldLabel: f.label, note: f.note || '',
          key: tb.key.indexOf(f.name) >= 0 });
      }
    }
    return rows;
  };

  // ---------------------------------------------------------------------------------------------------------
  // rollout (ขยายผลทีละกลุ่มสินค้า/คลัง)
  // ---------------------------------------------------------------------------------------------------------
  /**
   * Is a rollout ready? q: {rollout | id, today}. Required checks: owner, rollback plan, a recent OK restore test,
   * the daily integrity check, no open CRITICAL pilot issue, UAT of its phases all PASS, store/QC/accounting accepted
   * (different people), the team trained for its roles. KPIs are shown (advisory).
   */
  reports.rolloutReadiness = function rolloutReadiness(state, q) {
    q = q || {};
    const r = q.rollout || G(state, 'rollouts', q.id) || null;
    if (!r) return { ok: false, checks: [], problems: ['ไม่พบแผนขยายผล'] };
    const today = todayOf(state, q);
    const pol = settingsOf(state).policies;
    const users = tablesOf(state).users || {};
    const checks = [];
    const add = (id, label, ok, detail, required) => checks.push({ id, label, ok: !!ok, okLabel: ok ? 'ผ่าน' : required === false ? 'ควรแก้' : 'ไม่ผ่าน',
      detail: detail || '', required: required !== false });
    const owner = users[r.owner];
    add('owner', 'มีผู้รับผิดชอบ', owner && owner.active !== false, owner ? `${owner.name}` : 'ยังไม่ระบุ/ไม่พบผู้ใช้');
    add('rollback', 'มีแผนย้อนกลับ', util.trim(r.rollbackPlan).length >= 10, util.trim(r.rollbackPlan) ? '' : 'ยังไม่มีแผนย้อนกลับ');
    const maxDays = Number(pol.backupTestMaxDays) || DEFAULT_BACKUP_DAYS;
    const bts = T(state, 'backup_tests').sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(b.id).localeCompare(String(a.id)));
    const lastBt = bts[0];
    const btAge = lastBt && today ? util.daysBetween(dateOf(lastBt.at), today) : null;
    add('backup', `ทดสอบกู้ข้อมูลสำเร็จภายใน ${maxDays} วัน`, lastBt && lastBt.result === 'OK' && btAge != null && btAge <= maxDays,
      lastBt ? `${lastBt.id} ${lastBt.result} เมื่อ ${dateOf(lastBt.at)}` : 'ยังไม่เคยทดสอบกู้ข้อมูล');
    const chk = reports.dailyCheck(state);
    add('integrity', 'ตรวจยอดไม่พบข้อผิดพลาดรุนแรง', chk.ok, chk.problems.slice(0, 3).join('; '));
    const crit = T(state, 'pilot_issues').filter((x) => x.status === 'OPEN' && x.severity === 'CRITICAL');
    add('issues', 'ไม่มีปัญหาร้ายแรงค้าง', !crit.length, crit.map((x) => x.id).join(', '));
    const phases = (r.phases && r.phases.length ? r.phases : [0, 1, 2, 3, 4, 5, 6]).map(Number);
    const u = reports.uatSummary(state, { phases });
    const notPass = u.rows.filter((x) => x.status !== 'PASS').map((x) => x.id);
    add('uat', 'ผลทดสอบรับงานผ่านครบ', u.totals.allPass, `${u.totals.pass}/${u.totals.total}${notPass.length ? ' ยังไม่ผ่าน: ' + notPass.slice(0, 8).join(', ') + (notPass.length > 8 ? ' …' : '') : ''}`);
    const latest = latestSignoffs(T(state, 'uat_signoffs'));
    const missing = REQUIRED_SIGNOFFS.filter((a) => !latest[a] || latest[a].decision !== 'ACCEPT');
    const signers = REQUIRED_SIGNOFFS.map((a) => latest[a] && latest[a].by).filter(Boolean);
    const distinct = uniq(signers).length === signers.length;
    add('signoff', 'สโตร์/QC/บัญชียอมรับยอดและขั้นตอน', !missing.length && distinct,
      missing.length ? `ยังไม่ยอมรับ: ${missing.map((a) => SIGNOFF_AREAS[a].label).join(', ')}` : distinct ? signers.join(', ') : 'คนเดียวลงนามหลายฝ่าย');
    const team = r.team || [];
    const trainings = T(state, 'trainings');
    const untrained = [];
    for (const uid of team) {
      const us = users[uid];
      const need = ((us && us.roles) || []).filter((x) => TRAINED_ROLES.indexOf(x) >= 0);
      for (const role of need) if (!trainings.some((t) => t.userId === uid && t.role === role)) untrained.push(`${uid}/${auth.ROLES[role] || role}`);
      if (!us) untrained.push(`${uid} (ไม่พบผู้ใช้)`);
    }
    add('training', 'ทีมได้รับการอบรมตามบทบาท', team.length > 0 && !untrained.length,
      !team.length ? 'ยังไม่ระบุทีม' : untrained.length ? `ยังไม่อบรม: ${untrained.slice(0, 8).join(', ')}` : `${team.length} คน`);
    const k = reports.kpiActuals(state, { today });
    add('kpi', 'ตัวชี้วัดถึงเป้าหมายที่ตกลง (ข้อมูลประกอบ)', k.totals.notMet === 0,
      k.rows.filter((x) => x.met === false).map((x) => x.label).join(', '), false);
    const failed = checks.filter((c) => c.required && !c.ok);
    return { ok: failed.length === 0, checks, problems: failed.map((c) => `${c.label}${c.detail ? ': ' + c.detail : ''}`),
      cols: [C('label', 'เงื่อนไข'), C('okLabel', 'ผล'), C('detail', 'รายละเอียด')] };
  };

  function rolloutOf(tx, id) {
    const r = tx.get('rollouts', util.normCode(id));
    if (!r) tx.error('NOT_FOUND', `ไม่พบแผนขยายผล ${id || '(ว่าง)'}`, { field: 'id' });
    return r;
  }
  function pilotScope(tx, exceptId) {
    const groups = new Set();
    const whs = new Set();
    for (const r of tx.all('rollouts', (x) => x.status === 'APPROVED' && x.id !== exceptId)) {
      for (const g of r.groups || []) groups.add(g);
      for (const w of r.warehouses || []) whs.add(w);
    }
    return { groups, whs };
  }

  define('rollout.propose', {
    label: 'เสนอแผนขยายผล', perm: 'rollout.propose',
    prepare(tx, p) {
      const groups = uniq((p.groups || []).map(util.trim).filter(Boolean));
      const warehouses = uniq((p.warehouses || []).map(util.normCode).filter(Boolean));
      if (!groups.length && !warehouses.length) return tx.error('REQUIRED', 'ระบุกลุ่มสินค้าหรือคลังที่จะขยาย', { field: 'groups' });
      for (const w of warehouses) {
        const row = tx.get('warehouses', w);
        if (!row) return tx.error('NOT_FOUND', `ไม่พบคลัง ${w}`, { field: 'warehouses' });
        if (row.active === false) return tx.error('INACTIVE', `คลัง ${w} ปิดใช้งาน`, { field: 'warehouses' });
      }
      for (const g of groups) if (!tx.all('items', (it) => it.group === g).length) tx.warn(`ยังไม่มีสินค้าในกลุ่ม ${g}`);
      const owner = util.normCode(p.owner);
      const ou = owner && tx.get('users', owner);
      if (!ou) return tx.error('REQUIRED', 'ระบุผู้รับผิดชอบ (ผู้ใช้ในระบบ)', { field: 'owner' });
      if (ou.active === false) return tx.error('INACTIVE', `ผู้ใช้ ${owner} ถูกปิดการใช้งาน`, { field: 'owner' });
      const team = uniq((p.team || []).map(util.normCode).filter(Boolean));
      if (!team.length) return tx.error('REQUIRED', 'ระบุผู้ใช้งานในขอบเขต (ทีม)', { field: 'team' });
      for (const u of team) if (!tx.get('users', u)) return tx.error('NOT_FOUND', `ไม่พบผู้ใช้ ${u}`, { field: 'team' });
      const rollbackPlan = util.trim(p.rollbackPlan);
      if (rollbackPlan.length < 10) return tx.error('REQUIRED', 'ระบุแผนย้อนกลับ (ปิดสวิตช์ กู้ข้อมูลจากสำรอง เอกสารที่ต้องคีย์ซ้ำ)', { field: 'rollbackPlan' });
      const phases = p.phases && p.phases.length ? uniq(p.phases.map(Number)).sort() : [0, 1, 2, 3, 4, 5, 6];
      if (phases.some((x) => !(x >= 0 && x <= 6 && Math.floor(x) === x))) return tx.error('BAD_VALUE', 'Phase ต้องเป็น 0–6', { field: 'phases' });
      const id = tx.nextId('RO');
      const title = util.trim(p.title) || `ขยายผล ${groups.concat(warehouses).join(', ')}`;
      tx.put('rollouts', id, hist({ id, title, groups, warehouses, owner, team, rollbackPlan, phases, status: 'PROPOSED',
        proposedBy: tx.userId, proposedAt: tx.now, approvedBy: '', approvedAt: '', readiness: null, rejectedBy: '', rejectedAt: '',
        rejectReason: '', rolledBackBy: '', rolledBackAt: '', rollbackReason: '' }, tx, 'PROPOSE', title));
      tx.result.id = id;
      tx.summary = `เสนอแผนขยายผล ${id}: ${title}`;
    },
  });

  define('rollout.approve', {
    label: 'อนุมัติแผนขยายผล', perm: 'rollout.approve',
    prepare(tx, p) {
      const r = rolloutOf(tx, p.id);
      if (!r) return;
      if (r.status !== 'PROPOSED') return tx.error('BAD_STATE', `แผน ${r.id} ${ROLLOUT_STATUS[r.status]}`);
      if (!tx.different(r.proposedBy, 'ผู้อนุมัติขยายผล')) return;
      const ready = reports.rolloutReadiness(tx.state, { rollout: r, today: tx.date });
      if (!ready.ok) return tx.error('NOT_READY', `ยังไม่พร้อมขยายผล: ${ready.problems.join(' | ')}`);
      const st = util.clone(tx.settings());
      st.pilot = Object.assign({ groups: [], warehouses: [], note: '' }, st.pilot || {});
      st.pilot.groups = uniq((st.pilot.groups || []).concat(r.groups || []));
      st.pilot.warehouses = uniq((st.pilot.warehouses || []).concat(r.warehouses || []));
      st.id = 'main';
      tx.put('settings', 'main', st);
      tx.put('rollouts', r.id, hist(Object.assign({}, r, { status: 'APPROVED', approvedBy: tx.userId, approvedAt: tx.now,
        readiness: ready.checks.map((c) => ({ id: c.id, ok: c.ok, detail: c.detail })) }), tx, 'APPROVE', ''));
      tx.summary = `อนุมัติขยายผล ${r.id}`;
    },
  });
  define('rollout.reject', {
    label: 'ไม่อนุมัติแผนขยายผล', perm: 'rollout.approve',
    prepare(tx, p) {
      const r = rolloutOf(tx, p.id);
      if (!r) return;
      if (r.status !== 'PROPOSED') return tx.error('BAD_STATE', `แผน ${r.id} ${ROLLOUT_STATUS[r.status]}`);
      const reason = util.trim(p.reason);
      if (!reason) return tx.error('REQUIRED', 'ระบุเหตุผล', { field: 'reason' });
      tx.put('rollouts', r.id, hist(Object.assign({}, r, { status: 'REJECTED', rejectedBy: tx.userId, rejectedAt: tx.now, rejectReason: reason }),
        tx, 'REJECT', reason));
      tx.summary = `ไม่อนุมัติแผนขยายผล ${r.id}`;
    },
  });
  /** Roll an approved rollout back: its scope leaves settings.pilot unless another approved rollout covers it. */
  define('rollout.rollback', {
    label: 'ย้อนกลับการขยายผล', perm: 'rollout.approve',
    prepare(tx, p) {
      const r = rolloutOf(tx, p.id);
      if (!r) return;
      if (r.status !== 'APPROVED') return tx.error('BAD_STATE', `แผน ${r.id} ${ROLLOUT_STATUS[r.status]} – ย้อนกลับได้เฉพาะแผนที่อนุมัติแล้ว`);
      const reason = util.trim(p.reason);
      if (!reason) return tx.error('REQUIRED', 'ระบุเหตุผลการย้อนกลับ', { field: 'reason' });
      const keep = pilotScope(tx, r.id);
      const st = util.clone(tx.settings());
      st.pilot = Object.assign({ groups: [], warehouses: [], note: '' }, st.pilot || {});
      st.pilot.groups = (st.pilot.groups || []).filter((g) => (r.groups || []).indexOf(g) < 0 || keep.groups.has(g));
      st.pilot.warehouses = (st.pilot.warehouses || []).filter((w) => (r.warehouses || []).indexOf(w) < 0 || keep.whs.has(w));
      st.id = 'main';
      tx.put('settings', 'main', st);
      tx.put('rollouts', r.id, hist(Object.assign({}, r, { status: 'ROLLED_BACK', rolledBackBy: tx.userId, rolledBackAt: tx.now, rollbackReason: reason }),
        tx, 'ROLLBACK', reason));
      tx.summary = `ย้อนกลับการขยายผล ${r.id}`;
    },
  });

  /** Report menu for the screens. */
  reports.LIST = [
    { id: 'stockByLocation', label: 'ยอดตามคลัง/ช่องเก็บ/สถานะ' },
    { id: 'shortageExcess', label: 'ของขาด / ต่ำกว่า Min / เกิน Max' },
    { id: 'nonMoving', label: 'ของไม่เคลื่อนไหว' },
    { id: 'aging', label: 'อายุสต็อก' },
    { id: 'countAccuracy', label: 'ความแม่นยำการนับ' },
    { id: 'qcPending', label: 'งานรอ QC' },
    { id: 'fpy', label: 'ผ่าน QC ครั้งแรก (FPY)' },
    { id: 'qcWait', label: 'เวลารอ QC' },
    { id: 'repeatIssues', label: 'ปัญหาซ้ำ (NCR)' },
    { id: 'kpiActuals', label: 'ตัวชี้วัดเทียบเป้าหมาย' },
    { id: 'dailyCheck', label: 'ตรวจยอดประจำวัน' },
  ];
})(typeof globalThis !== 'undefined' ? globalThis : this);
