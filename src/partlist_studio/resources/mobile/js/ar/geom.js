// Plane geometry of a label the camera sees: its corners on the screen and the homography of its plane,
// so things can be drawn "on" the label (its own x to the right, y down, the label is the unit square).

// Homography from the unit square (0,0) (1,0) (1,1) (0,1) to the quad tl, tr, br, bl (Heckbert).
export function squareToQuad([[x0, y0], [x1, y1], [x2, y2], [x3, y3]]) {
  const dx1 = x1 - x2; const dx2 = x3 - x2; const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2; const dy2 = y3 - y2; const dy3 = y0 - y1 + y2 - y3;
  let a; let b; let c; let d; let e; let f; let g; let h;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    a = x1 - x0; b = x2 - x1; c = x0;
    d = y1 - y0; e = y2 - y1; f = y0;
    g = 0; h = 0;
  } else {
    const det = dx1 * dy2 - dx2 * dy1 || 1e-9;
    g = (dx3 * dy2 - dx2 * dy3) / det;
    h = (dx1 * dy3 - dx3 * dy1) / det;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0;
    d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
  }
  return [a, b, c, d, e, f, g, h];
}

export function project(H, u, v) {
  const [a, b, c, d, e, f, g, h] = H;
  const w = g * u + h * v + 1;
  return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
}

export function center(pts) {
  return [(pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4, (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4];
}

export function side(pts) {
  const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  return (d(pts[0], pts[1]) + d(pts[1], pts[2]) + d(pts[2], pts[3]) + d(pts[3], pts[0])) / 4;
}

// the label's own right (x) and up directions on the screen, unit length
export function axes(pts) {
  const [tl, tr, br, bl] = pts;
  let rx = (tr[0] - tl[0] + br[0] - bl[0]) / 2; let ry = (tr[1] - tl[1] + br[1] - bl[1]) / 2;
  let ux = (tl[0] - bl[0] + tr[0] - br[0]) / 2; let uy = (tl[1] - bl[1] + tr[1] - br[1]) / 2;
  const lr = Math.hypot(rx, ry) || 1; const lu = Math.hypot(ux, uy) || 1;
  rx /= lr; ry /= lr; ux /= lu; uy /= lu;
  return { right: [rx, ry], up: [ux, uy] };
}

// put the corners of a new detection in the order of the last one (detectors may start at another corner)
export function align(prev, pts) {
  if (!prev) return pts;
  let best = pts; let bestD = Infinity;
  for (let k = 0; k < 4; k += 1) {
    const rot = [pts[k % 4], pts[(k + 1) % 4], pts[(k + 2) % 4], pts[(k + 3) % 4]];
    let dsum = 0;
    for (let i = 0; i < 4; i += 1) dsum += Math.hypot(rot[i][0] - prev[i][0], rot[i][1] - prev[i][1]);
    if (dsum < bestD) { bestD = dsum; best = rot; }
  }
  return best;
}

// points of loops (mm, y up) fitted into a box of the label's own plane: [u0, v0, u1, v1] (label = 1 × 1)
export function fitLoops(loops, box) {
  const [u0, v0, u1, v1] = box;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of loops[0] || []) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const w = x1 - x0 || 1; const hgt = y1 - y0 || 1;
  const s = Math.min((u1 - u0) / w, (v1 - v0) / hgt);
  const ou = u0 + ((u1 - u0) - w * s) / 2; const ov = v0 + ((v1 - v0) - hgt * s) / 2;
  return loops.map((loop) => loop.map(([x, y]) => [ou + (x - x0) * s, ov + (y1 - y) * s]));
}
