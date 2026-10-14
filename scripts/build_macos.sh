#!/bin/sh
# Build RRS Part List Studio for macOS -> dist/RRS Part List Studio.app
set -e
cd "$(dirname "$0")/.."
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
# Wheels that run on macOS 11 Big Sur and newer, not only on the macOS of this Mac
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
sh scripts/macos_deps.sh
# Optional: bundle dwg2dxf so .dwg opens without ODA File Converter (takes a few minutes once)
scripts/build_libredwg_unix.sh || echo "LibreDWG build skipped - .dwg will need ODA File Converter"
pyinstaller --noconfirm packaging/partlist_studio.spec
python tools/macho_min_os.py "dist/RRS Part List Studio.app" --max "$MACOSX_DEPLOYMENT_TARGET" || \
    echo "WARNING: the app needs a newer macOS than $MACOSX_DEPLOYMENT_TARGET"
# Unsigned app: remove the quarantine flag so Gatekeeper lets it open on this Mac.
xattr -cr "dist/RRS Part List Studio.app" || true
echo "Done: dist/RRS Part List Studio.app"
