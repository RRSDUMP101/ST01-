"""Render hidden-line views of the RRS flatbed model. usage: render.py brep spec.py outdir
spec.py defines VIEWS = [dict(name, dir, up=(0,1,0), keep=lambda i,b: bool, rot=[(sel, (px,py,pz), (ax,ay,az), deg)], defl=1.0)]"""
import sys, json, time, math, runpy
from OCP.BRepTools import BRepTools
from OCP.BRep import BRep_Builder
from OCP.TopoDS import TopoDS_Shape, TopoDS_Compound, TopoDS
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_SOLID, TopAbs_EDGE
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.HLRBRep import HLRBRep_PolyAlgo, HLRBRep_PolyHLRToShape
from OCP.HLRAlgo import HLRAlgo_Projector
from OCP.gp import gp_Ax2, gp_Pnt, gp_Dir, gp_Trsf, gp_Ax1
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.GCPnts import GCPnts_QuasiUniformDeflection
brep, specf, outdir = sys.argv[1:4]
only = sys.argv[4:]
spec = runpy.run_path(specf)
s = TopoDS_Shape(); BRepTools.Read_s(s, brep, BRep_Builder())
solids = []
e = TopExp_Explorer(s, TopAbs_SOLID)
while e.More():
    b = Bnd_Box(); BRepBndLib.Add_s(e.Current(), b); m = b.CornerMin(); M = b.CornerMax()
    solids.append((e.Current(), (m.X(), m.Y(), m.Z(), M.X(), M.Y(), M.Z())))
    e.Next()
BRepMesh_IncrementalMesh(s, 2.0, False, 0.4, True)
def lines(shape, defl):
    res = []
    if shape is None or shape.IsNull(): return res
    ex = TopExp_Explorer(shape, TopAbs_EDGE)
    while ex.More():
        c = BRepAdaptor_Curve(TopoDS.Edge(ex.Current()))
        try:
            u = GCPnts_QuasiUniformDeflection(c, defl)
            pts = [c.Value(u.Parameter(i)) for i in range(1, u.NbPoints() + 1)]
        except Exception:
            pts = [c.Value(c.FirstParameter()), c.Value(c.LastParameter())]
        res.append([(p.X(), -p.Y()) for p in pts])
        ex.Next()
    return res
for v in spec["VIEWS"]:
    if only and v["name"] not in only: continue
    t = time.time()
    comp = TopoDS_Compound(); bld = BRep_Builder(); bld.MakeCompound(comp)
    for i, (sh, bb) in enumerate(solids):
        if not v["keep"](i, bb): continue
        for sel, p, a, deg in v.get("rot", []):
            if sel(i, bb):
                tr = gp_Trsf(); tr.SetRotation(gp_Ax1(gp_Pnt(*p), gp_Dir(*a)), math.radians(deg))
                sh = BRepBuilderAPI_Transform(sh, tr, True).Shape()
                BRepMesh_IncrementalMesh(sh, 2.0, False, 0.4, True)
        for sel, mv in v.get("move", []):
            if sel(i, bb):
                tr = gp_Trsf(); tr.SetTranslation(__import__("OCP.gp", fromlist=["gp_Vec"]).gp_Vec(*mv))
                sh = BRepBuilderAPI_Transform(sh, tr, True).Shape()
                BRepMesh_IncrementalMesh(sh, 2.0, False, 0.4, True)
        bld.Add(comp, sh)
    d = gp_Dir(*v["dir"]); up = gp_Dir(*v.get("up", (0, 1, 0)))
    xd = up.Crossed(d)
    ax = gp_Ax2(gp_Pnt(0, 0, 0), d, xd)
    algo = HLRBRep_PolyAlgo(); algo.Load(comp); algo.Projector(HLRAlgo_Projector(ax)); algo.Update()
    h = HLRBRep_PolyHLRToShape(); h.Update(algo)
    defl = v.get("defl", 1.0)
    vis = lines(h.VCompound(), defl) + lines(h.OutLineVCompound(), defl)
    smooth = lines(h.Rg1LineVCompound(), defl)
    yd0 = d.Crossed(xd)
    if "crop" in v:
        c = v["crop"]; pts = [(a, bb_, cc) for a in (c[0], c[3]) for bb_ in (c[1], c[4]) for cc in (c[2], c[5])]
        allp = [(px * xd.X() + py * xd.Y() + pz * xd.Z(), -(px * yd0.X() + py * yd0.Y() + pz * yd0.Z())) for px, py, pz in pts]
    else:
        allp = [p for l in vis for p in l]
    x0 = min(p[0] for p in allp); x1 = max(p[0] for p in allp); y0 = min(p[1] for p in allp); y1 = max(p[1] for p in allp)
    W0 = x1 - x0; pad = 0 if "crop" in v else W0 * .015; W, H = W0 + 2 * pad, y1 - y0 + 2 * pad
    sw = v.get("sw") or (W / 380 if "crop" in v else W / 900)
    def path(ls):
        return "".join("M" + " L".join(f"{x - x0 + pad:.1f} {y - y0 + pad:.1f}" for x, y in l) for l in ls if len(l) > 1)
    clip = f'<clipPath id="c"><rect width="{W:.0f}" height="{H:.0f}"/></clipPath>'
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}">{clip}<g clip-path="url(#c)">'
           f'<path d="{path(smooth)}" fill="none" stroke="#000" stroke-width="{sw * .6:.2f}" stroke-opacity=".5"/>'
           f'<path d="{path(vis)}" fill="none" stroke="#000" stroke-width="{sw:.2f}" stroke-linejoin="round" stroke-linecap="round"/></g></svg>')
    open(f"{outdir}/{v['name']}.svg", "w").write(svg)
    yd = d.Crossed(xd)
    json.dump({"x0": x0, "y0": y0, "pad": pad, "W": W, "H": H, "xd": [xd.X(), xd.Y(), xd.Z()], "yd": [yd.X(), yd.Y(), yd.Z()]},
              open(f"{outdir}/{v['name']}.json", "w"))
    print(v["name"], len(vis), "edges", round(time.time() - t), "s", round(W), round(H), flush=True)
