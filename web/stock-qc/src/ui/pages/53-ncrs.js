/*
 * Phase 5 – ของไม่เป็นไปตามข้อกำหนด (NCR) (RRS.quality: ncr.open, ncr.disposition, ncr.close, qcQueue).
 * NCRs open by themselves when an inspection fails (the quantity is quarantined); ncr.open raises one for stock that is
 * already quarantined (e.g. a whole lot) so it can be returned or scrapped. A QC lead / engineering decides:
 *   REWORK     กักกัน → รอแก้ไข, then a re-inspection that points at the NCR (close after it)
 *   RETURN     the engine posts a return to the supplier (RV) from QUARANTINE
 *   SCRAP      the engine posts a scrap document (SC) from QUARANTINE
 *   USE_AS_IS  กักกัน → ใช้ได้ with conditions – ncr.useAsIs (QC lead), not the inspector nor whoever opened the NCR
 * Every decision keeps who / when / why and the document it made; the NCR is closed afterwards.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const { util } = RRS;
  const Q = RRS.quality;
  const K = RRS.ui.qcKit;
  if (!Q || !K) {
    RRS.ui.page({ id: 'ncrs', title: 'ของไม่เป็นไปตามข้อกำหนด (NCR)', phase: 5, order: 40,
      render: () => h.empty('ยังไม่ได้เปิดใช้โมดูลคุณภาพ', 'หน้านี้ใช้ได้เมื่อระบบโหลดโมดูล Phase 5 (quality) แล้ว') });
    return;
  }

  const STEP = 300;
  const STATUS_TONE = { OPEN: 'bad', DISPOSITIONED: 'warn', CLOSED: 'ok' };
  const DISP_TONE = { REWORK: 'info', RETURN: 'accent', SCRAP: 'bad', USE_AS_IS: 'warn' };
  const TABS = { open: 'OPEN', disp: 'DISPOSITIONED', closed: 'CLOSED' };
  const RULES = 'ตัดสินได้ 4 แบบ: แก้ไขงาน (ของไป "รอแก้ไข" แล้ว QC ตรวจซ้ำ) · คืนผู้ขาย (ระบบออกใบคืน RV) · ตัดทิ้ง (ระบบออกใบตัดทิ้ง SC) · ' +
    'ยอมรับแบบมีเงื่อนไข (ของกลับเป็น "ใช้ได้" – เฉพาะหัวหน้า QC ที่ไม่ใช่ผู้ตรวจหรือผู้เปิด NCR และต้องระบุเงื่อนไข) · ทุกการตัดสินต้องมีเหตุผล ระบบบันทึกผู้ตัดสินและเวลา · ' +
    'ของใน NCR ที่ยังไม่ตัดสินออกจากกักกันทางอื่นไม่ได้';

  const ncrBadge = (n) => h.badge(Q.NCR_STATUS[n.status] || n.status, STATUS_TONE[n.status]);
  const dispBadge = (d) => (d ? h.badge(Q.DISPOSITIONS[d] || d, DISP_TONE[d]) : '');
  const ageOf = (ctx, n) => (n.createdAt ? util.daysBetween(util.bkkDate(n.createdAt), ctx.today) : null);
  const typeName = (type) => ((RRS.inventory.DOC_TYPES[type] || {}).name || '');

  function ncrRows(ctx) {
    const v = ctx.view;
    const tab = v.tab || 'open';
    const q = util.ckey(v.q);
    return RRS.q.rows(ctx.state, 'ncrs', (n) => (tab === 'all' || n.status === TABS[tab])
      && (!q || [n.ncrNo, n.code, n.lot, n.defect, n.inspectionId, n.jobNo, n.docNo, (ctx.item(n.code) || {}).name].some((x) => util.ckey(x).indexOf(q) >= 0)))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.ncrNo.localeCompare(a.ncrNo));
  }
  /** Quarantined stock that no open NCR holds yet (can be raised with ncr.open) – worked out once per state. */
  let heldMemo = { state: null, seq: -1, today: '', rows: [] };
  function heldRows(ctx) {
    // the ledger updates its state object in place: the commit number tells whether anything changed
    if (heldMemo.state === ctx.state && heldMemo.seq === ctx.state.seq && heldMemo.today === ctx.today) return heldMemo.rows;
    const rows = Q.qcQueue(ctx.state, ctx.today).balances.filter((b) => b.status === 'QUARANTINE' && util.round(b.qty - b.ncrHeld) > 0)
      .map((b) => Object.assign({ free: util.round(b.qty - b.ncrHeld) }, b));
    heldMemo = { state: ctx.state, seq: ctx.state.seq, today: ctx.today, rows };
    return rows;
  }
  /** Quantity of a REWORK NCR already re-inspected (PASS or FAIL; void results do not count) – the engine closes at qty. */
  function reinspected(ctx, n) {
    return util.round(util.sum(RRS.q.rows(ctx.state, 'inspections', (x) => x.reinspectionNcr === n.ncrNo && x.status !== 'VOID'), (x) => x.qty));
  }
  /** The person who opened the NCR (the inspector of a failed result) does not decide it (separation of duties). */
  const ownNcr = (ctx, n) => K.sodOn(ctx.state) && !!n.createdBy && n.createdBy === K.me(ctx);
  /** What happened to the stock of the NCR, in the words of the store. */
  function stockText(ctx, n, unit) {
    if (!n.stockHeld) return 'ไม่มีของในคลัง (พบระหว่างผลิต)';
    const q = `${h.fmt.num(n.qty)} ${unit}`;
    if (n.status === 'OPEN') return `กักกันอยู่ ${q} – ใช้ เบิก หรือส่งมอบไม่ได้จนกว่าจะตัดสิน`;
    if (n.disposition === 'REWORK') {
      const left = Math.max(0, util.round(n.qty - reinspected(ctx, n)));
      return left ? `รอแก้ไข ${h.fmt.num(left)} ${unit} – แก้แล้วให้ QC ตรวจซ้ำ` : `ตรวจซ้ำครบ ${q} แล้ว (ผลผ่านต้องให้หัวหน้า QC ปล่อยผ่านก่อนใช้)`;
    }
    if (n.disposition === 'RETURN') return `คืนผู้ขายแล้ว ${q}`;
    if (n.disposition === 'SCRAP') return `ตัดทิ้งแล้ว ${q}`;
    if (n.disposition === 'USE_AS_IS') return `กลับเป็น "ใช้ได้" ${q} ตามเงื่อนไข`;
    return '';
  }

  function listView(ctx) {
    const v = ctx.view;
    const limit = v.limit || STEP;
    const rows = ncrRows(ctx);
    const total = RRS.q.rows(ctx.state, 'ncrs').length;
    const tbl = h.table({ id: 'ncr-list', scroll: true, rows: rows.slice(0, limit), rowAct: 'pick', rowArg: (n) => n.ncrNo, rowCls: (n) => (n.ncrNo === v.sel ? 'sel' : ''),
      empty: total ? (v.q ? 'ไม่พบ NCR ตามคำค้น' : 'ไม่มี NCR ในแท็บนี้') : 'ยังไม่มี NCR',
      emptyText: total ? 'ลองแท็บอื่นหรือล้างคำค้น' : 'NCR เปิดอัตโนมัติเมื่อผลตรวจ QC ไม่ผ่าน (ของจำนวนนั้นถูกกักกัน) หรือเปิดเองจากของที่กักกันอยู่ในแท็บ ของกักกันที่ยังไม่มี NCR',
      cols: [
        { label: 'เลขที่', render: (n) => t`${h.code(n.ncrNo)}<br><small class="muted">${h.fmt.dt(n.createdAt)}</small>` },
        { label: 'สินค้า', render: (n) => t`${h.code(n.code)}${n.lot ? t`<br><small class="muted">ล็อต ${n.lot}</small>` : ''}` },
        { label: 'ตำแหน่ง', get: (n) => (n.wh ? K.loc(n) : 'ระหว่างผลิต') },
        { label: 'จำนวน', num: true, render: (n) => h.qty(n.qty, (ctx.item(n.code) || {}).baseUnit) },
        { label: 'ข้อบกพร่อง', get: (n) => (String(n.defect || '').length > 80 ? String(n.defect).slice(0, 80) + '…' : n.defect) },
        { label: 'ที่มา', render: (n) => (n.inspectionId ? h.code(n.inspectionId) : t`<small class="muted">เปิดจากของกักกัน</small>`) },
        { label: 'สถานะ', render: (n) => t`${ncrBadge(n)}${n.disposition ? t`<br>${dispBadge(n.disposition)}` : ''}` },
        { label: 'อายุ', num: true, render: (n) => {
          const d = ageOf(ctx, n);
          return n.status === 'OPEN' && d > 3 ? h.badge(K.age(d), 'warn') : K.age(d);
        } },
      ] });
    const more = rows.length > limit ? t`<p class="hint">แสดง ${h.fmt.num(limit)} จาก ${h.fmt.num(rows.length)} ${h.btn('แสดงเพิ่ม', { act: 'more', tone: 'ghost', small: true })}</p>` : '';
    return t`${h.toolbar([h.field({ name: 'q', label: 'ค้นหา', value: v.q, placeholder: 'เลขที่ NCR รหัส ล็อต ข้อบกพร่อง ใบงาน…', id: 'ncr-q', act: 'filter', live: true })],
      rows.length ? h.btn('ดาวน์โหลด CSV', { act: 'csv', tone: 'ghost' }) : '')}<div>${tbl}${more}</div>`;
  }

  function heldView(ctx) {
    const rows = heldRows(ctx);
    const canOpen = (wh) => ctx.can('qc.inspect', wh);
    return t`${h.note('ของที่กักกันอยู่แต่ยังไม่มี NCR (เช่น กักกันทั้งล็อต) – เปิด NCR เพื่อให้หัวหน้า QC ตัดสินคืนผู้ขาย ตัดทิ้ง แก้ไข หรือยอมรับแบบมีเงื่อนไข · ถ้าปัญหาของล็อตหมดไปแล้ว ให้ปลดกักกันที่หน้าล็อตแทน (ของกลับไปรอตรวจ)', 'info')}
      ${h.table({ id: 'ncr-held', scroll: true, rows, empty: 'ไม่มีของกักกันที่ยังไม่มี NCR', emptyText: 'ของกักกันทุกตำแหน่งอยู่ใน NCR แล้ว หรือไม่มีของกักกัน',
        cols: [
          { label: 'สินค้า', render: (b) => t`${h.code(b.code)}<br><small class="muted">${b.name}</small>` },
          { label: 'ตำแหน่ง', render: (b) => h.code(K.loc(b)) },
          { label: 'ล็อต', render: (b) => (b.lot ? t`${K.lotLink(b.code, b.lot)}${b.lotStatus === 'QUARANTINED' ? t`<br>${h.badge('กักกันทั้งล็อต', 'bad')}` : ''}` : K.dash) },
          { label: 'กักกันอยู่', num: true, render: (b) => h.qty(b.qty, b.unit) },
          { label: 'ยังไม่มี NCR', num: true, render: (b) => t`<b>${h.fmt.num(b.free)}</b>` },
          { label: 'อายุ', num: true, get: (b) => K.age(b.ageDays) },
          { label: '', render: (b) => (canOpen(b.wh) ? h.btn('เปิด NCR', { act: 'openNcr', arg: RRS.balanceKey(b), small: true, tone: 'primary' }) : t`<small class="muted">QC เป็นผู้เปิด</small>`) },
        ] })}`;
  }

  function useAsIsBlock(ctx, n) {
    const me = K.me(ctx);
    if (!ctx.can('ncr.useAsIs')) return 'ต้องเป็นหัวหน้า QC (สิทธิ์อนุมัติใช้ตามสภาพ)';
    if (!K.sodOn(ctx.state)) return '';
    const insp = n.inspectionId ? RRS.q.get(ctx.state, 'inspections', n.inspectionId) : null;
    if (insp && insp.inspector === me) return 'คุณเป็นผู้ตรวจที่พบปัญหานี้ – ให้หัวหน้า QC คนอื่นอนุมัติ';
    if (n.createdBy === me) return 'คุณเป็นผู้เปิด NCR นี้ – ให้หัวหน้า QC คนอื่นอนุมัติ';
    return '';
  }

  function detail(ctx, n) {
    const it = ctx.item(n.code) || {};
    const unit = it.baseUnit || '';
    const insp = n.inspectionId ? RRS.q.get(ctx.state, 'inspections', n.inspectionId) : null;
    const lot = n.lot ? RRS.q.get(ctx.state, 'lots', n.code + '|' + n.lot) : null;
    const acts = [];
    const notes = [];
    const canDisp = ctx.can('ncr.disposition', n.wh || undefined);
    if (n.status === 'OPEN') {
      const own = ownNcr(ctx, n);
      if (canDisp) {
        acts.push(h.btn('ตัดสิน NCR', { act: 'decide', tone: 'primary', id: 'ncr-decide-btn', disabled: own,
          title: own ? 'คุณเป็นผู้เปิด NCR นี้ – ผู้ตัดสินต้องเป็นคนละคน' : 'เลือกแก้ไข คืนผู้ขาย ตัดทิ้ง หรือยอมรับแบบมีเงื่อนไข' }));
        if (own) notes.push(h.note(`คุณเป็นผู้เปิด ${n.ncrNo}${n.inspectionId ? ' (ผู้ตรวจที่พบปัญหา)' : ''} – ผู้ตัดสินต้องเป็นคนละคน (แยกหน้าที่) ให้หัวหน้า QC หรือวิศวกรรมคนอื่นตัดสิน`, 'warn'));
      } else notes.push(h.note('รอหัวหน้า QC หรือวิศวกรรมตัดสิน – ระหว่างนี้ของยังกักกัน ใช้ เบิก หรือส่งมอบไม่ได้', 'warn'));
    }
    if (n.status === 'DISPOSITIONED') {
      const done = n.disposition === 'REWORK' ? reinspected(ctx, n) : 0;
      const needRe = n.disposition === 'REWORK' && done < util.round(n.qty);
      if (needRe) {
        const rework = n.stockHeld ? RRS.q.qty(ctx.state, { code: n.code, wh: n.wh, bin: n.bin || '', lot: n.lot || '', status: 'REWORK' }) : 0;
        notes.push(h.note(t`ตัดสินให้แก้ไขงานแล้ว – แก้เสร็จให้ QC ตรวจซ้ำ (อ้าง ${n.ncrNo}) ให้ครบ ${h.fmt.num(n.qty)} ${unit} ก่อนจึงปิด NCR ได้ · ตรวจซ้ำแล้ว ${h.fmt.num(done)} จาก ${h.fmt.num(n.qty)}${rework ? t` · ${h.link('ไปตรวจซ้ำ (คิวรอแก้ไข)', 'inspections', { tab: 'queue', st: 'REWORK', sel: null })}` : ''}`, 'info'));
      }
      if (canDisp) acts.push(h.btn('ปิด NCR', { act: 'closeNcr', tone: needRe ? 'ghost' : 'primary', disabled: needRe, id: 'ncr-close-btn', title: needRe ? `ต้องตรวจซ้ำให้ครบก่อนปิด (ตรวจแล้ว ${h.fmt.num(done)} จาก ${h.fmt.num(n.qty)})` : 'ปิดเมื่อดำเนินการตามการตัดสินครบแล้ว' }));
    }
    const re = n.reinspections || [];
    return h.section(t`${h.code(n.ncrNo)} ${it.name || n.code}`, t`${notes}
      ${h.dl([
        ['สถานะ', t`${ncrBadge(n)} ${dispBadge(n.disposition)}`],
        ['สินค้า', t`${h.code(n.code)} ${it.name || ''}`], ['ล็อต', n.lot ? K.lotLink(n.code, n.lot) : ''],
        ['ตำแหน่ง', n.wh ? K.loc(n) : 'ระหว่างผลิต'], ['จำนวน', h.qty(n.qty, unit)],
        ['ของในคลัง', stockText(ctx, n, unit)],
        ['ขั้นตอนที่พบ', n.stage ? K.stage(n.stage) : 'เปิดจากของกักกัน'],
        ['ผลตรวจที่พบ', n.inspectionId ? t`${K.inspLink(n.inspectionId)}${insp ? t` · ผู้ตรวจ ${ctx.userName(insp.inspector)}` : ''}` : ''],
        insp && insp.qsDocNo ? ['เอกสารกักกัน', K.docLink(insp.qsDocNo)] : null,
        ['ใบงาน', n.jobNo ? K.jobLink(n.jobNo) : ''], ['ผู้ขายของล็อต', lot ? K.supplierName(ctx.state, lot.supplier) : ''],
        ['ข้อบกพร่อง', n.defect], n.description ? ['รายละเอียด', n.description] : null,
        ['เปิดโดย', K.who(ctx, n.createdBy, n.createdAt)],
      ])}
      ${n.disposition ? t`<h3>การตัดสิน</h3>${h.dl([
        ['ตัดสิน', dispBadge(n.disposition)], ['ผู้ตัดสิน', K.who(ctx, n.dispositionBy, n.dispositionAt)], ['เหตุผล', n.reason],
        n.conditions ? ['เงื่อนไขการยอมรับ', n.conditions] : null,
        ['เอกสารที่ออกตามการตัดสิน', n.docNo ? t`${K.docLink(n.docNo)} <small class="muted">${n.docType} ${typeName(n.docType)}</small>` : 'ไม่มี (ไม่มีของต้องตัดยอด)'],
      ])}` : ''}
      ${re.length ? t`<h3>ตรวจซ้ำ</h3>${h.table({ rows: re, dense: true, cols: [
        { label: 'ผลตรวจ', render: (x) => K.inspLink(x.id) }, { label: 'เมื่อ', get: (x) => h.fmt.dt(x.at) }, { label: 'ผู้ตรวจ', get: (x) => ctx.userName(x.by) },
        { label: 'ผล', render: (x) => (x.result === 'PASS' ? h.badge('ผ่าน', 'ok') : h.badge('ไม่ผ่าน', 'bad')) }] })}` : ''}
      ${n.status === 'CLOSED' ? h.dl([['ปิดโดย', K.who(ctx, n.closedBy, n.closedAt)], ['บันทึกปิด', n.closeNote]]) : ''}
      ${acts.length ? t`<div class="form-actions">${acts}</div>` : ''}
      <h3>ประวัติ</h3>${K.histTable(ctx, n.history)}`, {
      id: 'ncr-detail', actions: h.btn('ปิดหน้าต่างนี้', { act: 'close', tone: 'quiet', small: true }),
    });
  }

  function kpis(ctx) {
    const all = RRS.q.rows(ctx.state, 'ncrs');
    const n = (s) => all.filter((x) => x.status === s).length;
    const held = heldRows(ctx);
    return h.kpis([
      h.kpi('รอตัดสิน', h.fmt.num(n('OPEN')), 'ของยังกักกันอยู่', n('OPEN') ? 'bad' : 'ok'),
      h.kpi('ตัดสินแล้ว รอปิด', h.fmt.num(n('DISPOSITIONED')), 'ทำตามการตัดสินแล้วปิด', n('DISPOSITIONED') ? 'warn' : ''),
      h.kpi('ปิดแล้ว', h.fmt.num(n('CLOSED')), 'ทั้งหมด'),
      h.kpi('ของกักกันที่ยังไม่มี NCR', h.fmt.num(held.length), 'ตำแหน่ง', held.length ? 'warn' : ''),
    ]);
  }

  RRS.ui.page({
    id: 'ncrs', title: 'ของไม่เป็นไปตามข้อกำหนด (NCR)', phase: 5, order: 40,
    sub: 'ของที่ตรวจไม่ผ่านหรือถูกกักกัน: ตัดสินแก้ไข / คืนผู้ขาย / ตัดทิ้ง / ยอมรับแบบมีเงื่อนไข พร้อมเหตุผล ผู้ตัดสิน และเอกสารที่ออก',
    badge: (ctx) => RRS.q.rows(ctx.state, 'ncrs', (n) => n.status === 'OPEN').length || '',
    render(ctx) {
      const v = ctx.view;
      const tab = v.tab === 'held' || v.tab === 'all' || TABS[v.tab] ? v.tab : 'open';
      const all = RRS.q.rows(ctx.state, 'ncrs');
      const n = (s) => all.filter((x) => x.status === s).length;
      const sel = v.sel ? RRS.q.get(ctx.state, 'ncrs', v.sel) : null;
      return t`${h.note(RULES, 'info')}${kpis(ctx)}${sel ? detail(ctx, sel) : ''}
        ${h.tabs([{ id: 'open', label: 'รอตัดสิน', count: n('OPEN') }, { id: 'disp', label: 'ตัดสินแล้ว รอปิด', count: n('DISPOSITIONED') },
          { id: 'closed', label: 'ปิดแล้ว', count: n('CLOSED') }, { id: 'all', label: 'ทั้งหมด', count: all.length },
          { id: 'held', label: 'ของกักกันที่ยังไม่มี NCR', count: heldRows(ctx).length }], tab)}
        ${tab === 'held' ? heldView(ctx) : listView(ctx)}`;
    },
    after(ctx, root0) {
      K.scrollTo(ctx, root0, 'ncr-detail');
    },
    actions: {
      tab: (ctx, el) => ctx.set({ tab: el.dataset.arg, limit: STEP }),
      pick: (ctx, el) => ctx.set({ sel: el.dataset.arg, _scroll: true }),
      close: (ctx) => ctx.set({ sel: null }),
      more: (ctx) => ctx.set({ limit: (ctx.view.limit || STEP) + STEP }),
      filter(ctx, el) {
        const patch = { limit: STEP };
        patch[el.name] = el.value;
        ctx.set(patch);
      },
      async decide(ctx) {
        const n = RRS.q.get(ctx.state, 'ncrs', ctx.view.sel);
        if (!n || n.status !== 'OPEN') return;
        const it = ctx.item(n.code) || {};
        const unit = it.baseUnit || '';
        const lot = n.lot ? RRS.q.get(ctx.state, 'lots', n.code + '|' + n.lot) : null;
        const q = `${h.fmt.num(n.qty)} ${unit}`;
        const opts = [
          { k: 'REWORK', what: n.stockHeld ? `ของ ${q} เปลี่ยนจาก "กักกัน" เป็น "รอแก้ไข" – แก้แล้ว QC ตรวจซ้ำอ้าง NCR นี้ ผ่านแล้วหัวหน้า QC ปล่อยผ่านจึงใช้ได้ · ปิด NCR ได้หลังตรวจซ้ำ`
            : 'แก้งานในสายผลิต แล้ว QC ตรวจซ้ำอ้าง NCR นี้ · ปิด NCR ได้หลังตรวจซ้ำ' },
          { k: 'RETURN', what: `ระบบออกใบคืนสินค้าผู้ขาย (RV) ตัดของกักกัน ${q} ออกจากคลัง${lot && lot.supplier ? ' คืน ' + K.supplierName(ctx.state, lot.supplier) : ''}${lot && lot.poNo ? ' อ้าง PO ' + lot.poNo : ''}`,
            off: n.stockHeld ? '' : 'ไม่มีของในคลัง (พบระหว่างผลิต) จึงคืนผู้ขายไม่ได้' },
          { k: 'SCRAP', what: n.stockHeld ? `ระบบออกใบตัดทิ้ง (SC) ตัดของกักกัน ${q} ออกจากคลัง` : 'บันทึกว่าตัดทิ้ง (ไม่มีของในคลังให้ตัดยอด)' },
          { k: 'USE_AS_IS', what: `${n.stockHeld ? `ของ ${q} กลับเป็น "ใช้ได้"` : 'ยอมรับงาน'} พร้อมเงื่อนไขที่ระบุ${it.certRequired ? ' · ต้องมีใบรับรองวัสดุที่ตรวจแล้ว' : ''}${lot && lot.status === 'QUARANTINED' ? ' · ล็อตนี้กักกันทั้งล็อต ต้องปลดกักกันล็อตก่อน' : ''}`,
            off: useAsIsBlock(ctx, n) },
        ];
        // ask the engine about each decision with a placeholder reason (nothing is saved): what it would refuse is
        // disabled with its own reason – the lot quarantined, the certificate not checked, a count in progress …
        const probe = 'ตรวจสอบก่อนเลือก';
        for (const o of opts) {
          if (o.off) continue;
          const chk = ctx.check('ncr.disposition', { ncrNo: n.ncrNo, disposition: o.k, reason: probe, conditions: o.k === 'USE_AS_IS' ? probe : '' });
          if (!chk.ok && chk.errors && chk.errors.length) o.off = chk.errors[0].message;
        }
        await ctx.dialog({
          title: `ตัดสิน ${n.ncrNo}`, submit: 'บันทึกการตัดสิน', wide: true,
          body: t`<div class="wide">${h.dl([['สินค้า', t`${h.code(n.code)} ${it.name || ''}`], ['ล็อต', n.lot], ['ตำแหน่ง', n.wh ? K.loc(n) : 'ระหว่างผลิต'],
            ['จำนวน', q], ['ข้อบกพร่อง', n.defect]])}</div>
            <div class="wide"><p class="fld-l">การตัดสิน <b class="req">*</b></p><div class="checks" role="radiogroup" aria-label="การตัดสิน">${opts.map((o) => t`<label class="chk wide"><input type="radio" name="disposition" value="${o.k}"${h.safe(o.off ? ' disabled' : '')}> <span><b>${Q.DISPOSITIONS[o.k]}</b><br><small class="hint">${o.off ? 'เลือกไม่ได้: ' + o.off : o.what}</small></span></label>`)}</div></div>
            ${h.field({ name: 'reason', label: 'เหตุผลการตัดสิน', type: 'textarea', required: true, wide: true, id: 'disp-reason', placeholder: 'เช่น ผู้ขายยืนยันรับคืนตามใบรับประกัน' })}
            ${h.field({ name: 'conditions', label: 'เงื่อนไขการยอมรับ (เฉพาะ ยอมรับแบบมีเงื่อนไข)', type: 'textarea', wide: true, id: 'disp-cond', placeholder: 'เช่น ใช้กับงานภายในเท่านั้น / เจียรขอบก่อนประกอบ' })}`,
          onSubmit(vals) {
            const d = vals.disposition;
            if (!d) return { ok: false, errors: [{ message: 'เลือกการตัดสิน 1 แบบ' }] };
            if (d === 'USE_AS_IS' && util.trim(vals.conditions).length < 3) return { ok: false, errors: [{ message: 'ยอมรับแบบมีเงื่อนไขต้องระบุเงื่อนไข เช่น ใช้กับงานใด ต้องทำอะไรก่อนใช้' }] };
            const payload = { ncrNo: n.ncrNo, disposition: d, reason: vals.reason };
            if (d === 'USE_AS_IS') payload.conditions = vals.conditions;
            return ctx.exec('ncr.disposition', payload, { quiet: true,
              done: (r) => `ตัดสิน ${n.ncrNo}: ${Q.DISPOSITIONS[d]}${r.result.docNo ? ' – ออกเอกสาร ' + r.result.docNo : ''}` });
          },
        });
      },
      async closeNcr(ctx) {
        const n = RRS.q.get(ctx.state, 'ncrs', ctx.view.sel);
        if (!n) return;
        await ctx.dialog({
          title: `ปิด ${n.ncrNo}`, submit: 'ปิด NCR',
          message: `ยืนยันว่าดำเนินการตามการตัดสิน (${Q.DISPOSITIONS[n.disposition] || ''}) ครบแล้ว – ปิดแล้วแก้ไม่ได้ และเอกสาร${n.docNo ? ' ' + n.docNo : ''}ที่ออกตามการตัดสินจะยกเลิกไม่ได้`,
          body: h.field({ name: 'note', label: 'บันทึกปิด', type: 'textarea', wide: true, id: 'close-note', placeholder: 'เช่น ผู้ขายรับคืนแล้ว ใบลดหนี้เลขที่ …' }),
          onSubmit: (vals) => ctx.exec('ncr.close', { ncrNo: n.ncrNo, note: vals.note }, { quiet: true, done: `ปิด ${n.ncrNo} แล้ว` }),
        });
      },
      async openNcr(ctx, el) {
        const b = (ctx.state.tables.balances || {})[el.dataset.arg];
        if (!b || b.status !== 'QUARANTINE') return ctx.toast('ตำแหน่งนี้ไม่มีของกักกันแล้ว – อาจมีคนดำเนินการไปก่อน', 'warn');
        const row = heldRows(ctx).find((x) => RRS.balanceKey(x) === el.dataset.arg);
        const free = row ? row.free : b.qty;
        const it = ctx.item(b.code) || {};
        const unit = it.baseUnit || '';
        const lot = b.lot ? RRS.q.get(ctx.state, 'lots', b.code + '|' + b.lot) : null;
        const r = await ctx.dialog({
          title: `เปิด NCR ของกักกัน ${b.code}`, submit: 'เปิด NCR',
          body: t`<div class="wide">${h.dl([['สินค้า', t`${h.code(b.code)} ${it.name || ''}`], ['ตำแหน่ง', K.loc(b)], ['ล็อต', b.lot],
            ['ยังไม่มี NCR', `${h.fmt.num(free)} ${unit}`], lot && lot.quarantineReason ? ['เหตุผลที่กักกันล็อต', lot.quarantineReason] : null])}</div>
            ${h.field({ name: 'qty', label: `จำนวน (${unit})`, type: 'number', value: free, required: true, id: 'open-qty', hint: `ไม่เกิน ${h.fmt.num(free)}` })}
            ${h.field({ name: 'jobNo', label: 'ใบงาน (ถ้ามี)', id: 'open-job' })}
            ${h.field({ name: 'defect', label: 'ข้อบกพร่อง', required: true, wide: true, id: 'open-defect', value: lot && lot.status === 'QUARANTINED' ? lot.quarantineReason : '', placeholder: 'เช่น ใบรับรองไม่ตรงกับ Heat' })}
            ${h.field({ name: 'description', label: 'รายละเอียด', type: 'textarea', wide: true, id: 'open-desc' })}`,
          onSubmit: (vals) => ctx.exec('ncr.open', { code: b.code, wh: b.wh, bin: b.bin, lot: b.lot, qty: vals.qty, defect: vals.defect, description: vals.description, jobNo: vals.jobNo },
            { quiet: true, done: (x) => `เปิด ${x.result.ncrNo} แล้ว – รอหัวหน้า QC ตัดสิน` }),
        });
        if (r && r.ok) ctx.set({ sel: r.result.ncrNo, tab: 'open', _scroll: true });
      },
      async csv(ctx) {
        const out = [['เลขที่ NCR', 'เปิดเมื่อ', 'รหัสสินค้า', 'ล็อต', 'คลัง', 'ช่องเก็บ', 'จำนวน', 'ขั้นตอน', 'ผลตรวจที่พบ', 'ใบงาน', 'ข้อบกพร่อง', 'สถานะ', 'การตัดสิน',
          'ผู้ตัดสิน', 'ตัดสินเมื่อ', 'เหตุผล', 'เงื่อนไข', 'เอกสาร', 'ปิดเมื่อ']];
        for (const n of ncrRows(ctx)) {
          out.push([n.ncrNo, h.fmt.dt(n.createdAt), n.code, n.lot, n.wh, n.bin, n.qty, n.stage ? K.stage(n.stage) : '', n.inspectionId, n.jobNo, n.defect,
            Q.NCR_STATUS[n.status] || n.status, Q.DISPOSITIONS[n.disposition] || '', n.dispositionBy ? ctx.userName(n.dispositionBy) : '',
            n.dispositionAt ? h.fmt.dt(n.dispositionAt) : '', n.reason, n.conditions, n.docNo, n.closedAt ? h.fmt.dt(n.closedAt) : '']);
        }
        await ctx.download(`ncr-${ctx.today}.csv`, h.csv(out));
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
