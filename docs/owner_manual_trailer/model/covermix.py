"""trailer.brep + coupling (locked) and jockey wheel (up) from parts.py, placed at the drawbar nose -> trailer_cover.brep"""
import sys
sys.path.insert(0, "/home/user/st01-/docs/owner_manual_trailer/model")
import parts as P
from OCP.BRepTools import BRepTools
from OCP.BRep import BRep_Builder
from OCP.TopoDS import TopoDS_Shape
s = TopoDS_Shape(); BRepTools.Read_s(s, sys.argv[1], BRep_Builder())
ball = (0, -4900, 470)
add = [P.move(P.rot(x, (0, 0, 0), (0, 0, 1), 90), ball) for x in P.coupling(True)]
jk = P.jockey(False)[1:]                                   # without its own drawbar stub
add += [P.move(P.rot(x, (0, 0, 0), (0, 0, 1), 90), (115, -4250, 161)) for x in jk]
# wheels (CAD tyres: centre y -706 / 244, z 346, R 345, x 920..1120 and mirrored): steel rim with vent holes, hub cap,
# wheel nuts, sidewall line and tread grooves
import math
for side in (1, -1):
    xo = 1120 * side; d = (side, 0, 0)
    X = lambda v: xo + side * (50 - v)                # rim parts stand proud of the CAD tyre side (a solid disc)
    T = lambda v: xo - side * v                       # v mm in from the tyre side face
    for yc in (-706, 244):
        zc = 346
        add.append(P.tor((X(14), yc, zc), d, 205, 8))                                         # rim lip
        disc = P.cyl((X(40), yc, zc), d, 200, 18)
        for k in range(8):
            a_ = math.radians(22.5 + 45 * k)
            disc = P.cut(disc, P.cyl((X(60), yc + 135 * math.cos(a_), zc + 135 * math.sin(a_)), d, 24, 60))
        add.append(disc)
        add.append(P.cyl((X(30), yc, zc), d, 72, 14))                                         # hub face
        add.append(P.cyl((X(20), yc, zc), d, 46, 32))                                         # hub cap
        add += [P.cyl((X(20), yc + 88 * math.cos(math.radians(60 * k)), zc + 88 * math.sin(math.radians(60 * k))), d, 11, 16) for k in range(6)]   # wheel nuts
        add.append(P.tor((T(-4), yc, zc), d, 280, 5))                                          # sidewall bead line
        add += [P.tor((T(v), yc, zc), d, 345, 5) for v in (45, 85, 115, 155)]                 # tread grooves
# roof: seam caps over the panel joins, drip rails along the eaves, end caps
for yj in (-1710, -576, 557, 1693):
    add.append(P.box(-992, yj - 22, 3053, 1984, 44, 10))
for sx in (1, -1):
    add.append(P.box(992 if sx > 0 else -1018, -2862, 3008, 26, 5707, 52))
for ye in (-2862, 2845):
    add.append(P.box(-1018, ye - (26 if ye < 0 else 0), 3008, 2036, 26, 52))
BRepTools.Write_s(P.comp([s] + add), sys.argv[2])
print("ok")
