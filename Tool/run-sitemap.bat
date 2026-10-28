@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -NoProfile -File "generate-sitemap.ps1"
pause