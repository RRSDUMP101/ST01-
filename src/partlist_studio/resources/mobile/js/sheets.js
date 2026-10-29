// Bottom sheets used from several screens: record a step, spoiled pieces, report a problem, count an item.
import { api } from './api.js';
import { countSession } from './sessions.js';
import { Button, Chip, Stepper, Steps, KV, StatusChip } from './ui.js';
import { PartVisual } from './view3d.js';
import { closeSheet, feedback, html, num, openSheet, store, toast, useState } from './lib.js';

function hello() { return store.state.hello || {}; }
function canChange() { return (store.state.device || {}).role !== 'viewer'; }

// ---- production: pieces through a step ---------------------------------------------------------------------
export function openRecord(part, onDone) {
  openSheet((close) => html`<${RecordSheet} part=${part} close=${close} onDone=${onDone} />`,
    { title: `${part.code}`, onClose: null });
}

function RecordSheet({ part, close, onDone }) {
  const route = part.route || [];
  const first = part.step && route.some((r) => r.step === part.step) ? part.step
    : (part.next_step || (route.find((r) => r.waiting > 0) || route[0] || {}).step || '');
  const [step, setStep] = useState(first);
  const here = route.find((r) => r.step === step) || { waiting: 0 };
  const [qty, setQty] = useState(here.waiting || 1);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const pick = (s) => {
    setStep(s);
    const r = route.find((x) => x.step === s);
    setQty(r && r.waiting ? r.waiting : 1);
  };
  const save = async () => {
    setBusy(true);
    try {
      const ans = await api.change('record', { job_no: part.job_no, index: part.index, step, qty, note }, `บันทึก${step} ${part.code}`);
      feedback.ok();
      if (!ans.queued) toast(`บันทึก${step} ${num(ans.taken)} ชิ้นแล้ว · ${ans.part.status_text}`, 'ok');
      close();
      if (onDone) onDone(ans);
    } catch (e) {
      feedback.error();
      toast(e.message, 'bad', 4200);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="rec">
    <div class="rec-head">
      <div><div class="rec-name">${part.name}</div>
        <div class="rec-sub">${part.job_no}${part.job_title ? ` · ${part.job_title}` : ''}</div></div>
      <${StatusChip} status=${part.status} />
    </div>
    <${Steps} route=${route} current=${step} />
    <div class="label-sm">ขั้นที่บันทึก</div>
    <div class="chips-row">${route.map((r) => html`<${Chip} active=${r.step === step} tone=${r.waiting > 0 ? 'warn' : 'muted'}
      onClick=${() => pick(r.step)}>${r.step}${r.waiting > 0 ? ` · รอ ${num(r.waiting)}` : ''}</${Chip}>`)}</div>
    <div class="label-sm">จำนวนที่ผ่านขั้น${step} (รออยู่ ${num(here.waiting)} ${part.unit || 'ชิ้น'})</div>
    <${Stepper} big value=${qty} onChange=${setQty} min=${1} max=${Math.max(1, here.waiting || 1)} />
    <input class="input" placeholder="หมายเหตุ (ถ้ามี)" value=${note} onInput=${(e) => setNote(e.target.value)} />
    <${Button} size="xl" block icon="check" disabled=${busy || !canChange() || !here.waiting} onClick=${save}>
      ${here.waiting ? `เสร็จ ${num(qty)} ${part.unit || 'ชิ้น'} (${step})` : `ขั้น${step} ไม่มีชิ้นรอ`}</${Button}>
    <div class="btn-row">
      <${Button} kind="danger-soft" icon="close" disabled=${!canChange() || !here.waiting}
        onClick=${() => { closeSheet(); setTimeout(() => openScrap(part, step, onDone), 200); }}>เสีย…</${Button}>
      <${Button} kind="warn-soft" icon="alert"
        onClick=${() => { closeSheet(); setTimeout(() => openProblem({ job_no: part.job_no, index: part.index, step, code: part.code, name: part.name }, onDone), 200); }}>แจ้งปัญหา…</${Button}>
    </div>
    ${!canChange() ? html`<p class="muted small">บทบาท ดูอย่างเดียว – บันทึกไม่ได้</p>` : null}
  </div>`;
}

export function openScrap(part, step, onDone) {
  openSheet((close) => html`<${ScrapSheet} part=${part} step=${step} close=${close} onDone=${onDone} />`,
    { title: `บันทึกชิ้นเสีย · ${part.code}` });
}

function ScrapSheet({ part, step: first, close, onDone }) {
  const route = part.route || [];
  const [step, setStep] = useState(first || part.next_step || (route[0] || {}).step);
  const here = route.find((r) => r.step === step) || { waiting: 0 };
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const reasons = hello().scrap_reasons || [];
  const save = async () => {
    setBusy(true);
    try {
      const ans = await api.change('scrap', { job_no: part.job_no, index: part.index, step, qty, reason }, `เสีย ${part.code}`);
      feedback.warn();
      if (!ans.queued) toast(`บันทึกเสีย ${num(ans.taken)} ชิ้น – ระบบให้ทำใหม่จากขั้นแรกแล้ว`, 'warn', 3600);
      close();
      if (onDone) onDone(ans);
    } catch (e) {
      feedback.error();
      toast(e.message, 'bad', 4200);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="rec">
    <p class="muted">ชิ้นที่เสียจะถูกหักออกจากขั้นก่อนหน้า และกลับไป “รอ${route[0] ? route[0].step : 'ตัด'}” ให้ทำใหม่อัตโนมัติ</p>
    <div class="label-sm">เสียที่ขั้น</div>
    <div class="chips-row">${route.map((r) => html`<${Chip} active=${r.step === step} onClick=${() => setStep(r.step)}>${r.step}</${Chip}>`)}</div>
    <div class="label-sm">จำนวนที่เสีย</div>
    <${Stepper} big value=${qty} onChange=${setQty} min=${1} max=${Math.max(1, here.waiting || 999)} />
    <div class="label-sm">สาเหตุ</div>
    <div class="chips-row">${reasons.map((r) => html`<${Chip} active=${reason === r} tone="bad" onClick=${() => setReason(r)}>${r}</${Chip}>`)}</div>
    <input class="input" placeholder="หรือพิมพ์สาเหตุ" value=${reasons.includes(reason) ? '' : reason} onInput=${(e) => setReason(e.target.value)} />
    <${Button} size="xl" block kind="danger" icon="close" disabled=${busy || !reason.trim()} onClick=${save}>บันทึกเสีย ${num(qty)} ชิ้น</${Button}>
  </div>`;
}

export function openProblem(ctx = {}, onDone) {
  openSheet((close) => html`<${ProblemSheet} ctx=${ctx} close=${close} onDone=${onDone} />`, { title: 'แจ้งปัญหา (Andon)' });
}

function ProblemSheet({ ctx, close, onDone }) {
  const [topic, setTopic] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const topics = hello().problem_topics || [];
  const send = async () => {
    setBusy(true);
    try {
      const full = [topic, text.trim()].filter(Boolean).join(': ');
      await api.change('problem', { text: full, job_no: ctx.job_no || '', index: ctx.index ?? '', step: ctx.step || '' }, 'แจ้งปัญหา');
      feedback.warn();
      toast('ส่งแจ้งปัญหาให้หัวหน้าแล้ว – ขึ้นที่คอมทันที', 'ok', 3200);
      close();
      if (onDone) onDone();
    } catch (e) {
      feedback.error();
      toast(e.message, 'bad', 4200);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="rec">
    ${ctx.code ? html`<${KV} items=${[['งาน', ctx.job_no], ['ชิ้นส่วน', `${ctx.code} ${ctx.name || ''}`], ['ขั้น', ctx.step]]} />` : null}
    <div class="label-sm">เรื่อง</div>
    <div class="chips-row">${topics.map((t) => html`<${Chip} active=${topic === t} tone="warn" onClick=${() => setTopic(topic === t ? '' : t)}>${t}</${Chip}>`)}</div>
    <textarea class="input" rows="3" placeholder="รายละเอียด เช่น เครื่องพับ 2 ไฮดรอลิกรั่ว" value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
    <${Button} size="xl" block kind="warn" icon="alert" disabled=${busy || !(topic || text.trim())} onClick=${send}>ส่งแจ้งปัญหา</${Button}>
  </div>`;
}

// ---- stock count of one item ------------------------------------------------------------------------------------
export function openCount(item, opts = {}) {
  openSheet((close) => html`<${CountSheet} item=${item} opts=${opts} close=${close} />`, { title: `นับสต็อก · ${item.code}` });
}

function CountSheet({ item, opts, close }) {
  const before = countSession.find(item.key);
  const [qty, setQty] = useState(opts.value ?? (before ? before.counted : item.on_hand || 0));
  const diff = qty - (item.on_hand || 0);
  const save = () => {
    countSession.add({
      key: item.key, code: item.code, name: item.name, unit: item.unit, location: opts.location || item.location || '',
      counted: qty, system: item.on_hand || 0, method: opts.method || 'manual',
    });
    feedback.ok();
    toast(`นับ ${item.code} = ${num(qty)} ${item.unit || ''}${diff ? ` (ต่าง ${diff > 0 ? '+' : ''}${num(diff)})` : ' ตรงกับระบบ'}`, diff ? 'warn' : 'ok');
    close();
    if (opts.onDone) opts.onDone();
  };
  return html`<div class="rec">
    <div class="rec-head"><div><div class="rec-name">${item.name || item.code}</div>
      <div class="rec-sub">${item.location ? `ตำแหน่ง ${item.location}` : 'ยังไม่ตั้งตำแหน่งเก็บ'}</div></div></div>
    ${opts.visual ? html`<${PartVisual} item=${item} height=${150} compact />` : null}
    <div class="count-grid">
      <div><span>ในระบบ</span><b>${num(item.on_hand)}</b><small>${item.unit || ''}</small></div>
      <div class=${diff ? (diff > 0 ? 'up' : 'down') : 'same'}><span>ต่าง</span><b>${diff > 0 ? '+' : ''}${num(diff)}</b><small>${diff ? '' : 'ตรง'}</small></div>
    </div>
    <div class="label-sm">นับได้จริง</div>
    <${Stepper} big value=${qty} onChange=${setQty} min=${0} />
    ${opts.onTapCount ? html`<${Button} kind="secondary" block icon="hand" onClick=${() => { close(); setTimeout(opts.onTapCount, 200); }}>นับจากภาพ (แตะทีละชิ้น)</${Button}>` : null}
    <${Button} size="xl" block icon="check" onClick=${save}>บันทึกยอดนับ ${num(qty)} ${item.unit || ''}</${Button}>
    <p class="muted small">ยอดนับเก็บในรายการนับของเครื่องนี้ก่อน แล้วกด “ส่งผลนับ” ให้สโตร์ยืนยันที่คอม (ระบบร่างใบปรับยอด AJ เฉพาะส่วนต่าง)</p>
  </div>`;
}
