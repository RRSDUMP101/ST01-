// Work kept on the phone until it is sent: the stock count and the picking of a job.
import { local, norm, store } from './lib.js';

export const countSession = {
  get() {
    return local.get('count', null) || { lines: [], started: new Date().toISOString() };
  },
  save(s) {
    local.set('count', s.lines.length ? s : null);
    store.set({ countN: s.lines.length });
  },
  add(line) {
    const s = this.get();
    const key = line.key || norm(line.code);
    s.lines = s.lines.filter((l) => (l.key || norm(l.code)) !== key);
    s.lines.unshift({ ...line, key, at: new Date().toISOString() });
    this.save(s);
    return s;
  },
  remove(key) {
    const s = this.get();
    s.lines = s.lines.filter((l) => l.key !== key);
    this.save(s);
  },
  find(key) {
    return this.get().lines.find((l) => l.key === key) || null;
  },
  clear() { this.save({ lines: [] }); },
};

// picking of one job: lines in the order of the walk, what was picked, the line being picked now
export const pickSession = {
  get() { return local.get('pick', null); },
  save(s) {
    local.set('pick', s);
    store.set({ pickJob: s ? s.job_no : '' });
  },
  start(list) {
    const lines = list.lines.filter((l) => l.ready && l.pick_now > 0);
    const s = {
      job_no: list.job_no, title: list.title, lines, picked: {}, skipped: {}, started: new Date().toISOString(),
    };
    this.save(s);
    return s;
  },
  current(s = this.get()) {
    if (!s) return null;
    return s.lines.find((l) => !(l.index in s.picked) && !(l.index in s.skipped))
      || s.lines.find((l) => !(l.index in s.picked)) || null;
  },
  pick(index, qty, verified) {
    const s = this.get();
    if (!s) return null;
    s.picked[index] = { qty, verified: !!verified, at: new Date().toISOString() };
    delete s.skipped[index];
    this.save(s);
    return s;
  },
  unpick(index) {
    const s = this.get();
    if (!s) return;
    delete s.picked[index];
    this.save(s);
  },
  skip(index) {
    const s = this.get();
    if (!s) return;
    s.skipped[index] = true;
    this.save(s);
  },
  clear() { this.save(null); },
};

// "RRS-T-022-L-84" and "RRS-T-022-R-84": the same part, the other side - the classic wrong pick
export function lookAlike(a, b) {
  const pa = String(a || '').toUpperCase().split(/[-\s]+/).filter(Boolean);
  const pb = String(b || '').toUpperCase().split(/[-\s]+/).filter(Boolean);
  if (!pa.length || !pb.length || norm(a) === norm(b)) return '';
  const sideOf = (parts) => parts.find((p) => p === 'L' || p === 'R') || '';
  const sa = sideOf(pa); const sb = sideOf(pb);
  const strip = (parts) => parts.filter((p) => p !== 'L' && p !== 'R').join('-');
  if (sa && sb && sa !== sb && strip(pa) === strip(pb)) return sb === 'R' ? 'ข้างขวา (ต้องการข้างซ้าย)' : 'ข้างซ้าย (ต้องการข้างขวา)';
  if (pa.length >= 3 && pb.length >= 3 && pa.slice(0, 3).join('-') === pb.slice(0, 3).join('-')) return 'รุ่น/ขนาดต่างกัน';
  return '';
}
