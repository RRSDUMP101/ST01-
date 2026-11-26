"""Simple 3D models of the coupling hardware seen on the RRS trailer video (Video_Project_2): Ford ball mount in the
receiver with hitch pin and clip, hand-lever ball coupling with lock indicator, crank jockey wheel with clamp knob.
Not in the trailer CAD file; sizes are typical. Writes one BREP per state, rendered by render.py like the CAD views.
Axes (mm): x along the drawbar (+ towards the trailer), y across, z up.  python3 parts.py <outdir>"""
import math, sys
from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism, BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeSphere, BRepPrimAPI_MakeTorus, BRepPrimAPI_MakeWedge
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform, BRepBuilderAPI_MakePolygon, BRepBuilderAPI_MakeFace
from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_EDGE
from OCP.gp import gp_Pnt, gp_Dir, gp_Ax2, gp_Trsf, gp_Ax1, gp_Vec
from OCP.TopoDS import TopoDS_Compound, TopoDS
from OCP.BRep import BRep_Builder
from OCP.BRepTools import BRepTools


def box(x0, y0, z0, dx, dy, dz, r=0):
    s = BRepPrimAPI_MakeBox(gp_Pnt(x0, y0, z0), dx, dy, dz).Shape()
    if r:
        f = BRepFilletAPI_MakeFillet(s); e = TopExp_Explorer(s, TopAbs_EDGE)
        while e.More():
            f.Add(r, TopoDS.Edge(e.Current())); e.Next()
        s = f.Shape()
    return s


def cyl(p, d, r, h):
    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(*p), gp_Dir(*d)), r, h).Shape()


def sph(p, r):
    return BRepPrimAPI_MakeSphere(gp_Pnt(*p), r).Shape()


def tor(p, d, R, r):
    return BRepPrimAPI_MakeTorus(gp_Ax2(gp_Pnt(*p), gp_Dir(*d)), R, r).Shape()


def cut(a, b):
    return BRepAlgoAPI_Cut(a, b).Shape()


def rot(s, p, a, deg):
    t = gp_Trsf(); t.SetRotation(gp_Ax1(gp_Pnt(*p), gp_Dir(*a)), math.radians(deg))
    return BRepBuilderAPI_Transform(s, t, True).Shape()


def move(s, v):
    t = gp_Trsf(); t.SetTranslation(gp_Vec(*v))
    return BRepBuilderAPI_Transform(s, t, True).Shape()


def comp(shapes):
    c = TopoDS_Compound(); b = BRep_Builder(); b.MakeCompound(c)
    for s in shapes:
        b.Add(c, s)
    return c


# ---------------------------------------------------------------- ball mount (car side): ball centre at (0, 0, 0)
def ball_mount():
    rec = cut(box(-420, -32, -120, 220, 64, 64, 3), box(-430, -26, -114, 240, 52, 52))       # Ford receiver tube
    tongue = box(-400, -25, -113, 300, 50, 50, 2)                                             # ball mount shank
    drop = box(-110, -25, -113, 60, 50, 95, 2)                                                # riser plate
    plate = box(-110, -40, -30, 120, 80, 22, 4)                                               # ball platform
    neck = cyl((0, 0, -10), (0, 0, 1), 15, 22)
    ball = sph((0, 0, 0), 25)                                                                 # Ø50 ball
    pin = cyl((-300, -50, -88), (0, 1, 0), 8, 100)                                            # hitch pin through receiver
    head = cyl((-300, -58, -88), (0, 1, 0), 14, 8)
    clip = tor((-300, 56, -88), (1, 0, 0), 18, 2.5)                                           # R-clip ring
    return [rec, tongue, drop, plate, neck, ball, pin, head, clip]


# ---------------------------------------------------------------- hand-lever coupling on the ball
def coupling(locked=True):
    body = box(-40, -45, -8, 330, 90, 70, 10)                                                 # cast head
    nose = cyl((0, -45, 30), (0, 1, 0), 45, 90)                                                # rounded front over the ball
    body = cut(body, sph((0, 0, 0), 27))
    shank = box(280, -40, -2, 420, 80, 60, 3)                                                  # drawbar tube
    bolts = [cyl((x, -48, 28), (0, 1, 0), 9, 96) for x in (330, 420)]
    hinge = (60, 0, 62)
    lever = box(60, -18, 58, 240, 36, 22, 6)                                                   # handle
    grip = box(220, -24, 60, 90, 48, 30, 10)                                                   # black grip
    ind = cyl((150, 0, 62), (0, 0, 1), 9, 8)                                                   # lock indicator button
    parts = [body, nose, shank, lever, grip] + bolts
    if not locked:
        parts = [body, nose, shank] + bolts + [rot(s, hinge, (0, 1, 0), -38) for s in (lever, grip)]
    return parts + [ind]


# ---------------------------------------------------------------- crank jockey wheel with clamp
def jockey(down=True):
    dz = 0 if down else 230
    bar = box(-150, -60, 300, 300, 120, 120, 4)                                                 # drawbar section
    clamp = cut(box(-55, -65, 280, 110, 130, 160, 6), box(-48, -60, 270, 96, 120, 180))
    knob = cyl((0, 65, 360), (0, 1, 0), 20, 30)
    knob2 = cyl((0, 95, 360), (0, 1, 0), 34, 14)                                               # red hand wheel
    outer = cyl((0, 0, 180 + dz), (0, 0, 1), 30, 420)
    inner = cyl((0, 0, 70 + dz), (0, 0, 1), 22, 120)
    cap = cyl((0, 0, 600 + dz), (0, 0, 1), 34, 30)
    crank = [cyl((0, 0, 630 + dz), (0, 0, 1), 8, 20), cyl((0, 0, 650 + dz), (1, 0, 0), 7, 110), cyl((110, 0, 590 + dz), (0, 0, 1), 10, 60)]
    fork = box(-35, -32, 40 + dz, 70, 64, 40, 4)
    wheel = cyl((0, -25, 40 + dz), (0, 1, 0), 40, 50)
    hub = cyl((0, -32, 40 + dz), (0, 1, 0), 12, 64)
    return [bar, clamp, knob, knob2, outer, inner, cap, fork, wheel, hub] + crank


# ---------------------------------------------------------------- front tool box (x along the box, y depth, z up)
def wedge(x0, y0, z0, dx, dy, dz):
    return BRepPrimAPI_MakeWedge(gp_Ax2(gp_Pnt(x0, y0, z0), gp_Dir(0, 0, 1), gp_Dir(1, 0, 0)), dx, dy, dz, 0).Shape()


def prism(pts, x0, L):
    """Profile pts [(y, z)] in the plane x = x0, extruded L along +x."""
    poly = BRepBuilderAPI_MakePolygon()
    for y, z in pts:
        poly.Add(gp_Pnt(x0, y, z))
    poly.Close()
    return BRepPrimAPI_MakePrism(BRepBuilderAPI_MakeFace(poly.Wire()).Face(), gp_Vec(L, 0, 0)).Shape()


# tool box at the front of the body, taken from the trailer CAD (trailer.igs): trapezoid side profile (front 150 high,
# lid sloping up to 270 at the body wall) and end walls angled in plan along the A-frame (back 1662, front 1358, depth 293)
TB_L, TB_D, TB_HF, TB_HB, TB_ANG = 1662, 293, 150, 270, math.degrees(math.atan(152 / 293))
TB_PROF = [(0, 0), (0, TB_HF), (240, TB_HB), (TB_D, TB_HB), (TB_D, 0)]


def tb_trim(s, off=0):
    """Cut the ends of s along the A-frame angle; off moves both planes inwards."""
    big = 3000
    left = rot(box(-big + off, -1000, -500, big, 3000, 2000), (off, TB_D, 0), (0, 0, 1), TB_ANG)
    right = rot(box(TB_L - off, -1000, -500, big, 3000, 2000), (TB_L - off, TB_D, 0), (0, 0, 1), -TB_ANG)
    return cut(cut(s, left), right)


def toolbox(open_=True):
    L, D, HF, HB, t = TB_L, TB_D, TB_HF, TB_HB, 4
    outer = tb_trim(prism(TB_PROF, -300, L + 600))
    inner = tb_trim(prism([(t, t), (t, 2000), (D - t, 2000), (D - t, t)], -300, L + 600), t + 2)
    shell = cut(cut(outer, inner), prism([(-50, HF), (240, HB), (-50, HB + 500)], -300, L + 600))   # open top under the lid
    shell = cut(shell, prism([(-50, HB), (D + 50, HB), (D + 50, HB + 500), (-50, HB + 500)], -300, L + 600))
    lid = tb_trim(prism([(-8, HF - 2), (-8, HF + 6), (238, HB + 8), (D + 4, HB + 8), (D + 4, HB), (240, HB), (0, HF - 2)], -300, L + 600), -6)
    if open_:
        lid = rot(lid, (0, D, HB), (1, 0, 0), 100)
    # red mushroom "Brake lock valve" button and its yellow plate, left end of the front face
    valve = [cyl((260, 0, 80), (0, -1, 0), 12, 20), cut(comp([cyl((260, -20, 80), (0, -1, 0), 26, 12), sph((260, -26, 80), 22)]), box(220, -2, 40, 80, 20, 80))]
    plate = box(305, -3, 55, 110, 3, 50)
    latch = []
    for x in (620, 1080):                                                      # two over-centre draw latches on the lid edge
        latch += [box(x, -10, HF - 55, 40, 10, 45, 3), box(x + 8, -16, HF - 95, 24, 6, 50)]
        if not open_:
            latch.append(box(x + 4, -14, HF + 2, 32, 8, 10))                       # keeper on the lid
    parts = [shell, lid, plate] + valve + latch
    if open_:   # layout seen on the RRS trailer (battery left, Break-Away unit and control box on the back wall, storage right)
        W = D - t
        parts += [box(300, 105, t, 230, 160, 175, 6)]                                                                   # battery (Amaron GO 12 V)
        parts += [cyl((335, 235, 179), (0, 0, 1), 22, 28), cyl((335, 235, 207), (0, 0, 1), 15, 12)]                      # + terminal, red cover
        parts += [cyl((495, 235, 179), (0, 0, 1), 12, 22)]                                                              # - terminal
        parts += [cyl((415, 92, t), (0, 0, 1), 6, 195), box(400, 92, 179, 30, 170, 10), cyl((415, 92, 120), (0, -1, 0), 14, 4)]   # J-bolt hold-down
        parts += [box(570, W - 50, 70, 190, 50, 170, 8), box(582, W - 54, 82, 166, 4, 140),                           # Break-Away unit on the back wall
                  cyl((610, W - 54, 200), (0, -1, 0), 11, 16), cyl((730, W - 54, 180), (0, -1, 0), 13, 6)]
        parts += [box(790, W - 65, 90, 220, 65, 140, 6)] + [box(802 + 17 * k, W - 71, 100, 8, 6, 120) for k in range(12)]   # black control box (ribbed)
        parts += [tor((620 + 90 * k, W - 60, 40), (1, 0, 0), 24, 6) for k in range(5)]                                    # wiring harness and plugs
        parts += [box(580 + 115 * k, W - 90, t, 40, 26, 30, 3) for k in range(4)]
    return parts


# ---------------------------------------------------------------- safety chains + breakaway cable on the drawbar
def chain(p0, p1, sag=60, link=22):
    """Chain links from p0 to p1 sagging in -z."""
    out = []
    n = max(4, int(math.dist(p0, p1) / link))
    for k in range(n + 1):
        t = k / n
        x = p0[0] + (p1[0] - p0[0]) * t; y = p0[1] + (p1[1] - p0[1]) * t; z = p0[2] + (p1[2] - p0[2]) * t - sag * 4 * t * (1 - t)
        d = (1, 0, 0) if k % 2 else (0, 0, 1)
        out.append(tor((x, y, z), d, 9, 2.6))
    return out


def chains():
    parts = ball_mount() + coupling(True)
    for s in (-1, 1):  # A-frame rails converging on the coupling tube
        r = box(700, -40, 0, 520, 80, 60, 3)
        parts.append(rot(move(r, (0, 0, 0)), (700, 0, 0), (0, 0, 1), s * 14))
        parts.append(box(600, s * 70 - 10, 20, 20, 20, 20))             # chain eye on the drawbar
    parts += chain((610, 80, 30), (-260, -45, -100), 80) + chain((610, -80, 30), (-260, 45, -100), 80)   # crossed under the coupling
    parts += [cyl((-262, y, -112), (0, 0, 1), 8, 24) for y in (-45, 45)]                                 # chain points on the ball mount
    # breakaway cable: thin coiled cable from the switch on the drawbar to the car
    sw = box(520, 60, 62, 60, 40, 40, 4)
    coil = [tor((520 - 18 * k, 80 - 6 * k, 40 - 3 * k), (1, 0, 0), 12, 1.8) for k in range(26)]
    return parts + [sw] + coil


# ---------------------------------------------------------------- 12-pin flat plug, face view
PINS12 = {1: (-1, -1), 2: (0, -1.25), 3: (1, -1), 4: (1.25, 0), 5: (1, 1), 6: (0, 1.25), 7: (-1, 1), 8: (-1.25, 0),
          9: (-.55, -.45), 10: (.55, -.45), 11: (.55, .45), 12: (-.55, .45)}


def plug12():
    body = cyl((0, 0, -60), (0, 0, 1), 32, 60)
    face = cut(cyl((0, 0, 0), (0, 0, 1), 32, 6), cyl((0, 0, 1), (0, 0, 1), 28, 10))
    grip = cyl((0, 0, -120), (0, 0, 1), 22, 60)
    key = box(-5, 29, -10, 10, 8, 16)
    pins = [box(x * 17 - 4, y * 17 - 1.6, -4, 8, 3.2, 6) for x, y in PINS12.values()]
    return [body, face, grip, key] + pins


# ---------------------------------------------------------------- breakaway unit (front)
def ba_unit():
    case = box(0, 0, 0, 300, 60, 240, 14)
    panel = box(14, -2, 14, 272, 4, 212, 1.5)
    knob = cyl((44, -2, 200), (0, -1, 0), 17, 24)                       # interior-lamp switch
    test = cyl((250, -2, 150), (0, -1, 0), 22, 8)                       # TEST button
    tube = box(232, -8, 30, 30, 8, 64, 3)                              # battery lamps
    leds = [cyl((247, -8, z), (0, -1, 0), 6, 4) for z in (44, 62, 80)]
    lugs = [box(-20, 10, z, 20, 40, 30, 4) for z in (20, 190)] + [box(300, 10, z, 20, 40, 30, 4) for z in (20, 190)]
    return [case, panel, knob, test, tube] + leds + lugs


if __name__ == "__main__":
    out = sys.argv[1]
    for name, shapes in (("ballmount", ball_mount()), ("cpl_open", ball_mount() + coupling(False)),
                         ("cpl_locked", ball_mount() + coupling(True)), ("jockey_down", jockey(True)), ("jockey_up", jockey(False)), ("toolbox", toolbox(False)), ("toolbox_open", toolbox(True)), ("chains", chains()), ("plug12", plug12()), ("ba_unit", ba_unit())):
        BRepTools.Write_s(comp(shapes), f"{out}/{name}.brep")
        print(name)
