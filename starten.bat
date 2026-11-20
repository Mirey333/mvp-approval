@echo off
cd /d "%~dp0"
where node >nul 2>&1 || (
  echo Node.js is missing. Install it from https://nodejs.org and start this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Pakete werden installiert...
  call npm install
  if errorlevel 1 (
    echo Installation fehlgeschlagen.
    pause
    exit /b 1
  )
)
start "MVP Approval" cmd /c "node server.js"
ping 127.0.0.1 -n 3 >nul
start "" http://127.0.0.1:8756
