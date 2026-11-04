// นับอัตโนมัติจากภาพ: the person taps ONE piece (a pipe end, a bracket in a bin …) on a still picture. The size of the
// piece is measured around the tap, the picture is scaled so the piece is always about the same number of pixels,
// and every place that looks like the sample - a little smaller or bigger (further from / nearer to the camera),
// turned (when the piece is not round) - becomes a dot. The cut-off between "a piece" and "not a piece" is read
// from the scores of the picture itself; the person moves it with one slider and fixes dots by tapping.
// Pure functions on gray pictures ({g, w, h}): the same code runs in the worker (count-worker.js) and in tests.

export const WORK_R = 7; // the radius of the sample in the scaled picture (px)
const MAX_PIXELS = 900000; // the scaled picture never gets bigger than this (speed on a phone)
const SCALES = [0.82, 0.91, 1, 1.1, 1.22];

export function grayOf(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i += 1, j += 4) g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  return { g, w, h };
}

function at(img, x, y) { // bilinear, clamped at the edge
  const { g, w, h } = img;
  const fx = Math.max(0, Math.min(w - 1.001, x)); const fy = Math.max(0, Math.min(h - 1.001, y));
  const x0 = fx | 0; const y0 = fy | 0; const dx = fx - x0; const dy = fy - y0;
  const i = y0 * w + x0;
  return (g[i] * (1 - dx) + g[i + 1] * dx) * (1 - dy) + (g[i + w] * (1 - dx) + g[i + w + 1] * dx) * dy;
}

export function resize(img, nw, nh) {
  const out = new Float32Array(nw * nh);
  const sx = img.w / nw; const sy = img.h / nh;
  if (sx >= 1.5 || sy >= 1.5) { // smaller: the mean of the pixels under each new one (no aliasing)
    for (let y = 0; y < nh; y += 1) {
      const y0 = Math.floor(y * sy); const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < nw; x += 1) {
        const x0 = Math.floor(x * sx); const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
        let s = 0;
        for (let yy = y0; yy < y1; yy += 1) for (let xx = x0; xx < x1; xx += 1) s += img.g[yy * img.w + xx];
        out[y * nw + x] = s / ((y1 - y0) * (x1 - x0));
      }
    }
  } else {
    for (let y = 0; y < nh; y += 1) for (let x = 0; x < nw; x += 1) out[y * nw + x] = at(img, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5);
  }
  return { g: out, w: nw, h: nh };
}

// the radius of the piece around (x, y): the ring around the tap where the picture changes the most (its edge)
export function estimateRadius(img, x, y, rMin = 3, rMax = 0) {
  rMax = rMax || Math.min(img.w, img.h) / 6;
  let best = 0; let bestR = rMin * 2;
  const step = Math.max(1, rMax / 60);
  for (let r = rMin; r <= rMax; r += step) {
    const n = Math.max(16, Math.round(2 * Math.PI * r));
    let edge = 0;
    for (let k = 0; k < n; k += 1) {
      const a = (2 * Math.PI * k) / n; const c = Math.cos(a); const s = Math.sin(a);
      const inner = at(img, x + c * (r - 1.5), y + s * (r - 1.5)); const outer = at(img, x + c * (r + 1.5), y + s * (r + 1.5));
      edge += Math.abs(outer - inner);
    }
    edge /= n;
    const score = edge * (1 + 0.15 * Math.log(r)); // a slight push to the outer edge (not the hole of a pipe)
    if (score > best) { best = score; bestR = r; }
  }
  return bestR;
}

// the piece around the tap: the patch of picture that stands out from what is around it (a local Otsu cut), grown
// from the tap; -> {x, y, r} its middle and radius. Pieces that touch (pipe ends in a crate) grow into one patch
// that reaches the edge of the window: then the ring of the tap (estimateRadius) is used.
export function measurePiece(img, x, y) {
  const rr = estimateRadius(img, x, y, 3, Math.min(img.w, img.h) / 5);
  let half = Math.round(Math.max(24, Math.min(rr * 4.5, Math.min(img.w, img.h) / 3)));
  for (let k = 0; k < 3; k += 1) { // a long piece tapped at one end: a bigger window, twice
    const found = _patch(img, x, y, rr, half);
    if (found) return found;
    half = Math.min(half * 2, Math.round(Math.min(img.w, img.h) / 2.5));
  }
  return { x, y, r: rr };
}

function _patch(img, x, y, rr, half) {
  const x0 = Math.max(0, Math.round(x) - half); const y0 = Math.max(0, Math.round(y) - half);
  const x1 = Math.min(img.w - 1, Math.round(x) + half); const y1 = Math.min(img.h - 1, Math.round(y) + half);
  const ww = x1 - x0 + 1; const hh = y1 - y0 + 1;
  const hist = new Float64Array(256); let total = 0;
  for (let yy = y0; yy <= y1; yy += 1) {
    for (let xx = x0; xx <= x1; xx += 1) { hist[Math.max(0, Math.min(255, img.g[yy * img.w + xx] | 0))] += 1; total += 1; }
  }
  let sum = 0; for (let i = 0; i < 256; i += 1) sum += i * hist[i];
  let wb = 0; let sb = 0; let best = -1; let cut = 128;
  for (let i = 0; i < 256; i += 1) {
    wb += hist[i]; if (!wb || wb === total) continue;
    sb += i * hist[i];
    const mb = sb / wb; const mf = (sum - sb) / (total - wb);
    const between = wb * (total - wb) * (mb - mf) ** 2;
    if (between > best) { best = between; cut = i; }
  }
  let dark = 0; for (let i = 0; i <= cut; i += 1) dark += hist[i];
  const pieceDark = dark < total / 2; // the piece is the smaller part of the window
  const isPiece = (xx, yy) => (img.g[yy * img.w + xx] <= cut) === pieceDark;
  let sx = -1; let sy = -1;
  for (let d = 0; d <= Math.ceil(rr) && sx < 0; d += 1) { // the tap, or the nearest piece pixel to it
    for (let a = 0; a < 16 && sx < 0; a += 1) {
      const xx = Math.round(x + d * Math.cos((a * Math.PI) / 8)); const yy = Math.round(y + d * Math.sin((a * Math.PI) / 8));
      if (xx >= x0 && yy >= y0 && xx <= x1 && yy <= y1 && isPiece(xx, yy)) { sx = xx; sy = yy; }
    }
  }
  if (sx < 0) return { x, y, r: rr };
  const seen = new Uint8Array(ww * hh); const stack = [[sx, sy]]; seen[(sy - y0) * ww + sx - x0] = 1;
  let minX = sx; let maxX = sx; let minY = sy; let maxY = sy; let n = 0; let edge = false;
  while (stack.length) {
    const [cx, cy] = stack.pop(); n += 1;
    if (cx <= x0 || cy <= y0 || cx >= x1 || cy >= y1) edge = true;
    minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx; const ny = cy + dy;
      if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
      const i = (ny - y0) * ww + nx - x0;
      if (!seen[i] && isPiece(nx, ny)) { seen[i] = 1; stack.push([nx, ny]); }
    }
  }
  const r = Math.max(maxX - minX, maxY - minY) / 2 + 1;
  if (edge) return null; // reaches the edge of the window: a bigger one, or pieces that touch
  if (n < 12 || r < 3) return { x, y, r: rr }; // a speck: the ring around the tap
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, r };
}

function makeTemplate(img, cx, cy, R, scale, angle) {
  const size = 2 * R + 1; const t = new Float32Array(size * size);
  const c = Math.cos(angle) / scale; const s = Math.sin(angle) / scale;
  let mean = 0;
  for (let y = -R; y <= R; y += 1) {
    for (let x = -R; x <= R; x += 1) {
      const v = at(img, cx + x * c - y * s, cy + x * s + y * c);
      t[(y + R) * size + (x + R)] = v; mean += v;
    }
  }
  mean /= t.length;
  let ss = 0;
  for (let i = 0; i < t.length; i += 1) { t[i] -= mean; ss += t[i] * t[i]; }
  return { t, R, size, ss, scale };
}

function ncc(a, b) {
  let s = 0;
  for (let i = 0; i < a.t.length; i += 1) s += a.t[i] * b.t[i];
  return s / Math.sqrt(a.ss * b.ss || 1);
}

function integrals(img) {
  const { g, w, h } = img; const W1 = w + 1;
  const s1 = new Float64Array(W1 * (h + 1)); const s2 = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y += 1) {
    let a = 0; let b = 0;
    for (let x = 0; x < w; x += 1) {
      const v = g[y * w + x]; a += v; b += v * v;
      s1[(y + 1) * W1 + x + 1] = s1[y * W1 + x + 1] + a;
      s2[(y + 1) * W1 + x + 1] = s2[y * W1 + x + 1] + b;
    }
  }
  return { s1, s2, W1 };
}

function scoreAt(img, I, tpl, cx, cy) { // NCC of the template centred at (cx, cy)
  const { g, w } = img; const { t, R, size, ss } = tpl;
  const x0 = cx - R; const y0 = cy - R;
  if (x0 < 0 || y0 < 0 || x0 + size > img.w || y0 + size > img.h) return -1;
  const { s1, s2, W1 } = I; const n = size * size;
  const box = (S) => S[(y0 + size) * W1 + x0 + size] - S[y0 * W1 + x0 + size] - S[(y0 + size) * W1 + x0] + S[y0 * W1 + x0];
  const sum = box(s1); const v = box(s2) - (sum * sum) / n;
  if (v < ss * 0.06) return -1; // a flat place (wall, floor): nothing there
  let cross = 0;
  for (let y = 0; y < size; y += 1) {
    const row = (y0 + y) * w + x0; const tr = y * size;
    for (let x = 0; x < size; x += 1) cross += g[row + x] * t[tr + x];
  }
  return cross / Math.sqrt(v * ss);
}

// the cut-off between the pieces and the rest, from the scores of the peaks (Otsu on two groups)
export function autoThreshold(scores) {
  const s = scores.filter((v) => v > 0.25).sort((a, b) => b - a);
  if (s.length < 3) return 0.6;
  let best = -1; let bestT = 0.6;
  for (let i = 1; i < s.length; i += 1) {
    const hi = s.slice(0, i); const lo = s.slice(i);
    const mh = hi.reduce((a, b) => a + b, 0) / hi.length; const ml = lo.reduce((a, b) => a + b, 0) / lo.length;
    const between = (hi.length * lo.length) * (mh - ml) ** 2;
    if (between > best) { best = between; bestT = (s[i - 1] + s[i]) / 2; }
  }
  return Math.max(0.5, Math.min(0.86, bestT));
}

// count: img gray picture, sample {x, y} in its pixels (r optional) -> {peaks [{x, y, score}], threshold, r}
export function countPieces(img, sample, opts = {}) {
  if (!sample.r) sample = { ...sample, ...measurePiece(img, sample.x, sample.y) };
  const r0 = sample.r;
  let k = WORK_R / r0;
  if (img.w * img.h * k * k > MAX_PIXELS) k = Math.sqrt(MAX_PIXELS / (img.w * img.h));
  k = Math.min(k, 3);
  const nw = Math.max(16, Math.round(img.w * k)); const nh = Math.max(16, Math.round(img.h * k));
  const G = resize(img, nw, nh);
  const kx = nw / img.w; const ky = nh / img.h;
  const sx = sample.x * kx; const sy = sample.y * ky;
  const R = Math.max(4, Math.round(r0 * kx * 1.15)); // the piece and a thin ring of what is around it
  const base = makeTemplate(G, sx, sy, R, 1, 0);
  if (base.ss < 1e-3) return { peaks: [], threshold: 1, r: r0, sample: { x: sample.x, y: sample.y } };
  // a round piece looks the same turned: one turn is enough; else four
  const turned = [Math.PI / 2, Math.PI].map((a) => ncc(base, makeTemplate(G, sx, sy, R, 1, a)));
  const angles = Math.min(...turned) > 0.72 ? [0] : [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
  const templates = [];
  for (const s of opts.scales || SCALES) {
    for (const a of angles) templates.push(makeTemplate(G, sx, sy, Math.max(3, Math.round(R * s)), s, a));
  }
  const I = integrals(G);
  // coarse search every 2 px with every template, the best score per place
  const cw = Math.ceil(nw / 2); const ch = Math.ceil(nh / 2);
  const best = new Float32Array(cw * ch).fill(-1); const which = new Int16Array(cw * ch);
  for (let ti = 0; ti < templates.length; ti += 1) {
    const tpl = templates[ti];
    for (let y = tpl.R; y + tpl.R < nh; y += 2) {
      for (let x = tpl.R; x + tpl.R < nw; x += 2) {
        const v = scoreAt(G, I, tpl, x, y);
        const ci = (y >> 1) * cw + (x >> 1);
        if (v > best[ci]) { best[ci] = v; which[ci] = ti; }
      }
    }
    if (opts.progress) opts.progress((ti + 1) / templates.length);
  }
  // peaks: the highest place of each neighbourhood, refined to 1 px
  const peaks = [];
  for (let y = 1; y < ch - 1; y += 1) {
    for (let x = 1; x < cw - 1; x += 1) {
      const v = best[y * cw + x];
      if (v < 0.3) continue;
      let top = true;
      for (let dy = -1; dy <= 1 && top; dy += 1) for (let dx = -1; dx <= 1; dx += 1) if ((dx || dy) && best[(y + dy) * cw + x + dx] > v) { top = false; break; }
      if (!top) continue;
      const tpl = templates[which[y * cw + x]];
      let bv = v; let bx = x * 2; let by = y * 2;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const s = scoreAt(G, I, tpl, x * 2 + dx, y * 2 + dy);
          if (s > bv) { bv = s; bx = x * 2 + dx; by = y * 2 + dy; }
        }
      }
      peaks.push({ x: bx, y: by, score: bv, R: tpl.R });
    }
  }
  peaks.sort((a, b) => b.score - a.score);
  // one dot per piece: pieces may touch (centres about one diameter apart), not overlap
  const kept = [];
  for (const p of peaks) {
    if (kept.length >= 800) break;
    const minD = 1.2 * Math.min(p.R, R) / 1.15;
    if (kept.every((q) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 > minD * minD)) kept.push(p);
  }
  // the sample is a piece even when the search did not put a peak right on it
  if (!kept.some((q) => (q.x - sx) ** 2 + (q.y - sy) ** 2 < (R * 0.8) ** 2)) kept.unshift({ x: sx, y: sy, score: 1, R });
  const threshold = autoThreshold(kept.map((p) => p.score));
  return {
    peaks: kept.map((p) => ({ x: p.x / kx, y: p.y / ky, score: Math.round(p.score * 1000) / 1000 })),
    threshold, r: r0, sample: { x: sample.x, y: sample.y },
  };
}

// the dots of a result for a slider position: sensitivity 0..1 (0.5 = the cut-off read from the picture)
export function pick(result, sensitivity = 0.5) {
  if (!result) return [];
  const t = Math.max(0.3, Math.min(0.97, result.threshold - (sensitivity - 0.5) * 0.36));
  return result.peaks.map((p, i) => ({ ...p, i, unsure: p.score < t + 0.06 })).filter((p) => p.score >= t);
}

// ---- on the phone: count a still picture (canvas) in a worker; x, y, r in the canvas' pixels ----------------------
const MAX_SIDE = 1600;
let worker = null;
let ids = 0;

export function countOnPicture(canvas, x, y, r = 0) {
  const k = Math.min(1, MAX_SIDE / Math.max(canvas.width, canvas.height));
  const w = Math.round(canvas.width * k); const h = Math.round(canvas.height * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const read = () => ctx.getImageData(0, 0, w, h).data;
  const back = (res) => ({ ...res, r: res.r / k, sample: { x: res.sample.x / k, y: res.sample.y / k },
    peaks: res.peaks.map((p) => ({ ...p, x: p.x / k, y: p.y / k })) });
  const here = () => back(countPieces(grayOf(read(), w, h), { x: x * k, y: y * k, r: r * k }));
  if (!worker) {
    try {
      worker = new Worker(new URL('./count-worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      worker = false; // no module workers: on this thread (a short wait)
    }
  }
  if (!worker) return Promise.resolve(here());
  const id = ++ids;
  return new Promise((resolve, reject) => {
    const done = (e) => {
      if (e.data.id !== id) return;
      worker.removeEventListener('message', done);
      if (e.data.ok) resolve(back(e.data.res));
      else reject(new Error(e.data.error));
    };
    worker.addEventListener('message', done);
    worker.onerror = () => { worker = false; resolve(here()); };
    const rgba = read();
    worker.postMessage({ id, rgba, w, h, x: x * k, y: y * k, r: r * k }, [rgba.buffer]);
  });
}
