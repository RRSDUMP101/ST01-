import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { reservedName, validUsername } from '../src/auth.js';
import { startServer, tempPassword } from './helpers.mjs';

let s, owner;
before(async () => {
  // Generated test-only secret: existing owner hashes accept an eight-character password; new staff still require 12.
  const ownerPassword = randomBytes(4).toString('hex');
  const secrets = { ownerUsername: 'Owner.' + randomBytes(3).toString('hex'), ownerPassword,
    ownerHash: await bcrypt.hash(ownerPassword, 12), sessionSecret: randomBytes(32).toString('hex') };
  s = await startServer({ secrets, isolates: 2 });
  owner = await s.ownerLogin({ ip: '192.0.2.101' });
  await s.ok(owner, 'system.bootstrap', { name: 'Test owner', userId: 'OWNER' });
});
after(async () => { if (s) await s.dispose(); });

test('owner login is case-insensitive, preserves configured identity, and cannot be shadowed by a staff account', async () => {
  const r = await s.callJson('/api/auth/login', { body: { username: s.secrets.ownerUsername.toUpperCase(), password: s.secrets.ownerPassword }, ip: '192.0.2.102' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.username, s.secrets.ownerUsername);
  assert.equal(r.body.owner, true);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const session = await s.callJson('/api/auth/session', { cookie });
  assert.equal(session.body.username, s.secrets.ownerUsername);
  assert.equal(session.body.user.id, 'OWNER');
  for (const username of [s.secrets.ownerUsername.toLowerCase(), s.secrets.ownerUsername.toUpperCase()]) {
    const denied = await s.callJson('/api/admin/credentials', { cookie: owner, body: { username, password: tempPassword() } });
    assert.equal(denied.status, 400, denied.text);
  }
  assert.equal((await s.d1.prepare('SELECT COUNT(*) AS n FROM sq_app_users WHERE username=? COLLATE NOCASE').bind(s.secrets.ownerUsername).first()).n, 0);
});

test('case-insensitive staff login and edits preserve stored identity, engine grants, and session revocation', async () => {
  const username = 'Case.Clerk', initial = tempPassword(), next = tempPassword();
  const created = await s.callJson('/api/admin/credentials', { cookie: owner, body: { username, password: initial } });
  assert.equal(created.status, 200, created.text);
  await s.ok(owner, 'user.upsert', { id: 'CLERK', name: 'Case test', roles: ['viewer'], accountId: username, permissions: { 'users.manage': true } });
  const first = await s.login(username.toUpperCase(), initial, { ip: '192.0.2.103' });
  const a = await s.callJson('/api/auth/session', { cookie: first });
  assert.equal(a.body.username, username);
  assert.equal(a.body.owner, false);
  assert.equal(a.body.mustChange, true);
  assert.equal(a.body.user.id, 'CLERK');
  const changed = await s.callJson('/api/auth/password', { cookie: first, body: { current: initial, next } });
  assert.equal(changed.status, 200, changed.text);
  assert.equal((await s.callJson('/api/auth/session', { cookie: first })).status, 401);
  const cookie = await s.login(username.toLowerCase(), next, { ip: '192.0.2.104' });
  const denied = await s.callJson('/api/admin/credentials', { cookie });
  assert.equal(denied.status, 403, 'delegated users.manage alone cannot list login accounts');
  const resetOwner = await s.callJson('/api/admin/credentials', { cookie, body: { username: s.secrets.ownerUsername, password: tempPassword() } });
  assert.equal(resetOwner.status, 403, 'delegated users.manage alone cannot reset credentials');
  const off = await s.callJson('/api/admin/credentials', { cookie: owner, body: { username: username.toLowerCase(), active: false } });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.body.username, username);
  assert.equal((await s.callJson('/api/auth/session', { cookie })).status, 401);
  const refused = await s.callJson('/api/auth/login', { body: { username: username.toUpperCase(), password: next }, ip: '192.0.2.105' });
  assert.equal(refused.status, 401);
  const stored = (await s.d1.prepare('SELECT username,active FROM sq_app_users WHERE username=? COLLATE NOCASE').bind(username).all()).results;
  assert.deepEqual(stored, [{ username, active: 0 }]);
  const sessions = (await s.d1.prepare('SELECT DISTINCT username FROM sq_sessions WHERE username=? COLLATE NOCASE').bind(username).all()).results;
  assert.deepEqual(sessions, [{ username }]);
});

test('NOCASE uniqueness prevents concurrent case-variant account creation across worker isolates', async () => {
  const password = tempPassword();
  const responses = await Promise.all(['Race.Person', 'RACE.PERSON'].map((username, i) => s.callJson('/api/admin/credentials', {
    cookie: owner, on: i ? 'b' : 'a', body: { username, password },
  })));
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409], responses.map((r) => r.text).join('\n'));
  const rows = (await s.d1.prepare("SELECT username FROM sq_app_users WHERE username='race.person' COLLATE NOCASE").all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].username, responses.find((r) => r.status === 200).body.username);
  // Enforced by D1, even when writes bypass the application lookup.
  await assert.rejects(s.d1.prepare('INSERT INTO sq_app_users (username,password_hash,created_at,updated_at) VALUES (?,?,?,?)')
    .bind('race.person', s.secrets.ownerHash, new Date().toISOString(), new Date().toISOString()).run(), /UNIQUE/);
});

test('account metadata is owner/admin-only and never returns credential or session secrets', async () => {
  assert.equal((await s.callJson('/api/admin/credentials')).status, 401);
  const r = await s.callJson('/api/admin/credentials', { cookie: owner });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const configuredOwner = r.body.users.find((u) => u.owner);
  assert.equal(configuredOwner.username, s.secrets.ownerUsername);
  assert.equal(configuredOwner.active, true);
  assert.equal(configuredOwner.mustChange, false);
  const expectedKeys = ['username', 'active', 'mustChange', 'owner', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'].sort();
  for (const row of r.body.users) assert.deepEqual(Object.keys(row).sort(), expectedKeys);
  const knownSecrets = [s.secrets.ownerPassword, s.secrets.ownerHash, s.secrets.sessionSecret, owner.split('=')[1],
    ...(await s.d1.prepare('SELECT password_hash FROM sq_app_users').all()).results.map((u) => u.password_hash)];
  for (const secret of knownSecrets) assert.ok(!r.text.includes(secret));
});

test('Object.prototype account names are reserved in every letter case; staff password minimum remains 12', async () => {
  for (const name of [...Object.getOwnPropertyNames(Object.prototype), 'prototype']) {
    for (const variant of [name, name.toLowerCase(), name.toUpperCase()]) {
      assert.equal(reservedName(variant), true, variant);
      assert.equal(validUsername(variant), false, variant);
    }
  }
  const denied = await s.callJson('/api/admin/credentials', { cookie: owner, body: { username: 'TOSTRING', password: tempPassword() } });
  assert.equal(denied.status, 400);
  const short = await s.callJson('/api/admin/credentials', { cookie: owner, body: { username: 'short.password', password: randomBytes(4).toString('hex') } });
  assert.equal(short.status, 400);
});
