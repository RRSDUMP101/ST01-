/* Phase 0 – item register: codes (main / Express / stock count), units with factors, tracking and QC flags. */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t } = h;
  const M = RRS.master;

  // Metadata is cached only for this signed-in browser session. Photo bytes remain in authenticated server storage.
  const photoCache = new Map();
  const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const PHOTO_MAX = 5 * 1024 * 1024;
  const icon = (name) => h.icon ? h.icon(name) : '';
  const photoKey = (ctx, code) => `${ctx.server ? 'server' : ctx.mode}:${ctx.account || ''}:${code}`;
  const photoState = (ctx, code) => {
    const key = photoKey(ctx, code);
    if (!photoCache.has(key)) photoCache.set(key, { code, photos: [], status: 'idle', selected: '', maxPhotos: 8, maxBytes: PHOTO_MAX });
    return photoCache.get(key);
  };
  const photoEditor = (ctx) => !!(ctx.server && (ctx.can('master.edit') || RRS.app && RRS.app.session && RRS.app.session.owner));
  function imageUrl(value) {
    if (typeof value !== 'string') return '';
    try {
      const origin = root.location && root.location.href || 'https://nexuspart-terminal.com/';
      const api = new URL(RRS.app && RRS.app.api || '/api', origin);
      const url = new URL(value, origin);
      const path = api.pathname.replace(/\/$/, '') + '/items/photos/';
      return url.origin === api.origin && !url.username && !url.password && url.pathname.startsWith(path)
        && /^[a-f0-9]{64}$/.test(url.pathname.slice(path.length)) ? url.href : '';
    } catch (e) { return ''; }
  }
  const photoPath = (code) => '/items/photos?code=' + encodeURIComponent(code);
  const photoError = (r) => r && (r.error || r.message || (r.errors || []).map((e) => e.message).join(' · ')) || 'จัดการรูปไม่สำเร็จ กรุณาลองอีกครั้ง';
  function photoImage(photo, label, cls) {
    const url = imageUrl(photo && photo.url);
    return t`<span class="product-photo ${cls || ''}">${url ? t`<img src="${url}" alt="${label}" loading="lazy" decoding="async" data-product-photo>` : ''}
      <span class="product-photo-placeholder"${h.safe(url ? ' hidden' : '')}>${icon('image')}<span>ไม่มีรูป</span></span></span>`;
  }
  function thumbnail(ctx, code, label) {
    const entry = photoState(ctx, code);
    const photo = ctx.server ? entry.photos.find((p) => p.primary) || entry.photos[0] || entry.thumbnail : null;
    return t`<span data-photo-thumb="${code}" data-photo-label="${label || code}">${photoImage(photo, label || code, 'product-thumb')}</span>`;
  }
  function galleryBody(ctx, code) {
    const entry = photoState(ctx, code);
    const item = RRS.q.get(ctx.state, 'items', code);
    const label = item && item.name || code;
    const photos = ctx.server ? entry.photos : [];
    const selected = photos.find((p) => p.id === entry.selected) || photos.find((p) => p.primary) || photos[0];
    const canEdit = photoEditor(ctx) && entry.canEdit !== false;
    const ready = entry.status === 'ready';
    return t`<div class="product-gallery-stage">${photoImage(selected, label, 'product-hero')}
      ${selected && selected.primary ? h.badge('รูปหลัก', 'ok') : ''}</div>
      ${photos.length ? t`<div class="product-photo-strip" aria-label="เลือกรูปสินค้า">${photos.map((p, i) => t`<button type="button" class="product-photo-choice${selected && p.id === selected.id ? ' on' : ''}" data-photo-action="select" data-photo-id="${p.id}" aria-label="ดูรูปที่ ${i + 1}${p.primary ? ' (รูปหลัก)' : ''}" aria-pressed="${selected && p.id === selected.id ? 'true' : 'false'}">${photoImage(p, `รูปที่ ${i + 1} ของ ${label}`, 'product-thumb')}${p.primary ? t`<span class="product-photo-star" aria-hidden="true">${icon('star')}</span>` : ''}</button>`)}</div>` : ''}
      ${selected ? t`<div class="product-photo-caption"><span>${selected.name || 'รูปสินค้า'}</span>${canEdit && !selected.primary ? t`<button type="button" class="btn btn-ghost btn-sm" data-photo-action="primary" data-photo-id="${selected.id}"${h.safe(entry.busy ? ' disabled' : '')}>${icon('star')} ใช้เป็นรูปหลัก</button>` : ''}</div>` : ''}
      <div role="status" aria-live="polite" class="product-photo-message">${entry.busy ? 'กำลังบันทึกรูป…' : entry.status === 'loading' ? 'กำลังโหลดรูปสินค้า…' : entry.notice || ''}</div>
      ${entry.error ? t`<div class="note n-warn" role="alert">${entry.error} <button type="button" class="btn btn-quiet btn-sm" data-photo-action="retry">ลองอีกครั้ง</button></div>` : ''}
      ${!ctx.server ? t`<p class="hint">เพิ่มรูปจริงได้เมื่อเปิดระบบออนไลน์ ข้อมูลทดลองไม่เก็บรูปสินค้า</p>` : canEdit ? t`
        <div class="product-photo-drop${entry.busy ? ' is-busy' : ''}" data-photo-drop aria-busy="${entry.busy ? 'true' : 'false'}">
          ${icon('upload')}<strong>${photos.length >= entry.maxPhotos ? `ครบ ${entry.maxPhotos} รูปแล้ว` : 'ลากรูปมาวางที่นี่'}</strong>
          <span class="hint">JPEG, PNG หรือ WebP · ไม่เกิน 5 MB ต่อรูป · สูงสุด ${entry.maxPhotos} รูป</span>
          <label class="btn btn-ghost product-photo-upload">เลือกไฟล์รูป<input type="file" data-photo-file accept="image/jpeg,image/png,image/webp" multiple${h.safe(!ready || entry.busy || photos.length >= entry.maxPhotos ? ' disabled' : '')} aria-label="เลือกรูปสินค้า"></label>
        </div>` : !photos.length && ready ? t`<p class="hint">สินค้านี้ยังไม่มีรูป ผู้ดูแลข้อมูลสินค้าสามารถเพิ่มรูปได้</p>` : ''}`;
  }
  function gallery(ctx, code) {
    if (!code || code === '__new') return t`<div class="product-new-photo">${icon('image')}<p>บันทึกสินค้าก่อน แล้วเพิ่มรูปจริงได้ที่นี่</p></div>`;
    return t`<div class="product-gallery" data-photo-gallery="${code}">${galleryBody(ctx, code)}</div>`;
  }
  function bindImageFallback(container) {
    for (const img of container.querySelectorAll('img[data-product-photo]')) img.addEventListener('error', () => {
      img.hidden = true;
      const placeholder = img.parentElement.querySelector('.product-photo-placeholder');
      if (placeholder) placeholder.hidden = false;
    }, { once: true });
  }
  function refreshPhotos(ctx, code) {
    if (RRS.app && RRS.app.account != null && RRS.app.account !== ctx.account) return;
    const main = root.document && root.document.querySelector('#main');
    if (!main) return;
    for (const box of main.querySelectorAll('[data-photo-gallery]')) if (box.dataset.photoGallery === code) {
      box.innerHTML = String(galleryBody(ctx, code)); bindGallery(ctx, box);
    }
    for (const box of main.querySelectorAll('[data-photo-thumb]')) if (box.dataset.photoThumb === code) {
      const entry = photoState(ctx, code);
      box.innerHTML = String(photoImage(entry.photos.find((p) => p.primary) || entry.photos[0] || entry.thumbnail, box.dataset.photoLabel || code, 'product-thumb'));
      bindImageFallback(box);
    }
  }
  async function loadPhotos(ctx, code, force) {
    if (!ctx.server) return;
    const entry = photoState(ctx, code);
    if (entry.status === 'loading' || !force && ['ready', 'error'].includes(entry.status)) return;
    entry.status = 'loading'; entry.error = ''; refreshPhotos(ctx, code);
    try {
      const r = await ctx.api(photoPath(code));
      if (!r.ok) throw new Error(photoError(r));
      entry.photos = (r.photos || []).filter((p) => p && imageUrl(p.url));
      entry.canEdit = r.canEdit; entry.maxPhotos = r.maxPhotos || 8; entry.maxBytes = r.maxBytes || PHOTO_MAX;
      entry.status = 'ready'; entry.thumbTried = true; entry.thumbnail = entry.photos.find((p) => p.primary) || entry.photos[0] || null;
    } catch (e) { entry.status = 'error'; entry.error = e.message || 'โหลดรูปไม่ได้ กรุณาลองอีกครั้ง'; }
    refreshPhotos(ctx, code);
  }
  async function uploadPhotos(ctx, code, files) {
    const entry = photoState(ctx, code);
    if (!photoEditor(ctx) || entry.canEdit === false || entry.busy || entry.status !== 'ready') return;
    const list = Array.from(files || []);
    if (!list.length) return;
    const bad = list.find((f) => !PHOTO_TYPES.includes(f.type) || !f.size || f.size > entry.maxBytes);
    if (bad) { entry.error = `${bad.name}: เลือก JPEG, PNG หรือ WebP ขนาดไม่เกิน 5 MB`; refreshPhotos(ctx, code); return; }
    if (entry.photos.length + list.length > entry.maxPhotos) { entry.error = `เพิ่มรูปได้อีก ${Math.max(0, entry.maxPhotos - entry.photos.length)} รูป`; refreshPhotos(ctx, code); return; }
    entry.busy = true; entry.error = ''; entry.notice = ''; refreshPhotos(ctx, code);
    let uploaded = 0;
    try {
      for (const file of list) {
        const body = new FormData(); body.append('file', file, file.name);
        const response = await fetch((RRS.app && RRS.app.api || '/api') + photoPath(code), { method: 'POST', credentials: 'same-origin', body });
        let r; try { r = await response.json(); } catch (e) { r = null; }
        if (!response.ok || !r || !r.ok) throw new Error(photoError(r));
        entry.photos = (r.photos || []).filter((p) => p && imageUrl(p.url));
        entry.selected = r.photo && r.photo.id || entry.selected;
        entry.thumbnail = entry.photos.find((p) => p.primary) || entry.photos[0] || null; uploaded++;
      }
      entry.notice = `เพิ่มรูปแล้ว ${uploaded} รูป`;
    } catch (e) { entry.error = `${uploaded ? `เพิ่มแล้ว ${uploaded} รูป · ` : ''}${e.message || 'อัปโหลดไม่สำเร็จ'} · ตรวจสถานะรูปก่อนลองอีกครั้ง`; }
    finally { entry.busy = false; refreshPhotos(ctx, code); }
  }
  async function primaryPhoto(ctx, code, id) {
    const entry = photoState(ctx, code);
    if (!photoEditor(ctx) || entry.canEdit === false || entry.busy || !entry.photos.some((p) => p.id === id)) return;
    entry.busy = true; entry.error = ''; refreshPhotos(ctx, code);
    try {
      const r = await ctx.api('/items/photos/primary?code=' + encodeURIComponent(code), { id });
      if (!r.ok) throw new Error(photoError(r));
      entry.photos = (r.photos || []).filter((p) => p && imageUrl(p.url));
      entry.thumbnail = entry.photos.find((p) => p.primary) || entry.photos[0] || null; entry.notice = 'เปลี่ยนรูปหลักแล้ว';
    } catch (e) { entry.error = e.message || 'เปลี่ยนรูปหลักไม่ได้'; }
    finally { entry.busy = false; refreshPhotos(ctx, code); }
  }
  function bindGallery(ctx, box) {
    const code = box.dataset.photoGallery;
    bindImageFallback(box);
    for (const button of box.querySelectorAll('[data-photo-action]')) button.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      if (button.dataset.photoAction === 'select') { photoState(ctx, code).selected = button.dataset.photoId; refreshPhotos(ctx, code); }
      if (button.dataset.photoAction === 'primary') primaryPhoto(ctx, code, button.dataset.photoId);
      if (button.dataset.photoAction === 'retry') loadPhotos(ctx, code, true);
    });
    const file = box.querySelector('[data-photo-file]');
    if (file) file.addEventListener('change', () => { const files = Array.from(file.files || []); file.value = ''; uploadPhotos(ctx, code, files); });
    const drop = box.querySelector('[data-photo-drop]');
    if (drop) {
      drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('drag-over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
      drop.addEventListener('drop', (ev) => { ev.preventDefault(); drop.classList.remove('drag-over'); uploadPhotos(ctx, code, ev.dataTransfer && ev.dataTransfer.files); });
    }
  }
  async function loadThumbnails(ctx, codes) {
    if (!ctx.server) return;
    const pending = [...new Set(codes)].filter((code) => !photoState(ctx, code).thumbTried && photoState(ctx, code).status !== 'loading');
    for (let i = 0; i < pending.length; i += 100) {
      const batch = pending.slice(i, i + 100);
      batch.forEach((code) => { photoState(ctx, code).thumbTried = true; });
      try {
        const r = await ctx.api('/items/photos/thumbnails?' + batch.map((code) => 'code=' + encodeURIComponent(code)).join('&'));
        if (!r.ok) continue;
        for (const item of r.items || []) if (batch.includes(item.itemId)) {
          const entry = photoState(ctx, item.itemId);
          if (entry.status !== 'ready') entry.thumbnail = item.photo && imageUrl(item.photo.url) ? item.photo : null;
          refreshPhotos(ctx, item.itemId);
        }
      } catch (e) { /* Table remains usable without photos; opening the product offers a retry. */ }
    }
  }
  function attachPhotos(ctx, root0) {
    bindImageFallback(root0);
    for (const box of root0.querySelectorAll('[data-photo-gallery]')) { bindGallery(ctx, box); loadPhotos(ctx, box.dataset.photoGallery); }
    loadThumbnails(ctx, Array.from(root0.querySelectorAll('[data-photo-thumb]')).map((box) => box.dataset.photoThumb)
      .filter((code) => !!RRS.q.get(ctx.state, 'items', code)));
  }
  RRS.ui.productPhotos = { thumbnail, gallery, after: attachPhotos, load: loadPhotos, upload: uploadPhotos, primary: primaryPhoto };

  const ALIASES = {
    code: ['รหัสสินค้า', 'รหัส', 'code', 'item code'], name: ['ชื่อสินค้า', 'ชื่อ', 'name', 'รายละเอียด'],
    baseUnit: ['หน่วยหลัก', 'หน่วย', 'unit'], type: ['ประเภท', 'type'], group: ['กลุ่ม', 'กลุ่มประกอบ', 'group'],
    expressCode: ['รหัสexpress', 'express code', 'express'], countCode: ['รหัสนับสต็อก', 'รหัสนับสต๊อค', 'count code'],
    model: ['รุ่น', 'รุ่นรถ', 'model'], side: ['ข้าง', 'side'], drawingNo: ['เลขที่แบบ', 'drawing'], drawingRev: ['ฉบับแบบ', 'rev'],
    trackLot: ['ติดตาม', 'track'], material: ['วัสดุ', 'material'], thickness: ['ความหนา', 'thickness'],
    width: ['กว้าง', 'width'], length: ['ยาว', 'length'], minQty: ['min'], maxQty: ['max'], unitCost: ['ราคาต่อหน่วย', 'cost'],
    qcIncoming: ['ตรวจรับ', 'qc incoming'], qcFinal: ['ตรวจเมื่อผลิตเสร็จ', 'qc final'], certRequired: ['ใบรับรอง', 'cert'],
  };
  const TEMPLATE = 'รหัสสินค้า,ชื่อสินค้า,หน่วยหลัก,ประเภท,กลุ่ม,รหัส Express,รหัสนับสต็อก,ติดตาม,ตรวจรับ,ตรวจเมื่อผลิตเสร็จ,Min,Max\n' +
    'DEMO-A-001,ตัวอย่าง ฝาข้าง ซ้าย,ชิ้น,PART,ฝาข้าง,,01-0001,none,,1,2,6';

  function itemForm(ctx, it) {
    const v = it || { type: 'PART', trackLot: 'none', active: true };
    const lock = !!it;
    return h.form({
      name: 'save', submit: it ? 'บันทึกการแก้ไข' : 'เพิ่มสินค้า', cancel: 'close',
      body: [
        h.field({ name: 'code', label: 'รหัสสินค้า (หลัก)', value: v.id, required: true, readonly: lock, hint: lock ? 'รหัสหลักแก้ไม่ได้ – ถ้าผิดให้ปิดใช้งานแล้วเพิ่มใหม่' : 'ระบบไม่ยอมให้รหัสที่อ่านแล้วซ้ำกับรหัสอื่น' }),
        h.field({ name: 'name', label: 'ชื่อสินค้า', value: v.name, required: true, wide: true }),
        h.field({ name: 'type', label: 'ประเภท', type: 'select', value: v.type, options: Object.entries(M.ITEM_TYPES), blank: false }),
        h.field({ name: 'baseUnit', label: 'หน่วยหลัก (เก็บยอด)', value: v.baseUnit, required: true }),
        h.field({ name: 'group', label: 'กลุ่ม / กลุ่มประกอบ', value: v.group }),
        h.field({ name: 'expressCode', label: 'รหัส Express', value: v.expressCode }),
        h.field({ name: 'countCode', label: 'รหัสนับสต็อก', value: v.countCode }),
        h.field({ name: 'model', label: 'รุ่นรถ/รุ่นกระบะ', value: v.model }),
        h.field({ name: 'side', label: 'ข้าง', type: 'select', value: v.side, options: [['L', 'ซ้าย (L)'], ['R', 'ขวา (R)']], blank: 'ไม่มีข้าง' }),
        h.field({ name: 'drawingNo', label: 'เลขที่แบบ', value: v.drawingNo }),
        h.field({ name: 'drawingRev', label: 'ฉบับแบบที่อนุมัติ', value: v.drawingRev, hint: 'อนุมัติ BOM แล้วระบบตั้งให้' }),
        h.field({ name: 'trackLot', label: 'ติดตามล็อต', type: 'select', value: v.trackLot, options: Object.entries(M.TRACK), blank: false }),
        h.field({ name: 'material', label: 'วัสดุ', value: v.material }),
        h.field({ name: 'thickness', label: 'ความหนา (มม.)', type: 'number', value: v.thickness || '' }),
        h.field({ name: 'width', label: 'กว้าง (มม.)', type: 'number', value: v.width || '' }),
        h.field({ name: 'length', label: 'ยาว (มม.)', type: 'number', value: v.length || '' }),
        h.field({ name: 'minQty', label: 'Min', type: 'number', value: v.minQty || '' }),
        h.field({ name: 'maxQty', label: 'Max', type: 'number', value: v.maxQty || '' }),
        h.field({ name: 'unitCost', label: 'ราคาต่อหน่วย (อ้างอิง)', type: 'number', value: v.unitCost || '', hint: 'มูลค่าจริงยึดบัญชี/Express' }),
        h.field({ name: 'qcIncoming', label: 'ต้องตรวจรับ (เข้ายอดรอตรวจ)', type: 'checkbox', value: v.qcIncoming }),
        h.field({ name: 'qcFinal', label: 'ต้องตรวจเมื่อผลิตเสร็จ', type: 'checkbox', value: v.qcFinal }),
        h.field({ name: 'certRequired', label: 'ต้องมีใบรับรองวัสดุ', type: 'checkbox', value: v.certRequired }),
        h.field({ name: 'active', label: 'ใช้งาน', type: 'checkbox', value: v.active !== false }),
        h.field({ name: 'remark', label: 'หมายเหตุ', value: v.remark, wide: true }),
      ],
    });
  }

  RRS.ui.page({
    id: 'items', title: 'ทะเบียนสินค้า', phase: 0, order: 20,
    sub: 'ค้นหาสินค้าจากชื่อหรือรหัส ดูรูปจริง และจัดการข้อมูลที่ใช้รับ–จ่ายของ',
    render(ctx) {
      const v = ctx.view;
      const q = (v.q || '').toLowerCase();
      const sum = RRS.inventory.summary(ctx.state);
      const rows = RRS.q.rows(ctx.state, 'items')
        .filter((i) => (!v.type || i.type === v.type) && (v.inactive || i.active !== false)
          && (!q || [i.id, i.name, i.expressCode, i.countCode, i.group, i.model].some((x) => String(x || '').toLowerCase().indexOf(q) >= 0)))
        .sort((a, b) => a.id.localeCompare(b.id));
      const canEdit = ctx.can('master.edit');
      const sel = v.sel === '__new' ? null : v.sel && RRS.q.get(ctx.state, 'items', v.sel);
      const list = h.table({
        rows, rowAct: 'pick', rowArg: (r) => r.id, rowCls: (r) => (r.id === v.sel ? 'sel' : r.active === false ? 'muted' : ''),
        empty: 'ยังไม่มีสินค้า', emptyText: canEdit ? 'กด เพิ่มสินค้า หรือ นำเข้าจากไฟล์ CSV' : 'ผู้มีสิทธิ์แก้ข้อมูลหลักเป็นผู้เพิ่มรายการ',
        cols: [
          { label: 'สินค้า', render: (r) => t`<div class="product-table-item">${thumbnail(ctx, r.id, r.name)}<div><b>${r.name}</b><br>${h.code(r.id)}${r.group ? t`<small>${r.group}</small>` : ''}</div></div>` },
          { label: 'ประเภท / หน่วย', render: (r) => t`${M.ITEM_TYPES[r.type] || r.type}<br><small>${r.baseUnit}</small>` },
          { label: 'ควบคุม', render: (r) => t`${r.trackLot !== 'none' ? h.badge(M.TRACK[r.trackLot], 'accent') : ''} ${r.qcIncoming ? h.badge('ตรวจรับ', 'warn') : ''} ${r.qcFinal ? h.badge('ตรวจผลิต', 'warn') : ''} ${r.side ? h.badge(r.side, 'muted') : ''}` },
          { label: 'คงเหลือรวม', num: true, get: (r) => (sum[r.id] ? sum[r.id].total : 0) },
          { label: '', render: (r) => h.btn('ดูสินค้า', { act: 'pick', arg: r.id, tone: 'quiet', small: true, title: `ดู ${r.name}` }) },
        ],
      });
      let detail = '';
      if (v.sel === '__new') detail = h.section('เพิ่มสินค้า', t`${gallery(ctx, '__new')}${itemForm(ctx, null)}`);
      else if (sel) {
        const units = RRS.q.rows(ctx.state, 'item_units', (u) => u.code === sel.id);
        const locs = RRS.inventory.locations(ctx.state, { code: sel.id });
        detail = t`${h.section(t`${h.code(sel.id)} ${sel.name}`, t`${gallery(ctx, sel.id)}${canEdit ? itemForm(ctx, sel) : h.dl([
          ['ประเภท', M.ITEM_TYPES[sel.type]], ['หน่วยหลัก', sel.baseUnit], ['รหัส Express', sel.expressCode], ['รหัสนับสต็อก', sel.countCode],
          ['รุ่น/ข้าง', [sel.model, sel.side].filter(Boolean).join(' · ')], ['แบบ/ฉบับ', [sel.drawingNo, sel.drawingRev].filter(Boolean).join(' rev ')],
          ['ติดตาม', M.TRACK[sel.trackLot]], ['Min / Max', `${sel.minQty || 0} / ${sel.maxQty || 0}`]])}`)}
          ${h.section('หน่วยและตัวคูณ', t`${h.table({ rows: units, empty: 'ใช้หน่วยหลักอย่างเดียว', emptyText: `1 ${sel.baseUnit} = 1 ${sel.baseUnit}`,
            cols: [{ label: 'หน่วย', key: 'unit' }, { label: 'เท่ากับ', render: (u) => h.qty(u.factor, sel.baseUnit) },
              { label: '', render: (u) => (canEdit ? h.btn('ลบ', { act: 'delUnit', arg: u.unit, tone: 'quiet', small: true }) : '') }] })}
            ${canEdit ? h.form({ name: 'unit', submit: 'เพิ่มหน่วย', body: [h.field({ name: 'unit', label: 'หน่วย เช่น โหล, กก., ผน', required: true }),
              h.field({ name: 'factor', label: `1 หน่วยนี้ = กี่ ${sel.baseUnit}`, type: 'number', required: true })] }) : ''}`)}
          ${h.section('ยอดตามตำแหน่ง', h.table({ rows: locs, empty: 'ไม่มียอด', dense: true,
            cols: [{ label: 'คลัง', key: 'wh' }, { label: 'ช่องเก็บ', key: 'bin' }, { label: 'สถานะ', render: (b) => h.statusBadge(b.status) },
              { label: 'ล็อต', key: 'lot' }, { label: 'จำนวน', num: true, key: 'qty' }] }), { actions: h.link('ดูประวัติ', 'history', { code: sel.id }) })}`;
      }
      return t`${h.toolbar([
        h.field({ name: 'q', label: 'ค้นหา', value: v.q, placeholder: 'รหัส ชื่อ รหัส Express กลุ่ม…', id: 'items-q' }),
        h.field({ name: 'type', label: 'ประเภท', type: 'select', value: v.type, options: Object.entries(M.ITEM_TYPES), blank: 'ทุกประเภท', id: 'items-type' }),
        h.field({ name: 'inactive', label: 'แสดงที่ปิดใช้งาน', type: 'checkbox', value: v.inactive, id: 'items-inactive' }),
      ], canEdit ? [h.btn('นำเข้า CSV', { act: 'import', tone: 'ghost' }), h.btn('+ เพิ่มสินค้า', { act: 'new', tone: 'primary' })] : '')}
        <div class="split items-layout"><div>${list}<p class="hint">${rows.length} รายการ</p></div><div>${detail || h.empty('เลือกสินค้าจากรายการ', 'ดูรูป ข้อมูลสินค้า หน่วย และตำแหน่งจัดเก็บ')}</div></div>`;
    },
    after(ctx, root0) {
      attachPhotos(ctx, root0);
      // filters apply as you type
      const q = root0.querySelector('#items-q');
      if (q) q.addEventListener('input', () => { ctx.view.q = q.value; clearTimeout(ctx.view._t); ctx.view._t = setTimeout(() => ctx.set({ _qfocus: true }), 250); });
      for (const id of ['items-type', 'items-inactive']) {
        const el = root0.querySelector('#' + id);
        if (el) el.addEventListener('change', () => ctx.set(id === 'items-type' ? { type: el.value } : { inactive: el.checked }));
      }
      if (q && ctx.view._qfocus) { ctx.view._qfocus = false; q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    },
    actions: {
      pick: (ctx, el) => ctx.set({ sel: el.dataset.arg }),
      new: (ctx) => ctx.set({ sel: '__new' }),
      close: (ctx) => ctx.set({ sel: null }),
      async delUnit(ctx, el) {
        await ctx.exec('item.unit', { code: ctx.view.sel, unit: el.dataset.arg, remove: true }, { done: 'ลบหน่วยแล้ว' });
      },
      async import(ctx) {
        const pasted = await ctx.dialog({
          title: 'นำเข้าสินค้าจากไฟล์', submit: 'ตรวจและนำเข้า', wide: true,
          body: t`<p class="hint wide">วางข้อมูลจาก Excel/CSV (แถวแรกเป็นหัวตาราง) หรือเลือกไฟล์ ระบบนำเข้าทั้งหมดหรือไม่นำเข้าเลยถ้ามีแถวผิด</p>
            ${h.field({ name: 'file', label: 'ไฟล์ (.csv .xlsx)', type: 'file', accept: '.csv,.txt,.tsv,.xlsx,.xls', wide: true, id: 'imp-file' })}
            ${h.field({ name: 'text', label: 'หรือวางข้อมูล (ตัวอย่างหัวตารางด้านล่าง)', type: 'textarea', rows: 8, wide: true, placeholder: TEMPLATE, id: 'imp-text' })}`,
          async onSubmit(values, form) {
            let rows;
            const f = form.querySelector('#imp-file').files[0];
            if (f) rows = (await h.readTable(f)).rows;
            else rows = h.parseCsv(values.text);
            if (rows.length < 2) return { ok: false, errors: [{ message: 'ไม่พบแถวข้อมูล' }] };
            const map = h.mapHeader(rows[0], ALIASES);
            if (map.code == null || map.name == null) return { ok: false, errors: [{ message: 'ต้องมีคอลัมน์ รหัสสินค้า และ ชื่อสินค้า' }] };
            const items = rows.slice(1).map((r) => {
              const o = {};
              for (const k in map) o[k] = r[map[k]];
              for (const b of ['qcIncoming', 'qcFinal', 'certRequired']) if (o[b] != null) o[b] = ['1', 'y', 'yes', 'ใช่', 'true', '✓'].indexOf(String(o[b]).trim().toLowerCase()) >= 0;
              return o;
            });
            return ctx.exec('master.import', { items }, { quiet: true, done: (r) => `นำเข้า ${r.result.rows} รายการแล้ว` });
          },
        });
        if (pasted && pasted.ok) ctx.toast(`นำเข้า ${pasted.result.rows} รายการแล้ว`, 'ok');
      },
    },
    forms: {
      async save(ctx, v) {
        const r = await ctx.exec('item.upsert', Object.assign({}, v, { create: ctx.view.sel === '__new' }), { done: 'บันทึกสินค้าแล้ว' });
        if (r.ok) ctx.set({ sel: RRS.util.normCode(v.code) });
      },
      async unit(ctx, v) {
        await ctx.exec('item.unit', { code: ctx.view.sel, unit: v.unit, factor: v.factor }, { done: 'เพิ่มหน่วยแล้ว' });
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
