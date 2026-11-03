// Login, sessions, password change and account credentials (Sales Office lib/rrs/auth.ts behaviour) in Miniflare.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, tempPassword, rid } from './helpers.mjs';

let s;
before(async () => {
  s = await startServer();
});
after(async () => {
  if (s) await s.dispose();
});

const GENERIC = 'เข้าสู่ระบบไม่สำเร็จ กรุณาตรวจสอบข้อมูลหรือลองใหม่ภายหลัง';

test('owner login sets a __Host- HttpOnly Secure session cookie; the session id stored is not the token', async () => {
  const r = await s.callJson('/api/auth/login', { body: { username: s.secrets.ownerUsername, password: s.secrets.ownerPassword } });
  assert.equal(r.status, 200);
  const setCookie = r.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-sq_session=[a-f0-9]{64};/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=28800']) assert.ok(setCookie.includes(flag), flag);
  assert.ok(!/Domain=/i.test(setCookie));
  const cookie = setCookie.split(';')[0];
  const token = cookie.split('=')[1];
  assert.ok(!r.text.includes(token), 'token not in the body');
  assert.equal(r.body.owner, true);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const sess = await s.callJson('/api/auth/session', { cookie });
  assert.equal(sess.status, 200);
  assert.equal(sess.body.username, s.secrets.ownerUsername);
  assert.equal(sess.body.owner, true);
  assert.equal(sess.body.user, null);
  assert.equal(sess.body.bootstrapped, false);
  const rows = (await s.d1.prepare('SELECT id FROM sq_sessions').all()).results;
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((x) => x.id !== token));
});

test('wrong username and wrong password give the same generic 401 and are audited', async () => {
  const a = await s.callJson('/api/auth/login', { body: { username: 'nobody-here', password: s.secrets.ownerPassword }, ip: '192.0.2.21' });
  const b = await s.callJson('/api/auth/login', { body: { username: s.secrets.ownerUsername, password: 'not-the-password' }, ip: '192.0.2.21' });
  const c = await s.callJson('/api/auth/login', { raw: 'not json', headers: { 'content-type': 'application/json' }, ip: '192.0.2.21' });
  for (const r of [a, b, c]) {
    assert.equal(r.status, 401);
    assert.equal(r.body.error, GENERIC);
    assert.equal(r.headers.get('set-cookie'), null);
  }
  const n = await s.d1.prepare("SELECT COUNT(*) AS n FROM sq_auth_audit WHERE event='login_failed'").first();
  assert.ok(n.n >= 3);
});

test('rate limit: the 11th attempt from one IP in 15 minutes is refused even with the right password; other IPs still log in', async () => {
  const ip = '198.51.100.7';
  for (let i = 0; i < 10; i++) {
    const r = await s.callJson('/api/auth/login', { body: { username: 'guess-' + i, password: 'wrong-password' }, ip });
    assert.equal(r.status, 401, `attempt ${i + 1}`);
  }
  const limited = await s.callJson('/api/auth/login', { body: { username: s.secrets.ownerUsername, password: s.secrets.ownerPassword }, ip });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, GENERIC);
  assert.equal(limited.headers.get('set-cookie'), null);
  const other = await s.callJson('/api/auth/login', { body: { username: s.secrets.ownerUsername, password: s.secrets.ownerPassword }, ip: '198.51.100.8' });
  assert.equal(other.status, 200);
  const ev = await s.d1.prepare("SELECT COUNT(*) AS n FROM sq_auth_audit WHERE event='rate_limited'").first();
  assert.ok(ev.n >= 1);
});

test('same-origin: login, logout and commands from another site (or without Origin) are refused', async () => {
  const creds = { username: s.secrets.ownerUsername, password: s.secrets.ownerPassword };
  for (const o of [{ origin: 'https://attacker.test' }, { origin: null }, { headers: { 'sec-fetch-site': 'cross-site' } }]) {
    const r = await s.callJson('/api/auth/login', Object.assign({ body: creds, ip: '192.0.2.30' }, o));
    assert.equal(r.status, 403, JSON.stringify(o));
    assert.equal(r.body.error, 'ไม่อนุญาตคำขอจากเว็บไซต์อื่น');
    assert.equal(r.headers.get('set-cookie'), null);
  }
  const cookie = await s.ownerLogin({ ip: '192.0.2.31' });
  const cmd = await s.callJson('/api/command', { cookie, origin: 'https://attacker.test', body: { kind: 'system.bootstrap', payload: { name: 'x' }, requestId: rid() } });
  assert.equal(cmd.status, 403);
  const out = await s.callJson('/api/auth/logout', { cookie, origin: 'https://attacker.test', body: {} });
  assert.equal(out.status, 403);
  assert.equal((await s.callJson('/api/auth/session', { cookie })).status, 200, 'session still valid after the refused logout');
  assert.equal((await s.d1.prepare('SELECT COUNT(*) AS n FROM sq_commits').first()).n, 0);
});

test('session expiry and logout end access', async () => {
  const cookie = await s.ownerLogin({ ip: '192.0.2.40' });
  assert.equal((await s.callJson('/api/auth/session', { cookie })).status, 200);
  await s.d1.prepare('UPDATE sq_sessions SET expires_at=0 WHERE revoked_at IS NULL').run();
  const expired = await s.callJson('/api/auth/session', { cookie });
  assert.equal(expired.status, 401);
  assert.equal((await s.callJson('/api/commits?after=0', { cookie })).status, 401);
  const fresh = await s.ownerLogin({ ip: '192.0.2.40' });
  const out = await s.callJson('/api/auth/logout', { cookie: fresh, body: {} });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await s.callJson('/api/auth/session', { cookie: fresh })).status, 401);
  // forged cookie
  assert.equal((await s.callJson('/api/auth/session', { cookie: '__Host-sq_session=' + 'a'.repeat(64) })).status, 401);
});

test('admin-set password must be changed; a new password ends every session of the account and the old one stops working', async () => {
  const owner = await s.ownerLogin({ ip: '192.0.2.50' });
  const temp = tempPassword();
  const created = await s.callJson('/api/admin/credentials', { cookie: owner, body: { username: 'clerk.one', password: temp } });
  assert.equal(created.status, 200, created.text);
  assert.deepEqual([created.body.created, created.body.mustChange, created.body.active], [true, true, true]);
  const c1 = await s.login('clerk.one', temp, { ip: '192.0.2.51' });
  const c2 = await s.login('clerk.one', temp, { ip: '192.0.2.52' });
  const sess = await s.callJson('/api/auth/session', { cookie: c1 });
  assert.equal(sess.body.mustChange, true);
  const blocked = await s.callJson('/api/command', { cookie: c1, body: { kind: 'kpi.record', payload: {}, requestId: rid() } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'MUST_CHANGE_PASSWORD');

  const wrong = await s.callJson('/api/auth/password', { cookie: c1, body: { current: 'wrong-current-pw', next: tempPassword() } });
  assert.equal(wrong.status, 400, 'a wrong old password is not a logout (400, not 401)');
  const short = await s.callJson('/api/auth/password', { cookie: c1, body: { current: temp, next: 'short' } });
  assert.equal(short.status, 400);
  const same = await s.callJson('/api/auth/password', { cookie: c1, body: { current: temp, next: temp } });
  assert.equal(same.status, 400);
  const next = tempPassword();
  const changed = await s.callJson('/api/auth/password', { cookie: c1, body: { current: temp, next } });
  assert.equal(changed.status, 200, changed.text);
  assert.match(changed.headers.get('set-cookie'), /Max-Age=0/);
  for (const c of [c1, c2]) assert.equal((await s.callJson('/api/auth/session', { cookie: c })).status, 401);
  const old = await s.callJson('/api/auth/login', { body: { username: 'clerk.one', password: temp }, ip: '192.0.2.53' });
  assert.equal(old.status, 401);
  const c3 = await s.login('clerk.one', next, { ip: '192.0.2.53' });
  assert.equal((await s.callJson('/api/auth/session', { cookie: c3 })).body.mustChange, false);
});

test('the owner password is set only in the Worker secret, not through the API', async () => {
  const owner = await s.ownerLogin({ ip: '192.0.2.60' });
  const r = await s.callJson('/api/auth/password', { cookie: owner, body: { current: s.secrets.ownerPassword, next: tempPassword() } });
  assert.equal(r.status, 400);
  assert.equal((await s.callJson('/api/auth/session', { cookie: owner })).status, 200);
});

test('credentials: owner or engine admin only; turning an account off ends its sessions; input is checked', async () => {
  const owner = await s.ownerLogin({ ip: '192.0.2.70' });
  const clerk = await s.account(owner, 'clerk.two');
  // no engine administrator → refused
  const refused = await s.callJson('/api/admin/credentials', { cookie: clerk.cookie, body: { username: 'someone.else', password: tempPassword() } });
  assert.equal(refused.status, 403);
  // turn off → session ends, login refused; on again → login works, password unchanged
  const off = await s.callJson('/api/admin/credentials', { cookie: owner, body: { username: 'clerk.two', active: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.active, false);
  assert.equal((await s.callJson('/api/auth/session', { cookie: clerk.cookie })).status, 401);
  assert.equal((await s.callJson('/api/auth/login', { body: { username: 'clerk.two', password: clerk.password }, ip: '192.0.2.71' })).status, 401);
  const on = await s.callJson('/api/admin/credentials', { cookie: owner, body: { username: 'clerk.two', active: true } });
  assert.equal(on.status, 200);
  assert.equal(on.body.mustChange, false);
  await s.login('clerk.two', clerk.password, { ip: '192.0.2.72' });
  // input checks
  const bad = [
    { username: s.secrets.ownerUsername, password: tempPassword() },
    { username: 'ab', password: tempPassword() },
    { username: 'has space', password: tempPassword() },
    { username: 'new.person' },
    { username: 'new.person', password: 'short' },
    { username: 'new.person', password: 'new.person-pass-1' },
    { username: 'new.person', password: tempPassword(), role: 'admin' },
    { username: 'clerk.two', active: 'yes' },
  ];
  for (const body of bad) {
    const r = await s.callJson('/api/admin/credentials', { cookie: owner, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  // an engine admin who is not the owner may manage accounts too
  await s.ok(owner, 'system.bootstrap', { name: 'เจ้าของ', userId: 'ADMIN' });
  const second = await s.account(owner, 'second.admin');
  await s.ok(owner, 'user.upsert', { id: 'ADMIN2', name: 'ผู้ดูแลคนที่สอง', roles: ['admin'], accountId: 'second.admin' });
  const byAdmin = await s.callJson('/api/admin/credentials', { cookie: second.cookie, body: { username: 'third.user', password: tempPassword() } });
  assert.equal(byAdmin.status, 200, byAdmin.text);
  const ev = await s.d1.prepare("SELECT detail FROM sq_security_events WHERE event='credentials_set'").all();
  assert.ok(ev.results.some((e) => e.detail.startsWith('second.admin → third.user')));
});

test('no password, password hash, session secret or session token is stored in audit/session/event tables', async () => {
  const cookie = await s.ownerLogin({ ip: '192.0.2.80' });
  const token = cookie.split('=')[1];
  for (const table of ['sq_auth_audit', 'sq_sessions', 'sq_security_events', 'sq_auth_limits', 'sq_commits', 'sq_records']) {
    const dump = JSON.stringify((await s.d1.prepare(`SELECT * FROM ${table}`).all()).results);
    for (const secret of [s.secrets.ownerPassword, s.secrets.ownerHash, s.secrets.sessionSecret, token]) assert.ok(!dump.includes(secret), table);
  }
  const users = (await s.d1.prepare('SELECT password_hash FROM sq_app_users').all()).results;
  assert.ok(users.every((u) => /^\$2[ab]\$12\$/.test(u.password_hash)), 'app passwords stored only as bcrypt cost 12');
});

test('not configured: login answers 503, sessions are never valid, health says login is not ready', async () => {
  const bare = await startServer({ bindings: { ADMIN_USERNAME: '', ADMIN_PASSWORD_HASH: '', SESSION_SECRET: '' } });
  try {
    const r = await bare.callJson('/api/auth/login', { body: { username: '', password: 'x' } });
    assert.equal(r.status, 503);
    assert.equal((await bare.callJson('/api/auth/session', { cookie: '__Host-sq_session=' + 'b'.repeat(64) })).status, 401);
    assert.equal((await bare.callJson('/api/health')).body.features.login, false);
    const weak = await startServer({ bindings: { SESSION_SECRET: 'too-short' } });
    try {
      const w = await weak.callJson('/api/auth/login', { body: { username: weak.secrets.ownerUsername, password: weak.secrets.ownerPassword } });
      assert.equal(w.status, 503, 'SESSION_SECRET shorter than 32 characters is refused');
    } finally {
      await weak.dispose();
    }
  } finally {
    await bare.dispose();
  }
});
