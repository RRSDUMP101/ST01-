/*
 * App shell: picks where data lives (demo in this browser / shared team data / a server), who is working,
 * the menu by phase, and renders the current page. Pages are registered with RRS.ui.page (see kit.js).
 */
(function (root) {
  'use strict';
  const RRS = root.RRS;
  const { h } = RRS.ui;
  const { t, safe } = h;

  const PHASES = [
    { n: 'home', label: 'ภาพรวม' },
    { n: 0, label: 'Phase 0 · ขอบเขตและข้อมูลหลัก' },
    { n: 1, label: 'Phase 1 · รับ–เบิก–โอน' },
    { n: 2, label: 'Phase 2 · จองและเบิกให้งานผลิต' },
    { n: 3, label: 'Phase 3 · Express และตรวจนับ' },
    { n: 4, label: 'Phase 4 · เติมสต็อกและจัดซื้อ' },
    { n: 5, label: 'Phase 5 · ล็อต คุณภาพ กักกัน' },
    { n: 6, label: 'Phase 6 · รายงานและขยายผล' },
    { n: 'sys', label: 'ระบบ' },
  ];
  const MODES = {
    demo: { label: 'ข้อมูลตัวอย่าง', sub: 'เก็บในเบราว์เซอร์นี้เท่านั้น สลับผู้ใช้ทดลองได้', tone: 'warn' },
    team: { label: 'ข้อมูลทีม', sub: 'ใช้ร่วมกันทุกคนที่เปิดหน้านี้', tone: 'ok' },
    server: { label: 'Nexus Part Terminal', sub: 'บัญชีและข้อมูล Nexus Part Terminal', tone: 'ok' },
  };
  const DEMO_KEY = 'rrs-stockqc-demo-v1';

  const pref = {
    get(k, d) {
      try {
        const v = root.localStorage.getItem('rrs-sq:' + k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        root.localStorage.setItem('rrs-sq:' + k, JSON.stringify(v));
      } catch (e) { /* per-viewer convenience only */ }
    },
  };

  const app = {
    mode: null, ledger: null, store: null, unsub: null, caps: {}, account: null, demoUser: pref.get('demoUser', 'ADMIN'),
    page: 'home', views: {}, busy: false, dirty: false, stale: false, loading: true, loadNote: '', error: '', rid: null,
    navOpen: false,
  };
  RRS.app = app;
  let ridN = 0;
  const newRid = () => (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : `r${Date.now().toString(36)}-${(++ridN).toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const $ = (sel) => root.document.querySelector(sel);

  // ---- capabilities ----------------------------------------------------------------------------------------
  function use(name) {
    try {
      if (!root.claude || typeof root.claude.use !== 'function') return Promise.resolve(null);
      return root.claude.use(name).catch(() => null);
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  // ---- who is working ----------------------------------------------------------------------------------------
  function users() {
    return app.ledger ? RRS.q.rows(app.ledger.state, 'users') : [];
  }
  function currentUser() {
    if (!app.ledger) return null;
    if (app.mode === 'demo') return RRS.q.get(app.ledger.state, 'users', app.demoUser) || users().find((u) => u.roles.indexOf('admin') >= 0) || null;
    if (app.mode === 'team') return users().find((u) => u.accountId && u.accountId === app.account && u.active !== false) || null;
    return users().find((u) => u.accountId && u.accountId === app.account) || null;
  }

  // ---- start a mode --------------------------------------------------------------------------------------------
  async function startMode(mode) {
    if (app.unsub) {
      try { app.unsub(); } catch (e) { /* ignore */ }
      app.unsub = null;
    }
    app.mode = mode;
    app.loading = true;
    app.error = '';
    app.stale = false;
    render();
    const holder = 'tab-' + newRid().slice(0, 8);
    try {
      if (mode === 'demo') {
        app.store = new RRS.stores.LocalStore(DEMO_KEY);
        app.ledger = new RRS.Ledger(app.store, { holder });
        await app.ledger.catchUp();
        if (app.ledger.state.seq === 0) {
          app.loadNote = pref.get('demoEmpty', false) ? 'กำลังเริ่มระบบว่าง…' : 'กำลังสร้างข้อมูลตัวอย่าง…';
          render();
          if (RRS.fixture && RRS.fixture.load && !pref.get('demoEmpty', false)) await RRS.fixture.load(app.ledger);
          else await app.ledger.execute({ kind: 'system.bootstrap', payload: { name: 'ผู้ดูแลระบบ (ตัวอย่าง)', company: 'ข้อมูลตัวอย่าง' } }, {});
        }
        app.unsub = app.store.subscribe(() => app.ledger.catchUp().catch(onSyncError));
      } else if (mode === 'team') {
        const db = app.caps.db;
        if (!db) throw new Error('หน้านี้ยังเปิดฐานข้อมูลร่วมไม่ได้ (ต้องเปิดใน claude.ai และเข้าสู่ระบบ)');
        app.store = new RRS.stores.ArtifactDbStore(db);
        app.ledger = new RRS.Ledger(app.store, { holder: (app.account || 'anon') + ':' + holder }); // one lock holder per tab
        app.loadNote = 'กำลังโหลดข้อมูลทีม…';
        render();
        const timer = setTimeout(() => {
          app.loadNote = 'ยังติดต่อฐานข้อมูลไม่ได้ – กำลังลองต่อ (ตรวจการเชื่อมต่อ)';
          render();
        }, 10000);
        try {
          await app.ledger.catchUp();
        } finally {
          clearTimeout(timer);
        }
        app.unsub = app.store.subscribe(() => app.ledger.catchUp().catch(onSyncError), (e) => {
          app.error = 'การเชื่อมต่อข้อมูลทีมหยุด (' + (e && e.code) + ') – โหลดหน้าใหม่เพื่อเชื่อมต่ออีกครั้ง';
          render();
        });
      } else if (mode === 'server') {
        const cfg = root.RRS_CONFIG || {};
        app.api = String(cfg.api || '/api').replace(/\/+$/, '');
        app.session = await serverSession();
        if (!app.session) {
          app.ledger = null;
          app.needLogin = true;
          app.loading = false;
          render();
          return;
        }
        app.needLogin = false;
        app.account = app.session.username;
        app.ledger = new RRS.stores.RemoteLedger(app.api, { headers: cfg.headers });
        // signed in but not a user of the stock system yet: the server refuses to show its data, so only offer the
        // access request (user.requestAccess runs on the server for accounts without an engine user)
        app.noAccess = !app.session.user && !app.session.owner;
        if (app.noAccess) {
          app.loading = false;
          render();
          return;
        }
        app.loadNote = 'กำลังโหลดข้อมูลจากเซิร์ฟเวอร์…';
        render();
        await app.ledger.catchUp();
        const iv = setInterval(() => app.ledger.catchUp().catch(onSyncError), 15000);
        app.unsub = () => clearInterval(iv);
      }
      app.ledger.onChange((state, info) => onState(info));
      pref.set('mode', mode);
    } catch (e) {
      app.error = (e && e.message) || String(e);
    }
    app.loading = false;
    app.loadNote = '';
    render();
  }
  function onSyncError(e) {
    const msg = (e && e.message) || String(e);
    if (/another history|ลายนิ้วมือ|does not follow/.test(msg)) {
      // someone else's commit replaced ours (should not happen under the lock): start again from the store
      startMode(app.mode);
      return;
    }
    app.error = 'อ่านข้อมูลล่าสุดไม่ได้: ' + msg;
    render();
  }
  function onState(info) {
    if (info && info.remote && (app.dirty || isEditing())) {
      app.stale = true;
      renderChrome();
      return;
    }
    render();
  }
  function isEditing() {
    const el = root.document.activeElement;
    return !!(el && el.closest && el.closest('#main, #dlg') && /INPUT|TEXTAREA|SELECT/.test(el.tagName) && el.type !== 'button' && el.type !== 'submit');
  }

  // ---- server mode: cookie-backed Nexus accounts ----------------------------------------------------------------
  async function serverSession() {
    try {
      const r = await fetch(`${app.api}/auth/session`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      const body = await r.json();
      if (body && body.authProvider) app.authProvider = body.authProvider;
      if (!r.ok) {
        if (r.status !== 401) app.loginError = 'ระบบยืนยันตัวตนยังไม่พร้อม กรุณาลองใหม่อีกครั้ง';
        return null;
      }
      return body && body.username ? body : null;
    } catch (e) {
      app.error = 'ติดต่อเซิร์ฟเวอร์ไม่ได้: ' + ((e && e.message) || e);
      return null;
    }
  }
  /** JSON call to a server-only route (credentials, files, backup, Sales Office sync). */
  async function apiCall(path, body, method) {
    if (app.mode !== 'server') return { ok: false, errors: [{ code: 'NO_SERVER', message: 'ใช้ได้เมื่อเชื่อมเซิร์ฟเวอร์ (Cloudflare) แล้ว' }] };
    const r = await fetch(app.api + path, { method: method || (body ? 'POST' : 'GET'), credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (r.status === 401) {
      app.needLogin = true;
      startMode('server');
    }
    if (!r.ok) return Object.assign({ ok: false, errors: [{ code: 'HTTP_' + r.status, message: (data && (typeof data.error === 'string' ? data.error : data.message)) || 'เซิร์ฟเวอร์ตอบ ' + r.status }] }, data || {});
    return Object.assign({ ok: true }, data || {});
  }
  /**
   * Attach a photo / certificate. Server mode: stored in R2 by the Worker → {id, name, url}. Other modes: images are
   * shrunk to a small JPEG kept inside the record (PDF needs the server).
   */
  async function uploadFile(file) {
    if (!file) return null;
    if (app.mode === 'server') {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const r = await fetch(app.api + '/files', { method: 'POST', credentials: 'same-origin', body: fd });
      let data = null;
      try { data = await r.json(); } catch (e) { data = null; }
      if (!r.ok || !data || !data.id) throw new Error((data && data.error) || 'อัปโหลดไฟล์ไม่สำเร็จ');
      return { id: data.id, name: file.name, url: `${app.api}/files/${data.id}`, type: file.type };
    }
    if (!/^image\//.test(file.type)) throw new Error('แนบ PDF/ไฟล์อื่นได้เมื่อใช้เซิร์ฟเวอร์ – ในโหมดนี้แนบได้เฉพาะรูป');
    const url = await new Promise((resolve, reject) => {
      const img = new root.Image();
      const src = root.URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, 800 / Math.max(img.width, img.height));
        const c = root.document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        root.URL.revokeObjectURL(src);
        resolve(c.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = () => reject(new Error('อ่านรูปไม่ได้'));
      img.src = src;
    });
    if (url.length > 180000) throw new Error('รูปใหญ่เกินไปสำหรับโหมดนี้');
    return { id: 'inline-' + RRS.util.sha256(url).slice(0, 16), name: file.name, url, type: 'image/jpeg' };
  }

  /** Every commit from the store (audit fingerprint check, backup). */
  async function loadCommits() {
    if (app.mode === 'server') {
      const out = [];
      let after = 0;
      for (let i = 0; i < 1000; i++) {
        const r = await fetch(`${app.api}/commits?after=${after}`, { credentials: 'same-origin' });
        if (!r.ok) throw new Error('อ่านข้อมูลจากเซิร์ฟเวอร์ไม่ได้ (' + r.status + ')');
        const body = await r.json();
        out.push(...(body.commits || []));
        if (!body.more || !(body.commits || []).length) break;
        after = out[out.length - 1].seq;
      }
      return out;
    }
    return app.store ? app.store.load(0) : [];
  }

  // ---- toasts and dialogs --------------------------------------------------------------------------------------
  function toast(text, tone) {
    const box = $('#toasts');
    if (!box) return;
    const el = root.document.createElement('div');
    el.className = 'toast t-' + (tone || 'info');
    el.setAttribute('role', 'status');
    el.textContent = text;
    box.appendChild(el);
    setTimeout(() => el.classList.add('out'), 4200);
    setTimeout(() => el.remove(), 4800);
  }
  let dlgState = null;
  /** dialog({title, body, submit, danger, wide, onSubmit(values) -> result | true | false}) */
  function dialog(o) {
    return new Promise((resolve) => {
      dlgState = { o, resolve, rid: newRid() };
      const box = $('#dlg');
      box.innerHTML = String(t`<div class="dlg-back" data-dlg-close="1"></div><div class="dlg-card${o.wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <form data-dlg-form="1" novalidate><header class="dlg-h"><h2 id="dlg-title">${o.title}</h2><button type="button" class="btn btn-quiet" data-dlg-close="1" aria-label="ปิด">×</button></header>
        <div class="dlg-b">${o.message ? t`<p>${o.message}</p>` : ''}<div class="fgrid">${o.body || ''}</div><div class="dlg-err" id="dlg-err"></div></div>
        <footer class="dlg-f">${h.btn('ยกเลิก', { tone: 'ghost' })}${h.btn(o.submit || 'ตกลง', { type: 'submit', tone: o.danger ? 'danger' : 'primary' })}</footer></form></div>`);
      box.hidden = false;
      box.querySelector('.dlg-f .btn-ghost').setAttribute('data-dlg-close', '1');
      const first = box.querySelector('input:not([type=hidden]), select, textarea, button[type=submit]');
      if (first) first.focus();
    });
  }
  function closeDialog(value) {
    const box = $('#dlg');
    box.hidden = true;
    box.innerHTML = '';
    const s = dlgState;
    dlgState = null;
    if (s) s.resolve(value);
    if (app.stale && !app.dirty) render();
  }
  async function submitDialog(form) {
    const s = dlgState;
    if (!s) return;
    const bad = h.badNumbers(form);
    if (bad) {
      const box = $('#dlg-err');
      if (box) box.innerHTML = String(h.errors(bad));
      return;
    }
    const values = h.parseForm(form);
    if (!s.o.onSubmit) return closeDialog(values);
    const outerRid = app.rid; // a page form may be waiting on this dialog: keep its request id
    app.rid = s.rid;
    let r;
    try {
      r = await s.o.onSubmit(values, form);
    } finally {
      app.rid = outerRid;
    }
    if (r === true || (r && r.ok)) return closeDialog(r);
    const errBox = $('#dlg-err');
    if (errBox && r && r.errors) errBox.innerHTML = String(h.errors(r));
  }
  function confirmBox(o) {
    return dialog({ title: o.title || 'ยืนยัน', message: o.message, submit: o.ok || 'ยืนยัน', danger: o.danger, body: o.body })
      .then((v) => v !== undefined && v !== null && v !== false);
  }

  // ---- downloads ----------------------------------------------------------------------------------------------
  async function download(filename, text) {
    const dl = app.caps.downloads;
    if (dl) {
      try {
        await dl.save({ filename, data: text });
        toast('ส่งไฟล์ ' + filename + ' แล้ว', 'ok');
        return true;
      } catch (e) {
        if (e && e.code === 'declined') return false;
        if (e && e.code === 'rate_limited') {
          toast('มีหน้าต่างบันทึกไฟล์เปิดอยู่แล้ว', 'warn');
          return false;
        }
      }
    }
    await dialog({ title: 'คัดลอกข้อมูล', submit: 'ปิด', wide: true,
      body: t`<p class="hint wide">หน้านี้บันทึกไฟล์ให้ไม่ได้ – คัดลอกข้อความด้านล่างไปวางในไฟล์ ${filename}</p><textarea class="wide copybox" rows="12" readonly>${text}</textarea>` });
    return false;
  }

  // ---- context handed to pages ----------------------------------------------------------------------------------
  function makeCtx(pageId) {
    const state = app.ledger ? app.ledger.state : RRS.core.createState();
    const user = currentUser();
    const view = app.views[pageId] || (app.views[pageId] = {});
    const now = new Date().toISOString();
    return {
      state, user, mode: app.mode, view, h, RRS, today: RRS.util.bkkDate(now), now,
      can: (perm, wh) => RRS.auth.can(user, perm, wh),
      set(patch) {
        Object.assign(view, patch);
        app.dirty = false;
        render();
      },
      go(id, patch) {
        if (patch) Object.assign(app.views[id] || (app.views[id] = {}), patch);
        navigate(id);
      },
      async exec(kind, payload, opt) {
        opt = opt || {};
        if (!app.ledger) return { ok: false, errors: [{ code: 'NOT_READY', message: 'ระบบยังโหลดไม่เสร็จ' }] };
        if (!user && !opt.public) {
          const r0 = { ok: false, errors: [{ code: 'NO_USER', message: 'ยังไม่มีผู้ใช้ – เลือกผู้ใช้หรือขอสิทธิ์ก่อน' }] };
          if (!opt.quiet) showErrors(r0);
          return r0;
        }
        const requestId = opt.requestId || app.rid || newRid();
        setBusy(true);
        let r;
        try {
          r = await app.ledger.execute({ kind, payload, requestId }, { user: user ? user.id : '', via: app.account || '' });
        } catch (e) {
          r = { ok: false, errors: [{ code: 'ERROR', message: (e && e.message) || String(e) }] };
        } finally {
          setBusy(false);
        }
        if (!r.ok) {
          if (r.auth) {
            app.needLogin = true;
            startMode('server');
          }
          if (!opt.quiet) showErrors(r);
        } else {
          app.dirty = false;
          if (r.duplicate) toast('รายการนี้บันทึกไปแล้ว (ส่งซ้ำ) – ไม่บันทึกซ้ำ', 'info');
          else if (opt.done) toast(typeof opt.done === 'function' ? opt.done(r) : opt.done, 'ok');
          for (const w of r.warnings || []) toast(w, 'warn');
        }
        return r;
      },
      check: (kind, payload) => (app.ledger ? app.ledger.check({ kind, payload }, { user: user ? user.id : '', via: app.account || '' }) : { ok: false, errors: [] }),
      toast, dialog, confirm: confirmBox, download, api: apiCall, uploadFile, server: app.mode === 'server',
      account: app.account || '',
      loadCommits,
      /** Replace the body of the open dialog (e.g. after loading something). */
      dialogBody(html) {
        const box = root.document.querySelector('#dlg .dlg-b .fgrid');
        if (box) box.innerHTML = String(html);
      },
      item: (code) => RRS.q.item(state, code),
      userName: (id) => {
        const u = RRS.q.get(state, 'users', id);
        return u ? u.name : id || '–';
      },
      whName: (code) => {
        const w = RRS.q.get(state, 'warehouses', code);
        return w ? w.name : code;
      },
    };
  }
  function showErrors(r) {
    const list = (r.errors || []).slice(0, 6);
    if (!list.length) return;
    if (list.length === 1) toast(list[0].message, 'bad');
    else dialog({ title: 'บันทึกไม่ได้ – ยังไม่มีอะไรเปลี่ยน', submit: 'ปิด', body: t`<div class="wide">${h.errors({ errors: list })}</div>` });
  }
  function setBusy(b) {
    app.busy = b;
    root.document.body.classList.toggle('is-busy', b);
  }

  // ---- routing ---------------------------------------------------------------------------------------------------
  function navigate(id) {
    if (!RRS.ui.pages[id]) id = 'home';
    app.page = id;
    app.dirty = false;
    app.navOpen = false;
    if (root.location.hash !== '#' + id) {
      try {
        root.history.replaceState(null, '', '#' + id);
      } catch (e) {
        root.location.hash = id;
      }
    }
    render();
    const main = $('#main');
    if (main) main.scrollTop = 0;
    root.scrollTo && root.scrollTo(0, 0);
  }
  function pageFromHash() {
    const id = String(root.location.hash || '').replace(/^#/, '');
    return RRS.ui.pages[id] ? id : 'home';
  }

  // ---- rendering ------------------------------------------------------------------------------------------------
  function navHtml(user) {
    const pages = Object.values(RRS.ui.pages);
    const groups = PHASES.map((p) => {
      const list = pages.filter((pg) => (pg.phase === p.n) && (!pg.perm || RRS.auth.can(user, pg.perm) || pg.showAll))
        .sort((a, b) => a.order - b.order);
      if (!list.length) return '';
      return t`<div class="nav-g"><p class="nav-gl">${p.label}</p>${list.map((pg) => t`<a href="#${pg.id}" data-go="${pg.id}" class="nav-a${pg.id === app.page ? ' on' : ''}"${safe(pg.id === app.page ? ' aria-current="page"' : '')}>${pg.title}${pg.badge ? safe(` <span class="nav-n">${h.esc(pg.badge(makeCtx(pg.id)) || '')}</span>`) : ''}</a>`)}</div>`;
    });
    return t`${groups}`;
  }
  function userChip(user) {
    if (app.mode === 'demo') {
      const opts = users().filter((u) => u.active !== false).map((u) => [u.id, `${u.name} · ${u.roles.map((r) => RRS.auth.ROLES[r] || r).join(', ')}`]);
      return t`<label class="who"><span class="who-l">ทำรายการในชื่อ</span><select id="who-sel" data-who="1" aria-label="เลือกผู้ใช้ทดลอง">${opts.map(([v, l]) => t`<option value="${v}"${safe(user && user.id === v ? ' selected' : '')}>${l}</option>`)}</select></label>`;
    }
    const acct = app.mode === 'server' && app.session ? t` ${salesAuth() || app.session.owner ? '' : h.btn('เปลี่ยนรหัสผ่าน', { act: '_password', tone: 'quiet', small: true })}${h.btn('ออกจากระบบ', { act: '_logout', tone: 'quiet', small: true })}` : '';
    if (!user) return t`<span class="who"><span class="who-l">ผู้ใช้</span><b>${app.mode === 'server' && app.session ? app.session.username : 'ยังไม่มีสิทธิ์'}</b>${acct}</span>`;
    return t`<span class="who"><span class="who-l">ผู้ใช้</span><b>${user.name}</b> <span class="who-r">${user.roles.map((r) => RRS.auth.ROLES[r] || r).join(', ')}</span>${acct}</span>`;
  }
  function renderChrome() {
    const top = $('#top');
    if (!top) return;
    const user = currentUser();
    const m = MODES[app.mode] || MODES.demo;
    top.innerHTML = String(t`<button class="btn btn-quiet nav-toggle" data-nav-toggle="1" aria-label="เมนู" aria-expanded="${app.navOpen ? 'true' : 'false'}">☰</button>
      <a class="brand" href="#home" data-go="home"><span class="brand-mark" aria-hidden="true">RRS</span><span class="brand-t">Stock &amp; QC</span></a>
      <button class="mode b-${m.tone}" data-mode-switch="1" title="${m.sub}">${m.label} ▾</button>
      <div class="top-r">${userChip(user)}</div>`);
    const nav = $('#nav');
    nav.innerHTML = String(navHtml(user));
    nav.classList.toggle('open', app.navOpen);
    const banner = $('#banner');
    const notes = [];
    if (app.mode === 'demo') notes.push(t`<div class="bar bar-warn">${pref.get('demoEmpty', false) ? 'ข้อมูลทดลองในเบราว์เซอร์นี้ (เริ่มจากระบบว่าง) ไม่ใช่ยอดจริง' : 'ข้อมูลตัวอย่างในเบราว์เซอร์นี้ (รหัส DEMO-…) ไม่ใช่ยอดจริง'} · ${h.btn('เริ่มข้อมูลตัวอย่างใหม่', { act: '_resetDemo', tone: 'quiet', small: true })}${app.caps.db ? h.btn('ไปใช้ข้อมูลทีม', { act: '_toTeam', tone: 'quiet', small: true }) : ''}</div>`);
    if (app.stale) notes.push(t`<div class="bar bar-info">มีข้อมูลใหม่จากผู้อื่น ${h.btn('แสดงข้อมูลล่าสุด', { act: '_refresh', tone: 'quiet', small: true })}</div>`);
    if (app.error) notes.push(t`<div class="bar bar-bad">${app.error}</div>`);
    banner.innerHTML = String(t`${notes}`);
  }
  function render() {
    const shell = $('.app');
    if (shell) shell.classList.toggle('auth-screen', app.mode === 'server' && !!app.needLogin);
    renderChrome();
    const main = $('#main');
    if (!main) return;
    if (app.loading) {
      main.innerHTML = String(t`<div class="loading"><div class="spin" aria-hidden="true"></div><p>${app.loadNote || 'กำลังเตรียมข้อมูล…'}</p></div>`);
      return;
    }
    if (app.mode === 'server' && app.needLogin) return renderLogin(main);
    if (app.mode === 'server' && app.noAccess) return renderAccess(main);
    if (!app.ledger) {
      main.innerHTML = String(h.empty('เปิดข้อมูลไม่ได้', app.error || 'ลองโหลดหน้าใหม่'));
      return;
    }
    app.stale = false;
    const user = currentUser();
    const noUsers = users().length === 0;
    if (app.mode !== 'demo' && noUsers) return renderBootstrap(main);
    if (app.mode !== 'demo' && !user) return renderAccess(main);
    const page = RRS.ui.pages[app.page] || RRS.ui.pages.home;
    const ctx = makeCtx(page.id);
    let html;
    try {
      html = page.render(ctx);
    } catch (e) {
      if (root.console) root.console.error(e);
      html = h.empty('หน้านี้แสดงไม่ได้', (e && e.message) || String(e));
    }
    const y = root.scrollY;
    const focus = root.document.activeElement;
    const keep = focus && focus.id && main.contains(focus) && /INPUT|TEXTAREA|SELECT/.test(focus.tagName)
      ? { id: focus.id, start: focus.selectionStart, end: focus.selectionEnd } : null;
    main.innerHTML = String(t`<div class="page" data-page="${page.id}"><header class="page-h"><div><p class="eyebrow">${(PHASES.find((p) => p.n === page.phase) || {}).label || ''}</p><h1>${page.title}</h1>${page.sub ? t`<p class="page-s">${page.sub}</p>` : ''}</div></header>${html}</div>${h.lists.items(ctx.state)}${h.lists.warehouses(ctx.state)}${h.lists.bins(ctx.state)}`);
    const before = root.document.activeElement;
    if (page.after) {
      try {
        page.after(ctx, main);
      } catch (e) {
        if (root.console) root.console.error(e);
      }
    }
    const moved = root.document.activeElement !== before && root.document.activeElement !== root.document.body;
    if (keep && !moved) {
      const el = root.document.getElementById(keep.id);
      if (el && el !== root.document.activeElement) {
        el.focus({ preventScroll: true });
        try { if (keep.start != null) el.setSelectionRange(keep.start, keep.end); } catch (e) { /* not a text field */ }
      }
    }
    if (Math.abs(root.scrollY - y) > 2) root.scrollTo(0, y);
    root.document.title = `${page.title} · RRS Stock & QC`;
  }
  function salesAuth() {
    return app.authProvider === 'sales-office' || (app.session && app.session.authProvider === 'sales-office');
  }
  function serverOnly() {
    return !!(root.RRS_CONFIG && root.RRS_CONFIG.api && root.RRS_CONFIG.only !== false);
  }
  function renderLogin(main) {
    const shared = salesAuth();
    root.document.title = 'เข้าสู่ระบบ · Nexus Part Terminal';
    main.innerHTML = String(t`<section class="login-layout" aria-labelledby="login-title">
      <div class="login-intro"><span class="login-wordmark">NEXUS<span>PART TERMINAL</span></span>
        <div><p class="login-kicker">RRS STOCK &amp; QC</p><h2>ทุกชิ้นส่วน<br>พร้อมสำหรับงานถัดไป</h2>
        <p class="login-description">จัดการสต็อก จองของให้งานผลิต และติดตามคุณภาพในพื้นที่ทำงานเดียว</p></div>
        <ol class="login-workflow"><li><span>01</span>รับและจัดเก็บ</li><li><span>02</span>จองและเบิก</li><li><span>03</span>ตรวจและส่งต่อ</li></ol>
      </div><div class="login-panel"><div class="login-panel-content"><p class="eyebrow">ยินดีต้อนรับกลับ</p><h1 id="login-title">เข้าสู่ระบบ</h1>
        <p class="login-subtitle">${shared ? 'ใช้ชื่อผู้ใช้และรหัสผ่านเดียวกับ RRS Sales Office' : 'ใช้บัญชี Nexus Part Terminal ที่ผู้ดูแลระบบกำหนดให้'}</p>
        <form data-form="_login" class="login-form">
          <div id="login-feedback" role="alert" aria-live="polite" class="login-feedback"${safe(app.loginError ? '' : ' hidden')}>${app.loginError || ''}</div>
          <label class="fld" for="login-user"><span>ชื่อผู้ใช้${shared ? ' Sales Office' : ''}</span>
            <input id="login-user" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="100" aria-describedby="login-user-hint" value="${app.loginUsername || ''}">
            <small id="login-user-hint">${shared ? 'ชื่อผู้ใช้ของบัญชี Sales Office' : 'ชื่อผู้ใช้ไม่แยกตัวพิมพ์ใหญ่–เล็ก'}</small></label>
          <div class="fld"><label for="login-pass">รหัสผ่าน</label><div class="password-field">
            <input id="login-pass" name="password" type="password" autocomplete="current-password" required>
            <button class="btn btn-quiet password-toggle" type="button" data-act="_togglePassword" aria-controls="login-pass" aria-pressed="false" aria-label="แสดงรหัสผ่าน">แสดง</button></div></div>
          <label class="fld login-otp" for="login-otp" id="login-otp-wrap"${safe(app.loginMfa ? '' : ' hidden')}><span>รหัสยืนยันตัวตน</span>
            <input id="login-otp" name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"${safe(app.loginMfa ? ' required' : ' disabled')} aria-describedby="login-otp-hint">
            <small id="login-otp-hint">กรอกรหัส 6 หลักจากแอปยืนยันตัวตน</small></label>
          <button class="btn btn-primary login-submit" type="submit">${app.loginMfa ? 'ยืนยันและเข้าสู่ระบบ' : 'เข้าสู่ระบบ'}</button>
          <p class="login-status" id="login-status" role="status" aria-live="polite"></p>
        </form>
        <p class="login-help">${shared ? 'บัญชีและรหัสผ่านจัดการที่ Sales Office ส่วนสิทธิ์สต็อกและ QC กำหนดตามหน้าที่ในระบบนี้' : 'หากเข้าสู่ระบบไม่ได้ กรุณาติดต่อผู้ดูแลระบบ'}</p>
      </div><footer class="login-footer">RRS · Nexus Part Terminal</footer></div></section>`);
    const u = main.querySelector('#login-user');
    if (u) u.focus();
  }
  function renderBootstrap(main) {
    main.innerHTML = String(t`<div class="page narrow"><header class="page-h"><div><p class="eyebrow">เริ่มใช้ข้อมูลทีม</p><h1>ตั้งผู้ดูแลระบบคนแรก</h1>
      <p class="page-s">ฐานข้อมูลทีมยังว่าง บัญชีที่เปิดหน้านี้อยู่จะเป็นผู้ดูแลระบบ แล้วเพิ่มผู้ใช้คนอื่นในหน้า ผู้ใช้และสิทธิ์</p></div></header>
      ${app.mode === 'server' ? h.note('เฉพาะบัญชีเจ้าของระบบเริ่มใช้งานได้', 'info') : ''}
      ${h.form({ name: '_bootstrap', submit: 'เริ่มระบบ', body: [h.field({ name: 'name', label: 'ชื่อผู้ดูแลระบบ', required: true }), h.field({ name: 'company', label: 'ชื่อบริษัท/หน่วยงาน' })] })}</div>`);
  }
  function renderAccess(main) {
    if (app.mode === 'server') {
      const ready = app.session && app.session.bootstrapped !== false;
      main.innerHTML = String(t`<div class="page narrow"><header class="page-h"><div><p class="eyebrow">เซิร์ฟเวอร์</p><h1>บัญชี ${app.account || ''} ยังไม่มีสิทธิ์ในระบบสต็อก</h1>
        <p class="page-s">${ready ? 'ส่งคำขอ แล้วให้ผู้ดูแลระบบเพิ่มผู้ใช้ในหน้า ผู้ใช้และสิทธิ์ โดยผูกกับบัญชีนี้และกำหนดบทบาท' : 'ระบบยังไม่ได้เริ่ม – รอเจ้าของระบบเข้าสู่ระบบและเริ่มระบบก่อน'}</p></div></header>
        ${app.accessSent ? h.note('ส่งคำขอแล้ว – รอผู้ดูแลระบบเพิ่มสิทธิ์ แล้วโหลดหน้านี้ใหม่', 'ok') : ''}
        ${ready ? h.form({ name: '_access', submit: app.accessSent ? 'ส่งคำขออีกครั้ง' : 'ส่งคำขอใช้งาน', body: [h.field({ name: 'name', label: 'ชื่อ-นามสกุล', required: true }), h.field({ name: 'note', label: 'ตำแหน่ง/หน้าที่' })] }) : ''}
        <div class="form-actions">${h.btn('ออกจากระบบ', { act: '_logout', tone: 'ghost' })}</div></div>`);
      return;
    }
    const req = app.account ? RRS.q.get(app.ledger.state, 'access_requests', app.account) : null;
    main.innerHTML = String(t`<div class="page narrow"><header class="page-h"><div><p class="eyebrow">ข้อมูลทีม</p><h1>บัญชีนี้ยังไม่มีสิทธิ์ใช้งาน</h1>
      <p class="page-s">${app.account ? 'ส่งคำขอให้ผู้ดูแลระบบเพิ่มสิทธิ์ตามหน้าที่' : 'เข้าสู่ระบบ claude.ai ก่อน แล้วโหลดหน้าใหม่'}</p></div></header>
      ${req ? h.note(t`ส่งคำขอในชื่อ <b>${req.name}</b> แล้ว (${req.status === 'OPEN' ? 'รอผู้ดูแลเพิ่มสิทธิ์' : 'ดำเนินการแล้ว'})`, 'info') : ''}
      ${app.account ? h.form({ name: '_access', submit: req ? 'ส่งคำขออีกครั้ง' : 'ส่งคำขอใช้งาน', body: [h.field({ name: 'name', label: 'ชื่อ-นามสกุล', required: true, value: req && req.name }), h.field({ name: 'note', label: 'ตำแหน่ง/หน้าที่', value: req && req.note })] }) : ''}
      <p class="hint">ต้องการทดลองก่อน: ${h.btn('ใช้ข้อมูลตัวอย่าง', { act: '_toDemo', tone: 'ghost', small: true })}</p></div>`);
  }

  // ---- built-in actions (prefixed _) --------------------------------------------------------------------------------
  const builtin = {
    _togglePassword(button) {
      const field = root.document.getElementById(button.getAttribute('aria-controls'));
      if (!field || !['password', 'text'].includes(field.type)) return;
      const start = field.selectionStart, end = field.selectionEnd, direction = field.selectionDirection;
      const visible = field.type === 'password';
      field.type = visible ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(visible));
      button.setAttribute('aria-label', visible ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน');
      button.textContent = visible ? 'ซ่อน' : 'แสดง';
      field.focus({ preventScroll: true });
      if (start != null) field.setSelectionRange(start, end, direction);
    },
    async _logout() {
      await fetch(`${app.api}/auth/logout`, { method: 'POST', credentials: 'same-origin' }).catch(() => null);
      app.session = null;
      app.account = null;
      await startMode('server');
    },
    async _password() {
      if (salesAuth()) return toast('จัดการรหัสผ่านที่ RRS Sales Office', 'info');
      if (app.session && app.session.owner) return toast('ติดต่อผู้ดูแลการติดตั้งระบบเพื่อเปลี่ยนรหัสผ่านเจ้าของระบบ', 'info');
      await dialog({ title: 'เปลี่ยนรหัสผ่าน', submit: 'เปลี่ยนรหัสผ่าน',
        body: [h.field({ name: 'current', label: 'รหัสผ่านเดิม', type: 'password', required: true, wide: true }),
          h.field({ name: 'next', label: 'รหัสผ่านใหม่ (อย่างน้อย 12 ตัว)', type: 'password', required: true, wide: true })],
        onSubmit: async (v) => {
          const r = await apiCall('/auth/password', { current: v.current, next: v.next });
          if (r.ok) toast('เปลี่ยนรหัสผ่านแล้ว – เข้าสู่ระบบใหม่ทุกเครื่อง', 'ok');
          return r;
        } });
    },
    async _resetDemo() {
      const v = await dialog({ title: 'เริ่มข้อมูลตัวอย่างใหม่', submit: 'ล้างและเริ่มใหม่', danger: true,
        message: 'ล้างข้อมูลตัวอย่างในเบราว์เซอร์นี้แล้วเริ่มใหม่ (ไม่กระทบข้อมูลทีมหรือเซิร์ฟเวอร์) – เลือกเริ่มด้วยข้อมูลตัวอย่าง หรือระบบว่างเพื่อฝึกตั้งค่าเอง',
        body: h.field({ name: 'start', label: 'เริ่มด้วย', type: 'radio', value: 'sample', wide: true,
          options: [['sample', 'ข้อมูลตัวอย่างครบทุกเฟส (รหัส DEMO-…)'], ['empty', 'ระบบว่าง – มีแค่ผู้ดูแลระบบ (ฝึกตั้งค่าเอง)']] }) });
      if (!v) return;
      pref.set('demoEmpty', v.start === 'empty');
      new RRS.stores.LocalStore(DEMO_KEY).clear();
      await startMode('demo');
    },
    _toTeam: () => serverOnly() ? null : startMode('team'),
    _toDemo: () => serverOnly() ? null : startMode('demo'),
    _refresh: () => {
      app.dirty = false;
      render();
    },
  };
  const builtinForms = {
    async _login(values, form) {
      if (app.loginBusy) return;
      if (!form.reportValidity()) return;
      app.loginBusy = true;
      app.loginError = '';
      app.loginUsername = String(values.username || '').trim();
      const feedback = form.querySelector('#login-feedback');
      const status = form.querySelector('#login-status');
      const submit = form.querySelector('[type="submit"]');
      const otp = form.querySelector('#login-otp');
      feedback.hidden = true;
      status.textContent = 'กำลังตรวจสอบบัญชี…';
      form.setAttribute('aria-busy', 'true');
      submit.disabled = true;
      let success = false;
      try {
        const payload = { username: app.loginUsername, password: values.password };
        if (app.loginMfa) payload.otp = String(values.otp || '').trim();
        const r = await fetch(`${app.api}/auth/login`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload) });
        let data = null;
        try { data = await r.json(); } catch (e) { /* handled as an invalid response below */ }
        if (!r.ok || !data || data.ok === false) {
          if (r.status === 428 || (data && data.mfaRequired)) {
            app.loginMfa = true;
            form.querySelector('#login-otp-wrap').hidden = false;
            otp.disabled = false;
            otp.required = true;
            otp.value = '';
            otp.focus();
            app.loginError = 'กรอกรหัสยืนยัน 6 หลักจากแอปยืนยันตัวตน';
          } else {
            app.loginError = (data && typeof data.error === 'string' && data.error) || 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
            if (app.loginMfa) { otp.value = ''; otp.focus(); }
          }
          return;
        }
        success = true;
        form.reset();
        app.loginMfa = false;
        app.loginUsername = '';
        app.loginError = '';
        if (data.authProvider) app.authProvider = data.authProvider;
        app.dirty = false;
        await startMode('server');
      } catch (e) {
        app.loginError = 'ติดต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจการเชื่อมต่อแล้วลองอีกครั้ง';
      } finally {
        app.loginBusy = false;
        form.setAttribute('aria-busy', 'false');
        submit.disabled = false;
        submit.textContent = app.loginMfa ? 'ยืนยันและเข้าสู่ระบบ' : 'เข้าสู่ระบบ';
        status.textContent = '';
        if (!success) { feedback.textContent = app.loginError; feedback.hidden = !app.loginError; }
      }
    },
    async _bootstrap(values) {
      const r = await makeCtx('home').exec('system.bootstrap', { name: values.name, company: values.company, accountId: app.account || '' }, { public: true });
      if (r.ok) toast('เริ่มระบบแล้ว – เพิ่มคลัง สินค้า และผู้ใช้ได้เลย', 'ok');
    },
    async _access(values) {
      const r = await makeCtx('home').exec('user.requestAccess', { name: values.name, note: values.note }, { public: true });
      if (r.ok) {
        app.accessSent = true;
        toast('ส่งคำขอแล้ว', 'ok');
        render();
      }
    },
  };

  async function switchMode() {
    if (serverOnly()) return;
    const choices = [['demo', `${MODES.demo.label} – ${MODES.demo.sub}`]];
    if (app.caps.db) choices.push(['team', `${MODES.team.label} – ${MODES.team.sub}`]);
    if (root.RRS_CONFIG && root.RRS_CONFIG.api) choices.push(['server', `${MODES.server.label} – ${MODES.server.sub}`]);
    const v = await dialog({ title: 'เลือกแหล่งข้อมูล', submit: 'เปิด',
      body: t`<div class="wide radios">${choices.map(([k, l]) => t`<label class="chk"><input type="radio" name="mode" value="${k}"${safe(k === app.mode ? ' checked' : '')}> ${l}</label>`)}</div>
      ${!app.caps.db ? t`<p class="hint wide">ข้อมูลทีมใช้ได้เมื่อเปิดหน้านี้ใน claude.ai และเข้าสู่ระบบแล้ว</p>` : ''}` });
    if (v && v.mode && v.mode !== app.mode) startMode(v.mode);
  }

  // ---- events ---------------------------------------------------------------------------------------------------------
  function bind() {
    const doc = root.document;
    let liveTimer = null;
    let livePending = null;
    /** Run a filter typed less than 250 ms ago now, so a click right after typing works on the filtered list. */
    async function flushLive() {
      const p = livePending;
      clearTimeout(liveTimer);
      livePending = null;
      if (p) await p();
    }
    doc.addEventListener('click', async (ev) => {
      const el = ev.target.closest('[data-act],[data-go],[data-dlg-close],[data-mode-switch],[data-nav-toggle]');
      if (!el) return;
      // a filter typed just before: run it first. Form controls are left to their change event (a re-render here would
      // detach a checkbox / radio before its change fires); that handler flushes too.
      if (livePending && !(el.matches && el.matches('[data-live]')) && el.tagName !== 'INPUT' && el.tagName !== 'SELECT') await flushLive();
      if (el.hasAttribute('data-dlg-close')) {
        ev.preventDefault();
        return closeDialog(null);
      }
      if (el.hasAttribute('data-mode-switch')) return switchMode();
      if (el.hasAttribute('data-nav-toggle')) {
        app.navOpen = !app.navOpen;
        return renderChrome();
      }
      if (el.hasAttribute('data-go')) {
        ev.preventDefault();
        const view = el.getAttribute('data-view');
        if (view) {
          try {
            Object.assign(app.views[el.dataset.go] || (app.views[el.dataset.go] = {}), JSON.parse(view));
          } catch (e) { /* ignore */ }
        }
        return navigate(el.dataset.go);
      }
      const act = el.dataset.act;
      if (el.tagName === 'SELECT' || el.tagName === 'INPUT') return; // handled on change
      if (builtin[act]) return builtin[act](el, ev);
      const page = RRS.ui.pages[app.page];
      const fn = page && page.actions[act];
      if (!fn) return;
      ev.preventDefault();
      if (app.busy) return;
      try {
        await fn(makeCtx(page.id), el, ev);
      } catch (e) {
        if (root.console) root.console.error(e);
        toast('ทำรายการไม่สำเร็จ: ' + ((e && e.message) || e), 'bad');
      }
    });
    doc.addEventListener('change', async (ev) => {
      const el = ev.target;
      if (el.matches && el.matches('[data-who]')) {
        app.demoUser = el.value;
        pref.set('demoUser', el.value);
        return render();
      }
      if (el.closest && el.closest('#main form, #dlg')) app.dirty = true;
      const act = el.dataset && el.dataset.act;
      if (!act || !(el.tagName === 'SELECT' || el.tagName === 'INPUT') || el.hasAttribute('data-live')) return;
      if (livePending) await flushLive(); // the change has fired: the control's value / checked state is read from el
      const page = RRS.ui.pages[app.page];
      const fn = page && page.actions[act];
      if (fn) await fn(makeCtx(page.id), el, ev);
    });
    doc.addEventListener('input', (ev) => {
      const el = ev.target;
      if (el.matches && el.matches('[data-live][data-act]')) {
        clearTimeout(liveTimer);
        const run = async () => {
          if (livePending === run) livePending = null;
          const page = RRS.ui.pages[app.page];
          const fn = page && page.actions[el.dataset.act];
          if (fn) await fn(makeCtx(page.id), el, ev);
        };
        livePending = run;
        liveTimer = setTimeout(run, 250);
        return;
      }
      if (el.closest && el.closest('#main form, #dlg')) app.dirty = true;
    });
    doc.addEventListener('submit', async (ev) => {
      const form = ev.target;
      clearTimeout(liveTimer); // a filter typed just before saving must not re-render over the result
      livePending = null;
      if (form.hasAttribute('data-dlg-form')) {
        ev.preventDefault();
        return submitDialog(form);
      }
      const name = form.dataset && form.dataset.form;
      if (!name) return;
      ev.preventDefault();
      if (app.busy) return;
      const bad = h.badNumbers(form);
      if (bad) {
        toast(bad.errors.map((e) => e.message).join(' · '), 'bad');
        const first = Array.from(form.querySelectorAll('input[type="number"]')).find((x) => !x.disabled && x.validity && x.validity.badInput);
        if (first) first.focus();
        return;
      }
      const values = h.parseForm(form);
      if (!form.dataset.rid) form.dataset.rid = newRid();
      app.rid = form.dataset.rid;
      try {
        if (builtinForms[name]) await builtinForms[name](values, form);
        else {
          const page = RRS.ui.pages[app.page];
          const fn = page && page.forms[name];
          if (fn) await fn(makeCtx(page.id), values, form);
        }
      } catch (e) {
        if (root.console) root.console.error(e);
        toast('บันทึกไม่สำเร็จ: ' + ((e && e.message) || e), 'bad');
      } finally {
        app.rid = null;
      }
    });
    doc.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && dlgState) closeDialog(null);
    });
    root.addEventListener('hashchange', () => {
      const id = pageFromHash();
      if (id !== app.page) navigate(id);
    });
  }

  async function boot() {
    bind();
    app.page = pageFromHash();
    render();
    const [db, user, downloads] = await Promise.all([use('db'), use('user'), use('downloads')]);
    app.caps = { db, user, downloads };
    if (user) {
      try {
        app.account = await user.id();
      } catch (e) {
        app.account = null;
      }
    }
    if (!app.account) app.caps.db = null; // no identity: no shared data (signed out / outside the organisation)
    let mode = pref.get('mode', 'demo');
    if (mode === 'team' && !app.caps.db) mode = 'demo';
    if (mode === 'server' && !(root.RRS_CONFIG && root.RRS_CONFIG.api)) mode = 'demo';
    if (root.RRS_CONFIG && root.RRS_CONFIG.api && root.RRS_CONFIG.only !== false) mode = 'server'; // deployed on Cloudflare: server only
    await startMode(mode);
  }

  RRS.boot = boot;
  RRS.ui.PHASES = PHASES;
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
