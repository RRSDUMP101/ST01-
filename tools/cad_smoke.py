"""Does a built program read a STEP file? Used after a build (CI and by hand):

    python tools/cad_smoke.py "dist/RRS Part List Studio/RRS Part List Studio.exe"

Writes a small STEP assembly with OpenCascade (of this Python), has the program read it the way the 3D tab
does - the program started again with --cad-import - and checks the model that comes out. Exit 0 = it works.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def write_step(path: Path) -> None:
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
    from OCP.TopoDS import TopoDS_Builder, TopoDS_Compound

    both = TopoDS_Compound()
    builder = TopoDS_Builder()
    builder.MakeCompound(both)
    builder.Add(both, BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 300.0, 120.0, 40.0).Shape())
    builder.Add(both, BRepPrimAPI_MakeBox(gp_Pnt(0, 200, 0), 80.0, 60.0, 20.0).Shape())
    writer = STEPControl_Writer()
    writer.Transfer(both, STEPControl_AsIs)
    if writer.Write(str(path)) != 1:  # IFSelect_RetDone
        raise SystemExit("could not write the test STEP file")


def main(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):  # the sizes are written with ×: not in every Windows code page
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    program = Path(argv[0])
    wait = float(argv[1]) if len(argv) > 1 else 240.0
    with tempfile.TemporaryDirectory() as folder:
        source, target, log = Path(folder) / "two boxes.step", Path(folder) / "out.rrsasm", Path(folder) / "log.txt"
        write_step(source)
        found = subprocess.run([str(program), "--cad-check"], timeout=wait, check=False).returncode
        if found != 0:  # what the 3D tab asks before it starts an import
            print(f"FAIL: the program does not find its STEP / IGES reader (code {found})")
            return 1
        start = time.monotonic()
        done = subprocess.run([str(program), "--cad-import", str(source), str(target), "60000", "", str(log)],
                              timeout=wait, check=False)
        took = time.monotonic() - start
        said = log.read_text(encoding="utf-8") if log.exists() else ""
        if done.returncode != 0 or not target.exists():
            print(f"FAIL: the program ended with code {done.returncode} after {took:.0f} s and wrote "
                  f"{'a' if target.exists() else 'no'} model\n{said[-2000:]}")
            return 1
        model = json.loads(target.read_text(encoding="utf-8"))
        sizes = sorted(p.get("size", "") for p in model["parts"])
        print(f"{program.name}: read STEP in {took:.1f} s -> {len(model['parts'])} parts {sizes}")
        if sizes != ["300×120×40", "80×60×20"]:
            print("FAIL: not the two boxes of the test file")
            return 1
    print("OK: the built program reads STEP")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
