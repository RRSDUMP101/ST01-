/*
 * Phase 6 – คู่มือตามบทบาท. One section per role (store, store lead, planner, production, engineering, purchasing,
 * accounting, QC, QC lead, manager, admin) with the daily steps in this app and links to the pages that do them, what the
 * role may do (from RRS.auth.PERMS – the engine's own list), and who has been trained on it (training.record).
 * 'เมื่อเกิดปัญหา': the common errors in plain words with what to do, plus every engine error code
 * (RRS.reports.ERROR_GUIDE) with a search.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const U = RRS.util;

  const low = (s) => String(s == null ? '' : s).toLowerCase();
  /** Link to a page when it exists here (other screens may not be loaded in every build). */
  const go = (label, page, view) => (RRS.ui.pages[page] ? h.link(label, page, view) : t`<span class="muted">${label} (หน้าจอยังไม่เปิดใช้)</span>`);

  // [title, what to do, [[link label, page id, view?], …]]
  const GUIDE = [
    { roles: ['store'], title: 'สโตร์', duty: 'รับ เก็บ หยิบ จ่าย และนับของจริง ให้ยอดในระบบตรงกับของบนชั้น', steps: [
      ['เริ่มวัน', 'เปิดหน้าภาพรวม ดูงานที่รอคุณ: ของรอรับตาม PO ใบงานที่ต้องหยิบ ใบโอนที่รอรับ', [['ภาพรวม', 'home']]],
      ['รับของตาม PO', 'เลือก PO นับจำนวนจริง ใส่คลัง ช่องเก็บ ล็อต/Heat และเลขใบรับรองวัสดุ (ถ้ามี) · ของที่ต้องตรวจรับเข้ายอด "รอตรวจ" ยังเบิกไม่ได้จนกว่า QC ปล่อยผ่าน', [['รับของตาม PO', 'purchasing', { tab: 'recv' }]]],
      ['หยิบของให้งานผลิต', 'เลือกใบงาน ระบบบอกว่าหยิบจากช่องไหน สแกนหรือพิมพ์รหัสบนชิ้นงาน (ข้างต้องตรง) แล้วบันทึกครั้งเดียวทั้งใบ', [['ใบจัดชุดและหยิบของ', 'picking']]],
      ['เบิก รับคืน โอน อื่น ๆ', 'สร้างร่างเอกสาร กด ตรวจก่อนบันทึก แล้วกด บันทึก (เปลี่ยนยอด) – บรรทัดผิดบรรทัดเดียว ระบบไม่บันทึกทั้งใบ · ใบโอนต้องกด รับโอน ที่ปลายทาง', [['เอกสารรับ–จ่าย–โอน', 'docs'], ['ใบโอนที่รอรับ', 'docs', { tab: 'transit' }]]],
      ['ดูยอดก่อนจ่าย', 'ดูยอด ใช้ได้ / รอตรวจ / กักกัน แยกตามคลังและช่องเก็บ · ของรอตรวจและกักกันอยู่ในคลังแต่เบิกไม่ได้', [['ยอดคงเหลือ', 'stock'], ['ประวัติเคลื่อนไหว', 'history']]],
      ['ตรวจนับ', 'เปิดรอบนับที่หัวหน้าสโตร์สร้าง นับของจริงทีละบรรทัด (สินค้า + ช่องเก็บ + ล็อต) ระบบไม่แสดงยอดในระบบให้ผู้นับเห็น', [['ตรวจนับ', 'counts']]],
      ['เศษเหล็ก', 'ชิ้นที่เหลือจากการตัดที่ยังใช้ได้ ให้บันทึกขนาดและที่เก็บ แล้วเขียนรหัส OC-… บนชิ้น', [['เศษเหล็กใช้ซ้ำ', 'offcuts']]],
    ] },
    { roles: ['store_lead'], title: 'หัวหน้าสโตร์', duty: 'ดูแลความถูกต้องของยอด อนุมัติข้อยกเว้น ยกเลิกเอกสารที่ผิด และควบคุมการนับ', steps: [
      ['เอกสารรออนุมัติ', 'ข้อยกเว้นยอดติดลบที่สโตร์ขอ – ตรวจเหตุผลแล้วอนุมัติหรือส่งกลับ (อนุมัติคำขอของตัวเองไม่ได้)', [['รออนุมัติ', 'docs', { tab: 'wait' }]]],
      ['แก้เอกสารที่บันทึกผิด', 'เปิดเอกสาร กด ยกเลิกเอกสาร พร้อมเหตุผล ระบบกลับรายการทุกบรรทัด ประวัติเดิมยังอยู่ แล้วทำเอกสารใหม่ที่ถูก', [['เอกสารรับ–จ่าย–โอน', 'docs']]],
      ['เปิดรอบนับและอนุมัติผลนับ', 'เลือกคลัง/ช่องเก็บและวิธีนับ ยอดที่ต่างเกินเกณฑ์ต้องให้อีกคนนับซ้ำ ยอดต่างต้องมีคำอธิบายก่อนอนุมัติ', [['ตรวจนับ', 'counts']]],
      ['ข้อมูลหลัก', 'รหัสสินค้าใหม่ หน่วยและตัวคูณ คลังและช่องเก็บ ต้องเพิ่มก่อนรับของ – ระบบไม่จับคู่รหัสจากชื่อให้เอง', [['ทะเบียนสินค้า', 'items'], ['คลังและช่องเก็บ', 'warehouses']]],
      ['กระทบยอดกับ Express', 'นำเข้าไฟล์รายงานสต็อกจาก Express ร่วมกับบัญชี แล้วอธิบายยอดต่างทีละรายการ', [['นำเข้าและกระทบยอด Express', 'express']]],
      ['ตรวจยอดประจำวัน', 'ทุกเย็นระหว่างทดลองใช้: เปิดรายงานตรวจยอดประจำวัน ถ้าผ่านกด บันทึกผลตรวจวันนี้ ถ้าไม่ผ่านแจ้งบัญชีทันที', [['ตรวจยอดประจำวัน', 'reports', { tab: 'dailyCheck' }]]],
      ['ผลทดสอบรับงาน', 'ลองตามเกณฑ์ของ Phase ที่ดูแลกับงานจริง แล้วบันทึกผลพร้อมหลักฐาน', [['ทดสอบรับงาน (UAT)', 'uat']]],
    ] },
    { roles: ['planner'], title: 'วางแผนผลิต', duty: 'เปิดงาน จองของให้งาน ดูความพร้อม และแจ้งของที่ต้องซื้อ', steps: [
      ['เปิดงาน/SO', 'สร้างงานจากสินค้าที่มี BOM อนุมัติ × จำนวนชุด · งานจาก Sales Office ต้องจับคู่กับ BOM ก่อน ระบบไม่เดาจากชื่อสินค้า', [['งาน/SO และการจอง', 'jobs']]],
      ['จองของให้งาน', 'จองได้ไม่เกินยอดพร้อมใช้ (ของรอตรวจและของที่ยังไม่มาจองไม่ได้) · ยกเลิกงานแล้วระบบคืนยอดจองให้', [['งาน/SO และการจอง', 'jobs']]],
      ['ดูความพร้อมผลิต', 'สต็อก 6 ช่อง: มีจริง รอตรวจ/กักกัน จองแล้ว พร้อมเบิก กำลังผลิต จะเข้า เทียบกับที่งานต้องใช้ – งานไหนขาดอะไร', [['สต็อก 6 ช่อง และความพร้อมผลิต', 'readiness']]],
      ['ของขาด', 'เปิดแผนเติมสต็อก เลือกรายการที่ต้องสั่ง แล้วสร้างใบขอซื้อ – ระบบหักของค้างรับที่มาทันแล้ว', [['แผนเติมสต็อก', 'replenish'], ['รายงานของขาด/เกิน', 'reports', { tab: 'shortageExcess' }]]],
      ['บันทึกผลิตเสร็จ', 'บันทึกจำนวนที่ผลิตเสร็จในใบงาน · ของที่ต้องตรวจเข้ายอด "รอตรวจ" – ผลิตเสร็จยังไม่เท่ากับผ่าน QC', [['งาน/SO และการจอง', 'jobs']]],
    ] },
    { roles: ['production'], title: 'ฝ่ายผลิต', duty: 'ใช้ของตามใบงาน แจ้งผลิตเสร็จ และใช้เศษเหล็กก่อนตัดแผ่นใหม่', steps: [
      ['ดูงานและของที่จองไว้', 'ดูว่างานที่จะทำมีของพร้อมเบิกครบหรือยัง', [['สต็อก 6 ช่อง และความพร้อมผลิต', 'readiness', { tab: 'jobs' }], ['งาน/SO และการจอง', 'jobs']]],
      ['ขอเบิกของ', 'แจ้งสโตร์หยิบตามใบจัดชุด หรือสร้างร่างใบเบิก – ร่างยังไม่ตัดยอดจนสโตร์ตรวจและบันทึก', [['ใบจัดชุดและหยิบของ', 'picking'], ['เอกสารรับ–จ่าย–โอน', 'docs']]],
      ['ก่อนตัดแผ่นใหม่', 'กรอกวัสดุ ความหนา และขนาดที่ต้องตัด ระบบแนะนำเศษชิ้นเล็กสุดที่พอดี ใช้แล้วบันทึกชิ้นที่เหลือ (ได้รหัสใหม่ไว้เขียนบนชิ้น)', [['หาเศษที่ใช้ได้', 'offcuts', { tab: 'find' }]]],
      ['บันทึกผลิตเสร็จ', 'แจ้งจำนวนที่เสร็จในใบงาน ของที่ต้องตรวจยังส่งมอบไม่ได้จนกว่า QC ปล่อยผ่าน', [['งาน/SO และการจอง', 'jobs']]],
      ['ของเหลือคืนสโตร์', 'ของที่เบิกเกินหรือไม่ได้ใช้ ให้สโตร์รับคืน (RT) อ้างใบงานเดิม พร้อมเหตุผล', [['ใบจัดชุดและหยิบของ', 'picking']]],
    ] },
    { roles: ['engineering'], title: 'วิศวกรรม', duty: 'ดูแลรหัส แบบ BOM และแผนตรวจ ให้ตรงกับฉบับแบบที่อนุมัติ', steps: [
      ['BOM และฉบับแบบ', 'ทำร่าง BOM ต่อสินค้า 1 หน่วย แล้วอนุมัติ · ฉบับที่อนุมัติแก้ไม่ได้ ต้องสร้างฉบับใหม่ ฉบับเดิมเลิกใช้อัตโนมัติ', [['BOM และฉบับแบบ', 'boms']]],
      ['ทะเบียนสินค้า', 'รหัส รุ่น/ข้าง เลขที่แบบ วัสดุ ความหนา ขนาดแผ่น และการติดตามล็อต/Heat', [['ทะเบียนสินค้า', 'items']]],
      ['แผนตรวจ QC', 'ทำร่างแผนตรวจที่ผูกกับฉบับแบบที่อนุมัติ แล้วให้อีกคนอนุมัติ', [['แผนการตรวจ QC', 'qc-plans']]],
      ['ตัดสิน NCR', 'ร่วมกับหัวหน้า QC: แก้ไข คืนผู้ขาย ตัดทิ้ง พร้อมเหตุผล', [['NCR', 'ncrs']]],
      ['ปัญหาซ้ำ', 'ดูรหัสที่ข้อบกพร่องเดิมเกิดซ้ำ เพื่อแก้ที่แบบหรือวิธีทำ', [['รายงานปัญหาซ้ำ', 'reports', { tab: 'repeatIssues' }]]],
    ] },
    { roles: ['purchasing', 'purchasing_lead'], title: 'จัดซื้อ / หัวหน้าจัดซื้อ', duty: 'ซื้อของให้ทันงาน ตามเงื่อนไขที่ตกลงกับผู้ขาย', steps: [
      ['เงื่อนไขซื้อ', 'ราคาต่อหน่วยซื้อ ตัวคูณ MOQ แพ็ก และเวลาส่งของของแต่ละผู้ขาย – แผนเติมสต็อกปัดจำนวนตามนี้', [['ผู้ขายและเงื่อนไขซื้อ', 'suppliers']]],
      ['ดูของที่ต้องสั่ง', 'แผนเติมสต็อกบอกว่าสั่งอะไร เท่าไร เพราะอะไร แล้วสร้างใบขอซื้อได้ทันที', [['แผนเติมสต็อก', 'replenish']]],
      ['ใบขอซื้อ → ใบสั่งซื้อ', 'ใบขอซื้อต้องให้หัวหน้าจัดซื้อหรือผู้บริหารอนุมัติ (คนละคนกับผู้ขอ) แล้วออก PO จากใบที่อนุมัติ', [['ขอซื้อ (PR)', 'purchasing', { tab: 'pr' }], ['สั่งซื้อ (PO)', 'purchasing', { tab: 'po' }]]],
      ['ติดตามของค้างรับ', 'PO ที่เลยกำหนดส่ง และงานที่รอของนั้น – เลื่อนวันส่งหรือยกเลิกบรรทัดพร้อมเหตุผล', [['สั่งซื้อ (PO)', 'purchasing', { tab: 'po' }], ['ภาพรวม', 'home']]],
      ['ของไม่ผ่าน QC', 'ของที่ตัดสินคืนผู้ขายจะมีใบคืน (RV) – ประสานผู้ขายรับคืนหรือส่งทดแทน', [['คืนผู้ขาย', 'purchasing', { tab: 'rv' }], ['NCR', 'ncrs']]],
    ] },
    { roles: ['accounting'], title: 'บัญชี', duty: 'กระทบยอดกับ Express ซึ่งเป็นยอดทางบัญชี และยืนยันว่ากู้ข้อมูลได้', steps: [
      ['นำเข้าไฟล์ Express', 'เลือกไฟล์รายงานสต็อกจาก Express ใส่เวลาของข้อมูลในไฟล์ (ระบบเทียบยอด ณ เวลานั้น) · ไฟล์เดิมนำเข้าซ้ำไม่ได้', [['นำเข้าไฟล์ใหม่', 'express', { tab: 'import' }]]],
      ['กระทบยอด', 'ดูยอดต่างระหว่าง Express กับระบบ อธิบายสาเหตุ หรือปรับยอดเมื่อพิสูจน์แล้ว', [['รอบนำเข้า', 'express', { tab: 'batches' }]]],
      ['เอกสารรอคีย์ Express', 'เอกสารที่สโตร์บันทึกแล้วแต่ยังไม่มีใน Express – คีย์ใน Express แล้วบันทึกเลขที่ให้ตรงกัน', [['รอคีย์ Express', 'docs', { tab: 'express' }]]],
      ['อนุมัติผลนับและข้อยกเว้น', 'อนุมัติผลนับร่วมกับหัวหน้าสโตร์ และข้อยกเว้นยอดติดลบ (ต้องเป็นคนละคนกับผู้ขอ)', [['ตรวจนับ', 'counts'], ['รออนุมัติ', 'docs', { tab: 'wait' }]]],
      ['รายงานยอดและมูลค่า', 'ยอดตามคลังพร้อมมูลค่าอ้างอิง – มูลค่าทางบัญชียึดตามข้อตกลงกับ Express', [['ยอดตามคลัง', 'reports', { tab: 'stockByLocation' }], ['ของไม่เคลื่อนไหว', 'reports', { tab: 'nonMoving' }]]],
      ['สำรองและทดสอบกู้คืน', 'ดาวน์โหลดไฟล์สำรองอย่างน้อยสัปดาห์ละครั้ง ตรวจว่าไฟล์ใช้กู้ได้ แล้วบันทึกผล', [['สำรองและกู้คืน', 'backup']]],
    ] },
    { roles: ['qc'], title: 'QC ผู้ตรวจ', duty: 'ตรวจของตามแผนที่อนุมัติ บันทึกค่าที่วัดและหลักฐาน', steps: [
      ['คิวตรวจ', 'ของรอตรวจ กักกัน และรอแก้ไข เรียงตามเวลาที่รอ – เริ่มตรวจจากแถวนั้น', [['คิวตรวจ', 'inspections', { tab: 'queue' }]]],
      ['บันทึกผลตรวจ', 'ใช้แผนตรวจที่อนุมัติของสินค้าและขั้นตอนนั้น กรอกค่าที่วัดทุกข้อ แนบรูป · ผู้ตรวจต้องไม่ใช่ผู้บันทึกรับเข้า', [['ตรวจ QC และปล่อยผ่าน', 'inspections']]],
      ['ไม่ผ่าน', 'ระบบเปิด NCR และกักกันของให้เอง – เขียนข้อบกพร่องให้ชัดเพื่อให้ตัดสินได้', [['NCR', 'ncrs']]],
      ['ใบรับรองวัสดุ', 'ตรวจใบรับรองที่สโตร์บันทึกกับเลข Heat บนแผ่นจริง (คนบันทึกกับคนตรวจต้องเป็นคนละคน)', [['ล็อต/Heat', 'lots']]],
      ['สงสัยทั้งล็อต', 'กักกันทั้งล็อต ระบบบล็อกการเบิก โอน และส่งมอบของล็อตนั้นทุกคลัง', [['ล็อต/Heat', 'lots']]],
    ] },
    { roles: ['qc_lead'], title: 'หัวหน้า QC', duty: 'ปล่อยผ่าน ตัดสิน NCR และดูแลแผนตรวจ', steps: [
      ['รอปล่อยผ่าน', 'ผลตรวจที่ผ่านแล้วรอการปล่อย – ปล่อยได้เมื่อคุณไม่ใช่ผู้ตรวจหรือผู้บันทึกรับเข้า และใบรับรองตรวจแล้ว', [['รอปล่อยผ่าน', 'inspections', { tab: 'release' }]]],
      ['ตัดสิน NCR', 'แก้ไขงาน / คืนผู้ขาย / ตัดทิ้ง / ยอมรับแบบมีเงื่อนไข พร้อมเหตุผล – ระบบออกเอกสารที่เกี่ยวข้องให้', [['NCR รอตัดสิน', 'ncrs', { tab: 'open' }]]],
      ['ปลดกักกันล็อต', 'เมื่อพิสูจน์แล้ว ปลดกักกัน ของกลับไปเป็น "รอตรวจ" ไม่ใช่ใช้ได้ทันที', [['ล็อต/Heat', 'lots']]],
      ['อนุมัติแผนตรวจ', 'แผนที่วิศวกรรม/QC ทำร่างไว้ (อนุมัติร่างของตัวเองไม่ได้)', [['แผนการตรวจ QC', 'qc-plans']]],
      ['ดูผลคุณภาพ', 'งานรอ QC, ผ่าน QC ครั้งแรก, เวลารอ QC และปัญหาซ้ำ', [['งานรอ QC', 'reports', { tab: 'qcPending' }], ['FPY', 'reports', { tab: 'fpy' }]]],
    ] },
    { roles: ['manager'], title: 'ผู้บริหาร / เจ้าของโครงการ', duty: 'ตัดสินข้อตกลง ดูผลเทียบเป้า และอนุมัติก่อนขยายหรือหยุดใช้', steps: [
      ['ภาพรวม', 'ความคืบหน้าแต่ละ Phase และงานที่ค้าง', [['ภาพรวม', 'home']]],
      ['ข้อตกลงและนโยบาย', 'ตัดสินข้อตกลง ค-1…ค-11 ขอบเขตทดลอง นโยบายยอดติดลบ และตั้งเป้าหมายตัวชี้วัด', [['ขอบเขต นโยบาย และข้อตกลง', 'setup'], ['ตัวชี้วัดตั้งต้น', 'setup', { tab: 'kpis' }]]],
      ['อนุมัติใบขอซื้อ', 'ใบขอซื้อที่รออนุมัติ (อนุมัติคำขอของตัวเองไม่ได้)', [['ขอซื้อ (PR)', 'purchasing', { tab: 'pr' }]]],
      ['ผลเทียบเป้าหมาย', 'ตัวชี้วัดจริงเทียบค่าก่อนเริ่มและเป้าหมายที่ตกลงใน Phase 0', [['ตัวชี้วัดเทียบเป้าหมาย', 'reports', { tab: 'kpiActuals' }]]],
      ['ก่อนขยายผล', 'ผลทดสอบรับงานผ่านครบ ทดสอบกู้คืนผ่าน ตรวจยอดประจำวันผ่าน และมีแผนย้อนกลับ', [['ทดสอบรับงาน (UAT)', 'uat'], ['สำรองและกู้คืน', 'backup']]],
    ] },
    { roles: ['admin'], title: 'ผู้ดูแลระบบ', duty: 'ดูแลผู้ใช้ สิทธิ์ และความปลอดภัยของข้อมูล', steps: [
      ['ผู้ใช้และสิทธิ์', 'ให้ทุกคนมีผู้ใช้ของตัวเอง (ห้ามใช้ร่วมกัน) เลือกบทบาทตามหน้าที่ และจำกัดคลังได้', [['ผู้ใช้', 'users', { tab: 'users' }], ['สิทธิ์ตามบทบาท', 'users', { tab: 'matrix' }]]],
      ['คำขอใช้งาน', 'คนที่เปิดระบบแล้วยังไม่มีสิทธิ์จะส่งคำขอ – เพิ่มผู้ใช้ตามหน้าที่จริง', [['คำขอใช้งาน', 'users', { tab: 'requests' }]]],
      ['ตรวจความถูกต้องของข้อมูล', 'บันทึกการทำรายการทุกครั้งต่อกันเป็นสาย ตรวจได้ว่ามีการแก้ข้อมูลนอกระบบหรือไม่', [['บันทึกการทำรายการ', 'audit']]],
      ['สำรองข้อมูล', 'ดูสถานะสำรองไป Google Drive (เมื่อใช้เซิร์ฟเวอร์) และผลทดสอบกู้คืน', [['สำรองและกู้คืน', 'backup']]],
      ['ข้อควรระวัง', 'ผู้ดูแลระบบทำได้ทุกคำสั่ง แต่การแยกหน้าที่ยังใช้ (อนุมัติงานที่ตัวเองทำไม่ได้) – ใช้ผู้ใช้ผู้ดูแลเฉพาะงานดูแลระบบ', [['พจนานุกรมข้อมูล', 'dictionary']]],
    ] },
  ];

  /** Common problems in plain words (codes link to the engine's error manual). */
  const PROBLEMS = [
    { title: 'ยอดไม่พอ / ยอดจะติดลบ', codes: ['NOT_ENOUGH', 'NEGATIVE'], see: 'ระบบไม่บันทึกเพราะยอดที่คลัง ช่องเก็บ ล็อต หรือสถานะที่เลือก น้อยกว่าที่ขอ',
      todo: 'ตรวจคลัง/ช่องเก็บ/ล็อตที่เลือกกับหน้า ยอดคงเหลือ · ของมีจริงแต่ยังไม่ลงระบบ ให้บันทึกรับเข้าก่อน · ถ้านโยบายอนุญาต ขออนุมัติข้อยกเว้นยอดติดลบ ให้หัวหน้าสโตร์หรือบัญชีอีกคนอนุมัติ', links: [['ยอดคงเหลือ', 'stock'], ['รออนุมัติ', 'docs', { tab: 'wait' }]] },
    { title: 'ของถูกจองให้งานอื่น', codes: ['RESERVED'], see: 'ของใช้ได้มีพอ แต่จองไว้ให้ใบงานอื่นแล้ว',
      todo: 'เบิกโดยอ้างใบงานหรือใบจองของงานตัวเอง หรือให้ฝ่ายวางแผนปรับการจอง', links: [['งาน/SO และการจอง', 'jobs']] },
    { title: 'ล็อตถูกกัก / ของยังไม่ผ่าน QC', codes: ['BAD_STATUS', 'LOT_QUARANTINED'], see: 'ของรอตรวจ กักกัน หรือรอแก้ไข เบิก โอน หรือส่งมอบไม่ได้ · ล็อตที่ถูกกักกันถูกบล็อกทุกคลัง',
      todo: 'ให้ QC ตรวจและหัวหน้า QC ปล่อยผ่านก่อน หรือดำเนินการตาม NCR · ของล็อตกักกันออกได้ทางเดียวคือตัดทิ้งหรือคืนผู้ขายตาม NCR · ปลดกักกันแล้วของกลับเป็นรอตรวจ', links: [['คิวตรวจ', 'inspections', { tab: 'queue' }], ['ล็อต/Heat', 'lots'], ['NCR', 'ncrs']] },
    { title: 'ผู้อนุมัติต้องเป็นคนอื่น', codes: ['SAME_PERSON'], see: 'คนขอ คนตรวจ หรือคนนับ อนุมัติหรือปล่อยผ่านงานของตัวเองไม่ได้ (แยกหน้าที่)',
      todo: 'ให้ผู้มีสิทธิ์อีกคนอนุมัติ · ถ้าวันนั้นไม่มีใคร ให้ผู้บริหารกำหนดผู้อนุมัติสำรองในหน้าผู้ใช้และสิทธิ์ – อย่ายืมผู้ใช้ของคนอื่น', links: [['สิทธิ์ตามบทบาท', 'users', { tab: 'matrix' }]] },
    { title: 'ไฟล์ Express ซ้ำ / ไฟล์เก่ากว่า', codes: ['DUPLICATE_FILE', 'OLD_SNAPSHOT'], see: 'ระบบจำลายนิ้วมือของไฟล์ที่นำเข้าแล้ว ไฟล์เดิมนำเข้าซ้ำไม่ได้ · ไฟล์ที่เวลาข้อมูลเก่ากว่ารอบล่าสุดไม่ทับยอดใหม่เอง',
      todo: 'ไม่ต้องนำเข้าซ้ำ – เปิดรอบนำเข้าเดิมดูผล · ถ้าต้องการยอดใหม่ ให้ออกรายงานจาก Express ใหม่แล้วนำเข้าไฟล์ใหม่ · ไฟล์เก่าต้องยืนยันก่อนปรับยอด', links: [['รอบนำเข้า', 'express', { tab: 'batches' }]] },
    { title: 'ยกเลิกเอกสารไม่ได้', codes: ['CANNOT_REVERSE', 'ALREADY_CANCELLED', 'BAD_STATE'], see: 'ของที่รับเข้าด้วยเอกสารนั้นถูกเบิกหรือย้ายไปแล้ว ยอดไม่พอให้กลับรายการ หรือเอกสารยกเลิกไปแล้ว',
      todo: 'ทำเอกสารแก้ไขแทน เช่น ใบรับคืน (RT) หรือใบปรับยอด (AJ) พร้อมเหตุผลที่อ้างเอกสารเดิม · เอกสารที่ยกเลิกแล้วไม่ต้องยกเลิกซ้ำ ดูประวัติได้', links: [['เอกสารรับ–จ่าย–โอน', 'docs'], ['ประวัติเคลื่อนไหว', 'history']] },
    { title: 'ไม่พบรหัส / รหัสซ้ำ', codes: ['NOT_FOUND', 'CODE_CLASH'], see: 'รหัสสินค้า คลัง หรือช่องเก็บไม่มีในระบบ หรืออ่านแล้วเหมือนรหัสอื่น',
      todo: 'ตรวจการสะกด ใช้รหัสหลัก รหัส Express หรือรหัสนับสต็อกได้ – ระบบไม่จับคู่จากชื่อให้เอง · รหัสใหม่ให้หัวหน้าสโตร์หรือวิศวกรรมเพิ่มในทะเบียนสินค้าก่อน', links: [['ทะเบียนสินค้า', 'items'], ['คลังและช่องเก็บ', 'warehouses']] },
    { title: 'ต้องระบุล็อต/Heat หรือช่องเก็บ', codes: ['LOT_REQUIRED', 'BIN_REQUIRED'], see: 'สินค้านี้ตั้งให้ติดตามล็อต/Heat หรือคลังนี้ต้องระบุช่องเก็บทุกครั้ง',
      todo: 'อ่านเลขล็อต/Heat จากป้ายหรือใบรับรองวัสดุ สแกนหรือเลือกช่องเก็บ แล้วบันทึกอีกครั้ง', links: [['ยอดคงเหลือ', 'stock']] },
    { title: 'ต้องนับซ้ำโดยอีกคน', codes: ['NEEDS_RECOUNT'], see: 'ผลนับต่างจากระบบเกินเกณฑ์ หรือสองคนนับได้ไม่เท่ากัน',
      todo: 'ให้อีกคน (ไม่ใช่คนที่นับแล้ว) นับบรรทัดนั้นซ้ำ แล้วจึงส่งผลนับ', links: [['ตรวจนับ', 'counts']] },
    { title: 'ไม่มีสิทธิ์', codes: ['NO_PERMISSION'], see: 'บทบาทหรือคลังของคุณไม่มีสิทธิ์คำสั่งนี้ (ปุ่มที่ทำไม่ได้จะไม่แสดงหรือกดไม่ได้)',
      todo: 'ให้ผู้มีสิทธิ์ทำ หรือขอผู้ดูแลระบบปรับบทบาท/คลังให้ตรงกับหน้าที่จริง', links: [['สิทธิ์ตามบทบาท', 'users', { tab: 'matrix' }]] },
    { title: 'บันทึกไม่สำเร็จ / อินเทอร์เน็ตหลุด', codes: ['STORE', 'BUSY'], see: 'ที่เก็บข้อมูลไม่ตอบ หรือหลายคนบันทึกพร้อมกัน – ไม่มีอะไรถูกบันทึก',
      todo: 'ตรวจอินเทอร์เน็ตแล้วกดบันทึกอีกครั้ง ระบบไม่ตัดยอดซ้ำ · ถ้าขึ้นว่า "รายการนี้บันทึกไปแล้ว (ส่งซ้ำ)" แปลว่าครั้งแรกสำเร็จแล้ว', links: [] },
    { title: 'ตรวจยอดประจำวันไม่ผ่าน', codes: ['INTEGRITY'], see: 'ยอดไม่ตรงกับประวัติ มียอดติดลบที่ไม่ได้อนุมัติ หรือของกักกันหลุดออกนอกขั้นตอน QC',
      todo: 'แจ้งหัวหน้าสโตร์และบัญชีทันที ดูรายละเอียดในรายงาน แก้ด้วยเอกสารแก้ไข (ไม่ลบประวัติ) แล้วตรวจใหม่ – ยังไม่ขยายผลจนกว่าจะผ่าน', links: [['ตรวจยอดประจำวัน', 'reports', { tab: 'dailyCheck' }]] },
  ];

  const roleName = (r) => RRS.auth.ROLES[r] || r;
  function permsOf(role) {
    if (role === 'admin') return ['ทุกคำสั่งในระบบ (ยกเว้นอนุมัติงานของตัวเอง)'];
    const out = [];
    for (const p of Object.keys(RRS.auth.PERMS)) if ((RRS.auth.PERMS[p] || []).indexOf(role) >= 0) out.push(RRS.auth.PERM_LABELS[p] || p);
    return out;
  }
  function trainedOf(state, roles) {
    const users = RRS.q.rows(state, 'users', (u) => u.active !== false && roles.some((r) => (u.roles || []).indexOf(r) >= 0));
    const tr = RRS.q.rows(state, 'trainings');
    const done = users.filter((u) => tr.some((x) => x.userId === u.id && roles.indexOf(x.role) >= 0));
    return { users, done };
  }
  const linksOf = (list) => h.join((list || []).map(([label, page, view]) => go(label, page, view)), ' · ');

  function roleSection(ctx, g, mine) {
    const steps = t`<div class="steps">${g.steps.map(([title, text, links], i) => t`<div class="step"><span class="step-n">ขั้น ${i + 1}</span><b>${title}</b><span>${text}</span>${links && links.length ? t`<span>${linksOf(links)}</span>` : ''}</div>`)}</div>`;
    const perms = g.roles.map((r) => t`<p class="hint"><b>${roleName(r)} ทำได้:</b> ${permsOf(r).join(' · ') || 'ดูอย่างเดียว'}</p>`);
    let train = '';
    if (g.roles[0] !== 'admin' && RRS.schema.tables.trainings) {
      const tr = trainedOf(ctx.state, g.roles);
      train = t`<p class="hint">อบรมแล้ว ${h.fmt.num(tr.done.length)} จาก ${h.fmt.num(tr.users.length)} คนที่มีบทบาทนี้${tr.users.length && tr.done.length < tr.users.length ? ` · ยังไม่อบรม: ${tr.users.filter((u) => tr.done.indexOf(u) < 0).map((u) => u.name).slice(0, 8).join(', ')}` : ''}</p>`;
    }
    const canTrain = ctx.can('uat.record') && g.roles[0] !== 'admin' && !!RRS.commands.defs['training.record'];
    const actions = t`${mine ? h.badge('บทบาทของคุณ', 'accent') : ''}${canTrain ? h.btn('บันทึกการอบรม', { act: 'train', arg: g.roles.join(','), tone: 'ghost', small: true }) : ''}`;
    return h.section(g.title, t`${steps}${perms}${train}`, { id: 'guide-' + g.roles[0], sub: g.duty, actions });
  }

  function problemsView(ctx) {
    const v = ctx.view;
    const q = low(v.q).trim();
    const cards = PROBLEMS.filter((p) => !q || [p.title, p.see, p.todo].concat(p.codes).some((x) => low(x).indexOf(q) >= 0));
    const list = cards.length ? t`<div class="steps">${cards.map((p) => t`<div class="step" id="${'prob-' + p.codes[0]}"><b>${p.title}</b>
      <span><span class="muted">ที่เห็น:</span> ${p.see}</span><span><span class="muted">ทำอย่างนี้:</span> ${p.todo}</span>
      ${p.links.length ? t`<span>${linksOf(p.links)}</span>` : ''}<span class="hint">รหัสในข้อความ: ${p.codes.join(', ')}</span></div>`)}</div>`
      : h.empty('ไม่พบปัญหาที่ค้น', 'ลองคำอื่น หรือดูตารางรหัสข้อผิดพลาดทั้งหมดด้านล่าง');
    const guide = (RRS.reports && RRS.reports.ERROR_GUIDE) || [];
    const rows = guide.filter((g) => !q || [g.code, g.title, g.cause, g.action, g.who].some((x) => low(x).indexOf(q) >= 0));
    const tbl = guide.length ? h.section('รหัสข้อผิดพลาดทั้งหมด', h.table({ dense: true, scroll: true, rows, id: 'guide-errors', empty: 'ไม่พบรหัสที่ค้น',
      cols: [{ label: 'รหัส', render: (g) => h.code(g.code) }, { label: 'ความหมาย', key: 'title' }, { label: 'สาเหตุ', key: 'cause' },
        { label: 'ทำอย่างไร', key: 'action' }, { label: 'ใครช่วยได้', key: 'who' }] }),
    { sub: 'ข้อความที่ระบบแจ้งบอกเหตุผลเสมอ และเมื่อบันทึกไม่ได้ ไม่มีข้อมูลใดเปลี่ยน – แก้ตามข้อความแล้วบันทึกใหม่' }) : '';
    return t`${h.note('เมื่อระบบไม่ยอมบันทึก แปลว่ายังไม่มีอะไรเปลี่ยน (ไม่ตัดยอดครึ่ง ๆ) – อ่านข้อความ แก้ตามนั้น แล้วบันทึกใหม่ · ถ้าไม่แน่ใจ อย่าเลี่ยงด้วยการใช้ผู้ใช้ของคนอื่น ให้ถามหัวหน้างาน', 'info')}
      ${h.toolbar([h.field({ name: 'q', label: 'ค้นหาปัญหา', value: v.q, placeholder: 'เช่น ยอดไม่พอ, กักกัน, Express, SAME_PERSON', id: 'guide-q', act: 'search', live: true })], '')}
      ${h.section('ปัญหาที่พบบ่อย', list, { id: 'guide-problems' })}${tbl}`;
  }

  RRS.ui.page({
    id: 'guide', title: 'คู่มือตามบทบาท', phase: 6, order: 50,
    sub: 'งานประจำวันของแต่ละบทบาทในระบบนี้ กดชื่อหน้าเพื่อไปทำงานนั้น · ปุ่มที่คุณไม่มีสิทธิ์จะไม่แสดงหรือกดไม่ได้',
    render(ctx) {
      const v = ctx.view;
      const tab = v.tab === 'problems' ? 'problems' : 'roles';
      const tabs = h.tabs([{ id: 'roles', label: 'งานตามบทบาท' }, { id: 'problems', label: 'เมื่อเกิดปัญหา' }], tab);
      if (tab === 'problems') return t`${tabs}${problemsView(ctx)}`;
      const myRoles = (ctx.user && ctx.user.roles) || [];
      const isMine = (g) => g.roles.some((r) => myRoles.indexOf(r) >= 0);
      const opts = GUIDE.map((g) => [g.roles[0], g.title]);
      const want = v.role || '';
      let list = GUIDE.filter((g) => !want || (want === 'mine' ? isMine(g) : g.roles[0] === want));
      list = list.filter(isMine).concat(list.filter((g) => !isMine(g)));
      const pick = h.field({ name: 'role', label: 'แสดงบทบาท', type: 'select', value: want, id: 'guide-role', act: 'role',
        options: [['mine', 'เฉพาะบทบาทของฉัน']].concat(opts), blank: 'ทุกบทบาท' });
      const jump = t`<p class="hint">ไปที่: ${h.join(GUIDE.map((g) => h.btn(g.title, { act: 'jump', arg: g.roles[0], tone: 'quiet', small: true })), ' ')}</p>`;
      const body = list.length ? list.map((g) => roleSection(ctx, g, isMine(g)))
        : h.empty('ไม่มีคู่มือสำหรับบทบาทของคุณ', 'บทบาท ดูอย่างเดียว ดูข้อมูลได้ทุกหน้าแต่บันทึกไม่ได้ – เลือก ทุกบทบาท เพื่ออ่านคู่มือของคนอื่น');
      return t`${tabs}${h.toolbar([pick], '')}${!want ? jump : ''}${body}
        ${h.section('ก่อนเริ่มใช้งานจริง', t`<div class="steps">
          <div class="step"><span class="step-n">1</span><b>ใช้ผู้ใช้ของตัวเองเสมอ</b><span>ทุกรายการบันทึกว่าใครทำ ห้ามใช้ผู้ใช้ร่วมกันหรือยืมของคนอื่น</span></div>
          <div class="step"><span class="step-n">2</span><b>ของจริงก่อน ระบบตาม</b><span>บันทึกทันทีที่ของเคลื่อน ไม่สะสมไว้บันทึกทีหลัง</span></div>
          <div class="step"><span class="step-n">3</span><b>ไม่ลบประวัติ</b><span>บันทึกผิดให้ยกเลิกหรือทำเอกสารแก้ไขพร้อมเหตุผล</span></div>
          <div class="step"><span class="step-n">4</span><b>ติดปัญหา</b><span>${go('ดูวิธีแก้', 'guide', { tab: 'problems' })} หรือถามหัวหน้างาน</span></div></div>`)}`;
    },
    after(ctx, root0) {
      const v = ctx.view;
      if (v._jump) {
        const el = root0.querySelector('#guide-' + v._jump);
        v._jump = null;
        if (el) setTimeout(() => el.scrollIntoView({ block: 'start' }), 0);
      }
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg }),
      role: (ctx, el) => ctx.set({ role: el.value }),
      jump: (ctx, el) => ctx.set({ _jump: el.dataset.arg }),
      search: (ctx, el) => ctx.set({ q: el.value }),
      async train(ctx, el) {
        const roles = String(el.dataset.arg || '').split(',').filter(Boolean);
        const g = GUIDE.find((x) => x.roles[0] === roles[0]);
        const me = ctx.user ? ctx.user.id : '';
        const people = RRS.q.rows(ctx.state, 'users', (u) => u.active !== false && u.id !== me && roles.some((r) => (u.roles || []).indexOf(r) >= 0))
          .sort((a, b) => a.name.localeCompare(b.name, 'th'));
        if (!people.length) return ctx.toast(`ยังไม่มีผู้ใช้คนอื่นที่มีบทบาท ${g ? g.title : roles.join(', ')} – เพิ่มผู้ใช้ก่อน (บันทึกการอบรมตัวเองไม่ได้)`, 'warn');
        await ctx.dialog({
          title: `บันทึกการอบรม: ${g ? g.title : roles.join(', ')}`, submit: 'บันทึกการอบรม',
          body: t`${h.field({ name: 'userId', label: 'ผู้รับการอบรม', type: 'select', required: true, wide: true, id: 'guide-train-user',
            options: people.map((u) => [u.id, `${u.name} · ${u.roles.map(roleName).join(', ')}`]) })}
            ${roles.length > 1 ? h.field({ name: 'role', label: 'บทบาทที่อบรม', type: 'select', required: true, value: roles[0], options: roles.map((r) => [r, roleName(r)]), blank: false })
              : h.field({ name: 'role', type: 'hidden', value: roles[0] })}
            ${h.field({ name: 'topic', label: 'หัวข้อ', required: true, value: `คู่มือ${g ? g.title : ''} และวิธีแก้ปัญหาที่พบบ่อย`, wide: true })}
            ${h.field({ name: 'trainedOn', label: 'วันที่อบรม', type: 'date', value: ctx.today, required: true })}
            ${h.field({ name: 'note', label: 'หมายเหตุ', wide: true })}
            <p class="hint wide">ผู้อบรมคือคุณ (ระบบบันทึกให้) · ใช้ตรวจความพร้อมก่อนขยายผล</p>`,
          onSubmit(vals) {
            const u = RRS.q.get(ctx.state, 'users', vals.userId);
            if (!u) return { ok: false, errors: [{ message: 'เลือกผู้รับการอบรม' }] };
            const role = (u.roles || []).indexOf(vals.role) >= 0 ? vals.role : roles.find((r) => (u.roles || []).indexOf(r) >= 0) || vals.role;
            return ctx.exec('training.record', { userId: vals.userId, role, topic: vals.topic, trainedOn: vals.trainedOn, note: vals.note },
              { quiet: true, done: `บันทึกการอบรม ${u.name} แล้ว` });
          },
        });
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
