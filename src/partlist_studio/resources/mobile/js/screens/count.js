// The stock count of this phone: counted lines, how far each is from the system, send for the store to confirm.
import { api, useData } from '../api.js';
import { Icon } from '../icons.js';
import { countSession } from '../sessions.js';
import { openCount } from '../sheets.js';
import { Button, Card, Chip, Empty, Page, Section, StatusChip } from '../ui.js';
import { feedback, go, html, num, timeAgo, toast, useState, useStore } from '../lib.js';

export function CountScreen() {
  useStore((s) => s.countN);
  const session = countSession.get();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const mine = useData('mine');
  const lines = session.lines;
  const diff = lines.filter((l) => l.counted !== l.system).length;
  const send = async () => {
    setBusy(true);
    try {
      const ans = await api.change('count', { lines: lines.map(({ code, counted, location, method }) => ({ code, counted, location, method })), note }, 'ผลนับสต็อก');
      countSession.clear();
      feedback.ok();
      toast(ans.queued ? 'เก็บผลนับไว้ ส่งให้เมื่อเชื่อมต่อได้' : 'ส่งผลนับแล้ว – รอสโตร์ยืนยันที่คอม', 'ok', 3600);
      mine.reload();
    } catch (e) {
      feedback.error();
      toast(e.message, 'bad', 4500);
    } finally {
      setBusy(false);
    }
  };
  return html`<${Page} title="นับสต็อก" sub="ส่องป้ายด้วย AR · แตะนับจากภาพ · ส่งให้สโตร์ยืนยัน" backTo="stock">
    <div class="count-actions">
      <${Button} size="lg" icon="scan" onClick=${() => go('scan?mode=count')}>สแกนนับด้วย AR</${Button}>
      <${Button} size="lg" kind="secondary" icon="search" onClick=${() => go('stock')}>ค้นหารายการ</${Button}>
    </div>
    <${Section} title=${`รายการที่นับ (${lines.length})`} action=${lines.length ? html`<button class="link danger" onClick=${() => { if (confirm('ล้างรายการนับทั้งหมด?')) countSession.clear(); }}>ล้าง</button>` : null}>
      ${lines.length ? html`<div class="list">${lines.map((l) => {
        const d = l.counted - l.system;
        return html`<div class="count-row">
          <button class="cr-main" onClick=${() => openCount({ key: l.key, code: l.code, name: l.name, unit: l.unit, on_hand: l.system, location: l.location }, { value: l.counted })}>
            <b>${l.code}</b><span>${l.name}</span><small>${l.location ? `📍 ${l.location} · ` : ''}${l.method === 'tap' ? 'นับจากภาพ' : l.method === 'ar' ? 'AR' : 'กรอกเอง'} · ${timeAgo(l.at)}</small></button>
          <div class="cr-qty"><b>${num(l.counted)}</b><small>ระบบ ${num(l.system)}</small>
            <${Chip} tone=${d ? (d > 0 ? 'info' : 'bad') : 'ok'}>${d ? `${d > 0 ? '+' : ''}${num(d)}` : 'ตรง'}</${Chip}></div>
          <button class="icon-btn" aria-label="ลบ" onClick=${() => countSession.remove(l.key)}><${Icon} name="trash" size=${18} /></button>
        </div>`;
      })}</div>
      <textarea class="input" rows="2" placeholder="หมายเหตุ เช่น นับชั้นวาง P-POST ทั้งแถว" value=${note} onInput=${(e) => setNote(e.target.value)}></textarea>
      <${Button} size="xl" block icon="send" disabled=${busy} onClick=${send}>ส่งผลนับ ${lines.length} รายการ${diff ? ` (ไม่ตรง ${diff})` : ''}</${Button}>`
    : html`<${Empty} icon="count" title="ยังไม่มีรายการนับ" text="กด สแกนนับด้วย AR แล้วส่องป้าย QR ที่ชั้นวาง แตะการ์ดของป้ายเพื่อใส่จำนวน" />`}
    </${Section}>
    ${mine.data && mine.data.length ? html`<${Section} title="ที่ส่งไปแล้ว">${mine.data.slice(0, 10).map((s) => html`<${Card} className="mini-card">
      <${Icon} name=${s.kind === 'pick' ? 'pick' : s.kind === 'count' ? 'count' : 'alert'} size=${18} />
      <span class="grow"><b>${s.kind_name}</b> ${s.summary}<small class="muted">${timeAgo(s.created)}${s.doc_no ? ` · ${s.doc_no}` : ''}</small></span>
      <${StatusChip} status=${s.status} /></${Card}>`)}</${Section}>` : null}
  </${Page}>`;
}
