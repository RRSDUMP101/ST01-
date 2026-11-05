// นับอัตโนมัติ: 60 random photos of cut plates on a floor (sizes 210-1600 px, five floors from white to dark concrete,
// light from either side, shadows or none, gaps 2 px up and touching-ish, one in five a light/rusty plate).
// node tools/autocount_robust.mjs [case] -> the exact share; with a case number: that one, and case<N>.pgm.
import { countPieces, pick } from '../src/partlist_studio/resources/mobile/js/ar/autocount.js';
import { colourPicture, plate, finish, PLATE_COLOURS } from './autocount_scenes.mjs';

let seed = 101; const r = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const floors = [[214, 212, 206], [160, 158, 150], [190, 180, 160], [120, 122, 125], [230, 230, 228]];
const ONLY = process.argv[2] ? +process.argv[2] : -1;
let ok = 0; let tot = 0; const fails = [];
for (let t = 0; t < 60; t += 1) {
  const W = [210, 420, 900, 1600][t % 4]; const H = Math.round(W * (0.6 + r() * 0.2));
  const floor = floors[t % floors.length];
  const raw = colourPicture(W, H, floor, (r() - 0.3) * 0.6);
  const cols = 2 + Math.floor(r() * 3); const rows = 1 + Math.floor(r() * 3);
  const s = Math.min(W / (cols * 1.6), H / (rows * 1.3)); const gap = Math.max(2, s * (0.02 + r() * 0.15));
  const pts = [];
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
    const cx = s * 0.8 + col * (s * 1.24 + gap) + (r() - 0.5) * gap * 0.6;
    const cy = s * 0.6 + row * (s * 0.9 + gap) + (r() - 0.5) * gap * 0.6;
    let c = PLATE_COLOURS[Math.floor(r() * 6)];
    if (floor[0] < 140) c = c.map((v) => v * 0.6); // a dark floor: darker steel
    plate(raw, cx, cy, s, (r() - 0.5) * 0.3, c, r() < 0.8); pts.push([cx, cy]);
  }
  const img = finish(raw, 4 + r() * 6);
  const tap = pts[Math.floor(r() * pts.length)];
  if (ONLY >= 0 && t !== ONLY) continue;
  const res = countPieces(img, { x: tap[0], y: tap[1] });
  const n = pick(res, 0.5).length; tot += 1;
  if (ONLY >= 0) {
    const fs = await import('fs');
    fs.writeFileSync(`case${t}.pgm`, Buffer.concat([Buffer.from(`P5 ${img.w} ${img.h} 255\n`),
      Buffer.from(Uint8Array.from(img.g, (v) => Math.max(0, Math.min(255, v))))]));
    console.log('tap', tap.map(Math.round), 'dots', pick(res, 0.5).map((p) => [Math.round(p.x), Math.round(p.y), p.score]));
  }
  if (n === pts.length) ok += 1;
  else fails.push(`#${t} W${W} floor${floor[0]} ${cols}x${rows} gap${gap.toFixed(1)} -> ${n}/${pts.length} (${res.method})`);
}
console.log(`exact ${ok}/${tot}`);
if (fails.length) console.log(fails.join('\n'));
