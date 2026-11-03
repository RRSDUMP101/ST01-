// Read-only checks plus one intentionally invalid login; never uses a real user's credentials.
import assert from 'node:assert/strict';
const origin = 'https://nexuspart-terminal.com';
const health = await fetch(origin + '/api/health');
assert.equal(health.status, 200);
const h = await health.json();
assert.equal(h.features.authProvider, 'local');
assert.equal(h.features.database, 'ready');
assert.equal(h.features.login, true);
for (const path of ['/api/auth/session', '/api/commits']) {
  const r = await fetch(origin + path);
  assert.equal(r.status, 401, path);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  console.log(path, r.status);
}
const page = await fetch(origin);
assert.equal(page.status, 200);
assert.equal(page.headers.get('x-frame-options'), 'DENY');
assert.match(await page.text(), /NEXUS/);
const artifact = await fetch(origin + '/artifact.html');
assert.equal(artifact.status, 404);
const cross = await fetch(origin + '/api/auth/login', {method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:'{}'});
assert.equal(cross.status, 403);
const login = await fetch(origin + '/api/auth/login', {method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'nexus-check-' + crypto.randomUUID().slice(0,8),password:'invalid-test-only-not-a-user-password'})});
assert.equal(login.status, 401, 'Invalid credentials must be rejected by local auth, not fail with configuration/CPU error');
assert.equal(login.headers.has('set-cookie'), false);
console.log('HTTPS, login page, private APIs, CSRF, artifact block and independent login rejection: passed');
