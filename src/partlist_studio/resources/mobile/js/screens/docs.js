// เบิก / รับ สต็อก: ask for an issue (PD / OU) or a receipt (RR / FR) from the phone - the store confirms it on the PC,
// which posts the document (or keeps it as a draft). The documents of the PC can be looked at too.
import { api, useData } from '../api.js';
import { Icon } from '../icons.js';
import { Button, Card, Chip, Empty, KV, Loader, Page, Section, Seg, StatusChip, Stepper } from '../ui.js';
import { feedback, go, html, local, num, store, timeAgo, toast, useEffect, useState } from '../lib.js';

const OUT = ['PD', 'OU'];
const EMPTY = { type: 'PD', job: '', lines: [], note: '' };

function draftOf() { return { ...EMPTY, ...(local.get('docDraft', null) || {}) }; }

export function DocsScreen({ route }) {
  const [tab, setTab] = useState(route.params.tab || 'new');
  return html`<${Page} title="เบิก / รับ สต็อก" sub="ส่งให้สโตร์ยืนยันที่คอม แล้วบันทึกเอกสาร" backTo="stock">
    <${Seg} options=${[['new', 'สร้างใบเบิก / รับ'], ['mine', 'ที่ส่งแล้ว'], ['docs', 'เอกสารในคอม']]} value=${tab} onChange=${setTab} />
    ${tab === 'new' ? html`<${NewDoc} route=${route} onSent=${() => setTab('mine')} />`
      : tab === 'mine' ? html`<${Mine} />` : html`<${PcDocs} />`}
  </${Page}>`;
}

function NewDoc({ route, onSent }) {
  const types = (store.state.hello || {}).doc_types || { PD: 'เบิกไปผลิต (PD)', OU: 'เบิกใช้ภายใน (OU)', RR: 'รับสินค้าที่ซื้อ (RR)', FR: 'รับชิ้นงานที่ผลิตเสร็จ (FR)' };
  const [draft, setDraftState] = useState(draftOf);
  const setDraft = (d) => { setDraftState(d); local.set('docDraft', d); };
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const jobs = useData('jobs');
  const found = useData('items', q ? { q, limit: 12 } : null);
  useEffect(() => { const t = setTimeout(() => setQ(typed.trim()), 250); return () => clearTimeout(t); }, [typed]);
  const add = (it, qty = 1) => {
    if (draft.lines.some((l) => l.code === it.code)) { toast(`${it.code} อยู่ในรายการแล้ว`, 'warn'); return; }
    feedback.tick();
    setDraft({ ...draft, lines: [...draft.lines, { code: it.code, name: it.name, unit: it.unit, on_hand: it.on_hand, qty }] });
    setTyped('');
  };
  // from the item screen or a scan: ?type=RR&code=…
  useEffect(() => {
    const { type, code } = route.params;
    if (!type && !code) return;
    let d = draftOf();
    if (type && types[type]) d = { ...d, type };
    setDraft(d);
    if (code) {
      api.get('item', { code }).then((it) => {
        const cur = draftOf();
        if (!cur.lines.some((l) => l.code === it.code)) {
          setDraft({ ...cur, lines: [...cur.lines, { code: it.code, name: it.name, unit: it.unit, on_hand: it.on_hand, qty: 1 }] });
        }
      }).catch(() => {});
    }
  }, [route.params.type, route.params.code]);
  const setLine = (i, patch) => setDraft({ ...draft, lines: draft.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) });
  const out = OUT.includes(draft.type);
  const send = async () => {
    setBusy(true);
    try {
      const ans = await api.change('stockdoc', { doc_type: draft.type, job_no: draft.job, note: draft.note,
        lines: draft.lines.map((l) => ({ code: l.code, qty: l.qty, note: l.note || '' })) }, `${types[draft.type]} ${draft.lines.length} รายการ`);
      feedback.ok();
      toast(ans.queued ? 'ยังส่งไม่ได้ – เก็บไว้ส่งเองเมื่อเชื่อมต่อได้' : 'ส่งให้สโตร์แล้ว – รอยืนยันที่คอม', 'ok', 3200);
      setDraft({ ...EMPTY, type: draft.type });
      onSent();
    } catch (e) {
      feedback.error();
      toast(e.message, 'bad', 4200);
    } finally {
      setBusy(false);
    }
  };
  return html`<div>
    <${Section} title="ชนิดเอกสาร">
      <div class="chips-row">${Object.entries(types).map(([k, label]) => html`<${Chip} active=${draft.type === k}
        tone=${OUT.includes(k) ? 'warn' : 'ok'} icon=${OUT.includes(k) ? 'arrow' : 'box'} onClick=${() => setDraft({ ...draft, type: k })}>${label}</${Chip}>`)}</div>
      <label class="field"><span class="field-label">งาน / SO (ถ้ามี)</span>
        <select class="input" value=${draft.job} onChange=${(e) => setDraft({ ...draft, job: e.target.value })}>
          <option value="">ไม่ระบุงาน</option>
          ${(jobs.data || []).map((j) => html`<option value=${j.job_no}>${j.job_no} · ${j.title || j.model || ''}</option>`)}
        </select></label>
    </${Section}>
    <${Section} title=${`รายการ (${draft.lines.length})`}>
      <div class="search">
        <${Icon} name="search" size=${20} />
        <input type="search" placeholder="ค้นหารหัส / ชื่อ เพื่อเพิ่มรายการ" value=${typed} onInput=${(e) => setTyped(e.target.value)} />
        <button class="icon-btn solid" aria-label="สแกนป้าย" onClick=${() => go('scan?mode=info')}><${Icon} name="scan" /></button>
      </div>
      ${q ? html`<${Loader} state=${found} rows=${2}>${(rows) => (rows.length ? html`<div class="list">${rows.slice(0, 12).map((it) => html`
        <button class="item-row" onClick=${() => add(it)}><span class="ir-main"><b>${it.code}</b><span>${it.name}</span>
          <small>${it.location ? `📍 ${it.location}` : ''}</small></span>
          <span class="ir-qty"><b>${num(it.on_hand)}</b><small>${it.unit || ''}</small></span><${Icon} name="plus" /></button>`)}</div>`
        : html`<p class="muted small">ไม่พบ "${q}"</p>`)}</${Loader}>` : null}
      ${draft.lines.length ? draft.lines.map((l, i) => html`<${Card} className="doc-line">
        <div class="row-between"><div><b>${l.code}</b><div class="muted small">${l.name}</div>
          <div class=${`small ${out && l.qty > l.on_hand ? 'bad' : 'muted'}`}>คงเหลือ ${num(l.on_hand)} ${l.unit || ''}${out && l.qty > l.on_hand ? ' · ไม่พอเบิก' : ''}</div></div>
          <button class="icon-btn" aria-label="เอาออก" onClick=${() => setDraft({ ...draft, lines: draft.lines.filter((_, k) => k !== i) })}><${Icon} name="trash" /></button></div>
        <${Stepper} value=${l.qty} min=${1} onChange=${(v) => setLine(i, { qty: v })} />
      </${Card}>`) : html`<${Empty} icon="box" title="ยังไม่มีรายการ" text="ค้นหาหรือสแกนป้ายชั้นวาง แล้วแตะเพื่อเพิ่ม · จากหน้าสินค้ากด เบิก / รับ ก็ได้" />`}
    </${Section}>
    <input class="input" placeholder="หมายเหตุ (ถ้ามี)" value=${draft.note} onInput=${(e) => setDraft({ ...draft, note: e.target.value })} />
    <${Button} size="xl" block icon="send" disabled=${busy || !draft.lines.length || (store.state.device || {}).role === 'viewer'} onClick=${send}>
      ส่ง${(types[draft.type] || '').replace(/\s*\(.*\)$/, '')} ${draft.lines.length} รายการ</${Button}>
    <p class="muted small">สโตร์ยืนยันที่คอม (หน้า มือถือ & AR → งานจากมือถือ) แล้วระบบบันทึกเอกสาร ${draft.type} ให้ – ยอดสต็อกเปลี่ยนเมื่อยืนยันแล้ว</p>
  </div>`;
}

function Mine() {
  const state = useData('mine');
  return html`<${Loader} state=${state} rows=${4}>${(rows) => {
    const docs = rows.filter((s) => s.kind === 'doc');
    return docs.length ? docs.map((s) => html`<${Card}>
      <div class="row-between"><b>${s.summary}</b><${StatusChip} status=${s.status} /></div>
      <div class="muted small">${timeAgo(s.created)}${s.doc_no ? ` · เอกสาร ${s.doc_no}` : ''}${s.text ? ` · ${s.text}` : ''}</div>
      <div class="chips-row tight">${s.lines.slice(0, 6).map((l) => html`<${Chip}>${l.code} × ${num(l.qty)}</${Chip}>`)}</div>
      ${s.doc_no ? html`<button class="link" onClick=${() => go(`docs/${encodeURIComponent(s.doc_no)}`)}>ดูเอกสาร</button>` : null}
    </${Card}>`) : html`<${Empty} icon="send" title="ยังไม่ได้ส่งใบเบิก / รับ" />`;
  }}</${Loader}>`;
}

function PcDocs() {
  const state = useData('docs', { limit: 40 });
  return html`<${Loader} state=${state} rows=${5}>${(rows) => (rows.length ? html`<div class="list">${rows.map((d) => html`
    <button class="item-row" onClick=${() => go(`docs/${encodeURIComponent(d.doc_no)}`)}>
      <span class="ir-main"><b>${d.doc_no}</b><span>${d.type_name}${d.job ? ` · ${d.job}` : ''}</span>
        <small>${d.date} · ${d.lines} รายการ</small></span>
      <span class="ir-qty"><${StatusChip} status=${d.status} /></span></button>`)}</div>`
    : html`<${Empty} icon="list" title="ยังไม่มีเอกสาร" />`)}</${Loader}>`;
}

export function DocScreen({ route }) {
  const no = decodeURIComponent(route.parts[1] || '');
  const state = useData('doc', { no });
  return html`<${Page} title=${no} sub="เอกสารสต็อก" backTo="docs?tab=docs">
    <${Loader} state=${state} rows=${5}>${(d) => html`
      <${Card}><div class="row-between"><b>${d.type_name}</b><${StatusChip} status=${d.status} /></div>
        <${KV} items=${[['วันที่', d.date], ['งาน / SO', d.job], ['เลขที่ Express', d.express_no], ['หมายเหตุ', d.remark]]} /></${Card}>
      <${Section} title=${`รายการ (${d.lines.length})`}>${d.lines.map((l) => html`<${Card} className="doc-line">
        <div class="row-between"><div><b>${l.code}</b><div class="muted small">${l.name}</div></div>
          <div class="ir-qty"><b>${num(l.qty)}</b><small>${l.unit || ''}</small></div></div>
        ${l.on_hand !== null ? html`<div class="muted small">คงเหลือตอนนี้ ${num(l.on_hand)}${l.remark ? ` · ${l.remark}` : ''}</div>` : null}
      </${Card}>`)}</${Section}>`}</${Loader}>
  </${Page}>`;
}
