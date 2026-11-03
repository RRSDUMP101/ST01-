import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const ID = 'a'.repeat(64), SECOND = 'b'.repeat(64);
const photo = (id = ID, primary = true) => ({ id, name: 'part.jpg', type: 'image/jpeg', primary,
  url: '/api/items/photos/' + id + '?code=PART-A', size: 123, uploadedAt: '2026-11-03T12:00:00Z' });
function setup({ server = true, canEdit = true, list, fetcher } = {}) {
  const calls = [], posts = [], messages = [];
  const root = { URL, FormData, File, TextEncoder, console, setTimeout, clearTimeout,
    location: { href: 'https://nexuspart-terminal.com/#stock' },
    document: { querySelector: () => null },
    fetch: async (url, init) => { posts.push({ url, init }); return fetcher ? fetcher(url, init) : Response.json({ ok: true, photo: photo(), photos: [photo()] }); } };
  vm.createContext(root);
  for (const path of ['engine/core.js', 'engine/ledger.js', 'engine/master.js', 'engine/inventory.js', 'engine/planning.js', 'ui/kit.js', 'ui/pages/02-items.js', 'ui/pages/11-stock.js']) {
    vm.runInContext(readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'), root, { filename: path });
  }
  const RRS = root.RRS;
  RRS.app = { api: '/api', session: { owner: false } };
  const state = RRS.core.createState();
  state.tables.balances = {};
  state.tables.items = { 'PART-A': { id: 'PART-A', code: 'PART-A', name: 'ข้อต่อเหล็ก', baseUnit: 'ชิ้น', type: 'PART', trackLot: 'none', active: true, minQty: 2 } };
  state.tables.warehouses = { A: { id: 'A', code: 'A', name: 'คลัง A', active: true }, B: { id: 'B', code: 'B', name: 'คลัง B', active: true } };
  for (const b of [
    { wh: 'A', bin: 'A01', status: 'AVAILABLE', qty: 10 }, { wh: 'B', bin: 'B01', status: 'AVAILABLE', qty: 8 },
    { wh: 'A', bin: 'A02', status: 'QC_HOLD', qty: 3 }, { wh: 'A', bin: 'A03', status: 'QUARANTINE', qty: 2 },
    { wh: 'A', bin: 'A04', status: 'REWORK', qty: 1 },
  ]) {
    Object.assign(b, { code: 'PART-A', lot: '', lastIn: '2026-11-03T12:00:00Z' });
    state.tables.balances[RRS.balanceKey(b)] = b;
  }
  state.tables.reservations = { RES1: { id: 'RES1', code: 'PART-A', wh: 'A', qty: 12, issued: 0, released: 0, status: 'OPEN' } };
  const ctx = { RRS, state, server, mode: server ? 'server' : 'demo', account: 'staff', view: {}, today: '2026-11-03',
    can: () => canEdit, userName: (id) => id, item: (code) => state.tables.items[code],
    set() { throw new Error('Photo updates must not rerender or clear product edits'); },
    exec() { throw new Error('Photo bytes must never enter the ledger'); },
    toast(message) { messages.push(message); },
    async api(path, body) { calls.push({ path, body }); return body ? { ok: true, photos: [photo(ID, false), photo(SECOND, true)] } :
      list || { ok: true, itemId: 'PART-A', photos: [photo()], canEdit, maxPhotos: 8, maxBytes: 5242880 }; } };
  return { root, RRS, ctx, calls, posts, messages, photos: RRS.ui.productPhotos, stock: RRS.ui.pages.stock, items: RRS.ui.pages.items };
}

test('gallery uses authenticated real images, escapes captions and never accepts external or data URLs', async () => {
  const f = setup({ list: { ok: true, canEdit: true, photos: [
    { ...photo(), name: '<img src=x onerror=alert(1)>' },
    { ...photo(SECOND), url: 'https://evil.invalid/photo.jpg' },
    { ...photo(SECOND), url: 'data:image/png;base64,AAAA' },
  ] } });
  await f.photos.load(f.ctx, 'PART-A');
  const html = String(f.photos.gallery(f.ctx, 'PART-A'));
  assert.match(html, /https:\/\/nexuspart-terminal\.com\/api\/items\/photos\//);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /evil\.invalid|data:image|<img src=x/);
  assert.match(html, /data-photo-drop/);
  assert.match(String(f.photos.thumbnail(f.ctx, 'PART-A', 'ข้อต่อ')), /src="https:/);
});

test('photo upload sends multipart to item endpoint and leaves engine state unchanged', async () => {
  const f = setup({ list: { ok: true, photos: [], canEdit: true } });
  await f.photos.load(f.ctx, 'PART-A');
  const before = JSON.stringify(f.ctx.state);
  const file = new File([new Uint8Array([255, 216, 255])], 'actual-part.jpg', { type: 'image/jpeg' });
  await f.photos.upload(f.ctx, 'PART-A', [file]);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].url, '/api/items/photos?code=PART-A');
  assert.equal(f.posts[0].init.method, 'POST');
  assert.equal(f.posts[0].init.credentials, 'same-origin');
  assert.equal(f.posts[0].init.body.get('file').name, 'actual-part.jpg');
  assert.equal(JSON.stringify(f.ctx.state), before);
  assert.match(String(f.photos.gallery(f.ctx, 'PART-A')), /เพิ่มรูปแล้ว 1 รูป/);
});

test('invalid type, oversized files and maximum photo count are blocked before upload', async () => {
  const f = setup({ list: { ok: true, photos: [], canEdit: true, maxPhotos: 1, maxBytes: 10 } });
  await f.photos.load(f.ctx, 'PART-A');
  await f.photos.upload(f.ctx, 'PART-A', [new File(['x'], 'vector.svg', { type: 'image/svg+xml' })]);
  await f.photos.upload(f.ctx, 'PART-A', [new File(['12345678901'], 'large.png', { type: 'image/png' })]);
  const jpg = new File(['x'], 'part.jpg', { type: 'image/jpeg' });
  await f.photos.upload(f.ctx, 'PART-A', [jpg, jpg]);
  assert.equal(f.posts.length, 0);
  assert.match(String(f.photos.gallery(f.ctx, 'PART-A')), /เพิ่มรูปได้อีก 1 รูป/);
});

test('primary selection posts the selected stored identifier and refreshes table thumbnail', async () => {
  const f = setup({ list: { ok: true, canEdit: true, photos: [photo(), photo(SECOND, false)] } });
  await f.photos.load(f.ctx, 'PART-A');
  await f.photos.primary(f.ctx, 'PART-A', SECOND);
  assert.equal(f.calls[1].path, '/items/photos/primary?code=PART-A');
  assert.equal(f.calls[1].body.id, SECOND);
  assert.match(String(f.photos.thumbnail(f.ctx, 'PART-A', 'part')), new RegExp(SECOND));
});

test('server-denied photo editing and demo mode never upload; new product explains save-first', async () => {
  const denied = setup({ list: { ok: true, photos: [], canEdit: false } });
  await denied.photos.load(denied.ctx, 'PART-A');
  await denied.photos.upload(denied.ctx, 'PART-A', [new File(['x'], 'x.png', { type: 'image/png' })]);
  assert.equal(denied.posts.length, 0);
  assert.doesNotMatch(String(denied.photos.gallery(denied.ctx, 'PART-A')), /data-photo-drop/);
  const demo = setup({ server: false });
  await demo.photos.load(demo.ctx, 'PART-A');
  await demo.photos.upload(demo.ctx, 'PART-A', [new File(['x'], 'x.png', { type: 'image/png' })]);
  assert.equal(demo.calls.length + demo.posts.length, 0);
  assert.match(String(demo.photos.gallery(demo.ctx, 'PART-A')), /ข้อมูลทดลองไม่เก็บรูป/);
  assert.match(String(demo.photos.gallery(demo.ctx, '__new')), /บันทึกสินค้าก่อน/);
});

test('offline gallery offers retry and partial upload reports already completed files', async () => {
  const f = setup({ list: { ok: true, photos: [], canEdit: true }, fetcher: (() => { let n = 0; return () => {
    if (++n === 1) return Response.json({ ok: true, photo: photo(), photos: [photo()] });
    throw new Error('offline');
  }; })() });
  await f.photos.load(f.ctx, 'PART-A');
  const jpg = new File(['x'], 'part.jpg', { type: 'image/jpeg' });
  await f.photos.upload(f.ctx, 'PART-A', [jpg, jpg]);
  const html = String(f.photos.gallery(f.ctx, 'PART-A'));
  assert.match(html, /เพิ่มแล้ว 1 รูป/);
  assert.match(html, /data-photo-action="retry"/);
  assert.match(html, new RegExp(ID));
});

test('table thumbnails load in bounded batches instead of one request per product', async () => {
  const f = setup();
  const boxes = Array.from({ length: 205 }, (_, i) => {
    const code = 'PART-' + i;
    f.ctx.state.tables.items[code] = { id: code };
    return { dataset: { photoThumb: code } };
  });
  f.ctx.api = async (path) => { f.calls.push({ path }); return { ok: true, items: [] }; };
  const dom = { querySelectorAll: (selector) => selector === '[data-photo-thumb]' ? boxes : [] };
  f.photos.after(f.ctx, dom);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.map((c) => new URL(c.path, 'https://nexus.test').searchParams.getAll('code').length), [100, 100, 5]);
  f.photos.after(f.ctx, dom);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.calls.length, 3);
});

test('stock free quantity uses planning per warehouse, with reservations and storage positions visible', () => {
  const f = setup();
  const html = String(f.stock.render(f.ctx));
  assert.match(html, /พร้อมเบิก/);
  assert.match(html, /stock-available">8<\/span>/, 'over-reserved warehouse A must not reduce free stock at B');
  assert.match(html, /จองแล้ว 12/);
  assert.match(html, /จองเกินของ 2/);
  assert.match(html, /A\/A01/);
  assert.match(html, /B\/B01/);
  assert.match(html, /รอตรวจ 3/);
  assert.match(html, /กักกัน 2/);
  assert.match(html, /รอแก้ไข 1/);
  f.ctx.view.wh = 'A';
  const scoped = String(f.stock.render(f.ctx));
  assert.match(scoped, /stock-available">0<\/span>/);
  assert.doesNotMatch(scoped, /B\/B01/);
});

test('stock photo detail retains disabled QC actions and warehouse permission enforcement', async () => {
  const f = setup();
  f.ctx.view.sel = 'PART-A';
  const html = String(f.stock.render(f.ctx));
  assert.match(html, /data-photo-gallery="PART-A"/);
  assert.match(html, /data-act="issue"/);
  assert.match(html, /data-act="move"/);
  assert.match(html, /data-go="history"/);
  const held = Object.entries(f.ctx.state.tables.balances).find(([, b]) => b.status === 'QC_HOLD');
  await f.stock.actions.issue(f.ctx, { dataset: { arg: held[0] } });
  assert.match(f.messages.at(-1), /QC|ตรวจปล่อย/);
  f.ctx.can = () => false;
  const free = Object.entries(f.ctx.state.tables.balances).find(([, b]) => b.status === 'AVAILABLE');
  await f.stock.actions.move(f.ctx, { dataset: { arg: free[0] } });
  assert.match(f.messages.at(-1), /ไม่มีสิทธิ์/);
});

test('issuing from a stock position still creates a draft and opens document review without posting stock', async () => {
  const f = setup();
  const commands = [], routes = [];
  f.ctx.exec = async (kind, payload) => { commands.push({ kind, payload }); return { ok: true, result: { docNo: 'PD-TEST' } }; };
  f.ctx.dialog = async (opts) => opts.onSubmit({ type: 'PD', job: 'JOB-1', qty: '2', remark: 'test' });
  f.ctx.go = (page, view) => routes.push({ page, view });
  const balance = Object.entries(f.ctx.state.tables.balances).find(([, b]) => b.wh === 'B' && b.status === 'AVAILABLE');
  const before = JSON.stringify(f.ctx.state.tables.balances);
  await f.stock.actions.issue(f.ctx, { dataset: { arg: balance[0] } });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].kind, 'doc.saveDraft');
  assert.equal(commands[0].payload.lines[0].wh, 'B');
  assert.equal(commands[0].payload.lines[0].bin, 'B01');
  assert.equal(commands[0].payload.lines[0].qty, 2);
  assert.equal(routes[0].page, 'docs');
  assert.equal(routes[0].view.sel, 'PD-TEST');
  assert.equal(JSON.stringify(f.ctx.state.tables.balances), before);
});
