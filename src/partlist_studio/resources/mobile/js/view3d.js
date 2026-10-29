// The part in 3D: its flat pattern from the DWG (outer loop + holes) as a plate of its thickness.
// Drawn on a 2D canvas (faces sorted back to front), turned by dragging, zoomed by pinching.
import { api } from './api.js';
import { Icon } from './icons.js';
import { html, num, useEffect, useRef, useState } from './lib.js';

function signedArea(loop) {
  let a = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export class PlateModel {
  constructor({ loops, thickness, bends }) {
    const outer = loops[0] || [];
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const [x, y] of outer) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    this.w = x1 - x0; this.h = y1 - y0;
    const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2;
    this.size = Math.max(this.w, this.h) || 1;
    const t = Math.max(Number(thickness) || 0, this.size * 0.012, 0.5);
    this.t = Number(thickness) || 0;
    // outer loop counter-clockwise, holes clockwise: the side walls face away from the material
    this.loops = loops.filter((l) => l.length >= 3).map((loop, i) => {
      let pts = loop.map(([x, y]) => [x - cx, y - cy]);
      const ccw = signedArea(pts) > 0;
      if ((i === 0) !== ccw) pts = pts.reverse();
      return pts;
    });
    this.half = t / 2;
    this.box = [[x0 - cx, y0 - cy], [x1 - cx, y0 - cy], [x1 - cx, y1 - cy], [x0 - cx, y1 - cy]];
    this.bends = (bends || []).map((ln) => ln.map(([x, y]) => [x - cx, y - cy]));
    this.walls = [];
    for (const loop of this.loops) {
      for (let i = 0; i < loop.length; i += 1) {
        const a = loop[i]; const b = loop[(i + 1) % loop.length];
        const dx = b[0] - a[0]; const dy = b[1] - a[1];
        const len = Math.hypot(dx, dy) || 1;
        this.walls.push({ a, b, n: [dy / len, -dx / len] });
      }
    }
  }
}

export function drawPlate(ctx, model, view, W, H, colors) {
  const { yaw, pitch, zoom } = view;
  const cy = Math.cos(yaw); const sy = Math.sin(yaw);
  const cp = Math.cos(pitch); const sp = Math.sin(pitch);
  // fit: the box of the part as seen now (no perspective), eased so turning does not jump
  let ex0 = Infinity; let ex1 = -Infinity; let ey0 = Infinity; let ey1 = -Infinity;
  for (const [x, y] of model.box) {
    for (const z of [-model.half, model.half]) {
      const x1 = x * cy - y * sy;
      const y2 = (x * sy + y * cy) * cp - z * sp;
      ex0 = Math.min(ex0, x1); ex1 = Math.max(ex1, x1); ey0 = Math.min(ey0, y2); ey1 = Math.max(ey1, y2);
    }
  }
  const fit = Math.min((W * 0.86) / Math.max(1e-6, ex1 - ex0), (H * 0.74) / Math.max(1e-6, ey1 - ey0));
  view.fit = view.fit ? view.fit + (fit - view.fit) * 0.12 : fit;
  const scale = view.fit * zoom;
  const dist = model.size * 2.6;
  // part coordinates: x, y on the plate, z through it; camera looks down -z after yaw (about z) and pitch (about x)
  const tf = (x, y, z) => {
    const x1 = x * cy - y * sy;
    const y1 = x * sy + y * cy;
    const y2 = y1 * cp - z * sp;
    const z2 = y1 * sp + z * cp;
    const f = dist / (dist - z2);
    return [W / 2 + x1 * scale * f, H / 2 - y2 * scale * f, z2];
  };
  const normal = (nx, ny, nz) => {
    const x1 = nx * cy - ny * sy;
    const y1 = nx * sy + ny * cy;
    return [x1, y1 * cp - nz * sp, y1 * sp + nz * cp];
  };
  const light = [-0.35, 0.55, 0.76];
  const shade = (n) => Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
  ctx.clearRect(0, 0, W, H);
  const topN = normal(0, 0, 1);
  const front = topN[2] >= 0 ? model.half : -model.half; // the face the camera sees
  const backZ = -front;
  const faces = [];
  for (const w of model.walls) {
    const n = normal(w.n[0], w.n[1], 0);
    if (n[2] <= 0) continue; // faces away
    const p = [tf(w.a[0], w.a[1], backZ), tf(w.b[0], w.b[1], backZ), tf(w.b[0], w.b[1], front), tf(w.a[0], w.a[1], front)];
    faces.push({ p, z: (p[0][2] + p[1][2] + p[2][2] + p[3][2]) / 4, light: shade(n) });
  }
  faces.sort((a, b) => a.z - b.z);
  const path = (z) => {
    ctx.beginPath();
    for (const loop of model.loops) {
      loop.forEach(([x, y], i) => {
        const [sx, sy2] = tf(x, y, z);
        if (i) ctx.lineTo(sx, sy2); else ctx.moveTo(sx, sy2);
      });
      ctx.closePath();
    }
  };
  // the far face, the walls, the near face with its holes open
  path(backZ);
  ctx.fillStyle = colors.back;
  ctx.fill('evenodd');
  for (const f of faces) {
    ctx.beginPath();
    f.p.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    const l = 0.42 + 0.58 * f.light;
    ctx.fillStyle = `rgb(${Math.round(colors.wall[0] * l)},${Math.round(colors.wall[1] * l)},${Math.round(colors.wall[2] * l)})`;
    ctx.fill();
  }
  path(front);
  const l = 0.55 + 0.45 * shade(front > 0 ? topN : [-topN[0], -topN[1], -topN[2]]);
  ctx.fillStyle = `rgb(${Math.round(colors.face[0] * l)},${Math.round(colors.face[1] * l)},${Math.round(colors.face[2] * l)})`;
  ctx.fill('evenodd');
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = colors.edge;
  ctx.stroke();
  if (model.bends.length) {
    ctx.save();
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = colors.bend;
    ctx.lineWidth = 1.6;
    for (const ln of model.bends) {
      ctx.beginPath();
      ln.forEach(([x, y], i) => {
        const [sx, sy2] = tf(x, y, front);
        if (i) ctx.lineTo(sx, sy2); else ctx.moveTo(sx, sy2);
      });
      ctx.stroke();
    }
    ctx.restore();
  }
}

const COLORS = {
  light: { face: [176, 196, 222], wall: [120, 140, 168], back: '#7d8ea8', edge: 'rgba(15,34,56,.55)', bend: '#F28C28' },
  dark: { face: [150, 178, 214], wall: [96, 118, 150], back: '#3b4b63', edge: 'rgba(230,240,255,.55)', bend: '#FFB257' },
};

const cache = new Map();
export function loadOutline(code) {
  if (!cache.has(code)) cache.set(code, api.get('outline', { code }).catch((e) => { cache.delete(code); throw e; }));
  return cache.get(code);
}

export function Part3D({ code, height = 220, auto = true, compact = false }) {
  const canvas = useRef(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const view = useRef({ yaw: -0.35, pitch: 0.85, zoom: 1, spin: auto });
  useEffect(() => {
    let live = true;
    setData(null);
    setError('');
    if (code) loadOutline(code).then((d) => live && setData(d)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [code]);
  useEffect(() => {
    if (!data || !canvas.current) return undefined;
    const model = new PlateModel(data);
    const el = canvas.current;
    const ctx = el.getContext('2d');
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    let raf = 0; let last = performance.now(); let idle = 0;
    const pointers = new Map();
    let pinch = 0;
    const frame = (now) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = el.clientWidth; const H = el.clientHeight;
      if (el.width !== Math.round(W * dpr)) { el.width = Math.round(W * dpr); el.height = Math.round(H * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (view.current.spin && now > idle) view.current.yaw += dt * 0.5;
      drawPlate(ctx, model, view.current, W, H, dark ? COLORS.dark : COLORS.light);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const down = (e) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      idle = performance.now() + 4000;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
      }
    };
    const move = (e) => {
      if (!pointers.has(e.pointerId)) return;
      const [px, py] = pointers.get(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      idle = performance.now() + 4000;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch) view.current.zoom = Math.max(0.5, Math.min(4, view.current.zoom * (d / pinch)));
        pinch = d;
        return;
      }
      view.current.yaw += (e.clientX - px) * 0.012;
      view.current.pitch = Math.max(-1.45, Math.min(1.45, view.current.pitch + (e.clientY - py) * 0.01));
    };
    const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = 0; };
    const wheel = (e) => {
      e.preventDefault();
      view.current.zoom = Math.max(0.5, Math.min(4, view.current.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
    };
    const dbl = () => { view.current = { yaw: -0.35, pitch: 0.85, zoom: 1, spin: auto }; };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('dblclick', dbl);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('dblclick', dbl);
    };
  }, [data]);
  if (error) {
    return html`<div class="view3d empty3d" style=${`height:${height}px`}><${Icon} name="cube" size=${30} stroke=${1.5} /><span>${error}</span></div>`;
  }
  return html`<div class=${compact ? 'view3d compact' : 'view3d'} style=${`height:${height}px`}>
    <canvas ref=${canvas} aria-label="ภาพ 3 มิติของชิ้นงาน (ลากเพื่อหมุน)"></canvas>
    ${data ? html`<div class="view3d-dims">${num(data.width, 0)} × ${num(data.length, 0)} มม.${data.thickness ? ` · t${num(data.thickness)}` : ''}${data.material ? ` · ${data.material}` : ''}</div>`
    : html`<div class="view3d-load"><span class="spinner"></span></div>`}
    ${!compact && data ? html`<div class="view3d-hint">ลากเพื่อหมุน · จีบนิ้วเพื่อซูม</div>` : null}
  </div>`;
}

export function PartImage({ code, height = 200 }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let live = true;
    setUrl('');
    api.blobUrl(`image?code=${encodeURIComponent(code)}`).then((u) => live && setUrl(u)).catch(() => {});
    return () => { live = false; };
  }, [code]);
  return url ? html`<div class="part-img" style=${`height:${height}px`}><img src=${url} alt="รูปชิ้นงาน" /></div>`
    : html`<div class="part-img loading" style=${`height:${height}px`}><span class="spinner"></span></div>`;
}

// the 3D model when the drawing has a flat pattern, else the picture of the Parts List file
export function PartVisual({ item, height = 220, compact }) {
  if (!item) return null;
  const code = item.outline_code || item.code;
  if (item.has_outline) return html`<${Part3D} code=${code} height=${height} compact=${compact} />`;
  if (item.has_image) return html`<${PartImage} code=${item.code} height=${height} />`;
  return null;
}
