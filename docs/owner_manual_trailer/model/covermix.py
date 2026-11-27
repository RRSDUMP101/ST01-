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
BRepTools.Write_s(P.comp([s] + add), sys.argv[2])
print("ok")
