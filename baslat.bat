@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Grafik
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js bulunamadi. https://nodejs.org adresinden LTS surumunu kurup tekrar deneyin.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)
node server.js --open --lan
pause
