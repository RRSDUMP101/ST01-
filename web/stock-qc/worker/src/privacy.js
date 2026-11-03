// Public, static disclosure: never reads environment bindings, accounts, sessions or connection tokens.
const HTML = `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ความเป็นส่วนตัว · Nexus Part Terminal</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f3f6f8;color:#172b3a;font:16px/1.8 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:860px;margin:40px auto;padding:36px;background:#fff;border:1px solid #dce5eb;border-radius:16px}header{border-bottom:1px solid #dce5eb;padding-bottom:22px;margin-bottom:26px}.brand{color:#087b70;font-size:14px;font-weight:700;letter-spacing:.08em}h1{font-size:30px;line-height:1.35;margin:10px 0}h2{font-size:20px;line-height:1.5;margin:28px 0 8px}p{margin:10px 0}li{margin:6px 0}a{color:#075ea8;text-underline-offset:3px}a:focus-visible{outline:3px solid #087b70;outline-offset:4px}.muted{color:#526573}footer{border-top:1px solid #dce5eb;margin-top:28px;padding-top:18px}@media(max-width:600px){main{margin:0;padding:24px 20px;border:0;border-radius:0}h1{font-size:26px}}
</style></head><body><main>
<header><div class="brand">NEXUS PART TERMINAL</div><h1>ความเป็นส่วนตัวและการเชื่อม Google</h1><p class="muted">อัปเดต 3 พฤศจิกายน 2569 · ระบบจัดการสต็อกและอะไหล่สำหรับใช้งานภายใน</p></header>
<p>หน้านี้อธิบายการใช้ข้อมูลเมื่อเจ้าของระบบเชื่อมบัญชี Google เพื่อสำรองข้อมูล Nexus Part Terminal ไปยัง Google Drive และ Google Sheets การเชื่อม Google เป็นส่วนของการสำรองข้อมูล ไม่ใช่บัญชีเข้าสู่ระบบ Nexus</p>
<h2>สิทธิ์ที่ขอและข้อมูลที่ใช้</h2>
<p>เจ้าของระบบเป็นผู้อนุญาตการเชื่อมต่อผ่านหน้าของ Google ระบบขอสิทธิ์ Google Drive แบบเต็ม ซึ่ง Google แสดงว่าสามารถดู สร้าง แก้ไข และลบไฟล์ใน Drive ได้ สิทธิ์นี้ใช้เพื่อเข้าถึงโฟลเดอร์ที่กำหนดไว้ก่อนเชื่อมต่อ และตรวจสอบสิทธิ์ของไฟล์กับโฟลเดอร์</p>
<p>การทำงานของแอปจำกัดการเขียนไว้ในโฟลเดอร์สำรองส่วนตัวที่กำหนดและโฟลเดอร์ย่อยของรอบสำรอง ระบบอ่านข้อมูลประกอบ เช่น รหัสไฟล์ ชื่อ ประเภท ตำแหน่งโฟลเดอร์ เจ้าของ สิทธิ์แชร์ ขนาด และค่าตรวจสอบไฟล์ เพื่อยืนยันปลายทางและความครบถ้วน หากพบว่าปลายทางถูกแชร์หรือสิทธิ์ไม่ตรง ระบบจะหยุดการสำรอง</p>
<h2>สิ่งที่ส่งออก</h2>
<p>เมื่อเปิดใช้งาน ระบบสำรองข้อมูลทุกวันเวลา 03:00 น. ตามเวลาประเทศไทย และผู้มีสิทธิ์สามารถสั่งสำรองได้ ข้อมูลสต็อก อะไหล่ เอกสาร ใบงาน และประวัติรายการจะถูกบันทึกเป็นภาพข้อมูล ณ เวลาส่งออกใน Google Sheets พร้อมไฟล์ JSONL และ manifest สำหรับตรวจสอบและกู้คืน</p>
<ul><li>ไม่ส่งออกรหัสผ่าน ข้อมูลรับรองบัญชี โทเค็นเข้าสู่ระบบ เซสชัน หรือค่า secret</li><li>ไม่รวมเนื้อหาไฟล์แนบที่เก็บใน R2 เช่น รูปตรวจ QC หรือใบรับรอง โดยรายการอาจมีรหัสอ้างอิงไฟล์</li><li>การแก้ไข Google Sheets ไม่ถูกนำกลับมาแก้ข้อมูลใน Nexus อัตโนมัติ</li></ul>
<h2>การเก็บและการใช้ข้อมูล</h2>
<p>ข้อมูลระบบและการประมวลผลอยู่บนโครงสร้างพื้นฐาน Cloudflare ข้อมูลสำรองถูกส่งไปยัง Google Drive ของบัญชีที่เจ้าของอนุญาต โทเค็นที่ใช้ต่ออายุการเชื่อม Google ถูกเข้ารหัสในฐานข้อมูล Cloudflare D1 ข้อมูลรับรองอยู่ฝั่งเซิร์ฟเวอร์และไม่ส่งกลับไปยังหน้าเว็บ</p>
<p>ระบบใช้ข้อมูลจาก Google เพื่อให้การสำรองและตรวจสอบปลายทางทำงานเท่านั้น ไม่ขายข้อมูล ไม่ใช้เพื่อโฆษณา และไม่ใช้ฝึกโมเดล AI การใช้และการส่งต่อข้อมูลที่ได้รับจาก Google APIs เป็นไปตาม <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a> รวมถึงข้อกำหนด Limited Use</p>
<h2>การเก็บรักษาและการยกเลิกสิทธิ์</h2>
<p>ระบบไม่มีการลบไฟล์สำรองใน Drive อัตโนมัติ ไฟล์จะคงอยู่จนกว่าเจ้าของจะลบเอง การยกเลิกสิทธิ์เชื่อมต่อไม่ลบไฟล์ที่ส่งออกไปแล้ว</p>
<p>เจ้าของสามารถยกเลิกการเข้าถึงได้ที่ <a href="https://myaccount.google.com/connections">หน้าการเชื่อมต่อของบัญชี Google</a> โดยเลือก Nexus Part Terminal และนำสิทธิ์เข้าถึงออก ตาม <a href="https://support.google.com/accounts/answer/13533235">ขั้นตอนของ Google</a> เมื่อยกเลิกแล้ว การสำรองที่ต้องใช้ Google จะทำงานต่อไม่ได้จนกว่าจะเชื่อมใหม่</p>
<p>หากต้องการลบข้อมูลการเชื่อมต่อที่เก็บใน Nexus ให้ติดต่อผู้ดูแลระบบภายในเพื่อลบโทเค็นที่เข้ารหัสออกจากเซิร์ฟเวอร์ ปัจจุบันยังไม่มีปุ่มลบการเชื่อมต่อจากหน้าเว็บ ข้อมูลการเชื่อมต่อจะเก็บไว้จนกว่าผู้ดูแลจะลบหรือเจ้าของเชื่อมใหม่เพื่อแทนที่</p>
<h2>ติดต่อ</h2><p>ติดต่อเจ้าของระบบหรือผู้ดูแล Nexus Part Terminal ผ่านช่องทางภายในองค์กร สำหรับคำถามเกี่ยวกับข้อมูล การเชื่อม Google หรือการขอลบข้อมูลการเชื่อมต่อ</p>
<footer><a href="/">กลับไป Nexus Part Terminal</a></footer>
</main></body></html>`;

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=15552000',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

export function privacyPage(req) {
  if (!['GET', 'HEAD'].includes(req.method)) return new Response('ไม่รองรับวิธีเรียกนี้', {
    status: 405, headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Allow: 'GET, HEAD' },
  });
  return new Response(req.method === 'HEAD' ? null : HTML, { status: 200, headers: HEADERS });
}
