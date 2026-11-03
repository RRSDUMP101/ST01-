import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../src/index.js';
import { MAX_PHOTO_BYTES } from '../src/files.js';
import { startServer, bootstrapped, ORIGIN, tempPassword } from './helpers.mjs';

let s, owner, editor, viewer, uploader, unbound, firstId;
const ITEM = 'PHOTO/ONE', SECOND = 'SECOND,ITEM';
const endpoint = (code = ITEM) => '/api/items/photos?code=' + encodeURIComponent(code);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6McAAAAASUVORK5CYII=', 'base64');
const photo = (n) => Buffer.concat([PNG, Buffer.from([n])]);
const upload = (cookie, bytes, type = 'image/png', code = ITEM, extra = {}) => s.callJson(endpoint(code), {
  cookie, raw: bytes, headers: { 'content-type': type, 'x-file-name': encodeURIComponent('รูปสินค้า.png') }, ...extra,
});
async function multipart(entries) {
  const form = new FormData();
  for (const [key, bytes, type, name] of entries) form.append(key, new Blob([bytes], { type }), name);
  const request = new Request('https://form.test', { method: 'POST', body: form });
  return { raw: Buffer.from(await request.arrayBuffer()), headers: { 'content-type': request.headers.get('content-type') } };
}
before(async () => {
  s = await startServer({ isolates: 2 });
  owner = await bootstrapped(s);
  for (const code of [ITEM, SECOND, 'GALLERY-LIMIT', 'LARGE-PHOTO']) await s.ok(owner, 'item.upsert', { code, name: code, baseUnit: 'ชิ้น', type: 'PART' });
  editor = await s.account(owner, 'photo.editor');
  viewer = await s.account(owner, 'photo.viewer');
  uploader = await s.account(owner, 'photo.uploader');
  unbound = await s.account(owner, 'photo.unbound');
  await s.ok(owner, 'user.upsert', { id: 'EDIT', name: 'Editor', accountId: editor.username, roles: ['viewer'], permissions: { 'master.edit': true }, warehouses: ['A'] });
  await s.ok(owner, 'user.upsert', { id: 'VIEW', name: 'Viewer', accountId: viewer.username, roles: ['viewer'] });
  await s.ok(owner, 'user.upsert', { id: 'UPLOAD', name: 'Uploader', accountId: uploader.username, roles: ['store'] });
});
after(async () => { if (s) { assert.deepEqual(s.outbound.requests, []); await s.dispose(); } });

test('item photos require an active stock reader and the existing master.edit grant for mutations', async () => {
  assert.equal((await s.callJson(endpoint())).status, 401);
  assert.equal((await s.callJson(endpoint(), { cookie: unbound.cookie })).status, 403);
  const empty = await s.callJson(endpoint(), { cookie: viewer.cookie });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.canEdit, false);
  assert.deepEqual(empty.body.photos, []);
  assert.equal(empty.body.maxPhotos, 8);
  assert.equal(empty.body.maxBytes, MAX_PHOTO_BYTES);
  assert.equal((await s.callJson(endpoint(), { cookie: editor.cookie })).body.canEdit, true);
  assert.equal((await upload(viewer.cookie, PNG)).status, 403);
  assert.equal((await upload(uploader.cookie, PNG)).status, 403, 'files.upload does not grant product editing');
  assert.equal((await upload(editor.cookie, PNG, 'image/png', ITEM, { origin: 'https://attacker.test' })).status, 403);
  assert.equal((await upload(editor.cookie, PNG, 'image/png', 'MISSING')).status, 404);
  assert.equal((await s.callJson('/api/items/photos', { cookie: owner })).status, 400);
  const password = tempPassword();
  await s.callJson('/api/admin/credentials', { cookie: owner, body: { username: 'photo.temporary', password } });
  const temp = await s.login('photo.temporary', password, { ip: '192.0.2.90' });
  await s.ok(owner, 'user.upsert', { id: 'TEMP', name: 'Temporary', accountId: 'photo.temporary', roles: ['engineering'] });
  const refused = await upload(temp, PNG);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'MUST_CHANGE_PASSWORD');
});

test('multipart photo persists in R2, returns safe item-bound URLs and reads only within its product', async () => {
  const up = await s.callJson(endpoint(), { cookie: editor.cookie,
    ...await multipart([['file', PNG, 'image/png', '../unsafe"<name>\r\nรูป.png']]) });
  assert.equal(up.status, 201, up.text);
  firstId = createHash('sha256').update(PNG).digest('hex');
  assert.equal(up.body.photo.id, firstId);
  assert.equal(up.body.itemId, ITEM);
  assert.equal(up.body.photo.primary, true);
  assert.equal(up.body.photo.uploadedBy, editor.username);
  assert.ok(!/[\r\n"<>/\\]/.test(up.body.photo.name));
  assert.equal(up.body.photo.url, `/api/items/photos/${firstId}?code=${encodeURIComponent(ITEM)}`);
  assert.equal(up.body.photos.length, 1);
  assert.equal(up.body.photo.r2_key, undefined);
  const res = await s.call(up.body.photo.url, { cookie: viewer.cookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-disposition'), /^inline;/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  assert.equal((await s.call(up.body.photo.url)).status, 401);
  assert.equal((await s.call(`/api/items/photos/${firstId}?code=${encodeURIComponent(SECOND)}`, { cookie: viewer.cookie })).status, 404);
  const duplicate = await upload(editor.cookie, PNG);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.existing, true);
  assert.equal(duplicate.body.photos.length, 1);
  // Existing QC attachment access and content deduplication stay intact.
  const qc = await s.callJson('/api/files', { cookie: uploader.cookie, raw: PNG, headers: { 'content-type': 'image/png' } });
  assert.equal(qc.status, 200);
  assert.equal(qc.body.id, firstId);
  assert.equal((await s.call(qc.body.url, { cookie: viewer.cookie })).status, 200);
});

test('primary selection is item-scoped and atomic; thumbnails batch preserves missing-photo products', async () => {
  const second = await upload(editor.cookie, photo(2));
  assert.equal(second.status, 201);
  const id = second.body.photo.id;
  const path = '/api/items/photos/primary?code=' + encodeURIComponent(ITEM);
  assert.equal((await s.callJson(path, { cookie: viewer.cookie, body: { id } })).status, 403);
  const missing = await s.callJson(path, { cookie: editor.cookie, body: { id: 'f'.repeat(64) } });
  assert.equal(missing.status, 404);
  assert.equal((await s.callJson(endpoint(), { cookie: viewer.cookie })).body.photos.find((p) => p.primary).id, firstId);
  const selected = await s.callJson(path, { cookie: editor.cookie, body: { id } });
  assert.equal(selected.status, 200, selected.text);
  assert.deepEqual(selected.body.photos.filter((p) => p.primary).map((p) => p.id), [id]);
  assert.equal((await s.callJson(path, { cookie: editor.cookie, body: { id, url: 'https://attacker.test/photo.png' } })).status, 400);
  const bulk = await s.callJson('/api/items/photos/thumbnails?code=' + encodeURIComponent(ITEM) + '&code=' + encodeURIComponent(SECOND), { cookie: viewer.cookie });
  assert.equal(bulk.status, 200, bulk.text);
  assert.equal(bulk.body.items[0].photo.id, id);
  assert.equal(bulk.body.items[0].count, 2);
  assert.deepEqual(bulk.body.items[1], { itemId: SECOND, photo: null, count: 0 });
  assert.equal((await s.callJson('/api/items/photos/thumbnails?' + Array(101).fill('code=' + encodeURIComponent(ITEM)).join('&'), { cookie: owner })).status, 400);
  const updates = await Promise.all([firstId, id].map((chosen, i) => s.callJson(path, { cookie: editor.cookie, on: i ? 'b' : 'a', body: { id: chosen } })));
  assert.ok(updates.every((r) => r.status === 200));
  assert.equal((await s.d1.prepare('SELECT COUNT(*) AS n FROM sq_item_photos WHERE item_id=? AND is_primary=1').bind(ITEM).first()).n, 1);
});

test('gallery limit remains eight with one primary across simultaneous uploads on two isolates', async () => {
  const results = await Promise.all(Array.from({ length: 9 }, (_, i) => upload(editor.cookie, photo(20 + i), 'image/png', 'GALLERY-LIMIT', { on: i % 2 ? 'b' : 'a' })));
  assert.equal(results.filter((r) => r.status === 201).length, 8, results.map((r) => r.text).join('\n'));
  const refused = results.filter((r) => r.status === 409);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].body.code, 'PHOTO_LIMIT');
  const list = await s.callJson(endpoint('GALLERY-LIMIT'), { cookie: viewer.cookie });
  assert.equal(list.body.photos.length, 8);
  assert.equal(list.body.photos.filter((p) => p.primary).length, 1);
  const existing = results.find((r) => r.status === 201).body.photo.id;
  const duplicate = await upload(editor.cookie, photo(20 + results.findIndex((r) => r.status === 201)), 'image/png', 'GALLERY-LIMIT');
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.photo.id, existing);
});

test('only image magic is accepted, uploads are single-file and five MiB bounded without fetching supplied URLs', async () => {
  for (const [bytes, type, expected] of [
    [Buffer.from('<svg/>'), 'image/svg+xml', 415], [Buffer.from('%PDF-1.7'), 'application/pdf', 415],
    [Buffer.from('<html>not a picture</html>'), 'image/png', 415], [PNG, 'image/jpeg', 415], [Buffer.alloc(0), 'image/png', 400],
    [Buffer.from('{"url":"https://attacker.test/x.png"}'), 'application/json', 415],
  ]) assert.equal((await upload(editor.cookie, bytes, type, SECOND)).status, expected);
  const multiple = await s.callJson(endpoint(SECOND), { cookie: editor.cookie,
    ...await multipart([['file', PNG, 'image/png', 'one.png'], ['file', PNG, 'image/png', 'two.png']]) });
  assert.equal(multiple.status, 400);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP')]);
  assert.equal((await upload(editor.cookie, jpeg, 'image/jpeg', SECOND)).status, 201);
  assert.equal((await upload(editor.cookie, webp, 'image/webp', SECOND)).status, 201);
  const exact = Buffer.concat([PNG, Buffer.alloc(MAX_PHOTO_BYTES - PNG.length)]);
  const accepted = await upload(owner, exact, 'image/png', 'LARGE-PHOTO');
  assert.equal(accepted.status, 201, accepted.text);
  // Direct Worker invocation avoids Miniflare's known socket reset when rejecting a large request before reading it.
  const over = Buffer.concat([exact, Buffer.from([1])]);
  const res = await worker.fetch(new Request(ORIGIN + endpoint('LARGE-PHOTO'), { method: 'POST',
    headers: { Origin: ORIGIN, Cookie: owner, 'Content-Type': 'image/png', 'Content-Length': String(over.length) }, body: over }), { ...s.env(), ...s.bindings });
  assert.equal(res.status, 413);
  const formOver = await s.callJson(endpoint('LARGE-PHOTO'), { cookie: owner, ...await multipart([['file', over, 'image/png', 'large.png']]) });
  assert.equal(formOver.status, 413);
  assert.equal((await s.callJson(endpoint('LARGE-PHOTO'), { cookie: owner })).body.photos.length, 1);
});

test('deactivating an engine user revokes photo list and image access immediately', async () => {
  await s.ok(owner, 'user.upsert', { id: 'VIEW', name: 'Viewer', accountId: viewer.username, roles: ['viewer'], active: false });
  assert.equal((await s.callJson(endpoint(), { cookie: viewer.cookie })).status, 403);
  assert.equal((await s.call(`/api/items/photos/${firstId}?code=${encodeURIComponent(ITEM)}`, { cookie: viewer.cookie })).status, 403);
});
