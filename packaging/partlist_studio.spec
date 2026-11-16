# PyInstaller spec - build with:  pyinstaller --noconfirm packaging/partlist_studio.spec
# Produces dist/RRS Part List Studio/ (Windows, Linux) or dist/RRS Part List Studio.app (macOS).
# With PARTLIST_ONEFILE=1: dist/RRS Part List Studio Portable(.exe) - a single file.
import importlib.util
import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

ROOT = Path(SPECPATH).parent
APP = "RRS Part List Studio"
# Optional: LibreDWG dwg2dxf (Windows build fetches it, see .github/workflows/build.yml) so that
# .dwg files open without installing ODA File Converter.
LIBREDWG = ROOT / "packaging" / "third_party" / "libredwg"
# Optional: OpenCascade (cadquery-ocp-novtk, requirements-cad.txt) so that STEP / IGES models open in the built
# program. It is one big extension module, OCP.OCP, imported only inside functions. Its own libraries are found
# by PyInstaller from that module (macOS: OCP/.dylibs, Linux: <wheel>.libs); on Windows they lie in a folder
# beside the package that OCP/__init__.py adds to the DLL search path, so that folder goes in under its name.
CAD_HIDDEN, CAD_BINARIES = [], []
_ocp = importlib.util.find_spec("OCP")
if _ocp is not None and _ocp.origin:
    CAD_HIDDEN = ["OCP", "OCP.OCP"]
    if sys.platform == "win32":
        for libs in Path(_ocp.origin).parent.parent.glob("cadquery_ocp*.libs"):
            CAD_BINARIES += [(str(f), libs.name) for f in libs.iterdir() if f.is_file()]
print(f"OpenCascade (STEP / IGES): {'bundled' if CAD_HIDDEN else 'NOT installed - the build will not read STEP / IGES'}")

a = Analysis(
    [str(ROOT / "src" / "partlist_studio" / "__main__.py")],
    pathex=[str(ROOT / "src")],
    datas=collect_data_files("ezdxf") + [
        (str(ROOT / "src" / "partlist_studio" / "resources"), "partlist_studio/resources"),
        (str(ROOT / "samples"), "samples"),
    ] + ([(str(LIBREDWG), "libredwg")] if LIBREDWG.is_dir() else []),
    binaries=CAD_BINARIES,
    hiddenimports=["certifi", "ezdxf.addons.odafc", "openpyxl", "xlrd", "gspread", "google_auth_oauthlib.flow",
                   "segno", "zstandard", *CAD_HIDDEN],
    excludes=["tkinter", "matplotlib", "PySide6.QtWebEngineCore", "PySide6.Qt3DCore", "vtk", "vtkmodules"],
)
if sys.platform == "darwin":
    # OpenSSL's legacy provider (MD4, DES ...) is not used and the runner's copy needs macOS 15
    a.binaries = [b for b in a.binaries if "ossl-modules" not in b[0].replace("\\", "/")]
pyz = PYZ(a.pure)
ICON = str(ROOT / "packaging" / ("app.icns" if sys.platform == "darwin" else "app.ico"))
if os.environ.get("PARTLIST_ONEFILE") == "1":
    # Portable: one .exe that unpacks itself to a temp folder on start (runs straight from a zip).
    exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name=f"{APP} Portable", console=False, icon=ICON,
              upx=False, runtime_tmpdir=None)
else:
    exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name=APP, console=False, icon=ICON)
    coll = COLLECT(exe, a.binaries, a.datas, name=APP)
if sys.platform == "darwin" and os.environ.get("PARTLIST_ONEFILE") != "1":
    app = BUNDLE(coll, name=f"{APP}.app", icon=str(ROOT / "packaging" / "app.icns"),
                 bundle_identifier="com.rrs.partliststudio",
                 info_plist={"NSHighResolutionCapable": True, "CFBundleShortVersionString": "0.1.0",
                             # the build uses wheels for macOS 11+ (scripts/macos_deps.sh, tools/macho_min_os.py)
                             "LSMinimumSystemVersion": os.environ.get("MACOSX_DEPLOYMENT_TARGET") or "11.0",
                             "CFBundleDocumentTypes": [{"CFBundleTypeName": "RRS Part List",
                                                        "CFBundleTypeExtensions": ["rrspl"],
                                                        "CFBundleTypeRole": "Editor"}]})
