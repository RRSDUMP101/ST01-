// นับอัตโนมัติ off the screen's thread: the still picture in, the pieces out (autocount.js).
import { countPieces, grayOf } from './autocount.js';

self.onmessage = (e) => {
  const { id, rgba, w, h, x, y, r } = e.data;
  try {
    const res = countPieces(grayOf(rgba, w, h), { x, y, r: r || 0 });
    self.postMessage({ id, ok: true, res });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
