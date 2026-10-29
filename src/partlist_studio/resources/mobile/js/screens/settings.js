// Settings: who is using this phone, the connection, sound / vibration / camera, unpair.
import { api, auth } from '../api.js';
import { Icon } from '../icons.js';
import { Button, Card, Chip, KV, Page, Section } from '../ui.js';
import { feedback, go, html, local, store, toast, useState, useStore } from '../lib.js';

export function SettingsScreen() {
  const device = useStore((s) => s.device) || {};
  const hello = useStore((s) => s.hello) || {};
  const online = useStore((s) => s.online);
  const queue = useStore((s) => s.queue);
  const [name, setName] = useState(device.name || '');
  const [station, setStation] = useState(device.station || '');
  const [sound, setSound] = useState(local.get('sound', true));
  const [vibrate, setVibrate] = useState(local.get('vibrate', true));
  const [hd, setHd] = useState(local.get('hd', false));
  const [engine, setEngine] = useState(local.get('engine', 'auto'));
  const steps = hello.steps || [];
  const save = async () => {
    try {
      const dev = await api.post('profile', { name, station });
      store.set({ device: dev });
      feedback.ok();
      toast('บันทึกแล้ว', 'ok');
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  const toggle = (key, value, set) => { local.set(key, value); set(value); };
  const unpair = () => {
    if (!confirm('ยกเลิกการจับคู่เครื่องนี้? ต้องสแกน QR จากคอมใหม่เพื่อใช้งานต่อ')) return;
    auth.token = '';
    store.set({ paired: false, device: null });
    go('pair', true);
  };
  return html`<${Page} title="ตั้งค่า" backTo="home">
    <${Section} title="ผู้ใช้เครื่องนี้">
      <${Card}>
        <label class="field"><span class="field-label">ชื่อ</span><input class="input" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
        <div class="field-label">บทบาท</div><p><${Chip} tone="navy">${device.role_name}</${Chip}> <small class="muted">เปลี่ยนบทบาทได้ที่คอม (หน้า มือถือ & AR)</small></p>
        <div class="field-label">สถานีของฉัน</div>
        <div class="chips-row">${['', ...steps].map((s) => html`<button class=${`chip tap ${station === s ? 'active' : ''}`} onClick=${() => setStation(s)}>${s || 'ไม่ระบุ'}</button>`)}</div>
        <${Button} block icon="check" onClick=${save}>บันทึก</${Button}>
      </${Card}>
    </${Section}>
    <${Section} title="การเชื่อมต่อ">
      <${Card}>
        <${KV} items=${[['สถานะ', online ? 'เชื่อมต่อแล้ว' : 'ขาดการเชื่อมต่อ'], ['คอมเครื่องหลัก', `${hello.server || ''} (${location.host})`],
          ['โปรแกรม', `${hello.app || ''} v${hello.version || ''}`], ['ค้างส่ง', queue ? `${queue} รายการ` : 'ไม่มี']]} />
        ${queue ? html`<${Button} kind="secondary" icon="send" onClick=${() => api.flush()}>ส่งรายการที่ค้างตอนนี้</${Button}>` : null}
      </${Card}>
    </${Section}>
    <${Section} title="การใช้งาน">
      <${Card} className="toggles">
        <label class="toggle"><span><${Icon} name="bolt" size=${18} /> เสียงยืนยัน / เตือน</span><input type="checkbox" checked=${sound} onChange=${(e) => toggle('sound', e.target.checked, setSound)} /></label>
        <label class="toggle"><span><${Icon} name="hand" size=${18} /> สั่น (Android)</span><input type="checkbox" checked=${vibrate} onChange=${(e) => toggle('vibrate', e.target.checked, setVibrate)} /></label>
        <label class="toggle"><span><${Icon} name="camera" size=${18} /> กล้องความละเอียดสูง (ป้ายไกล / เล็ก)</span><input type="checkbox" checked=${hd} onChange=${(e) => toggle('hd', e.target.checked, setHd)} /></label>
        <label class="toggle"><span><${Icon} name="qr" size=${18} /> ตัวอ่าน QR</span>
          <select class="input slim" value=${engine} onChange=${(e) => toggle('engine', e.target.value, setEngine)}>
            <option value="auto">อัตโนมัติ (ของเครื่อง ถ้ามี)</option><option value="zxing">ZXing (ทุกเครื่อง)</option></select></label>
      </${Card}>
    </${Section}>
    <${Section} title="ติดตั้งเป็นแอป">
      <${Card}><p class="small">iPhone / iPad: กดปุ่มแชร์ใน Safari → <b>เพิ่มไปยังหน้าจอโฮม</b><br />Android: เมนู ⋮ ใน Chrome → <b>ติดตั้งแอป</b> หรือ <b>เพิ่มลงในหน้าจอหลัก</b></p>
        <p class="small muted">ถ้าเปิดจากหน้าจอโฮมแล้วต้องจับคู่ใหม่ (iPhone แยกข้อมูลแอปกับ Safari) ใช้ปุ่มสแกน QR ในหน้าจับคู่</p></${Card}>
    </${Section}>
    <${Button} kind="danger-soft" block icon="logout" onClick=${unpair}>ยกเลิกการจับคู่เครื่องนี้</${Button}>
    <p class="muted small center">RRS Part List Studio · แอปมือถือ</p>
  </${Page}>`;
}
