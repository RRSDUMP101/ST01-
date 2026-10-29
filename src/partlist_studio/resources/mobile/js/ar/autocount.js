// นับอัตโนมัติจากภาพ: the person taps one piece (a pipe end, a bracket in a bin …) and sets its size; every place of
// the still picture that looks like it (normalised cross-correlation of the sample) becomes a dot to check by hand.

const WORK = 360; // the picture is searched at this width (fast enough on a phone)

function gray(canvas) {
  const s = WORK / canvas.width;
  const w = WORK; const h = Math.max(1, Math.round(canvas.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i += 1, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  return { g, w, h };
}

// sample: {x, y, r} as fractions of the picture (r of its width); sensitivity 0..1 (more = more dots)
export function autoCount(canvas, sample, sensitivity = 0.5) {
  const { g, w, h } = gray(canvas);
  const r = Math.max(3, Math.round(sample.r * w));
  const size = 2 * r + 1;
  const cx = Math.round(sample.x * w); const cy = Math.round(sample.y * h);
  if (cx - r < 0 || cy - r < 0 || cx + r >= w || cy + r >= h) return [];
  // the sample, without its mean
  const n = size * size;
  const t = new Float32Array(n);
  let mean = 0;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) { t[y * size + x] = g[(cy - r + y) * w + (cx - r + x)]; mean += t[y * size + x]; }
  mean /= n;
  let tss = 0;
  for (let i = 0; i < n; i += 1) { t[i] -= mean; tss += t[i] * t[i]; }
  if (tss < 1e-3) return [];
  // sums of the picture and of its squares, for the mean and spread under the sample at every place
  const W1 = w + 1;
  const s1 = new Float64Array(W1 * (h + 1)); const s2 = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y += 1) {
    let a = 0; let b = 0;
    for (let x = 0; x < w; x += 1) {
      const v = g[y * w + x];
      a += v; b += v * v;
      s1[(y + 1) * W1 + x + 1] = s1[y * W1 + x + 1] + a;
      s2[(y + 1) * W1 + x + 1] = s2[y * W1 + x + 1] + b;
    }
  }
  const box = (S, x0, y0) => S[(y0 + size) * W1 + x0 + size] - S[y0 * W1 + x0 + size] - S[(y0 + size) * W1 + x0] + S[y0 * W1 + x0];
  const step = r > 8 ? 2 : 1;
  const scores = [];
  for (let y0 = 0; y0 + size <= h; y0 += step) {
    for (let x0 = 0; x0 + size <= w; x0 += step) {
      const sum = box(s1, x0, y0);
      const var_ = box(s2, x0, y0) - (sum * sum) / n;
      if (var_ < tss * 0.08) continue; // flat area: nothing there
      let cross = 0;
      for (let y = 0; y < size; y += 1) {
        const row = (y0 + y) * w + x0; const trow = y * size;
        for (let x = 0; x < size; x += 1) cross += g[row + x] * t[trow + x];
      }
      const score = cross / Math.sqrt(var_ * tss);
      scores.push([score, x0 + r, y0 + r]);
    }
  }
  const threshold = 0.86 - 0.36 * Math.max(0, Math.min(1, sensitivity));
  scores.sort((a, b) => b[0] - a[0]);
  const keep = [];
  const minD2 = (size * 0.75) ** 2;
  for (const [score, x, y] of scores) {
    if (score < threshold) break;
    if (keep.every((k) => (k[1] - x) ** 2 + (k[2] - y) ** 2 > minD2)) keep.push([score, x, y]);
    if (keep.length >= 400) break;
  }
  return keep.map(([score, x, y]) => ({ x: x / w, y: y / h, score }));
}
