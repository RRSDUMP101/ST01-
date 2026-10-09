@echo off
REM Run from source on Windows (first run installs the dependencies)
cd /d "%~dp0\.."
if not exist .venv (
  python -m venv .venv
  call .venv\Scripts\activate.bat
  pip install -r requirements.txt
) else (
  call .venv\Scripts\activate.bat
)
set PYTHONPATH=%CD%\src
python -m partlist_studio %*
