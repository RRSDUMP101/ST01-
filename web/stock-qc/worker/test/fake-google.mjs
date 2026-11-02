// A local fake of the Google endpoints the backup uses (OAuth token, Drive v3 files/generateIds/create, multipart
// upload, alt=media download) – enough of their real behaviour to test the Worker without Google: bearer tokens from a
// refresh token, ids from generateIds only, 409 for an id that exists, sha256Checksum/size of what was stored,
// private-by-default files. Fault injection: g.fault(op, {status, commit, times}); g.afterUpload(file) runs after an
// uploaded file is stored (tests change sharing mid-run with it).
import { createHash, randomBytes } from 'node:crypto';

const FOLDER = 'application/vnd.google-apps.folder';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: Object.assign({ 'content-type': 'application/json' }, headers) });

export function fakeGoogle({ clientId, clientSecret, refreshToken, rootId }) {
  const g = { files: new Map(), tokens: new Set(), generated: new Set(), log: [], faults: [], counter: 0, delayMs: 0, tokenCalls: 0, afterUpload: null };
  const owner = () => [{ id: 'owner-permission', type: 'user', role: 'owner' }];
  g.files.set(rootId, { id: rootId, name: 'RRS Stock QC backup (test)', mimeType: FOLDER, parents: ['my-drive-root'], trashed: false, shared: false,
    ownedByMe: true, permissions: owner(), capabilities: { canAddChildren: true }, appProperties: {} });
  /** Inject a failure for the next `times` calls of op ('token'|'get'|'generateIds'|'createFolder'|'upload'). commit: store first. */
  g.fault = (op, f) => g.faults.push(Object.assign({ op, times: 1 }, f));
  const take = (op) => {
    const f = g.faults.find((x) => x.op === op && x.times > 0);
    if (f) f.times -= 1;
    return f || null;
  };
  const meta = (f) => {
    const out = { kind: 'drive#file', id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, trashed: f.trashed, shared: f.shared,
      ownedByMe: f.ownedByMe, permissions: f.permissions, capabilities: f.capabilities, appProperties: f.appProperties };
    if (f.driveId) out.driveId = f.driveId;
    if (f.bytes) {
      out.size = String(f.bytes.length);
      out.sha256Checksum = sha(f.bytes);
    }
    return out;
  };
  const newFile = (m, bytes) => {
    const parent = g.files.get((m.parents || [])[0]);
    return { id: m.id, name: m.name, mimeType: m.mimeType || 'application/octet-stream', parents: m.parents, trashed: false,
      shared: parent ? parent.shared : false, ownedByMe: true, permissions: parent ? parent.permissions.map((p) => Object.assign({}, p)) : owner(),
      capabilities: { canAddChildren: m.mimeType === FOLDER }, appProperties: m.appProperties || {}, bytes: bytes || null, createdAt: Date.now() };
  };
  /** Checks a create request: a generated, unused id, an existing parent folder. → error Response or null. */
  const checkCreate = (m) => {
    if (!m || typeof m.id !== 'string' || !g.generated.has(m.id)) return json({ error: { code: 400, message: 'id was not generated' } }, 400);
    if (g.files.has(m.id)) return json({ error: { code: 409, message: 'A file already exists with the provided ID.' } }, 409);
    const parent = g.files.get((m.parents || [])[0]);
    if (!Array.isArray(m.parents) || m.parents.length !== 1 || !parent || parent.mimeType !== FOLDER) return json({ error: { code: 404, message: 'parent not found' } }, 404);
    return null;
  };
  function parseMultipart(contentType, buf) {
    const m = /boundary=([^;]+)/.exec(contentType || '');
    if (!m) throw new Error('no boundary');
    const delim = Buffer.from('--' + m[1]);
    const parts = [];
    let pos = buf.indexOf(delim);
    while (pos >= 0) {
      const start = pos + delim.length;
      if (buf.slice(start, start + 2).toString() === '--') break;
      const next = buf.indexOf(delim, start);
      if (next < 0) throw new Error('unterminated multipart');
      const chunk = buf.slice(start + 2, next - 2); // after CRLF, before CRLF--boundary
      const sep = chunk.indexOf(Buffer.from('\r\n\r\n'));
      parts.push({ headers: chunk.slice(0, sep).toString(), body: chunk.slice(sep + 4) });
      pos = next;
    }
    if (parts.length !== 2) throw new Error('expected 2 parts');
    return { metadata: JSON.parse(parts[0].body.toString('utf8')), media: parts[1].body, mediaType: /Content-Type:\s*([^\r\n]+)/i.exec(parts[1].headers)[1].trim() };
  }

  g.handle = async (req) => {
    const url = new URL(req.url);
    const op = url.host === 'oauth2.googleapis.com' ? 'token' : url.pathname.startsWith('/upload/') ? 'upload'
      : url.pathname.endsWith('/generateIds') ? 'generateIds' : req.method === 'POST' ? 'createFolder' : url.searchParams.get('alt') === 'media' ? 'media' : 'get';
    g.log.push({ op, method: req.method, path: url.pathname });
    if (g.delayMs) await new Promise((r) => setTimeout(r, g.delayMs));
    if (op === 'token') {
      g.tokenCalls += 1;
      const f = take('token');
      if (f) return json({ error: f.error || 'server_error' }, f.status || 500);
      const form = new URLSearchParams(await req.text());
      if (form.get('grant_type') !== 'refresh_token' || form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) {
        return json({ error: 'invalid_client' }, 401);
      }
      if (form.get('refresh_token') !== refreshToken) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
      const token = 'ya29.test-' + randomBytes(12).toString('hex');
      g.tokens.add(token);
      return json({ access_token: token, expires_in: 3599, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/drive.file' });
    }
    if (url.host !== 'www.googleapis.com') return json({ error: 'unknown host' }, 404);
    const auth = req.headers.get('authorization') || '';
    if (!auth.startsWith('Bearer ') || !g.tokens.has(auth.slice(7))) return json({ error: { code: 401, message: 'Invalid Credentials' } }, 401);
    const fault = take(op);
    if (op === 'generateIds') {
      if (fault) return json({ error: { code: fault.status } }, fault.status);
      const n = Math.min(1000, Number(url.searchParams.get('count')) || 10);
      const ids = [];
      for (let i = 0; i < n; i++) {
        const id = 'fakeid' + String(++g.counter).padStart(8, '0') + randomBytes(4).toString('hex');
        g.generated.add(id);
        ids.push(id);
      }
      return json({ kind: 'drive#generatedIds', space: 'drive', ids });
    }
    if (op === 'get' || op === 'media') {
      if (fault) return json({ error: { code: fault.status } }, fault.status);
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const f = g.files.get(id);
      if (!f) return json({ error: { code: 404, message: 'File not found: ' + id } }, 404);
      if (op === 'media') return new Response(f.bytes || new Uint8Array(), { status: 200, headers: { 'content-type': f.mimeType } });
      return json(meta(f));
    }
    if (op === 'createFolder') {
      const m = JSON.parse(await req.text());
      const bad = checkCreate(m);
      if (bad) return bad;
      if (fault && !fault.commit) return json({ error: { code: fault.status } }, fault.status);
      const f = newFile(m, null);
      g.files.set(f.id, f);
      if (fault) return json({ error: { code: fault.status } }, fault.status);
      return json({ id: f.id });
    }
    if (op === 'upload') {
      if (url.searchParams.get('uploadType') !== 'multipart') return json({ error: { code: 400, message: 'uploadType' } }, 400);
      const { metadata, media, mediaType } = parseMultipart(req.headers.get('content-type'), Buffer.from(await req.arrayBuffer()));
      if (mediaType !== metadata.mimeType) return json({ error: { code: 400, message: 'media type differs from metadata' } }, 400);
      if (media.length > 5 * 1024 * 1024) return json({ error: { code: 413, message: 'multipart upload is limited to 5 MB' } }, 413);
      const bad = checkCreate(metadata);
      if (bad) return bad;
      if (fault && !fault.commit) return json({ error: { code: fault.status } }, fault.status);
      g.log[g.log.length - 1].id = metadata.id;
      const f = newFile(metadata, new Uint8Array(media));
      g.files.set(f.id, f);
      if (g.afterUpload) g.afterUpload(f);
      if (fault) return json({ error: { code: fault.status } }, fault.status);
      return json(meta(f));
    }
    return json({ error: 'not handled' }, 404);
  };
  /** Files of one folder (by parent id), newest last. */
  g.children = (parentId) => [...g.files.values()].filter((f) => f.parents && f.parents[0] === parentId).sort((a, b) => a.createdAt - b.createdAt);
  return g;
}
