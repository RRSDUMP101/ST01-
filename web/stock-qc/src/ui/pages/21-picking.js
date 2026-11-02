/*
 * Phase 2 – ใบจัดชุดและหยิบของ. Choose a job → RRS.planning.pickList (reservations with something left, bins of
 * that warehouse holding AVAILABLE stock, oldest receipt first, and a suggestion of what to take from where).
 * A phone-friendly pick form: one card per reservation, one row per bin – scan/type the code, side, bin, qty →
 * pick.post (one PD for the whole pick, or nothing). The engine's errors (wrong item / side / warehouse / BOM revision,
 * over the reservation, not enough in the bin) are shown on the row they belong to; the scanned code is compared
 * as you type (the engine checks again). Leftovers go back to stock with an RT of the job (doc.post) and a reason.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const P = RRS.planning;
  if (!P) return; // the planning module is not part of this build
  const { h } = RRS.ui;
  const { t } = h;
  const U = RRS.util;

  const OPEN = { OPEN: true, IN_PROGRESS: true };
  const JOB_TONE = { OPEN: 'info', IN_PROGRESS: 'accent', DONE: 'ok', DELIVERED: 'muted', CANCELLED: 'bad' };
  const SIDE = { L: 'ซ้าย (L)', R: 'ขวา (R)' };
  const BLOCKING = { BOM_CHANGED: true, JOB_CLOSED: true, NOT_FOUND: true };
  const dash = t`<span class="muted">–</span>`;
  const jobBadge = (s) => h.badge(P.JOB_STATUS[s] || s, JOB_TONE[s]);
  const docView = (docNo) => ({ sel: docNo, lines: null, checked: null, header: null, tab: 'all', q: '', type: '' });
  const docLink = (docNo) => h.link(h.code(docNo), 'docs', docView(docNo));
  const comp = (j) => (j.lines || []).filter((l) => !l.output);
  /** A label wrapped around an input built here (the kit field cannot carry the scan attributes). */
  const fld = (label, input, hint) => t`<label class="fld"><span class="fld-l">${label}</span>${input}${hint ? t`<small class="hint">${hint}</small>` : ''}</label>`;

  // ---- model ---------------------------------------------------------------------------------------------------------
  /**
   * Pick rows: one per suggested bin of each reservation (+ rows the picker added). The key of a row is its reservation
   * + its place among that reservation's rows (RS-00001_0, RS-00001_1 …), so what was typed stays with its reservation
   * even when another person's commit adds or removes reservations of the job before the pick is saved.
   */
  function pickModel(ctx, jobNo) {
    const entries = P.pickList(ctx.state, jobNo);
    const extra = ((ctx.view.extra || {})[jobNo]) || {};
    const rows = [];
    entries.forEach((e, i) => {
      let n = 0;
      const key = () => `${e.reservationId}_${n++}`;
      const sug = e.suggest.length ? e.suggest : [{ bin: '', lot: '', qty: '' }];
      sug.forEach((s) => rows.push({ k: key(), e, i, bin: s.bin, lot: s.lot, qty: s.qty, none: !e.bins.length }));
      for (let x = 0; x < (extra[e.reservationId] || 0); x++) rows.push({ k: key(), e, i, bin: '', lot: '', qty: '', added: true, none: !e.bins.length });
    });
    return { entries, rows };
  }
  /** Open jobs and closed jobs with material still out; the job on screen is always in the list. */
  function jobChoices(ctx, current) {
    const out = [];
    for (const j of P.jobs(ctx.state)) {
      const left = P.reservations(ctx.state, { jobNo: j.jobNo, open: true }).filter((r) => P.remaining(r) > 0).length;
      const issued = comp(j).some((l) => l.issued > 0);
      if (!OPEN[j.status] && !issued && j.jobNo !== current) continue;
      const what = OPEN[j.status] ? (left ? `ค้างหยิบ ${left} รายการ` : 'ยังไม่มีของจองค้าง') : `${P.JOB_STATUS[j.status]}${issued ? ' · คืนของได้' : ''}`;
      out.push([j.jobNo, `${j.jobNo} · SO ${j.soNo || '–'}${j.product ? ' · ' + j.product : ''} · ${what}`, OPEN[j.status] ? 0 : 1]);
    }
    return out.sort((a, b) => a[2] - b[2]).map((x) => [x[0], x[1]]);
  }
  function lastIssue(ctx, jobNo, code) {
    let best = null;
    for (const d of RRS.q.rows(ctx.state, 'documents', (x) => x.status === 'POSTED' && (x.type === 'PD' || x.type === 'OU') && U.normCode(x.job) === jobNo)) {
      for (const l of d.lines || []) {
        if (l.code === code && (!best || String(d.postedAt) > String(best.at))) best = { wh: l.wh, bin: l.bin, lot: l.lot, at: d.postedAt };
      }
    }
    return best;
  }
  /** Engine errors → {k (row), message} with the "บรรทัด n:" of the submitted list replaced by what the picker sees. */
  function mapErrs(errors, map, label) {
    return (errors || []).map((e) => {
      const row = e.line ? map[e.line - 1] : null;
      const msg = String(e.message || '').replace(/^บรรทัด\s+\d+(?:,\s*\d+)*:\s*/, '');
      return { k: row ? row.k : null, code: e.code, message: row ? `${label(row)}: ${msg}` : msg };
    });
  }

  // ---- pick form -----------------------------------------------------------------------------------------------------
  function pickRow(ctx, row, vals, errs, canPick) {
    const e = row.e;
    const x = (vals && vals.p && vals.p[row.k]) || null;
    const binVal = x ? x.binlot : `${row.bin}|${row.lot}`;
    const myErr = errs.filter((er) => er.k === row.k);
    if (row.none) {
      return t`<div class="note n-warn">ไม่มีของสถานะ "ใช้ได้" ในช่องเก็บของคลัง ${e.wh} – หยิบไม่ได้ตอนนี้ (ของอาจยังรอตรวจ ถูกย้าย หรือเบิกไปแล้ว)</div>`;
    }
    const binOpts = e.bins.map((b) => [`${b.bin}|${b.lot}`, `${b.bin || '(ไม่ระบุช่อง)'}${b.lot ? ' · ล็อต ' + b.lot : ''} · มี ${h.fmt.num(b.qty)}`]);
    const dis = h.safe(canPick ? '' : ' disabled');
    const sel = (v) => h.safe(v ? ' selected' : '');
    return t`<div class="fgrid" data-row="${row.k}"${h.safe(myErr.length ? ' data-err="1"' : '')}>
      <input type="hidden" name="p[${row.k}][rid]" value="${e.reservationId}">
      ${fld('สแกนหรือพิมพ์รหัสที่หยิบ', t`<input name="p[${row.k}][scan]" id="pk-scan-${row.k}" data-scan="${row.k}" data-code="${e.code}" value="${x ? x.scan : ''}" placeholder="${e.code}" autocomplete="off" autocapitalize="characters"${dis}>`,
        t`<span class="badge b-muted" data-scan-out="${row.k}">ยังไม่สแกน</span>`)}
      ${e.side ? fld('ข้างที่หยิบ', t`<select name="p[${row.k}][side]" id="pk-side-${row.k}"${dis}><option value="">— ไม่ระบุ —</option>${Object.keys(SIDE).map((s) => t`<option value="${s}"${sel(x && x.side === s)}>${SIDE[s]}</option>`)}</select>`, `ต้องเป็น${SIDE[e.side] || e.side}`) : ''}
      ${fld('หยิบจากช่องเก็บ', t`<select name="p[${row.k}][binlot]" id="pk-bin-${row.k}"${dis}>${row.added && !x ? t`<option value="">— เลือกช่อง —</option>` : ''}${binOpts.map(([v, l]) => t`<option value="${v}"${sel(v === binVal)}>${l}</option>`)}</select>`)}
      ${fld(`จำนวนที่หยิบ (${e.baseUnit || 'หน่วยหลัก'})`, t`<input type="number" step="any" inputmode="decimal" name="p[${row.k}][qty]" id="pk-qty-${row.k}" value="${x ? x.qty : row.qty}"${dis}>`, row.added ? 'แถวที่เพิ่ม – เว้นว่างถ้าไม่ใช้' : '')}
      ${myErr.length ? t`<div class="wide">${h.note(t`<ul class="errs">${myErr.map((er) => t`<li>${er.message}</li>`)}</ul>`, 'bad')}</div>` : ''}
    </div>`;
  }
  function pickCard(ctx, e, rows, vals, errs) {
    const canPick = ctx.can('pick.post', e.wh);
    const bins = e.bins.map((b) => `${b.bin || '(ไม่ระบุช่อง)'}${b.lot ? ' ล็อต ' + b.lot : ''} มี ${h.fmt.num(b.qty)}${b.lastIn ? ' (รับ ' + h.fmt.date(U.bkkDate(b.lastIn)) + ')' : ''}`);
    return t`<div class="step" id="pk-card-${e.reservationId}">
      <span class="step-n">ใบจอง ${e.reservationId} · คลัง ${e.wh}${e.needDate ? ' · ต้องใช้ ' + h.fmt.date(e.needDate) : ''}</span>
      <div>${h.code(e.code)} <b>${e.name}</b> ${e.side ? h.badge('ข้าง ' + (SIDE[e.side] || e.side), 'accent') : ''} ${e.model ? h.badge('รุ่น ' + e.model, 'muted') : ''} ${e.drawingRev ? h.badge('แบบฉบับ ' + e.drawingRev, 'muted') : ''}</div>
      <p>ต้องหยิบ <b>${h.qty(e.remaining, e.baseUnit)}</b> <span class="muted">(จอง ${h.fmt.num(e.qty)} · เบิกแล้ว ${h.fmt.num(e.issued)})</span></p>
      <p class="hint">ช่องที่มีของ (เข้าก่อน หยิบก่อน): ${bins.length ? bins.join(' · ') : 'ไม่มี'}</p>
      ${e.notInBins > 0 && e.bins.length ? h.note(`ในช่องเก็บมีของใช้ได้ไม่พอ – ขาด ${h.fmt.num(e.notInBins)} ${e.baseUnit}`, 'warn') : ''}
      ${!canPick ? h.note(`คุณไม่มีสิทธิ์หยิบของคลัง ${e.wh}`, 'info') : ''}
      ${rows.map((r, n) => t`${rows.length > 1 && !r.none ? t`<p class="hint"><b>แถวหยิบ ${n + 1} จาก ${rows.length}</b>${r.added ? ' · เพิ่มเอง' : ''}</p>` : ''}${pickRow(ctx, r, vals, errs, canPick)}`)}
      ${canPick && e.bins.length > 0 ? t`<div>${h.btn('+ หยิบอีกช่อง', { act: 'addRow', arg: e.reservationId, tone: 'quiet', small: true })}</div>` : ''}
    </div>`;
  }
  function pickSection(ctx, job) {
    const v = ctx.view;
    const model = pickModel(ctx, job.jobNo);
    const canPickAny = ctx.can('pick.post');
    const pre = ctx.check('pick.post', { jobNo: job.jobNo, lines: [] });
    const blocking = ((pre && pre.errors) || []).filter((e) => BLOCKING[e.code]);
    const errs = v.errs && v.errsJob === job.jobNo ? v.errs : [];
    const vals = v.vals && v.errsJob === job.jobNo ? v.vals : null;
    const csvBtn = model.entries.length ? h.btn('ดาวน์โหลดใบจัดชุด (CSV)', { act: 'csv', tone: 'ghost', small: true }) : '';
    const lastDoc = v.lastDoc && v.lastDocJob === job.jobNo ? h.note(t`บันทึกหยิบแล้วเป็น ${docLink(v.lastDoc)} – ยอดคงเหลือและยอดจองลดแล้ว`, 'ok') : '';
    if (!model.entries.length) {
      const none = P.reservations(ctx.state, { jobNo: job.jobNo }).length === 0;
      return h.section('ใบจัดชุด', t`${lastDoc}${h.empty(none ? 'ยังไม่ได้จองของให้งานนี้' : 'ไม่มีของค้างหยิบ',
        none ? 'ใบจัดชุดสร้างจากการจอง – จองของให้งานนี้ที่หน้า งาน/SO และการจอง แล้วกลับมาหยิบที่นี่' : 'ทุกใบจองของงานนี้หยิบครบหรือปล่อยแล้ว – ถ้ายังต้องใช้เพิ่ม จองเพิ่มที่หน้า งาน/SO และการจอง',
        h.link('ไปหน้า งาน/SO และการจอง', 'jobs', { sel: job.jobNo }))}`, { id: 'pk-list' });
    }
    if (!canPickAny) {
      return h.section('ใบจัดชุด', t`${lastDoc}${h.table({ rows: model.rows, dense: true, scroll: true,
        cols: [{ label: 'ใบจอง', render: (r) => h.code(r.e.reservationId) }, { label: 'รายการ', render: (r) => t`${h.code(r.e.code)} ${r.e.name}` },
          { label: 'ข้าง', get: (r) => SIDE[r.e.side] || '' }, { label: 'คลัง/ช่อง', get: (r) => `${r.e.wh}${r.bin ? '/' + r.bin : ''}` }, { label: 'ล็อต', get: (r) => r.lot },
          { label: 'หยิบ', num: true, get: (r) => r.qty }, { label: 'ค้างหยิบ', num: true, get: (r) => r.e.remaining }] })}
        <p class="hint">สโตร์/หัวหน้าสโตร์เป็นผู้บันทึกหยิบ – หน้านี้แสดงใบจัดชุดให้ดูหรือดาวน์โหลดไปพิมพ์</p>`, { id: 'pk-list', actions: csvBtn });
    }
    const byEntry = {};
    for (const r of model.rows) (byEntry[r.i] || (byEntry[r.i] = [])).push(r);
    const cards = model.entries.map((e, i) => pickCard(ctx, e, byEntry[i] || [], vals, errs));
    const errBox = errs.length ? h.note(t`<b>บันทึกหยิบไม่ได้ – ยังไม่มีอะไรเปลี่ยน แก้แถวที่ขึ้นสีแดงแล้วกดบันทึกอีกครั้ง</b><ul class="errs">${errs.map((e) => t`<li>${e.message}</li>`)}</ul>`, 'bad') : '';
    const form = t`<form class="form" data-form="pick" novalidate id="pk-form">
      <div class="cols">${cards}</div>
      ${h.field({ name: 'remark', label: 'หมายเหตุใบหยิบ', value: vals ? vals.remark : '', wide: true, id: 'pk-remark' })}
      <div class="form-actions">${h.btn('บันทึกหยิบ (ตัดยอดเป็นใบ PD)', { type: 'submit', tone: 'primary', disabled: blocking.length > 0, id: 'pk-submit' })}
        <span class="hint">เว้นจำนวนว่างหรือ 0 = ยังไม่หยิบแถวนั้น · ทุกแถวบันทึกเป็นใบจ่ายเพื่อผลิต (PD) ใบเดียว ทั้งใบหรือไม่บันทึกเลย</span></div>
    </form>`;
    return h.section('ใบจัดชุด', t`${lastDoc}
      ${blocking.length ? h.note(t`<b>หยิบของให้งานนี้ไม่ได้ตอนนี้</b><ul class="errs">${blocking.map((e) => t`<li>${e.message}</li>`)}</ul>`, 'bad') : ''}
      ${errBox}${form}`, {
      id: 'pk-list', sub: 'สแกนหรือพิมพ์รหัสบนชิ้นงาน ระบบเทียบกับใบจองทันที (รหัส Express / รหัสนับสต็อกใช้ได้) · ข้างต้องตรง · BOM ต้องเป็นฉบับที่อนุมัติ',
      actions: csvBtn,
    });
  }

  // ---- return leftovers (RT) ----------------------------------------------------------------------------------------------
  function rtSection(ctx, job) {
    const v = ctx.view;
    const lines = comp(job).filter((l) => l.issued > 0);
    // the confirmation of the last return stays visible, also when it gave back everything that was issued
    const lastRt = v.lastRt && v.rtJob === job.jobNo ? h.note(t`รับคืนแล้วเป็น ${docLink(v.lastRt)} – ยอดเบิกของงานลดลงแล้ว`, 'ok') : '';
    if (!lines.length) {
      return h.section('คืนของเหลือเข้าคลัง (RT)', t`${lastRt}${h.empty(lastRt ? 'คืนของที่เบิกให้งานนี้ครบแล้ว' : 'ยังไม่มีของที่เบิกให้งานนี้', 'ของที่เบิกไปแล้วแต่เหลือจากการผลิต คืนเข้าคลังได้ที่นี่ – ระบบลดยอดเบิกของงานให้')}`, { id: 'pk-rt' });
    }
    const canRt = ctx.can('doc.post');
    if (!canRt) {
      return h.section('คืนของเหลือเข้าคลัง (RT)', t`${h.table({ rows: lines, dense: true, cols: [{ label: 'รายการ', render: (l) => t`${h.code(l.code)} ${(ctx.item(l.code) || {}).name || ''}` }, { label: 'เบิกไปแล้ว', num: true, key: 'issued' }] })}
        <p class="hint">สโตร์/หัวหน้าสโตร์เป็นผู้บันทึกรับคืน – นำของเหลือมาคืนที่สโตร์พร้อมเลขใบงาน ${job.jobNo}</p>`, { id: 'pk-rt' });
    }
    const vals = v.rtVals && v.rtJob === job.jobNo ? v.rtVals : null;
    const errs = v.rtErrs && v.rtJob === job.jobNo ? v.rtErrs : [];
    const whOpts = h.whOptions(ctx.state).filter(([c]) => ctx.can('doc.post', c));
    const cards = lines.map((l, i) => {
      const it = ctx.item(l.code) || {};
      const last = lastIssue(ctx, job.jobNo, l.code) || {};
      const x = (vals && (vals.rt || []).find((r) => r && r.code === l.code)) || {};
      const mine = errs.filter((e) => e.k === l.code);
      return t`<div class="step" data-rt="${i}"${h.safe(mine.length ? ' data-err="1"' : '')}>
        <span class="step-n">${l.code}</span><div><b>${it.name || ''}</b></div>
        <p>เบิกไปแล้ว ${h.qty(l.issued, it.baseUnit)} <span class="muted">· คืนได้ไม่เกินนี้</span></p>
        <input type="hidden" name="rt[${i}][code]" value="${l.code}">
        <div class="fgrid">
          ${h.field({ name: `rt[${i}][qty]`, label: `จำนวนที่คืน (${it.baseUnit || 'หน่วยหลัก'})`, type: 'number', value: x.qty, id: `rt-qty-${i}` })}
          ${h.field({ name: `rt[${i}][wh]`, label: 'เข้าคลัง', type: 'select', options: whOpts, value: x.wh != null ? x.wh : last.wh, id: `rt-wh-${i}` })}
          ${h.field({ name: `rt[${i}][bin]`, label: 'ช่องเก็บ', list: 'dl-bins', value: x.bin != null ? x.bin : last.bin, id: `rt-bin-${i}` })}
          ${it.trackLot && it.trackLot !== 'none' ? h.field({ name: `rt[${i}][lot]`, label: 'ล็อต / Heat', value: x.lot != null ? x.lot : last.lot, id: `rt-lot-${i}` }) : ''}
        </div>
        ${mine.length ? h.note(t`<ul class="errs">${mine.map((e) => t`<li>${e.message}</li>`)}</ul>`, 'bad') : ''}
      </div>`;
    });
    return h.section('คืนของเหลือเข้าคลัง (RT)', t`${lastRt}
      ${errs.length ? h.note(t`<b>บันทึกรับคืนไม่ได้ – ยังไม่มีอะไรเปลี่ยน</b><ul class="errs">${errs.map((e) => t`<li>${e.message}</li>`)}</ul>`, 'bad') : ''}
      <form class="form" data-form="rt" novalidate id="rt-form">
        <div class="cols">${cards}</div>
        ${h.field({ name: 'reason', label: 'เหตุผลที่คืน', type: 'textarea', rows: 2, required: true, wide: true, value: vals ? vals.reason : '', id: 'rt-reason', placeholder: 'เช่น ของเหลือจากการผลิต งานเปลี่ยนแบบ ยกเลิกงาน' })}
        <div class="form-actions">${h.btn('บันทึกรับคืน (RT)', { type: 'submit', tone: 'primary', id: 'rt-submit' })}<span class="hint">เว้นจำนวนว่าง = ไม่คืนรายการนั้น · ของคืนเข้าเป็นสถานะ ใช้ได้ ที่คลัง/ช่องที่เลือก</span></div>
      </form>`, { id: 'pk-rt', sub: `ของที่เบิกให้ ${job.jobNo} แล้วเหลือ คืนเข้าคลังพร้อมเลขใบงาน – ยอดเบิกของงานลดตาม (คืนเกินที่เบิกไม่ได้)` });
  }

  function docsSection(ctx, job) {
    const docs = RRS.q.rows(ctx.state, 'documents', (d) => U.normCode(d.job) === job.jobNo)
      .sort((a, b) => String(b.postedAt || b.createdAt || '').localeCompare(String(a.postedAt || a.createdAt || '')));
    if (!docs.length) return '';
    return h.section('เอกสารของงานนี้', h.table({ rows: docs, dense: true, scroll: true,
      cols: [{ label: 'เลขที่', render: (d) => docLink(d.docNo) }, { label: 'ประเภท', get: (d) => `${d.type} ${(RRS.inventory.DOC_TYPES[d.type] || {}).name || ''}` },
        { label: 'วันที่', get: (d) => h.fmt.date(d.date) }, { label: 'บรรทัด', num: true, get: (d) => (d.lines || []).length }, { label: 'สถานะ', render: (d) => h.docStatus(d.status) }] }));
  }

  // ---- page ------------------------------------------------------------------------------------------------------------
  RRS.ui.page({
    id: 'picking', title: 'ใบจัดชุดและหยิบของ', phase: 2, order: 20,
    sub: 'หยิบตามใบจองของงาน: ช่องเก็บที่มีของ เข้าก่อนหยิบก่อน สแกนรหัสตรวจของ/ข้าง แล้วตัดยอดเป็นใบ PD ใบเดียว · คืนของเหลือเข้าคลังด้วยใบ RT ของงาน',
    render(ctx) {
      const v = ctx.view;
      const choices = jobChoices(ctx, U.normCode(v.job));
      if (!choices.length) {
        return h.empty('ยังไม่มีงานที่จะจัดชุด', 'ใบจัดชุดสร้างจากการจองของใบงาน – สร้างใบงานและจองของที่หน้า งาน/SO และการจอง แล้วกลับมาหยิบที่นี่ (ใช้มือถือสแกนรหัสได้)',
          h.link('ไปหน้า งาน/SO และการจอง', 'jobs'));
      }
      const job = v.job ? RRS.q.get(ctx.state, 'jobs', U.normCode(v.job)) : null;
      const picker = h.toolbar([h.field({ name: 'job', label: 'งานที่จะจัดชุด', type: 'select', value: job ? job.jobNo : '', options: choices, blank: '— เลือกใบงาน —', act: 'pickJob', id: 'pk-job' })],
        job ? h.link('ดูใบงาน', 'jobs', { sel: job.jobNo }) : '');
      if (!job) return t`${picker}${h.empty('เลือกใบงานที่จะจัดชุด', 'รายการจองที่ยังไม่ได้หยิบ ช่องเก็บที่มีของ (ของที่รับเข้าก่อนหยิบก่อน) และฟอร์มหยิบจะขึ้นที่นี่')}`;
      const it = job.product ? ctx.item(job.product) || {} : null;
      const head = h.dl([
        ['ใบงาน', h.code(job.jobNo)], ['SO', job.soNo], ['สินค้าที่ผลิต', job.product ? `${job.product} ${it.name || ''} · BOM ฉบับ ${job.bomRev}` : 'ระบุรายการเอง'],
        ['จำนวนชุด', job.qty ? h.fmt.num(job.qty) : ''], ['วันต้องใช้', job.dueDate ? h.fmt.date(job.dueDate) : ''], ['สถานะ', jobBadge(job.status)],
      ]);
      return t`${picker}${head}
        ${OPEN[job.status] ? pickSection(ctx, job) : h.note(`ใบงาน${P.JOB_STATUS[job.status]} – หยิบ/เบิกเข้างานนี้ไม่ได้ คืนของเหลือได้ด้านล่าง`, 'info')}
        ${rtSection(ctx, job)}
        ${docsSection(ctx, job)}`;
    },
    after(ctx, root0) {
      // scanned code compared with the reservation while typing (the engine checks again on save)
      const check = (el) => {
        const out = root0.querySelector(`[data-scan-out="${el.dataset.scan}"]`);
        if (!out) return;
        const val = U.trim(el.value);
        const want = el.dataset.code;
        if (!val) { out.className = 'badge b-muted'; out.textContent = 'ยังไม่สแกน'; return; }
        const it = RRS.q.item(ctx.state, val);
        if (it && it.id === want) { out.className = 'badge b-ok'; out.textContent = `ตรงกับใบจอง ${it.id}`; return; }
        out.className = 'badge b-bad';
        out.textContent = it ? `ไม่ตรง: สแกนได้ ${it.id} ${it.name} – ต้องหยิบ ${want}` : `ไม่ตรง: ไม่พบรหัส ${val} ในทะเบียน – ต้องหยิบ ${want}`;
      };
      for (const el of root0.querySelectorAll('input[data-scan]')) {
        check(el);
        el.addEventListener('input', () => check(el));
      }
      // a scanner ends with Enter: go to the next field instead of saving the whole pick
      for (const form of root0.querySelectorAll('form[data-form="pick"], form[data-form="rt"]')) {
        form.addEventListener('keydown', (ev) => {
          if (ev.key !== 'Enter' || ev.target.tagName !== 'INPUT') return;
          ev.preventDefault();
          const fields = Array.from(form.querySelectorAll('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea'));
          const next = fields[fields.indexOf(ev.target) + 1];
          if (next) next.focus();
        });
      }
    },
    actions: {
      pickJob: (ctx, el) => ctx.set({ job: el.value, vals: null, errs: null, rtVals: null, rtErrs: null, lastDoc: null, lastRt: null }),
      addRow(ctx, el) {
        const form = root.document.querySelector('form[data-form="pick"]');
        const vals = form ? h.parseForm(form) : null;
        const jobNo = U.normCode(ctx.view.job);
        const extra = Object.assign({}, ctx.view.extra || {});
        const mine = Object.assign({}, extra[jobNo] || {});
        mine[el.dataset.arg] = (mine[el.dataset.arg] || 0) + 1;
        extra[jobNo] = mine;
        // rows are keyed by reservation: the added row gets the next key, what was typed stays where it was
        ctx.set({ extra, vals, errs: null, errsJob: jobNo });
      },
      async csv(ctx) {
        const jobNo = U.normCode(ctx.view.job);
        const job = RRS.q.get(ctx.state, 'jobs', jobNo);
        const rows = [['ใบงาน', 'SO', 'ใบจอง', 'รหัสสินค้า', 'ชื่อสินค้า', 'ข้าง', 'รุ่น', 'คลัง', 'ช่องเก็บ', 'ล็อต', 'หยิบ', 'ค้างหยิบรวม', 'หน่วย', 'วันต้องใช้']];
        for (const r of pickModel(ctx, jobNo).rows) {
          rows.push([jobNo, job ? job.soNo : '', r.e.reservationId, r.e.code, r.e.name, r.e.side, r.e.model, r.e.wh, r.bin, r.lot, r.qty, r.e.remaining, r.e.baseUnit, r.e.needDate]);
        }
        await ctx.download(`ใบจัดชุด-${jobNo}.csv`, h.csv(rows));
      },
    },
    forms: {
      async pick(ctx, vals) {
        const jobNo = U.normCode(ctx.view.job);
        const model = pickModel(ctx, jobNo);
        // a row that was typed but is no longer in the pick list: someone picked or changed the reservations meanwhile
        const known = {};
        for (const row of model.rows) known[row.k] = row;
        const gone = Object.keys(vals.p || {}).filter((k) => {
          const x = vals.p[k] || {};
          return U.trim(x.qty) && U.num(x.qty) !== 0 && (!known[k] || known[k].none || (x.rid && x.rid !== known[k].e.reservationId));
        });
        if (gone.length) {
          return ctx.set({ vals, errsJob: jobNo, errs: [{ k: null, message: `ใบจัดชุดเปลี่ยนระหว่างที่กรอก (มีคนบันทึกหยิบหรือเปลี่ยนการจองของงานนี้) – ${gone.length} แถวที่กรอกไว้ไม่อยู่ในรายการแล้ว ตรวจตัวเลขในแต่ละใบจองอีกครั้งแล้วกดบันทึก` }] });
        }
        const lines = [];
        const map = [];
        for (const row of model.rows) {
          if (row.none) continue;
          const x = (vals.p || {})[row.k] || {};
          const raw = U.trim(x.qty);
          if (!raw || U.num(raw) === 0) continue;
          const parts = String(x.binlot || '').split('|');
          if (!x.binlot) {
            return ctx.set({ vals, errsJob: jobNo, errs: [{ k: row.k, message: `${row.e.code} (ใบจอง ${row.e.reservationId}): เลือกช่องเก็บที่หยิบ` }] });
          }
          lines.push({ reservationId: row.e.reservationId, qty: raw, wh: row.e.wh, bin: parts[0] || '', lot: parts.slice(1).join('|'),
            scannedCode: U.trim(x.scan), scannedSide: x.side || '' });
          map.push(row);
        }
        if (!lines.length) return ctx.toast('ใส่จำนวนที่หยิบอย่างน้อย 1 แถว', 'bad');
        const payload = { jobNo, lines, remark: vals.remark };
        const label = (row) => `${row.e.code} (ใบจอง ${row.e.reservationId}${map.filter((m) => m.e.reservationId === row.e.reservationId).length > 1 ? ' ช่อง ' + (row.bin || '-') : ''})`;
        const pre = ctx.check('pick.post', payload);
        if (!pre.ok) return ctx.set({ vals, errsJob: jobNo, errs: mapErrs(pre.errors, map, label) });
        const total = lines.length;
        const unscanned = lines.filter((l) => !l.scannedCode).length;
        const what = map.map((row, n) => {
          const l = lines[n];
          return `${row.e.code} ${h.fmt.num(U.num(l.qty))} ${row.e.baseUnit} จาก ${row.e.wh}/${l.bin || '(ไม่ระบุช่อง)'}${l.lot ? ' ล็อต ' + l.lot : ''}${l.scannedCode ? '' : ' · ยังไม่สแกน'}`;
        });
        const ok = await ctx.confirm({ title: `บันทึกหยิบให้ ${jobNo}`, ok: 'บันทึกหยิบ',
          message: `ตัดยอด ${total} แถวเป็นใบจ่ายเพื่อผลิต (PD) 1 ใบ – ยอดคงเหลือในช่องเก็บและยอดจองของงานลดทันที ทั้งใบหรือไม่บันทึกเลย`,
          body: t`<div class="wide" id="pk-confirm"><ul>${what.map((w) => t`<li>${w}</li>`)}</ul>${unscanned ? h.note(`ยังไม่สแกน ${unscanned} แถว – ระบบตรวจรหัสและข้างเฉพาะแถวที่สแกน ตรวจของกับใบจองให้ตรงก่อนบันทึก`, 'warn') : ''}</div>` });
        if (!ok) return;
        const r = await ctx.exec('pick.post', payload, { quiet: true });
        if (!r.ok) return ctx.set({ vals, errsJob: jobNo, errs: mapErrs(r.errors, map, label) });
        ctx.toast(`บันทึกหยิบแล้วเป็น ${r.result.docNo}`, 'ok');
        const extra = Object.assign({}, ctx.view.extra || {});
        delete extra[jobNo];
        ctx.set({ vals: null, errs: null, lastDoc: r.result.docNo, lastDocJob: jobNo, extra });
      },
      async rt(ctx, vals) {
        const jobNo = U.normCode(ctx.view.job);
        const job = RRS.q.get(ctx.state, 'jobs', jobNo);
        if (!job) return;
        const reason = U.trim(vals.reason);
        const lines = [];
        const map = [];
        (vals.rt || []).forEach((x) => {
          if (!x || !U.trim(x.qty) || U.num(x.qty) === 0) return;
          lines.push({ code: x.code, qty: U.trim(x.qty), wh: x.wh, bin: x.bin, lot: x.lot || '', remark: reason });
          map.push({ k: x.code, code: x.code });
        });
        const set = (errs) => ctx.set({ rtVals: vals, rtErrs: errs, rtJob: jobNo });
        if (!lines.length) return set([{ k: null, message: 'ใส่จำนวนที่คืนอย่างน้อย 1 รายการ' }]);
        if (!reason) return set([{ k: null, message: 'ระบุเหตุผลที่คืน เช่น ของเหลือจากการผลิต' }]);
        const payload = { type: 'RT', job: jobNo, ref: job.soNo, remark: reason, lines };
        const label = (row) => row.code;
        const toErrs = (errors) => (errors || []).map((e) => {
          const row = e.line ? map[e.line - 1] : null;
          const msg = String(e.message || '').replace(/^บรรทัด\s+\d+(?:,\s*\d+)*:\s*/, '');
          return { k: row ? row.k : null, message: row ? `${label(row)}: ${msg}` : msg };
        });
        const pre = ctx.check('doc.post', payload);
        if (!pre.ok) return set(toErrs(pre.errors));
        const ok = await ctx.confirm({ title: `รับคืนของเหลือจาก ${jobNo}`, ok: 'บันทึกรับคืน',
          message: `บันทึกใบรับคืน (RT) ${lines.length} บรรทัด – ของเข้าคลังเป็นสถานะ ใช้ได้ และยอดเบิกของงานลดลงตามที่คืน` });
        if (!ok) return;
        const r = await ctx.exec('doc.post', payload, { quiet: true });
        if (!r.ok) return set(toErrs(r.errors));
        ctx.toast(`รับคืนแล้วเป็น ${r.result.docNo}`, 'ok');
        ctx.set({ rtVals: null, rtErrs: null, lastRt: r.result.docNo, rtJob: jobNo });
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
