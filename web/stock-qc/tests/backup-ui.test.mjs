import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function setup({ owner = true, response, status = {}, href } = {}) {
  const navigations = [], calls = [], notices = [];
  const root = { URL, console, TextEncoder, setTimeout, clearTimeout,
    location: { href: href || 'https://nexuspart-terminal.com/#backup', assign: (url) => navigations.push(url) },
    history: { state: null, replaceState(_state, _title, path) { root.location.href = new URL(path, root.location.href).href; } } };
  vm.createContext(root);
  for (const path of ['engine/core.js', 'ui/kit.js', 'ui/pages/63-backup.js']) {
    vm.runInContext(readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'), root);
  }
  const RRS = root.RRS;
  RRS.app = { session: { owner } };
  RRS.reports = { verifyBackup() {} };
  const r = { ok: true, configured: true, enabled: true, google: { configured: true, connected: true },
    nativeSheets: { enabled: true, snapshotOnly: true, format: 'google-sheets' }, runs: [], ...status };
  const ctx = { state: RRS.core.createState(), view: { drive: { at: '2026-11-03T10:00:00Z', r } }, server: true, mode: 'server',
    today: '2026-11-03', can: () => true, userName: (id) => id, confirm: async () => true,
    set(patch) { Object.assign(this.view, patch); }, toast(message, tone) { notices.push({ message, tone }); },
    async api(path, body) { calls.push({ path, body }); return typeof response === 'function' ? response(path, body) : response || { ok: true }; } };
  return { root, ctx, page: RRS.ui.pages.backup, calls, navigations, notices };
}

test('only the owner can connect Google; action cannot be invoked by another user', async () => {
  const f = setup({ owner: false });
  assert.doesNotMatch(String(f.page.render(f.ctx)), /id="bk-google-connect"/);
  await f.page.actions.driveConnect(f.ctx);
  assert.equal(f.calls.length, 0);
  const own = setup({ status: { configured: false, google: { configured: true, connected: false } } });
  assert.match(String(own.page.render(own.ctx)), /id="bk-google-connect"/);
  assert.match(String(own.page.render(own.ctx)), /ยังไม่ได้เชื่อมบัญชี Google/);
});

test('owner connect posts once and navigates only to Google authorization', async () => {
  let finish;
  const f = setup({ response: () => new Promise((resolve) => { finish = resolve; }) });
  const connecting = f.page.actions.driveConnect(f.ctx);
  await f.page.actions.driveConnect(f.ctx);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, '/backup/google/connect');
  assert.equal(JSON.stringify(f.calls[0].body), '{}');
  finish({ ok: true, authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque&client_id=public-id' });
  await connecting;
  assert.equal(f.navigations.length, 1);
  assert.equal(new URL(f.navigations[0]).hostname, 'accounts.google.com');
  assert.equal(f.ctx.view.driveConnectBusy, false);
});

test('invalid provider URL or network error keeps the user on Nexus with recoverable feedback', async () => {
  for (const response of [
    { ok: true, authorizationUrl: 'https://accounts.google.com.evil.invalid/o/oauth2/v2/auth' },
    { ok: true, authorizationUrl: 'javascript:alert(1)' },
    () => { throw new Error('offline'); },
  ]) {
    const f = setup({ response });
    await f.page.actions.driveConnect(f.ctx);
    assert.equal(f.navigations.length, 0);
    assert.equal(f.ctx.view.driveConnectError, true);
    assert.ok(f.ctx.view.driveConnectNotice);
    assert.equal(f.ctx.view.driveConnectBusy, false);
  }
});

test('OAuth return message consumes only its own query parameter and refreshes server status', () => {
  const f = setup({ href: 'https://nexuspart-terminal.com/?other=keep&google=connected#backup' });
  f.page.after(f.ctx);
  assert.equal(f.root.location.href, 'https://nexuspart-terminal.com/?other=keep#backup');
  assert.match(f.ctx.view.driveConnectNotice, /กลับจาก Google/);
  assert.equal(f.ctx.view.driveConnectError, false);
  assert.equal(f.ctx.view.drive, null);
});

test('native Sheets is a server-controlled snapshot at 03:00 Thai time, while JSONL restore stays available', () => {
  const f = setup();
  const html = String(f.page.render(f.ctx));
  assert.match(html, /03:00/);
  assert.match(html, /เวลาไทย/);
  assert.match(html, /type="checkbox" disabled checked aria-describedby="bk-sheets-help"/);
  assert.match(html, /การแก้ไขในชีตไม่ส่งกลับมาเปลี่ยนข้อมูล Nexus/);
  assert.match(html, /JSONL และ manifest/);
  assert.match(html, /data-form="verify"/);
  assert.match(html, /id="bk-download"/);
});

test('workbook links accept run or manifest metadata, escape titles, and reject unexpected domains', () => {
  const f = setup({ status: { lastOk: { commits: 2, spreadsheet: { name: '<img src=x>', url: 'https://docs.google.com/spreadsheets/d/book_123/edit' } },
    runs: [
      { status: 'ok', manifest: { spreadsheet: { name: 'Snapshot', url: 'https://docs.google.com/spreadsheets/d/book_456/edit' } } },
      { status: 'ok', spreadsheet: { name: 'Unexpected', url: 'https://evil.invalid/spreadsheets/d/book_456' } },
    ] } });
  const html = String(f.page.render(f.ctx));
  assert.match(html, /https:\/\/docs\.google\.com\/spreadsheets\/d\/book_123\/edit/);
  assert.match(html, /https:\/\/docs\.google\.com\/spreadsheets\/d\/book_456\/edit/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /evil\.invalid|<img src=x>/);
});

test('successful manual backup retains returned spreadsheet link for display after the status refresh', async () => {
  const f = setup({ response: { ok: true, run: { commits: 10, spreadsheet: { name: 'New snapshot', url: 'https://docs.google.com/spreadsheets/d/new_snapshot/edit' } } } });
  await f.page.actions.driveRun(f.ctx);
  assert.equal(f.ctx.view.driveRunResult.spreadsheet.name, 'New snapshot');
  assert.equal(f.ctx.view.drive, null);
  assert.equal(f.ctx.view.driveBusy, false);
  assert.equal(f.notices[0].tone, 'ok');
});
