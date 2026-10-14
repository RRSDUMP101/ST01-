# PyInstaller spec - build with:  pyinstaller --noconfirm packaging/partlist_studio.spec
# Produces dist/RRS Part List Studio/ (Windows, Linux) or dist/RRS Part List Studio.app (macOS).
# With PARTLIST_ONEFILE=1: dist/RRS Part List Studio Portable(.exe) - a single file.
import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

ROOT = Path(SPECPATH).parent
APP = "RRS Part List Studio"
# Optional: LibreDWG dwg2dxf (Windows build fetches it, see .github/workflows/build.yml) so that
# .dwg files open without installing ODA File Converter.
LIBREDWG = ROOT / "packaging" / "third_party" / "libredwg"

a = Analysis(
    [str(ROOT / "src" / "partlist_studio" / "__main__.py")],
    pathex=[str(ROOT / "src")],
    datas=collect_data_files("ezdxf") + [
        (str(ROOT / "src" / "partlist_studio" / "resources"), "partlist_studio/resources"),
        (str(ROOT / "samples"), "samples"),
    ] + ([(str(LIBREDWG), "libredwg")] if LIBREDWG.is_dir() else []),
    hiddenimports=["ezdxf.addons.odafc", "openpyxl", "xlrd", "gspread", "google_auth_oauthlib.flow"],
    excludes=["tkinter", "matplotlib", "PySide6.QtWebEngineCore", "PySide6.Qt3DCore"],
)
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
