import test from 'node:test';
import assert from 'node:assert/strict';
import { RRS, world } from './helpers.mjs';

const user = (state, id) => RRS.q.get(state, 'users', id);
const update = async (w, id, patch, actor = 'ADMIN') => {
  const current = user(await w.state(), id);
  return w.exec(actor, 'user.upsert', { ...current, ...patch, id });
};

test('explicit action grants permit selected commands and deny role defaults immediately', async () => {
  const w = await world();
  assert.equal((await update(w, 'VIEW', { permissions: { 'master.edit': true }, position: 'ทะเบียนอะไหล่' })).ok, true);
  await w.ok('VIEW', 'item.upsert', { code: 'CUSTOM-1', name: 'สิทธิ์เฉพาะข้อ', baseUnit: 'ชิ้น' });
  const denied = await w.exec('VIEW', 'settings.update', { patch: { company: 'ไม่ได้รับอนุญาต' } });
  assert.equal(denied.errors[0].code, 'NO_PERMISSION');
  assert.equal((await update(w, 'LEAD', { permissions: { 'master.edit': false } })).ok, true);
  const deniedRole = await w.exec('LEAD', 'item.upsert', { code: 'CUSTOM-2', name: 'บทบาทเดิมไม่ให้สิทธิ์ทับ', baseUnit: 'ชิ้น' });
  assert.equal(deniedRole.errors[0].code, 'NO_PERMISSION');
  assert.equal((await update(w, 'VIEW', { permissions: {} })).ok, true);
  assert.equal((await w.exec('VIEW', 'item.upsert', { code: 'CUSTOM-3', name: 'ถูกถอนสิทธิ์แล้ว', baseUnit: 'ชิ้น' })).errors[0].code, 'NO_PERMISSION');
  assert.equal(user(await w.state(), 'VIEW').position, 'ทะเบียนอะไหล่');
});

test('omitted grants preserve customization; null restores legacy role grants; admin stays unrestricted', async () => {
  const w = await world();
  assert.equal((await update(w, 'LEAD', { permissions: { 'master.edit': true } })).ok, true);
  const previous = user(await w.state(), 'LEAD');
  const { permissions, position, ...legacyPayload } = previous;
  await w.ok('ADMIN', 'user.upsert', { ...legacyPayload, name: 'แก้ชื่อจากแบบฟอร์มเก่า' });
  assert.deepEqual(user(await w.state(), 'LEAD').permissions, { 'master.edit': true });
  assert.equal(RRS.auth.can(user(await w.state(), 'LEAD'), 'doc.post'), false);
  assert.equal((await update(w, 'LEAD', { permissions: null })).ok, true);
  assert.equal(RRS.auth.can(user(await w.state(), 'LEAD'), 'doc.post'), true);
  assert.equal((await update(w, 'ADMIN', { permissions: {} })).ok, true);
  await w.ok('ADMIN', 'item.upsert', { code: 'ADMIN-ITEM', name: 'ยังบริหารระบบได้', baseUnit: 'ชิ้น' });
  const defaults = { roles: ['store'], active: true };
  assert.equal(RRS.auth.can(defaults, 'doc.post'), true);
  assert.equal(RRS.auth.can(defaults, 'files.upload'), true);
  assert.equal(RRS.auth.can({ roles: ['viewer'] }, 'files.upload'), false);
});

test('per-action stock grants still enforce warehouse scope and active status', async () => {
  const w = await world();
  assert.equal((await update(w, 'VIEW', { permissions: { 'doc.post': true, 'doc.postAdjust': true }, warehouses: ['A'] })).ok, true);
  const payload = (wh, bin) => ({ type: 'AJ', remark: 'ทดสอบขอบเขตคลัง', lines: [{ code: 'TST-001', qty: 2, wh, bin }] });
  await w.ok('VIEW', 'doc.post', payload('A', 'A-01'));
  assert.equal((await w.exec('VIEW', 'doc.post', payload('B', 'B-01'))).errors[0].code, 'NO_PERMISSION');
  assert.equal((await update(w, 'VIEW', { active: false })).ok, true);
  assert.equal((await w.exec('VIEW', 'doc.post', payload('A', 'A-01'))).errors[0].code, 'USER_INACTIVE');
});

test('malformed or unknown permission grants and oversized positions never change the ledger', async () => {
  const w = await world();
  const before = (await w.state()).seq;
  for (const permissions of [[], true, 'all', { 'master.edit': 'true' }, { 'not-a-permission': true }, JSON.parse('{"__proto__":true}')]) {
    const result = await update(w, 'VIEW', { permissions });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'BAD_VALUE');
  }
  for (const position of [4, 'x'.repeat(121)]) assert.equal((await update(w, 'VIEW', { position })).errors[0].code, 'BAD_VALUE');
  assert.equal((await w.state()).seq, before);
  for (const permissions of ['all', [], { 'master.edit': 1 }, Object.create({ 'master.edit': true })]) {
    assert.equal(RRS.auth.can({ roles: ['store_lead'], permissions }, 'master.edit'), false);
  }
  assert.equal(RRS.auth.can({ roles: ['admin'] }, 'constructor'), false);
});

test('a delegated user manager cannot manufacture admin, stronger actions or broader warehouse access', async () => {
  const w = await world();
  assert.equal((await update(w, 'VIEW', { permissions: { 'users.manage': true, 'master.edit': true }, warehouses: ['A'] })).ok, true);
  const create = (patch) => w.exec('VIEW', 'user.upsert', { id: 'CUSTOM', name: 'พนักงาน', roles: ['viewer'], permissions: { 'master.edit': true }, warehouses: ['A'], ...patch });
  assert.equal((await create({})).ok, true);
  assert.equal((await create({ roles: ['admin'] })).errors[0].code, 'NO_PERMISSION');
  assert.equal((await create({ permissions: { 'backup.restore': true } })).errors[0].code, 'NO_PERMISSION');
  assert.equal((await create({ warehouses: [] })).errors[0].code, 'NO_PERMISSION');
  assert.equal((await update(w, 'VIEW', { permissions: { 'users.manage': true, 'backup.restore': true } }, 'VIEW')).errors[0].code, 'NO_PERMISSION');
  assert.equal((await update(w, 'ADMIN', { name: 'แก้เจ้าของ' }, 'VIEW')).errors[0].code, 'NO_PERMISSION');
  assert.equal((await update(w, 'ADMIN', { roles: ['viewer'] })).errors[0].code, 'LAST_ADMIN');
});

test('account links are unique without letter-case distinctions and reject reserved names', async () => {
  const w = await world();
  assert.equal((await update(w, 'VIEW', { accountId: 'Parts.Team' })).ok, true);
  assert.equal((await update(w, 'STORE1', { accountId: 'pARTS.tEAM' })).errors[0].code, 'DUPLICATE');
  assert.equal(user(await w.state(), 'VIEW').accountId, 'Parts.Team');
  for (const accountId of ['Constructor', 'TOSTRING', '__PROTO__', 'Prototype']) {
    assert.equal((await update(w, 'STORE1', { accountId })).errors[0].code, 'BAD_KEY');
  }
  const effective = RRS.auth.permissionsFor(user(await w.state(), 'VIEW'));
  assert.equal(effective['master.edit'], false);
  assert.equal(Object.keys(effective).length, Object.keys(RRS.auth.PERMS).length);
});
