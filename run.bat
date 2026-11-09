@echo off
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0scripts/main/launch.js"
if errorlevel 1 pause
