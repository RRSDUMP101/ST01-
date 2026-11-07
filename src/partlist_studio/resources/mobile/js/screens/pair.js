// First start: pair this phone with the program on the PC (code from the QR on the PC screen).
import { api, auth } from '../api.js';
import { Icon } from '../icons.js';
import { Button, Field } from '../ui.js';
import { feedback, go, html, local, parseRoute, store, toast, unlockAudio, useEffect, useState } from '../lib.js';

const ROLE_INFO = {
  station: ['factory', 'หน้างานผลิต', 'ดูคิวสถานี บันทึกเสร็จ/เสีย แจ้งปัญหา'],
  store: ['box', 'สโตร์ / คลัง', 'นับสต็อกด้วย AR หยิบของตามใบจัดชุด'],
  planner: ['layers', 'วางแผน / หัวหน้างาน', 'ภาพรวมทุกงาน ปิดการแจ้งปัญหา ทำได้ทุกอย่าง'],
  viewer: ['eye', 'ดูอย่างเดียว', 'ดูสถานะ ไม่บันทึกอะไร'],
};
const STEPS = ['ตัด', 'พับ', 'เหยียบปิด', 'เชื่อม', 'กลึง', 'ทำสี'];

export function codeFromText(text) {
  const m = String(text || '').match(/[#?&]pair=([A-Za-z0-9-]+)/);
  return m ? m[1] : '';
}

export function PairScreen() {
  const route = parseRoute();
  const hashCode = codeFromText(location.href) || route.params.code || '';
  const [code, setCode] = useState(hashCode.toUpperCase());
  const [name, setName] = useState(local.get('lastName', ''));
  const [role, setRole] = useState('station');
  const [station, setStation] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(null); // what the code gives: the role set on the PC, an invitation's name
  const clean = code.replace(/[\s-]/g, '');
  useEffect(() => {
    if (clean.length < 8) { setInfo(null); return undefined; }
    let gone = false;
    api.get('paircode', { code: clean }).then((ans) => {
      if (gone) return;
      setInfo(ans && ans.ok ? ans : null);
      if (ans && ans.ok && ans.name && !name.trim()) setName(ans.name);
    }).catch(() => { if (!gone) setInfo(null); });
    return () => { gone = true; };
  }, [clean]);
  const given = info && info.role ? info.role : '';
  const submit = async (e) => {
    if (e) e.preventDefault();
    unlockAudio();
    setBusy(true);
    try {
      const mine = given || role;
      const ans = await api.post('pair', { code: clean, name, role: mine, station: mine === 'station' ? station : '' });
      auth.token = ans.token;
      local.set('lastName', name);
      store.set({ paired: true, device: ans.device, hello: ans.hello });
      feedback.ok();
      toast(`จับคู่สำเร็จ – ยินดีต้อนรับ ${ans.device.name}`, 'ok');
      history.replaceState(null, '', location.pathname); // the code (?pair= of an invitation) out of the address
      const r = ans.device.role || mine;
      go(r === 'store' ? 'stock' : r === 'station' ? 'prod' : 'home', true);
    } catch (err) {
      feedback.error();
      toast(err.message, 'bad', 5000);
    } finally {
      setBusy(false);
    }
  };
  return html`<section class="pair">
    <div class="pair-hero">
      <div class="logo-badge"><img src="icons/icon-192.png" alt="" /></div>
      <h1>RRS Smart Production</h1>
      <p>ติดตามการผลิต · สแกน AR นับสต็อก · หยิบของนำทางด้วย AR</p>
    </div>
    <form class="card pair-card" onSubmit=${submit}>
      <h2>${info && info.invite ? 'คำเชิญจากคอมของโรงงาน' : 'เชื่อมต่อกับโปรแกรมบนคอม'}</h2>
      ${info && info.invite ? html`<p class="invite-note"><${Icon} name="check" size=${18} stroke=${2.6} />
          <span>ลิงก์เชิญใช้ได้ <b>1 เครื่อง</b> ถึง ${info.until} น. · ตรวจชื่อแล้วกด <b>เริ่มใช้งาน</b></span></p>`
    : html`<p class="muted small">ที่คอม: หน้า <b>มือถือ & AR</b> → สแกน QR ด้วยกล้องมือถือ หรือกรอกรหัส 8 ตัวที่แสดงบนจอ</p>`}
      ${info && info.invite ? null : html`<${Field} label="รหัสจับคู่">
        <div class="code-row">
          <input class="input code-input" value=${code} maxlength="12" autocapitalize="characters" autocomplete="off"
            placeholder="เช่น K7Q2M9XA" onInput=${(e) => setCode(e.target.value.toUpperCase())} />
          <button type="button" class="icon-btn solid" aria-label="สแกน QR จับคู่" onClick=${() => go('scan?mode=pair')}>
            <${Icon} name="qr" /></button>
        </div>
      </${Field}>`}
      <${Field} label="ชื่อผู้ใช้ / ชื่อเครื่อง">
        <input class="input" value=${name} maxlength="40" placeholder="เช่น แอน 2 หรือ แท็บเล็ตสถานีพับ" onInput=${(e) => setName(e.target.value)} />
      </${Field}>
      ${given ? html`<div class="field-label">บทบาท</div><div class="role-given"><span class="role-ic"><${Icon} name=${(ROLE_INFO[given] || ['eye'])[0]} /></span>
          <span><b>${info.role_name || (ROLE_INFO[given] || [])[1]}</b><small>กำหนดจากคอม</small></span></div>` : html`<div class="field-label">บทบาท</div>
      <div class="role-grid">${Object.entries(ROLE_INFO).map(([key, [icon, title, text]]) => html`
        <button type="button" class=${`role ${role === key ? 'on' : ''}`} onClick=${() => setRole(key)}>
          <span class="role-ic"><${Icon} name=${icon} /></span><b>${title}</b><small>${text}</small></button>`)}</div>`}
      ${(given || role) === 'station' ? html`<div class="field-label">สถานีที่ทำงาน</div>
        <div class="chips-row">${STEPS.map((s) => html`<button type="button" class=${`chip tap ${station === s ? 'active' : ''}`} onClick=${() => setStation(station === s ? '' : s)}>${s}</button>`)}</div>` : null}
      <${Button} type="submit" size="xl" block icon="check" disabled=${busy || clean.length < 8 || !name.trim()}>เริ่มใช้งาน</${Button}>
    </form>
    <p class="muted small center">ข้อมูลทั้งหมดอยู่บนคอมของบริษัท มือถือไม่เก็บสำเนา${info && info.invite ? '' : ' · ใช้ผ่าน Wi-Fi ในโรงงาน'}</p>
  </section>`;
}
