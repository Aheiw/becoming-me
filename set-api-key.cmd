@echo off
cd /d "%~dp0"
node --import tsx local-runtime/run-local.mjs --set-key
pause
