// Health, security headers on every API response, the page through the Worker, unknown routes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, tempDir, rid } from './helpers.mjs';

let s;
let assets;
before(async () => {
  assets = tempDir('assets');
  fs.writeFileSync(path.join(assets, 'index.html'), '<!doctype html><html lang="th"><body><main id="main">RRS Stock &amp; QC</main></body></html>');
  fs.writeFileSync(path.join(assets, 'artifact.html'), '<div>artifact build</div>');
  s = await startServer({ assetsDir: assets, bindings: { SQ_SALES_URL: 'https://sales.invalid', SQ_SALES_DOMESTIC_SECRET: 'x'.repeat(40) } });
});
after(async () => {
  if (s) await s.dispose();
  fs.rmSync(assets, { recursive: true, force: true });
});

test('health says which features are configured, never a value; every flag is off by default', async () => {
  const r = await s.callJson('/api/health');
  assert.equal(r.status, 200);
  const f = r.body.features;
  assert.equal(f.login, true);
  assert.equal(f.database, 'ready');
  assert.equal(f.files, true);
  assert.equal(f.page, true);
  assert.deepEqual(f.driveBackup, { enabled: false, configured: false, built: true });
  assert.equal(f.salesBridge.mode, 'off');
  assert.equal(f.salesBridge.built, true);
  assert.ok(r.body.engine.files.includes('sales.js'));
  assert.equal(f.salesBridge.configured, false, 'only some connector values present');
  assert.ok(r.body.engine.files.includes('core.js') && r.body.engine.files.includes('inventory.js'));
  for (const v of [s.secrets.ownerUsername, s.secrets.ownerHash, s.secrets.sessionSecret, 'sales.invalid', 'x'.repeat(40)]) assert.ok(!r.text.includes(v), 'health leaks ' + v.slice(0, 6));
});

test('every API response carries no-store, nosniff, no-referrer and no framing', async () => {
  const responses = [
    await s.call('/api/health'),
    await s.call('/api/auth/session'),
    await s.call('/api/nope'),
    await s.call('/api/auth/login', { body: {}, origin: 'https://attacker.test' }),
    await s.call('/api/command', { body: { kind: 'x', payload: {}, requestId: rid() } }),
    await s.call('/api/commits?after=0'),
  ];
  for (const r of responses) {
    assert.equal(r.headers.get('cache-control'), 'no-store', r.url);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.match(r.headers.get('content-type'), /^application\/json/);
  }
  assert.deepEqual(responses.map((r) => r.status), [200, 401, 404, 403, 401, 401]);
});

test('the page goes through the Worker with frame-ancestors none; the artifact build is not served', async () => {
  const page = await s.call('/', { origin: null });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /RRS Stock &amp; QC/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await s.call('/artifact.html', { origin: null })).status, 404);
  assert.equal((await s.call('/missing.js', { origin: null })).status, 404);
});

test('wrong method → 405 with Allow; unknown API → 404 JSON', async () => {
  const r = await s.callJson('/api/commits', { method: 'POST', body: {} });
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('allow'), 'GET');
  const g = await s.callJson('/api/auth/login');
  assert.equal(g.status, 405);
  assert.equal(g.headers.get('allow'), 'POST');
  const n = await s.callJson('/api/admin/backup', { body: {} });
  assert.equal(n.status, 404);
  assert.equal(n.body.ok, false);
});
