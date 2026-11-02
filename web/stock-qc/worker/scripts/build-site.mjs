// Builds the page in ../dist for server mode (window.RRS_CONFIG = {api: '/api'}) and refreshes the engine imports.
// Same as `RRS_API=/api node build.mjs` in web/stock-qc, but works on Windows too. Run before `wrangler deploy`.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, [path.join(here, 'sync-engine.mjs')], { stdio: 'inherit' });
execFileSync(process.execPath, ['build.mjs'], { cwd: path.resolve(here, '..', '..'), stdio: 'inherit', env: Object.assign({}, process.env, { RRS_API: '/api' }) });
