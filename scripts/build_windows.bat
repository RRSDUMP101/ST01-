@echo off
REM Build RRS Part List Studio for Windows -> dist\RRS Part List Studio\RRS Part List Studio.exe
cd /d "%~dp0\.."
if not exist .venv python -m venv .venv
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements-dev.txt || exit /b 1
pyinstaller --noconfirm packaging\partlist_studio.spec || exit /b 1
echo.
echo Done: dist\RRS Part List Studio\RRS Part List Studio.exe
