// Read-only, native Google Sheets snapshots. Drive creates the native file; Sheets writes literal RAW strings.
// No auth tables or arbitrary D1 records are accepted. The source is the same verified, pinned ledger as JSONL.
import { jsonObject, OutboundError } from './outbound.js';

export const SHEETS_MIME = 'application/vnd.google-apps.spreadsheet';
export const SHEETS_LIMITS = Object.freeze({ cells: 1000000, bytes: 32 * 1024 * 1024, cellChars: 45000, requestBytes: 1024 * 1024, rows: 500 });
const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const encoder = new TextEncoder();
const fail = (code, retryable = false) => new OutboundError(code, retryable);
// Explicit table allowlist: users, settings, access requests and all authentication storage are excluded.
const TABLES = [
  ['items', 'สินค้า'], ['warehouses', 'คลัง'], ['bins', 'ช่องเก็บ'], ['item_units', 'หน่วยสินค้า'], ['boms', 'BOM'],
  ['balances', 'ยอดสต็อก'], ['documents', 'เอกสารสต็อก'], ['jobs', 'ใบงาน'], ['reservations', 'จองสินค้า'],
  ['suppliers', 'ผู้ขาย'], ['item_suppliers', 'สินค้าและผู้ขาย'], ['reorder_rules', 'เงื่อนไขเติมสินค้า'],
  ['prs', 'ใบขอซื้อ'], ['pos', 'ใบสั่งซื้อ'], ['lots', 'ล็อตและใบรับรอง'], ['qc_plans', 'แผนQC'],
  ['inspections', 'ผลตรวจQC'], ['ncrs', 'NCR'], ['movements', 'ประวัติเคลื่อนไหว'],
  ['count_sessions', 'ตรวจนับ'], ['express_batches', 'กระทบยอดExpress'], ['offcuts', 'เศษวัสดุ'], ['audit', 'ประวัติทำรายการ'],
];
const TABLE_NAMES = new Set(TABLES.map(([name]) => name));
const CHILDREN = {
  boms: { lines: 'รายการBOM' }, documents: { lines: 'รายการเอกสารสต็อก' }, jobs: { lines: 'รายการใบงาน' },
  prs: { lines: 'รายการใบขอซื้อ' }, pos: { lines: 'รายการใบสั่งซื้อ' }, qc_plans: { chars: 'หัวข้อตรวจQC' },
  inspections: { results: 'รายละเอียดผลQC' }, count_sessions: { lines: 'รายการตรวจนับ' },
};
const sensitive = (key) => /password|passwd|credential|secret|token|session|authorization|cookie|private.?key|salt|^__proto__$|^constructor$|^prototype$/i.test(key);
function scrub(value, depth = 0) {
  if (depth > 20) throw fail('SHEETS_DATA_TOO_LARGE');
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out = Object.create(null);
  for (const [k, v] of Object.entries(value)) if (!sensitive(k)) out[k] = scrub(v, depth + 1);
  return out;
}
function cell(value) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(scrub(value)) : String(value);
  if (text.length > SHEETS_LIMITS.cellChars) throw fail('SHEETS_CELL_TOO_LARGE');
  return text;
}
/** A bounded projection, excluding auth and request/idempotency caches, while the JSONL reader verifies the chain. */
export function sheetsProjection() { return { tables: Object.create(null), sizes: new Map(), bytes: 0 }; }
export function projectSheetsCommit(state, commit) {
  for (const effect of commit.effects) {
    if (!TABLE_NAMES.has(effect.t)) continue;
    if (['__proto__', 'constructor', 'prototype'].includes(effect.k)) throw fail('LEDGER_INTEGRITY');
    const table = state.tables[effect.t] || (state.tables[effect.t] = Object.create(null));
    const key = effect.t + '\0' + effect.k;
    state.bytes -= state.sizes.get(key) || 0;
    if (effect.v === null) { delete table[effect.k]; state.sizes.delete(key); }
    else {
      const fields = globalThis.RRS.schema.tables[effect.t].fields;
      const row = Object.create(null);
      for (const field of fields) if (!sensitive(field.name) && Object.hasOwn(effect.v, field.name)) row[field.name] = scrub(effect.v[field.name]);
      const size = encoder.encode(JSON.stringify(row)).length;
      state.bytes += size;
      if (state.bytes > SHEETS_LIMITS.bytes) throw fail('SHEETS_DATA_TOO_LARGE');
      state.sizes.set(key, size);
      table[effect.k] = row;
    }
  }
}
export function sheetsDataset(state, metadata) {
  const tabs = [];
  let cells = 0;
  let bytes = 0;
  function tab(title, rows) {
    for (const row of rows) {
      cells += row.length;
      bytes += encoder.encode(JSON.stringify(row)).length;
      if (cells > SHEETS_LIMITS.cells || bytes > SHEETS_LIMITS.bytes) throw fail('SHEETS_DATA_TOO_LARGE');
    }
    tabs.push({ title, rows });
  }
  tab('ข้อมูลการส่งออก', [
    ['หัวข้อ', 'ค่า'], ['ระบบ', 'Nexus Part Terminal'], ['วันที่ไทย', cell(metadata.day)], ['เวลาเขต', 'Asia/Bangkok'],
    ['เวลาเริ่มส่งออก', cell(metadata.startedAt)], ['ลำดับรายการล่าสุด', cell(metadata.toSeq)], ['ลายนิ้วมือข้อมูล', cell(metadata.head)],
    ['รอบสำรอง', cell(metadata.runId)], ['รูปแบบ', 'ข้อมูล ณ เวลาส่งออก อ่านจากระบบเท่านั้น ไม่ดึงการแก้ในชีตกลับเข้าระบบ'],
    ['ค่าทุกช่อง', 'ข้อความ RAW เพื่อคงรหัส เลขศูนย์นำหน้า และป้องกันการทำงานของสูตร'],
    ['กู้คืนระบบ', 'ใช้ JSONL และ manifest.json ในโฟลเดอร์เดียวกัน'],
    ['ไม่รวม', 'รหัสผ่าน บัญชีเข้าสู่ระบบ เซสชัน secrets และเนื้อหาไฟล์แนบใน R2'],
  ]);
  for (const [name, title] of TABLES) {
    const schema = globalThis.RRS.schema.tables[name];
    if (!schema) continue;
    const children = CHILDREN[name] || {};
    const fields = schema.fields.filter((f) => !sensitive(f.name) && !children[f.name]);
    const records = Object.entries(state.tables[name] || {}).sort(([a], [b]) => a.localeCompare(b));
    tab(title, [['รหัสแถว', ...fields.map((f) => `${f.label} (${f.name})`)], ...records.map(([key, row]) =>
      [cell(key), ...fields.map((f) => cell(row[f.name]))])]);
    for (const [field, childTitle] of Object.entries(children)) {
      const childRows = [];
      const keys = new Set();
      for (const [parent, row] of records) for (const [index, raw] of (Array.isArray(row[field]) ? row[field] : []).entries()) {
        const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? scrub(raw) : { value: raw };
        for (const key of Object.keys(value)) if (!sensitive(key)) keys.add(key);
        childRows.push({ parent, index: index + 1, value });
      }
      const columns = [...keys].sort();
      tab(childTitle, [['รหัสแถวต้นทาง', 'ลำดับบรรทัด', ...columns], ...childRows.map((r) =>
        [cell(r.parent), cell(r.index), ...columns.map((k) => cell(r.value[k]))])]);
    }
  }
  return { tabs, cells, bytes };
}
function apiError(status) {
  if (status === 429) return fail('SHEETS_RATE_LIMITED', true);
  if (status >= 500) return fail('SHEETS_UNAVAILABLE', true);
  if (status === 403) return fail('SHEETS_ACCESS_DENIED');
  return fail('SHEETS_REQUEST_FAILED');
}
async function retry(operation, heartbeat) {
  for (let attempt = 0; ; attempt++) {
    try { await heartbeat(); return await operation(); }
    catch (e) {
      if (!(e instanceof OutboundError && e.retryable) || attempt >= 2) throw e;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}
/** Pack complete rows into bounded idempotent RAW updates (all values are strings, including numbers). */
export function* sheetsChunks(dataset) {
  let data = [], size = 512;
  for (const tab of dataset.tabs) {
    let rows = [], start = 1, rowSize = 0;
    const range = () => `'${tab.title.replaceAll("'", "''")}'!A${start}`;
    for (let i = 0; i < tab.rows.length; i++) {
      const n = encoder.encode(JSON.stringify(tab.rows[i])).length + 2;
      if (n + 1024 > SHEETS_LIMITS.requestBytes) throw fail('SHEETS_ROW_TOO_LARGE');
      if (rows.length && (rows.length >= SHEETS_LIMITS.rows || size + rowSize + n + 512 > SHEETS_LIMITS.requestBytes)) {
        data.push({ range: range(), majorDimension: 'ROWS', values: rows });
        size += rowSize + 256; rows = []; rowSize = 0; start = i + 1;
      }
      if (data.length && size + rowSize + n + 512 > SHEETS_LIMITS.requestBytes) { yield data; data = []; size = 512; }
      rows.push(tab.rows[i]); rowSize += n;
    }
    if (rows.length) { data.push({ range: range(), majorDimension: 'ROWS', values: rows }); size += rowSize + 256; }
  }
  if (data.length) yield data;
}
function verifyEcho(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) throw fail('SHEETS_WRITE_NOT_CONFIRMED');
  for (let i = 0; i < expected.length; i++) {
    const values = actual[i]?.updatedData?.values || [];
    const rows = expected[i].values;
    for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) {
      if ((values[r]?.[c] ?? '') !== rows[r][c]) throw fail('SHEETS_WRITE_NOT_CONFIRMED');
    }
  }
}
export async function exportNativeSpreadsheet(client, dataset, input) {
  const heartbeat = input.heartbeat;
  let file;
  try {
    await heartbeat();
    file = await client.createSpreadsheet(input);
    const target = Object.assign({}, input, { id: file.id });
    const url = `${API}/${encodeURIComponent(file.id)}`;
    // Native Drive create may supply a default tab. Re-read before retrying addSheet after an uncertain response.
    await retry(async () => {
      await client.verifySpreadsheet(target);
      const meta = await client.request(`${url}?fields=spreadsheetId,sheets.properties`, { method: 'GET' });
      if (meta.status !== 200) throw apiError(meta.status);
      const props = jsonObject(meta);
      if (props?.spreadsheetId !== file.id || (props.sheets !== undefined && !Array.isArray(props.sheets))) throw fail('INVALID_PROVIDER_RESPONSE');
      const existing = (props.sheets || []).map((s) => s.properties);
      const requests = [];
      for (const [i, tab] of dataset.tabs.entries()) {
        const found = existing.find((s) => s.title === tab.title);
        const gridProperties = { rowCount: Math.max(2, tab.rows.length), columnCount: Math.max(2, tab.rows[0].length), frozenRowCount: 1 };
        if (found) requests.push({ updateSheetProperties: { properties: { sheetId: found.sheetId, gridProperties }, fields: 'gridProperties' } });
        else requests.push({ addSheet: { properties: { sheetId: 1000 + i, title: tab.title, gridProperties } } });
      }
      for (const sheet of existing) if (!dataset.tabs.some((t) => t.title === sheet.title)) requests.push({ deleteSheet: { sheetId: sheet.sheetId } });
      const res = await client.request(`${url}:batchUpdate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }) });
      if (res.status !== 200) throw apiError(res.status);
    }, heartbeat);
    let chunks = 0;
    for (const data of sheetsChunks(dataset)) {
      await retry(async () => {
        await client.verifySpreadsheet(target);
        const body = JSON.stringify({ valueInputOption: 'RAW', data, includeValuesInResponse: true, responseValueRenderOption: 'UNFORMATTED_VALUE' });
        if (encoder.encode(body).length > SHEETS_LIMITS.requestBytes) throw fail('SHEETS_ROW_TOO_LARGE');
        const res = await client.request(`${url}/values:batchUpdate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, 2 * SHEETS_LIMITS.requestBytes);
        if (res.status !== 200) throw apiError(res.status);
        const result = jsonObject(res);
        if (result?.spreadsheetId !== file.id) throw fail('INVALID_PROVIDER_RESPONSE');
        verifyEcho(result.responses, data);
      }, heartbeat);
      chunks++;
    }
    await retry(() => client.markSpreadsheet(target, 'complete'), heartbeat);
    return { id: file.id, url: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(file.id)}/edit`, name: input.name,
      format: 'google-sheets', valueInputOption: 'RAW', snapshotOnly: true, cells: dataset.cells, chunks,
      tabs: dataset.tabs.map((t) => ({ title: t.title, rows: t.rows.length - 1, columns: t.rows[0].length })) };
  } catch (error) {
    if (file) await client.markSpreadsheet(Object.assign({}, input, { id: file.id }), 'failed').catch(() => {});
    throw error;
  }
}
