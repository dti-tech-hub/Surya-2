@echo off
title CrowdTrust Dashboard
echo ======================================================================
echo   Starting CrowdTrust Dashboard on http://localhost:5180
echo ======================================================================
cd /d "%~dp0frontend"
start http://localhost:5180
call npm run dev
pause
