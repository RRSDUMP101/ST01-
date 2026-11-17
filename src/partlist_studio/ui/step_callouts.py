"""ป้ายของขั้นที่ชิ้นเยอะ: แสดงเป็นกลุ่มก่อน (กลุ่มละ 1 ป้าย สีเดียวกับชิ้น) แตะกลุ่มแล้วจึงเห็นหมายเลขรายการของกลุ่มนั้น.

Drawn by Assembly3DView for a step that AssemblyModel.crowded() says is crowded; every other step keeps its numbers
as they always were. Rules:

* nothing picked: one callout per group – ■ name ×pieces – with a line to one part of the group;
* a group in focus: one number per list line of that group ('48 ×4': the line has four pieces), the other parts
  of the step pale; top left ◂ ทุกกลุ่ม · ‹ · the group · › to walk through the groups;
* a small or hidden part of what is looked at has a dot in the colour of its group (hollow: it is behind another);
* no two labels overlap; a label with no room is counted in a note, never dropped silently;
* while the model is turned the labels ride with their parts and are laid out again when the mouse lets go.
"""

from __future__ import annotations

import math

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QFont, QPainter, QPen

from ..core.assembly3d import StepPlan
from . import theme

DIM = QColor("#BFD2C2")  # a part of this step that is not in the group looked at: pale, not the colour of what is done
INK = QColor("#1E2A3A")
TRAVEL = QColor("#2E9D5B")
PICKED = QColor(theme.ACCENT)
RADII = (9, 18, 30, 46, 66, 90, 120, 155, 195)  # how far a label may stand from what it points at (px × text scale)
DIRS = 16
SMALL = 14  # a part whose smaller side in the picture is under … px has a dot: its colour alone cannot be seen
REPS = 8  # of the parts of a line or a group, so many are tried as the one the label points at
FINGER = 6  # px: a label takes a tap this far outside what is drawn


def part_colour(view, part, plan: StepPlan) -> QColor:
    """The colour of a part of the crowded step: that of its group; pale while another group is looked at."""
    if view.focus and part.group not in view.focus:
        return QColor(DIM)
    return QColor(plan.colour.get(part.group, "#5DBB63"))


def surface_point(mesh) -> np.ndarray:
    """A point of the part itself near the middle of its box: the middle of the box of a hoop or of an angle is in
    the air, and a label pointing there points at the part behind. Found once per part."""
    point = getattr(mesh, "label_point", None)
    if point is None:
        piece = mesh.pieces[0]
        if piece.tri is not None and len(piece.tri):
            mids = piece.tri.mean(axis=1)
        else:  # convex pieces: the middle of the piece nearest to the middle of the part is inside it
            mids = np.array([(c.lo + c.hi) / 2 for c in mesh.pieces])
        point = mids[int(np.argmin(((mids - mesh.centre) ** 2).sum(axis=1)))]
        mesh.label_point = point
    return point


def layout(items, w, h, k, blocked, avoid, cover: float = 14.0) -> dict:
    """Greedy, no two labels over one another. items: (key, anchors [(x, y, penalty, may sit on it)], width, height)
    in the order they are placed; blocked: rectangles no label may touch; avoid: points a label should not cover (the
    other parts of the step). Returns key → (rect, anchor x, anchor y); an item with no free place is left out."""
    ang = np.linspace(0, 2 * math.pi, DIRS, endpoint=False)
    ca, sa = np.cos(ang), np.sin(ang)
    radii = np.array(RADII, dtype=float) * k
    boxes = np.array([[b.left(), b.top(), b.right(), b.bottom()] for b in blocked], dtype=float).reshape(-1, 4)
    avoid = np.asarray(avoid, dtype=float).reshape(-1, 2)
    pts = [a[:2] for _key, anchors, _w, _h in items for a in anchors] or [(w / 2, h / 2)]
    mid = np.mean(np.array(pts, dtype=float), axis=0)
    out = {}
    for key, anchors, bw, bh in items:
        best = None
        for ax, ay, penalty, on_it in anchors:
            # the middle of the label: far enough along the direction that the label is clear of its anchor
            reach = np.minimum(bw / 2 / np.maximum(np.abs(ca), 1e-6), bh / 2 / np.maximum(np.abs(sa), 1e-6))
            dist = radii[:, None] + reach[None, :]
            cx, cy = (ax + dist * ca[None, :]).ravel(), (ay + dist * sa[None, :]).ravel()
            gap = np.repeat(radii, DIRS)
            away = math.atan2(ay - mid[1], ax - mid[0])  # labels stand on the outer side of the model
            cost = gap + 22 * k * (1 - np.cos(np.tile(ang, len(radii)) - away)) + penalty
            if on_it:  # a big part: its number may sit on it
                cx, cy = np.append(cx, ax), np.append(cy, ay)
                cost = np.append(cost, penalty - 4.0)
            x0, y0, x1, y1 = cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2
            ok = (x0 >= 4) & (y0 >= 4) & (x1 <= w - 4) & (y1 <= h - 4)
            pad = 3 * k
            if len(boxes):
                hit = ((x0[:, None] < boxes[None, :, 2] + pad) & (x1[:, None] > boxes[None, :, 0] - pad)
                       & (y0[:, None] < boxes[None, :, 3] + pad) & (y1[:, None] > boxes[None, :, 1] - pad))
                ok &= ~hit.any(axis=1)
                # the line from the label to its anchor may not run under another label
                t = np.linspace(0.15, 1.0, 7)[None, :, None]
                seg = np.stack((cx, cy), axis=1)[:, None, :] * (1 - t) + np.array([ax, ay])[None, None, :] * t
                under = ((seg[:, :, None, 0] > boxes[None, None, :, 0]) & (seg[:, :, None, 0] < boxes[None, None, :, 2])
                         & (seg[:, :, None, 1] > boxes[None, None, :, 1]) & (seg[:, :, None, 1] < boxes[None, None, :, 3]))
                ok &= ~under.any(axis=(1, 2))
            if len(avoid):
                m = 2 * k
                covered = ((avoid[None, :, 0] > x0[:, None] - m) & (avoid[None, :, 0] < x1[:, None] + m)
                           & (avoid[None, :, 1] > y0[:, None] - m) & (avoid[None, :, 1] < y1[:, None] + m)).sum(axis=1)
                own = (ax > x0 - m) & (ax < x1 + m) & (ay > y0 - m) & (ay < y1 + m)
                cost = cost + cover * k * (covered - own)
            if not ok.any():
                continue
            cost = np.where(ok, cost, np.inf)
            i = int(np.argmin(cost))
            if best is None or cost[i] < best[0]:
                best = (float(cost[i]), QRectF(x0[i], y0[i], bw, bh), ax, ay)
        if best is None:
            continue
        _c, rect, ax, ay = best
        out[key] = (rect, ax, ay)
        boxes = np.vstack((boxes, [[rect.left(), rect.top(), rect.right(), rect.bottom()]]))
        t = np.linspace(0.2, 0.9, 5)[:, None]  # … and later labels keep off this one's line
        c = np.array([rect.center().x(), rect.center().y()])
        avoid = np.vstack((avoid, c[None, :] * (1 - t) + np.array([ax, ay])[None, :] * t))
    return out


def edge_point(rect: QRectF, x: float, y: float) -> QPointF:
    """Where the line from the middle of a label to (x, y) leaves the label."""
    c = rect.center()
    dx, dy = x - c.x(), y - c.y()
    if abs(dx) < 1e-6 and abs(dy) < 1e-6:
        return c
    f = min(rect.width() / 2 / abs(dx) if dx else 1e9, rect.height() / 2 / abs(dy) if dy else 1e9)
    return QPointF(c.x() + dx * min(f, 1.0), c.y() + dy * min(f, 1.0))


def _font(k: float, size: float = 9.5, bold: bool = True) -> QFont:
    font = QFont(theme.app_font())
    font.setPointSizeF(size * k)
    font.setBold(bold)
    return font


def _leader(painter: QPainter, rect: QRectF, x: float, y: float, k: float, colour: QColor, hollow: bool = False) -> None:
    a = edge_point(rect, x, y)
    if (a.x() - x) ** 2 + (a.y() - y) ** 2 > 4:
        painter.setPen(QPen(QColor(255, 255, 255, 215), 3.2 * k, Qt.SolidLine, Qt.RoundCap))  # reads on any colour
        painter.drawLine(a, QPointF(x, y))
        painter.setPen(QPen(INK, 1.15 * k, Qt.SolidLine, Qt.RoundCap))
        painter.drawLine(a, QPointF(x, y))
    if hollow:
        painter.setPen(QPen(colour, 1.7 * k))
        painter.setBrush(QColor("white"))
    else:
        painter.setPen(QPen(QColor("white"), 1.2 * k))
        painter.setBrush(colour)
    painter.drawEllipse(QPointF(x, y), 3.4 * k, 3.4 * k)


def _dot(painter: QPainter, x: float, y: float, k: float, colour: QColor, radius: float = 2.6, hollow: bool = False) -> None:
    if hollow:  # the part is under / behind another one
        painter.setPen(QPen(colour, 1.5 * k))
        painter.setBrush(QColor(255, 255, 255, 235))
        painter.drawEllipse(QPointF(x, y), (radius + 0.6) * k, (radius + 0.6) * k)
        return
    painter.setPen(QPen(QColor(255, 255, 255, 230), 1.0 * k))
    painter.setBrush(colour)
    painter.drawEllipse(QPointF(x, y), radius * k, radius * k)


def _anchors(view, key, marks) -> list:
    """Of the same parts, the ones a label may point at. A number: those that can be seen first, the nearest to the
    eye first. The callout of a group: the parts on the outer sides of the group (there the callout finds room)."""
    if key[0] == "g":
        out = []
        for a in np.linspace(0, 2 * math.pi, REPS, endpoint=False):
            m = max(marks, key=lambda m: m["x"] * math.cos(a) + m["y"] * math.sin(a))
            if m not in out:
                out.append(m)
        return out
    return sorted(marks, key=lambda m: (bool(view._hidden.get(m["part"].id)), m["depth"]))[:REPS]


def paint(view, painter: QPainter, plan: StepPlan, marks: list[dict], w: int, h: int) -> None:
    """The labels of a crowded step over the finished picture. `marks`: every part of the step that is drawn (and
    the selected part) with where it is on the screen (x, y), where its place is (hx, hy), how far from the eye
    (depth) and how big on the screen (size)."""
    k = view._text_scale
    live = not view._static
    flying = live and view._anim > 0  # the parts are on their way in: only the ways, the labels when they have arrived
    current = [m for m in marks if m["current"]]
    moved = [m for m in marks if abs(m["x"] - m["hx"]) + abs(m["y"] - m["hy"]) > 14 * k]
    selected = next((m for m in marks if m["part"].id == view.selected), None)
    at_rest = not view._moving
    colours = {g: QColor(c) for g, c in plan.colour.items()}

    def travel(m, strong: bool) -> None:
        c = QColor(TRAVEL)
        c.setAlpha(255 if strong else 110)
        painter.setPen(QPen(c, (1.6 if strong else 0.9) * k, Qt.DashLine))
        painter.drawLine(QPointF(m["x"], m["y"]), QPointF(m["hx"], m["hy"]))
        if strong:
            painter.setBrush(TRAVEL)
            painter.setPen(Qt.NoPen)
            painter.drawEllipse(QPointF(m["hx"], m["hy"]), 3.5 * k, 3.5 * k)

    if not view.show_labels or flying:
        for m in moved:  # thin: a hundred of them at once must not hide the parts
            travel(m, strong=len(moved) <= 30 or m is selected)
        if selected and view.show_labels:
            _paint_name(painter, selected, k, w, h)
        return

    blocked = [QRectF(0, h - 78 * k, 150 * k, 78 * k)]  # the three axes in the corner
    header = _caption(view, painter, plan, colours, k, w, live)
    if header:
        blocked.append(header)
    groups_view = not view.focus
    # the same picture as the last one laid out (a repaint for a selection, a card, the window coming back)?
    sig = (w, h, k, view.yaw, view.pitch, view.zoom, tuple(np.round(view.target, 3)), view.step, frozenset(view.focus),
           view.picked_line, view.explode, view._anim, len(current), len(plan.lines), frozenset(view.hidden_groups),
           frozenset(view.hidden_parts), view.ghost_later)
    fresh = at_rest and sig != view._sig
    if fresh and not groups_view:  # is a part behind another one? - what is drawn at its point tells
        looked_at = {m["part"].id for m in current if m["part"].group in view.focus}
        view._hidden = {m["part"].id: view.pick(m["x"], m["y"]) not in looked_at for m in current
                        if m["part"].id in looked_at}  # behind a part of the same group is not hidden: the group shows
    hidden = {} if groups_view else view._hidden

    def lies_on(m, bw, bh) -> bool:
        """A number may sit ON its part when the whole label is on what can be seen of the part."""
        if m["size"] < 1.5 * bh or hidden.get(m["part"].id):
            return False
        return all(view.pick(m["x"] + sx * bw * 0.45, m["y"] + sy * bh * 0.4) == m["part"].id
                   for sx in (-1, 1) for sy in (-1, 1))

    font, small = _font(k), _font(k, 8.0, False)
    painter.setFont(small)
    fm_small = painter.fontMetrics()
    painter.setFont(font)
    fm = painter.fontMetrics()
    entries, info = [], {}  # (key, its parts, width, height) · key → (text, count, its parts)
    if groups_view:  # one callout per group: ■ name ×pieces
        for g in plan.groups:
            mine = [m for m in current if m["part"].group == g]
            if mine:
                text, count = g, f"×{plan.pieces[g]}"
                bw = 30 * k + fm.horizontalAdvance(text) + 6 * k + fm.horizontalAdvance(count) + 9 * k
                entries.append((("g", g), mine, bw, 26 * k))
                info[("g", g)] = (text, count, mine)
        shown = current
    else:  # one number per list line of the groups looked at
        shown = [m for m in current if m["part"].group in view.focus]
        by_line: dict[int, list] = {}
        for m in shown:
            by_line.setdefault(plan.no_of.get(m["part"].id, 0), []).append(m)
        for no, mine in by_line.items():
            text = str(no)
            count = f"×{len(mine)}" if len(mine) > 1 else ""
            bw = max(24.0 * k, fm.horizontalAdvance(text) + 13 * k) + (fm_small.horizontalAdvance(count) + 3 * k if count else 0)
            entries.append((("l", no), mine, bw, 22 * k))
            info[("l", no)] = (text, count, mine)
    by_id = {m["part"].id: m for m in current}
    if not fresh and view._sig is not None and all(view._kept[key][0] in by_id for key in view._kept):
        # the model is being turned: every label goes along with its part, as it stood (no new layout: nothing
        # jumps, and a frame costs no more than before); when the mouse lets go the labels are laid out again
        placed = {}
        for key, _mine, bw, bh in entries:
            if key in view._kept:  # else it had no room
                part_id, dx, dy = view._kept[key]
                m = by_id[part_id]
                placed[key] = (QRectF(m["x"] + dx - bw / 2, m["y"] + dy - bh / 2, bw, bh), m["x"], m["y"])
    else:
        avoid = [(m["x"], m["y"]) for m in shown]
        if groups_view:
            items = [(key, [(m["x"], m["y"], 0.0, False) for m in _anchors(view, key, mine)], bw, bh)
                     for key, mine, bw, bh in entries]
            # few and wide: the order they are placed in matters, so some orders are tried and the best is kept
            best = None
            for order_by in (lambda it: -len(info[it[0]][2]), lambda it: len(info[it[0]][2]),
                             lambda it: min(a[1] for a in it[1]), lambda it: -max(a[1] for a in it[1]),
                             lambda it: min(a[0] for a in it[1]), lambda it: -max(a[0] for a in it[1])):
                got = layout(sorted(items, key=order_by), w, h, k, blocked, avoid, cover=32.0)
                score = sum(math.hypot(r.center().x() - ax, r.center().y() - ay) for r, ax, ay in got.values()) \
                    + 1000 * (len(items) - len(got))
                if best is None or score < best[0]:
                    best = (score, got)
            placed = best[1] if best else {}
        else:
            items = [(key, [(m["x"], m["y"], 3.0 * i + (30.0 * k if hidden.get(m["part"].id) else 0.0), lies_on(m, bw, bh))
                            for i, m in enumerate(_anchors(view, key, mine))], bw, bh) for key, mine, bw, bh in entries]
            # the line that is picked first, then from the outside of the model inwards
            mid = np.mean([[m["x"], m["y"]] for m in shown], axis=0) if shown else np.zeros(2)
            items.sort(key=lambda it: (it[0][1] != view.picked_line,
                                       -max((a[0] - mid[0]) ** 2 + (a[1] - mid[1]) ** 2 for a in it[1])))
            placed = layout(items, w, h, k, blocked, avoid, cover=14.0)
        view._kept, view._sig = {}, (sig if at_rest else None)
        for key, (rect, ax, ay) in placed.items():
            rep = min(info[key][2], key=lambda m: (m["x"] - ax) ** 2 + (m["y"] - ay) ** 2)
            view._kept[key] = (rep["part"].id, rect.center().x() - ax, rect.center().y() - ay)

    # ---- under the labels: where the small parts of what is looked at are
    any_hidden = False
    for m in current:
        g = m["part"].group
        if view.focus and g not in view.focus:
            continue  # pale in the picture, no dot: not what is looked at now
        colour = colours.get(g, INK)
        if not groups_view and plan.no_of.get(m["part"].id) == view.picked_line:
            painter.setPen(QPen(PICKED, 2.2 * k))
            painter.setBrush(Qt.NoBrush)
            painter.drawEllipse(QPointF(m["x"], m["y"]), 8 * k, 8 * k)
        if m["size"] < SMALL * k or hidden.get(m["part"].id):
            any_hidden = any_hidden or bool(hidden.get(m["part"].id))
            _dot(painter, m["x"], m["y"], k, colour.darker(115), 2.2 if groups_view else 2.8,
                 hollow=bool(hidden.get(m["part"].id)))
    for key, (rect, ax, ay) in placed.items():
        rep = by_id[view._kept[key][0]]
        if rep in moved:
            travel(rep, strong=True)
        if rect.contains(ax, ay):
            continue  # the number sits on its part
        any_hidden = any_hidden or bool(hidden.get(rep["part"].id))
        _leader(painter, rect, ax, ay, k, colours.get(rep["part"].group, INK).darker(115),
                hollow=bool(hidden.get(rep["part"].id)))
    for m in moved:
        if m in shown and not any(view._kept[key][0] == m["part"].id for key in placed):
            travel(m, strong=False)
    # ---- the labels
    for key, (rect, _ax, _ay) in placed.items():
        text, count, mine = info[key]
        if key[0] == "g":
            colour = colours[key[1]]
            painter.setPen(QPen(colour.darker(120), 1.6 * k))
            painter.setBrush(QColor(255, 255, 255, 242))
            painter.drawRoundedRect(rect, 6 * k, 6 * k)
            sw = QRectF(rect.left() + 7 * k, rect.center().y() - 7 * k, 14 * k, 14 * k)
            painter.setPen(Qt.NoPen)
            painter.setBrush(colour)
            painter.drawRoundedRect(sw, 3 * k, 3 * k)
            painter.setPen(INK)
            painter.setFont(font)
            painter.drawText(QRectF(sw.right() + 6 * k, rect.top(), rect.width(), rect.height()),
                             Qt.AlignVCenter | Qt.AlignLeft, text)
            painter.setPen(colour.darker(150))
            painter.drawText(QRectF(rect.left(), rect.top(), rect.width() - 8 * k, rect.height()),
                             Qt.AlignVCenter | Qt.AlignRight, count)
            view._hits.append((rect, "group", key[1]))
        else:
            picked = key[1] == view.picked_line
            colour = colours.get(mine[0]["part"].group, INK)
            painter.setPen(QPen(PICKED.darker(115) if picked else colour.darker(125), (2.0 if picked else 1.5) * k))
            painter.setBrush(QColor("#FFE7C7") if picked else QColor(255, 255, 255, 242))
            painter.drawRoundedRect(rect, 11 * k, 11 * k)
            painter.setPen(INK)
            painter.setFont(font)
            if count:
                painter.drawText(QRectF(rect.left() + 6.5 * k, rect.top(), rect.width(), rect.height()),
                                 Qt.AlignVCenter | Qt.AlignLeft, text)
                painter.setFont(small)
                painter.setPen(QColor(theme.MUTED))
                painter.drawText(QRectF(rect.left(), rect.top(), rect.width() - 6 * k, rect.height()),
                                 Qt.AlignVCenter | Qt.AlignRight, count)
                painter.setFont(font)
            else:
                painter.drawText(rect, Qt.AlignCenter, text)
            view._hits.append((rect, "line", key[1]))
    notes = []
    if any_hidden:
        notes.append("○ = ชิ้นอยู่ใต้ / หลังชิ้นอื่น" + (" – หมุนภาพเพื่อดู" if live else ""))
    if len(entries) > len(placed):  # no room: said, not silently dropped (the list of the step has them all)
        notes.append(f"อีก {len(entries) - len(placed)} รายการไม่มีที่วางป้าย – ดูในรายการ" + (" / ซูมเข้า" if live else ""))
    view.callout_notes = notes
    if notes:
        painter.setFont(small)
        painter.setPen(QColor(theme.MUTED))
        painter.drawText(QRectF(0, h - 24 * k, w - 8 * k, 20 * k), Qt.AlignRight | Qt.AlignVCenter, "   ·   ".join(notes))
    if selected:
        _paint_name(painter, selected, k, w, h)


def _paint_name(painter: QPainter, m: dict, k: float, w: int, h: int) -> None:
    """The part that was tapped: its name, above the part and kept inside the picture."""
    painter.setFont(_font(k))
    text = m["part"].name
    width = painter.fontMetrics().horizontalAdvance(text) + 14 * k
    x = min(max(m["x"] - width / 2, 4), max(4, w - width - 4))
    y = m["y"] - 34 * k if m["y"] > 44 * k else m["y"] + 12 * k
    box = QRectF(x, y, width, 22 * k)
    painter.setPen(QPen(PICKED.darker(115), 1.4 * k))
    painter.setBrush(QColor("#FFE7C7"))
    painter.drawRoundedRect(box, 11 * k, 11 * k)
    painter.setPen(INK)
    painter.drawText(box, Qt.AlignCenter, text)


def _caption(view, painter: QPainter, plan: StepPlan, colours: dict, k: float, w: int, live: bool) -> QRectF | None:
    """Top left. All groups: what a tap does. A group in focus: its name and numbers; on the screen also ◂ ทุกกลุ่ม
    and ‹ › to walk through the groups one after another (34 px high: for a finger)."""
    font = _font(k)
    painter.setFont(font)
    fm = painter.fontMetrics()
    x, y, hgt = 8 * k, 8 * k, (34 if live else 26) * k

    def chip(text, kind=None, value=None, fill=None, pen=None, swatch=None, ink=INK) -> QRectF:
        nonlocal x
        width = fm.horizontalAdvance(text) + 20 * k + (20 * k if swatch else 0)
        rect = QRectF(x, y, width, hgt)
        painter.setPen(QPen(pen or QColor(theme.BORDER).darker(120), 1.2 * k))
        painter.setBrush(fill or QColor(255, 255, 255, 240))
        painter.drawRoundedRect(rect, 7 * k, 7 * k)
        tx = rect.left() + 10 * k
        if swatch:
            painter.setPen(Qt.NoPen)
            painter.setBrush(swatch)
            painter.drawRoundedRect(QRectF(tx, rect.center().y() - 7 * k, 14 * k, 14 * k), 3 * k, 3 * k)
            tx += 20 * k
        painter.setPen(ink)
        painter.drawText(QRectF(tx, rect.top(), width, hgt), Qt.AlignVCenter | Qt.AlignLeft, text)
        if kind and live:
            view._hits.append((rect, kind, value))
        x = rect.right() + 6 * k
        return rect

    if not view.focus:
        if not live:
            return None
        painter.setFont(_font(k, 8.5, False))
        text = f"{len(plan.groups)} กลุ่ม · {len(plan.lines)} รายการ – แตะป้ายกลุ่มเพื่อดูหมายเลขชิ้น"
        rect = QRectF(x, y, painter.fontMetrics().horizontalAdvance(text) + 8 * k, 20 * k)
        painter.setPen(QColor(theme.MUTED))
        painter.drawText(rect, Qt.AlignVCenter | Qt.AlignLeft, text)
        return rect
    first = None
    if live:
        first = chip("◂ ทุกกลุ่ม", "all", None, fill=QColor(theme.NAVY), pen=QColor(theme.NAVY), ink=QColor("white"))
        chip("‹", "step", -1)
    for g in [g for g in plan.groups if g in view.focus]:
        rect = chip(f"{g} ×{plan.pieces[g]}  ·  {plan.span(g)}", swatch=colours[g], pen=colours[g].darker(120))
        first = first or rect
        if x > w - 120 * k and not live:  # the printed picture: the next group on a new row
            x, y = 8 * k, y + hgt + 4 * k
    if first is None:  # the group in focus has no parts left in this step
        return None
    if live:
        last = chip("›", "step", 1)
        return QRectF(first.topLeft(), last.bottomRight())
    return QRectF(8 * k, 8 * k, w - 16 * k, y + hgt - 8 * k) if y > 8 * k else QRectF(first.topLeft(), QPointF(x, y + hgt))


def tapped(view, x: float, y: float) -> bool:
    """A tap at (x, y): did it hit a label or a button of the crowded step? Then the focus follows and True."""
    plan = view.plan()
    if plan is None:
        return False
    for rect, kind, value in reversed(view._hits):
        if not rect.adjusted(-FINGER, -FINGER, FINGER, FINGER).contains(x, y):  # a finger is not a mouse
            continue
        if kind == "group":
            view.set_focus({value})
        elif kind == "all":
            view.set_focus(set())
        elif kind == "step":  # the next / the one before, round and round
            now = next((i for i, g in enumerate(plan.groups) if g in view.focus), 0)
            view.set_focus({plan.groups[(now + value) % len(plan.groups)]})
        elif kind == "line":
            view.set_focus(view.focus, 0 if value == view.picked_line else value)
        return True
    return False
