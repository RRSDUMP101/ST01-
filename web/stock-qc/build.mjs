// Builds one self-contained page from src/: the engine, the stores, the UI kit, every page and the shell.
//   node build.mjs              -> dist/artifact.html (page content for a claude.ai artifact)
//                                  dist/index.html    (full HTML document for Cloudflare Pages / any static host)
//   RRS_API=https://…/api node build.mjs   also writes window.RRS_CONFIG = {api} into dist/index.html (server mode)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (...p) => path.join(here, 'src', ...p);
const read = (p) => fs.readFileSync(p, 'utf8');

const order = JSON.parse(read(src('engine', 'order.json')));
// RRS_ENGINE_ONLY=planning.js,… (or "none") builds with the base engine plus only those modules
const BASE = ['core.js', 'ledger.js', 'master.js', 'inventory.js'];
const only = process.env.RRS_ENGINE_ONLY ? process.env.RRS_ENGINE_ONLY.split(',').map((x) => x.trim()) : null;
const engine = order.filter((f) => (!only || BASE.includes(f) || only.includes(f)) && fs.existsSync(src('engine', f))).map((f) => src('engine', f));
const pagesDir = src('ui', 'pages');
const pages = fs.existsSync(pagesDir) ? fs.readdirSync(pagesDir).filter((f) => f.endsWith('.js')).sort().map((f) => path.join(pagesDir, f)) : [];
const files = [...engine, src('store', 'stores.js'), src('ui', 'kit.js'), ...pages, src('ui', 'app.js')];

const outDir = process.env.RRS_OUT ? path.resolve(process.env.RRS_OUT) : path.join(here, 'dist');
const scripts = files.map((f) => {
  const code = read(f).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  return `<script>/* ${path.relative(here, f)} */\n${code}\n</script>`;
}).join('\n');

const template = read(src('index.html'));
const css = ['styles.css', 'redesign.css', 'product-photos.css'].filter(f => fs.existsSync(src('ui', f))).map(f => read(src('ui', f))).join('\n');
const fragment = (config) => template.replace('/*STYLE*/', css).replace('<!--CONFIG-->', config || '').replace('<!--SCRIPTS-->', scripts);

fs.mkdirSync(outDir, { recursive: true });
const artifact = fragment('');
fs.writeFileSync(path.join(outDir, 'artifact.html'), artifact);

const api = process.env.RRS_API || '';
const config = api ? `<script>window.RRS_CONFIG = ${JSON.stringify({ api })};</script>` : '';
const reset = ':root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}';
const full = `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${reset}</style></head><body>\n${fragment(config)}\n</body></html>\n`;
fs.writeFileSync(path.join(outDir, 'index.html'), full);

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(0);
console.log(`built ${files.length} scripts → ${path.relative(here, outDir) || '.'} · artifact.html ${kb(artifact)} KB · index.html ${kb(full)} KB${api ? ' · server ' + api : ''}`);
