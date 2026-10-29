// Stock: search the parts and items, one item with its six numbers, where it is kept and its 3D model.
import { useData } from '../api.js';
import { Icon } from '../icons.js';
import { openCount } from '../sheets.js';
import { Button, Card, Chip, Empty, IconButton, KV, Loader, Page, Section, Seg, StatusChip } from '../ui.js';
import { PartVisual } from '../view3d.js';
import { go, html, num, store, tone, useEffect, useState, useStore } from '../lib.js';

export function StockScreen({ route }) {
  const [q, setQ] = useState(route.params.q || '');
  const [typed, setTyped] = useState(route.params.q || '');
  const [only, setOnly] = useState(route.params.only || '');
  const [group, setGroup] = useState('');
  const groups = ((store.state.hello || {}).groups) || [];
  useEffect(() => {
    const t = setTimeout(() => setQ(typed), 250);
    return () => clearTimeout(t);
  }, [typed]);
  const state = useData('items', { q, only, group, limit: 80 });
  const countN = useStore((s) => s.countN);
  return html`<${Page} title="สต็อก" sub="ชิ้นส่วนพร้อมประกอบ · วัตถุดิบ · ตำแหน่งเก็บ"
    actions=${html`<${IconButton} icon="count" label="รายการนับ" badge=${countN || ''} onClick=${() => go('count')} />`}>
    <div class="search">
      <${Icon} name="search" size=${20} />
      <input type="search" placeholder="ค้นหารหัส ชื่อ หรือตำแหน่ง" value=${typed} onInput=${(e) => setTyped(e.target.value)} />
      <button class="icon-btn solid" aria-label="สแกน" onClick=${() => go('scan?mode=info')}><${Icon} name="scan" /></button>
    </div>
    <${Seg} options=${[['', 'ทั้งหมด'], ['made', 'ชิ้นส่วนผลิต'], ['short', 'ขาด / ต่ำกว่า Min']]} value=${only} onChange=${setOnly} className="small" />
    <div class="chips-row scroll">${[['', 'ทุกกลุ่ม'], ...groups.map((g) => [g.key, g.name])].map(([k, name]) => html`
      <button class=${`chip tap ${group === k ? 'active' : ''}`} onClick=${() => setGroup(k)}>${name}</button>`)}</div>
    <${Loader} state=${state} rows=${6}>${(rows) => (rows.length ? html`<div class="list">
      ${rows.map((r) => html`<button class="item-row" onClick=${() => go(`stock/item/${encodeURIComponent(r.code)}`)}>
        <span class=${`dot t-${tone(r.status)}`}></span>
        <span class="ir-main"><b>${r.code}</b><span>${r.name}</span>
          <small>${[r.group_name, r.location ? `📍 ${r.location}` : '', r.wip_text].filter(Boolean).join(' · ')}</small></span>
        <span class="ir-qty"><b>${num(r.on_hand)}</b><small>${r.unit || ''}${r.made && r.free !== r.on_hand ? ` · ใช้ได้ ${num(r.free)}` : ''}</small>
          ${r.short ? html`<${Chip} tone="bad">ขาด ${num(r.short)}</${Chip}>` : null}</span>
      </button>`)}</div>` : html`<${Empty} icon="search" title="ไม่พบรายการ" text="ลองค้นหาด้วยคำอื่น หรือเลือก ทั้งหมด" />`)}</${Loader}>
  </${Page}>`;
}

export function ItemScreen({ route }) {
  const code = route.parts[2] || '';
  const state = useData('item', { code });
  const [tab, setTab] = useState('3d');
  return html`<${Page} title=${code} sub="รายละเอียดสินค้า" backTo="stock">
    <${Loader} state=${state} rows=${6}>${(it) => html`
      <${Card} className="item-hero">
        <div class="ih-top"><div><h2>${it.name || it.code}</h2>
          <div class="chips-row tight">${it.type_name ? html`<${Chip}>${it.type_name}</${Chip}>` : null}
            ${it.group_name ? html`<${Chip} tone="navy">${it.group_name}</${Chip}>` : null}
            ${it.brand ? html`<${Chip}>${it.brand}</${Chip}>` : null}
            ${it.side ? html`<${Chip} tone=${it.side === 'ซ้าย' ? 'info' : 'violet'}>${it.side}</${Chip}>` : null}
            <${StatusChip} status=${it.status} /></div></div></div>
        ${it.has_outline || it.has_image ? html`<${PartVisual} item=${it} height=${230} />` : null}
        <${KV} items=${[['ขนาด', it.size], ['วัสดุ', it.material], ['ความหนา', it.thickness ? `${num(it.thickness)} มม.` : ''], ['สเปก', it.spec]]} />
      </${Card}>
      <div class="six">
        <div class="six-cell"><span>พร้อมประกอบ</span><b>${num(it.on_hand)}</b><small>${it.unit}</small></div>
        <div class="six-cell"><span>จองให้งาน</span><b>${num(it.reserved)}</b></div>
        <div class=${`six-cell ${it.free > 0 ? 'ok' : ''}`}><span>ใช้ได้</span><b>${num(it.free)}</b></div>
        <div class="six-cell warn"><span>ระหว่างผลิต</span><b>${num(Object.values(it.wip || {}).reduce((a, b) => a + b, 0))}</b><small>${it.wip_text}</small></div>
        <div class="six-cell"><span>จะได้</span><b>${num(it.incoming)}</b></div>
        <div class=${`six-cell ${it.short > 0 ? 'bad' : ''}`}><span>ขาด</span><b>${num(it.short)}</b></div>
      </div>
      ${it.min || it.max ? html`<p class="muted small">Min ${num(it.min)} · Max ${num(it.max)} · ต้องใช้ตามงานที่เปิด ${num(it.need)}</p>` : null}
      <${Section} title="ตำแหน่งเก็บ">
        <${Card} className="loc-card">
          <div class="loc-big"><${Icon} name="tag" size=${22} /><b>${it.location || 'ยังไม่ได้ตั้ง'}</b></div>
          ${it.slot ? html`<p class="muted">${it.slot.where || `ชั้นวาง ${it.slot.rack}`}${it.slot.level ? ` · ชั้นที่ ${it.slot.level} จากล่าง` : ''}${it.slot.column ? ` · ช่องที่ ${it.slot.column} จากซ้าย` : ''}</p>` : html`<p class="muted small">ตั้งตำแหน่งเก็บได้ที่คอม: สโตร์ → ชิ้นส่วนพร้อมประกอบ → ตั้งตำแหน่งเก็บ</p>`}
          <div class="btn-row">
            ${it.location ? html`<${Button} icon="target" onClick=${() => go(`scan?mode=find&code=${encodeURIComponent(it.code)}`)}>นำทางด้วย AR</${Button}>` : null}
            <${Button} kind="secondary" icon="count" onClick=${() => openCount(it, { visual: false })}>นับรายการนี้</${Button}>
          </div>
        </${Card}>
      </${Section}>
      ${it.job_lines.length ? html`<${Section} title="งานที่ใช้ชิ้นนี้">${it.job_lines.map((l) => html`<${Card} onClick=${() => go(`prod/job/${encodeURIComponent(l.job_no)}`)} className="mini-card">
        <b>${l.job_no}</b><span>${l.status_text}</span><${Chip} tone="warn">ต้องใช้ ${num(l.need)}</${Chip}></${Card}>`)}</${Section}>` : null}
      ${it.movements.length ? html`<${Section} title="ความเคลื่อนไหวล่าสุด"><${Card} className="log">${it.movements.map((m) => html`<div class="log-row">
        <span class="log-time">${m.when.slice(5, 10).split('-').reverse().join('/')}</span>
        <span class="log-main"><b>${m.doc}</b> ${m.qty > 0 ? '+' : ''}${num(m.qty)} → ${num(m.balance)}<small>${m.job || ''}</small></span></div>`)}</${Card}></${Section}>` : null}
    `}</${Loader}>
  </${Page}>`;
}
