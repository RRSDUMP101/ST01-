/*
 * UI kit: safe HTML building (every value is escaped unless it comes from a kit helper), tables, forms, badges,
 * and the page registry. Pages are plain objects:
 *
 *   RRS.ui.page({
 *     id: 'items', title: 'ทะเบียนสินค้า', group: 'ข้อมูลหลัก', phase: 0, order: 10,
 *     render(ctx)  -> SafeString | string of HTML built with h.t`...`
 *     actions: { name(ctx, el, ev) {} }   // <button data-act="name" data-arg="..."> (el.dataset.arg)
 *     forms:   { name(ctx, values, form) }// <form data-form="name"> – values parsed, see parseForm
 *     after(ctx, root)                    // optional, after the HTML is in the page
 *   })
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { util } = RRS;

  class Safe {
    constructor(s) {
      this.s = s;
    }
    toString() {
      return this.s;
    }
  }
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const show = (v) => {
    if (v == null || v === false) return '';
    if (v instanceof Safe) return v.s;
    if (Array.isArray(v)) return v.map(show).join('');
    return esc(v);
  };
  const safe = (s) => new Safe(String(s == null ? '' : s));
  /** Tagged template: h.t`<td>${value}</td>` escapes value; arrays are joined; kit results pass through. */
  const t = (strings, ...vals) => {
    let out = strings[0];
    for (let i = 0; i < vals.length; i++) out += show(vals[i]) + strings[i + 1];
    return new Safe(out);
  };
  const attr = (name, v) => (v == null || v === false ? '' : v === true ? ` ${name}` : ` ${name}="${esc(v)}"`);
  const join = (arr, sep) => new Safe(arr.filter((x) => x != null && x !== false && x !== '').map(show).join(sep || ''));

  // ---- formatting ----------------------------------------------------------------------------------------
  const nf = (d) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: d == null ? 3 : d });
  const fmt = {
    num(n, d) {
      if (n == null || n === '' || isNaN(Number(n))) return '';
      return nf(d).format(Number(n));
    },
    money(n) {
      if (n == null || isNaN(Number(n))) return '';
      return new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n));
    },
    pct(n, d) {
      if (n == null || isNaN(Number(n))) return '–';
      return nf(d == null ? 1 : d).format(Number(n) * 100) + '%';
    },
    date: (d) => util.beDate(d),
    dt: (iso) => util.beDateTime(iso),
    status: (s) => RRS.STATUS_LABEL[s] || s,
  };

  // ---- small pieces --------------------------------------------------------------------------------------
  const TONES = ['ok', 'warn', 'bad', 'info', 'muted', 'accent'];
  const badge = (text, tone) => t`<span class="badge ${TONES.indexOf(tone) >= 0 ? 'b-' + tone : 'b-muted'}">${text}</span>`;
  const STATUS_TONE = { AVAILABLE: 'ok', QC_HOLD: 'warn', QUARANTINE: 'bad', REWORK: 'info' };
  const statusBadge = (s) => badge(RRS.STATUS_LABEL[s] || s, STATUS_TONE[s] || 'muted');
  const DOC_TONE = { DRAFT: 'muted', WAIT_APPROVAL: 'warn', POSTED: 'ok', IN_TRANSIT: 'info', RECEIVED: 'ok', CANCELLED: 'bad' };
  const docStatus = (s) => badge((RRS.inventory && RRS.inventory.DOC_STATUS[s]) || s, DOC_TONE[s] || 'muted');
  const code = (c) => t`<span class="code">${c}</span>`;
  const qty = (n, unit) => t`<span class="qty">${fmt.num(n)}</span>${unit ? t` <span class="unit">${unit}</span>` : ''}`;

  /** <button>. opts: {act, arg, tone: primary|ghost|danger|quiet, disabled, title, type, small, id} */
  const btn = (label, o) => {
    o = o || {};
    const cls = ['btn', o.tone ? 'btn-' + o.tone : '', o.small ? 'btn-sm' : ''].filter(Boolean).join(' ');
    return t`<button class="${cls}" type="${o.type || 'button'}"${safe(attr('data-act', o.act))}${safe(attr('data-arg', o.arg))}${safe(attr('disabled', !!o.disabled))}${safe(attr('title', o.title))}${safe(attr('id', o.id))}>${label}</button>`;
  };
  const link = (label, page, view) => t`<a href="#${page}" class="lnk" data-go="${page}"${safe(attr('data-view', view ? JSON.stringify(view) : null))}>${label}</a>`;

  /**
   * h.table({cols, rows, empty, rowAct, rowArg, foot, dense, id})
   *   col: {label, key | get(row), num (right aligned, formatted), render(row) -> html, cls, w}
   */
  const table = (o) => {
    const cols = o.cols;
    const rows = o.rows || [];
    if (!rows.length && o.empty !== false) return empty(o.empty || 'ยังไม่มีข้อมูล', o.emptyText || '');
    const head = cols.map((c) => t`<th class="${c.num ? 'n' : ''} ${c.cls || ''}"${safe(c.w ? ` style="width:${esc(c.w)}"` : '')}>${c.label}</th>`);
    const body = rows.map((r, i) => {
      const cells = cols.map((c) => {
        let v;
        if (c.render) v = c.render(r, i);
        else {
          const raw = c.get ? c.get(r, i) : r[c.key];
          v = c.num ? fmt.num(raw, c.digits) : raw;
        }
        return t`<td class="${c.num ? 'n' : ''} ${c.cls || ''}">${v}</td>`;
      });
      const act = o.rowAct ? safe(` data-act="${esc(o.rowAct)}" data-arg="${esc(o.rowArg ? o.rowArg(r, i) : i)}" class="clickable${o.rowCls ? ' ' + esc(o.rowCls(r) || '') : ''}"`) :
        safe(o.rowCls ? ` class="${esc(o.rowCls(r) || '')}"` : '');
      return t`<tr${act}>${cells}</tr>`;
    });
    const foot = o.foot ? t`<tfoot><tr>${o.foot.map((f, i) => t`<td class="${cols[i] && cols[i].num ? 'n' : ''}">${f}</td>`)}</tr></tfoot>` : '';
    return t`<div class="tbl-wrap"${safe(attr('id', o.id))}><table class="tbl${o.dense ? ' dense' : ''}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table></div>`;
  };

  const empty = (title, text, action) => t`<div class="empty"><p class="empty-t">${title}</p>${text ? t`<p class="empty-s">${text}</p>` : ''}${action || ''}</div>`;

  /**
   * h.field({name, label, type, value, options, required, hint, placeholder, step, list, readonly, wide, id})
   *   type: text | number | date | datetime | select | multiselect | textarea | checkbox | hidden | file
   *   options: [[value, label], …] or [value, …]
   */
  let fieldN = 0;
  const field = (o) => {
    const id = o.id || `f-${o.name.replace(/[^\w-]/g, '_')}-${++fieldN}`;
    const opts = (o.options || []).map((x) => (Array.isArray(x) ? x : [x, x]));
    const common = safe(`${attr('id', id)}${attr('name', o.name)}${attr('required', !!o.required)}${attr('readonly', !!o.readonly)}${attr('disabled', !!o.disabled)}${attr('placeholder', o.placeholder)}`);
    let input;
    if (o.type === 'hidden') return t`<input type="hidden" name="${o.name}" value="${o.value == null ? '' : o.value}">`;
    if (o.type === 'select') {
      input = t`<select${common}>${o.blank !== false ? t`<option value="">${o.blank || '— เลือก —'}</option>` : ''}${opts.map(([v, l]) => t`<option value="${v}"${safe(attr('selected', String(v) === String(o.value == null ? '' : o.value)))}>${l}</option>`)}</select>`;
    } else if (o.type === 'multiselect') {
      const vals = (o.value || []).map(String);
      input = t`<div class="checks" id="${id}">${opts.map(([v, l]) => t`<label class="chk"><input type="checkbox" name="${o.name}[]" value="${v}"${safe(attr('checked', vals.indexOf(String(v)) >= 0))}> ${l}</label>`)}</div>`;
    } else if (o.type === 'textarea') {
      input = t`<textarea${common} rows="${o.rows || 3}">${o.value == null ? '' : o.value}</textarea>`;
    } else if (o.type === 'checkbox') {
      return t`<label class="fld fld-check${o.wide ? ' wide' : ''}"><input type="checkbox"${common} value="1"${safe(attr('checked', !!o.value))}> <span>${o.label}</span>${o.hint ? t`<small class="hint">${o.hint}</small>` : ''}</label>`;
    } else {
      const type = o.type === 'datetime' ? 'datetime-local' : o.type || 'text';
      input = t`<input type="${type}"${common}${safe(attr('value', o.value == null ? '' : o.value))}${safe(attr('step', o.step || (type === 'number' ? 'any' : null)))}${safe(attr('list', o.list))}${safe(attr('accept', o.accept))}${safe(attr('inputmode', type === 'number' ? 'decimal' : null))}>`;
    }
    return t`<label class="fld${o.wide ? ' wide' : ''}" for="${id}"><span class="fld-l">${o.label}${o.required ? t` <b class="req">*</b>` : ''}</span>${input}${o.hint ? t`<small class="hint">${o.hint}</small>` : ''}</label>`;
  };
  /** h.form({name, body, submit, cancel (act name), danger}) */
  const form = (o) => t`<form class="form" data-form="${o.name}" novalidate><div class="fgrid">${o.body}</div><div class="form-actions">${o.submit !== false ? btn(o.submit || 'บันทึก', { type: 'submit', tone: o.danger ? 'danger' : 'primary' }) : ''}${o.cancel ? btn('ยกเลิก', { act: o.cancel, tone: 'ghost' }) : ''}${o.extra || ''}</div></form>`;

  const tabs = (list, current, act) => t`<div class="tabs" role="tablist">${list.map((x) => t`<button type="button" role="tab" class="tab${x.id === current ? ' on' : ''}" aria-selected="${x.id === current ? 'true' : 'false'}" data-act="${act || 'tab'}" data-arg="${x.id}">${x.label}${x.count != null ? t` <span class="tab-n">${x.count}</span>` : ''}</button>`)}</div>`;
  const kpi = (label, value, sub, tone) => t`<div class="kpi${tone ? ' k-' + tone : ''}"><span class="kpi-l">${label}</span><span class="kpi-v">${value}</span>${sub ? t`<span class="kpi-s">${sub}</span>` : ''}</div>`;
  const kpis = (arr) => t`<div class="kpis">${arr}</div>`;
  const section = (title, body, o) => {
    o = o || {};
    return t`<section class="sec"${safe(attr('id', o.id))}><header class="sec-h"><div><h2>${title}</h2>${o.sub ? t`<p class="sec-s">${o.sub}</p>` : ''}</div>${o.actions ? t`<div class="sec-a">${o.actions}</div>` : ''}</header>${body}</section>`;
  };
  const toolbar = (left, right) => t`<div class="toolbar"><div class="tb-l">${left || ''}</div><div class="tb-r">${right || ''}</div></div>`;
  const note = (text, tone) => t`<div class="note n-${tone || 'info'}">${text}</div>`;
  const dl = (pairs) => t`<dl class="dl">${pairs.filter(Boolean).map(([k, v]) => t`<div><dt>${k}</dt><dd>${v == null || v === '' ? '–' : v}</dd></div>`)}</dl>`;

  // ---- datalists for code fields --------------------------------------------------------------------------
  const lists = {
    items: (state) => t`<datalist id="dl-items">${RRS.q.rows(state, 'items', (i) => i.active !== false).sort((a, b) => a.id.localeCompare(b.id)).map((i) => t`<option value="${i.id}">${i.name} (${i.baseUnit})</option>`)}</datalist>`,
    warehouses: (state) => t`<datalist id="dl-wh">${RRS.q.rows(state, 'warehouses', (w) => w.active !== false).map((w) => t`<option value="${w.code}">${w.name}</option>`)}</datalist>`,
    bins: (state) => t`<datalist id="dl-bins">${RRS.q.rows(state, 'bins', (b) => b.active !== false).map((b) => t`<option value="${b.code}">${b.wh} · ${b.name || ''}</option>`)}</datalist>`,
  };
  const whOptions = (state) => RRS.q.rows(state, 'warehouses', (w) => w.active !== false).sort((a, b) => a.code.localeCompare(b.code)).map((w) => [w.code, `${w.code} · ${w.name}`]);
  const binOptions = (state, wh) => RRS.q.rows(state, 'bins', (b) => b.active !== false && (!wh || b.wh === wh)).sort((a, b) => a.code.localeCompare(b.code)).map((b) => [b.code, wh ? b.code : `${b.wh}/${b.code}`]);
  const userOptions = (state, perm) => RRS.q.rows(state, 'users', (u) => u.active !== false && (!perm || RRS.auth.can(u, perm))).map((u) => [u.id, u.name]);

  /**
   * Editable lines inside a form: inputs named `${name}[i][field]` (parseForm turns them into an array).
   * cols: [{key, label, type?, list?, options?, w?, placeholder?}]  lines: [{…}]  addAct: action to add a line
   */
  const lineEditor = (o) => {
    const rows = (o.lines && o.lines.length ? o.lines : [{}]).map((ln, i) => t`<tr>${o.cols.map((c) => {
      const nm = `${o.name}[${i}][${c.key}]`;
      const v = ln[c.key] == null ? '' : ln[c.key];
      let input;
      if (c.options) {
        const opts = c.options.map((x) => (Array.isArray(x) ? x : [x, x]));
        input = t`<select name="${nm}" aria-label="${c.label}"><option value="">${c.blank || '–'}</option>${opts.map(([ov, ol]) => t`<option value="${ov}"${safe(attr('selected', String(ov) === String(v)))}>${ol}</option>`)}</select>`;
      } else {
        input = t`<input name="${nm}" aria-label="${c.label}" value="${v}"${safe(attr('list', c.list))}${safe(attr('type', c.type === 'number' ? 'number' : null))}${safe(attr('step', c.type === 'number' ? 'any' : null))}${safe(attr('inputmode', c.type === 'number' ? 'decimal' : null))}${safe(attr('placeholder', c.placeholder))}>`;
      }
      return t`<td${safe(c.w ? ` style="width:${esc(c.w)}"` : '')}>${input}</td>`;
    })}<td class="le-x">${btn('×', { act: o.removeAct || 'removeLine', arg: i, tone: 'quiet', small: true, title: 'ลบบรรทัด' })}</td></tr>`);
    return t`<div class="tbl-wrap le"><table class="tbl dense"><thead><tr>${o.cols.map((c) => t`<th>${c.label}</th>`)}<th></th></tr></thead><tbody>${rows}</tbody></table></div><div class="le-add">${btn('+ เพิ่มบรรทัด', { act: o.addAct || 'addLine', tone: 'ghost', small: true })}</div>`;
  };

  /** FormData -> object. 'a[]' -> array; 'lines[0][code]' -> lines[0].code; checkboxes -> true/false. */
  const parseForm = (formEl) => {
    const out = {};
    const setPath = (obj, path, value) => {
      let cur = obj;
      for (let i = 0; i < path.length - 1; i++) {
        const k = path[i];
        const nextIsIndex = /^\d+$/.test(path[i + 1]);
        if (cur[k] == null) cur[k] = nextIsIndex ? [] : {};
        cur = cur[k];
      }
      cur[path[path.length - 1]] = value;
    };
    for (const el of formEl.elements) {
      if (!el.name || el.disabled) continue;
      if (el.type === 'checkbox') {
        if (el.name.endsWith('[]')) {
          const k = el.name.slice(0, -2);
          out[k] = out[k] || [];
          if (el.checked) out[k].push(el.value);
        } else out[el.name] = el.checked;
        continue;
      }
      if (el.type === 'radio' && !el.checked) continue;
      if (el.type === 'file') continue;
      const m = el.name.match(/^([^[]+)((?:\[[^\]]*\])+)$/);
      if (m) {
        const path = [m[1]].concat(m[2].slice(1, -1).split(']['));
        setPath(out, path, el.value);
      } else out[el.name] = el.value;
    }
    for (const k in out) if (Array.isArray(out[k])) out[k] = out[k].filter((x) => x != null);
    return out;
  };
  /** Lines from parseForm without the empty rows. */
  const cleanLines = (lines, keyField) => (lines || []).filter((l) => l && Object.keys(l).some((k) => util.trim(l[k]) !== '') && (!keyField || util.trim(l[keyField])));

  /** CSV / TSV text -> rows (quoted fields, "" escapes, CRLF). The delimiter is guessed from the first line. */
  const parseCsv = (text) => {
    const src = String(text || '').replace(/^\ufeff/, '');
    const first = src.split(/\r?\n/, 1)[0] || '';
    const delim = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (q) {
        if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && src[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
  };
  /**
   * A file the user picked -> {name, rows (first sheet), hash (SHA-256 of the bytes), sheets}. Excel needs the
   * SheetJS script (loaded by the page from cdnjs); CSV / TSV / TXT are read as text (UTF-8, else TIS-620).
   */
  const readTable = async (file) => {
    const buf = await file.arrayBuffer();
    const hash = RRS.util.sha256(new Uint8Array(buf));
    const name = file.name || 'file';
    if (/\.(xlsx|xlsm|xls)$/i.test(name)) {
      if (!root.XLSX) throw new Error('อ่านไฟล์ Excel ไม่ได้ (ตัวอ่าน Excel โหลดไม่สำเร็จ) – บันทึกเป็น CSV แล้วลองใหม่');
      const wb = root.XLSX.read(buf, { type: 'array', cellDates: true });
      const sheets = {};
      for (const sn of wb.SheetNames) sheets[sn] = root.XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, defval: '' });
      return { name, hash, rows: sheets[wb.SheetNames[0]] || [], sheets };
    }
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.indexOf('\ufffd') >= 0) {
      try { text = new TextDecoder('windows-874').decode(buf); } catch (e) { /* keep utf-8 */ }
    }
    return { name, hash, rows: parseCsv(text), sheets: null };
  };
  /** Header row -> {fieldName: columnIndex} using alias lists {field: ['รหัสสินค้า', 'code', …]}. */
  const mapHeader = (header, aliases) => {
    const norm = (x) => String(x || '').toLowerCase().replace(/[\s_().\-/]+/g, '');
    const out = {};
    header.forEach((hd, i) => {
      const n = norm(hd);
      for (const f in aliases) if (out[f] == null && aliases[f].some((a) => norm(a) === n)) out[f] = i;
    });
    return out;
  };

  /** The errors of a failed command as a list. */
  const errors = (r) => (r && r.errors && r.errors.length ? t`<ul class="errs">${r.errors.map((e) => t`<li>${e.message}</li>`)}</ul>` : '');

  RRS.ui = {
    pages: {},
    page(def) {
      this.pages[def.id] = Object.assign({ actions: {}, forms: {}, order: 100, phase: '' }, def);
      return this.pages[def.id];
    },
    h: { t, safe, esc, show, attr, join, fmt, badge, statusBadge, docStatus, code, qty, btn, link, table, empty, field, form,
      tabs, kpi, kpis, section, toolbar, note, dl, lists, whOptions, binOptions, userOptions, lineEditor, parseForm,
      cleanLines, errors, Safe, parseCsv, readTable, mapHeader },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
