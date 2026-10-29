// AR camera: the video, the QR reader (worker), the labels it follows from frame to frame and what is drawn
// on them. The screen says per label what to show (look) and the card next to it; the engine places both on the
// label 60 times a second.
import { align, axes, center, fitLoops, project, side, squareToQuad } from './geom.js';

const KEEP_MS = 700; // a label stays on screen this long after the reader last saw it

export class ARScanner {
  constructor({ video, canvas, layer, engine = 'auto', hd = false, look, card, onTap, onChange, onStatus }) {
    Object.assign(this, { video, canvas, layer, engine, hd, look, card, onTap, onChange, onStatus });
    this.tracks = new Map();
    this.cards = new Map();
    this.running = false;
    this.busy = false;
    this.frameId = 0;
    this.lastSend = 0;
    this.stats = { ms: 0, engine: '' };
    this.grab = document.createElement('canvas');
    this.grabCtx = this.grab.getContext('2d', { willReadFrequently: true });
    this.spare = null;
    this.tick = this.tick.bind(this);
  }

  async start() {
    if (!window.isSecureContext) {
      throw new Error('กล้องใช้ได้เฉพาะเมื่อเปิดแอปแบบปลอดภัย (https) – ติดตั้งใบรับรองตามหน้าตั้งค่าบนคอมก่อน');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('เครื่องนี้ไม่รองรับการเปิดกล้องในเบราว์เซอร์');
    const want = this.hd ? { width: { ideal: 1920 }, height: { ideal: 1080 } } : { width: { ideal: 1280 }, height: { ideal: 720 } };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: { ideal: 'environment' }, frameRate: { ideal: 30 }, ...want },
      });
    } catch (e) {
      if (e && e.name === 'NotAllowedError') throw new Error('ไม่ได้รับอนุญาตให้ใช้กล้อง – เปิดสิทธิ์กล้องให้เบราว์เซอร์ในการตั้งค่าของเครื่อง แล้วลองอีกครั้ง');
      if (e && e.name === 'NotFoundError') throw new Error('ไม่พบกล้องในเครื่องนี้');
      throw new Error(`เปิดกล้องไม่ได้ (${e && e.message ? e.message : e})`);
    }
    this.track = this.stream.getVideoTracks()[0];
    const caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
    this.canTorch = !!caps.torch;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this.worker = new Worker('js/ar/qr-worker.js');
    this.worker.onmessage = (e) => this.onWorker(e.data);
    this.worker.postMessage({ type: 'init', engine: this.engine });
    this.running = true;
    requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    if (this.worker) this.worker.terminate();
    this.worker = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    for (const el of this.cards.values()) el.remove();
    this.cards.clear();
    this.tracks.clear();
  }

  async setTorch(on) {
    if (!this.track || !this.canTorch) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      return true;
    } catch (e) {
      return false;
    }
  }

  onWorker(msg) {
    if (msg.type === 'ready') {
      this.stats.engine = msg.engine;
      if (this.onStatus) this.onStatus({ ready: true, engine: msg.engine });
      return;
    }
    if (msg.type === 'error') {
      if (this.onStatus) this.onStatus({ error: msg.error });
      return;
    }
    if (msg.type !== 'result') return;
    this.busy = false;
    if (msg.buffer) this.spare = msg.buffer;
    this.stats.ms = msg.ms || 0;
    const now = performance.now();
    const scale = this.scaleBack || 1;
    const before = new Set(this.tracks.keys());
    for (const code of msg.codes || []) {
      const pts = code.pts.map(([x, y]) => [x * scale, y * scale]);
      const t = this.tracks.get(code.text);
      if (!t) {
        this.tracks.set(code.text, { text: code.text, pts, raw: pts, first: now, last: now, hits: 1 });
      } else {
        const p = align(t.raw, pts);
        const jump = Math.hypot(center(p)[0] - center(t.pts)[0], center(p)[1] - center(t.pts)[1]) > side(t.pts) * 0.6;
        t.raw = p;
        t.pts = jump ? p : t.pts.map((q, i) => [q[0] + (p[i][0] - q[0]) * 0.6, q[1] + (p[i][1] - q[1]) * 0.6]);
        t.last = now;
        t.hits += 1;
      }
    }
    for (const [text, t] of this.tracks) if (now - t.last > KEEP_MS) this.tracks.delete(text);
    const after = new Set(this.tracks.keys());
    if (this.onChange && (after.size !== before.size || [...after].some((k) => !before.has(k)))) {
      this.onChange([...this.tracks.values()]);
    }
  }

  send(now) {
    const v = this.video;
    if (!this.worker || this.busy || !v.videoWidth || now - this.lastSend < 70) return;
    const long = this.hd ? 1920 : 1280;
    const s = Math.min(1, long / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * s); const h = Math.round(v.videoHeight * s);
    if (this.grab.width !== w) { this.grab.width = w; this.grab.height = h; }
    this.grabCtx.drawImage(v, 0, 0, w, h);
    const img = this.grabCtx.getImageData(0, 0, w, h);
    this.scaleBack = 1 / s;
    this.busy = true;
    this.lastSend = now;
    this.frameId += 1;
    const buffer = img.data.buffer;
    this.worker.postMessage({ type: 'frame', id: this.frameId, width: w, height: h, buffer }, [buffer]);
  }

  // video pixels -> screen pixels (the video fills the screen: object-fit cover)
  mapper() {
    const v = this.video;
    const W = v.clientWidth; const H = v.clientHeight;
    const vw = v.videoWidth || W; const vh = v.videoHeight || H;
    const s = Math.max(W / vw, H / vh);
    const ox = (W - vw * s) / 2; const oy = (H - vh * s) / 2;
    return (p) => [p[0] * s + ox, p[1] * s + oy];
  }

  tick(now) {
    if (!this.running) return;
    this.send(now);
    this.draw(now);
    requestAnimationFrame(this.tick);
  }

  visible() {
    const map = this.mapper();
    return [...this.tracks.values()].map((t) => ({ ...t, screen: t.pts.map(map) }));
  }

  draw(now) {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth; const H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const seen = new Set();
    for (const t of this.visible()) {
      const look = (this.look && this.look(t)) || { color: '#38BDF8' };
      const fade = Math.max(0, 1 - Math.max(0, now - t.last - 250) / (KEEP_MS - 250));
      ctx.globalAlpha = fade;
      paintLook(ctx, t.screen, look, now);
      ctx.globalAlpha = 1;
      seen.add(t.text);
      this.placeCard(t, look, fade);
    }
    for (const [text, el] of this.cards) {
      if (!seen.has(text)) {
        el.remove();
        this.cards.delete(text);
      }
    }
  }

  placeCard(t, look, fade) {
    const content = this.card ? this.card(t, look) : null;
    let el = this.cards.get(t.text);
    if (!content) {
      if (el) { el.remove(); this.cards.delete(t.text); }
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = 'arc';
      el.addEventListener('click', (e) => { e.stopPropagation(); if (this.onTap) this.onTap(this.tracks.get(t.text) || t, e); });
      this.layer.appendChild(el);
      this.cards.set(t.text, el);
    }
    if (el.dataset.html !== content.html) {
      el.innerHTML = content.html;
      el.dataset.html = content.html;
      el.dataset.w = '';
    }
    const cls = `arc ${content.className || ''}`;
    if (el.className !== cls) {
      el.className = cls;
      el.dataset.w = '';
    }
    if (!el.dataset.w) el.dataset.w = String(el.offsetWidth || 160); // measured once per content, not every frame
    const half = Number(el.dataset.w) / 2;
    const pts = t.screen;
    const W = this.layer.clientWidth;
    const top = Math.min(...pts.map((p) => p[1]));
    const bottom = Math.max(...pts.map((p) => p[1]));
    const [cx] = center(pts);
    const x = Math.max(half + 8, Math.min(W - half - 8, cx)); // keep the whole card on the screen
    const below = content.below || top < 120; // no room above (the top bar): under the label
    const y = below ? bottom + 12 : top - 12;
    el.classList.toggle('under', below);
    el.style.setProperty('--tip', `${Math.round(Math.max(-half + 14, Math.min(half - 14, cx - x)))}px`);
    el.style.opacity = String(fade);
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, ${below ? '0' : '-100%'})`;
  }

  // the current picture and labels, for counting by tapping on a still frame
  still() {
    const v = this.video;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return { canvas: c, tracks: [...this.tracks.values()] };
  }
}

// ---- what can be drawn on a label --------------------------------------------------------------------------
// look = { color, glow, pulse, dim, cross, arrow: {dx, dy, text}, loops (outline of the part to show beside it) }
export function paintLook(ctx, pts, look, now) {
  const color = look.color || '#38BDF8';
  const s = side(pts);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (look.glow) {
    const pulse = look.pulse ? 0.5 + 0.5 * Math.sin(now / 160) : 1;
    ctx.shadowColor = color;
    ctx.shadowBlur = 18 + 14 * pulse;
    ctx.fillStyle = hexA(color, 0.16 + 0.12 * pulse);
    quad(ctx, pts, s * 0.12);
    ctx.fill();
  } else if (!look.dim) {
    ctx.fillStyle = hexA(color, 0.1);
    quad(ctx, pts, s * 0.08);
    ctx.fill();
  }
  ctx.shadowBlur = look.glow ? 12 : 0;
  ctx.strokeStyle = color;
  ctx.lineWidth = look.dim ? 2 : look.glow ? 5 : 3.5;
  if (look.dim) ctx.setLineDash([6, 6]);
  brackets(ctx, pts, s * 0.12);
  ctx.setLineDash([]);
  if (look.cross) {
    ctx.lineWidth = 6;
    const [a, b, c2, d] = pts;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]); ctx.lineTo(c2[0], c2[1]);
    ctx.moveTo(b[0], b[1]); ctx.lineTo(d[0], d[1]);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  if (look.loops && look.loops.length) hologram(ctx, pts, look.loops, color, now);
  if (look.arrow && (look.arrow.dx || look.arrow.dy)) arrow(ctx, pts, look.arrow, color, now);
  if (look.target) drop(ctx, pts, color, now);
  ctx.restore();
}

function quad(ctx, pts, grow) {
  const [cx, cy] = center(pts);
  ctx.beginPath();
  pts.forEach(([x, y], i) => {
    const dx = x - cx; const dy = y - cy; const l = Math.hypot(dx, dy) || 1;
    const px = x + (dx / l) * grow; const py = y + (dy / l) * grow;
    if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
  });
  ctx.closePath();
}

function brackets(ctx, pts, grow) {
  const [cx, cy] = center(pts);
  const out = pts.map(([x, y]) => {
    const dx = x - cx; const dy = y - cy; const l = Math.hypot(dx, dy) || 1;
    return [x + (dx / l) * grow, y + (dy / l) * grow];
  });
  ctx.beginPath();
  for (let i = 0; i < 4; i += 1) {
    const p = out[i]; const n = out[(i + 1) % 4]; const pr = out[(i + 3) % 4];
    const k = 0.28;
    ctx.moveTo(p[0] + (pr[0] - p[0]) * k, p[1] + (pr[1] - p[1]) * k);
    ctx.lineTo(p[0], p[1]);
    ctx.lineTo(p[0] + (n[0] - p[0]) * k, p[1] + (n[1] - p[1]) * k);
  }
  ctx.stroke();
}

// the outline of the part, lying on the shelf beside the label (in the label's plane)
function hologram(ctx, pts, loops, color, now) {
  const H = squareToQuad(pts);
  const fitted = fitLoops(loops, [1.25, -0.35, 4.25, 1.35]);
  const wave = 0.55 + 0.25 * Math.sin(now / 300);
  ctx.beginPath();
  for (const loop of fitted) {
    loop.forEach(([u, v], i) => {
      const [x, y] = project(H, u, v);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.closePath();
  }
  ctx.fillStyle = hexA(color, 0.18 * wave + 0.08);
  ctx.fill('evenodd');
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = hexA(color, 0.95);
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// from this label towards the slot of the part: dx slots to the right, dy levels up (the label's own axes)
function arrow(ctx, pts, a, color, now) {
  const { right, up } = axes(pts);
  let vx = right[0] * Math.sign(a.dx || 0) * Math.min(1, Math.abs(a.dx || 0)) + up[0] * Math.sign(a.dy || 0);
  let vy = right[1] * Math.sign(a.dx || 0) * Math.min(1, Math.abs(a.dx || 0)) + up[1] * Math.sign(a.dy || 0);
  const l = Math.hypot(vx, vy) || 1;
  vx /= l; vy /= l;
  const s = side(pts);
  const [cx, cy] = center(pts);
  const go = (now / 600) % 1;
  const start = s * (0.75 + 0.25 * go);
  const len = s * 1.5;
  const x0 = cx + vx * start; const y0 = cy + vy * start;
  const x1 = x0 + vx * len; const y1 = y0 + vy * len;
  const nx = -vy; const ny = vx;
  const w = Math.max(10, s * 0.22);
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 16;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x0 + nx * w * 0.45, y0 + ny * w * 0.45);
  ctx.lineTo(x1 - vx * w + nx * w * 0.45, y1 - vy * w + ny * w * 0.45);
  ctx.lineTo(x1 - vx * w + nx * w, y1 - vy * w + ny * w);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x1 - vx * w - nx * w, y1 - vy * w - ny * w);
  ctx.lineTo(x1 - vx * w - nx * w * 0.45, y1 - vy * w - ny * w * 0.45);
  ctx.lineTo(x0 - nx * w * 0.45, y0 - ny * w * 0.45);
  ctx.closePath();
  ctx.globalAlpha *= 0.92;
  ctx.fill();
  ctx.restore();
}

// a pin bouncing over the slot to pick from
function drop(ctx, pts, color, now) {
  const [cx] = center(pts);
  const top = Math.min(...pts.map((p) => p[1]));
  const s = side(pts);
  const bounce = Math.abs(Math.sin(now / 260)) * s * 0.25;
  const y = top - s * 0.55 - bounce;
  const w = Math.max(14, s * 0.28);
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx - w, y - w * 1.2);
  ctx.lineTo(cx + w, y - w * 1.2);
  ctx.lineTo(cx, y + w * 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
