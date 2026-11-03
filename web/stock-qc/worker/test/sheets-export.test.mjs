import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startServer, bootstrapped, stockIn, outboundRouter, replay } from './helpers.mjs';
import { fakeGoogle } from './fake-google.mjs';
import { SHEETS_MIME, SHEETS_LIMITS, sheetsProjection, projectSheetsCommit, sheetsDataset, sheetsChunks, exportNativeSpreadsheet } from '../src/sheets-export.js';

function setup() {
  const creds = { clientId: 'sheets-client.apps.googleusercontent.com', clientSecret: randomBytes(16).toString('hex'),
    refreshToken: randomBytes(24).toString('hex'), rootId: 'rootfolder' + randomBytes(8).toString('hex') };
  const g = fakeGoogle(creds);
  const router = outboundRouter({ 'oauth2.googleapis.com': g.handle, 'www.googleapis.com': g.handle, 'sheets.googleapis.com': g.handle });
  return { g, creds, router, bindings: { SQ_DRIVE_BACKUP_ENABLED: 'true', SQ_SHEETS_EXPORT_ENABLED: 'true',
    GOOGLE_DRIVE_CLIENT_ID: creds.clientId, GOOGLE_DRIVE_CLIENT_SECRET: creds.clientSecret,
    GOOGLE_DRIVE_REFRESH_TOKEN: creds.refreshToken, SQ_DRIVE_BACKUP_FOLDER_ID: creds.rootId } };
}
const sheetRows = (file, title) => file.sheets.find((s) => s.properties.title === title).values;
const cellByField = (rows, field, row = 1) => rows[row][rows[0].findIndex((v) => v.endsWith(`(${field})`))];

test('new native workbook accepts empty or omitted sheets list and creates its first tab', async () => {
  for (const initial of [{ sheets: [] }, {}]) {
    const bodies = [];
    const id = 'native-sheet-id';
    const response = (body) => { const text = JSON.stringify(body); return { status: 200, bytes: new TextEncoder().encode(text), text: () => text }; };
    const client = {
      createSpreadsheet: async () => ({ id }), verifySpreadsheet: async () => {}, markSpreadsheet: async () => {},
      request: async (url, options) => {
        if (options.method === 'GET') return response({ spreadsheetId: id, ...initial });
        const body = JSON.parse(options.body); bodies.push(body);
        return url.includes('/values:') ? response({ spreadsheetId: id, responses: body.data.map((d) => ({ updatedData: { values: d.values } })) })
          : response({ spreadsheetId: id });
      },
    };
    const result = await exportNativeSpreadsheet(client, { tabs: [{ title: 'สินค้า', rows: [['id'], ['001']] }], cells: 2 },
      { name: 'test', heartbeat: async () => {} });
    assert.equal(result.id, id);
    assert.equal(bodies[0].requests.length, 1);
    assert.equal(bodies[0].requests[0].addSheet.properties.title, 'สินค้า');
  }
});

test('projection excludes auth and undeclared fields, flattens lines and retains literal formulas/leading zeros', () => {
  const state = sheetsProjection();
  projectSheetsCommit(state, { effects: [
    { t: 'users', k: 'admin', v: { password: 'NEVER_EXPORT_THIS' } },
    { t: 'items', k: '001', v: { id: '001', name: '=IMPORTXML("https://example.invalid", "x")', password: 'SECRET_UNKNOWN_FIELD', unitCost: 0 } },
    { t: 'documents', k: 'RR001', v: { docNo: 'RR001', lines: [{ code: '001', qty: 2, token: 'SECRET_NESTED', more: { password: 'SECRET_DEEP', ok: true } }] } },
    { t: 'inspections', k: 'IN001', v: { id: 'IN001', results: [{ char: 'C1', value: '=1+2', ok: true }] } },
  ] });
  const dataset = sheetsDataset(state, { day: '2026-11-03', toSeq: 1 });
  const serialized = JSON.stringify(dataset);
  for (const secret of ['NEVER_EXPORT_THIS', 'SECRET_UNKNOWN_FIELD', 'SECRET_NESTED', 'SECRET_DEEP']) assert.ok(!serialized.includes(secret));
  const items = dataset.tabs.find((t) => t.title === 'สินค้า').rows;
  assert.equal(cellByField(items, 'id'), '001');
  assert.equal(cellByField(items, 'name'), '=IMPORTXML("https://example.invalid", "x")');
  assert.equal(cellByField(items, 'unitCost'), '0');
  assert.equal(dataset.tabs.find((t) => t.title === 'รายการเอกสารสต็อก').rows.length, 2);
  assert.equal(dataset.tabs.find((t) => t.title === 'รายละเอียดผลQC').rows.length, 2);
  for (const tab of dataset.tabs) for (const row of tab.rows) assert.ok(row.every((v) => typeof v === 'string'));
  projectSheetsCommit(state, { effects: [{ t: 'items', k: '001', v: null }] });
  assert.equal(sheetsDataset(state, {}).tabs.find((t) => t.title === 'สินค้า').rows.length, 1);
});

test('bounded chunks preserve every row/range and oversized cells fail instead of silently truncating', () => {
  const rows = Array.from({ length: 1400 }, (_, i) => [String(i), 'ข'.repeat(900)]);
  const data = { tabs: [{ title: 'ตาราง', rows }, { title: 'ท้าย', rows: [['id'], ['0001']] }] };
  const chunks = [...sheetsChunks(data)];
  assert.ok(chunks.length > 3);
  const flattened = [];
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(JSON.stringify({ valueInputOption: 'RAW', data: chunk, includeValuesInResponse: true, responseValueRenderOption: 'UNFORMATTED_VALUE' })) <= SHEETS_LIMITS.requestBytes);
    for (const range of chunk) if (range.range.startsWith("'ตาราง'")) {
      assert.equal(Number(/A(\d+)$/.exec(range.range)[1]), flattened.length + 1);
      assert.ok(range.values.length <= SHEETS_LIMITS.rows);
      flattened.push(...range.values);
    }
  }
  assert.deepEqual(flattened, rows);
  const state = sheetsProjection();
  projectSheetsCommit(state, { effects: [{ t: 'items', k: 'big', v: { id: 'big', name: 'a'.repeat(SHEETS_LIMITS.cellChars + 1) } }] });
  assert.throws(() => sheetsDataset(state, {}), { code: 'SHEETS_CELL_TOO_LARGE' });
});

test('real Worker pipeline: private native workbook + JSONL + manifest, RAW echo confirmed, 03:00 Thai daily cron', async () => {
  const { g, creds, router, bindings } = setup();
  const s = await startServer({ bindings, outbound: router });
  try {
    const owner = await bootstrapped(s);
    await stockIn(s, owner, 3);
    const source = await replay(s.d1);
    const run = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(run.status, 200, run.text);
    const folder = g.children(creds.rootId)[0];
    const files = g.children(folder.id);
    const workbook = files.find((f) => f.mimeType === SHEETS_MIME);
    assert.ok(workbook);
    assert.equal(workbook.appProperties.sqBackupStatus, 'complete');
    assert.ok(!workbook.name.startsWith('INCOMPLETE'));
    assert.equal(workbook.shared, false);
    assert.equal(g.generated.has(workbook.id), false, 'native file did not use a reserved Drive ID');
    assert.equal(sheetRows(workbook, 'เอกสารสต็อก').length, Object.keys(source.state.tables.documents).length + 1);
    assert.equal(cellByField(sheetRows(workbook, 'ยอดสต็อก'), 'qty'), '3');
    const manifest = JSON.parse(Buffer.from(files.find((f) => f.name === 'manifest.json').bytes).toString());
    assert.equal(manifest.spreadsheet.id, workbook.id);
    assert.equal(manifest.commits.head, source.state.head);
    assert.deepEqual(run.body.run.spreadsheet, manifest.spreadsheet);
    assert.equal(files.at(-1).name, 'manifest.json');
    assert.ok(files.some((f) => f.name.endsWith('.jsonl')));
    const wholeWorkbook = JSON.stringify(workbook.sheets);
    for (const secret of [creds.clientSecret, creds.refreshToken, ...g.tokens]) assert.ok(!wholeWorkbook.includes(secret));
    for (const request of g.log.filter((r) => r.op === 'sheetValues')) assert.equal(request.body.valueInputOption, 'RAW');
    const st = await s.callJson('/api/backup/status', { cookie: owner });
    assert.equal(st.body.schedule.cron, '0 20 * * *');
    assert.equal(st.body.schedule.time, '03:00');
    assert.equal(st.body.nativeSheets.enabled, true);
    await s.scheduled('40 18 * * *');
    assert.equal(g.children(creds.rootId).length, 1, 'old cron ignored');
    await s.scheduled('0 20 * * *');
    await s.scheduled('0 20 * * *');
    assert.equal(g.children(creds.rootId).length, 2, 'daily scheduled run only once');
    assert.deepEqual(router.blocked, []);
  } finally { await s.dispose(); }
});

test('uncertain structure/write retries safely without duplicate tabs or workbooks', async () => {
  const { g, router, bindings } = setup();
  g.fault('sheetStructure', { status: 503, commit: true });
  g.fault('sheetValues', { status: 429, commit: true });
  const s = await startServer({ bindings, outbound: router });
  try {
    const owner = await bootstrapped(s);
    const result = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(result.status, 200, result.text);
    const workbooks = [...g.files.values()].filter((f) => f.mimeType === SHEETS_MIME);
    assert.equal(workbooks.length, 1);
    const names = workbooks[0].sheets.map((s) => s.properties.title);
    assert.equal(new Set(names).size, names.length);
    assert.equal(g.log.filter((r) => r.op === 'sheetValues').length, 2);
  } finally { await s.dispose(); }
});

test('permanent Sheets failure marks run/workbook failed, keeps JSONL, and never publishes complete manifest', async () => {
  const { g, router, bindings } = setup();
  g.fault('sheetValues', { status: 403 });
  const s = await startServer({ bindings, outbound: router });
  try {
    const owner = await bootstrapped(s);
    const result = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(result.body.code, 'SHEETS_ACCESS_DENIED', result.text);
    assert.equal(result.body.run.status, 'failed');
    const all = [...g.files.values()];
    assert.ok(all.some((f) => f.name.endsWith('.jsonl')));
    assert.ok(!all.some((f) => f.name === 'manifest.json'));
    const workbook = all.find((f) => f.mimeType === SHEETS_MIME);
    assert.equal(workbook.appProperties.sqBackupStatus, 'failed');
    assert.ok(workbook.name.startsWith('FAILED'));
  } finally { await s.dispose(); }
});

test('uncertain native create is not retried, remains INCOMPLETE and run fails', async () => {
  const { g, router, bindings } = setup();
  g.afterUpload = (f) => { if (f.name.endsWith('.jsonl')) g.fault('createFolder', { status: 503, commit: true }); };
  const s = await startServer({ bindings, outbound: router });
  try {
    const owner = await bootstrapped(s);
    const result = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(result.body.code, 'SHEETS_CREATE_UNCERTAIN', result.text);
    const workbooks = [...g.files.values()].filter((f) => f.mimeType === SHEETS_MIME);
    assert.equal(workbooks.length, 1);
    assert.ok(workbooks[0].name.startsWith('INCOMPLETE'));
    assert.ok(![...g.files.values()].some((f) => f.name === 'manifest.json'));
  } finally { await s.dispose(); }
});

test('sharing changed during export fails closed before the next write', async () => {
  const { g, router, bindings } = setup();
  g.afterSheetWrite = (file) => { file.shared = true; file.permissions.push({ id: 'other', type: 'user', role: 'reader' }); };
  const s = await startServer({ bindings, outbound: router });
  try {
    const owner = await bootstrapped(s);
    const result = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(result.body.code, 'DESTINATION_NOT_PRIVATE', result.text);
    assert.equal(result.body.run.status, 'failed');
    assert.ok(![...g.files.values()].some((f) => f.name === 'manifest.json'));
  } finally { await s.dispose(); }
});

test('concurrent new document does not leak into the pinned Sheets/JSONL snapshot', async () => {
  const { g, router, bindings } = setup();
  const s = await startServer({ bindings, outbound: router });
  try {
    const owner = await bootstrapped(s);
    await stockIn(s, owner, 3);
    const before = await replay(s.d1);
    let lateWrite;
    g.afterUpload = (file) => {
      if (file.name.endsWith('.jsonl') && !lateWrite) lateWrite = stockIn(s, owner, 5);
    };
    const result = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    await lateWrite;
    assert.equal(result.status, 200, result.text);
    assert.ok((await replay(s.d1)).state.seq > before.state.seq);
    assert.equal(result.body.run.toSeq, before.state.seq);
    const workbook = [...g.files.values()].find((f) => f.mimeType === SHEETS_MIME);
    assert.equal(cellByField(sheetRows(workbook, 'ยอดสต็อก'), 'qty'), '3');
    const manifest = JSON.parse(Buffer.from([...g.files.values()].find((f) => f.name === 'manifest.json').bytes).toString());
    assert.equal(manifest.commits.head, before.state.head);
    assert.equal(sheetRows(workbook, 'ข้อมูลการส่งออก').find((row) => row[0] === 'ลายนิ้วมือข้อมูล')[1], before.state.head);
  } finally { await s.dispose(); }
});

test('mismatched values echoed by Sheets are rejected and the run fails', async () => {
  const { g, router, bindings } = setup();
  g.afterSheetWrite = (file) => { file.sheets[0].values[0][0] = 'changed by provider'; };
  const s = await startServer({ bindings, outbound: router });
  try {
    const owner = await bootstrapped(s);
    const result = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(result.body.code, 'SHEETS_WRITE_NOT_CONFIRMED', result.text);
    assert.equal(result.body.run.status, 'failed');
    assert.ok(![...g.files.values()].some((f) => f.name === 'manifest.json'));
  } finally { await s.dispose(); }
});
