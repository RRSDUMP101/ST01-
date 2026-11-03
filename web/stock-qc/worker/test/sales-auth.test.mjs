import test from 'node:test';
import assert from 'node:assert/strict';
import * as auth from '../src/sales-auth.js';
import * as entryAuth from '../src/auth.js';

const origin = 'https://sales.example.com', local = 'https://nexuspart-terminal.com';
const token = 'a'.repeat(64);
const cookie = `__Host-rrs_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`;
const session = (more = {}) => ({ username: 'alice', role: 'sales', expiresAt: new Date(Date.now() + 3600000).toISOString(), ...more });
const json = (v, status = 200, headers = {}) => Response.json(v, { status, headers });
const envFor = fetch => ({ SQ_AUTH_PROVIDER: 'sales-office', SQ_AUTH_ORIGIN: origin, SALES_AUTH: { fetch } });
function request(path = '/api/auth/login', body = { username: 'alice', password: 'secret', otp: '123456' }, headers = {}) {
  return new Request(local + path, { method: body === null ? 'GET' : 'POST',
    headers: { Origin: local, 'Content-Type': 'application/json', ...headers }, body: body === null ? undefined : JSON.stringify(body) });
}

test('configuration requires explicit valid provider, HTTPS origin and service binding; unknown providers select fail-closed mode', () => {
  const env = envFor(() => {});
  assert.equal(auth.configuration(env).ready, true);
  for (const patch of [{ SALES_AUTH: null }, { SQ_AUTH_ORIGIN: 'http://sales.example.com' },
    { SQ_AUTH_ORIGIN: origin + '/path' }, { SQ_AUTH_ORIGIN: origin + '/' }, { SQ_AUTH_ORIGIN: 'https://u:p@sales.example.com' },
    { SQ_AUTH_PROVIDER: 'sales-office-typo' }]) assert.equal(auth.configuration({ ...env, ...patch }).ready, false);
  assert.equal(auth.externalAuthSelected({ SQ_AUTH_PROVIDER: 'typo' }), true);
  assert.equal(auth.externalAuthSelected({}), false);
  assert.equal(auth.externalAuthSelected({ SQ_AUTH_PROVIDER: 'local' }), false);
});

test('login relays only allowlisted credential fields and cookie, then maps session without copying upstream permissions', async () => {
  const calls = [];
  const env = envFor(async req => {
    calls.push(req);
    if (calls.length === 1) {
      assert.deepEqual(await req.json(), { username: 'alice', password: 'secret', otp: '123456' });
      assert.equal(req.url, origin + '/api/auth/login');
      assert.equal(req.headers.get('origin'), origin);
      assert.equal(req.headers.get('sec-fetch-site'), 'same-origin');
      assert.equal(req.headers.get('cookie'), `__Host-rrs_session=${token}`);
      assert.equal(req.headers.get('authorization'), null);
      assert.equal(req.headers.get('x-forwarded-for'), null);
      assert.equal(req.headers.get('cf-connecting-ip'), '192.0.2.1');
      assert.equal(req.redirect, 'manual');
      return json({ ok: true }, 200, { 'Set-Cookie': cookie });
    }
    assert.equal(req.url, origin + '/api/auth/session');
    return json(session({ permissions: { production: 'use' } }));
  });
  const r = await auth.login(env, request(undefined, { username: 'alice', password: 'secret', otp: '123456', role: 'owner' },
    { Cookie: `other=bad; __Host-sq_session=${token}`, Authorization: 'Bearer attacker', 'X-Forwarded-For': 'attacker', 'CF-Connecting-IP': '192.0.2.1' }));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.username, 'alice'); assert.equal(body.owner, false); assert.equal(body.mustChange, false);
  assert.equal(body.authProvider, 'sales-office'); assert.equal(body.permissions, undefined);
  assert.match(r.headers.get('set-cookie'), /^__Host-sq_session=[a-f0-9]{64}; HttpOnly; Secure; SameSite=Lax; Path=\//);
  assert.doesNotMatch(r.headers.get('set-cookie'), /Domain=/i);
  assert.equal(calls.length, 2);
});

test('cross-origin login/logout never reach binding', async () => {
  const env = envFor(() => { throw Error('must not call'); });
  for (const headers of [{ Origin: 'https://attacker.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    await assert.rejects(() => auth.login(env, request(undefined, {}, headers)), e => e.status === 403);
    await assert.rejects(() => auth.logout(env, request('/api/auth/logout', {}, headers)), e => e.status === 403);
  }
});

test('MFA and rate limits preserve upstream status/message without issuing cookie', async () => {
  for (const status of [401, 428, 429]) {
    const env = envFor(() => json({ error: status === 428 ? 'ต้องยืนยันรหัส MFA' : 'try later' }, status, { 'Retry-After': '900', 'Set-Cookie': cookie }));
    const res = await auth.login(env, request());
    assert.equal(res.status, status); assert.equal(res.headers.get('set-cookie'), null);
    assert.equal((await res.json()).error, status === 428 ? 'ต้องยืนยันรหัส MFA' : 'try later');
    assert.equal(res.headers.get('retry-after'), status === 429 ? '900' : null);
  }
});

test('upstream redirects/errors/malformed responses fail closed, no external fetch fallback', async () => {
  for (const handler of [() => { throw Error('network token secret'); }, () => Response.redirect('https://attacker.example'),
    () => new Response('bad response'), () => json({ ok: true }, 200),
    () => json({ ok: true }, 200, { 'Set-Cookie': cookie + '; Domain=example.com' })]) {
    await assert.rejects(() => auth.login(envFor(handler), request()), e => e.status === 503 && !e.message.includes('token secret'));
  }
  await assert.rejects(() => auth.getSession({ SQ_AUTH_PROVIDER: 'sales-office' }, request('/api/auth/session', null)), e => e.status === 503);
});

test('session cookie parsing rejects missing, duplicate, malformed and foreign cookies', async () => {
  let calls = 0;
  const env = envFor(() => { calls++; return json(session()); });
  for (const c of ['', `__Host-rrs_session=${token}`, '__Host-sq_session=wrong',
    `__Host-sq_session=${token}; __Host-sq_session=${token}`]) {
    assert.equal(await auth.getSession(env, request('/api/auth/session', null, { Cookie: c })), null);
  }
  assert.equal(calls, 0);
});

test('session role mapping grants owner only for actual owner; expiry and username validation fail closed', async () => {
  for (const role of ['owner', 'executive', 'sales', 'documents', 'viewer']) {
    const s = await auth.getSession(envFor(() => json(session({ role }))), request('/api/auth/session', null, { Cookie: `__Host-sq_session=${token}` }));
    assert.equal(s.owner, role === 'owner'); assert.equal(s.mustChange, false); assert.equal(s.username, 'alice');
    assert.notEqual(s.id, token); assert.match(s.id, /^[a-f0-9]{64}$/);
  }
  for (const patch of [{ role: 'admin' }, { username: '__proto__' }, { username: '' }, { expiresAt: 'broken' },
    { expiresAt: new Date(Date.now() - 1000).toISOString() }, { expiresAt: new Date(Date.now() + 86400000).toISOString() }]) {
    assert.equal(await auth.getSession(envFor(() => json(session(patch))), request('/api/auth/session', null, { Cookie: `__Host-sq_session=${token}` })), null);
  }
});

test('revoked session rechecked every time, upstream outage does not act as a valid session', async () => {
  let valid = true;
  const env = envFor(() => valid ? json(session()) : json({ error: 'revoked' }, 401));
  const req = request('/api/auth/session', null, { Cookie: `__Host-sq_session=${token}` });
  assert.ok(await auth.getSession(env, req)); valid = false;
  assert.equal(await auth.getSession(env, req), null);
  await assert.rejects(() => auth.getSession(envFor(() => json({ error: 'down' }, 503)), req), e => e.status === 503);
});

test('logout revokes upstream token and clears isolated local cookie; already revoked also clears', async () => {
  for (const status of [200, 401]) {
    const env = envFor(req => { assert.equal(req.url, origin + '/api/auth/logout');
      assert.equal(req.headers.get('cookie'), `__Host-rrs_session=${token}`); return json({}, status); });
    const res = await auth.logout(env, request('/api/auth/logout', {}, { Cookie: `__Host-sq_session=${token}` }));
    assert.equal(res.status, 200); assert.match(res.headers.get('set-cookie'), /^__Host-sq_session=;.*Max-Age=0/);
  }
});

test('credential administration is explicitly delegated to Sales Office', () => {
  assert.throws(() => auth.managedCredentials(), e => e.status === 409 && e.extra.code === 'AUTH_MANAGED_BY_SALES_OFFICE');
});

test('auth entrypoints dispatch to shared provider while retaining local login rate limit and rejecting local credential mutation', async () => {
  let queries = [], attempts = 0, upstreamCalls = 0;
  const env = envFor(req => {
    upstreamCalls++;
    return new URL(req.url).pathname.endsWith('/login') ? json({ ok: true }, 200, { 'Set-Cookie': cookie }) : json(session());
  });
  env.DB = {
    prepare(sql) {
      queries.push(sql);
      assert.match(sql, /sq_auth_limits|sq_auth_audit/);
      return { bind() { return this; }, async run() { return {}; } };
    },
    async batch() { attempts++; return [{ results: [{ count: attempts }] }, { results: [{ count: attempts }] }]; },
  };
  assert.equal(entryAuth.authConfiguration(env).ready, true);
  assert.equal((await entryAuth.login(env, request())).status, 200);
  assert.equal(attempts, 1);
  assert.equal(upstreamCalls, 2);
  const s = await entryAuth.getSession(env, request('/api/auth/session', null, { Cookie: `__Host-sq_session=${token}` }));
  assert.equal(s.owner, false);
  attempts = 10;
  await assert.rejects(() => entryAuth.login(env, request()), e => e.status === 429);
  assert.equal(upstreamCalls, 3, 'rate limited login must never call the service');
  await assert.rejects(() => entryAuth.changePassword(env, request()), e => e.status === 409);
  await assert.rejects(() => entryAuth.setCredentials(env, request(), { owner: true }), e => e.status === 409);
  const broken = { ...env, SQ_AUTH_PROVIDER: 'wrong' };
  assert.equal(entryAuth.authConfiguration(broken).ready, false);
  await assert.rejects(() => entryAuth.login(broken, request()), e => e.status === 503);
});
