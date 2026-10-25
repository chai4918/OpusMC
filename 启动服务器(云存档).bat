@echo off
rem Standalone authoritative storage server (Node.js 22+ required, zero dependencies).
rem Open http://localhost:8765/ on this PC, or http://YOUR-PC-IP:8765/ on an iPad / tablet.
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js 22 or newer is required: https://nodejs.org/
  pause
  exit /b 1
)
start "" http://localhost:8765/
node server\index.js
pause
