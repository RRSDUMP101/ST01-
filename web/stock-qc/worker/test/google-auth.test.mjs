import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { startServer, bootstrapped, outboundRouter, ORIGIN } from './helpers.mjs';
import { GOOGLE_SCOPE, GOOGLE_CALLBACK_PATH, resolvedGoogleEnv, googleConnectionStatus } from '../src/google-auth.js';

let s, owner, otherOwner, staff, provider, tokens = [];
const clientId = 'test-' + randomBytes(6).toString('hex') + '.apps.googleusercontent.com';
const clientSecret = randomBytes(24).toString('base64url');
const refreshToken = '1//' + randomBytes(24).toString('base64url');
const accessToken = randomBytes(24).toString('base64url');
const tokenData = () => ({ access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', scope: GOOGLE_SCOPE, expires_in: 3600 });
const bindings = { GOOGLE_DRIVE_CLIENT_ID: clientId, GOOGLE_DRIVE_CLIENT_SECRET: clientSecret,
  SQ_GOOGLE_REDIRECT_URI: ORIGIN + GOOGLE_CALLBACK_PATH, SQ_DRIVE_BACKUP_FOLDER_ID: 'test-private-folder', SQ_DRIVE_BACKUP_ENABLED: 'true' };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const runtimeEnv = () => ({ ...s.env(), ...s.bindings });
before(async () => {
  const router = outboundRouter({ 'oauth2.googleapis.com': async (req) => {
    assert.equal(req.url, 'https://oauth2.googleapis.com/token');
    assert.equal(req.method, 'POST');
    const body = new URLSearchParams(await req.text());
    assert.equal(body.get('client_id'), clientId);
    assert.equal(body.get('client_secret'), clientSecret);
    assert.equal(body.get('redirect_uri'), bindings.SQ_GOOGLE_REDIRECT_URI);
    assert.equal(body.get('grant_type'), 'authorization_code');
    tokens.push(body);
    return provider ? provider(body) : Response.json(tokenData());
  } });
  s = await startServer({ bindings, outbound: router, isolates: 2 });
  owner = await bootstrapped(s);
  otherOwner = await s.ownerLogin({ ip: '198.51.100.50' });
  staff = await s.account(owner, 'oauth.backup.staff');
  await s.ok(owner, 'user.upsert', { id: 'BACKUP', name: 'Backup staff', roles: ['viewer'], permissions: { 'backup.export': true }, accountId: staff.username });
});
after(async () => { if (s) { assert.deepEqual(s.outbound.blocked, []); await s.dispose(); } });

async function begin(cookie = owner) {
  const r = await s.callJson('/api/backup/google/connect', { cookie, body: {} });
  assert.equal(r.status, 200, r.text);
  return new URL(r.body.authorizationUrl);
}
function callback(url, extra = {}) {
  return s.mf.dispatchFetch(ORIGIN + GOOGLE_CALLBACK_PATH + '?' + new URLSearchParams({ state: url.searchParams.get('state'), code: 'test-' + randomBytes(8).toString('hex'), ...extra.query }),
    { method: 'GET', redirect: 'manual', headers: { Cookie: extra.cookie || owner, ...(extra.on === 'b' ? { 'MF-Route-Override': 'b' } : {}) } });
}

test('only the owner can start OAuth, with exact same origin and no caller-controlled redirect', async () => {
  assert.equal((await s.callJson('/api/backup/google/connect', { body: {} })).status, 401);
  assert.equal((await s.callJson('/api/backup/google/connect', { cookie: staff.cookie, body: {} })).status, 403);
  assert.equal((await s.callJson('/api/backup/google/connect', { cookie: owner, body: {}, origin: 'https://attacker.test' })).status, 403);
  assert.equal((await s.callJson('/api/backup/google/connect', { cookie: owner, body: { redirect: 'https://attacker.test' } })).status, 400);
  assert.equal((await s.callJson('/api/backup/google/connect', { cookie: owner })).status, 405);
  assert.equal(tokens.length, 0);
});

test('OAuth request uses offline Drive scope and S256; only hashed state and encrypted verifier are stored', async () => {
  const url = await begin();
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  for (const [key, value] of Object.entries({ response_type: 'code', access_type: 'offline', prompt: 'consent', scope: GOOGLE_SCOPE,
    code_challenge_method: 'S256', redirect_uri: bindings.SQ_GOOGLE_REDIRECT_URI })) assert.equal(url.searchParams.get(key), value);
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(url.searchParams.has('code_verifier'), false);
  const state = url.searchParams.get('state');
  const row = await s.d1.prepare('SELECT * FROM sq_google_oauth_states WHERE state_hash=?').bind(hash(state)).first();
  assert.ok(row.expires_at > Date.now() && row.expires_at <= Date.now() + 600000);
  assert.ok(!JSON.stringify(row).includes(state));
  assert.deepEqual(Object.keys(JSON.parse(row.verifier_ciphertext)).sort(), ['ciphertext', 'iv', 'v']);
  const noSession = await s.call(GOOGLE_CALLBACK_PATH + '?state=' + state + '&code=x', { origin: null });
  assert.equal(noSession.status, 401);
  assert.equal((await callback(url, { cookie: otherOwner })).status, 400, 'a second valid owner session cannot redeem this state');
  await s.d1.prepare('UPDATE sq_google_oauth_states SET expires_at=0 WHERE state_hash=?').bind(hash(state)).run();
  assert.equal((await callback(url)).status, 400);
  assert.equal(tokens.length, 0);
});

test('one callback across two isolates encrypts the token, checks PKCE, and never returns secrets', async () => {
  const url = await begin();
  const before = tokens.length;
  const responses = await Promise.all([callback(url), callback(url, { on: 'b' })]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [303, 400]);
  const success = responses.find((r) => r.status === 303);
  assert.equal(success.headers.get('location'), '/?google=connected#backup');
  assert.equal(success.headers.get('cache-control'), 'no-store');
  assert.equal(success.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(tokens.length, before + 1);
  const verifier = tokens.at(-1).get('code_verifier');
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  const rows = (await s.d1.prepare('SELECT * FROM sq_integrations').all()).results;
  assert.equal(rows.length, 1);
  const stored = JSON.stringify(rows);
  for (const secret of [refreshToken, accessToken, clientSecret, verifier, url.searchParams.get('state')]) assert.ok(!stored.includes(secret));
  assert.equal((await resolvedGoogleEnv(runtimeEnv())).GOOGLE_DRIVE_REFRESH_TOKEN, refreshToken);
  const status = await s.callJson('/api/backup/status', { cookie: staff.cookie });
  assert.equal(status.status, 200, status.text);
  assert.equal(status.body.google.connected, true);
  assert.equal(status.body.google.configured, true);
  for (const secret of [refreshToken, accessToken, clientSecret, clientId]) assert.ok(!status.text.includes(secret));
  const health = await s.callJson('/api/health');
  assert.equal(health.body.features.driveBackup.configured, true);
  assert.ok(!health.text.includes(refreshToken));
});

test('denial, provider errors, redirects and incomplete scopes consume state without replacing a valid connection', async () => {
  const before = tokens.length;
  const deniedUrl = await begin();
  const denied = await callback(deniedUrl, { query: { error: 'access_denied' } });
  assert.equal(denied.headers.get('location'), '/?google=denied#backup');
  assert.equal((await callback(deniedUrl)).status, 400);
  assert.equal(tokens.length, before);
  for (const response of [
    () => Response.json({ error: refreshToken, error_description: clientSecret }, { status: 400 }),
    () => new Response(null, { status: 302, headers: { Location: 'https://attacker.test' } }),
    () => Response.json({ ...tokenData(), scope: 'https://www.googleapis.com/auth/drive.file' }),
    () => Response.json({ ...tokenData(), refresh_token: undefined }),
  ]) {
    provider = response;
    const url = await begin();
    const result = await callback(url);
    assert.equal(result.status, 303);
    assert.equal(result.headers.get('location'), '/?google=failed#backup');
    assert.equal(await result.text(), '');
    assert.equal((await callback(url)).status, 400);
    assert.equal((await resolvedGoogleEnv(runtimeEnv())).GOOGLE_DRIVE_REFRESH_TOKEN, refreshToken);
  }
  provider = undefined;
});

test('connection fails closed on ciphertext tampering, session-key rotation, changed client or database outage', async () => {
  const row = await s.d1.prepare('SELECT encrypted_value FROM sq_integrations WHERE id=?').bind('google-drive').first();
  await assert.rejects(resolvedGoogleEnv({ ...runtimeEnv(), SESSION_SECRET: randomBytes(32).toString('hex'), GOOGLE_DRIVE_REFRESH_TOKEN: 'legacy-fallback' }), /เชื่อมต่อใหม่/);
  await assert.rejects(resolvedGoogleEnv({ ...runtimeEnv(), GOOGLE_DRIVE_CLIENT_ID: 'different-client', GOOGLE_DRIVE_REFRESH_TOKEN: 'legacy-fallback' }), /เชื่อมต่อใหม่/);
  await s.d1.prepare('UPDATE sq_integrations SET encrypted_value=? WHERE id=?').bind('{"v":1,"iv":"bad","ciphertext":"bad"}', 'google-drive').run();
  assert.equal((await googleConnectionStatus(runtimeEnv())).connected, false);
  const health = await s.callJson('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.features.driveBackup.configured, false);
  const run = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
  assert.equal(run.status, 503);
  assert.equal(run.body.code, 'GOOGLE_RECONNECT_REQUIRED');
  await s.d1.prepare('UPDATE sq_integrations SET encrypted_value=? WHERE id=?').bind(row.encrypted_value, 'google-drive').run();
  const broken = { ...runtimeEnv(), DB: { prepare() { throw new Error(clientSecret); } } };
  await assert.rejects(resolvedGoogleEnv(broken), (e) => e.status === 503 && !e.message.includes(clientSecret));
  assert.equal((await googleConnectionStatus(broken)).connected, false);
});

test('logout during the token exchange prevents storing the returned connection', async () => {
  const before = await s.d1.prepare('SELECT encrypted_value FROM sq_integrations WHERE id=?').bind('google-drive').first();
  const url = await begin(otherOwner);
  provider = async () => {
    assert.equal((await s.callJson('/api/auth/logout', { cookie: otherOwner, body: {} })).status, 200);
    return Response.json({ ...tokenData(), refresh_token: 'different-' + randomBytes(24).toString('base64url') });
  };
  const result = await callback(url, { cookie: otherOwner });
  assert.equal(result.headers.get('location'), '/?google=failed#backup');
  const after = await s.d1.prepare('SELECT encrypted_value FROM sq_integrations WHERE id=?').bind('google-drive').first();
  assert.equal(after.encrypted_value, before.encrypted_value);
  provider = undefined;
});

test('legacy refresh-token secrets remain usable when no encrypted connection exists', async () => {
  await s.d1.prepare('DELETE FROM sq_integrations WHERE id=?').bind('google-drive').run();
  const value = randomBytes(24).toString('base64url');
  assert.equal((await resolvedGoogleEnv({ ...runtimeEnv(), GOOGLE_DRIVE_REFRESH_TOKEN: value })).GOOGLE_DRIVE_REFRESH_TOKEN, value);
  assert.equal((await googleConnectionStatus(runtimeEnv())).connected, false);
});
