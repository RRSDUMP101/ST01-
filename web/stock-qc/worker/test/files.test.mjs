// R2 files: types, content checks, size limit, de-duplication, download headers and who may upload/download.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startServer, bootstrapped } from './helpers.mjs';

let s;
let owner;
let store;
let viewer;
let norole;
before(async () => {
  s = await startServer();
  owner = await bootstrapped(s, { masters: false });
  store = await s.account(owner, 'store.clerk');
  viewer = await s.account(owner, 'look.only');
  norole = await s.account(owner, 'no.engine.user');
  await s.ok(owner, 'user.upsert', { id: 'STORE1', name: 'สโตร์', roles: ['store'], accountId: 'store.clerk' });
  await s.ok(owner, 'user.upsert', { id: 'VIEW1', name: 'ดูอย่างเดียว', roles: ['viewer'], accountId: 'look.only' });
});
after(async () => {
  if (s) await s.dispose();
});

const sha = (b) => createHash('sha256').update(b).digest('hex');
const bytes = (head, size = 2048, fill = 0x41) => {
  const b = Buffer.alloc(size, fill);
  Buffer.from(head).copy(b);
  return b;
};
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], 4096, 0x11);
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = (() => {
  const b = bytes([0x52, 0x49, 0x46, 0x46]);
  Buffer.from('WEBP').copy(b, 8);
  return b;
})();
const PDF = bytes(Buffer.from('%PDF-1.7\n'));
const XLSX = bytes([0x50, 0x4b, 0x03, 0x04]);
const CSV_TIS620 = Buffer.from([0x72, 0x6f, 0x77, 0x2c, 0xca, 0xb5, 0xe7, 0xcd, 0xa1, 0x0a]); // Thai text in TIS-620 bytes
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** multipart/form-data bytes as a browser sends them (Miniflare's own fetch does not take Node's FormData object). */
async function encodeForm(fd) {
  const req = new Request('http://form.local/', { method: 'POST', body: fd });
  return { raw: Buffer.from(await req.arrayBuffer()), headers: { 'content-type': req.headers.get('content-type') } };
}
function form(buf, type, name) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), name);
  return encodeForm(fd);
}
const rawUpload = (cookie, buf, type, name, o = {}) => s.callJson('/api/files', Object.assign({ cookie, raw: buf, headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name || '') } }, o));
const formUpload = async (cookie, buf, type, name, o = {}) => s.callJson('/api/files', Object.assign({ cookie }, await form(buf, type, name), o));

test('upload a JPEG the way the page does (multipart field "file") and get it back inline with nosniff', async () => {
  const up = await formUpload(store.cookie, JPEG, 'image/jpeg', 'รูป QC ชิ้นที่ 1.jpg');
  assert.equal(up.status, 201, up.text);
  assert.equal(up.body.id, sha(JPEG));
  assert.equal(up.body.name, 'รูป QC ชิ้นที่ 1.jpg');
  assert.equal(up.body.url, `/api/files/${sha(JPEG)}`);
  const row = await s.d1.prepare('SELECT r2_key,type,size,uploaded_by FROM sq_files WHERE id=?').bind(sha(JPEG)).first();
  assert.deepEqual(row, { r2_key: `stockqc/files/${sha(JPEG)}`, type: 'image/jpeg', size: JPEG.length, uploaded_by: 'store.clerk' });
  const res = await s.call(`/api/files/${sha(JPEG)}`, { cookie: viewer.cookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('content-disposition'), /^inline;/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(JPEG));
});

test('PDF, XLSX, PNG, WEBP and CSV (any text encoding) are accepted; non-images download as attachments', async () => {
  for (const [buf, type, name] of [[PDF, 'application/pdf', 'ใบรับรองวัสดุ.pdf'], [XLSX, XLSX_TYPE, 'express.xlsx'], [PNG, 'image/png', 'a.png'],
    [WEBP, 'image/webp', 'b.webp'], [CSV_TIS620, 'text/csv', 'สต็อก.csv']]) {
    const up = await rawUpload(store.cookie, buf, type, name);
    assert.equal(up.status, 201, `${type}: ${up.text}`);
    const res = await s.call(`/api/files/${up.body.id}`, { cookie: store.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), type);
    const disp = res.headers.get('content-disposition');
    if (type.startsWith('image/')) assert.match(disp, /^inline;/);
    else assert.match(disp, /^attachment;/);
    assert.ok(disp.includes(`filename*=UTF-8''${encodeURIComponent(name)}`), disp);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(buf));
  }
});

test('types browsers really send: .csv as application/vnd.ms-excel (Windows + Excel), .xlsx with no type, image/jpg', async () => {
  const csv = Buffer.from('code,qty\nTST-001,5\n');
  const a = await formUpload(store.cookie, csv, 'application/vnd.ms-excel', 'express-stock.csv');
  assert.equal(a.status, 201, a.text);
  assert.equal(a.body.type, 'text/csv');
  const x = bytes([0x50, 0x4b, 0x03, 0x04], 3000, 0x33);
  const b = await formUpload(store.cookie, x, '', 'นับสต็อก.xlsx');
  assert.equal(b.status, 201, b.text);
  assert.equal(b.body.type, XLSX_TYPE);
  const j = bytes([0xff, 0xd8, 0xff, 0xe1], 1000, 0x44);
  const c = await formUpload(store.cookie, j, 'image/jpg', 'photo.JPG');
  assert.equal(c.status, 201, c.text);
  assert.equal(c.body.type, 'image/jpeg');
});

test('the same bytes uploaded twice are stored once', async () => {
  const again = await rawUpload(store.cookie, PDF, 'application/pdf', 'ชื่ออื่น.pdf');
  assert.equal(again.status, 200);
  assert.equal(again.body.existing, true);
  assert.equal(again.body.name, 'ใบรับรองวัสดุ.pdf');
  const n = await s.d1.prepare('SELECT COUNT(*) AS n FROM sq_files WHERE id=?').bind(sha(PDF)).first();
  assert.equal(n.n, 1);
  const list = await s.r2.list({ prefix: 'stockqc/files/' });
  assert.equal(list.objects.filter((o) => o.key.endsWith(sha(PDF))).length, 1);
});

test('types outside the list, bytes that do not match the declared type and empty files are refused', async () => {
  const cases = [
    [Buffer.from('<html><script>alert(1)</script></html>'), 'text/html', 415],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', 415],
    [bytes([0x4d, 0x5a]), 'application/octet-stream', 415],
    [bytes([0x4d, 0x5a]), 'application/pdf', 415], // an .exe called PDF
    [Buffer.from('<html></html>'), 'image/jpeg', 415],
    [bytes([0x00, 0x01, 0x02]), 'text/csv', 415], // binary called CSV
    [Buffer.alloc(0), 'application/pdf', 400],
  ];
  for (const [buf, type, status] of cases) {
    const r = await rawUpload(store.cookie, buf, type, 'x');
    assert.equal(r.status, status, `${type} → ${r.status} ${r.text}`);
  }
  const noField = new FormData();
  noField.append('other', 'x');
  assert.equal((await s.callJson('/api/files', Object.assign({ cookie: store.cookie }, await encodeForm(noField)))).status, 400);
  // a generic browser type is resolved by the extension, then the bytes must still match it
  assert.equal((await formUpload(store.cookie, bytes([0x4d, 0x5a]), 'application/octet-stream', 'setup.pdf')).status, 415);
  assert.equal((await formUpload(store.cookie, Buffer.from('<b>x</b>'), 'application/octet-stream', 'page.html')).status, 415);
});

test('size limit: exactly 10 MB is accepted; one byte more is refused (raw and multipart)', async () => {
  const max = 10 * 1024 * 1024;
  const exact = bytes([0xff, 0xd8, 0xff, 0xdb], max, 0x22);
  const ok = await rawUpload(store.cookie, exact, 'image/jpeg', 'big.jpg');
  assert.equal(ok.status, 201, ok.text);
  const over = bytes([0xff, 0xd8, 0xff, 0xdb], max + 1, 0x23);
  assert.equal((await rawUpload(store.cookie, over, 'image/jpeg', 'too-big.jpg')).status, 413);
  assert.equal((await formUpload(store.cookie, over, 'image/jpeg', 'too-big.jpg')).status, 413);
  assert.equal((await s.d1.prepare('SELECT COUNT(*) AS n FROM sq_files WHERE id=?').bind(sha(over)).first()).n, 0);
});

test('who may upload/download: session required, same origin, an engine user; viewers download only; unknown ids 404', async () => {
  const id = sha(JPEG);
  assert.equal((await formUpload(null, PNG, 'image/png', 'a.png')).status, 401);
  assert.equal((await s.callJson(`/api/files/${id}`)).status, 401);
  assert.equal((await formUpload(store.cookie, PNG, 'image/png', 'a.png', { origin: 'https://attacker.test' })).status, 403);
  assert.equal((await formUpload(norole.cookie, PNG, 'image/png', 'a.png')).status, 403);
  assert.equal((await s.callJson(`/api/files/${id}`, { cookie: norole.cookie })).status, 403);
  const v = await formUpload(viewer.cookie, PNG, 'image/png', 'a.png');
  assert.equal(v.status, 403);
  assert.equal((await s.call(`/api/files/${id}`, { cookie: viewer.cookie })).status, 200);
  assert.equal((await formUpload(owner, Buffer.from('owner,file\n'), 'text/csv', 'o.csv')).status, 201, 'owner (admin) uploads');
  assert.equal((await s.callJson(`/api/files/${'f'.repeat(64)}`, { cookie: store.cookie })).status, 404);
  assert.equal((await s.callJson('/api/files/not-a-hash', { cookie: store.cookie })).status, 404);
  assert.equal((await s.callJson(`/api/files/${id}`, { cookie: store.cookie, method: 'DELETE' })).status, 405);
});
