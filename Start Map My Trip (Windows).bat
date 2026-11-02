@echo off
title Map My Trip
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed yet.
  echo  The download page will open now: install the "LTS" version,
  echo  then double-click this file again.
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b
)

echo.
echo  Map My Trip is starting at http://localhost:5199
echo  Keep this window open while you work. Close it to stop.
echo.
start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:5199"
node serve.cjs
pause
