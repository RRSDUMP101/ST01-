// Synthetic scenes for the auto-count checks (tools/autocount_check.mjs, tools/autocount_robust.mjs).

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
// ---- photos like the store's: cut steel plates on a light floor (RGB, shadows, light from one side, one rusty) ----
function colourPicture(w, h, base, tilt) { // a light floor, brighter on one side, a little texture
  const rgba = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = (y * w + x) * 4; const l = 1 + tilt * (x / w - 0.5) - 0.08 * (y / h);
    rgba[i] = base[0] * l; rgba[i + 1] = base[1] * l; rgba[i + 2] = base[2] * l; rgba[i + 3] = 255;
  }
  return { rgba, w, h };
}
function insidePlate(u, v, s) { // a plate with a hook-shaped notch on its right side (like the photo), in its own frame
  if (Math.abs(u) > s * 0.62 || Math.abs(v) > s * 0.45) return false;
  const nx = u - s * 0.28; const ny = v + s * 0.02;
  if (nx > 0 && Math.abs(ny) < s * 0.1) return false; // the slot
  if (Math.hypot(nx, ny) < s * 0.14 && nx > -s * 0.14) return false; // its round end
  if (u > s * 0.4 && v < -s * 0.18) return false; // the cut corner
  return true;
}
function plate(img, cx, cy, s, angle, colour, shadow = true) {
  const c = Math.cos(angle); const sn = Math.sin(angle);
  const reach = s * 0.8;
  for (const pass of shadow ? [0, 1] : [1]) {
    const ox = pass ? 0 : s * 0.06; const oy = pass ? 0 : s * 0.08; // the shadow falls down-right
    for (let y = Math.floor(cy - reach + oy); y <= cy + reach + oy; y += 1) {
      for (let x = Math.floor(cx - reach + ox); x <= cx + reach + ox; x += 1) {
        if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
        let cover = 0; // 4 x 4 samples: soft edges
        for (let sy = 0; sy < 4; sy += 1) for (let sx = 0; sx < 4; sx += 1) {
          const px = x + (sx + 0.5) / 4 - cx - ox; const py = y + (sy + 0.5) / 4 - cy - oy;
          if (insidePlate(px * c + py * sn, -px * sn + py * c, s)) cover += 1;
        }
        if (!cover) continue;
        const a = cover / 16; const i = (y * img.w + x) * 4;
        for (let k = 0; k < 3; k += 1) {
          const tex = colour[k] * (0.85 + 0.3 * rnd());
          img.rgba[i + k] = pass ? img.rgba[i + k] * (1 - a) + tex * a : img.rgba[i + k] * (1 - 0.22 * a);
        }
      }
    }
  }
}
function finish(img, sigma) { // noise, a little blur, to 0-255, and the gray picture beside the colours
  for (let i = 0; i < img.rgba.length; i += 1) if (i % 4 !== 3) img.rgba[i] += gauss() * sigma;
  const out = new Uint8ClampedArray(img.rgba.length);
  for (let i = 0; i < out.length; i += 1) out[i] = img.rgba[i];
  const g = new Float32Array(img.w * img.h);
  for (let i = 0, j = 0; i < g.length; i += 1, j += 4) g[i] = 0.299 * out[j] + 0.587 * out[j + 1] + 0.114 * out[j + 2];
  return { g, w: img.w, h: img.h, rgba: out };
}
const PLATE_COLOURS = [[58, 48, 46], [74, 60, 52], [150, 118, 92], [52, 44, 44], [66, 54, 50], [60, 56, 58]];
for (const [label, W, gap, scale] of [['รูปเล็ก 210 px (แบบรูปที่ส่งมา)', 210, 4, 1], ['รูปจากมือถือ 1600 px', 1600, 26, 7.6],
  ['ชิ้นวางชิดกัน (ช่อง 2 px)', 420, 2, 2]]) {
  const H = Math.round(W * 0.67);
  const raw = colourPicture(W, H, [214, 212, 206], 0.25);
  const s = 50 * scale; const pts = [];
  for (let row = 0; row < 2; row += 1) for (let col = 0; col < 3; col += 1) {
    const jig = Math.min(3 * scale, gap * 0.8); // pieces lie apart: the jitter never makes them overlap
    const cx = W * 0.2 + col * (s * 1.24 + gap) + (rnd() - 0.5) * jig;
    const cy = H * 0.33 + row * (s * 0.9 + gap) + (rnd() - 0.5) * jig;
    plate(raw, cx, cy, s, (rnd() - 0.5) * 0.12, PLATE_COLOURS[row * 3 + col]); pts.push([cx, cy]);
  }
  const img = finish(raw, 6);
  scenes.push({ name: `แผ่นเหล็กตัด 6 ชิ้นบนพื้นสีอ่อน · ${label}`, img, tap: pts[0], taps: [pts[2], pts[4]], expect: 6, exact: true });
}
{ // 20 plates in a loose heap: some touching, turned every way
  const W = 1400; const H = 1000;
  const raw = colourPicture(W, H, [196, 200, 204], 0.3); const pts = [];
  while (pts.length < 20) {
    const cx = 120 + rnd() * (W - 240); const cy = 110 + rnd() * (H - 220);
    if (pts.every(([x, y]) => Math.hypot(x - cx, y - cy) > 195)) { plate(raw, cx, cy, 120, rnd() * 6.28, PLATE_COLOURS[pts.length % 6]); pts.push([cx, cy]); }
  }
  const img = finish(raw, 7);
  scenes.push({ name: 'แผ่นเหล็ก 20 ชิ้น วางกระจาย หมุนต่างกัน', img, tap: pts[3], taps: [pts[11]], expect: 20, exact: true });
}
{ // 8 plates in two touching pairs and four apart
  const W = 1200; const H = 800;
  const raw = colourPicture(W, H, [210, 206, 198], 0.2); const pts = [];
  const s = 110;
  for (const [cx, cy] of [[200, 220], [200 + s * 1.24, 220], [700, 220], [700, 220 + s * 0.9], [200, 560], [480, 600], [800, 600], [1040, 380]]) {
    plate(raw, cx, cy, s, 0, PLATE_COLOURS[pts.length % 6], false); pts.push([cx, cy]);
  }
  const img = finish(raw, 6);
  scenes.push({ name: 'แผ่นเหล็ก 8 ชิ้น มีคู่ที่ติดกัน 2 คู่', img, tap: pts[5], taps: [pts[0]], expect: 8, exact: true });
}

scenes[0].taps = [[220 + 0, 160], [220 + 3 * 60, 160 + 2 * 66]];
scenes[2].taps = [[130 + 2 * 200 - 30, 140 - 30]];


// ---- like a phone photo in the store: 3 pieces only, a busy floor, glare, the tap not quite on the middle --------
function concrete(img, s) { // stains, grain, a crack: the floor is not plain
  for (let k = 0; k < 14; k += 1) { // stains: soft darker patches about a third of a piece
    const cx = rnd() * img.w; const cy = rnd() * img.h; const r = s * (0.1 + rnd() * 0.35); const f = 0.82 + rnd() * 0.12;
    for (let y = Math.floor(cy - r); y <= cy + r; y += 1) for (let x = Math.floor(cx - r); x <= cx + r; x += 1) {
      if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
      const t = Math.hypot(x - cx, y - cy) / r; if (t > 1) continue;
      const a = 1 - (1 - f) * (1 - t * t); const i = (y * img.w + x) * 4;
      for (let c = 0; c < 3; c += 1) img.rgba[i + c] *= a;
    }
  }
  for (let i = 0; i < img.rgba.length; i += 4) { const v = 1 + (rnd() - 0.5) * 0.12; for (let c = 0; c < 3; c += 1) img.rgba[i + c] *= v; }
  let x = rnd() * img.w; let y = 0; // a crack across
  while (y < img.h) { const i = (Math.round(y) * img.w + Math.max(0, Math.min(img.w - 1, Math.round(x)))) * 4; for (let c = 0; c < 3; c += 1) img.rgba[i + c] *= 0.55; y += 1; x += (rnd() - 0.5) * 2; }
}
function glare(img, cx, cy, s) { // a shiny stripe on a piece (light on steel)
  for (let y = Math.floor(cy - s * 0.3); y <= cy + s * 0.3; y += 1) for (let x = Math.floor(cx - s * 0.5); x <= cx + s * 0.5; x += 1) {
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
    const d = Math.abs((x - cx) * 0.6 - (y - cy)) / (s * 0.08); if (d > 1) continue;
    const a = 0.8 * (1 - d); const i = (y * img.w + x) * 4;
    for (let c = 0; c < 3; c += 1) img.rgba[i + c] = img.rgba[i + c] * (1 - a) + 245 * a;
  }
}
for (const [label, W, floorC, how] of [['พื้นปูนมีคราบ แตะตรงแสงสะท้อน', 1600, [178, 176, 170], 'glare'],
  ['พื้นปูนมีคราบ แตะข้างชิ้น', 1600, [178, 176, 170], 'beside'], ['พื้นขาว รูปเล็ก แตะขอบชิ้น', 320, [222, 222, 218], 'edge'],
  ['พื้นปูนเข้ม ชิ้นเหล็กดำ', 1200, [128, 126, 122], 'middle']]) {
  const H = Math.round(W * 0.75); const raw = colourPicture(W, H, floorC, 0.3);
  const s = W * 0.2; concrete(raw, s);
  const pts = [[W * 0.25, H * 0.35], [W * 0.62, H * 0.3], [W * 0.45, H * 0.7]];
  pts.forEach(([cx, cy], k) => {
    plate(raw, cx, cy, s, (rnd() - 0.5) * 0.8, floorC[0] < 140 ? [40, 36, 34] : PLATE_COLOURS[k]);
    if (how === 'glare' || k === 1) glare(raw, cx - s * 0.1, cy, s);
  });
  const img = finish(raw, 7);
  const [tx, ty] = pts[0];
  const tap = how === 'glare' ? [tx - s * 0.1, ty] : how === 'beside' ? [tx - s * 0.66, ty] : how === 'edge' ? [tx - s * 0.58, ty - s * 0.4] : [tx, ty];
  scenes.push({ name: `3 ชิ้นบน${label}`, img, tap, taps: [pts[1], pts[2]], expect: 3, exact: true });
}

// ---- the store's own test (photo of 6 Nov): 3 light-blue plastic stirrers on a wood-grain table, side by side, the
// spoons almost touching, a portrait phone photo, the tap on the thin middle (between two of them) ------------------
function wood(w, h) {
  const rgba = new Float32Array(w * h * 4);
  const ph = Array.from({ length: 6 }, () => rnd() * 6.28);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const u = x * 0.9 + y * 0.12; // grain across, a little slanted
    const g = 0.5 * Math.sin(u * 0.045 + ph[0] + 2 * Math.sin(y * 0.004 + ph[1])) + 0.3 * Math.sin(u * 0.17 + ph[2]) + 0.2 * Math.sin(u * 0.61 + ph[3]);
    const light = 1 + 0.18 * Math.exp(-(((x - w * 0.55) / (w * 0.25)) ** 2) - (((y - h * 0.35) / (h * 0.3)) ** 2)); // a lamp
    const i = (y * w + x) * 4; const k = (1 + 0.09 * g) * light;
    rgba[i] = 132 * k; rgba[i + 1] = 118 * k; rgba[i + 2] = 104 * k; rgba[i + 3] = 255;
  }
  return { rgba, w, h };
}
function stirrer(img, x0, y0, x1, y1, scale, colour) { // a thin stick, a paddle at the top, a spoon at the bottom
  const L = Math.hypot(x1 - x0, y1 - y0); const ux = (x1 - x0) / L; const uy = (y1 - y0) / L;
  const inside = (px, py) => {
    const t = (px - x0) * ux + (py - y0) * uy; const sd = Math.abs(-(px - x0) * uy + (py - y0) * ux);
    if (t < 0 || t > L) return false;
    if (t < L * 0.2) return sd < 13 * scale; // the paddle
    if (t > L * 0.86) { const c = L * 0.93; return ((t - c) / (L * 0.07)) ** 2 + (sd / (24 * scale)) ** 2 < 1; } // the spoon
    return sd < 5 * scale; // the stick
  };
  const minX = Math.floor(Math.min(x0, x1) - 30 * scale); const maxX = Math.ceil(Math.max(x0, x1) + 30 * scale);
  for (let y = Math.floor(Math.min(y0, y1)); y <= Math.max(y0, y1); y += 1) for (let x = minX; x <= maxX; x += 1) {
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
    let cover = 0; for (let sy = 0; sy < 3; sy += 1) for (let sx = 0; sx < 3; sx += 1) if (inside(x + sx / 3, y + sy / 3)) cover += 1;
    if (!cover) continue;
    const a = cover / 9; const i = (y * img.w + x) * 4; const sheen = 1 + 0.1 * Math.sin(x * 0.3);
    for (let c = 0; c < 3; c += 1) img.rgba[i + c] = img.rgba[i + c] * (1 - a) + colour[c] * sheen * a;
  }
}
for (const [label, W] of [['รูปมือถือแนวตั้ง', 900], ['รูปเล็ก', 360]]) {
  const H = Math.round(W * 1.45); const k = W / 900;
  const raw = wood(W, H);
  const tops = [[W * 0.33, H * 0.34], [W * 0.41, H * 0.33], [W * 0.49, H * 0.34]];
  const bots = [[W * 0.32, H * 0.84], [W * 0.41, H * 0.83], [W * 0.5, H * 0.85]];
  for (let j = 0; j < 3; j += 1) stirrer(raw, tops[j][0], tops[j][1], bots[j][0], bots[j][1], k, [150, 182, 205]);
  const img = finish(raw, 5);
  const mid = (j) => [(tops[j][0] + bots[j][0]) / 2, (tops[j][1] + bots[j][1]) / 2];
  scenes.push({ name: `ไม้คนพลาสติก 3 ชิ้นบนโต๊ะลายไม้ · ${label} · แตะระหว่างก้าน`, img, tap: [(mid(1)[0] + mid(2)[0]) / 2, mid(1)[1] + 30 * k],
    taps: [mid(0), [bots[1][0], bots[1][1] - 20 * k], [tops[2][0], tops[2][1] + 40 * k]], expect: 3, exact: true });
}

export { scenes, colourPicture, plate, finish, PLATE_COLOURS, rnd, gauss };
