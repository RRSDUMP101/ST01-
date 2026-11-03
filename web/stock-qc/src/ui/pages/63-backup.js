/*
 * Phase 6 – สำรองและกู้คืน.
 *   ดาวน์โหลดไฟล์สำรอง   every commit (ctx.loadCommits) as one JSON file with its count and the hash of the last commit
 *   ตรวจไฟล์สำรอง        pick a JSON backup → RRS.reports.verifyBackup replays it from the start in memory (hashes, sequence,
 *                        chain, balances = Σ history) and the result is compared with this system (same history up to
 *                        that point, or newer data here); the result is recorded with backup.recordTest. Nothing is
 *                        restored over the live data from this page.
 *   Google Drive          server mode only: GET /api/backup/status and POST /api/backup/run (404 → ยังไม่ได้ตั้งค่า)
 *   แผนย้อนกลับ          how to stop using the system safely: disable, keep the data, never restore an old backup over newer data.
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const U = RRS.util;
  const R = () => RRS.reports || null;

  const dash = t`<span class="muted">–</span>`;
  const short = (hash) => (hash ? String(hash).slice(0, 16) + '…' : '');
  const RUN_STATUS = { ok: ['สำเร็จ', 'ok'], running: ['กำลังสำรอง', 'info'], failed: ['ไม่สำเร็จ', 'bad'], error: ['ไม่สำเร็จ', 'bad'], expired: ['หยุดกลางทาง', 'bad'] };
  const TRIGGER = { manual: 'สั่งเอง', scheduled: 'ตามเวลา' };
  const FORMAT = 'rrs-stockqc-backup';
  const whoCan = () => RRS.auth.rolesFor('backup.export').filter((r) => r !== 'admin').map((r) => RRS.auth.ROLES[r] || r).join(' / ');
  const maxDays = (state) => {
    const s = RRS.q.get(state, 'settings', 'main') || {};
    return Number((s.policies || {}).backupTestMaxDays) || 30;
  };
  const tableLabel = (name) => (RRS.schema.tables[name] ? RRS.schema.tables[name].label : name);
  const bytes = (n) => (n >= 1048576 ? `${h.fmt.num(n / 1048576, 1)} MB` : `${h.fmt.num(Math.max(1, Math.round((n || 0) / 1024)))} KB`);

  /** Compare a verified backup with this system: same history up to its last commit? (async: older files need the commit list). */
  async function compareLive(ctx, res) {
    const live = { seq: ctx.state.seq, head: ctx.state.head };
    if (res.commits > live.seq) {
      return { match: false, other: true, text: `ไฟล์มี ${h.fmt.num(res.commits)} รายการ มากกว่าระบบนี้ (${h.fmt.num(live.seq)}) – เป็นข้อมูลของระบบอื่น หรือระบบนี้ถูกเริ่มใหม่ ห้ามกู้ทับ` };
    }
    if (res.commits === live.seq) {
      if (res.head !== live.head) return { match: false, other: true, text: 'ลายนิ้วมือรายการสุดท้ายไม่ตรงกับระบบนี้ที่ลำดับเดียวกัน – เป็นข้อมูลของระบบอื่น' };
      if (res.fingerprint && R().fingerprint(ctx.state) !== res.fingerprint) return { match: false, text: 'ข้อมูลที่กู้ได้ไม่ตรงกับข้อมูลในระบบนี้' };
      return { match: true, text: 'ตรงกับข้อมูลในระบบนี้ทุกตาราง (ล่าสุด)' };
    }
    let commits = null;
    try {
      commits = await ctx.loadCommits();
    } catch (e) {
      commits = null;
    }
    const at = commits && commits.find((c) => c.seq === res.commits);
    if (!at) return { match: null, text: `ระบบนี้อยู่ที่ลำดับ ${h.fmt.num(live.seq)} – อ่านประวัติเพื่อเทียบย้อนหลังไม่ได้` };
    if (at.hash !== res.head) return { match: false, text: `ไฟล์ไม่ตรงกับประวัติของระบบนี้ที่ลำดับ ${h.fmt.num(res.commits)} – เป็นข้อมูลของระบบอื่น` };
    return { match: true, older: true, text: `ตรงกับระบบนี้ถึงลำดับ ${h.fmt.num(res.commits)} · ระบบมีรายการใหม่กว่าไฟล์อีก ${h.fmt.num(live.seq - res.commits)} รายการ (ไฟล์นี้เก่ากว่าข้อมูลปัจจุบัน – ใช้กู้ได้ แต่ข้อมูลหลังจากนั้นจะไม่มี)` };
  }

  function checkView(ctx, c) {
    if (!c) return h.empty('ยังไม่ได้ตรวจไฟล์', 'เลือกไฟล์สำรอง (.json) ที่ดาวน์โหลดไว้ แล้วกด ตรวจไฟล์สำรอง – ระบบเล่นซ้ำทุกรายการตั้งแต่ต้นในหน่วยความจำ ตรวจลายนิ้วมือ ลำดับ และยอดคงเหลือ ไม่เขียนทับข้อมูลจริง');
    const ok = c.ok;
    const head = ok
      ? h.note(t`<b>ไฟล์นี้ใช้กู้ข้อมูลได้</b> – ${h.fmt.num(c.commits)} รายการ ลายนิ้วมือครบ ลำดับต่อเนื่อง และยอดคงเหลือตรงกับประวัติ${c.live && c.live.text ? ` · ${c.live.text}` : ''}`, 'ok')
      : h.note(t`<b>ไฟล์นี้ใช้กู้ข้อมูลไม่ได้</b> – ${h.errors({ errors: c.problems.map((p) => ({ message: p })) })}`, 'bad');
    const tables = Object.keys(c.tables || {}).filter((k) => c.tables[k]).map((k) => ({ name: k, label: tableLabel(k), n: c.tables[k] }));
    const canRecord = ctx.can('backup.export');
    const other = c.live && c.live.other;
    return t`${head}
      ${h.dl([['ไฟล์', c.name], ['ขนาด', bytes(c.size)], ['จำนวนรายการ (commit)', h.fmt.num(c.commits)], ['ลายนิ้วมือรายการสุดท้าย', h.code(short(c.head))],
        ['ลายนิ้วมือข้อมูลที่กู้ได้', c.fingerprint ? h.code(short(c.fingerprint)) : '–'], ['ตรวจเมื่อ', h.fmt.dt(c.at)],
        c.exportedAt ? ['สำรองเมื่อ (ตามไฟล์)', h.fmt.dt(c.exportedAt)] : null])}
      ${tables.length ? t`<details><summary>จำนวนแถวที่กู้ได้ต่อตาราง (${tables.length} ตาราง)</summary>${h.table({ dense: true, scroll: true, rows: tables,
        cols: [{ label: 'ตาราง', key: 'label' }, { label: 'ชื่อในระบบ', render: (x) => h.code(x.name) }, { label: 'แถว', num: true, key: 'n' }] })}</details>` : ''}
      <div class="form-actions">${other ? h.note('ไม่บันทึกผลทดสอบ เพราะไฟล์นี้ไม่ใช่ข้อมูลของระบบนี้', 'warn')
        : c.recorded ? h.note(t`บันทึกผลการตรวจครั้งนี้แล้ว (${h.code(c.recorded)}) – ตรวจไฟล์ใหม่เพื่อบันทึกอีกครั้ง`, 'ok')
        : canRecord ? h.btn(ok ? 'บันทึกผลทดสอบกู้คืน (ผ่าน)' : 'บันทึกผลทดสอบกู้คืน (ไม่ผ่าน)', { act: 'recordTest', tone: ok ? 'primary' : 'danger', id: 'bk-record' })
          : t`<span class="hint">บันทึกผลทดสอบได้เฉพาะ ${whoCan()}</span>`}</div>`;
  }

  // ---- Google Drive (server) ------------------------------------------------------------------------------------------------
  const owner = (ctx) => !!(ctx.server && RRS.app && RRS.app.session && RRS.app.session.owner);
  function googleLink(value, kind) {
    if (typeof value !== 'string') return '';
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
      if (kind === 'folder' && url.hostname === 'drive.google.com' && /^\/drive\/folders\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return url.href;
      if (kind === 'sheet' && url.hostname === 'docs.google.com' && /^\/spreadsheets\/d\/[A-Za-z0-9_-]+(?:\/.*)?$/.test(url.pathname)) return url.href;
      if (kind === 'authorize' && url.hostname === 'accounts.google.com' && /^\/o\/oauth2\/(?:v2\/)?auth$/.test(url.pathname)) return url.href;
    } catch (e) { /* Do not render or navigate an unrecognized provider URL. */ }
    return '';
  }
  function googleReturn(ctx) {
    if (!ctx.server || !root.location || !root.history) return false;
    const url = new URL(root.location.href);
    const outcome = url.searchParams.get('google');
    const messages = {
      connected: 'กลับจาก Google แล้ว · ตรวจสถานะการเชื่อมต่อด้านล่างก่อนสำรองข้อมูล',
      denied: 'ยังไม่ได้เชื่อมบัญชี Google เนื่องจากไม่ได้อนุญาตสิทธิ์ ลองเชื่อมใหม่ได้เมื่อพร้อม',
      failed: 'เชื่อมบัญชี Google ไม่สำเร็จ กรุณาลองอีกครั้ง',
    };
    if (!Object.prototype.hasOwnProperty.call(messages, outcome)) return false;
    url.searchParams.delete('google');
    root.history.replaceState(root.history.state, '', url.pathname + url.search + url.hash);
    ctx.set({ driveConnectNotice: messages[outcome], driveConnectError: outcome !== 'connected', drive: null });
    return true;
  }
  function workbookLinks(run) {
    if (!run) return '';
    const sheet = run.spreadsheet || run.manifest && run.manifest.spreadsheet;
    const url = googleLink(sheet && sheet.url, 'sheet');
    return url ? t`<a class="lnk" href="${url}" target="_blank" rel="noopener noreferrer">${sheet.name || 'เปิด Google Sheets'}</a>` : '';
  }
  let driveLoading = false;
  async function loadDrive(ctx) {
    if (driveLoading) return;
    driveLoading = true;
    let r;
    try {
      r = await ctx.api('/backup/status');
    } catch (e) {
      r = { ok: false, errors: [{ code: 'NETWORK', message: 'ติดต่อเซิร์ฟเวอร์ไม่ได้ – ตรวจอินเทอร์เน็ตแล้วลองใหม่' }] };
    }
    driveLoading = false;
    ctx.set({ drive: { at: new Date().toISOString(), r } });
  }
  function driveView(ctx) {
    const v = ctx.view;
    const canRun = ctx.can('backup.export');
    if (!ctx.server) {
      return h.section('สำรองอัตโนมัติไป Google Drive', t`${h.note('ใช้ได้เมื่อเปิดระบบผ่านเซิร์ฟเวอร์ (Cloudflare) ของบริษัท – ตอนนี้ยังไม่ได้เชื่อมเซิร์ฟเวอร์ จึงยังไม่มีการสำรองอัตโนมัติ', 'info')}
        <p class="hint">ระหว่างนี้ให้ ${canRun ? 'กด ดาวน์โหลดไฟล์สำรอง' : `${whoCan()} ดาวน์โหลดไฟล์สำรอง`} แล้วเก็บไฟล์ไว้นอกเครื่องนี้ (เช่น ไดรฟ์ของบริษัท) อย่างน้อยสัปดาห์ละครั้ง และทุกครั้งก่อนเปลี่ยนแปลงใหญ่</p>
        ${ctx.mode === 'demo' ? h.note('ข้อมูลตัวอย่างอยู่ในเบราว์เซอร์นี้เท่านั้น – ล้างประวัติเบราว์เซอร์แล้วข้อมูลหาย', 'warn') : ''}`, { id: 'bk-drive' });
    }
    const d = v.drive;
    if (!d) return h.section('สำรองอัตโนมัติไป Google Drive', t`<div class="loading"><div class="spin" aria-hidden="true"></div><p>กำลังอ่านสถานะการสำรอง…</p></div>`, { id: 'bk-drive' });
    const r = d.r || {};
    const refresh = h.btn('ตรวจสถานะอีกครั้ง', { act: 'driveRefresh', tone: 'ghost', small: true });
    if (!r.ok) {
      const code = ((r.errors || [])[0] || {}).code || '';
      let body;
      if (code === 'HTTP_404') body = h.note(t`<b>ยังไม่ได้ตั้งค่า</b> – เซิร์ฟเวอร์ยังไม่มีส่วนสำรองข้อมูลไป Google Drive ให้ผู้ดูแลระบบติดตั้ง/เปิดใช้ก่อน · ระหว่างนี้ใช้ ดาวน์โหลดไฟล์สำรอง`, 'warn');
      else if (code === 'HTTP_403') body = h.note(`ดูสถานะได้เฉพาะเจ้าของระบบหรือ ${whoCan()}`, 'info');
      else body = h.note(`อ่านสถานะไม่ได้: ${r.message || ((r.errors || [])[0] || {}).message || 'ไม่ทราบสาเหตุ'} – กด ตรวจสถานะอีกครั้ง`, 'bad');
      return h.section('สำรองอัตโนมัติไป Google Drive', body, { id: 'bk-drive', actions: refresh });
    }
    const runs = r.runs || [];
    const last = r.lastOk;
    const ready = r.enabled && r.configured;
    const google = r.google || {};
    const connected = typeof google.connected === 'boolean' ? google.connected : r.configured;
    const connectBtn = owner(ctx) ? h.btn(v.driveConnectBusy ? 'กำลังเปิด Google…' : connected ? 'เชื่อมบัญชี Google ใหม่' : 'เชื่อมบัญชี Google',
      { act: 'driveConnect', tone: connected ? 'ghost' : 'primary', id: 'bk-google-connect', disabled: v.driveConnectBusy || google.configured === false,
        title: google.configured === false ? 'ให้ผู้ดูแลการติดตั้งตั้งค่าการเชื่อมต่อ Google ก่อน' : 'เลือกบัญชี Google สำหรับเก็บไฟล์สำรอง' }) : '';
    const connection = connected
      ? h.note('เชื่อมบัญชี Google แล้ว · ระบบจะสร้างโฟลเดอร์และไฟล์สำรองในบัญชีที่เชื่อมไว้', 'ok')
      : h.note(google.configured === false ? 'การเชื่อม Google ยังไม่พร้อม ให้ผู้ดูแลการติดตั้งตั้งค่าก่อน' : owner(ctx)
        ? 'ยังไม่ได้เชื่อมบัญชี Google · กด เชื่อมบัญชี Google แล้วเลือกบัญชีที่ต้องการเก็บข้อมูล'
        : 'ยังไม่ได้เชื่อมบัญชี Google · ให้เจ้าของระบบเชื่อมบัญชีก่อน', 'warn');
    const stateNote = !r.enabled
      ? h.note(t`<b>ยังไม่ได้เปิดสำรองอัตโนมัติ</b> – ให้ผู้ดูแลระบบเปิดใช้หลังเชื่อมบัญชี Google แล้ว`, 'warn')
      : !r.configured
        ? h.note(t`<b>ยังไม่พร้อมสำรองข้อมูล</b> – ${connected ? 'การตั้งค่าปลายทางยังไม่ครบ ให้ผู้ดูแลระบบตรวจสอบ' : 'เชื่อมบัญชี Google เพื่อให้ระบบเตรียมโฟลเดอร์ปลายทาง'}`, 'warn')
        : r.running ? h.note('กำลังสำรองข้อมูลอยู่ – รอสักครู่แล้วกด ตรวจสถานะอีกครั้ง', 'info')
          : h.note(t`เปิดใช้แล้ว – สำรองอัตโนมัติทุกวัน ${(r.schedule || {}).time || '03:00'} น. (เวลาไทย)`, 'ok');
    const folderUrl = googleLink(last && last.folderUrl, 'folder');
    const folder = folderUrl ? t`<a class="lnk" href="${folderUrl}" target="_blank" rel="noopener noreferrer">เปิดโฟลเดอร์ใน Google Drive</a>` : '';
    const sheets = r.nativeSheets || {};
    const sheetStatus = t`<div><label class="chk"><input type="checkbox" disabled${h.safe(sheets.enabled ? ' checked' : '')} aria-describedby="bk-sheets-help"> สร้างไฟล์ Google Sheets ในแต่ละรอบสำรอง</label>
      <p class="hint" id="bk-sheets-help">${sheets.enabled ? 'เปิดใช้แล้ว' : 'ยังไม่ได้เปิดใช้'} · ค่านี้กำหนดโดยผู้ดูแลระบบ</p></div>
      <p>Google Sheets เป็นสำเนาข้อมูล ณ เวลาที่สำรอง ใช้เปิดอ่านและตรวจสอบ การแก้ไขในชีตไม่ส่งกลับมาเปลี่ยนข้อมูล Nexus</p>
      <p class="hint">ระบบยังเก็บไฟล์ประวัติ JSONL และ manifest สำหรับตรวจสอบและกู้คืนข้อมูล การกู้คืนใช้ไฟล์สำรองเหล่านี้</p>`;
    const workbook = workbookLinks(v.driveRunResult) || workbookLinks(last);
    const facts = h.dl([
      ['สำรองสำเร็จล่าสุด', last ? `${h.fmt.dt(last.finishedAt || last.startedAt)} · ${h.fmt.num(last.commits)} รายการ` : 'ยังไม่เคยสำเร็จ'],
      ['ลายนิ้วมือของรอบล่าสุด', last && last.head ? h.code(short(last.head)) : '–'],
      ['ระบบตอนนี้', `${h.fmt.num(ctx.state.seq)} รายการ`],
      ['เวลาสำรองประจำวัน', `${(r.schedule || {}).time || '03:00'} น. · เวลาไทย (Asia/Bangkok)`],
      last && last.toSeq != null && last.toSeq < ctx.state.seq ? ['ยังไม่ได้สำรอง', `${h.fmt.num(ctx.state.seq - last.toSeq)} รายการใหม่`] : null,
      folder ? ['ที่เก็บ', folder] : null,
      workbook ? ['Google Sheets รอบล่าสุดที่มีลิงก์', workbook] : null,
    ]);
    const tbl = h.table({ dense: true, scroll: true, rows: runs, empty: 'ยังไม่มีรอบสำรอง', emptyText: ready ? 'กด สำรองตอนนี้ หรือรอรอบอัตโนมัติ' : 'ตั้งค่าให้ครบก่อน',
      rowCls: (x) => (x.status === 'ok' || x.status === 'running' ? '' : 'row-bad'),
      cols: [{ label: 'เริ่ม', get: (x) => h.fmt.dt(x.startedAt) }, { label: 'แบบ', get: (x) => TRIGGER[x.trigger] || x.trigger || '' },
        { label: 'ผล', render: (x) => h.badge((RUN_STATUS[x.status] || [x.status])[0], (RUN_STATUS[x.status] || [])[1] || 'muted') },
        { label: 'รายการ', num: true, key: 'commits' }, { label: 'ไฟล์ย่อย', num: true, key: 'parts' }, { label: 'ขนาด', num: true, get: (x) => (x.bytes ? bytes(x.bytes) : '') },
        { label: 'สั่งโดย', get: (x) => x.requestedBy || '' }, { label: 'Google Sheets', render: (x) => workbookLinks(x) || dash },
        { label: 'ข้อความ', get: (x) => x.message || '' }] });
    const runBtn = canRun ? h.btn(r.running ? 'กำลังสำรอง…' : 'สำรองตอนนี้', { act: 'driveRun', tone: 'primary', id: 'bk-drive-run', disabled: !ready || r.running || v.driveBusy,
      title: ready ? 'สำรองข้อมูลทั้งหมดไป Google Drive ทันที' : 'ยังไม่ได้ตั้งค่า Google Drive' }) : '';
    return h.section('สำรองอัตโนมัติไป Google Drive', t`${v.driveConnectNotice ? h.note(v.driveConnectNotice, v.driveConnectError ? 'warn' : 'info') : ''}
      ${connection}${stateNote}${sheetStatus}${facts}${tbl}`, { id: 'bk-drive', sub: `ตรวจเมื่อ ${h.fmt.dt(d.at)}`, actions: t`${connectBtn}${refresh}${runBtn}` });
  }

  const ROLLBACK = [
    ['ตัดสินใจหยุด', 'เจ้าของโครงการ (ผู้บริหาร) สั่งหยุดเมื่อพบปัญหาร้ายแรง เช่น ยอดคลาดเคลื่อน ตัดยอดซ้ำ หรือปล่อยของกักกัน ที่แก้ไม่ทันในวันนั้น – จดเหตุผลและเวลาที่หยุด'],
    ['ปิดการใช้งาน ไม่ลบข้อมูล', 'ประกาศให้ทุกคนหยุดบันทึกในระบบนี้ตั้งแต่เวลาที่ประกาศ แล้วกลับไปใช้วิธีเดิม (Express + ใบเบิก/ใบรับกระดาษ) · ปิดการเชื่อมอัตโนมัติ (Sales Office) · ห้ามลบข้อมูล ห้ามล้างฐานข้อมูล'],
    ['สำรองทันที', 'ดาวน์โหลดไฟล์สำรอง ณ เวลาที่หยุด ตรวจไฟล์ในหน้านี้ แล้วเก็บคู่กับรายงานยอดตามคลัง (รายงาน → ยอดตามคลัง → CSV) ไว้นอกเครื่อง'],
    ['ยอดบัญชียังอยู่ที่ Express', 'เอกสารที่บันทึกในระบบนี้แต่ยังไม่คีย์ Express ให้บัญชีคีย์ให้ครบ (หน้าเอกสาร แท็บ รอคีย์ Express) – Express เป็นยอดทางบัญชีตามข้อตกลงเดิม'],
    ['ห้ามกู้ไฟล์สำรองเก่าทับข้อมูลที่ใหม่กว่า', 'การกู้ข้อมูลทำในระบบใหม่ที่ว่างเท่านั้น แล้วตรวจลายนิ้วมือให้ตรงก่อนใช้ · ถ้ายอดผิดให้แก้ด้วยเอกสารปรับยอด/ยกเลิกในระบบเดิม ไม่ใช่กู้ไฟล์เก่าทับ'],
    ['กลับมาใช้อีกครั้ง', 'แก้สาเหตุ ทดสอบเกณฑ์ที่เกี่ยวข้องซ้ำ (UAT) ตรวจยอดประจำวันให้ผ่าน ตรวจนับคลังที่ได้รับผลกระทบ แล้วให้เจ้าของโครงการอนุมัติก่อนเปิดใช้'],
  ];

  RRS.ui.page({
    id: 'backup', title: 'สำรองและกู้คืน', phase: 6, order: 40,
    sub: 'ดาวน์โหลดข้อมูลทั้งหมดเป็นไฟล์ ตรวจว่าไฟล์ใช้กู้ได้จริง และบันทึกผลทดสอบกู้คืนเป็นหลักฐาน · หน้านี้ไม่กู้ข้อมูลทับระบบ',
    render(ctx) {
      if (!R() || typeof R().verifyBackup !== 'function') return h.empty('ยังเปิดหน้าสำรองข้อมูลไม่ได้', 'หน้านี้ต้องใช้โมดูลรายงาน (reports) ซึ่งยังไม่ได้โหลด – โหลดหน้าใหม่ หรือแจ้งผู้ดูแลระบบ');
      const v = ctx.view;
      const canExport = ctx.can('backup.export');
      const tests = RRS.q.rows(ctx.state, 'backup_tests').sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(b.id).localeCompare(String(a.id)));
      const last = tests[0];
      const age = last ? U.daysBetween(U.bkkDate(last.at), ctx.today) : null;
      const limit = maxDays(ctx.state);
      const lastOk = tests.find((x) => x.result === 'OK');
      const k = h.kpis([
        h.kpi('ข้อมูลในระบบ', h.fmt.num(ctx.state.seq), 'รายการ (commit) ที่ต้องสำรอง'),
        h.kpi('ทดสอบกู้คืนล่าสุด', last ? h.fmt.date(U.bkkDate(last.at)) : 'ยังไม่เคย', last ? `${last.result === 'OK' ? 'ผ่าน' : 'ไม่ผ่าน'} · ${h.fmt.num(age)} วันที่แล้ว` : 'ต้องทดสอบก่อนเริ่มใช้จริง',
          !last ? 'warn' : last.result !== 'OK' ? 'bad' : age > limit ? 'warn' : 'ok'),
        h.kpi('ผ่านล่าสุด', lastOk ? `${h.fmt.num(lastOk.commits)} รายการ` : '–', lastOk ? `เมื่อ ${h.fmt.date(U.bkkDate(lastOk.at))}` : `ควรทดสอบผ่านภายใน ${limit} วัน`),
      ]);
      const dl = h.section('1 · ดาวน์โหลดไฟล์สำรอง', canExport
        ? t`<p>ไฟล์เดียว (.json) มีทุกรายการตั้งแต่เริ่มระบบ ${h.fmt.num(ctx.state.seq)} รายการ ลายนิ้วมือล่าสุด ${h.code(short(ctx.state.head))} – เก็บไฟล์ไว้นอกเครื่องนี้ ไฟล์มีข้อมูลทั้งหมดของบริษัท ห้ามส่งให้คนนอก</p>
          <div class="form-actions">${h.btn('ดาวน์โหลดไฟล์สำรอง (JSON)', { act: 'download', tone: 'primary', id: 'bk-download', disabled: !ctx.state.seq })}</div>`
        : h.note(`ดาวน์โหลดไฟล์สำรองได้เฉพาะ ${whoCan()} (ไฟล์มีข้อมูลทั้งหมดของบริษัท)`, 'info'), { id: 'bk-dl' });
      const verify = h.section('2 · ตรวจไฟล์สำรอง (ทดสอบกู้คืน)', t`${h.form({ name: 'verify', submit: 'ตรวจไฟล์สำรอง', body: [
        h.field({ name: 'file', label: 'ไฟล์สำรอง (.json)', type: 'file', accept: '.json,application/json', wide: true, id: 'bk-file' }),
        t`<p class="hint wide">ระบบเล่นซ้ำทุกรายการจากไฟล์ตั้งแต่ต้นในหน่วยความจำ ตรวจลายนิ้วมือทุกรายการ ลำดับต่อเนื่อง และยอดคงเหลือ = ผลรวมประวัติ แล้วเทียบกับระบบนี้ – ไม่เขียนทับข้อมูลจริง</p>`] })}
        ${checkView(ctx, v.check)}`, { id: 'bk-verify' });
      const log = h.section('ผลทดสอบกู้คืนที่บันทึกไว้', h.table({ dense: true, scroll: true, rows: tests.slice(0, 100), id: 'bk-tests',
        empty: 'ยังไม่เคยบันทึกผลทดสอบกู้คืน', emptyText: 'ดาวน์โหลดไฟล์ → ตรวจไฟล์ → กด บันทึกผลทดสอบกู้คืน – ต้องมีผลผ่านก่อนขยายผลการใช้งาน',
        rowCls: (x) => (x.result === 'OK' ? '' : 'row-bad'),
        cols: [{ label: 'รหัส', render: (x) => h.code(x.id) }, { label: 'เมื่อ', get: (x) => h.fmt.dt(x.at) }, { label: 'ผู้ทดสอบ', get: (x) => ctx.userName(x.by) },
          { label: 'รายการในไฟล์', num: true, key: 'commits' }, { label: 'ลายนิ้วมือสุดท้าย', render: (x) => h.code(short(x.head)) },
          { label: 'ผล', render: (x) => h.badge(x.result === 'OK' ? 'ผ่าน' : 'ไม่ผ่าน', x.result === 'OK' ? 'ok' : 'bad') },
          { label: 'ปัญหา / หมายเหตุ', get: (x) => [(x.problems || []).join(' · '), x.note].filter(Boolean).join(' – ') }] }), { id: 'bk-log' });
      const plan = h.section('แผนย้อนกลับ (ถ้าต้องหยุดใช้ระบบนี้)', t`<div class="steps">${ROLLBACK.map(([title, text], i) => t`<div class="step"><span class="step-n">ขั้น ${i + 1}</span><b>${title}</b><span class="hint">${text}</span></div>`)}</div>`,
        { id: 'bk-plan', sub: 'ใช้เมื่อเจ้าของโครงการสั่งหยุด – เป้าหมายคือไม่มีข้อมูลหาย และไม่มียอดซ้ำ' });
      return t`${k}${dl}${verify}${log}${driveView(ctx)}${plan}`;
    },
    after(ctx) {
      if (googleReturn(ctx)) return;
      if (ctx.server && !ctx.view.drive) loadDrive(ctx);
    },
    actions: {
      async download(ctx) {
        if (!ctx.can('backup.export')) return ctx.toast(`ดาวน์โหลดไฟล์สำรองได้เฉพาะ ${whoCan()}`, 'warn');
        let commits;
        try {
          commits = await ctx.loadCommits();
        } catch (e) {
          return ctx.toast(`อ่านข้อมูลเพื่อสำรองไม่ได้: ${(e && e.message) || e} – ลองใหม่`, 'bad');
        }
        if (!commits.length) return ctx.toast('ยังไม่มีข้อมูลให้สำรอง', 'warn');
        const last = commits[commits.length - 1];
        const data = { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), exportedBy: ctx.user ? ctx.user.id : '', mode: ctx.mode,
          count: commits.length, seq: last.seq, head: last.hash, commits };
        const ok = await ctx.download(`rrs-stockqc-backup-${ctx.today}-${commits.length}.json`, JSON.stringify(data));
        ctx.toast(`ไฟล์สำรอง ${h.fmt.num(commits.length)} รายการ · ลายนิ้วมือสุดท้าย ${short(last.hash)}${ok ? '' : ' – ถ้ายังไม่ได้บันทึกไฟล์ ให้คัดลอกข้อความไปเก็บ'}`, 'info');
      },
      async recordTest(ctx) {
        const c = ctx.view.check;
        if (!c || c.recorded) return;
        const ok = c.ok;
        const res = await ctx.dialog({
          title: ok ? 'บันทึกผลทดสอบกู้คืน: ผ่าน' : 'บันทึกผลทดสอบกู้คืน: ไม่ผ่าน', submit: 'บันทึกผล', danger: !ok,
          body: t`<div class="wide">${h.dl([['ไฟล์', c.name], ['รายการในไฟล์', h.fmt.num(c.commits)], ['ลายนิ้วมือสุดท้าย', h.code(short(c.head))],
            ['ผล', h.badge(ok ? 'ผ่าน' : 'ไม่ผ่าน', ok ? 'ok' : 'bad')]])}</div>
            ${!ok ? t`<div class="wide">${h.errors({ errors: c.problems.map((p) => ({ message: p })) })}</div>` : ''}
            ${h.field({ name: 'note', label: 'หมายเหตุ (ที่เก็บไฟล์ / เครื่องที่ใช้ตรวจ)', type: 'textarea', rows: 2, wide: true, id: 'bk-note', placeholder: 'เช่น เก็บใน Google Drive บริษัท โฟลเดอร์ Backup ตรวจจากเครื่องบัญชี' })}
            <p class="hint wide">ผู้ทดสอบและเวลามาจากระบบ · ผลนี้ใช้เป็นหลักฐานว่ากู้ข้อมูลได้ก่อนขยายผล</p>`,
          onSubmit: (vals) => ctx.exec('backup.recordTest', { commits: c.commits, head: c.head, result: ok ? 'OK' : 'FAIL', fingerprint: c.fingerprint || '',
            problems: ok ? [] : c.problems, note: vals.note }, { quiet: true, done: (r) => `บันทึกผลทดสอบกู้คืน ${r.result.id} แล้ว` }),
        });
        // one check = one record: the same verification is not recorded twice
        if (res && res.ok && res.result && res.result.id && ctx.view.check === c) ctx.set({ check: Object.assign({}, c, { recorded: res.result.id }) });
      },
      driveRefresh(ctx) {
        ctx.set({ drive: null });
      },
      async driveConnect(ctx) {
        if (!owner(ctx) || ctx.view.driveConnectBusy) return;
        ctx.set({ driveConnectBusy: true, driveConnectNotice: '', driveConnectError: false });
        try {
          const r = await ctx.api('/backup/google/connect', {});
          const url = r.ok && googleLink(r.authorizationUrl, 'authorize');
          if (!url) {
            const message = r.message || ((r.errors || [])[0] || {}).message || 'เปิดการเชื่อมต่อ Google ไม่สำเร็จ กรุณาลองใหม่';
            ctx.set({ driveConnectNotice: message, driveConnectError: true });
            return;
          }
          root.location.assign(url);
        } catch (e) {
          ctx.set({ driveConnectNotice: 'ติดต่อระบบไม่ได้ กรุณาตรวจการเชื่อมต่อแล้วลองอีกครั้ง', driveConnectError: true });
        } finally {
          ctx.set({ driveConnectBusy: false });
        }
      },
      async driveRun(ctx) {
        if (!ctx.server || !ctx.can('backup.export') || ctx.view.driveBusy) return;
        const go = await ctx.confirm({ title: 'สำรองไป Google Drive ตอนนี้', message: `ส่งข้อมูลทั้งหมด ${h.fmt.num(ctx.state.seq)} รายการไปโฟลเดอร์สำรองของบริษัท (ใช้เวลาสักครู่)`, ok: 'สำรองตอนนี้' });
        if (!go) return;
        ctx.set({ driveBusy: true });
        let r;
        try {
          r = await ctx.api('/backup/run', {});
        } catch (e) {
          r = { ok: false, errors: [{ message: 'ติดต่อเซิร์ฟเวอร์ไม่ได้ – ตรวจอินเทอร์เน็ตแล้วลองใหม่' }] };
        }
        if (r.ok) ctx.toast(`สำรองไป Google Drive แล้ว${r.run ? ` · ${h.fmt.num(r.run.commits)} รายการ` : ''}`, 'ok');
        else if (((r.errors || [])[0] || {}).code === 'HTTP_404') ctx.toast('ยังไม่ได้ตั้งค่า – เซิร์ฟเวอร์ยังไม่มีส่วนสำรองข้อมูลไป Google Drive', 'warn');
        else ctx.toast(`สำรองไม่สำเร็จ: ${r.message || ((r.errors || [])[0] || {}).message || 'ไม่ทราบสาเหตุ'}`, 'bad');
        ctx.set({ driveBusy: false, drive: null, driveRunResult: r.ok && r.run || ctx.view.driveRunResult || null });
      },
    },
    forms: {
      async verify(ctx, vals, form) {
        const input = form.querySelector('#bk-file');
        const file = input && input.files && input.files[0];
        if (!file) return ctx.toast('เลือกไฟล์สำรอง (.json) ก่อนกด ตรวจไฟล์สำรอง', 'warn');
        let text;
        try {
          text = await file.text();
        } catch (e) {
          return ctx.toast('อ่านไฟล์ไม่ได้ – เลือกไฟล์ใหม่', 'bad');
        }
        let exportedAt = '';
        try {
          const j = JSON.parse(text);
          if (j && typeof j === 'object' && !Array.isArray(j) && typeof j.exportedAt === 'string') exportedAt = j.exportedAt;
        } catch (e) { /* verifyBackup reports the bad file */ }
        let res;
        try {
          res = R().verifyBackup(text);
        } catch (e) {
          res = { ok: false, commits: 0, head: '', problems: [`ตรวจไฟล์ไม่สำเร็จ: ${(e && e.message) || e}`], tables: {} };
        }
        const problems = (res.problems || []).slice();
        let live = null;
        if (res.ok) {
          live = await compareLive(ctx, res);
          if (live.match === false) problems.push(live.text);
        }
        ctx.set({ check: { name: file.name, size: file.size, at: new Date().toISOString(), exportedAt, ok: problems.length === 0, commits: res.commits || 0,
          head: res.head || '', fingerprint: res.fingerprint || '', problems, tables: res.tables || {}, live } });
        ctx.toast(problems.length ? `ไฟล์ ${file.name} ใช้กู้ข้อมูลไม่ได้ – ดูปัญหาที่พบ` : `ไฟล์ ${file.name} ใช้กู้ข้อมูลได้`, problems.length ? 'bad' : 'ok');
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
