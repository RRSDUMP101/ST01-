#!/bin/sh
# Build RRS Part List Studio for macOS -> dist/RRS Part List Studio.app
set -e
cd "$(dirname "$0")/.."
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements-dev.txt
pyinstaller --noconfirm packaging/partlist_studio.spec
# Unsigned app: remove the quarantine flag so Gatekeeper lets it open on this Mac.
xattr -cr "dist/RRS Part List Studio.app" || true
echo "Done: dist/RRS Part List Studio.app"
