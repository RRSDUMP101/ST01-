#!/bin/sh
# Run from source on macOS (double-click in Finder; first run installs the dependencies)
cd "$(dirname "$0")/.."
if [ ! -d .venv ]; then
  python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
else
  . .venv/bin/activate
fi
PYTHONPATH="$PWD/src" python -m partlist_studio "$@"
