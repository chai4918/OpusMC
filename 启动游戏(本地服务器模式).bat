@echo off
rem Fallback launcher: serves the game on this PC and the local network (requires Python 3)
rem Open http://<this-PC-IP>:8765/ on an iPad / phone that is on the same Wi-Fi.
cd /d "%~dp0"
set PY=python
where py >nul 2>nul && set PY=py
echo Local: http://localhost:8765/
echo LAN:   http://YOUR-PC-IP:8765/
start "" http://localhost:8765/
%PY% tools\serve.py 8765 0.0.0.0
