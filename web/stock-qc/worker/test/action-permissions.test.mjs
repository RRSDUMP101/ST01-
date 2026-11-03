import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, bootstrapped } from './helpers.mjs';
import { engineUserFor } from '../src/ledger.js';

test('live API applies explicit grants and revocation to commands and uploads on the same session', async (t) => {
  const s = await startServer();
  t.after(() => s.dispose());
  const owner = await bootstrapped(s, {masters:false});
  const clerk = await s.account(owner, 'Clerk.Custom');
  const row = {id:'CUSTOM',name:'พนักงานกำหนดสิทธิ์',roles:['viewer'],accountId:'CLERK.CUSTOM',
    permissions:{'master.edit':true,'files.upload':true}};
  await s.ok(owner,'user.upsert',row);
  const session = await s.callJson('/api/auth/session',{cookie:clerk.cookie});
  assert.equal(session.body.user.id,'CUSTOM');
  await s.ok(clerk.cookie,'item.upsert',{code:'ALLOWED',name:'สิทธิ์ที่ได้รับ',baseUnit:'ชิ้น'});
  const forbidden = await s.cmd(clerk.cookie,'settings.update',{patch:{company:'ไม่ได้รับอนุญาต'}});
  assert.equal(forbidden.status,422);
  assert.equal(forbidden.body.errors[0].code,'NO_PERMISSION');
  const upload = () => s.callJson('/api/files',{cookie:clerk.cookie,raw:Buffer.from('code,qty\nPART-1,1\n'),headers:{'content-type':'text/csv','x-file-name':'test.csv'}});
  const allowed = await upload();
  assert.equal(allowed.status,201,allowed.text);
  await s.ok(owner,'user.upsert',{...row,permissions:{}});
  assert.equal((await upload()).status,403);
  const revoked = await s.cmd(clerk.cookie,'item.upsert',{code:'REVOKED',name:'ถอนสิทธิ์แล้ว',baseUnit:'ชิ้น'});
  assert.equal(revoked.body.errors[0].code,'NO_PERMISSION');
  assert.equal((await s.callJson('/api/auth/session',{cookie:clerk.cookie})).status,200);
});

test('ambiguous legacy case-variant account links fail closed', () => {
  const a={id:'A',accountId:'Clerk.One'}, b={id:'B',accountId:'CLERK.ONE'};
  assert.equal(engineUserFor({tables:{users:{A:a}}},'clerk.one'),a);
  assert.throws(()=>engineUserFor({tables:{users:{A:a,B:b}}},'clerk.one'),e=>e.status===403&&e.extra.code==='AMBIGUOUS_ACCOUNT');
});
