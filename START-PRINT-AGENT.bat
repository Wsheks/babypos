@echo off
title Ilekela print agent
cd /d "%~dp0"
echo ============================================
echo   Ilekela POS - print agent
echo   Keep this window open while the shop trades.
echo ============================================
echo.
node print-agent.js
echo.
echo The print agent stopped. Press a key to close.
pause >nul
