/*
 * Phase 5 – ตรวจ QC และปล่อยผ่าน (RRS.quality: qcQueue, planFor, qc.inspect, qc.release, releaseCheck).
 *   คิวตรวจ        balances in รอตรวจ / กักกัน / รอแก้ไข with their age; start an inspection (or a re-inspection after
 *                 rework) from a row. Finished goods in รอตรวจ cannot be delivered – "ผลิตเสร็จ" is not "ผ่าน QC".
 *   รอปล่อยผ่าน    PASS results waiting for a release by another person (qc.release); the reasons a person cannot release
 *                 (the inspector, who posted the receipt, certificate not checked, lot quarantined) come from the engine.
 *   ผลตรวจทั้งหมด  every result with its characteristics, photos, NCR, re-inspections and releases.
 * The inspection form takes the approved plan of the item + stage and gives one input per characteristic; pass/fail is
 * shown as the person types (min/max of the plan), photos are attached with ctx.uploadFile. Results are voided by the
 * engine itself (lot quarantined, source document cancelled) – there is no manual void command.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const { util, TRANSIT, STATUS_LABEL } = RRS;
  const Q = RRS.quality;
  const K = RRS.ui.qcKit;
  if (!Q || !K) {
    RRS.ui.page({ id: 'inspections', title: 'ตรวจ QC และปล่อยผ่าน', phase: 5, order: 30,
      render: () => h.empty('ยังไม่ได้เปิดใช้โมดูลคุณภาพ', 'หน้านี้ใช้ได้เมื่อระบบโหลดโมดูล Phase 5 (quality) แล้ว') });
    return;
  }

  const STEP = 300;
  const MAX_PHOTOS = 20;
  const STOCK_STAGES = { INCOMING: true, FINAL: true };
  const STAGE_OPTS = Object.entries(Q.STAGES);
  const INSP_TONE = { OPEN: 'warn', RELEASED: 'ok', NCR: 'bad', VOID: 'muted' };
  const RULE = 'ผลิตเสร็จยังไม่เท่ากับผ่าน QC: ของที่รับจากผลิต (FR) ของสินค้าที่ต้องตรวจก่อนส่งมอบจะอยู่ในสถานะ "รอตรวจ" – ส่งมอบลูกค้า (DL) เบิก หรือโอนไม่ได้ ' +
    'จนกว่า QC ตรวจผ่าน และหัวหน้า QC ที่ไม่ใช่ผู้ตรวจกดปล่อยผ่าน ของจึงเปลี่ยนเป็น "ใช้ได้"';
  const SOD = 'ผู้ตรวจปล่อยผ่านงานที่ตัวเองตรวจไม่ได้ และผู้บันทึกใบรับเข้าก็ปล่อยของที่ตัวเองรับไม่ได้ – คนวัดกับคนอนุมัติต้องเป็นคนละคน (แยกหน้าที่) · ' +
    'สินค้าที่ต้องมีใบรับรองวัสดุ ต้องบันทึกและตรวจใบรับรองของล็อตนั้นก่อน';
  /** Pictures taken in this tab when files cannot be stored (demo / team mode): inspection id -> [{name, src}]. */
  const previews = new Map();

  const inspBadge = (i) => h.badge(Q.INSP_STATUS[i.status] || i.status, INSP_TONE[i.status]);
  const resultBadge = (r) => (r === 'PASS' ? h.badge('ผ่าน', 'ok') : r === 'FAIL' ? h.badge('ไม่ผ่าน', 'bad') : '');
  const fmtN = (n) => (n == null || n === '' ? '' : h.fmt.num(n));
  function rangeText(c) {
    if (c.kind !== 'measure') return 'ผ่าน / ไม่ผ่าน';
    if (c.min != null && c.max != null) return `${fmtN(c.min)} – ${fmtN(c.max)}`;
    return c.min != null ? `≥ ${fmtN(c.min)}` : `≤ ${fmtN(c.max)}`;
  }
  /** The engine's own rule: measure = rounded number within min/max; check = ผ่าน / OK / pass. */
  function judge(c, v) {
    if (v == null || String(v).trim() === '') return 'empty';
    if (c.kind === 'measure') {
      const n = util.num(v);
      if (isNaN(n)) return 'invalid';
      const x = util.round(n);
      return (c.min == null || x >= c.min) && (c.max == null || x <= c.max) ? 'ok' : 'bad';
    }
    return /^(ผ่าน|ok|pass)$/i.test(String(v).trim()) ? 'ok' : 'bad';
  }
  const JUDGE = { ok: ['ผ่าน', 'ok'], bad: ['ไม่ผ่าน', 'bad'], invalid: ['ไม่ใช่ตัวเลข', 'warn'], empty: ['ยังไม่กรอก', 'muted'] };
  const sameLoc = (a, b) => a.code === b.code && a.wh === b.wh && (a.bin || '') === (b.bin || '') && (a.lot || '') === (b.lot || '');
  const isFinalItem = (it) => !!it && (it.qcFinal || it.type === 'FG');
  const postedDoc = (d) => d && d.status !== 'DRAFT' && d.status !== 'WAIT_APPROVAL' && d.status !== 'CANCELLED';

  /** The receipt that put this balance into รอตรวจ (latest posted inbound line of the same place). */
  function lastInbound(state, b) {
    let best = null;
    for (const d of RRS.q.rows(state, 'documents', postedDoc)) {
      const td = RRS.inventory.DOC_TYPES[d.type] || {};
      if (!(td.dir === 1 || td.dir === 0)) continue;
      const hit = (d.lines || []).some((l) => l.code === b.code && (l.wh || '') === b.wh && (l.bin || '') === (b.bin || '') && (l.lot || '') === (b.lot || '')
        && l.status === b.status && Number(l.base != null ? l.base : l.qty) > 0);
      if (hit && (!best || String(d.postedAt || '') > String(best.postedAt || ''))) best = d;
    }
    return best;
  }
  /** Quantity already inspected PASS and waiting for release at a place + status. */
  function pendingAt(state, loc, status) {
    return util.round(util.sum(RRS.q.rows(state, 'inspections', (i) => i.status === 'OPEN' && STOCK_STAGES[i.stage] && i.fromStatus === status && sameLoc(i, loc)),
      (i) => i.qty - (i.releasedQty || 0)));
  }

  /** Quantity of an NCR (decided REWORK) still waiting for its re-inspection (void results do not count). */
  function ncrLeft(ctx, n) {
    if (!n) return 0;
    const done = util.sum(RRS.q.rows(ctx.state, 'inspections', (x) => x.reinspectionNcr === n.ncrNo && x.status !== 'VOID'), (x) => x.qty);
    return Math.max(0, util.round(n.qty - done));
  }

  // ---- the inspection form ------------------------------------------------------------------------------------
  function formValues() {
    const form = root.document.querySelector('form[data-form="ins"]');
    return form ? h.parseForm(form) : {};
  }
  /** The approved plan the form's item + stage uses ('' when none) – results are kept only while it stays the same. */
  function planKey(ctx, e) {
    const it = util.trim(e.code) ? ctx.item(e.code) : null;
    const p = it ? Q.planFor(ctx.state, it.id, e.stage || 'INCOMING') : null;
    return p ? p.id : '';
  }
  function mergeIns(ctx, vals, patch) {
    const cur = ctx.view.ins || {};
    return Object.assign({}, cur, vals, { res: Object.assign({}, cur.res || {}, vals.res || {}), photos: cur.photos || [] }, patch || {});
  }
  function charRow(c, e) {
    const val = (e.res || {})[c.id];
    const j = JUDGE[judge(c, val)];
    const input = c.kind === 'measure'
      ? t`<input type="number" step="any" inputmode="decimal" name="res[${c.id}]" id="ins-res-${c.id}" value="${val == null ? '' : val}" data-act="insField" data-live="1" aria-label="${c.name}">`
      : t`<div class="checks radios" role="radiogroup" aria-label="${c.name}">${['ผ่าน', 'ไม่ผ่าน'].map((o) => t`<label class="chk"><input type="radio" name="res[${c.id}]" value="${o}" data-act="insField"${h.safe(String(val || '') === o ? ' checked' : '')}> ${o}</label>`)}</div>`;
    return { c, input, badge: h.badge(j[0], j[1]) };
  }
  function insForm(ctx) {
    const v = ctx.view;
    const e = v.ins || {};
    const stage = e.stage || 'INCOMING';
    const stock = !!STOCK_STAGES[stage];
    const it = util.trim(e.code) ? ctx.item(e.code) : null;
    const unit = it ? it.baseUnit : '';
    const tracked = !!it && it.trackLot && it.trackLot !== 'none';
    const fromStatus = e.fromStatus || 'QC_HOLD';
    const plan = it ? Q.planFor(ctx.state, it.id, stage) : null;
    let avail = '';
    if (stock && it && e.wh) {
      const loc = { code: it.id, wh: util.normCode(e.wh), bin: util.normCode(e.bin), lot: util.trim(e.lot) };
      const have = RRS.q.qty(ctx.state, Object.assign({ status: fromStatus }, loc));
      const pend = pendingAt(ctx.state, loc, fromStatus);
      avail = `มี${STATUS_LABEL[fromStatus]}ที่ ${K.loc(loc)}${loc.lot ? ' ล็อต ' + loc.lot : ''} ${h.fmt.num(have)} ${unit}${pend ? ` (ตรวจผ่านรอปล่อย ${h.fmt.num(pend)})` : ''} – ตรวจได้ไม่เกิน ${h.fmt.num(Math.max(0, util.round(have - pend)))}`;
    }
    const src = util.trim(e.sourceDoc) ? RRS.q.get(ctx.state, 'documents', util.normCode(e.sourceDoc)) : null;
    const me = K.me(ctx);
    const head = [
      h.field({ name: 'stage', label: 'ขั้นตอนตรวจ', type: 'select', value: stage, options: STAGE_OPTS, blank: false, act: 'insField', id: 'ins-stage' }),
      h.field({ name: 'code', label: 'สินค้า', value: e.code, list: 'dl-items', required: true, act: 'insField', live: true, id: 'ins-code', placeholder: 'รหัสสินค้า',
        hint: util.trim(e.code) ? (it ? it.name : 'ไม่พบรหัสนี้ในทะเบียนสินค้า') : 'พิมพ์หรือเลือกรหัสสินค้า' }),
      h.field({ name: 'wh', label: stock ? 'คลัง' : 'คลัง (ถ้ามี)', type: 'select', value: e.wh, options: h.whOptions(ctx.state), required: stock, act: 'insField', id: 'ins-wh' }),
      h.field({ name: 'bin', label: 'ช่องเก็บ', value: e.bin, list: 'dl-bins', act: 'insField', live: true, id: 'ins-bin' }),
      tracked || util.trim(e.lot) ? h.field({ name: 'lot', label: tracked ? ((RRS.master.TRACK || {})[it.trackLot] || 'ล็อต') : 'ล็อต', value: e.lot, required: stock && tracked, act: 'insField', live: true, id: 'ins-lot',
        hint: tracked ? 'ตามป้ายของ / ใบรับรอง' : 'สินค้านี้ไม่ได้ติดตามล็อต – ลบออก' }) : '',
      stock ? h.field({ name: 'fromStatus', label: 'ตรวจของสถานะ', type: 'select', value: fromStatus, blank: false, act: 'insField', id: 'ins-from',
        options: [['QC_HOLD', 'รอตรวจ (ตรวจครั้งแรก)'], ['REWORK', 'รอแก้ไข (ตรวจซ้ำหลังแก้ไข)']] }) : '',
      h.field({ name: 'qty', label: `จำนวนที่ตรวจ${unit ? ' (' + unit + ')' : ''}`, type: 'number', value: e.qty, required: true, act: 'insField', live: true, id: 'ins-qty', hint: avail || '' }),
      h.field({ name: 'sourceDoc', label: 'เอกสารต้นทาง', value: e.sourceDoc, id: 'ins-src', placeholder: 'เช่น RR6911-0001',
        hint: src ? `${src.type} ${src.date ? h.fmt.date(src.date) : ''} บันทึกโดย ${ctx.userName(src.postedBy)}${src.postedBy === me ? ' – คุณบันทึกเอง จึงตรวจไม่ได้ (แยกหน้าที่)' : ''}` : 'ใบรับเข้า (RR) หรือรับจากผลิต (FR) ที่ทำให้ของเข้ารอตรวจ' }),
      h.field({ name: 'jobNo', label: stage === 'IN_PROCESS' ? 'ใบงาน' : 'ใบงาน (ถ้ามี)', value: e.jobNo, required: stage === 'IN_PROCESS', id: 'ins-job', list: 'dl-p5-jobs' }),
      fromStatus === 'REWORK' || util.trim(e.reinspectionOf) || stage === 'IN_PROCESS'
        ? h.field({ name: 'reinspectionOf', label: 'ตรวจซ้ำของผลตรวจ / NCR', value: e.reinspectionOf, required: fromStatus === 'REWORK', id: 'ins-reof', placeholder: 'เช่น IN-00012 หรือ NCR6911-0003',
          hint: 'ตรวจซ้ำหลังแก้ไขต้องอ้างผลตรวจที่ไม่ผ่าน (หรือ NCR) ของสินค้า ล็อต และขั้นตอนเดียวกัน' }) : '',
    ];
    let planBox;
    if (!it) planBox = t`<p class="hint">เลือกสินค้าและขั้นตอน ระบบจะดึงหัวข้อตรวจจากแผนที่อนุมัติ</p>`;
    else if (!plan) {
      planBox = h.note(t`ยังไม่มีแผนตรวจที่อนุมัติของ ${it.id} ขั้นตอน${Q.STAGES[stage]} – บันทึกผลไม่ได้ ให้วิศวกรรม/หัวหน้า QC ทำแผนและให้อีกคนอนุมัติ ${h.link('ไปหน้าแผนการตรวจ QC', 'qc-plans', { tab: 'missing' })}`, 'bad');
    } else if (plan.stale) {
      planBox = h.note(t`แผน ${plan.id} อ้างแบบฉบับ "${plan.drawingRev || '-'}" แต่ฉบับแบบที่อนุมัติปัจจุบันของ ${it.id} คือ "${it.drawingRev || '-'}" – ต้องอนุมัติแผนฉบับใหม่ก่อน ${h.link('ไปหน้าแผนการตรวจ QC', 'qc-plans', { sel: plan.id })}`, 'bad');
    } else {
      const rows = plan.chars.map((c) => charRow(c, e));
      const states = plan.chars.map((c) => judge(c, (e.res || {})[c.id]));
      const filled = states.filter((s) => s !== 'empty').length;
      const qtyTxt = e.qty ? `${h.fmt.num(e.qty)} ${unit}` : 'จำนวนที่ตรวจ';
      let overall;
      if (states.indexOf('invalid') >= 0) overall = h.note('บางหัวข้อไม่ใช่ตัวเลข – ใส่ค่าที่วัดได้เป็นตัวเลข', 'warn');
      else if (filled < states.length) overall = h.note(`กรอกแล้ว ${filled}/${states.length} หัวข้อ – ต้องกรอกครบทุกหัวข้อ`, 'info');
      else if (states.every((s) => s === 'ok')) overall = h.note(`ผลรวม: ผ่าน – ${stock ? `ของยังเป็น "${STATUS_LABEL[fromStatus]}" จนกว่า` : 'รอ'}หัวหน้า QC ที่ไม่ใช่ผู้ตรวจกดปล่อยผ่าน`, 'ok');
      else overall = h.note(`ผลรวม: ไม่ผ่าน – เมื่อบันทึก ระบบเปิด NCR${stock ? ` และเปลี่ยน ${qtyTxt} เป็น "กักกัน"` : ''} รอหัวหน้า QC ตัดสิน`, 'bad');
      planBox = t`${h.dl([['แผนตรวจ', K.planLink(plan.id)], ['ฉบับแบบ', plan.drawingRev || '(ไม่ระบุ)'], ['อ้างอิงแบบ/WI', plan.sourceRef], ['วิธีสุ่มตรวจ', plan.sampling]])}
        ${h.table({ rows, dense: true, cols: [
          { label: 'หัวข้อตรวจ / เกณฑ์ยอมรับ', render: (r) => t`<b>${r.c.name}</b><br><span class="nowrap">${rangeText(r.c)}${r.c.unit ? t` <span class="unit">${r.c.unit}</span>` : ''}</span>${r.c.kind === 'measure' && r.c.nominal != null ? t`<br><small class="muted">ค่าระบุ ${fmtN(r.c.nominal)}</small>` : ''}${r.c.method ? t`<br><small class="muted">${r.c.method}</small>` : ''}` },
          { label: 'ค่าที่วัด / ผล', w: '48%', render: (r) => t`${r.input}<div id="ins-judge-${r.c.id}">${r.badge}</div>` },
        ] })}
        <div id="ins-overall">${overall}</div>`;
    }
    const photos = e.photos || [];
    const photoBox = t`<label class="fld wide" for="ins-photo"><span class="fld-l">รูปหลักฐาน (ไม่เกิน ${MAX_PHOTOS} รูป)</span>
        <input type="file" accept="image/*" multiple id="ins-photo" data-act="insPhoto">
        <small class="hint">${ctx.server ? 'รูปเก็บบนเซิร์ฟเวอร์' : 'โหมดนี้ย่อรูปไว้ให้ดูในหน้าจอนี้ และบันทึกเฉพาะชื่อรูปกับผลตรวจ (รูปจริงเก็บได้เมื่อใช้เซิร์ฟเวอร์)'}</small></label>
      ${photos.length ? t`<div class="form-actions wide" id="ins-thumbs">${photos.map((p, i) => thumb(p.preview || p.url, p.name, h.btn('ลบรูป', { act: 'insPhotoDel', arg: i, tone: 'quiet', small: true })))}</div>` : ''}`;
    const body = [
      ...head,
      t`<div class="wide"><h3>ผลแต่ละหัวข้อ</h3>${planBox}</div>`,
      photoBox,
      h.field({ name: 'note', label: 'หมายเหตุ / รายละเอียดที่พบ', type: 'textarea', value: e.note, wide: true, id: 'ins-note' }),
      v.insErr ? t`<div class="wide">${h.note(t`บันทึกไม่ได้ – ยังไม่มีอะไรเปลี่ยน${h.errors(v.insErr)}`, 'bad')}</div>` : '',
    ];
    const title = util.trim(e.reinspectionOf) || fromStatus === 'REWORK' ? 'บันทึกผลตรวจซ้ำหลังแก้ไข' : `บันทึกผลตรวจ${Q.STAGES[stage]}`;
    return h.section(title, h.form({ name: 'ins', submit: 'บันทึกผลตรวจ', cancel: 'insClose', body }), {
      id: 'ins-form', sub: 'ใช้แผนตรวจที่อนุมัติของสินค้าและขั้นตอนนี้ · ผู้ตรวจต้องไม่ใช่ผู้บันทึกเอกสารรับเข้า · ผลผ่านต้องให้หัวหน้า QC อีกคนปล่อยผ่าน',
    });
  }
  const thumb = K.thumb;

  // ---- queue -------------------------------------------------------------------------------------------------
  function queueView(ctx, qq) {
    const v = ctx.view;
    const q = util.ckey(v.q);
    const items = ctx.state.tables.items || {};
    const rows = qq.balances.filter((b) => (!v.st || b.status === v.st)
      && (!q || [b.code, b.name, b.lot, b.wh, b.bin].some((x) => util.ckey(x).indexOf(q) >= 0)));
    const canIns = (wh) => ctx.can('qc.inspect', wh);
    const tbl = h.table({ id: 'qc-queue', scroll: true, rows, empty: v.st || v.q ? 'ไม่พบรายการตามตัวกรอง' : 'ไม่มีของรอตรวจ กักกัน หรือรอแก้ไข',
      emptyText: v.st || v.q ? 'ลองล้างตัวกรอง' : 'ของจะขึ้นที่นี่เมื่อรับเข้าสินค้าที่ตั้ง "ต้องตรวจรับ" (RR) หรือรับจากผลิตสินค้าที่ "ต้องตรวจเมื่อผลิตเสร็จ" (FR) – ตั้งได้ที่ทะเบียนสินค้า',
      rowCls: (b) => (b.status === 'QUARANTINE' ? 'row-bad' : ''),
      cols: [
        { label: 'สินค้า', render: (b) => t`${h.code(b.code)}<br><small class="muted">${b.name}</small>${b.status === 'QC_HOLD' && isFinalItem(items[b.code]) ? t`<br>${h.badge('ผลิตเสร็จ – ส่งมอบไม่ได้จนกว่าจะผ่าน QC', 'warn')}` : ''}` },
        { label: 'ตำแหน่ง', render: (b) => h.code(K.loc(b)) },
        { label: 'ล็อต', render: (b) => (b.lot ? t`${K.lotLink(b.code, b.lot)}${b.certRequired ? t`<br>${b.certVerified ? h.badge('ใบรับรองตรวจแล้ว', 'ok') : b.certNo ? h.badge('ใบรับรองรอตรวจ', 'warn') : h.badge('ยังไม่มีใบรับรอง', 'bad')}` : ''}${b.lotStatus === 'QUARANTINED' ? t`<br>${h.badge('ล็อตถูกกักกัน', 'bad')}` : ''}` : K.dash) },
        { label: 'สถานะ', render: (b) => h.statusBadge(b.status) },
        { label: 'จำนวน', num: true, render: (b) => h.qty(b.qty, b.unit) },
        { label: 'ยังไม่ได้ตรวจ', num: true, render: (b) => (b.status === 'QUARANTINE' ? K.dash : b.toInspect ? t`<b>${h.fmt.num(b.toInspect)}</b>` : '0') },
        { label: 'ผ่านรอปล่อย', num: true, render: (b) => (b.waitingRelease ? h.fmt.num(b.waitingRelease) : K.dash) },
        { label: 'อยู่ใน NCR', render: (b) => (b.ncrs.length ? h.join(b.ncrs.map((n) => K.ncrLink(n.ncrNo)), ' ') : K.dash) },
        { label: 'อายุ', num: true, render: (b) => (b.ageDays == null ? K.dash : b.ageDays > 3 ? h.badge(K.age(b.ageDays), 'warn') : K.age(b.ageDays)) },
        { label: '', render: (b) => {
          const key = RRS.balanceKey(b);
          if (b.status === 'QC_HOLD') {
            if (!canIns(b.wh)) return t`<small class="muted">รอ QC ตรวจ</small>`;
            if (b.lotStatus === 'QUARANTINED') return t`<small class="muted">ล็อตถูกกักกัน</small>`;
            return b.toInspect > 0 ? h.btn('ตรวจ', { act: 'startIns', arg: key, small: true, tone: 'primary' }) : t`<small class="muted">ตรวจครบแล้ว รอปล่อยผ่าน</small>`;
          }
          if (b.status === 'REWORK') return canIns(b.wh) && b.toInspect > 0 ? h.btn('ตรวจซ้ำหลังแก้ไข', { act: 'startRe', arg: key, small: true, tone: 'primary' }) : t`<small class="muted">รอแก้ไขแล้วตรวจซ้ำ</small>`;
          if (b.ncrs.length) return t`<small class="muted">รอตัดสิน NCR</small>`;
          return canIns(b.wh) ? h.link('เปิด NCR', 'ncrs', { tab: 'held' }) : t`<small class="muted">ยังไม่มี NCR – QC เป็นผู้เปิด</small>`;
        } },
      ] });
    const filtered = v.st || v.q;
    return t`${h.toolbar([
      h.field({ name: 'q', label: 'ค้นหา', value: v.q, placeholder: 'รหัส ชื่อ ล็อต คลัง…', id: 'insq-q', act: 'filter', live: true }),
      h.field({ name: 'st', label: 'สถานะ', type: 'select', value: v.st, options: [['QC_HOLD', 'รอตรวจ'], ['QUARANTINE', 'กักกัน'], ['REWORK', 'รอแก้ไข']], blank: 'ทุกสถานะ', id: 'insq-st', act: 'filter' }),
    ], [filtered ? h.btn('ล้างตัวกรอง', { act: 'clear', tone: 'ghost' }) : '', ctx.can('qc.inspect') ? h.btn('ตรวจระหว่างผลิต (ไม่มีของในคลัง)', { act: 'startInProcess', tone: 'ghost' }) : '',
      ctx.can('qc.inspect') ? h.btn('+ บันทึกผลตรวจ', { act: 'startBlank', tone: 'ghost', id: 'ins-new-btn' }) : ''])}
      <div>${tbl}<p class="hint">อายุนับจากวันที่รับเข้าตำแหน่งนั้นล่าสุด · เรียงจากค้างนานที่สุด · ของกักกันดำเนินการต่อที่หน้า NCR</p></div>`;
  }

  // ---- waiting for release ------------------------------------------------------------------------------------
  function releaseView(ctx, qq) {
    const me = K.me(ctx);
    const rows = qq.inspections;
    const tbl = h.table({ id: 'qc-release', scroll: true, rows, empty: 'ไม่มีผลตรวจผ่านที่รอปล่อย', emptyText: 'ผลตรวจที่ผ่านจะรอที่นี่จนหัวหน้า QC (คนละคนกับผู้ตรวจ) กดปล่อยผ่าน',
      cols: [
        { label: 'ผลตรวจ', render: (i) => t`${K.inspLink(i.id)}<br><small class="muted">${K.stage(i.stage)}</small>` },
        { label: 'สินค้า', render: (i) => t`${h.code(i.code)}${i.lot ? t`<br><small class="muted">ล็อต ${i.lot}</small>` : ''}` },
        { label: 'ตำแหน่ง', get: (i) => (i.wh ? K.loc(i) : 'ระหว่างผลิต') },
        { label: 'รอปล่อย', num: true, render: (i) => h.qty(util.round(i.qty - (i.releasedQty || 0)), (ctx.item(i.code) || {}).baseUnit) },
        { label: 'ผู้ตรวจ', render: (i) => t`${ctx.userName(i.inspector)}<br><small class="muted">${h.fmt.dt(i.at)}</small>` },
        { label: 'ปล่อยผ่าน', render: (i) => {
          if (!ctx.can('qc.release', i.wh || undefined)) return t`<small class="muted">รอหัวหน้า QC</small>`;
          const why = Q.releaseCheck(ctx.state, i.id, me);
          if (why.length) return t`<small class="muted">${why.map((w) => w.message).join(' · ')}</small>`;
          return h.btn('ปล่อยผ่าน', { act: 'release', arg: i.id, small: true, tone: 'primary' });
        } },
      ] });
    return t`${h.note(SOD, 'info')}<div>${tbl}</div>`;
  }

  // ---- every result -------------------------------------------------------------------------------------------
  function allRows(ctx) {
    const v = ctx.view;
    const q = util.ckey(v.aq);
    return RRS.q.rows(ctx.state, 'inspections', (i) => (!v.ares || i.result === v.ares) && (!v.astat || i.status === v.astat)
      && (!q || [i.id, i.code, i.lot, i.jobNo, i.ncrNo, i.sourceDoc].some((x) => util.ckey(x).indexOf(q) >= 0)))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)) || b.id.localeCompare(a.id));
  }
  function allView(ctx) {
    const v = ctx.view;
    const limit = v.limit || STEP;
    const rows = allRows(ctx);
    const tbl = h.table({ id: 'qc-all', scroll: true, rows: rows.slice(0, limit), rowAct: 'pick', rowArg: (i) => i.id, rowCls: (i) => (i.id === v.sel ? 'sel' : ''),
      empty: RRS.q.rows(ctx.state, 'inspections').length ? 'ไม่พบผลตรวจตามตัวกรอง' : 'ยังไม่มีผลตรวจ',
      emptyText: RRS.q.rows(ctx.state, 'inspections').length ? 'ลองล้างตัวกรอง' : 'บันทึกผลตรวจได้จากแท็บ คิวตรวจ (ปุ่ม ตรวจ ของแต่ละแถว)',
      cols: [
        { label: 'เลขที่', render: (i) => h.code(i.id) }, { label: 'ตรวจเมื่อ', get: (i) => h.fmt.dt(i.at) }, { label: 'ขั้นตอน', get: (i) => K.stage(i.stage) },
        { label: 'สินค้า', render: (i) => t`${h.code(i.code)}${i.lot ? t`<br><small class="muted">ล็อต ${i.lot}</small>` : ''}` },
        { label: 'จำนวน', num: true, key: 'qty' }, { label: 'ผล', render: (i) => resultBadge(i.result) }, { label: 'สถานะ', render: (i) => inspBadge(i) },
        { label: 'ผู้ตรวจ', get: (i) => ctx.userName(i.inspector) }, { label: 'NCR', render: (i) => (i.ncrNo ? h.code(i.ncrNo) : K.dash) },
      ] });
    const more = rows.length > limit ? t`<p class="hint">แสดง ${h.fmt.num(limit)} จาก ${h.fmt.num(rows.length)} ${h.btn('แสดงเพิ่ม', { act: 'more', tone: 'ghost', small: true })}</p>` : '';
    return t`${h.toolbar([
      h.field({ name: 'aq', label: 'ค้นหา', value: v.aq, placeholder: 'เลขที่ รหัส ล็อต ใบงาน NCR…', id: 'insa-q', act: 'filter', live: true }),
      h.field({ name: 'ares', label: 'ผล', type: 'select', value: v.ares, options: [['PASS', 'ผ่าน'], ['FAIL', 'ไม่ผ่าน']], blank: 'ทุกผล', id: 'insa-res', act: 'filter' }),
      h.field({ name: 'astat', label: 'สถานะ', type: 'select', value: v.astat, options: Object.entries(Q.INSP_STATUS), blank: 'ทุกสถานะ', id: 'insa-stat', act: 'filter' }),
    ], rows.length ? h.btn('ดาวน์โหลด CSV', { act: 'csv', tone: 'ghost' }) : '')}<div>${tbl}${more}</div>`;
  }

  // ---- one result ---------------------------------------------------------------------------------------------
  function detail(ctx, i) {
    const it = ctx.item(i.code) || {};
    const unit = it.baseUnit || '';
    const me = K.me(ctx);
    const stock = !!STOCK_STAGES[i.stage];
    const ncr = i.ncrNo ? RRS.q.get(ctx.state, 'ncrs', i.ncrNo) : null;
    const acts = [];
    const notes = [];
    if (i.status === 'OPEN' && i.result === 'PASS') {
      const why = Q.releaseCheck(ctx.state, i.id, me);
      if (ctx.can('qc.release', i.wh || undefined)) {
        acts.push(h.btn('ปล่อยผ่าน', { act: 'release', arg: i.id, tone: 'primary', disabled: why.length > 0, id: 'ins-release-btn', title: why.length ? why[0].message : 'ให้ของใช้ได้' }));
        if (why.length) notes.push(h.note(t`ปล่อยผ่านไม่ได้ตอนนี้:${h.errors({ errors: why })}`, 'warn'));
        if (i.inspector !== me) acts.push(h.btn('ยกเลิกผลตรวจ (บันทึกผิด)', { act: 'voidInsp', arg: i.id, tone: 'ghost', id: 'ins-void-btn', title: 'ทำให้ผลนี้เป็นโมฆะ – ของยังรอตรวจและต้องตรวจใหม่' }));
      } else notes.push(h.note(`ผลผ่านแล้ว รอหัวหน้า QC ที่ไม่ใช่ผู้ตรวจ (${ctx.userName(i.inspector)}) กดปล่อยผ่าน – ระหว่างนี้ของยังเป็น "${STATUS_LABEL[i.fromStatus] || 'รอตรวจ'}" ใช้หรือส่งมอบไม่ได้`, 'info'));
    }
    if (i.result === 'FAIL' && ctx.can('qc.inspect', i.wh || undefined)) {
      // a re-inspection needs the NCR decided REWORK, pieces of it not yet re-inspected and (for stock) รอแก้ไข stock there
      const rw = !!ncr && ncr.status === 'DISPOSITIONED' && ncr.disposition === 'REWORK';
      const left = rw ? ncrLeft(ctx, ncr) : 0;
      const rework = stock ? RRS.q.qty(ctx.state, { code: i.code, wh: i.wh, bin: i.bin || '', lot: i.lot || '', status: 'REWORK' }) : left;
      if (ncr && ncr.status === 'CLOSED') notes.push(h.note(`NCR ${ncr.ncrNo} ปิดแล้ว – ไม่ต้องตรวจซ้ำ`, 'info'));
      else if (rw && left > 0 && rework > 0) acts.push(h.btn(`ตรวจซ้ำหลังแก้ไข (เหลือ ${h.fmt.num(left)} ${unit})`, { act: 'reFrom', arg: i.id, tone: 'primary', id: 'ins-re-btn' }));
      else if (rw && !left) notes.push(h.note(t`ตรวจซ้ำครบจำนวนของ ${K.ncrLink(ncr.ncrNo)} แล้ว – ปิด NCR ได้ที่หน้า NCR`, 'info'));
      else if (rw) notes.push(h.note(`ไม่มีของ "รอแก้ไข" ของ ${i.code} ที่ ${K.loc(i)} ให้ตรวจซ้ำ – ตรวจสอบว่าของถูกย้ายหรือตัดยอดไปแล้วหรือไม่`, 'warn'));
      else if (ncr && ncr.status === 'DISPOSITIONED') notes.push(h.note(t`${K.ncrLink(ncr.ncrNo)} ตัดสินเป็น "${Q.DISPOSITIONS[ncr.disposition] || ncr.disposition}" แล้ว – ไม่ต้องตรวจซ้ำ`, 'info'));
      else if (ncr && ncr.status === 'OPEN') {
        notes.push(h.note(t`${stock ? `ของ ${h.fmt.num(i.qty)} ${unit} กักกันอยู่ ` : ''}รอหัวหน้า QC/วิศวกรรมตัดสิน ${K.ncrLink(ncr.ncrNo)} – ถ้าตัดสินให้แก้ไขงาน จะตรวจซ้ำได้หลังแก้`, 'warn'));
      }
    }
    if (i.status === 'VOID') {
      notes.push(h.note(`ผลนี้เป็นโมฆะ (${i.voidReason || 'ต้องตรวจใหม่'}) โดย ${K.who(ctx, i.voidedBy, i.voidedAt)} – ของกลับไปต้องตรวจใหม่ ผลนี้ใช้ปล่อยผ่านไม่ได้`, 'warn'));
      const still = stock ? RRS.q.qty(ctx.state, { code: i.code, wh: i.wh, bin: i.bin || '', lot: i.lot || '', status: i.fromStatus }) : 0;
      if (still > 0 && ctx.can('qc.inspect', i.wh)) acts.push(h.btn('ตรวจใหม่', { act: 'redo', arg: i.id, tone: 'ghost' }));
    }
    const re = RRS.q.rows(ctx.state, 'inspections', (x) => x.reinspectionOf === i.id).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const stored = (i.photos || []).filter((p) => K.imgSrc(p.url));
    const local = previews.get(i.id) || [];
    const names = (i.photos || []).filter((p) => !K.imgSrc(p.url)).map((p) => p.name);
    const photoBox = stored.length || local.length || names.length
      ? t`<div class="form-actions">${stored.map((p) => thumb(p.url, p.name))}${local.map((p) => thumb(p.src, p.name))}</div>
        ${names.length && !local.length ? t`<p class="hint">รูปที่บันทึกไว้เฉพาะชื่อ: ${names.join(', ')} (ไฟล์รูปเก็บได้เมื่อใช้เซิร์ฟเวอร์)</p>` : ''}`
      : t`<p class="hint">ไม่มีรูปหลักฐาน</p>`;
    return h.section(t`${h.code(i.id)} ${K.stage(i.stage)} · ${i.code}`, t`${notes}
      ${h.dl([
        ['ผล', resultBadge(i.result)], ['สถานะ', inspBadge(i)],
        ['สินค้า', t`${h.code(i.code)} ${it.name || ''}`], ['ล็อต', i.lot ? K.lotLink(i.code, i.lot) : ''],
        ['ตำแหน่ง', i.wh ? K.loc(i) : 'ระหว่างผลิต (ไม่มีของในคลัง)'], ['จำนวนที่ตรวจ', h.qty(i.qty, unit)],
        stock ? ['สถานะของก่อนตรวจ', STATUS_LABEL[i.fromStatus] || i.fromStatus] : null,
        ['เอกสารต้นทาง', i.sourceDoc ? K.docLink(i.sourceDoc) : ''], ['ใบงาน', i.jobNo ? K.jobLink(i.jobNo) : ''],
        ['แผนตรวจ', t`${K.planLink(i.planId)} แบบฉบับ ${i.planRev || '-'}`], ['อ้างอิงแบบ/WI', i.sourceRef],
        ['ผู้ตรวจ', K.who(ctx, i.inspector, i.at)],
        i.reinspectionOf ? ['ตรวจซ้ำของ', K.inspLink(i.reinspectionOf)] : null,
        i.reinspectionNcr ? ['ตาม NCR', K.ncrLink(i.reinspectionNcr)] : null,
        i.revChanged ? ['ฉบับแบบ', h.badge('แบบเปลี่ยนจากผลเดิม – ตรวจตามแผนฉบับปัจจุบัน', 'warn')] : null,
        i.ncrNo ? ['NCR ที่เปิด', t`${K.ncrLink(i.ncrNo)}${i.qsDocNo ? t` · กักกัน ${K.docLink(i.qsDocNo)}` : ''}`] : null,
        i.releasedQty ? ['ปล่อยผ่านแล้ว', `${h.fmt.num(i.releasedQty)} / ${h.fmt.num(i.qty)} ${unit}`] : null,
        i.note ? ['หมายเหตุ', i.note] : null,
      ])}
      <h3>ผลแต่ละหัวข้อ</h3>
      ${h.table({ rows: i.results || [], dense: true, cols: [
        { label: 'หัวข้อตรวจ', key: 'name' }, { label: 'ค่าที่วัด / ผล', get: (r) => (r.kind === 'measure' ? `${fmtN(r.value)}${r.unit ? ' ' + r.unit : ''}` : String(r.value)) },
        { label: 'เกณฑ์', get: (r) => rangeText(r) }, { label: 'ผล', render: (r) => (r.ok ? h.badge('ผ่าน', 'ok') : h.badge('ไม่ผ่าน', 'bad')) }] })}
      <h3>รูปหลักฐาน</h3>${photoBox}
      ${(i.releases || []).length ? t`<h3>การปล่อยผ่าน</h3>${h.table({ rows: i.releases, dense: true, cols: [
        { label: 'เวลา', get: (r) => h.fmt.dt(r.at) }, { label: 'ผู้อนุมัติ', get: (r) => ctx.userName(r.by) }, { label: 'จำนวน', num: true, key: 'qty' },
        { label: 'เอกสาร', render: (r) => K.docLink(r.docNo) }] })}` : ''}
      ${re.length ? t`<h3>ตรวจซ้ำ</h3>${h.table({ rows: re, dense: true, cols: [
        { label: 'ผลตรวจ', render: (x) => K.inspLink(x.id) }, { label: 'ตรวจเมื่อ', get: (x) => h.fmt.dt(x.at) }, { label: 'ผล', render: (x) => resultBadge(x.result) },
        { label: 'สถานะ', render: (x) => inspBadge(x) }] })}` : ''}
      ${acts.length ? t`<div class="form-actions">${acts}</div>` : ''}`, {
      id: 'ins-detail', actions: h.btn('ปิด', { act: 'close', tone: 'quiet', small: true }),
    });
  }

  function kpis(ctx, qq) {
    const items = ctx.state.tables.items || {};
    const hold = qq.balances.filter((b) => b.status === 'QC_HOLD');
    const fgHold = hold.filter((b) => isFinalItem(items[b.code]));
    const n = (s) => qq.balances.filter((b) => b.status === s).length;
    return h.kpis([
      h.kpi('รอตรวจ', h.fmt.num(hold.length), 'ตำแหน่ง – ใช้/เบิกไม่ได้จนกว่าจะผ่าน QC', hold.length ? 'warn' : 'ok'),
      h.kpi('ผลิตเสร็จรอตรวจ', h.fmt.num(util.round(util.sum(fgHold, (b) => b.qty))), 'จำนวนรวม – ยังส่งมอบลูกค้าไม่ได้', fgHold.length ? 'bad' : ''),
      h.kpi('ผ่านแล้วรอปล่อย', h.fmt.num(qq.inspections.length), 'ผลตรวจรอหัวหน้า QC อนุมัติ', qq.inspections.length ? 'warn' : ''),
      h.kpi('กักกัน', h.fmt.num(n('QUARANTINE')), 'ตำแหน่ง – ดำเนินการตาม NCR', n('QUARANTINE') ? 'bad' : ''),
      h.kpi('รอแก้ไข', h.fmt.num(n('REWORK')), 'ตำแหน่ง – แก้แล้วตรวจซ้ำ', n('REWORK') ? 'info' : ''),
    ]);
  }

  /** Open the inspection form. From the queue the open result closes (keep = true when started from that result). */
  function startFrom(ctx, patch, keep) {
    const p = { ins: Object.assign({ stage: 'INCOMING', fromStatus: 'QC_HOLD', res: {}, photos: [] }, patch), insErr: null, _scroll: true };
    if (!keep) p.sel = null;
    ctx.set(p);
  }

  RRS.ui.page({
    id: 'inspections', title: 'ตรวจ QC และปล่อยผ่าน', phase: 5, order: 30,
    sub: 'คิวของรอตรวจ / กักกัน / รอแก้ไข · บันทึกผลตามแผนที่อนุมัติพร้อมรูป · ผลผ่านต้องให้หัวหน้า QC อีกคนปล่อยผ่านก่อนใช้หรือส่งมอบ',
    badge: (ctx) => RRS.q.rows(ctx.state, 'inspections', (i) => i.status === 'OPEN').length || '',
    render(ctx) {
      const v = ctx.view;
      const tab = v.tab === 'release' || v.tab === 'all' ? v.tab : 'queue';
      const qq = Q.qcQueue(ctx.state, ctx.today);
      const sel = v.sel ? RRS.q.get(ctx.state, 'inspections', v.sel) : null;
      const body = tab === 'release' ? releaseView(ctx, qq) : tab === 'all' ? allView(ctx) : queueView(ctx, qq);
      return t`${h.note(RULE, 'warn')}${kpis(ctx, qq)}
        ${v.ins && ctx.can('qc.inspect') ? insForm(ctx) : ''}${sel ? detail(ctx, sel) : ''}
        ${h.tabs([{ id: 'queue', label: 'คิวตรวจ', count: qq.balances.length }, { id: 'release', label: 'รอปล่อยผ่าน', count: qq.inspections.length },
          { id: 'all', label: 'ผลตรวจทั้งหมด', count: RRS.q.rows(ctx.state, 'inspections').length }], tab)}
        ${body}
        <datalist id="dl-p5-jobs">${Array.from(new Set(RRS.q.rows(ctx.state, 'jobs').map((j) => j.jobNo))).slice(0, 500).map((j) => t`<option value="${j}"></option>`)}</datalist>`;
    },
    after(ctx, root0) {
      K.scrollTo(ctx, root0, ctx.view.ins ? 'ins-form' : 'ins-detail');
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg, limit: STEP }),
      pick: (ctx, el) => ctx.set({ sel: el.dataset.arg, _scroll: true }),
      close: (ctx) => ctx.set({ sel: null }),
      more: (ctx) => ctx.set({ limit: (ctx.view.limit || STEP) + STEP }),
      clear: (ctx) => ctx.set({ q: '', st: '' }),
      filter(ctx, el) {
        const patch = { limit: STEP };
        patch[el.name] = el.value;
        ctx.set(patch);
      },
      startBlank: (ctx) => startFrom(ctx, {}),
      startInProcess: (ctx) => startFrom(ctx, { stage: 'IN_PROCESS', fromStatus: '' }),
      startIns(ctx, el) {
        const b = (ctx.state.tables.balances || {})[el.dataset.arg];
        if (!b) return ctx.toast('ตำแหน่งนี้ไม่มีของรอตรวจแล้ว – อาจมีคนตรวจหรือย้ายไปก่อน', 'warn');
        const it = ctx.item(b.code);
        const doc = lastInbound(ctx.state, b);
        const stage = doc ? (doc.type === 'FR' ? 'FINAL' : 'INCOMING') : it && it.qcFinal && !it.qcIncoming ? 'FINAL' : 'INCOMING';
        const left = Math.max(0, util.round(b.qty - pendingAt(ctx.state, b, b.status)));
        startFrom(ctx, { stage, code: b.code, wh: b.wh, bin: b.bin, lot: b.lot, qty: left, fromStatus: 'QC_HOLD', sourceDoc: doc ? doc.docNo : '',
          jobNo: doc ? doc.job || '' : '' });
      },
      startRe(ctx, el) {
        const b = (ctx.state.tables.balances || {})[el.dataset.arg];
        if (!b) return ctx.toast('ตำแหน่งนี้ไม่มีของรอแก้ไขแล้ว', 'warn');
        const ncr = RRS.q.rows(ctx.state, 'ncrs', (n) => n.stockHeld && n.disposition === 'REWORK' && n.status === 'DISPOSITIONED' && sameLoc(n, b))
          .sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)))[0];
        const orig = ncr && ncr.inspectionId ? RRS.q.get(ctx.state, 'inspections', ncr.inspectionId) : null;
        const left = Math.max(0, util.round(b.qty - pendingAt(ctx.state, b, 'REWORK')));
        startFrom(ctx, { stage: (orig && orig.stage) || ncr && ncr.stage || 'INCOMING', code: b.code, wh: b.wh, bin: b.bin, lot: b.lot, qty: left, fromStatus: 'REWORK',
          reinspectionOf: ncr ? (orig ? orig.id : ncr.ncrNo) : '', jobNo: (ncr && ncr.jobNo) || '', sourceDoc: '' });
      },
      reFrom(ctx, el) {
        const i = RRS.q.get(ctx.state, 'inspections', el.dataset.arg);
        if (!i) return;
        const stock = !!STOCK_STAGES[i.stage];
        const rework = stock ? RRS.q.qty(ctx.state, { code: i.code, wh: i.wh, bin: i.bin || '', lot: i.lot || '', status: 'REWORK' }) : i.qty;
        // no more than the NCR still waits to re-inspect
        const left = i.ncrNo ? ncrLeft(ctx, RRS.q.get(ctx.state, 'ncrs', i.ncrNo)) : i.qty;
        startFrom(ctx, { stage: i.stage, code: i.code, wh: i.wh, bin: i.bin, lot: i.lot, qty: Math.min(left, rework) || left || i.qty, fromStatus: stock ? 'REWORK' : '',
          reinspectionOf: i.id, jobNo: i.jobNo, sourceDoc: '' }, true);
      },
      redo(ctx, el) {
        const i = RRS.q.get(ctx.state, 'inspections', el.dataset.arg);
        if (!i) return;
        startFrom(ctx, { stage: i.stage, code: i.code, wh: i.wh, bin: i.bin, lot: i.lot, qty: i.qty, fromStatus: i.fromStatus || 'QC_HOLD', sourceDoc: i.sourceDoc,
          jobNo: i.jobNo, reinspectionOf: i.reinspectionOf }, true);
      },
      insClose: (ctx) => ctx.set({ ins: null, insErr: null }),
      insField(ctx) {
        const vals = formValues();
        const prev = ctx.view.ins || {};
        const next = mergeIns(ctx, vals);
        // results belong to the characteristics of one plan: another item or stage (another plan) starts them empty,
        // so a measurement of the previous item is never saved against this one
        if (planKey(ctx, prev) !== planKey(ctx, next)) next.res = {};
        ctx.set({ ins: next });
      },
      async insPhoto(ctx, el) {
        const files = Array.from(el.files || []);
        if (!files.length) return;
        const vals = formValues();
        const photos = ((ctx.view.ins || {}).photos || []).slice();
        for (const f of files) {
          if (photos.length >= MAX_PHOTOS) {
            ctx.toast(`แนบรูปได้ไม่เกิน ${MAX_PHOTOS} รูปต่อผลตรวจ`, 'warn');
            break;
          }
          try {
            const up = await ctx.uploadFile(f);
            const inline = /^data:/i.test(up.url || '');
            photos.push({ name: String(up.name || f.name || 'รูป').slice(0, 120), url: inline ? '' : up.url, preview: up.url });
          } catch (e) {
            ctx.toast(`แนบรูป ${f.name} ไม่ได้: ${(e && e.message) || e}`, 'bad');
          }
        }
        ctx.set({ ins: mergeIns(ctx, vals, { photos }) });
      },
      insPhotoDel(ctx, el) {
        const vals = formValues();
        const photos = ((ctx.view.ins || {}).photos || []).filter((_, i) => i !== Number(el.dataset.arg));
        ctx.set({ ins: mergeIns(ctx, vals, { photos }) });
      },
      async release(ctx, el) {
        const i = RRS.q.get(ctx.state, 'inspections', el.dataset.arg);
        if (!i) return;
        const why = Q.releaseCheck(ctx.state, i.id, K.me(ctx));
        if (why.length) return ctx.toast(why[0].message, 'warn');
        const it = ctx.item(i.code) || {};
        const unit = it.baseUnit || '';
        const left = util.round(i.qty - (i.releasedQty || 0));
        const stock = !!STOCK_STAGES[i.stage];
        await ctx.dialog({
          title: `ปล่อยผ่าน ${i.id}`, submit: stock ? 'ปล่อยผ่าน – ให้ใช้ได้' : 'อนุมัติผลตรวจ',
          body: t`<div class="wide">${h.dl([['สินค้า', t`${h.code(i.code)} ${it.name || ''}`], ['ล็อต', i.lot], ['ตำแหน่ง', i.wh ? K.loc(i) : 'ระหว่างผลิต'],
            ['ผู้ตรวจ', K.who(ctx, i.inspector, i.at)], ['แผน / ฉบับแบบ', `${i.planId} · ${i.planRev || '-'}`]])}</div>
            ${stock ? h.field({ name: 'qty', label: `จำนวนที่ปล่อย (${unit})`, type: 'number', value: left, required: true, wide: true, id: 'rel-qty',
              hint: `ปล่อยได้ไม่เกิน ${h.fmt.num(left)} – ปล่อยบางส่วนได้ ที่เหลือยังรอปล่อย` }) : ''}
            <p class="hint wide">${stock ? `ของจะเปลี่ยนจาก "${STATUS_LABEL[i.fromStatus] || 'รอตรวจ'}" เป็น "ใช้ได้" ทันที (บันทึกเป็นเอกสารเปลี่ยนสถานะ QS) แล้วเบิกหรือส่งมอบได้` : 'ผลตรวจระหว่างผลิตไม่มีของในคลัง – บันทึกการอนุมัติอย่างเดียว'}</p>`,
          onSubmit(vals) {
            // an empty box would let the engine release everything that is left – the person must say how much
            if (stock && !util.trim(vals.qty)) return { ok: false, errors: [{ message: `ใส่จำนวนที่ปล่อย (ไม่เกิน ${h.fmt.num(left)} ${unit})` }] };
            return ctx.exec('qc.release', stock ? { id: i.id, qty: vals.qty } : { id: i.id }, { quiet: true,
              done: (r) => `ปล่อยผ่าน ${i.id} แล้ว${stock ? ` – ${h.fmt.num(r.result.qty)} ${unit} ใช้ได้${r.result.docNo ? ' (' + r.result.docNo + ')' : ''}${r.result.done ? '' : ' · ที่เหลือยังรอปล่อย'}` : ''}` });
          },
        });
      },
      async voidInsp(ctx, el) {
        const i = RRS.q.get(ctx.state, 'inspections', el.dataset.arg);
        if (!i) return;
        const unit = (ctx.item(i.code) || {}).baseUnit || '';
        const left = util.round(i.qty - (i.releasedQty || 0));
        await ctx.dialog({
          title: `ยกเลิกผลตรวจ ${i.id}`, submit: 'ยกเลิกผลตรวจนี้', danger: true,
          message: `ใช้เมื่อบันทึกผลผิด – ผลนี้จะเป็นโมฆะ ประวัติยังอยู่ ${STOCK_STAGES[i.stage] && left > 0 ? `ของ ${h.fmt.num(left)} ${unit} ยังเป็น "${STATUS_LABEL[i.fromStatus] || 'รอตรวจ'}" และต้องตรวจใหม่` : 'ต้องตรวจใหม่'}`,
          body: h.field({ name: 'reason', label: 'เหตุผล', type: 'textarea', required: true, wide: true, id: 'void-reason', placeholder: 'เช่น บันทึกค่าความหนาผิดช่อง' }),
          onSubmit: (vals) => ctx.exec('qc.void', { id: i.id, reason: vals.reason }, { quiet: true, done: () => `${i.id} เป็นโมฆะแล้ว – ตรวจใหม่จากคิวตรวจ` }),
        });
      },
      async csv(ctx) {
        const out = [['เลขที่', 'ตรวจเมื่อ', 'ขั้นตอน', 'รหัสสินค้า', 'ล็อต', 'คลัง', 'ช่องเก็บ', 'จำนวน', 'ผล', 'สถานะ', 'ผู้ตรวจ', 'แผน', 'ฉบับแบบ', 'เอกสารต้นทาง',
          'ใบงาน', 'NCR', 'ตรวจซ้ำของ', 'ปล่อยแล้ว', 'ผลแต่ละหัวข้อ']];
        for (const i of allRows(ctx)) {
          out.push([i.id, h.fmt.dt(i.at), K.stage(i.stage), i.code, i.lot, i.wh, i.bin, i.qty, i.result === 'PASS' ? 'ผ่าน' : 'ไม่ผ่าน', Q.INSP_STATUS[i.status] || i.status,
            ctx.userName(i.inspector), i.planId, i.planRev, i.sourceDoc, i.jobNo, i.ncrNo, i.reinspectionOf, i.releasedQty || 0,
            (i.results || []).map((r) => `${r.name}=${r.value}${r.ok ? '' : ' (ไม่ผ่าน)'}`).join('; ')]);
        }
        await ctx.download(`inspections-${ctx.today}.csv`, h.csv(out));
      },
    },
    forms: {
      async ins(ctx, vals) {
        const e = mergeIns(ctx, vals);
        const stage = e.stage || 'INCOMING';
        const stock = !!STOCK_STAGES[stage];
        const it = ctx.item(e.code);
        const plan = it ? Q.planFor(ctx.state, it.id, stage) : null;
        if (!it) return ctx.set({ ins: e, insErr: { errors: [{ message: `ไม่พบรหัส ${util.trim(e.code) || '(ว่าง)'} ในทะเบียนสินค้า – เลือกจากรายการ` }] } });
        if (!plan) return ctx.set({ ins: e, insErr: { errors: [{ message: `ยังไม่มีแผนตรวจที่อนุมัติของ ${it.id} ขั้นตอน${Q.STAGES[stage]} – ทำแผนและให้อีกคนอนุมัติก่อน` }] } });
        const payload = {
          stage, code: e.code, wh: e.wh || '', bin: e.bin || '', lot: e.lot || '', qty: e.qty, sourceDoc: e.sourceDoc || '', jobNo: e.jobNo || '',
          planId: plan.id, reinspectionOf: e.reinspectionOf || '', note: e.note || '',
          results: plan.chars.map((c) => ({ char: c.id, value: (e.res || {})[c.id] == null ? '' : e.res[c.id] })),
          photos: (e.photos || []).map((p) => ({ name: p.name, url: p.url || '' })),
        };
        if (stock) payload.fromStatus = e.fromStatus || 'QC_HOLD';
        const chk = ctx.check('qc.inspect', payload);
        if (!chk.ok) return ctx.set({ ins: e, insErr: chk });
        const fail = chk.result && chk.result.result === 'FAIL';
        const unit = it.baseUnit || '';
        const ok = await ctx.confirm({
          title: fail ? 'บันทึกผล ไม่ผ่าน' : 'บันทึกผล ผ่าน', danger: fail,
          ok: fail ? 'บันทึกผลไม่ผ่านและเปิด NCR' : 'บันทึกผลผ่าน',
          message: fail
            ? `${it.id} ${h.fmt.num(e.qty)} ${unit}: ระบบเปิด NCR${stock ? ' และเปลี่ยนของจำนวนนี้เป็น "กักกัน" (เบิก/ส่งมอบไม่ได้)' : ''} – หัวหน้า QC ตัดสินต่อที่หน้า NCR`
            : `${it.id} ${h.fmt.num(e.qty)} ${unit}: ผลผ่านจะรอหัวหน้า QC ที่ไม่ใช่คุณกดปล่อยผ่าน${stock ? ' – ระหว่างนี้ของยังใช้ไม่ได้' : ''}`,
        });
        if (!ok) return ctx.set({ ins: e });
        const r = await ctx.exec('qc.inspect', payload, { quiet: true,
          done: (x) => (x.result.result === 'FAIL' ? `บันทึก ${x.result.id} ไม่ผ่าน – เปิด ${x.result.ncrNo}` : `บันทึก ${x.result.id} ผ่าน – รอหัวหน้า QC ปล่อยผ่าน`) });
        if (!r.ok) return ctx.set({ ins: e, insErr: r });
        const local = (e.photos || []).filter((p) => !p.url && p.preview).map((p) => ({ name: p.name, src: p.preview }));
        if (local.length) previews.set(r.result.id, local);
        ctx.set({ ins: null, insErr: null, sel: r.result.id, _scroll: true });
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
