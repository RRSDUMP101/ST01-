// Smoke the exact single-file MCP package, including its embedded ASSETS implementation.
// Run `node scripts/build-mcp.mjs` before this test. No network or real credentials are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { applyMigrations, COMPAT_DATE } from './helpers.mjs';

test('MCP package serves only the server page and enforces Sales Office authentication and stock permissions', async (t) => {
  const token = 'a'.repeat(64);
  const upstreamCalls = [];
  const blocked = [];
  const mf = new Miniflare({
    workers: [{
      name: 'stock-mcp', modules: true,
      script: fs.readFileSync(new URL('../.deploy/worker.js', import.meta.url), 'utf8'),
      compatibilityDate: COMPAT_DATE, compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: 'stock-mcp-test' }, r2Buckets: { BUCKET: 'stock-mcp-test' },
      bindings: { SQ_AUTH_PROVIDER: 'sales-office', SQ_AUTH_ORIGIN: 'https://sales.example.com', SQ_ENV: 'test',
        SQ_SALES_BRIDGE: 'off', SQ_DRIVE_BACKUP_ENABLED: 'false' },
      serviceBindings: { SALES_AUTH: async (req) => {
        upstreamCalls.push({ url: req.url, cookie: req.headers.get('cookie') });
        assert.equal(req.url, 'https://sales.example.com/api/auth/session');
        assert.equal(req.headers.get('cookie'), `__Host-rrs_session=${token}`);
        return Response.json({ username: 'viewer1', role: 'viewer', expiresAt: new Date(Date.now() + 3600000).toISOString() });
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
  assert.match(html, /RRS Sales Office/);
  assert.match(html, /RRS_CONFIG\s*=\s*\{\s*api:\s*["']\/api["']/);
  assert.match(html, /autocomplete="one-time-code"/);
  assert.match(html, /login-otp/);

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
  assert.equal(noSession.authProvider, 'sales-office');
  assert.equal(noSession.configured, true);
  assert.equal(upstreamCalls.length, 0);

  const sessionRes = await get('/api/auth/session', { headers: { Cookie: `__Host-sq_session=${token}` } });
  assert.equal(sessionRes.status, 200);
  const session = await sessionRes.json();
  assert.equal(session.username, 'viewer1');
  assert.equal(session.owner, false);
  assert.equal(session.authProvider, 'sales-office');
  assert.equal(session.user, null);

  const commits = await get('/api/commits?after=0', { headers: { Cookie: `__Host-sq_session=${token}` } });
  assert.equal(commits.status, 403);
  const denied = await commits.json();
  assert.equal(denied.code, 'NO_USER');
  assert.equal(denied.commits, undefined);
  assert.equal(upstreamCalls.length, 2);
  assert.deepEqual(blocked, []);
});
