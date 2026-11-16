"""ภาพ 3 มิติของงานประกอบ: หมุน (ลากซ้าย) · เลื่อน (ลากขวา / Shift+ลาก) · ซูม (ล้อเมาส์) · ดับเบิลคลิกชิ้นเพื่อซูมเข้า.

Drawn with QPainter (no OpenGL, so it works on every office PC and in a remote desktop): the faces are turned to
the screen with numpy, the hidden ones dropped, and the rest painted from far to near.
"""

from __future__ import annotations

import math

import numpy as np
from PySide6.QtCore import QByteArray, QDataStream, QIODevice, QPointF, QRectF, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QFont, QImage, QLinearGradient, QPainter, QPainterPath, QPen, QPolygonF
from PySide6.QtWidgets import QWidget

from ..core.assembly3d import AssemblyModel, Part3D
from . import theme

VIEWS = {"iso": (38.0, 26.0), "iso2": (142.0, 26.0), "top": (90.0, 89.9), "front": (180.0, 0.0), "rear": (0.0, 0.0),
         "side": (90.0, 0.0)}
CURRENT, SELECTED, EDGE = QColor("#5DBB63"), QColor(theme.ACCENT), QColor("#2B3440")
FAST_FACES = 400000  # more faces than this: while the mouse moves, big imported parts are drawn as boxes
MESH_SHADES = 12  # shades of a colour on an imported mesh (fewer shades: fewer, bigger paths to fill)
MESH_SLABS = 3  # slabs of distance a mesh is drawn in, far to near
MAX_ORDERED = 1200  # more pieces than this: all faces sorted by distance instead (less exact, still quick)


class _Piece:
    """A convex piece of a part, ready to draw: all corners in one array, a start and a length per face, the normals."""

    def __init__(self, faces: list, convex: bool = True):
        pts = [p for f, _e in faces for p in f]
        self.points = np.array(pts, dtype=float).reshape(-1, 3)
        self.counts = np.array([len(f) for f, _e in faces], dtype=int)
        self.starts = np.concatenate(([0], np.cumsum(self.counts)[:-1])).astype(int) if len(faces) else np.zeros(0, int)
        self.edges = [e for _f, e in faces]
        normals = np.zeros((len(faces), 3))
        for i, (f, _e) in enumerate(faces):  # Newell: right for any flat face
            a = np.array(f, dtype=float)
            b = np.roll(a, -1, axis=0)
            normals[i] = (((a[:, 1] - b[:, 1]) * (a[:, 2] + b[:, 2])).sum(), ((a[:, 2] - b[:, 2]) * (a[:, 0] + b[:, 0])).sum(),
                          ((a[:, 0] - b[:, 0]) * (a[:, 1] + b[:, 1])).sum())
        length = np.linalg.norm(normals, axis=1)
        length[length == 0] = 1
        self.normals = normals / length[:, None]
        self.convex = convex
        self.tri = None
        self.cull = False
        self.lo, self.hi = (self.points.min(axis=0), self.points.max(axis=0)) if len(pts) else (np.zeros(3), np.ones(3))


class _MeshPiece:
    """An imported mesh: all its faces as triangles in one array (T, 3, 3). It is not convex - its faces can hide one
    another - and unless it is a closed skin wound outwards (Part3D.cull) both sides of a face can be seen."""

    convex = False

    def __init__(self, mesh: list, cull: bool):
        try:
            tri = np.asarray(mesh, dtype=float)
            if tri.ndim != 3 or tri.shape[1:] != (3, 3):
                raise ValueError
        except ValueError:  # faces with more than 3 corners: as fans of triangles
            fans = [(f[0], f[k], f[k + 1]) for f in mesh for k in range(1, len(f) - 1)]
            tri = np.asarray(fans, dtype=float).reshape(-1, 3, 3)
        self.tri = tri
        normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]) if len(tri) else np.zeros((0, 3))
        length = np.linalg.norm(normals, axis=1)
        length[length == 0] = 1
        self.normals = normals / length[:, None]
        self.cull = cull
        self.counts = np.full(len(tri), 3)
        flat = tri.reshape(-1, 3)
        self.lo, self.hi = (flat.min(axis=0), flat.max(axis=0)) if len(flat) else (np.zeros(3), np.ones(3))


class _Mesh:
    def __init__(self, part: Part3D):
        if part.shape == "mesh":
            self.pieces = [_MeshPiece(part.mesh, bool(getattr(part, "cull", False)))]
        else:
            self.pieces = [_Piece(faces) for faces in part.chunks()]
        self.lo = np.min([c.lo for c in self.pieces], axis=0)
        self.hi = np.max([c.hi for c in self.pieces], axis=0)
        self.centre = (self.lo + self.hi) / 2
        self.faces = int(sum(len(c.counts) for c in self.pieces))


def triangles_path(xy: np.ndarray) -> QPainterPath:
    """Triangles (n, 3, 2) as one path of n closed outlines, made without a Python loop: the bytes are written
    as QDataStream would write a path and read back. One fill of such a path replaces n calls of drawPolygon."""
    n = len(xy)
    rec = np.empty(n * 4, dtype=[("kind", ">i4"), ("x", ">f8"), ("y", ">f8")])
    rec["kind"] = 1  # line to
    rec["kind"][0::4] = 0  # move to: the first corner of each triangle
    pts = np.concatenate([xy, xy[:, :1]], axis=1).reshape(-1, 2)
    rec["x"], rec["y"] = pts[:, 0], pts[:, 1]
    tail = np.array([0, 1], dtype=">i4")  # where the last outline starts (unused), then the fill rule: 1 = winding,
    # so triangles that overlap all stay filled (they must turn the same way - see _paint_mesh)
    data = QByteArray(np.array([n * 4], dtype=">i4").tobytes() + rec.tobytes() + tail.tobytes())
    path = QPainterPath()
    stream = QDataStream(data, QIODevice.ReadOnly)
    stream >> path
    path.setFillRule(Qt.WindingFill)
    return path


def draw_order(lo: np.ndarray, hi: np.ndarray, d: np.ndarray, r: np.ndarray | None = None, u: np.ndarray | None = None,
               tol: float = 0.5) -> list[int]:
    """Far to near, for boxes that do not run through one another: a box on the camera's side of a plane that
    separates it from another is drawn after it (so a floor lying on its beams always covers them). Boxes that
    overlap have no rule between them: the one whose middle is farther goes first."""
    n = len(lo)
    depth = ((lo + hi) / 2) @ d
    front = np.zeros((n, n), dtype=bool)  # front[a, b]: a is on the camera's side of a plane between a and b
    for i in range(3):
        if d[i] < -1e-6:  # the camera is on the + side of this axis
            front |= lo[:, None, i] >= hi[None, :, i] - tol
        elif d[i] > 1e-6:
            front |= hi[:, None, i] <= lo[None, :, i] + tol
    after = front & ~front.T  # a must be drawn after b; among the pieces that are free, the farthest goes first
    if r is not None and u is not None:
        # only where the two really meet in the picture, or long pieces make false rings (a before b before c
        # before a). A box seen from any side is a six-cornered shape made of the same three directions for
        # every box, so the three lines across those directions tell exactly whether two of them overlap.
        mid, half = (lo + hi) / 2, (hi - lo) / 2
        gen = np.stack([r, u], axis=1)  # (3, 2): where each axis of the model points in the picture
        for i in range(3):
            normal = np.array([-gen[i, 1], gen[i, 0]])
            if np.linalg.norm(normal) < 1e-9:
                continue
            c = (mid @ r) * normal[0] + (mid @ u) * normal[1]
            e = half @ np.abs(gen @ normal)
            after &= np.abs(c[:, None] - c[None, :]) < e[:, None] + e[None, :] - 1e-6
    waiting = after.sum(axis=1)
    done = np.zeros(n, dtype=bool)
    order: list[int] = []
    for _ in range(n):
        free = np.nonzero((waiting == 0) & ~done)[0]
        if not len(free):  # a ring of pieces each in front of the next: the farthest goes first
            free = np.nonzero(~done)[0]
        pick = int(free[np.argmax(depth[free])])
        order.append(pick)
        done[pick] = True
        waiting = waiting - after[:, pick]
    return order


class Assembly3DView(QWidget):
    part_clicked = Signal(str)  # id of the part under the mouse ('' = none)
    animation_done = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(QSize(420, 320))
        self.setMouseTracking(False)
        self.setFocusPolicy(Qt.StrongFocus)
        self.model: AssemblyModel | None = None
        self.yaw, self.pitch = VIEWS["iso"]
        self.zoom = 0.2  # pixels per mm
        self.target = np.zeros(3)  # the point of the model in the middle of the picture
        self.explode = 0.0  # 0 = assembled … 1 = every part at its waiting position
        self.step: int | None = None  # None = the whole assembly · n = parts up to step n, those of n highlighted
        self.show_labels = True
        self.ghost_later = False  # parts of later steps drawn faintly
        self.hidden_groups: set[str] = set()
        self.hidden_parts: set[str] = set()
        self.selected = ""
        self.marked: set[str] = set()  # more parts chosen in the table: tinted like the selected one
        self._anim = 0.0  # 1 → 0 while the parts of the step fly in
        self._meshes: dict[str, _Mesh] = {}
        self._drawn: list[tuple] = []  # (corners of a face, or the triangles of a mesh as an array; part id)
        self._drag = None
        self._moving = False
        self._text_scale = 1.0  # bigger numbers and axis names in a picture rendered larger than the widget
        self._timer = QTimer(self)
        self._timer.setInterval(30)
        self._timer.timeout.connect(self._tick)

    # ---- model ------------------------------------------------------------
    def set_model(self, model: AssemblyModel | None, keep_view: bool = False) -> None:
        self.model = model
        self._meshes = {p.id: _Mesh(p) for p in model.parts} if model else {}
        self.selected = ""
        if not keep_view:
            self.fit()
        self.update()

    def refresh_part(self, part: Part3D) -> None:
        self._meshes[part.id] = _Mesh(part)
        self.update()

    def face_total(self) -> int:
        return int(sum(m.faces for m in self._meshes.values()))

    # ---- camera -----------------------------------------------------------
    def _basis(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """right, up, and the direction the camera looks."""
        y, p = math.radians(self.yaw), math.radians(self.pitch)
        d = np.array([-math.cos(p) * math.cos(y), -math.cos(p) * math.sin(y), -math.sin(p)])
        r = np.cross(d, (0.0, 0.0, 1.0))
        n = np.linalg.norm(r)
        r = r / n if n > 1e-9 else np.array([-math.sin(y), math.cos(y), 0.0])
        return r, np.cross(r, d), d

    def set_view(self, name: str) -> None:
        self.yaw, self.pitch = VIEWS.get(name, VIEWS["iso"])
        self.fit()

    def fit(self, parts: list[Part3D] | None = None, margin: float = 0.86, size: tuple[int, int] | None = None) -> None:
        if not self.model:
            return
        parts = [p for p in (parts if parts else self._visible_parts()) if p.id in self._meshes] or list(self.model.parts)
        if not parts:
            return
        lo = np.min([self._meshes[p.id].lo for p in parts], axis=0)
        hi = np.max([self._meshes[p.id].hi for p in parts], axis=0)
        corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
        r, u, _d = self._basis()
        sx, sy = corners @ r, corners @ u
        w, h = size or (max(self.width(), 200), max(self.height(), 150))
        span_x, span_y = max(sx.max() - sx.min(), 1.0), max(sy.max() - sy.min(), 1.0)
        self.zoom = margin * min(w / span_x, h / span_y)
        self.target = (lo + hi) / 2
        self.update()

    def zoom_to(self, part_ids: list[str]) -> None:
        parts = [p for p in (self.model.parts if self.model else []) if p.id in part_ids]
        if parts:
            self.fit(parts, margin=0.55)

    def zoom_by(self, factor: float, at: QPointF | None = None) -> None:
        old = self.zoom
        self.zoom = min(max(self.zoom * factor, 0.005), 60.0)
        if at is not None:  # the point under the mouse stays under the mouse
            r, u, _d = self._basis()
            dx, dy = at.x() - self.width() / 2, at.y() - self.height() / 2
            self.target = self.target + (r * dx - u * dy) * (1 / old - 1 / self.zoom)
        self.update()

    # ---- steps ------------------------------------------------------------
    def set_step(self, step: int | None, animate: bool = True) -> None:
        self.step = step
        self._anim = 1.0 if (animate and step) else 0.0
        if self._anim:
            self._timer.start()
        else:
            self._timer.stop()
        self.update()

    def set_explode(self, value: float) -> None:
        self.explode = min(max(value, 0.0), 1.0)
        self.update()

    def finish_animation(self) -> None:
        self._timer.stop()
        self._anim = 0.0
        self.update()

    def _tick(self) -> None:
        self._anim = max(0.0, self._anim - 0.03)
        if self._anim <= 0:
            self._timer.stop()
            self.animation_done.emit()
        self.update()

    def _state(self, p: Part3D) -> str:
        """'' hidden · ref · done · current · ghost · normal"""
        if p.group in self.hidden_groups or p.id in self.hidden_parts:
            return ""
        if p.step == 0:
            return "ref"
        if self.step is None:
            return "normal"
        if p.step < self.step:
            return "done"
        if p.step == self.step:
            return "current"
        return "ghost" if self.ghost_later else ""

    def _visible_parts(self) -> list[Part3D]:
        return [p for p in (self.model.parts if self.model else []) if self._state(p)]

    def _offset(self, p: Part3D, state: str) -> np.ndarray:
        if state == "ref":
            return np.zeros(3)
        f = self.explode
        if state == "current":
            t = self._anim
            f = max(f, t * t * (3 - 2 * t))  # ease in and out
        return np.array(p.explode, dtype=float) * f

    # ---- drawing ----------------------------------------------------------
    def paintEvent(self, _event) -> None:  # noqa: N802
        painter = QPainter(self)
        self._paint(painter, self.width(), self.height())
        painter.end()

    def render_image(self, width: int = 1100, height: int = 700, fit: bool = False, margin: float = 0.8) -> QImage:
        """The picture as it is now at a given size (for the printed manual); `fit`: what is shown fills it."""
        image = QImage(width, height, QImage.Format_ARGB32)
        zoom, target = self.zoom, self.target
        if fit:
            self.fit(margin=margin, size=(width, height))
        else:
            self.zoom = zoom * min(width / max(self.width(), 1), height / max(self.height(), 1))
        self._text_scale = min(2.2, max(1.0, width / 760))
        painter = QPainter(image)
        self._paint(painter, width, height)
        painter.end()
        self._text_scale = 1.0
        self.zoom, self.target = zoom, target
        return image

    def _paint(self, painter: QPainter, w: int, h: int) -> None:
        grad = QLinearGradient(0, 0, 0, h)
        grad.setColorAt(0, QColor("#F6F8FB"))
        grad.setColorAt(1, QColor("#C9D1DB"))
        painter.fillRect(QRectF(0, 0, w, h), grad)
        self._drawn = []
        if not self.model or not self.model.parts:
            painter.setPen(QColor(theme.MUTED))
            painter.drawText(QRectF(0, 0, w, h), Qt.AlignCenter, "ยังไม่มีโมเดล 3 มิติ – กด นำเข้าโมเดล (OBJ / STL)…")
            return
        painter.setRenderHint(QPainter.Antialiasing, True)
        r, u, d = self._basis()
        light = d - 0.55 * u + 0.35 * r
        light = light / np.linalg.norm(light)
        cx, cy, zoom = w / 2, h / 2, self.zoom
        fast = self._moving and self.face_total() > FAST_FACES
        # ---- what to draw: (piece, offset, colour, alpha, part id, lines?)
        todo: list[tuple] = []
        labels: list[tuple[float, float, Part3D, np.ndarray, np.ndarray]] = []
        for p in self.model.parts:
            state = self._state(p)
            if not state:
                continue
            mesh = self._meshes[p.id]
            off = self._offset(p, state)
            base = QColor(CURRENT) if state == "current" else QColor(p.color)
            if (p.id == self.selected or p.id in self.marked) and mesh.pieces[0].tri is not None:  # a mesh has no outline to make thicker
                base = QColor((base.red() + 2 * SELECTED.red()) // 3, (base.green() + 2 * SELECTED.green()) // 3,
                              (base.blue() + 2 * SELECTED.blue()) // 3)
            alpha = 70 if state == "ghost" else 120 if state == "ref" else 255
            for piece in mesh.pieces:
                todo.append((piece, off, base, alpha, p.id, state != "ghost", fast and mesh.faces > 400))
            if state == "current" or p.id == self.selected:
                c = mesh.centre - self.target
                labels.append((float((c + off) @ r) * zoom + cx, cy - float((c + off) @ u) * zoom, p, c, off))
        if todo:  # far to near, piece by piece
            lo = np.array([piece.lo + off for piece, off, *_rest in todo])
            hi = np.array([piece.hi + off for piece, off, *_rest in todo])
            order = draw_order(lo, hi, d, r, u) if len(todo) <= MAX_ORDERED else np.argsort(-(((lo + hi) / 2) @ d)).tolist()
            todo = [todo[i] for i in order]
        edge_pen = QPen(EDGE, 1.0)
        sel_pen = QPen(SELECTED, 2.4)
        smooth = True
        for piece, off, base, alpha, part_id, lines, as_box in todo:
            if piece.tri is not None:
                if smooth:  # triangles side by side: without antialiasing no background shows between them
                    painter.setRenderHint(QPainter.Antialiasing, False)
                    smooth = False
                if as_box:
                    self._paint_box(painter, piece.lo + off - self.target, piece.hi + off - self.target, r, u, cx, cy, zoom,
                                    base, part_id)
                else:
                    self._paint_mesh(painter, piece, off, base, alpha, part_id, r, u, d, light, cx, cy, zoom)
                continue
            if not smooth:
                painter.setRenderHint(QPainter.Antialiasing, True)
                smooth = True
            pts = piece.points + off - self.target
            xs = ((pts @ r) * zoom + cx).tolist()
            ys = (cy - (pts @ u) * zoom).tolist()
            buckets = (np.clip(-(piece.normals @ light), 0, 1) * 15).astype(int).tolist()
            for i in np.nonzero((piece.normals @ d) < -1e-6)[0].tolist():
                s0, n = int(piece.starts[i]), int(piece.counts[i])
                f = 0.52 + 0.48 * buckets[i] / 15
                color = QColor(int(base.red() * f), int(base.green() * f), int(base.blue() * f), alpha)
                corners = [(xs[j], ys[j]) for j in range(s0, s0 + n)]
                painter.setPen(QPen(color, 0.6))
                painter.setBrush(color)
                painter.drawPolygon(QPolygonF([QPointF(x, y) for x, y in corners]))
                if lines:
                    painter.setPen(sel_pen if (part_id == self.selected or part_id in self.marked) else edge_pen)
                    edges = piece.edges[i]
                    for j in range(n):
                        if edges[j]:
                            painter.drawLine(QPointF(*corners[j]), QPointF(*corners[(j + 1) % n]))
                self._drawn.append((corners, part_id))
        painter.setRenderHint(QPainter.Antialiasing, True)
        self._paint_labels(painter, labels, r, u, cx, cy, zoom)
        self._paint_triad(painter, r, u, h)

    def _paint_mesh(self, painter, piece, off, base, alpha, part_id, r, u, d, light, cx, cy, zoom) -> None:
        """The triangles that face the camera, far ones first, in a few slabs of distance; in a slab all triangles
        of one shade are one path. (Same shade over same shade looks the same in any order, so only triangles of
        different shades in one slab can be drawn in the wrong order - a small price for 5 to 10 times the speed.)"""
        lit = -(piece.normals @ light)
        if piece.cull:
            seen = np.nonzero((piece.normals @ d) < -1e-6)[0]
        else:
            lit = np.abs(lit)
            seen = np.arange(len(lit))
        if not len(seen):
            return
        tri = piece.tri[seen] + (off - self.target)
        seen = seen[np.argsort(-(tri @ d).mean(axis=1))]
        tri = piece.tri[seen] + (off - self.target)
        xy = np.stack(((tri @ r) * zoom + cx, cy - (tri @ u) * zoom), axis=2)
        # all turned the same way on the screen: in one path, a triangle over one turned the other way (the top and
        # the bottom of a thin plate) would cancel it and leave a hole
        e1, e2 = xy[:, 1] - xy[:, 0], xy[:, 2] - xy[:, 0]
        back = (e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]) < 0
        xy[back] = xy[back][:, ::-1]
        shades = MESH_SHADES // 2 if self._moving else MESH_SHADES  # while the mouse turns the model: fewer paths
        shade = (np.clip(lit[seen], 0, 1) * (shades - 1) + 0.5).astype(int)
        painter.setPen(Qt.NoPen)
        slabs = 1 if (len(seen) < 80 or self._moving) else MESH_SLABS
        for part in np.array_split(np.arange(len(seen)), slabs):
            for k in np.unique(shade[part]).tolist():
                f = 0.52 + 0.48 * k / (shades - 1)
                color = QColor(int(base.red() * f), int(base.green() * f), int(base.blue() * f), alpha)
                painter.fillPath(triangles_path(xy[part[shade[part] == k]]), color)
        self._drawn.append((xy, part_id))

    def _paint_box(self, painter, lo, hi, r, u, cx, cy, zoom, base, part_id) -> None:
        """A part as its box, see-through: what a very big model shows while the mouse turns it."""
        c = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
        sx, sy = ((c @ r) * zoom + cx).tolist(), (cy - (c @ u) * zoom).tolist()
        painter.setPen(QPen(EDGE, 1.0))
        painter.setBrush(QColor(base.red(), base.green(), base.blue(), 60))
        for quad in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            corners = [(sx[i], sy[i]) for i in quad]
            painter.drawPolygon(QPolygonF([QPointF(x, y) for x, y in corners]))
            self._drawn.append((corners, part_id))

    def _paint_labels(self, painter: QPainter, labels, r, u, cx, cy, zoom) -> None:
        if not labels:
            return
        font = QFont(theme.app_font())
        k = self._text_scale
        font.setPointSizeF(9.5 * k)
        font.setBold(True)
        painter.setFont(font)
        for x, y, part, centre, off in labels:
            if np.any(off):  # the way the part travels to its place
                hx, hy = float(centre @ r) * zoom + cx, cy - float(centre @ u) * zoom
                painter.setPen(QPen(QColor("#2E9D5B"), 1.6, Qt.DashLine))
                painter.drawLine(QPointF(x, y), QPointF(hx, hy))
                painter.setBrush(QColor("#2E9D5B"))
                painter.setPen(Qt.NoPen)
                painter.drawEllipse(QPointF(hx, hy), 3.5, 3.5)
            if not self.show_labels:
                continue
            no = self.model.bom_no(part) if part.step else 0
            text = str(no) if no and part.id != self.selected else part.name
            width = max(22.0 * k, painter.fontMetrics().horizontalAdvance(text) + 12.0 * k)
            box = QRectF(x - width / 2, y - 11 * k, width, 22 * k)
            painter.setPen(QPen(QColor("#1E2A3A"), 1.2 * k))
            painter.setBrush(QColor(255, 255, 255, 235) if part.id != self.selected else QColor("#FFE7C7"))
            painter.drawRoundedRect(box, 11 * k, 11 * k)
            painter.drawText(box, Qt.AlignCenter, text)

    def _paint_triad(self, painter: QPainter, r, u, h: int) -> None:
        k = self._text_scale
        ox, oy = 46.0 * k, h - 46.0 * k
        font = QFont(theme.app_font())
        font.setPointSizeF(8.5 * k)
        painter.setFont(font)
        for axis, color, name in (((1, 0, 0), "#D64545", "X ท้ายรถ"), ((0, 1, 0), "#2E9D5B", "Y ซ้าย"), ((0, 0, 1), "#2F6FD0", "Z")):
            a = np.array(axis, dtype=float)
            ex, ey = ox + float(a @ r) * 30 * k, oy - float(a @ u) * 30 * k
            painter.setPen(QPen(QColor(color), 2 * k))
            painter.drawLine(QPointF(ox, oy), QPointF(ex, ey))
            painter.drawText(QPointF(ex + 3, ey + 3), name)

    # ---- mouse ------------------------------------------------------------
    def drawn_faces(self) -> list[tuple[list, str]]:
        """Every face of the last picture as (corners on the screen, part id), in the order drawn."""
        out: list[tuple[list, str]] = []
        for pts, part_id in self._drawn:
            if isinstance(pts, np.ndarray):
                out += [([tuple(c) for c in tri], part_id) for tri in pts.tolist()]
            else:
                out.append((pts, part_id))
        return out

    def pick(self, x: float, y: float) -> str:
        """The part drawn last under the point (what is drawn last is in front)."""
        for pts, part_id in reversed(self._drawn):
            if isinstance(pts, np.ndarray):  # the triangles of a mesh, all at once
                a, b, c = pts[:, 0], pts[:, 1], pts[:, 2]
                d1 = (x - b[:, 0]) * (a[:, 1] - b[:, 1]) - (a[:, 0] - b[:, 0]) * (y - b[:, 1])
                d2 = (x - c[:, 0]) * (b[:, 1] - c[:, 1]) - (b[:, 0] - c[:, 0]) * (y - c[:, 1])
                d3 = (x - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (y - a[:, 1])
                if np.any(~(((d1 < 0) | (d2 < 0) | (d3 < 0)) & ((d1 > 0) | (d2 > 0) | (d3 > 0)))):
                    return part_id
                continue
            inside, n = False, len(pts)
            for i in range(n):
                (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % n]
                if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                    inside = not inside
            if inside:
                return part_id
        return ""

    def mousePressEvent(self, event) -> None:  # noqa: N802
        self._drag = (event.position(), event.button(), bool(event.modifiers() & Qt.ShiftModifier), False)
        self.setFocus()

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if not self._drag:
            return
        last, button, shift, _moved = self._drag
        pos = event.position()
        dx, dy = pos.x() - last.x(), pos.y() - last.y()
        if abs(dx) + abs(dy) < 1:
            return
        if button == Qt.LeftButton and not shift:
            self.yaw = (self.yaw - dx * 0.4) % 360
            self.pitch = min(89.9, max(-89.9, self.pitch + dy * 0.4))
        else:
            r, u, _d = self._basis()
            self.target = self.target - (r * dx - u * dy) / self.zoom
        self._drag = (pos, button, shift, True)
        self._moving = True
        self.update()

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        moved = bool(self._drag and self._drag[3])
        self._drag = None
        if self._moving:
            self._moving = False
            self.update()
        if not moved and event.button() == Qt.LeftButton:
            self.selected = self.pick(event.position().x(), event.position().y())
            self.part_clicked.emit(self.selected)
            self.update()

    def mouseDoubleClickEvent(self, event) -> None:  # noqa: N802
        part_id = self.pick(event.position().x(), event.position().y())
        if part_id:
            self.zoom_to([part_id])
        else:
            self.fit()

    def wheelEvent(self, event) -> None:  # noqa: N802
        self.zoom_by(1.2 if event.angleDelta().y() > 0 else 1 / 1.2, event.position())

    def keyPressEvent(self, event) -> None:  # noqa: N802
        if event.key() in (Qt.Key_Plus, Qt.Key_Equal):
            self.zoom_by(1.25)
        elif event.key() == Qt.Key_Minus:
            self.zoom_by(0.8)
        elif event.key() == Qt.Key_F:
            self.fit()
        else:
            super().keyPressEvent(event)
