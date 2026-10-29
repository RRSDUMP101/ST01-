#!/bin/sh
# Python packages for a macOS build that opens on macOS 11 Big Sur and newer (Intel and Apple chip).
# pip on a new macOS picks the wheels made for that macOS (PySide6 6.12, numpy macosx_14_0), and the
# app then quits at start on older Macs; the versions in packaging/macos-constraints.txt are built for 11.0.
set -e
cd "$(dirname "$0")/.."
# cryptography and cffi only as wheels: a build here links the OpenSSL of Homebrew, which the app does not carry
python -m pip install -r requirements-dev.txt -c packaging/macos-constraints.txt --only-binary=cryptography,cffi
# numpy has a macosx_14_0 and a macosx_10_13/11_0 wheel of the same version: take the older-macOS one
NUMPY="$(grep -i '^numpy==' packaging/macos-constraints.txt | cut -d= -f3)"
PYVER="$(python -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
rm -rf build/compat_wheels
python -m pip download --only-binary=:all: --no-deps --platform "macosx_11_0_$(uname -m)" \
    --python-version "$PYVER" --implementation cp -d build/compat_wheels "numpy==$NUMPY"
python -m pip install --force-reinstall --no-deps build/compat_wheels/*.whl
python -m pip list 2>/dev/null | grep -i -E "pyside6|shiboken6|numpy|cryptography|cffi"
