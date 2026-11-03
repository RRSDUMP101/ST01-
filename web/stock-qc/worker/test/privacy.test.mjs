import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

test('public privacy route reads no bindings or credentials and never reflects the URL or cookie', async () => {
  const env = new Proxy({}, { get() { throw new Error('public page must not access environment'); } });
  const res = await worker.fetch(new Request('https://nexuspart-terminal.com/privacy?token=do-not-echo', {
    headers: { Cookie: '__Host-sq_session=do-not-echo' },
  }), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<html lang="th">/);
  assert.match(html, /Nexus Part Terminal/);
  assert.match(html, /Limited Use/);
  assert.match(html, /https:\/\/myaccount.google.com\/connections/);
  assert.ok(!html.includes('do-not-echo'));
  assert.ok(!/<script|<iframe|<form\b/i.test(html));
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('privacy route supports bodyless HEAD and rejects mutation methods without accessing storage', async () => {
  const head = await worker.fetch(new Request('https://nexuspart-terminal.com/privacy', { method: 'HEAD' }), undefined);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await worker.fetch(new Request('https://nexuspart-terminal.com/privacy', { method }), undefined);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});
