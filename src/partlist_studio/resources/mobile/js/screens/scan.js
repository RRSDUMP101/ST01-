// The AR camera screen. Modes:
//   info   ส่องป้าย → the part, stock numbers, where it is kept; a job ticket → record the step
//   count  นับสต็อก: tap a label to count it, or count the pieces on a still picture
//   pick   หยิบของ: the slot of the part lights up, arrows from the labels around it, a wrong part sounds the alarm
//   find   นำทางไปที่ตำแหน่งของรหัสหนึ่ง (from the item page)
//   pair   reads the pairing QR shown on the PC
import { api } from '../api.js';
import { autoCount } from '../ar/autocount.js';
import { ARScanner } from '../ar/engine.js';
import { Icon } from '../icons.js';
import { countSession, lookAlike, pickSession } from '../sessions.js';
import { openCount, openRecord } from '../sheets.js';
import { Button, Chip, Seg, Stepper } from '../ui.js';
import { loadOutline, PartVisual } from '../view3d.js';
import { codeFromText } from './pair.js';
import { StoreMap } from './pick.js';
import {
  back, cls, feedback, go, html, local, norm, num, openSheet, toast, unlockAudio, useEffect, useRef, useState, useStore,
} from '../lib.js';

const C = { ok: '#22C55E', bad: '#EF4444', warn: '#F59E0B', info: '#38BDF8', dim: '#94A3B8', navy: '#60A5FA' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function ScanScreen({ route }) {
  const initial = route.params.mode || 'info';
  const [mode, setMode] = useState(initial);
  const [status, setStatus] = useState({ ready: false, error: '' });
  const [seen, setSeen] = useState([]); // resolved labels in view, newest first
  const [torch, setTorch] = useState(false);
  const [still, setStill] = useState(null);
  const [alarm, setAlarm] = useState(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [run, setRun] = useState(0);
  const [map, setMap] = useState(null);
  const pickJob = useStore((s) => s.pickJob);
  const countN = useStore((s) => s.countN);
  const video = useRef(null);
  const canvas = useRef(null);
  const layer = useRef(null);
  const engine = useRef(null);
  const resolved = useRef(new Map());
  const pending = useRef(new Set());
  const modeRef = useRef(mode);
  const target = useRef(null); // pick / find: the line to go to
  const outlines = useRef(new Map());
  const verified = useRef(0);
  const warned = useRef(new Map());
  const [, force] = useState(0);
  modeRef.current = mode;

  // ---- what we are looking for -----------------------------------------------------------------------------
  const refreshTarget = async () => {
    if (modeRef.current === 'pick') {
      const line = pickSession.current();
      target.current = line ? { ...line, qty: line.pick_now } : null;
    } else if (modeRef.current === 'find' && route.params.code) {
      try {
        const it = await api.get('item', { code: route.params.code });
        target.current = { ...it, qty: 0, find: true };
      } catch (e) { toast(e.message, 'bad'); }
    } else {
      target.current = null;
    }
    verified.current = 0;
    const t = target.current;
    if (t && t.has_outline && !outlines.current.has(t.key)) {
      loadOutline(t.outline_code || t.code).then((o) => { outlines.current.set(t.key, o.loops); }).catch(() => {});
    }
    force((n) => n + 1);
  };
  useEffect(() => { refreshTarget(); }, [mode, pickJob]);
  useEffect(() => { api.get('map').then(setMap).catch(() => {}); }, []);

  // ---- labels: ask the PC what each QR is (a few at a time) ----------------------------------------------------
  const resolveSoon = useRef(0);
  const askPC = () => {
    clearTimeout(resolveSoon.current);
    resolveSoon.current = setTimeout(async () => {
      const texts = [...pending.current].filter((t) => !resolved.current.has(t)).slice(0, 30);
      if (!texts.length) return;
      try {
        const ans = await api.post('resolve', { texts });
        for (const r of ans) {
          resolved.current.set(r.text, r);
          pending.current.delete(r.text);
        }
        updateSeen();
      } catch (e) {
        for (const t of texts) pending.current.delete(t);
      }
    }, 120);
  };

  const updateSeen = () => {
    const eng = engine.current;
    if (!eng) return;
    const list = [...eng.tracks.values()].map((t) => resolved.current.get(t.text)).filter(Boolean);
    setSeen(list);
  };

  const onChange = (tracks) => {
    for (const t of tracks) {
      if (modeRef.current === 'pair') {
        const code = codeFromText(t.text);
        if (code) {
          feedback.ok();
          engine.current && engine.current.stop();
          go(`pair?code=${encodeURIComponent(code)}`, true);
          return;
        }
      }
      if (modeRef.current !== 'pair' && !resolved.current.has(t.text) && !pending.current.has(t.text)) {
        pending.current.add(t.text);
        askPC();
      }
    }
    updateSeen();
  };

  // ---- per label: how it looks and the card beside it -----------------------------------------------------------
  const judge = (res) => {
    const t = target.current;
    if (!t || !res || !res.found) return null;
    const tkey = t.key;
    if (res.key && res.key === tkey) return { kind: 'target' };
    if (res.kind === 'location' && t.location && norm(res.location) === norm(t.location)) return { kind: 'target', place: true };
    if (res.key && res.key !== tkey) {
      const like = lookAlike(t.code, res.code);
      if (like) return { kind: 'alike', why: like };
    }
    const here = res.slot; const there = t.slot;
    if (here && there && here.rack && here.rack === there.rack && (here.column || here.level)) {
      let dx = there.column && here.column ? there.column - here.column : 0;
      const dy = there.level && here.level ? there.level - here.level : 0;
      if (!there.slots && there.on_map === false) dx = there.number && here.number ? there.number - here.number : dx;
      const words = [];
      if (dx) words.push(`${dx > 0 ? 'ขวา' : 'ซ้าย'} ${Math.abs(dx)} ช่อง`);
      if (dy) words.push(`${dy > 0 ? 'ขึ้น' : 'ลง'} ${Math.abs(dy)} ชั้น`);
      if (dx || dy) return { kind: 'near', dx, dy, text: words.join(' · ') };
    }
    return { kind: 'other' };
  };

  const look = (track) => {
    const res = resolved.current.get(track.text);
    const m = modeRef.current;
    if (!res) return { color: C.dim, dim: true };
    if (!res.found) return { color: C.dim, dim: true };
    if (m === 'pick' || m === 'find') {
      const j = judge(res);
      if (!j) return { color: C.dim, dim: true };
      if (j.kind === 'target') {
        verified.current = Date.now();
        const loops = outlines.current.get(target.current.key);
        return { color: C.ok, glow: true, pulse: true, target: true, loops: j.place ? null : loops };
      }
      if (j.kind === 'alike') return { color: C.bad, cross: true };
      if (j.kind === 'near') return { color: C.warn, arrow: { dx: j.dx, dy: j.dy } };
      return { color: C.dim, dim: true };
    }
    if (m === 'count') {
      const line = res.key ? countSession.find(res.key) : null;
      return { color: line ? (line.counted === line.system ? C.ok : C.warn) : C.info, glow: !!line };
    }
    const st = (res.item || {}).status || (res.part || {}).status || '';
    if (res.kind === 'job') return { color: C.navy };
    if (res.kind === 'location') return { color: C.info, dim: true };
    return { color: /ขาด|หมด/.test(st) ? C.bad : /Min|ระหว่าง/.test(st) ? C.warn : C.ok };
  };

  const card = (track) => {
    const res = resolved.current.get(track.text);
    const m = modeRef.current;
    if (!res) return { html: '<span class="arc-wait">กำลังอ่าน…</span>', className: 'wait' };
    if (!res.found) return { html: `<span class="arc-sub">${esc(res.message || 'ไม่รู้จัก QR นี้')}</span>`, className: 'unknown' };
    if (m === 'pick' || m === 'find') {
      const j = judge(res);
      const t = target.current;
      if (!j) return null;
      if (j.kind === 'target') {
        const qty = t && t.qty ? `<b class="arc-big">หยิบ ${num(t.qty)} ${esc(t.unit || 'ชิ้น')}</b>` : '<b class="arc-big">อยู่ที่นี่</b>';
        return { html: `${qty}<span class="arc-title">${esc(t.code)}</span><span class="arc-sub">${esc(t.name || '')}</span>`, className: 'target' };
      }
      if (j.kind === 'alike') return { html: `<b class="arc-title">✖ ไม่ใช่ชิ้นนี้</b><span class="arc-sub">${esc(res.code)} – ${esc(j.why)}</span>`, className: 'bad' };
      if (j.kind === 'near') return { html: `<b class="arc-title">${esc(j.text)}</b><span class="arc-sub">ไปช่อง ${esc(t.location)}</span>`, className: 'near' };
      return { html: `<span class="arc-sub">${esc(res.location || res.code)}</span>`, className: 'dimmed' };
    }
    if (m === 'count') {
      if (res.kind === 'job') return { html: `<span class="arc-sub">ใบงาน ${esc(res.code)} – ใช้โหมดข้อมูล</span>`, className: 'dimmed' };
      if (res.kind === 'location') return { html: `<span class="arc-title">📍 ${esc(res.location)}</span><span class="arc-sub">${res.items.length} รายการในช่องนี้</span>`, className: 'dimmed' };
      const it = res.item || {};
      const line = countSession.find(res.key);
      const d = line ? line.counted - line.system : 0;
      return {
        html: `<span class="arc-title">${esc(res.code)}</span><span class="arc-sub">ระบบ ${num(it.on_hand)} ${esc(it.unit || '')}</span>${line
          ? `<b class="arc-count ${d ? 'diff' : 'same'}">นับแล้ว ${num(line.counted)}${d ? ` (${d > 0 ? '+' : ''}${num(d)})` : ' ✓'}</b>`
          : '<span class="arc-cta">แตะเพื่อนับ</span>'}`,
        className: line ? 'counted' : 'tap',
      };
    }
    if (res.kind === 'job') {
      const p = res.part || {};
      return {
        html: `<span class="arc-title">${esc(res.job.job_no)} · ${esc(p.code)}</span><span class="arc-sub">${esc(p.name)}</span>
          <b class="arc-step">${esc(p.status_text)}</b><span class="arc-cta">แตะเพื่อบันทึก${p.next_step ? esc(p.next_step) : ''}</span>`,
        className: 'job tap',
      };
    }
    if (res.kind === 'location') {
      const s = res.slot || {};
      return { html: `<span class="arc-title">📍 ${esc(res.location)}</span><span class="arc-sub">${esc(s.where || s.rack || '')}${res.items.length ? ` · ${res.items.length} รายการ` : ''}</span>`, className: 'loc tap' };
    }
    const it = res.item || {};
    return {
      html: `<span class="arc-title">${esc(res.code)}</span><span class="arc-sub">${esc(res.name)}</span>
        <span class="arc-nums"><b>${num(it.on_hand)}</b> ${esc(it.unit || '')} · ใช้ได้ ${num(it.free)}${it.short ? ` · <em>ขาด ${num(it.short)}</em>` : ''}</span>
        ${res.location ? `<span class="arc-loc">📍 ${esc(res.location)}</span>` : ''}`,
      className: `item tap ${/ขาด|หมด/.test(it.status || '') ? 'bad' : ''}`,
    };
  };

  // ---- tapping a card -------------------------------------------------------------------------------------------
  const onTap = (track) => {
    unlockAudio();
    const res = resolved.current.get(track.text);
    if (!res || !res.found) return;
    const m = modeRef.current;
    if (m === 'pick' || m === 'find') {
      const j = judge(res);
      if (j && j.kind === 'target') confirmPick(true);
      else if (j && j.kind === 'alike') raise(res, j.why);
      return;
    }
    if (m === 'count') {
      if (res.kind === 'item') openCount(res.item, { location: res.location, method: 'ar', onTapCount: () => freeze(res), visual: false });
      return;
    }
    if (res.kind === 'job') openRecord({ ...res.part, job_title: res.job.title });
    else if (res.kind === 'item') openSheet(() => html`<${InfoSheet} res=${res} />`, { title: res.code });
    else if (res.kind === 'location') openSheet(() => html`<${LocationSheet} res=${res} />`, { title: `ตำแหน่ง ${res.location}` });
  };

  const raise = (res, why) => {
    feedback.error();
    setAlarm({ code: res.code, why, want: target.current ? target.current.code : '' });
    setTimeout(() => setAlarm(null), 3800);
  };

  // ---- pick: confirm, skip, next ------------------------------------------------------------------------------------
  const [qty, setQtyState] = useState(0);
  const qtyRef = useRef(0);
  const setQty = (v) => { qtyRef.current = v; setQtyState(v); };
  useEffect(() => { setQty(target.current && target.current.qty ? target.current.qty : 0); }, [target.current && target.current.index, target.current && target.current.key]);
  const inView = seen.some((r) => { const j = judge(r); return j && j.kind === 'target'; });
  const wrongInView = seen.find((r) => { const j = judge(r); return j && j.kind === 'alike'; });
  useEffect(() => {
    if (inView) feedback.found();
  }, [inView, target.current && target.current.index]);
  useEffect(() => {
    if (!wrongInView || inView) return;
    const last = warned.current.get(wrongInView.text) || 0;
    if (Date.now() - last > 6000) {
      warned.current.set(wrongInView.text, Date.now());
      feedback.warn();
    }
  }, [wrongInView && wrongInView.text, inView]);

  const confirmPick = (byScan) => {
    const t = target.current;
    if (!t) return;
    if (modeRef.current === 'find') {
      feedback.ok();
      toast(`พบ ${t.code} ที่ ${t.location}`, 'ok');
      return;
    }
    const ok = byScan || Date.now() - verified.current < 4000;
    if (!ok && !confirm('ยังไม่ได้สแกนยืนยันป้ายของชิ้นนี้ – บันทึกว่าหยิบแล้วหรือไม่?')) return;
    const n = qtyRef.current || t.qty;
    pickSession.pick(t.index, n, ok);
    feedback.ok();
    toast(`หยิบ ${t.code} ${num(n)} ${t.unit || 'ชิ้น'} ✓`, 'ok');
    refreshTarget();
  };
  const skip = () => {
    const t = target.current;
    if (!t) return;
    pickSession.skip(t.index);
    refreshTarget();
  };

  // ---- count by tapping a still picture ----------------------------------------------------------------------------
  const freeze = (res) => {
    if (!engine.current) return;
    const shot = engine.current.still();
    const items = [...resolved.current.values()].filter((r) => r.kind === 'item' && r.found && shot.tracks.some((t) => t.text === r.text))
      .map((r) => ({ ...r.item, location: r.location || r.item.location }));
    setStill({ ...shot, res, items });
  };

  // ---- camera on / off ------------------------------------------------------------------------------------------------
  useEffect(() => {
    let eng = null;
    let cancelled = false;
    const start = async () => {
      eng = new ARScanner({
        video: video.current, canvas: canvas.current, layer: layer.current, engine: local.get('engine', 'auto'),
        hd: !!local.get('hd', false), look, card, onTap, onChange,
        onStatus: (s) => setStatus((old) => ({ ...old, ...s })),
      });
      engine.current = eng;
      try {
        await eng.start();
        if (cancelled) eng.stop();
      } catch (e) {
        setStatus({ ready: false, error: e.message });
      }
    };
    start();
    const vis = () => { if (document.hidden && eng) { eng.stop(); setStatus({ ready: false, error: '', paused: true }); } };
    setStatus({ ready: false, error: '' });
    document.addEventListener('visibilitychange', vis);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', vis);
      if (eng) eng.stop();
      engine.current = null;
    };
  }, [run]);

  const t = target.current;
  const progress = mode === 'pick' ? (() => {
    const s = pickSession.get();
    if (!s) return null;
    const pos = t ? s.lines.findIndex((l) => l.index === t.index) + 1 : 0;
    return { done: Object.keys(s.picked).length, total: s.lines.length, pos };
  })() : null;
  const modes = [['info', 'ข้อมูล'], ['count', 'นับ', countN || ''], ['pick', 'หยิบ']];
  const changeMode = (m) => {
    if (m === 'pick' && !pickSession.get()) { toast('เลือกงานที่จะหยิบก่อน', 'info'); go('pick'); return; }
    setMode(m);
    history.replaceState(null, '', `#/scan?mode=${m}`);
  };
  const hereRack = (seen.find((r) => r.slot && r.slot.rack) || {}).slot;

  return html`<section class=${cls('ar-screen', `mode-${mode}`)}>
    <video ref=${video} class="ar-video" playsinline muted autoplay></video>
    <canvas ref=${canvas} class="ar-canvas"></canvas>
    <div ref=${layer} class="ar-layer"></div>
    <div class="ar-top">
      <button class="ar-btn" aria-label="กลับ" onClick=${() => back('home')}><${Icon} name="back" /></button>
      ${mode === 'pair' || mode === 'find' ? html`<div class="ar-title">${mode === 'pair' ? 'สแกน QR จับคู่บนจอคอม' : 'นำทางไปตำแหน่งเก็บ'}</div>`
    : html`<${Seg} options=${modes} value=${mode} onChange=${changeMode} className="ar-seg" />`}
      ${engine.current && engine.current.canTorch ? html`<button class=${cls('ar-btn', torch && 'on')} aria-label="ไฟฉาย"
        onClick=${async () => { const ok = await engine.current.setTorch(!torch); if (ok) setTorch(!torch); }}><${Icon} name="torch" /></button>`
    : html`<button class="ar-btn" aria-label="ผังสโตร์" onClick=${() => setMapOpen(!mapOpen)}><${Icon} name="map" /></button>`}
    </div>
    ${status.error ? html`<div class="ar-error"><${Icon} name="camera" size=${40} stroke=${1.5} /><h3>เปิดกล้องไม่ได้</h3><p>${status.error}</p>
      <${Button} kind="secondary" onClick=${() => setRun((n) => n + 1)}>ลองอีกครั้ง</${Button}></div>` : null}
    ${status.paused ? html`<div class="ar-error"><${Icon} name="camera" size=${40} stroke=${1.5} /><h3>หยุดกล้องชั่วคราว</h3>
      <${Button} onClick=${() => setRun((n) => n + 1)}>เปิดกล้องอีกครั้ง</${Button}></div>` : null}
    ${!status.error && !seen.length ? html`<div class="ar-hint"><span class="reticle"></span>
      <p>${{ info: 'ส่องกล้องไปที่ป้าย QR ชั้นวาง หรือใบงาน', count: 'ส่องป้าย QR ที่ชั้นวาง แล้วแตะการ์ดเพื่อนับ', pick: 'ส่องป้าย QR ที่ชั้นวาง ระบบจะชี้ไปยังช่องที่ต้องหยิบ', find: 'ส่องป้าย QR ที่ชั้นวาง ระบบจะชี้ไปยังช่องนั้น', pair: 'ส่อง QR ที่หน้า มือถือ & AR บนคอม' }[mode]}</p>
      ${status.ready ? null : html`<small>กำลังเตรียมตัวอ่าน QR…</small>`}</div>` : null}
    ${alarm ? html`<div class="ar-alarm" role="alert"><${Icon} name="alert" size=${42} stroke=${2.4} /><b>ผิดรุ่น! อย่าหยิบชิ้นนี้</b>
      <span>สแกนได้ <em>${alarm.code}</em> – ${alarm.why}</span><span>ต้องการ <em>${alarm.want}</em></span></div>` : null}
    ${mapOpen ? html`<div class="ar-map" onClick=${() => setMapOpen(false)}><div class="ar-map-card" onClick=${(e) => e.stopPropagation()}>
      <div class="row-between"><b>ผังสโตร์</b><button class="icon-btn" onClick=${() => setMapOpen(false)}><${Icon} name="close" /></button></div>
      <${StoreMap} map=${map} here=${hereRack ? hereRack.rack : ''} target=${t && t.slot ? t.slot.rack : ''} />
      ${t && t.slot ? html`<p class="muted small">${t.slot.where || `ชั้นวาง ${t.slot.rack}`}${t.slot.level ? ` · ชั้นที่ ${t.slot.level} จากล่าง` : ''}</p>` : null}</div></div>` : null}

    ${(mode === 'pick' || mode === 'find') ? html`<div class="ar-panel pick-panel">
      ${t ? html`
        ${progress ? html`<div class="pp-progress"><span>รายการที่ ${progress.pos}/${progress.total} · หยิบแล้ว ${progress.done}</span><div class="bar thin t-ok"><span style=${`width:${(progress.done / Math.max(1, progress.total)) * 100}%`}></span></div></div>` : null}
        <div class="pp-main">
          <div class="pp-visual">${t.has_outline || t.has_image ? html`<${PartVisual} item=${t} height=${72} compact />` : html`<${Icon} name="box" size=${32} stroke=${1.4} />`}</div>
          <div class="pp-text"><b class="pp-code">${t.code}</b><span>${t.name}</span>
            <div class="chips-row tight">${t.side ? html`<${Chip} tone=${t.side === 'ซ้าย' ? 'info' : 'violet'}>${t.side}</${Chip}>` : null}
              <${Chip} icon="tag" tone=${t.location ? 'navy' : 'muted'}>${t.location || 'ไม่มีตำแหน่ง'}</${Chip}></div></div>
        </div>
        <div class=${cls('pp-state', inView ? 'ok' : wrongInView ? 'bad' : '')}>
          ${inView ? html`<${Icon} name="check" size=${18} stroke=${3} /> เจอแล้ว – ป้ายตรงกับชิ้นที่ต้องหยิบ`
    : wrongInView ? html`<${Icon} name="alert" size=${18} /> ป้ายที่เห็นไม่ใช่ชิ้นนี้ (${wrongInView.code})`
      : html`<${Icon} name="target" size=${18} /> ${t.slot && t.slot.where ? `ไป ${t.slot.where}` : t.location ? `ไปช่อง ${t.location}` : 'ส่องป้ายของชิ้นเพื่อยืนยัน'}`}</div>
        ${mode === 'pick' ? html`<div class="pp-actions">
          <${Stepper} value=${qty} onChange=${setQty} min=${1} max=${Math.max(1, t.need || t.qty || 1)} />
          <${Button} size="lg" kind=${inView ? 'ok' : 'secondary'} icon="check" onClick=${() => confirmPick(false)}>หยิบแล้ว</${Button}>
          <button class="link" onClick=${skip}>ข้าม</button></div>` : null}`
    : html`<div class="pp-done"><${Icon} name="check" size=${30} stroke=${2.6} /><b>${mode === 'find' ? 'ไม่พบรายการ' : 'หยิบครบทุกรายการแล้ว'}</b>
          ${mode === 'pick' ? html`<${Button} kind="ok" icon="send" onClick=${() => go(`pick/job/${encodeURIComponent(pickJob)}`)}>ตรวจและส่งรายการหยิบ</${Button}>` : null}</div>`}
    </div>` : null}

    ${mode === 'count' ? html`<div class="ar-panel">
      <div class="row-between"><span><b>นับแล้ว ${countN || 0} รายการ</b><small class="muted"> · แตะการ์ดบนป้ายเพื่อนับ</small></span>
        <${Button} size="sm" kind="secondary" icon="list" onClick=${() => go('count')}>รายการนับ</${Button}></div>
      <div class="btn-row"><${Button} kind="secondary" icon="hand" disabled=${!engine.current} onClick=${() => freeze(seen.find((r) => r.kind === 'item') || null)}>นับจากภาพ (แตะทีละชิ้น)</${Button}></div>
    </div>` : null}

    ${mode === 'info' && seen.length ? html`<div class="ar-panel">
      <div class="seen-strip">${seen.slice(0, 8).map((r) => html`<button class="seen" onClick=${() => onTap({ text: r.text })}>
        <b>${r.kind === 'job' ? `${r.job.job_no}` : r.kind === 'location' ? `📍 ${r.location}` : r.code || 'QR'}</b>
        <small>${r.found ? (r.kind === 'job' ? r.part.status_text : r.name || '') : 'ไม่รู้จัก'}</small></button>`)}</div></div>` : null}

    ${still ? html`<${TapCount} shot=${still} onClose=${() => setStill(null)} />` : null}
  </section>`;
}

function InfoSheet({ res }) {
  const it = res.item || {};
  return html`<div class="rec">
    <div class="rec-head"><div><div class="rec-name">${it.name}</div><div class="rec-sub">${it.group_name || it.type_name || ''}</div></div></div>
    <${PartVisual} item=${it} height=${170} />
    <div class="six compact">
      <div class="six-cell"><span>พร้อมประกอบ</span><b>${num(it.on_hand)}</b></div>
      <div class="six-cell"><span>ใช้ได้</span><b>${num(it.free)}</b></div>
      <div class=${`six-cell ${it.short ? 'bad' : ''}`}><span>ขาด</span><b>${num(it.short)}</b></div>
    </div>
    ${it.wip_text ? html`<p class="muted small">ระหว่างผลิต: ${it.wip_text}</p>` : null}
    <div class="btn-row">
      <${Button} kind="secondary" icon="count" onClick=${() => openCount(it, { location: res.location, method: 'ar' })}>นับรายการนี้</${Button}>
      <${Button} icon="info" onClick=${() => go(`stock/item/${encodeURIComponent(it.code)}`)}>ดูรายละเอียด</${Button}>
    </div></div>`;
}

function LocationSheet({ res }) {
  return html`<div class="rec">
    <p class="muted">${(res.slot || {}).where || (res.slot || {}).rack || ''}</p>
    ${res.items.length ? res.items.map((i) => html`<button class="mini-row" onClick=${() => go(`stock/item/${encodeURIComponent(i.code)}`)}>
      <span><b>${i.code}</b><small>${i.name}</small></span><b>${num(i.on_hand)}</b></button>`) : html`<p class="muted">ยังไม่มีรายการที่ตั้งตำแหน่งนี้</p>`}
  </div>`;
}

// count pieces on a still picture: tap each one, a number appears on it; tap a number to take it away.
// นับอัตโนมัติ: tap one sample piece and set its size - every place that looks like it gets a dot, then fix by hand.
function TapCount({ shot, onClose }) {
  const items = shot.items || [];
  const [dots, setDots] = useState([]);
  const [item, setItem] = useState(shot.res && shot.res.item ? shot.res.item : (items.length === 1 ? items[0] : null));
  const [auto, setAuto] = useState(null); // {x, y, r, sens} while choosing the sample
  const [busy, setBusy] = useState(false);
  const img = useRef(null);
  const [src] = useState(() => shot.canvas.toDataURL('image/jpeg', 0.85));
  const at = (e) => {
    const r = img.current.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  const tap = (e) => {
    const [x, y] = at(e);
    if (x < 0 || y < 0 || x > 1 || y > 1) return;
    feedback.tick();
    if (auto && auto.picking) { setAuto({ ...auto, x, y, picking: false }); return; }
    setDots((d) => [...d, { x, y, auto: false }]);
  };
  const find = (opts = auto) => {
    if (!opts || opts.x === undefined) return;
    setBusy(true);
    setTimeout(() => {
      try {
        const found = autoCount(shot.canvas, { x: opts.x, y: opts.y, r: opts.r }, opts.sens);
        const manual = dots.filter((d) => !d.auto);
        setDots([...found.map((f) => ({ x: f.x, y: f.y, auto: true })), ...manual]);
        if (found.length) feedback.found();
        toast(found.length ? `พบ ${found.length} ชิ้นที่เหมือนตัวอย่าง – แตะจุดที่ผิดเพื่อเอาออก แตะที่ว่างเพื่อเพิ่ม` : 'ไม่พบชิ้นที่เหมือนตัวอย่าง – ลองปรับขนาดหรือความไว', found.length ? 'ok' : 'warn', 3600);
      } finally {
        setBusy(false);
      }
    }, 30);
  };
  const use = () => {
    if (!item) { toast('เลือกรายการที่นับก่อน', 'warn'); return; }
    onClose();
    openCount(item, { value: dots.length, method: dots.some((d) => d.auto) ? 'auto' : 'tap', location: item.location, visual: false });
  };
  const ratio = shot.canvas.height / shot.canvas.width;
  return html`<div class="tapcount">
    <div class="tc-top"><button class="ar-btn" onClick=${onClose} aria-label="ปิด"><${Icon} name="close" /></button>
      <div class="tc-count"><b>${dots.length}</b><span>ชิ้น</span></div>
      <button class="ar-btn" onClick=${() => setDots((d) => d.slice(0, -1))} aria-label="ย้อน"><${Icon} name="back" /></button></div>
    <div class="tc-stage"><div class="tc-img" onClick=${tap}>
      <img ref=${img} src=${src} alt="ภาพที่หยุดไว้" draggable="false" />
      ${auto && auto.x !== undefined ? html`<span class="tc-sample" style=${`left:${auto.x * 100}%;top:${auto.y * 100}%;width:${auto.r * 200}%;height:${(auto.r * 200) / ratio}%`}></span>` : null}
      ${dots.map((d, i) => html`<button class=${`tc-dot ${d.auto ? 'auto' : ''}`} style=${`left:${d.x * 100}%;top:${d.y * 100}%`}
        onClick=${(e) => { e.stopPropagation(); feedback.tick(); setDots((all) => all.filter((_, k) => k !== i)); }}>${i + 1}</button>`)}
    </div></div>
    <div class="tc-bottom">
      ${items.length > 1 ? html`<div class="chips-row tight">${items.map((it) => html`<button class=${`chip tap ${item && item.key === it.key ? 'active' : ''}`}
        onClick=${() => setItem(it)}>${it.code}</button>`)}</div>` : html`<p>${item ? html`นับ <b>${item.code}</b> ${item.name || ''}` : 'แตะบนชิ้นงานทีละชิ้น'}</p>`}
      ${auto ? html`<div class="tc-auto">
          <p class="small">${auto.picking ? '① แตะชิ้นตัวอย่าง 1 ชิ้นในภาพ' : '② ปรับวงให้พอดีกับชิ้น แล้วกด หาชิ้นที่เหมือนกัน'}</p>
          <label class="tc-slider"><span>ขนาด</span><input type="range" min="0.01" max="0.16" step="0.002" value=${auto.r}
            onInput=${(e) => setAuto({ ...auto, r: Number(e.target.value) })} /></label>
          <label class="tc-slider"><span>ความไว</span><input type="range" min="0" max="1" step="0.05" value=${auto.sens}
            onInput=${(e) => setAuto({ ...auto, sens: Number(e.target.value) })} onChange=${(e) => { if (dots.some((d) => d.auto)) find({ ...auto, sens: Number(e.target.value) }); }} /></label>
          <div class="btn-row"><${Button} kind="secondary" onClick=${() => setAuto(null)}>ปิด</${Button}>
            <${Button} kind="ok" icon="target" disabled=${busy || auto.picking} onClick=${() => find()}>${busy ? 'กำลังหา…' : 'หาชิ้นที่เหมือนกัน'}</${Button}></div></div>`
    : html`<div class="btn-row"><${Button} kind="secondary" onClick=${() => setDots([])}>ล้าง</${Button}>
          <${Button} kind="secondary" icon="target" onClick=${() => setAuto({ picking: true, r: 0.04, sens: 0.5 })}>นับอัตโนมัติ</${Button}>
          <${Button} kind="ok" icon="check" disabled=${!dots.length} onClick=${use}>ใช้จำนวน ${dots.length}</${Button}></div>`}
    </div></div>`;
}
