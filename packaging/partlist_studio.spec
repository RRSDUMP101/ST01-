# PyInstaller spec - build with:  pyinstaller --noconfirm packaging/partlist_studio.spec
# Produces dist/RRS Part List Studio/ (Windows, Linux) or dist/RRS Part List Studio.app (macOS).
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

ROOT = Path(SPECPATH).parent
APP = "RRS Part List Studio"

a = Analysis(
    [str(ROOT / "src" / "partlist_studio" / "__main__.py")],
    pathex=[str(ROOT / "src")],
    datas=collect_data_files("ezdxf") + [
        (str(ROOT / "src" / "partlist_studio" / "resources"), "partlist_studio/resources"),
        (str(ROOT / "samples"), "samples"),
    ],
    hiddenimports=["ezdxf.addons.odafc", "openpyxl", "xlrd", "gspread", "google_auth_oauthlib.flow"],
    excludes=["tkinter", "matplotlib", "PIL", "PySide6.QtWebEngineCore", "PySide6.Qt3DCore"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name=APP, console=False,
          icon=str(ROOT / "packaging" / ("app.icns" if sys.platform == "darwin" else "app.ico")))
coll = COLLECT(exe, a.binaries, a.datas, name=APP)
if sys.platform == "darwin":
    app = BUNDLE(coll, name=f"{APP}.app", icon=str(ROOT / "packaging" / "app.icns"),
                 bundle_identifier="com.rrs.partliststudio",
                 info_plist={"NSHighResolutionCapable": True, "CFBundleShortVersionString": "0.1.0",
                             "CFBundleDocumentTypes": [{"CFBundleTypeName": "RRS Part List",
                                                        "CFBundleTypeExtensions": ["rrspl"],
                                                        "CFBundleTypeRole": "Editor"}]})
