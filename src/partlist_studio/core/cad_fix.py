"""ตรวจและแก้เส้นแบบก่อนตัด – repair the cut lines of a flat-pattern drawing before it goes to the laser.

Drawings often reach the laser not quite finished: two lines of a corner do not meet (a gap), a line runs
past the corner (an overshoot), a line is drawn twice, a bend line or a construction line sits on the cut
layer, or an angle text ('90') was exploded into lines inside the part. A laser cannot cut such a part as
drawn, and the reader used to drop it ("เส้นไม่ปิดเป็นวง").

The cut lines that do not close into a loop by themselves are repaired here:

1. split where they cross or touch, and lines drawn twice are kept once
2. loose ends closer than GAP_TOL are joined (end to end, or end to the line it stops short of)
3. short loose ends past a corner are cut off (overshoot), other loose lines are taken out
4. straight lines that divide a part from edge to edge are bend lines: not cut, they can be marked
5. the closed faces that are left are the outlines of the parts and their holes

Every change is a Fix with its place, so the user sees what was changed and the drawing office can fix the
drawing too. Nothing that cannot be repaired safely is guessed: it is reported as a line that does not close.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

Point = tuple[float, float]

GAP_TOL = 0.5  # mm: ends further apart than this are not joined - the drawing must be corrected
OVERSHOOT_MAX = 5.0  # mm: a loose end this short past a corner is an overshoot
BEND_TOUCH = 2.0  # mm: a bend line ends this close to the outline of its part
GLYPH_MAX = 30.0  # mm: letters and digits drawn as lines are smaller than this
EPS = 0.01  # mm: points this close are one point
MAX_SEGMENTS = 60000  # more loose segments than this: not repaired (too slow, the drawing is not a flat pattern)

FIX_GAP = "gap"
FIX_OVERSHOOT = "overshoot"
FIX_DUPLICATE = "duplicate"
FIX_DUP_LOOP = "dup_loop"
FIX_BEND = "bend"
FIX_STRAY = "stray"
FIX_GLYPH = "glyph"
FIX_TEXT = "text"
FIX_KEPT = "kept"  # lettering / a pattern cut in the part on purpose (a logo): cut as drawn
FIX_OPEN = "open"  # could not be repaired: the drawing must be corrected
FIX_OPEN_IN_PART = "open_in_part"

FIX_LABELS = {
    FIX_GAP: "ต่อเส้นที่ต่อไม่สนิท",
    FIX_OVERSHOOT: "ตัดเส้นเกินมุม",
    FIX_DUPLICATE: "ลบเส้นซ้ำ/เส้นทับกัน",
    FIX_DUP_LOOP: "ลบวงเส้นที่ซ้อนกัน",
    FIX_BEND: "เส้นพับ (ไม่ตัด · มาร์คได้)",
    FIX_STRAY: "ลบเส้นเกินในชิ้นงาน",
    FIX_GLYPH: "ลบตัวอักษร/ตัวเลขที่เป็นเส้น",
    FIX_TEXT: "ข้อความในชิ้นงาน (ไม่ส่งไปตัด)",
    FIX_KEPT: "คงตัวอักษร/ลวดลายที่ตัดในชิ้นงาน (ตัดตามแบบ)",
    FIX_OPEN: "เส้นไม่ปิดเป็นวง – แก้อัตโนมัติไม่ได้",
    FIX_OPEN_IN_PART: "เส้นในชิ้นงานไม่ปิด – ไม่ตัด ตรวจแบบ",
}
UNFIXED = {FIX_OPEN, FIX_OPEN_IN_PART}
INFO = {FIX_BEND, FIX_TEXT, FIX_KEPT}  # nothing was wrong with the lines: only said so the user knows


@dataclass
class Fix:
    kind: str
    x: float
    y: float
    size: float = 0.0  # mm: the gap joined, the overshoot cut, the line taken out
    text: str = ""
    part: int = -1  # index in DrawingData.profiles of the part it belongs to (-1 = none)

    @property
    def fixed(self) -> bool:
        return self.kind not in UNFIXED

    @property
    def label(self) -> str:
        return FIX_LABELS.get(self.kind, self.kind)

    def detail(self) -> str:
        if self.text:
            return self.text
        if self.kind == FIX_GAP:
            return f"ห่าง {self.size:.2f} มม. – ต่อให้แล้ว"
        if self.kind == FIX_OVERSHOOT:
            return f"ยื่นเกิน {self.size:.1f} มม. – ตัดออกแล้ว"
        if self.kind in (FIX_DUPLICATE, FIX_STRAY):
            return f"ยาว {self.size:.1f} มม."
        if self.kind == FIX_BEND:
            return f"ยาว {self.size:.0f} มม."
        return ""


@dataclass
class Piece:
    """An open line taken out of the cut lines (decided against the parts once they are known)."""
    points: list[Point]
    layer: str = ""
    spur: bool = False  # the loose end past a corner (overshoot)
    base: Point | None = None  # the end still on a kept line (where an overshoot leaves the corner)
    gap: float = 0.0  # its loose end to the nearest other line (how far it is from closing); 0 = not measured
    kind: str = ""  # FIX_* once decided

    @property
    def length(self) -> float:
        return sum(math.dist(a, b) for a, b in zip(self.points, self.points[1:]))

    @property
    def straight(self) -> bool:
        return is_straight(self.points)

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        xs = [p[0] for p in self.points]
        ys = [p[1] for p in self.points]
        return min(xs), min(ys), max(xs), max(ys)


@dataclass
class Repair:
    loops: list[tuple[list[Point], str]] = field(default_factory=list)  # closed faces (outlines and holes)
    fixes: list[Fix] = field(default_factory=list)  # gaps joined, lines drawn twice
    pieces: list[Piece] = field(default_factory=list)  # open lines taken out
    bends: list[tuple[Point, Point]] = field(default_factory=list)  # lines dividing a face: bend lines
    skipped: bool = False  # too many lines: nothing repaired


def is_straight(points: list[Point], tol: float = 0.05) -> bool:
    if len(points) < 2:
        return False
    (ax, ay), (bx, by) = points[0], points[-1]
    length = math.hypot(bx - ax, by - ay)
    if length < EPS:
        return False
    return all(abs((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / length <= tol for x, y in points[1:-1])


def signed_area(points: list[Point]) -> float:
    s = 0.0
    for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1]):
        s += x0 * y1 - x1 * y0
    return s / 2


def seg_dist(p: Point, a: Point, b: Point) -> tuple[float, float]:
    """(distance from p to segment ab, parameter of the nearest point along ab 0..1)."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    ll = dx * dx + dy * dy
    t = 0.0 if ll <= 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / ll))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy), t


def dist_to_loop(p: Point, loop: list[Point]) -> float:
    return min(seg_dist(p, a, b)[0] for a, b in zip(loop, loop[1:] + loop[:1]))


def is_circle(points: list[Point], tol: float = 0.02) -> bool:
    if len(points) < 8:
        return False
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2  # the mean leans to a repeated closing point
    radii = [math.hypot(x - cx, y - cy) for x, y in points]
    r = sum(radii) / len(radii)
    return r > 0 and max(abs(q - r) for q in radii) <= tol * r


def is_slot(points: list[Point], tol: float = 0.04) -> bool:
    """An oblong hole (two half circles and two straight sides, at any angle) - a real cut, never a letter."""
    if len(points) < 8:
        return False
    n = len(points)
    mx, my = sum(x for x, _ in points) / n, sum(y for _, y in points) / n
    sxx = sum((x - mx) ** 2 for x, _ in points)
    syy = sum((y - my) ** 2 for _, y in points)
    sxy = sum((x - mx) * (y - my) for x, y in points)
    angle = 0.5 * math.atan2(2 * sxy, sxx - syy)  # the long axis
    c, s = math.cos(angle), math.sin(angle)
    us = [(x - mx) * c + (y - my) * s for x, y in points]
    vs = [-(x - mx) * s + (y - my) * c for x, y in points]
    length, width = max(us) - min(us), max(vs) - min(vs)
    if width <= 0 or length < 1.2 * width:
        return False
    area = abs(signed_area(points))
    stadium = width * (length - width) + math.pi * width * width / 4
    return area >= 0.97 * hull_area(points) and abs(area - stadium) <= tol * stadium


def convex_hull(points: list[Point]) -> list[Point]:
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts

    def half(seq):
        out: list[Point] = []
        for p in seq:
            while len(out) >= 2 and ((out[-1][0] - out[-2][0]) * (p[1] - out[-2][1])
                                     - (out[-1][1] - out[-2][1]) * (p[0] - out[-2][0])) <= 0:
                out.pop()
            out.append(p)
        return out

    return half(pts)[:-1] + half(list(reversed(pts)))[:-1]


def hull_area(points: list[Point]) -> float:
    hull = convex_hull(points)
    return abs(signed_area(hull)) if len(hull) >= 3 else 0.0


# --------------------------------------------------------------------------
# Planar graph of the loose lines
# --------------------------------------------------------------------------
class _Nodes:
    def __init__(self, eps: float = EPS):
        self.eps = eps
        self.cells: dict[tuple[int, int], list[int]] = {}
        self.pts: list[Point] = []

    def id(self, x: float, y: float) -> int:
        e = self.eps
        cx, cy = math.floor(x / e), math.floor(y / e)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for k in self.cells.get((cx + dx, cy + dy), ()):
                    px, py = self.pts[k]
                    if abs(px - x) <= e and abs(py - y) <= e:
                        return k
        k = len(self.pts)
        self.pts.append((x, y))
        self.cells.setdefault((cx, cy), []).append(k)
        return k


def _grid_cell(segs: list[tuple[Point, Point]]) -> float:
    xs = [c for a, b in segs for c in (a[0], b[0])]
    ys = [c for a, b in segs for c in (a[1], b[1])]
    span = max(max(xs) - min(xs), max(ys) - min(ys), 1.0)
    return max(span / math.sqrt(len(segs)) * 2, 1.0)


def _cells(a: Point, b: Point, cell: float, pad: float):
    gx0, gx1 = math.floor((min(a[0], b[0]) - pad) / cell), math.floor((max(a[0], b[0]) + pad) / cell)
    gy0, gy1 = math.floor((min(a[1], b[1]) - pad) / cell), math.floor((max(a[1], b[1]) + pad) / cell)
    for gx in range(gx0, gx1 + 1):
        for gy in range(gy0, gy1 + 1):
            yield gx, gy


def _touch(s: tuple[Point, Point], t: tuple[Point, Point], eps: float) -> tuple[list[float], list[float]]:
    """Where segments s and t cross or touch: parameters along s and along t."""
    (px, py), (p2x, p2y) = s
    (qx, qy), (q2x, q2y) = t
    rx, ry, sx, sy = p2x - px, p2y - py, q2x - qx, q2y - qy
    rr, ss = math.hypot(rx, ry), math.hypot(sx, sy)
    if rr < eps or ss < eps:
        return [], []
    denom = rx * sy - ry * sx
    qpx, qpy = qx - px, qy - py
    out_s: list[float] = []
    out_t: list[float] = []
    if abs(denom) <= 1e-9 * rr * ss:  # parallel
        if abs(qpx * ry - qpy * rx) / rr > eps:
            return [], []
        for x, y in ((qx, qy), (q2x, q2y)):  # collinear: each end inside the other splits it
            u = ((x - px) * rx + (y - py) * ry) / (rr * rr)
            if eps / rr < u < 1 - eps / rr:
                out_s.append(u)
        for x, y in ((px, py), (p2x, p2y)):
            u = ((x - qx) * sx + (y - qy) * sy) / (ss * ss)
            if eps / ss < u < 1 - eps / ss:
                out_t.append(u)
        return out_s, out_t
    ts = (qpx * sy - qpy * sx) / denom
    us = (qpx * ry - qpy * rx) / denom
    if -eps / rr <= ts <= 1 + eps / rr and -eps / ss <= us <= 1 + eps / ss:
        out_s.append(min(max(ts, 0.0), 1.0))
        out_t.append(min(max(us, 0.0), 1.0))
    return out_s, out_t


class _Graph:
    def __init__(self, nodes: _Nodes):
        self.nodes = nodes
        self.adj: dict[int, set[int]] = {}
        self.layer: dict[tuple[int, int], str] = {}

    @staticmethod
    def key(u: int, v: int) -> tuple[int, int]:
        return (u, v) if u < v else (v, u)

    def add(self, u: int, v: int, layer: str = "") -> bool:
        """False when the edge is there already (a line drawn twice)."""
        if u == v:
            return True
        k = self.key(u, v)
        if k in self.layer:
            return False
        self.layer[k] = layer
        self.adj.setdefault(u, set()).add(v)
        self.adj.setdefault(v, set()).add(u)
        return True

    def remove(self, u: int, v: int) -> None:
        self.layer.pop(self.key(u, v), None)
        for a, b in ((u, v), (v, u)):
            nb = self.adj.get(a)
            if nb is not None:
                nb.discard(b)
                if not nb:
                    del self.adj[a]

    def deg(self, n: int) -> int:
        return len(self.adj.get(n, ()))

    def pt(self, n: int) -> Point:
        return self.nodes.pts[n]

    def walk(self, start: int) -> list[int]:
        """From a loose end along nodes of degree 2 to the first junction or loose end."""
        path, prev, cur = [start], -1, start
        while True:
            nxt = [m for m in self.adj.get(cur, ()) if m != prev]
            if not nxt or (cur != start and self.deg(cur) != 2):
                return path
            prev, cur = cur, nxt[0]
            path.append(cur)
            if cur == start:
                return path

    def length(self, path: list[int]) -> float:
        return sum(math.dist(self.pt(a), self.pt(b)) for a, b in zip(path, path[1:]))


def _build_graph(lines: list[tuple[list[Point], str]], eps: float, dup_fixes: list[Fix]) -> _Graph:
    segs: list[tuple[Point, Point]] = []
    owner: list[int] = []
    for n, (pts, _layer) in enumerate(lines):
        for a, b in zip(pts, pts[1:]):
            if math.dist(a, b) > eps:
                segs.append((a, b))
                owner.append(n)
    nodes = _Nodes(eps)
    graph = _Graph(nodes)
    if not segs:
        return graph
    cell = _grid_cell(segs)
    grid: dict[tuple[int, int], list[int]] = {}
    for i, (a, b) in enumerate(segs):
        for c in _cells(a, b, cell, eps):
            grid.setdefault(c, []).append(i)
    splits: list[list[float]] = [[0.0, 1.0] for _ in segs]
    done: set[tuple[int, int]] = set()
    for members in grid.values():
        for x, i in enumerate(members):
            for j in members[x + 1:]:
                if owner[i] == owner[j] and abs(i - j) == 1:
                    continue  # neighbours along one polyline meet at their shared end
                pair = (i, j) if i < j else (j, i)
                if pair in done:
                    continue
                done.add(pair)
                ts, us = _touch(segs[i], segs[j], eps)
                splits[i] += ts
                splits[j] += us
    dup_len: dict[int, float] = {}
    for i, (a, b) in enumerate(segs):
        layer = lines[owner[i]][1]
        prev_id = None
        for t in sorted(set(splits[i])):
            k = nodes.id(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            if prev_id is not None and k != prev_id and not graph.add(prev_id, k, layer):
                dup_len[owner[i]] = dup_len.get(owner[i], 0.0) + math.dist(nodes.pts[prev_id], nodes.pts[k])
            prev_id = k
    for n, length in dup_len.items():
        if length >= 0.5:
            pts = lines[n][0]
            mid = pts[len(pts) // 2]
            dup_fixes.append(Fix(FIX_DUPLICATE, mid[0], mid[1], length))
    return graph


# --------------------------------------------------------------------------
# Repair
# --------------------------------------------------------------------------
def _join_gaps(g: _Graph, gap_tol: float, overshoot: float, fixes: list[Fix]) -> None:
    """Join loose ends to each other, then to the line they stop short of."""
    ends = []
    for n in [n for n in g.adj if g.deg(n) == 1]:
        path = g.walk(n)
        if g.deg(path[-1]) >= 3 and g.length(path) <= overshoot:
            continue  # past a corner: an overshoot, cut off later
        ends.append((n, path))
    if not ends:
        return
    cell = max(gap_tol, EPS) * 2
    grid: dict[tuple[int, int], list[int]] = {}
    for idx, (n, _path) in enumerate(ends):
        x, y = g.pt(n)
        grid.setdefault((math.floor(x / cell), math.floor(y / cell)), []).append(idx)
    pairs = []
    for idx, (n, path) in enumerate(ends):
        x, y = g.pt(n)
        cx, cy = math.floor(x / cell), math.floor(y / cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for jdx in grid.get((cx + dx, cy + dy), ()):
                    if jdx <= idx:
                        continue
                    m = ends[jdx][0]
                    d = math.dist(g.pt(n), g.pt(m))
                    if d > gap_tol:
                        continue
                    if path[-1] == m and g.length(path) < 3 * gap_tol:
                        continue  # both ends of one tiny line
                    pairs.append((d, n, m))
    for d, n, m in sorted(pairs):
        if g.deg(n) == 1 and g.deg(m) == 1:
            g.add(n, m, "")
            (x0, y0), (x1, y1) = g.pt(n), g.pt(m)
            fixes.append(Fix(FIX_GAP, (x0 + x1) / 2, (y0 + y1) / 2, d))
    # an end that stops short of a line: join it to the nearest point of that line
    left = [(n, path) for n, path in ends if g.deg(n) == 1]
    if not left:
        return
    edges = [(u, v) for u, v in g.layer]
    if not edges:
        return
    ecell = max(_grid_cell([(g.pt(u), g.pt(v)) for u, v in edges]), gap_tol * 4)
    egrid: dict[tuple[int, int], list[int]] = {}
    for i, (u, v) in enumerate(edges):
        for c in _cells(g.pt(u), g.pt(v), ecell, gap_tol):
            egrid.setdefault(c, []).append(i)
    for n, path in left:
        if g.deg(n) != 1:
            continue
        p = g.pt(n)
        near, run = set(), 0.0  # its own line close to the end is not what it stops short of
        for a, b in zip(path, path[1:]):
            near.update((a, b))
            run += math.dist(g.pt(a), g.pt(b))
            if run > 3 * gap_tol:
                break
        best = None
        for i in set(egrid.get((math.floor(p[0] / ecell), math.floor(p[1] / ecell)), ())):
            u, v = edges[i]
            if g.key(u, v) not in g.layer or u in near or v in near:
                continue
            d, t = seg_dist(p, g.pt(u), g.pt(v))
            if d <= gap_tol and (best is None or d < best[0]):
                best = (d, t, u, v)
        if best is None:
            continue
        d, t, u, v = best
        if d <= EPS:
            continue
        a, b = g.pt(u), g.pt(v)
        if t * math.dist(a, b) <= EPS:
            w = u
        elif (1 - t) * math.dist(a, b) <= EPS:
            w = v
        else:
            w = g.nodes.id(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            layer = g.layer.get(g.key(u, v), "")
            g.remove(u, v)
            g.add(u, w, layer)
            g.add(w, v, layer)
            edges.append((u, w))
            edges.append((w, v))
            for k in (len(edges) - 2, len(edges) - 1):
                for c in _cells(g.pt(edges[k][0]), g.pt(edges[k][1]), ecell, gap_tol):
                    egrid.setdefault(c, []).append(k)
        g.add(n, w, "")
        q = g.pt(w)
        fixes.append(Fix(FIX_GAP, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, d))


def _prune(g: _Graph, overshoot: float) -> list[Piece]:
    """Take out every line with a loose end; returns them as pieces (paths between junctions)."""
    removed: dict[int, set[int]] = {}
    layers: dict[tuple[int, int], str] = {}
    stack = [n for n in g.adj if g.deg(n) <= 1]
    while stack:
        n = stack.pop()
        if g.deg(n) != 1:
            continue
        (m,) = tuple(g.adj[n])
        layers[g.key(n, m)] = g.layer.get(g.key(n, m), "")
        g.remove(n, m)
        removed.setdefault(n, set()).add(m)
        removed.setdefault(m, set()).add(n)
        if g.deg(m) == 1:
            stack.append(m)
    pieces: list[Piece] = []
    seen: set[tuple[int, int]] = set()

    def rdeg(n: int) -> int:
        return len(removed.get(n, ()))

    def through(n: int) -> bool:  # a piece runs on through n (not a kept junction, not a branch)
        return rdeg(n) == 2 and g.deg(n) == 0

    for start in removed:
        if through(start):
            continue
        for first in removed[start]:
            if _Graph.key(start, first) in seen:
                continue
            path, prev, cur = [start, first], start, first
            seen.add(_Graph.key(start, first))
            while through(cur):
                nxt = next(m for m in removed[cur] if m != prev)
                seen.add(_Graph.key(cur, nxt))
                prev, cur = cur, nxt
                path.append(cur)
            pts = [g.pt(k) for k in path]
            attached = [k for k in (path[0], path[-1]) if g.deg(k) > 0]  # one end still on a kept line
            piece = Piece(pts, layers.get(_Graph.key(path[0], path[1]), ""))
            piece.spur = len(attached) == 1 and piece.length <= overshoot
            piece.base = g.pt(attached[0]) if attached else None
            pieces.append(piece)
    return pieces


def _faces(g: _Graph) -> tuple[list[list[int]], dict[tuple[int, int], int]]:
    """Faces of the planar graph (node loops) and the face on the left of every directed edge."""
    order: dict[int, list[int]] = {}
    pos: dict[tuple[int, int], int] = {}
    for n, nbrs in g.adj.items():
        x, y = g.pt(n)
        lst = sorted(nbrs, key=lambda m: math.atan2(g.pt(m)[1] - y, g.pt(m)[0] - x))
        order[n] = lst
        for i, m in enumerate(lst):
            pos[(n, m)] = i
    face_of: dict[tuple[int, int], int] = {}
    faces: list[list[int]] = []
    for u, nbrs in g.adj.items():
        for v in nbrs:
            if (u, v) in face_of:
                continue
            fid = len(faces)
            loop: list[int] = []
            a, b = u, v
            while (a, b) not in face_of:
                face_of[(a, b)] = fid
                loop.append(a)
                lst = order[b]
                c = lst[(pos[(b, a)] - 1) % len(lst)]
                a, b = b, c
            faces.append(loop)
    return faces, face_of


def repair_lines(lines: list[tuple[list[Point], str]], gap_tol: float = GAP_TOL,
                 overshoot: float = OVERSHOOT_MAX) -> Repair:
    """Repair the cut lines that did not close by themselves (polylines in mm, with their layer)."""
    out = Repair()
    if sum(max(0, len(p) - 1) for p, _l in lines) > MAX_SEGMENTS:
        out.skipped = True
        out.pieces = [Piece(list(p), layer) for p, layer in lines if len(p) >= 2]
        return out
    g = _build_graph(lines, EPS, out.fixes)
    if not g.adj:
        return out
    _join_gaps(g, gap_tol, overshoot, out.fixes)
    ends = {n: g.pt(n) for n in g.adj if g.deg(n) == 1}
    out.pieces += _prune(g, overshoot)
    for _round in range(4):
        faces, face_of = _faces(g)
        areas = [signed_area([g.pt(n) for n in f]) for f in faces]
        changed = False
        # an edge with a face on each side divides a part: a straight one is a bend line
        inner = {g.key(u, v) for (u, v), f in face_of.items()
                 if areas[f] > 0 and areas[face_of[(v, u)]] > 0 and face_of[(v, u)] != f}
        for path in _paths(g, inner):
            pts = [g.pt(n) for n in path]
            if is_straight(pts) and g.deg(path[0]) >= 3 and g.deg(path[-1]) >= 3:
                for a, b in zip(path, path[1:]):
                    g.remove(a, b)
                out.bends.append((pts[0], pts[-1]))
                changed = True
        # an edge with the same face on both sides joins two loops (or sticks into one): not a cut line
        bridges = {g.key(u, v) for (u, v), f in face_of.items() if face_of.get((v, u)) == f}
        for path in _paths(g, bridges) if not changed else []:
            pts = [g.pt(n) for n in path]
            for a, b in zip(path, path[1:]):
                g.remove(a, b)
            out.pieces.append(Piece(pts, ""))
            changed = True
        if not changed:
            for f, area in zip(faces, areas):
                if area > 1.0:
                    keys = [g.key(a, b) for a, b in zip(f, f[1:] + f[:1])]
                    layers = [g.layer.get(k, "") for k in keys if g.layer.get(k)]
                    layer = max(set(layers), key=layers.count) if layers else ""
                    out.loops.append(([g.pt(n) for n in f], layer))
            break
        out.pieces += _prune(g, overshoot)
    loose_ends = set(ends.values())
    for piece in out.pieces:  # how far each open line is from closing
        if piece.spur:
            continue
        loose = [p for p in (piece.points[0], piece.points[-1]) if p in loose_ends]
        if loose:
            piece.gap = min((math.dist(p, q) for p in loose for q in loose_ends if q != p), default=0.0)
    return out


def _paths(g: _Graph, keys: set[tuple[int, int]]) -> list[list[int]]:
    """The edges `keys` joined into paths through nodes of degree 2."""
    adj: dict[int, list[int]] = {}
    for u, v in keys:
        adj.setdefault(u, []).append(v)
        adj.setdefault(v, []).append(u)
    seen: set[tuple[int, int]] = set()
    paths = []
    for start in adj:
        if g.deg(start) == 2 and len(adj[start]) == 2:
            continue
        for first in adj[start]:
            if g.key(start, first) in seen:
                continue
            seen.add(g.key(start, first))
            path, prev, cur = [start, first], start, first
            while g.deg(cur) == 2 and len(adj.get(cur, ())) == 2:
                nxt = next(m for m in adj[cur] if m != prev)
                if g.key(cur, nxt) in seen:
                    break
                seen.add(g.key(cur, nxt))
                prev, cur = cur, nxt
                path.append(cur)
            paths.append(path)
    return paths


# --------------------------------------------------------------------------
# Text drawn as lines (exploded text) inside a part
# --------------------------------------------------------------------------
@dataclass
class GlyphItem:
    bbox: tuple[float, float, float, float]
    evidence: bool  # looks like a letter: an open stroke, a loop with a counter, a concave loop
    ref: tuple[str, int]  # ("loop", profile index) or ("piece", index)
    counter: bool = False  # a loop with a loop inside ('0', '8', '9'): a letter even on its own

    @property
    def size(self) -> float:
        x0, y0, x1, y1 = self.bbox
        return max(x1 - x0, y1 - y0)


def _bbox_gap(a, b) -> float:
    dx = max(0.0, max(a[0], b[0]) - min(a[2], b[2]))
    dy = max(0.0, max(a[1], b[1]) - min(a[3], b[3]))
    return math.hypot(dx, dy)


def text_clusters(items: list[GlyphItem]) -> list[list[GlyphItem]]:
    """Groups of glyph-sized items written next to each other like the letters of a word."""
    parent = list(range(len(items)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, a in enumerate(items):
        for j in range(i + 1, len(items)):
            b = items[j]
            small, big = sorted((a.size, b.size))
            if big and small / big >= 0.4 and _bbox_gap(a.bbox, b.bbox) <= 0.8 * big:
                parent[find(i)] = find(j)
    groups: dict[int, list[GlyphItem]] = {}
    for i, item in enumerate(items):
        groups.setdefault(find(i), []).append(item)
    return [g for g in groups.values()
            if (len(g) >= 2 and any(it.evidence for it in g)) or (len(g) == 1 and g[0].counter)]


# --------------------------------------------------------------------------
# Summary for a part
# --------------------------------------------------------------------------
def fix_summary(fixes: list[Fix]) -> list[str]:
    """Short lines for one part: 'ต่อเส้นที่ต่อไม่สนิท 2 จุด (ห่างสุด 0.30 มม.)'."""
    out = []
    by_kind: dict[str, list[Fix]] = {}
    for f in fixes:
        by_kind.setdefault(f.kind, []).append(f)
    for kind in FIX_LABELS:
        group = by_kind.get(kind)
        if not group:
            continue
        label = FIX_LABELS[kind]
        if kind == FIX_GAP:
            out.append(f"{label} {len(group)} จุด (ห่างสุด {max(f.size for f in group):.2f} มม.)")
        elif kind == FIX_TEXT:
            texts = ", ".join(dict.fromkeys(f.text.split("'")[1] if "'" in f.text else f.text for f in group))
            out.append(f"{label}: {texts}")
        elif kind == FIX_BEND:
            out.append(f"{label} {len(group)} เส้น")
        else:
            out.append(f"{label} {len(group)} จุด")
    return out
