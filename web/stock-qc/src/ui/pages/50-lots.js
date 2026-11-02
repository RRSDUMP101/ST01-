/*
 * Phase 5 – ล็อต/Heat และการสอบกลับ (RRS.quality: lot.update, lot.verifyCert, lot.quarantine, lot.release, findLots,
 * trace, traceJob). Three tabs:
 *   ล็อตทั้งหมด            every lot / heat / serial received: supplier, PO, first receipt, certificate, lot status and
 *                          the quantity by quality status. A lot opens its detail: material certificate (recorded by one
 *                          person, checked by another), quarantine / release with a reason, stock by location, history.
 *   สอบกลับจาก Heat/ล็อต  receipts → issues with their jobs → what those jobs produced (FR) → deliveries (DL), plus
 *                          transfers, quality status changes, inspections, NCRs and what is left.
 *   สอบกลับจากใบงาน       back from a job: the lots it used (net of returns) with supplier, PO and certificate.
 * Also defines RRS.ui.qcKit – small helpers shared by the Phase 5 screens (51-qc-plans, 52-inspections, 53-ncrs).
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const { util, TRANSIT, STATUS_LABEL } = RRS;

  // ---- shared helpers of the Phase 5 screens -----------------------------------------------------------------
  const dash = t`<span class="muted">–</span>`;
  const docView = (docNo) => ({ sel: docNo, lines: null, checked: null, header: null, tab: 'all', q: '', type: '' });
  const ACTION_LABEL = {
    CREATE: 'สร้าง', RECEIVE: 'รับเข้า', UPDATE: 'แก้ข้อมูล', VERIFY_CERT: 'ตรวจใบรับรอง', QUARANTINE: 'กักกัน',
    QUARANTINE_SWEEP: 'กักกันซ้ำ', RELEASE: 'ปลดกักกัน', RECEIPT_CANCELLED: 'ยกเลิกใบรับ', EDIT: 'แก้ร่าง', APPROVE: 'อนุมัติ',
    OBSOLETE: 'เลิกใช้', OPEN: 'เปิด NCR', DISPOSITION: 'ตัดสิน', REINSPECT: 'ตรวจซ้ำ', UNDO: 'ย้อนการตัดสิน', CLOSE: 'ปิด',
  };
  /** Only http(s) links and same-site paths (/api/files/…) become links – never javascript: or other schemes. */
  function safeUrl(u) {
    const s = String(u == null ? '' : u).trim();
    return /^https?:\/\/[^\s"'<>]+$/i.test(s) || /^\/(?!\/)[^\s"'<>]*$/.test(s) ? s : '';
  }
  /** Image source for a thumbnail: a safe link or a small inline JPEG/PNG made by ctx.uploadFile in this browser. */
  function imgSrc(u) {
    const s = String(u == null ? '' : u);
    return /^data:image\/(jpeg|png|webp|gif);base64,[a-z0-9+/=]+$/i.test(s) ? s : safeUrl(s);
  }
  function fileLink(url, label) {
    const u = safeUrl(url);
    if (u) return t`<a class="lnk" href="${u}" target="_blank" rel="noopener noreferrer">${label || 'เปิดไฟล์'}</a>`;
    return url ? t`<span>${url}</span> <small class="muted">(ชื่อไฟล์ – ไม่มีลิงก์)</small>` : dash;
  }
  function certState(lot, it) {
    const c = (lot && lot.cert) || {};
    if (c.no && c.verified) return { key: 'verified', label: 'ตรวจแล้ว', tone: 'ok' };
    if (c.no) return { key: 'entered', label: 'รอ QC ตรวจใบรับรอง', tone: 'warn' };
    if (it && it.certRequired) return { key: 'missing', label: 'ยังไม่มี (ต้องมี)', tone: 'bad' };
    return { key: 'none', label: 'ไม่บังคับ', tone: 'muted' };
  }
  const certBadge = (lot, it) => {
    const c = certState(lot, it);
    return h.badge(c.label, c.tone);
  };
  const lotBadge = (s) => (s === 'QUARANTINED' ? h.badge('กักกันทั้งล็อต', 'bad') : h.badge('ใช้งาน', 'ok'));
  const ZERO = { AVAILABLE: 0, QC_HOLD: 0, QUARANTINE: 0, REWORK: 0, transit: 0, total: 0 };
  /** code|lot -> quantity by quality status (transit apart). */
  function stockByLot(state) {
    const out = {};
    for (const b of RRS.q.rows(state, 'balances', (x) => x.lot && x.qty)) {
      const k = b.code + '|' + b.lot;
      const r = out[k] || (out[k] = Object.assign({}, ZERO));
      if (b.wh === TRANSIT) r.transit = util.round(r.transit + b.qty);
      else r[b.status] = util.round((r[b.status] || 0) + b.qty);
      r.total = util.round(r.total + b.qty);
    }
    return out;
  }
  function supplierName(state, id) {
    if (!id) return '';
    const s = RRS.q.get(state, 'suppliers', id);
    return s && s.name ? `${s.name} (${id})` : id;
  }
  const sodOn = (state) => (((RRS.q.get(state, 'settings', 'main') || RRS.defaultSettings()).policies || {}).sod !== false);
  /** A picture card (thumbnail + name) – src must be a safe link or a small inline image (imgSrc). */
  function thumb(src, name, extra) {
    const s = imgSrc(src);
    return t`<div class="step">${s ? t`<a href="${s}" target="_blank" rel="noopener noreferrer"><img src="${s}" alt="${name || 'รูป'}" width="112" loading="lazy"></a>` : ''}<small class="muted">${name || ''}</small>${extra || ''}</div>`;
  }
  function histTable(ctx, list) {
    const rows = (list || []).slice().reverse();
    return h.table({ rows, dense: true, scroll: rows.length > 8, empty: 'ยังไม่มีประวัติ', emptyText: 'ทุกการเปลี่ยนแปลงจะบันทึกผู้ทำและเวลาไว้ที่นี่',
      cols: [
        { label: 'เวลา', get: (x) => h.fmt.dt(x.at) },
        { label: 'ผู้ทำ', get: (x) => ctx.userName(x.by) },
        { label: 'รายการ', get: (x) => ACTION_LABEL[x.action] || x.action },
        { label: 'รายละเอียด', key: 'detail' },
      ] });
  }
  const K = {
    dash, docView, ACTION_LABEL, safeUrl, imgSrc, fileLink, certState, certBadge, lotBadge, stockByLot, supplierName, sodOn, histTable, thumb,
    low: (s) => String(s == null ? '' : s).toLowerCase(),
    me: (ctx) => (ctx.user ? ctx.user.id : ''),
    docLink: (docNo) => (docNo ? h.link(h.code(docNo), 'docs', docView(docNo)) : dash),
    inspLink: (id) => (id ? h.link(h.code(id), 'inspections', { sel: id, _scroll: true }) : dash),
    ncrLink: (no) => (no ? h.link(h.code(no), 'ncrs', { sel: no, _scroll: true }) : dash),
    planLink: (id) => (id ? h.link(h.code(id), 'qc-plans', { sel: id, edit: null, _scroll: true }) : dash),
    lotLink: (code, lot, label) => (lot ? h.link(label || lot, 'lots', { tab: 'list', sel: code + '|' + lot, _scroll: true }) : dash),
    traceLink: (code, lot, label) => h.link(label || 'สอบกลับ', 'lots', { tab: 'trace', tq: lot, tcode: code || '', tsel: code ? code + '|' + lot : '' }),
    jobLink: (job) => (job ? h.link(h.code(job), 'lots', { tab: 'job', jq: job }) : dash),
    stage: (s) => ((RRS.quality && RRS.quality.STAGES) || {})[s] || s || '',
    loc: (x) => (x.wh === TRANSIT ? `ระหว่างโอน (${x.bin})` : `${x.wh || ''}${x.bin ? '/' + x.bin : ''}`),
    who: (ctx, id, at) => (id ? `${ctx.userName(id)}${at ? ' · ' + h.fmt.dt(at) : ''}` : ''),
    age: (d) => (d == null ? '' : d <= 0 ? 'วันนี้' : `${d} วัน`),
    /** Scroll a detail box into view once after a pick (below the sticky top bar). */
    scrollTo(ctx, root0, id) {
      if (!ctx.view._scroll) return;
      ctx.view._scroll = false;
      const d = root0.querySelector('#' + id);
      if (d) setTimeout(() => d.scrollIntoView({ block: 'start' }), 0);
    },
  };
  RRS.ui.qcKit = K;

  const Q = RRS.quality;
  if (!Q) {
    RRS.ui.page({ id: 'lots', title: 'ล็อต/Heat และการสอบกลับ', phase: 5, order: 10,
      render: () => h.empty('ยังไม่ได้เปิดใช้โมดูลล็อตและคุณภาพ', 'หน้านี้ใช้ได้เมื่อระบบโหลดโมดูล Phase 5 (quality) แล้ว') });
    return;
  }

  const STEP = 300;
  const TRACK = (RRS.master && RRS.master.TRACK) || { lot: 'ล็อต', heat: 'Heat no.', serial: 'Serial' };
  const CERT_FILTER = [['missing', 'ต้องมีแต่ยังไม่มี'], ['entered', 'รอ QC ตรวจใบรับรอง'], ['verified', 'ตรวจแล้ว'], ['none', 'ไม่บังคับ']];
  const RULES = 'กักกันล็อต: ของทุกตำแหน่งของล็อตนี้ที่ "ใช้ได้" หรือ "รอตรวจ" เปลี่ยนเป็น "กักกัน" (ของไม่ย้ายที่) และเบิก โอน ส่งมอบ ล็อตนี้ไม่ได้ทุกช่องทาง ยกเว้นตัดทิ้ง/คืนผู้ขายผ่าน NCR · ' +
    'ปลดกักกัน: ของกลับไปเป็น "รอตรวจ" ไม่กลับเป็น "ใช้ได้" ทันที – QC ต้องตรวจใหม่และหัวหน้า QC ปล่อยผ่านก่อนใช้';

  /**
   * Certificate pictures picked in this tab when files cannot be stored (demo / team mode): code|lot -> {no, file, name, src}.
   * The record keeps the file name only; the small picture made by ctx.uploadFile is shown while this tab is open.
   */
  const certPreviews = new Map();
  function certPreview(l) {
    const p = certPreviews.get(l.code + '|' + l.lot);
    const c = l.cert || {};
    return p && p.no === c.no && p.file === c.file ? p : null;
  }
  const selLot = (ctx) => (ctx.view.sel ? RRS.q.get(ctx.state, 'lots', ctx.view.sel) : null);
  const kindName = (l) => TRACK[l.kind] || 'ล็อต';
  const sumQ = (list) => util.round(util.sum(list, (x) => x.qty));

  function lotRows(ctx, stock) {
    const v = ctx.view;
    const q = util.ckey(v.q);
    const items = ctx.state.tables.items || {};
    return RRS.q.rows(ctx.state, 'lots').map((l) => {
      const it = items[l.code] || null;
      return { l, it, s: stock[l.code + '|' + l.lot] || ZERO, cert: certState(l, it) };
    }).filter((r) => {
      if (v.status && r.l.status !== v.status) return false;
      if (v.cert && r.cert.key !== v.cert) return false;
      if (v.has && !r.s.total) return false;
      if (q && ![r.l.lot, r.l.code, r.it && r.it.name, r.l.supplier, supplierName(ctx.state, r.l.supplier), r.l.poNo, r.l.docNo,
        r.l.cert && r.l.cert.no].some((x) => util.ckey(x).indexOf(q) >= 0)) return false;
      return true;
    }).sort((a, b) => String(b.l.receivedAt || '').localeCompare(String(a.l.receivedAt || '')) || (a.l.code + a.l.lot).localeCompare(b.l.code + b.l.lot));
  }

  function kpis(ctx) {
    const items = ctx.state.tables.items || {};
    const all = RRS.q.rows(ctx.state, 'lots');
    let quar = 0, missing = 0, waiting = 0;
    for (const l of all) {
      const c = certState(l, items[l.code]);
      if (l.status === 'QUARANTINED') quar++;
      if (c.key === 'missing') missing++;
      if (c.key === 'entered') waiting++;
    }
    return h.kpis([
      h.kpi('ล็อต/Heat ทั้งหมด', h.fmt.num(all.length), 'สร้างอัตโนมัติเมื่อรับเข้า'),
      h.kpi('กักกันทั้งล็อต', h.fmt.num(quar), quar ? 'เบิก โอน ส่งมอบไม่ได้' : 'ไม่มีล็อตถูกกักกัน', quar ? 'bad' : 'ok'),
      h.kpi('ต้องมีใบรับรองแต่ยังไม่มี', h.fmt.num(missing), missing ? 'ปล่อยผ่าน QC ไม่ได้จนกว่าจะบันทึกและตรวจ' : 'ครบทุกล็อต', missing ? 'warn' : ''),
      h.kpi('ใบรับรองรอ QC ตรวจ', h.fmt.num(waiting), 'ต้องเป็นคนละคนกับผู้บันทึก', waiting ? 'warn' : ''),
    ]);
  }

  function listTable(ctx, rows, limit) {
    const v = ctx.view;
    return h.table({
      id: 'lots-list', scroll: true, rows: rows.slice(0, limit), rowAct: 'pick', rowArg: (r) => r.l.code + '|' + r.l.lot,
      rowCls: (r) => (r.l.code + '|' + r.l.lot === v.sel ? 'sel' : r.l.status === 'QUARANTINED' ? 'row-bad' : ''),
      empty: 'ไม่พบล็อตตามตัวกรอง', emptyText: 'ลองล้างตัวกรอง หรือค้นด้วยรหัสสินค้า/ผู้ขาย/PO',
      cols: [
        { label: 'สินค้า', render: (r) => t`${h.code(r.l.code)}${r.it ? t`<br><small class="muted">${r.it.name}</small>` : ''}` },
        { label: 'ล็อต / Heat', render: (r) => t`<b>${r.l.lot}</b><br><small class="muted">${kindName(r.l)}</small>` },
        { label: 'ผู้ขาย', get: (r) => supplierName(ctx.state, r.l.supplier) || '–' },
        { label: 'PO', render: (r) => (r.l.poNo ? h.code(r.l.poNo) : dash) },
        { label: 'รับเข้าครั้งแรก', render: (r) => t`${r.l.docNo ? h.code(r.l.docNo) : dash}<br><small class="muted">${r.l.receivedAt ? h.fmt.dt(r.l.receivedAt) : ''}</small>` },
        { label: 'ใบรับรอง', render: (r) => t`${h.badge(r.cert.label, r.cert.tone)}${r.l.cert && r.l.cert.no ? t`<br><small class="muted">${r.l.cert.no}</small>` : ''}` },
        { label: 'สถานะล็อต', render: (r) => lotBadge(r.l.status) },
        { label: 'ใช้ได้', num: true, render: (r) => (r.s.AVAILABLE ? t`<b>${h.fmt.num(r.s.AVAILABLE)}</b>` : dash) },
        { label: 'รอตรวจ', num: true, render: (r) => (r.s.QC_HOLD ? h.fmt.num(r.s.QC_HOLD) : dash) },
        { label: 'กักกัน', num: true, render: (r) => (r.s.QUARANTINE ? h.fmt.num(r.s.QUARANTINE) : dash) },
        { label: 'รอแก้ไข', num: true, render: (r) => (r.s.REWORK ? h.fmt.num(r.s.REWORK) : dash) },
        { label: 'รวม', num: true, render: (r) => t`${r.s.total ? h.fmt.num(r.s.total) : '0'} <span class="unit">${r.it ? r.it.baseUnit : ''}</span>` },
      ],
    });
  }

  function detail(ctx, l) {
    const it = ctx.item(l.code) || null;
    const unit = it ? it.baseUnit : '';
    const me = K.me(ctx);
    const c = l.cert || {};
    const cs = certState(l, it);
    const sod = sodOn(ctx.state);
    const bals = RRS.q.rows(ctx.state, 'balances', (b) => b.code === l.code && b.lot === l.lot && b.qty)
      .sort((a, b) => (a.wh + a.bin + a.status).localeCompare(b.wh + b.bin + b.status));
    const facts = h.dl([
      ['สินค้า', t`${h.code(l.code)} ${it ? it.name : 'ไม่พบในทะเบียนสินค้า'}`],
      [kindName(l), t`<b>${l.lot}</b>`],
      ['ผู้ขาย', supplierName(ctx.state, l.supplier)],
      ['ใบสั่งซื้อ (PO)', l.poNo ? t`${h.code(l.poNo)}${l.poLine ? t` <small class="muted">บรรทัด ${l.poLine}</small>` : ''}` : ''],
      ['รับเข้าครั้งแรก', l.docNo ? t`${K.docLink(l.docNo)} <small class="muted">${l.receivedAt ? h.fmt.dt(l.receivedAt) : ''}</small>` : ''],
      ['สถานะล็อต', lotBadge(l.status)],
      l.status === 'QUARANTINED' ? ['กักกันโดย', t`${K.who(ctx, l.quarantinedBy, l.quarantinedAt)}${l.quarantineDocNo ? t` · ${K.docLink(l.quarantineDocNo)}` : ''}`] : null,
      l.status === 'QUARANTINED' ? ['เหตุผลการกักกัน', l.quarantineReason] : null,
      l.releasedBy ? ['ปลดกักกันล่าสุด', t`${K.who(ctx, l.releasedBy, l.releasedAt)} · ${l.releaseReason}${l.releaseDocNo ? t` · ${K.docLink(l.releaseDocNo)}` : ''}`] : null,
      l.note ? ['หมายเหตุ', l.note] : null,
    ]);

    // certificate
    const canCert = ctx.can('lot.manage');
    const canVerify = ctx.can('qc.inspect');
    const ownCert = sod && c.enteredBy && c.enteredBy === me;
    const certActs = [];
    if (canCert) certActs.push(h.btn(c.no ? 'แก้ใบรับรอง' : 'บันทึกใบรับรอง', { act: 'cert', tone: c.no ? 'ghost' : 'primary', id: 'lot-cert-btn' }));
    if (canVerify && c.no && !c.verified) {
      certActs.push(h.btn('ตรวจสอบใบรับรอง', { act: 'verify', tone: 'primary', disabled: ownCert, id: 'lot-verify-btn',
        title: ownCert ? 'คุณเป็นผู้บันทึกใบรับรองนี้ – ให้ QC อีกคนตรวจ' : 'ยืนยันว่าใบรับรองตรงกับของที่รับ' }));
    }
    const pv = certPreview(l);
    const certBox = t`${h.dl([
      ['สถานะ', h.badge(cs.label, cs.tone)], ['เลขที่ใบรับรอง', c.no], ['ไฟล์', c.file ? fileLink(c.file, 'เปิดไฟล์ใบรับรอง') : ''],
      ['บันทึกโดย', K.who(ctx, c.enteredBy, c.enteredAt)], ['ตรวจโดย', K.who(ctx, c.verifiedBy, c.verifiedAt)],
    ])}
      ${pv ? t`<div class="form-actions" id="lot-cert-preview">${thumb(pv.src, pv.name)}</div><p class="hint">รูปใบรับรองย่อไว้ให้ดูในหน้าต่างนี้เท่านั้น – ระบบเก็บเฉพาะชื่อไฟล์ (เก็บไฟล์จริงได้เมื่อใช้เซิร์ฟเวอร์)</p>` : ''}
      ${cs.key === 'missing' ? h.note(`${l.code} ต้องมีใบรับรองวัสดุ – บันทึกใบรับรองแล้วให้ QC ตรวจ ก่อนปล่อยผ่านของล็อตนี้ได้`, 'warn') : ''}
      ${cs.key === 'entered' ? h.note(ownCert && canVerify ? 'คุณเป็นผู้บันทึกใบรับรองนี้ – ผู้ตรวจต้องเป็นคนละคน (แยกหน้าที่) ให้ QC อีกคนกด ตรวจสอบใบรับรอง' : 'รอ QC ตรวจใบรับรอง (ต้องเป็นคนละคนกับผู้บันทึก) – ก่อนตรวจ ปล่อยผ่าน QC ของล็อตนี้ไม่ได้', 'warn') : ''}
      ${certActs.length ? t`<div class="form-actions">${certActs}</div>` : !canCert && !canVerify ? t`<p class="hint">บันทึกใบรับรองโดยสโตร์/QC และตรวจโดย QC อีกคน</p>` : ''}`;

    // quarantine / release
    const canQuar = ctx.can('qc.quarantine');
    const canRel = ctx.can('qc.release');
    const ownQuar = sod && l.quarantinedBy && l.quarantinedBy === me;
    // a quarantined lot can only be swept again when some of it is still ใช้ได้ / รอตรวจ (e.g. a bin that was being counted)
    const sweep = util.round(util.sum(bals.filter((b) => b.wh !== TRANSIT && (b.status === 'AVAILABLE' || b.status === 'QC_HOLD')), (b) => b.qty));
    const qActs = [];
    if (l.status !== 'QUARANTINED' && canQuar) qActs.push(h.btn('กักกันทั้งล็อต', { act: 'quarantine', tone: 'danger', id: 'lot-quar-btn' }));
    if (l.status === 'QUARANTINED' && canQuar && sweep > 0) {
      qActs.push(h.btn(`กักกันของที่ยังไม่ถูกกักกัน (${h.fmt.num(sweep)} ${unit})`, { act: 'quarantine', tone: 'danger', id: 'lot-requar-btn' }));
    }
    if (l.status === 'QUARANTINED' && canRel) {
      qActs.push(h.btn('ปลดกักกัน (กลับไปรอตรวจ)', { act: 'release', tone: 'primary', disabled: ownQuar, id: 'lot-release-btn',
        title: ownQuar ? 'คุณเป็นผู้สั่งกักกัน – ผู้ปลดต้องเป็นคนละคน' : 'ของกลับไปรอตรวจ ต้องตรวจใหม่ก่อนใช้' }));
    }
    const quarFree = util.round(util.sum(bals.filter((b) => b.status === 'QUARANTINE' && b.wh !== TRANSIT), (b) => b.qty)
      - util.sum(RRS.q.rows(ctx.state, 'ncrs', (n) => n.status === 'OPEN' && n.stockHeld && n.code === l.code && n.lot === l.lot), (n) => n.qty));
    const qBox = t`${h.note(RULES, l.status === 'QUARANTINED' ? 'bad' : 'info')}
      ${l.status === 'QUARANTINED' && ownQuar && canRel ? h.note('คุณเป็นผู้สั่งกักกันล็อตนี้ – ผู้ปลดกักกันต้องเป็นคนละคน (แยกหน้าที่)', 'warn') : ''}
      ${l.status === 'QUARANTINED' && sweep > 0 ? h.note(`ของล็อตนี้ ${h.fmt.num(sweep)} ${unit} ยังเป็น "ใช้ได้/รอตรวจ" (เช่น ช่องที่อยู่ระหว่างตรวจนับตอนสั่งกักกัน) – เบิกไม่ได้แล้ว แต่ควรสั่งกักกันให้ครบ`, 'warn') : ''}
      ${l.status === 'QUARANTINED' && quarFree > 0 ? t`<p class="hint">ของกักกันของล็อตนี้ ${h.fmt.num(quarFree)} ${unit} ยังไม่มี NCR – ถ้าจะคืนผู้ขายหรือตัดทิ้ง ${h.link('เปิด NCR ของที่กักกัน', 'ncrs', { tab: 'held' })}</p>` : ''}
      ${qActs.length ? t`<div class="form-actions">${qActs}</div>` : t`<p class="hint">กักกันโดย QC/หัวหน้าสโตร์ · ปลดกักกันโดยหัวหน้า QC (คนละคนกับผู้กักกัน)</p>`}`;

    const balTbl = h.table({ rows: bals, dense: true, empty: 'ล็อตนี้ไม่มีของคงเหลือ', emptyText: 'ใช้หมด คืน หรือตัดทิ้งแล้ว – ประวัติยังสอบกลับได้',
      cols: [
        { label: 'ตำแหน่ง', render: (b) => (b.wh === TRANSIT ? t`${h.badge('ระหว่างโอน', 'info')} ${K.docLink(b.bin)}` : h.code(K.loc(b))) },
        { label: 'สถานะ', render: (b) => h.statusBadge(b.status) },
        { label: 'จำนวน', num: true, render: (b) => h.qty(b.qty, unit) },
        { label: 'รับเข้าล่าสุด', get: (b) => (b.lastIn ? h.fmt.dt(b.lastIn) : '') },
      ] });
    const head = t`${h.code(l.code)} ${kindName(l)} ${l.lot}`;
    return h.section(head, t`${facts}
      <h3>ใบรับรองวัสดุ</h3>${certBox}
      <h3>กักกัน / ปลดกักกัน</h3>${qBox}
      <h3>ยอดตามตำแหน่ง</h3>${balTbl}
      <h3>ประวัติของล็อต</h3>${histTable(ctx, l.history)}`, {
      id: 'lot-detail',
      actions: t`${K.traceLink(l.code, l.lot, 'สอบกลับล็อตนี้')}${h.link('ดูประวัติเคลื่อนไหว', 'history', { code: l.code, lot: l.lot, docNo: '', wh: '', job: '', from: '', to: '', type: '', more: 0 })}${h.btn('ปิด', { act: 'close', tone: 'quiet', small: true })}`,
    });
  }

  function listView(ctx) {
    const v = ctx.view;
    const limit = v.limit || STEP;
    const total = RRS.q.rows(ctx.state, 'lots').length;
    if (!total) {
      return h.empty('ยังไม่มีล็อต/Heat',
        'ล็อตจะขึ้นที่นี่อัตโนมัติเมื่อบันทึกรับเข้า (RR รับซื้อ, FR รับจากผลิต, RT รับคืน) ของสินค้าที่ตั้งให้ติดตามล็อต/Heat/Serial พร้อมเลขล็อต – ตั้งการติดตามได้ที่ทะเบียนสินค้า',
        t`<div class="form-actions">${h.link('ไปทะเบียนสินค้า', 'items')}${h.link('บันทึกรับเข้า', 'docs')}</div>`);
    }
    const stock = stockByLot(ctx.state);
    const rows = lotRows(ctx, stock);
    const sel = selLot(ctx);
    const filtered = v.q || v.status || v.cert || v.has;
    const left = [
      h.field({ name: 'q', label: 'ค้นหา', value: v.q, placeholder: 'Heat/ล็อต รหัส ผู้ขาย PO เลขใบรับรอง…', id: 'lots-q', act: 'filter', live: true }),
      h.field({ name: 'status', label: 'สถานะล็อต', type: 'select', value: v.status, options: [['ACTIVE', 'ใช้งาน'], ['QUARANTINED', 'กักกัน']], blank: 'ทุกสถานะ', id: 'lots-status', act: 'filter' }),
      h.field({ name: 'cert', label: 'ใบรับรอง', type: 'select', value: v.cert, options: CERT_FILTER, blank: 'ทั้งหมด', id: 'lots-cert', act: 'filter' }),
      h.field({ name: 'has', label: 'เฉพาะที่มีของคงเหลือ', type: 'checkbox', value: v.has, id: 'lots-has', act: 'filter' }),
    ];
    const right = [filtered ? h.btn('ล้างตัวกรอง', { act: 'clear', tone: 'ghost' }) : '', rows.length ? h.btn('ดาวน์โหลด CSV', { act: 'csv', tone: 'ghost' }) : ''];
    const more = rows.length > limit
      ? t`<p class="hint">แสดง ${h.fmt.num(limit)} จาก ${h.fmt.num(rows.length)} ล็อต ${h.btn(`แสดงเพิ่มอีก ${h.fmt.num(Math.min(STEP, rows.length - limit))}`, { act: 'more', tone: 'ghost', small: true })}</p>`
      : t`<p class="hint">${h.fmt.num(rows.length)} ล็อต · คลิกแถวเพื่อดูใบรับรอง กักกัน/ปลดกักกัน ยอดตามตำแหน่ง และประวัติ</p>`;
    return t`${kpis(ctx)}${h.toolbar(left, right)}${sel ? detail(ctx, sel) : ''}<div>${listTable(ctx, rows, limit)}${more}</div>`;
  }

  // ---- trace from a heat / lot -------------------------------------------------------------------------------
  const lineText = (e) => e.lines.map((x) => `${x.code} ${h.fmt.num(x.qty)}${x.unit ? ' ' + x.unit : ''}`).join(', ');
  function docTable(ctx, list, o) {
    o = o || {};
    const cols = [
      { label: 'เอกสาร', render: (e) => t`${K.docLink(e.docNo)}${e.cancelled ? t` ${h.badge('ยกเลิกแล้ว', 'bad')}` : ''}` },
      { label: 'ประเภท', get: (e) => `${e.type} ${e.typeName}` },
      { label: 'วันที่', get: (e) => h.fmt.date(e.date) },
    ];
    if (o.job) cols.push({ label: 'ใบงาน', render: (e) => K.jobLink(e.job) });
    if (o.items) cols.push({ label: 'สินค้า', get: lineText });
    else cols.push({ label: 'จำนวน', num: true, get: (e) => e.qty });
    if (o.loc) cols.push({ label: 'ตำแหน่ง', get: (e) => e.lines.map((x) => K.loc(x) + (x.toWh ? ` → ${x.toWh}${x.toBin ? '/' + x.toBin : ''}` : '')).filter((x, i, a) => a.indexOf(x) === i).join(', ') });
    if (o.supplier) cols.push({ label: 'ผู้ขาย / PO', get: (e) => [supplierName(ctx.state, e.supplier), e.poNo].filter(Boolean).join(' · ') || '–' });
    if (o.status) cols.push({ label: 'เปลี่ยนสถานะ', get: (e) => e.lines.map((x) => `${STATUS_LABEL[x.fromStatus] || x.fromStatus} → ${STATUS_LABEL[x.toStatus] || x.toStatus} ${h.fmt.num(x.qty)}`).join(', ') });
    if (o.status) cols.push({ label: 'เหตุผล', get: (e) => e.remark });
    return h.table({ rows: list, dense: true, scroll: list.length > 10, cols });
  }
  function part(title, list, body, emptyText) {
    return h.section(t`${title} <span class="tab-n">${list.length}</span>`, list.length ? body : t`<p class="hint">${emptyText}</p>`);
  }
  function traceResult(ctx, tr) {
    const lot = tr.lot;
    const code = tr.query.code || (lot && lot.code) || '';
    const it = code ? ctx.item(code) : null;
    const unit = it ? it.baseUnit : '';
    const live = (list) => list.filter((e) => !e.cancelled);
    const inQty = sumQ(live(tr.receipts));
    const outQty = sumQ(live(tr.issues));
    const left = sumQ(tr.balances);
    const head = lot ? t`${h.code(lot.code)} ${kindName(lot)} ${lot.lot}` : t`${code ? h.code(code) : ''} ล็อต ${tr.query.lot}`;
    const facts = lot ? h.dl([
      ['สินค้า', it ? it.name : lot.code], ['ผู้ขาย', supplierName(ctx.state, lot.supplier)], ['PO', lot.poNo],
      ['ใบรับรอง', t`${certBadge(lot, it)}${lot.cert && lot.cert.no ? t` ${lot.cert.no}` : ''}`], ['สถานะล็อต', lotBadge(lot.status)],
    ]) : h.note('ไม่พบทะเบียนล็อตนี้ (รับเข้าก่อนเปิดใช้ระบบล็อต) – แสดงจากประวัติเอกสาร', 'info');
    const flow = h.kpis([
      h.kpi('รับเข้า', h.fmt.num(inQty), `${unit ? unit + ' · ' : ''}${live(tr.receipts).length} เอกสาร`),
      h.kpi('จ่ายออก', h.fmt.num(outQty), `เบิกให้ ${tr.jobs.length} ใบงาน / คืน / ตัดทิ้ง`),
      h.kpi('ผลผลิตของงานเหล่านั้น', h.fmt.num(live(tr.outputs).length), 'ใบรับจากผลิต (FR)', 'info'),
      h.kpi('ส่งมอบลูกค้า', h.fmt.num(live(tr.deliveries).length), 'ใบส่งมอบ (DL)', 'info'),
      h.kpi('คงเหลือ', h.fmt.num(left), unit, left ? '' : 'ok'),
    ]);
    const jobs = tr.jobs.length ? t`<div class="form-actions">${tr.jobs.map((j) => K.jobLink(j))}</div><p class="hint">คลิกเลขที่ใบงานเพื่อสอบกลับจากใบงานนั้น</p>` : '';
    return t`${h.section(head, t`${facts}${flow}`, { id: 'trace-head', actions: t`${lot ? K.lotLink(lot.code, lot.lot, 'ดูรายละเอียดล็อต') : ''}${h.btn('ดาวน์โหลด CSV', { act: 'traceCsv', tone: 'ghost', small: true })}` })}
      ${part('1 · รับเข้า', tr.receipts, docTable(ctx, tr.receipts, { loc: true, supplier: true }), 'ยังไม่มีเอกสารรับเข้าของล็อตนี้')}
      ${part('2 · จ่ายออก (เบิกให้งาน / คืนผู้ขาย / ตัดทิ้ง)', tr.issues, t`${docTable(ctx, tr.issues, { job: true, loc: true })}${jobs}`, 'ยังไม่มีการจ่ายล็อตนี้ออก')}
      ${part('3 · ผลผลิตของงานที่ใช้ล็อตนี้ (FR)', tr.outputs, docTable(ctx, tr.outputs, { job: true, items: true }), tr.jobs.length ? 'งานที่ใช้ล็อตนี้ยังไม่มีผลผลิตรับเข้า' : 'ยังไม่มีงานที่ใช้ล็อตนี้')}
      ${part('4 · ส่งมอบลูกค้า (DL)', tr.deliveries, docTable(ctx, tr.deliveries, { job: true, items: true }), 'ยังไม่มีการส่งมอบที่เกี่ยวกับล็อตนี้')}
      ${tr.transfers.length ? part('โอนย้าย', tr.transfers, docTable(ctx, tr.transfers, { loc: true }), '') : ''}
      ${tr.statusChanges.length ? part('เปลี่ยนสถานะคุณภาพ (QS)', tr.statusChanges, docTable(ctx, tr.statusChanges, { loc: true, status: true }), '') : ''}
      ${part('ผลตรวจ QC', tr.inspections, h.table({ rows: tr.inspections, dense: true, cols: [
        { label: 'เลขที่', render: (i) => K.inspLink(i.id) }, { label: 'ตรวจเมื่อ', get: (i) => h.fmt.dt(i.at) }, { label: 'ขั้นตอน', get: (i) => K.stage(i.stage) },
        { label: 'จำนวน', num: true, key: 'qty' }, { label: 'ผล', render: (i) => (i.result === 'PASS' ? h.badge('ผ่าน', 'ok') : h.badge('ไม่ผ่าน', 'bad')) },
        { label: 'สถานะ', get: (i) => Q.INSP_STATUS[i.status] || i.status }] }), 'ยังไม่มีผลตรวจของล็อตนี้')}
      ${tr.ncrs.length ? part('NCR', tr.ncrs, h.table({ rows: tr.ncrs, dense: true, cols: [
        { label: 'เลขที่', render: (n) => K.ncrLink(n.ncrNo) }, { label: 'เปิดเมื่อ', get: (n) => h.fmt.dt(n.createdAt) }, { label: 'จำนวน', num: true, key: 'qty' },
        { label: 'ข้อบกพร่อง', key: 'defect' }, { label: 'สถานะ', get: (n) => `${Q.NCR_STATUS[n.status] || n.status}${n.disposition ? ' · ' + Q.DISPOSITIONS[n.disposition] : ''}` }] }), '') : ''}
      ${part('คงเหลือตอนนี้', tr.balances, h.table({ rows: tr.balances, dense: true, cols: [
        { label: 'ตำแหน่ง', get: (b) => K.loc(b) }, { label: 'สถานะ', render: (b) => h.statusBadge(b.status) }, { label: 'จำนวน', num: true, render: (b) => h.qty(b.qty, unit) }] }), 'ไม่มีของคงเหลือของล็อตนี้')}`;
  }
  /** The lot to trace: the picked one, the only match, or the exact match; otherwise the list to choose from. */
  function resolveTrace(ctx) {
    const v = ctx.view;
    const text = util.trim(v.tq);
    if (!text) return { none: true };
    let cands = Q.findLots(ctx.state, text);
    let codeNote = '';
    if (util.trim(v.tcode)) {
      const it = ctx.item(v.tcode);
      if (!it) codeNote = `ไม่พบรหัส "${util.trim(v.tcode)}" ในทะเบียนสินค้า – ค้นทุกสินค้า`;
      else cands = cands.filter((l) => l.code === it.id);
    }
    let chosen = v.tsel ? cands.find((l) => l.code + '|' + l.lot === v.tsel) : null;
    if (!chosen && cands.length === 1) chosen = cands[0];
    if (!chosen) {
      const exact = cands.filter((l) => l.lot === text);
      if (exact.length === 1) chosen = exact[0];
    }
    if (chosen) return { tr: Q.trace(ctx.state, { code: chosen.code, lot: chosen.lot }), codeNote };
    if (cands.length) return { cands, codeNote };
    const tr = Q.trace(ctx.state, { lot: text, code: codeNote ? '' : util.trim(v.tcode) });
    const any = tr.receipts.length + tr.issues.length + tr.transfers.length + tr.balances.length;
    return any ? { tr, codeNote } : { missing: text, codeNote };
  }
  function traceView(ctx) {
    const v = ctx.view;
    const form = h.form({ name: 'trace', submit: 'สอบกลับ', body: [
      h.field({ name: 'tq', label: 'Heat no. / ล็อต / Serial', value: v.tq, required: true, list: 'dl-p5-lots', placeholder: 'เช่น HT-7788 (เว้นวรรค ขีด ตัวพิมพ์ ไม่มีผล)', id: 'lots-tq' }),
      h.field({ name: 'tcode', label: 'รหัสสินค้า (ไม่บังคับ)', value: v.tcode, list: 'dl-items', placeholder: 'ใส่เมื่อเลขล็อตซ้ำกันหลายสินค้า', id: 'lots-tcode' }),
    ] });
    const r = resolveTrace(ctx);
    let body;
    if (r.none) {
      body = h.empty('พิมพ์ Heat no. หรือเลขล็อต แล้วกด สอบกลับ', 'ระบบแสดงใบรับเข้า (ผู้ขาย/PO) → การเบิกให้แต่ละใบงาน → ผลผลิตของงานนั้น (FR) → การส่งมอบลูกค้า (DL) พร้อมผลตรวจ QC และ NCR');
    } else if (r.missing) {
      body = h.empty(`ไม่พบล็อต "${r.missing}"`, 'ตรวจเลขจากป้ายหรือใบรับรองวัสดุ หรือค้นด้วยบางส่วนของเลข – ล็อตจะมีเมื่อบันทึกรับเข้าพร้อมเลขล็อต');
    } else if (r.cands) {
      body = h.section(`พบ ${r.cands.length} ล็อตที่ตรงกับ "${util.trim(v.tq)}" – เลือกล็อตที่ต้องการสอบกลับ`, h.table({ rows: r.cands, rowAct: 'tpick', rowArg: (l) => l.code + '|' + l.lot, dense: true, scroll: true,
        cols: [{ label: 'สินค้า', render: (l) => t`${h.code(l.code)} ${(ctx.item(l.code) || {}).name || ''}` }, { label: 'ล็อต', key: 'lot' }, { label: 'ผู้ขาย', get: (l) => supplierName(ctx.state, l.supplier) },
          { label: 'รับเข้า', get: (l) => (l.receivedAt ? h.fmt.dt(l.receivedAt) : '') }, { label: 'สถานะ', render: (l) => lotBadge(l.status) }] }));
    } else body = traceResult(ctx, r.tr);
    return t`${h.section('สอบกลับจาก Heat / ล็อต', form, { sub: 'ใช้เมื่อพบปัญหาวัสดุ: ล็อตนี้มาจากผู้ขาย/PO ไหน ถูกเบิกไปงานใด งานนั้นผลิตอะไร และส่งมอบให้ลูกค้าแล้วหรือยัง' })}
      ${r.codeNote ? h.note(r.codeNote, 'warn') : ''}${body}`;
  }

  // ---- trace back from a job -----------------------------------------------------------------------------------
  function jobView(ctx) {
    const v = ctx.view;
    const form = h.form({ name: 'jtrace', submit: 'สอบกลับจากใบงาน', body: [
      h.field({ name: 'jq', label: 'เลขที่ใบงาน / งาน', value: v.jq, required: true, list: 'dl-p5-jobs', placeholder: 'เช่น JOB-2569-001', id: 'lots-jq' }),
    ] });
    const jn = util.trim(v.jq);
    let body;
    if (!jn) {
      body = h.empty('พิมพ์เลขที่ใบงาน แล้วกด สอบกลับจากใบงาน', 'ระบบแสดงทุกล็อต/Heat ที่ใบงานนั้นเบิกไปใช้ (หักที่คืนแล้ว) พร้อมผู้ขาย PO และใบรับรองวัสดุ');
    } else {
      const tj = Q.traceJob(ctx.state, jn);
      const job = RRS.q.get(ctx.state, 'jobs', tj.jobNo);
      const jobFacts = job ? h.dl([['สินค้าที่ผลิต', t`${h.code(job.product)} ${(ctx.item(job.product) || {}).name || ''}`], ['SO', job.soNo], ['จำนวน', job.qty],
        ['กำหนดเสร็จ', h.fmt.date(job.dueDate)], ['สถานะใบงาน', ((RRS.planning && RRS.planning.JOB_STATUS) || {})[job.status] || job.status]]) : '';
      const any = tj.lots.length + tj.outputs.length + tj.deliveries.length + tj.inspections.length + tj.ncrs.length;
      if (!any) {
        body = t`${jobFacts}${h.empty(`ไม่พบการใช้ล็อตในใบงาน ${tj.jobNo}`, job ? 'ใบงานนี้ยังไม่ได้เบิกของที่ติดตามล็อต/Heat และยังไม่มีผลผลิตหรือผลตรวจ' : 'ตรวจเลขที่ใบงาน – ต้องตรงกับช่อง งาน/SO ในใบเบิก (PD/OU)')}`;
      } else {
        const lotsTbl = h.table({ rows: tj.lots, dense: true, scroll: true, empty: 'ใบงานนี้ยังไม่ได้เบิกของที่ติดตามล็อต', cols: [
          { label: 'สินค้า', render: (g) => t`${h.code(g.code)}<br><small class="muted">${g.name || (ctx.item(g.code) || {}).name || ''}</small>` },
          { label: 'ล็อต / Heat', render: (g) => K.lotLink(g.code, g.lot) },
          { label: 'เบิก', num: true, key: 'issued' }, { label: 'คืน', num: true, key: 'returned' },
          { label: 'ใช้สุทธิ', num: true, render: (g) => t`<b>${h.fmt.num(g.qty)}</b> <span class="unit">${g.unit}</span>` },
          { label: 'ผู้ขาย', get: (g) => supplierName(ctx.state, g.supplier) || '–' },
          { label: 'PO', render: (g) => (g.poNo ? h.code(g.poNo) : dash) },
          { label: 'ใบรับเข้า', render: (g) => (g.receipts.length ? h.join(g.receipts.map((x) => K.docLink(x.docNo)), ' ') : dash) },
          { label: 'ใบรับรอง', render: (g) => t`${g.cert && g.cert.no ? t`${g.cert.no} ` : ''}${certBadge(g.lotRow, ctx.item(g.code))}${g.cert && g.cert.file ? t`<br>${fileLink(g.cert.file, 'เปิดไฟล์')}` : ''}` },
          { label: 'สถานะล็อต', render: (g) => (g.lotStatus ? lotBadge(g.lotStatus) : dash) },
          { label: '', render: (g) => K.traceLink(g.code, g.lot) },
        ] });
        body = t`${jobFacts}
          ${h.section(t`ล็อตที่ใบงาน ${tj.jobNo} ใช้ <span class="tab-n">${tj.lots.length}</span>`, lotsTbl, { id: 'job-lots', actions: h.btn('ดาวน์โหลด CSV', { act: 'jobCsv', tone: 'ghost', small: true }) })}
          ${part('ผลผลิตของใบงาน (FR)', tj.outputs, docTable(ctx, tj.outputs, { items: true }), 'ยังไม่มีผลผลิตรับเข้า')}
          ${part('ส่งมอบลูกค้า (DL)', tj.deliveries, docTable(ctx, tj.deliveries, { items: true }), 'ยังไม่ได้ส่งมอบ')}
          ${part('ผลตรวจ QC ของใบงาน', tj.inspections, h.table({ rows: tj.inspections, dense: true, cols: [
            { label: 'เลขที่', render: (i) => K.inspLink(i.id) }, { label: 'ขั้นตอน', get: (i) => K.stage(i.stage) }, { label: 'สินค้า', render: (i) => h.code(i.code) },
            { label: 'จำนวน', num: true, key: 'qty' }, { label: 'ผล', render: (i) => (i.result === 'PASS' ? h.badge('ผ่าน', 'ok') : h.badge('ไม่ผ่าน', 'bad')) },
            { label: 'สถานะ', get: (i) => Q.INSP_STATUS[i.status] || i.status }] }), 'ยังไม่มีผลตรวจ')}
          ${tj.ncrs.length ? part('NCR ของใบงาน', tj.ncrs, h.table({ rows: tj.ncrs, dense: true, cols: [
            { label: 'เลขที่', render: (n) => K.ncrLink(n.ncrNo) }, { label: 'สินค้า', render: (n) => h.code(n.code) }, { label: 'ข้อบกพร่อง', key: 'defect' },
            { label: 'สถานะ', get: (n) => Q.NCR_STATUS[n.status] || n.status }] }), '') : ''}`;
      }
    }
    return t`${h.section('สอบกลับจากใบงาน', form, { sub: 'ใช้เมื่อลูกค้าแจ้งปัญหาของงาน: งานนี้ใช้วัสดุล็อต/Heat ใด จากผู้ขายและ PO ใด ใบรับรองตรวจแล้วหรือยัง' })}${body}`;
  }

  function datalists(ctx) {
    const lots = RRS.q.rows(ctx.state, 'lots').slice(0, 800);
    const jobs = new Set(RRS.q.rows(ctx.state, 'jobs').map((j) => j.jobNo));
    for (const d of RRS.q.rows(ctx.state, 'documents', (x) => x.job && x.status !== 'DRAFT')) if (jobs.size < 800) jobs.add(d.job);
    return t`<datalist id="dl-p5-lots">${lots.map((l) => t`<option value="${l.lot}">${l.code}</option>`)}</datalist><datalist id="dl-p5-jobs">${Array.from(jobs).sort().map((j) => t`<option value="${j}"></option>`)}</datalist>`;
  }

  function csvRowsOfTrace(tr) {
    const out = [['ส่วน', 'เอกสาร', 'ประเภท', 'วันที่', 'ใบงาน', 'รหัสสินค้า', 'ล็อต', 'จำนวน', 'หน่วย', 'ตำแหน่ง', 'ผู้ขาย', 'PO', 'ยกเลิก']];
    const add = (label, list) => {
      for (const e of list) for (const l of e.lines) out.push([label, e.docNo, e.type, e.date, e.job || l.jobNo, l.code, l.lot, l.qty, l.unit, K.loc(l), e.supplier, l.poNo || e.poNo, e.cancelled ? 'ยกเลิก' : '']);
    };
    add('รับเข้า', tr.receipts);
    add('เบิกออก', tr.issues);
    add('ผลผลิต FR', tr.outputs);
    add('ส่งมอบ DL', tr.deliveries);
    add('โอนย้าย', tr.transfers);
    add('เปลี่ยนสถานะ QS', tr.statusChanges);
    return out;
  }

  RRS.ui.page({
    id: 'lots', title: 'ล็อต/Heat และการสอบกลับ', phase: 5, order: 10,
    sub: 'ทุกล็อต/Heat/Serial ที่รับเข้า พร้อมผู้ขาย PO ใบรับรองวัสดุ และสถานะ · สอบกลับจาก Heat ไปถึงงานและการส่งมอบ หรือจากใบงานกลับไปหาล็อต',
    badge: (ctx) => RRS.q.rows(ctx.state, 'lots', (l) => l.status === 'QUARANTINED').length || '',
    render(ctx) {
      const v = ctx.view;
      const tab = v.tab === 'trace' || v.tab === 'job' ? v.tab : 'list';
      const n = RRS.q.rows(ctx.state, 'lots').length;
      const body = tab === 'trace' ? traceView(ctx) : tab === 'job' ? jobView(ctx) : listView(ctx);
      return t`${h.tabs([{ id: 'list', label: 'ล็อตทั้งหมด', count: n }, { id: 'trace', label: 'สอบกลับจาก Heat/ล็อต' }, { id: 'job', label: 'สอบกลับจากใบงาน' }], tab)}
        ${body}${datalists(ctx)}`;
    },
    after(ctx, root0) {
      K.scrollTo(ctx, root0, ctx.view.tab === 'trace' ? 'trace-head' : 'lot-detail');
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg }),
      pick: (ctx, el) => ctx.set({ sel: el.dataset.arg, _scroll: true }),
      close: (ctx) => ctx.set({ sel: null }),
      more: (ctx) => ctx.set({ limit: (ctx.view.limit || STEP) + STEP }),
      clear: (ctx) => ctx.set({ q: '', status: '', cert: '', has: false, limit: STEP }),
      filter(ctx, el) {
        const patch = { limit: STEP };
        patch[el.name] = el.type === 'checkbox' ? el.checked : el.value;
        ctx.set(patch);
      },
      tpick: (ctx, el) => ctx.set({ tsel: el.dataset.arg, _scroll: true }),
      async csv(ctx) {
        const stock = stockByLot(ctx.state);
        const out = [['รหัสสินค้า', 'ชื่อสินค้า', 'ชนิด', 'ล็อต/Heat', 'ผู้ขาย', 'PO', 'เอกสารรับเข้าครั้งแรก', 'รับเข้าเมื่อ', 'เลขที่ใบรับรอง', 'สถานะใบรับรอง',
          'สถานะล็อต', 'ใช้ได้', 'รอตรวจ', 'กักกัน', 'รอแก้ไข', 'ระหว่างโอน', 'รวม', 'หน่วย']];
        for (const r of lotRows(ctx, stock)) {
          out.push([r.l.code, r.it ? r.it.name : '', kindName(r.l), r.l.lot, supplierName(ctx.state, r.l.supplier), r.l.poNo, r.l.docNo,
            r.l.receivedAt ? h.fmt.dt(r.l.receivedAt) : '', (r.l.cert && r.l.cert.no) || '', r.cert.label, Q.LOT_STATUS[r.l.status] || r.l.status,
            r.s.AVAILABLE, r.s.QC_HOLD, r.s.QUARANTINE, r.s.REWORK, r.s.transit, r.s.total, r.it ? r.it.baseUnit : '']);
        }
        await ctx.download(`lots-${ctx.today}.csv`, h.csv(out));
      },
      async traceCsv(ctx) {
        const r = resolveTrace(ctx);
        if (!r.tr) return;
        await ctx.download(`trace-${util.ckey(r.tr.query.lot) || 'lot'}-${ctx.today}.csv`, h.csv(csvRowsOfTrace(r.tr)));
      },
      async jobCsv(ctx) {
        const tj = Q.traceJob(ctx.state, ctx.view.jq);
        const out = [['ใบงาน', 'รหัสสินค้า', 'ชื่อสินค้า', 'ล็อต/Heat', 'เบิก', 'คืน', 'ใช้สุทธิ', 'หน่วย', 'ผู้ขาย', 'PO', 'ใบรับเข้า', 'เลขที่ใบรับรอง', 'ใบรับรองตรวจแล้ว', 'สถานะล็อต']];
        for (const g of tj.lots) {
          out.push([tj.jobNo, g.code, g.name, g.lot, g.issued, g.returned, g.qty, g.unit, supplierName(ctx.state, g.supplier), g.poNo,
            g.receipts.map((x) => x.docNo).join(' '), (g.cert && g.cert.no) || '', g.cert && g.cert.verified ? 'ใช่' : 'ไม่', Q.LOT_STATUS[g.lotStatus] || g.lotStatus]);
        }
        await ctx.download(`job-trace-${util.ckey(tj.jobNo)}-${ctx.today}.csv`, h.csv(out));
      },
      async cert(ctx) {
        const l = selLot(ctx);
        if (!l) return;
        const c = l.cert || {};
        const server = ctx.server;
        const oldLink = safeUrl(c.file) ? c.file : '';
        await ctx.dialog({
          title: `${c.no ? 'แก้' : 'บันทึก'}ใบรับรองวัสดุ ${l.code} ${l.lot}`, submit: 'บันทึกใบรับรอง',
          message: c.verified ? 'ใบรับรองนี้ตรวจแล้ว – ถ้าเปลี่ยนเลขที่หรือไฟล์ ผลตรวจเดิมจะถูกล้างและต้องให้ QC ตรวจใหม่'
            : 'บันทึกแล้วต้องให้ QC อีกคนตรวจสอบใบรับรอง ก่อนปล่อยผ่านของล็อตนี้ได้',
          body: t`${h.field({ name: 'no', label: 'เลขที่ใบรับรอง (Mill cert / MTC)', value: c.no, required: true, wide: true, id: 'cert-no' })}
            ${h.field({ name: 'file', label: 'ไฟล์ใบรับรอง (รูปถ่ายหรือ PDF)', type: 'file', accept: server ? 'image/*,application/pdf' : null, wide: true, id: 'cert-file',
              hint: server ? 'อัปโหลดเก็บบนเซิร์ฟเวอร์' : 'โหมดนี้เก็บเฉพาะชื่อไฟล์ รูปถ่ายย่อไว้ให้ดูในหน้าต่างนี้ (ไฟล์จริงเก็บได้เมื่อใช้เซิร์ฟเวอร์) – หรือใส่ลิงก์ไฟล์ที่เก็บไว้แล้วด้านล่าง' })}
            ${h.field({ name: 'link', label: 'หรือลิงก์ไฟล์ที่เก็บไว้แล้ว', value: oldLink, placeholder: 'https://…', wide: true, id: 'cert-link' })}
            ${c.file ? t`<p class="hint wide">ไฟล์เดิม: ${fileLink(c.file)} – ไม่เลือกไฟล์ใหม่และไม่แก้ลิงก์ = ใช้ไฟล์เดิมกับเลขที่เดิม · ถ้าแก้เลขที่ใบรับรอง ระบบจะไม่ใช้ไฟล์เดิม (เป็นใบรับรองคนละใบ) ให้แนบไฟล์หรือลิงก์ของใบใหม่</p>` : ''}
            ${h.field({ name: 'note', label: 'หมายเหตุของล็อต', value: l.note, wide: true, id: 'cert-note' })}`,
          async onSubmit(vals, form) {
            const no = util.trim(vals.no);
            if (!no) return { ok: false, errors: [{ message: 'ใส่เลขที่ใบรับรองตามที่พิมพ์บนเอกสาร' }] };
            const picked = form.querySelector('#cert-file').files[0];
            let file;
            let preview = null;
            if (picked) {
              if (server) {
                try {
                  file = (await ctx.uploadFile(picked)).url;
                } catch (e) {
                  return { ok: false, errors: [{ message: `อัปโหลดไฟล์ไม่สำเร็จ: ${(e && e.message) || e} – ลองใหม่ หรือใส่ลิงก์ไฟล์แทน` }] };
                }
              } else {
                // the record keeps the name only; a picture is shrunk by ctx.uploadFile and shown in this tab
                file = String(picked.name || 'ใบรับรอง').slice(0, 200);
                if (/^image\//.test(picked.type || '')) {
                  try {
                    const up = await ctx.uploadFile(picked);
                    if (up && imgSrc(up.url)) preview = { name: file, src: up.url };
                  } catch (e) {
                    ctx.toast(`ย่อรูป ${file} ไม่ได้ (${(e && e.message) || e}) – บันทึกเฉพาะชื่อไฟล์`, 'warn');
                  }
                }
              }
            } else if (util.trim(vals.link) !== oldLink) {
              const link = util.trim(vals.link);
              if (link && !safeUrl(link)) return { ok: false, errors: [{ message: 'ลิงก์ต้องขึ้นต้นด้วย https:// (หรือเว้นว่างเพื่อลบไฟล์)' }] };
              file = link;
            }
            const cert = { no };
            if (file !== undefined) cert.file = file;
            const payload = { code: l.code, lot: l.lot, cert };
            if (util.trim(vals.note) !== util.trim(l.note)) payload.note = vals.note;
            const r = await ctx.exec('lot.update', payload, { quiet: true, done: `บันทึกใบรับรอง ${no} แล้ว – รอ QC ตรวจ` });
            if (r.ok && preview) {
              const saved = RRS.q.get(ctx.state, 'lots', l.code + '|' + l.lot) || {};
              const sc = saved.cert || {};
              certPreviews.set(l.code + '|' + l.lot, Object.assign({ no: sc.no, file: sc.file }, preview));
              ctx.set({});
            }
            return r;
          },
        });
      },
      async verify(ctx) {
        const l = selLot(ctx);
        if (!l || !l.cert) return;
        const c = l.cert;
        const ok = await ctx.confirm({
          title: `ตรวจสอบใบรับรอง ${c.no}`, ok: 'ยืนยันว่าใบรับรองถูกต้อง',
          message: `ยืนยันว่าเลขที่ใบรับรอง ไฟล์ และ ${kindName(l)} ${l.lot} ตรงกับของที่รับเข้า (${l.code}) – ระบบบันทึกชื่อคุณเป็นผู้ตรวจ`,
          body: t`${certPreview(l) ? t`<div class="form-actions wide">${thumb(certPreview(l).src, certPreview(l).name)}</div>` : ''}${c.file ? t`<p class="wide">${fileLink(c.file, 'เปิดไฟล์ใบรับรองเพื่อเทียบ')}</p>` : t`<p class="hint wide">ใบรับรองนี้ไม่มีไฟล์แนบ – เทียบกับเอกสารจริง</p>`}`,
        });
        if (!ok) return;
        await ctx.exec('lot.verifyCert', { code: l.code, lot: l.lot }, { done: `ตรวจใบรับรอง ${c.no} แล้ว` });
      },
      async quarantine(ctx) {
        const l = selLot(ctx);
        if (!l) return;
        const it = ctx.item(l.code) || {};
        const moving = RRS.q.rows(ctx.state, 'balances', (b) => b.code === l.code && b.lot === l.lot && b.qty > 0 && b.wh !== TRANSIT
          && (b.status === 'AVAILABLE' || b.status === 'QC_HOLD'));
        const again = l.status === 'QUARANTINED';
        await ctx.dialog({
          title: `${again ? 'สั่งกักกันซ้ำ' : 'กักกันทั้งล็อต'} ${l.code} ${l.lot}`, submit: again ? 'กักกันของที่เหลือ' : 'กักกันล็อตนี้', danger: true, wide: true,
          body: t`<div class="wide">${h.note(RULES, 'warn')}</div>
            <div class="wide">${moving.length ? t`<p class="hint">ของที่จะเปลี่ยนเป็น "กักกัน" (ผลตรวจผ่านที่รอปล่อยของล็อตนี้จะเป็นโมฆะ ต้องตรวจใหม่):</p>${h.table({ rows: moving, dense: true, cols: [
              { label: 'ตำแหน่ง', get: (b) => K.loc(b) }, { label: 'จากสถานะ', render: (b) => h.statusBadge(b.status) }, { label: 'จำนวน', num: true, render: (b) => h.qty(b.qty, it.baseUnit) }] })}`
              : h.note('ตอนนี้ไม่มีของ "ใช้ได้/รอตรวจ" ของล็อตนี้ในคลัง – ล็อตจะถูกบล็อกไว้ และของที่รับเข้าใหม่ของล็อตนี้จะเป็นกักกัน', 'info')}</div>
            ${h.field({ name: 'reason', label: 'เหตุผลการกักกัน', type: 'textarea', required: true, wide: true, id: 'quar-reason', placeholder: 'เช่น ใบรับรองไม่ตรงกับ Heat ที่ตอกบนแผ่น' })}`,
          onSubmit: (vals) => ctx.exec('lot.quarantine', { code: l.code, lot: l.lot, reason: vals.reason }, { quiet: true,
            done: (r) => `กักกัน ${l.lot} แล้ว – เปลี่ยนเป็นกักกัน ${h.fmt.num(r.result.moved)} ${it.baseUnit || ''}${r.result.docNo ? ' (' + r.result.docNo + ')' : ''}` }),
        });
      },
      async release(ctx) {
        const l = selLot(ctx);
        if (!l) return;
        const it = ctx.item(l.code) || {};
        const quar = RRS.q.rows(ctx.state, 'balances', (b) => b.code === l.code && b.lot === l.lot && b.qty > 0 && b.wh !== TRANSIT && b.status === 'QUARANTINE');
        const held = RRS.q.rows(ctx.state, 'ncrs', (n) => n.status === 'OPEN' && n.stockHeld && n.code === l.code && n.lot === l.lot);
        await ctx.dialog({
          title: `ปลดกักกัน ${l.code} ${l.lot}`, submit: 'ปลดกักกัน – ให้กลับไปรอตรวจ', wide: true,
          body: t`<div class="wide">${h.note('ปลดกักกันแล้วของกลับเป็น "รอตรวจ" ไม่ใช่ "ใช้ได้" – QC ต้องตรวจใหม่ และหัวหน้า QC ปล่อยผ่านก่อน จึงเบิกได้ · ผู้ปลดต้องไม่ใช่ผู้สั่งกักกัน', 'info')}</div>
            <div class="wide">${quar.length ? h.table({ rows: quar, dense: true, cols: [
              { label: 'ตำแหน่ง', get: (b) => K.loc(b) }, { label: 'กักกันอยู่', num: true, render: (b) => h.qty(b.qty, it.baseUnit) }] }) : t`<p class="hint">ไม่มีของกักกันของล็อตนี้ในคลัง – ปลดเฉพาะสถานะล็อต</p>`}
            ${held.length ? h.note(t`ของใน NCR ที่ยังไม่ตัดสิน (${held.map((n) => n.ncrNo).join(', ')}) ยังคงกักกันจนกว่าจะตัดสิน`, 'warn') : ''}</div>
            ${h.field({ name: 'reason', label: 'เหตุผลการปลดกักกัน', type: 'textarea', required: true, wide: true, id: 'rel-reason', placeholder: 'เช่น ผู้ขายส่งใบรับรองที่ถูกต้องมาแล้ว' })}`,
          onSubmit: (vals) => ctx.exec('lot.release', { code: l.code, lot: l.lot, reason: vals.reason }, { quiet: true,
            done: (r) => `ปลดกักกัน ${l.lot} แล้ว – กลับไปรอตรวจ ${h.fmt.num(r.result.moved)} ${it.baseUnit || ''}` }),
        });
      },
    },
    forms: {
      trace: (ctx, v) => ctx.set({ tq: util.trim(v.tq), tcode: util.trim(v.tcode), tsel: '', _scroll: true }),
      jtrace: (ctx, v) => ctx.set({ jq: util.trim(v.jq) }),
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
