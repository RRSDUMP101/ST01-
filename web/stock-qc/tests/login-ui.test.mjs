// Exercise the actual login controller against mocked HTTP responses without browser or production credentials.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8')
  .replace('RRS.boot = boot;', 'RRS.testLogin = { builtinForms, serverSession, userChip, renderLogin, switchMode }; RRS.boot = boot;');

function setup(fetcher) {
  const h = { t: (parts, ...values) => parts.map((p, i) => p + (values[i] ?? '')).join(''), safe: (x) => x,
    btn: (label) => `<button>${label}</button>` };
  const root = { RRS: { ui: { h, pages: {} }, stores: { RemoteLedger: class {} } }, RRS_CONFIG: { api: '/api' }, fetch: fetcher,
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Promise };
  vm.runInNewContext(source, root);
  root.document = { querySelector: () => null };
  Object.assign(root.RRS.app, { mode: 'server', api: '/api', authProvider: 'sales-office' });
  const els = Object.fromEntries(['#login-feedback', '#login-status', '[type="submit"]', '#login-otp', '#login-otp-wrap']
    .map((k) => [k, { hidden: true, disabled: k === '#login-otp', value: '', textContent: '', focus() { this.focused = true; } }]));
  const form = { querySelector: (k) => els[k], reportValidity: () => true, setAttribute() {}, reset() { this.wasReset = true; } };
  return { root, app: root.RRS.app, api: root.RRS.testLogin, form, els };
}

test('MFA challenge keeps the form and then sends the entered code without persisting credentials', async () => {
  const calls = [];
  let n = 0;
  const f = setup(async (url, options) => {
    calls.push({ url, options });
    n++;
    if (n === 1) return new Response(JSON.stringify({ error: 'OTP required' }), { status: 428 });
    if (n === 2) return new Response(JSON.stringify({ ok: true, authProvider: 'sales-office' }));
    return new Response(JSON.stringify({ ok: true, username: 'store1', owner: false, user: null, authProvider: 'sales-office' }));
  });
  await f.api.builtinForms._login({ username: 'store1', password: 'only-in-form' }, f.form);
  assert.equal(f.app.loginMfa, true);
  assert.equal(f.els['#login-otp-wrap'].hidden, false);
  assert.equal(f.els['#login-otp'].required, true);
  assert.equal(f.form.wasReset, undefined);
  assert.equal(JSON.stringify(f.app).includes('only-in-form'), false);
  await f.api.builtinForms._login({ username: 'store1', password: 'only-in-form', otp: '012345' }, f.form);
  assert.deepEqual(JSON.parse(calls[1].options.body), { username: 'store1', password: 'only-in-form', otp: '012345' });
  assert.equal(calls[1].options.credentials, 'same-origin');
  assert.equal(f.form.wasReset, true);
  assert.equal(f.app.loginMfa, false);
  assert.equal(f.app.noAccess, true);
  assert.equal(f.app.account, 'store1');
});

test('repeated submit while authentication is pending sends only one request', async () => {
  let finish;
  let calls = 0;
  const f = setup(() => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  const first = f.api.builtinForms._login({ username: 'store1', password: 'password' }, f.form);
  assert.equal(f.els['[type="submit"]'].disabled, true);
  await f.api.builtinForms._login({ username: 'store1', password: 'password' }, f.form);
  assert.equal(calls, 1);
  finish(new Response(JSON.stringify({ error: 'Invalid account' }), { status: 401 }));
  await first;
  assert.equal(f.els['[type="submit"]'].disabled, false);
  assert.equal(f.els['#login-feedback'].textContent, 'Invalid account');
});

test('network error restores login controls and does not start a session', async () => {
  const f = setup(async () => { throw new Error('offline'); });
  await f.api.builtinForms._login({ username: 'store1', password: 'password' }, f.form);
  assert.equal(f.app.loginBusy, false);
  assert.equal(f.els['[type="submit"]'].disabled, false);
  assert.equal(f.els['#login-feedback'].hidden, false);
  assert.equal(f.app.session, undefined);
});

test('401 session metadata identifies Sales Office and removes local password controls', async () => {
  const f = setup(async () => new Response(JSON.stringify({ authProvider: 'sales-office' }), { status: 401 }));
  f.app.authProvider = undefined;
  assert.equal(await f.api.serverSession(), null);
  assert.equal(f.app.authProvider, 'sales-office');
  f.app.session = { username: 'store1' };
  const html = String(f.api.userChip(null));
  assert.equal(html.includes('เปลี่ยนรหัสผ่าน'), false);
  assert.equal(html.includes('ออกจากระบบ'), true);
  await f.api.switchMode(); // locked server deployment must not open a demo-mode chooser
});

test('login form includes accessible credential autocomplete and Sales Office identity', () => {
  const f = setup(async () => null);
  const main = { innerHTML: '', querySelector: () => null };
  f.api.renderLogin(main);
  assert.match(main.innerHTML, /autocomplete="username"/);
  assert.match(main.innerHTML, /autocomplete="current-password"/);
  assert.match(main.innerHTML, /autocomplete="one-time-code"/);
  assert.match(main.innerHTML, /aria-live="polite"/);
  assert.match(main.innerHTML, /RRS Sales Office/);
  assert.doesNotMatch(main.innerHTML, /_toDemo|data-mode-switch/);
});
