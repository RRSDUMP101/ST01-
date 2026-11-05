// Synthetic pictures for นับอัตโนมัติ (resources/mobile/js/ar/autocount.js): pipe ends in a crate, seen a little from
// above (the far ones smaller), uneven light, noise, clutter; small pieces; brackets turned every way.
// node tools/autocount_check.mjs  -> one line per scene: expected, found, time; exit 1 when one is off.
import { countPieces, pick } from '../src/partlist_studio/resources/mobile/js/ar/autocount.js';
import { scenes } from './autocount_scenes.mjs';

let bad = 0;
for (const s of scenes) {
  for (const tap of [s.tap, ...(s.taps || [])]) {
    const t = Date.now();
    const res = countPieces(s.img, { x: tap[0], y: tap[1] });
    const n = pick(res, 0.5).length;
    const ok = s.exact ? n === s.expect : Math.abs(n - s.expect) <= Math.max(1, Math.round(s.expect * 0.04));
    if (!ok) bad += 1;
    console.log(`${ok ? 'OK ' : 'BAD'} ${s.name} · แตะ ${tap.map(Math.round)}: expected ${s.expect}, found ${n} `
      + `(${res.method}, r ${res.r.toFixed(1)}, cut ${res.threshold.toFixed(2)}) ${Date.now() - t} ms`);
  }
}
process.exit(bad ? 1 : 0);
