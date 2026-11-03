// Smoke the exact single-file MCP package, including its embedded ASSETS implementation.
// Run `node scripts/build-mcp.mjs` before this test. No network or real credentials are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { applyMigrations, COMPAT_DATE } from './helpers.mjs';

test('MCP package serves the independent login and enforces local accounts and stock permissions', async (t) => {
  const ownerName = 'Nexus.Owner';
  const password = randomBytes(18).toString('hex');
  const passwordHash = await bcrypt.hash(password, 12);
  const upstreamCalls = [];
  const blocked = [];
  const mf = new Miniflare({
    workers: [{
      name: 'stock-mcp', modules: true,
      script: fs.readFileSync(new URL('../.deploy/worker.js', import.meta.url), 'utf8'),
      compatibilityDate: COMPAT_DATE, compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: 'stock-mcp-test' }, r2Buckets: { BUCKET: 'stock-mcp-test' },
      bindings: { SQ_AUTH_PROVIDER: 'local', ADMIN_USERNAME: ownerName, ADMIN_PASSWORD_HASH: passwordHash,
        SESSION_SECRET: randomBytes(48).toString('hex'), SQ_ENV: 'test',
        SQ_SALES_BRIDGE: 'off', SQ_DRIVE_BACKUP_ENABLED: 'false' },
      serviceBindings: { SALES_AUTH: async (req) => {
        upstreamCalls.push({ url: req.url, cookie: req.headers.get('cookie') });
        return Response.json({ error: 'Independent login must never call Sales Office' }, {status:500});
      } },
      outboundService: (req) => { blocked.push(req.url); return new Response('Network blocked', { status: 599 }); },
    }],
    cf: false, log: new Log(LogLevel.ERROR),
  });
  t.after(() => mf.dispose());
  await mf.ready;
  const d1 = await mf.getD1Database('DB', 'stock-mcp');
  await applyMigrations(d1);
  const base = 'https://nexuspart-terminal.com';
  const get = (p, options) => mf.dispatchFetch(base + p, options);

  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /NEXUS/);
  assert.match(html, /เข้าสู่ระบบ/);
  assert.match(html, /RRS_CONFIG\s*=\s*\{\s*api:\s*["']\/api["']/);
  assert.match(html, /autocomplete="current-password"/);

  for (const p of ['/artifact', '/artifact.html', '/artifact/', '/unknown.html', '/login.html']) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.headers.get('content-type') || '', /text\/html/, p);
    await r.body?.cancel();
  }
  const post = await get('/', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  await post.body?.cancel();
  const head = await get('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const unauthenticated = await get('/api/auth/session');
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get('cache-control'), 'no-store');
  const noSession = await unauthenticated.json();
  assert.equal(noSession.authProvider, 'local');
  assert.equal(noSession.configured, true);
  assert.equal(upstreamCalls.length, 0);

  const postJson = (p, body, cookie) => get(p, {method:'POST', headers:{Origin:base,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  const login = await postJson('/api/auth/login', {username:ownerName.toUpperCase(),password});
  assert.equal(login.status,200);
  const ownerCookie = login.headers.get('set-cookie').split(';')[0];
  const loginBody = await login.json();
  assert.equal(loginBody.username,ownerName);
  const sessionRes = await get('/api/auth/session', { headers: { Cookie: ownerCookie } });
  assert.equal(sessionRes.status, 200);
  const session = await sessionRes.json();
  assert.equal(session.username, ownerName);
  assert.equal(session.owner, true);
  assert.equal(session.authProvider, 'local');
  assert.equal(session.user, null);

  const listed = await get('/api/admin/credentials', {headers:{Cookie:ownerCookie}});
  assert.equal(listed.status,200);
  assert.equal((await listed.json()).users[0].username,ownerName);
  const staffPassword = randomBytes(18).toString('hex');
  const created = await postJson('/api/admin/credentials',{username:'Clerk.One',password:staffPassword},ownerCookie);
  assert.equal(created.status,200);
  await created.body?.cancel();
  const staffLogin = await postJson('/api/auth/login',{username:'clerk.one',password:staffPassword});
  assert.equal(staffLogin.status,200);
  const staffCookie = staffLogin.headers.get('set-cookie').split(';')[0];
  await staffLogin.body?.cancel();
  const commits = await get('/api/commits?after=0', { headers: { Cookie: staffCookie } });
  assert.equal(commits.status, 403);
  const denied = await commits.json();
  assert.equal(denied.code, 'NO_USER');
  assert.equal(denied.commits, undefined);
  const logout = await postJson('/api/auth/logout',{},ownerCookie);
  assert.equal(logout.status,200);
  await logout.body?.cancel();
  assert.equal((await get('/api/auth/session',{headers:{Cookie:ownerCookie}})).status,401);
  assert.equal(upstreamCalls.length, 0);
  assert.deepEqual(blocked, []);
});
