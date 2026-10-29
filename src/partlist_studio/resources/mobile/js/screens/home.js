// Home: today at a glance for the person holding the phone.
import { api, useData } from '../api.js';
import { Icon } from '../icons.js';
import { openProblem, openRecord } from '../sheets.js';
import { Bar, Button, Card, Chip, Empty, Loader, Ring, Section, Stat, StatusChip } from '../ui.js';
import { feedback, go, html, num, pct, store, timeAgo, toast, useStore } from '../lib.js';

const STEP_TONE = { ตัด: 'muted', พับ: 'gold', เหยียบปิด: 'amber', เชื่อม: 'orange', กลึง: 'violet', ทำสี: 'teal' };

export function HomeScreen() {
  const device = useStore((s) => s.device) || {};
  const online = useStore((s) => s.online);
  const queue = useStore((s) => s.queue);
  const state = useData('dashboard');
  const hour = new Date().getHours();
  const hi = hour < 12 ? 'อรุณสวัสดิ์' : hour < 17 ? 'สวัสดีตอนบ่าย' : 'สวัสดีตอนเย็น';
  return html`<section class="page home">
    <header class="hero">
      <div class="hero-top">
        <div><p class="hero-hi">${hi}</p><h1>${device.name || 'ผู้ใช้'}</h1>
          <span class="hero-role">${device.role_name || ''}${device.station ? ` · สถานี${device.station}` : ''}</span></div>
        <button class="avatar" aria-label="ตั้งค่า" onClick=${() => go('settings')}><${Icon} name="user" /></button>
      </div>
      <div class=${`conn ${online ? 'on' : 'off'}`}><${Icon} name=${online ? 'wifi' : 'wifioff'} size=${16} />
        ${online ? 'เชื่อมต่อโปรแกรมบนคอมแล้ว' : 'ขาดการเชื่อมต่อ – บันทึกจะส่งเมื่อกลับมา'}${queue ? ` · ค้างส่ง ${queue}` : ''}</div>
      <div class="quick">
        <button class="quick-btn quick-scan" onClick=${() => go('scan?mode=info')}><${Icon} name="scan" size=${26} /><span>สแกน AR</span></button>
        <button class="quick-btn" onClick=${() => go('scan?mode=count')}><${Icon} name="count" size=${24} /><span>นับสต็อก</span></button>
        <button class="quick-btn" onClick=${() => go('pick')}><${Icon} name="pick" size=${24} /><span>หยิบของ</span></button>
        <button class="quick-btn warn" onClick=${() => openProblem({}, state.reload)}><${Icon} name="alert" size=${24} /><span>แจ้งปัญหา</span></button>
      </div>
    </header>
    <div class="page-body">
      <${Loader} state=${state} rows=${5}>${(d) => html`
        <div class="stats">
          <${Stat} label="งานที่เปิด" value=${d.open_jobs} icon="layers" sub=${d.due_soon ? `ใกล้ส่ง ${d.due_soon} งาน` : 'งานผลิต (SO)'} onClick=${() => go('prod?tab=jobs')} />
          <${Stat} label="เลยกำหนด" value=${d.overdue} icon="clock" tone=${d.overdue ? 'bad' : 'ok'} sub=${d.overdue ? 'ต้องเร่ง' : 'ไม่มีงานล่าช้า'} onClick=${() => go('prod?tab=jobs')} />
          <${Stat} label="ชิ้นรอผลิต" value=${num(d.wip_total)} icon="factory" tone="warn" sub="ทุกขั้นรวมกัน" onClick=${() => go('prod')} />
          <${Stat} label="เสร็จวันนี้" value=${num(d.done_today)} icon="check" tone="ok" sub=${d.scrap_today ? `เสีย ${num(d.scrap_today)} ชิ้น` : 'ชิ้น (ทุกขั้น)'} />
        </div>
        <div class="home-cols">
        ${d.problems.length ? html`<${Section} title=${`แจ้งปัญหาที่ยังไม่แก้ (${d.problems.length})`}>
          ${d.problems.map((p) => html`<${Problem} p=${p} reload=${state.reload} />`)}</${Section}>` : null}
        ${d.my_queue && d.my_queue.length ? html`<${Section} title=${`คิวของฉัน · ${device.station}`}
          action=${html`<button class="link" onClick=${() => go(`prod?step=${encodeURIComponent(device.station)}`)}>ดูทั้งหมด</button>`}>
          ${d.my_queue.map((q) => html`<${Card} className="q-mini" onClick=${() => openRecord(q, state.reload)}>
            <div class="q-mini-main"><b>${q.code}</b><span>${q.name}</span><small>${q.job_no}${q.overdue ? ' · เลยกำหนด' : q.due_text ? ` · ส่ง ${q.due_text}` : ''}</small></div>
            <div class="q-mini-qty"><b>${num(q.waiting_here)}</b><small>รอ${q.step}</small></div></${Card}>`)}
        </${Section}>` : null}
        <${Section} title="ชิ้นงานรอแต่ละขั้น">
          <${Card} className="wip">${Object.keys(d.wip).length ? Object.entries(d.wip).map(([step, q]) => html`
            <button class="wip-row" onClick=${() => go(`prod?step=${encodeURIComponent(step)}`)}>
              <span class="wip-step">รอ${step}</span>
              <${Bar} value=${d.wip_total ? q / Math.max(...Object.values(d.wip)) : 0} tone=${STEP_TONE[step] || 'navy'} />
              <b>${num(q)}</b></button>`) : html`<p class="muted">ไม่มีชิ้นรอผลิต</p>`}</${Card}>
        </${Section}>
        <${Section} title="งานใกล้กำหนดส่ง" action=${html`<button class="link" onClick=${() => go('prod?tab=jobs')}>ทั้งหมด</button>`}>
          ${d.jobs.length ? d.jobs.map((j) => html`<${JobRow} j=${j} />`) : html`<${Empty} icon="layers" title="ยังไม่มีงานผลิตที่เปิด" text="เปิดงานจาก Part List หรือแบบกระบะที่โปรแกรมบนคอม" />`}
        </${Section}>
        ${d.short_items.length ? html`<${Section} title=${`ชิ้นส่วนขาด (${d.short})`} action=${html`<button class="link" onClick=${() => go('stock?only=short')}>ดูสต็อก</button>`}>
          <${Card}>${d.short_items.map((s) => html`<button class="mini-row" onClick=${() => go(`stock/item/${encodeURIComponent(s.code)}`)}>
            <span><b>${s.code}</b><small>${s.name}</small></span><${Chip} tone="bad">ขาด ${num(s.short)}</${Chip}></button>`)}</${Card}>
        </${Section}>` : null}
        </div>
      `}</${Loader}>
    </div>
  </section>`;
}

export function JobRow({ j }) {
  return html`<${Card} className="job-row" onClick=${() => go(`prod/job/${encodeURIComponent(j.job_no)}`)}>
    <${Ring} value=${j.progress} size=${52} tone=${j.overdue ? 'bad' : j.progress >= 1 ? 'ok' : 'navy'} />
    <div class="job-main"><div class="job-top"><b>${j.job_no}</b>${j.overdue ? html`<${Chip} tone="bad">เลยกำหนด</${Chip}>` : j.days_left !== null && j.days_left <= 3 ? html`<${Chip} tone="warn">อีก ${j.days_left} วัน</${Chip}>` : null}</div>
      <div class="job-title">${j.title || j.model}${j.customer ? ` · ${j.customer}` : ''}</div>
      <div class="job-meta"><span>${num(j.sets)} คัน</span>${j.due_text ? html`<span>ส่ง ${j.due_text}</span>` : null}
        <span>พร้อมประกอบ ${pct(j.ready_pct)}</span></div>
      ${Object.keys(j.waiting).length ? html`<div class="chips-row tight">${Object.entries(j.waiting).map(([s, q]) => html`<${Chip} tone="warn">รอ${s} ${num(q)}</${Chip}>`)}</div>` : null}
    </div><${Icon} name="chev" className="chev" /></${Card}>`;
}

function Problem({ p, reload }) {
  const device = store.state.device || {};
  const solve = async () => {
    try {
      await api.post('solve', { id: p.id });
      feedback.ok();
      toast('ปิดการแจ้งปัญหาแล้ว', 'ok');
      reload();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  return html`<${Card} tone="bad" className="problem">
    <div class="problem-ic"><${Icon} name="alert" /></div>
    <div class="problem-main"><b>${p.text}</b>
      <small>${[p.job_no, p.code, p.step ? `ขั้น${p.step}` : ''].filter(Boolean).join(' · ')}</small>
      <small>${p.by} · ${timeAgo(p.created)}</small></div>
    ${device.role === 'planner' ? html`<${Button} kind="secondary" size="sm" icon="check" onClick=${solve}>แก้แล้ว</${Button}>` : html`<${StatusChip} status=${p.status} />`}
  </${Card}>`;
}
