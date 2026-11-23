"""Figures for the owner manual taken from the RRS 3D model (พื้นเรียบ Ford.stp).

model/*.png are hidden-line renders of the STEP model (model/render.py), model/*.json their projections, so a 3D point
in model coordinates (mm; X to the rear, Y up, Z to the right-hand side) can be marked on a render: dashed circles,
numbers and arrows in the style of a carmaker's owner manual.
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
INK, NAVY, CYAN, RED = "#111", "#0B2A5B", "#00B4F0", "#D9534F"

# reference points on the model (mm)
PT = dict(
    headboard=(-1385, 620, 0), floor=(-180, 17, -300), side_gate=(0, 160, 982), side_rack=(0, 470, 960), tailgate=(1270, 160, 0),
    hinge_sg=[(-1035, 0, 1000), (-135, 0, 1000), (765, 0, 1000)], hinge_tg=[(1285, -45, -637), (1285, -45, -2), (1285, -45, 633)],
    lever_rh=(1300, 200, 965), lever_lh=(1300, 200, -965), latch_sg=[(1143, 283, 957), (-31, 283, 957), (-1214, 283, 957)],
    latch_tg=[(1250, 285, 826), (1250, 285, -7), (1250, 285, -831)],
    tiedown=[(x, 17, z) for x in (-1155, -519, 132, 782) for z in (800, -800)],
    lamp_rh=(1290, -150, 760), lamp_lh=(1290, -150, -760), plate=(1300, -150, 0), mudguard=(230, -300, 980), mudguard2=(-580, -300, 980),
    mount=(-600, -180, 600), head_bolts=[(-1378, 355, -702), (-1378, 355, -90), (-1378, 355, 90), (-1378, 355, 702),
                                         (-1378, 811, -448), (-1378, 811, -91), (-1378, 811, 91), (-1378, 811, 448)],
)


def _meta(name):
    return json.load(open(HERE / "model" / f"{name}.json"))


def xy(name, p):
    m = _meta(name)
    X = sum(a * b for a, b in zip(p, m["xd"])); Y = sum(a * b for a, b in zip(p, m["yd"]))
    return (X - m["x0"] + m["pad"]) / m["W"] * 1000, (-Y - m["y0"] + m["pad"]) / m["W"] * 1000


def view(name, marks=(), cap="", cls=""):
    """marks: ("c", p, r) dashed circle · ("n", p, n, dx, dy) number with leader · ("a", p1, p2) arrow ·
    ("ca", p, r, a0, a1) curved arrow around p · ("t", p, text, dx, dy) label."""
    m = _meta(name)
    h = m["H"] / m["W"] * 1000
    g = []
    for mk in marks:
        k = mk[0]
        if k == "c":
            x, y = xy(name, mk[1]); g.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{mk[2]}" fill="none" stroke="{INK}" stroke-width="3" stroke-dasharray="11 7"/>')
        elif k == "n":
            x, y = xy(name, mk[1]); dx, dy = mk[3], mk[4]
            g.append(f'<line x1="{x:.1f}" y1="{y:.1f}" x2="{x + dx:.1f}" y2="{y + dy:.1f}" stroke="{INK}" stroke-width="2.2"/><circle cx="{x:.1f}" cy="{y:.1f}" r="5" fill="{INK}"/>'
                     f'<circle cx="{x + dx:.1f}" cy="{y + dy:.1f}" r="21" fill="{INK}"/><text x="{x + dx:.1f}" y="{y + dy + 9:.1f}" text-anchor="middle" font-size="26" font-weight="bold" fill="#fff" font-family="Noto Sans">{mk[2]}</text>')
        elif k == "a":
            (x1, y1), (x2, y2) = xy(name, mk[1]), xy(name, mk[2])
            g.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{CYAN}" stroke-width="9" marker-end="url(#ah)"/>')
        elif k == "ca":
            x, y = xy(name, mk[1]); r, a0, a1 = mk[2], mk[3], mk[4]
            import math
            p0 = (x + r * math.cos(math.radians(a0)), y + r * math.sin(math.radians(a0))); p1 = (x + r * math.cos(math.radians(a1)), y + r * math.sin(math.radians(a1)))
            sweep = 1 if a1 > a0 else 0
            g.append(f'<path d="M{p0[0]:.1f} {p0[1]:.1f} A{r} {r} 0 0 {sweep} {p1[0]:.1f} {p1[1]:.1f}" fill="none" stroke="{CYAN}" stroke-width="9" marker-end="url(#ah)"/>')
        elif k == "t":
            x, y = xy(name, mk[1]); dx, dy = mk[3], mk[4]
            g.append(f'<text x="{x + dx:.1f}" y="{y + dy:.1f}" text-anchor="middle" font-size="30" font-weight="bold" fill="{NAVY}" font-family="Noto Sans, Noto Sans Thai" paint-order="stroke" stroke="#fff" stroke-width="8">{mk[2]}</text>')
    defs = f'<defs><marker id="ah" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="{CYAN}"/></marker></defs>'
    svg = f'<svg class="ov" viewBox="0 0 1000 {h:.0f}" xmlns="http://www.w3.org/2000/svg">{defs}{"".join(g)}</svg>'
    return (f'<div class="mv {cls}"><div class="mvin"><img src="model/{name}.png">{svg}</div>'
            + (f'<p class="cap">{cap}</p>' if cap else "") + "</div>")


def row(*items, cls=""):
    return f'<div class="mvrow {cls}">' + "".join(items) + "</div>"


CSS = '''
.mv{margin:1mm 0 2mm;text-align:center}.mvin{position:relative;display:inline-block;width:100%}.mvin img{width:100%;display:block}
.mvin svg.ov{position:absolute;left:0;top:0;width:100%;height:100%}
.mv.s .mvin{width:72%}.mv.m .mvin{width:62%}.mv.xxs .mvin{width:38%}.mv.t .mvin{width:30%}.mv.t2 .mvin{width:26%}.mv.h .mvin{width:46%}.mv.h2 .mvin{width:40%}.side2{display:flex;gap:5mm;align-items:flex-start}.side2>.mv{flex:0 0 40%}.side2>div:last-child{flex:1}.mv.xs .mvin{width:55%}.mv.l .mvin{width:88%}
.coverfig .mvin{width:auto}.coverfig .mvin img{max-height:56mm;width:auto;margin:0 auto}.mvrow{display:flex;gap:4mm;align-items:flex-end}.mvrow .mv{flex:1}
.mv.box .mvin{border:1.2pt solid #111;border-radius:3mm;overflow:hidden}
'''
