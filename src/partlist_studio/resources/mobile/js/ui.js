// Building blocks of every screen.
import { Icon } from './icons.js';
import { back as goBack, closeSheet, cls, html, num, tone, useEffect, useRef, useState, useStore } from './lib.js';

export function Page({ title, sub, backTo, actions, children, className = '' }) {
  return html`<section class=${cls('page', className)}>
    <header class="page-head">
      ${backTo !== undefined ? html`<button class="icon-btn" aria-label="กลับ" onClick=${() => goBack(backTo)}>
        <${Icon} name="back" /></button>` : null}
      <div class="page-title"><h1>${title}</h1>${sub ? html`<p>${sub}</p>` : null}</div>
      <div class="page-actions">${actions}</div>
    </header>
    <div class="page-body">${children}</div>
  </section>`;
}

export function Section({ title, action, children, className = '' }) {
  return html`<div class=${cls('section', className)}>
    ${title ? html`<div class="section-head"><h2>${title}</h2>${action || null}</div>` : null}
    ${children}
  </div>`;
}

export function Card({ children, className = '', onClick, tone: t }) {
  return html`<div class=${cls('card', t && `tone-${t}`, onClick && 'tap', className)} onClick=${onClick}
    role=${onClick ? 'button' : undefined} tabIndex=${onClick ? 0 : undefined}>${children}</div>`;
}

export function Chip({ children, tone: t = 'muted', icon, onClick, active, className = '' }) {
  const Tag = onClick ? 'button' : 'span';
  return html`<${Tag} class=${cls('chip', `t-${t}`, active && 'active', onClick && 'tap', className)} onClick=${onClick}>
    ${icon ? html`<${Icon} name=${icon} size=${15} />` : null}${children}</${Tag}>`;
}

export function StatusChip({ status }) {
  return status ? html`<${Chip} tone=${tone(status)}>${status}</${Chip}>` : null;
}

export function Seg({ options, value, onChange, className = '' }) {
  return html`<div class=${cls('seg', className)} role="tablist">
    ${options.map(([key, label, badge]) => html`<button role="tab" aria-selected=${value === key}
      class=${cls('seg-btn', value === key && 'on')} onClick=${() => onChange(key)}>${label}
      ${badge ? html`<span class="seg-badge">${badge}</span>` : null}</button>`)}
  </div>`;
}

export function Stat({ label, value, sub, icon, tone: t = 'navy', onClick }) {
  return html`<div class=${cls('stat', `t-${t}`, onClick && 'tap')} onClick=${onClick} role=${onClick ? 'button' : undefined}>
    <div class="stat-top">${icon ? html`<span class="stat-ic"><${Icon} name=${icon} size=${18} /></span>` : null}
      <span class="stat-label">${label}</span></div>
    <div class="stat-value">${value}</div>${sub ? html`<div class="stat-sub">${sub}</div>` : null}
  </div>`;
}

export function Ring({ value = 0, size = 56, stroke = 6, tone: t = 'navy', label }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  return html`<div class=${`ring t-${t}`} style=${`width:${size}px;height:${size}px`}>
    <svg width=${size} height=${size} viewBox=${`0 0 ${size} ${size}`}>
      <circle cx=${size / 2} cy=${size / 2} r=${r} class="ring-bg" stroke-width=${stroke} fill="none" />
      <circle cx=${size / 2} cy=${size / 2} r=${r} class="ring-fg" stroke-width=${stroke} fill="none"
        stroke-dasharray=${`${c * v} ${c}`} stroke-linecap="round" transform=${`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg><span class="ring-label">${label !== undefined ? label : `${Math.round(v * 100)}%`}</span></div>`;
}

export function Bar({ value = 0, tone: t = 'navy', thin }) {
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  return html`<div class=${cls('bar', thin && 'thin', `t-${t}`)}><span style=${`width:${(v * 100).toFixed(1)}%`}></span></div>`;
}

export function Steps({ route, current }) {
  return html`<div class="steps">${(route || []).map((s) => {
    const done = s.waiting <= 0 && s.done > 0;
    const here = s.step === current || (!current && s.waiting > 0);
    return html`<span class=${cls('step', done && 'done', here && 'here')}>
      ${done ? html`<${Icon} name="check" size=${13} stroke=${3} />` : null}${s.step}
      ${s.waiting > 0 ? html`<b>${num(s.waiting)}</b>` : null}</span>`;
  })}</div>`;
}

export function Button({ children, kind = 'primary', size = '', icon, onClick, disabled, block, type = 'button', className = '' }) {
  return html`<button type=${type} class=${cls('btn', `btn-${kind}`, size && `btn-${size}`, block && 'block', className)}
    onClick=${onClick} disabled=${disabled}>${icon ? html`<${Icon} name=${icon} size=${size === 'xl' ? 26 : 20} />` : null}
    ${children ? html`<span>${children}</span>` : null}</button>`;
}

export function IconButton({ icon, label, onClick, className = '', badge }) {
  return html`<button class=${cls('icon-btn', className)} aria-label=${label} title=${label} onClick=${onClick}>
    <${Icon} name=${icon} />${badge ? html`<span class="dot-badge">${badge}</span>` : null}</button>`;
}

export function Stepper({ value, onChange, min = 0, max = 1e6, big }) {
  const set = (v) => onChange(Math.max(min, Math.min(max, Math.round((Number(v) || 0) * 1000) / 1000)));
  return html`<div class=${cls('stepper', big && 'big')}>
    <button class="step-btn" aria-label="ลด" onClick=${() => set(value - 1)} disabled=${value <= min}><${Icon} name="minus" size=${26} stroke=${2.6} /></button>
    <input type="number" inputmode="decimal" value=${value} min=${min} max=${max}
      onInput=${(e) => { if (e.target.value !== '') set(e.target.value); }}
      onFocus=${(e) => e.target.select()} />
    <button class="step-btn" aria-label="เพิ่ม" onClick=${() => set(value + 1)} disabled=${value >= max}><${Icon} name="plus" size=${26} stroke=${2.6} /></button>
  </div>`;
}

export function Empty({ icon = 'info', title, text, action }) {
  return html`<div class="empty"><span class="empty-ic"><${Icon} name=${icon} size=${34} stroke=${1.6} /></span>
    <h3>${title}</h3>${text ? html`<p>${text}</p>` : null}${action || null}</div>`;
}

export function Spinner({ text }) {
  return html`<div class="spinner-wrap"><span class="spinner"></span>${text ? html`<span>${text}</span>` : null}</div>`;
}

export function Skeleton({ rows = 4 }) {
  return html`<div class="skeleton">${Array.from({ length: rows }, (_, i) => html`<div class="sk-row" style=${`animation-delay:${i * 80}ms`}></div>`)}</div>`;
}

// loading / error / empty around the data of a screen
export function Loader({ state, children, rows = 4, empty }) {
  if (state.loading && !state.data) return html`<${Skeleton} rows=${rows} />`;
  if (state.error && !state.data) {
    return html`<${Empty} icon=${state.error.status === 0 ? 'wifioff' : 'alert'} title="โหลดข้อมูลไม่ได้"
      text=${state.error.message} action=${html`<${Button} kind="secondary" icon="refresh" onClick=${state.reload}>ลองอีกครั้ง</${Button}>`} />`;
  }
  if (empty && empty(state.data)) return typeof empty.view === 'function' ? empty.view() : null;
  return children(state.data);
}

export function Field({ label, hint, children }) {
  return html`<label class="field"><span class="field-label">${label}</span>${children}${hint ? html`<span class="field-hint">${hint}</span>` : null}</label>`;
}

export function KV({ items }) {
  return html`<dl class="kv">${items.filter((x) => x && x[1] !== '' && x[1] !== undefined && x[1] !== null).map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
}

// ---- hosts: one toast and one bottom sheet for the whole app --------------------------------------------------
export function ToastHost() {
  const t = useStore((s) => s.toast);
  if (!t) return null;
  return html`<div class=${cls('toast', `t-${t.kind}`)} role="status" key=${t.id}>
    <${Icon} name=${t.kind === 'ok' ? 'check' : t.kind === 'bad' ? 'alert' : t.kind === 'warn' ? 'alert' : 'info'} size=${18} />
    <span>${t.text}</span></div>`;
}

export function SheetHost() {
  const sheet = useStore((s) => s.sheet);
  const [closing, setClosing] = useState(false);
  const panel = useRef(null);
  const drag = useRef(null);
  useEffect(() => { setClosing(false); }, [sheet && sheet.id]);
  useEffect(() => {
    if (!sheet) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet && sheet.id]);
  if (!sheet) return null;
  const close = () => {
    if (sheet.onClose) sheet.onClose();
    setClosing(true);
    setTimeout(() => closeSheet(), 180);
  };
  const down = (e) => {
    if (!e.target.closest('.sheet-grab')) return;
    drag.current = { y: e.clientY, dy: 0 };
  };
  const move = (e) => {
    if (!drag.current || !panel.current) return;
    drag.current.dy = Math.max(0, e.clientY - drag.current.y);
    panel.current.style.transform = `translateY(${drag.current.dy}px)`;
  };
  const up = () => {
    if (!drag.current || !panel.current) return;
    const far = drag.current.dy > 90;
    panel.current.style.transform = '';
    drag.current = null;
    if (far) close();
  };
  return html`<div class=${cls('sheet-wrap', closing && 'closing', sheet.full && 'full')} onPointerMove=${move} onPointerUp=${up}>
    <div class="sheet-backdrop" onClick=${close}></div>
    <div class="sheet" ref=${panel} role="dialog" aria-modal="true" onPointerDown=${down}>
      <div class="sheet-grab"><span></span></div>
      ${sheet.title ? html`<div class="sheet-head"><h2>${sheet.title}</h2>
        <button class="icon-btn" aria-label="ปิด" onClick=${close}><${Icon} name="close" /></button></div>` : null}
      <div class="sheet-body">${sheet.render(close)}</div>
    </div></div>`;
}
