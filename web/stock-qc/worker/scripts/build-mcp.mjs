// Package the server and its single HTML page for authenticated Cloudflare MCP upload.
// No browser-only artifact, credentials or data are included. Same page/API security handlers as wrangler.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const wr = createRequire(require.resolve('wrangler/package.json'));
const esbuild = wr('esbuild');
execFileSync(process.execPath, [path.join(here, 'build-site.mjs')], { stdio: 'inherit' });
const dir = path.join(root, '.deploy');
fs.mkdirSync(dir, { recursive: true });
let html = fs.readFileSync(path.resolve(root, '../dist/index.html'), 'utf8');
// Minify each inline script without changing the independently scoped global modules.
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
for (const m of scripts.reverse()) {
  const out = await esbuild.transform(m[1], { loader: 'js', minify: true, target: 'es2022' });
  html = html.slice(0, m.index) + '<script>' + out.code.replace(/<\/script/gi, '<\\/script') + '</script>' + html.slice(m.index + m[0].length);
}
const entry = `import app from '../src/index.js';
import page from './page.html';
const ASSETS = {async fetch(req){const p=new URL(req.url).pathname;if(p!=='/'&&p!=='/index.html')return new Response('Not found',{status:404});if(req.method!=='GET'&&req.method!=='HEAD')return new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}});return new Response(req.method==='HEAD'?null:page,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});}};
export default {fetch(req,env,ctx){return app.fetch(req,{...env,ASSETS},ctx);},scheduled(c,env,ctx){return app.scheduled(c,env,ctx);}};`;
fs.writeFileSync(path.join(dir, 'entry.js'), entry);
fs.writeFileSync(path.join(dir, 'page.html'), html);
await esbuild.build({entryPoints:[path.join(dir,'entry.js')],outfile:path.join(dir,'worker.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',conditions:['workerd','worker','browser'],mainFields:['browser','module','main'],loader:{'.html':'text'},minify:true,logLevel:'info'});
console.log('MCP bundle bytes:', fs.statSync(path.join(dir, 'worker.js')).size);
