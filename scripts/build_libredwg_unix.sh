#!/bin/sh
# Build a self-contained dwg2dxf (GNU LibreDWG, GPLv3) into packaging/third_party/libredwg/
# so the macOS app can open .dwg files without ODA File Converter.
#   scripts/build_libredwg_unix.sh [version]
set -e
VER="${1:-${LIBREDWG_VERSION:-0.13.3}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DST="$ROOT/packaging/third_party/libredwg"
if [ -x "$DST/dwg2dxf" ]; then echo "dwg2dxf already built: $DST"; exit 0; fi
WORK="$(mktemp -d)"
cd "$WORK"
curl -fsSL -o libredwg.tar.xz "https://github.com/LibreDWG/libredwg/releases/download/$VER/libredwg-$VER.tar.xz"
tar xf libredwg.tar.xz
cd "libredwg-$VER"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
# Static library + no bindings: one executable that only needs the system libraries.
./configure --disable-shared --enable-static --disable-bindings --disable-python CFLAGS="-O2" >/dev/null
make -j"$JOBS" -C src >/dev/null
make -j"$JOBS" -C programs dwg2dxf >/dev/null
mkdir -p "$DST"
cp programs/dwg2dxf "$DST/dwg2dxf"
strip "$DST/dwg2dxf" || true
cp COPYING "$DST/COPYING.txt"
cp README "$DST/README.txt" 2>/dev/null || true
echo "GNU LibreDWG $VER (GPLv3). Source: https://github.com/LibreDWG/libredwg/releases/tag/$VER" > "$DST/SOURCE.txt"
"$DST/dwg2dxf" --version
if command -v otool >/dev/null; then otool -L "$DST/dwg2dxf"; fi
rm -rf "$WORK"
