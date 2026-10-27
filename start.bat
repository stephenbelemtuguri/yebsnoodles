@echo off
title YEBS Noodles Server
cd /d "%~dp0"
echo Starting YEBS Noodles server...
echo.
echo   Customer : http://localhost:3000/
echo   Driver   : http://localhost:3000/driver.html
echo   Admin    : http://localhost:3000/admin.html
echo.
echo Keep this window open while using the app. Press Ctrl+C to stop.
echo.
node server.js
pause
