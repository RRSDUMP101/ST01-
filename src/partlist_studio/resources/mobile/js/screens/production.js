// Production: the queue of every station (pieces waiting at a step), the jobs and one job with its parts.
import { useData } from '../api.js';
import { Icon } from '../icons.js';
import { openProblem, openRecord } from '../sheets.js';
import { Bar, Card, Chip, Empty, IconButton, Loader, Page, Ring, Section, Seg, Steps, StatusChip } from '../ui.js';
import { JobRow } from './home.js';
import { clock, go, html, local, num, pct, useState, useStore } from '../lib.js';

export function ProductionScreen({ route }) {
  const device = useStore((s) => s.device) || {};
  const [tab, setTab] = useState(route.params.tab === 'jobs' ? 'jobs' : 'queue');
  const [step, setStepState] = useState(route.params.step || local.get('step', '') || device.station || 'ตัด');
  const setStep = (s) => { setStepState(s); local.set('step', s); };
  const stations = useData('stations');
  return html`<${Page} title="งานผลิต" sub="คิวสถานี · บันทึกเสร็จ 2 แตะ"
    actions=${html`<${IconButton} icon="scan" label="สแกนใบงาน" onClick=${() => go('scan?mode=info')} />`}>
    <${Seg} options=${[['queue', 'คิวสถานี'], ['jobs', 'งานทั้งหมด']]} value=${tab} onChange=${setTab} />
    ${tab === 'queue' ? html`
      <div class="station-strip">${(stations.data || []).map((s) => html`<button class=${`station ${s.step === step ? 'on' : ''}`} onClick=${() => setStep(s.step)}>
        <span>${s.step}</span><b>${num(s.pieces)}</b><small>${s.lines} รายการ</small></button>`)}</div>
      <${Queue} step=${step} />` : html`<${Jobs} />`}
  </${Page}>`;
}

function Queue({ step }) {
  const state = useData('queue', { step });
  return html`<${Loader} state=${state} rows=${5}>${(rows) => (rows.length ? html`
    <p class="muted small">${rows.length} รายการรอ${step} · งานเลยกำหนดขึ้นก่อน แตะเพื่อบันทึก</p>
    ${rows.map((q) => html`<${Card} className=${`queue-card ${q.overdue ? 'late' : ''}`} onClick=${() => openRecord(q, state.reload)}>
      <div class="qc-top"><span class="qc-job">${q.job_no}</span>${q.overdue ? html`<${Chip} tone="bad">เลยกำหนด</${Chip}>` : q.due_text ? html`<span class="qc-due">ส่ง ${q.due_text}</span>` : null}</div>
      <div class="qc-body"><div class="qc-main"><b>${q.code}</b><span>${q.name}</span>
        ${q.location ? html`<small><${Icon} name="tag" size=${13} /> ${q.location}</small>` : null}</div>
        <div class="qc-qty"><b>${num(q.waiting_here)}</b><small>${q.unit || 'ชิ้น'} รอ${step}</small></div></div>
      <${Steps} route=${q.route} current=${step} />
    </${Card}>`)}` : html`<${Empty} icon="check" title=${`ไม่มีชิ้นรอ${step}`} text="สถานีนี้ว่าง – เลือกสถานีอื่นด้านบน" />`)}</${Loader}>`;
}

function Jobs() {
  const [all, setAll] = useState(false);
  const state = useData('jobs', all ? { all: '1' } : null);
  return html`<div class="row-between"><span class="muted small">${state.data ? `${state.data.length} งาน` : ''}</span>
    <label class="switch"><input type="checkbox" checked=${all} onChange=${(e) => setAll(e.target.checked)} /><span>รวมงานที่ปิดแล้ว</span></label></div>
    <${Loader} state=${state} rows=${4}>${(jobs) => (jobs.length ? jobs.map((j) => html`<${JobRow} j=${j} />`)
    : html`<${Empty} icon="layers" title="ยังไม่มีงานผลิต" text="เปิดงานที่โปรแกรมบนคอม (หน้า งานผลิต SO)" />`)}</${Loader}>`;
}

export function JobScreen({ route }) {
  const no = route.parts[2] || '';
  const state = useData('job', { no });
  const [filter, setFilter] = useState('make');
  return html`<${Page} title=${no} sub="รายละเอียดงานผลิต" backTo="prod?tab=jobs"
    actions=${html`<${IconButton} icon="alert" label="แจ้งปัญหา" onClick=${() => openProblem({ job_no: no })} />`}>
    <${Loader} state=${state} rows=${6}>${(j) => {
      const parts = j.parts_list.filter((p) => (filter === 'all' ? true : filter === 'done' ? ['เสร็จ', 'ใช้จากสต็อก'].includes(p.status) : p.to_make > 0 && p.status !== 'เสร็จ'));
      return html`
      <${Card} className="job-hero">
        <${Ring} value=${j.progress} size=${86} stroke=${9} tone=${j.overdue ? 'bad' : j.progress >= 1 ? 'ok' : 'navy'} />
        <div><h2>${j.title}</h2><p class="muted">${[j.customer, j.vehicle, `${num(j.sets)} คัน`].filter(Boolean).join(' · ')}</p>
          <div class="chips-row tight"><${StatusChip} status=${j.status} />${j.overdue ? html`<${Chip} tone="bad">เลยกำหนด</${Chip}>` : null}
          ${j.due_text ? html`<${Chip} icon="clock">ส่ง ${j.due_text}</${Chip}>` : null}</div></div>
      </${Card}>
      <${Section} title=${`ความพร้อมประกอบ ${pct(j.ready_pct)}`}>
        <${Card}>${j.groups.map((g) => html`<div class="ready-row"><div class="ready-top"><b>${g.name}</b><span>${pct(g.pct)}</span></div>
          <${Bar} value=${g.pct} tone=${g.complete ? 'ok' : g.pct > 0.6 ? 'warn' : 'bad'} />
          ${g.missing ? html`<small class="muted">ขาด: ${g.missing}</small>` : null}</div>`)}</${Card}>
      </${Section}>
      <${Section} title="ชิ้นส่วน">
        <${Seg} options=${[['make', 'กำลังผลิต'], ['done', 'เสร็จ'], ['all', 'ทั้งหมด']]} value=${filter} onChange=${setFilter} className="small" />
        ${parts.length ? parts.map((p) => html`<${Card} className="part-card" onClick=${() => openRecord({ ...p, job_title: j.title }, state.reload)}>
          <div class="pc-top"><div><b>${p.code}</b><span>${p.name}</span></div><${StatusChip} status=${p.status} /></div>
          <div class="pc-meta"><span>ต้องผลิต ${num(p.to_make)}</span>${p.from_stock ? html`<span>ใช้สต็อก ${num(p.from_stock)}</span>` : null}
            ${p.scrapped ? html`<span class="bad">เสีย ${num(p.scrapped)}</span>` : null}${p.location ? html`<span>📍 ${p.location}</span>` : null}</div>
          ${p.route.length ? html`<${Steps} route=${p.route} />` : null}
        </${Card}>`) : html`<${Empty} icon="check" title="ไม่มีรายการ" />`}
      </${Section}>
      ${j.log.length ? html`<${Section} title="บันทึกล่าสุด"><${Card} className="log">${j.log.slice(0, 12).map((e) => html`<div class="log-row">
        <span class="log-time">${clock(e.when)}</span><span class="log-main"><b>${e.step}</b> ${num(e.qty)} · ${e.code}<small>${e.by || 'คอม'}${e.note ? ` · ${e.note}` : ''}</small></span></div>`)}</${Card}></${Section}>` : null}
    `;
    }}</${Loader}>
  </${Page}>`;
}
