/*
 * Phase 3 – นำเข้าและกระทบยอด Express (engine: RRS.reconcile).
 *   นำเข้าไฟล์      pick the Express stock report (h.readTable: rows + SHA-256 of the bytes), find the header row, map
 *                   the columns รหัสสินค้า / คลัง / ยอดคงเหลือ / หน่วย (h.mapHeader, changeable), enter the time of the
 *                   data (required: the difference is taken at that moment), dry run (ctx.check), then express.import –
 *                   a file seen before is refused and nothing in stock changes
 *   รอบนำเข้า       batch list; review = RRS.reconcile.reconcile (Express, RRS at the snapshot, RRS now, diff, status,
 *                   documents not yet keyed at the snapshot) with filters; resolve a row: adjust (only when
 *                   settings.ownership.qty is Express; confirmOld for a file older than the newest closed batch) or
 *                   explain with a reason; close / discard
 *   รอคีย์ Express  posted documents still to be keyed in Express (RRS.reconcile.pendingExpress) → documents page
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  if (!RRS || !RRS.ui || !RRS.reconcile) return; // engine module not in this build: no screen
  const { h } = RRS.ui;
  const { t } = h;
  const { util } = RRS;
  const rec = RRS.reconcile;

  const ALIASES = {
    code: ['รหัสสินค้า', 'รหัส', 'รหัสสินค้า express', 'code', 'item code', 'itemcode', 'product code', 'stkcod', 'stock code'],
    wh: ['คลัง', 'รหัสคลัง', 'คลังสินค้า', 'ที่เก็บ', 'warehouse', 'wh', 'loccod', 'location'],
    qty: ['ยอดคงเหลือ', 'คงเหลือ', 'จำนวนคงเหลือ', 'ยอดคงเหลือ (จำนวน)', 'จำนวน', 'ยอด', 'qty', 'quantity', 'balance', 'onhand', 'on hand', 'locbal'],
    unit: ['หน่วย', 'หน่วยนับ', 'unit', 'uom', 'unitnam'],
  };
  const FIELDS = [
    { k: 'code', label: 'รหัสสินค้า', need: true, why: 'ระบบหาสินค้าจากรหัสหลัก รหัส Express หรือรหัสนับสต็อกเท่านั้น ไม่จับคู่จากชื่อ' },
    { k: 'wh', label: 'คลัง', need: false, why: 'ไม่มีคอลัมน์นี้ = ทุกแถวเป็นคลังเริ่มต้นของ Express' },
    { k: 'qty', label: 'ยอดคงเหลือ', need: true, why: 'จำนวน ณ เวลาของไฟล์' },
    { k: 'unit', label: 'หน่วย', need: false, why: 'ไม่มี = หน่วยหลักของสินค้า' },
  ];
  const STEP = 300;
  const PREVIEW = 12;
  const ROW_TONE = { MATCH: 'ok', DIFF: 'warn', ONLY_EXPRESS: 'info', ONLY_RRS: 'info', UNKNOWN_CODE: 'bad' };
  const BATCH_TONE = { REVIEW: 'warn', CLOSED: 'ok', DISCARDED: 'muted' };
  const FILTERS = [
    ['open', 'ยังไม่ตัดสิน'], ['all', 'ทั้งหมด'], ['DIFF', 'ยอดต่าง'], ['ONLY_EXPRESS', 'มีเฉพาะใน Express'], ['ONLY_RRS', 'มีเฉพาะใน RRS'],
    ['UNKNOWN_CODE', 'ไม่รู้จักรหัส'], ['MATCH', 'ตรงกัน'], ['resolved', 'ตัดสินแล้ว'],
  ];
  const dash = t`<span class="muted">–</span>`;
  const low = (s) => String(s == null ? '' : s).toLowerCase();
  const docView = (docNo) => ({ sel: docNo, lines: null, checked: null, header: null, tab: 'all', q: '', type: '' });
  const docLink = (no) => (no ? h.link(h.code(no), 'docs', docView(no)) : dash);
  const signed = (n) => (n == null ? '' : `${n > 0 ? '+' : ''}${h.fmt.num(n)}`);
  const roleNames = (perm) => RRS.auth.rolesFor(perm).filter((r) => r !== 'admin').map((r) => RRS.auth.ROLES[r] || r).join(' / ');
  const colName = (i) => {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };

  function settingsOf(state) {
    const d = RRS.defaultSettings();
    const s = RRS.q.get(state, 'settings', 'main') || {};
    return Object.assign({}, d, s, { ownership: Object.assign({}, d.ownership, s.ownership), policies: Object.assign({}, d.policies, s.policies),
      express: Object.assign({}, d.express, s.express) });
  }
  const expressOwns = (state) => settingsOf(state).ownership.qty === 'Express';

  /** 'YYYY-MM-DDTHH:MM[:SS]' typed in Thai time -> ISO with +07:00 ('' when not a full date and time). */
  function snapIso(v) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?(\.\d+)?$/.exec(util.trim(v));
    return m ? `${m[1]}T${m[2]}${m[3] || ':00'}+07:00` : '';
  }

  // ---- reading the file ------------------------------------------------------------------------------------------
  /** The header row: the first of the top rows naming both a code and a quantity column, else the one naming most. */
  function findHeader(rows) {
    let best = { row: 0, map: {}, score: -1 };
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const map = h.mapHeader(rows[i] || [], ALIASES);
      const both = map.code != null && map.qty != null;
      const score = Object.keys(map).length + (both ? 10 : 0);
      if (score > best.score) best = { row: i, map, score };
      if (both) break;
    }
    return best;
  }

  /** Data rows under the header: rows without a code are skipped (totals, blank lines); a code needs a number. */
  function parseSrc(src) {
    const map = src.map || {};
    const out = { rows: [], skipped: [], bad: [] };
    src.rows.slice(src.headerRow + 1).forEach((r, i) => {
      const fileRow = src.headerRow + 2 + i;
      const cell = (k) => (map[k] != null ? util.trim(r[map[k]]) : '');
      const code = cell('code');
      if (!code) {
        if ((r || []).some((x) => util.trim(x))) out.skipped.push(fileRow);
        return;
      }
      const qtyRaw = cell('qty');
      const qty = util.num(qtyRaw);
      if (qtyRaw === '' || isNaN(qty)) out.bad.push({ row: fileRow, code, qty: qtyRaw });
      out.rows.push({ row: fileRow, code, wh: cell('wh'), qty: isNaN(qty) ? qtyRaw : qty, unit: cell('unit') });
    });
    return out;
  }

  /** Express warehouse -> RRS warehouse, the way express.import maps it (display only – the engine decides). */
  function whMap(state, raw) {
    const whs = RRS.q.rows(state, 'warehouses', (w) => w.code !== RRS.TRANSIT);
    const find = (code) => {
      const k = util.ckey(code);
      if (!k) return null;
      const byExp = whs.filter((w) => w.expressCode && util.ckey(w.expressCode) === k);
      if (byExp.length) return { wh: byExp.length > 1 ? '' : byExp[0].code, by: byExp.length > 1 ? 'ambiguous' : 'expressCode' };
      const same = whs.find((w) => w.code === util.normCode(code));
      return same ? { wh: same.code, by: 'code' } : null;
    };
    const direct = find(raw);
    if (direct) return direct;
    const d = find(settingsOf(state).express.defaultWarehouse);
    return d && d.wh ? { wh: d.wh, by: 'default' } : { wh: '', by: 'none' };
  }

  let dryCache = { key: '', r: null };
  /** Dry run of the import (errors of a real import, nothing saved). Without a time yet a minute ago stands in. */
  function dryRun(ctx, payload) {
    const key = `${ctx.state.seq}|${ctx.user ? ctx.user.id : ''}|${util.sha256(util.stable(payload))}`;
    if (dryCache.key === key) return dryCache.r;
    const probe = Object.assign({}, payload, { snapshotAt: payload.snapshotAt || new Date(Date.now() - 60000).toISOString() });
    const r = ctx.check('express.import', probe);
    dryCache = { key, r };
    return r;
  }
  const payloadOf = (src, parsed, snapshotAt) => ({
    source: 'Express', fileName: src.name, fileHash: src.hash, snapshotAt,
    rows: parsed.rows.map((r) => ({ row: r.row, code: r.code, wh: r.wh, qty: r.qty, unit: r.unit })),
  });

  // ---- import tab ------------------------------------------------------------------------------------------------
  function importTab(ctx) {
    const v = ctx.view;
    if (!ctx.can('express.import')) {
      return h.empty('คุณนำเข้าไฟล์ Express ไม่ได้', `ผู้นำเข้าไฟล์คือ ${roleNames('express.import')} – ผลกระทบยอดของไฟล์ที่นำเข้าแล้วดูได้ที่แท็บ รอบนำเข้า`);
    }
    const intro = h.note(t`<b>ไฟล์ Express คือภาพยอด ณ เวลาที่ออกรายงาน ไม่ใช่ยอดสด</b> – นำเข้าแล้วระบบเทียบกับยอด RRS ณ เวลาเดียวกัน
      <b>ยอดคงเหลือไม่เปลี่ยน</b> · ไฟล์เดิม (เนื้อหาเดียวกัน แม้เปลี่ยนชื่อ) นำเข้าซ้ำไม่ได้ · ระบบหาสินค้าจากรหัสหลัก รหัส Express หรือรหัสนับสต็อกเท่านั้น ไม่จับคู่จากชื่อ`, 'info');
    const pick = h.section('1 · เลือกไฟล์รายงานสินค้าคงเหลือจาก Express', t`
      <p class="hint">ไฟล์ .xlsx .xls หรือ .csv ที่ส่งออกจาก Express · ต้องมีคอลัมน์ รหัสสินค้า และ ยอดคงเหลือ (คลังและหน่วยมีหรือไม่มีก็ได้) · แถวหัวรายงานด้านบนตารางไม่เป็นไร ระบบหาแถวหัวตารางให้</p>
      ${v.readErr ? h.note(v.readErr, 'bad') : ''}
      <div class="fgrid">${h.field({ name: 'file', label: v.src ? 'เลือกไฟล์อื่น' : 'ไฟล์ Express', type: 'file', accept: '.xlsx,.xls,.xlsm,.csv,.txt,.tsv', act: 'readFile', wide: true, id: 'ex-file' })}</div>`);
    if (!v.src) return t`${intro}${pick}`;
    return t`${intro}${pick}${fileReview(ctx)}`;
  }

  function fileReview(ctx) {
    const v = ctx.view;
    const src = v.src;
    const header = src.rows[src.headerRow] || [];
    const width = Math.max(header.length, ...src.rows.slice(0, 50).map((r) => (r || []).length));
    const colOpts = Array.from({ length: width }, (_, i) => [String(i), `${colName(i)} · ${util.trim(header[i]) || '(ไม่มีหัว)'}`]);
    const parsed = parseSrc(src);
    const sample = src.rows[src.headerRow + 1] || [];
    const mapRows = FIELDS.map((f) => {
      const cur = src.map[f.k];
      const sel = t`<select id="ex-map-${f.k}" data-act="mapCol" data-arg="${f.k}" aria-label="คอลัมน์ของ ${f.label}"><option value="">${f.need ? '— ยังไม่ได้เลือก —' : '— ไม่มีในไฟล์ —'}</option>${colOpts.map(([val, lab]) => t`<option value="${val}"${h.safe(cur != null && String(cur) === val ? ' selected' : '')}>${lab}</option>`)}</select>`;
      return { f, cur, sel, example: cur != null ? util.trim(sample[cur]) : '' };
    });
    const mapTbl = h.table({ rows: mapRows, dense: true, id: 'ex-map', cols: [
      { label: 'ข้อมูล', render: (m) => t`<b>${m.f.label}</b>${m.f.need ? t` <b class="req">*</b>` : ''}<br><small class="hint">${m.f.why}</small>` },
      { label: 'คอลัมน์ในไฟล์', render: (m) => t`${m.sel}${m.cur == null ? t`<br>${h.badge(m.f.need ? 'ต้องเลือก' : 'ไม่มีในไฟล์', m.f.need ? 'bad' : 'muted')}` : ''}` },
      { label: 'ตัวอย่างแถวแรก', render: (m) => (m.cur == null ? dash : m.example ? m.example : t`<span class="muted">(ว่าง)</span>`) },
    ] });
    const headOpts = src.rows.slice(0, Math.min(src.rows.length, 30)).map((r, i) => [String(i), `แถว ${i + 1}: ${(r || []).filter((x) => util.trim(x)).slice(0, 4).join(' | ').slice(0, 60) || '(ว่าง)'}`]);
    const headSel = h.field({ name: 'headerRow', label: 'แถวหัวตาราง', type: 'select', blank: false, value: String(src.headerRow), options: headOpts, act: 'headRow', id: 'ex-head' });

    // duplicate file: refused by the engine – said here before anyone types the time
    const same = RRS.q.rows(ctx.state, 'express_batches', (b) => b.fileHash === src.hash);
    const live = same.find((b) => b.status !== 'DISCARDED');
    const discarded = same.filter((b) => b.status === 'DISCARDED');
    const missing = FIELDS.filter((f) => f.need && src.map[f.k] == null);
    const snap = snapIso(v.snap);
    const payload = payloadOf(src, parsed, snap);
    const dry = !live && !missing.length && parsed.rows.length && !parsed.bad.length ? dryRun(ctx, payload) : null;
    const dryErrs = dry && !dry.ok ? dry.errors.filter((e) => e.code !== 'BAD_TIME' && e.code !== 'FUTURE_TIME') : [];
    const blockers = [];
    if (live) blockers.push(`ไฟล์นี้นำเข้าแล้วเป็นรอบ ${live.id} (${rec.BATCH_STATUS[live.status]}) เมื่อ ${h.fmt.dt(live.importedAt)} – ไม่นำเข้าซ้ำ เปิดรอบเดิมที่แท็บ รอบนำเข้า`);
    for (const f of missing) blockers.push(`เลือกคอลัมน์ของ ${f.label} ในตารางจับคู่ด้านบน`);
    if (!missing.length && !parsed.rows.length) blockers.push('ไม่พบแถวที่มีรหัสสินค้าใต้แถวหัวตาราง – ตรวจว่าเลือกแถวหัวตารางและคอลัมน์รหัสสินค้าถูก');
    for (const b of parsed.bad.slice(0, 8)) blockers.push(`แถว ${b.row} (${b.code}): ยอดคงเหลือ "${b.qty}" ไม่ใช่ตัวเลข – แก้ในไฟล์ หรือเลือกคอลัมน์ยอดคงเหลือให้ถูก`);
    if (parsed.bad.length > 8) blockers.push(`… และอีก ${parsed.bad.length - 8} แถวที่ยอดไม่ใช่ตัวเลข`);
    for (const e of dryErrs.slice(0, 8)) blockers.push(e.message);

    // what the rows read as
    const items = {};
    const whs = {};
    let unknown = 0;
    let byDefault = 0;
    for (const r of parsed.rows) {
      const it = RRS.q.item(ctx.state, r.code);
      if (!it) unknown++;
      items[r.code] = it;
      const m = whs[r.wh] || (whs[r.wh] = whMap(ctx.state, r.wh));
      if (m.by === 'default' && r.wh) byDefault++;
    }
    const preview = h.table({ rows: parsed.rows.slice(0, PREVIEW), dense: true, scroll: true, id: 'ex-preview', empty: 'ยังไม่มีแถวข้อมูล', emptyText: 'แถวที่มีรหัสสินค้าจะขึ้นที่นี่',
      cols: [
        { label: 'แถว', num: true, key: 'row' },
        { label: 'รหัสในไฟล์', render: (r) => h.code(r.code) },
        { label: 'อ่านเป็น', render: (r) => (items[r.code] ? t`${h.code(items[r.code].id)} <small class="muted">${items[r.code].name}</small>` : h.badge('ไม่รู้จักรหัส', 'bad')) },
        { label: 'คลัง', render: (r) => {
          const m = whs[r.wh];
          const raw = r.wh ? h.code(r.wh) : t`<span class="muted">(ว่าง)</span>`;
          if (m.by === 'none' || m.by === 'ambiguous') return t`${raw} → ${h.badge(m.by === 'ambiguous' ? 'ผูกหลายคลัง' : 'ไม่พบคลัง', 'bad')}`;
          return t`${raw} → ${h.code(m.wh)}${m.by === 'default' ? t` <small class="muted">(คลังเริ่มต้น)</small>` : ''}`;
        } },
        { label: 'ยอด', num: true, render: (r) => (typeof r.qty === 'number' ? h.fmt.num(r.qty) : t`<b>${r.qty || '(ว่าง)'}</b>`) },
        { label: 'หน่วย', render: (r) => r.unit || (items[r.code] ? t`<span class="muted">${items[r.code].baseUnit}</span>` : dash) },
      ] });
    const facts = h.kpis([
      h.kpi('แถวที่จะนำเข้า', h.fmt.num(parsed.rows.length), `จาก ${h.fmt.num(Math.max(0, src.rows.length - src.headerRow - 1))} แถวใต้หัวตาราง`),
      h.kpi('ไม่รู้จักรหัส', h.fmt.num(unknown), unknown ? 'นำเข้าได้ แต่ต้องอธิบายก่อนปิดรอบ' : 'ทุกแถวรู้จักรหัส', unknown ? 'warn' : 'ok'),
      h.kpi('ใช้คลังเริ่มต้น', h.fmt.num(byDefault), byDefault ? 'รหัสคลังในไฟล์ไม่ตรงกับคลังใด' : 'ทุกแถวพบคลัง', byDefault ? 'warn' : ''),
      h.kpi('ข้าม (ไม่มีรหัส)', h.fmt.num(parsed.skipped.length), parsed.skipped.length ? 'เช่น แถวรวม แถวหัวกลุ่ม' : 'ไม่มี'),
    ]);
    const warns = dry && dry.ok ? (dry.warnings || []) : [];
    const snapField = h.field({ name: 'snap', label: 'ข้อมูลในไฟล์เป็นยอด ณ วันเวลา (เวลาประเทศไทย)', type: 'datetime', required: true, value: v.snap, act: 'snap', id: 'ex-snap',
      hint: 'ดูจากหัวรายงาน Express หรือเวลาที่สั่งพิมพ์/ส่งออก · ระบบคิดยอด RRS ย้อนไป ณ เวลานี้ เอกสารที่บันทึกหลังเวลานี้จะไม่ถูกนับเป็นผลต่าง – ใส่ผิดผลต่างจะผิด' });
    const impErr = v.impErr ? h.note(t`นำเข้าไม่ได้ – ยังไม่มีอะไรเปลี่ยน${h.errors({ errors: v.impErr })}`, 'bad') : '';
    return t`${h.section(t`2 · ตรวจไฟล์ ${src.name}`, t`
        ${h.dl([['ไฟล์', src.name], ['แถวทั้งหมดในไฟล์', h.fmt.num(src.rows.length)], ['ลายนิ้วมือไฟล์ (SHA-256)', t`<span class="mono">${src.hash.slice(0, 16)}…</span>`],
          ['หัวตารางอยู่แถว', h.fmt.num(src.headerRow + 1)]])}
        ${live ? h.note(t`<b>ไฟล์นี้นำเข้าแล้ว</b> เป็นรอบ ${h.code(live.id)} (${rec.BATCH_STATUS[live.status]}) เมื่อ ${h.fmt.dt(live.importedAt)} โดย ${ctx.userName(live.importedBy)} – ไฟล์เดิมนำเข้าซ้ำไม่ได้ ${h.btn('เปิดรอบ ' + live.id, { act: 'pick', arg: live.id, tone: 'ghost', small: true })}`, 'bad') : ''}
        ${!live && discarded.length ? h.note(`ไฟล์นี้เคยนำเข้าเป็นรอบ ${discarded.map((b) => b.id).join(', ')} แล้วยกเลิกรอบ – นำเข้าใหม่ได้ (เช่น หลังแก้รหัส Express ในทะเบียนสินค้า)`, 'info') : ''}
        <h3>จับคู่คอลัมน์</h3>
        <div class="fgrid">${headSel}</div>
        ${mapTbl}
        <h3>ตัวอย่างแถวที่อ่านได้</h3>
        ${facts}${preview}
        ${parsed.rows.length > PREVIEW ? t`<p class="hint">แสดง ${PREVIEW} แถวแรกจาก ${h.fmt.num(parsed.rows.length)} แถว</p>` : ''}`,
      { sub: 'ยังไม่มีอะไรเปลี่ยน – ตรวจว่าแต่ละข้อมูลมาจากคอลัมน์ที่ถูก ถ้าผิดเลือกคอลัมน์ใหม่ได้' })}
      ${h.section('3 · เวลาของข้อมูลและนำเข้า', t`
        <div class="fgrid">${snapField}</div>
        ${blockers.length ? h.note(t`ยังนำเข้าไม่ได้${h.errors({ errors: blockers.map((m) => ({ message: m })) })}`, 'bad') : ''}
        ${warns.map((w) => h.note(w, 'warn'))}
        ${impErr}
        <div class="form-actions">${h.btn('นำเข้าเป็นรอบใหม่ (ยอดไม่เปลี่ยน)', { act: 'doImport', tone: 'primary', id: 'ex-import', disabled: blockers.length > 0 })}${h.btn('ยกเลิก ไม่นำเข้าไฟล์นี้', { act: 'dropFile', tone: 'ghost' })}</div>`,
      { sub: 'นำเข้าแล้วไปตรวจผลต่างรายสินค้าได้ทันที – การปรับยอดหรืออธิบายผลต่างเป็นขั้นต่อไป' })}`;
  }

  // ---- batches ---------------------------------------------------------------------------------------------------
  function batchList(ctx) {
    const v = ctx.view;
    const all = RRS.q.rows(ctx.state, 'express_batches').sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)) || b.id.localeCompare(a.id));
    if (!all.length) {
      return h.empty('ยังไม่มีไฟล์ Express ที่นำเข้า', ctx.can('express.import')
        ? 'นำเข้าไฟล์รายงานสินค้าคงเหลือจาก Express เพื่อเทียบกับยอดในระบบ ณ เวลาเดียวกัน – การนำเข้าไม่เปลี่ยนยอดคงเหลือ แต่ละไฟล์จะเป็นหนึ่งรอบในรายการนี้'
        : `เมื่อ${roleNames('express.import')}นำเข้าไฟล์รายงานสินค้าคงเหลือจาก Express แล้ว รอบนำเข้าและผลต่างจะขึ้นที่นี่`,
      ctx.can('express.import') ? h.btn('นำเข้าไฟล์แรก', { act: 'tab', arg: 'import', tone: 'primary' }) : '');
    }
    return h.table({ rows: all, rowAct: 'pick', rowArg: (b) => b.id, rowCls: (b) => (b.id === v.sel ? 'sel' : b.status === 'DISCARDED' ? 'muted' : ''), scroll: true, id: 'ex-batches',
      cols: [
        { label: 'รอบ', render: (b) => h.code(b.id) },
        { label: 'ไฟล์', render: (b) => t`${b.fileName}<br><small class="muted mono">${String(b.fileHash || '').slice(0, 10)}…</small>` },
        { label: 'ข้อมูล ณ', get: (b) => h.fmt.dt(b.snapshotAt) },
        { label: 'นำเข้าโดย', render: (b) => t`${ctx.userName(b.importedBy)}<br><small class="muted">${h.fmt.dt(b.importedAt)}</small>` },
        { label: 'แถว', num: true, get: (b) => (b.rows || []).length },
        { label: 'ไม่รู้จักรหัส', num: true, render: (b) => (b.unknownRows ? h.badge(h.fmt.num(b.unknownRows), 'warn') : dash) },
        { label: 'สถานะ', render: (b) => t`${h.badge(rec.BATCH_STATUS[b.status] || b.status, BATCH_TONE[b.status])}${b.olderThanLatest ? t` ${h.badge('ไฟล์เก่ากว่ารอบที่ปิด', 'warn')}` : ''}` },
      ] });
  }

  function rowFilter(r, f) {
    if (f === 'all') return true;
    if (f === 'open') return r.status !== 'MATCH' && !r.resolved;
    if (f === 'resolved') return r.resolved;
    return r.status === f;
  }
  /** Why this row cannot be adjusted from the file ('' = it can). */
  function noAdjust(ctx, rc, r) {
    const b = rc.batch;
    if (b.status !== 'REVIEW') return `รอบนี้${rec.BATCH_STATUS[b.status]}แล้ว`;
    if (r.status === 'UNKNOWN_CODE') return 'แถวนี้ไม่รู้จักรหัส ระบบไม่รู้ว่าเป็นสินค้าใด จึงปรับยอดไม่ได้ – ถ้าเป็นสินค้าที่มีในระบบ ให้ใส่รหัส Express ในทะเบียนสินค้า แล้วยกเลิกรอบนี้และนำเข้าไฟล์ใหม่';
    if (!expressOwns(ctx.state)) return 'ข้อตกลง ค-1: ยอดจำนวนเป็นของระบบ RRS – ไฟล์ Express ใช้กระทบยอดเท่านั้น จึงปรับยอดจากไฟล์ไม่ได้ ถ้าของจริงไม่ตรงกับระบบให้เปิดรอบตรวจนับ';
    if (!r.diff) return 'ไม่มีผลต่าง';
    if (r.staleBy.length) return `รายการนี้ถูกตรวจนับ/ปรับยอดหลังเวลาของไฟล์แล้ว (${r.staleBy.join(', ')}) – ไฟล์นี้ล้าสมัยสำหรับรายการนี้ ใช้ไฟล์ที่ใหม่กว่า`;
    if (!ctx.can('express.reconcile', r.wh)) return `คุณไม่มีสิทธิ์กระทบยอดคลัง ${r.wh}`;
    if (settingsOf(ctx.state).policies.sod !== false && ctx.user && b.importedBy === ctx.user.id) return 'คุณเป็นผู้นำเข้าไฟล์นี้ – ผู้ปรับยอดตามไฟล์ต้องเป็นอีกคน (แยกหน้าที่) อธิบายผลต่างได้';
    return '';
  }

  function resolutionCell(ctx, rc, r) {
    const res = r.resolution;
    const canAct = rc.batch.status === 'REVIEW' && ctx.can('express.reconcile', r.wh || undefined);
    if (res) {
      return t`${h.badge(res.action === 'adjust' ? 'ปรับยอดตาม Express' : 'อธิบายแล้ว', res.action === 'adjust' ? 'accent' : 'ok')}${res.docNo ? t` ${docLink(res.docNo)}` : ''}${res.confirmOld ? t` ${h.badge('ยืนยันใช้ไฟล์เก่า', 'warn')}` : ''}
        <br><small>${res.reason}</small><br><small class="muted">${ctx.userName(res.by)} · ${h.fmt.dt(res.at)}</small>
        ${canAct && res.action === 'explain' ? t`<br>${h.btn('ตัดสินใหม่', { act: 'resolve', arg: r.key, tone: 'quiet', small: true })}` : ''}`;
    }
    if (r.status === 'MATCH') return t`<span class="muted">ไม่ต้องทำ</span>`;
    return canAct ? h.btn('ตัดสิน', { act: 'resolve', arg: r.key, small: true }) : t`<span class="muted">ยังไม่ตัดสิน</span>`;
  }

  function batchReview(ctx, id) {
    const v = ctx.view;
    const rc = rec.reconcile(ctx.state, id);
    if (!rc) return '';
    const b = rc.batch;
    const tot = rc.totals;
    const live = b.status === 'REVIEW';
    const canRec = ctx.can('express.reconcile');
    const owns = expressOwns(ctx.state);
    const f = v.filt || (live && tot.unresolved ? 'open' : 'all');
    const q = low(v.rq).trim();
    const shown = rc.rows.filter((r) => rowFilter(r, f) && (!q || [r.code, r.name, r.wh].concat(r.rawCodes).some((x) => low(x).indexOf(q) >= 0)));
    const limit = v.limit || STEP;
    const picked = v.picked || {};
    const pickable = (r) => live && r.status !== 'MATCH' && !(r.resolution && r.resolution.action === 'adjust') && ctx.can('express.reconcile', r.wh || undefined);
    const nPicked = rc.rows.filter((r) => picked[r.key] && pickable(r)).length;
    const counts = {};
    for (const [k] of FILTERS) counts[k] = rc.rows.filter((r) => rowFilter(r, k)).length;
    const adjDocs = Array.from(new Set((b.resolutions || []).filter((x) => x.action === 'adjust' && x.docNo && !x.cancelledAt).map((x) => x.docNo)));

    const acts = [];
    if (rc.rows.length) acts.push(h.btn('ดาวน์โหลด CSV', { act: 'csv', tone: 'ghost', small: true }));
    if (live && canRec) acts.push(h.btn('ปิดรอบ', { act: 'close', tone: 'primary', small: true, id: 'ex-close', disabled: tot.unresolved > 0, title: tot.unresolved ? `ยังมี ${tot.unresolved} รายการที่ยังไม่ตัดสิน` : 'ปิดรอบกระทบยอดนี้' }));
    if (live && (ctx.can('express.import') || canRec)) acts.push(h.btn('ยกเลิกรอบ', { act: 'discard', tone: 'ghost', small: true, id: 'ex-discard' }));
    acts.push(h.btn('ปิด', { act: 'unpick', tone: 'quiet', small: true }));

    const notes = [];
    if (live) notes.push(h.note(t`นำเข้าแล้ว <b>ยอดคงเหลือยังไม่เปลี่ยน</b> – ผลต่าง = Express − RRS ณ เวลาของไฟล์ (${h.fmt.dt(b.snapshotAt)}) เอกสารที่บันทึกหลังเวลานั้นอยู่ในคอลัมน์ RRS ตอนนี้ และไม่ถูกนับเป็นผลต่าง`, 'info'));
    notes.push(owns
      ? h.note(t`<b>ข้อตกลง ค-1: ยอดจำนวนยึด Express</b> – ปรับยอดตามไฟล์ได้ (ใบปรับยอด AJ ของผลต่าง ณ เวลาไฟล์ เอกสารหลังเวลานั้นยังอยู่ครบ) หรืออธิบายผลต่าง`, 'warn')
      : h.note(t`<b>ข้อตกลง ค-1: ยอดจำนวนเป็นของระบบ RRS</b> – ไฟล์ Express ใช้กระทบยอดเท่านั้น ปรับยอดจากไฟล์ไม่ได้ ทุกผลต่างให้อธิบายเหตุผล (เช่น เอกสารยังไม่คีย์ Express) ถ้าของจริงไม่ตรงให้ ${h.link('เปิดรอบตรวจนับ', 'counts')}`, 'info'));
    if (rc.olderThanLatest) notes.push(h.note('ไฟล์นี้เก่ากว่ารอบที่ปิดล่าสุด – การปรับยอดจากไฟล์นี้ต้องติ๊กยืนยันใช้ไฟล์เก่าทีละครั้ง และรายการที่ถูกนับ/ปรับหลังเวลาไฟล์ปรับจากไฟล์นี้ไม่ได้', 'warn'));
    if (b.status === 'CLOSED') notes.push(h.note(`ปิดรอบแล้วโดย ${ctx.userName(b.closedBy)} เมื่อ ${h.fmt.dt(b.closedAt)} – แก้การตัดสินไม่ได้`, 'ok'));
    if (b.status === 'DISCARDED') notes.push(h.note(`ยกเลิกรอบโดย ${ctx.userName(b.discardedBy)} เมื่อ ${h.fmt.dt(b.discardedAt)}: ${b.discardReason} – รอบนี้ไม่ได้เปลี่ยนยอด ไฟล์เดิมนำเข้าใหม่ได้`, 'info'));

    const kp = h.kpis([
      h.kpi('ตรงกัน', h.fmt.num(tot.MATCH), 'รายการ', 'ok'),
      h.kpi('ยอดต่าง', h.fmt.num(tot.DIFF + tot.ONLY_EXPRESS + tot.ONLY_RRS), `มีเฉพาะ Express ${tot.ONLY_EXPRESS} · เฉพาะ RRS ${tot.ONLY_RRS}`, tot.DIFF + tot.ONLY_EXPRESS + tot.ONLY_RRS ? 'warn' : 'ok'),
      h.kpi('ไม่รู้จักรหัส', h.fmt.num(tot.UNKNOWN_CODE), 'แถวในไฟล์', tot.UNKNOWN_CODE ? 'bad' : ''),
      h.kpi('ยังไม่ตัดสิน', h.fmt.num(tot.unresolved), tot.unresolved ? 'ต้องครบก่อนปิดรอบ' : 'ปิดรอบได้', tot.unresolved ? 'warn' : 'ok'),
      h.kpi('เอกสารยังไม่คีย์ ณ เวลาไฟล์', h.fmt.num(tot.pendingDocs), 'อาจเป็นที่มาของผลต่าง', tot.pendingDocs ? 'info' : ''),
    ]);
    const bulk = live && canRec ? t`<div class="form-actions">
        ${h.btn(`เลือกทุกรายการที่ยังไม่ตัดสินในตัวกรองนี้`, { act: 'pickAll', tone: 'ghost', small: true })}
        ${nPicked ? h.btn(`อธิบายผลต่างที่เลือก (${nPicked})`, { act: 'bulkExplain', tone: 'primary', small: true, id: 'ex-bulk' }) : ''}
        ${nPicked ? h.btn('ล้างที่เลือก', { act: 'pickNone', tone: 'quiet', small: true }) : ''}</div>` : '';
    const cols = [];
    if (live && canRec) {
      cols.push({ label: '', w: '34px', render: (r) => (pickable(r) && !(r.resolution && r.resolution.action === 'adjust')
        ? t`<input type="checkbox" data-act="tick" data-arg="${r.key}" aria-label="เลือก ${r.code || 'แถว ' + r.rows[0]}"${h.safe(picked[r.key] ? ' checked' : '')}>` : '') });
    }
    cols.push(
      { label: 'สินค้า', render: (r) => (r.status === 'UNKNOWN_CODE'
        ? t`${h.code(r.rawCodes[0] || '(ว่าง)')}<br><small class="muted">แถว ${r.rows.join(', ')} · ไม่รู้จักรหัส ระบบไม่จับคู่จากชื่อ</small>`
        : t`${h.code(r.code)} ${r.name ? t`<small>${r.name}</small>` : ''}${r.rawCodes.some((c) => util.ckey(c) !== util.ckey(r.code)) ? t`<br><small class="muted">ในไฟล์: ${r.rawCodes.join(', ')}</small>` : ''}`) },
      { label: 'คลัง', render: (r) => (r.wh ? h.code(r.wh) : dash) },
      { label: 'Express', num: true, render: (r) => (r.status === 'ONLY_RRS' ? dash : h.fmt.num(r.express)) },
      { label: 'RRS ณ เวลาไฟล์', num: true, render: (r) => (r.rrsAtSnapshot == null ? dash : h.fmt.num(r.rrsAtSnapshot)) },
      { label: 'RRS ตอนนี้', num: true, render: (r) => (r.rrsNow == null ? dash : h.fmt.num(r.rrsNow)) },
      { label: 'ผลต่าง', num: true, render: (r) => (r.diff == null ? dash : r.diff ? t`<b>${signed(r.diff)}</b>` : '0') },
      { label: 'หน่วย', get: (r) => r.unit },
      { label: 'สถานะ', render: (r) => t`${h.badge(rec.ROW_STATUS[r.status] || r.status, ROW_TONE[r.status])}${r.staleBy.length ? t`<br><small class="muted">นับ/ปรับหลังเวลาไฟล์: ${r.staleBy.join(', ')}</small>` : ''}` },
      { label: 'เอกสารยังไม่คีย์ Express', render: (r) => (r.pendingDocs.length
        ? t`${r.pendingDocs.slice(0, 3).map((no) => t`${docLink(no)} `)}${r.pendingDocs.length > 3 ? t`<small class="muted">+${r.pendingDocs.length - 3}</small>` : ''}` : dash) },
      { label: 'การตัดสิน', render: (r) => resolutionCell(ctx, rc, r) },
    );
    const table = h.table({ rows: shown.slice(0, limit), cols, dense: true, scroll: true, id: 'ex-rec', rowCls: (r) => (r.status === 'UNKNOWN_CODE' && !r.resolved ? 'row-bad' : ''),
      empty: rc.rows.length ? 'ไม่มีรายการในตัวกรองนี้' : 'ไฟล์นี้ไม่มีรายการ', emptyText: rc.rows.length ? (f === 'open' ? 'ทุกรายการที่ยอดต่างตัดสินแล้ว – ปิดรอบได้' : 'เลือกตัวกรองอื่น') : '' });
    const more = shown.length > limit ? t`<p class="hint">แสดง ${h.fmt.num(limit)} จาก ${h.fmt.num(shown.length)} รายการ ${h.btn('แสดงเพิ่ม', { act: 'more', tone: 'ghost', small: true })}</p>` : '';
    return h.section(t`รอบ ${h.code(b.id)} · ${b.fileName} ${h.badge(rec.BATCH_STATUS[b.status] || b.status, BATCH_TONE[b.status])}`, t`
      ${h.dl([['ข้อมูล ณ', h.fmt.dt(b.snapshotAt)], ['นำเข้าโดย', `${ctx.userName(b.importedBy)} · ${h.fmt.dt(b.importedAt)}`],
        ['แถวในไฟล์', h.fmt.num(((RRS.q.get(ctx.state, 'express_batches', b.id) || {}).rows || []).length)], ['ลายนิ้วมือไฟล์', t`<span class="mono">${String(b.fileHash || '').slice(0, 16)}…</span>`],
        adjDocs.length ? ['ใบปรับยอดจากรอบนี้', t`${adjDocs.map((no) => t`${docLink(no)} `)}`] : null])}
      ${notes}${kp}
      ${h.tabs(FILTERS.map(([k, l]) => ({ id: k, label: l, count: counts[k] })), f, 'filt')}
      ${h.toolbar([h.field({ name: 'rq', label: 'ค้นหาในรอบนี้', value: v.rq, placeholder: 'รหัส ชื่อ คลัง…', act: 'rq', live: true, id: 'ex-rq' })], bulk)}
      ${table}${more}
      <p class="hint">ผลต่าง = Express − RRS ณ เวลาไฟล์ (คือจำนวนที่ใบปรับยอดจะลง) · RRS นับทุกสถานะในคลังนั้น ของระหว่างโอนข้ามคลังไม่อยู่ในคลังใด · เอกสารยังไม่คีย์ = บันทึกในระบบก่อนเวลาไฟล์แต่ยังไม่มีเลขที่ Express</p>`,
    { id: 'ex-review', actions: acts });
  }

  // ---- pending keying in Express -------------------------------------------------------------------------------------
  function pendingTab(ctx) {
    const v = ctx.view;
    const pe = rec.pendingExpress(ctx.state, ctx.today);
    const q = low(v.pq).trim();
    const match = (d) => !q || [d.docNo, d.type, d.typeName, d.expressNo].concat(d.codes).some((x) => low(x).indexOf(q) >= 0);
    const wait = pe.wait.filter(match);
    const canMark = ctx.can('doc.markExpress');
    const limit = v.plimit || STEP;
    const kp = h.kpis([
      h.kpi('รอคีย์ Express', h.fmt.num(pe.totals.wait), pe.totals.wait ? `เก่าสุดลงวันที่ ${h.fmt.date(pe.totals.oldestWait)}` : 'ไม่มีค้าง', pe.totals.wait ? 'warn' : 'ok'),
      h.kpi('คีย์แล้ว', h.fmt.num(pe.totals.keyed), 'มีเลขที่ Express'),
      h.kpi('ยกเลิกหลังคีย์แล้ว', h.fmt.num(pe.totals.cancelledKeyed), pe.totals.cancelledKeyed ? 'ต้องกลับรายการใน Express ด้วย' : 'ไม่มี', pe.totals.cancelledKeyed ? 'bad' : ''),
    ]);
    const age = (d) => (d.ageDays == null ? '' : d.ageDays > 2 ? h.badge(`${d.ageDays} วัน`, 'warn') : t`<span class="muted">${d.ageDays} วัน</span>`);
    const waitTbl = h.table({ rows: wait.slice(0, limit), dense: true, scroll: true, id: 'ex-pending',
      empty: pe.totals.wait ? 'ไม่พบเอกสารตามที่ค้น' : 'ไม่มีเอกสารรอคีย์ Express',
      emptyText: pe.totals.wait ? 'ลองคำค้นอื่น' : 'เอกสารรับ–จ่ายที่บันทึกแล้วแต่ยังไม่มีเลขที่ Express จะขึ้นที่นี่ (ใบโอนและใบรับคืนไม่ต้องคีย์)',
      cols: [
        { label: 'เลขที่', render: (d) => docLink(d.docNo) },
        { label: 'ประเภท', render: (d) => t`${d.type} <small class="muted">${d.typeName}</small>` },
        { label: 'ลงวันที่', get: (d) => h.fmt.date(d.date) },
        { label: 'ค้างมา', render: age },
        { label: 'บันทึกโดย', render: (d) => t`${ctx.userName(d.postedBy)}<br><small class="muted">${h.fmt.dt(d.postedAt)}</small>` },
        { label: 'บรรทัด', num: true, key: 'lines' },
        { label: 'สินค้า', render: (d) => t`${d.codes.slice(0, 3).map((c) => t`${h.code(c)} `)}${d.codes.length > 3 ? t`<small class="muted">+${d.codes.length - 3}</small>` : ''}` },
        { label: '', render: (d) => (canMark ? h.btn('บันทึกเลขที่ Express', { act: 'markExpress', arg: d.docNo, small: true }) : '') },
      ] });
    const more = wait.length > limit ? t`<p class="hint">แสดง ${h.fmt.num(limit)} จาก ${h.fmt.num(wait.length)} ใบ ${h.btn('แสดงเพิ่ม', { act: 'pmore', tone: 'ghost', small: true })}</p>` : '';
    const cancelled = pe.cancelledKeyed.length ? h.section('ยกเลิกในระบบแล้ว แต่คีย์ใน Express ไปแล้ว', h.table({ rows: pe.cancelledKeyed, dense: true, scroll: true, cols: [
      { label: 'เลขที่', render: (d) => docLink(d.docNo) }, { label: 'ประเภท', key: 'type' }, { label: 'ลงวันที่', get: (d) => h.fmt.date(d.date) },
      { label: 'เลขที่ Express', render: (d) => h.code(d.expressNo) }, { label: 'คีย์โดย', get: (d) => ctx.userName(d.expressBy) }] }),
    { sub: 'ต้องกลับรายการหรือยกเลิกเอกสารเลขที่นี้ใน Express ด้วย ไม่เช่นนั้นยอด Express จะมากหรือน้อยกว่าของจริง' }) : '';
    return t`${kp}
      ${h.note(t`เอกสารที่บันทึกในระบบแล้วแต่ยังไม่ได้คีย์ใน Express – ถ้ายังไม่คีย์ ยอด Express จะต่างจาก RRS (ดูคอลัมน์ เอกสารยังไม่คีย์ Express ในการกระทบยอด) · คีย์ใน Express แล้วบันทึกเลขที่ที่ Express ออกให้ ${h.link('หรือเปิดหน้าเอกสาร แท็บ รอคีย์ Express', 'docs', { tab: 'express', sel: null, q: '', type: '' })}`, 'info')}
      ${h.section('เอกสารรอคีย์ Express', t`${h.toolbar([h.field({ name: 'pq', label: 'ค้นหา', value: v.pq, placeholder: 'เลขที่ ประเภท รหัสสินค้า…', act: 'pq', live: true, id: 'ex-pq' })], '')}${waitTbl}${more}`,
        { sub: canMark ? 'กดเลขที่เอกสารเพื่อดูรายละเอียด · บันทึกเลขที่ Express ได้ที่ปุ่มท้ายแถว' : `กดเลขที่เอกสารเพื่อดูรายละเอียด · ผู้บันทึกเลขที่ Express คือ ${roleNames('doc.markExpress')}` })}
      ${cancelled}`;
  }

  // ---- page ------------------------------------------------------------------------------------------------------
  RRS.ui.page({
    id: 'express', title: 'นำเข้าและกระทบยอด Express', phase: 3, order: 10,
    sub: 'นำเข้าไฟล์ยอดคงเหลือจาก Express (ไม่เปลี่ยนยอด) เทียบกับยอด RRS ณ เวลาเดียวกัน ตัดสินผลต่างทีละรายการ และติดตามเอกสารที่ยังไม่คีย์ใน Express',
    badge: (ctx) => RRS.q.rows(ctx.state, 'express_batches', (b) => b.status === 'REVIEW').length || '',
    render(ctx) {
      const v = ctx.view;
      const canImp = ctx.can('express.import');
      const canRec = ctx.can('express.reconcile');
      const batches = RRS.q.rows(ctx.state, 'express_batches');
      const review = batches.filter((b) => b.status === 'REVIEW').length;
      const pe = rec.pendingExpress(ctx.state, ctx.today);
      let tab = v.tab || 'batches';
      if (tab === 'import' && !canImp) tab = 'batches';
      const closed = batches.filter((b) => b.status === 'CLOSED').sort((a, b) => String(b.snapshotAt).localeCompare(String(a.snapshotAt)))[0];
      const kp = h.kpis([
        h.kpi('รอบรอตรวจผลต่าง', h.fmt.num(review), review ? 'ตัดสินผลต่างให้ครบแล้วปิดรอบ' : 'ไม่มีค้าง', review ? 'warn' : 'ok'),
        h.kpi('รอบล่าสุดที่ปิด', closed ? h.fmt.dt(closed.snapshotAt) : '–', closed ? `ข้อมูล ณ เวลานี้ · ${closed.id}` : 'ยังไม่เคยปิดรอบ'),
        h.kpi('เอกสารรอคีย์ Express', h.fmt.num(pe.totals.wait), pe.totals.wait ? `เก่าสุด ${h.fmt.date(pe.totals.oldestWait)}` : 'ไม่มีค้าง', pe.totals.wait ? 'warn' : 'ok'),
        h.kpi('ยอดจำนวนเป็นของ', expressOwns(ctx.state) ? 'Express' : 'RRS', expressOwns(ctx.state) ? 'ปรับยอดตามไฟล์ได้ (ค-1)' : 'ไฟล์ใช้กระทบยอดเท่านั้น (ค-1)', 'info'),
      ]);
      const tabs = [{ id: 'batches', label: 'รอบนำเข้า', count: review || null }];
      if (canImp) tabs.push({ id: 'import', label: 'นำเข้าไฟล์ใหม่' });
      tabs.push({ id: 'pending', label: 'รอคีย์ Express', count: pe.totals.wait || null });
      const ro = !canImp && !canRec ? h.note(`คุณดูผลกระทบยอดได้อย่างเดียว – นำเข้าไฟล์: ${roleNames('express.import')} · ตัดสินผลต่างและปิดรอบ: ${roleNames('express.reconcile')}`, 'info') : '';
      let body;
      if (tab === 'import') body = importTab(ctx);
      else if (tab === 'pending') body = pendingTab(ctx);
      else {
        const sel = v.sel && RRS.q.get(ctx.state, 'express_batches', v.sel) ? v.sel : null;
        body = t`${sel ? batchReview(ctx, sel) : ''}${h.section('รอบนำเข้า', batchList(ctx), {
          sub: 'หนึ่งไฟล์ = หนึ่งรอบ · คลิกแถวเพื่อดูผลต่างรายสินค้า', actions: canImp ? h.btn('+ นำเข้าไฟล์ใหม่', { act: 'tab', arg: 'import', tone: 'primary', small: true }) : '' })}`;
      }
      return t`${kp}${ro}${h.tabs(tabs, tab)}${body}`;
    },
    after(ctx, root0) {
      const v = ctx.view;
      const box = root0.querySelector('#ex-rec');
      if (box) {
        // the review table scrolls inside its own box: keep its place across re-renders (ticking, resolving)
        if (v._st && v._stId === v.sel) box.scrollTop = v._st;
        box.addEventListener('scroll', () => { v._st = box.scrollTop; v._stId = v.sel; });
      }
      if (v._scroll) {
        v._scroll = false;
        const d = root0.querySelector('#ex-review');
        if (d) setTimeout(() => d.scrollIntoView({ block: 'start' }), 0);
      }
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg }),
      pick: (ctx, el) => ctx.set({ tab: 'batches', sel: el.dataset.arg, filt: null, rq: '', limit: STEP, picked: {}, _st: 0, _scroll: true }),
      unpick: (ctx) => ctx.set({ sel: null, picked: {} }),
      filt: (ctx, el) => ctx.set({ filt: el.dataset.arg, limit: STEP, _st: 0 }),
      more: (ctx) => ctx.set({ limit: (ctx.view.limit || STEP) + STEP }),
      pmore: (ctx) => ctx.set({ plimit: (ctx.view.plimit || STEP) + STEP }),
      rq: (ctx, el) => ctx.set({ rq: el.value, limit: STEP, _st: 0 }),
      pq: (ctx, el) => ctx.set({ pq: el.value, plimit: STEP }),
      tick(ctx, el) {
        const p = Object.assign({}, ctx.view.picked);
        if (el.checked) p[el.dataset.arg] = true;
        else delete p[el.dataset.arg];
        ctx.set({ picked: p });
      },
      pickAll(ctx) {
        const rc = rec.reconcile(ctx.state, ctx.view.sel);
        if (!rc) return;
        const v = ctx.view;
        const f = v.filt || (rc.totals.unresolved ? 'open' : 'all');
        const q = low(v.rq).trim();
        const p = Object.assign({}, v.picked);
        let n = 0;
        for (const r of rc.rows) {
          if (!rowFilter(r, f) || r.status === 'MATCH' || r.resolved || !ctx.can('express.reconcile', r.wh || undefined)) continue;
          if (q && ![r.code, r.name, r.wh].concat(r.rawCodes).some((x) => low(x).indexOf(q) >= 0)) continue;
          p[r.key] = true;
          n++;
        }
        if (!n) return ctx.toast('ไม่มีรายการที่ยังไม่ตัดสินในตัวกรองนี้', 'info');
        ctx.set({ picked: p });
      },
      pickNone: (ctx) => ctx.set({ picked: {} }),
      dropFile: (ctx) => ctx.set({ src: null, impErr: null, readErr: '' }),
      async readFile(ctx, el) {
        const f = el.files && el.files[0];
        if (!f) return;
        try {
          const tb = await h.readTable(f);
          if (!tb.rows.length) return ctx.set({ src: null, readErr: `ไฟล์ ${tb.name} ไม่มีข้อมูล – ตรวจว่าเลือกไฟล์รายงานสินค้าคงเหลือที่ส่งออกจาก Express`, impErr: null });
          const hd = findHeader(tb.rows);
          ctx.set({ src: { name: tb.name, hash: tb.hash, rows: tb.rows, headerRow: hd.row, map: hd.map }, readErr: '', impErr: null });
        } catch (e) {
          ctx.set({ src: null, readErr: 'อ่านไฟล์ไม่ได้: ' + ((e && e.message) || e) + ' – ลองบันทึกเป็น CSV (UTF-8) แล้วเลือกใหม่', impErr: null });
        }
      },
      mapCol(ctx, el) {
        const src = Object.assign({}, ctx.view.src);
        src.map = Object.assign({}, src.map);
        if (el.value === '') delete src.map[el.dataset.arg];
        else src.map[el.dataset.arg] = Number(el.value);
        ctx.set({ src, impErr: null });
      },
      headRow(ctx, el) {
        const src = Object.assign({}, ctx.view.src);
        src.headerRow = Number(el.value) || 0;
        src.map = h.mapHeader(src.rows[src.headerRow] || [], ALIASES);
        ctx.set({ src, impErr: null });
      },
      snap(ctx, el) {
        ctx.view.snap = el.value; // kept for the import; no re-render while the person may still be typing
        ctx.view.impErr = null;
      },
      async doImport(ctx) {
        const v = ctx.view;
        const src = v.src;
        if (!src) return;
        const input = root.document.querySelector('#ex-snap');
        if (input) v.snap = input.value;
        const snap = snapIso(v.snap);
        if (!snap) {
          const msg = 'ใส่วันเวลาของข้อมูลในไฟล์ก่อน (ดูจากหัวรายงาน Express) – ระบบใช้เวลานี้คิดยอด RRS ณ เวลาเดียวกัน ถ้าไม่ใส่หรือใส่ผิด ผลต่างจะผิด';
          ctx.set({ impErr: [{ message: msg }] });
          ctx.toast(msg, 'bad');
          const el = root.document.querySelector('#ex-snap');
          if (el) el.focus();
          return;
        }
        if (Date.parse(snap) > Date.now() + 60000) {
          const msg = `เวลาของข้อมูล ${h.fmt.dt(snap)} อยู่หลังเวลาปัจจุบัน – ตรวจวันเวลาในหัวรายงาน Express`;
          ctx.set({ impErr: [{ message: msg }] });
          return ctx.toast(msg, 'bad');
        }
        const parsed = parseSrc(src);
        const payload = payloadOf(src, parsed, snap);
        const ok = await ctx.confirm({ title: 'นำเข้าไฟล์ Express', ok: 'นำเข้า',
          message: `นำเข้า ${parsed.rows.length} แถวจาก ${src.name} เป็นข้อมูล ณ ${h.fmt.dt(snap)} – ยอดคงเหลือไม่เปลี่ยน ใช้เทียบผลต่างเท่านั้น` });
        if (!ok) return;
        const r = await ctx.exec('express.import', payload, { quiet: true });
        if (!r.ok) {
          ctx.set({ impErr: r.errors.slice(0, 12) });
          return ctx.toast(r.errors[0] ? r.errors[0].message : 'นำเข้าไม่สำเร็จ', 'bad');
        }
        const id = r.result && r.result.batchId;
        ctx.toast(`นำเข้าเป็นรอบ ${id} แล้ว – ยอดคงเหลือไม่เปลี่ยน ตรวจผลต่างด้านล่าง`, 'ok');
        ctx.set({ tab: 'batches', sel: id, src: null, snap: '', impErr: null, filt: null, rq: '', picked: {}, limit: STEP, _st: 0, _scroll: true });
      },
      async resolve(ctx, el) {
        const rc = rec.reconcile(ctx.state, ctx.view.sel);
        const r = rc && rc.rows.find((x) => x.key === el.dataset.arg);
        if (!r) return ctx.toast('ไม่พบรายการนี้แล้ว – ข้อมูลอาจเปลี่ยน ลองเปิดรอบใหม่', 'warn');
        const why = noAdjust(ctx, rc, r);
        const it = r.code ? RRS.q.get(ctx.state, 'items', r.code) : null;
        const w = r.wh ? RRS.q.get(ctx.state, 'warehouses', r.wh) : null;
        const tracked = it && it.trackLot && it.trackLot !== 'none';
        const locs = r.code ? RRS.inventory.locations(ctx.state, { code: r.code, wh: r.wh, status: 'AVAILABLE' }) : [];
        const binQty = {};
        for (const l of locs) binQty[l.bin] = util.round((binQty[l.bin] || 0) + l.qty);
        const bins = RRS.q.rows(ctx.state, 'bins', (b) => b.wh === r.wh && b.active !== false).sort((a, b) => a.code.localeCompare(b.code));
        const binOpts = bins.map((b) => [b.code, `${b.code}${binQty[b.code] ? ` (ใช้ได้ ${h.fmt.num(binQty[b.code])})` : ''}`]);
        const top = locs.slice().sort((a, b) => b.qty - a.qty)[0];
        const defBin = r.diff < 0 && top ? top.bin : locs.length === 1 ? locs[0].bin : '';
        const unit = r.unit || (it ? it.baseUnit : '');
        const opts = why ? [['explain', 'อธิบายผลต่าง (ยอดไม่เปลี่ยน)']]
          : [['adjust', `ปรับยอดตาม Express: ${signed(r.diff)} ${unit} (ยอดตอนนี้ ${h.fmt.num(r.rrsNow)} → ${h.fmt.num(util.round(r.rrsNow + r.diff))})`], ['explain', 'อธิบายผลต่าง (ยอดไม่เปลี่ยน)']];
        const facts = h.dl([
          ['สินค้า', r.code ? t`${h.code(r.code)} ${r.name}` : t`${h.code(r.rawCodes[0] || '(ว่าง)')} <span class="muted">ไม่รู้จักรหัส</span>`], ['คลัง', r.wh],
          ['Express', r.status === 'ONLY_RRS' ? 'ไม่มีในไฟล์' : `${h.fmt.num(r.express)} ${unit}`],
          ['RRS ณ เวลาไฟล์', r.rrsAtSnapshot == null ? '–' : `${h.fmt.num(r.rrsAtSnapshot)} ${unit}`],
          ['RRS ตอนนี้', r.rrsNow == null ? '–' : `${h.fmt.num(r.rrsNow)} ${unit}`], ['ผลต่าง', r.diff == null ? '–' : `${signed(r.diff)} ${unit}`],
        ]);
        const lots = tracked ? Array.from(new Set(locs.map((l) => l.lot).filter(Boolean))).sort() : [];
        const body = t`<div class="wide">${facts}</div>
          ${r.pendingDocs.length ? t`<div class="wide">${h.note(t`มีเอกสารที่บันทึกในระบบก่อนเวลาไฟล์แต่ยังไม่คีย์ใน Express: ${r.pendingDocs.join(', ')} – ผลต่างอาจมาจากเอกสารเหล่านี้ ควรคีย์ใน Express แล้วอธิบาย แทนการปรับยอด`, 'warn')}</div>` : ''}
          ${why ? t`<div class="wide">${h.note(t`ปรับยอดจากไฟล์ไม่ได้: ${why}`, 'info')}</div>` : ''}
          <div class="wide">${h.field({ name: 'action', label: 'ตัดสินอย่างไร', type: 'radio', options: opts, value: why ? 'explain' : '', required: true, id: 'res-action' })}</div>
          ${!why ? t`${h.field({ name: 'bin', label: 'ช่องเก็บที่ลงใบปรับยอด', type: 'select', options: binOpts, value: defBin, blank: w && w.requireBin ? '— เลือกช่องเก็บ —' : 'ไม่ระบุช่องเก็บ', id: 'res-bin',
              hint: r.diff < 0 ? 'ลดยอด: เลือกช่องที่มีของพอ' : 'เพิ่มยอด: ช่องที่ของอยู่จริง' })}
            ${tracked ? t`${h.field({ name: 'lot', label: `ล็อต/Heat (${RRS.master.TRACK[it.trackLot] || it.trackLot})`, list: 'res-lots', required: true, id: 'res-lot' })}<datalist id="res-lots">${lots.map((l) => t`<option value="${l}"></option>`)}</datalist>` : ''}
            ${rc.olderThanLatest ? h.field({ name: 'confirmOld', label: 'ยืนยันใช้ไฟล์ที่เก่ากว่ารอบที่ปิดล่าสุด', type: 'checkbox', wide: true, id: 'res-old',
              hint: 'ไฟล์นี้ทำก่อนรอบที่ปิดแล้ว – ติ๊กเมื่อตรวจแล้วว่ายอดในไฟล์นี้ยังถูกสำหรับรายการนี้ (ระบบบันทึกการยืนยันไว้กับการตัดสิน)' }) : ''}` : ''}
          ${h.field({ name: 'reason', label: 'เหตุผล / คำอธิบายผลต่าง', type: 'textarea', rows: 3, required: true, wide: true, id: 'res-reason',
            placeholder: r.pendingDocs.length ? `เช่น ${r.pendingDocs[0]} ยังไม่คีย์ Express` : 'เช่น นับจริงแล้วตรงกับ Express / เอกสารยังไม่คีย์' })}`;
        await ctx.dialog({ title: r.code ? `ตัดสินผลต่าง ${r.code} คลัง ${r.wh}` : `ตัดสินแถว ${r.rows.join(', ')} ที่ไม่รู้จักรหัส`, submit: 'บันทึกการตัดสิน', wide: true, body,
          onSubmit: (vals) => {
            const action = vals.action;
            if (action !== 'adjust' && action !== 'explain') return { ok: false, errors: [{ message: 'เลือกว่าจะปรับยอดตาม Express หรืออธิบายผลต่าง' }] };
            if (!util.trim(vals.reason)) return { ok: false, errors: [{ message: 'ใส่เหตุผลหรือคำอธิบายผลต่าง – ผู้ตรวจย้อนหลังจะเห็นข้อความนี้' }] };
            const line = r.code ? { code: r.code, wh: r.wh, action, reason: vals.reason } : { row: r.rows[0], action, reason: vals.reason };
            if (action === 'adjust') {
              if (w && w.requireBin && !vals.bin) return { ok: false, errors: [{ message: `คลัง ${r.wh} ต้องระบุช่องเก็บ – เลือกช่องที่ลงใบปรับยอด` }] };
              if (tracked && !util.trim(vals.lot)) return { ok: false, errors: [{ message: `${r.code} ติดตามล็อต – ใส่ล็อต/Heat ที่จะปรับ` }] };
              if (rc.olderThanLatest && !vals.confirmOld) return { ok: false, errors: [{ message: 'ไฟล์นี้เก่ากว่ารอบที่ปิดล่าสุด – ติ๊ก ยืนยันใช้ไฟล์ที่เก่ากว่า ก่อนปรับยอด หรือเลือกอธิบายผลต่าง' }] };
              line.bin = vals.bin || '';
              if (tracked) line.lot = util.trim(vals.lot);
            }
            const payload = { batchId: rc.batch.id, lines: [line] };
            if (action === 'adjust' && rc.olderThanLatest) payload.confirmOld = vals.confirmOld === true;
            return ctx.exec('express.resolve', payload, { quiet: true,
              done: (res) => (res.result && res.result.docNo ? `ปรับยอดแล้ว – ใบปรับยอด ${res.result.docNo}` : 'บันทึกคำอธิบายผลต่างแล้ว') });
          } });
      },
      async bulkExplain(ctx) {
        const rc = rec.reconcile(ctx.state, ctx.view.sel);
        if (!rc) return;
        const picked = ctx.view.picked || {};
        const rows = rc.rows.filter((r) => picked[r.key] && r.status !== 'MATCH' && !(r.resolution && r.resolution.action === 'adjust'));
        if (!rows.length) return ctx.toast('ยังไม่ได้เลือกรายการ – ติ๊กช่องหน้ารายการที่จะอธิบาย', 'info');
        const r = await ctx.dialog({ title: `อธิบายผลต่าง ${rows.length} รายการ`, submit: `บันทึกคำอธิบาย ${rows.length} รายการ`, wide: true,
          body: t`<p class="hint wide">ใช้คำอธิบายเดียวกันทุกรายการที่เลือก ยอดคงเหลือไม่เปลี่ยน: ${rows.slice(0, 12).map((x) => (x.code ? `${x.code}@${x.wh}` : `แถว ${x.rows[0]}`)).join(', ')}${rows.length > 12 ? ` และอีก ${rows.length - 12} รายการ` : ''}</p>
            ${h.field({ name: 'reason', label: 'คำอธิบายผลต่าง', type: 'textarea', rows: 3, required: true, wide: true, id: 'bulk-reason', placeholder: 'เช่น เอกสารยังไม่คีย์ Express ณ เวลาไฟล์' })}`,
          onSubmit: (vals) => {
            if (!util.trim(vals.reason)) return { ok: false, errors: [{ message: 'ใส่คำอธิบายผลต่าง – ผู้ตรวจย้อนหลังจะเห็นข้อความนี้' }] };
            const lines = rows.map((x) => (x.code ? { code: x.code, wh: x.wh, action: 'explain', reason: vals.reason } : { row: x.rows[0], action: 'explain', reason: vals.reason }));
            return ctx.exec('express.resolve', { batchId: rc.batch.id, lines }, { quiet: true, done: `บันทึกคำอธิบาย ${lines.length} รายการแล้ว` });
          } });
        if (r && r.ok) ctx.set({ picked: {} });
      },
      async close(ctx) {
        const rc = rec.reconcile(ctx.state, ctx.view.sel);
        if (!rc) return;
        if (rc.totals.unresolved) return ctx.toast(`ยังมี ${rc.totals.unresolved} รายการที่ยอดต่างแต่ยังไม่ตัดสิน – ตัดสินให้ครบก่อนปิดรอบ`, 'bad');
        const ok = await ctx.confirm({ title: `ปิดรอบ ${rc.batch.id}`, ok: 'ปิดรอบ',
          message: `ปิดรอบกระทบยอดข้อมูล ณ ${h.fmt.dt(rc.batch.snapshotAt)} – หลังปิดแก้การตัดสินไม่ได้ และไฟล์ที่เก่ากว่ารอบนี้จะต้องยืนยันพิเศษก่อนปรับยอด` });
        if (!ok) return;
        await ctx.exec('express.close', { batchId: rc.batch.id }, { done: `ปิดรอบ ${rc.batch.id} แล้ว` });
      },
      async discard(ctx) {
        const b = RRS.q.get(ctx.state, 'express_batches', ctx.view.sel);
        if (!b) return;
        const live = Array.from(new Set((b.resolutions || []).filter((x) => x.action === 'adjust' && !x.cancelledAt).map((x) => x.docNo)));
        if (live.length) return ctx.toast(`รอบ ${b.id} ปรับยอดไปแล้ว (${live.join(', ')}) – ยกเลิกใบปรับยอดที่หน้าเอกสารก่อน แล้วจึงยกเลิกรอบ`, 'bad');
        await ctx.dialog({ title: `ยกเลิกรอบ ${b.id}`, submit: 'ยกเลิกรอบ', danger: true,
          message: 'รอบนี้ยังไม่ได้เปลี่ยนยอด ยกเลิกแล้วการตัดสินในรอบนี้ไม่มีผล และนำเข้าไฟล์เดิมใหม่ได้ (เช่น หลังแก้รหัส Express หรือรหัสคลัง)',
          body: h.field({ name: 'reason', label: 'เหตุผลที่ยกเลิก', required: true, wide: true, id: 'discard-reason', placeholder: 'เช่น เลือกไฟล์ผิดคลัง / แก้รหัส Express แล้วจะนำเข้าใหม่' }),
          onSubmit: (vals) => (util.trim(vals.reason)
            ? ctx.exec('express.discard', { batchId: b.id, reason: vals.reason }, { quiet: true, done: `ยกเลิกรอบ ${b.id} แล้ว` })
            : { ok: false, errors: [{ message: 'ใส่เหตุผลที่ยกเลิกรอบ' }] }) });
      },
      async csv(ctx) {
        const rc = rec.reconcile(ctx.state, ctx.view.sel);
        if (!rc) return;
        const b = rc.batch;
        const out = [['รอบ', b.id, 'ไฟล์', b.fileName, 'ข้อมูล ณ', h.fmt.dt(b.snapshotAt), 'สถานะ', rec.BATCH_STATUS[b.status] || b.status],
          ['รหัสสินค้า', 'ชื่อสินค้า', 'คลัง', 'รหัสในไฟล์', 'แถวในไฟล์', 'Express', 'RRS ณ เวลาไฟล์', 'RRS ตอนนี้', 'ผลต่าง (Express − RRS)', 'หน่วย', 'สถานะ',
            'เอกสารยังไม่คีย์ Express', 'การตัดสิน', 'เหตุผล', 'ใบปรับยอด', 'ผู้ตัดสิน', 'เวลา']];
        for (const r of rc.rows) {
          const res = r.resolution;
          out.push([r.code, r.name, r.wh, r.rawCodes.join(' '), r.rows.join(' '), r.status === 'ONLY_RRS' ? '' : r.express, r.rrsAtSnapshot, r.rrsNow, r.diff, r.unit,
            rec.ROW_STATUS[r.status] || r.status, r.pendingDocs.join(' '), res ? (res.action === 'adjust' ? 'ปรับยอด' : 'อธิบาย') : '', res ? res.reason : '',
            res ? res.docNo : '', res ? ctx.userName(res.by) : '', res ? h.fmt.dt(res.at) : '']);
        }
        await ctx.download(`express-${b.id}-${ctx.today}.csv`, h.csv(out));
      },
      async markExpress(ctx, el) {
        const d = RRS.q.get(ctx.state, 'documents', el.dataset.arg);
        if (!d) return;
        await ctx.dialog({ title: `เลขที่ Express ของ ${d.docNo}`, submit: 'บันทึกเลขที่',
          message: 'คีย์เอกสารนี้ใน Express ก่อน แล้วใส่เลขที่ที่ Express ออกให้',
          body: h.field({ name: 'expressNo', label: 'เลขที่เอกสารใน Express', required: true, wide: true, id: 'mx-no' }),
          onSubmit: (vals) => (util.trim(vals.expressNo)
            ? ctx.exec('doc.markExpress', { docNo: d.docNo, expressNo: vals.expressNo }, { quiet: true, done: `บันทึกเลขที่ Express ของ ${d.docNo} แล้ว` })
            : { ok: false, errors: [{ message: 'ใส่เลขที่ที่ Express ออกให้ (ยังไม่คีย์ = ปล่อยไว้ในรายการรอคีย์)' }] }) });
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
