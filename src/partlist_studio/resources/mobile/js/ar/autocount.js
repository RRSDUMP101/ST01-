// นับอัตโนมัติจากภาพ: the person taps ONE piece (a pipe end, a bracket in a bin …) on a still picture. The size of the
// piece is measured around the tap, the picture is scaled so the piece is always about the same number of pixels,
// and every place that looks like the sample - a little smaller or bigger (further from / nearer to the camera),
// turned (when the piece is not round) - becomes a dot. The cut-off between "a piece" and "not a piece" is read
// from the scores of the picture itself; the person moves it with one slider and fixes dots by tapping.
// Pure functions on gray pictures ({g, w, h}): the same code runs in the worker (count-worker.js) and in tests.
//
// Two ways, chosen by the picture:
//  * pieces lying apart on a plain floor / table / pallet (cut plates, brackets, nuts): the pieces are told from the
//    floor (each place against the light of the floor around it, so shadows and uneven light do not count), the patch
//    of the tapped piece gives the area of one piece, and every patch counts by its area (two touching pieces = one
//    patch of twice the area = 2). This is the common case and does not depend on the shape or how it is turned.
//  * pieces packed together (pipe ends in a crate, a stack) - no floor between them: every place that looks like the
//    tapped piece (template matching, a little smaller / bigger / turned).

export const WORK_R = 7; // the radius of the sample in the scaled picture (px)
const MAX_PIXELS = 900000; // the scaled picture never gets bigger than this (speed on a phone)
const SCALES = [0.82, 0.91, 1, 1.1, 1.22];

export function grayOf(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i += 1, j += 4) g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  return { g, w, h, rgba };
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

// ---- pieces apart on a plain floor ---------------------------------------------------------------------------------
function otsu(values, bins = 256, lo = 0, hi = 255) {
  const hist = new Float64Array(bins); let total = 0;
  const k = (bins - 1) / (hi - lo || 1);
  for (let i = 0; i < values.length; i += 1) {
    const b = Math.max(0, Math.min(bins - 1, Math.round((values[i] - lo) * k)));
    hist[b] += 1; total += 1;
  }
  let sum = 0; for (let i = 0; i < bins; i += 1) sum += i * hist[i];
  let wb = 0; let sb = 0; let best = -1; let cut = bins / 2;
  for (let i = 0; i < bins; i += 1) {
    wb += hist[i]; if (!wb || wb === total) continue;
    sb += i * hist[i];
    const mb = sb / wb; const mf = (sum - sb) / (total - wb);
    const between = wb * (total - wb) * (mb - mf) ** 2;
    if (between > best) { best = between; cut = i; }
  }
  return lo + (cut + 0.5) / k;
}

function boxMeans(vals, keep, w, h, rad) { // the mean of the kept pixels in a (2 rad + 1)² box around each pixel
  const W1 = w + 1; const S = new Float64Array(W1 * (h + 1)); const N = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y += 1) {
    let a = 0; let n = 0;
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (keep[i]) { a += vals[i]; n += 1; }
      S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + a;
      N[(y + 1) * W1 + x + 1] = N[y * W1 + x + 1] + n;
    }
  }
  const out = new Float32Array(w * h); const cnt = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.max(0, y - rad); const y1 = Math.min(h, y + rad + 1);
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.max(0, x - rad); const x1 = Math.min(w, x + rad + 1);
      const n = N[y1 * W1 + x1] - N[y0 * W1 + x1] - N[y1 * W1 + x0] + N[y0 * W1 + x0];
      const s = S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0];
      cnt[y * w + x] = n; out[y * w + x] = n ? s / n : NaN;
    }
  }
  return { mean: out, count: cnt };
}

function erodeDilate(mask, w, h, rad, erode) { // a square min (erode) or max (dilate), in two passes
  if (rad <= 0) return mask;
  const tmp = new Uint8Array(w * h); const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let v = erode ? 1 : 0;
      for (let d = -rad; d <= rad; d += 1) {
        const xx = x + d; const m = xx < 0 || xx >= w ? (erode ? 0 : 0) : mask[y * w + xx];
        if (erode ? !m : m) { v = erode ? 0 : 1; break; }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let v = erode ? 1 : 0;
      for (let d = -rad; d <= rad; d += 1) {
        const yy = y + d; const m = yy < 0 || yy >= h ? 0 : tmp[yy * w + x];
        if (erode ? !m : m) { v = erode ? 0 : 1; break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function components(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1); const comps = [];
  for (let start = 0; start < w * h; start += 1) {
    if (!mask[start] || label[start] >= 0) continue;
    const id = comps.length; const stack = [start]; label[start] = id;
    let n = 0; let sx = 0; let sy = 0; let minX = w; let maxX = 0; let minY = h; let maxY = 0; let edge = false;
    const pix = [];
    while (stack.length) {
      const i = stack.pop(); const x = i % w; const y = (i - x) / w;
      n += 1; sx += x; sy += y; pix.push(i);
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const xx = x + dx; const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (mask[j] && label[j] < 0) { label[j] = id; stack.push(j); }
        }
      }
    }
    comps.push({ id, area: n, x: sx / n, y: sy / n, minX, maxX, minY, maxY, edge, pix });
  }
  return { label, comps };
}

// a patch cut at higher levels of the difference map: -> its parts, grown back over the patch level by level (a
// watershed: the boundaries fall in the valleys between the pieces), or null when it stays one
function splitAtLevels(c, d, w, t) {
  if (c.area < 60) return null;
  const bw = c.maxX - c.minX + 1; const bh = c.maxY - c.minY + 1;
  const local = new Int32Array(bw * bh).fill(-2); // -2 not in the patch, -1 in it, k = part k
  const vals = [];
  for (const i of c.pix) {
    const x = i % w; const y = (i - x) / w; local[(y - c.minY) * bw + (x - c.minX)] = -1;
    vals.push(d[i]);
  }
  vals.sort((a, b) => a - b);
  const top = vals[Math.floor(vals.length * 0.8)]; // the body of the pieces (not the odd bright speck of grain)
  const dl = (j) => d[(Math.floor(j / bw) + c.minY) * w + (j % bw) + c.minX];
  let best = null; let bestLevel = 0;
  for (const f of [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75]) {
    const level = t + (top - t) * f;
    const sub = new Uint8Array(bw * bh);
    for (let j = 0; j < sub.length; j += 1) if (local[j] === -1 && dl(j) > level) sub[j] = 1;
    const parts = components(sub, bw, bh).comps.filter((p) => p.area >= c.area * 0.04);
    if (parts.length < 2) continue;
    const big = Math.max(...parts.map((p) => p.area));
    const kept = parts.filter((p) => p.area >= big * 0.3);
    const sum = kept.reduce((a, p) => a + p.area, 0);
    // a gap between pieces is a thin valley: the parts keep most of the patch (grain or a glare stripe that breaks a
    // piece apart leaves far less)
    if (kept.length >= 2 && sum >= c.area * 0.5) { best = kept; bestLevel = level; break; } // the first level that splits
  }
  if (!best) return null;
  const lab = Int32Array.from(local);
  best.forEach((p, k) => { for (const j of p.pix) lab[j] = k; });
  // grow the parts back: first into the pixels that differ most from the floor, the valleys last
  const steps = 12;
  for (let s = 0; s <= steps; s += 1) {
    const level = bestLevel - ((bestLevel - t) * s) / steps - (s === steps ? 1 : 0);
    let frontier = [];
    for (let j = 0; j < lab.length; j += 1) if (lab[j] >= 0) frontier.push(j);
    while (frontier.length) {
      const next = [];
      for (const j of frontier) {
        const x = j % bw; const y = (j - x) / bw;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx; const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
          const q = yy * bw + xx;
          if (lab[q] === -1 && dl(q) >= level) { lab[q] = lab[j]; next.push(q); }
        }
      }
      frontier = next;
    }
  }
  const out = best.map(() => ({ pix: [], sx: 0, sy: 0, minX: Infinity, maxX: -1, minY: Infinity, maxY: -1 }));
  for (let j = 0; j < lab.length; j += 1) {
    if (lab[j] < 0) continue;
    const x = (j % bw) + c.minX; const y = Math.floor(j / bw) + c.minY; const o = out[lab[j]];
    o.pix.push(y * w + x); o.sx += x; o.sy += y;
    if (x < o.minX) o.minX = x; if (x > o.maxX) o.maxX = x; if (y < o.minY) o.minY = y; if (y > o.maxY) o.maxY = y;
  }
  return out.filter((o) => o.pix.length).map((o) => ({ area: o.pix.length, x: o.sx / o.pix.length, y: o.sy / o.pix.length,
    minX: o.minX, maxX: o.maxX, minY: o.minY, maxY: o.maxY, edge: c.edge, pix: o.pix }));
}

function splitDots(comp, k, w) { // k dots over a patch of k touching pieces (k-means on its pixels)
  const step = Math.max(1, Math.floor(comp.pix.length / 4000));
  const pts = [];
  for (let i = 0; i < comp.pix.length; i += step) { const p = comp.pix[i]; pts.push([p % w, Math.floor(p / w)]); }
  // start along the long side of the patch
  const long = comp.maxX - comp.minX >= comp.maxY - comp.minY;
  let cs = Array.from({ length: k }, (_v, j) => (long
    ? [comp.minX + ((j + 0.5) / k) * (comp.maxX - comp.minX), comp.y]
    : [comp.x, comp.minY + ((j + 0.5) / k) * (comp.maxY - comp.minY)]));
  for (let it = 0; it < 12; it += 1) {
    const acc = cs.map(() => [0, 0, 0]);
    for (const [x, y] of pts) {
      let bj = 0; let bd = Infinity;
      for (let j = 0; j < k; j += 1) { const d = (x - cs[j][0]) ** 2 + (y - cs[j][1]) ** 2; if (d < bd) { bd = d; bj = j; } }
      acc[bj][0] += x; acc[bj][1] += y; acc[bj][2] += 1;
    }
    cs = cs.map((c, j) => (acc[j][2] ? [acc[j][0] / acc[j][2], acc[j][1] / acc[j][2]] : c));
  }
  return cs;
}

// a quadratic surface a + bx + cy + dx² + exy + fy² fitted (least squares) to the kept pixels, on a grid of `step`
function fitSurface(vals, keep, w, h, step) {
  const A = Array.from({ length: 6 }, () => new Float64Array(6)); const B = new Float64Array(6);
  let cnt = 0;
  for (let y = 0; y < h; y += step) {
    const v = (2 * y) / h - 1;
    for (let x = 0; x < w; x += step) {
      const i = y * w + x;
      if (!keep[i]) continue;
      const u = (2 * x) / w - 1; const f = [1, u, v, u * u, u * v, v * v];
      for (let a = 0; a < 6; a += 1) { B[a] += f[a] * vals[i]; for (let b = 0; b < 6; b += 1) A[a][b] += f[a] * f[b]; }
      cnt += 1;
    }
  }
  if (cnt < 30) return null;
  for (let a = 0; a < 6; a += 1) A[a][a] += 1e-6 * cnt;
  for (let col = 0; col < 6; col += 1) { // Gauss-Jordan
    let piv = col;
    for (let r = col + 1; r < 6; r += 1) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]]; [B[col], B[piv]] = [B[piv], B[col]];
    const p = A[col][col] || 1e-12;
    for (let r = 0; r < 6; r += 1) {
      if (r === col) continue;
      const k = A[r][col] / p;
      if (!k) continue;
      for (let c = col; c < 6; c += 1) A[r][c] -= k * A[col][c];
      B[r] -= k * B[col];
    }
  }
  return Array.from({ length: 6 }, (_v, a) => B[a] / (A[a][a] || 1e-12));
}

function surfaceAt(c, x, y, w, h) {
  const u = (2 * x) / w - 1; const v = (2 * y) / h - 1;
  return c[0] + c[1] * u + c[2] * v + c[3] * u * u + c[4] * u * v + c[5] * v * v;
}

function shrinkRGBA(rgba, w, h, nw, nh) {
  const out = new Uint8ClampedArray(nw * nh * 4); const sx = w / nw; const sy = h / nh;
  for (let y = 0; y < nh; y += 1) {
    const y0 = Math.floor(y * sy); const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < nw; x += 1) {
      const x0 = Math.floor(x * sx); const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const acc = [0, 0, 0]; let k = 0;
      for (let yy = y0; yy < y1; yy += 1) for (let xx = x0; xx < x1; xx += 1) {
        const i = (yy * w + xx) * 4; acc[0] += rgba[i]; acc[1] += rgba[i + 1]; acc[2] += rgba[i + 2]; k += 1;
      }
      const o = (y * nw + x) * 4; out[o] = acc[0] / k; out[o + 1] = acc[1] / k; out[o + 2] = acc[2] / k; out[o + 3] = 255;
    }
  }
  return out;
}

const SEG_SIDE = 720; // pieces apart on a floor are counted on a picture at most this big (a phone's 1600 px is slow)

// -> a result like countPieces', or null when the picture is not "pieces apart on a plain floor"
export function segmentCount(img, sample) {
  const side = Math.max(img.w, img.h);
  if (side > SEG_SIDE * 1.15) {
    const k = SEG_SIDE / side; const nw = Math.round(img.w * k); const nh = Math.round(img.h * k);
    const small = resize(img, nw, nh);
    if (img.rgba && img.rgba.length >= img.w * img.h * 4) small.rgba = shrinkRGBA(img.rgba, img.w, img.h, nw, nh);
    const res = segmentAt(small, { x: sample.x * (nw / img.w), y: sample.y * (nh / img.h) });
    if (!res) return null;
    const bx = img.w / nw; const by = img.h / nh;
    return { ...res, r: res.r * bx, sample: { x: sample.x, y: sample.y },
      peaks: res.peaks.map((p) => ({ ...p, x: p.x * bx, y: p.y * by })) };
  }
  return segmentAt(img, sample);
}

const why = (k, v) => { if (globalThis.__why) globalThis.__why(k); return v; };

function segmentAt(img, sample) {
  const { g, w, h } = img;
  const n = w * h;
  // 1. the floor: Otsu of the whole picture, the class the tapped piece is not in
  const cut0 = otsu(g);
  const tapI = Math.round(Math.max(0, Math.min(h - 1, sample.y))) * w + Math.round(Math.max(0, Math.min(w - 1, sample.x)));
  let tapV = 0; let tn = 0;
  for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
    const x = Math.round(sample.x) + dx; const y = Math.round(sample.y) + dy;
    if (x >= 0 && y >= 0 && x < w && y < h) { tapV += g[y * w + x]; tn += 1; }
  }
  tapV /= tn || 1;
  let below = 0; for (let i = 0; i < n; i += 1) if (g[i] <= cut0) below += 1;
  // the floor is the bigger part of the picture; the pieces are the other side (darker - or lighter - than the floor)
  const dark = below * 2 < n ? true : below * 2 > n * 1.4 ? false : tapV <= cut0;
  const floor0 = new Uint8Array(n); let floorN = 0;
  for (let i = 0; i < n; i += 1) if ((g[i] > cut0) === dark) { floor0[i] = 1; floorN += 1; }
  if (floorN < n * 0.3) return why(1, null); // little floor showing: packed pieces
  // 2.-3. the light of the floor: a smooth surface over the whole picture (light from one side, a dim corner) fitted
  // to the floor and fitted again without what stands out from it - so a big piece, or a light one, never becomes
  // "floor" -; then how much each place differs from it (relative, so dim corners count the same), and in colour
  const rgba = img.rgba && img.rgba.length >= n * 4 ? img.rgba : null;
  const chans = rgba ? [0, 1, 2].map((c) => { const ch = new Float32Array(n); for (let i = 0; i < n; i += 1) ch[i] = rgba[i * 4 + c]; return ch; }) : null;
  let floor = floor0; let d = new Float32Array(n); let t = 0.16;
  const step = Math.max(1, Math.round(Math.sqrt(n / 40000)));
  for (let pass = 0; pass < 5; pass += 1) {
    const surf = fitSurface(g, floor, w, h, step);
    if (!surf) return why(2, null);
    const surfC = chans ? chans.map((ch) => fitSurface(ch, floor, w, h, step) || surf) : null;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        const b = Math.max(8, surfaceAt(surf, x, y, w, h));
        let v = dark ? (b - g[i]) / b : (g[i] - b) / Math.max(255 - b, 8);
        if (surfC) { // colour: a rusty / brown piece on a grey floor of about the same lightness
          let cd = 0;
          for (let c = 0; c < 3; c += 1) cd += (rgba[i * 4 + c] - surfaceAt(surfC[c], x, y, w, h)) ** 2;
          v = Math.max(v, 0.6 * Math.sqrt(cd) / Math.max(b, 30));
        }
        d[i] = Math.max(0, Math.min(1.5, v));
      }
    }
    { // a little smoothing: the grain of rusty / galvanised steel would leave holes that break a piece apart
      const rb = Math.max(1, Math.round(Math.min(w, h) / 250));
      d = boxMeans(d, new Uint8Array(n).fill(1), w, h, rb).mean;
    }
    // between the floor and the pieces, below a light (rusty, galvanised) piece but above shadows (~10-22 % darker)
    t = Math.max(0.2, 0.7 * otsu(d, 256, 0, 1.5));
    if (pass === 4) break;
    const next = new Uint8Array(n); let nn = 0;
    for (let i = 0; i < n; i += 1) if (d[i] < Math.min(0.12, t * 0.5)) { next[i] = 1; nn += 1; }
    if (nn < n * 0.2) break;
    floor = next;
  }
  // two cut-offs: a patch is a piece when part of it clears t; it reaches out to a low cut-off just above the grain
  // of the floor (a brown plate on brown concrete differs from it only a little)
  let fm = 0; let fq = 0; let fk = 0;
  for (let i = 0; i < n; i += 5) if (d[i] < t * 0.5) { fm += d[i]; fq += d[i] * d[i]; fk += 1; }
  fm /= fk || 1;
  const fsd = Math.sqrt(Math.max(0, fq / (fk || 1) - fm * fm));
  const tLow = Math.max(0.08, Math.min(t * 0.75, fm + 5 * fsd));
  let mask = new Uint8Array(n);
  {
    // ... but only a little way out from what clears t (a stain on the floor must not join two pieces)
    const strong = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) strong[i] = d[i] > t ? 1 : 0;
    const reach = erodeDilate(strong, w, h, Math.max(2, Math.round(Math.min(w, h) * 0.03)), false);
    const low = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) low[i] = d[i] > tLow && reach[i] ? 1 : 0;
    for (const c of components(low, w, h).comps) {
      let strong = 0;
      for (const i of c.pix) if (d[i] > t) strong += 1;
      if (strong >= Math.max(8, c.area * 0.15)) for (const i of c.pix) mask[i] = 1;
    }
  }
  { // the floor must be plain: little change on it compared with how much the pieces differ from it
    let fs = 0; let fn = 0; let ps = 0; let pn = 0;
    for (let i = 0; i < n; i += 7) {
      if (d[i] > t) { ps += d[i]; pn += 1; } else { fs += d[i]; fn += 1; }
    }
    const plain = fn && pn ? (fs / fn) / (ps / pn) : 1;
    if (plain > 0.2) return why(3, null); // a crate, a stack, a busy background: matching the tapped piece works better
  }
  // 4. the tapped piece: its patch and size
  let { label, comps } = components(mask, w, h);
  const nearest = () => {
    let id = label[tapI];
    for (let r = 1; id < 0 && r < Math.min(w, h) / 10; r += 1) {
      for (let a = 0; a < 16 && id < 0; a += 1) {
        const x = Math.round(sample.x + r * Math.cos((a * Math.PI) / 8)); const y = Math.round(sample.y + r * Math.sin((a * Math.PI) / 8));
        if (x >= 0 && y >= 0 && x < w && y < h) id = label[y * w + x];
      }
    }
    return id;
  };
  let sid = nearest();
  if (sid < 0) return why(4, null);
  let sc = comps[sid];
  const size = Math.max(sc.maxX - sc.minX, sc.maxY - sc.minY) + 1;
  // thin bridges and specks away (dust, a scratch): an opening scaled to the piece
  // first a closing: a light piece on a darker floor is grainy at the cut-off - its bits are held together
  // both scaled to the thickness of the piece, not its length: a long thin piece (a rod, a stirrer, a flat bar) is
  // only a few pixels wide and an opening of its length would wipe it out
  const thick = Math.max(2, sc.area / Math.max(1, Math.hypot(sc.maxX - sc.minX + 1, sc.maxY - sc.minY + 1)));
  const rc = Math.max(1, Math.min(6, Math.round(size * 0.025), Math.floor(thick / 3)));
  mask = erodeDilate(erodeDilate(mask, w, h, rc, false), w, h, rc, true);
  const ro = Math.max(1, Math.min(3, Math.round(size * 0.02), Math.floor(thick / 4)));
  mask = erodeDilate(erodeDilate(mask, w, h, ro, true), w, h, ro, false);
  ({ label, comps } = components(mask, w, h));
  // pieces lying close: their shadow fills the gap and joins them into one patch, but the gap is still a valley
  // (a shadow differs from the floor much less than steel does) - so each patch is cut again at higher levels,
  // and when it falls apart into parts of about the same size, the parts are the pieces
  const split = (c, depth) => { const parts = depth < 5 ? splitAtLevels(c, d, w, t) : null; return parts ? parts.flatMap((p) => split(p, depth + 1)) : [c]; };
  const blobs = comps; // the patches as cut at the first level: counted by their whole area
  blobs.forEach((bl, k) => { bl.blob = k; });
  comps = blobs.flatMap((c) => split(c, 0).map((p) => ({ ...p, blob: c.blob })));
  label = new Int32Array(n).fill(-1);
  comps.forEach((c, k) => { c.id = k; for (const i of c.pix) label[i] = k; });
  sid = nearest();
  if (sid < 0) return why(5, null);
  sc = comps[sid];
  if (sc.area > n * 0.6) return why(6, null); // the patch is most of the picture: a pile, not pieces apart
  // 5. the area of one piece. First the whole patches: when several are about the same size and the tapped one is
  // a whole number of them, that is one piece (a glare stripe or grain that cuts a piece in two changes nothing).
  // Only when the patches cannot tell (pieces pushed together into one or two patches) do their parts decide.
  const tb = blobs[sc.blob];
  let unit = tb.area;
  const alikeOf = (list, tol) => {
    let group = [];
    for (const a of list) {
      const g = list.filter((b) => Math.abs(b / a - 1) < tol);
      if (g.length > group.length) group = g;
    }
    return group.sort((a, b) => a - b);
  };
  const blobAreas = blobs.filter((b) => b.area >= tb.area * 0.2).map((b) => b.area);
  const bg = alikeOf(blobAreas, 0.15);
  const whole = (m) => { const r = tb.area / m; return r >= 0.8 && Math.abs(r - Math.round(r)) < 0.25; };
  if (bg.length >= 2 && whole(bg[Math.floor(bg.length / 2)])) {
    unit = bg[Math.floor(bg.length / 2)];
  } else {
    const partAreas = comps.filter((c) => c.area >= sc.area * 0.12).map((c) => c.area); // the tap may be on 4-8 joined
    const pg = alikeOf(partAreas, 0.12);
    if (pg.length >= 2 && pg.length >= partAreas.length * 0.25) {
      const m = pg[Math.floor(pg.length / 2)];
      if (tb.area / m >= 1.6 && sc.area / m >= 0.85 && m >= sc.area / 4.5) unit = m; // plates pushed together
    }
  }
  // one "piece" that covers a quarter of the picture is a crate or a stack seen as one patch (the pipe ends in it
  // touch): matching the tapped piece works better there
  const pieces = blobs.reduce((k, b) => k + (b.area >= unit * 0.55 ? Math.max(1, Math.round(b.area / unit)) : 0), 0);
  if (unit > n * 0.25 || (unit > n * 0.12 && pieces <= 2)) return why(9, null);
  // 6. every patch by its whole area; its dots on its parts
  const peaks = [];
  for (const bl of blobs) {
    const ratio = bl.area / unit;
    if (ratio < 0.2) continue; // dust, a scratch
    let k = Math.max(1, Math.round(ratio));
    let score;
    if (ratio < 0.55) { k = 1; score = 0.45; } // a small bit: a piece seen in part? (counts with the slider up)
    else score = Math.max(0.6, 1 - 0.8 * Math.abs(ratio - k) / Math.max(1, k) - (bl.edge ? 0.05 : 0));
    if (k > 400) return why(7, null);
    const parts = comps.filter((c) => c.blob === bl.blob);
    const ks = parts.map((p) => Math.round(p.area / unit));
    let diff = k - ks.reduce((a, b) => a + b, 0);
    while (diff !== 0) { // the parts' dots add up to the patch's count
      let bj = 0; let bv = -Infinity;
      parts.forEach((p, j) => {
        const v = (p.area / unit - ks[j]) * Math.sign(diff);
        if ((diff > 0 || ks[j] > 0) && v > bv) { bv = v; bj = j; }
      });
      ks[bj] += Math.sign(diff); diff -= Math.sign(diff);
    }
    parts.forEach((p, j) => {
      const dots = ks[j] === 1 ? [[p.x, p.y]] : ks[j] > 1 ? splitDots(p, ks[j], w) : [];
      for (const [x, y] of dots) peaks.push({ x, y, score: Math.round(score * 1000) / 1000 });
    });
  }
  if (!peaks.length) return why(8, null);
  peaks.sort((a, b) => b.score - a.score);
  return { peaks, threshold: 0.55, r: Math.sqrt(unit / Math.PI), sample: { x: sample.x, y: sample.y }, method: 'segment' };
}

// count: img gray picture, sample {x, y} in its pixels (r optional) -> {peaks [{x, y, score}], threshold, r}
export function countPieces(img, sample, opts = {}) {
  if (opts.method !== 'template') {
    const seg = segmentCount(img, sample);
    if (seg) return seg;
  }
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
    threshold, r: r0, sample: { x: sample.x, y: sample.y }, method: 'template',
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
