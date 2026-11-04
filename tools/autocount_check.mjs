// Synthetic pictures for นับอัตโนมัติ (resources/mobile/js/ar/autocount.js): pipe ends in a crate, seen a little from
// above (the far ones smaller), uneven light, noise, clutter; small pieces; brackets turned every way.
// node tools/autocount_check.mjs  -> one line per scene: expected, found, time; exit 1 when one is off.
import { countPieces, pick } from '../src/partlist_studio/resources/mobile/js/ar/autocount.js';

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());

function picture(w, h, light = true) {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) g[y * w + x] = 120 + (light ? 50 * (x / w) - 30 * (y / h) : 0);
  return { g, w, h };
}
function disc(img, cx, cy, r, fn) {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
      const d = Math.hypot(x - cx, y - cy);
      const v = fn(d / r);
      if (v !== null) img.g[y * img.w + x] = v;
    }
  }
}
const pipe = (shade) => (t) => (t > 1 ? null : t > 0.72 ? 70 + shade : 205 + shade); // dark wall, light inside
function noise(img, s) { for (let i = 0; i < img.g.length; i += 1) img.g[i] += gauss() * s; }
function rect(img, x0, y0, w, h, v) { for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) if (x >= 0 && y >= 0 && x < img.w && y < img.h) img.g[y * img.w + x] = v; }
function bracket(img, cx, cy, s, turn) { // an L, turned by turn × 90°
  const pts = [];
  for (let a = -s; a <= s; a += 1) for (let b = -s; b <= -s + s * 0.45; b += 1) pts.push([a, b]);
  for (let a = -s; a <= -s + s * 0.45; a += 1) for (let b = -s; b <= s; b += 1) pts.push([a, b]);
  for (const [a, b] of pts) {
    let x = a; let y = b;
    for (let k = 0; k < turn; k += 1) [x, y] = [-y, x];
    const px = Math.round(cx + x); const py = Math.round(cy + y);
    if (px >= 0 && py >= 0 && px < img.w && py < img.h) img.g[py * img.w + px] = 60;
  }
}

const scenes = [];
{ // a crate of pipe ends, 8 x 6, rows further away are smaller
  const img = picture(1280, 960); const pts = [];
  for (let row = 0; row < 6; row += 1) {
    const r = 34 * (0.8 + 0.04 * row);
    for (let col = 0; col < 8; col += 1) {
      const cx = 220 + col * (2 * r + 6) + (row % 2) * r; const cy = 160 + row * (2 * r + 4);
      disc(img, cx, cy, r * (0.95 + 0.1 * rnd()), pipe(Math.round(gauss() * 8))); pts.push([cx, cy]);
    }
  }
  rect(img, 40, 40, 120, 600, 90); rect(img, 1150, 700, 100, 30, 230); noise(img, 9);
  scenes.push({ name: 'ปลายท่อในลัง 48 ชิ้น (ไกล-ใกล้ ขนาดต่างกัน)', img, tap: pts[20], expect: 48 });
}
{ // small pipe ends scattered, touching here and there
  const img = picture(1280, 720); const pts = [];
  while (pts.length < 60) {
    const cx = 60 + rnd() * 1160; const cy = 60 + rnd() * 600;
    if (pts.every(([x, y]) => Math.hypot(x - cx, y - cy) > 24)) { disc(img, cx, cy, 11, pipe(0)); pts.push([cx, cy]); }
  }
  noise(img, 7);
  scenes.push({ name: 'ชิ้นเล็ก 60 ชิ้น กระจาย', img, tap: pts[0], expect: 60 });
}
{ // brackets turned every way on a pallet
  const img = picture(1280, 960, false); const pts = [];
  for (let i = 0; i < 24; i += 1) {
    const cx = 130 + (i % 6) * 200; const cy = 140 + Math.floor(i / 6) * 220;
    bracket(img, cx, cy, 38, Math.floor(rnd() * 4)); pts.push([cx, cy]);
  }
  noise(img, 8);
  scenes.push({ name: 'ขาจับรูปตัว L 24 ชิ้น หมุนต่างกัน', img, tap: pts[5], expect: 24 });
}

function blur(img) { // a little out of focus (box 3 x 3, twice)
  for (let k = 0; k < 2; k += 1) {
    const g = new Float32Array(img.g);
    for (let y = 1; y < img.h - 1; y += 1) for (let x = 1; x < img.w - 1; x += 1) {
      let s = 0; for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) s += img.g[(y + dy) * img.w + x + dx];
      g[y * img.w + x] = s / 9;
    }
    img.g = g;
  }
}
{ // a dense crate, pipe ends touching (hexagonal), dim and a little out of focus
  const img = picture(1280, 960); const pts = [];
  const r = 26;
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 11; col += 1) {
      const cx = 140 + col * 2 * r + (row % 2) * r; const cy = 120 + row * r * 1.74;
      disc(img, cx, cy, r * (0.96 + 0.08 * rnd()), (t2) => (t2 > 1 ? null : t2 > 0.75 ? 95 : 150)); pts.push([cx, cy]);
    }
  }
  blur(img); noise(img, 10);
  scenes.push({ name: 'ปลายท่อชิดกัน 99 ชิ้น แสงน้อย ภาพไม่ชัด', img, tap: pts[40], taps: [pts[0], pts[60], pts[98]], expect: 99 });
}
scenes[0].taps = [[220 + 0, 160], [220 + 3 * 60, 160 + 2 * 66]];
scenes[2].taps = [[130 + 2 * 200 - 30, 140 - 30]];

let bad = 0;
for (const s of scenes) {
  for (const tap of [s.tap, ...(s.taps || [])]) {
    const t = Date.now();
    const res = countPieces(s.img, { x: tap[0], y: tap[1] });
    const n = pick(res, 0.5).length;
    const ok = Math.abs(n - s.expect) <= Math.max(1, Math.round(s.expect * 0.04));
    if (!ok) bad += 1;
    console.log(`${ok ? 'OK ' : 'BAD'} ${s.name} · แตะ ${tap.map(Math.round)}: expected ${s.expect}, found ${n} `
      + `(r ${res.r.toFixed(1)}, cut ${res.threshold.toFixed(2)}) ${Date.now() - t} ms`);
  }
}
process.exit(bad ? 1 : 0);
