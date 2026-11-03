// Run the real page controller and safe HTML helpers, with only the network/ledger boundaries replaced.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function setup({ users = [], credentials = [], actor, apiResult, engineResult } = {}) {
  const root = { console, TextEncoder, setTimeout, clearTimeout };
  vm.createContext(root);
  for (const path of ['engine/core.js', 'ui/kit.js', 'ui/pages/05-users.js']) {
    vm.runInContext(readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'), root, { filename: path });
  }
  const RRS = root.RRS;
  RRS.app = { authProvider: 'local', session: { username: 'owner', owner: true } };
  const admin = vm.runInContext('JSON.parse(' + JSON.stringify(JSON.stringify(actor ||
    { id: 'ADMIN', name: 'Admin', active: true, roles: ['admin'], accountId: 'owner', warehouses: [] })) + ')', root);
  const state = RRS.core.createState();
  state.tables.users = Object.fromEntries([admin, ...users].map((u) => [u.id, u]));
  const calls = [], messages = [];
  const ctx = { RRS, h: RRS.ui.h, state, user: admin, server: true, mode: 'server',
    view: { sel: '__new', credentialsLoaded: true, credentials: [{ username: 'owner', owner: true, active: true }, ...credentials] },
    can: (p) => RRS.auth.can(admin, p), userName: (id) => id,
    set(patch) { Object.assign(this.view, patch); },
    toast(message, tone) { messages.push({ message, tone }); }, confirm: async () => true,
    async exec(kind, payload) {
      calls.push({ type: 'engine', kind, payload: JSON.parse(JSON.stringify(payload)) });
      if (engineResult) return engineResult;
      state.tables.users[payload.id] = { ...payload };
      return { ok: true };
    },
    async api(path, body) {
      calls.push({ type: 'api', path, body: body ? JSON.parse(JSON.stringify(body)) : undefined });
      if (!body) return { ok: true, users: ctx.view.credentials };
      return apiResult || { ok: true, username: body.username, active: body.active, mustChange: true, created: true };
    },
  };
  const input = { value: 'one-use-secret', type: 'password' };
  const form = { reportValidity: () => true, querySelector: (selector) => selector === '[name="password"]' ? input : null };
  const vals = { id: 'Store.One', name: 'Store Person', position: 'คลังสินค้า', roles: ['viewer'], permissionMode: 'custom',
    permissions: ['doc.draft', 'files.upload'], warehouses: [], active: true, password: 'LongTemporary!938' };
  return { root, RRS, ctx, calls, messages, form, input, vals, page: RRS.ui.pages.users };
}

test('new local account saves selected action grants then credentials, never a password in the ledger/view', async () => {
  const f = setup();
  await f.page.forms.saveUser(f.ctx, f.vals, f.form);
  assert.equal(f.calls[0].type, 'engine');
  assert.equal(f.calls[0].payload.id, 'STORE.ONE');
  assert.equal(f.calls[0].payload.accountId, 'Store.One');
  assert.equal(f.calls[0].payload.position, 'คลังสินค้า');
  assert.equal(f.calls[0].payload.permissions['doc.draft'], true);
  assert.equal(f.calls[0].payload.permissions['files.upload'], true);
  assert.equal(f.calls[0].payload.permissions['doc.post'], false);
  assert.equal('password' in f.calls[0].payload, false);
  assert.deepEqual(f.calls[1].body, { username: 'Store.One', active: true, password: 'LongTemporary!938' });
  assert.equal(JSON.stringify(f.ctx.view).includes('LongTemporary'), false);
  assert.equal('password' in f.vals, false);
  assert.equal(f.input.value, '');
  assert.equal(f.ctx.view.savePartial, false);
});

test('credential failure accurately reports the saved permission change and clears the password', async () => {
  const f = setup({ apiResult: { ok: false, errors: [{ message: 'บัญชีถูกแก้ไขพร้อมกัน' }] } });
  await f.page.forms.saveUser(f.ctx, f.vals, f.form);
  assert.equal(f.ctx.view.sel, 'STORE.ONE');
  assert.equal(f.ctx.view.savePartial, true);
  assert.match(f.ctx.view.saveNotice, /บันทึกข้อมูลผู้ใช้และสิทธิ์แล้ว/);
  assert.match(f.ctx.view.saveNotice, /ยังบันทึกบัญชีเข้าสู่ระบบไม่สำเร็จ/);
  assert.equal(f.messages.some((m) => m.tone === 'ok'), false);
  assert.equal(f.calls.filter((c) => c.type === 'api' && c.body).length, 1);
  assert.equal(f.input.value, '');
});

test('an engine rejection cannot create or reset a login account', async () => {
  const f = setup({ engineResult: { ok: false } });
  await f.page.forms.saveUser(f.ctx, f.vals, f.form);
  assert.equal(f.calls.length, 1);
  assert.equal(f.input.value, '');
});

test('existing identities stay canonical and a blank password preserves the current credential', async () => {
  const user = { id: 'LEGACY_1', name: 'Original', active: true, roles: ['viewer'], accountId: 'Staff.Mixed', warehouses: [] };
  const f = setup({ users: [user], credentials: [{ username: 'Staff.Mixed', active: true, owner: false }] });
  f.ctx.view.sel = user.id;
  Object.assign(f.vals, { id: 'renamed', accountId: 'renamed', password: '', permissionMode: 'roles' });
  await f.page.forms.saveUser(f.ctx, f.vals, f.form);
  assert.equal(f.calls[0].payload.id, 'LEGACY_1');
  assert.equal(f.calls[0].payload.accountId, 'Staff.Mixed');
  assert.equal(f.calls[0].payload.permissions, null);
  assert.deepEqual(f.calls[1].body, { username: 'Staff.Mixed', active: true });
});

test('owner identity comes from safe credential metadata and never calls the staff credential endpoint', async () => {
  const f = setup();
  f.ctx.view.sel = 'ADMIN';
  Object.assign(f.vals, { id: 'ADMIN', accountId: 'owner', roles: ['admin'], password: '' });
  await f.page.forms.saveUser(f.ctx, f.vals, f.form);
  assert.equal(f.calls.length, 1);
  const markup = String(f.page.render(f.ctx));
  assert.match(markup, /บัญชีเจ้าของระบบ/);
  assert.doesNotMatch(markup, /id="user-password"/);
});

test('a delegated user manager can edit grants without credential fields or API calls', async () => {
  const actor = { id: 'LEAD', active: true, name: 'Lead', roles: ['viewer'], permissions: { 'users.manage': true, 'doc.draft': true }, warehouses: [] };
  const f = setup({ actor });
  f.RRS.app.session = { username: 'lead', owner: false };
  f.vals.password = '';
  f.vals.permissions = ['doc.draft'];
  const markup = String(f.page.render(f.ctx));
  assert.doesNotMatch(markup, /id="user-password"/);
  assert.match(markup, /ผู้ดูแลระบบเป็นผู้สร้างบัญชี/);
  await f.page.forms.saveUser(f.ctx, f.vals, f.form);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].payload.permissions['doc.draft'], true);
});

test('editor lists every known action, escapes names, and blocks account editing before metadata is ready', () => {
  const f = setup();
  f.ctx.view.prefill = { name: '<script>bad()</script>' };
  const markup = String(f.page.render(f.ctx));
  assert.equal((markup.match(/name="permissions\[\]"/g) || []).length, Object.keys(f.RRS.auth.PERMS).length);
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /autocomplete="new-password" minlength="12"/);
  f.ctx.view.credentialsLoaded = false;
  const loading = String(f.page.render(f.ctx));
  assert.doesNotMatch(loading, /data-form="saveUser"/);
  assert.match(loading, /กำลังอ่านสถานะบัญชี/);
});

test('short passwords and malformed usernames are rejected before changing either store', async () => {
  const f = setup();
  f.vals.password = 'short';
  await f.page.forms.saveUser(f.ctx, f.vals, f.form);
  assert.equal(f.calls.length, 0);
  f.vals.password = 'LongTemporary!938';
  f.vals.id = 'AB';
  await f.page.forms.saveUser(f.ctx, f.vals, f.form);
  assert.equal(f.calls.length, 0);
});
