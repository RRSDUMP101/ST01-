// Picking the parts of a job for assembly (ใบจัดชุด): the walk in shelf order, AR guidance, send to the store.
import { api, useData } from '../api.js';
import { Icon } from '../icons.js';
import { pickSession } from '../sessions.js';
import { Bar, Button, Card, Chip, Empty, Loader, Page, Ring, Section } from '../ui.js';
import { feedback, go, html, num, pct, toast, useState, useStore } from '../lib.js';

export function PickListsScreen() {
  const state = useData('picklists');
  const active = useStore((s) => s.pickJob) || (pickSession.get() || {}).job_no;
  return html`<${Page} title="หยิบของ" sub="ใบจัดชุดต่องาน · นำทางด้วย AR · กันหยิบผิดรุ่น">
    ${active ? html`<${Card} tone="info" className="resume" onClick=${() => go(`pick/job/${encodeURIComponent(active)}`)}>
      <${Icon} name="pick" /><span class="grow"><b>กำลังหยิบ ${active}</b><small>แตะเพื่อทำต่อ</small></span><${Icon} name="chev" /></${Card}>` : null}
    <${Loader} state=${state} rows=${4}>${(rows) => (rows.length ? rows.map((j) => html`
      <${Card} className="job-row" onClick=${() => go(`pick/job/${encodeURIComponent(j.job_no)}`)}>
        <${Ring} value=${j.lines ? j.ready_lines / j.lines : 0} size=${52} tone=${j.ready_lines ? 'ok' : 'muted'} label=${`${j.ready_lines}/${j.lines}`} />
        <div class="job-main"><div class="job-top"><b>${j.job_no}</b>${j.pending ? html`<${Chip} tone="warn">รอสโตร์ยืนยัน</${Chip}>` : null}</div>
          <div class="job-title">${j.title}${j.customer ? ` · ${j.customer}` : ''}</div>
          <div class="job-meta"><span>หยิบได้ตอนนี้ ${num(j.pieces)} ชิ้น</span><span>พร้อมประกอบ ${pct(j.ready_pct)}</span>${j.due_text ? html`<span>ส่ง ${j.due_text}</span>` : null}</div></div>
        <${Icon} name="chev" className="chev" /></${Card}>`)
    : html`<${Empty} icon="pick" title="ไม่มีของรอหยิบ" text="งานที่เปิดอยู่จ่ายชิ้นส่วนครบแล้ว หรือยังไม่มีงานผลิต" />`)}</${Loader}>
  </${Page}>`;
}

export function PickJobScreen({ route }) {
  const no = route.parts[2] || '';
  const state = useData('picklist', { job: no });
  useStore((s) => s.pickJob);
  const [busy, setBusy] = useState(false);
  const session = pickSession.get();
  const mine = session && session.job_no === no ? session : null;
  const start = (list) => {
    if (!mine) pickSession.start(list);
    go('scan?mode=pick');
  };
  const send = async () => {
    const s = pickSession.get();
    const lines = Object.entries(s.picked).map(([index, v]) => ({ index: Number(index), qty: v.qty, verified: v.verified }));
    setBusy(true);
    try {
      const ans = await api.change('pick', { job_no: s.job_no, lines }, `หยิบของ ${s.job_no}`);
      pickSession.clear();
      feedback.ok();
      toast(ans.queued ? 'เก็บรายการหยิบไว้ ส่งให้เมื่อเชื่อมต่อได้' : 'ส่งรายการหยิบแล้ว – สโตร์ยืนยันที่คอม แล้วระบบออกใบ PD ให้', 'ok', 4200);
      state.reload();
    } catch (e) {
      feedback.error();
      toast(e.message, 'bad', 4500);
    } finally {
      setBusy(false);
    }
  };
  return html`<${Page} title=${`หยิบของ ${no}`} sub="เรียงตามเส้นทางเดินในสโตร์" backTo="pick">
    <${Loader} state=${state} rows=${6}>${(list) => {
      const ready = list.lines.filter((l) => l.ready);
      const picked = mine ? Object.keys(mine.picked).length : 0;
      const total = mine ? mine.lines.length : ready.length;
      return html`
        <${Card} className="pick-hero">
          <div class="ph-top"><div><h2>${list.title}</h2><p class="muted">${list.customer || ''}${list.due_text ? ` · ส่ง ${list.due_text}` : ''}</p></div>
            <${Ring} value=${total ? picked / total : 0} size=${64} tone="ok" label=${`${picked}/${total}`} /></div>
          <${Bar} value=${total ? picked / total : 0} tone="ok" />
          <div class="btn-row">
            <${Button} size="lg" icon="scan" disabled=${!ready.length} onClick=${() => start(list)}>${mine ? 'หยิบต่อด้วย AR' : 'เริ่มหยิบด้วย AR'}</${Button}>
            ${mine && picked ? html`<${Button} size="lg" kind="ok" icon="send" disabled=${busy} onClick=${send}>ส่ง ${picked} รายการ</${Button}>` : null}
          </div>
          ${mine ? html`<button class="link danger" onClick=${() => { if (confirm('เลิกการหยิบรอบนี้? รายการที่ติ๊กไว้จะหาย')) pickSession.clear(); }}>เลิกรอบนี้</button>` : null}
        </${Card}>
        <${Section} title=${`รายการ (${list.lines.length})`}>
          ${list.lines.map((l, i) => {
            const done = mine && mine.picked[l.index];
            return html`<div class=${`pick-row ${l.ready ? '' : 'not-ready'} ${done ? 'done' : ''}`}>
              <span class="pr-no">${done ? html`<${Icon} name="check" size=${18} stroke=${3} />` : i + 1}</span>
              <span class="pr-loc">${l.location || '—'}</span>
              <span class="pr-main"><b>${l.code}</b><span>${l.name}</span>
                <small>${l.ready ? l.group_name : `ยังไม่พร้อม: ${l.where}`}</small></span>
              <span class="pr-qty">${l.side ? html`<${Chip} tone=${l.side === 'ซ้าย' ? 'info' : 'violet'}>${l.side}</${Chip}>` : null}
                <b>${num(done ? done.qty : l.pick_now)}</b><small>/ ${num(l.need)} ${l.unit}</small></span>
            </div>`;
          })}
        </${Section}>
        ${list.lines.some((l) => !l.location) ? html`<p class="muted small">รายการที่ไม่มีตำแหน่งเก็บ: AR ช่วยนำทางไม่ได้ แต่ยังสแกนป้ายเพื่อยืนยันชิ้นได้</p>` : null}`;
    }}</${Loader}>
  </${Page}>`;
}

// the store seen from above: aisles from the entrance, racks left and right, where you are and where to go
export function StoreMap({ map, here, target }) {
  if (!map || !map.racks || !map.racks.length) {
    return html`<${Empty} icon="map" title="ยังไม่มีผังสโตร์" text="ตั้งผังที่คอม: หน้า มือถือ & AR → ผังสโตร์ (หาชั้นวางจากตำแหน่งเก็บได้อัตโนมัติ)" />`;
  }
  const aisles = map.aisles.length ? map.aisles : [1];
  const maxOrder = Math.max(...map.racks.map((r) => r.order), 1);
  const colW = 120; const rowH = 46; const W = aisles.length * colW + 20; const H = maxOrder * rowH + 60;
  return html`<svg class="store-map" viewBox=${`0 0 ${W} ${H}`} role="img" aria-label="ผังสโตร์">
    <rect x="0" y=${H - 26} width=${W} height="26" class="sm-door" /><text x=${W / 2} y=${H - 9} text-anchor="middle" class="sm-door-t">ทางเข้า</text>
    ${aisles.map((a, i) => html`<g transform=${`translate(${10 + i * colW},0)`}>
      <rect x="44" y="6" width="32" height=${H - 36} class="sm-aisle" rx="6" />
      <text x="60" y="20" text-anchor="middle" class="sm-aisle-t">${a}</text>
      ${map.racks.filter((r) => r.aisle === a).map((r) => {
        const y = H - 36 - r.order * rowH;
        const x = r.side === 'L' ? 2 : 80;
        const cls = r.code === target ? 'sm-rack target' : r.code === here ? 'sm-rack here' : 'sm-rack';
        return html`<g><rect x=${x} y=${y} width="38" height=${rowH - 8} rx="5" class=${cls} />
          <text x=${x + 19} y=${y + rowH / 2} text-anchor="middle" class="sm-rack-t">${r.code.split('-').slice(-1)[0]}</text>
          ${r.code === here ? html`<circle cx=${r.side === 'L' ? x + 50 : x - 12} cy=${y + rowH / 2 - 4} r="6" class="sm-you" />` : null}</g>`;
      })}</g>`)}
  </svg>`;
}
